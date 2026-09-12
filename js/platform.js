// Channel Keeper — StarHermit platform adapter.
// Launch-token lifecycle (fragment read, Bearer, 45-min refresh), profile
// nickname, cloud-save slot for the progress records, the game's own-server
// validated daily routes, and read-only platform leaderboards. Everything
// degrades to local/offline play: no token → localStorage only, and the
// own-server routes are only called when the local dev backend answers.
// Tokens are kept in memory only — never persisted.

const REFRESH_MS = 45 * 60 * 1000; // token lives 60 min; re-mint at 45
const RETRY_MS = 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0);
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const platform = {
  token: null,
  userId: null,
  slug: null,
  hosted: false,       // a launch token was read
  ownServer: false,    // the game's own dev backend answered /time
  profile: null,       // { name } for the signed-in player
  sync: 'offline',     // offline | saving | synced (cloud mirror)
  _timeOffset: 0,
  _refreshTimer: null,
  _retryTimer: null,
  _saveTimer: null,
  _pendingSave: null,
  _profileNames: {},
  _syncListeners: [],

  /* Token: fragment first (platform contract); query forms are local-dev
   * only. Stripped from the URL after the read, kept in memory only. */
  _readLaunchToken() {
    try {
      const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      const t = h.get('game_token');
      if (t) {
        h.delete('game_token');
        h.delete('session_id');
        const rest = h.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return t;
      }
      const q = new URLSearchParams(location.search);
      return q.get('game_token') || q.get('token') || q.get('launch_token') || null;
    } catch {
      return null;
    }
  },
  _decodeJwt(t) {
    try {
      const seg = String(t).split('.')[1];
      if (!seg) return null;
      let b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      b64 += '='.repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  },
  headers(extra) {
    const h = extra || {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  },

  async init() {
    this.token = this._readLaunchToken();
    if (this.token) {
      const claims = this._decodeJwt(this.token);
      if (!claims) this.token = null;
      else {
        if (typeof claims.sub === 'string' && claims.sub) this.userId = claims.sub;
        if (typeof claims.game_scope === 'string' && claims.game_scope) this.slug = claims.game_scope;
        if (!this.userId || !this.slug) this.token = null;
      }
    }
    this.hosted = !!this.token;
    if (this.hosted) {
      this._scheduleRefresh();
      try {
        window.addEventListener('pagehide', () => this.flushSave());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushSave(); });
      } catch { /* no window events available */ }
      this.fetchProfile().catch(() => {});
    }
    return { hosted: this.hosted };
  },

  /* Token refresh: scoped tokens may re-mint via the game's launch-token
   * route. Retry a failed re-mint after ~60 s. */
  _scheduleRefresh() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = setInterval(() => this.refreshToken(), REFRESH_MS);
  },
  refreshToken() {
    if (!this.token || !this.slug) return Promise.resolve(false);
    return fetch(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: '{}',
    }).then((r) => r.json().catch(() => null)).then((j) => {
      if (j && typeof j.token === 'string' && j.token) {
        this.token = j.token;
        const claims = this._decodeJwt(this.token);
        if (claims && claims.sub) this.userId = claims.sub;
        if (claims && claims.game_scope) this.slug = claims.game_scope;
        return true;
      }
      this._retryRefresh();
      return false;
    }).catch(() => { this._retryRefresh(); return false; });
  },
  _retryRefresh() {
    if (this._retryTimer || !this.token) return;
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this.refreshToken(); }, RETRY_MS);
  },

  /* Identity: the profile nickname is the only profile read a game-scoped
   * token may make (never /api/v1/me, never usernames). Cached per id. */
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    if (this._profileNames[userId]) return this._profileNames[userId];
    const p = fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { headers: this.headers() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j.nickname === 'string' && j.nickname ? j.nickname : null))
      .then((n) => n || (`Player ${userId.slice(0, 8)}`))
      .catch(() => `Player ${userId.slice(0, 8)}`);
    this._profileNames[userId] = p;
    return p;
  },
  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name };
    return this.profile;
  },

  /* Server time (own backend or platform); local clock otherwise. */
  async syncTime() {
    try {
      const t0 = Date.now();
      const r = await fetch('/api/v1/time', { cache: 'no-store', headers: this.headers() });
      if (!r.ok) return false;
      const j = await r.json();
      const t1 = Date.now();
      const serverMs = typeof j.now === 'number' ? j.now : Date.parse(j.now || j.time);
      if (!Number.isFinite(serverMs)) return false;
      this._timeOffset = serverMs + (t1 - t0) / 2 - t1;
      this.ownServer = true;
      return true;
    } catch {
      return false; // offline: local clock
    }
  },
  now() { return new Date(Date.now() + this._timeOffset); },

  /* Cloud save: ONE zip+base64 slot at /api/v1/me/cloud-saves/{slug} holding
   * the {settings, progress, achievements, boards} records. Remote wins on
   * boot; saves debounce ~2 s and flush on pagehide/hidden with keepalive;
   * localStorage stays the offline cache. */
  async loadCloud() {
    if (!this.hosted || !this.slug) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, { headers: this.headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`http-${res.status}`);
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) return null;
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(new Uint8Array(buf))));
    } catch {
      return null;
    }
  },
  saveCloud(doc) {
    if (!this.hosted || !this.slug) return Promise.resolve(false);
    this._pendingSave = doc;
    this._setSync('saving');
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  },
  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (!this.hosted || !this.slug || this._pendingSave == null) return Promise.resolve(false);
    const doc = this._pendingSave;
    this._pendingSave = null;
    let body;
    try {
      body = { dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)))) };
    } catch {
      return Promise.resolve(false);
    }
    return fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      keepalive: true,
    }).then((res) => {
      if (res.ok) { this._setSync('synced'); return true; }
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return false;
    }).catch(() => {
      this._pendingSave = this._pendingSave == null ? doc : this._pendingSave;
      this._setSync('offline');
      return false;
    });
  },
  onSync(fn) { if (typeof fn === 'function') this._syncListeners.push(fn); },
  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  },

  /* Own-server validated daily routes (declared server=server.js). Only
   * called when the own backend was detected; failures are silent. */
  async submitDaily(dailyKey, envelope) {
    if (!this.ownServer) return { ok: false, reason: 'offline' };
    try {
      const res = await fetch('/api/v1/daily/submit', {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ playerId: this.userId || 'anon', dailyKey, envelope }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, reason: (j && j.error) || `http-${res.status}` };
      return { ok: true, rank: j.rank, total: j.total };
    } catch {
      return { ok: false, reason: 'network' };
    }
  },
  async fetchDailyBoard(dailyKey) {
    if (!this.ownServer) return null;
    try {
      const res = await fetch('/api/v1/daily/board?key=' + encodeURIComponent(dailyKey), { headers: this.headers() });
      if (!res.ok) return null;
      const j = await res.json();
      return Array.isArray(j.entries) ? j.entries : [];
    } catch {
      return null;
    }
  },

  /* Platform leaderboard (read-only; clients never submit). Entries resolve
   * to profile nicknames. */
  async fetchLeaderboard() {
    if (!this.hosted || !this.slug) return null;
    try {
      const game = await (await fetch(`/api/v1/games/${encodeURIComponent(this.slug)}`, { headers: this.headers() })).json();
      const leaderboardId = game && game.leaderboardId;
      if (!leaderboardId) return null;
      const res = await fetch(`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?page=1&pageSize=20`, { headers: this.headers() });
      if (!res.ok) return null;
      const j = await res.json();
      const raw = (j.entries || j.items) || [];
      return Promise.all(raw.slice(0, 20).map(async (e) => {
        const uid = e.userId != null ? e.userId : e.playerId;
        const name = uid ? await this.profileFor(String(uid)) : (e.name || 'player');
        return { name, score: e.score != null ? e.score : e.value, you: String(uid || '') === this.userId };
      }));
    } catch {
      return null;
    }
  },
};
