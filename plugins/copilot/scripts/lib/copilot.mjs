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
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { readJsonFile } from "./fs.mjs";
import {
  ACP_PROTOCOL_VERSION,
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  COPILOT_COMMAND_ENV,
  CopilotAcpClient,
  resolveCopilotCommand
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
  const label =
    stopReason === "end_turn"
      ? "completed"
      : stopReason === null
        ? "failed (transport error)"
        : stopReason;
  emitProgress(
    state.onProgress,
    `Session turn ${label}.`,
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
    // Per ACP v1, the session/prompt response is the end-of-stream marker:
    // the agent is required to finish emitting session/update notifications
    // before returning stopReason. Our JSONL parser dispatches notifications
    // synchronously inside handleChunk, so by the time this await resolves
    // every update from the same chunk has already been applied to `state`.
    completePrompt(state, response?.stopReason ?? "end_turn");
    return await state.completion;
  } catch (error) {
    state.error = error;
    // Distinguish transport errors from ACP-defined stop reasons (including
    // "refusal", which means the model refused). Using null makes it obvious
    // at the downstream renderer that this was an infra failure, not an LLM
    // outcome.
    completePrompt(state, null);
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

export function getCopilotAvailability(cwd, options = {}) {
  // Honor the test-only COPILOT_COMPANION_COPILOT_COMMAND override so hook
  // tests can point the availability probe at the same fake binary as the
  // ACP client. In production the env var is unset and this resolves to
  // plain `["copilot"]`.
  const env = options.env ?? process.env;
  const [bin, ...preArgs] = resolveCopilotCommand(env);
  // When a custom command is in play, disable the Windows shell wrapper so
  // cmd.exe's arg-splitting does not mangle absolute paths containing
  // spaces (e.g., test workspaces under %USERPROFILE%\OneDrive - *).
  const useCustomCommand = Boolean(env[COPILOT_COMMAND_ENV]);
  const versionStatus = binaryAvailable(bin, [...preArgs, "--version"], {
    cwd,
    env,
    shell: useCustomCommand ? false : undefined
  });
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
  const availability = getCopilotAvailability(cwd, { env: options.env });
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


export async function interruptAppServerTurn(cwd, { threadId, turnId, env } = {}) {
  if (!threadId) {
    return { attempted: false, interrupted: false, transport: null, detail: "missing sessionId" };
  }
  const availability = getCopilotAvailability(cwd, { env });
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

function ensureCopilotAvailable(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd, { env: options.env });
  if (!availability.available) {
    throw new Error(
      "Copilot CLI is not installed or ACP is unavailable. Install with `npm install -g @github/copilot`, then rerun `/copilot:setup`."
    );
  }
}

// Shell/cmd.exe metacharacters. Any of these in a user-controlled argv slot
// becomes a command-injection vector on Windows where we keep `shell:true`
// for `.cmd` launcher resolution (CVE-2024-27980 / "BatBadBut" class). We
// fail closed across all platforms rather than diffing behaviour by shell
// flag — callers hitting this can reword or drop `--model`/`--effort` to
// route through the ACP broker, where prompts travel over JSON-RPC and
// never reach a shell.
const SHELL_METACHAR_RE = /[`$&|;<>^"\r\n\x00]|%[^%]*%/;

function assertNoShellMetachars(value, label) {
  if (typeof value !== "string" || SHELL_METACHAR_RE.test(value)) {
    throw new Error(
      `Refusing to spawn Copilot CLI: ${label} contains a shell metacharacter ` +
        "(one of ` $ & | ; < > ^ \" CR LF NUL %VAR%). Reword the " +
        `${label} or drop --model/--effort to route through the broker.`
    );
  }
}

/**
 * Per-call CLI fallback for `--model`. Copilot CLI exposes `--model` only at
 * spawn time, so the shared ACP broker (spawned once per Claude session with
 * fixed flags) cannot honor a per-call model switch. When the caller asks
 * for a specific model, we bypass the broker entirely and invoke
 * `copilot -p "<prompt>" --model <model> ...` as a one-shot subprocess.
 *
 * The returned shape matches the broker path so renderers, job records, and
 * status reporters stay identical; the trade-off is coarser progress (we
 * emit two phase transitions instead of streaming `session/update` events)
 * and no `copilotSessionId` (the CLI one-shot has no resumable sessionId).
 *
 * Note on `--allow-all-tools --allow-all-paths`: the shared broker spawns
 * with the same flags (see `DEFAULT_COPILOT_SPAWN_ARGS` in acp-client.mjs),
 * so the one-shot CLI does not widen the CLI-level permission set. What the
 * broker additionally provides is auto-approval of ACP
 * `session/request_permission` calls via `firstAllowOption` (allow_once,
 * never allow_always); one-shot `-p` mode has no such round-trip hook, so
 * any tool Copilot chooses to invoke during the single call runs without
 * per-call mediation. Callers that need per-tool approval should route
 * through the broker by omitting `--model`/`--effort`.
 */
async function runCopilotCli(cwd, options = {}) {
  const env = options.env ?? process.env;
  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Copilot run.");
  }

  const model = String(options.model);
  assertNoShellMetachars(prompt, "prompt");
  assertNoShellMetachars(model, "--model value");
  assertNoShellMetachars(cwd, "working directory");

  const [bin, ...preArgs] = resolveCopilotCommand(env);
  const useCustomCommand = Boolean(env[COPILOT_COMMAND_ENV]);
  const shell =
    useCustomCommand || process.platform !== "win32" ? false : env.SHELL || true;
  const args = [
    ...preArgs,
    "-p",
    prompt,
    "--allow-all-tools",
    "--allow-all-paths",
    "--add-dir",
    cwd,
    "--model",
    model
  ];

  const threadId = `cli-${crypto.randomUUID()}`;
  emitProgress(
    options.onProgress,
    `Starting Copilot CLI (--model ${model}).`,
    "starting",
    { threadId }
  );

  return await new Promise((resolve) => {
    // Node emits `error` (pre-spawn failures like ENOENT), `exit` (process
    // ended), and `close` (process ended AND all stdio streams drained).
    // `exit` can fire before the last stdout chunk arrives, which would
    // silently truncate `finalMessage`. Listen on `close` for the happy
    // path and guard against double-resolve if `error` fires after we've
    // already settled via `close` (or vice versa).
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    const proc = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell,
      windowsHide: true
    });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    proc.on("error", (error) => {
      emitProgress(
        options.onProgress,
        `Copilot CLI failed to start: ${error.message}`,
        "failed"
      );
      settle(
        buildCliResult({
          exit: 1,
          threadId,
          model,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          error
        })
      );
    });
    proc.on("close", (code, signal) => {
      const exit = code ?? (signal ? 1 : 0);
      emitProgress(
        options.onProgress,
        exit === 0
          ? `Copilot CLI completed (${model}).`
          : `Copilot CLI exited ${signal ? `(signal ${signal})` : `(code ${code})`}.`,
        exit === 0 ? "finalizing" : "failed"
      );
      settle(
        buildCliResult({
          exit,
          threadId,
          model,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          error: null
        })
      );
    });
  });
}

function buildCliResult({ exit, threadId, model, stdout, stderr, error }) {
  const trimmed = stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return {
    status: exit === 0 ? 0 : 1,
    threadId,
    turnId: threadId,
    finalMessage: trimmed,
    reasoningSummary: [],
    turn: {
      id: threadId,
      status: exit === 0 ? "end_turn" : error ? "transport_error" : "failed",
      model
    },
    error,
    stderr: cleanCopilotStderr(stderr),
    fileChanges: [],
    touchedFiles: [],
    commandExecutions: [],
    copilotSessionId: null
  };
}

export async function runAppServerTurn(cwd, options = {}) {
  ensureCopilotAvailable(cwd, { env: options.env });

  // When the caller pins a per-call --model, route through the one-shot CLI
  // fallback. Resume is incompatible with this path (the CLI one-shot cannot
  // load a broker-held sessionId), so a resume request stays on the broker
  // and we surface a note that --model was dropped.
  if (options.model && !options.resumeThreadId) {
    return runCopilotCli(cwd, options);
  }
  if (options.model && options.resumeThreadId) {
    process.stderr.write(
      `[copilot] --model ${options.model} is ignored when --resume/--resume-last is used; Copilot CLI cannot switch models on a resumed broker session.\n`
    );
  }

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

    // Distinguish a true completion from a transport-synthesized stopReason:
    // capturePrompt sets state.stopReason=null AND state.error=<Error> when
    // the ACP request itself throws. Collapsing both into "completed" in
    // turn.status would lie to any consumer that reads that field (stored
    // job records, future UI renderers).
    const turnStatus =
      state.stopReason ?? (state.error ? "transport_error" : "completed");

    return {
      status: buildResultStatus(state),
      threadId: sessionId,
      turnId: sessionId,
      finalMessage: state.lastAgentMessage,
      reasoningSummary: state.reasoningSummary,
      turn: { id: sessionId, status: turnStatus },
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
