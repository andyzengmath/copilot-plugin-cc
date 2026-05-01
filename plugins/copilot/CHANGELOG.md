# Changelog

Note: the first two releases were originally cut as 0.1.0 and 0.2.0 but
retroactively renumbered to 0.0.1 and 0.0.2 to better reflect their
pre-1.0 alpha status. Version strings inside the v0.0.1 tag's commit
still say 0.1.0; the tag itself is the canonical identifier.

## 0.0.21

Single fix surfaced by the v0.0.20 post-release dogfooding smoke
test (`/copilot:setup --probe-models`, the first time the plugin
exercised its own commands against a real Copilot CLI install
immediately after a release).

Fixed:
- `probeModelAvailability` default `timeoutMs` bumped 15000 →
  60000ms (PR #85). Running `/copilot:setup --probe-models` against
  Copilot CLI 1.0.40-0 immediately after v0.0.20 reported all 7
  probed models as "unknown — probe timed out after 15000ms" with
  no real availability signal. Measured cold-start of
  `copilot -p "ping" --model gpt-5.5` was ~33s end-to-end (each
  one-shot CLI invocation re-loads agent skills + MCP servers
  before resolving the model — cold-start dominates). The 15s
  default (set in v0.0.7) was reliably below that. Bumped to 60s
  with a measurement comment so future re-tunings are data-driven.
  Probes still run in parallel via `Promise.all`, so wall-clock
  cost of `--probe-models` is bounded by the slowest probe, not
  the sum. Default extracted to a `DEFAULT_PROBE_TIMEOUT_MS`
  module-level constant per project convention (matches
  `DEFAULT_STATUS_WAIT_TIMEOUT_MS`, `BROKER_LOCK_DEFAULT_TIMEOUT_MS`).

Process notes:
- First release directly verified by the v0.0.20 `CONTRIBUTING.md`
  pre-release smoke test. Post-fix probe result on a real account:
  6 / 7 models OK, 1 (`claude-opus-4.6-fast`) correctly identified
  as unavailable via `isModelUnavailableStderr` and surfaced in
  the next-steps banner.

Test suite: 174 / 173 pass / 1 skipped (unchanged — the change is
a default-value bump; existing `setup-probe.test.mjs` cases use a
fake Copilot binary with no real cold-start and don't depend on
the timeout literal). CI green on Ubuntu and Windows.

See merged PR #85 for the full review history (including the
`/pr-review` consistency finding that turned the inline `60000`
into a named constant).

## 0.0.20

User-facing model-alias refresh. The 2026-04-30 supported-models doc
check ([docs.github.com/en/copilot/reference/ai-models/supported-models](https://docs.github.com/en/copilot/reference/ai-models/supported-models))
surfaced `gpt-5.5` as the new top-of-family non-codex GPT model —
bumps the plugin's `gpt` alias to track the catalog. Mirrors the
v0.0.11 / v0.0.12 alias-refresh recipe.

Changed:
- `MODEL_ALIASES` (PR #76): `gpt` → `gpt-5.5` (was `gpt-5.4`, set in
  v0.0.12). Strictly additive — concrete model names always passed
  through verbatim, so `--model gpt-5.5` already worked before this
  PR; this just bumps the user-facing shortcut.
- README and `plugins/copilot/skills/copilot-cli-runtime/SKILL.md`
  alias lists refreshed to match (PR #76).
- Inline alias-resolution comment in
  `plugins/copilot/scripts/copilot-companion.mjs` (line 321) synced
  to `gpt → gpt-5.5`. The first commit missed it; the `/code-review`
  pass on PR #76 surfaced it and the fixup landed in the same PR.

Other catalog deltas surfaced by the same doc check (none actionable):
- `claude-opus-4.7` still latest opus (matches `opus` alias).
- `claude-sonnet-4.6` still latest sonnet (matches `sonnet` alias).
- `claude-haiku-4.5` still latest haiku (matches `haiku` alias).
- `gpt-5.3-codex` still latest codex (matches `codex` alias).
- `gpt-5.4-mini` and `gpt-5.4-nano` are visible — never had short
  aliases, so nothing to do.

Added:
- `tests/runtime-task.test.mjs`: `task --model gpt resolves the alias
  to --model gpt-5.5 via -p` (+1 case). Mirrors the existing
  codex/opus alias-resolution tests so a future bump (e.g. 5.6)
  cannot silently stale the alias without a test update.

`COMMON_PROBE_MODELS` deliberately retains both `gpt-5.5` and
`gpt-5.4` (and other prior-generation models) since the probe list is
about what users commonly ask for, not just current top-of-family.

Test suite: 174 / 173 pass / 1 skipped (was 173 / 172 / 1; +1 from
the new gpt-alias case). CI green on Ubuntu and Windows.

See merged PR #76 for the full review history.

## 0.0.19

Polish cycle on top of v0.0.18. Tightens `engines.node` to actually
enforce the per-major-line floors v0.0.18 intended, plus a documentation
refresh that brings the README and handoff doc in sync with the v0.0.17
and v0.0.18 hardenings.

Fixed:
- `engines.node` (PR #72): tightened from `>=18.20.2 || >=20.12.2 || >=22.0.0`
  to `^18.20.2 || ^20.12.2 || >=22.0.0`. The previous expression reduced
  to effectively `>=18.20.2` because npm semver `>=` is unbounded above,
  silently accepting Node 19.x and 21.x (both EOL) on hosts that may
  lack the CVE-2024-27980 (`.cmd` argv-injection) patch v0.0.18 was
  trying to require. The new caret-bounded expression enforces
  18.x ≥ 18.20.2, 20.x ≥ 20.12.2, and 22.0.0+ explicitly.
  **Behavioral change**: Node 19.x and 21.x users now hit a clear
  engines mismatch on `npm install` instead of silently passing
  through to an unpatched runtime. Both lines are EOL upstream, so
  the practical impact is small.

Changed:
- `README.md` (PR #71): refresh through v0.0.18. Status section
  bumped v0.0.16 → v0.0.18. Replaced the shell-metacharacter
  deny-list bullet with a description of the v0.0.18 `lib/safe-spawn.mjs`
  cross-spawn helper. Added a defense-in-depth bullet covering the
  v0.0.17 `--no-ask-user` + `--secret-env-vars` flags and the v0.0.18
  `--deny-tool=shell(<cmd>:*)` denials for `curl`/`wget`/`nc`/`ncat`/`ssh`.
  Test count `169` → `173`. Drop the `SHELL_METACHAR_RE` reference
  from the unit-test list; mention `tests/safe-spawn.test.mjs` as the
  first CI test exercising the production Windows `.cmd`-launcher
  spawn path. Requirements bumped to Copilot CLI 1.0.11+ and Node.js
  18.20.2+/20.12.2+/22.0.0+. Security paragraph now references the
  v0.0.18 cross-spawn helper plus `--deny-tool` exfiltration denials.
- `docs/plans/2026-04-20-v08-handoff.md` (PRs #67, #68, #69):
  - PR #67: post-v0.0.18 update folding the cross-spawn refactor
    notes into the live handoff.
  - PR #68: post-merge stale-reference cleanup. Replaced the
    `### Security deny-list` section with `### Spawn safety
    (cross-spawn helper, v0.0.18)` pointing at `lib/safe-spawn.mjs`.
    Replaced the `### EFFORT_TO_MODEL / fallback-chain tuning`
    backlog entry (referencing code removed in v0.0.16) with a
    `### MODEL_ALIASES refresh` entry following the v0.0.11/12 alias-
    refresh recipe. `node --test` example count `169 / 168` → `173 / 172`;
    `git log --oneline -5` example "atop v0.0.16" → "atop v0.0.18".
    "Key files to re-read first" drops dead `EFFORT_TO_MODEL`,
    `EFFORT_FALLBACK_CHAIN`, `buildEffortModelChain`, and
    `SHELL_METACHAR_RE` pointers; adds `lib/safe-spawn.mjs`. Removed
    3 untracked v0.0.18 cross-spawn debug repros from `tests/`.
  - PR #69: 2026-04-30 upstream audit (CLI 1.0.40-0) section.
    Re-confirmed both upstream-blocked items remain blocked
    (no stdin / `--prompt-file` for `-p`; no per-`session/new`
    permission flags). Net new flag surface since 1.0.39:
    `--reasoning-effort` (alias for `--effort`, plugin already wires
    `--effort`) and `--no-bash-env` (explicit-off pair to `--bash-env`).
    Neither actionable.
- `.gitignore` (PR #70): add `.claude/` alongside the existing `.omc/`
  entry. Per-user Claude Code agent-tool state shouldn't be staged
  by accidental `git add .`.

Test suite: 173 / 172 pass / 1 skipped. Unchanged count (no source
behavior changes apart from `engines.node`; test fixtures unaffected).
CI green on Ubuntu and Windows runners (both on Node 22, satisfying
the third clause of the new `engines.node`).

See merged PRs #67, #68, #69, #70, #71, #72 for the full review history.

## 0.0.18

Security hardening continuation on top of v0.0.17. Closes the
deferred items from the 2026-04-29 deep-dive: `--deny-tool` patterns
that previously broke under Windows `shell:true` cmd.exe parsing
now ship cleanly via a new cross-spawn-style helper.

Added:
- `lib/safe-spawn.mjs` — drop-in replacement for `child_process.spawn`
  that handles Windows `.cmd`/`.bat` launchers correctly without
  using `shell: true`. Modeled on `moxystudio/node-cross-spawn`'s
  `parseNonShell` + escape pipeline. Pre-resolves PATHEXT, builds
  `cmd.exe /d /s /c "<escaped>"` with backslash-double-quoting +
  caret-escape of cmd metacharacters, spawns with
  `windowsVerbatimArguments: true`. cmd-shims under
  `node_modules/.bin` get a second escape pass (BatBadBut
  mitigation).
- 5x `--deny-tool=shell(<cmd>:*)` flags pinned on broker
  `DEFAULT_COPILOT_SPAWN_ARGS` and one-shot `runCopilotCli` for
  `curl`, `wget`, `nc`, `ncat`, `ssh`. Per `copilot help permissions`:
  *"Denial rules always take precedence over allow rules, even
  --allow-all-tools."* Closes the prompt-injection-via-curl /
  exfiltration-via-nc threats. These commands have no legitimate
  use in code-review or rescue workflows (GitHub API → `gh`; npm
  registry → `npm`).
- `tests/safe-spawn.test.mjs` (3 tests). One Windows-only test
  writes a `.cmd` shim around `fake-copilot.mjs` and asserts
  metachar argv (`--deny-tool=shell(curl:*)`) reaches the child
  verbatim through the launcher. This is the FIRST CI test that
  exercises the production Windows `.cmd`-launcher path —
  previously tests always pointed `COPILOT_COMPANION_COPILOT_COMMAND`
  at `node fake.mjs` and never touched the `shell:true` branch.

Changed:
- All three spawn sites (`SpawnedCopilotAcpClient.initialize`,
  `runCopilotCli`, `probeSingleModel`) migrated to `safeSpawn` with
  `shell: false` everywhere. The Windows-vs-non-Windows shell
  ternary is gone.
- `engines.node` bumped from `>=18.18.0` to
  `>=18.20.2 || >=20.12.2 || >=22.0.0` so the CVE-2024-27980 patch
  (Node's mitigation against `.cmd` argv injection) is guaranteed
  present. Older 18.x lines are unpatched and would silently lose
  the entire mitigation.

Removed:
- `assertNoShellMetachars` helper + `SHELL_METACHAR_RE` constant
  (-50 LOC). The hand-rolled deny-list was incomplete (didn't
  cover `(`, `)`, `*`) and applied only to a subset of argv
  positions. safeSpawn's full escape pipeline replaces it across
  all spawn sites.
- `tests/shell-metachar-regex.test.mjs` (-72 LOC). The unit tests
  for the deleted helpers go with them.

Test suite: 173 / 172 pass / 1 skipped on Ubuntu + Windows CI.
The new safe-spawn.test.mjs Windows-only test passes on the
windows-latest runner — first CI exercise of the production
`.cmd`-launcher spawn path.

## 0.0.17

Security hardening cycle on top of v0.0.16. Two new flags surfaced
from the 2026-04-29 upstream audit (Copilot CLI 1.0.39) make the
plugin's broker and one-shot CLI explicitly non-interactive and
redact auth tokens from any debug-style shell output the agent
might surface.

Added:
- `--no-ask-user` (PR #60). The plugin runs through Claude Code's
  ACP harness, so the agent's `ask_user` tool had no human to
  answer it — `firstAllowOption` was auto-approving the
  `session/request_permission` instead, which let the tool fire but
  return without meaningful input. Now the tool is unavailable at
  the CLI level, so the agent never tries to use it.
- `--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN`
  (PR #61). Redacts the three auth-token env vars from broker logs
  and any shell output the agent surfaces. An LLM-generated
  `cat $env:GH_TOKEN` while debugging now shows `[REDACTED]` instead
  of the literal token in stdout.

Both flags are added to `DEFAULT_COPILOT_SPAWN_ARGS` (the broker
spawn) and to `runCopilotCli` (the one-shot `-p` path) so per-call
`--model` / `--effort` runs match the broker's behavior.

Internal cleanup since v0.0.16 (no user-visible behavior change):
- README rewrite + 3 pre-existing OneDrive-on-Windows test fixes
  (PR #56 — root cause was `CLAUDE_PLUGIN_DATA` and
  `COPILOT_COMPANION_SESSION_ID` env-leakage from real Claude Code
  sessions into spawned test subprocesses; tests now scrub the vars
  before spawn).
- Drop pre-v0.0.16 effort-mapping prose from skill, agent, and
  source comments (PR #57). README was updated in #56; #57 covers
  the files #56 missed.
- Remove dead `suppressActiveModelEcho` option from
  `runAppServerTurn` (PR #58). It was added speculatively in v0.0.15
  and never used. Plus 3 new tests locking in the active-model
  stderr echo format and edge cases (`COPILOT_HOME` with trailing
  slash, JSONC inline comments).
- 2026-04-29 upstream audit doc + design-doc deprecation note for
  the removed `EFFORT_TO_MODEL` mapping (PR #59).

Test suite: 169 / 168 pass / 1 skipped. Same on Ubuntu and Windows
CI. Two known flakes under high parallel load
(`concurrent ensureBrokerSession`, `task --resume-last --effort
high`) — both pass cleanly when re-run alone; documented in
`docs/plans/2026-04-20-v08-handoff.md` "Known flakes".

## 0.0.16

Closes the v0.0.15 user-reported bug: setting `model: "gpt-5.5"` in
`~/.copilot/settings.json` should mean every plugin command uses
GPT-5.5, but `--effort high` was silently overriding it with
`claude-opus-4.6` because the plugin mapped reasoning-effort to a
specific Claude model. Copilot CLI 1.0.11+ has its own native
`--effort` flag now, so the plugin's mapping was double-counting.

Changed:
- `--effort` now passes straight through to Copilot CLI's native
  `--effort=<low|medium|high|xhigh>` flag (1.0.11+ required). The
  plugin's `none`/`minimal` aliases still collapse to `low` at spawn
  time for codex-plugin-cc command parity.
- `--model` and `--effort` can be passed together; both flags forward
  verbatim and Copilot's runtime applies them independently. The old
  "--effort ignored because --model was passed" stderr notice is gone.
- When `--effort` is set without `--model`, the per-call CLI omits
  `--model` entirely so the user's `~/.copilot/settings.json` default
  model is preserved.
- On `--resume-last`, per-call `--model` and `--effort` are dropped
  together with a single combined stderr notice. (Broker holds the
  session and cannot switch either mid-turn.)
- `/copilot:setup --probe-models` now probes a fixed list
  (`COMMON_PROBE_MODELS`: 7 entries spanning Claude and GPT)
  instead of the now-removed `EFFORT_TO_MODEL` derivation.

Removed:
- `EFFORT_TO_MODEL`, `EFFORT_FALLBACK_CHAIN`, `applyEffortFallbackModel`,
  `buildEffortModelChain`. Net -311 LOC across source + tests. The
  multi-tier model-availability fallback chain is gone — Copilot's own
  error surfaces directly when a model isn't available on the account.

Fixed:
- `writeCopilotDefaults` (added in v0.0.15) used `Date.now()` as part
  of its temp filename, which could collide for two callers in the
  same millisecond (CI / parallel-test scenarios). Switched to
  `crypto.randomUUID()`. Caught by the soliton review of PR #54.

Tests:
- Rewrote 6 existing `--effort` tests to assert the new
  flag-passthrough behavior. Deleted 6 fallback-chain tests (behavior
  removed). Added 1 test for "single spawn, no chain". Updated
  `tests/setup-probe.test.mjs` for the new probe list.
- Full suite: 165/169 pass. The 3 remaining failures are pre-existing
  `resolveStateDir` / `status` issues on the OneDrive Windows
  workspace, unrelated to this release.

## 0.0.15

This release surfaces which Copilot model the plugin actually uses,
and adds a way to persist your default model + reasoning effort
without hand-editing `settings.json`.

Added:
- Active-model echo to stderr on every Copilot invocation so you can
  see, at a glance, which model the plugin is dispatching to (alias
  + resolved model + source).
- `/copilot:setup` output now prints the inherited model + effort +
  source, alongside the existing auth/CLI checks.
- `/copilot:setup --default-model <name|alias>` and
  `--default-effort <low|medium|high|xhigh>` write your defaults
  into `~/.copilot/settings.json` atomically. The writer preserves
  leading `//` comments and unrelated keys, so hand-tuned files
  survive the round-trip.
- `--model` and `--effort` flags exposed in the
  `argument-hint` for `/copilot:review` and
  `/copilot:adversarial-review`, matching the existing CLI runtime.
- New `auto` model alias maps to Copilot's auto-model selection
  (GA 2026-04-17), so `--model auto` now works as a first-class
  alias instead of a passthrough string.

Fixed:
- `~/.copilot/settings.json` was previously not read at all — model
  preferences only lived inside the auth file (`config.json`). The
  plugin now layers `settings.json` on top so user-pinned defaults
  actually take effect.
- `COPILOT_HOME` environment variable is now honored when locating
  the config dir. Earlier code only checked `XDG_CONFIG_HOME`, which
  meant users who relocated their Copilot data via `COPILOT_HOME`
  silently fell back to `~/.copilot`.

Internal:
- Outdated `:92-93` comment claiming Copilot has no per-call effort
  knob is corrected. Copilot CLI 1.0.11+ added a real `--effort`
  flag; a follow-up should pass it through directly instead of
  routing effort through model aliases.

Test suite: 158 → 174 tests (+16: active-model-info ×8,
write-copilot-defaults ×9). 170 / 174 pass. The 3 remaining failures
are pre-existing OneDrive-on-Windows path-resolution issues in
`resolveStateDir` / status helpers, unrelated to this release.

## 0.0.14

Two bugs found during a real local install + login on Copilot CLI
1.0.36. Both shipped in this release.

Fixed:
- `/copilot:setup` reported `loggedIn: false` even after a successful
  `copilot login` (PR #52). Root cause: Copilot CLI 1.0+ changed the
  `~/.copilot/config.json` schema in two ways the plugin didn't
  track:
  - The file now starts with JS-style `//` line comments that strict
    `JSON.parse` rejects, so `readCopilotConfig` silently returned
    `null`.
  - Field names flipped snake_case → camelCase:
    `logged_in_users` → `loggedInUsers`,
    `last_logged_in_user` → `lastLoggedInUser`. Even on a success-
    ful parse, the old field reads missed the signed-in user.

  `readCopilotConfig` now strips full-line `//` comments before
  parsing (narrow regex; block comments aren't observed in the
  config). `getCopilotAuthStatus` reads both the camelCase and
  snake_case key variants so CLI 0.x and 1.x both resolve.
  `tests/copilot-auth-status.test.mjs` added (+5) covering both
  schemas, missing file, empty users, and malformed JSON.
- Marketplace manifest identifiers claimed "GitHub" ownership (PR
  #51). Corrected to match the actual repo + author:
  - `.claude-plugin/marketplace.json` `"name"`:
    `"github-copilot"` → `"copilot-plugin-cc"` (matches repo slug).
  - `.claude-plugin/marketplace.json` `"owner"` and
    `plugins[0].author`: `"GitHub"` → `"andyzengmath"`.
  - `plugins/copilot/.claude-plugin/plugin.json` `"author"`:
    `"GitHub"` → `"andyzengmath"`.
  - README install command updated from
    `/plugin install copilot@github-copilot` to
    `/plugin install copilot@copilot-plugin-cc`.

  Cross-checked against Anthropic's own
  `anthropics/claude-code/.claude-plugin/marketplace.json`, which
  uses a self-describing marketplace name and the real author
  rather than the name of any plugin inside.

  **Breaking change** for users who installed via
  `/plugin install copilot@github-copilot`: re-run with
  `/plugin install copilot@copilot-plugin-cc` after updating. The
  `/plugin marketplace add andyzengmath/copilot-plugin-cc` step is
  unaffected (uses the repo path, not the manifest name).

Test suite: 153 → 158 tests (+5 auth-status cases). 157 pass, 1
skipped, 0 fail. CI green on both Linux and Windows.

See merged PRs #51, #52 for the full review history.

## 0.0.13

Small cleanup release. Two low-risk items that had drifted since
v0.0.8 (SECURITY.md) and v0.0.11 (SKILL.md alias list).

Changed:
- `EFFORT_TO_MODEL` (PR #47): `medium` → `claude-sonnet-4.6` (was
  `claude-sonnet-4.5`). Same Anthropic billing tier, no
  cost/quota impact on `--effort medium` flows. `EFFORT_FALLBACK_CHAIN`
  first-fallback entry for `high` / `xhigh` bumped to
  `claude-sonnet-4.6` to stay consistent with the primary.
- **Unchanged** — `--effort high` / `xhigh` stays on
  `claude-opus-4.6`. The v0.0.12 `opus` alias bumped to 4.7 for
  users who explicitly type `--model opus`, but the effort-default
  intentionally holds on 4.6 to avoid the 7.5x opus-4.7 premium-
  request multiplier (through 2026-04-30) silently hitting
  automation.
- `plugins/copilot/agents/copilot-rescue.md` and
  `plugins/copilot/skills/copilot-cli-runtime/SKILL.md` had stale
  alias lists (still showed `opus` → 4.6, `sonnet` → 4.5, didn't
  list the v0.0.11 `gpt` / `codex` aliases). Refreshed to the
  v0.0.12 state + the v0.0.13 sonnet default.
- `SECURITY.md` (PR #46): threat model refresh for everything
  shipped since v0.0.3/4. Adds two bullets to "What the plugin IS
  designed to defend against" — concurrent-session broker hijack
  (v0.0.8 `broker.lock` + stale-PID recovery) and silent acceptance
  of malformed structured review output (v0.0.8/9 schema
  validator). Adds `broker.lock` to the Secrets and paths table.
  Expands "Known limits" to explicitly list per-ACP-session
  sandboxing and Windows review-path `--effort` as upstream-
  blocked rather than plugin-side plans.

Test suite: 153 tests, unchanged count (the sonnet bump is a
surgical rename, not new coverage). 152 pass, 1 skipped, 0 fail.
CI green on both Linux and Windows.

See merged PRs #46, #47 for the full review history.

## 0.0.12

Refreshes the user-facing model aliases to track Copilot's
current top-of-family models after the v0.0.9 upstream audit
surfaced newer IDs that `--help` still lagged behind. User-
facing shortcuts only — `--effort` defaults are deliberately
unchanged to avoid silent quota-cost changes.

Changed:
- MODEL_ALIASES (PR #43):
  - `opus`    → `claude-opus-4.7`   (was `claude-opus-4.6`)
  - `sonnet`  → `claude-sonnet-4.6` (was `claude-sonnet-4.5`)
  - `gpt`     → `gpt-5.4`           (was `gpt-5.2`)
  - `codex`   → `gpt-5.3-codex`     (was `gpt-5.2-codex`)
  - `fast` / `haiku` unchanged (no newer variant shipped yet).
  - Verified against the official [supported-models
    doc](https://docs.github.com/en/copilot/reference/ai-models/supported-models);
    local `copilot --help` lags the catalog.
- README (PR #43): aliases line reshuffled + new block-quote
  documenting the 7.5x premium-request multiplier on
  `claude-opus-4.7` (promotional, through 2026-04-30) and how
  to opt back to `claude-opus-4.6` explicitly.

Explicitly NOT changed:
- `EFFORT_TO_MODEL` stays on `claude-opus-4.6` for
  `high`/`xhigh` and `claude-sonnet-4.5` for `medium`. Silently
  shifting `--effort high` from 4.6 to 4.7 would 7.5x users'
  quota burn on automated flows. The alias refresh only kicks
  in when a user explicitly types `--model opus`.
- `EFFORT_FALLBACK_CHAIN` stays on the existing tier names.

Limitations:
- `claude-opus-4.7` on Copilot is capped at ~192K context (the
  full 1M window the Anthropic API supports is not exposed by
  Copilot — see [upstream issue
  #2785](https://github.com/github/copilot-cli/issues/2785)).
  Users needing full 1M have to use Claude Code or the
  Anthropic API directly. No plugin-side workaround.

Added:
- `tests/runtime-task.test.mjs`: `task --model opus resolves
  the alias to --model claude-opus-4.7 via -p` (+1 case).
- Existing codex-alias test updated to `gpt-5.3-codex` as the
  refresh regression guard.
- Two opus-alias-resolution tests in runtime-task and
  runtime-review updated: fake-copilot `unavailableModels`
  now lists `claude-opus-4.7` so `--model opus`'s
  non-auto-fallback assertion still holds.

Test suite: 152 → 153 tests (+1 opus alias). 152 pass, 1
skipped, 0 fail. CI green on both Linux and Windows.

See merged PR #43 for the full review history.

## 0.0.11

Small follow-up cycle to v0.0.10 acting on the remaining open-ended
items from the post-v0.0.10 backlog. One user-facing UX addition
(GPT-family model aliases) plus one long-standing Windows test
flake root-caused and fixed.

Added:
- `gpt` → `gpt-5.2` and `codex` → `gpt-5.2-codex` MODEL_ALIASES
  entries (PR #40). Acts on the v0.0.9 upstream audit finding that
  multiple GPT models became visible in `copilot --help`
  (gpt-5.2, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5-mini, etc.) but
  were only reachable via full identifier. Strictly additive — any
  concrete model name still passes through verbatim. The comment
  above MODEL_ALIASES now documents the refresh convention (update
  when Copilot advances a family's top model; older names keep
  working via pass-through without an alias entry).
- `tests/runtime-task.test.mjs`: `task --model codex resolves the
  alias to --model gpt-5.2-codex via -p` (+1 case).
- `README.md`: model-alias line updated to show all six aliases and
  an explicit mention that concrete model names work without an
  alias.

Fixed:
- `tests/runtime-task.test.mjs`'s `task --background --effort high
  falls back to --model claude-sonnet-4.5 via the worker path` no
  longer flakes under full-suite parallel load on Windows (PR #41).
  Root cause: a synchronous busy-spin in the polling loop between
  file-system reads starved the detached worker subprocess of CPU,
  pushing the job past the 90 s deadline on loaded Windows. The
  test now uses `await new Promise((resolve) => setTimeout(resolve,
  500))` between polls (releasing the event loop) and the deadline
  has been bumped to 180 s. Isolated run completes in ~125 s
  post-fix. The root-cause analysis is recorded in an expanded
  comment above the polling loop so a future reader doesn't
  reintroduce a busy-spin.

Test suite: 151 → 152 tests (+1 codex alias). 151 pass, 1 skipped,
0 fail. CI green on both Linux and Windows; the previously-flaky
\-\-background test now passes deterministically under parallel
load.

See merged PRs #40, #41 for the full review history.

## 0.0.10

Extends the `--effort` fallback chain with `claude-haiku-4.5` as the
lowest-cost, widest-availability tail tier. Strictly-additive: users
on tiers where earlier fallbacks are available are unaffected; users
who previously hit chain exhaustion on a busy Copilot account now
get one more graceful tier before the call fails.

Changed:
- `EFFORT_FALLBACK_CHAIN` (PR #36): `claude-haiku-4.5` appended to
  the tail of the `medium` and `high` / `xhigh` chains.
  `medium`: `claude-sonnet-4.5` → `claude-opus-4.6-fast` →
  `claude-haiku-4.5`. `high` / `xhigh`: `claude-opus-4.6` →
  `claude-sonnet-4.5` → `claude-opus-4.6-fast` → `claude-haiku-4.5`.
  The `none` / `minimal` / `low` tiers are unchanged (still no
  fallback — their primary is already the lowest available tier).
  Rationale in the code comment and in
  `docs/plans/2026-04-20-post-v008-handoff.md#v009-update`: a
  `copilot --help` audit on 2026-04-20 confirmed `claude-haiku-4.5`
  is exposed on every tier that ships `--model` support.
- `/copilot:setup --probe-models` (PR #36): the probe now covers the
  union of `EFFORT_TO_MODEL` primaries AND every entry in
  `EFFORT_FALLBACK_CHAIN`, rather than just the primaries. Users
  previously could see "all probed models ok" while a fallback-only
  tier was actually unavailable — the probe's coverage didn't match
  what the runtime might reach. Automatically picks up new
  `claude-haiku-4.5` tier.
- `README.md` (PRs #36, #36 fixup): fallback-chain table on
  `/copilot:rescue` updated with the haiku tail for `medium` and
  `high` / `xhigh`. Status-section inline chain description now
  points to the canonical table instead of restating a (now-stale)
  shorter chain. "Deferred to v0.7+" list replaced with a one-
  paragraph note on which release shipped each item (setup-time
  model probe → v0.0.7; cross-Claude-session broker coordination →
  v0.0.8 PR #28; structured-output enforcement → v0.0.8 PR #29).

Added:
- `tests/runtime-task.test.mjs` (+2 cases):
  - `task --effort medium falls back to claude-haiku-4.5 when sonnet
    and fast are both unavailable` — locks in that the medium chain
    walks all the way to haiku rather than silently truncating.
  - `task --effort medium exhausts the fallback chain when every
    tier is unavailable` — mirror of the high-chain exhaustion test.
- `tests/setup-probe.test.mjs` (+1 case):
  - `setup --probe-models surfaces claude-haiku-4.5 in nextSteps
    when it is the only unavailable tier` — regression guard
    against the probe's model-union ever dropping fallback-chain
    entries.
- Existing tests updated for the new chain length: the
  `--effort high` exhaustion test now expects 3 retry notices + 4
  `-p` invocations; `setup --probe-models` tests expect 4 probe
  spawns instead of 3.

Test suite: 148 → 151 tests (+3). 150 pass, 1 skipped, 0 fail. CI
green on both Linux and Windows.

See merged PR #36 for the full review history (including both
`/code-review:code-review` and `/soliton:pr-review` passes).

## 0.0.9

Small polish cycle on the review-output render path introduced by
v0.0.8, closing the three follow-ups parked in the post-v0.0.8
handoff. No user-visible behavior changes for valid Copilot output;
tightens error-reporting for whitespace-only input and removes
unreachable defensive code.

Changed:
- `validateReviewOutput` is now file-local (PR #32). It was exported
  by PR #29 but had no external caller — every consumer is inside
  `renderReviewResult`. Keeping it unexported avoids implying a
  public surface that isn't used.
- `normalizeReviewFinding` simplified to just `.trim()` every string
  (PR #32). The pre-v0.0.8 defensive fallbacks (`"low"` severity,
  `"Finding N"` title, `"No details provided."` body, `"unknown"`
  file, null-line-start tolerance, reorder guard on line_end) were
  unreachable after `validateReviewOutput` started running first;
  the trimmed happy-path is now the only path. Drops ~20 lines.
- Review-output `minLength: 1` string validators now align on
  `.trim().length === 0` across `summary` / `findings[*].title /
  .body / .file` / `next_steps[i]` (PR #33). Before, `next_steps`
  used `.trim()` while the other four used raw `.length`, so
  Copilot could satisfy the schema with `summary: "   "` or
  `file: " "` and the validator would accept it. Consistent
  rejection of whitespace-only strings across all five fields.
  Deliberately stricter than the literal JSON Schema
  `minLength: 1` semantics — see PR #33 description for the
  rationale.

Added:
- `tests/render.test.mjs`: `renderReviewResult rejects whitespace-
  only summary/title/body/file` (+1 case).

Test suite: 147 → 148 tests (+1). 147 pass, 1 skipped, 0 fail. CI
green on both Linux and Windows.

See merged PRs #32, #33 for the full review history.

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
