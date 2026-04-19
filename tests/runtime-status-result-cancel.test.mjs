import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { COMPANION_SCRIPT } from "./harness.mjs";
import { resolveStateDir } from "../plugins/copilot/scripts/lib/state.mjs";

function buildEnv({ sessionId, pluginData } = {}) {
  return {
    ...process.env,
    ...(pluginData ? { CLAUDE_PLUGIN_DATA: pluginData } : {}),
    ...(sessionId ? { COPILOT_COMPANION_SESSION_ID: sessionId } : {})
  };
}

function runCompanion(args, opts = {}) {
  return run(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: opts.cwd ?? makeTempDir(),
    env: buildEnv(opts)
  });
}

function seedState(workspace, pluginData, { config = {}, jobs = [], jobFiles = {} } = {}) {
  // resolveStateDir accepts an explicit pluginData override so we don't
  // have to mutate process.env. The companion subprocess spawned later
  // reads CLAUDE_PLUGIN_DATA from its own env and will compute the same
  // path.
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

test("status shows 'no jobs tracked' when the state is empty", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  // CLAUDE_PLUGIN_DATA is set but no state file exists yet.
  const result = runCompanion(["status"], { cwd: workspace, pluginData });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // Rendered status for zero jobs uses "No jobs tracked" or similar;
  // accept any phrase that makes it clear there's nothing to show.
  assert.match(result.stdout, /No jobs recorded yet\./);
});

test("status renders a completed review as the latest finished job", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const env = buildEnv({ pluginData });
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "review-done",
        status: "completed",
        title: "Copilot Review",
        jobClass: "review",
        kindLabel: "review",
        phase: "done",
        threadId: "thr_done",
        summary: "Review main...HEAD",
        createdAt: "2026-04-17T15:10:00.000Z",
        startedAt: "2026-04-17T15:10:05.000Z",
        completedAt: "2026-04-17T15:11:10.000Z",
        updatedAt: "2026-04-17T15:11:10.000Z"
      }
    ],
    jobFiles: {
      "review-done": {
        id: "review-done",
        status: "completed",
        title: "Copilot Review",
        rendered: "# Copilot Review\n\nNo material issues found.\n"
      }
    }
  });

  const result = run(process.execPath, [COMPANION_SCRIPT, "status"], {
    cwd: workspace,
    env
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Latest finished/);
  assert.match(result.stdout, /review-done/);
  assert.match(result.stdout, /Review main\.\.\.HEAD/);
  // Tighten beyond the section label: assert the renderer surfaces the
  // status and kind label so a regression that drops those fields would
  // fail this test rather than silently passing.
  assert.match(result.stdout, /completed/);
  assert.match(result.stdout, /Copilot Review/);
});

test("status filters by COPILOT_COMPANION_SESSION_ID when no job id is passed", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "job-current",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        kindLabel: "rescue",
        sessionId: "sess-current",
        threadId: "thr_current",
        summary: "Current session job",
        updatedAt: "2026-04-17T20:00:00.000Z",
        completedAt: "2026-04-17T20:00:10.000Z"
      },
      {
        id: "job-other",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        kindLabel: "rescue",
        sessionId: "sess-other",
        threadId: "thr_other",
        summary: "Other session job",
        updatedAt: "2026-04-17T20:05:00.000Z",
        completedAt: "2026-04-17T20:05:10.000Z"
      }
    ]
  });

  const result = run(process.execPath, [COMPANION_SCRIPT, "status"], {
    cwd: workspace,
    env: buildEnv({ pluginData, sessionId: "sess-current" })
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /job-current/);
  assert.doesNotMatch(result.stdout, /job-other/);
});

test("status <job-id> renders the specific job's detail", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-detail",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        kindLabel: "rescue",
        threadId: "thr_detail",
        summary: "Investigate flaky test",
        updatedAt: "2026-04-17T21:00:00.000Z",
        completedAt: "2026-04-17T21:00:30.000Z"
      }
    ]
  });

  const result = run(process.execPath, [COMPANION_SCRIPT, "status", "task-detail"], {
    cwd: workspace,
    env: buildEnv({ pluginData })
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /task-detail/);
  assert.match(result.stdout, /Investigate flaky test/);
});

test("result <job-id> returns the stored rendered output", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  const rendered = "# Copilot Task\n\nHandled the requested task.\n";
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-result",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_result",
        summary: "test result",
        updatedAt: "2026-04-17T22:00:00.000Z",
        completedAt: "2026-04-17T22:00:10.000Z"
      }
    ],
    jobFiles: {
      "task-result": {
        id: "task-result",
        status: "completed",
        title: "Copilot Task",
        threadId: "thr_result",
        rendered,
        result: {
          status: 0,
          threadId: "thr_result",
          copilotSessionId: "thr_result",
          rawOutput: "Handled the requested task."
        }
      }
    }
  });

  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "result", "task-result"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Handled the requested task\./);
});

test("result errors clearly when no finished jobs exist", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();

  const result = run(process.execPath, [COMPANION_SCRIPT, "result"], {
    cwd: workspace,
    env: buildEnv({ pluginData })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No finished Copilot jobs/i);
});

test("cancel without a job id errors when no active jobs exist", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();

  const result = run(process.execPath, [COMPANION_SCRIPT, "cancel"], {
    cwd: workspace,
    env: buildEnv({ pluginData })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No active Copilot jobs to cancel/i);
});

test("result --json returns a structured payload instead of rendered text", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-json",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_json",
        summary: "json payload",
        updatedAt: "2026-04-17T22:00:00.000Z",
        completedAt: "2026-04-17T22:00:10.000Z"
      }
    ],
    jobFiles: {
      "task-json": {
        id: "task-json",
        status: "completed",
        title: "Copilot Task",
        threadId: "thr_json",
        rendered: "# Copilot Task\n\ndone\n",
        result: { status: 0, threadId: "thr_json", rawOutput: "done" }
      }
    }
  });

  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "result", "task-json", "--json"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-json");
  assert.equal(payload.storedJob.status, "completed");
  assert.equal(payload.storedJob.result.rawOutput, "done");
});

test("status --json returns a structured snapshot", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-snap",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_snap",
        summary: "snapshot",
        updatedAt: "2026-04-17T23:00:00.000Z",
        completedAt: "2026-04-17T23:00:10.000Z"
      }
    ]
  });

  const result = run(process.execPath, [COMPANION_SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: buildEnv({ pluginData })
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const snapshot = JSON.parse(result.stdout);
  assert.ok(snapshot.latestFinished, "expected latestFinished on the snapshot");
  assert.equal(snapshot.latestFinished.id, "task-snap");
});

test("status <ambiguous-prefix> errors with 'ambiguous' when multiple jobs share the prefix", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-alpha-1",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_a1",
        summary: "first",
        updatedAt: "2026-04-17T20:00:00.000Z",
        completedAt: "2026-04-17T20:00:10.000Z"
      },
      {
        id: "task-alpha-2",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_a2",
        summary: "second",
        updatedAt: "2026-04-17T20:01:00.000Z",
        completedAt: "2026-04-17T20:01:10.000Z"
      }
    ]
  });

  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "status", "task-alpha"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambiguous/i);
});

test("cancel <queued-job> marks the job cancelled without needing a live worker", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-queued",
        status: "queued",
        title: "Copilot Task",
        jobClass: "task",
        threadId: null,
        summary: "queued work",
        pid: 999999, // dead pid; terminateProcessTree no-ops safely
        updatedAt: "2026-04-17T19:00:00.000Z",
        createdAt: "2026-04-17T19:00:00.000Z"
      }
    ],
    jobFiles: {
      "task-queued": {
        id: "task-queued",
        status: "queued",
        title: "Copilot Task",
        pid: 999999,
        threadId: null
      }
    }
  });

  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "cancel", "task-queued"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Cancelled/i);

  // Follow-up: state reflects the cancellation.
  const followUp = run(
    process.execPath,
    [COMPANION_SCRIPT, "status", "task-queued"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.equal(followUp.status, 0, `stderr: ${followUp.stderr}`);
  assert.match(followUp.stdout, /cancelled/i);
});

test("cancel <job-id> errors clearly when the job is not active", () => {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  seedState(workspace, pluginData, {
    jobs: [
      {
        id: "task-done",
        status: "completed",
        title: "Copilot Task",
        jobClass: "task",
        threadId: "thr_done",
        summary: "finished",
        updatedAt: "2026-04-17T22:00:00.000Z",
        completedAt: "2026-04-17T22:00:10.000Z"
      }
    ]
  });

  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "cancel", "task-done"],
    { cwd: workspace, env: buildEnv({ pluginData }) }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No (active )?job found/i);
});
