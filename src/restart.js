'use strict';
/**
 * Best-effort restart of the Codex desktop app around a switch, so the new
 * auth.json is picked up without the user doing it manually.
 *
 * Exposed as two phases so callers can quit Codex BEFORE swapping auth.json and
 * relaunch AFTER. Ordering matters: if Codex is still running when we replace
 * auth.json, it may flush its in-memory session back over our swap on quit,
 * leaving the wrong (or a half-written) credential and forcing a re-login.
 * Correct sequence: quitCodex() → switch (swap auth.json) → launchCodex().
 *
 * macOS only (uses osascript to quit + `open -a` to relaunch). On other
 * platforms each phase returns a no-op result with a hint. The app name is
 * configurable (default "Codex") and validated to avoid shell/AppleScript
 * injection — we never interpolate untrusted strings into a script.
 */
const { spawnSync } = require('child_process');

const SAFE_APP = /^[A-Za-z0-9 ._-]{1,64}$/;

function resolveApp(appName) {
  const app = appName || process.env.CODEX_APP_NAME || 'Codex';
  if (!SAFE_APP.test(app)) return { ok: false, reason: `invalid app name: ${app}` };
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'auto-restart is implemented for the macOS Codex app only; restart Codex manually.' };
  }
  return { ok: true, app };
}

/** Quit Codex (best effort) and wait briefly for it to flush + terminate. */
function quitCodex({ appName, timeoutMs = 15000 } = {}) {
  const r = resolveApp(appName);
  if (!r.ok) return r;
  spawnSync('osascript', ['-e', `tell application "${r.app}" to quit`],
    { timeout: timeoutMs, stdio: 'ignore' });
  // Grace period so the app finishes writing/terminating before we swap+open.
  spawnSync('sleep', ['1'], { timeout: 3000 });
  return { ok: true, app: r.app };
}

/** Launch (or relaunch) Codex so it reads the freshly swapped auth.json. */
function launchCodex({ appName, timeoutMs = 15000 } = {}) {
  const r = resolveApp(appName);
  if (!r.ok) return r;
  const res = spawnSync('open', ['-a', r.app], { timeout: timeoutMs });
  if (res.error || res.status !== 0) {
    return { ok: false, reason: `could not relaunch "${r.app}". Set CODEX_APP_NAME if the app has a different name.` };
  }
  return { ok: true, app: r.app };
}

/** Convenience: quit then relaunch in one call (kept for compatibility). */
function restartCodex(opts = {}) {
  const q = quitCodex(opts);
  if (!q.ok) return q; // non-macOS / invalid name hint
  return launchCodex(opts);
}

module.exports = { restartCodex, quitCodex, launchCodex };
