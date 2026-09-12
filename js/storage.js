// Channel Keeper — local persistence: settings, progression, achievements,
// last safe session snapshot. All documents are versioned + checksummed.
// No credentials or tokens are ever stored here.

const PREFIX = 'channelkeeper.';
const VERSION = 1;

function checksum(obj) {
  const str = JSON.stringify(obj);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function wrap(data) {
  return { v: VERSION, data, sum: checksum(data) };
}

function unwrap(raw) {
  try {
    const doc = JSON.parse(raw);
    if (!doc || doc.v !== VERSION || !doc.data) return null;
    if (checksum(doc.data) !== doc.sum) return null; // corrupted/tampered
    return doc.data;
  } catch {
    return null;
  }
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const data = unwrap(raw);
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

let _recordsListener = null;
// The platform adapter registers here to mirror the save records to the
// cloud slot (debounced there); called after every settings/progress/
// achievements/boards write.
export function onRecordsChange(fn) { _recordsListener = fn; }

function write(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(wrap(data)));
    if (_recordsListener && (key === 'settings' || key === 'progress' || key === 'achievements' || key === 'boards')) {
      try { _recordsListener(); } catch { /* mirror errors never break saves */ }
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  // audio buses
  volMaster: 0.8, volMusic: 0.6, volEffects: 0.9, volAmbience: 0.5, volVoice: 0.8,
  muted: false,
  // graphics
  quality: 'auto',            // auto | low | medium | high
  reducedMotion: false,
  // accessibility
  palette: 'default',         // default | deuteranopia | protanopia | tritanopia | contrast
  highContrast: false,
  largeText: false,
  leftHanded: false,
  holdToCarve: true,          // hold/drag vs toggle tap mode
  timingAssist: false,        // slower flow tick rate
  haptics: true,
  // gameplay
  cameraView: 'fit',          // fit | close
  tutorialsDone: [],
  // input overrides: action -> KeyboardEvent.code
  bindings: {
    carve: 'Enter', release: 'KeyR', undo: 'KeyU', pause: 'Escape',
    hint: 'KeyH', cameraReset: 'KeyC',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    altUp: 'KeyW', altDown: 'KeyS', altLeft: 'KeyA', altRight: 'KeyD',
  },
};

export function loadSettings() {
  const s = read('settings', {});
  const merged = Object.assign({}, DEFAULT_SETTINGS, s);
  merged.bindings = Object.assign({}, DEFAULT_SETTINGS.bindings, s.bindings || {});
  return merged;
}

export function saveSettings(settings) {
  return write('settings', settings);
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

export const DEFAULT_PROGRESS = {
  journeyCompleted: {},       // levelId -> { score, won }
  journeyBest: {},            // levelId -> best total score
  challengesCompleted: {},
  daily: {},                  // dailyKey -> { score, won, clean }
  dailyDays: [],              // distinct UTC days played (for streak)
  practicePlayed: 0,
  totalCleanWater: 0,
  cleanWins: 0,               // wins with zero contamination
  sessionsPlayed: 0,
};

export function loadProgress() {
  return Object.assign({}, DEFAULT_PROGRESS, read('progress', {}));
}

export function saveProgress(progress) {
  return write('progress', progress);
}

// ---------------------------------------------------------------------------
// Achievements (idempotent unlocks)
// ---------------------------------------------------------------------------

export function loadAchievements() {
  return read('achievements', {}); // key -> unix ms
}

export function saveAchievements(all) {
  return write('achievements', all || {});
}

export function unlockAchievement(key) {
  const all = loadAchievements();
  if (all[key]) return false; // idempotent
  all[key] = Date.now();
  write('achievements', all);
  return true;
}

// ---------------------------------------------------------------------------
// Session snapshot (resume after interruption) — "last safe local snapshot"
// ---------------------------------------------------------------------------

export function saveSessionSnapshot(snapshotObj) {
  return write('session', snapshotObj);
}

export function loadSessionSnapshot() {
  return read('session', null);
}

export function clearSessionSnapshot() {
  try { localStorage.removeItem(PREFIX + 'session'); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Local leaderboards (score chase): per-board arrays of entries.
// entry: { name, score, levelId, seed, ruleset, assists, durationTicks, sessionId, when }
// ---------------------------------------------------------------------------

export function loadBoards() {
  return read('boards', {});
}

export function saveBoards(boards) {
  return write('boards', boards);
}

export function submitScore(boardId, entry, maxEntries = 50) {
  const boards = loadBoards();
  const list = boards[boardId] || [];
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.durationTicks - b.durationTicks ||
    String(a.sessionId).localeCompare(String(b.sessionId)));
  boards[boardId] = list.slice(0, maxEntries);
  write('boards', boards);
  return boards[boardId].indexOf(entry);
}
