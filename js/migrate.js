// migrate.js — the engine client's save document and what the browser build
// left in the player's account (pure: no storage, importable in node).
//  - The engine save (starhermit:storage `saves`) is { v: 1, progress,
//    achievements, boards, tutorialsDone }: the browser build's cloud
//    document without its settings (those are the runtime's Options and the
//    game's own settings now), plus the finished lessons, which the browser
//    build kept in its settings. Two devices' copies merge with storage.js's
//    mergeRecords (journey and challenge records at their best, every daily,
//    the larger counters, every achievement with its earliest unlock, both
//    local boards) and the union of the finished lessons.
//  - The browser build's cloud save (slot game:channel-keeper, the JS SDK's
//    zipped save.json) is { settings, progress, achievements, boards }; the
//    engine shows it as a foreign save whose text this reads.
//  - Settings: the browser build kept its whole settings object in the save
//    and its preferences as flat keys in the account's per-player settings.
//    The game's own options carry over (colour palette, left-handed layout,
//    hold to dig, timing assist, haptics, camera view); volumes, mute,
//    graphics quality and overrides, reduced motion, high contrast and larger
//    text are the runtime's Options now and are dropped.

import { DEFAULT_PROGRESS, mergeRecords } from './storage.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const clone = (v) => JSON.parse(JSON.stringify(v));
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** A document with every part present. */
export function normalize(doc) {
  const d = obj(doc) || {};
  const progress = { ...clone(DEFAULT_PROGRESS), ...(obj(d.progress) || {}) };
  for (const k of ['journeyCompleted', 'journeyBest', 'challengesCompleted', 'daily']) if (!obj(progress[k])) progress[k] = {};
  if (!Array.isArray(progress.dailyDays)) progress.dailyDays = [];
  const boards = {};
  for (const [id, list] of Object.entries(obj(d.boards) || {})) if (Array.isArray(list)) boards[id] = list.filter(obj);
  return {
    v: 1,
    progress,
    achievements: { ...(obj(d.achievements) || {}) },
    boards,
    tutorialsDone: [...new Set(strings(d.tutorialsDone))],
  };
}

/** The progress document in an engine save, or null. */
export function docFromSave(data) {
  const d = obj(data);
  return d && d.v === 1 ? normalize(d) : null;
}

/** The browser build's cloud save text → { doc, settings } (either may be null). */
export function fromBrowserSave(text) {
  if (typeof text !== 'string') return { doc: null, settings: null };
  let d;
  try { d = JSON.parse(text); } catch { return { doc: null, settings: null }; }
  if (!obj(d)) return { doc: null, settings: null };
  const s = obj(d.settings);
  const has = d.progress || d.achievements || d.boards || (s && Array.isArray(s.tutorialsDone));
  const doc = has ? normalize({ progress: d.progress, achievements: d.achievements, boards: d.boards, tutorialsDone: s ? s.tutorialsDone : [] }) : null;
  return { doc, settings: s ? gameSettingsFrom(s) : null };
}

/** Two documents merged (either may be null), keeping the better of every record. */
export function mergeDocs(a, b) {
  if (!a && !b) return normalize({});
  if (!a) return normalize(b);
  if (!b) return normalize(a);
  const x = normalize(a), y = normalize(b);
  const m = mergeRecords(x, y);
  return normalize({ ...m, tutorialsDone: [...x.tutorialsDone, ...y.tutorialsDone] });
}

// ---------------------------------------------------------------- settings

const bool = (v) => typeof v === 'boolean';
/** The game's own settings (game.<key> in the runtime's settings) with their checks. */
export const GAME_SETTINGS = {
  palette: (v) => ['default', 'deuteranopia', 'protanopia', 'tritanopia', 'contrast'].includes(v),
  leftHanded: bool,
  holdToCarve: bool,
  timingAssist: bool,
  haptics: bool,
  cameraView: (v) => v === 'fit' || v === 'close',
};
export const GAME_SETTING_KEYS = Object.keys(GAME_SETTINGS);
export const DEFAULT_GAME_SETTINGS = Object.freeze({
  palette: 'default', leftHanded: false, holdToCarve: true, timingAssist: false, haptics: true, cameraView: 'fit',
});
/** The per-player settings keys the browser build wrote (platform.js SYNCED_SETTINGS). */
export const BROWSER_SETTING_KEYS = ['volMaster', 'volMusic', 'volEffects', 'volAmbience', 'volVoice', 'muted', 'quality', 'gfx',
  'reducedMotion', 'palette', 'highContrast', 'largeText', 'leftHanded', 'holdToCarve', 'timingAssist', 'haptics', 'cameraView'];

/** A value for one of the game's settings, or undefined when it is not one. */
export function checkSetting(key, value) {
  const check = GAME_SETTINGS[key];
  return check && check(value) ? value : undefined;
}

/** The game's settings found in a browser-build settings object. */
export function gameSettingsFrom(settings) {
  const s = obj(settings) || {};
  const out = {};
  for (const k of GAME_SETTING_KEYS) if (checkSetting(k, s[k]) !== undefined) out[k] = s[k];
  return out;
}

/** The game's settings in one of the browser build's per-player settings keys. */
export function gameSettingsFromLegacy(key, value) {
  return checkSetting(key, value) !== undefined ? { [key]: value } : {};
}
