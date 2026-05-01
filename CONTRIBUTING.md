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

```bash
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
2. The `copilot:copilot-rescue` subagent forwards to `task`, which
   spawns the shared `copilot --acp` broker, runs the ACP turn, and
   returns with stdout containing `echo hello`. The active-model line
   (`[copilot] Using model: ...`) prints to stderr first.
3. The most recent rescue session shows up in the status table with
   `status: done`, and `/copilot:result <id>` retrieves the same
   stdout.

A 30-second run catches:

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

## Status

This file documents what the maintainer has been doing informally
since v0.0.14 (the "Two bugs found during a real local install +
login on Copilot CLI 1.0.36" entry in CHANGELOG.md). Codifying it here
makes the practice visible to future-self and to anyone the
maintainer hands the plugin to.
