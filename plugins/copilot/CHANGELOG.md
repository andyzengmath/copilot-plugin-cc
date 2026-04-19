# Changelog

Note: the first two releases were originally cut as 0.1.0 and 0.2.0 but
retroactively renumbered to 0.0.1 and 0.0.2 to better reflect their
pre-1.0 alpha status. Version strings inside the v0.0.1 tag's commit
still say 0.1.0; the tag itself is the canonical identifier.

## 0.0.3

Per-call `--model` routing, canonical bundled-agent prompts, and a
SECURITY.md covering the same-user threat model and the Windows ACL
caveat.

Added:
- `getCopilotAvailability` now honors `COPILOT_COMPANION_COPILOT_COMMAND`
  and propagates `options.env`, unlocking hook tests that could not
  previously substitute the fake Copilot binary in the availability
  probe (PR #9).
- Per-call `--model` / `--effort` routing via a new `runCopilotCli`
  one-shot fallback that bypasses the shared ACP broker and invokes
  `copilot -p "<prompt>" --model <model>` directly. Resume + model stays
  on the broker with a stderr notice (PR #10).
- Shell-metacharacter deny-list (`SHELL_METACHAR_RE` +
  `assertNoShellMetachars`) applied to `prompt`, `--model` value, and
  `cwd` before every per-call CLI spawn. Closes a CVE-2024-27980
  ("BatBadBut") class exposure introduced by the new `-p` path
  (PR #10 fixup).
- `{{AGENT:<name>}}` include directive in the prompt loader, making
  `plugins/copilot/copilot-agents/*.md` the canonical source for review
  methodology. Prompt templates shrank to thin runtime wrappers; drift
  between the plugin prompt and the interactive `copilot --agent` prompt
  is now impossible (PR #11).
- `SECURITY.md` at the repo root with threat model, artifact table,
  security-relevant env vars, and a private-disclosure GitHub Security
  Advisory link. README links to it from a new Security section
  (PR #12).
- Test fixture plumbing: restored `FAKE_COPILOT_SPAWN_LOG` +
  `buildCopilotEnv({ spawnLog })` so tests can assert the plugin's
  spawn argv; new `-p` CLI mode in `tests/fake-copilot.mjs` mirroring
  the real `copilot -p` one-shot.

Changed / fixed:
- `proc.on("close")` replaces `proc.on("exit")` in `runCopilotCli` so
  stdout drains before resolution; added a `settled` guard against
  double-resolve when `error` races `close` (PR #10 fixup).
- Adversarial agent's `<review_method>` restored the "weight user focus
  heavily" instruction that was dropped during the canonicalization
  refactor (PR #11 fixup).

Test coverage:
- 96 → 103 tests (+7 new prompts.test.mjs unit tests, +8 new
  runtime-task per-call CLI and resume-branch tests). 99 green; the
  same 3 pre-existing Windows-path failures (`bump-version` x2 and
  `createBrokerEndpoint` Unix-socket test on Windows) remain
  cross-platform quirks, unchanged since 0.0.2.

See merged PRs #9, #10, #11, #12 for the full review history.

## 0.0.2

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

## 0.0.1

- Initial release. Ports the codex-plugin-cc architecture to GitHub Copilot CLI via ACP v1.
