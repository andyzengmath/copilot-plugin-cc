import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getActiveCopilotModelInfo,
  normalizeEffortForSettings,
  writeCopilotDefaults
} from "../plugins/copilot/scripts/lib/copilot.mjs";

function withTempCopilotHome(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-write-"));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("writes both model and effortLevel into a fresh settings.json", () => {
  withTempCopilotHome((home) => {
    const result = writeCopilotDefaults({
      model: "gpt-5.5",
      effortLevel: "xhigh",
      env: { COPILOT_HOME: home }
    });
    const written = JSON.parse(fs.readFileSync(result.path, "utf8"));
    assert.equal(written.model, "gpt-5.5");
    assert.equal(written.effortLevel, "xhigh");
    assert.deepEqual(result.applied, { model: "gpt-5.5", effortLevel: "xhigh" });
    assert.deepEqual(result.before, { model: null, effortLevel: null });
  });
});

test("preserves unrelated keys and leading // comment block", () => {
  withTempCopilotHome((home) => {
    const settingsPath = path.join(home, "settings.json");
    fs.writeFileSync(
      settingsPath,
      "// User settings.\n// Edit carefully.\n" +
        JSON.stringify({
          model: "claude-sonnet-4.6",
          effortLevel: "medium",
          theme: "auto",
          renderMarkdown: true,
          trustedFolders: ["C:\\Users\\example"]
        })
    );
    const result = writeCopilotDefaults({
      model: "gpt-5.5",
      env: { COPILOT_HOME: home }
    });
    const raw = fs.readFileSync(result.path, "utf8");
    assert.match(raw, /^\/\/ User settings\.\n\/\/ Edit carefully\.\n/);
    const written = JSON.parse(raw.replace(/^\s*\/\/[^\n]*$/gm, ""));
    assert.equal(written.model, "gpt-5.5");
    // Unspecified key untouched.
    assert.equal(written.effortLevel, "medium");
    assert.equal(written.theme, "auto");
    assert.equal(written.renderMarkdown, true);
    assert.deepEqual(written.trustedFolders, ["C:\\Users\\example"]);
    assert.deepEqual(result.before, { model: "claude-sonnet-4.6", effortLevel: "medium" });
  });
});

test("normalizeEffortForSettings collapses none/minimal to low and lowercases", () => {
  assert.equal(normalizeEffortForSettings("none"), "low");
  assert.equal(normalizeEffortForSettings("MINIMAL"), "low");
  assert.equal(normalizeEffortForSettings("Low"), "low");
  assert.equal(normalizeEffortForSettings("medium"), "medium");
  assert.equal(normalizeEffortForSettings("high"), "high");
  assert.equal(normalizeEffortForSettings("xhigh"), "xhigh");
  assert.equal(normalizeEffortForSettings("bogus"), null);
  assert.equal(normalizeEffortForSettings(""), null);
  assert.equal(normalizeEffortForSettings(null), null);
});

test("requires at least one of model or effortLevel", () => {
  withTempCopilotHome((home) => {
    assert.throws(
      () => writeCopilotDefaults({ env: { COPILOT_HOME: home } }),
      /at least one of model or effortLevel/
    );
  });
});

test("rejects an invalid effort value with a helpful message", () => {
  withTempCopilotHome((home) => {
    assert.throws(
      () =>
        writeCopilotDefaults({
          effortLevel: "extreme",
          env: { COPILOT_HOME: home }
        }),
      /Invalid --default-effort value "extreme"/
    );
  });
});

test("refuses to overwrite a settings.json that does not parse as JSON", () => {
  withTempCopilotHome((home) => {
    fs.writeFileSync(path.join(home, "settings.json"), "{ broken not json");
    assert.throws(
      () =>
        writeCopilotDefaults({
          model: "gpt-5.5",
          env: { COPILOT_HOME: home }
        }),
      /does not parse as JSON/
    );
  });
});

test("creates ~/.copilot if it does not exist yet", () => {
  withTempCopilotHome((home) => {
    fs.rmSync(home, { recursive: true, force: true });
    const result = writeCopilotDefaults({
      model: "gpt-5.5",
      env: { COPILOT_HOME: home }
    });
    assert.ok(fs.existsSync(result.path), "settings.json should exist after write");
  });
});

test("end-to-end: writeCopilotDefaults → getActiveCopilotModelInfo round-trips", () => {
  withTempCopilotHome((home) => {
    writeCopilotDefaults({
      model: "gpt-5.5",
      effortLevel: "xhigh",
      env: { COPILOT_HOME: home }
    });
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: home } });
    assert.equal(info.model, "gpt-5.5");
    assert.equal(info.effortLevel, "xhigh");
    assert.match(info.source, /settings\.json/);
  });
});
