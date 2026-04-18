/**
 * Copilot runtime shim. Wraps the ACP v1 client and exposes the same public
 * API surface that codex-plugin-cc's `codex.mjs` provides, so the companion
 * script can remain nearly identical across the two backends.
 *
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").SessionUpdate} SessionUpdate
 * @typedef {import("./acp-protocol").SessionUpdateNotification} SessionUpdateNotification
 * @typedef {import("./acp-protocol").StopReason} StopReason
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile } from "./fs.mjs";
import {
  ACP_PROTOCOL_VERSION,
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  CopilotAcpClient
} from "./acp-client.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";

const TASK_THREAD_PREFIX = "Copilot Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

function cleanCopilotStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) return;
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) return;
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function contentBlockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  return "";
}

function collectToolTitle(toolCall) {
  if (!toolCall) return "";
  if (typeof toolCall.title === "string" && toolCall.title.trim()) return toolCall.title.trim();
  if (typeof toolCall.kind === "string" && toolCall.kind.trim()) return toolCall.kind.trim();
  if (typeof toolCall.toolCallId === "string" && toolCall.toolCallId.trim()) return toolCall.toolCallId.trim();
  return "tool";
}

function isEditKind(kind) {
  if (typeof kind !== "string") return false;
  return /edit|write|apply|patch|file|modify/i.test(kind);
}

function isCommandKind(kind, title) {
  const combined = `${kind ?? ""} ${title ?? ""}`;
  return /execute|shell|command|bash|terminal|run/i.test(combined);
}

/**
 * Construct the state machine for a single ACP `session/prompt` call. We
 * keep the shape intentionally similar to codex-plugin-cc's TurnCaptureState
 * so downstream renderers and progress reporters need no behavioural change.
 */
function createPromptCaptureState(sessionId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    sessionId,
    completion,
    resolveCompletion,
    rejectCompletion,
    completed: false,
    stopReason: null,
    error: null,
    lastAgentMessage: "",
    reasoningSummary: [],
    toolCalls: new Map(),
    fileChanges: [],
    commandExecutions: [],
    touchedFiles: new Set(),
    reviewText: "",
    onProgress: options.onProgress ?? null
  };
}

function applySessionUpdate(state, params) {
  if (!params || params.sessionId !== state.sessionId) {
    return;
  }
  const update = params.update;
  if (!update || typeof update !== "object") return;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const chunk = contentBlockText(update.content);
      if (chunk) {
        state.lastAgentMessage += chunk;
        state.reviewText += chunk;
      }
      return;
    }
    case "agent_thought_chunk": {
      const chunk = contentBlockText(update.content);
      if (chunk) {
        const normalized = chunk.trim();
        if (normalized && !state.reasoningSummary.includes(normalized)) {
          state.reasoningSummary.push(normalized);
          emitProgress(state.onProgress, `Reasoning: ${shorten(normalized, 96)}`, "investigating");
        }
      }
      return;
    }
    case "tool_call": {
      const key = update.toolCallId ?? `${Math.random()}`;
      state.toolCalls.set(key, update);
      const title = collectToolTitle(update);
      const isVerification = looksLikeVerificationCommand(title);
      emitProgress(
        state.onProgress,
        `Running tool: ${shorten(title, 96)}`,
        isVerification ? "verifying" : isEditKind(update.kind) ? "editing" : "investigating"
      );
      for (const location of update.locations ?? []) {
        if (location?.path) state.touchedFiles.add(location.path);
      }
      if (isEditKind(update.kind)) state.fileChanges.push(update);
      if (isCommandKind(update.kind, title)) state.commandExecutions.push(update);
      return;
    }
    case "tool_call_update": {
      const key = update.toolCallId;
      if (!key) return;
      const merged = { ...(state.toolCalls.get(key) ?? {}), ...update };
      state.toolCalls.set(key, merged);
      if (update.status === "completed" || update.status === "failed") {
        const title = collectToolTitle(merged);
        emitProgress(
          state.onProgress,
          `Tool ${update.status}: ${shorten(title, 96)}`,
          update.status === "failed" ? "failed" : "running"
        );
      }
      for (const location of update.locations ?? []) {
        if (location?.path) state.touchedFiles.add(location.path);
      }
      return;
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      if (entries.length > 0) {
        const preview = entries
          .map((entry) => `- ${entry?.content ?? ""}`)
          .filter((line) => line.trim() !== "- ")
          .join("\n");
        emitLogEvent(state.onProgress, {
          message: `Plan updated (${entries.length} step${entries.length === 1 ? "" : "s"}).`,
          phase: "planning",
          logTitle: "Plan",
          logBody: preview
        });
      }
      return;
    }
    case "commands_available_update":
    case "current_mode_update":
    case "user_message_chunk":
    default:
      return;
  }
}

function completePrompt(state, stopReason) {
  if (state.completed) return;
  state.completed = true;
  state.stopReason = stopReason;
  emitProgress(
    state.onProgress,
    `Session turn ${stopReason === "end_turn" ? "completed" : stopReason}.`,
    stopReason === "end_turn" ? "finalizing" : "failed"
  );
  state.resolveCompletion(state);
}

async function capturePrompt(client, sessionId, startRequest, options = {}) {
  const state = createPromptCaptureState(sessionId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
    if (message?.method === "session/update") {
      applySessionUpdate(state, message.params);
      return;
    }
    previousHandler?.(message);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    completePrompt(state, response?.stopReason ?? "end_turn");
    return await state.completion;
  } catch (error) {
    state.error = error;
    completePrompt(state, "refusal");
    return state;
  } finally {
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAcpClient(cwd, fn, options = {}) {
  let client = null;
  try {
    client = await CopilotAcpClient.connect(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }
    if (!shouldRetryDirect) throw error;

    const directClient = await CopilotAcpClient.connect(cwd, { ...options, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

function buildPromptBlocks(prompt) {
  return [{ type: "text", text: prompt }];
}

function buildResultStatus(state) {
  if (state.error) return 1;
  return state.stopReason === "end_turn" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getCopilotAvailability(cwd) {
  const versionStatus = binaryAvailable("copilot", ["--version"], { cwd });
  if (!versionStatus.available) return versionStatus;
  return {
    available: true,
    detail: `${versionStatus.detail}; ACP v${ACP_PROTOCOL_VERSION} runtime available`
  };
}


export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Copilot ACP runtime.",
      endpoint
    };
  }
  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Copilot runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

function resolveCopilotConfigPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() ? env.XDG_CONFIG_HOME : os.homedir();
  return path.join(configHome, ".copilot", "config.json");
}

function readCopilotConfig(env = process.env) {
  const configPath = resolveCopilotConfigPath(env);
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: false,
    provider: null,
    ...fields
  };
}

export async function getCopilotAuthStatus(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: false,
      provider: null
    };
  }

  const env = options.env ?? process.env;
  const config = readCopilotConfig(env);
  const loggedUsers = Array.isArray(config?.logged_in_users) ? config.logged_in_users : [];
  if (loggedUsers.length > 0) {
    const user = config.last_logged_in_user ?? loggedUsers[0];
    const login = typeof user?.login === "string" ? user.login : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: login ? `Copilot login active for ${login}` : "Copilot login active",
      source: "config",
      authMethod: "copilot-login",
      verified: true,
      provider: "github-copilot"
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: "Copilot CLI is installed but no GitHub account is signed in. Run `!copilot login`.",
    source: "config"
  });
}


export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId) {
    return { attempted: false, interrupted: false, transport: null, detail: "missing sessionId" };
  }
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return { attempted: false, interrupted: false, transport: null, detail: availability.detail };
  }

  let client = null;
  try {
    client = await CopilotAcpClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("session/cancel", { sessionId: threadId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Cancelled session ${threadId}${turnId ? ` (turn ${turnId})` : ""}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

function ensureCopilotAvailable(cwd) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Copilot CLI is not installed or ACP is unavailable. Install with `npm install -g @github/copilot`, then rerun `/copilot:setup`."
    );
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  ensureCopilotAvailable(cwd);
  return withAcpClient(cwd, async (client) => {
    let sessionId = options.resumeThreadId ?? null;

    if (!sessionId) {
      emitProgress(options.onProgress, "Starting Copilot session.", "starting");
      const response = await client.request("session/new", { cwd, mcpServers: [] });
      sessionId = response.sessionId;
    }

    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", {
      threadId: sessionId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Copilot run.");
    }

    const state = await capturePrompt(
      client,
      sessionId,
      () =>
        client.request("session/prompt", {
          sessionId,
          prompt: buildPromptBlocks(prompt)
        }),
      { onProgress: options.onProgress }
    );

    return {
      status: buildResultStatus(state),
      threadId: sessionId,
      turnId: sessionId,
      finalMessage: state.lastAgentMessage,
      reasoningSummary: state.reasoningSummary,
      turn: { id: sessionId, status: state.stopReason ?? "completed" },
      error: state.error,
      stderr: cleanCopilotStderr(client.stderr),
      fileChanges: state.fileChanges,
      touchedFiles: [...state.touchedFiles],
      commandExecutions: state.commandExecutions,
      copilotSessionId: sessionId
    };
  });
}

export async function runAppServerReview(cwd, options = {}) {
  // Copilot CLI has no native `review/start` RPC. The companion script is
  // expected to build a structured review prompt and call runAppServerTurn
  // directly. We keep this export so the companion's native-review branch
  // can be simplified without breaking imports; it delegates to
  // runAppServerTurn under the hood.
  return runAppServerTurn(cwd, options);
}

export async function findLatestTaskThread(_cwd) {
  // Copilot's ACP surface has no thread-listing RPC. The companion script
  // falls back to the local `state.mjs` job store, which already tracks
  // threadId per completed job.
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Copilot did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const trimmed = String(rawOutput).trim();
  // Copilot often wraps JSON in ```json fences when emitting structured
  // output. Strip those before parsing.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return {
      parsed: JSON.parse(unfenced),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
