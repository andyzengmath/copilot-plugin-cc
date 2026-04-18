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

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { ACP_PROTOCOL_VERSION, BROKER_BUSY_RPC_CODE, CopilotAcpClient } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

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
  if (socket.destroyed) {
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

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

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

        // Broker-local initialize: respond with canned ACP capabilities so
        // connecting clients can complete their handshake without forwarding
        // a second `initialize` to the already-initialized upstream process.
        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: BROKER_INITIALIZE_RESULT
          });
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
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
          continue;
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
          continue;
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
          // For ACP, session/prompt response is the end-of-stream marker
          // (stopReason is included). Clear ownership now.
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
      }
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
