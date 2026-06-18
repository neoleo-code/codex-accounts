'use strict';
/**
 * Parsing + identity extraction from a Codex auth.json, and the import gate.
 */
const fs = require('fs');
const { validateClaims } = require('./jwt');
const { safeName } = require('./safe-name');

const MAX_AUTH_BYTES = 256 * 1024; // single-file size cap for imports

function parseAuthBuffer(buf) {
  if (buf.length > MAX_AUTH_BYTES) {
    throw new Error(`auth file too large: ${buf.length} > ${MAX_AUTH_BYTES}`);
  }
  let data;
  try { data = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw new Error(`auth file is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object') throw new Error('auth file: expected JSON object');
  return data;
}

/**
 * Pull the best available tokens from common Codex/CLIProxyAPI shapes.
 * Returns a normalised view without mutating the original.
 */
function extractTokens(auth) {
  const tokens = auth.tokens || auth.OPENAI_AUTH || auth;
  return {
    id_token: tokens.id_token || null,
    access_token: tokens.access_token || null,
    refresh_token: tokens.refresh_token || null,
    api_key: auth.OPENAI_API_KEY || auth.api_key || tokens.api_key || null,
    account_id: auth.account_id || tokens.account_id || null,
    last_refresh: auth.last_refresh || tokens.last_refresh || null,
  };
}

/**
 * Derive a stable account identity. Prefer the *verified* claims from the
 * id_token; fall back to access_token claims; never trust a bare field alone
 * for the key when a token is present.
 */
function deriveIdentity(auth, { allowedIssuers, audience } = {}) {
  const t = extractTokens(auth);
  let claims = {};
  let tokenVerifiedStructurally = false;
  const probe = t.id_token || t.access_token;
  if (probe) {
    try {
      const res = validateClaims(probe, { allowedIssuers, audience });
      claims = res.claims;
      tokenVerifiedStructurally = true;
    } catch (e) {
      // surfaced to caller; identity from claims is not trusted
      claims = { _error: e.message };
    }
  }
  const email = claims.email || auth.email || null;
  const userId = claims.sub || claims.user_id || auth.user_id || null;
  const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
    || claims.account_id || t.account_id || auth.account_id || null;
  const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type
    || auth.plan || null;

  // Account key: stable, collision-resistant, traversal-safe.
  const basis = accountId || userId || email || probe || JSON.stringify(auth);
  const key = safeName(String(basis));

  return {
    key, email, userId, accountId, plan,
    tokenVerifiedStructurally,
    claimsError: claims._error || null,
    tokens: t,
  };
}

function readAuthFile(path) {
  return parseAuthBuffer(fs.readFileSync(path));
}

module.exports = { parseAuthBuffer, extractTokens, deriveIdentity, readAuthFile, MAX_AUTH_BYTES };
