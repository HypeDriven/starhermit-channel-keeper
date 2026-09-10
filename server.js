// Channel Keeper — authoritative game script (StarHermit host integration).
// Plain Node, no dependencies. Serves the static distribution and the
// authoritative API: server time, daily seed, replay-validated score
// submission, and durable achievement delivery.
//
//   node server.js [port]      — run standalone (default port 8080)
//
// The same validateDailySubmission() is importable for tests.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyLevel, dailyKey, CONTENT_VERSION, ACHIEVEMENTS } from './js/content.js';
import { replay, stateHash, scoreBreakdown, PHASE } from './js/rules.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BUILD_VERSION = '1.0.0';

// In-memory stores (the host sandbox persists via its own layer; daily
// immutability is enforced by deriving levels from the UTC day only).
const boards = new Map();        // dailyKey -> [entry]
const achievements = new Map();  // playerId -> Set(key)
const rateLimits = new Map();    // playerId -> [timestamps]

const MAX_COMMANDS = 20000;
const MAX_BODY = 256 * 1024;

function rateOk(playerId, limit = 30, windowMs = 60000) {
  const nowMs = Date.now();
  const list = (rateLimits.get(playerId) || []).filter((t) => nowMs - t < windowMs);
  if (list.length >= limit) return false;
  list.push(nowMs);
  rateLimits.set(playerId, list);
  return true;
}

/** Plausibility: score must match the deterministic replay exactly. */
export function validateDailySubmission(dateKey, envelope) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'bad envelope' };
  if (envelope.schema !== 1) return { ok: false, error: 'stale replay schema' };
  if (envelope.contentVersion !== CONTENT_VERSION) return { ok: false, error: 'stale content version' };
  if (!Array.isArray(envelope.commands) || envelope.commands.length > MAX_COMMANDS) {
    return { ok: false, error: 'bad command log' };
  }
  // The daily level is derived from the immutable day key; never trust the client.
  const day = dateKey || envelope.dailyKey || dailyKey(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: 'bad daily key' };
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return { ok: false, error: 'bad daily key' };
  // The daily window is synchronized to platform (UTC) time: only today's
  // board is open for submission. Past/future days are rejected.
  if (day !== dailyKey(new Date())) return { ok: false, error: 'daily not open' };
  const level = dailyLevel(date);
  if (envelope.seed !== level.seed) return { ok: false, error: 'seed mismatch' };
  for (const c of envelope.commands) {
    if (!c || typeof c.id !== 'string' || typeof c.type !== 'string') {
      return { ok: false, error: 'malformed command' };
    }
  }
  const state = replay(level, envelope.seed, envelope.commands);
  const hash = stateHash(state);
  if (hash !== envelope.stateHash) return { ok: false, error: 'hash mismatch', hash };
  const score = state.score || scoreBreakdown(state);
  return {
    ok: true,
    hash,
    won: state.phase === PHASE.WON,
    score,
    ticks: state.tick,
    invalidCount: state.invalidCount,
  };
}

export function submitDailyScore(playerId, dateKey, envelope) {
  if (!rateOk(playerId)) return { ok: false, error: 'rate limited' };
  const v = validateDailySubmission(dateKey, envelope);
  if (!v.ok) return v;
  const entry = {
    playerId, score: v.score.total, won: v.won, ticks: v.ticks,
    ruleset: `rules-v${CONTENT_VERSION}`, when: Date.now(),
  };
  const list = boards.get(dateKey) || [];
  // One ranked row per identity: a re-submission replaces that player's prior
  // row rather than appending duplicates onto the board.
  const kept = list.filter((e) => e.playerId !== playerId);
  kept.push(entry);
  kept.sort((a, b) => b.score - a.score || a.ticks - b.ticks);
  boards.set(dateKey, kept.slice(0, 200));
  return { ok: true, rank: kept.indexOf(entry) + 1, score: v.score.total };
}

/** Durable, idempotent achievement delivery. */
export function grantAchievement(playerId, key, proof) {
  if (!ACHIEVEMENTS.some((a) => a.key === key)) return { ok: false, error: 'unknown key' };
  const set = achievements.get(playerId) || new Set();
  if (set.has(key)) return { ok: true, already: true };
  set.add(key);
  achievements.set(playerId, set);
  return { ok: true, already: false };
}

// ---------------------------------------------------------------------------
// HTTP layer (only when run directly)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.opus': 'audio/ogg',
};

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createGameServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/v1/time') {
        return json(res, 200, { now: Date.now() });
      }
      if (url.pathname === '/api/v1/version') {
        return json(res, 200, { build: BUILD_VERSION, content: CONTENT_VERSION });
      }
      if (url.pathname === '/api/v1/daily' && req.method === 'GET') {
        const key = dailyKey(new Date());
        const level = dailyLevel(new Date());
        return json(res, 200, { key, seed: level.seed, contentVersion: CONTENT_VERSION });
      }
      if (url.pathname === '/api/v1/daily/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const playerId = String(body.playerId || 'anon').slice(0, 64);
        const result = submitDailyScore(playerId, body.dailyKey, body.envelope);
        return json(res, result.ok ? 200 : 400, result.ok ? result : { error: result.error });
      }
      if (url.pathname === '/api/v1/daily/board' && req.method === 'GET') {
        const key = url.searchParams.get('key') || dailyKey(new Date());
        return json(res, 200, { key, entries: boards.get(key) || [] });
      }
      if (url.pathname === '/api/v1/achievement' && req.method === 'POST') {
        const body = await readBody(req);
        const r = grantAchievement(String(body.playerId || 'anon').slice(0, 64), body.key, body.proof);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (url.pathname === '/api/v1/events' && req.method === 'POST') {
        await readBody(req).catch(() => ({}));
        return json(res, 202, { ok: true }); // anonymous funnel sink
      }
      if (url.pathname === '/api/v1/presence' && req.method === 'POST') {
        return json(res, 202, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) {
        return json(res, 404, { error: 'not found' });
      }
      // Static files (same-origin distribution).
      let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || p === '\\') p = '/index.html';
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(data);
    } catch (err) {
      json(res, err.message === 'payload too large' ? 413 : 500, { error: String(err.message || err) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 8080;
  createGameServer().listen(port, () => {
    console.log(`Channel Keeper server listening on http://localhost:${port}`);
  });
}
