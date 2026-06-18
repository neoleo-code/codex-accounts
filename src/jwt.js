'use strict';
/**
 * Minimal JWT validation for imported auth files.
 *
 * SECURITY (CWE-347 improper signature verification): we MUST NOT trust JWT
 * claims after a bare base64 decode. Before accepting an imported credential
 * we verify: structural validity, issuer allowlist, audience, expiry/nbf, and
 * — when JWKS is available — the RS256/ES256 signature against the issuer's
 * published keys. Tokens that only "decode" are treated as UNVERIFIED and the
 * caller decides whether to allow import with an explicit warning.
 *
 * Note: OpenAI/Codex access tokens are validated server-side by the API; this
 * is a *local sanity* gate to avoid importing forged or malformed files, not a
 * substitute for the official auth server.
 */
const crypto = require('crypto');

const DEFAULT_ALLOWED_ISSUERS = [
  'https://auth.openai.com',
  'https://auth0.openai.com',
];

function b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('JWT: expected 3 segments');
  const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
  return { header, payload, signature: parts[2], signingInput: `${parts[0]}.${parts[1]}` };
}

/**
 * Validate claims only (no network). Returns {verifiedSignature:false, claims}.
 */
function validateClaims(token, {
  allowedIssuers = DEFAULT_ALLOWED_ISSUERS,
  audience = null,
  now = Math.floor(Date.now() / 1000),
  clockSkew = 60,
} = {}) {
  const { header, payload } = decodeJwt(token);
  if (header.alg === 'none') throw new Error('JWT: alg=none rejected');
  if (payload.iss && !allowedIssuers.includes(payload.iss)) {
    throw new Error(`JWT: issuer not allowed: ${payload.iss}`);
  }
  if (audience && payload.aud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(audience)) throw new Error(`JWT: audience mismatch`);
  }
  if (typeof payload.exp === 'number' && now > payload.exp + clockSkew) {
    throw new Error('JWT: expired');
  }
  if (typeof payload.nbf === 'number' && now + clockSkew < payload.nbf) {
    throw new Error('JWT: not yet valid (nbf)');
  }
  return { verifiedSignature: false, header, claims: payload };
}

/**
 * Verify RS256/ES256 signature against a JWKS (array of public keys in JWK
 * form). Caller is responsible for fetching JWKS only from the issuer's
 * allowlisted HTTPS discovery endpoint.
 */
function verifySignature(token, jwks) {
  const { header, signingInput, signature } = decodeJwt(token);
  const key = (jwks.keys || jwks).find((k) => k.kid === header.kid) || (jwks.keys || jwks)[0];
  if (!key) throw new Error('JWT: no matching JWK');
  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const algMap = { RS256: 'RSA-SHA256', ES256: 'sha256', PS256: 'RSA-SHA256' };
  const nodeAlg = algMap[header.alg];
  if (!nodeAlg) throw new Error(`JWT: unsupported alg ${header.alg}`);
  const sig = b64urlToBuf(signature);
  let ok;
  if (header.alg === 'ES256') {
    ok = crypto.verify('sha256', Buffer.from(signingInput), { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
  } else if (header.alg === 'PS256') {
    ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, sig);
  } else {
    ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), pub, sig);
  }
  if (!ok) throw new Error('JWT: signature verification failed');
  return true;
}

module.exports = { decodeJwt, validateClaims, verifySignature, DEFAULT_ALLOWED_ISSUERS };
