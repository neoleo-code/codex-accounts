'use strict';
/**
 * Safe file-name encoding for account keys (CWE-22 path traversal defense).
 *
 * Account keys are derived from untrusted values (email, account_id from a
 * decoded JWT, user-supplied alias). We MUST NOT let them contain path
 * separators, "..", NUL, drive letters, or reserved Windows device names.
 *
 * Strategy: allow a strict [a-z0-9._-] subset; everything else is percent-ish
 * encoded to a hex form. The result is reversible enough for display but never
 * contains a path separator. We also cap length and reject reserved names.
 */

const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function safeName(input, maxLen = 96) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('safeName: empty input');
  }
  let out = '';
  for (const ch of input) {
    if (/[a-zA-Z0-9._-]/.test(ch) && ch !== '..') {
      out += ch.toLowerCase();
    } else {
      const hex = Buffer.from(ch, 'utf8').toString('hex');
      out += `_${hex}`;
    }
  }
  // Collapse any "." runs so we can never produce "." or ".."
  out = out.replace(/\.{2,}/g, (m) => '_'.repeat(m.length));
  if (out === '.' || out === '..' || out === '') {
    out = `_${Buffer.from(input, 'utf8').toString('hex')}`;
  }
  // Strip a leading dot so snapshots are never hidden/lock-like files.
  if (out.startsWith('.')) out = `_${out.slice(1)}`;
  if (WINDOWS_RESERVED.has(out.toLowerCase())) out = `_${out}`;
  if (out.length > maxLen) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
    out = `${out.slice(0, maxLen - 13)}-${h}`;
  }
  return out;
}

module.exports = { safeName };
