'use strict';
/**
 * Engine facade.
 *
 * The tool ships two registry engines:
 *   - engine.js       — this tool's own object-format registry (reference impl)
 *   - codex-format.js — the REAL array-format registry used by an existing
 *                       Codex multi-account tool under ~/.codex
 *
 * `cli.js` and `web.js` used to branch on `useCodex` at every call site and
 * re-normalise the differing return shapes by hand. This module centralises
 * that selection and normalisation so callers depend on ONE uniform API and
 * new commands can't drift between the two engines.
 *
 * Security semantics are unchanged: every method delegates straight to the
 * underlying engine, which still runs under the cross-process lock with atomic,
 * 0600, path-checked writes.
 */
const engine = require('./engine');
const codex = require('./codex-format');

function list(p, useCodex) {
  return useCodex ? codex.list(p) : engine.list(p);
}

function whoami(p, useCodex) {
  return useCodex ? codex.whoami(p) : engine.whoami(p);
}

/**
 * Switch the active account. Returns a normalised shape for BOTH engines:
 *   { switched_to: <email|key>, account_key: <key> }
 */
function switchTo(p, useCodex, selector) {
  if (useCodex) {
    const r = codex.switchTo(p, selector);
    return { switched_to: r.email || r.account_key, account_key: r.account_key };
  }
  const r = engine.switchTo(p, selector);
  return { switched_to: r.entry.email || r.key, account_key: r.key };
}

/**
 * Insert/update an account from a produced auth.json (login/import).
 * Returns a normalised shape: { account_key, email }.
 */
function upsert(p, useCodex, authObj, opts = {}) {
  if (useCodex) {
    const r = codex.upsertFromAuth(p, authObj, opts);
    return { account_key: r.account_key, email: r.email };
  }
  const r = engine.importAuthObject(p, authObj, opts);
  return { account_key: r.key, email: r.entry?.email || null };
}

module.exports = { list, whoami, switchTo, upsert };
