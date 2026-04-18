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

test("task --background enqueues a tracked job and exits without waiting", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--background", "work on it"],
    { pluginData, script: buildScriptedPrompt("async output") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /started in the background as task-/);
  assert.match(result.stdout, /Check \/copilot:status/);
});

test("task with both --model and --effort emits a stderr notice that --effort was ignored", () => {
  // Note: the ACP broker is spawned once per Claude session, so the
  // broker-scoped --model does NOT flow through to the fake's argv on
  // subsequent calls. The user-visible `--effort ignored because --model`
  // stderr notice is the behavior under test here; the spawn-arg
  // assertion for per-call --model is out of scope until the broker
  // learns to pass model per-session (tracked for v0.3).
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["task", "--model", "haiku", "--effort", "high", "work"],
    { pluginData, script: buildScriptedPrompt("done") }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /--effort high is ignored because --model claude-haiku-4.5 was also passed/);
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
