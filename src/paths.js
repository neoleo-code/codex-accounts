'use strict';
/**
 * Path resolution and the trust boundary for CODEX_HOME.
 *
 * SECURITY: every path the tool writes must be proven to live *inside* the
 * resolved CODEX_HOME after symlink resolution. This is the single choke point
 * that defends against path traversal and symlink redirection (CWE-22 / CWE-59).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

function resolveCodexHome() {
  const fromEnv = process.env.CODEX_HOME;
  const base = fromEnv && fromEnv.trim() !== ''
    ? path.resolve(fromEnv)
    : path.join(os.homedir(), '.codex');
  return base;
}

function paths(home = resolveCodexHome()) {
  return {
    home,
    authFile: path.join(home, 'auth.json'),
    accountsDir: path.join(home, 'accounts'),
    registryFile: path.join(home, 'accounts', 'registry.json'),
    registryLock: path.join(home, 'accounts', '.registry.lock'),
    tmpLoginRoot: path.join(home, 'accounts', '.login-tmp'),
    snapshot(accountKey) {
      // accountKey MUST already be passed through safeName() by the caller.
      return path.join(home, 'accounts', `${accountKey}.json`);
    },
  };
}

/**
 * Assert that `target` resolves to a location strictly inside `root`.
 * Resolves symlinks on the portion of the path that already exists, so an
 * attacker cannot point accounts/foo.json at /etc/shadow via a symlink.
 * Throws on violation. Returns the realpath-normalised absolute target.
 */
function assertInside(root, target) {
  const realRoot = fs.realpathSync(root);
  const resolvedTarget = path.resolve(target);

  // Resolve the realpath of the deepest existing ancestor of target.
  let probe = resolvedTarget;
  // walk up until something exists
  // (a freshly-created snapshot file won't exist yet)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  const tail = path.relative(probe, resolvedTarget); // remaining non-existent part
  const realTarget = tail ? path.join(realProbe, tail) : realProbe;

  const rel = path.relative(realRoot, realTarget);
  if (rel === '' || rel === '.') return realTarget; // root itself
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes CODEX_HOME: ${target} -> ${realTarget} (root ${realRoot})`);
  }
  return realTarget;
}

module.exports = { resolveCodexHome, paths, assertInside };
