# copilot-plugin-cc — post-v0.0.8 handoff notes

**Date:** 2026-04-20
**Last shipped tag:** `v0.0.8`
**Main state:** 147 tests / 146 pass / 1 skipped / 0 fail on both `ubuntu-latest` and `windows-latest` CI.

Follow-on to [`2026-04-20-v08-handoff.md`](./2026-04-20-v08-handoff.md). Re-read that file for the full v0.0.1 → v0.0.7 history, conventions, release process, and fixture/test patterns — it's all still accurate. This file only captures what changed in the v0.0.8 cycle and the current backlog.

---

## Shipped in v0.0.8

| PR  | Theme                                                                                 |
| --- | ------------------------------------------------------------------------------------- |
| #28 | v0.8 (1/N) Concurrent broker reuse via workspace `broker.lock`; dual-budget liveness. |
| #29 | v0.8 (2/N) Full schema enforcement for review output; accumulated-violation reporting. |
| #30 | Release bump to v0.0.8.                                                               |

Closes v1.1 items 1 and 2 from the original design doc. Item 3 (per-ACP-session sandboxing) remains upstream-blocked on `copilot --acp`.

### v0.0.8 details worth remembering

**Broker coordination** — `plugins/copilot/scripts/lib/broker-lifecycle.mjs`:
- `broker.lock` via `fs.openSync(path, "wx", 0o600)` (atomic `O_CREAT|O_EXCL`). Contents: `<pid>\n<timestamp>\n`.
- Acquirers poll at 25 ms; default 5 s budget.
- Stale-lock recovery via `process.kill(pid, 0)` ESRCH check. `EPERM` treated as alive (holder is another user's process).
- Fast path (live `broker.json` + reachable endpoint) skips the lock entirely, preserving zero-overhead single-session reuse.
- **Dual-budget liveness check**: `isBrokerEndpointReady(endpoint, timeoutMs)` — fast path uses 150 ms, slow path uses 1000 ms before destructive teardown. Teardown kills a broker another client may be mid-stream with, so the slow path now demands a more generous dead signal.

**Review-output validator** — `plugins/copilot/scripts/lib/render.mjs`:
- `validateReviewOutput(data)` walks `plugins/copilot/schemas/review-output.schema.json` end-to-end and returns a list of violations.
- Renderer emits a bulleted `Schema violations:` section so every breakage surfaces in one pass, rather than short-circuiting on the first error.
- Hand-rolled (no AJV) — zero new runtime deps.
- `normalizeReviewFinding` / `normalizeReviewResultData` still carry their pre-validation defensive fallbacks. Those branches are now unreachable after validation, but left in place per surgical-changes convention. Worth a cleanup PR if anyone picks up small tidying work.

---

## Open backlog

### Blocked upstream
- **Per-ACP-session sandboxing** (was v1.1 item 3): `copilot --acp` still doesn't expose per-session permission flags. `DEFAULT_COPILOT_SPAWN_ARGS` pins `--allow-all-tools --allow-all-paths --allow-all-urls`. Track upstream Copilot CLI releases.

### Harder than the v0.8 handoff suggested
- **Windows production `--effort` on the review path.** The v0.8 handoff's recipe ("resolve `.cmd` to an absolute path, use `shell:false`") does **not** work as stated. Investigation on 2026-04-20:
  - npm-installed Copilot ships as `C:\ProgramData\global-npm\copilot.cmd` (no `.exe` counterpart — `which copilot` returns only the `.cmd`; default `PATHEXT` has `.EXE` before `.CMD`, but there's no `copilot.exe` to prefer).
  - Node's `child_process.spawn` on Windows refuses to spawn a `.bat`/`.cmd` file with `shell: false` — this is the post-CVE-2024-27980 behavior change. So absolute-path resolution alone is not enough; we'd also have to bypass that check.
  - Candidate approaches, each with real cost:
    1. Manually invoke `cmd.exe /d /s /c <abs-cmd> ...` via `spawn("cmd.exe", ["/d", "/s", "/c", abs, ...args], { shell: false })` — we'd own the quoting end-to-end. Need a robust cmd.exe argument quoter that handles XML metacharacters safely. This replicates Node's pre-CVE-fix behavior manually, and we'd be on the hook for getting the quoting right (the CVE exists because this is hard).
    2. Pipe the prompt via stdin if Copilot CLI supports it — keeps XML out of argv entirely. Needs confirmation that `copilot -p` reads stdin when the `-p` value is `-` (or similar). Worth checking upstream before investing.
    3. Write the prompt to a temp file and pass the file path via argv — only viable if the CLI grows a `--prompt-file`-style flag.
  - **Recommendation:** don't pick this up without first checking whether `copilot` CLI has any stdin or prompt-file support. Otherwise expect multi-PR scope around a Windows-specific cmd.exe quoter, including native-Windows fuzzing.
  - Not blocking for users: review via the broker (no `--effort`) works fine on Windows.

### Parking lot
- **Setup-time JSON output consumers.** `/copilot:setup --probe-models --json` emits `report.modelProbe`. Unchanged since v0.0.7; still waiting for a UI consumer to plug in.
- **Code-review follow-ups from PR #29.** All scored below our ≥80 review threshold, so they weren't flagged at PR time, but noting here for anyone doing small tidying work:
  - `normalizeReviewFinding` / `normalizeReviewResultData` contain unreachable fallback branches now that validation enforces their preconditions (`plugins/copilot/scripts/lib/render.mjs` around lines 133–170).
  - `validateReviewOutput` is `export`ed but has no external caller — could be file-local.
  - `next_steps[i]` uses `step.trim().length === 0` while `summary` / `title` / `body` / `file` use `value.length === 0`. Either both should trim or neither should; schema's `minLength: 1` technically allows `"   "` for all of them.

---

## Getting started in the next session

```bash
cd "C:/Users/andyzeng/OneDrive - Microsoft/Documents/GitHub/copilot-plugin-cc"
git fetch --all --tags
git checkout main && git pull
git log --oneline -5            # expect d22d697 (0.0.8 release bump) at HEAD
node --test tests/*.test.mjs    # expect 147 / 146 pass / 1 skipped, ~20 min on Windows
```

### Key files to re-read first
- [`docs/plans/2026-04-20-v08-handoff.md`](./2026-04-20-v08-handoff.md) — full history through v0.0.7 and the v0.8 cycle design.
- [`docs/plans/2026-04-17-copilot-plugin-cc-design.md`](./2026-04-17-copilot-plugin-cc-design.md) — original design doc.
- `plugins/copilot/CHANGELOG.md` — per-release notes (0.0.8 section covers both shipped v1.1 items).
- `plugins/copilot/scripts/lib/broker-lifecycle.mjs` — lock + dual-budget liveness.
- `plugins/copilot/scripts/lib/render.mjs` — `validateReviewOutput` + the schema-violation renderer.
- `SECURITY.md` — threat model; still reflects v0.0.7 state (broker.json mode, broker-secret env), nothing in v0.0.8 changed the threat surface.

### Suggested first steps

No v1.1-tier items remain tractable. Reasonable options for a v0.9 cycle:

- **Polish PR from the PR-#29 review follow-ups.** Small, self-contained, ships measurable tidying. Good warmup for a fresh session.
- **Upstream check on Copilot CLI.** Look for new ACP flags (per-session sandboxing) and stdin/prompt-file support (would unblock the Windows review-path work).
- **Feature work outside the v1.1 backlog.** Pick something user-facing — e.g. a new `/copilot:*` command or a reporting enhancement — once upstream checks have been done.
