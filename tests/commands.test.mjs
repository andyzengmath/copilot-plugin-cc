import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "copilot");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion + background Bash and stays review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Copilot's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  // --model and --effort must appear in the hint so users discover that
  // per-call model overrides are supported on review (regression for #54
  // — they were backend-supported but never surfaced in the hint).
  assert.match(source, /\[--model <name>\]/);
  assert.match(source, /\[--effort <none\|minimal\|low\|medium\|high\|xhigh>\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/copilot-companion\.mjs" review "\$ARGUMENTS"/);
  assert.match(source, /description:\s*"Copilot review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
});

test("adversarial-review command mirrors review structure with focus text allowed", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /\[focus \.\.\.\]/);
  assert.match(source, /\[--model <name>\]/);
  assert.match(source, /\[--effort <none\|minimal\|low\|medium\|high\|xhigh>\]/);
  assert.match(source, /description:\s*"Copilot adversarial review"/);
  assert.match(source, /uses the same review target selection as `\/copilot:review`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
  assert.match(source, /return Copilot's output verbatim to the user/i);
});

test("plugin exposes the expected command inventory", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command + subagent + runtime skill are internally consistent", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/copilot-rescue.md");
  const runtimeSkill = read("skills/copilot-cli-runtime/SKILL.md");

  // Rescue slash-command shape
  assert.match(rescue, /The final user-visible response must be Copilot's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion/);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /Continue current Copilot thread/);
  assert.match(rescue, /Start a new Copilot thread/);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Copilot companion stdout verbatim to the user/i);

  // Subagent shape
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /copilot-prompting/);
  assert.match(agent, /Return the stdout of the `copilot-companion` command exactly as-is/i);

  // Runtime skill shape
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /use the `copilot-prompting` skill to rewrite the user's request/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`/i);
  assert.match(runtimeSkill, /fast/);
  assert.match(runtimeSkill, /opus/);
  assert.match(runtimeSkill, /sonnet/);
  assert.match(runtimeSkill, /haiku/);

  // The `spark` codex alias was dropped in v0.1. Confirm it is not
  // advertised anywhere user-facing.
  assert.doesNotMatch(rescue, /\bspark\b/);
  assert.doesNotMatch(agent, /\bspark\b/);
  assert.doesNotMatch(runtimeSkill, /\bspark\b/);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/copilot-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /copilot-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /copilot-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Copilot run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Copilot was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/copilot-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/copilot-prompting/SKILL.md");
  const promptRecipes = read("skills/copilot-prompting/references/copilot-prompt-recipes.md");

  assert.match(runtimeSkill, /copilot-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /task prompts/i);
});

test("hooks wire SessionStart + SessionEnd + Stop to the plugin hook scripts", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command offers Copilot install and points users to copilot login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /--enable-review-gate\|--disable-review-gate/);
  assert.match(setup, /--default-model <name\|alias>/);
  assert.match(setup, /--default-effort <low\|medium\|high\|xhigh>/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @github\/copilot/);
  assert.match(setup, /copilot-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!copilot login/);
  assert.match(readme, /offer to install Copilot for you/i);
  assert.match(readme, /\/copilot:setup --enable-review-gate/);
  assert.match(readme, /\/copilot:setup --disable-review-gate/);
});
