'use strict';
/**
 * Engine: the security-critical flows (import, switch, list, snapshot).
 * Every mutation runs under the cross-process lock and uses atomic writes.
 * This is the JS reference implementation; the Zig native CLI mirrors it.
 */
const fs = require('fs');
const path = require('path');
const { paths, assertInside } = require('./paths');
const { ensureDir, chmodFile, verifyFilePerms } = require('./perms');
const { atomicWriteFile } = require('./atomic');
const { withLock } = require('./lock');
const reg = require('./registry');
const { parseAuthBuffer, deriveIdentity, MAX_AUTH_BYTES } = require('./auth-file');
const { safeName } = require('./safe-name');

function init(home) {
  const p = paths(home);
  ensureDir(p.home);
  ensureDir(p.accountsDir);
  return p;
}

/** Write a snapshot file for an account, atomically + 0600, proven inside home. */
function writeSnapshot(p, accountKey, authObj) {
  const key = safeName(accountKey);
  const dest = p.snapshot(key);
  assertInside(p.home, dest); // traversal guard
  atomicWriteFile(dest, JSON.stringify(authObj, null, 2) + '\n', { mode0600: true });
  return dest;
}

/**
 * Import a single in-memory auth object (already size/JSON validated by caller
 * for file imports). Returns the registry entry created/updated.
 */
function importAuthObject(p, authObj, { alias = null, jwtOpts = {} } = {}) {
  const id = deriveIdentity(authObj, jwtOpts);
  return withLock(p.registryLock, () => {
    const registry = reg.load(p);
    writeSnapshot(p, id.key, authObj);
    const prev = registry.accounts[id.key] || {};
    registry.accounts[id.key] = {
      key: id.key,
      email: id.email || prev.email || null,
      alias: alias || prev.alias || null,
      user_id: id.userId || prev.user_id || null,
      account_id: id.accountId || prev.account_id || null,
      plan: id.plan || prev.plan || null,
      last_used: prev.last_used || null,
      imported_at: new Date().toISOString(),
      token_verified_structurally: id.tokenVerifiedStructurally,
      claims_error: id.claimsError,
      usage: prev.usage || null,
    };
    reg.save(p, registry);
    return { key: id.key, entry: registry.accounts[id.key], identity: id };
  });
}

function importFile(p, filePath, opts = {}) {
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) throw new Error('refusing to import a symlink');
  if (st.size > MAX_AUTH_BYTES) throw new Error('auth file too large');
  const authObj = parseAuthBuffer(fs.readFileSync(filePath));
  return importAuthObject(p, authObj, opts);
}

/**
 * Switch the active account.
 *  - resolve selector
 *  - verify snapshot exists + perms ok (no symlink, not group/world readable)
 *  - back up current auth.json
 *  - atomically replace auth.json with the snapshot
 *  - update current/previous/last_used and persist registry atomically
 * All under one lock so two switches can't interleave.
 */
function switchTo(p, selector) {
  return withLock(p.registryLock, () => {
    const registry = reg.load(p);
    const key = reg.resolve(registry, selector);
    if (!key) throw new Error(`no account matches selector: ${selector}`);
    const snap = p.snapshot(key);
    assertInside(p.home, snap);
    if (!fs.existsSync(snap)) throw new Error(`snapshot missing for ${key}`);
    const v = verifyFilePerms(snap);
    if (!v.ok) throw new Error(`snapshot ${key} has unsafe perms: ${v.reason}`);

    // Back up current auth.json (if any) to previous slot file.
    if (fs.existsSync(p.authFile)) {
      const liveBuf = fs.readFileSync(p.authFile);
      const backup = path.join(p.accountsDir, '.auth.previous.json');
      assertInside(p.home, backup);
      atomicWriteFile(backup, liveBuf, { mode0600: true });
      // SYNC-BACK: Codex rotates tokens into the live auth.json during a
      // session; persist them into the currently-active account's snapshot so
      // switching back never loads an invalidated refresh token (which would
      // force a re-login). Best-effort — never block the switch.
      if (registry.current) {
        try {
          const liveSnap = p.snapshot(registry.current);
          assertInside(p.home, liveSnap);
          atomicWriteFile(liveSnap, liveBuf, { mode0600: true });
        } catch (_) { /* keep stored snapshot */ }
      }
    }

    // Atomic replace of the live auth.json with the snapshot bytes.
    // Read AFTER sync-back so re-selecting the active account stays fresh.
    const bytes = fs.readFileSync(snap);
    assertInside(p.home, p.authFile);
    atomicWriteFile(p.authFile, bytes, { mode0600: true });

    registry.previous = registry.current;
    registry.current = key;
    registry.accounts[key].last_used = new Date().toISOString();
    reg.save(p, registry);
    return { key, entry: registry.accounts[key] };
  });
}

function list(p) {
  const registry = reg.load(p);
  const keys = Object.keys(registry.accounts);
  return keys.map((key, i) => {
    const a = registry.accounts[key];
    return {
      index: i + 1,
      key,
      email: a.email,
      alias: a.alias,
      plan: a.plan,
      team: a.team || null,
      current: registry.current === key,
      usage_5h: a.usage?.window_5h ?? null,
      usage_cycle: a.usage?.window_cycle ?? null,
      next_reset: a.usage?.next_reset ?? null,
      last_used: a.last_used,
    };
  });
}

function whoami(p) {
  const registry = reg.load(p);
  return { current: registry.current, previous: registry.previous };
}

module.exports = { init, importAuthObject, importFile, switchTo, list, whoami, writeSnapshot };
