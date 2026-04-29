---
description: Check whether the local Copilot CLI is ready and optionally toggle the stop-time review gate or set the default model and reasoning effort
argument-hint: '[--enable-review-gate|--disable-review-gate] [--default-model <name|alias>] [--default-effort <low|medium|high|xhigh>] [--probe-models]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If the result says Copilot is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Copilot now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Copilot (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @github/copilot
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

If Copilot is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Copilot is installed but not authenticated, preserve the guidance to run `!copilot login`.

Default model and effort:
- The setup output shows the active model line (e.g. `active model: gpt-5.5, effort xhigh [~/.copilot/settings.json]`) so users can see what every plugin command will inherit by default.
- `--default-model <name|alias>` writes a default into `~/.copilot/settings.json`'s `model` key. Aliases (`fast`, `opus`, `sonnet`, `haiku`, `gpt`, `codex`, `auto`) are resolved before persisting; concrete names like `gpt-5.5` or `claude-opus-4.7` pass through.
- `--default-effort <low|medium|high|xhigh>` writes the corresponding `effortLevel`. The plugin's `none`/`minimal` aliases collapse to `low` since Copilot's settings.json only accepts the four canonical values.
- Either flag may be passed alone or together. Existing keys in `settings.json` are preserved.
