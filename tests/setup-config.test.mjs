import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, run } from "./helpers.mjs";
import { buildCopilotEnv, COMPANION_SCRIPT, REPO_ROOT } from "./harness.mjs";

// E2E coverage for the four `setup` config-writing flags. Closes the
// Team C HIGH finding from PR #93's meta-review: prior to this file the
// flags were only string-grep-checked in commands.test.mjs; the actual
// handleSetup mutation paths (setConfig, writeCopilotDefaults, alias
// resolution, and the conflict-detection between --enable-review-gate
// and --disable-review-gate at copilot-companion.mjs:302-304) had no
// behavioural coverage. A regression that swapped setConfig boolean
// arguments, dropped the actionsTaken line, or broke the alias-note
// formatting would have shipped silently.

function runCompanion(args, envOpts = {}) {
  return run(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: envOpts.cwd ?? REPO_ROOT,
    env: buildCopilotEnv(envOpts)
  });
}

test("setup --enable-review-gate writes stopReviewGate via setConfig and reports the action", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(["setup", "--enable-review-gate"], { pluginData });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    /Enabled the stop-time review gate/,
    "actionsTaken must include the 'Enabled' string"
  );
});

test("setup --disable-review-gate writes the inverse stopReviewGate value", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(["setup", "--disable-review-gate"], { pluginData });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    /Disabled the stop-time review gate/,
    "actionsTaken must include the 'Disabled' string"
  );
});

test("setup with both --enable-review-gate and --disable-review-gate exits with the conflict error", () => {
  const pluginData = makeTempDir();
  const result = runCompanion(
    ["setup", "--enable-review-gate", "--disable-review-gate"],
    { pluginData }
  );
  assert.notEqual(result.status, 0, "expected non-zero exit on conflicting flags");
  assert.match(
    result.stderr,
    /Choose either --enable-review-gate or --disable-review-gate/,
    "stderr must explain the conflict"
  );
});

test("setup --default-model gpt resolves the alias and writes gpt-5.5 to ~/.copilot/settings.json", () => {
  // Lock the v0.0.20 alias-resolution behaviour end-to-end: handleSetup
  // calls normalizeRequestedModel BEFORE writeCopilotDefaults, so the
  // file holds Copilot's canonical 'gpt-5.5' identifier rather than the
  // 'gpt' alias. The corresponding actionsTaken line carries the
  // '(alias gpt → gpt-5.5)' note so the user can see the substitution.
  const pluginData = makeTempDir();
  const copilotHome = makeTempDir();
  const result = runCompanion(
    ["setup", "--default-model", "gpt"],
    { pluginData, extraEnv: { COPILOT_HOME: copilotHome } }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    /Set default model to gpt-5\.5 \(alias gpt → gpt-5\.5\)/,
    "actionsTaken must include the resolved-alias note"
  );
  const settingsPath = path.join(copilotHome, "settings.json");
  assert.ok(
    fs.existsSync(settingsPath),
    `expected ${settingsPath} to be created in COPILOT_HOME`
  );
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(
    settings.model,
    "gpt-5.5",
    "settings.json must hold the canonical model name, not the alias"
  );
});
