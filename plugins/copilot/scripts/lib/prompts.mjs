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
  return template.replace(AGENT_INCLUDE_RE, (_, agentName) => {
    const raw = loadCopilotAgent(rootDir, agentName);
    return stripFrontmatter(raw).trim();
  });
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
