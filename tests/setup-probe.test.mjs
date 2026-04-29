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
  // v0.0.16: COMMON_PROBE_MODELS replaces the old EFFORT_TO_MODEL-derived
  // list. The 7 entries are the most common per-call --model targets users
  // pass; the list is hand-maintained against the Copilot model catalog.
  assert.match(result.stdout, /- claude-opus-4\.7: ok/);
  assert.match(result.stdout, /- claude-sonnet-4\.6: ok/);
  assert.match(result.stdout, /- claude-haiku-4\.5: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6-fast: ok/);
  assert.match(result.stdout, /- gpt-5\.5: ok/);
  assert.match(result.stdout, /- gpt-5\.4: ok/);
  assert.match(result.stdout, /- gpt-5\.3-codex: ok/);

  const entries = fs.readFileSync(spawnLog, "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const probeSpawns = entries.filter((entry) => entry.argv.includes("-p"));
  assert.equal(
    probeSpawns.length,
    7,
    "one probe spawn per entry in COMMON_PROBE_MODELS"
  );
  const probedModels = probeSpawns.map((entry) => {
    const modelIdx = entry.argv.indexOf("--model");
    return entry.argv[modelIdx + 1];
  });
  assert.deepEqual(
    probedModels.sort(),
    [
      "claude-haiku-4.5",
      "claude-opus-4.6-fast",
      "claude-opus-4.7",
      "claude-sonnet-4.6",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.5"
    ]
  );
});

test("setup --probe-models marks account-unavailable models correctly", () => {
  const pluginData = makeTempDir();

  const result = runCompanion(
    ["setup", "--probe-models"],
    {
      pluginData,
      script: pingScript({ unavailableModels: ["claude-opus-4.7"] })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // Available models stay "ok"; the unavailable one lands on the
  // availability line with its Copilot-CLI-style error as the detail.
  assert.match(result.stdout, /- claude-sonnet-4\.6: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6-fast: ok/);
  assert.match(result.stdout, /- claude-opus-4\.7: unavailable/);
  assert.match(result.stdout, /model claude-opus-4\.7 is not available/);
  // v0.0.16: nextSteps prompt was rewritten now that effort tiers no longer
  // map to specific models.
  assert.match(
    result.stdout,
    /These models are unavailable on this account[\s\S]*claude-opus-4\.7/i
  );
});

test("setup --probe-models surfaces claude-haiku-4.5 in nextSteps when it is the only unavailable model", () => {
  // Haiku still appears in COMMON_PROBE_MODELS as a low-cost tier users
  // commonly fall back to via --model. If a future tweak silently drops
  // it from the probe list, this test catches it.
  const pluginData = makeTempDir();

  const result = runCompanion(
    ["setup", "--probe-models"],
    {
      pluginData,
      script: pingScript({ unavailableModels: ["claude-haiku-4.5"] })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /- claude-opus-4\.7: ok/);
  assert.match(result.stdout, /- claude-sonnet-4\.6: ok/);
  assert.match(result.stdout, /- claude-opus-4\.6-fast: ok/);
  assert.match(result.stdout, /- claude-haiku-4\.5: unavailable/);
  assert.match(
    result.stdout,
    /These models are unavailable on this account[\s\S]*claude-haiku-4\.5/i,
    "nextSteps must name claude-haiku-4.5 as unavailable"
  );
});

test("setup --probe-models JSON output includes modelProbe array", () => {
  const pluginData = makeTempDir();

  const result = runCompanion(
    ["setup", "--probe-models", "--json"],
    {
      pluginData,
      script: pingScript({ unavailableModels: ["claude-opus-4.7"] })
    }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.modelProbe));
  assert.equal(report.modelProbe.length, 7);
  const opus = report.modelProbe.find((r) => r.model === "claude-opus-4.7");
  assert.equal(opus.available, false);
  assert.match(opus.detail, /not available/);
  const sonnet = report.modelProbe.find((r) => r.model === "claude-sonnet-4.6");
  assert.equal(sonnet.available, true);
});
