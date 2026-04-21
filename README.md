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
- **Copilot CLI 0.0.400 or later** (anything that speaks ACP v1).
- **Node.js 18.18 or later.**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add andyzengmath/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@github-copilot
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
`claude-haiku-4.5`, `gpt` → `gpt-5.4`, `codex` → `gpt-5.3-codex`.
Any concrete Copilot model name works too — e.g.
`--model claude-opus-4.6` or `--model gpt-5.1-codex-max` or
`--model gpt-5.4-mini` — even if it doesn't have a short alias.

> Note: `claude-opus-4.7` currently sits at a 7.5x Copilot premium-
> request multiplier (through 2026-04-30). The `opus` alias tracks
> it anyway; type `--model claude-opus-4.6` explicitly if you need
> the pre-4.7 billing rate. The `--effort high` default (below)
> intentionally stays on `claude-opus-4.6` so automated flows that
> use `--effort` don't change their per-call cost without an
> explicit user decision.

**Effort → model mapping**: Copilot CLI has no per-call reasoning knob, so
`--effort` is translated:

| `--effort`                | Model                  | Fallback chain on unavailability                                         |
|---------------------------|------------------------|--------------------------------------------------------------------------|
| `none`, `minimal`, `low`  | `claude-opus-4.6-fast` | _(already lowest tier)_                                                  |
| `medium` (default)        | `claude-sonnet-4.6`    | `claude-opus-4.6-fast` → `claude-haiku-4.5`                              |
| `high`, `xhigh`           | `claude-opus-4.6`      | `claude-sonnet-4.6` → `claude-opus-4.6-fast` → `claude-haiku-4.5`        |

If the primary effort-mapped model isn't available on your Copilot
account, the plugin automatically retries down the chain and surfaces a
stderr notice showing which tier it landed on. Explicit `--model X`
never triggers the fallback — your picked model is used as-is. The
same fallback chain applies to `/copilot:task`, `/copilot:review`, and
`/copilot:adversarial-review`.

If you pass both `--model` and `--effort`, `--model` wins and `--effort` is
logged as a no-op.

### `/copilot:status`, `/copilot:result`, `/copilot:cancel`

Same semantics as codex-plugin-cc. Track, fetch, and cancel background
Copilot jobs scoped to this Claude session.

### `/copilot:setup`

Checks install, ACP health, and auth state. Also toggles the optional
stop-time review gate:

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

## How it works

- Spawns one shared `copilot --acp` broker process per Claude session.
- Routes all plugin commands to the broker over a Unix socket (or Windows
  named pipe).
- Tracks jobs in `${CLAUDE_PLUGIN_DATA}/state/<workspace>/` with per-job
  JSON + log files, session-scoped via a `SessionStart` hook.
- Cancels a live run with ACP `session/cancel`; falls back to killing the
  process tree if the session ID is unknown.
- Cross-Claude-session resume falls back to `copilot -p --continue` when no
  in-broker session is available (streaming progress degrades to coarse
  phase transitions).

See [`docs/plans/2026-04-17-copilot-plugin-cc-design.md`](docs/plans/2026-04-17-copilot-plugin-cc-design.md)
for the full design, including the Codex-RPC ↔ ACP-v1 mapping table and
the per-command porting decisions.

## Status (v0.0.12)

- Core runtime, broker, companion, and hooks all ported and under test.
- Standard and adversarial review commands share one prompt-engineered
  path (Copilot has no native `review/start` RPC). The `copilot-agents/`
  files are the canonical review methodology; the runtime prompt
  templates include them via `{{AGENT:<name>}}` so there's no drift
  between the plugin prompt and `copilot --agent copilot-code-review`.
- Per-call `--model` / `--effort` routing bypasses the shared ACP
  broker and invokes `copilot -p "<prompt>" --model <model>` as a
  one-shot subprocess. Applied uniformly across `/copilot:task`,
  `/copilot:review`, and `/copilot:adversarial-review`. When the
  effort-mapped model isn't available on the user's Copilot account,
  the plugin walks the fallback chain defined in the table under
  [`/copilot:rescue`](#copilotrescue) with a stderr notice on each
  retry. Explicit `--model` never auto-falls-back.
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
- `--effort` fallback chain extends through `claude-haiku-4.5` as the
  lowest-cost last-resort tier (v0.0.10). User-facing aliases
  (`opus`, `sonnet`, `gpt`, `codex`) track Copilot's current top-of-
  family models (v0.0.11 + v0.0.12).
- A conservative shell-metacharacter deny-list fires on the shell-
  enabled spawn path (Windows production with the real `.cmd`
  launcher) so user-controlled prompts can't become a cmd.exe
  injection vector (CVE-2024-27980 class). Under `shell:false` argv
  passes to `CreateProcess` / `execve` verbatim, so the deny-list
  is skipped — safely — rather than rejecting legitimately-structured
  review prompts (XML tags, code fences).
- Test coverage is end-to-end against a spawnable fake-ACP fixture
  (`tests/fake-copilot.mjs`). 153 tests across runtime suites, unit
  tests (SHELL_METACHAR_RE, isModelUnavailableStderr, prompt loader,
  firstAllowOption, broker endpoint, schema validator, etc.), and the
  protocol-agnostic set. CI runs on every PR on Ubuntu + Windows.

All three v1.1-deferred items from the original design doc are now
either shipped (concurrent broker reuse → v0.0.8; structured-output
enforcement → v0.0.8) or confirmed upstream-blocked
(per-ACP-session sandboxing). See
[`docs/plans/2026-04-20-v08-handoff.md`](docs/plans/2026-04-20-v08-handoff.md)
for the running backlog and per-release details.

All three items that this section previously listed as deferred have
shipped: the setup-time model probe landed in v0.0.7 as
`/copilot:setup --probe-models`; cross-Claude-session broker
coordination landed in v0.0.8 via the workspace-scoped `broker.lock`
(PR #28); structured-output enforcement for review JSON landed in
v0.0.8 as the full schema walker in `validateReviewOutput` (PR #29).

## Security

See [SECURITY.md](SECURITY.md) for the threat model, the Windows ACL
caveat on `broker.json`, the per-call CLI shell-metacharacter deny-list,
and how to report vulnerabilities via a private GitHub Security
Advisory.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
