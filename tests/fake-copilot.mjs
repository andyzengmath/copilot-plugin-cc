#!/usr/bin/env node
/**
 * Fake `copilot --acp` subprocess for tests.
 *
 * Speaks ACP v1 JSON-RPC on stdio. Behavior is driven by the
 * `FAKE_COPILOT_SCRIPT` env var (JSON string) or by
 * `FAKE_COPILOT_SCRIPT_FILE` (path to a JSON file). Both are optional;
 * without them the fixture responds to every ACP method with sensible
 * empty defaults so a smoke test can spin it up without config.
 *
 * Script shape (all fields optional):
 *
 *   {
 *     "initialize": <InitializeResponse override>,
 *     "sessionId": <string to return from session/new; default "sess-fake-1">,
 *     "authenticateError": <JSON-RPC error to return from authenticate>,
 *     "newSessionError": <JSON-RPC error to return from session/new>,
 *     "prompt": {
 *       "updates": [<SessionUpdate>, ...],       // emitted as notifications
 *       "updateDelayMs": <number | 0>,
 *       "stopReason": "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal",
 *       "error": <JSON-RPC error to return from session/prompt>,
 *       "permissionRequest": {                   // optional: fixture asks client for permission
 *         "toolCall": <ToolCallInfo>,
 *         "options": [<PermissionOption>, ...]
 *       }
 *     },
 *     "cancelAcknowledges": <bool, default true>
 *   }
 *
 * The fixture also accepts `--acp` (ignored — only present because the
 * plugin always appends it). Other flags (`--allow-all-*`, `--model`)
 * are captured into the `SpawnArgs` buffer for tests that want to assert
 * how the plugin invoked us.
 */

import fs from "node:fs";
import readline from "node:readline";
import process from "node:process";

function readScript() {
  const inline = process.env.FAKE_COPILOT_SCRIPT;
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      return {};
    }
  }
  const filePath = process.env.FAKE_COPILOT_SCRIPT_FILE;
  if (filePath && fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

const script = readScript();

const DEFAULT_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false }
  },
  agentInfo: { name: "fake-copilot", version: "0.0.1" },
  authMethods: []
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function sendError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  send({ id, error });
}

function notify(method, params) {
  send({ method, params });
}

const activeSessions = new Set();
const pendingPermissionResolvers = new Map();
let pendingRequestIdCounter = 1;

function requestPermission(sessionId, toolCall, options) {
  const id = `perm-${pendingRequestIdCounter++}`;
  send({
    id,
    method: "session/request_permission",
    params: { sessionId, toolCall, options }
  });
  return new Promise((resolve) => {
    pendingPermissionResolvers.set(id, resolve);
  });
}

async function handlePromptRun(sessionId) {
  const promptSpec = script.prompt ?? {};
  if (promptSpec.error) {
    return { error: promptSpec.error };
  }

  const delayMs = Number.isFinite(promptSpec.updateDelayMs) ? promptSpec.updateDelayMs : 0;
  for (const update of promptSpec.updates ?? []) {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    notify("session/update", { sessionId, update });
  }

  if (promptSpec.permissionRequest) {
    const { toolCall, options } = promptSpec.permissionRequest;
    await requestPermission(sessionId, toolCall ?? { toolCallId: "t1", title: "fake tool" }, options ?? []);
  }

  return { result: { stopReason: promptSpec.stopReason ?? "end_turn" } };
}

async function dispatch(message) {
  const { id, method, params, result, error } = message;

  // Responses to OUR outgoing server-to-client requests (e.g.
  // session/request_permission). The client's reply carries our id.
  if (id !== undefined && method === undefined && (result !== undefined || error !== undefined)) {
    const resolver = pendingPermissionResolvers.get(id);
    if (resolver) {
      pendingPermissionResolvers.delete(id);
      resolver({ result, error });
    }
    return;
  }

  if (method === "initialize") {
    send({ id, result: script.initialize ?? DEFAULT_INITIALIZE });
    return;
  }

  if (method === "authenticate") {
    if (script.authenticateError) {
      sendError(id, script.authenticateError.code ?? -32000, script.authenticateError.message ?? "auth failed");
    } else {
      send({ id, result: {} });
    }
    return;
  }

  if (method === "session/new") {
    if (script.newSessionError) {
      sendError(id, script.newSessionError.code ?? -32000, script.newSessionError.message ?? "session/new failed");
      return;
    }
    const sessionId = script.sessionId ?? "sess-fake-1";
    activeSessions.add(sessionId);
    send({ id, result: { sessionId } });
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params?.sessionId;
    if (!sessionId || !activeSessions.has(sessionId)) {
      sendError(id, -32602, `unknown sessionId: ${sessionId}`);
      return;
    }
    const outcome = await handlePromptRun(sessionId);
    if (outcome.error) {
      sendError(id, outcome.error.code ?? -32000, outcome.error.message ?? "prompt failed");
    } else {
      send({ id, result: outcome.result });
    }
    return;
  }

  if (method === "session/cancel") {
    const ack = script.cancelAcknowledges !== false;
    if (ack) {
      send({ id, result: {} });
    } else {
      sendError(id, -32000, "cancel rejected");
    }
    return;
  }

  if (method === "initialized") {
    // Notification; no response.
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `fake-copilot: unsupported method: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  dispatch(parsed).catch((error) => {
    process.stderr.write(`fake-copilot: handler error: ${error?.message ?? error}\n`);
  });
});

rl.on("close", () => process.exit(0));

// Exit on SIGTERM/SIGINT so tests can clean up.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
