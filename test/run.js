'use strict';
/* Minimal self-contained test harness (no deps). Run: node test/run.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { safeName } = require(path.join(ROOT, 'src/safe-name'));
const { assertInside, paths } = require(path.join(ROOT, 'src/paths'));
const { atomicWriteFile } = require(path.join(ROOT, 'src/atomic'));
const { withLock } = require(path.join(ROOT, 'src/lock'));
const { validateClaims } = require(path.join(ROOT, 'src/jwt'));
const { redact, fingerprint } = require(path.join(ROOT, 'src/redact'));
const engine = require(path.join(ROOT, 'src/engine'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

function mkHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  return dir;
}

// ---- safe-name / traversal ----
test('safeName blocks path separators and ..', () => {
  assert.ok(!safeName('../../etc/passwd').includes('/'));
  assert.ok(!safeName('..\\..\\win').includes('\\'));
  assert.notStrictEqual(safeName('..'), '..');
  assert.notStrictEqual(safeName('.'), '.');
});
test('safeName preserves benign emails enough to round-trip key stability', () => {
  const a = safeName('user@example.com');
  const b = safeName('user@example.com');
  assert.strictEqual(a, b);
  assert.ok(!a.includes('/') && !a.includes('\0'));
});
test('safeName rejects Windows reserved name', () => {
  assert.ok(safeName('con') !== 'con');
});

// ---- assertInside ----
test('assertInside accepts paths inside home', () => {
  const home = mkHome();
  const p = paths(home);
  engine.init(home);
  const ok = assertInside(home, p.snapshot(safeName('a@b.com')));
  assert.ok(ok.startsWith(fs.realpathSync(home)));
});
test('assertInside rejects traversal target', () => {
  const home = mkHome();
  engine.init(home);
  assert.throws(() => assertInside(home, path.join(home, '..', 'escape.json')));
});
test('assertInside rejects symlink escape', () => {
  const home = mkHome();
  engine.init(home);
  const evil = path.join(home, 'accounts', 'evil.json');
  const outside = path.join(os.tmpdir(), `outside-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, evil);
  assert.throws(() => assertInside(home, evil));
});

// ---- atomic write + perms ----
test('atomicWriteFile creates 0600 file with content', () => {
  const home = mkHome();
  const f = path.join(home, 'auth.json');
  atomicWriteFile(f, '{"a":1}', { mode0600: true });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  }
});
test('atomicWriteFile leaves no temp files behind', () => {
  const home = mkHome();
  const f = path.join(home, 'auth.json');
  atomicWriteFile(f, 'data', { mode0600: true });
  const leftover = fs.readdirSync(home).filter((n) => n.includes('.tmp'));
  assert.deepStrictEqual(leftover, []);
});

// ---- lock ----
test('withLock is reentrant-safe sequentially and cleans up', () => {
  const home = mkHome();
  const p = paths(home); engine.init(home);
  let n = 0;
  withLock(p.registryLock, () => { n++; });
  withLock(p.registryLock, () => { n++; });
  assert.strictEqual(n, 2);
  assert.ok(!fs.existsSync(p.registryLock));
});

// ---- JWT ----
function makeUnsignedJwt(payload, header = { alg: 'RS256', kid: 'k1' }) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b(header)}.${b(payload)}.${'A'.repeat(32)}`;
}
test('validateClaims rejects alg=none', () => {
  const t = makeUnsignedJwt({ iss: 'https://auth.openai.com' }, { alg: 'none' });
  assert.throws(() => validateClaims(t));
});
test('validateClaims rejects bad issuer', () => {
  const t = makeUnsignedJwt({ iss: 'https://evil.example' });
  assert.throws(() => validateClaims(t));
});
test('validateClaims rejects expired token', () => {
  const t = makeUnsignedJwt({ iss: 'https://auth.openai.com', exp: 1 });
  assert.throws(() => validateClaims(t));
});
test('validateClaims accepts valid claims (signature still unverified)', () => {
  const t = makeUnsignedJwt({ iss: 'https://auth.openai.com', exp: Math.floor(Date.now() / 1000) + 3600, email: 'a@b.com', sub: 'u1' });
  const r = validateClaims(t);
  assert.strictEqual(r.verifiedSignature, false);
  assert.strictEqual(r.claims.email, 'a@b.com');
});

// ---- redaction ----
test('redact replaces secrets with fingerprints', () => {
  const obj = { access_token: 'eyJhbGc.payload.sig', email: 'a@b.com', nested: { refresh_token: 'rt-secret-value' } };
  const r = redact(obj);
  assert.ok(!JSON.stringify(r).includes('eyJhbGc.payload.sig'));
  assert.ok(!JSON.stringify(r).includes('rt-secret-value'));
  assert.strictEqual(r.email, 'a@b.com');
  assert.ok(r.access_token.startsWith('sha256:'));
});

// ---- end-to-end import + switch ----
function authObj(email, accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  const idt = makeUnsignedJwt({ iss: 'https://auth.openai.com', email, sub: 'user-' + accountId, exp,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } });
  return { tokens: { id_token: idt, access_token: idt, refresh_token: 'rt-' + accountId }, account_id: accountId };
}

test('import two accounts then switch is atomic and consistent', () => {
  const home = mkHome();
  const p = engine.init(home);
  engine.importAuthObject(p, authObj('alice@example.com', 'acc-alice'), { alias: 'work' });
  engine.importAuthObject(p, authObj('bob@example.com', 'acc-bob'), { alias: 'personal' });

  const listed = engine.list(p);
  assert.strictEqual(listed.length, 2);

  const r = engine.switchTo(p, 'alice@example.com');
  const live = JSON.parse(fs.readFileSync(p.authFile, 'utf8'));
  assert.strictEqual(live.account_id, 'acc-alice');
  assert.strictEqual(r.entry.email, 'alice@example.com');

  // auth.json must be 0600
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(p.authFile).mode & 0o777, 0o600);
  }

  engine.switchTo(p, 'personal'); // by alias
  const live2 = JSON.parse(fs.readFileSync(p.authFile, 'utf8'));
  assert.strictEqual(live2.account_id, 'acc-bob');

  // previous should now be alice
  const who = engine.whoami(p);
  assert.strictEqual(who.previous, listed.find((x) => x.email === 'alice@example.com').key);
});

test('switch syncs rotated live tokens back into the previous snapshot', () => {
  const home = mkHome();
  const p = engine.init(home);
  engine.importAuthObject(p, authObj('alice@example.com', 'acc-alice'), { alias: 'work' });
  engine.importAuthObject(p, authObj('bob@example.com', 'acc-bob'), { alias: 'personal' });
  const aliceKey = engine.list(p).find((x) => x.email === 'alice@example.com').key;

  engine.switchTo(p, 'alice@example.com');
  // Simulate Codex rotating the refresh token in the live auth.json while alice
  // is the active account.
  const live = JSON.parse(fs.readFileSync(p.authFile, 'utf8'));
  live.refresh_token = 'rotated-token-xyz';
  fs.writeFileSync(p.authFile, JSON.stringify(live));

  // Switching away must capture alice's rotated token into her snapshot…
  engine.switchTo(p, 'personal');
  const aliceSnap = JSON.parse(fs.readFileSync(p.snapshot(aliceKey), 'utf8'));
  assert.strictEqual(aliceSnap.refresh_token, 'rotated-token-xyz');

  // …so switching back restores the rotated (still-valid) token, not the stale
  // one captured at import.
  engine.switchTo(p, 'alice@example.com');
  const back = JSON.parse(fs.readFileSync(p.authFile, 'utf8'));
  assert.strictEqual(back.refresh_token, 'rotated-token-xyz');
});

test('switch refuses world-readable snapshot (Unix)', function () {
  if (process.platform === 'win32') return;
  const home = mkHome();
  const p = engine.init(home);
  engine.importAuthObject(p, authObj('carol@example.com', 'acc-carol'));
  const registry = require(path.join(ROOT, 'src/registry')).load(p);
  const key = Object.keys(registry.accounts)[0];
  fs.chmodSync(p.snapshot(key), 0o644); // tamper: make it group/world readable
  assert.throws(() => engine.switchTo(p, 'carol@example.com'), /unsafe perms/);
});

test('end-to-end via bin launcher (JS fallback) lists accounts', () => {
  const home = mkHome();
  const p = engine.init(home);
  engine.importAuthObject(p, authObj('dave@example.com', 'acc-dave'));
  const stdout = execFileSync(process.execPath, [path.join(ROOT, 'bin/codex-accounts.js'), 'list'],
    { env: { ...process.env, CODEX_HOME: home } }).toString();
  assert.ok(stdout.includes('dave@example.com'));
});

console.log(`\n${passed} checks passed`);
