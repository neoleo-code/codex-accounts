#!/usr/bin/env node
'use strict';
/**
 * CI gate: verify every staged binary against its SHA256SUMS file before we
 * publish. Fails closed (non-zero exit) on any mismatch or missing checksum.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

function main() {
  const root = process.argv[2] || 'artifacts';
  const sumFiles = walk(root).filter((f) => path.basename(f).startsWith('SHA256SUMS'));
  if (sumFiles.length === 0) { console.error('no SHA256SUMS files found'); process.exit(1); }
  let checked = 0;
  for (const sf of sumFiles) {
    const dir = path.dirname(sf);
    for (const line of fs.readFileSync(sf, 'utf8').split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (!m) continue;
      const [, want, name] = m;
      const target = path.join(dir, name);
      if (!fs.existsSync(target)) { console.error(`missing: ${target}`); process.exit(1); }
      const got = sha256(target);
      if (got !== want) { console.error(`MISMATCH ${name}: want ${want} got ${got}`); process.exit(1); }
      checked++;
      console.log(`ok ${name} ${got.slice(0, 12)}…`);
    }
  }
  console.log(`verified ${checked} binaries`);
}
main();
