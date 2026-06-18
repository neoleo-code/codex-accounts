'use strict';
/**
 * Atomic file replacement (defends against torn writes / TOCTOU on the
 * critical auth.json and registry.json).
 *
 * Write to a temp file in the SAME directory (so rename is atomic on the same
 * filesystem), fsync it, set perms BEFORE it is visible at the final path,
 * then rename over the destination. A crash leaves either the old or the new
 * file intact, never a half-written one.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chmodFile } = require('./perms');

function atomicWriteFile(destPath, data, { mode0600 = true } = {}) {
  const dir = path.dirname(destPath);
  const tmp = path.join(dir, `.${path.basename(destPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode0600 ? 0o600 : 0o644); // wx => fail if exists
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (mode0600) chmodFile(tmp); // enforce ACL/0600 while still at temp name
  fs.renameSync(tmp, destPath); // atomic within same dir
  // fsync the directory so the rename is durable
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (_) { /* directory fsync not supported on all platforms */ }
}

module.exports = { atomicWriteFile };
