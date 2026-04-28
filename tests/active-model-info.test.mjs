import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatActiveModelLine,
  getActiveCopilotModelInfo
} from "../plugins/copilot/scripts/lib/copilot.mjs";

function withTempCopilotHome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-settings-"));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("explicit --model wins over settings.json and env", () => {
  withTempCopilotHome((home) => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ model: "gpt-5.5", effortLevel: "xhigh" })
    );
    const info = getActiveCopilotModelInfo({
      requestedModel: "claude-haiku-4.5",
      env: { COPILOT_HOME: home, COPILOT_MODEL: "gpt-5.4" }
    });
    assert.equal(info.model, "claude-haiku-4.5");
    assert.equal(info.effortLevel, null);
    assert.equal(info.source, "--model flag");
  });
});

test("COPILOT_MODEL env beats settings.json", () => {
  withTempCopilotHome((home) => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ model: "gpt-5.5", effortLevel: "xhigh" })
    );
    const info = getActiveCopilotModelInfo({
      env: { COPILOT_HOME: home, COPILOT_MODEL: "gpt-5.4", COPILOT_EFFORT_LEVEL: "medium" }
    });
    assert.equal(info.model, "gpt-5.4");
    assert.equal(info.effortLevel, "medium");
    assert.equal(info.source, "COPILOT_MODEL env");
  });
});

test("settings.json model + effortLevel surfaces source", () => {
  withTempCopilotHome((home) => {
    // Mirror Copilot 1.x's JSONC header that strict JSON.parse would reject.
    fs.writeFileSync(
      path.join(home, "settings.json"),
      `// User settings belong here.\n${JSON.stringify({ model: "gpt-5.5", effortLevel: "xhigh" })}`
    );
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: home } });
    assert.equal(info.model, "gpt-5.5");
    assert.equal(info.effortLevel, "xhigh");
    assert.match(info.source, /settings\.json/);
  });
});

test("missing settings.json yields the Copilot CLI default sentinel", () => {
  withTempCopilotHome((home) => {
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: home } });
    assert.equal(info.model, null);
    assert.equal(info.effortLevel, null);
    assert.equal(info.source, "Copilot CLI default");
  });
});

test("malformed settings.json falls through to default rather than crashing", () => {
  withTempCopilotHome((home) => {
    fs.writeFileSync(path.join(home, "settings.json"), "{ not valid json");
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: home } });
    assert.equal(info.model, null);
    assert.equal(info.source, "Copilot CLI default");
  });
});

test("whitespace-only requestedModel is treated as unset", () => {
  withTempCopilotHome((home) => {
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "gpt-5.5" }));
    const info = getActiveCopilotModelInfo({
      requestedModel: "   ",
      env: { COPILOT_HOME: home }
    });
    assert.equal(info.model, "gpt-5.5");
    assert.equal(info.source, "~/.copilot/settings.json");
  });
});

test("formatActiveModelLine renders model + effort + source", () => {
  const line = formatActiveModelLine({
    model: "gpt-5.5",
    effortLevel: "xhigh",
    source: "~/.copilot/settings.json"
  });
  assert.match(line, /gpt-5\.5/);
  assert.match(line, /effort xhigh/);
  assert.match(line, /settings\.json/);
});

test("formatActiveModelLine reports CLI default when model is null", () => {
  const line = formatActiveModelLine({
    model: null,
    effortLevel: null,
    source: "Copilot CLI default"
  });
  assert.match(line, /Copilot CLI default/);
});
