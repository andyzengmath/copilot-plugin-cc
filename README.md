# Copilot plugin for Claude Code

Use **GitHub Copilot CLI** from inside Claude Code for code reviews or to
delegate tasks to Copilot.

This plugin is for Claude Code users who already have Copilot CLI installed
and want to invoke Copilot from the same workflow, without leaving Claude.

It is a port of [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
that swaps the underlying runtime: `codex app-server` is replaced by
`copilot --acp`, which speaks the standard
[Agent Client Protocol v1](https://agentclientprotocol.com/).

## What you get

- `/copilot:review` — standard code review of your current work
- `/copilot:adversarial-review` — steerable challenge review
- `/copilot:rescue`, `/copilot:status`, `/copilot:result`, `/copilot:cancel` — delegate work and manage background jobs
- `/copilot:setup` — installer and auth check; toggle the optional stop-time review gate

## Requirements

- **GitHub Copilot subscription.** Usage counts against your Copilot allowance.
- **Copilot CLI 1.0.11 or later** (for native `--effort` passthrough; anything that speaks ACP v1).
- **Node.js 18.20.2–18.x, 20.12.2–20.x, or 22.0.0+** — caret-bounded so EOL Node 19.x and 21.x are explicitly rejected. `engines.node` enforces the floors so the CVE-2024-27980 (`.cmd` argv-injection) patch is guaranteed present.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add andyzengmath/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@copilot-plugin-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` will tell you whether Copilot CLI is ready. If Copilot is
missing and npm is available, it can offer to install Copilot for you.

If you prefer to install Copilot yourself:

```bash
npm install -g @github/copilot
```

If Copilot is installed but not signed in:

```bash
!copilot login
```

## Usage

### `/copilot:review`

Runs a standard code review on your current work.

Use it when you want:

- a review of your uncommitted changes
- a review of your branch compared to a base branch like `main`

Flags: `--base <ref>`, `--wait`, `--background`, `--model <name>`,
`--effort <level>`, optional focus text.

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
/copilot:review --effort high
```

### `/copilot:adversarial-review`

A **steerable** review that challenges the implementation approach and
design choices rather than just scanning for defects. Accepts the same
flags as `/copilot:review`.

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether the caching design is right
/copilot:adversarial-review --background look for race conditions
/copilot:adversarial-review --effort high focus on the retry semantics
```

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

Use it when you want Copilot to investigate a bug, try a fix, continue a
previous Copilot task, or take a different pass at the problem.

Flags: `--background`, `--wait`, `--resume`, `--fresh`, `--model <name>`, `--effort <level>`.

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model claude-opus-4.6 --effort high investigate the regression
/copilot:rescue --background investigate the flaky integration test
```

**Model aliases**: `fast` → `claude-opus-4.6-fast`, `opus` →
`claude-opus-4.7`, `sonnet` → `claude-sonnet-4.6`, `haiku` →
`claude-haiku-4.5`, `gpt` → `gpt-5.5`, `codex` → `gpt-5.3-codex`,
`auto` → Copilot's auto-model-selection (GA 2026-04-17).
Any concrete Copilot model name works too — e.g.
`--model claude-opus-4.6` or `--model gpt-5.5` or
`--model gpt-5.4-mini` — even if it doesn't have a short alias.

> Note: `claude-opus-4.7` currently sits at a 7.5x Copilot premium-
> request multiplier (through 2026-04-30). The `opus` alias tracks
> it anyway; type `--model claude-opus-4.6` explicitly if you need
> the pre-4.7 billing rate.

**`--effort`** passes straight through to Copilot CLI's native
`--effort=<low|medium|high|xhigh>` flag (Copilot CLI 1.0.11+). The
plugin's `none`/`minimal` aliases collapse to `low` at spawn time
for codex-plugin-cc command parity. When `--effort` is set without
`--model`, the user's default model from
[`~/.copilot/settings.json`](#default-model--effort) is preserved
— effort and model are independent knobs.

`--model` and `--effort` can be passed together; both flow through
verbatim and Copilot's runtime applies them independently. There is
no longer an "either/or" override: in v0.0.16 the plugin dropped the
internal effort-to-model mapping that used to silently force a Claude
model whenever `--effort` was set.

### Default model + effort

The plugin reads its default model and reasoning effort from
`~/.copilot/settings.json` (the standard Copilot CLI settings file —
location is `$COPILOT_HOME/settings.json` if you've set
`COPILOT_HOME`). Selection precedence is:

1. `/model` slash command inside an interactive `copilot` session
2. `--model` / `--effort` CLI flags on the plugin command
3. `COPILOT_MODEL` / `COPILOT_EFFORT_LEVEL` environment variables
4. `model` / `effortLevel` keys in `~/.copilot/settings.json`
5. Copilot CLI's built-in default (`claude-sonnet-4.6` today)

The fastest way to change your default for every plugin command is:

```bash
/copilot:setup --default-model gpt-5.5 --default-effort high
```

That writes the two keys into `~/.copilot/settings.json` atomically,
preserving leading `// ...` comments and every other key the file
already had. After that, `/copilot:rescue`, `/copilot:review`, and
the others will inherit GPT-5.5 + high reasoning unless a per-call
flag overrides them.

Every plugin call also emits an `[copilot] Using model: ...` line
to stderr before doing work, so you can confirm the active model +
effort + source on each invocation.

### `/copilot:status`, `/copilot:result`, `/copilot:cancel`

Same semantics as codex-plugin-cc. Track, fetch, and cancel background
Copilot jobs scoped to this Claude session.

### `/copilot:setup`

Checks install, ACP health, and auth state. The output also shows the
**active model** line — your inherited default model, effort, and where
the value came from (settings.json, env, or Copilot CLI default).

Toggle the optional stop-time review gate:

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

Persist a default model and reasoning effort into
`~/.copilot/settings.json`:

```bash
/copilot:setup --default-model gpt-5.5
/copilot:setup --default-effort high
/copilot:setup --default-model auto --default-effort medium
```

Aliases (`fast`, `opus`, `sonnet`, `haiku`, `gpt`, `codex`, `auto`)
resolve to canonical Copilot model identifiers before being written.
The plugin's `none`/`minimal` effort tiers collapse to `low` (Copilot's
own `effortLevel` only accepts `low`/`medium`/`high`/`xhigh`). Other
keys in `settings.json` are preserved.

Probe Copilot for model availability against a fixed list of common
models (Claude + GPT) before you hit an availability error mid-run:

```bash
/copilot:setup --probe-models
```

## How it works

- Spawns one shared `copilot --acp` broker process per Claude session.
- Routes all plugin commands to the broker over a Unix socket (or Windows
  named pipe).
- Tracks jobs in `${CLAUDE_PLUGIN_DATA}/state/<workspace>/` with per-job
  JSON + log files, session-scoped via a `SessionStart` hook.
- Cancels a live run with ACP `session/cancel`; falls back to killing the
  process tree if the session ID is unknown.
- Within a Claude session, the broker reuses the cached Copilot session ID
  over ACP (full streaming progress). Cross-Claude-session resume was
  descoped in v1; `render.mjs` emits a `copilot --continue ${sessionId}`
  hint string so users can recover via the Copilot CLI directly.

See [`docs/plans/2026-04-17-copilot-plugin-cc-design.md`](docs/plans/2026-04-17-copilot-plugin-cc-design.md)
for the full design, including the Codex-RPC ↔ ACP-v1 mapping table and
the per-command porting decisions.

## Status (v0.0.21)

- Core runtime, broker, companion, and hooks all ported and under test.
- Standard and adversarial review commands share one prompt-engineered
  path (Copilot has no native `review/start` RPC). The `copilot-agents/`
  files are the canonical review methodology; the runtime prompt
  templates include them via `{{AGENT:<name>}}` so there's no drift
  between the plugin prompt and `copilot --agent copilot-code-review`.
- Per-call `--model` and `--effort` flags pass straight through to
  Copilot CLI's native flags (1.0.11+) via a one-shot
  `copilot -p "<prompt>"` subprocess that bypasses the shared ACP
  broker. Applied uniformly across `/copilot:rescue`, `/copilot:review`,
  and `/copilot:adversarial-review`. The legacy effort→model mapping
  was removed in v0.0.16 so `--effort` no longer overrides your
  configured default model.
- The active model + effort + source is echoed to stderr before every
  plugin call (v0.0.15) and shown in `/copilot:setup` output. Defaults
  can be persisted to `~/.copilot/settings.json` via
  `/copilot:setup --default-model X --default-effort Y` (v0.0.15).
- Multi-session broker coordination via a workspace-scoped
  `broker.lock` file (v0.0.8). Two Claude sessions starting on the
  same workspace simultaneously share one `copilot --acp` broker
  instead of racing to spawn duplicates. Fast path (live `broker.json`
  + reachable endpoint) skips the lock entirely so single-session
  reuse stays zero-overhead.
- Review-output enforcement walks every constraint in
  `plugins/copilot/schemas/review-output.schema.json` end-to-end
  (v0.0.8 + v0.0.9 tightening). Violations render as a bulleted
  `Schema violations:` section, not a short-circuited "first error"
  message.
- All three Copilot spawn sites use `lib/safe-spawn.mjs` (v0.0.18) — a
  cross-spawn-style helper that pre-resolves Windows `.cmd`/`.bat`
  launchers via PATHEXT and applies argv escaping with
  `windowsVerbatimArguments: true`, so `shell: false` everywhere. This
  closed the CVE-2024-27980 ("BatBadBut") class without the
  hand-rolled deny-list that v0.0.3-v0.0.17 carried.
- Defense-in-depth on the prompt-injection path: `--no-ask-user`
  (v0.0.17) removes the `ask_user` tool at the CLI level so a
  prompt-injected ask can't stall the run; `--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN`
  (v0.0.17) redacts auth tokens from any debug-style shell output the
  agent surfaces; `--deny-tool=shell(<cmd>:*)` for `curl`/`wget`/`nc`/`ncat`/`ssh`
  (v0.0.18) cuts off exfiltration commands even with the broker's
  `--allow-all-tools` (denial > allow per `copilot help permissions`).
- Test coverage is end-to-end against a spawnable fake-ACP fixture
  (`tests/fake-copilot.mjs`). 180 tests across runtime suites, unit
  tests (safe-spawn, prompt loader, firstAllowOption, broker
  endpoint, schema validator, settings.json reader/writer, etc.) and
  the protocol-agnostic set. `tests/safe-spawn.test.mjs` (v0.0.18) is
  the first CI test that exercises the production Windows
  `.cmd`-launcher spawn path. CI runs on every PR on Ubuntu + Windows.

See
[`docs/plans/2026-04-20-v08-handoff.md`](docs/plans/2026-04-20-v08-handoff.md)
for the running backlog and per-release details, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the maintainer pre-release
smoke-test recipe.

## Security

See [SECURITY.md](SECURITY.md) for the threat model, the Windows ACL
caveat on `broker.json`, the v0.0.18 cross-spawn helper plus
`--deny-tool` exfiltration denials, and how to report vulnerabilities
via a private GitHub Security Advisory.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
