import path from "node:path";
import process from "node:process";

function sanitizePipeName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createBrokerEndpoint(sessionDir, platform = process.platform) {
  if (platform === "win32") {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-copilot-acp`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  // Use the POSIX joiner explicitly so the endpoint stays `unix:/tmp/...`
  // even when `createBrokerEndpoint` is called on a Windows runner with a
  // POSIX-style sessionDir (e.g. cross-platform tests). On a real POSIX
  // host `path.posix.join` and `path.join` are identical, so this is a
  // no-op on production Linux/macOS callers.
  return `unix:${path.posix.join(sessionDir, "broker.sock")}`;
}

export function parseBrokerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("Missing broker endpoint.");
  }

  if (endpoint.startsWith("pipe:")) {
    const pipePath = endpoint.slice("pipe:".length);
    if (!pipePath) {
      throw new Error("Broker pipe endpoint is missing its path.");
    }
    return { kind: "pipe", path: pipePath };
  }

  if (endpoint.startsWith("unix:")) {
    const socketPath = endpoint.slice("unix:".length);
    if (!socketPath) {
      throw new Error("Broker Unix socket endpoint is missing its path.");
    }
    return { kind: "unix", path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
