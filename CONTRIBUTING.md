# Contributing

This is a personal/team plugin (single maintainer), not an open-source
community project. The notes here capture maintainer practices that
have been useful in keeping the plugin honest with itself.

## Pre-release smoke test

Before tagging a new release (`git tag -a v0.0.X ...`), run these three
commands against a real Copilot install. **CI alone is insufficient**
because it runs against a fake Copilot binary (`tests/fake-copilot.mjs`)
and never touches real auth, real model IDs, or the real spawn path —
so a stale alias, a broken broker spawn on Windows, or an upstream
ACP-version drift can ship green.

```text
# 1. Install + auth + probe
/copilot:setup --probe-models

# 2. End-to-end broker spawn + ACP turn
/copilot:rescue "echo hello"

# 3. Verify state read
/copilot:status
```

Expected:

1. `auth: Copilot login active for <username>`, `copilot: <version>; ACP v<N> runtime available`, and the model probe
   lists each common model as `ok` (or names the unavailable ones
   explicitly via `isModelUnavailableStderr`). The active-model line
   shows the inherited default (model + effort + source).
   Note: `claude-opus-4.6-fast` may show as `unavailable` on accounts
   that don't have the corresponding Copilot tier — that is expected
   behavior, not a regression. The probe surfaces the unavailability
   correctly via `isModelUnavailableStderr`.
2. The `copilot:copilot-rescue` subagent forwards to `task`, which
   spawns the shared `copilot --acp` broker, runs the ACP turn, and
   returns with stdout containing `echo hello`. The active-model line
   (`[copilot] Using model: ...`) prints to stderr first.
3. The most recent rescue session shows up in the status table with
   `status: done`, and `/copilot:result <id>` retrieves the same
   stdout.

A smoke-test run (typically under 2 minutes — the broker spawn dominates: each one-shot `copilot -p` invocation is ~33s cold-start on real Copilot CLI 1.0.40, and the rescue-path warm-broker turn was ~48s in the v0.0.20 dogfood) catches:

- **Stale model aliases** — the alias resolves on the plugin side but
  the underlying model errors out at spawn (the v0.0.20 `gpt-5.5` bump
  and prior `gpt-5.4` / `gpt-5.2` bumps would all surface here before
  release).
- **Broken broker spawn** — named-pipe EACCES on Windows, missing
  PATHEXT resolution, `--deny-tool` denial firing on a command that
  should be allowed, or the safe-spawn helper failing on a new
  `.cmd`/`.bat` launcher shape.
- **ACP version drift** — the `initialize` handshake's
  `ACP_PROTOCOL_VERSION` no longer matching upstream.
- **Broken state-read paths** — `resolveStateDir`, `broker.lock`,
  `jobs/*.json` round-trip, or `renderStoredJobResult` regressions.

If any step regresses, that is a real bug — file it (or fix it) before
tagging.

## Release recipe

The full bump-version → PR → merge → tag → `gh release create` flow
lives in
[`docs/plans/2026-04-20-v08-handoff.md`](docs/plans/2026-04-20-v08-handoff.md)
under "Release process" — that is the authoritative source. The
smoke test above is a precondition; the release recipe is the
procedure once the precondition passes.

## Upstream re-audit cadence

See
[`docs/plans/2026-04-20-v08-handoff.md`](docs/plans/2026-04-20-v08-handoff.md)
"Re-audit cadence" for the triggers (npm minor/major bump on
`@github/copilot`, or a new top-of-family model in the
[supported-models doc](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
above any current `MODEL_ALIASES` slot). The audit produces a new
`## Upstream audit findings (YYYY-MM-DD, CLI X.Y.Z)` section appended
to the handoff.

## Doc-vs-code audit ritual

This complements the upstream re-audit cadence above: where that
audit checks for *upstream Copilot CLI* drift, this audit checks for
drift between this plugin's own docs and its own implementation.

**When to run:** before tagging a release where 5+ PRs have merged
since the last audit, OR ad-hoc when a maintainer suspects doc/code
divergence (e.g., after a refactor that touched user-visible strings
— display labels, command flags, model aliases).

**Pattern:** dispatch 4 lens-scoped agents in parallel via the Task
tool. Each agent compares one slice of the doc surface against the
implementation and returns HIGH/MEDIUM/LOW findings with `file:line`
citations. The maintainer verifies each citation before bundling and
ships a single hygiene PR.

**The 4 lenses:**

- **L1: Original design doc ↔ current implementation** —
  `docs/plans/2026-04-17-copilot-plugin-cc-design.md` cross-checked
  against `plugins/copilot/scripts/lib/*.mjs`.
- **L2: Handoff doc ↔ current reality** —
  `docs/plans/2026-04-20-v08-handoff.md` for stale facts (test counts,
  version refs, file paths, untagged-PR follow-ups).
- **L3: User-facing docs ↔ command behavior** — `README.md`,
  `plugins/copilot/skills/**/SKILL.md`, `plugins/copilot/commands/*.md`,
  `plugins/copilot/agents/*.md`,
  `plugins/copilot/copilot-agents/*.md`,
  `plugins/copilot/prompts/*.md` ↔
  `plugins/copilot/scripts/copilot-companion.mjs` flag handlers +
  `MODEL_ALIASES`.
- **L4: Project-level docs/configs ↔ implementation** — `SECURITY.md`,
  this file, `plugins/copilot/CHANGELOG.md`, `package.json`, plugin
  manifests ↔ recent PRs and source.

**What each agent's prompt MUST explicitly ask for** (narrow prompts
miss whole flavors of staleness — the lesson is captured in the
maintainer's `feedback_audit_prompt_scope_determines_findings.md`
memory entry):

1. Stale facts (current claim X vs current code Y).
2. **Described-but-never-shipped architecture** — sections describing
   in present tense an implementation path that was never built. Tell
   the agent to verify each described path exists in code via
   `git grep` before treating it as alive.
3. **Stale prose adjacent to supersession callouts** — prose the
   callout makes historical-by-implication but doesn't explicitly
   frame.
4. **Internal contradictions** — sections that contradict each other
   within the same doc.
5. **Stale function/symbol citations** — every cited identifier should
   grep clean against current code.

Per-finding output format: HIGH/MEDIUM/LOW with `file:line`, quoted
stale text under 100 chars, contradicting reality, suggested minimal
fix.

**Verify before bundling:** read each cited line in the source file
before adding to the bundle. Agents are mostly trustworthy but can
hallucinate line numbers or misquote.

**Bundle workflow:** branch `docs/post-vX.Y.Z-audit-bundle-N` (where
N is the audit pass number); single commit; PR body lists HIGH / MED /
LOW findings as a table; references prior audit PRs.

**Past audits** (canonical record of audit-bundle PRs and their deferred-finding follow-ups; for full release history including handoff-bookkeeping PRs see the handoff doc's `### Post-v0.0.21 hygiene (untagged)` block):

- **PR #88** (`c513f33`, 2026-05-01) — first pass: tier 1-5 hygiene
  fixes across user-facing docs + supersession callouts.
- **PR #89** (`b3891f8`, 2026-05-01) — second pass: design-doc
  spawn-flags block → 11-arg canonical set; LOC-sizing callout;
  `formatActiveModelLine` fallback `claude-sonnet-4.5` →
  `claude-sonnet-4.6` (paired test update); `commands/status.md`
  `[--json]` hint; `CONTRIBUTING.md` fence `bash` → `text`.
- **PR #90** (`ad426be`, 2026-05-01) — single deferred follow-up from
  #89: `acp-client.mjs:9` file-header docstring refresh.
- **PR #91** (`6c0440f`, 2026-05-02) — third pass: Path B descoped
  marker; `--effort → model` prose historical framing;
  `safe-spawn.mjs` added to design-doc layout; handoff
  post-v0.0.21 hygiene block.
- **PR #93** (`aedfe20`, 2026-05-02) — fourth pass (this recipe's
  first user): 7 dead exports purged; `--prompt-file` flag added
  to `printUsage` + try/catch wrapped. Net -44 LOC. Deferred 4
  HIGH findings to subsequent passes.
- **PR #95** (`8ad0310`, 2026-05-02) — closes Team C HIGH #1 from
  #93's meta-review: probe-timeout test + `hangModels` fixture.
- **PR #96** (`172d6b2`, 2026-05-02) — closes Team D HIGH H1 +
  MEDIUM M1 from #93's meta-review: design-doc `### task`
  subcommand section + `task-worker` / `task-resume-candidate`
  callouts.
- **PR #97** (`4c1dbcf`, 2026-05-02) — closes Team C HIGH #2 from
  #93's meta-review: 4 setup-config flag e2e tests.

Audit-prompt scope is a compounding asset: each pass that surfaces a
new question class should update the
`feedback_audit_prompt_scope_determines_findings.md` memory entry so
the next pass starts from the broader prompt baseline, not the
narrower one.

## Status

This file documents what the maintainer has been doing informally
since v0.0.14 (the "Two bugs found during a real local install +
login on Copilot CLI 1.0.36" entry in CHANGELOG.md). Codifying it here
makes the practice visible to future-self and to anyone the
maintainer hands the plugin to.
