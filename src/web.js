'use strict';
/**
 * Local WebUI for listing + switching accounts.
 *
 * SECURITY:
 *   - Binds to 127.0.0.1 only (never 0.0.0.0) — not reachable from the network.
 *   - Per-run random session token embedded in the served page; every /api
 *     call must echo it in the x-ca-token header. Other websites open in the
 *     browser cannot read this token (same-origin policy), so they cannot forge
 *     switch requests (CSRF defense).
 *   - Validates the Host header is localhost (basic DNS-rebinding defense).
 *   - Never sends raw tokens to the browser; only account metadata + usage.
 *   - Switch goes through the same locked, atomic, auto-backup engine as the CLI.
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const accts = require('./accounts');

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch (_) {}
}

function listAccounts(p, useCodex) {
  return accts.list(p, useCodex);
}
function whoami(p, useCodex) {
  return accts.whoami(p, useCodex);
}
function doSwitch(p, useCodex, selector, restart) {
  // Quit Codex before swapping auth.json (see restart.js for why ordering
  // matters), then relaunch so it reads the new account.
  const r = restart ? require('./restart') : null;
  if (r) r.quitCodex();
  let res;
  try {
    res = accts.switchTo(p, useCodex, selector);
  } catch (e) {
    if (r) r.launchCodex();
    throw e;
  }
  if (r) {
    const rr = r.launchCodex();
    res.restart = rr.ok ? `restarted ${rr.app}` : rr.reason;
  }
  return res;
}

function serve(p, { port = 4577, useCodex = false, open = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    // DNS-rebinding defense: Host must be localhost.
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end('forbidden host'); return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Static page
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE.replace('__TOKEN__', token));
      return;
    }

    // API: all /api/* require the session token header.
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-ca-token'] !== token) { res.writeHead(401).end('bad token'); return; }

      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        return sendJson(res, 200, { accounts: listAccounts(p, useCodex), me: whoami(p, useCodex) });
      }
      if (req.method === 'POST' && url.pathname === '/api/switch') {
        return readBody(req, (body) => {
          try {
            const { selector, restart } = JSON.parse(body || '{}');
            if (!selector) return sendJson(res, 400, { error: 'missing selector' });
            const r = doSwitch(p, useCodex, String(selector), !!restart);
            sendJson(res, 200, { ok: true, ...r });
          } catch (e) { sendJson(res, 500, { error: e.message }); }
        });
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(404).end('not found');
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/?t=${token.slice(0, 6)}`;
    process.stderr.write(`\ncodex-accounts WebUI → ${url}\n(127.0.0.1 only · Ctrl+C to stop)\n\n`);
    if (open) openBrowser(`http://127.0.0.1:${port}/`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`port ${port} in use, trying ${port + 1}…\n`);
      serve(p, { port: port + 1, useCodex, open });
    } else throw e;
  });
  return server;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => cb(b));
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>codex-accounts</title>
<style>
  :root{--bg:#0f1115;--card:#181b22;--mut:#8b93a7;--line:#262b36;--acc:#3b82f6;--ok:#22c55e;--warn:#f59e0b;--txt:#e6e9ef}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:680px;margin:0 auto;padding:28px 18px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:var(--mut);font-size:13px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;display:flex;align-items:center;gap:14px}
  .card.cur{border-color:var(--ok)}
  .ava{width:40px;height:40px;border-radius:50%;background:#222836;display:flex;align-items:center;justify-content:center;font-weight:600;color:#9fb0ff;flex:0 0 auto}
  .info{flex:1;min-width:0}
  .email{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta{color:var(--mut);font-size:12.5px;margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
  .pill{background:#222836;border-radius:999px;padding:1px 8px;font-size:11.5px}
  .bars{margin-top:8px;display:flex;gap:14px}
  .bar{flex:1} .bar small{color:var(--mut);font-size:11px} .track{height:6px;background:#222836;border-radius:6px;overflow:hidden;margin-top:3px}
  .fill{height:100%;background:var(--acc)} .fill.hi{background:var(--warn)} .fill.max{background:#ef4444}
  .btn{border:0;border-radius:10px;padding:9px 16px;font-weight:600;cursor:pointer;background:var(--acc);color:#fff;flex:0 0 auto}
  .btn:disabled{opacity:.5;cursor:default} .badge{color:var(--ok);font-weight:600;font-size:13px;flex:0 0 auto}
  .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2430;border:1px solid var(--line);padding:12px 18px;border-radius:12px;opacity:0;transition:.25s;pointer-events:none}
  .toast.show{opacity:1} .empty{color:var(--mut);text-align:center;padding:40px}
  .opt{display:flex;align-items:center;gap:8px;color:var(--mut);font-size:13px;margin-bottom:16px;cursor:pointer}
  .fresh{color:var(--mut);font-size:11.5px}
</style></head><body><div class="wrap">
<h1>Codex 账号切换</h1>
<div class="sub">本地工具 · 仅监听 127.0.0.1</div>
<label class="opt"><input type="checkbox" id="restart"> 切换后自动重启 Codex App（macOS）</label>
<div id="list"><div class="empty">加载中…</div></div>
</div><div class="toast" id="toast"></div>
<script>
const TOKEN="__TOKEN__";
const H={'x-ca-token':TOKEN,'content-type':'application/json'};
const initials=e=>(e||'?').slice(0,2).toUpperCase();
function bar(label,v,reset){if(v==null)return '';const c=v>=90?'max':v>=70?'hi':'';const tag=reset?' · 已重置':'';return \`<div class="bar"><small>\${label} \${v}%\${tag}</small><div class="track"><div class="fill \${c}" style="width:\${Math.min(v,100)}%"></div></div></div>\`;}
function ago(ms){if(!ms)return '';const s=Math.max(0,Date.now()-ms)/1000;if(s<90)return '刚刚';if(s<5400)return Math.round(s/60)+' 分钟前';if(s<172800)return Math.round(s/3600)+' 小时前';return Math.round(s/86400)+' 天前';}
function freshness(a){const src=a.usage_source==='rollout'?'实时(本地日志)':'缓存';const t=a.usage_as_of_ms?(' · 更新于 '+ago(a.usage_as_of_ms)):'';return '<span class=fresh>'+src+t+'</span>';}
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600);}
async function load(){
  const r=await fetch('/api/accounts',{headers:H});const d=await r.json();
  const list=document.getElementById('list');
  if(!d.accounts||!d.accounts.length){list.innerHTML='<div class="empty">还没有账号。用命令行 <code>login</code> 或 <code>import</code> 先添加。</div>';return;}
  list.innerHTML=d.accounts.map(a=>{
    const cur=a.current;const u5=a.usage_5h_percent??a.usage_5h;const uw=a.usage_weekly_percent??a.usage_cycle;
    const sel=a.email||a.account_key||a.alias||String(a.index);
    return \`<div class="card \${cur?'cur':''}">
      <div class="ava">\${initials(a.email)}</div>
      <div class="info">
        <div class="email">\${a.email||a.account_key||('#'+a.index)}</div>
        <div class="meta">\${a.plan?'<span class=pill>'+a.plan+'</span>':''}\${a.alias?'<span class=pill>'+a.alias+'</span>':''}<span>#\${a.index}</span>\${(u5!=null||uw!=null)?freshness(a):''}</div>
        \${(u5!=null||uw!=null)?'<div class=bars>'+bar('5h',u5,a.usage_window_reset)+bar('周',uw,a.usage_window_reset)+'</div>':''}
      </div>
      \${cur?'<span class="badge">● 当前</span>':\`<button class="btn" onclick="sw('\${encodeURIComponent(sel)}',this)">切换</button>\`}
    </div>\`;}).join('');
}
async function sw(sel,btn){
  btn.disabled=true;btn.textContent='切换中…';
  const restart=document.getElementById('restart').checked;
  try{const r=await fetch('/api/switch',{method:'POST',headers:H,body:JSON.stringify({selector:decodeURIComponent(sel),restart})});
    const d=await r.json();
    if(d.ok){toast('已切换到 '+d.switched_to+(d.restart?(' · '+d.restart):' · 请重启 Codex 生效'));await load();}
    else{toast('失败: '+(d.error||'未知'));btn.disabled=false;btn.textContent='切换';}
  }catch(e){toast('请求失败: '+e.message);btn.disabled=false;btn.textContent='切换';}
}
load();
</script></body></html>`;

module.exports = { serve };
