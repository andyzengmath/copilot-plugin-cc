import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeSpawn } from "../plugins/copilot/scripts/lib/safe-spawn.mjs";

const IS_WINDOWS = process.platform === "win32";

async function withTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-spawn-"));
  try {
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function spawnAndCapture(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = safeSpawn(file, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// On every platform, safeSpawn must be a transparent passthrough for the
// usual "spawn a node script" path the test suite already relies on.
test("safeSpawn forwards argv verbatim when bin is `node`", async () => {
  await withTempDir(async (dir) => {
    const script = path.join(dir, "echo-argv.mjs");
    fs.writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const result = await spawnAndCapture(process.execPath, [script, "hello", "world", "with spaces"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const argv = JSON.parse(result.stdout.trim());
    assert.deepEqual(argv, ["hello", "world", "with spaces"]);
  });
});

// The reason safeSpawn exists: cmd metacharacters in argv (parens, asterisks,
// ampersands etc.) must reach the child verbatim, even when the bin is a
// .cmd launcher on Windows. Skipped on non-Windows where there's no cmd.exe
// to interpret them.
test("safeSpawn passes cmd-metachar argv through a Windows .cmd launcher unchanged", { skip: !IS_WINDOWS }, async () => {
  await withTempDir(async (dir) => {
    const inner = path.join(dir, "echo-argv.mjs");
    fs.writeFileSync(
      inner,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n"
    );
    // Write a .cmd shim that mirrors the npm-generated Copilot launcher.
    // `%~dp0` is the directory of the .cmd; `%*` forwards argv verbatim.
    const launcher = path.join(dir, "echo-argv.cmd");
    const cmdContent = `@echo off\r\nnode.exe "%~dp0echo-argv.mjs" %*\r\n`;
    fs.writeFileSync(launcher, cmdContent);

    // The metacharacter-laden argv that broke v0.0.17's shell:true path.
    // safeSpawn's escape pipeline must survive cmd.exe parsing.
    const tricky = [
      "--deny-tool=shell(curl:*)",
      "--secret-env-vars=A,B,C",
      "plain-arg",
      "with spaces"
    ];
    const result = await spawnAndCapture(launcher, tricky);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const argv = JSON.parse(result.stdout.trim());
    assert.deepEqual(
      argv,
      tricky,
      `Windows .cmd launcher must receive metachar argv verbatim; got ${JSON.stringify(argv)}`
    );
  });
});

// Locks in the shape downstream code relies on: safeSpawn returns a
// ChildProcess with the standard stdio streams.
test("safeSpawn returns a ChildProcess with standard stdio streams", async () => {
  await withTempDir(async (dir) => {
    const script = path.join(dir, "noop.mjs");
    fs.writeFileSync(script, "process.exit(0);\n");
    const proc = safeSpawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    assert.ok(proc, "expected a ChildProcess");
    assert.ok(proc.stdout, "expected stdout stream");
    assert.ok(proc.stderr, "expected stderr stream");
    assert.equal(typeof proc.pid, "number");
    await new Promise((resolve) => proc.on("close", resolve));
  });
});
