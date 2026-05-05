import test from "node:test";
import assert from "node:assert/strict";

import { isCopilotTransientBackendError } from "../plugins/copilot/scripts/lib/copilot.mjs";

// `isCopilotTransientBackendError` matches the post-retry-exhaust line
// Copilot CLI emits when its retry loop (default 5) gives up without
// getting a response from the AI model. Without this detection, the
// plugin's review renderer falls back to a generic "did not return
// valid structured JSON" message which misleads users into filing
// parser bugs for what is actually a Copilot/server outage.

test("isCopilotTransientBackendError returns false for non-string inputs", () => {
  assert.equal(isCopilotTransientBackendError(null), false);
  assert.equal(isCopilotTransientBackendError(undefined), false);
  assert.equal(isCopilotTransientBackendError(123), false);
  assert.equal(isCopilotTransientBackendError(""), false);
});

test("isCopilotTransientBackendError matches the canonical retry-exhaust line", () => {
  // Verbatim from a real user-reported failure (~2026-05). Multiple
  // retry-info lines followed by the exhaust message — pattern must
  // anchor on the exhaust message, not the retry-info chatter.
  const raw =
    "Info: Response was interrupted due to a server error. Retrying..." +
    "Info: Response was interrupted due to a server error. Retrying..." +
    "Info: Response was interrupted due to a server error. Retrying..." +
    "Info: Response was interrupted due to a server error. Retrying..." +
    "Info: Response was interrupted due to a server error. Retrying..." +
    "Error: Execution failed: Error: Failed to get response from the AI model;" +
    " retried 5 times (total retry wait time: 5.80 seconds) Last error: Unknown error";
  assert.equal(isCopilotTransientBackendError(raw), true);
});

test("isCopilotTransientBackendError matches across line boundaries", () => {
  // Same content but with newlines instead of run-on. The 200-char gap
  // window in COPILOT_TRANSIENT_BACKEND_RE must accommodate either
  // formatting.
  const raw = [
    "Info: Response was interrupted due to a server error. Retrying...",
    "Error: Failed to get response from the AI model;",
    "  retried 5 times (total retry wait time: 5.80 seconds)"
  ].join("\n");
  assert.equal(isCopilotTransientBackendError(raw), true);
});

test("isCopilotTransientBackendError ignores recovered retries", () => {
  // Retry-info messages alone (without the post-exhaust "Failed to get
  // response from the AI model... retried N times" line) mean the CLI
  // recovered. Don't surface those as fatal backend errors.
  const raw = "Info: Response was interrupted due to a server error. Retrying...{\"verdict\":\"approve\"}";
  assert.equal(isCopilotTransientBackendError(raw), false);
});

test("isCopilotTransientBackendError ignores unrelated 'Failed to' errors", () => {
  // Other failure messages that happen to share the verb "Failed" must
  // not match — the pattern requires the unique combination of "Failed
  // to get response from the AI model" + "retried N times".
  assert.equal(
    isCopilotTransientBackendError("Error: Failed to read --prompt-file /tmp/x: ENOENT"),
    false
  );
  assert.equal(
    isCopilotTransientBackendError("Failed to spawn copilot: ENOENT"),
    false
  );
});

test("isCopilotTransientBackendError ignores model-unavailable errors", () => {
  // The two error families are distinct: model-unavailable means the
  // user's account lacks the requested model (handled by the --effort
  // fallback chain pre-v0.0.16, now just surfaced in the probe
  // report); transient-backend means the backend itself is down.
  // Don't conflate.
  assert.equal(
    isCopilotTransientBackendError("Error: model claude-opus-4.6 is not available on this account."),
    false
  );
});
