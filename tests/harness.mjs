import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, "..");
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "copilot");
export const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "copilot-companion.mjs");
export const FAKE_COPILOT_PATH = path.join(TESTS_DIR, "fake-copilot.mjs");

/**
 * Build an env dict that points the plugin at the fake-copilot subprocess.
 * Every test should call this to get a clean env that doesn't reuse
 * broker state from previous tests (via CLAUDE_PLUGIN_DATA per-test dir).
 *
 * @param {object} [opts]
 * @param {object|null} [opts.script]        JSON payload for FAKE_COPILOT_SCRIPT.
 * @param {string|null} [opts.sessionId]     Sets COPILOT_COMPANION_SESSION_ID.
 * @param {string|null} [opts.pluginData]    Sets CLAUDE_PLUGIN_DATA (usually a fresh makeTempDir()).
 * @param {object}      [opts.extraEnv]      Extra env vars to merge in last.
 */
export function buildCopilotEnv(opts = {}) {
  const env = {
    ...process.env,
    COPILOT_COMPANION_COPILOT_COMMAND: JSON.stringify(["node", FAKE_COPILOT_PATH])
  };
  if (opts.script) {
    env.FAKE_COPILOT_SCRIPT = JSON.stringify(opts.script);
  }
  if (opts.sessionId) {
    env.COPILOT_COMPANION_SESSION_ID = opts.sessionId;
  }
  if (opts.pluginData) {
    env.CLAUDE_PLUGIN_DATA = opts.pluginData;
  }
  return { ...env, ...(opts.extraEnv ?? {}) };
}

/**
 * Create a workspace + plugin-data directory pair and optionally seed a
 * minimal git repo with a README. Returns {workspace, pluginData}.
 */
export function makeIsolatedWorkspace({ initGit = false, seedFile = null } = {}) {
  const workspace = makeTempDir();
  const pluginData = makeTempDir();
  if (seedFile) {
    fs.writeFileSync(path.join(workspace, seedFile.name), seedFile.content);
  }
  if (initGit) {
    // Tests that need git should call initGitRepo + commit separately.
  }
  return { workspace, pluginData };
}
