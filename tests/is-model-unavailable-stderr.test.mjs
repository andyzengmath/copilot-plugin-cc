import test from "node:test";
import assert from "node:assert/strict";

import { isModelUnavailableStderr } from "../plugins/copilot/scripts/lib/copilot.mjs";

test("isModelUnavailableStderr returns false for non-string inputs", () => {
  assert.equal(isModelUnavailableStderr(null), false);
  assert.equal(isModelUnavailableStderr(undefined), false);
  assert.equal(isModelUnavailableStderr(123), false);
  assert.equal(isModelUnavailableStderr(""), false);
});

// --- Positive cases: real model-availability errors that SHOULD trigger the
// --effort fallback chain in copilot-companion.mjs.

test("isModelUnavailableStderr matches 'model ... not available'", () => {
  assert.equal(
    isModelUnavailableStderr("Error: model claude-opus-4.6 is not available on this account."),
    true
  );
});

test("isModelUnavailableStderr matches 'model ... not authorized'", () => {
  assert.equal(
    isModelUnavailableStderr("model claude-opus-4.6 is not authorized for your plan"),
    true
  );
});

test("isModelUnavailableStderr matches 'model ... access denied'", () => {
  assert.equal(
    isModelUnavailableStderr("Error: model claude-opus-4.6 access denied"),
    true
  );
});

test("isModelUnavailableStderr matches 'model ... requires a <tier> plan'", () => {
  assert.equal(
    isModelUnavailableStderr("model claude-opus-4.6 requires a Business plan"),
    true
  );
});

test("isModelUnavailableStderr matches 'forbidden for' as access-scope denial", () => {
  assert.equal(
    isModelUnavailableStderr("model claude-opus-4.6 is forbidden for this account"),
    true
  );
});

test("isModelUnavailableStderr matches 'no access'", () => {
  assert.equal(
    isModelUnavailableStderr("model claude-opus-4.6: no access on your tier"),
    true
  );
});

// --- Negative cases: generic non-zero-exit stderrs that should NOT trigger
// the fallback chain (content-policy rejection, cross-paragraph text,
// network errors mentioning "model"). These are the regressions that the
// v0.5 fixup hardens against.

test("isModelUnavailableStderr rejects bare 'forbidden' from a content-policy block", () => {
  // Without the qualifier, 'forbidden' is ambiguous — content policy
  // uses it to mean "your prompt/output was rejected", not "your
  // account lacks access to the model". Silently retrying on lower
  // tiers would waste time and mislead the user.
  assert.equal(
    isModelUnavailableStderr("model output: function call was forbidden by content policy"),
    false,
    "content-policy 'forbidden' must not trigger fallback"
  );
  assert.equal(
    isModelUnavailableStderr("Error: the model returned output that was forbidden by safety policy."),
    false
  );
});

test("isModelUnavailableStderr rejects cross-paragraph false matches", () => {
  // "model" on one paragraph and "access denied" on another separated
  // by a newline must NOT count as an availability indicator — the
  // regex now confines matching to the same line via [^\n].
  const multi = [
    "Starting model claude-opus-4.6...",
    "Prompt too large.",
    "Upstream: request access denied."
  ].join("\n");
  assert.equal(
    isModelUnavailableStderr(multi),
    false,
    "cross-line 'model ... access denied' must not falsely match"
  );
});

test("isModelUnavailableStderr rejects generic failures that happen to mention 'model'", () => {
  assert.equal(
    isModelUnavailableStderr("Network error while querying model; retrying..."),
    false
  );
  assert.equal(
    isModelUnavailableStderr("Model response timed out after 30s."),
    false
  );
  assert.equal(
    isModelUnavailableStderr("ENOENT: copilot binary not found."),
    false,
    "stderr with no 'model' token must not match"
  );
});
