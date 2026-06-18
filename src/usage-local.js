'use strict';
/**
 * LOCAL, NO-NETWORK usage source.
 *
 * Codex records rate-limit snapshots into its own session rollout logs:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Each line is { timestamp, type, payload }. The rate-limit events are
 *   type: "event_msg",
 *   payload: { type, info, rate_limits: {
 *       primary:   { used_percent, window_minutes, resets_at },   // 5h window
 *       secondary: { used_percent, window_minutes, resets_at },   // weekly
 *       plan_type, ... } }
 * resets_at is absolute epoch SECONDS.
 *
 * We read the most-recent snapshot (it reflects the most recent request, i.e.
 * the currently active account) — purely by reading local files. No token is
 * read, no request is made. Rollouts are NOT tagged by account, so we only
 * attribute the freshest snapshot to the *active* account; everything else is
 * shown as cached with its own timestamp.
 */
const fs = require('fs');
const path = require('path');

function rolloutFiles(home, maxFiles = 12) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  // sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl  (also accept flatter layouts)
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch (_) {}
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, maxFiles).map((x) => x.file);
}

/** Find the rate_limits holder anywhere in a parsed line. */
function findRateLimits(obj) {
  if (obj && typeof obj === 'object') {
    if (obj.rate_limits) return obj.rate_limits;
    for (const k of Object.keys(obj)) {
      const r = findRateLimits(obj[k]);
      if (r) return r;
    }
  }
  return null;
}

/** Scan one file from the end; return {rate_limits, ts} of the last match. */
function lastSnapshotInFile(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (_) { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('rate_limits') === -1) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const rl = findRateLimits(o);
    if (rl && (rl.primary || rl.secondary)) {
      const ts = o.timestamp || (o.payload && o.payload.timestamp) || null;
      return { rate_limits: rl, ts: ts ? Date.parse(ts) : null };
    }
  }
  return null;
}

/**
 * Latest rate-limit snapshot across the newest rollout files.
 * Returns null if none found.
 */
function latestSnapshot(home) {
  let best = null;
  for (const f of rolloutFiles(home)) {
    const s = lastSnapshotInFile(f);
    if (!s) continue;
    if (!best || (s.ts || 0) > (best.ts || 0)) best = { ...s, file: f };
    // The newest-mtime file usually wins immediately; keep scanning a few in
    // case an older-but-still-open session has a newer line.
    if (best && best.ts && Date.now() - best.ts < 60 * 1000) break;
  }
  if (!best) return null;
  const rl = best.rate_limits;
  return {
    recorded_at_ms: best.ts,
    plan_type: rl.plan_type || null,
    primary: normWindow(rl.primary, best.ts),
    secondary: normWindow(rl.secondary, best.ts),
    source_file: best.file,
  };
}

/**
 * Normalise a window and correct for staleness: if the reset time has already
 * passed, the window has rolled over since the snapshot, so the honest current
 * estimate is 0% (a fresh request would confirm the new value).
 */
function normWindow(w, recordedAtMs) {
  if (!w) return null;
  const now = Date.now();
  const resetMs = typeof w.resets_at === 'number' ? w.resets_at * 1000 : null;
  const reset = resetMs != null && now >= resetMs;
  return {
    used_percent: reset ? 0 : w.used_percent,
    window_minutes: w.window_minutes ?? null,
    resets_at_ms: resetMs,
    reset, // true => window has rolled over since the snapshot
    stale_minutes: recordedAtMs ? Math.round((now - recordedAtMs) / 60000) : null,
  };
}

module.exports = { latestSnapshot, rolloutFiles };
