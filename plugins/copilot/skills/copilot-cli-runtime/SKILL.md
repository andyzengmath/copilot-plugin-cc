---
name: copilot-cli-runtime
description: Internal helper contract for calling the copilot-companion runtime from Claude Code
user-invocable: false
---

# Copilot Runtime

Use this skill only inside the `copilot:copilot-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Copilot CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `copilot:copilot-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `copilot-prompting` skill to rewrite the user's request into a tighter Copilot prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Default to a write-capable Copilot run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` unchanged. Accepted aliases: `fast` → `claude-opus-4.6-fast`, `opus` → `claude-opus-4.7`, `sonnet` → `claude-sonnet-4.6`, `haiku` → `claude-haiku-4.5`, `gpt` → `gpt-5.5`, `codex` → `gpt-5.3-codex`, `auto` → Copilot's auto-model selection (GA 2026-04-17). Any concrete Copilot model name works too; it passes through unchanged.
- If the forwarded request includes `--effort`, pass it through to `task`. Copilot CLI 1.0.11+ has a native `--effort=<low|medium|high|xhigh>` flag — the companion forwards it verbatim. The plugin's `none`/`minimal` aliases collapse to `low` at spawn time for codex-plugin-cc command parity.
- `--model` and `--effort` are independent. Pass either or both; Copilot's runtime applies them without conflict. (Pre-v0.0.16 the plugin internally mapped effort to a Claude model tier and emitted a "ignored because --model was passed" stderr notice when both were set — that mapping was removed in v0.0.16.)
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. Within a single Claude session the companion reuses the cached Copilot session ID over ACP. Across Claude sessions it falls back to `copilot -p --continue`, which means streaming progress degrades to coarse phase transitions.

Safety rules:
- Default to write-capable Copilot work in `copilot:copilot-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Copilot cannot be invoked, return nothing.
