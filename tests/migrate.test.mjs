// The engine client's save: the browser build's cloud save (foreign, the JS
// SDK's save.json) and settings migrate into it; two devices' saves merge
// keeping the better of each record; js/storage.js keeps working over the
// localStorage shim whose record keys are that document (native/platform.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/migrate.js';

// The browser build's cloud document, as platform.saveCloud wrote it.
const BROWSER = JSON.stringify({
  settings: { volMaster: 0.5, quality: 'high', gfx: { bloom: 'off' }, palette: 'tritanopia', holdToCarve: false, cameraView: 'close',
    highContrast: true, haptics: 'yes', tutorialsDone: ['tut-1', 'tut-2'] },
  progress: { journeyCompleted: { 'journey-1': { score: 300, won: true } }, journeyBest: { 'journey-1': 300 }, daily: {}, dailyDays: [],
    totalCleanWater: 16, cleanWins: 1, sessionsPlayed: 4 },
  achievements: { first_flow: 1700000000000 },
  boards: { journey: [{ name: 'You', score: 300, sessionId: 's1', durationTicks: 29 }] },
});

test('the browser build cloud save becomes the engine document and the game settings', () => {
  const { doc, settings } = M.fromBrowserSave(BROWSER);
  assert.equal(doc.v, 1);
  assert.equal(doc.progress.journeyCompleted['journey-1'].score, 300);
  assert.equal(doc.progress.sessionsPlayed, 4);
  assert.deepEqual(doc.achievements, { first_flow: 1700000000000 });
  assert.equal(doc.boards.journey.length, 1);
  assert.deepEqual(doc.tutorialsDone, ['tut-1', 'tut-2']);
  // only the game's own options carry over, and only valid values
  assert.deepEqual(settings, { palette: 'tritanopia', holdToCarve: false, cameraView: 'close' });
  assert.deepEqual(M.fromBrowserSave('not json'), { doc: null, settings: null });
  assert.deepEqual(M.fromBrowserSave(null), { doc: null, settings: null });
});

test('legacy per-player settings keys map to the game settings they still are', () => {
  assert.deepEqual(M.gameSettingsFromLegacy('palette', 'deuteranopia'), { palette: 'deuteranopia' });
  assert.deepEqual(M.gameSettingsFromLegacy('palette', 'neon'), {});
  assert.deepEqual(M.gameSettingsFromLegacy('volMaster', 0.4), {});
  assert.deepEqual(M.gameSettingsFromLegacy('leftHanded', true), { leftHanded: true });
  assert.ok(M.BROWSER_SETTING_KEYS.includes('quality'));
  for (const k of M.GAME_SETTING_KEYS) assert.ok(M.BROWSER_SETTING_KEYS.includes(k), k);
});

test('engine saves round-trip and two devices merge to the better of each record', () => {
  assert.equal(M.docFromSave({ v: 2 }), null);
  assert.equal(M.docFromSave(null), null);
  const a = M.normalize({
    progress: { journeyCompleted: { a: { score: 50, won: true } }, journeyBest: { a: 50 }, daily: { d: { score: 10, won: true } }, dailyDays: ['d'], totalCleanWater: 40, cleanWins: 2, sessionsPlayed: 3 },
    achievements: { first_flow: 500 }, boards: { journey: [{ score: 5, sessionId: 's1', durationTicks: 9 }] }, tutorialsDone: ['tut-1'],
  });
  const b = M.normalize({
    progress: { journeyCompleted: { a: { score: 80, won: true }, b: { score: 20, won: true } }, journeyBest: { a: 80 }, daily: { e: { score: 7, won: true } }, dailyDays: ['e'], totalCleanWater: 90, cleanWins: 1, sessionsPlayed: 7 },
    achievements: { first_flow: 100, streak_3: 300 }, boards: { journey: [{ score: 9, sessionId: 's2', durationTicks: 9 }, { score: 5, sessionId: 's1', durationTicks: 9 }] }, tutorialsDone: ['tut-2', 'tut-1'],
  });
  assert.deepEqual(M.docFromSave(JSON.parse(JSON.stringify(a))), a);
  const m = M.mergeDocs(a, b);
  assert.equal(m.progress.journeyCompleted.a.score, 80);
  assert.ok(m.progress.journeyCompleted.b.won);
  assert.equal(m.progress.journeyBest.a, 80);
  assert.deepEqual(Object.keys(m.progress.daily).sort(), ['d', 'e']);
  assert.deepEqual(m.progress.dailyDays, ['d', 'e']);
  assert.equal(m.progress.totalCleanWater, 90);
  assert.equal(m.progress.cleanWins, 2);
  assert.equal(m.progress.sessionsPlayed, 7);
  assert.deepEqual(m.achievements, { first_flow: 100, streak_3: 300 });
  assert.deepEqual(m.boards.journey.map((e) => e.sessionId), ['s2', 's1']);
  assert.deepEqual(m.tutorialsDone.sort(), ['tut-1', 'tut-2']);
  assert.deepEqual(M.mergeDocs(null, null), M.normalize({}));
  assert.deepEqual(M.mergeDocs(a, null), a);
});

test('js/storage.js reads and writes the document through the localStorage shim', async () => {
  // native/platform.ts's shim: record keys are the document's parts (wrapped as storage.js expects), others the device's.
  const S = await import('../js/storage.js');
  let doc = M.normalize({});
  const device = new Map();
  const RECORDS = { 'channelkeeper.progress': 'progress', 'channelkeeper.achievements': 'achievements', 'channelkeeper.boards': 'boards' };
  globalThis.localStorage = {
    getItem: (k) => (RECORDS[k] ? JSON.stringify(S.wrap(doc[RECORDS[k]])) : device.get(k) ?? null),
    setItem: (k, v) => { if (RECORDS[k]) { const d = S.unwrap(v); if (d != null) doc = M.normalize({ ...doc, [RECORDS[k]]: d }); } else device.set(k, v); },
    removeItem: (k) => { if (!RECORDS[k]) device.delete(k); },
  };
  try {
    assert.equal(S.unlockAchievement('first_flow'), true);
    assert.equal(S.unlockAchievement('first_flow'), false);
    assert.ok(doc.achievements.first_flow > 0);
    assert.equal(S.submitScore('journey', { score: 10, sessionId: 'x', durationTicks: 5 }), 0);
    assert.equal(doc.boards.journey[0].sessionId, 'x');
    S.saveSessionSnapshot({ levelId: 'journey-1', state: { tick: 3 } });
    assert.equal(S.loadSessionSnapshot().levelId, 'journey-1');
    assert.ok(device.has('channelkeeper.session'));
    S.clearSessionSnapshot();
    assert.equal(S.loadSessionSnapshot(), null);
    assert.equal(S.loadProgress().sessionsPlayed, 0);
  } finally { delete globalThis.localStorage; }
});
