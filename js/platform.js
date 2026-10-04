// Channel Keeper — StarHermit platform adapter over window.StarHermit
// (starhermit-sdk.js, loaded and init()ed from index.html before the game
// modules). The SDK owns the launch token (#game_token / #access_token,
// memory only), renewal, profile nickname, cloud-save slot game:<slug>,
// settings KV, control bindings, leaderboards, invite link and sign-in.
// The game's own-server validated daily routes (server.js, local dev) are
// only probed when signed in. Standalone (no token) makes no requests.

const SAVE_DEBOUNCE_MS = 2000;
const sdk = () => globalThis.StarHermit || null;

// Keyboard actions — declared as control.<action> in starhermit.txt.
export const DEFAULT_BINDINGS = {
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  carve: ['Enter', 'Space'], release: ['KeyR'], undo: ['KeyU'], hint: ['KeyH'], cameraReset: ['KeyC'], pause: ['Escape'],
};
// Preferences mirrored to the settings KV (bindings go through controls).
const SYNCED_SETTINGS = ['volMaster', 'volMusic', 'volEffects', 'volAmbience', 'volVoice', 'muted', 'quality', 'gfx',
  'reducedMotion', 'palette', 'highContrast', 'largeText', 'leftHanded', 'holdToCarve', 'timingAssist', 'haptics', 'cameraView'];
const cloneBindings = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.slice()]));
const KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };

export const platform = {
  ownServer: false,    // the game's own dev backend answered /time
  profile: null,       // { name } for the signed-in player
  sync: 'offline',     // offline | saving | synced (cloud mirror)
  bindings: cloneBindings(DEFAULT_BINDINGS),
  _codeMap: null,
  _timeOffset: 0,
  _syncListeners: [],
  _authListeners: [],
  _hooked: false,
  _settingsLoaded: false,
  _lastSettings: null,
  _settingsTimer: null,

  get token() { const s = sdk(); return s ? s.token : null; },
  get userId() { const s = sdk(); return s ? s.userId : null; },
  get slug() { const s = sdk(); return s ? s.slug : null; },
  get hosted() { const s = sdk(); return !!(s && s.signedIn); },

  headers(extra) {
    const h = extra || {};
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  },

  async init() {
    const s = sdk();
    if (s && !this._hooked) {
      this._hooked = true;
      s.on('saved', (ok) => this._setSync(ok ? 'synced' : 'offline'));
      s.on('auth', (a) => {
        if (!a.signedIn) { this.profile = null; this.ownServer = false; this._setSync('offline'); }
        for (const fn of this._authListeners) { try { fn(a); } catch { /* ignore */ } }
      });
    }
    if (this.hosted) {
      try {
        window.addEventListener('pagehide', () => this.flushSave());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushSave(); });
      } catch { /* no window events available */ }
      this.fetchProfile().catch(() => {});
    }
    return { hosted: this.hosted };
  },
  onAuth(fn) { if (typeof fn === 'function') this._authListeners.push(fn); },
  canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); },
  signIn() { const s = sdk(); return !!(s && s.signIn()); },
  inviteLink() { const s = sdk(); return s && s.signedIn ? s.inviteLink() : null; },
  async copyInvite() {
    const link = this.inviteLink();
    if (!link) return false;
    try { await navigator.clipboard.writeText(link); return true; } catch { return false; }
  },
  refreshToken() { const s = sdk(); return s ? s.refresh() : Promise.resolve(null); },

  /* Identity: the profile nickname (never /api/v1/me, never usernames). */
  profileFor(userId) {
    if (!userId || typeof userId !== 'string') return Promise.resolve('player');
    const s = sdk();
    if (!s || !s.signedIn) return Promise.resolve('Player ' + userId.slice(0, 6));
    return s.profile(userId).then((p) => (p && p.displayName) || 'Player ' + userId.slice(0, 6))
      .catch(() => 'Player ' + userId.slice(0, 6));
  },
  async fetchProfile() {
    if (!this.userId) return null;
    const name = (await this.profileFor(this.userId)).slice(0, 40);
    this.profile = { name };
    return this.profile;
  },

  /* Server time from the own backend (signed in only); local clock otherwise. */
  async syncTime() {
    if (!this.hosted) return false;
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

  /* Cloud save: the SDK slot game:<slug> holds the {settings, progress,
   * achievements, boards} records. Remote wins on boot; saves debounce ~2 s
   * and flush on pagehide/hidden; localStorage stays the offline cache. */
  async loadCloud() {
    if (!this.hosted) return null;
    try { return await sdk().loadJSON(); } catch { return null; }
  },
  saveCloud(doc) {
    if (!this.hosted) return Promise.resolve(false);
    this._setSync('saving');
    sdk().saveJSON(doc, SAVE_DEBOUNCE_MS);
    return Promise.resolve(true);
  },
  flushSave() {
    if (!this.hosted) return Promise.resolve(false);
    return sdk().flushSave(true);
  },
  onSync(fn) { if (typeof fn === 'function') this._syncListeners.push(fn); },
  _setSync(state) {
    if (this.sync === state) return;
    this.sync = state;
    for (const fn of this._syncListeners) {
      try { fn(state); } catch { /* listener errors never break the adapter */ }
    }
  },

  /* Settings KV: preferences only; the platform value wins at boot. */
  async getSettings() {
    if (!this.hosted) return {};
    let kv = {};
    try { kv = (await sdk().getSettings()) || {}; } catch { kv = {}; }
    this._settingsLoaded = true;
    const out = {};
    for (const k of SYNCED_SETTINGS) if (kv[k] !== undefined && kv[k] !== null) out[k] = kv[k];
    return out;
  },
  /** Debounced patch of changed preferences (only after the KV was read). */
  mirrorSettings(settings) {
    if (!this.hosted || !this._settingsLoaded) return;
    const patch = {};
    for (const k of SYNCED_SETTINGS) if (settings[k] !== undefined) patch[k] = settings[k];
    const json = JSON.stringify(patch);
    if (json === this._lastSettings) return;
    clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => {
      this._lastSettings = json;
      sdk().patchSettings(patch).catch(() => {});
    }, 800);
  },

  /* Controls: platform overrides over DEFAULT_BINDINGS. */
  async loadBindings() {
    const s = sdk();
    if (s && s.signedIn) {
      try { this.bindings = await s.loadBindings(DEFAULT_BINDINGS); } catch { /* defaults */ }
    }
    this._codeMap = null;
    return this.bindings;
  },
  actionFor(e) {
    if (!this._codeMap) {
      this._codeMap = {};
      for (const [a, codes] of Object.entries(this.bindings)) for (const c of codes) this._codeMap[c] = a;
    }
    return this._codeMap[e.code] || null;
  },
  keyLabel(action) {
    return (this.bindings[action] || []).map((c) => KEY_NAMES[c] || c.replace(/^Key|^Digit/, '')).join(' / ');
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
};
