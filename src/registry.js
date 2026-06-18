'use strict';
/**
 * registry.json read/write. Always written atomically and only under the
 * cross-process lock held by the caller.
 */
const fs = require('fs');
const { atomicWriteFile } = require('./atomic');
const { assertInside } = require('./paths');

const SCHEMA_VERSION = 1;

function emptyRegistry() {
  return { schema: SCHEMA_VERSION, current: null, previous: null, accounts: {} };
}

function load(p) {
  if (!fs.existsSync(p.registryFile)) return emptyRegistry();
  const raw = fs.readFileSync(p.registryFile, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    throw new Error(`registry.json is corrupt: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || typeof data.accounts !== 'object') {
    throw new Error('registry.json has unexpected shape');
  }
  return data;
}

function save(p, registry) {
  assertInside(p.home, p.registryFile);
  registry.schema = SCHEMA_VERSION;
  atomicWriteFile(p.registryFile, JSON.stringify(registry, null, 2) + '\n');
}

/** Resolve a selector (1-based index | email | alias | accountKey | accountId). */
function resolve(registry, selector) {
  const keys = Object.keys(registry.accounts);
  if (/^[0-9]+$/.test(selector)) {
    const idx = parseInt(selector, 10) - 1;
    if (idx >= 0 && idx < keys.length) return keys[idx];
  }
  for (const [key, a] of Object.entries(registry.accounts)) {
    if (key === selector) return key;
    if (a.email === selector) return key;
    if (a.alias === selector) return key;
    if (a.account_id === selector) return key;
    if (a.user_id === selector) return key;
  }
  return null;
}

module.exports = { emptyRegistry, load, save, resolve, SCHEMA_VERSION };
