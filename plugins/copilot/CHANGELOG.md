# Changelog

Note: the first two releases were originally cut as 0.1.0 and 0.2.0 but
retroactively renumbered to 0.0.1 and 0.0.2 to better reflect their
pre-1.0 alpha status. Version strings inside the v0.0.1 tag's commit
still say 0.1.0; the tag itself is the canonical identifier.

## 0.0.5

Closes the last design-doc open question (`--effort` model-
availability fallback) and clears up two doc-debt items surfaced
during the v0.4 review cycle.

Added:
- `--effort`-driven fallback chain on `/copilot:task` (PR #19).
  When the primary effort-mapped model is unavailable on the user's
  Copilot account, `executeTaskRun` retries down the capability tier
  rather than failing outright:
  - `--effort high` / `xhigh`: `claude-opus-4.6` →
    `claude-sonnet-4.5` → `claude-opus-4.6-fast`.
  - `--effort medium`: `claude-sonnet-4.5` → `claude-opus-4.6-fast`.
  - `--effort low`/`minimal`/`none`: already lowest tier, no
    fallback.
  Each retry emits a stderr notice so users can see which tier the
  plugin actually ran on. Explicit `--model X` never triggers the
  chain — the user picked that model deliberately.
- `isModelUnavailableStderr()` exported from
  `plugins/copilot/scripts/lib/copilot.mjs` — conservative regex
  matching only the well-known availability phrases ("not available",
  "unavailable", "not authorized", "access denied", "access required",
  "no access", "forbidden for/on/to …", "requires <X>
  tier/plan/subscription"). A generic non-zero exit (network glitch,
  content-policy rejection, tool failure) does NOT trigger the
  chain. Hardened in the fixup to reject bare `forbidden` (common in
  content-policy stderr) and to confine matching to the same line so
  cross-paragraph text can't accidentally conflate into a false
  positive.
- `tests/is-model-unavailable-stderr.test.mjs` — 10 unit tests
  covering six positive availability phrases and four negatives
  (content-policy `forbidden`, cross-paragraph, generic network,
  stderr without a `model` token).
- `tests/runtime-task.test.mjs` — 5 new integration tests across
  the fallback chain: happy-path retry, chain exhaustion, explicit-
  model opt-out, no retry on primary success, no retry on non-
  availability failure.

Changed / fixed:
- `firstAllowOption` comment in `acp-client.mjs` rewritten (PR #18):
  the old parenthetical claimed the safe-fallback branch "means we
  simply don't pick one — the request will be cancelled", but the
  code below picks a non-reject, non-`allow_always` option when one
  exists. Comment now matches both the implementation and SECURITY.md.
- README status section refreshed from the stale "v0.2 status" to a
  "Status (v0.0.4)" (now implicitly v0.0.5) snapshot that removes
  items already shipped (per-call `--model`, Windows-path test
  failures) and names the single remaining deferred item — now
  closed as of this release. README's leftover "allow-list" was
  also swapped to "deny-list" to match the SECURITY.md PR #12 fixup
  (PR #18).

Test suite: 106 → 121 tests (+10 new unit tests for
`isModelUnavailableStderr`, +5 new task integration tests). 120
pass, 1 skipped, 0 fail. CI green on both Linux and Windows.

Design-doc status: all four "Open questions for implementation time"
from `docs/plans/2026-04-17-copilot-plugin-cc-design.md` are now
resolved.

See merged PRs #18, #19 for the full review history.

## 0.0.4

Tooling and hardening release: fixes the three pre-existing Windows
test failures documented since v0.0.1, adds the first CI signal for
the repo (Linux + Windows matrix), and ships three review-surfaced
defensive fixups in the prompt loader and SECURITY.md.

Added:
- `.github/workflows/pull-request-ci.yml`: CI job runs `npm install`,
  `npm test`, and `npm run build` on every PR and main push, across
  Ubuntu and Windows. Pinned action SHAs (v6.0.2 checkout, v6.3.0
  setup-node) on Node 22 (PR #15). First CI run on PR #15 itself
  passed 16s / 1m45s respectively.
- `loadPromptTemplate` now does an `fs.existsSync` guard symmetric with
  `loadCopilotAgent`, so a missing prompt surfaces "Prompt template not
  found: <name>" instead of a raw Node ENOENT leaking the absolute
  path (PR #16).
- `resolveAgentIncludes` now detects a leftover `{{AGENT:<name>}}` in a
  just-inlined agent body and throws. Prevents a stray-reference or
  typo in a future agent file from silently reaching the model as
  literal directive text (PR #16).

Changed / fixed:
- `scripts/bump-version.mjs`: marks `package-lock.json` as
  `optional: true`, matching this repo's no-lockfile choice. The 0.0.3
  bump had to edit version strings manually; 0.0.4 was cut with
  `node scripts/bump-version.mjs 0.0.4` directly (PR #14).
- `tests/bump-version.test.mjs`: spawns Node via `process.execPath`
  instead of bare `"node"`, bypassing the Windows cmd.exe wrapper that
  split the absolute repo path on the space in "OneDrive - Microsoft"
  and failed `MODULE_NOT_FOUND` (PR #14).
- `plugins/copilot/scripts/lib/broker-endpoint.mjs`: unix branch now
  builds the socket path with `path.posix.join` so the endpoint stays
  `unix:/tmp/...` even when the function is called on a Windows runner
  with a POSIX-style sessionDir (PR #14). No-op on production POSIX.
- Two pre-existing TypeScript build errors fixed with JSDoc-only
  changes so the CI `npm run build` step runs clean (PR #15):
  `acp-client.mjs` ACP_PROTOCOL_VERSION keeps its literal `1` type;
  `copilot.mjs` `interruptAppServerTurn` uses a typed `options = {}`
  parameter instead of an untyped destructured default.
- SECURITY.md now names both stages of `firstAllowOption`: prefer
  `allow_once`, fall back to the first non-reject / non-`allow_always`
  option (typically a `kind`-less default). Keeps the "never
  `allow_always`" boundary but fills in the safe-fallback path the
  code actually implements (PR #16).
- `.gitignore` explicitly lists `package-lock.json` so a local
  `npm install` does not create a commit candidate (PR #15).

Test suite: 103 → 106 tests (+2 new prompts unit tests, +1 new
bump-version optional-lockfile regression). 105 pass, 1 skipped, 0
fail — the three pre-existing Windows-path failures from 0.0.3 are
now green. CI runs on every PR going forward.

Deferred to v0.5:
- `--effort` model-availability fallback (the last remaining
  design-doc open question). The shape needs real Copilot CLI
  error-string signatures to detect model-unavailable from other
  non-zero exits without false positives.

See merged PRs #14, #15, #16 for the full review history.

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
