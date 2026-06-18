'use strict';
/**
 * login flow — import an account by running the OFFICIAL `codex login`.
 *
 * We never emulate or bypass OAuth. We run the official binary inside an
 * ISOLATED temporary CODEX_HOME so the live ~/.codex/auth.json is untouched
 * until login fully succeeds and the result is validated. Then we snapshot it
 * via the normal import path (atomic, 0600, registry under lock).
 *
 * SECURITY:
 *   - child spawned with an argv ARRAY, shell:false (no command injection).
 *   - the official tool is resolved from PATH but invoked by name only; we do
 *     not hand it our tokens — it produces its own auth.json in the temp dir.
 *   - temp dir is 0700 and removed in finally, even on failure.
 *   - bounded by a timeout so a hung login can't wedge the tool.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ensureDir } = require('./perms');
const { importAuthObject } = require('./engine');
const codex = require('./codex-format');
const { parseAuthBuffer } = require('./auth-file');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: device/OAuth needs user time

/**
 * @param {object} p           resolved paths (from engine.init)
 * @param {object} opts
 * @param {boolean} opts.device  use `codex login --device-auth`
 * @param {string}  opts.alias   alias for the new account
 * @param {string}  opts.codexBin  override binary name/path (default "codex")
 * @param {number}  opts.timeoutMs
 */
function login(p, opts = {}) {
  const {
    device = false,
    alias = null,
    codexBin = process.env.CODEX_CLI_PATH || 'codex',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    useCodex = false,
  } = opts;

  // Unique isolated login home under accounts/.login-tmp/<rand>
  ensureDir(p.tmpLoginRoot);
  const tempHome = path.join(p.tmpLoginRoot, crypto.randomBytes(8).toString('hex'));
  ensureDir(tempHome);

  try {
    const args = ['login'];
    if (device) args.push('--device-auth');

    // Run official login with CODEX_HOME pointed at the isolated dir.
    const res = spawnSync(codexBin, args, {
      stdio: 'inherit',          // let the user complete the browser/device flow
      shell: false,              // argv array only — no shell parsing
      windowsHide: true,
      timeout: timeoutMs,
      env: { ...process.env, CODEX_HOME: tempHome },
    });

    if (res.error) {
      if (res.error.code === 'ENOENT') {
        throw new Error(`official "${codexBin}" CLI not found in PATH. Install Codex CLI first, or pass --codex-bin <path>.`);
      }
      if (res.error.code === 'ETIMEDOUT') {
        throw new Error(`login timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw res.error;
    }
    if (res.status !== 0) {
      throw new Error(`official login exited with code ${res.status}`);
    }

    // The official tool writes auth.json into the isolated home.
    const producedAuth = path.join(tempHome, 'auth.json');
    if (!fs.existsSync(producedAuth)) {
      throw new Error('login finished but no auth.json was produced in the temp home');
    }
    const st = fs.lstatSync(producedAuth);
    if (st.isSymbolicLink()) throw new Error('refusing: produced auth.json is a symlink');

    const authObj = parseAuthBuffer(fs.readFileSync(producedAuth)); // size + JSON gate

    // Snapshot + registry update via the standard, locked, atomic import path.
    // Use the real Codex array-format adapter when that's what's on disk.
    return useCodex
      ? codex.upsertFromAuth(p, authObj, { alias })
      : importAuthObject(p, authObj, { alias });
  } finally {
    // Always clean up the isolated login dir.
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { login };
