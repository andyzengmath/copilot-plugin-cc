# Changelog

## 0.2.0

End-to-end test coverage against a spawnable fake-ACP fixture + small
correctness and ergonomics fixes surfaced by the review cycle.

Added:
- `tests/fake-copilot.mjs` subprocess that speaks ACP v1 on stdio for
  runtime tests (PR #2).
- `COPILOT_COMPANION_COPILOT_COMMAND` env var + `resolveCopilotCommand()`
  override so tests can substitute a fake binary (PR #2).
- Runtime end-to-end test suites: `runtime-task` (11 tests),
  `runtime-review` (7), `runtime-status-result-cancel` (14, including a
  queued-cancel path that used to require a live broker),
  `runtime-hooks` (5, including the stop-gate BLOCK decision). PRs
  #3–#6.
- Rewritten static `tests/commands.test.mjs` asserting plugin markdown
  contracts against the v0.2 surface (PR #7).

Changed / fixed:
- `copilotSessionId` threaded through the task payload and surfaced in
  `renderStoredJobResult`'s resume command (PRs #3, #3 fixup).
- `resolveStateDir()` now accepts `{ pluginData }` so tests can compute
  the state dir without mutating `process.env.CLAUDE_PLUGIN_DATA`
  (PR #5 fixup).
- `terminateProcessTree()` is now best-effort on Windows — no longer
  throws on unexpected `taskkill` failures, including the Git-Bash
  MSYS `/PID` path-translation edge case that was crashing
  `/copilot:cancel` for some users (PR #5 fixup).

Removed:
- Parked `tests/runtime.test.pending.mjs` and
  `tests/fake-copilot-fixture.pending.mjs`. Their Codex-protocol-
  specific residual tests (multi-provider setup/auth, shared-broker
  lazy-startup) need a Copilot-native rewrite and are deferred to v0.3
  (PR #7).

See the full review-cycle history on the merged PRs #2–#7.

## 0.1.0

- Initial release. Ports the codex-plugin-cc architecture to GitHub Copilot CLI via ACP v1.
