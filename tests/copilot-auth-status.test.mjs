import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { buildCopilotEnv } from "./harness.mjs";
import { getCopilotAuthStatus } from "../plugins/copilot/scripts/lib/copilot.mjs";

// Writes `config.json` under `<configHome>/.copilot/` and returns an env
// that redirects `getCopilotAuthStatus`'s config lookup to that tempdir
// via XDG_CONFIG_HOME, while also pointing the availability probe at the
// fake-copilot fixture so it reports "installed".
function envWithCopilotConfig(contentOrNull) {
  const configHome = makeTempDir("copilot-auth-");
  if (contentOrNull !== null) {
    const copilotDir = path.join(configHome, ".copilot");
    fs.mkdirSync(copilotDir, { recursive: true });
    fs.writeFileSync(path.join(copilotDir, "config.json"), contentOrNull, "utf8");
  }
  return buildCopilotEnv({ extraEnv: { XDG_CONFIG_HOME: configHome } });
}

test("getCopilotAuthStatus reports loggedIn: true on modern (v1.0+) camelCase config with leading // comments", async () => {
  // Real Copilot CLI 1.0.36 writes this exact shape: two leading
  // JS-style comment lines, then camelCase `loggedInUsers` and
  // `lastLoggedInUser`. Pre-fix plugin read snake_case `logged_in_users`
  // from an un-comment-stripped JSON.parse and failed on both counts.
  const cwd = makeTempDir();
  const env = envWithCopilotConfig(
    [
      "// User settings belong in settings.json.",
      "// This file is managed automatically.",
      JSON.stringify(
        {
          lastLoggedInUser: { host: "https://github.com", login: "octocat" },
          loggedInUsers: [{ host: "https://github.com", login: "octocat" }]
        },
        null,
        2
      )
    ].join("\n")
  );

  const status = await getCopilotAuthStatus(cwd, { env });

  assert.equal(status.available, true);
  assert.equal(status.loggedIn, true, "must detect octocat sign-in on modern config");
  assert.match(status.detail, /Copilot login active for octocat/);
  assert.equal(status.source, "config");
});

test("getCopilotAuthStatus still handles legacy snake_case config (backward compat)", async () => {
  const cwd = makeTempDir();
  const env = envWithCopilotConfig(
    JSON.stringify({
      last_logged_in_user: { host: "https://github.com", login: "legacy-user" },
      logged_in_users: [{ host: "https://github.com", login: "legacy-user" }]
    })
  );

  const status = await getCopilotAuthStatus(cwd, { env });

  assert.equal(status.loggedIn, true);
  assert.match(status.detail, /Copilot login active for legacy-user/);
});

test("getCopilotAuthStatus returns loggedIn: false when the config lists no users", async () => {
  const cwd = makeTempDir();
  const env = envWithCopilotConfig(JSON.stringify({ loggedInUsers: [] }));

  const status = await getCopilotAuthStatus(cwd, { env });

  assert.equal(status.loggedIn, false);
  assert.match(status.detail, /no GitHub account is signed in/);
});

test("getCopilotAuthStatus returns loggedIn: false when the config file is missing entirely", async () => {
  const cwd = makeTempDir();
  const env = envWithCopilotConfig(null);

  const status = await getCopilotAuthStatus(cwd, { env });

  assert.equal(status.loggedIn, false);
});

test("getCopilotAuthStatus tolerates genuinely malformed JSON by reporting loggedIn: false rather than throwing", async () => {
  const cwd = makeTempDir();
  const env = envWithCopilotConfig("{ this is not json at all ]");

  const status = await getCopilotAuthStatus(cwd, { env });

  assert.equal(status.loggedIn, false);
});
