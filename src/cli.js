'use strict';
/**
 * Pure-JS CLI. Auto-detects the on-disk registry format:
 *   - REAL Codex format (accounts: array, schema_version) → codex-format engine
 *   - this tool's own object format                       → reference engine
 * so it operates safely on an existing ~/.codex managed by another tool.
 */
const fs = require('fs');
const path = require('path');
const { resolveCodexHome } = require('./paths');
const engine = require('./engine');
const codex = require('./codex-format');
const accts = require('./accounts');
const { redact } = require('./redact');

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function err(msg) { process.stderr.write(`error: ${msg}\n`); }

function parseFlags(rest) {
  const aliasIdx = rest.indexOf('--alias');
  const binIdx = rest.indexOf('--codex-bin');
  return {
    device: rest.includes('--device') || rest.includes('--device-auth'),
    alias: aliasIdx >= 0 ? rest[aliasIdx + 1] : null,
    codexBin: binIdx >= 0 ? rest[binIdx + 1] : undefined,
    positionals: rest.filter((x, i) =>
      !x.startsWith('--') && rest[i - 1] !== '--alias' && rest[i - 1] !== '--codex-bin'),
  };
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const home = resolveCodexHome();
  const p = engine.init(home);
  const useCodex = codex.isCodexArrayFormat(p); // real existing-tool format?
  const f = parseFlags(rest);

  switch (cmd) {
    case 'serve':
    case 'web':
    case 'ui': {
      const portIdx = rest.indexOf('--port');
      let port = 4577;
      if (portIdx >= 0) {
        const n = parseInt(rest[portIdx + 1], 10);
        if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
        else err(`invalid --port "${rest[portIdx + 1]}", using ${port}`);
      }
      const noOpen = rest.includes('--no-open');
      require('./web').serve(p, { port, useCodex, open: !noOpen });
      return new Promise(() => {}); // keep process alive until Ctrl+C
    }
    case 'login': {
      const { login } = require('./login');
      process.stderr.write('Launching official `codex login` in an isolated CODEX_HOME…\n');
      const r = login(p, { device: f.device, alias: f.alias, codexBin: f.codexBin, useCodex });
      out({ imported: r.account_key || r.key, email: r.email || r.entry?.email,
        note: 'Account saved. Run `switch <email|index>` to activate, then restart Codex.' });
      return 0;
    }
    case 'list':
    case 'ls': {
      out(accts.list(p, useCodex));
      return 0;
    }
    case 'whoami': {
      out(accts.whoami(p, useCodex));
      return 0;
    }
    case 'switch':
    case 'use': {
      const selector = f.positionals[0];
      if (!selector) { err('usage: switch <index|email|alias|accountId> [--restart]'); return 2; }
      const wantRestart = rest.includes('--restart');
      const restart = wantRestart ? require('./restart') : null;
      // Quit Codex BEFORE swapping auth.json so it can't flush its old session
      // over the swap on quit; the switch then syncs the now-flushed tokens
      // back into the previous account's snapshot.
      if (restart) restart.quitCodex();
      let result;
      try {
        result = accts.switchTo(p, useCodex, selector);
      } catch (e) {
        if (restart) restart.launchCodex(); // don't leave the app closed on error
        throw e;
      }
      if (restart) {
        const rr = restart.launchCodex();
        result.restart = rr.ok ? `restarted ${rr.app}` : rr.reason;
      } else {
        result.note = 'Restart Codex CLI / VS Code extension / Codex App to pick up the new account (or use --restart).';
      }
      out(result);
      return 0;
    }
    case 'menubar': {
      // Emit SwiftBar/xbar-formatted output for the menu bar applet.
      process.stdout.write(renderMenubar(p, useCodex));
      return 0;
    }
    case 'import': {
      if (f.positionals.length === 0) { err('usage: import <file...> [--alias name]'); return 2; }
      const results = [];
      const addFile = (file) => {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const objs = Array.isArray(parsed) ? parsed : [parsed];
        for (const o of objs) {
          results.push(accts.upsert(p, useCodex, o, { alias: f.alias }));
        }
      };
      for (const fp of f.positionals) {
        const st = fs.statSync(fp);
        if (st.isDirectory()) {
          for (const name of fs.readdirSync(fp)) if (name.endsWith('.json')) addFile(`${fp}/${name}`);
        } else addFile(fp);
      }
      out(results.map((r) => ({ account: r.account_key, email: r.email })));
      return 0;
    }
    case 'inspect': {
      const selector = f.positionals[0];
      if (useCodex) {
        const obj = codex.load(p);
        const acct = codex.resolve(obj, selector);
        if (!acct) { err('no such account'); return 2; }
        const snap = codex.snapshotPath(p, acct.chatgpt_account_id);
        out(redact(JSON.parse(fs.readFileSync(snap, 'utf8'))));
      } else {
        const registry = require('./registry').load(p);
        const key = require('./registry').resolve(registry, selector);
        if (!key) { err('no such account'); return 2; }
        out(redact(JSON.parse(fs.readFileSync(p.snapshot(key), 'utf8'))));
      }
      return 0;
    }
    case 'help':
    case undefined:
      process.stdout.write(HELP);
      return 0;
    default:
      err(`unknown command: ${cmd}`);
      process.stdout.write(HELP);
      return 2;
  }
}

/** Render SwiftBar/xbar menu-bar output. Each non-current account becomes a
 *  clickable item that runs `switch <sel> --restart` and refreshes the menu. */
function renderMenubar(p, useCodex) {
  const exe = process.execPath;                         // absolute node path
  const cli = path.join(__dirname, '..', 'bin', 'codex-accounts.js');
  let rows = [];
  try { rows = accts.list(p, useCodex); } catch (_) {}
  const cur = rows.find((a) => a.current);
  const title = cur ? `🤖 ${(cur.email || cur.account_key || '').split('@')[0]}` : '🤖 Codex';

  const L = [];
  L.push(title);
  L.push('---');
  if (rows.length === 0) {
    L.push('还没有账号 | color=#888888');
    L.push(`用命令行 login/import 添加 | bash="${exe}" param1="${cli}" param2="help" terminal=true`);
  }
  for (const a of rows) {
    const sel = a.email || a.account_key || a.alias || String(a.index);
    const used = a.usage_5h_percent != null ? `  (5h ${a.usage_5h_percent}%)` : '';
    if (a.current) {
      L.push(`✓ ${a.email || a.account_key}${used} | color=#22c55e`);
    } else {
      L.push(`切换到 ${a.email || a.account_key}${used} | bash="${exe}" param1="${cli}" param2="switch" param3="${sel}" param4="--restart" terminal=false refresh=true`);
    }
  }
  L.push('---');
  L.push(`刷新 | refresh=true`);
  return L.join('\n') + '\n';
}

const HELP = `codex-accounts — local multi-account manager (manage only accounts you own)

Usage:
  codex-accounts login [--device] [--alias name] [--codex-bin path]
  codex-accounts list
  codex-accounts switch <index|email|alias|accountId>
  codex-accounts import <file|dir...> [--alias name]
  codex-accounts whoami
  codex-accounts inspect <selector>     # prints REDACTED auth (no secrets)

Env:
  CODEX_HOME   override the working dir (default ~/.codex)
`;

module.exports = { run };
