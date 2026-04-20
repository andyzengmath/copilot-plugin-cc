import fs from "node:fs";
import path from "node:path";

// `{{AGENT:<name>}}` directives in a prompt template inline the body of
// `copilot-agents/<name>.md` (with its YAML front-matter stripped). The
// agent files are the canonical review methodology source: power users can
// run `copilot --agent copilot-code-review` interactively and get the same
// system prompt the plugin sends through ACP, without any drift between
// the two copies.
const AGENT_INCLUDE_RE = /\{\{AGENT:([A-Za-z0-9_-]+)\}\}/g;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  // Symmetric existence check with loadCopilotAgent so a missing prompt
  // surfaces a clear "file not found" rather than a raw Node ENOENT
  // leaking the absolute filesystem path. (Production callers always
  // pass a fixed name from a small known set, so hitting this branch
  // means a packaging or rename bug worth surfacing precisely.)
  if (!fs.existsSync(promptPath)) {
    throw new Error(
      `Prompt template not found: ${name} (expected ${promptPath}).`
    );
  }
  const template = fs.readFileSync(promptPath, "utf8");
  return resolveAgentIncludes(template, rootDir);
}

export function loadCopilotAgent(rootDir, name) {
  const agentPath = path.join(rootDir, "copilot-agents", `${name}.md`);
  if (!fs.existsSync(agentPath)) {
    throw new Error(
      `Copilot agent file not found: ${name} (expected ${agentPath}).`
    );
  }
  return fs.readFileSync(agentPath, "utf8");
}

function resolveAgentIncludes(template, rootDir) {
  const resolved = template.replace(AGENT_INCLUDE_RE, (_, agentName) => {
    const raw = loadCopilotAgent(rootDir, agentName);
    return stripFrontmatter(raw).trim();
  });
  // The resolver runs a single pass on purpose — recursive includes
  // would let a malformed agent file silently chain into an unbounded
  // expansion. If an inlined agent body itself contains a leftover
  // `{{AGENT:<name>}}` directive (e.g. a typo or a stray reference),
  // it would otherwise be passed through to the model as literal text.
  // Surface it as an error instead.
  const stray = resolved.match(AGENT_INCLUDE_RE);
  if (stray) {
    throw new Error(
      `Nested {{AGENT:...}} directive in resolved prompt: ${stray[0]}. ` +
        "Agent files must not include other agents — keep them flat."
    );
  }
  return resolved;
}

function stripFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  return match ? content.slice(match[0].length) : content;
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
