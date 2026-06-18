'use strict';
/**
 * Log redaction (CWE-532 sensitive data in logs).
 * Never print tokens or API keys. Show only a short fingerprint so users can
 * correlate without the secret leaking to terminals, CI logs, or files.
 */
const crypto = require('crypto');

const SECRET_KEYS = new Set([
  'id_token', 'access_token', 'refresh_token', 'api_key', 'openai_api_key',
  'OPENAI_API_KEY', 'client_secret', 'authorization',
]);

function fingerprint(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '<none>';
  const h = crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `sha256:${h}…(${secret.length}b)`;
}

/** Deep-clone an object with all secret-looking fields replaced by fingerprints. */
function redact(value, keyHint = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(k) ? fingerprint(typeof v === 'string' ? v : JSON.stringify(v)) : redact(v, k);
    }
    return out;
  }
  if (typeof value === 'string' && SECRET_KEYS.has(keyHint)) return fingerprint(value);
  // Heuristic: long JWT/sk- strings get redacted even under unknown keys.
  if (typeof value === 'string' && /^(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.)/.test(value)) {
    return fingerprint(value);
  }
  return value;
}

module.exports = { redact, fingerprint };
