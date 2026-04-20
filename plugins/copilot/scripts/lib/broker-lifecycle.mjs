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
const BROKER_LOCK_FILE = "broker.lock";
const BROKER_LOCK_DEFAULT_TIMEOUT_MS = 5000;
const BROKER_LOCK_POLL_INTERVAL_MS = 25;

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

function resolveBrokerLockFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is existence-only on both POSIX and Windows Node.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH → process does not exist. EPERM → exists but signalling denied
    // (treat as alive; the lock owner is another user's process).
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function readLockHolderPid(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, "utf8");
    const [pidLine] = content.split("\n");
    const pid = Number(pidLine);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function tryAcquireLockFile(lockPath) {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

async function acquireBrokerLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? BROKER_LOCK_DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? BROKER_LOCK_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (tryAcquireLockFile(lockPath)) {
      return true;
    }
    // Steal the lock if the holder process is dead. This keeps a crashed
    // ensureBrokerSession from wedging every future caller.
    const holderPid = readLockHolderPid(lockPath);
    if (holderPid !== null && !isProcessAlive(holderPid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another contender already stole and replaced it; retry on next loop.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function releaseBrokerLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Lock may already be gone (stolen after we were declared dead, or the
    // state dir was cleaned externally). Nothing to recover.
  }
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

const FAST_PATH_LIVENESS_TIMEOUT_MS = 150;
const SLOW_PATH_LIVENESS_TIMEOUT_MS = 1000;

async function isBrokerEndpointReady(endpoint, timeoutMs = FAST_PATH_LIVENESS_TIMEOUT_MS) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, timeoutMs);
  } catch {
    return false;
  }
}

async function spawnAndRegisterBroker(cwd, options) {
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

export async function ensureBrokerSession(cwd, options = {}) {
  // Fast path: a previously-written broker.json with a live endpoint is
  // safe to reuse without serialization. Callers that find a dead broker
  // need to fall through to the locked slow path so that concurrent
  // sessions on the same workspace don't each spawn their own replacement.
  const existing = loadBrokerSession(cwd);
  if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  const lockPath = resolveBrokerLockFile(cwd);
  const acquired = await acquireBrokerLock(lockPath, {
    timeoutMs: options.lockTimeoutMs
  });
  if (!acquired) {
    // Another contender held the lock past our timeout. They may have
    // produced a live broker in the meantime — re-check with the slow-path
    // liveness budget before giving up.
    const after = loadBrokerSession(cwd);
    if (
      after &&
      (await isBrokerEndpointReady(after.endpoint, SLOW_PATH_LIVENESS_TIMEOUT_MS))
    ) {
      return after;
    }
    return null;
  }

  try {
    // Re-check inside the critical section with a more generous liveness
    // timeout. Tearing down and respawning a broker is expensive and
    // destructive: another client may be mid-stream. Give a busy-but-alive
    // broker more time to respond before declaring it dead.
    const inCritical = loadBrokerSession(cwd);
    if (
      inCritical &&
      (await isBrokerEndpointReady(
        inCritical.endpoint,
        SLOW_PATH_LIVENESS_TIMEOUT_MS
      ))
    ) {
      return inCritical;
    }

    if (inCritical) {
      teardownBrokerSession({
        endpoint: inCritical.endpoint ?? null,
        pidFile: inCritical.pidFile ?? null,
        logFile: inCritical.logFile ?? null,
        sessionDir: inCritical.sessionDir ?? null,
        pid: inCritical.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }

    return await spawnAndRegisterBroker(cwd, options);
  } finally {
    releaseBrokerLock(lockPath);
  }
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
