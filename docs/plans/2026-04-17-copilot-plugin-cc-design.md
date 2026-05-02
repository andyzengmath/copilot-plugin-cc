# copilot-plugin-cc design

**Date:** 2026-04-17
**Status:** Design approved, pending implementation
**Reference plugin:** `codex-plugin-cc` (OpenAI's Codex plugin for Claude Code)

## Goal

Ship a Claude Code plugin that wraps **GitHub Copilot CLI** with the same
command surface, UX, and job-management model that `codex-plugin-cc` offers for
OpenAI Codex. The plugin must feel identical to `codex-plugin-cc` users —
same slash commands, same status/result/cancel flow, same rescue subagent
forwarding pattern — while speaking Copilot's native protocol underneath.

## Non-goals

- Reimplementing Copilot's CLI features in Claude Code.
- Supporting non-ACP Copilot CLI transports (stdin REPL, etc.) in v1.
- Cross-tool portability (running the same companion against both Codex and
  Copilot from one install).

## High-level approach

Fork `codex-plugin-cc`'s architecture. Reuse every Codex-agnostic module
byte-for-byte. Replace only the three things that actually depend on the
backing CLI:

1. The JSON-RPC client (`lib/app-server.mjs` → `lib/acp-client.mjs`).
2. The turn-capture state machine and review/task runners
   (`lib/codex.mjs` → `lib/copilot.mjs`).
3. The broker spawn target
   (`spawn("codex", ["app-server"])` → `spawn("copilot", ["--acp"])`).

Every other module — `state.mjs`, `tracked-jobs.mjs`, `job-control.mjs`,
`git.mjs`, `process.mjs`, `args.mjs`, `fs.mjs`, `workspace.mjs`, `prompts.mjs`,
`render.mjs`, `broker-lifecycle.mjs`, `broker-endpoint.mjs` — ports verbatim.

The companion script (`codex-companion.mjs` → `copilot-companion.mjs`) keeps
its entire shape because the replacement `copilot.mjs` matches
`codex.mjs`'s public export signatures:
`runAppServerTurn`, `runAppServerReview`, `interruptAppServerTurn`,
`getCodexAvailability` (renamed `getCopilotAvailability`),
`getCodexAuthStatus` (renamed `getCopilotAuthStatus`),
`findLatestTaskThread`, `buildPersistentTaskThreadName`,
`parseStructuredOutput`, `readOutputSchema`, `DEFAULT_CONTINUE_PROMPT`.

Net reuse target: **~60% literal reuse, ~40% swap**. Roughly 1200–1500 LOC
of new/modified code against the plugin's ~4000 LOC baseline.
(Original v1 sizing target; the implementation through v0.0.21 has grown
past this — treat as historical context.)

## ACP spike findings (2026-04-17)

`copilot --acp` speaks the standard **Agent Client Protocol v1** (the same
protocol Zed uses). Initialize handshake returns:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": {
      "image": true, "audio": false, "embeddedContext": true
    }
  },
  "agentInfo": {"name": "Copilot", "title": "Copilot", "version": "0.0.406"},
  "authMethods": [{
    "id": "copilot-login",
    "name": "Log in with Copilot CLI",
    "description": "Run `copilot login` in the terminal"
  }]
}
```

Key implications:

- **Stable standard protocol.** We bind against ACP v1, not a Copilot-
  proprietary surface.
- **`loadSession: false`** → no protocol-level thread resume. We design two
  resume paths: in-broker (cached `sessionId`) and cross-Claude-session
  (CLI fallback with `copilot --continue`).
- **Auth is delegated to `copilot login`** at the terminal. ACP advertises
  the auth method but does not perform the login itself; our `setup` flow
  mirrors Codex's (`!copilot login` when not authenticated).
- **Copilot CLI has a built-in `/review` agent** in its interactive mode. We
  can reference its methodology in our review prompt templates without
  actually routing through interactive mode.

## Repository layout

```
copilot-plugin-cc/
├── .claude-plugin/
│   └── marketplace.json                        # name: github-copilot
├── plugins/copilot/
│   ├── .claude-plugin/plugin.json
│   ├── agents/
│   │   └── copilot-rescue.md                   # PORT (rename refs)
│   ├── copilot-agents/                         # NEW — bundled Copilot
│   │   ├── copilot-code-review.md              # agent definitions for
│   │   └── copilot-adversarial-review.md       # `copilot --agent ...`
│   ├── commands/
│   │   ├── review.md                           # PORT
│   │   ├── adversarial-review.md               # PORT
│   │   ├── rescue.md                           # PORT
│   │   ├── status.md                           # PORT
│   │   ├── result.md                           # PORT
│   │   ├── cancel.md                           # PORT
│   │   └── setup.md                            # PORT
│   ├── hooks/hooks.json                        # REUSE-as-is
│   ├── prompts/
│   │   ├── review.md                           # NEW (no native review)
│   │   ├── adversarial-review.md               # PORT (tone tweaks)
│   │   └── stop-review-gate.md                 # PORT
│   ├── schemas/
│   │   └── review-output.schema.json           # REUSE (prompt contract)
│   ├── scripts/
│   │   ├── copilot-companion.mjs               # PORT ~95% unchanged
│   │   ├── acp-broker.mjs                      # PORT of app-server-broker
│   │   ├── session-lifecycle-hook.mjs          # PORT (trivial renames)
│   │   ├── stop-review-gate-hook.mjs           # PORT (exec swap)
│   │   └── lib/
│   │       ├── acp-client.mjs                  # NEW — ACP v1 JSON-RPC
│   │       ├── acp-protocol.d.ts               # NEW — ACP v1 types
│   │       ├── copilot.mjs                     # PORT of codex.mjs
│   │       ├── broker-lifecycle.mjs            # REUSE (agnostic)
│   │       ├── broker-endpoint.mjs             # REUSE
│   │       ├── state.mjs                       # REUSE (bytewise)
│   │       ├── tracked-jobs.mjs                # REUSE (bytewise)
│   │       ├── job-control.mjs                 # REUSE (bytewise)
│   │       ├── git.mjs                         # REUSE (bytewise)
│   │       ├── process.mjs                     # REUSE (bytewise)
│   │       ├── args.mjs                        # REUSE (bytewise)
│   │       ├── fs.mjs                          # REUSE (bytewise)
│   │       ├── workspace.mjs                   # REUSE (bytewise)
│   │       ├── prompts.mjs                     # REUSE (bytewise)
│   │       └── render.mjs                      # REUSE (minor text)
│   └── skills/
│       ├── copilot-cli-runtime/SKILL.md        # PORT (renamed)
│       ├── copilot-result-handling/SKILL.md    # PORT (renamed)
│       └── copilot-prompting/SKILL.md          # PORT of gpt-5-4-prompting
├── scripts/
│   └── bump-version.mjs                        # REUSE
├── tests/                                      # PORT (fake-codex → fake-copilot)
│   ├── fake-copilot-fixture.mjs                # NEW (ACP-shaped fixture)
│   ├── broker-endpoint.test.mjs                # REUSE
│   ├── bump-version.test.mjs                   # REUSE
│   ├── commands.test.mjs                       # PORT
│   ├── git.test.mjs                            # REUSE
│   ├── helpers.mjs                             # REUSE
│   ├── process.test.mjs                        # REUSE
│   ├── render.test.mjs                         # PORT
│   ├── runtime.test.mjs                        # PORT (largest)
│   └── state.test.mjs                          # REUSE
├── tsconfig.app-server.json                    # REUSE (retargeted)
├── package.json                                # renamed to @github/copilot-plugin-cc
├── LICENSE                                     # new (matching repo license)
├── NOTICE                                      # new
├── README.md                                   # new (rewritten for Copilot)
└── .gitignore                                  # REUSE
```

## ACP v1 ↔ Codex app-server mapping

`lib/copilot.mjs` normalizes ACP events into the existing progress-reporter
event shape so `render.mjs` and `tracked-jobs.mjs` keep working unchanged.

| Codex RPC                            | ACP v1 equivalent                             | Notes                                                                 |
|--------------------------------------|-----------------------------------------------|-----------------------------------------------------------------------|
| `initialize`                         | `initialize`                                   | Same shape; capabilities negotiated.                                 |
| `thread/start`                       | `session/new`                                  | Returns `sessionId`. ACP sessions always persist for broker lifetime. |
| `thread/resume`                      | — (`loadSession: false`)                       | Resume works only within one broker lifetime by reusing sessionId.   |
| `thread/name/set`                    | —                                              | Thread names are a codex-only concept; skip.                         |
| `thread/list`                        | —                                              | Use local `state.mjs` job records as source of truth.                |
| `turn/start`                         | `session/prompt`                               | Returns `stopReason` on completion.                                  |
| `turn/interrupt`                     | `session/cancel`                               | Same semantics.                                                       |
| `review/start`                       | — (no native)                                  | Both review commands use `session/prompt` with structured prompt.    |
| `item/started`, `item/completed`     | `session/update` with variant types            | Mapper in `copilot.mjs` → existing progress-reporter events.          |
| `turn/completed`                     | `session/update` stop variant                  | Maps onto `turn/completed` equivalent.                                |
| `account/read`                       | — (check `~/.copilot/config.json`)             | Auth state via config file; supplement with ACP `initialize` probe.  |
| `config/read`                        | — (read `~/.copilot/config.json` directly)     | Provider info comes from Copilot config.                              |

### `session/update` variant mapping

The ACP `session/update` notification carries several variant types. The
mapper inside `copilot.mjs` translates them to the existing progress events
that `codex.mjs` emits today:

| ACP variant                 | Codex-equivalent event          | Progress phase        |
|-----------------------------|---------------------------------|-----------------------|
| `user_message_chunk`        | (echo — ignored)                | —                     |
| `agent_message_chunk`       | `item/started` agentMessage     | `running`             |
| `agent_thought_chunk`       | `item/completed` reasoning      | `investigating`       |
| `tool_call`                 | `item/started` commandExecution / mcpToolCall | `running` / `investigating` |
| `tool_call_update`          | `item/completed` commandExecution | `running` / `verifying` |
| `plan`                      | (log-only; no direct codex peer) | `planning`            |
| `commands_available_update` | (log-only)                      | —                     |
| `current_mode_update`       | (log-only)                      | —                     |
| stop variant (stopReason)   | `turn/completed`                | `finalizing`          |

The mapper lives inside `copilot.mjs`. All upstream modules (renderer,
progress updater, status preview) remain byte-identical to codex-plugin-cc.

## Per-command behaviour

### `/copilot:setup`

- Checks `copilot --version`.
- Probes `copilot --acp` with an `initialize` request to confirm ACP is
  healthy.
- Reads `~/.copilot/config.json::logged_in_users` to detect auth state.
- If Copilot missing and npm is available, offers
  `npm install -g @github/copilot` (verify final package name during
  implementation).
- If Copilot present but unauthenticated, directs the user to
  `!copilot login` (ACP `authMethods[0]` confirms the flow).
- Toggles `stopReviewGate` config identically to the Codex plugin.

### `/copilot:review`

- New `prompts/review.md` template (standard-tone, not adversarial).
- Opens with `"Use your built-in /review code-review skill as the review
  methodology, then emit ONLY JSON matching this schema: ..."` so Copilot's
  native reviewer patterns are engaged while we retain schema-constrained
  output.
- Uses the `executeReviewRun` non-native branch (same path codex uses for
  `/codex:adversarial-review`).
- Emits `review-output.schema.json` JSON as a prompt contract with
  best-effort parse (schema not enforced at protocol level — ACP has no
  `outputSchema` field).

### `/copilot:adversarial-review`

- Ports existing `prompts/adversarial-review.md` with minor tone tweaks for
  Copilot's default Claude model.
- Same execution path as `/copilot:review` but with the adversarial prompt
  variant.
- Preserves `--base`, `--scope`, focus-text, foreground/background flags.

### `/copilot:rescue`

- Forwards through the `copilot:copilot-rescue` subagent (renamed from
  `codex:codex-rescue`).
- Subagent uses a single `task` call into `copilot-companion.mjs`.
- Strips `--resume`/`--fresh` routing flags from the task text.
- `--resume-last` path:
  1. Primary: reuse the cached `sessionId` from the current broker →
     `session/prompt` on that ID (live streaming preserved).
  2. Fallback: if no in-broker session exists but a previous job's
     `copilotSessionId` is stored in `state.mjs`, spawn
     `copilot -p "<continue prompt>" --continue --allow-all-tools` as a
     detached subprocess. Feed stdout/stderr into the existing
     `tracked-jobs` pipeline. Progress degrades from `session/update`
     streaming to `running → completed` phase transitions only.
- `--effort` maps to `--model` per the table below.

### `/copilot:status`, `/copilot:result`, `/copilot:cancel`

Untouched behaviour — they operate entirely on local `state.mjs` data. The
only change is the string `codex` → `copilot` in rendered output.
`cancel` invokes `session/cancel` (via `interruptAppServerTurn`) instead of
`turn/interrupt`, but the public contract is identical.

## Permissions model

Codex uses a `sandbox: "read-only" | "workspace-write"` flag on every turn.
Copilot's permissions are set at CLI spawn time, not per-session.

**Broker spawn flags** (once per Claude session, updated through v0.0.18; canonical list at `plugins/copilot/scripts/lib/acp-client.mjs::DEFAULT_COPILOT_SPAWN_ARGS`):

```
copilot --acp \
  --allow-all-tools --allow-all-paths --allow-all-urls \
  --no-ask-user \
  --secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN \
  --deny-tool=shell(curl:*) --deny-tool=shell(wget:*) \
  --deny-tool=shell(nc:*)   --deny-tool=shell(ncat:*) \
  --deny-tool=shell(ssh:*)
```

(Per-call `-p` invocations — `probeSingleModel` and the review path in
`runCopilotCli` — additionally append `--add-dir <cwd>`, `--model`, and
`--effort`. Those are not part of the broker spawn.)

Our ACP broker auto-approves inbound `session/request_permission` messages.
Read-only review is enforced **by prompt contract**, the same way
codex-plugin-cc enforces `sandbox: "read-only"` through prompt text — both
are conventions the agent honors. This is an explicit design tradeoff: we
trade protocol-level sandboxing for broker-unity (one long-lived process
per Claude session) and simpler spawn plumbing.

Per-turn overrides are not supported in v1. If a future Copilot CLI release
adds per-session permission flags to ACP, we revisit.

## Resume semantics (detailed)

Codex's `thread/resume` is a first-class RPC. Copilot's ACP declares
`loadSession: false`. We implement a two-path resume:

### Path A — in-broker resume (primary)

1. When `copilot.mjs::runAppServerTurn` is called with `resumeThreadId`,
   check whether the current broker still has the session registered.
2. If yes, issue `session/prompt` on the cached `sessionId`. Full
   `session/update` streaming flows through.
3. This is the only path used while a Claude session is active and the
   broker is alive.

### Path B — CLI fallback (cross-Claude-session)

1. When path A fails (broker restarted, Claude session restarted), look up
   the most recent completed task job in `state.mjs` and read its
   `copilotSessionId` field (written by `runAppServerTurn` after
   `session/new`).
2. Spawn `copilot -p "<continue prompt>" --continue --allow-all-tools
   --add-dir <cwd>` as a detached subprocess. Copilot CLI's
   `--continue` resumes the most recent CLI session. Note: this may not be
   the exact session our plugin created earlier (if other `copilot` runs
   happened between), so we include the stored `copilotSessionId` in the
   prompt text as a recovery hint.
3. Stream the subprocess's stdout/stderr line-by-line into
   `createProgressReporter`. Phase transitions become `queued → running →
   completed` without fine-grained tool-call events.
4. Parse the final output the same way the primary path does.

The job record schema adds one new field: `copilotSessionId` (string,
optional). All other fields are preserved.

## `--effort` → model mapping

> **Superseded in v0.0.16.** Copilot CLI 1.0.11+ added a native
> `--effort=<low|medium|high|xhigh>` flag, and v0.0.16 dropped the
> `EFFORT_TO_MODEL` / `EFFORT_FALLBACK_CHAIN` translation entirely.
> `--effort` now flows verbatim to Copilot CLI; `--model` and
> `--effort` are independent (both can be passed; Copilot's runtime
> applies them without conflict). The "ignored because --model was
> passed" stderr notice was also removed. The plugin's `none` and
> `minimal` aliases still collapse to `low` at spawn time for
> codex-plugin-cc command parity.
>
> The historical mapping table below remains for context; do NOT
> reintroduce it. See `plugins/copilot/CHANGELOG.md` v0.0.16 and
> `docs/plans/2026-04-20-v08-handoff.md` for the replacement
> behavior.

Copilot CLI does not expose a per-call reasoning-effort flag. It accepts
`reasoning_effort` in `~/.copilot/config.json` only, which we refuse to
mutate (fragile under concurrent broker use). Instead, we translate
`--effort` to `--model` when the user did not pass an explicit `--model`:

| `--effort`          | Mapped `--model`           | Rationale                              |
|---------------------|----------------------------|----------------------------------------|
| `none`, `minimal`   | `claude-opus-4.6-fast`     | Fast variant for zero-reasoning calls. |
| `low`               | `claude-opus-4.6-fast`     | Same fast variant.                     |
| `medium` (default)  | `claude-sonnet-4.5`        | Good reasoning/cost balance.           |
| `high`              | `claude-opus-4.6`          | Highest standard Claude reasoning.     |
| `xhigh`             | `claude-opus-4.6`          | Copilot caps here in v1. Documented.   |

If the user passes `--model` explicitly, `--effort` is a no-op — we log a
note so the behaviour is discoverable. The mapping is documented in the
README and in the `copilot-cli-runtime` skill.

## Bundled agent definitions

Ship two Copilot agent definition files in `plugins/copilot/copilot-agents/`:

- `copilot-code-review.md` — system prompt = the review contract currently
  in `prompts/review.md`.
- `copilot-adversarial-review.md` — system prompt = the adversarial
  contract in `prompts/adversarial-review.md`.

The broker itself spawns without `--agent` to preserve broker-unity across
commands. Review and adversarial-review commands prepend the agent file's
content to the user prompt text inside `session/prompt`. Side benefit:
power users can run `copilot --agent copilot-code-review` interactively
outside Claude Code and get the same prompt contract.

Agent files are treated as single-source content: the prompt templates in
`prompts/` reference the same review and adversarial-review language. A
simple build step (or prompt-loader convention) ensures drift cannot creep
in between the two copies.

## Stop-review gate

Ports unchanged in shape: hook → `copilot-companion.mjs task "<gate prompt>"`
→ ACP prompt → parse `ALLOW:` / `BLOCK:` first line → emit hook decision.
Only swaps:

- The gate prompt template tones itself for Copilot's default Claude model
  instead of GPT-5.4.
- The helper binary renames from `codex-companion.mjs` to
  `copilot-companion.mjs`.

Enable/disable via `/copilot:setup --enable-review-gate` /
`--disable-review-gate`.

## Skills

| Codex skill            | Copilot skill            | Change scope                           |
|------------------------|--------------------------|----------------------------------------|
| `codex-cli-runtime`    | `copilot-cli-runtime`    | Swap helper name, drop `--effort` level list in favor of the model-mapping table, drop `spark` alias. |
| `codex-result-handling`| `copilot-result-handling`| Text-identical apart from `codex` → `copilot` renames. |
| `gpt-5-4-prompting`    | `copilot-prompting`      | Keep XML-block prompting framework. Rewrite model-specific antipatterns (default model is Claude 4.6, not GPT-5.4). Reference docs move from `gpt-5-4-prompting/references/*` to `copilot-prompting/references/*` with retargeted examples. |

Subagent `codex-rescue.md` → `copilot-rescue.md` with `skills:` list updated
to the renamed skills and `--model spark` alias removed.

## Auth & setup

- Authentication state is read from `~/.copilot/config.json::logged_in_users`
  (presence of at least one entry).
- `copilot-companion.mjs setup` additionally probes `copilot --acp
  initialize` (one RPC round-trip with a short timeout) to confirm ACP is
  responsive.
- Install hint: `npm install -g @github/copilot` (verify package name during
  implementation — may be `@github/copilot-cli` or different on Windows).
- `copilot login` OAuth device flow is user-driven; the plugin directs the
  user via `AskUserQuestion` when needed but does not perform the login
  itself.

## Tests

Port the test harness. The biggest lift is `fake-copilot-fixture.mjs`,
which replaces `fake-codex-fixture.mjs`. It must:

- Expose a spawnable script that accepts `--acp` and speaks ACP v1 JSON-RPC.
- Accept canned `session/new`, `session/prompt`, `session/cancel` responses
  configured per-test.
- Emit canned `session/update` notifications to exercise the variant
  mapper.
- Support the same deterministic-ordering guarantees the Codex fixture
  provides so `runtime.test.mjs` ports without reworking its expectations.

All other test files port with a codex → copilot find-and-replace plus
mapper-specific assertions in `runtime.test.mjs` where the Codex RPC names
appear.

## Deferred to v1.1

> **Items 2 and 3 shipped in v0.0.8.** Concurrent broker reuse landed
> via a workspace-scoped `broker.lock` (atomic `O_CREAT|O_EXCL`) plus
> dual-budget liveness checks for the slow-path teardown (PR #28).
> Structured-output enforcement shipped as `validateReviewOutput`
> walking `plugins/copilot/schemas/review-output.schema.json`
> end-to-end with accumulated violations rendered as a bulleted
> `Schema violations:` section (PR #29; tightened in v0.0.9 PRs
> #32–#33: PR #32 un-exported `validateReviewOutput` and simplified
> `normalizeReviewFinding` to trim-only; PR #33 aligned the
> `.trim().length === 0` whitespace check across all five
> `minLength:1` fields).
> Item 1 (custom sandboxing per ACP session) remains upstream-blocked
> on Copilot CLI exposing per-session permission flags via
> `session/new` — re-confirmed across audits 2026-04-20 / -21 / -29 /
> -30. The list below is preserved as historical context.

- Custom sandboxing per ACP session (blocked on upstream Copilot CLI).
- Concurrent broker reuse across multiple Claude sessions on the same
  workspace (codex-plugin-cc has this through per-session broker sockets;
  our port preserves the shape, but cross-session coordination on Copilot
  is untested).
- Structured-output enforcement beyond best-effort prompt contract.

## Implementation plan (order of operations)

1. Seed the repo structure (package.json, tsconfig, marketplace, plugin
   manifest, LICENSE/NOTICE).
2. Copy all reusable lib modules bytewise from codex-plugin-cc with
   provenance comments.
3. Write `lib/acp-protocol.d.ts` and `lib/acp-client.mjs` against ACP v1.
4. Port `lib/codex.mjs` → `lib/copilot.mjs`, starting with the simplest
   exports (`getCopilotAvailability`, `getCopilotAuthStatus`) and working
   up to `runAppServerTurn`, `runAppServerReview`,
   `interruptAppServerTurn`.
5. Port `scripts/app-server-broker.mjs` → `scripts/acp-broker.mjs` with
   the spawn swap and streaming-method renames.
6. Port `codex-companion.mjs` → `copilot-companion.mjs` (mechanical — just
   renames; the underlying `copilot.mjs` exports match signatures).
7. Port hooks, prompts, schemas, skills, subagent, and slash commands
   (renames + content tweaks).
8. Add `copilot-agents/` with bundled agent definitions.
9. Port tests with the new fixture.
10. Write README and CHANGELOG.
11. Run the full test suite; iterate on ACP mapper quirks surfaced by the
    fixture until green.

## Open questions for implementation time

> **All four resolved as of v0.0.5.**
> - **Q1 (npm package name):** confirmed `@github/copilot` (the README
>   install command and `/copilot:setup --probe-models` use this name).
> - **Q2 (`--acp` permission flags):** `--acp` accepts
>   `--allow-all-tools` / `--allow-all-paths` / `--allow-all-urls` at
>   spawn time. The plugin pins them in `DEFAULT_COPILOT_SPAWN_ARGS`
>   alongside `--no-ask-user`, `--secret-env-vars`, and
>   `--deny-tool=shell(<cmd>:*)` for `curl` / `wget` / `nc` / `ncat` /
>   `ssh` (v0.0.17–v0.0.18 hardenings).
> - **Q3 (per-session session ID):** `copilotSessionId` is threaded
>   through the task payload and surfaced in
>   `renderStoredJobResult`'s resume command (shipped v0.0.2 PR #3).
> - **Q4 (model-availability degradation):** originally solved by the
>   v0.0.5 `--effort` fallback chain (`isModelUnavailableStderr` regex
>   detecting availability phrases). v0.0.16 dropped the chain entirely
>   (along with `EFFORT_TO_MODEL`) when Copilot CLI 1.0.11+ added a
>   native `--effort` flag — the model-unavailable error from Copilot
>   now surfaces directly to the user with no plugin-side retry.
>
> The list below is preserved as historical context.

- Exact Copilot CLI npm package name (`@github/copilot` vs
  `@github/copilot-cli`) — verify at setup-script time.
- Whether `copilot --acp` accepts `--allow-all-tools` / `--allow-all-paths`
  flags at spawn time the same way `copilot -p` does, or whether ACP
  requires those via `clientCapabilities` during `initialize`.
- Whether the Copilot CLI exposes its per-session Copilot-side session ID
  anywhere in the ACP `session/new` response or `session/update` stream
  (needed for the cross-session resume fallback). If not exposed, Path B
  resume falls back to "most recent CLI session" semantics only.
- Model-availability check: not every Copilot account has access to every
  model in the `--effort` mapping table. Setup or the rescue path should
  degrade gracefully if a mapped model is unavailable (fall back to the
  next tier).
