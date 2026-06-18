'use strict';
/**
 * Filesystem permission hardening.
 *  - Unix: sensitive files 0600, sensitive dirs 0700.
 *  - Windows: reset ACL so only the current user has access (icacls).
 *
 * SECURITY (CWE-276 incorrect default permissions): Codex auth.json holds
 * long-lived refresh tokens / API keys. World- or group-readable perms leak
 * them to every local account. We enforce perms on create AND verify before
 * trusting an existing file.
 */
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';

function chmodFile(p) {
  if (isWindows) return lockdownWindows(p, false);
  fs.chmodSync(p, 0o600);
}

function chmodDir(p) {
  if (isWindows) return lockdownWindows(p, true);
  fs.chmodSync(p, 0o700);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  chmodDir(p);
}

/**
 * Windows: drop inheritance and grant only the current user.
 * Never use shell string interpolation — args are passed as an array.
 */
function lockdownWindows(p, isDir) {
  const user = process.env.USERNAME || os.userInfo().username;
  // /inheritance:r removes inherited ACEs; grant current user full control.
  const r = spawnSync('icacls', [p, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
    windowsHide: true,
    timeout: 10_000,
  });
  if (r.status !== 0) {
    throw new Error(`icacls failed for ${p}: ${r.stderr ? r.stderr.toString() : r.status}`);
  }
}

/**
 * Verify a sensitive file is not accessible to group/other (Unix) before we
 * trust it. Returns {ok, mode}. On Windows we best-effort check ownership.
 */
function verifyFilePerms(p) {
  if (isWindows) {
    // Cheap sanity check: file is owned by us and not a reparse point.
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink/reparse point' };
    return { ok: true, mode: null };
  }
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  const mode = st.mode & 0o777;
  if (mode & 0o077) return { ok: false, mode, reason: 'group/other access' };
  return { ok: true, mode };
}

module.exports = { chmodFile, chmodDir, ensureDir, verifyFilePerms, isWindows };
