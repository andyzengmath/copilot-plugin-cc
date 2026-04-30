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

test("task with both --model and --effort passes both flags through to the CLI", () => {
  // Copilot CLI 1.0.11+ accepts --model and --effort independently. The
  // plugin used to emit a "--effort ignored" stderr because of an internal
  // mapping, but that mapping was dropped in v0.0.16 — both flags now flow
  // through verbatim and Copilot's own runtime applies them.
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--model", "haiku", "--effort", "high", "work"],
    { pluginData, script: buildScriptedPrompt("done"), spawnLog }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, /--effort.*is ignored because --model/);
  const cli = readSpawnLog(spawnLog).find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, "expected a -p invocation");
  const modelIdx = cli.argv.indexOf("--model");
  const effortIdx = cli.argv.indexOf("--effort");
  assert.ok(modelIdx >= 0 && cli.argv[modelIdx + 1] === "claude-haiku-4.5", `expected --model claude-haiku-4.5; got ${JSON.stringify(cli.argv)}`);
  assert.ok(effortIdx >= 0 && cli.argv[effortIdx + 1] === "high", `expected --effort high; got ${JSON.stringify(cli.argv)}`);
});

function readSpawnLog(spawnLogPath) {
  if (!fs.existsSync(spawnLogPath)) return [];
  return fs
    .readFileSync(spawnLogPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("task --model codex resolves the alias to --model gpt-5.3-codex via -p", () => {
  // Locks in the v0.10 addition of the `codex` alias + v0.11 refresh
  // of the target model so MODEL_ALIASES edits don't silently drop
  // GPT-family shortcuts or stale-out.
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--model", "codex", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("codex ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /codex ok/);
  const cli = readSpawnLog(spawnLog).find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, "expected a -p invocation");
  const modelIdx = cli.argv.indexOf("--model");
  assert.equal(
    cli.argv[modelIdx + 1],
    "gpt-5.3-codex",
    `expected --model gpt-5.3-codex after alias resolution; got ${JSON.stringify(cli.argv)}`
  );
});

test("task --model gpt resolves the alias to --model gpt-5.5 via -p", () => {
  // Locks in the v0.20 refresh of `gpt` to track the new top-of-family
  // GPT model (gpt-5.5; baseline was gpt-5.4 from v0.0.12). Tests for
  // the GPT-family shortcut so a future refresh (e.g. 5.6) can't
  // silently stale the alias without a test update.
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--model", "gpt", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("gpt ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /gpt ok/);
  const cli = readSpawnLog(spawnLog).find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, "expected a -p invocation");
  const modelIdx = cli.argv.indexOf("--model");
  assert.equal(
    cli.argv[modelIdx + 1],
    "gpt-5.5",
    `expected --model gpt-5.5 after alias resolution; got ${JSON.stringify(cli.argv)}`
  );
});

test("task --model opus resolves the alias to --model claude-opus-4.7 via -p", () => {
  // Locks in the v0.11 refresh of `opus` to track the new top-of-
  // family model (claude-opus-4.7). Tests for the Claude-family
  // shortcut so a future refresh (e.g. 4.8) can't silently stale the
  // alias without a test update.
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--model", "opus", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("opus ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /opus ok/);
  const cli = readSpawnLog(spawnLog).find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, "expected a -p invocation");
  const modelIdx = cli.argv.indexOf("--model");
  assert.equal(
    cli.argv[modelIdx + 1],
    "claude-opus-4.7",
    `expected --model claude-opus-4.7 after alias resolution; got ${JSON.stringify(cli.argv)}`
  );
});

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

test("task --effort low passes --effort=low to the per-call CLI without forcing a --model", () => {
  // v0.0.16: dropped the EFFORT_TO_MODEL mapping. --effort now flows
  // straight through to Copilot CLI's native --effort flag (1.0.11+),
  // and the user's settings.json default model is preserved (we don't
  // pass --model at all).
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
  const effortIdx = cli.argv.indexOf("--effort");
  assert.ok(
    effortIdx >= 0 && cli.argv[effortIdx + 1] === "low",
    `expected --effort low; got ${JSON.stringify(cli.argv)}`
  );
  assert.ok(
    !cli.argv.includes("--model"),
    `--effort alone must not force a --model override; got ${JSON.stringify(cli.argv)}`
  );
});

test("task --effort high passes --effort=high to the per-call CLI without forcing a --model", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("high ok"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /high ok/);
  const entries = readSpawnLog(spawnLog);
  const cli = entries.find((entry) => entry.argv.includes("-p"));
  assert.ok(cli, "expected a -p invocation");
  const effortIdx = cli.argv.indexOf("--effort");
  assert.ok(
    effortIdx >= 0 && cli.argv[effortIdx + 1] === "high",
    `expected --effort high; got ${JSON.stringify(cli.argv)}`
  );
  assert.ok(
    !cli.argv.includes("--model"),
    `--effort alone must not force a --model override; got ${JSON.stringify(cli.argv)}`
  );
});

test("task produces exactly one CLI spawn — no fallback chain", () => {
  // v0.0.16 dropped the multi-tier model fallback chain. A single per-call
  // spawn is the only attempt; if it fails, the failure surfaces directly.
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "hi"],
    {
      pluginData,
      script: buildScriptedPrompt("once and done"),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const cliEntries = readSpawnLog(spawnLog).filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "expected exactly one -p invocation; the fallback chain is gone");
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i,
    "no retry notice should fire — fallback chain is gone"
  );
});

test("task --model passes shell-metachar prompts verbatim under shell:false (argv, no shell interpretation)", () => {
  // The shell-metacharacter deny-list is scoped to the shell-enabled
  // spawn path (Windows production with the real `.cmd` launcher).
  // Under shell:false — tests (COPILOT_COMPANION_COPILOT_COMMAND set),
  // Linux / macOS production — Node hands argv directly to CreateProcess
  // / execve, so metacharacters like `&&` are literal text and no
  // injection is possible. v0.0.18 dropped the shell:true production
  // path entirely (replaced by `lib/safe-spawn.mjs`'s cross-spawn-style
  // escaping); the `assertNoShellMetachars` deny-list and its dedicated
  // test file went with it. This test now just locks in that
  // metacharacters in argv reach the child verbatim.
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

test("task --effort high with explicit --model opus does NOT auto-fallback", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--effort", "high", "--model", "opus", "hi"],
    {
      pluginData,
      script: {
        ...buildScriptedPrompt("never seen"),
        // v0.11 refresh: `opus` alias now resolves to claude-opus-4.7,
        // so the fixture must unavailable-list the resolved target.
        unavailableModels: ["claude-opus-4.7"]
      },
      spawnLog
    }
  );
  // v0.0.16: both --model and --effort flow through verbatim. No fallback
  // chain exists, so an unavailable model surfaces directly.
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(
    result.stderr,
    /appears unavailable on this account.*retrying/i,
    `no fallback chain — must not retry; stderr was: ${result.stderr}`
  );
  const entries = readSpawnLog(spawnLog);
  const cliEntries = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(cliEntries.length, 1, "exactly one spawn — no fallback");
  const argv = cliEntries[0].argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "claude-opus-4.7", "--model passed through");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high", "--effort passed through");
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

test("task --resume-last --effort high stays on the broker path with a stderr drop notice", () => {
  // Resume holds a broker-issued sessionId; the broker can't switch effort
  // mid-turn, so per-call --effort is dropped with a stderr notice (mirror
  // of the existing --model-on-resume behavior).
  const pluginData = makeTempDir();
  const seed = runCompanion(
    ["task", "first"],
    {
      pluginData,
      script: buildScriptedPrompt("seed ok", { sessionId: "sess-resume-effort-drop" })
    }
  );
  assert.equal(seed.status, 0, `seed stderr: ${seed.stderr}`);

  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");
  const result = runCompanion(
    ["task", "--resume-last", "--effort", "high", "continue"],
    {
      pluginData,
      script: buildScriptedPrompt("resumed ok", { sessionId: "sess-resume-effort-drop" }),
      spawnLog
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /--effort high.*ignored when --resume/i,
    `expected resume+effort drop notice; got: ${result.stderr}`
  );
  const cliEntries = readSpawnLog(spawnLog).filter((entry) => entry.argv.includes("-p"));
  assert.equal(
    cliEntries.length,
    0,
    `resume must stay on the broker path; -p argv was: ${JSON.stringify(cliEntries.map((e) => e.argv))}`
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
