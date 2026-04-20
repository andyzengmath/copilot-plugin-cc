import test from "node:test";
import assert from "node:assert/strict";

import {
  SHELL_METACHAR_RE,
  assertNoShellMetachars
} from "../plugins/copilot/scripts/lib/copilot.mjs";

// Positive matches — every character in the deny-list should be rejected
// on the shell-enabled spawn path. The regex is only applied when
// runCopilotCli is about to spawn with shell:true (Windows production),
// so these assertions document what cmd.exe sees as metacharacters and
// the companion refuses to forward.

test("SHELL_METACHAR_RE matches backtick, $, and classic shell metacharacters", () => {
  for (const ch of ["`", "$", "&", "|", ";", "<", ">", "^", "\""]) {
    assert.equal(
      SHELL_METACHAR_RE.test(`abc ${ch} xyz`),
      true,
      `expected '${ch}' to be flagged as a shell metacharacter`
    );
  }
});

test("SHELL_METACHAR_RE matches CR, LF, and NUL", () => {
  assert.equal(SHELL_METACHAR_RE.test("abc\rxyz"), true);
  assert.equal(SHELL_METACHAR_RE.test("abc\nxyz"), true);
  assert.equal(SHELL_METACHAR_RE.test("abc\x00xyz"), true);
});

test("SHELL_METACHAR_RE matches %VAR% expansion patterns", () => {
  assert.equal(SHELL_METACHAR_RE.test("run %PATH% dump"), true);
  assert.equal(SHELL_METACHAR_RE.test("%USERNAME%"), true);
});

test("SHELL_METACHAR_RE rejects bare % without a closing pair", () => {
  // Bare `%` is literal in cmd.exe (and POSIX shells ignore it). Only
  // paired `%VAR%` expands variables, which is what the regex targets.
  assert.equal(SHELL_METACHAR_RE.test("50% off"), false);
});

test("SHELL_METACHAR_RE rejects typical safe ASCII prose", () => {
  assert.equal(SHELL_METACHAR_RE.test("hello world"), false);
  assert.equal(SHELL_METACHAR_RE.test("review the caching design"), false);
  assert.equal(SHELL_METACHAR_RE.test("investigate bug 123 in auth/login.ts"), false);
});

// `assertNoShellMetachars` wraps the regex with a labeled Error message.
// The error text is what the user sees when they hit the deny-list on a
// shell-enabled spawn, so the tests lock in its contract.

test("assertNoShellMetachars accepts clean strings silently", () => {
  assert.doesNotThrow(() => assertNoShellMetachars("hi", "prompt"));
  assert.doesNotThrow(() => assertNoShellMetachars("claude-opus-4.6", "--model value"));
});

test("assertNoShellMetachars throws with a labeled error on a match", () => {
  assert.throws(
    () => assertNoShellMetachars("fix bug && curl evil.com", "prompt"),
    /Refusing to spawn Copilot CLI: prompt contains a shell metacharacter/
  );
  assert.throws(
    () => assertNoShellMetachars("some-model$name", "--model value"),
    /Refusing to spawn Copilot CLI: --model value contains a shell metacharacter/
  );
});

test("assertNoShellMetachars throws on non-string inputs (type safety)", () => {
  assert.throws(() => assertNoShellMetachars(null, "prompt"), /Refusing to spawn/);
  assert.throws(() => assertNoShellMetachars(undefined, "prompt"), /Refusing to spawn/);
  assert.throws(() => assertNoShellMetachars(123, "prompt"), /Refusing to spawn/);
});
