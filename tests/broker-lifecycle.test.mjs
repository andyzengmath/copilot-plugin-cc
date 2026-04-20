import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { buildCopilotEnv } from "./harness.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown
} from "../plugins/copilot/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/copilot/scripts/lib/state.mjs";
import { terminateProcessTree } from "../plugins/copilot/scripts/lib/process.mjs";

const isPosix = process.platform !== "win32";

function withPluginDataEnv(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dir = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    return fn(dir);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("saveBrokerSession persists the secret so loadBrokerSession round-trips", () => {
  withPluginDataEnv(() => {
    const workspace = makeTempDir();
    const session = {
      endpoint: "unix:/tmp/test-endpoint.sock",
      pidFile: "/tmp/test.pid",
      logFile: "/tmp/test.log",
      sessionDir: "/tmp/test-session",
      pid: 1234,
      secret: "deadbeef".repeat(8)
    };
    saveBrokerSession(workspace, session);
    const loaded = loadBrokerSession(workspace);
    assert.equal(loaded.secret, session.secret);
    assert.equal(loaded.endpoint, session.endpoint);
  });
});

test("saveBrokerSession writes broker.json with mode 0600 on POSIX", { skip: !isPosix }, () => {
  withPluginDataEnv(() => {
    const workspace = makeTempDir();
    saveBrokerSession(workspace, {
      endpoint: "unix:/tmp/mode-check.sock",
      secret: "a".repeat(64)
    });
    const stateFile = path.join(resolveStateDir(workspace), "broker.json");
    const stat = fs.statSync(stateFile);
    // eslint-disable-next-line no-bitwise
    const perms = stat.mode & 0o777;
    assert.equal(
      perms.toString(8),
      "600",
      `expected broker.json mode 0600, got ${perms.toString(8)}`
    );
  });
});

test("saveBrokerSession does not throw when chmodSync fails (Windows path)", () => {
  withPluginDataEnv(() => {
    const workspace = makeTempDir();
    const originalChmod = fs.chmodSync;
    fs.chmodSync = () => {
      throw new Error("EPERM: simulated Windows failure");
    };
    try {
      assert.doesNotThrow(() => {
        saveBrokerSession(workspace, {
          endpoint: "unix:/tmp/x.sock",
          secret: "abc"
        });
      });
    } finally {
      fs.chmodSync = originalChmod;
    }
  });
});

async function withAsyncPluginDataEnv(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginData = makeTempDir();
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    return await fn(pluginData);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

async function shutdownBrokers(sessions) {
  const seen = new Set();
  for (const session of sessions.filter(Boolean)) {
    if (!session.endpoint || seen.has(session.endpoint)) continue;
    seen.add(session.endpoint);
    try {
      await sendBrokerShutdown(session.endpoint, { secret: session.secret });
    } catch {
      // Best-effort cleanup — a test assertion failure should surface, not the
      // teardown side-effect.
    }
  }
}

test("concurrent ensureBrokerSession calls share a single broker", async () => {
  await withAsyncPluginDataEnv(async (pluginData) => {
    const workspace = makeTempDir();
    const spawnLog = path.join(pluginData, "copilot-spawn.log");
    const env = buildCopilotEnv({ pluginData, spawnLog });

    const [sessionA, sessionB] = await Promise.all([
      ensureBrokerSession(workspace, { env, killProcess: terminateProcessTree }),
      ensureBrokerSession(workspace, { env, killProcess: terminateProcessTree })
    ]);

    try {
      assert.ok(sessionA, "first ensureBrokerSession call must return a session");
      assert.ok(sessionB, "second ensureBrokerSession call must return a session");
      assert.equal(
        sessionA.endpoint,
        sessionB.endpoint,
        "concurrent callers must share one broker endpoint"
      );
      assert.equal(
        sessionA.secret,
        sessionB.secret,
        "concurrent callers must share one broker secret"
      );

      const spawnLines = fs.existsSync(spawnLog)
        ? fs
            .readFileSync(spawnLog, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line))
        : [];
      const acpSpawns = spawnLines.filter((entry) =>
        Array.isArray(entry.argv) && entry.argv.includes("--acp")
      );
      assert.equal(
        acpSpawns.length,
        1,
        `expected exactly one copilot --acp spawn, got ${acpSpawns.length}: ${JSON.stringify(spawnLines, null, 2)}`
      );

      const persisted = loadBrokerSession(workspace);
      assert.ok(persisted, "broker.json must be persisted after ensureBrokerSession");
      assert.equal(persisted.endpoint, sessionA.endpoint);
      assert.equal(persisted.secret, sessionA.secret);
    } finally {
      await shutdownBrokers([sessionA, sessionB]);
    }
  });
});

test("ensureBrokerSession is reentrant when a live broker exists", async () => {
  await withAsyncPluginDataEnv(async (pluginData) => {
    const workspace = makeTempDir();
    const spawnLog = path.join(pluginData, "copilot-spawn.log");
    const env = buildCopilotEnv({ pluginData, spawnLog });

    const first = await ensureBrokerSession(workspace, {
      env,
      killProcess: terminateProcessTree
    });
    const second = await ensureBrokerSession(workspace, {
      env,
      killProcess: terminateProcessTree
    });

    try {
      assert.ok(first, "first call must succeed");
      assert.ok(second, "second call must reuse the live broker");
      assert.equal(first.endpoint, second.endpoint);
      assert.equal(first.secret, second.secret);

      const spawnLines = fs.existsSync(spawnLog)
        ? fs
            .readFileSync(spawnLog, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
        : [];
      assert.equal(
        spawnLines.length,
        1,
        "reuse must not spawn a second copilot --acp"
      );
    } finally {
      await shutdownBrokers([first, second]);
    }
  });
});
