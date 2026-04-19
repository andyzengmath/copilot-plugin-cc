import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { PLUGIN_ROOT } from "./harness.mjs";
import { resolveStateDir } from "../plugins/copilot/scripts/lib/state.mjs";

const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");

function envFor({ sessionId, pluginData } = {}) {
  return {
    ...process.env,
    ...(pluginData ? { CLAUDE_PLUGIN_DATA: pluginData } : {}),
    ...(sessionId ? { COPILOT_COMPANION_SESSION_ID: sessionId } : {})
  };
}

function seedState(workspace, pluginData, { config = {}, jobs = [], jobFiles = {} } = {}) {
  const stateDir = resolveStateDir(workspace, { pluginData });
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      { version: 1, config: { stopReviewGate: false, ...config }, jobs },
      null,
      2
    )}\n`,
    "utf8"
  );
  for (const [jobId, payload] of Object.entries(jobFiles)) {
    fs.writeFileSync(
      path.join(jobsDir, `${jobId}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
  }
  return { stateDir, jobsDir };
}

test("SessionStart hook writes COPILOT_COMPANION_SESSION_ID + CLAUDE_PLUGIN_DATA to the env file", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginData = makeTempDir();

  const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginData
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(envFile, "utf8");
  assert.match(written, /export COPILOT_COMPANION_SESSION_ID='sess-current'/);
  assert.match(written, new RegExp(`export CLAUDE_PLUGIN_DATA='${pluginData.replace(/\\/g, "\\\\")}'`));
});

test("SessionEnd hook removes jobs belonging to the ending session", () => {
  const repo = makeTempDir();
  const pluginData = makeTempDir();
  seedState(repo, pluginData, {
    jobs: [
      {
        id: "task-ending-session",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        sessionId: "sess-ending",
        summary: "this one should be removed",
        updatedAt: "2026-04-17T20:00:00.000Z",
        completedAt: "2026-04-17T20:00:10.000Z"
      },
      {
        id: "task-other",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        sessionId: "sess-other",
        summary: "this one stays",
        updatedAt: "2026-04-17T20:05:00.000Z",
        completedAt: "2026-04-17T20:05:10.000Z"
      }
    ]
  });

  const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: envFor({ pluginData }),
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ending",
      cwd: repo
    })
  });
  assert.equal(result.status, 0, result.stderr);

  const stateFile = path.join(resolveStateDir(repo, { pluginData }), "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const remaining = state.jobs.map((j) => j.id);
  assert.deepEqual(remaining, ["task-other"]);
});

test("stop hook (gate disabled) notes a running task on stderr and does not block", () => {
  const repo = makeTempDir();
  const pluginData = makeTempDir();
  seedState(repo, pluginData, {
    config: { stopReviewGate: false },
    jobs: [
      {
        id: "task-live",
        status: "running",
        title: "Copilot Task",
        jobClass: "task",
        sessionId: "sess-current",
        logFile: null,
        createdAt: "2026-04-17T15:30:00.000Z",
        updatedAt: "2026-04-17T15:30:05.000Z"
      }
    ]
  });

  const result = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: envFor({ pluginData, sessionId: "sess-current" }),
    input: JSON.stringify({ cwd: repo, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  // No JSON decision emitted — hook does not block when gate is disabled.
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Copilot task task-live is still running/i);
  assert.match(result.stderr, /\/copilot:status/);
  assert.match(result.stderr, /\/copilot:cancel task-live/);
});

test("stop hook (gate disabled) is silent when no jobs are running", () => {
  const repo = makeTempDir();
  const pluginData = makeTempDir();
  // No seedState: fresh plugin data dir, no jobs.

  const result = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: envFor({ pluginData, sessionId: "sess-current" }),
    input: JSON.stringify({ cwd: repo, session_id: "sess-current" })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  // No running-task note — stderr should be empty of our markers.
  assert.doesNotMatch(result.stderr, /is still running/i);
});

// Deferred: "stop hook when Copilot is unavailable" and "stop hook with a
// clean review verdict" both need either Copilot removed from PATH or a
// live fake-copilot handshake. getCopilotAvailability probes `copilot` on
// PATH directly (not via COPILOT_COMMAND_ENV), so the unavailable path is
// environment-dependent; the clean-verdict path needs a full ACP round
// trip. Both revisit in v0.3 alongside broker-scoped model plumbing.
