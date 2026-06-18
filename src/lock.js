'use strict';
/**
 * Cross-process advisory lock (defends against two `switch` commands racing
 * and corrupting auth.json / registry.json — the missing-lock risk).
 *
 * Implemented with O_CREAT|O_EXCL on a lockfile, which is atomic across
 * processes on POSIX and Windows. We store the holder pid + timestamp so a
 * stale lock from a crashed process can be detected and broken after a TTL.
 */
const fs = require('fs');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquire(lockPath, { timeoutMs = 10_000, staleMs = 60_000 } = {}) {
  const start = Date.now();
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600); // atomic create-exclusive
      fs.writeFileSync(fd, payload);
      fs.closeSync(fd);
      return { release: () => { try { fs.unlinkSync(lockPath); } catch (_) {} } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lock held — inspect for staleness.
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const stale = Date.now() - info.ts > staleMs;
        const dead = !isAlive(info.pid);
        if (stale || dead) {
          fs.unlinkSync(lockPath); // break stale lock, then retry
          continue;
        }
      } catch (_) { /* unreadable lock; treat as transient */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`could not acquire lock ${lockPath} within ${timeoutMs}ms`);
      }
      sleepMs(50);
    }
  }
}

function sleepMs(ms) {
  // synchronous sleep so callers can use a simple try/finally around the lock
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(lockPath, fn, opts) {
  const handle = acquire(lockPath, opts);
  try { return fn(); } finally { handle.release(); }
}

module.exports = { acquire, withLock };
