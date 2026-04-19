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

Flags: `--base <ref>`, `--wait`, `--background`, optional focus text.

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
```

### `/copilot:adversarial-review`

A **steerable** review that challenges the implementation approach and
design choices rather than just scanning for defects.

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether the caching design is right
/copilot:adversarial-review --background look for race conditions
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
`claude-opus-4.6`, `sonnet` → `claude-sonnet-4.5`, `haiku` →
`claude-haiku-4.5`. Any concrete Copilot model name works too.

**Effort → model mapping**: Copilot CLI has no per-call reasoning knob, so
`--effort` is translated:

| `--effort`         | Model                  |
|--------------------|------------------------|
| `none`, `minimal`, `low` | `claude-opus-4.6-fast` |
| `medium` (default) | `claude-sonnet-4.5`    |
| `high`, `xhigh`    | `claude-opus-4.6`      |

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

## v0.2 status

- Core runtime, broker, companion, and hooks all ported and under test.
- Standard and adversarial review commands share one prompt-engineered path
  (Copilot has no native `review/start` RPC).
- Bundled Copilot agent definitions live in `plugins/copilot/copilot-agents/`
  for users who want to invoke the same review contracts from interactive
  Copilot: `copilot --agent copilot-code-review`.
- Test coverage is now end-to-end against a spawnable fake-ACP fixture
  (`tests/fake-copilot.mjs`). Suites: `runtime-task`, `runtime-review`,
  `runtime-status-result-cancel`, `runtime-hooks`, `commands`, plus the
  protocol-agnostic set (git, process, render, state, broker-endpoint,
  broker-lifecycle, acp-client-allow-option, fake-copilot).
- Deferred to v0.3: per-session `--model` plumbing through the shared
  broker (broker is spawned once per Claude session, so per-call `--model`
  does not reach the upstream spawn); the multi-provider setup/auth
  tests from codex-plugin-cc (Codex-specific `account/read` + `config/read`
  contracts need a Copilot-native rewrite); shared-broker lazy-startup
  assertions.
- On Windows workspaces whose path contains spaces, `bump-version` and
  similar subprocess-style tests may fail with `MODULE_NOT_FOUND` because
  of a `spawnSync` quoting issue inherited from codex-plugin-cc. Move the
  repo to a path without spaces to work around it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
