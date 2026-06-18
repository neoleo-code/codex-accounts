'use strict';
/**
 * Best-effort restart of the Codex desktop app after a switch, so the new
 * auth.json is picked up without the user doing it manually.
 *
 * macOS only (uses osascript to quit + `open -a` to relaunch). On other
 * platforms it returns a no-op result with a hint. The app name is
 * configurable (default "Codex") and validated to avoid shell/AppleScript
 * injection — we never interpolate untrusted strings into a script.
 */
const { spawnSync } = require('child_process');

const SAFE_APP = /^[A-Za-z0-9 ._-]{1,64}$/;

function restartCodex({ appName, timeoutMs = 15000 } = {}) {
  const app = appName || process.env.CODEX_APP_NAME || 'Codex';
  if (!SAFE_APP.test(app)) return { ok: false, reason: `invalid app name: ${app}` };
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'auto-restart is implemented for the macOS Codex app only; restart Codex manually.' };
  }
  // Quit (best effort — app may not be running, which is fine).
  spawnSync('osascript', ['-e', `tell application "${app}" to quit`],
    { timeout: timeoutMs, stdio: 'ignore' });
  // Small grace period for the app to terminate before relaunch.
  spawnSync('sleep', ['1'], { timeout: 3000 });
  const r = spawnSync('open', ['-a', app], { timeout: timeoutMs });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: `could not relaunch "${app}". Set CODEX_APP_NAME if the app has a different name.` };
  }
  return { ok: true, app };
}

module.exports = { restartCodex };
