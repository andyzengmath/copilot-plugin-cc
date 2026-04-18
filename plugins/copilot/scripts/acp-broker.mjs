#!/usr/bin/env node
/**
 * Broker that serializes multi-client access to a single long-lived
 * `copilot --acp` process. Port of codex-plugin-cc's app-server-broker.
 *
 * Each client that connects speaks ACP JSON-RPC line-framed messages against
 * the broker's Unix socket. The broker forwards requests to the upstream
 * ACP process, routes `session/update` notifications back to the currently
 * active stream owner, and serializes other activity with a single active
 * request slot (plus a best-effort escape hatch for `session/cancel` during
 * an active stream).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { ACP_PROTOCOL_VERSION, BROKER_BUSY_RPC_CODE, CopilotAcpClient } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { BROKER_SECRET_ENV } from "./lib/broker-lifecycle.mjs";

const BROKER_AUTH_RPC_CODE = -32002;

function secretsEqual(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still burn a compare to keep timing uniform across length mismatches.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const STREAMING_METHODS = new Set(["session/prompt"]);
const BROKER_INITIALIZE_RESULT = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  agentInfo: { name: "copilot-companion-broker" },
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false }
  },
  authMethods: []
};

function buildStreamSessionIds(method, params, _result) {
  const sessionIds = new Set();
  if (params?.sessionId) {
    sessionIds.add(params.sessionId);
  }
  return sessionIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isCancelRequest(message) {
  return message?.method === "session/cancel";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  const expectedSecret = process.env[BROKER_SECRET_ENV] ?? null;
  writePidFile(pidFile);

  const acpClient = await CopilotAcpClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamSessionIds = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamSessionIds = null;
    }
  }

  function routeNotification(message) {
    // session/update notifications carry a sessionId; if it matches the
    // active stream's session set, prefer the stream owner so in-flight
    // notifications don't get diverted to a concurrent request slot (e.g.,
    // a cancel coming in from another socket).
    const notificationSessionId =
      message?.method === "session/update" ? message.params?.sessionId ?? null : null;
    const streamOwnsSession =
      activeStreamSocket &&
      notificationSessionId &&
      activeStreamSessionIds &&
      activeStreamSessionIds.has(notificationSessionId);
    const target = streamOwnsSession
      ? activeStreamSocket
      : activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await acpClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  acpClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    // Each connection is unauthenticated until its initialize message
    // passes broker-secret validation. We gate every other method on this
    // flag to prevent a same-user process from driving the shared broker
    // without knowing the secret written to broker.json (0600) or the
    // COPILOT_COMPANION_ACP_SECRET env var inherited by the broker.
    let authenticated = expectedSecret === null;
    // Per-socket serial queue. Node emits `data` events without waiting for
    // async handlers to settle, so concurrent invocations would race on the
    // shared `buffer`/`authenticated` state. Chaining work through a Promise
    // ensures at most one drain runs per socket at a time.
    let drainChain = Promise.resolve();

    async function processMessage(message) {
      // Broker-local initialize: respond with canned ACP capabilities so
      // connecting clients can complete their handshake without forwarding
      // a second `initialize` to the already-initialized upstream process.
      // If a broker secret is configured, the client MUST include it in
      // params._meta.brokerSecret to pass auth.
      if (message.id !== undefined && message.method === "initialize") {
        const providedSecret = message.params?._meta?.brokerSecret ?? null;
        if (expectedSecret !== null && !secretsEqual(providedSecret ?? "", expectedSecret)) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_AUTH_RPC_CODE, "Broker authentication failed")
          });
          socket.end();
          return "close";
        }
        authenticated = true;
        send(socket, {
          id: message.id,
          result: BROKER_INITIALIZE_RESULT
        });
        return "continue";
      }

      // Reject any non-initialize request before auth succeeds.
      if (!authenticated) {
        if (message.id !== undefined) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_AUTH_RPC_CODE, "Broker authentication required")
          });
        }
        socket.end();
        return "close";
      }

      if (message.id !== undefined && message.method === "broker/shutdown") {
        send(socket, { id: message.id, result: {} });
        await shutdown(server);
        process.exit(0);
      }

      if (message.id === undefined) {
        return "continue";
      }

      const allowCancelDuringActiveStream =
        isCancelRequest(message) &&
        activeStreamSocket &&
        activeStreamSocket !== socket &&
        !activeRequestSocket;

      if (
        ((activeRequestSocket && activeRequestSocket !== socket) ||
          (activeStreamSocket && activeStreamSocket !== socket)) &&
        !allowCancelDuringActiveStream
      ) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Copilot broker is busy.")
        });
        return "continue";
      }

      if (allowCancelDuringActiveStream) {
        try {
          const result = await acpClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
        }
        return "continue";
      }

      const isStreaming = STREAMING_METHODS.has(message.method);
      activeRequestSocket = socket;
      if (isStreaming) {
        activeStreamSocket = socket;
        activeStreamSessionIds = buildStreamSessionIds(
          message.method,
          message.params ?? {},
          null
        );
      }

      try {
        const result = await acpClient.request(message.method, message.params ?? {});
        send(socket, { id: message.id, result });
        if (isStreaming && activeStreamSocket === socket) {
          activeStreamSocket = null;
          activeStreamSessionIds = null;
        }
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
      } catch (error) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
        });
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
        }
        if (activeStreamSocket === socket) {
          activeStreamSocket = null;
          activeStreamSessionIds = null;
        }
      }
      return "continue";
    }

    async function drain() {
      while (true) {
        if (socket.destroyed || socket.writableEnded) {
          return;
        }
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) return;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        const action = await processMessage(message);
        if (action === "close") return;
      }
    }

    socket.on("data", (chunk) => {
      buffer += chunk;
      drainChain = drainChain.then(drain).catch(() => {});
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
