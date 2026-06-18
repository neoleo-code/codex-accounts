#!/usr/bin/env node
'use strict';
/**
 * Node.js launch layer.
 *
 * Responsibility (and ONLY this):
 *   1. Pick the native Zig binary for the current {platform, arch}.
 *   2. Spawn it with argv passed through UNMODIFIED, as an arg array
 *      (never a shell string — no command injection, CWE-78).
 *   3. Mirror its stdio and exit code.
 *
 * If no native binary is bundled for this platform we fall back to the pure-JS
 * reference engine so the tool is still usable from a plain `npm i`.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function nativeBinaryPath() {
  const platform = process.platform; // 'linux' | 'darwin' | 'win32'
  const arch = process.arch;         // 'x64' | 'arm64'
  const exe = platform === 'win32' ? 'codex-accounts.exe' : 'codex-accounts';
  const triple = `${platform}-${arch}`;
  const candidate = path.join(__dirname, '..', 'native', triple, exe);
  return fs.existsSync(candidate) ? candidate : null;
}

function main() {
  const argv = process.argv.slice(2);
  const bin = nativeBinaryPath();

  if (bin) {
    // SECURITY: array args, no shell. Inherit stdio. Bounded by the native
    // process's own timeouts; the launcher does not parse the credentials.
    const r = spawnSync(bin, argv, { stdio: 'inherit', shell: false, windowsHide: true });
    if (r.error) {
      process.stderr.write(`failed to launch native binary: ${r.error.message}\n`);
      process.exit(127);
    }
    process.exit(r.status === null ? 1 : r.status);
  }

  // Fallback: pure-JS reference engine.
  const { run } = require('../src/cli');
  try {
    const ret = run(argv);
    // `serve` returns a never-resolving Promise to keep the process alive
    // (the listening HTTP server holds the event loop open).
    if (ret && typeof ret.then === 'function') {
      ret.then((code) => process.exit(code || 0));
    } else {
      process.exit(ret);
    }
  } catch (err) {
    // Clean, user-facing error — never dump a stack trace or secrets.
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
