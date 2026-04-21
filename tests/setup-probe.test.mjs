import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { buildCopilotEnv, COMPANION_SCRIPT, REPO_ROOT } from "./harness.mjs";

function runCompanion(args, envOpts = {}) {
  return run(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: envOpts.cwd ?? REPO_ROOT,
    env: buildCopilotEnv(envOpts)
  });
}

// Scripted response for the `-p "ping" --model <m>` probes. The same
// fixture serves every model probe in a single setup run because the
// script is read per-spawn and gives a canned success unless the model
// is listed in `unavailableModels`.
function pingScript(opts = {}) {
  return {
    sessionId: opts.sessionId ?? "sess-probe-1",
    prompt: {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" }
        }
      ],
      stopReason: "end_turn"
    },
    unavailableModels: opts.unavailableModels ?? []
  };
}

test("setup without --probe-models does not run any model probes", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");

  const result = runCompanion(
    ["setup"],
    { pluginData, spawnLog }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const entries = fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const probeSpawns = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(probeSpawns.length, 0, "no -p probe spawns without --probe-models");
  assert.doesNotMatch(
    result.stdout,
    /Model availability/i,
    "no probe section rendered without the flag"
  );
});

test("setup --probe-models reports every model as ok when all are available", () => {
  const pluginData = makeTempDir();
  const spawnLog = path.join(makeTempDir(), "spawn.jsonl");

  const result = runCompanion(
    ["setup", "--probe-models"],
    { pluginData, script: pingScript(), spawnLog }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Model availability \(--probe-models\)/);
  assert.match(result.stdout, /- claude-opus-4\.6-fast: ok/);
  assert.match(result.stdout, /- claude-sonnet-4\.5: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6: ok/);
  assert.match(result.stdout, /- claude-haiku-4\.5: ok/);

  const entries = fs.readFileSync(spawnLog, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const probeSpawns = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(
    probeSpawns.length,
    4,
    "one probe spawn per unique model across EFFORT_TO_MODEL + EFFORT_FALLBACK_CHAIN"
  );
  const probedModels = probeSpawns.map((entry) => {
    const modelIdx = entry.argv.indexOf("--model");
    return entry.argv[modelIdx + 1];
  });
  assert.deepEqual(
    probedModels.sort(),
    ["claude-haiku-4.5", "claude-opus-4.6", "claude-opus-4.6-fast", "claude-sonnet-4.5"]
  );
});

test("setup --probe-models marks account-unavailable models correctly", () => {
  const pluginData = makeTempDir();

  const result = runCompanion(
    ["setup", "--probe-models"],
    {
      pluginData,
      script: pingScript({ unavailableModels: ["claude-opus-4.6"] })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // Available models stay "ok"; the unavailable one lands on the
  // availability line with its Copilot-CLI-style error as the detail.
  assert.match(result.stdout, /- claude-sonnet-4\.5: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6-fast: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6: unavailable/);
  assert.match(result.stdout, /model claude-opus-4\.6 is not available/);
  // Next steps should flag the unavailability and remind users that
  // --effort will auto-fall-back.
  assert.match(
    result.stdout,
    /--effort tiers are unavailable[\s\S]*claude-opus-4\.6/i
  );
});

test("setup --probe-models JSON output includes modelProbe array", () => {
  const pluginData = makeTempDir();

  const result = runCompanion(
    ["setup", "--probe-models", "--json"],
    {
      pluginData,
      script: pingScript({ unavailableModels: ["claude-opus-4.6"] })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.modelProbe));
  assert.equal(report.modelProbe.length, 4);
  const opus = report.modelProbe.find((r) => r.model === "claude-opus-4.6");
  assert.equal(opus.available, false);
  assert.match(opus.detail, /not available/);
  const sonnet = report.modelProbe.find((r) => r.model === "claude-sonnet-4.5");
  assert.equal(sonnet.available, true);
});
