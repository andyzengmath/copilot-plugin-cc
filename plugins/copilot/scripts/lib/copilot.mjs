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
import { safeSpawn } from "./safe-spawn.mjs";

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

function resolveCopilotHome(env = process.env) {
  // Copilot CLI honors COPILOT_HOME first, then defaults to ~/.copilot. Older
  // releases of this plugin only honored XDG_CONFIG_HOME, which never matched
  // Copilot's own search path; keep XDG as a tail fallback for compatibility
  // with anyone who scripted around the old behavior, but prefer the official
  // env var.
  if (env.COPILOT_HOME && env.COPILOT_HOME.trim()) {
    return env.COPILOT_HOME.trim();
  }
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()) {
    return path.join(env.XDG_CONFIG_HOME.trim(), ".copilot");
  }
  return path.join(os.homedir(), ".copilot");
}

function resolveCopilotConfigPath(env = process.env) {
  // config.json holds auth + installed-plugins state. settings.json (read by
  // resolveCopilotSettingsPath below) is the user-facing preferences file
  // documented at https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli.
  return path.join(resolveCopilotHome(env), "config.json");
}

function resolveCopilotSettingsPath(env = process.env) {
  return path.join(resolveCopilotHome(env), "settings.json");
}

function parseJsonWithLineComments(raw) {
  // Both config.json and settings.json may carry full-line `// ...` comments.
  // Strip them before parsing rather than pulling in a JSON5 parser.
  const stripped = String(raw).replace(/^\s*\/\/[^\n]*$/gm, "");
  return JSON.parse(stripped);
}

function readCopilotConfig(env = process.env) {
  const configPath = resolveCopilotConfigPath(env);
  if (!fs.existsSync(configPath)) return null;
  try {
    return parseJsonWithLineComments(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function readCopilotSettings(env = process.env) {
  const settingsPath = resolveCopilotSettingsPath(env);
  if (!fs.existsSync(settingsPath)) return null;
  try {
    return parseJsonWithLineComments(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve the model + effortLevel that a Copilot call will actually run with,
 * and tag the source so the user can see whether it came from a per-call
 * --model flag, the COPILOT_MODEL env var, ~/.copilot/settings.json, or the
 * Copilot CLI's own built-in default.
 *
 * Precedence mirrors Copilot CLI's documented hierarchy
 * (https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli):
 *   1. /model (interactive — not seen by us)
 *   2. --model CLI flag at launch  → requestedModel here
 *   3. COPILOT_MODEL env var
 *   4. settings.json `model` key
 *   5. system default (Claude Sonnet 4.5 today)
 *
 * effortLevel is only sourced from env / settings.json — there is no
 * per-call equivalent in Copilot CLI < 1.0.11. Callers that pass
 * --effort to /copilot:* still see it reflected separately in the call
 * args; this helper only describes inherited state.
 *
 * @param {{ requestedModel?: string | null, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ model: string | null, effortLevel: string | null, source: string }}
 */
export function getActiveCopilotModelInfo({ requestedModel = null, env = process.env } = {}) {
  const trimmedRequested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (trimmedRequested) {
    return { model: trimmedRequested, effortLevel: null, source: "--model flag" };
  }
  const envModel = typeof env.COPILOT_MODEL === "string" ? env.COPILOT_MODEL.trim() : "";
  if (envModel) {
    const envEffort = typeof env.COPILOT_EFFORT_LEVEL === "string" ? env.COPILOT_EFFORT_LEVEL.trim() : "";
    return {
      model: envModel,
      effortLevel: envEffort || null,
      source: "COPILOT_MODEL env"
    };
  }
  const settings = readCopilotSettings(env);
  const settingsModel = typeof settings?.model === "string" ? settings.model.trim() : "";
  if (settingsModel) {
    const settingsEffort = typeof settings?.effortLevel === "string" ? settings.effortLevel.trim() : "";
    return {
      model: settingsModel,
      effortLevel: settingsEffort || null,
      source: "~/.copilot/settings.json"
    };
  }
  return { model: null, effortLevel: null, source: "Copilot CLI default" };
}

/**
 * Render a single human-readable line describing the active model. Used by
 * both the setup report and the per-call stderr echo so the two stay in
 * sync when the format evolves.
 *
 * @param {{ model: string | null, effortLevel: string | null, source: string }} info
 */
export function formatActiveModelLine(info) {
  if (!info) return "";
  const modelLabel = info.model || "Copilot CLI default (claude-sonnet-4.6)";
  const effortLabel = info.effortLevel ? `, effort ${info.effortLevel}` : "";
  return `${modelLabel}${effortLabel} [${info.source}]`;
}

// Copilot CLI's settings.json effortLevel only accepts these tokens. The
// plugin's --effort vocabulary additionally exposes "none" and "minimal" for
// codex-plugin-cc parity; we collapse those onto "low" when writing through
// to settings.json since Copilot would reject the literal value.
const COPILOT_SETTINGS_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh"]);
const PLUGIN_TO_COPILOT_EFFORT = new Map([
  ["none", "low"],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"]
]);

export function normalizeEffortForSettings(effort) {
  if (typeof effort !== "string") return null;
  const lowered = effort.trim().toLowerCase();
  if (!lowered) return null;
  return PLUGIN_TO_COPILOT_EFFORT.get(lowered) ?? null;
}

/**
 * Persist a model and/or effortLevel default into ~/.copilot/settings.json
 * (or $COPILOT_HOME/settings.json), preserving every other key the user has
 * already set. Used by `/copilot:setup --default-model X --default-effort Y`.
 *
 * Leading `// ...` line comments are preserved verbatim; trailing/inline
 * comments are not (we never observed any in-the-wild settings.json with
 * inline comments and the strip-and-restore approach for inline comments
 * would require a JSONC parser we don't otherwise need).
 *
 * Atomic write: temp file in the same directory + rename so a crash mid-
 * write cannot leave a half-written settings.json.
 *
 * @param {{ model?: string | null, effortLevel?: string | null, env?: NodeJS.ProcessEnv }} options
 * @returns {{ path: string, applied: { model?: string, effortLevel?: string }, before: { model: string|null, effortLevel: string|null } }}
 */
export function writeCopilotDefaults({ model = null, effortLevel = null, env = process.env } = {}) {
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  const normalizedEffort = normalizeEffortForSettings(effortLevel);
  // Validate effort first: a non-empty `extreme` is a clearer error than the
  // generic "must provide one of..." message that would otherwise fire when
  // it normalizes to null.
  if (typeof effortLevel === "string" && effortLevel.trim() && !normalizedEffort) {
    throw new Error(
      `Invalid --default-effort value "${effortLevel}". Expected one of: low, medium, high, xhigh (none/minimal collapse to low).`
    );
  }
  if (!trimmedModel && !normalizedEffort) {
    throw new Error("writeCopilotDefaults: at least one of model or effortLevel must be provided.");
  }

  const home = resolveCopilotHome(env);
  fs.mkdirSync(home, { recursive: true });
  const settingsPath = path.join(home, "settings.json");

  // Preserve any leading // comment block by extracting it before parse and
  // re-emitting it on write. Anything more exotic (block comments, inline
  // comments) is not preserved — settings.json in the wild does not appear
  // to use either form.
  let leadingComments = "";
  let body = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const commentMatch = raw.match(/^(\s*\/\/[^\n]*\n)+/);
    if (commentMatch) {
      leadingComments = commentMatch[0];
    }
    try {
      body = parseJsonWithLineComments(raw) ?? {};
    } catch {
      // Refuse to overwrite a file we can't parse — better to surface an
      // error than to silently nuke whatever shape the user's settings.json
      // is in. The caller can hand-edit and retry.
      throw new Error(
        `Refusing to overwrite ${settingsPath}: existing file does not parse as JSON. Fix or remove it manually first.`
      );
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(
        `Refusing to overwrite ${settingsPath}: top-level must be a JSON object, got ${Array.isArray(body) ? "array" : typeof body}.`
      );
    }
  }

  const before = {
    model: typeof body.model === "string" ? body.model : null,
    effortLevel: typeof body.effortLevel === "string" ? body.effortLevel : null
  };
  const applied = {};

  if (trimmedModel) {
    body.model = trimmedModel;
    applied.model = trimmedModel;
  }
  if (normalizedEffort) {
    body.effortLevel = normalizedEffort;
    applied.effortLevel = normalizedEffort;
  }

  const json = `${JSON.stringify(body, null, 2)}\n`;
  const out = leadingComments ? `${leadingComments}${json}` : json;

  // Atomic write: same-dir temp + rename. Same-dir keeps rename on the same
  // filesystem volume, which is required for atomicity on POSIX and avoids
  // EXDEV on Windows when settings.json lives on a different drive than tmp.
  //
  // The temp suffix uses crypto.randomUUID() (not Date.now()) so two callers
  // racing in the same millisecond — e.g. parallel test runs in the same
  // process or a retry fired without awaiting — never compute the same path.
  // crypto is already imported at the top of this file. Soliton review of
  // PR #54 flagged the previous Date.now() variant as a concurrent-call
  // collision risk on Windows CI.
  const tempPath = path.join(home, `.settings.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, out, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tempPath, settingsPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }

  return { path: settingsPath, applied, before };
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
  // Field names flipped from snake_case to camelCase between Copilot
  // CLI 0.x and 1.x (`logged_in_users` → `loggedInUsers`,
  // `last_logged_in_user` → `lastLoggedInUser`). Accept either so a
  // user on an older CLI, a test fixture using the legacy shape, or a
  // freshly-upgraded CLI all resolve to the same loggedIn result.
  const loggedUsersRaw = config?.loggedInUsers ?? config?.logged_in_users;
  const loggedUsers = Array.isArray(loggedUsersRaw) ? loggedUsersRaw : [];
  if (loggedUsers.length > 0) {
    const user =
      config.lastLoggedInUser ?? config.last_logged_in_user ?? loggedUsers[0];
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


/**
 * @param {string} cwd
 * @param {{ threadId?: string|null, turnId?: string|null, env?: NodeJS.ProcessEnv }} [options]
 */
/**
 * Probe whether each Copilot model is available on the current account.
 * Spawns `copilot -p "ping" --model <model>` for each candidate in
 * parallel and classifies the result via `isModelUnavailableStderr`:
 *
 *   - exit 0                    → { available: true,  detail: "ok" }
 *   - non-zero + stderr matches → { available: false, detail: <first stderr line> }
 *   - non-zero + no match       → { available: false, unknown: true, detail: "exit N: ..." }
 *   - spawn error / timeout     → { available: false, unknown: true, detail: "..." }
 *
 * Used by `/copilot:setup --probe-models` so users see their
 * `--effort` tier upfront rather than discovering unavailability at
 * task time via the fallback-chain stderr notices.
 */
// 60s default — measured cold-start of `copilot -p "ping" --model X` on
// CLI 1.0.40-0 was ~33s for a single invocation (per the v0.0.20
// post-release dogfooding smoke test). 15s (the v0.0.7 default) reliably
// timed out every probe with a misleading "unknown" verdict on real
// accounts. Probes still run in parallel, so wall-clock cost of
// `--probe-models` is bounded by the slowest probe, not the sum.
const DEFAULT_PROBE_TIMEOUT_MS = 60000;

export async function probeModelAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const models = Array.isArray(options.models) ? options.models : [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  if (models.length === 0) return [];
  return Promise.all(
    models.map((model) => probeSingleModel(cwd, model, { env, timeoutMs }))
  );
}

function probeSingleModel(cwd, model, { env, timeoutMs }) {
  const [bin, ...preArgs] = resolveCopilotCommand(env);
  const args = [
    ...preArgs,
    "-p",
    "ping",
    "--allow-all-tools",
    "--allow-all-paths",
    "--add-dir",
    cwd,
    "--model",
    String(model)
  ];
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve({ model, ...result });
    };
    let stderrBuf = "";
    const proc = safeSpawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    proc.on("error", (error) => {
      settle({
        available: false,
        unknown: true,
        detail: `probe failed to spawn: ${error.message}`
      });
    });
    proc.on("close", (code, signal) => {
      const exit = code ?? (signal ? 1 : 0);
      if (exit === 0) {
        settle({ available: true, detail: "ok" });
        return;
      }
      const firstLine = stderrBuf.trim().split(/\r?\n/)[0] || `exit ${exit}`;
      if (isModelUnavailableStderr(stderrBuf)) {
        settle({ available: false, detail: firstLine });
      } else {
        settle({ available: false, unknown: true, detail: `exit ${exit}: ${firstLine}` });
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        proc.kill();
      } catch {
        // best-effort
      }
      settle({
        available: false,
        unknown: true,
        detail: `probe timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function interruptAppServerTurn(cwd, options = {}) {
  const { threadId, turnId, env } = options;
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

// A failure from the per-call CLI looks like a model-availability problem
// when stderr names a "model" alongside one of the well-known availability
// signals. The pattern is intentionally conservative:
//
// 1. Must mention "model" AND an availability indicator on the SAME LINE
//    ([^\n] instead of [\s\S]) within ~80 chars. Cross-paragraph matches
//    would conflate unrelated sentences that just happen to co-occur.
// 2. Availability indicators are phrases specific to model access control
//    ("not available", "not authorized", "access denied", "access required",
//    "no access", "requires <X> tier|plan|subscription") plus the qualified
//    form "forbidden for/on/to …" which specifically means access-denied
//    for the caller. Bare "forbidden" is NOT an indicator because content-
//    policy rejections commonly read "…was forbidden by content policy",
//    which is a different failure class that should surface verbatim
//    rather than silently swap models.
//
// A generic non-zero exit (network glitch, prompt rejected, tool failure,
// content-policy block) does NOT trigger the --effort fallback chain in
// copilot-companion.mjs. If a real Copilot CLI release uses an
// availability phrase outside this set, the fallback simply does not
// engage — safe failure mode, user sees the original error.
const MODEL_UNAVAILABLE_RE =
  /\bmodel\b[^\n]{0,80}?\b(?:not\s*available|unavailable|not\s*authorized|access\s*denied|forbidden\s+(?:for|on|to)\b|requires?\s+(?:a\s+)?[\w-]*\s*(?:tier|plan|subscription)|access\s*required|no\s*access)\b/i;

export function isModelUnavailableStderr(text) {
  if (typeof text !== "string" || !text) return false;
  return MODEL_UNAVAILABLE_RE.test(text);
}

// Note: the v0.0.6-era `SHELL_METACHAR_RE` / `assertNoShellMetachars` deny-list
// was removed in v0.0.18 when the spawn paths migrated to `safeSpawn` (see
// `lib/safe-spawn.mjs`). safeSpawn pre-resolves Windows .cmd launchers and
// hands argv to cmd.exe via cross-spawn-style escaping with
// `windowsVerbatimArguments: true`, so cmd.exe metachars in argv are quoted
// safely without us needing a runtime deny-list. This eliminates the entire
// CVE-2024-27980 / "BatBadBut" attack surface in the plugin's own code.

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

  // model and effort are independent — either, both, or neither may be set.
  // Neither would normally route through the broker (runAppServerTurn checks
  // before dispatching here), but tolerate it defensively so direct callers
  // don't get a confusing error.
  const model = options.model ? String(options.model) : null;
  const effort = options.effort ? String(options.effort) : null;
  const [bin, ...preArgs] = resolveCopilotCommand(env);
  // safeSpawn handles Windows .cmd-launcher resolution + cross-spawn-style
  // argv escaping internally, so the plugin no longer needs to flip
  // shell:true on Windows production. The `assertNoShellMetachars` deny-list
  // (formerly required for the shell:true path) was removed in v0.0.18.
  const args = [
    ...preArgs,
    "-p",
    prompt,
    "--allow-all-tools",
    "--allow-all-paths",
    // Mirror the broker's `--no-ask-user`: the one-shot CLI runs through
    // Claude Code's harness, so the agent's `ask_user` tool would have
    // no answerer. Disable it outright instead of stalling the run.
    "--no-ask-user",
    // Mirror the broker's auth-token redaction so a debug-style shell
    // command in the agent's plan can't echo the literal GH_TOKEN /
    // GITHUB_TOKEN / COPILOT_GITHUB_TOKEN value into the run's stdout.
    "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
    // Deny shell access to known prompt-injection exfiltration commands.
    // Per `copilot help permissions`: "Denial rules always take precedence
    // over allow rules, even --allow-all-tools." These commands have no
    // legitimate use in code-review or rescue workflows (GitHub API → gh
    // CLI; npm registry → npm). safeSpawn's escaping handles the parens
    // and `*` for us so cmd.exe doesn't misparse the argument.
    "--deny-tool=shell(curl:*)",
    "--deny-tool=shell(wget:*)",
    "--deny-tool=shell(nc:*)",
    "--deny-tool=shell(ncat:*)",
    "--deny-tool=shell(ssh:*)",
    "--add-dir",
    cwd
  ];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }

  const threadId = `cli-${crypto.randomUUID()}`;
  const flagSummary = [
    model ? `--model ${model}` : null,
    effort ? `--effort ${effort}` : null
  ]
    .filter(Boolean)
    .join(" ");
  emitProgress(
    options.onProgress,
    flagSummary ? `Starting Copilot CLI (${flagSummary}).` : "Starting Copilot CLI.",
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
    const proc = safeSpawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
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

  // Echo the model + effort that the upcoming call will actually use, so the
  // user can confirm whether they're getting their settings.json default
  // (e.g. gpt-5.5) or an override from --model. Goes to stderr to keep the
  // task command's verbatim stdout contract intact.
  const activeInfo = getActiveCopilotModelInfo({
    requestedModel: options.model ?? null,
    env: options.env ?? process.env
  });
  process.stderr.write(`[copilot] Using model: ${formatActiveModelLine(activeInfo)}\n`);

  // When the caller pins per-call --model or --effort, route through the
  // one-shot CLI. Copilot CLI 1.0.11+ honors both flags independently, and
  // the broker (one shared `copilot --acp` per Claude session) can't switch
  // either mid-turn — its model/effort were fixed at spawn time.
  //
  // Resume is incompatible with the one-shot path (the CLI one-shot cannot
  // load a broker-held sessionId), so a resume request stays on the broker
  // and we surface a stderr note that the per-call overrides were dropped.
  const wantsOneShot = options.model || options.effort;
  if (wantsOneShot && !options.resumeThreadId) {
    return runCopilotCli(cwd, options);
  }
  if (wantsOneShot && options.resumeThreadId) {
    const dropped = [
      options.model ? `--model ${options.model}` : null,
      options.effort ? `--effort ${options.effort}` : null
    ]
      .filter(Boolean)
      .join(" + ");
    process.stderr.write(
      `[copilot] ${dropped} ignored when --resume/--resume-last is used; Copilot CLI cannot switch model or effort on a resumed broker session.\n`
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

export { DEFAULT_CONTINUE_PROMPT };
