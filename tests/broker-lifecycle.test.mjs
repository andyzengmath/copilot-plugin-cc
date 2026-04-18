import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/copilot/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/copilot/scripts/lib/state.mjs";

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
