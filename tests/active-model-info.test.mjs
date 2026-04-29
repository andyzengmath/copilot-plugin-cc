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

test("formatActiveModelLine output matches the literal stderr-echo format", () => {
  // The plugin emits `[copilot] Using model: ${formatActiveModelLine(info)}\n`
  // on stderr before every Copilot call (lib/copilot.mjs runAppServerTurn).
  // Lock in the exact format so a future tweak to the formatter doesn't
  // silently change the message users see in their terminals.
  const explicit = formatActiveModelLine({
    model: "gpt-5.5",
    effortLevel: "xhigh",
    source: "~/.copilot/settings.json"
  });
  assert.equal(explicit, "gpt-5.5, effort xhigh [~/.copilot/settings.json]");

  const noEffort = formatActiveModelLine({
    model: "claude-opus-4.7",
    effortLevel: null,
    source: "--model flag"
  });
  assert.equal(noEffort, "claude-opus-4.7 [--model flag]");

  const cliDefault = formatActiveModelLine({
    model: null,
    effortLevel: null,
    source: "Copilot CLI default"
  });
  assert.equal(
    cliDefault,
    "Copilot CLI default (claude-sonnet-4.5) [Copilot CLI default]"
  );
});

test("COPILOT_HOME with a trailing slash resolves the same settings.json", () => {
  // Users sometimes export `COPILOT_HOME=/path/to/.copilot/` (trailing
  // separator). resolveCopilotHome trims whitespace but preserves the slash;
  // path.join handles the duplicate separator transparently. Both reads
  // should still hit the same file as the no-slash case.
  withTempCopilotHome((home) => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ model: "gpt-5.5" })
    );
    const trailing = `${home}${path.sep}`;
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: trailing } });
    assert.equal(info.model, "gpt-5.5");
    assert.match(info.source, /settings\.json/);
  });
});

test("settings.json with an inline `// ...` comment after a value fails the JSONC parser gracefully (documented limitation)", () => {
  // parseJsonWithLineComments only strips full-line `// ...` comments, not
  // inline trailing comments after a JSON value. Copilot CLI's own writer
  // never produces inline comments, so this is a hand-edit case. Verify
  // the failure mode is graceful (returns CLI-default sentinel, doesn't
  // throw) rather than masking the corruption silently.
  withTempCopilotHome((home) => {
    fs.writeFileSync(
      path.join(home, "settings.json"),
      `{"model":"gpt-5.5"} // user comment the line-only stripper does not catch`
    );
    const info = getActiveCopilotModelInfo({ env: { COPILOT_HOME: home } });
    assert.equal(info.model, null);
    assert.equal(info.source, "Copilot CLI default");
  });
});
