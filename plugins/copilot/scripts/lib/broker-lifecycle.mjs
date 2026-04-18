import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "COPILOT_COMPANION_ACP_PID_FILE";
export const LOG_FILE_ENV = "COPILOT_COMPANION_ACP_LOG_FILE";
export const BROKER_SECRET_ENV = "COPILOT_COMPANION_ACP_SECRET";
const BROKER_STATE_FILE = "broker.json";

function generateBrokerSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function createBrokerSessionDir(prefix = "cpc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, options = {}) {
  const secret = options.secret ?? null;
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    let authed = false;
    let buffer = "";
    // Single-settlement guard. The explicit `resolve()` in the data handler
    // and the socket `close`/`error` listeners can all fire — a plain
    // double-call is idempotent, but using a flag keeps the shutdown
    // lifecycle explicit and prevents future diffs from accidentally
    // resolving with different values.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    socket.on("connect", () => {
      // The broker requires an initialize+secret handshake before it will
      // accept any other method (including broker/shutdown). Send
      // initialize first; only after it succeeds do we send shutdown.
      const initParams = { protocolVersion: 1 };
      if (secret) {
        initParams._meta = { brokerSecret: secret };
      }
      socket.write(
        `${JSON.stringify({ id: 1, method: "initialize", params: initParams })}\n`
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!authed && msg?.id === 1) {
          if (msg.error) {
            // Auth failed. Give up gracefully — the broker will stay up,
            // but the caller can't do anything about it.
            socket.end();
            settle();
            return;
          }
          authed = true;
          socket.write(
            `${JSON.stringify({ id: 2, method: "broker/shutdown", params: {} })}\n`
          );
          continue;
        }
        if (authed && msg?.id === 2) {
          socket.end();
          settle();
          return;
        }
      }
    });
    socket.on("error", settle);
    socket.on("close", settle);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, secret, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const childEnv = {
    ...env,
    ...(secret ? { [BROKER_SECRET_ENV]: secret } : {})
  };
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = resolveBrokerStateFile(cwd);
  // broker.json contains the shared secret used to authenticate ACP broker
  // clients. Write with mode 0600 and re-chmod explicitly so the umask
  // cannot widen permissions on POSIX. On Windows chmod is a no-op, but the
  // secret is still only needed by processes running as the same user —
  // full ACL restriction would require a Windows-native helper.
  fs.writeFileSync(stateFile, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  try {
    fs.chmodSync(stateFile, 0o600);
  } catch {
    // Best-effort: on Windows chmod has limited effect; tolerate failure.
  }
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const secret = options.secret ?? generateBrokerSecret();
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../acp-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    secret,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    secret
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
