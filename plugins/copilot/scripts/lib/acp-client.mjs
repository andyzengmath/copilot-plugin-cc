/**
 * Agent Client Protocol v1 client for GitHub Copilot CLI.
 *
 * This replaces codex-plugin-cc's `app-server.mjs`. The overall structure
 * (spawned client, broker client, JSON-RPC line framing, pending-request map)
 * is preserved from the Codex port so the downstream companion logic stays
 * largely unchanged. The backend-specific pieces that do change:
 *
 *   - spawn target: `copilot --acp --allow-all-tools --allow-all-paths`
 *   - handshake: ACP `initialize` (no `initialized` notification)
 *   - server-initiated `session/request_permission` is auto-approved
 *   - fs/terminal server-initiated requests are rejected with the capability
 *     error, matching our advertised `clientCapabilities` (we declared we do
 *     not support those).
 *
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./acp-protocol").AcpMethod} AcpMethod
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").AcpNotificationHandler} AcpNotificationHandler
 * @typedef {import("./acp-protocol").ClientInfo} ClientInfo
 * @typedef {import("./acp-protocol").ClientCapabilities} ClientCapabilities
 * @typedef {import("./acp-protocol").AcpClientOptions} AcpClientOptions
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "COPILOT_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const ACP_PROTOCOL_VERSION = 1;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Copilot Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {ClientCapabilities} */
const DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
};

const DEFAULT_COPILOT_SPAWN_ARGS = [
  "--acp",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls"
];

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function firstAllowOption(options = []) {
  // Never select allow_always on behalf of the user — that would
  // persistently widen Copilot's permissions beyond the single call. Only
  // allow_once is safe to auto-approve. If no allow_once option is offered
  // we fall back to any non-reject option that is also not allow_always
  // (which means we simply don't pick one — the request will be cancelled).
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }
  const allowOnce = options.find((option) => option?.kind === "allow_once");
  if (allowOnce) return allowOnce;
  // Heuristic fallback: some agents omit `kind` and expect the first
  // option to be the safe default. Pick it only if it does NOT look like a
  // reject/allow_always variant.
  const safeFallback = options.find(
    (option) =>
      typeof option?.optionId === "string" &&
      option.kind !== "allow_always" &&
      option.kind !== "reject_once" &&
      option.kind !== "reject_always"
  );
  return safeFallback ?? null;
}

class AcpClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AcpMethod} M
   * @param {M} method
   * @param {import("./acp-protocol").AcpRequestParams<M>} params
   * @returns {Promise<import("./acp-protocol").AcpResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("copilot ACP client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse copilot ACP JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `copilot ACP ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AcpNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    // Auto-approve permission prompts so the broker stays non-interactive.
    if (message.method === "session/request_permission") {
      const options = message.params?.options ?? [];
      const chosen = firstAllowOption(options);
      const result = chosen
        ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
        : { outcome: { outcome: "cancelled" } };
      this.sendMessage({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    // We advertised fs: { readTextFile:false, writeTextFile:false } and
    // terminal:false, so the agent should not reach these paths. Reject
    // defensively with the ACP capability-unsupported shape.
    this.sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("copilot ACP connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCopilotAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const args = this.options.model
      ? [...DEFAULT_COPILOT_SPAWN_ARGS, "--model", String(this.options.model)]
      : [...DEFAULT_COPILOT_SPAWN_ARGS];

    this.proc = spawn("copilot", args, {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`copilot ACP exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      clientCapabilities: this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES
    });
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("copilot ACP stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCopilotAcpClient extends AcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
    this.brokerSecret = options.brokerSecret ?? null;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    const initParams = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      clientCapabilities: this.options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES
    };
    if (this.brokerSecret) {
      initParams._meta = { brokerSecret: this.brokerSecret };
    }
    await this.request("initialize", initParams);
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("copilot ACP broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CopilotAcpClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    let brokerSecret = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ??
        options.env?.[BROKER_ENDPOINT_ENV] ??
        process.env[BROKER_ENDPOINT_ENV] ??
        null;
      if (brokerEndpoint) {
        const existingSession = loadBrokerSession(cwd);
        if (existingSession?.endpoint === brokerEndpoint) {
          brokerSecret = existingSession.secret ?? null;
        }
      }
      if (!brokerEndpoint && options.reuseExistingBroker) {
        const existingSession = loadBrokerSession(cwd);
        brokerEndpoint = existingSession?.endpoint ?? null;
        brokerSecret = existingSession?.secret ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
        brokerSecret = brokerSession?.secret ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCopilotAcpClient(cwd, { ...options, brokerEndpoint, brokerSecret })
      : new SpawnedCopilotAcpClient(cwd, options);
    await client.initialize();
    return client;
  }
}
