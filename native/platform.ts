// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey, challenge and daily records, counters), achievements,
//   the local score-chase boards and the finished lessons are the game's save
//   (starhermit:storage `saves`): { v: 1, progress, achievements, boards,
//   tutorialsDone } on the device and in the player's cloud slot, two
//   devices' copies merged on a conflict (js/migrate.js mergeDocs →
//   js/storage.js mergeRecords). The slot the browser build wrote (the JS
//   SDK's save.json: the same records plus its settings) shows as foreign
//   and is merged in and replaced once;
// - js/storage.js keeps reading and writing `localStorage`: here a shim
//   whose record keys (channelkeeper.progress / achievements / boards) are
//   that document (a write saves it) and whose other keys (the interrupted
//   round's snapshot) are the device's starhermit:storage, as the browser
//   build kept them;
// - the game's own settings (colour palette, left-handed layout, hold to
//   dig, timing assist, haptics, camera view) are `settings` (game.<key>,
//   synced with the account); the browser build's settings keys are
//   migrated, then removed;
// - the player's name, the invite link, posting a finished ranked round's
//   total to the high-score board through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) and its rank, and the platform's clock for the daily.
//
// The browser build's own-server routes (server.js: replay-validated daily
// submission and board, telemetry) were for local development hosting and
// only ever called when that server answered; they are not called here.
import type { JsonValue } from "starhermit:engine";
import { connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions } from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import * as M from "../js/migrate.js";
import { wrap, unwrap } from "../js/storage.js";

export type Doc = ReturnType<typeof M.normalize>;
type Part = "progress" | "achievements" | "boards";

// --- the save and the localStorage shim ----------------------------------------------------
const PREFIX = "channelkeeper.";
const RECORDS: Record<string, Part> = { "channelkeeper.progress": "progress", "channelkeeper.achievements": "achievements", "channelkeeper.boards": "boards" };

let doc: Doc = M.normalize({});
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

export function getDoc(): Doc { return doc; }
/** Writes the save (device at once, the account debounced by the runtime). */
export function persist(): void {
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}

const shim = {
  getItem(key: string): string | null {
    const part = RECORDS[key];
    if (part) return JSON.stringify(wrap(doc[part]));
    try { return storage.getText(key); } catch { return null; }
  },
  setItem(key: string, value: string): void {
    const part = RECORDS[key];
    if (part) {
      const data = unwrap(String(value));
      if (data == null) return;
      (doc as Record<Part, unknown>)[part] = data;
      doc = M.normalize(doc);
      persist();
      return;
    }
    try { storage.set(key, String(value)); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key: string): void {
    if (RECORDS[key]) return;
    try { storage.remove(key); } catch { /* gone */ }
  },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

/** Settings › Erase local progress (the browser build's localStorage.clear()): the save emptied, the device's keys removed. */
export function eraseAll(): void {
  doc = M.normalize({});
  persist();
  try { for (const k of storage.keys()) if (k.startsWith(PREFIX)) storage.remove(k); } catch { /* best effort */ }
  merged();
}

/** Takes a document in (merged with what this device has); whether it changed. */
function adopt(other: Doc | null): boolean {
  if (!other) return false;
  const before = JSON.stringify(doc);
  const next = M.mergeDocs(other, doc);
  if (JSON.stringify(next) === before) return false;
  doc = next;
  return true;
}

saves.onConflict((local, remote) => ({
  merged: M.mergeDocs(M.docFromSave(remote.data), M.docFromSave(local?.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(M.docFromSave(cur.data))) { persist(); merged(); }
  }
});

/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const { doc: d, settings: s } = M.fromBrowserSave(old.text);
  const changed = adopt(d);
  if (s) for (const [k, v] of Object.entries(s)) adoptSetting(k, v);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the title's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's settings -------------------------------------------------------------------
export interface Settings {
  palette: string; leftHanded: boolean; holdToCarve: boolean; timingAssist: boolean; haptics: boolean; cameraView: string;
  [key: string]: unknown;
}
export const settings: Settings = { ...M.DEFAULT_GAME_SETTINGS };
const settingsListeners = new Set<() => void>();
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }
function readSetting(key: string): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = M.checkSetting(key, v);
  if (ok !== undefined) settings[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: string, value: unknown): void {
  const v = M.checkSetting(key, value);
  if (v === undefined || store.get(key) !== undefined) return;
  try { store.set(key, v as JsonValue); settings[key] = v; settingsChanged(); } catch { /* keep the device's */ }
}
/** Changes one of the game's settings (device and account). */
export function setSetting(key: keyof Settings & string, value: boolean | string): void {
  settings[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
  settingsChanged();
}
// The browser build's per-player settings: the game's options among them carry
// over (unless this game set them since), then every one of them is removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  for (const key of keys) {
    if (!M.BROWSER_SETTING_KEYS.includes(key)) continue;
    for (const [k, v] of Object.entries(M.gameSettingsFromLegacy(key, store.legacy(key)))) adoptSetting(k, v);
    store.removeLegacy(key);
  }
}

/** Reads the device's save and the game's settings (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  const d = M.docFromSave(cur?.data);
  if (d) doc = d;
  else if (!cur) persist();
  for (const k of M.GAME_SETTING_KEYS) readSetting(k);
  store.onChange((key) => {
    if (!M.GAME_SETTING_KEYS.includes(key)) return;
    readSetting(key);
    settingsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  settingsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player ----------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number { return serverNow() ?? Date.now(); }

// --- the StarHermit high-score board -------------------------------------------------------
/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const list = await leaderboards.list();
    const b = list.find((x) => x.key === "high-score") ?? list[0];
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
