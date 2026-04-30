/**
 * Drop-in replacement for `child_process.spawn` that handles Windows .cmd/.bat
 * launchers correctly without using `shell: true`.
 *
 * Why this exists:
 * - Node 18.20+/20.18.1+/22.x's CVE-2024-27980 mitigation refuses to spawn
 *   `.cmd`/`.bat` files with `shell: false` (errors EINVAL). The documented
 *   workaround is `shell: true`, but that hands the joined command line to
 *   `cmd.exe /d /s /c "<bin> <args>"` *without escaping* — any `(`, `)`, `*`,
 *   `&`, `|` etc. in argv (e.g. `--deny-tool=shell(curl:*)`) gets parsed by
 *   cmd.exe as syntax. Node 24 also added DEP0190 deprecation warning to
 *   shell:true with non-empty args.
 * - The plugin previously worked around this with a hand-rolled shell-metachar
 *   deny-list (`SHELL_METACHAR_RE` / `assertNoShellMetachars`), which is
 *   incomplete (doesn't cover `(`, `)`, `*`) and is itself a maintenance burden.
 *
 * Approach (modeled on cross-spawn's parseNonShell):
 * - On non-Windows: pass through to `child_process.spawn` unchanged.
 * - On Windows, if `bin` resolves via PATHEXT to a `.exe`/`.com`: spawn directly
 *   with `shell: false`. Argv goes through CreateProcess verbatim — no shell.
 * - Otherwise (`.cmd`, `.bat`, or anything else needing the shell): pre-resolve
 *   the file ourselves, build `cmd.exe /d /s /c "<escaped-cmd> <escaped-args>"`,
 *   spawn with `shell: false` + `windowsVerbatimArguments: true`. Args are
 *   escaped with the cross-spawn algorithm: backslash-double the quotes,
 *   wrap in `"..."`, then caret-escape every cmd metachar. cmd-shims under
 *   `node_modules/.bin` get a second escape pass (the BatBadBut mitigation).
 *
 * @see https://github.com/moxystudio/node-cross-spawn/blob/master/lib/parse.js
 * @see https://nvd.nist.gov/vuln/detail/CVE-2024-27980
 * @see https://flatt.tech/research/posts/batbadbut-you-cant-securely-execute-commands-on-windows/
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IS_WINDOWS = process.platform === "win32";
const EXECUTABLE_RE = /\.(?:com|exe)$/i;
const CMD_SHIM_RE = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;
// cmd.exe metacharacters that need caret-escaping when not inside quotes.
// Matches cross-spawn's escape.js exactly.
const CMD_METACHAR_RE = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(command) {
  // Caret-escape every metachar so cmd.exe treats it literally.
  return command.replace(CMD_METACHAR_RE, "^$1");
}

function escapeArgument(arg, doubleEscapeMetaChars) {
  // 1. Double up trailing backslashes so they don't escape the closing quote.
  // 2. Backslash-double any embedded `"` and the trailing run of backslashes.
  // 3. Wrap in `"..."` so spaces / parens are protected from cmd.exe parsing.
  // 4. Caret-escape every metachar in the resulting quoted string.
  // 5. cmd-shim path (`node_modules/.bin/*.cmd`): second caret-escape pass to
  //    survive the shim's own re-parse (BatBadBut mitigation).
  let escaped = String(arg);
  escaped = escaped.replace(/(\\*)"/g, `$1$1\\"`);
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_METACHAR_RE, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(CMD_METACHAR_RE, "^$1");
  }
  return escaped;
}

function resolveWindowsCommand(file, env) {
  // If `file` is absolute or has a clear directory separator, trust it.
  // Otherwise walk PATH × PATHEXT to find the first match.
  if (path.isAbsolute(file) || file.includes("/") || file.includes("\\")) {
    return file;
  }
  const pathDirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  // Default PATHEXT is `.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC`.
  // We only care about the entries Node can actually spawn or that resolve via
  // the cmd.exe shell — `.exe`, `.com`, `.cmd`, `.bat`. Plus the empty string
  // so files passed with explicit extension still resolve.
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  // Always check the literal name first (handles user passing `copilot.cmd`).
  const candidates = ["", ...exts];
  for (const dir of pathDirs) {
    for (const ext of candidates) {
      const candidate = path.join(dir, `${file}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not found at this candidate; keep walking.
      }
    }
  }
  return file;
}

export function safeSpawn(file, args = [], options = {}) {
  if (!IS_WINDOWS) {
    return nodeSpawn(file, args, { ...options, shell: false });
  }

  const env = options.env ?? process.env;
  const resolved = resolveWindowsCommand(file, env);
  const needsShell = !EXECUTABLE_RE.test(resolved);

  if (!needsShell) {
    // .com / .exe — CreateProcess can spawn it directly. shell:false bypasses
    // CVE-2024-27980 (only .cmd/.bat are gated) and avoids cmd.exe entirely,
    // so argv reaches the child verbatim with no metachar parsing.
    return nodeSpawn(resolved, args, { ...options, shell: false });
  }

  // .cmd / .bat / shebang script — must route through cmd.exe. Pre-build the
  // command string with cross-spawn's escaping, then spawn cmd.exe directly
  // with windowsVerbatimArguments so Node doesn't add its own quoting on top.
  const doubleEscape = CMD_SHIM_RE.test(resolved);
  const escapedCommand = escapeCommand(path.normalize(resolved));
  const escapedArgs = args.map((arg) => escapeArgument(arg, doubleEscape));
  const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
  const cmdArgs = ["/d", "/s", "/c", `"${shellCommand}"`];
  const cmdBin = env.comspec || env.ComSpec || "cmd.exe";
  return nodeSpawn(cmdBin, cmdArgs, {
    ...options,
    shell: false,
    windowsVerbatimArguments: true
  });
}
