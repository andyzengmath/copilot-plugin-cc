import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadCopilotAgent,
  loadPromptTemplate,
  interpolateTemplate
} from "../plugins/copilot/scripts/lib/prompts.mjs";
import { makeTempDir } from "./helpers.mjs";
import { PLUGIN_ROOT } from "./harness.mjs";

function seedPromptTree({ promptName, promptBody, agents = {} }) {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(root, "copilot-agents"), { recursive: true });
  fs.writeFileSync(path.join(root, "prompts", `${promptName}.md`), promptBody);
  for (const [name, body] of Object.entries(agents)) {
    fs.writeFileSync(path.join(root, "copilot-agents", `${name}.md`), body);
  }
  return root;
}

test("loadPromptTemplate inlines {{AGENT:<name>}} and strips YAML front-matter", () => {
  const root = seedPromptTree({
    promptName: "review",
    promptBody: "{{AGENT:copilot-code-review}}\n<tail>extra</tail>\n",
    agents: {
      "copilot-code-review":
        "---\nname: copilot-code-review\ndescription: test\n---\n<role>You are the reviewer.</role>\n"
    }
  });

  const rendered = loadPromptTemplate(root, "review");

  assert.match(rendered, /<role>You are the reviewer\.<\/role>/);
  assert.match(rendered, /<tail>extra<\/tail>/);
  assert.ok(
    !rendered.includes("---"),
    `front-matter delimiters leaked into output: ${rendered}`
  );
  assert.ok(
    !rendered.includes("description: test"),
    "front-matter description key leaked into rendered prompt"
  );
});

test("loadPromptTemplate throws a clear error when a referenced agent file is missing", () => {
  const root = seedPromptTree({
    promptName: "review",
    promptBody: "{{AGENT:missing-agent}}\n"
  });

  assert.throws(
    () => loadPromptTemplate(root, "review"),
    /Copilot agent file not found: missing-agent/
  );
});

test("loadPromptTemplate leaves prompts without {{AGENT:...}} directives untouched", () => {
  const root = seedPromptTree({
    promptName: "stop-review-gate",
    promptBody: "<task>Check the turn.</task>\n{{CLAUDE_RESPONSE_BLOCK}}\n"
  });

  const rendered = loadPromptTemplate(root, "stop-review-gate");
  assert.equal(
    rendered,
    "<task>Check the turn.</task>\n{{CLAUDE_RESPONSE_BLOCK}}\n"
  );
});

test("interpolateTemplate does not touch {{AGENT:<name>}} directives (distinct regex classes)", () => {
  const raw = "before {{AGENT:copilot-code-review}} after {{TARGET_LABEL}}";
  const interpolated = interpolateTemplate(raw, { TARGET_LABEL: "HEAD~1" });
  // The include directive must survive interpolation so the loader can
  // resolve it; interpolation only touches ALL_CAPS_UNDERSCORE tokens.
  assert.match(interpolated, /\{\{AGENT:copilot-code-review\}\}/);
  assert.match(interpolated, / after HEAD~1$/);
});

test("loadCopilotAgent returns the raw agent file (including front-matter)", () => {
  const agent = loadCopilotAgent(PLUGIN_ROOT, "copilot-code-review");
  assert.match(agent, /^---\n/);
  assert.match(agent, /name: copilot-code-review/);
  assert.match(agent, /<structured_output_contract>/);
});

test("bundled review.md renders the canonical agent methodology plus runtime wrapper", () => {
  const rendered = interpolateTemplate(
    loadPromptTemplate(PLUGIN_ROOT, "review"),
    {
      TARGET_LABEL: "HEAD~1..HEAD",
      USER_FOCUS: "caching layer",
      REVIEW_COLLECTION_GUIDANCE: "Diff collected via git.",
      REVIEW_INPUT: "<diff>sample</diff>"
    }
  );

  // Methodology from the agent file.
  assert.match(rendered, /<role>[\s\S]*standard code review/);
  assert.match(rendered, /<structured_output_contract>/);
  assert.match(rendered, /<final_check>/);
  // Runtime context from the prompt wrapper.
  assert.match(rendered, /Target: HEAD~1\.\.HEAD/);
  assert.match(rendered, /User focus: caching layer/);
  assert.match(rendered, /Diff collected via git\./);
  assert.match(rendered, /<diff>sample<\/diff>/);
  // No unfilled placeholders or leaked front-matter.
  assert.ok(
    !rendered.includes("{{"),
    `expected no unfilled placeholders; got:\n${rendered}`
  );
  assert.ok(
    !rendered.startsWith("---"),
    "agent front-matter leaked into rendered prompt"
  );
});

test("bundled adversarial-review.md renders the adversarial agent methodology", () => {
  const rendered = interpolateTemplate(
    loadPromptTemplate(PLUGIN_ROOT, "adversarial-review"),
    {
      TARGET_LABEL: "HEAD",
      USER_FOCUS: "retry logic",
      REVIEW_COLLECTION_GUIDANCE: "Working tree diff.",
      REVIEW_INPUT: "<diff>payload</diff>"
    }
  );

  assert.match(rendered, /adversarial software review/);
  assert.match(rendered, /<attack_surface>/);
  assert.match(rendered, /Target: HEAD/);
  assert.match(rendered, /User focus: retry logic/);
  assert.match(rendered, /<diff>payload<\/diff>/);
  assert.ok(
    !rendered.includes("{{"),
    `expected no unfilled placeholders; got:\n${rendered}`
  );
});
