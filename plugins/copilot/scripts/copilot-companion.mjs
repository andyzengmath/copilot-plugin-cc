#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCopilotAuthStatus,
    getCopilotAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    isModelUnavailableStderr,
    parseStructuredOutput,
    probeModelAvailability,
    runAppServerTurn
  } from "./lib/copilot.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
// User-facing shorthand for the most-reached-for Copilot models. The
// right-hand side is whatever Copilot ships as the current "major" of
// each family — refresh when Copilot publishes a newer top model
// (check https://docs.github.com/en/copilot/reference/ai-models/supported-models
// rather than local `copilot --help`, which lags the catalog). Concrete
// model names (e.g. `claude-opus-4.5`, `gpt-5.1-codex-max`, `gpt-5.4-mini`)
// always work via `--model` pass-through without needing an alias.
//
// Premium-multiplier caveat: `claude-opus-4.7` currently sits at a 7.5x
// Copilot premium-request multiplier (through 2026-04-30), so `--model
// opus` is user-pays-more relative to the v0.0.10-era `opus` → 4.6
// mapping. Users who want the pre-4.7 cost can type `--model
// claude-opus-4.6` explicitly. The plugin's `--effort high` default
// (EFFORT_TO_MODEL below) deliberately stays on `claude-opus-4.6` so
// automated flows that rely on `--effort` don't change their per-call
// cost without an explicit user decision.
const MODEL_ALIASES = new Map([
  ["fast", "claude-opus-4.6-fast"],
  ["opus", "claude-opus-4.7"],
  ["sonnet", "claude-sonnet-4.6"],
  ["haiku", "claude-haiku-4.5"],
  ["gpt", "gpt-5.4"],
  ["codex", "gpt-5.3-codex"]
]);
// Copilot CLI has no per-call reasoning-effort knob. We translate the
// codex-plugin-cc `--effort` levels into a matching model choice.
const EFFORT_TO_MODEL = new Map([
  ["none", "claude-opus-4.6-fast"],
  ["minimal", "claude-opus-4.6-fast"],
  ["low", "claude-opus-4.6-fast"],
  ["medium", "claude-sonnet-4.6"],
  ["high", "claude-opus-4.6"],
  ["xhigh", "claude-opus-4.6"]
]);

// When the primary effort-mapped model is not available on the user's
// Copilot account, /copilot:task degrades down the capability tiers
// rather than failing outright. The chain only activates for `--effort`
// (no explicit --model). Each entry is the ordered list of fallbacks
// AFTER the primary mapping; the runtime loop tries the primary first,
// then walks this list. Entries lower in the chain are progressively
// less capable but more widely available (Copilot Free / Pro / Business
// tiers ship subsets of these models).
// `claude-haiku-4.5` pins the tail of the medium/high chains as the
// lowest-cost, widest-availability Claude tier. Added in v0.10 after a
// `copilot --help` audit confirmed the model is exposed on every tier
// that ships `--model` support. Strictly-additive: it never fires while
// an earlier tier is available.
const EFFORT_FALLBACK_CHAIN = new Map([
  ["none", []],
  ["minimal", []],
  ["low", []],
  ["medium", ["claude-opus-4.6-fast", "claude-haiku-4.5"]],
  ["high", ["claude-sonnet-4.6", "claude-opus-4.6-fast", "claude-haiku-4.5"]],
  ["xhigh", ["claude-sonnet-4.6", "claude-opus-4.6-fast", "claude-haiku-4.5"]]
]);

function applyEffortFallbackModel(model, effort) {
  if (model || !effort) return model;
  return EFFORT_TO_MODEL.get(effort) ?? null;
}

function buildEffortModelChain({ requestedModel, effort, primaryModel }) {
  // Auto-fallback only when --effort drove the model choice. An explicit
  // --model X is the user opting into a specific model; if it fails, we
  // surface the error rather than silently substituting.
  if (requestedModel || !effort || !primaryModel) {
    return primaryModel ? [primaryModel] : [null];
  }
  const fallbacks = EFFORT_FALLBACK_CHAIN.get(effort) ?? [];
  // Drop duplicates (e.g. if a fallback equals the primary) while
  // preserving order.
  const seen = new Set();
  const chain = [];
  for (const candidate of [primaryModel, ...fallbacks]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    chain.push(candidate);
  }
  return chain;
}
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/copilot-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/copilot-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/copilot-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/copilot-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/copilot-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/copilot-companion.mjs result [job-id] [--json]",
      "  node scripts/copilot-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const copilotStatus = getCopilotAvailability(cwd);
  const authStatus = await getCopilotAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!copilotStatus.available) {
    nextSteps.push("Install Copilot with `npm install -g @github/copilot`.");
  }
  if (copilotStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!copilot login`.");
    nextSteps.push("If browser login is blocked, retry with `!copilot login --device-auth` or `!copilot login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/copilot:setup --enable-review-gate` to require a fresh review before stop.");
  }

  // --probe-models runs `copilot -p "ping" --model <m>` against every
  // distinct model that any --effort level could reach — the union of
  // EFFORT_TO_MODEL primaries and every tier in EFFORT_FALLBACK_CHAIN.
  // Before v0.10 this only covered the primaries, which hid the
  // fallback tiers from the probe (users could see "all ok" and still
  // fall through to a model their account couldn't actually reach).
  // Skipped by default to keep the default setup fast (each probe is a
  // full subprocess round-trip).
  let modelProbe = null;
  if (options.probeModels && copilotStatus.available) {
    const models = [
      ...new Set([
        ...EFFORT_TO_MODEL.values(),
        ...[...EFFORT_FALLBACK_CHAIN.values()].flat()
      ])
    ];
    modelProbe = await probeModelAvailability(cwd, { models });
    const unavailable = modelProbe.filter((r) => !r.available && !r.unknown);
    if (unavailable.length > 0) {
      nextSteps.push(
        `Some --effort tiers are unavailable on this account: ${unavailable
          .map((r) => r.model)
          .join(", ")}. /copilot:task will auto-fall-back; or pick --effort low / medium explicitly.`
      );
    }
  }

  return {
    ready: nodeStatus.available && copilotStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    copilot: copilotStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps,
    modelProbe
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: [
      "json",
      "enable-review-gate",
      "disable-review-gate",
      "probe-models"
    ]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, {
    probeModels: Boolean(options["probe-models"])
  });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function reviewTemplateName(reviewName) {
  return reviewName === "Adversarial Review" ? "adversarial-review" : "review";
}

function buildReviewPrompt(context, focusText, reviewName) {
  const template = loadPromptTemplate(ROOT_DIR, reviewTemplateName(reviewName));
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCopilotAvailable(cwd) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    throw new Error("Copilot CLI is not installed or is missing required runtime support. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`.");
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /copilot:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCopilotAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(context, focusText, reviewName);
  // Note: the ACP broker spawns once per Claude session with fixed
  // --allow-all-* flags, so read-only review is enforced by prompt
  // contract rather than runtime sandbox (Copilot CLI has no per-session
  // sandbox knob). The review prompt templates explicitly tell the agent
  // not to modify files.
  //
  // --effort driven model selection on the review path shares the same
  // availability fallback chain as /copilot:task: a missing top-tier
  // model degrades to the next tier rather than failing outright.
  // Review never takes `--resume-last`, so the chain is always the full
  // build result; explicit `--model` still opts out (single-element).
  const modelChain = buildEffortModelChain({
    requestedModel: request.requestedModel ?? null,
    effort: request.effort ?? null,
    primaryModel: request.model
  });
  if (modelChain.length === 0) {
    throw new Error(
      `Internal: buildEffortModelChain returned an empty chain for effort=${request.effort}.`
    );
  }
  let result;
  for (let i = 0; i < modelChain.length; i += 1) {
    const candidate = modelChain[i];
    result = await runAppServerTurn(context.repoRoot, {
      prompt,
      model: candidate,
      onProgress: request.onProgress
    });
    if (result.status === 0) break;
    const hasNext = i < modelChain.length - 1;
    if (!hasNext) break;
    if (
      !isModelUnavailableStderr(result.stderr) &&
      !isModelUnavailableStderr(result.error?.message ?? "")
    ) {
      break;
    }
    process.stderr.write(
      `[copilot] --model ${candidate} appears unavailable on this account; ` +
        `retrying with --model ${modelChain[i + 1]} (--effort ${request.effort} fallback chain).\n`
    );
  }
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    copilot: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Copilot ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCopilotAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Copilot task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Note: the ACP broker spawns once per Claude session, so permission
  // scoping for the task (`--write` on or off) is enforced by prompt
  // contract in the task-level instructions. Copilot CLI has no per-turn
  // sandbox knob, and we intentionally avoid restarting the broker
  // per-command to keep sessionId resume working.
  //
  // When --effort drove the model choice (no explicit --model), build a
  // fallback chain so a non-available top-tier model (e.g. user's
  // Copilot account is on a tier without claude-opus-4.6) degrades to
  // the next tier rather than failing outright. Resume forces the
  // broker path, where per-call --model is dropped anyway, so the chain
  // is collapsed to a single element below.
  const builtChain = buildEffortModelChain({
    requestedModel: request.requestedModel ?? null,
    effort: request.effort ?? null,
    primaryModel: request.model
  });
  // Collapse to a single element on resume: the broker path ignores
  // per-call --model, so iterating the full chain would fire N identical
  // broker calls with misleading retry notices naming models that were
  // never used. Keep the first entry so `result.model` in turn metadata
  // stays consistent with what the companion originally asked for.
  const modelChain = resumeThreadId && builtChain.length > 1 ? [builtChain[0]] : builtChain;
  // Defense against a future change that could produce an empty chain
  // (e.g. a buildEffortModelChain rewrite that filters everything). The
  // loop body writes to `result`, and downstream code reads
  // `result.finalMessage` — a silent crash on `undefined` would be worse
  // than a loud precondition.
  if (modelChain.length === 0) {
    throw new Error(
      `Internal: buildEffortModelChain returned an empty chain for effort=${request.effort}.`
    );
  }
  // Compute threadName once rather than on every retry iteration; its
  // inputs (resumeThreadId, request.prompt) are loop-invariant, and if
  // a future `session/new` evolution forwards threadName, duplicating
  // calls inside the loop would register multiple sessions under the
  // same name.
  const threadName = resumeThreadId
    ? null
    : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT);
  let result;
  for (let i = 0; i < modelChain.length; i += 1) {
    const candidate = modelChain[i];
    result = await runAppServerTurn(workspaceRoot, {
      resumeThreadId,
      prompt: request.prompt,
      defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
      model: candidate,
      onProgress: request.onProgress,
      threadName
    });
    if (result.status === 0) break;
    const hasNext = i < modelChain.length - 1;
    if (!hasNext) break;
    if (!isModelUnavailableStderr(result.stderr) && !isModelUnavailableStderr(result.error?.message ?? "")) {
      break;
    }
    process.stderr.write(
      `[copilot] --model ${candidate} appears unavailable on this account; ` +
        `retrying with --model ${modelChain[i + 1]} (--effort ${request.effort} fallback chain).\n`
    );
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    copilotSessionId: result.copilotSessionId ?? result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Copilot Review" : `Copilot ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Copilot Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Copilot Resume" : "Copilot Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /copilot:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId, requestedModel }) {
  return {
    cwd,
    model,
    effort,
    // Pass through the user's literal --model value so executeTaskRun can
    // tell "user picked exactly this model" apart from "we mapped from
    // --effort". Only the latter triggers the auto-fallback chain.
    requestedModel: requestedModel ?? null,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  // Share /copilot:task's --effort → model mapping so the two commands
  // expose a single capability-tier vocabulary. Apply the same "--model
  // wins, --effort is a no-op" rule and the same unknown-effort notice.
  const effort = normalizeReasoningEffort(options.effort);
  const requestedModel = normalizeRequestedModel(options.model);
  const model = applyEffortFallbackModel(requestedModel, effort);
  if (requestedModel && effort) {
    process.stderr.write(
      `[copilot] --effort ${effort} is ignored because --model ${requestedModel} was also passed.\n`
    );
  } else if (effort && !requestedModel && !EFFORT_TO_MODEL.has(effort)) {
    process.stderr.write(
      `[copilot] --effort ${effort} has no mapped model; Copilot CLI will use its config default.\n`
    );
  }

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        requestedModel,
        effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const effort = normalizeReasoningEffort(options.effort);
  const requestedModel = normalizeRequestedModel(options.model);
  // Copilot does not expose a per-call reasoning-effort knob. When the user
  // specified --effort but not --model, pick a Copilot model whose capability
  // tier matches the requested effort. If both are set, --model wins and we
  // note the effort flag was ignored.
  const model = applyEffortFallbackModel(requestedModel, effort);
  const effortOverriddenByModel = Boolean(requestedModel && effort);
  if (effortOverriddenByModel) {
    process.stderr.write(
      `[copilot] --effort ${effort} is ignored because --model ${requestedModel} was also passed.\n`
    );
  } else if (effort && !requestedModel && !EFFORT_TO_MODEL.has(effort)) {
    // If an unknown effort level slipped past validation and no model
    // fallback applies, let the user know it has no runtime effect rather
    // than silently accepting the flag.
    process.stderr.write(
      `[copilot] --effort ${effort} has no mapped model; Copilot CLI will use its config default.\n`
    );
  }
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCopilotAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      requestedModel,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        requestedModel,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Copilot turn interrupt for ${turnId} on ${threadId}.`
        : `Copilot turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
