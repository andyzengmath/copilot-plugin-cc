# Changelog

Note: the first two releases were originally cut as 0.1.0 and 0.2.0 but
retroactively renumbered to 0.0.1 and 0.0.2 to better reflect their
pre-1.0 alpha status. Version strings inside the v0.0.1 tag's commit
still say 0.1.0; the tag itself is the canonical identifier.

## 0.0.8

Finishes the two `v1.1`-deferred items that were tractable: concurrent
broker reuse across Claude sessions on the same workspace, and full
schema enforcement for structured review output. Item 3 (custom per-
ACP-session sandboxing) stays upstream-blocked on `copilot --acp`.

Changed:
- `ensureBrokerSession` now serializes its read-decide-spawn slow path
  through a workspace-scoped `broker.lock` file (PR #28). Two Claude
  sessions starting on the same workspace simultaneously previously
  raced to each spawn their own detached `copilot --acp` broker — the
  loser stayed alive as an orphan with no reference from `broker.json`.
  Now one wins the lock, spawns, and saves; siblings pick it up from
  `broker.json` and reuse. Fast path (live `broker.json` + reachable
  endpoint) still skips the lock so single-session reuse stays zero-
  overhead.
  - Lock file: atomic `O_CREAT|O_EXCL` via `fs.openSync(path, "wx", 0o600)`,
    contents `<pid>\n<timestamp>\n`, 25 ms poll with 5 s total budget.
  - Stale-lock recovery: if the holder PID is dead (ESRCH from
    `process.kill(pid, 0)`), a contender steals the lock.
  - `releaseBrokerLock` unlinks in a finally block so a mid-spawn
    throw still clears the lock.
- Dual-budget liveness check (`isBrokerEndpointReady`, PR #28): the
  fast path (outer) keeps its 150 ms budget because reuse is latency-
  sensitive, but the slow-path re-check before tearing down a sibling
  broker now uses 1000 ms. Teardown is destructive (kills a broker
  another client may be mid-stream with), so the slow path now demands
  a more generous dead-broker signal.
- `validateReviewResultShape` → `validateReviewOutput` (PR #29): the
  review pipeline now walks every constraint in
  `plugins/copilot/schemas/review-output.schema.json` and accumulates
  the full list of violations, instead of short-circuiting on the
  first. `renderReviewResult` surfaces them as a bulleted "Schema
  violations:" section. Now enforced: `verdict` enum, `summary`
  non-empty, every `findings[i]` required field with correct type
  (severity enum; title/body/file non-empty; line_start/line_end
  integer ≥ 1; confidence ∈ [0, 1]; recommendation string),
  `next_steps[i]` non-empty, no extra properties at top level or
  inside findings. Zero new runtime deps — hand-rolled walker,
  faithful to the one schema.

Added:
- `tests/broker-lifecycle.test.mjs` (+2): concurrent Promise.all of
  two `ensureBrokerSession` calls must share one broker endpoint +
  secret and record exactly one `--acp` spawn; sequential reentrant
  case still reuses through the fast path.
- `tests/render.test.mjs` (+7): coverage for each new schema
  constraint plus a "every violation in one pass" regression guard
  against first-error short-circuit.

Test suite: 138 → 147 tests (+9). 146 pass, 1 skipped, 0 fail. CI
green on both Linux and Windows.

See merged PRs #28, #29 for the full review history.

## 0.0.7

Setup-time model availability probe + README catch-up for the v0.5
and v0.6 changes.

Added:
- `/copilot:setup --probe-models` (PR #25). Opt-in flag that spawns
  `copilot -p "ping" --model <m>` in parallel against each unique
  model in EFFORT_TO_MODEL and reports which tiers are available on
  the current Copilot account. Results classify via the existing
  `isModelUnavailableStderr` regex (reuses v0.6's content-policy
  hardening):
    - exit 0                                   → `ok — ok`
    - non-zero + availability phrase           → `unavailable — <stderr first line>`
    - non-zero + no match                      → `unknown — exit N: ...`
    - spawn error / 15s timeout                → `unknown — ...`
  When any model is flagged unavailable, the next-steps section
  reminds the user that /copilot:task auto-falls-back and names the
  affected models. Complements the v0.5 runtime fallback chain so
  users can see their tier upfront rather than discovering it at
  task time via fallback stderr notices.
- `probeModelAvailability(cwd, { env, models, timeoutMs })` exported
  from `plugins/copilot/scripts/lib/copilot.mjs` for programmatic
  use.
- `tests/setup-probe.test.mjs` (+4): no-flag baseline (no probe
  spawns), all-ok path (3 spawns, one per distinct model), one-
  model-unavailable path (verifies next-steps hint), JSON output
  shape.

Changed:
- README refreshed for v0.0.6 → v0.0.7 state (PR #24 & this release):
  `/copilot:review` and `/copilot:adversarial-review` flag lists now
  include `--model` / `--effort`; the effort → model table has a
  fallback-chain column; the Status section replaced with a current-
  state summary (all design-doc "Open questions for implementation
  time" resolved, 134→138 tests, CI on every PR); "Deferred to
  v0.7+" block added for the outstanding v1.1 items (cross-Claude-
  session broker coordination, structured-output enforcement). The
  setup-time probe is now documented implicitly via the Status
  section.

Test suite: 134 → 138 tests (+4 setup-probe cases). 137 pass, 1
skipped, 0 fail. CI green on both Linux and Windows.

See merged PRs #24, #25 for the full review history.

## 0.0.6

Fallback-chain hardening and extension to the review path. Small
release that rounds out the v0.5 --effort work into something
consistent across all three entry points.

Added:
- `--effort` support on `/copilot:review` and
  `/copilot:adversarial-review` (PR #22). The same fallback chain
  that /copilot:task uses — high → sonnet → fast, medium → fast, low
  /minimal/none already at the bottom — now applies to review and
  adversarial-review. Explicit `--model` still opts out; the shared
  "--effort ignored because --model was also passed" notice fires
  across all three commands.
- Background-worker fallback test (PR #21) and resume-collapse test
  (PR #21). Closes the PR #19 review coverage gap on the worker
  path and asserts that `--resume-last --effort` does not fire
  redundant retries against the broker.
- Unit tests for `SHELL_METACHAR_RE` + `assertNoShellMetachars`
  (PR #22, new `tests/shell-metachar-regex.test.mjs`). Locks in
  the deny-list regex semantics and the labeled-error shape.

Changed / fixed:
- `executeTaskRun` hoists `threadName` and the empty-chain guard
  out of the retry loop (PR #21). No current bug; pins the
  invariant if a future `session/new` evolution starts forwarding
  the field.
- `executeTaskRun` collapses the fallback chain to a single entry
  when `resumeThreadId` is set (PR #21). The broker path ignores
  per-call `--model`, so iterating the full chain fired redundant
  identical calls and emitted misleading retry notices naming
  models that were never used. The comment in v0.5 claimed this
  was already true; this change makes the implementation match.
- `assertNoShellMetachars` is now scoped to the shell-enabled
  spawn path (PR #22). Under `shell:false` (Linux / macOS
  production, all tests) Node hands argv directly to CreateProcess
  / execve with no shell interpretation, so the CVE-2024-27980
  class does not apply; the always-on stance in v0.5 was rejecting
  legitimately-structured review prompts (XML tags, code fences)
  that never reached a shell. The deny-list still fires on the
  Windows production path where `shell:true` is needed for `.cmd`
  launcher resolution.
- SECURITY.md threat-model bullet updated to reflect the scoping
  rationale and to note that `--effort` can now spawn up to three
  sequential one-shot subprocesses through the fallback chain.

Test suite: 121 → 134 tests (+2 new task integration cases from
PR #21, +3 new review fallback cases from PR #22, +8 new
SHELL_METACHAR_RE unit tests from PR #22). 133 pass, 1 skipped, 0
fail. CI green on both `ubuntu-latest` and `windows-latest`.

See merged PRs #21, #22 for the full review history.

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
