// Channel Keeper — bootstrap + application controller.
// Owns: lifecycle, screen flow, input (pointer/touch/keyboard/gamepad),
// HUD, accessibility mirror, progression, achievements, boards, telemetry.

import { CELL, PHASE } from './rules.js';
import {
  TUTORIALS, JOURNEY, CHALLENGES, PRACTICE_DIFFICULTIES, ACHIEVEMENTS,
  dailyLevel, dailyKey, practiceLevel, findRoute, getTheme, CONTENT_VERSION,
} from './content.js';
import { Session } from './session.js';
import {
  loadSettings, saveSettings, loadProgress, saveProgress,
  loadAchievements, unlockAchievement, loadSessionSnapshot,
  submitScore, loadBoards,
} from './storage.js';
import { AudioEngine } from './audio.js';
import { $, $$, showScreen, openOverlay, closeOverlay, anyOverlayOpen, topOverlay,
  announce, toast, caption, fmtInt } from './ui.js';

// ---------------------------------------------------------------- bootstrap

const settings = loadSettings();
const progress = loadProgress();
const audio = new AudioEngine(settings);
audio.onCaption = caption;

let renderer = null;
let fallbackMode = false;
let serverOffset = 0; // ms; round-trip-adjusted server time offset

const now = () => new Date(Date.now() + serverOffset);

function track(event, data = {}) {
  // Anonymous funnel events only: start, tutorial_step, round_end, retry,
  // settings_change, error. Fire-and-forget; never blocks play.
  try {
    const body = JSON.stringify({ event, ...data, t: Date.now() });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/v1/events', body);
  } catch { /* offline is fine */ }
}

async function syncServerTime() {
  try {
    const t0 = Date.now();
    const r = await fetch('/api/v1/time', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const t1 = Date.now();
    const serverMs = typeof j.now === 'number' ? j.now : Date.parse(j.now || j.time);
    if (Number.isFinite(serverMs)) serverOffset = serverMs + (t1 - t0) / 2 - t1;
  } catch { /* offline: local clock */ }
}

function heartbeat() {
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/api/v1/presence', '{}');
  } catch { /* ignore */ }
}
setInterval(() => { if (game.session && game.session.phase !== PHASE.EDITING) heartbeat(); }, 30000);

// ---------------------------------------------------------------- game state

const game = {
  session: null,
  level: null,
  mode: null,          // learn | journey | daily | practice | challenge
  cursor: { x: 0, y: 0 },
  drag: { active: false, lastCell: null, pointerId: null, downAt: 0, downX: 0, downY: 0, moved: false },
  tutStep: 0,
  watching: false,
  watchTimer: null,
  gamepadPrev: {},
};

// ---------------------------------------------------------------- renderer

async function initRenderer() {
  try {
    const { BoardRenderer } = await import('./render.js');
    renderer = new BoardRenderer($('#playfield'), settings);
    if (renderer.contextLost) throw new Error('no context');
    renderer.onContextLost = (lost) => {
      if (lost) toast('Graphics context lost — recovering…');
      else { toast('Graphics recovered.'); if (game.session) fullSync(); }
    };
    const q = settings.quality === 'auto' ? detectQuality() : settings.quality;
    renderer.setQuality(q);
    renderer.setReducedMotion(settings.reducedMotion);
  } catch (err) {
    console.warn('WebGL unavailable, using DOM fallback', err);
    fallbackMode = true;
    $('#canvas-fallback').hidden = false;
    track('error', { category: 'webgl' });
  }
}

function detectQuality() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 800;
  return coarse || small ? 'low' : 'high';
}

// ---------------------------------------------------------------- level flow

function startLevel(level, mode, { resume = false } = {}) {
  stopWatch();
  game.level = level;
  game.mode = mode;
  game.tutStep = 0;

  let session = null;
  if (resume) session = Session.restore(level, sessionOpts());
  if (!session) session = new Session(level, sessionOpts());
  game.session = session;

  if (renderer) {
    renderer.loadLevel(level, level.theme);
    fullSync();
  }
  buildFallbackGrid();
  buildMirror();

  // Cursor starts below the source.
  const si = level.cells.indexOf(CELL.SOURCE);
  game.cursor = { x: si % level.w, y: Math.min(level.h - 1, Math.floor(si / level.w) + 1) };
  updateCursor();

  $('#hud-objective').textContent = level.goal || 'Deliver clean water to the well.';
  $('#btn-skip').hidden = true;
  setupTutorialPanel();
  updateHUD();
  showScreen('game');
  applyCompactRails();
  // The playfield only has measurable size once visible.
  requestAnimationFrame(() => { renderer?.resize(); fullSync(); });

  if (resume && session.state.tick > 0) {
    // "While you were away" summary after restoring a snapshot.
    toast(`Welcome back — ${session.state.deliveredClean} units delivered, tick ${session.state.tick} when you left.`);
  }
  announce(`${level.name}. ${level.goal || ''} Dig budget ${level.carveBudget}.`);
  track('start', { mode, levelId: level.id });
  audio.event('select');
}

function sessionOpts() {
  return {
    mode: game.mode,
    settings,
    seed: game.level.seed,
    onEvents: handleEvents,
    onTerminal: handleTerminal,
  };
}

function fullSync() {
  if (!renderer || !game.session) return;
  renderer.syncState(game.session.state, null, 1);
}

function handleEvents(events, state) {
  for (const e of events) {
    switch (e.t) {
      case 'carve':
        audio.event(e.hard ? 'carveHard' : 'carve');
        announceCell(e.x, e.y);
        advanceTutorial('carve');
        break;
      case 'release':
        audio.event('release');
        announce('Water released.');
        $('#btn-skip').hidden = false;
        advanceTutorial('release');
        break;
      case 'deliver':
        audio.event('deliver');
        break;
      case 'contaminate':
        audio.event('contaminate');
        announce('Water fouled by a contaminant pocket!', true);
        break;
      case 'undo':
        audio.event('undo');
        break;
      case 'end':
        break; // handled by onTerminal
    }
  }
  if (renderer) renderer.events(events, state);
  updateHUD();
  updateMirror();
  updateFallback();
  updateCursor();
}

function handleTerminal(results) {
  audio.event(results.won ? 'win' : 'lose');
  $('#btn-skip').hidden = true;
  applyResults(results);
  showResults(results);
  track('round_end', { mode: game.mode, won: results.won, reason: results.reason });
}

// ---------------------------------------------------------------- results

let lastResults = null;

function applyResults(r) {
  lastResults = r;
  const unlocked = [];
  const unlock = (key) => { if (unlockAchievement(key)) { unlocked.push(key); audio.event('achievement'); } };

  if (r.won) {
    progress.totalCleanWater += r.deliveredClean;
    if (r.deliveredDirty === 0) progress.cleanWins++;
    unlock('first_flow');

    if (game.mode === 'journey') {
      const prevBest = progress.journeyBest[r.levelId] || 0;
      progress.journeyBest[r.levelId] = Math.max(prevBest, r.score.total);
      progress.journeyCompleted[r.levelId] = { score: r.score.total, won: true };
      const done = Object.keys(progress.journeyCompleted).length;
      if (done >= 20) unlock('milestone_20');
    }
    if (game.mode === 'learn') {
      if (!settings.tutorialsDone.includes(r.levelId)) {
        settings.tutorialsDone.push(r.levelId);
        saveSettings(settings);
      }
      track('tutorial_step', { levelId: r.levelId, done: true });
      if (TUTORIALS.every((t) => settings.tutorialsDone.includes(t.id))) unlock('mechanic_mastery');
    }
    if (game.mode === 'daily') {
      const key = game.level.dailyKey || dailyKey(now());
      progress.daily[key] = { score: r.score.total, won: true, clean: r.deliveredClean };
      if (!progress.dailyDays.includes(key)) progress.dailyDays.push(key);
      if (progress.dailyDays.length >= 3) unlock('streak_3');
    }
    if (game.mode === 'challenge') {
      progress.challengesCompleted[r.levelId] = { score: r.score.total };
    }
    if (progress.totalCleanWater >= 500) unlock('long_haul');
    if (progress.cleanWins >= 10) unlock('purity_10');

    // Ranked-ish boards: daily, journey, challenge (practice stays off).
    if (game.mode !== 'practice' && game.mode !== 'learn') {
      submitScore(boardId(), {
        name: 'You', score: r.score.total, levelId: r.levelId, seed: r.seed,
        ruleset: `rules-v${CONTENT_VERSION}`, assists: assistsUsed(),
        durationTicks: r.tick, sessionId: r.sessionId, when: Date.now(),
      });
    }
  }
  progress.sessionsPlayed++;
  saveProgress(progress);
  refreshTitleStats();
}

function assistsUsed() {
  const a = [];
  if (settings.timingAssist) a.push('timing');
  if (game.session?.state.mechanics.undoAllowed) a.push('undo');
  return a.join('+') || 'none';
}

function boardId() {
  if (game.mode === 'daily') return `daily-${game.level.dailyKey || dailyKey(now())}`;
  if (game.mode === 'challenge') return `challenge-${game.level.id}`;
  return 'journey';
}

function showResults(r) {
  $('#results-h').textContent = r.won ? 'Well filled!' : 'The water is spent';
  $('#results-reason').textContent = {
    'target-filled': 'The well drank its fill of clean water.',
    'settled-dry': 'The water settled before reaching the well.',
    timeout: 'Time ran out — the flood stalled.',
    abandoned: 'Round abandoned.',
  }[r.reason] || r.reason;
  $('#sc-clean').textContent = fmtInt(r.score.cleanWater);
  $('#sc-eff').textContent = fmtInt(r.score.efficiency);
  $('#sc-speed').textContent = fmtInt(r.score.speed);
  $('#sc-contam').textContent = fmtInt(r.score.contamination);
  $('#sc-total').textContent = fmtInt(r.score.total);
  $('#results-seed').textContent = `seed ${r.seed} · ruleset v${CONTENT_VERSION} · session ${r.sessionId}`;

  const progBits = [];
  if (game.mode === 'journey') {
    const done = Object.keys(progress.journeyCompleted).length;
    progBits.push(`Journey: ${done} / ${JOURNEY.length} stages complete.`);
  }
  if (game.mode === 'learn') {
    progBits.push(`Lessons: ${settings.tutorialsDone.length} / ${TUTORIALS.length}.`);
  }
  progBits.push(`${fmtInt(r.deliveredClean)} clean · ${fmtInt(r.deliveredDirty)} fouled · ${r.movesUsed} digs · tick ${r.tick}.`);
  $('#results-progress').textContent = progBits.join(' ');

  // Comparison against the local board.
  let cmp = '';
  if (game.mode !== 'practice' && game.mode !== 'learn' && r.won) {
    const board = (loadBoards()[boardId()] || []);
    const rank = board.findIndex((e) => e.sessionId === r.sessionId);
    if (rank >= 0) cmp = `Board rank #${rank + 1} of ${board.length}.`;
  } else if (game.mode === 'practice') {
    cmp = 'Practice round — unranked.';
  }
  $('#results-compare').textContent = cmp;

  // Achievements earned this round.
  const earned = ACHIEVEMENTS.filter((a) => loadAchievements()[a.key]);
  $('#results-achv').innerHTML = '';
  // Show only freshly-relevant chips: keep it simple, show earned count.
  if (earned.length) {
    const chip = document.createElement('span');
    chip.className = 'achv-chip';
    chip.textContent = `${earned.length} / ${ACHIEVEMENTS.length} achievements`;
    $('#results-achv').appendChild(chip);
  }

  // Next recommended action.
  const nextBtn = $('#btn-next-level');
  nextBtn.hidden = true;
  if (r.won && game.mode === 'journey') {
    const i = JOURNEY.findIndex((l) => l.id === r.levelId);
    if (i >= 0 && i + 1 < JOURNEY.length) {
      nextBtn.hidden = false;
      nextBtn.onclick = () => { closeOverlay('overlay-results'); startLevel(JOURNEY[i + 1], 'journey'); };
    }
  } else if (r.won && game.mode === 'learn') {
    const i = TUTORIALS.findIndex((l) => l.id === r.levelId);
    if (i >= 0 && i + 1 < TUTORIALS.length) {
      nextBtn.hidden = false;
      nextBtn.textContent = 'Next lesson';
      nextBtn.onclick = () => { closeOverlay('overlay-results'); startLevel(TUTORIALS[i + 1], 'learn'); };
    }
  }
  if (!nextBtn.hidden) nextBtn.textContent = game.mode === 'learn' ? 'Next lesson' : 'Next stage';

  openOverlay('overlay-results');
  announce(r.won ? `Round complete. Score ${r.score.total}.` : 'Round failed.', true);
}

// ---------------------------------------------------------------- HUD

const CELL_NAMES = {
  [CELL.ROCK]: 'solid rock — cannot be dug',
  [CELL.SOIL]: 'soil — dig for 1',
  [CELL.HARD]: 'packed clay — dig for 2',
  [CELL.CHANNEL]: 'open channel',
  [CELL.CONTAM]: 'foul pocket — contaminates water',
  [CELL.SOURCE]: 'the spring',
  [CELL.TARGET]: 'the well',
};

function updateHUD() {
  const s = game.session?.state;
  if (!s) return;
  const need = s.targetNeed || 1;
  $('#hud-delivered').textContent = `${fmtInt(s.deliveredClean)} / ${fmtInt(need)}`;
  $('#hud-progress').style.width = `${Math.min(100, (s.deliveredClean / need) * 100)}%`;
  $('#hud-budget').textContent = s.budget;
  $('#hud-dirty').textContent = fmtInt(s.deliveredDirty);
  $('#hud-tick').textContent = s.tick;
  const legal = game.session.legal();
  $('#btn-release').disabled = !legal.canRelease;
  $('#tray-release').disabled = !legal.canRelease;
  $('#btn-undo').disabled = !legal.canUndo;
  $('#tray-undo').disabled = !legal.canUndo;
}

function announceCell(x, y) {
  const s = game.session?.state;
  if (!s) return;
  const t = s.cells[y * s.w + x];
  announce(`Dug ${CELL_NAMES[t] === 'open channel' ? 'a channel' : ''} at row ${y + 1}, column ${x + 1}. Budget ${s.budget}.`);
}

function updateCursor() {
  const s = game.session?.state;
  if (!s) return;
  const { x, y } = game.cursor;
  const reason = game.session.explain(x, y);
  const valid = reason === null;
  if (renderer) renderer.setSelection(x, y, valid);
  const t = s.cells[y * s.w + x];
  const water = s.clean[y * s.w + x] + s.dirty[y * s.w + x];
  $('#hud-cursor').textContent = `${x + 1}, ${y + 1}`;
  $('#hud-cellinfo').textContent = `${CELL_NAMES[t] || 'unknown'}${water ? ` · ${water} water` : ''}`;
}

// ---------------------------------------------------------------- input

function tryCarve(x, y, { quiet = false } = {}) {
  const s = game.session;
  if (!s || game.watching) return false;
  const reason = s.explain(x, y);
  if (reason) {
    if (!quiet) {
      audio.event('invalid', { reason });
      toast(explainReason(reason));
      announce(`Cannot dig: ${explainReason(reason)}`, true);
      if (renderer) renderer.setGhost(x, y, false);
      vibrate(40);
    }
    return false;
  }
  const res = s.carve(x, y);
  if (res.ok) vibrate(15);
  return res.ok;
}

function explainReason(r) {
  return {
    'out-of-bounds': 'outside the dig face',
    'blocked-rock': 'solid rock cannot be dug',
    'already-open': 'already open',
    'is-source': 'that is the spring',
    'is-target': 'that is the well',
    'no-budget': 'dig budget exhausted',
    'wrong-phase': 'not while water flows (this ruleset)',
    'game-over': 'the round is over',
  }[r] || r;
}

function vibrate(ms) {
  if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ok */ } }
}

function doRelease() {
  if (!game.session || game.watching) return;
  const res = game.session.release();
  if (!res.ok && res.reason !== 'duplicate') {
    audio.event('invalid');
    toast('Already released.');
  }
}

function doUndo() {
  if (!game.session || game.watching) return;
  const res = game.session.undo();
  if (!res.ok) {
    audio.event('invalid');
    toast(res.reason === 'undo-disabled' ? 'Undo is only allowed in Practice and Learn.' : 'Nothing to undo.');
  } else {
    fullSync();
    toast('Undone.');
  }
}

function doHint() {
  const s = game.session;
  if (!s || game.watching) return;
  // Hints use the same legality + route APIs as play; never a separate rulebook.
  const route = findRoute(s.state.cells, s.state.w, s.state.h);
  if (!route) { toast('No clean route exists from here — consider restarting.'); return; }
  const next = route.find((i) => s.state.cells[i] === CELL.SOIL || s.state.cells[i] === CELL.HARD);
  if (next == null) {
    toast(s.state.phase === PHASE.EDITING ? 'The route is open — release the water!' : 'The route is set; let it flow.');
    return;
  }
  const x = next % s.state.w, y = Math.floor(next / s.state.w);
  game.cursor = { x, y };
  updateCursor();
  if (renderer) renderer.setGhost(x, y, true);
  toast(`Try digging row ${y + 1}, column ${x + 1}.`);
  announce(`Hint: dig row ${y + 1}, column ${x + 1}.`);
  audio.event('ui');
}

// pointer / touch ------------------------------------------------------------

function bindPointer() {
  const el = $('#playfield');
  el.addEventListener('pointerdown', (e) => {
    if (!game.session || game.watching) return;
    audio.ensure();
    el.focus();
    game.drag = { active: true, lastCell: null, pointerId: e.pointerId,
      downAt: performance.now(), downX: e.clientX, downY: e.clientY, moved: false };
    el.setPointerCapture(e.pointerId);
    const cell = pickCell(e);
    if (cell) {
      game.cursor = cell;
      updateCursor();
      if (settings.holdToCarve) {
        tryCarve(cell.x, cell.y);
        game.drag.lastCell = cell;
      }
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!game.session || game.watching) return;
    const cell = pickCell(e);
    if (cell && !game.drag.active) {
      // hover preview (never required)
      game.cursor = cell;
      updateCursor();
      const reason = game.session.explain(cell.x, cell.y);
      if (renderer) renderer.setGhost(cell.x, cell.y, reason === null);
    }
    if (!game.drag.active || e.pointerId !== game.drag.pointerId) return;
    const dx = e.clientX - game.drag.downX, dy = e.clientY - game.drag.downY;
    if (Math.hypot(dx, dy) > 8) game.drag.moved = true;
    if (settings.holdToCarve && cell) {
      const last = game.drag.lastCell;
      if (!last || last.x !== cell.x || last.y !== cell.y) {
        game.cursor = cell;
        updateCursor();
        tryCarve(cell.x, cell.y, { quiet: true });
        game.drag.lastCell = cell;
      }
    }
  });
  const endDrag = (e) => {
    if (!game.drag.active || e.pointerId !== game.drag.pointerId) return;
    const wasTap = !game.drag.moved && performance.now() - game.drag.downAt < 400;
    game.drag.active = false;
    try { el.releasePointerCapture(e.pointerId); } catch { /* already lost */ }
    if (!settings.holdToCarve && wasTap) {
      const cell = pickCell(e);
      if (cell) { game.cursor = cell; updateCursor(); tryCarve(cell.x, cell.y); }
    }
    if (renderer) renderer.setGhost(null);
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => { game.drag.active = false; if (renderer) renderer.setGhost(null); });
  el.addEventListener('lostpointercapture', () => { game.drag.active = false; });
}

function pickCell(e) {
  if (fallbackMode || !renderer) return null;
  return renderer.pick(e.clientX, e.clientY);
}

// keyboard -------------------------------------------------------------------

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const b = settings.bindings;
    const code = e.code;

    if (anyOverlayOpen()) {
      if (code === b.pause || code === 'Escape') {
        const top = topOverlay();
        if (top === 'overlay-pause') { resumeGame(); e.preventDefault(); }
        else if (top !== 'overlay-results') { closeOverlay(top); e.preventDefault(); }
      }
      return;
    }
    if ($('#screen-game').hidden) return;

    const s = game.session;
    if (!s) return;
    const move = (dx, dy) => {
      game.cursor.x = Math.max(0, Math.min(s.state.w - 1, game.cursor.x + dx));
      game.cursor.y = Math.max(0, Math.min(s.state.h - 1, game.cursor.y + dy));
      updateCursor();
      audio.event('ui');
      e.preventDefault();
    };
    switch (code) {
      case b.up: case b.altUp: move(0, -1); break;
      case b.down: case b.altDown: move(0, 1); break;
      case b.left: case b.altLeft: move(-1, 0); break;
      case b.right: case b.altRight: move(1, 0); break;
      case b.carve: case 'Space':
        tryCarve(game.cursor.x, game.cursor.y); e.preventDefault(); break;
      case b.release: doRelease(); e.preventDefault(); break;
      case b.undo: doUndo(); e.preventDefault(); break;
      case b.hint: doHint(); e.preventDefault(); break;
      case b.cameraReset: renderer?.resetCamera(); e.preventDefault(); break;
      case b.pause: pauseGame(); e.preventDefault(); break;
    }
  });
}

// gamepad --------------------------------------------------------------------

const GAMEPAD_MAP = { carve: [0], cancel: [1], release: [2], hint: [3], pause: [9] };

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && Array.from(pads).find((p) => p && p.connected);
  if (!gp || !game.session || $('#screen-game').hidden || anyOverlayOpen()) return;
  const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = (name, down) => {
    const was = game.gamepadPrev[name];
    game.gamepadPrev[name] = down;
    return down && !was;
  };
  const ax = Math.abs(gp.axes[0]) > 0.5 ? Math.sign(gp.axes[0]) : 0;
  const ay = Math.abs(gp.axes[1]) > 0.5 ? Math.sign(gp.axes[1]) : 0;
  const dpx = (pressed(15) ? 1 : 0) - (pressed(14) ? 1 : 0) || ax;
  const dpy = (pressed(13) ? 1 : 0) - (pressed(12) ? 1 : 0) || ay;
  if (edge('mx', dpx !== 0) || edge('my', dpy !== 0)) {
    game.cursor.x = Math.max(0, Math.min(game.session.state.w - 1, game.cursor.x + dpx));
    game.cursor.y = Math.max(0, Math.min(game.session.state.h - 1, game.cursor.y + dpy));
    updateCursor();
  }
  if (edge('carve', GAMEPAD_MAP.carve.some(pressed))) tryCarve(game.cursor.x, game.cursor.y);
  if (edge('release', GAMEPAD_MAP.release.some(pressed))) doRelease();
  if (edge('hint', GAMEPAD_MAP.hint.some(pressed))) doHint();
  if (edge('pause', GAMEPAD_MAP.pause.some(pressed))) pauseGame();
  if (edge('cancel', GAMEPAD_MAP.cancel.some(pressed))) doUndo();
}

// ---------------------------------------------------------------- pause

function pauseGame() {
  if (!game.session || game.watching) return;
  openOverlay('overlay-pause');
  announce('Paused.');
}

function resumeGame() {
  closeOverlay('overlay-pause');
  announce('Resumed.');
}

// ---------------------------------------------------------------- tutorials

function setupTutorialPanel() {
  const panel = $('#tutorial-panel');
  if (game.mode !== 'learn' || !game.level.tutorial) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  showTutorialStep();
}

function showTutorialStep() {
  const steps = game.level.tutorial.steps;
  const step = steps[Math.min(game.tutStep, steps.length - 1)];
  $('#tut-step-h').textContent = `${game.level.name} — step ${Math.min(game.tutStep + 1, steps.length)} of ${steps.length}`;
  $('#tut-text').textContent = step.text;
  announce(step.text);
  if (step.focus) {
    game.cursor = { x: step.focus[0], y: step.focus[1] };
    updateCursor();
  }
  track('tutorial_step', { levelId: game.level.id, step: game.tutStep });
}

function advanceTutorial(action) {
  if (game.mode !== 'learn' || !game.level.tutorial) return;
  const steps = game.level.tutorial.steps;
  if (game.tutStep >= steps.length) return;
  if (steps[game.tutStep].hint === action) {
    game.tutStep++;
    if (game.tutStep < steps.length) showTutorialStep();
  }
}

// ---------------------------------------------------------------- mirror

function buildMirror() {
  const mirror = $('#board-mirror');
  mirror.innerHTML = '';
  const lv = game.level;
  if (!lv) return;
  for (let y = 0; y < lv.h; y++) {
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    for (let x = 0; x < lv.w; x++) {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'gridcell');
      cell.id = `mc-${x}-${y}`;
      row.appendChild(cell);
    }
    mirror.appendChild(row);
  }
  updateMirror();
}

function updateMirror() {
  const s = game.session?.state;
  if (!s) return;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const el = $(`#mc-${x}-${y}`);
      if (!el) continue;
      const t = s.cells[y * s.w + x];
      const wtr = s.clean[y * s.w + x] + s.dirty[y * s.w + x];
      el.textContent = `R${y + 1} C${x + 1}: ${CELL_NAMES[t] || t}${wtr ? `, ${wtr} water` : ''}`;
    }
  }
}

// ---------------------------------------------------------------- fallback

function buildFallbackGrid() {
  if (!fallbackMode) return;
  const grid = $('#fallback-grid');
  grid.innerHTML = '';
  const lv = game.level;
  grid.style.gridTemplateColumns = `repeat(${lv.w}, 44px)`;
  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      const b = document.createElement('button');
      b.id = `fb-${x}-${y}`;
      b.setAttribute('role', 'gridcell');
      b.addEventListener('click', () => {
        audio.ensure();
        game.cursor = { x, y };
        tryCarve(x, y);
      });
      grid.appendChild(b);
    }
  }
  updateFallback();
}

const FB_GLYPHS = {
  [CELL.ROCK]: '⬛', [CELL.SOIL]: '🟫', [CELL.HARD]: '▩',
  [CELL.CHANNEL]: '·', [CELL.CONTAM]: '⚠', [CELL.SOURCE]: '💧', [CELL.TARGET]: '◎',
};

function updateFallback() {
  if (!fallbackMode) return;
  const s = game.session?.state;
  if (!s) return;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const b = $(`#fb-${x}-${y}`);
      if (!b) continue;
      const i = y * s.w + x;
      const wtr = s.clean[i] + s.dirty[i];
      b.textContent = wtr > 0 ? (s.dirty[i] ? '🟠' : '🔵') : FB_GLYPHS[s.cells[i]];
      b.setAttribute('aria-label', `Row ${y + 1} column ${x + 1}: ${CELL_NAMES[s.cells[i]]}${wtr ? `, ${wtr} water` : ''}`);
    }
  }
}

// ---------------------------------------------------------------- replay

function watchReplay() {
  const s = game.session;
  if (!s || game.watching) return;
  const commands = s.state.commands.filter((c) => c.type !== 'undo');
  closeOverlay('overlay-results');
  const fresh = new Session(game.level, sessionOpts());
  // Suppress terminal handling during watch.
  fresh.onTerminal = () => {};
  game.watching = true;
  const watchSession = game.session;
  game.session = fresh;
  if (renderer) { renderer.loadLevel(game.level, game.level.theme); fullSync(); }
  toast('Watching replay…');
  let i = 0;
  const stepMs = 260;
  const step = () => {
    if (i >= commands.length) {
      game.watching = false;
      game.session = watchSession;
      fullSync();
      openOverlay('overlay-results');
      return;
    }
    const c = commands[i++];
    game.session.command(c.type, c.x, c.y);
    game.watchTimer = setTimeout(step, c.type === 'tick' ? 90 : stepMs);
  };
  step();
}

function stopWatch() {
  if (game.watchTimer) clearTimeout(game.watchTimer);
  game.watchTimer = null;
  game.watching = false;
}

// ---------------------------------------------------------------- screens

function refreshTitleStats() {
  const done = Object.keys(progress.journeyCompleted).length;
  $('#journey-prog').textContent = `(${done}/${JOURNEY.length})`;
  $('#daily-key').textContent = `(${dailyKey(now())})`;
  $('#btn-resume').hidden = !loadSessionSnapshot();
}

function buildLevelsScreen(mode) {
  const list = $('#level-list');
  const setup = $('#practice-setup');
  list.innerHTML = '';
  setup.hidden = mode !== 'practice';
  const desc = $('#levels-desc');

  if (mode === 'learn') {
    $('#levels-h').textContent = 'Learn';
    desc.textContent = 'Interactive lessons. Each introduces one rule and asks you to perform it.';
    TUTORIALS.forEach((lv) => {
      list.appendChild(levelButton(lv, mode, settings.tutorialsDone.includes(lv.id)));
    });
  } else if (mode === 'journey') {
    $('#levels-h').textContent = 'Journey';
    desc.textContent = 'Forty stages of rising depth. Every fourth stage is a mastery check.';
    const firstIncomplete = JOURNEY.findIndex((l) => !progress.journeyCompleted[l.id]);
    JOURNEY.forEach((lv, i) => {
      const done = !!progress.journeyCompleted[lv.id];
      const locked = firstIncomplete !== -1 && i > firstIncomplete;
      list.appendChild(levelButton(lv, mode, done, locked));
    });
  } else if (mode === 'challenge') {
    $('#levels-h').textContent = 'Challenge';
    desc.textContent = 'Constrained goals: tight budgets, speed targets, altered rules.';
    CHALLENGES.forEach((lv) => {
      list.appendChild(levelButton(lv, mode, !!progress.challengesCompleted[lv.id]));
    });
  }
}

function levelButton(lv, mode, done, locked = false) {
  const b = document.createElement('button');
  b.className = `level-item${done ? ' done' : ''}${locked ? ' locked' : ''}${lv.name.startsWith('Mastery') ? ' mastery' : ''}`;
  b.setAttribute('role', 'listitem');
  const best = progress.journeyBest[lv.id];
  b.innerHTML = `<strong>${lv.name}</strong><span class="dim small">${lv.w}×${lv.h} · need ${lv.targetNeed}</span>` +
    (done ? `<span class="stars">✓${best ? ` · best ${fmtInt(best)}` : ''}</span>` : '') +
    (locked ? '<span class="dim small">locked</span>' : '');
  if (!locked) {
    b.addEventListener('click', () => { audio.ensure(); audio.event('ui'); startLevel(lv, mode); });
  } else {
    b.disabled = true;
  }
  return b;
}

function buildScoresScreen() {
  const boards = loadBoards();
  const root = $('#scores-list');
  root.innerHTML = '';
  const ids = Object.keys(boards).sort();
  if (!ids.length) {
    root.innerHTML = '<p class="dim">No scores yet. Win a daily, journey, or challenge round to post one.</p>';
    return;
  }
  for (const id of ids) {
    const h = document.createElement('h3');
    h.textContent = id;
    root.appendChild(h);
    const table = document.createElement('table');
    table.className = 'board-list';
    table.innerHTML = '<thead><tr><th>#</th><th>Score</th><th>Ticks</th><th>Assists</th><th>Seed</th></tr></thead>';
    const tb = document.createElement('tbody');
    boards[id].slice(0, 10).forEach((e, i) => {
      const tr = document.createElement('tr');
      if (e.name === 'You') tr.className = 'you';
      tr.innerHTML = `<td>${i + 1}</td><td class="num">${fmtInt(e.score)}</td>` +
        `<td class="num">${e.durationTicks}</td><td>${e.assists}</td><td class="dim">${e.seed}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    root.appendChild(table);
  }
}

function buildAchievements() {
  const got = loadAchievements();
  const ul = $('#achv-list');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    li.className = got[a.key] ? '' : 'locked';
    li.innerHTML = `<span><strong>${a.name}</strong><br><span class="dim small">${a.desc}</span></span>` +
      `<span>${got[a.key] ? '✓' : '—'}</span>`;
    ul.appendChild(li);
  }
}

function applySettingsToUI() {
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('large-text', settings.largeText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  // Help card reflects current control mappings.
  const b = settings.bindings;
  $('#help-keys').textContent =
    `Move cursor: arrows / WASD · Dig: ${b.carve} · Release: ${b.release.replace('Key', '')} · ` +
    `Undo: ${b.undo.replace('Key', '')} · Hint: ${b.hint.replace('Key', '')} · Pause: Esc · ` +
    'Gamepad: stick/d-pad move, A dig, X release, Y hint, Start pause.';
}

function bindSettings() {
  const map = [
    ['set-master', 'volMaster'], ['set-music', 'volMusic'], ['set-effects', 'volEffects'],
    ['set-ambience', 'volAmbience'], ['set-voice', 'volVoice'],
  ];
  for (const [id, key] of map) {
    const el = $(`#${id}`);
    el.value = settings[key];
    el.addEventListener('input', () => {
      settings[key] = parseFloat(el.value);
      audio.applyVolumes();
      saveSettings(settings);
      track('settings_change', { key });
    });
  }
  const checks = [
    ['set-muted', 'muted'], ['set-motion', 'reducedMotion'], ['set-contrast', 'highContrast'],
    ['set-largetext', 'largeText'], ['set-lefthand', 'leftHanded'], ['set-hold', 'holdToCarve'],
    ['set-timing', 'timingAssist'], ['set-haptics', 'haptics'],
  ];
  for (const [id, key] of checks) {
    const el = $(`#${id}`);
    el.checked = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      applySettingsToUI();
      if (key === 'muted') audio.applyVolumes();
      if (key === 'reducedMotion' && renderer) renderer.setReducedMotion(el.checked);
      if ((key === 'highContrast') && renderer) renderer.setPalette(settings.palette);
      saveSettings(settings);
      track('settings_change', { key });
    });
  }
  $('#set-quality').value = settings.quality;
  $('#set-quality').addEventListener('change', () => {
    settings.quality = $('#set-quality').value;
    saveSettings(settings);
    if (renderer) renderer.setQuality(settings.quality === 'auto' ? detectQuality() : settings.quality);
    track('settings_change', { key: 'quality' });
  });
  $('#set-palette').value = settings.palette;
  $('#set-palette').addEventListener('change', () => {
    settings.palette = $('#set-palette').value;
    saveSettings(settings);
    if (renderer) renderer.setPalette(settings.palette);
    track('settings_change', { key: 'palette' });
  });
  $('#set-camera').value = settings.cameraView;
  $('#set-camera').addEventListener('change', () => {
    settings.cameraView = $('#set-camera').value;
    saveSettings(settings);
    if (renderer && game.session) renderer.resetCamera();
  });
  $('#btn-replay-tuts').addEventListener('click', () => {
    settings.tutorialsDone = [];
    saveSettings(settings);
    toast('Tutorials reset — find them under Learn.');
  });
  $('#btn-wipe').addEventListener('click', () => {
    if (!confirm('Erase all local progress, scores, and achievements?')) return;
    localStorage.clear();
    location.reload();
  });
}

// compact rails (drawers) ----------------------------------------------------

function applyCompactRails() {
  // Add an Info toggle to the tray on compact layouts (idempotent).
  if (!$('#tray-info')) {
    const b = document.createElement('button');
    b.id = 'tray-info';
    b.className = 'btn';
    b.textContent = 'Info';
    b.addEventListener('click', () => {
      $('#rail-left').classList.toggle('open');
      $('#rail-right').classList.remove('open');
    });
    $('#tray').prepend(b);
  }
  $('#rail-left').classList.remove('open');
  $('#rail-right').classList.remove('open');
}

// ---------------------------------------------------------------- wiring

function bindUI() {
  // title
  $('#btn-play').addEventListener('click', () => { audio.ensure(); showScreen('mode'); });
  $('#btn-daily').addEventListener('click', () => { audio.ensure(); startLevel(dailyLevel(now()), 'daily'); });
  $('#btn-journey').addEventListener('click', () => {
    audio.ensure();
    const next = JOURNEY.find((l) => !progress.journeyCompleted[l.id]) || JOURNEY[0];
    startLevel(next, 'journey');
  });
  $('#btn-resume').addEventListener('click', () => {
    const snap = loadSessionSnapshot();
    const all = [...TUTORIALS, ...JOURNEY, ...CHALLENGES];
    const lv = all.find((l) => l.id === snap?.levelId) ||
      (snap?.levelId?.startsWith('daily') ? dailyLevel(now()) : null) ||
      (snap ? practiceLevel('medium', snap.seed) : null);
    if (lv) startLevel(lv, snap.mode || 'practice', { resume: true });
    else toast('Nothing to resume.');
  });
  $('#btn-scores').addEventListener('click', () => { buildScoresScreen(); openOverlay('overlay-scores'); });
  $('#btn-achievements').addEventListener('click', () => { buildAchievements(); openOverlay('overlay-achv'); });
  $('#btn-help').addEventListener('click', () => openOverlay('overlay-help'));
  $('#btn-settings').addEventListener('click', () => openOverlay('overlay-settings'));

  // mode select
  $$('#mode-grid .card').forEach((card) => {
    card.addEventListener('click', () => {
      audio.ensure();
      audio.event('ui');
      const mode = card.dataset.mode;
      if (mode === 'daily') startLevel(dailyLevel(now()), 'daily');
      else if (mode === 'scores') { buildScoresScreen(); openOverlay('overlay-scores'); }
      else { buildLevelsScreen(mode); showScreen('levels'); }
    });
  });
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => showScreen('title')));

  $('#btn-practice-start').addEventListener('click', () => {
    const diff = document.querySelector('input[name="pdiff"]:checked')?.value || 'easy';
    const seed = (Math.random() * 0xffffffff) >>> 0;
    startLevel(practiceLevel(diff, seed), 'practice');
  });

  // game actions
  $('#btn-release').addEventListener('click', doRelease);
  $('#tray-release').addEventListener('click', doRelease);
  $('#btn-undo').addEventListener('click', doUndo);
  $('#tray-undo').addEventListener('click', doUndo);
  $('#btn-hint').addEventListener('click', doHint);
  $('#tray-hint').addEventListener('click', doHint);
  $('#btn-camera').addEventListener('click', () => renderer?.resetCamera());
  $('#btn-pause').addEventListener('click', pauseGame);
  $('#tray-pause').addEventListener('click', pauseGame);
  $('#btn-skip').addEventListener('click', () => {
    if (game.session) { game.session.skipToEnd(); fullSync(); }
  });

  // pause overlay
  $('#btn-resume-game').addEventListener('click', resumeGame);
  $('#btn-pause-settings').addEventListener('click', () => openOverlay('overlay-settings'));
  $('#btn-pause-help').addEventListener('click', () => openOverlay('overlay-help'));
  $('#btn-pause-restart').addEventListener('click', () => {
    closeOverlay('overlay-pause');
    startLevel(game.level, game.mode);
    track('retry', { levelId: game.level.id });
  });
  $('#btn-pause-leave').addEventListener('click', () => {
    game.session?.abandon();
    closeOverlay('overlay-pause');
  });

  // results overlay
  $('#btn-retry').addEventListener('click', () => {
    closeOverlay('overlay-results');
    startLevel(game.level, game.mode);
    track('retry', { levelId: game.level.id });
  });
  $('#btn-watch-replay').addEventListener('click', watchReplay);
  $('#btn-results-exit').addEventListener('click', () => {
    closeOverlay('overlay-results');
    refreshTitleStats();
    showScreen('title');
  });

  // other overlays
  $('#btn-settings-close').addEventListener('click', () => closeOverlay('overlay-settings'));
  $('#btn-help-close').addEventListener('click', () => closeOverlay('overlay-help'));
  $('#btn-achv-close').addEventListener('click', () => closeOverlay('overlay-achv'));
  $('#btn-scores-close').addEventListener('click', () => closeOverlay('overlay-scores'));

  // First gesture unlocks audio.
  document.addEventListener('pointerdown', () => audio.ensure(), { once: true });
  document.addEventListener('keydown', () => audio.ensure(), { once: true });
}

// ---------------------------------------------------------------- lifecycle

function bindLifecycle() {
  // Backgrounding pauses solo simulation; decorative motion stops.
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden;
    if (renderer) renderer.setHidden(hidden);
    audio.setBackgrounded(hidden);
    if (!hidden && game.session) fullSync();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderer?.resize(), 60);
  });
  window.addEventListener('orientationchange', () => {
    setTimeout(() => renderer?.resize(), 250);
  });
}

// main loop: fixed-step simulation + interpolated render ---------------------

let lastFrame = performance.now();
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(100, t - lastFrame);
  lastFrame = t;
  if (game.session && !game.watching && !document.hidden) {
    const wasFlowing = game.session.phase === PHASE.FLOWING;
    game.session.advance(dt);
    if (wasFlowing || game.session.phase === PHASE.FLOWING) {
      // HUD ticks advance even without events.
      updateHUD();
    }
  }
  if (renderer && game.session && !$('#screen-game').hidden) {
    renderer.syncState(game.session.state, game.session.prev, game.session.alpha());
    renderer.render(dt / 1000);
  }
  pollGamepad();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const bar = $('#boot-bar');
  const status = $('#boot-status');
  const step = (pct, msg) => { bar.style.width = `${pct}%`; status.textContent = msg; };

  step(15, 'Loading rules…');
  applySettingsToUI();
  bindUI();
  bindSettings();
  bindPointer();
  bindKeyboard();
  bindLifecycle();

  step(35, 'Synchronising clock…');
  await Promise.race([syncServerTime(), new Promise((r) => setTimeout(r, 1500))]);

  step(60, 'Building scene…');
  await initRenderer();

  step(85, 'Preparing content…');
  refreshTitleStats();

  step(100, 'Ready.');
  lastFrame = performance.now();
  requestAnimationFrame(loop);
  showScreen('title');
}

boot().catch((err) => {
  console.error(err);
  $('#boot-status').textContent = 'Failed to start: ' + err.message;
  track('error', { category: 'boot' });
});

// Test hook: drives the browser smoke tests through the same command path
// as real input. Harmless in production.
window.__ckTest = {
  carve: (x, y) => tryCarve(x, y),
  release: () => doRelease(),
  leave: () => game.session?.abandon(),
  phase: () => game.session?.phase,
  state: () => game.session?.state,
};
