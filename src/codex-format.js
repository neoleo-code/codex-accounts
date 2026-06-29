'use strict';
/**
 * Adapter for the REAL on-disk format already used under ~/.codex by an
 * existing Codex multi-account tool:
 *
 *   registry.json:
 *     { schema_version: 3,
 *       active_account_key: "user-XXX::<uuid>",
 *       active_account_activated_at_ms: <ms>,
 *       auto_switch: {...}, api: {...},
 *       accounts: [ { account_key, chatgpt_account_id, chatgpt_user_id,
 *                     email, alias, plan, ... }, ... ] }
 *
 *   snapshots:  accounts/<chatgpt_account_id>.json   (full Codex auth.json)
 *   backups:    accounts/auth.json.bak.<YYYYMMDD-HHMMSS>
 *
 * This adapter round-trips the ENTIRE registry object (preserving unknown
 * fields like auto_switch/api/last_usage) and only mutates what a switch /
 * login must change. It never adds foreign fields. All writes are atomic,
 * 0600, under the cross-process lock, and proven inside CODEX_HOME.
 */
const fs = require('fs');
const path = require('path');
const { assertInside } = require('./paths');
const { atomicWriteFile } = require('./atomic');
const { verifyFilePerms } = require('./perms');
const { withLock } = require('./lock');
const { validateClaims } = require('./jwt');

const ID_RE = /^[A-Za-z0-9._-]+$/; // chatgpt_account_id must look like a plain id

/** True if the registry on disk is the array-based real Codex format. */
function isCodexArrayFormat(p) {
  if (!fs.existsSync(p.registryFile)) return false;
  try {
    const o = JSON.parse(fs.readFileSync(p.registryFile, 'utf8'));
    return Array.isArray(o.accounts) || typeof o.schema_version === 'number';
  } catch (_) { return false; }
}

function load(p) {
  const o = JSON.parse(fs.readFileSync(p.registryFile, 'utf8'));
  if (!Array.isArray(o.accounts)) o.accounts = [];
  // Strip the foreign "schema" key our earlier object-format tool may have
  // appended, so saving restores the registry to its original shape.
  if ('schema' in o && typeof o.schema_version === 'number') delete o.schema;
  return o;
}

function save(p, obj) {
  assertInside(p.home, p.registryFile);
  atomicWriteFile(p.registryFile, JSON.stringify(obj, null, 2) + '\n', { mode0600: true });
}

function snapshotPath(p, accountId) {
  if (!ID_RE.test(String(accountId))) throw new Error(`unsafe account id: ${accountId}`);
  const dest = path.join(p.accountsDir, `${accountId}.json`);
  return assertInside(p.home, dest);
}

/** Resolve selector → account object. index is 1-based over the array order. */
function resolve(obj, selector) {
  const list = obj.accounts;
  if (/^[0-9]+$/.test(selector)) {
    const i = parseInt(selector, 10) - 1;
    if (i >= 0 && i < list.length) return list[i];
  }
  return list.find((a) =>
    a.account_key === selector ||
    a.chatgpt_account_id === selector ||
    a.chatgpt_user_id === selector ||
    (a.email && a.email === selector) ||
    (a.alias && a.alias !== '' && a.alias === selector)) || null;
}

function list(p) {
  const obj = load(p);
  // Live, local-only snapshot from Codex rollout logs (reflects the most
  // recent request → the currently active account). No network, no token read.
  let live = null;
  try { live = require('./usage-local').latestSnapshot(p.home); } catch (_) {}

  return obj.accounts.map((a, i) => {
    const current = a.account_key === obj.active_account_key;
    const row = {
      index: i + 1,
      email: a.email || null,
      alias: a.alias || null,
      plan: a.plan || a.last_usage?.plan_type || null,
      account_name: a.account_name || null,
      current,
      account_key: a.account_key,
    };
    if (current && live) {
      // Fresh, accurate values for the account you're actually using.
      row.usage_5h_percent = live.primary ? live.primary.used_percent : null;
      row.usage_weekly_percent = live.secondary ? live.secondary.used_percent : null;
      row.next_reset = live.primary && live.primary.resets_at_ms
        ? new Date(live.primary.resets_at_ms).toISOString() : null;
      row.usage_as_of_ms = live.recorded_at_ms;
      row.usage_source = 'rollout';          // local Codex logs
      row.usage_window_reset = !!(live.primary && live.primary.reset);
    } else {
      // Cached value the other tool last wrote; mark with its own timestamp.
      row.usage_5h_percent = a.last_usage?.primary?.used_percent ?? null;
      row.usage_weekly_percent = a.last_usage?.secondary?.used_percent ?? null;
      row.next_reset = a.last_usage?.primary?.resets_at
        ? new Date(a.last_usage.primary.resets_at * 1000).toISOString() : null;
      row.usage_as_of_ms = a.last_usage_at ? a.last_usage_at * 1000 : null;
      row.usage_source = 'cached';
    }
    return row;
  });
}

function whoami(p) {
  const obj = load(p);
  const active = obj.accounts.find((a) => a.account_key === obj.active_account_key) || null;
  return { active_account_key: obj.active_account_key || null,
    email: active ? active.email : null };
}

function tsStamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

/**
 * Switch active account: verify snapshot, back up current auth.json (matching
 * the existing auth.json.bak.<ts> convention), atomically copy snapshot ->
 * auth.json, update active_account_key + activated_at + that account's
 * last_used_at, save registry. All under one lock.
 */
function switchTo(p, selector) {
  return withLock(p.registryLock, () => {
    const obj = load(p);
    const acct = resolve(obj, selector);
    if (!acct) throw new Error(`no account matches selector: ${selector}`);
    const snap = snapshotPath(p, acct.chatgpt_account_id);
    if (!fs.existsSync(snap)) {
      throw new Error(`snapshot file missing: accounts/${acct.chatgpt_account_id}.json`);
    }
    const v = verifyFilePerms(snap);
    if (!v.ok) throw new Error(`snapshot has unsafe perms (${v.reason}); fix with: chmod 600 accounts/${acct.chatgpt_account_id}.json`);

    if (fs.existsSync(p.authFile)) {
      const liveBuf = fs.readFileSync(p.authFile);
      const bak = path.join(p.accountsDir, `auth.json.bak.${tsStamp()}`);
      assertInside(p.home, bak);
      atomicWriteFile(bak, liveBuf, { mode0600: true });
      // SYNC-BACK: Codex rotates the refresh/access token during a session and
      // writes the new one into the live auth.json. The per-account snapshot is
      // only captured at import/login, so without this it goes stale and
      // switching back loads an invalidated refresh token → forced re-login.
      // Persist the live auth.json into ITS OWN account's snapshot (identified
      // from the token), keeping that snapshot current. Best-effort: never let
      // a sync-back problem block the switch itself.
      try {
        const liveAuth = JSON.parse(liveBuf.toString('utf8'));
        const liveId = deriveIdentity(liveAuth);
        const liveSnap = snapshotPath(p, liveId.chatgpt_account_id);
        atomicWriteFile(liveSnap, JSON.stringify(liveAuth, null, 2) + '\n', { mode0600: true });
      } catch (_) { /* unparseable / API-key-only auth: skip, keep stored snapshot */ }
    }
    assertInside(p.home, p.authFile);
    // Read the target snapshot AFTER sync-back, so switching to the currently
    // active account picks up the freshly-synced tokens rather than stale ones.
    atomicWriteFile(p.authFile, fs.readFileSync(snap), { mode0600: true });

    obj.active_account_key = acct.account_key;
    obj.active_account_activated_at_ms = Date.now();
    acct.last_used_at = Math.floor(Date.now() / 1000);
    save(p, obj);
    return { account_key: acct.account_key, email: acct.email,
      account_id: acct.chatgpt_account_id };
  });
}

/** Derive identity (account_key etc.) from a freshly produced auth.json. */
function deriveIdentity(authObj, jwtOpts = {}) {
  const tokens = authObj.tokens || authObj;
  const probe = tokens.id_token || tokens.access_token;
  let claims = {};
  try { claims = validateClaims(probe, jwtOpts).claims; } catch (_) { claims = {}; }
  const ns = claims['https://api.openai.com/auth'] || {};
  const accountId = ns.chatgpt_account_id || authObj.chatgpt_account_id || authObj.account_id;
  const userId = ns.chatgpt_user_id || claims.chatgpt_user_id || claims.sub || authObj.chatgpt_user_id;
  if (!accountId || !userId) {
    throw new Error('could not derive chatgpt_account_id / chatgpt_user_id from auth.json');
  }
  return {
    account_key: `${userId}::${accountId}`,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    email: claims.email || authObj.email || null,
    plan: ns.chatgpt_plan_type || null,
  };
}

/**
 * Insert/update an account from a produced auth.json (used by login/import):
 * write snapshot <account_id>.json, upsert the array entry, save registry.
 */
function upsertFromAuth(p, authObj, { alias = null, jwtOpts = {} } = {}) {
  const id = deriveIdentity(authObj, jwtOpts);
  return withLock(p.registryLock, () => {
    const obj = load(p);
    const snap = snapshotPath(p, id.chatgpt_account_id);
    atomicWriteFile(snap, JSON.stringify(authObj, null, 2) + '\n', { mode0600: true });

    const now = Math.floor(Date.now() / 1000);
    let acct = obj.accounts.find((a) => a.account_key === id.account_key);
    if (!acct) {
      acct = {
        account_key: id.account_key,
        chatgpt_account_id: id.chatgpt_account_id,
        chatgpt_user_id: id.chatgpt_user_id,
        email: id.email,
        alias: alias || '',
        account_name: null,
        plan: id.plan,
        auth_mode: 'chatgpt',
        created_at: now,
        last_used_at: null,
        last_usage: null,
        last_usage_at: null,
        last_local_rollout: null,
      };
      obj.accounts.push(acct);
    } else {
      if (id.email) acct.email = id.email;
      if (id.plan) acct.plan = id.plan;
      if (alias) acct.alias = alias;
    }
    if (typeof obj.schema_version !== 'number') obj.schema_version = 3;
    save(p, obj);
    return { account_key: id.account_key, email: id.email,
      account_id: id.chatgpt_account_id, alias: acct.alias };
  });
}

module.exports = {
  isCodexArrayFormat, load, save, resolve, list, whoami, switchTo,
  upsertFromAuth, deriveIdentity, snapshotPath,
};
