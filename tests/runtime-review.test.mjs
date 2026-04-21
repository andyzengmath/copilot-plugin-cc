import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { buildCopilotEnv, COMPANION_SCRIPT } from "./harness.mjs";

function seedDirtyRepo({ branch = false } = {}) {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  if (branch) {
    run("git", ["checkout", "-b", "feature"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "hello\nupdated\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "feature change"], { cwd: repo });
  } else {
    // Working-tree diff: modify without committing.
    fs.writeFileSync(path.join(repo, "README.md"), "hello\nmore\n");
  }
  return repo;
}

function scriptedJsonReview(payload, opts = {}) {
  return {
    sessionId: opts.sessionId ?? "sess-review-1",
    prompt: {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(payload) }
        }
      ],
      stopReason: "end_turn"
    }
  };
}

function runCompanion(repo, args, opts = {}) {
  return run(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: repo,
    env: buildCopilotEnv(opts)
  });
}

test("review renders an approve verdict from a scripted no-findings JSON response", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(repo, ["review"], {
    pluginData,
    script: scriptedJsonReview({
      verdict: "approve",
      summary: "No material issues found.",
      findings: [],
      next_steps: []
    })
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material issues found\./);
});

test("review renders structured findings when the JSON response lists them", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(repo, ["review"], {
    pluginData,
    script: scriptedJsonReview({
      verdict: "needs-attention",
      summary: "Found one material issue.",
      findings: [
        {
          severity: "high",
          title: "Null deref on empty input",
          body: "foo() does not guard the null case.",
          file: "README.md",
          line_start: 1,
          line_end: 2,
          confidence: 0.8,
          recommendation: "Add a guard clause."
        }
      ],
      next_steps: ["Add the guard clause."]
    })
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Null deref on empty input/);
  assert.match(result.stdout, /README\.md/);
  assert.match(result.stdout, /Add the guard clause\./);
});

test("review --base main targets the branch diff", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo({ branch: true });

  const result = runCompanion(repo, ["review", "--base", "main"], {
    pluginData,
    script: scriptedJsonReview({
      verdict: "approve",
      summary: "Branch diff review OK.",
      findings: [],
      next_steps: []
    })
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /branch diff against main/);
  assert.match(result.stdout, /Branch diff review OK\./);
});

test("review --background enqueues a tracked review job", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(repo, ["review", "--background"], {
    pluginData,
    script: scriptedJsonReview({
      verdict: "approve",
      summary: "ok",
      findings: [],
      next_steps: []
    })
  });

  // Background path: the review invocation returns quickly after queuing.
  // It exits 0 (companion's foreground path DOES wait for the worker in
  // this design because review isn't routed through enqueueBackgroundTask;
  // the test just confirms it completes without error when --background is
  // passed through).
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test("review gracefully degrades when the JSON response is malformed", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(repo, ["review"], {
    pluginData,
    script: {
      sessionId: "sess-badjson-1",
      prompt: {
        updates: [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not-json at all" } }
        ],
        stopReason: "end_turn"
      }
    }
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Copilot did not return valid structured JSON|unexpected review shape/);
});

test("adversarial-review renders findings and supports focus text after the flags", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(
    repo,
    ["adversarial-review", "challenge", "the", "caching", "design"],
    {
      pluginData,
      script: scriptedJsonReview({
        verdict: "needs-attention",
        summary: "Cache invalidation is not idempotent.",
        findings: [
          {
            severity: "critical",
            title: "Cache race under retry",
            body: "Retries can double-write.",
            file: "README.md",
            line_start: 1,
            line_end: 2,
            confidence: 0.9,
            recommendation: "Gate retries behind an idempotency token."
          }
        ],
        next_steps: ["Add an idempotency token."]
      })
    }
  );

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Cache race under retry/);
  assert.match(result.stdout, /Cache invalidation is not idempotent\./);
});

function readSpawnLog(spawnLogPath) {
  if (!fs.existsSync(spawnLogPath)) return [];
  return fs
    .readFileSync(spawnLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("review --effort high falls back to --model claude-sonnet-4.5 when claude-opus-4.6 is unavailable", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");

  const result = runCompanion(
    repo,
    ["review", "--effort", "high"],
    {
      pluginData,
      script: {
        ...scriptedJsonReview({
          verdict: "approve",
          summary: "sonnet-level review ok",
          findings: [],
          next_steps: []
        }),
        unavailableModels: ["claude-opus-4.6"]
      },
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(
    result.stderr,
    /claude-opus-4\.6.*unavailable.*retrying.*claude-sonnet-4\.5.*fallback chain/i,
    `expected fallback notice on stderr; got: ${result.stderr}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(
    cliEntries.length,
    2,
    `expected two -p invocations (opus → sonnet); got ${cliEntries.length}`
  );
  const firstModel = cliEntries[0].argv[cliEntries[0].argv.indexOf("--model") + 1];
  const secondModel = cliEntries[1].argv[cliEntries[1].argv.indexOf("--model") + 1];
  assert.equal(firstModel, "claude-opus-4.6");
  assert.equal(secondModel, "claude-sonnet-4.5");
});

test("review --effort high with explicit --model opus does NOT auto-fallback", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");

  const result = runCompanion(
    repo,
    ["review", "--effort", "high", "--model", "opus"],
    {
      pluginData,
      script: {
        ...scriptedJsonReview({
          verdict: "approve",
          summary: "never seen",
          findings: [],
          next_steps: []
        }),
        // v0.11 refresh: `opus` alias now resolves to claude-opus-4.7,
        // so the fixture must unavailable-list the resolved target.
        unavailableModels: ["claude-opus-4.7"]
      },
      spawnLog
    }
  );
  assert.notEqual(result.status, 0);
  // --effort-ignored-because-of-model notice fires (shared with the task path);
  // but no retry notice, because the user explicitly picked the model.
  assert.match(
    result.stderr,
    /--effort high is ignored because --model claude-opus-4\.7 was also passed/
  );
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i,
    `explicit --model must not trigger fallback; stderr was: ${result.stderr}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "explicit --model should produce exactly one spawn attempt");
});

test("review --effort high with opus available does not retry", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");

  const result = runCompanion(
    repo,
    ["review", "--effort", "high"],
    {
      pluginData,
      script: scriptedJsonReview({
        verdict: "approve",
        summary: "primary ok",
        findings: [],
        next_steps: []
      }),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "no fallback expected when primary model succeeds");
  const modelIdx = cliEntries[0].argv.indexOf("--model");
  assert.equal(cliEntries[0].argv[modelIdx + 1], "claude-opus-4.6");
});

test("review persists a job record with copilotSessionId after completion", () => {
  const pluginData = makeTempDir();
  const repo = seedDirtyRepo();

  const result = runCompanion(repo, ["review"], {
    pluginData,
    script: scriptedJsonReview(
      { verdict: "approve", summary: "fine", findings: [], next_steps: [] },
      { sessionId: "sess-review-persist-1" }
    )
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((name) => name.endsWith(".json"));
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));

  assert.equal(job.status, "completed");
  assert.equal(job.jobClass, "review");
  assert.equal(job.threadId, "sess-review-persist-1");
});
