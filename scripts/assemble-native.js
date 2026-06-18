#!/usr/bin/env node
'use strict';
/**
 * Lay per-target build artifacts into native/<platform>-<arch>/ so the npm
 * launcher can find them. Input: dir of dist-<target> folders. Output: native/.
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || 'artifacts';
const dst = process.argv[3] || 'native';

const TARGET_MAP = {
  'x86_64-linux': 'linux-x64',
  'aarch64-linux': 'linux-arm64',
  'x86_64-macos': 'darwin-x64',
  'aarch64-macos': 'darwin-arm64',
  'x86_64-windows': 'win32-x64',
  'aarch64-windows': 'win32-arm64',
};

for (const entry of fs.readdirSync(src)) {
  const m = entry.match(/^dist-(.+)$/);
  if (!m) continue;
  const target = m[1];
  const node = TARGET_MAP[target];
  if (!node) { console.error(`unknown target ${target}`); process.exit(1); }
  const binSrcDir = path.join(src, entry);
  const bin = fs.readdirSync(binSrcDir).find((f) => f.startsWith('codex-accounts-'));
  if (!bin) { console.error(`no binary in ${binSrcDir}`); process.exit(1); }
  const outDir = path.join(dst, node);
  fs.mkdirSync(outDir, { recursive: true });
  const exe = target.includes('windows') ? 'codex-accounts.exe' : 'codex-accounts';
  fs.copyFileSync(path.join(binSrcDir, bin), path.join(outDir, exe));
  if (process.platform !== 'win32') fs.chmodSync(path.join(outDir, exe), 0o755);
  console.log(`native/${node}/${exe}`);
}
