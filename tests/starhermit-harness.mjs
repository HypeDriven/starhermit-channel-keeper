// starhermit-harness.mjs — loads the game's copy of starhermit-sdk.js in node
// with a fake launch fragment and a stubbed fetch, for adapter unit tests.

import { readFileSync } from 'node:fs';

export const UID = 'u-1234567890';

export function loadSdkFactory() {
  const src = readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

export function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return enc({ alg: 'none' }) + '.' + enc(claims) + '.sig';
}

export function resp(status, body, bytes) {
  return {
    status, ok: status >= 200 && status < 300, statusText: String(status),
    headers: { get: () => null },
    text: async () => (body == null ? '' : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    blob: async () => null,
  };
}

export function fakeWindow(hash) {
  const listeners = {};
  return {
    location: { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    listeners,
  };
}

/**
 * Hosted environment: a stub fetch serving profile, cloud save (game:<slug>),
 * settings KV and controls. `extra(path, method, init)` may answer other routes.
 */
export function hostedEnv(slug, extra) {
  const calls = [];
  let saved = null;
  let settings = { seeded: { fromPlatform: true } };
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, init });
    const path = String(url);
    if (path === `/api/v1/users/${UID}/profile`) return resp(200, { nickname: 'Ada' });
    if (path === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + slug)}`) {
      if (method === 'PUT') { saved = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return resp(204, null); }
      return saved ? resp(200, null, new Uint8Array(saved)) : resp(404, null);
    }
    if (path === `/api/v1/games/${slug}/settings`) {
      if (method === 'PATCH') { settings = { ...settings, ...JSON.parse(init.body).settings }; return resp(200, { settings }); }
      return resp(200, { settings });
    }
    if (path === `/api/v1/games/${slug}/controls`) return resp(200, { actions: [] });
    if (extra) { const r = await extra(path, method, init); if (r) return r; }
    return resp(404, null);
  };
  return { calls, fetchStub, get saved() { return saved; }, get settings() { return settings; } };
}

function installDom(win) {
  globalThis.window = win;
  globalThis.document = {
    hidden: false, addEventListener() {}, removeEventListener() {},
    documentElement: { lang: 'en-US' },
  };
}

/** Install a hosted SDK as globalThis.StarHermit; returns { sdk, env, win }. */
export function installHosted(slug, opts = {}) {
  const env = hostedEnv(slug, opts.extra);
  const win = fakeWindow('#game_token=' + jwt({ sub: UID, game_scope: slug, exp: Math.floor(Date.now() / 1000) + 3600 }) + '&session_id=s1');
  installDom(win);
  const sdk = loadSdkFactory().create({ window: win, fetch: env.fetchStub, setTimeout: opts.realTimers ? setTimeout : () => 0, clearTimeout: opts.realTimers ? clearTimeout : () => {} });
  globalThis.StarHermit = sdk.init();
  return { sdk, env, win };
}

/** Install a standalone SDK; every fetch (SDK or global) is recorded. */
export function installStandalone() {
  const calls = [];
  const win = fakeWindow('');
  installDom(win);
  const sdk = loadSdkFactory().create({ window: win, fetch: async (u) => { calls.push(String(u)); return resp(500, null); } });
  globalThis.StarHermit = sdk.init();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('network'); };
  return { sdk, calls, restore() { globalThis.fetch = realFetch; } };
}
