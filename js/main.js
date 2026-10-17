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
  loadAchievements, saveAchievements, unlockAchievement, loadSessionSnapshot,
  submitScore, loadBoards, saveBoards, onRecordsChange, mergeRecords,
} from './storage.js';
import { AudioEngine } from './audio.js';
import { CATEGORIES, PRESETS, resolve, presetTier, choosePreset, describe } from './gfx.js';
import { gfxStrings, pickLocale } from './gfx-i18n.js';
import { platform } from './platform.js';
import { platformStrings, fmtPlatform } from './platform-strings.js';

import { $, $$, showScreen, openOverlay, closeOverlay, anyOverlayOpen, topOverlay,
  announce, toast, caption, fmtInt, tr, N, relocalizeToast } from './ui.js';

// One game language (js/i18n.js → sh-language.js): tr() translates English
// keys; platform (PT) and graphics (gt) strings follow the same locale.
const curLang = () => (globalThis.CKI18N ? globalThis.CKI18N.lang : navigator.language);
let PT = platformStrings(curLang()); // StarHermit UI strings

/** Level names are authored as "Stage n", "Mastery n", "Daily — date", "Practice — Easy". */
function levelName(lv) {
  const name = (lv && lv.name) || '';
  let m;
  if ((m = /^Stage (\d+)$/.exec(name))) return tr('Stage {n}', { n: m[1] });
  if ((m = /^Mastery (\d+)$/.exec(name))) return tr('Mastery {n}', { n: m[1] });
  if ((m = /^Daily — (.+)$/.exec(name))) return tr('Daily — {date}', { date: m[1] });
  if ((m = /^Practice — (.+)$/.exec(name))) return tr('Practice — {level}', { level: tr(m[1]) });
  return tr(name);
}
function levelGoal(lv) {
  const goal = (lv && lv.goal) || N('Deliver clean water to the well.');
  const m = /^Deliver (\d+) units of clean water\.$/.exec(goal);
  return m ? tr('Deliver {n} units of clean water.', { n: m[1] }) : tr(goal);
}

// ---------------------------------------------------------------- bootstrap

const settings = loadSettings();
const progress = loadProgress();
const audio = new AudioEngine(settings);
audio.onCaption = (text) => {
  const m = /^not allowed: (.+)$/.exec(text);
  caption(m ? tr('not allowed: {reason}', { reason: explainReason(m[1]) }) : tr(text));
};

let renderer = null;
let fallbackMode = false;

const now = () => platform.now();

function track(event, data = {}) {
  // Anonymous funnel events, local dev only: the events sink is the game's
  // own dev server and does not exist on-platform (hosted mode never sends).
  if (!platform.ownServer) return;
  try {
    const body = JSON.stringify({ event, ...data, t: Date.now() });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/v1/events', body);
  } catch { /* offline is fine */ }
}

async function syncServerTime() {
  if (!platform.hosted) return; // standalone: local clock, no requests
  try {
    await platform.syncTime();
  } catch { /* offline: local clock */ }
}

// Account + cloud-sync status line (index.html #profile-line). Offline keeps
// the identical local-only behaviour; hosted shows the account nickname.
function renderProfileLine() {
  const line = $('#profile-line');
  if (!line) return;
  renderPlatformButtons();
  if (!platform.hosted) {
    line.textContent = tr('Playing as guest — progress is stored locally.');
    return;
  }
  const name = platform.profile ? platform.profile.name : '…';
  const syncTxt = platform.sync === 'synced' ? tr('progress synced')
    : platform.sync === 'saving' ? tr('saving…')
    : tr('cloud sync unavailable');
  line.textContent = tr('Playing as {name} · {sync}', { name, sync: syncTxt });
}

// Sign-in (platform host, no token) and invite (signed in) buttons on the title.
function renderPlatformButtons() {
  const signIn = $('#btn-signin'), invite = $('#btn-invite');
  if (signIn) { signIn.textContent = PT.signIn; signIn.hidden = !platform.canSignIn(); }
  if (invite) { invite.textContent = PT.invite; invite.hidden = !platform.hosted; }
}

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
  springDry: false,    // one-shot cue when the spring's last unit is emitted
};

// ---------------------------------------------------------------- renderer

async function initRenderer() {
  try {
    const { BoardRenderer } = await import('./render.js');
    renderer = new BoardRenderer($('#playfield'), settings);
    if (renderer.contextLost) throw new Error('no context');
    renderer.onContextLost = (lost) => {
      if (lost) toast(() => tr('Graphics context lost — recovering…'));
      else { toast(() => tr('Graphics recovered.')); if (game.session) fullSync(); }
    };
    renderer.setGraphics(gfxSaved());
    renderer.setReducedMotion(settings.reducedMotion);
    document.body.dataset.gfxPreset = renderer.q.preset;
  } catch (err) {
    console.warn('WebGL unavailable, using DOM fallback', err);
    fallbackMode = true;
    $('#canvas-fallback').hidden = false;
    track('error', { category: 'webgl' });
  }
}

// ---------------------------------------------------------------- graphics settings

let gt = gfxStrings(pickLocale(curLang()));

/** Saved graphics settings in the gfx.js shape (preset + overrides). */
function gfxSaved() {
  return { ...settings.gfx, preset: settings.quality };
}

function applyGraphics() {
  saveSettings(settings);
  const saved = gfxSaved();
  if (renderer) { renderer.setGraphics(saved); fullSync(); }
  document.body.dataset.gfxPreset = renderer ? renderer.q.preset : resolve(saved, 'low').preset;
  refreshGfxPanel();
  // Pixel size and post chain settle on the next frame.
  setTimeout(refreshGfxPanel, 150);
  track('settings_change', { key: 'graphics' });
}

/** Graphics labels and option names in the current language (also on a language change). */
function labelGfxPanel() {
  gt = gfxStrings(pickLocale(curLang()));
  $('#gfx-legend').textContent = gt('legend');
  for (const el of $$('[data-gfx-text]')) el.textContent = gt(el.dataset.gfxText);
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = $(`#set-gfx-${cat}`);
    if (!sel) continue;
    sel.parentElement.querySelector('span').textContent = gt(`cat_${cat}`);
    for (const o of sel.options) if (o.value !== 'preset') o.textContent = gt(`t_${o.value}`);
    void tiers;
  }
  refreshGfxPanel();
}

function buildGfxPanel() {
  $('#gfx-legend').textContent = gt('legend');
  for (const el of $$('[data-gfx-text]')) el.textContent = gt(el.dataset.gfxText);
  const host = $('#gfx-cats');
  host.textContent = '';
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = gt(`cat_${cat}`);
    const sel = document.createElement('select');
    sel.id = `set-gfx-${cat}`;
    sel.dataset.gfxCat = cat;
    for (const v of ['preset', ...tiers]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'preset' ? '' : gt(`t_${v}`);
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      if (sel.value === 'preset') delete settings.gfx[cat];
      else settings.gfx[cat] = sel.value;
      applyGraphics();
    });
    label.append(span, ' ', sel);
    host.appendChild(label);
  }
  $('#set-quality').addEventListener('change', () => {
    const next = choosePreset(gfxSaved(), $('#set-quality').value);
    settings.quality = next.preset;
    delete next.preset;
    settings.gfx = next;
    applyGraphics();
  });
  const scale = $('#set-gfx-scale');
  scale.addEventListener('input', () => {
    settings.gfx.render_scale = Math.round(parseFloat(scale.value)) / 100;
    $('#gfx-scale-val').textContent = `${scale.value}%`;
    applyGraphics();
  });
  $('#set-gfx-adaptive').addEventListener('change', () => {
    settings.gfx.adaptive = $('#set-gfx-adaptive').checked;
    applyGraphics();
  });
  $('#set-gfx-fps').addEventListener('change', () => {
    settings.gfx.show_fps = $('#set-gfx-fps').checked;
    applyGraphics();
  });
  refreshGfxPanel();
}

/** Sync the Graphics controls, labels and summary with the resolved settings. */
function refreshGfxPanel() {
  const info = renderer ? renderer.graphicsInfo() : null;
  const detected = info ? info.detected : 'low';
  const r = info ? info.resolved : resolve(gfxSaved(), detected);
  const q = $('#set-quality');
  for (const o of q.options) o.textContent = o.value === 'auto' ? gt('auto', { tier: gt(detected) }) : gt(o.value);
  q.value = PRESETS.includes(settings.quality) ? settings.quality : 'auto';
  for (const cat of Object.keys(CATEGORIES)) {
    const sel = $(`#set-gfx-${cat}`);
    if (!sel) continue;
    sel.options[0].textContent = gt('fromPreset', { tier: gt(`t_${presetTier(r.preset, cat)}`) });
    sel.value = settings.gfx[cat] && CATEGORIES[cat].includes(settings.gfx[cat]) ? settings.gfx[cat] : 'preset';
  }
  const pct = Math.round((r.renderScale || 1) * 100);
  $('#set-gfx-scale').value = pct;
  $('#gfx-scale-val').textContent = `${pct}%`;
  $('#set-gfx-adaptive').checked = r.adaptive;
  $('#set-gfx-fps').checked = r.showFps;
  const words = {
    noShadows: gt('w_noShadows'), shadows: gt('w_shadows'), ao: gt('w_ao'),
    aoHigh: gt('w_aoHigh'), bloom: gt('w_bloom'), noAA: gt('w_noAA'),
  };
  $('#gfx-summary').textContent = info
    ? `${info.gpu} · ${gt('level', { n: info.level })} · ${describe(r, info.pixels, words)}`
    : gt('noWebgl');
  const note = $('#gfx-post-note');
  note.hidden = !(info && info.postFailed);
  note.textContent = gt('postFailed');
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
  game.springDry = session.state.sourceLeft <= 0;

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

  $('#hud-objective').textContent = levelGoal(level);
  $('#btn-skip').hidden = true;
  setupTutorialPanel();
  updateHUD();
  showScreen('game');
  applyCompactRails();
  // The playfield only has measurable size once visible.
  requestAnimationFrame(() => { renderer?.resize(); fullSync(); });

  if (resume && session.state.tick > 0) {
    // "While you were away" summary after restoring a snapshot.
    const st = session.state;
    toast(() => tr('Welcome back — {n} units delivered, tick {tick} when you left.', { n: st.deliveredClean, tick: st.tick }));
  }
  announce(tr('{name}. {goal} Dig budget {n}.', { name: levelName(level), goal: levelGoal(level), n: level.carveBudget }));
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
        announce(tr('Water released.'));
        $('#btn-skip').hidden = false;
        advanceTutorial('release');
        break;
      case 'deliver':
        audio.event('deliver');
        break;
      case 'contaminate':
        audio.event('contaminate');
        announce(tr('Water fouled by a contaminant pocket!'), true);
        break;
      case 'undo':
        audio.event('undo');
        break;
      case 'tick':
        if (state.sourceLeft <= 0 && !game.springDry) {
          game.springDry = true;
          audio.event('springDry');
          toast(() => tr('The spring has run dry.'));
          announce(tr('The spring has run dry. The water still in the channels must reach the well on its own.'));
        }
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

// Hosted play only: post ranked rounds (not Learn/Practice/abandoned) to the
// platform high-score board and show the rank on the results sheet.
let lbSeq = 0;
function postToLeaderboard(r) {
  const line = $('#results-lb');
  const seq = ++lbSeq;
  line.hidden = true;
  if (!platform.hosted || game.mode === 'practice' || game.mode === 'learn' || r.reason === 'abandoned') return;
  line.hidden = false;
  lbState = { key: 'lbPosting' };
  renderLbLine();
  platform.submitScore(r.score.total).then((res) => {
    if (seq !== lbSeq) return;
    lbState = { key: !res.posted ? 'lbNotPosted' : res.rank ? 'lbRank' : 'lbPosted', rank: res.rank };
    renderLbLine();
  });
}
let lbState = null;
function renderLbLine() {
  if (!lbState) return;
  $('#results-lb').textContent = lbState.key === 'lbRank' ? fmtPlatform(PT.lbRank, { rank: lbState.rank }) : PT[lbState.key];
}

/**
 * Language change (Settings → Language or the account preference arriving):
 * static markup is re-applied by js/i18n.js; every string written from code is
 * rebuilt here. The round in play, its tick and the scene are untouched.
 */
function onLanguage() {
  PT = platformStrings(curLang());
  labelGfxPanel();
  applySettingsToUI();
  renderProfileLine();
  refreshTitleStats();
  if (!$('#screen-levels').hidden && lastLevelsMode) buildLevelsScreen(lastLevelsMode);
  if (!$('#overlay-scores').hidden) buildScoresScreen();
  if (!$('#overlay-achv').hidden) buildAchievements();
  const tray = $('#tray-info');
  if (tray) tray.textContent = tr('Info');
  if (game.session) {
    $('#hud-objective').textContent = levelGoal(game.level);
    if (game.mode === 'learn' && game.level.tutorial) showTutorialStep(true);
    updateHUD();
    updateCursor();
    updateMirror();
    updateFallback();
  }
  if (lastResults && !$('#overlay-results').hidden) { showResults(lastResults, true); renderLbLine(); }
  relocalizeToast();
}
document.addEventListener('ck-language', onLanguage);

function handleTerminal(results) {
  audio.event(results.won ? 'win' : 'lose');
  $('#btn-skip').hidden = true;
  applyResults(results);
  showResults(results);
  postToLeaderboard(results);
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
      // Validated daily submission to the own-server backend (graceful when
      // absent); the replay envelope is verified server-side.
      if (game.session && typeof game.session.exportReplay === 'function') {
        platform.submitDaily(key, game.session.exportReplay()).then((res) => {
          if (res.ok) toast(() => tr('Daily validated — rank #{rank} of {total}.', { rank: res.rank ?? '?', total: res.total ?? '?' }));
        }).catch(() => {});
      }
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

function showResults(r, relocalizing) {
  $('#results-h').textContent = tr(r.won ? 'Well filled!' : 'The water is spent');
  $('#results-reason').textContent = tr({
    'target-filled': N('The well drank its fill of clean water.'),
    'settled-dry': N('The water settled before reaching the well.'),
    timeout: N('Time ran out — the flood stalled.'),
    abandoned: N('Round abandoned.'),
  }[r.reason] || r.reason);
  $('#sc-clean').textContent = fmtInt(r.score.cleanWater);
  $('#sc-eff').textContent = fmtInt(r.score.efficiency);
  $('#sc-speed').textContent = fmtInt(r.score.speed);
  $('#sc-contam').textContent = fmtInt(r.score.contamination);
  $('#sc-total').textContent = fmtInt(r.score.total);
  $('#results-seed').textContent = tr('seed {seed} · ruleset v{version} · session {session}', { seed: r.seed, version: CONTENT_VERSION, session: r.sessionId });
  const art = $('#results-art');
  if (art) { // illustration is decorative; a failed load simply hides it
    art.hidden = false;
    art.src = r.won ? 'assets/well-filled.webp' : 'assets/water-spent.webp';
  }

  const progBits = [];
  if (game.mode === 'journey') {
    const done = Object.keys(progress.journeyCompleted).length;
    progBits.push(tr('Journey: {n} / {total} stages complete.', { n: done, total: JOURNEY.length }));
  }
  if (game.mode === 'learn') {
    progBits.push(tr('Lessons: {n} / {total}.', { n: settings.tutorialsDone.length, total: TUTORIALS.length }));
  }
  progBits.push(tr('{clean} clean · {fouled} fouled · {digs} digs · tick {tick}.', { clean: fmtInt(r.deliveredClean), fouled: fmtInt(r.deliveredDirty), digs: r.movesUsed, tick: r.tick }));
  $('#results-progress').textContent = progBits.join(' ');

  // Comparison against the local board.
  let cmp = '';
  if (game.mode !== 'practice' && game.mode !== 'learn' && r.won) {
    const board = (loadBoards()[boardId()] || []);
    const rank = board.findIndex((e) => e.sessionId === r.sessionId);
    if (rank >= 0) cmp = tr('Board rank #{rank} of {total}.', { rank: rank + 1, total: board.length });
  } else if (game.mode === 'practice') {
    cmp = tr('Practice round — unranked.');
  }
  $('#results-compare').textContent = cmp;

  // Achievements earned this round.
  const earned = ACHIEVEMENTS.filter((a) => loadAchievements()[a.key]);
  $('#results-achv').innerHTML = '';
  // Show only freshly-relevant chips: keep it simple, show earned count.
  if (earned.length) {
    const chip = document.createElement('span');
    chip.className = 'achv-chip';
    chip.textContent = tr('{n} / {total} achievements', { n: earned.length, total: ACHIEVEMENTS.length });
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
      nextBtn.textContent = tr('Next lesson');
      nextBtn.onclick = () => { closeOverlay('overlay-results'); startLevel(TUTORIALS[i + 1], 'learn'); };
    }
  }
  if (!nextBtn.hidden) nextBtn.textContent = tr(game.mode === 'learn' ? 'Next lesson' : 'Next stage');
  if (relocalizing) return;

  openOverlay('overlay-results');
  announce(r.won ? tr('Round complete. Score {n}.', { n: r.score.total }) : tr('Round failed.'), true);
}

// ---------------------------------------------------------------- HUD

const CELL_KEYS = {
  [CELL.ROCK]: N('solid rock — cannot be dug'),
  [CELL.SOIL]: N('soil — dig for 1'),
  [CELL.HARD]: N('packed clay — dig for 2'),
  [CELL.CHANNEL]: N('open channel'),
  [CELL.CONTAM]: N('foul pocket — contaminates water'),
  [CELL.SOURCE]: N('the spring'),
  [CELL.TARGET]: N('the well'),
};
/** Localized cell descriptions, looked up per use so they follow language changes. */
const CELL_NAMES = new Proxy(CELL_KEYS, { get: (o, k) => (o[k] ? tr(o[k]) : undefined) });

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
  announce(tr(CELL_KEYS[t] === 'open channel' ? 'Dug a channel at row {r}, column {c}. Budget {n}.' : 'Dug at row {r}, column {c}. Budget {n}.', { r: y + 1, c: x + 1, n: s.budget }));
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
  $('#hud-cellinfo').textContent = `${CELL_NAMES[t] || tr('unknown')}${water ? ' · ' + tr('{n} water', { n: water }) : ''}`;
}

// ---------------------------------------------------------------- input

function tryCarve(x, y, { quiet = false } = {}) {
  const s = game.session;
  if (!s || game.watching) return false;
  const reason = s.explain(x, y);
  if (reason) {
    if (!quiet) {
      audio.event('invalid', { reason });
      toast(() => explainReason(reason));
      announce(tr('Cannot dig: {reason}', { reason: explainReason(reason) }), true);
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
  return tr({
    'out-of-bounds': N('outside the dig face'),
    'blocked-rock': N('solid rock cannot be dug'),
    'already-open': N('already open'),
    'is-source': N('that is the spring'),
    'is-target': N('that is the well'),
    'no-budget': N('dig budget exhausted'),
    'wrong-phase': N('not while water flows (this ruleset)'),
    'game-over': N('the round is over'),
  }[r] || r);
}

function vibrate(ms) {
  if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* ok */ } }
}

function doRelease() {
  if (!game.session || game.watching) return;
  const res = game.session.release();
  if (!res.ok && res.reason !== 'duplicate') {
    audio.event('invalid');
    toast(() => tr('Already released.'));
  }
}

function doUndo() {
  if (!game.session || game.watching) return;
  const res = game.session.undo();
  if (!res.ok) {
    audio.event('invalid');
    const key = res.reason === 'undo-disabled' ? N('Undo is only allowed in Practice and Learn.') : N('Nothing to undo.');
    toast(() => tr(key));
  } else {
    fullSync();
    toast(() => tr('Undone.'));
  }
}

function doHint() {
  const s = game.session;
  if (!s || game.watching) return;
  // Hints use the same legality + route APIs as play; never a separate rulebook.
  const route = findRoute(s.state.cells, s.state.w, s.state.h);
  if (!route) { toast(() => tr('No clean route exists from here — consider restarting.')); return; }
  const next = route.find((i) => s.state.cells[i] === CELL.SOIL || s.state.cells[i] === CELL.HARD);
  if (next == null) {
    const key = s.state.phase === PHASE.EDITING ? N('The route is open — release the water!') : N('The route is set; let it flow.');
    toast(() => tr(key));
    return;
  }
  const x = next % s.state.w, y = Math.floor(next / s.state.w);
  game.cursor = { x, y };
  updateCursor();
  if (renderer) renderer.setGhost(x, y, true);
  toast(() => tr('Try digging row {r}, column {c}.', { r: y + 1, c: x + 1 }));
  announce(tr('Hint: dig row {r}, column {c}.', { r: y + 1, c: x + 1 }));
  audio.event('hint');
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
    const act = platform.actionFor(e);

    if (anyOverlayOpen()) {
      if (act === 'pause' || e.code === 'Escape') {
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
    switch (act) {
      case 'up': move(0, -1); break;
      case 'down': move(0, 1); break;
      case 'left': move(-1, 0); break;
      case 'right': move(1, 0); break;
      case 'carve': tryCarve(game.cursor.x, game.cursor.y); e.preventDefault(); break;
      case 'release': doRelease(); e.preventDefault(); break;
      case 'undo': doUndo(); e.preventDefault(); break;
      case 'hint': doHint(); e.preventDefault(); break;
      case 'cameraReset': renderer?.resetCamera(); e.preventDefault(); break;
      case 'pause': pauseGame(); e.preventDefault(); break;
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
  // Both edge states must be sampled every poll: `a || b` would skip recording
  // the Y edge whenever the X edge fires, causing a spurious second move.
  const movedX = edge('mx', dpx !== 0);
  const movedY = edge('my', dpy !== 0);
  if (movedX || movedY) {
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
  audio.event('pause');
  announce(tr('Paused.'));
}

function resumeGame() {
  closeOverlay('overlay-pause');
  audio.event('resume');
  announce(tr('Resumed.'));
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

function showTutorialStep(relocalizing) {
  const steps = game.level.tutorial.steps;
  const step = steps[Math.min(game.tutStep, steps.length - 1)];
  $('#tut-step-h').textContent = tr('{name} — step {n} of {total}', { name: levelName(game.level), n: Math.min(game.tutStep + 1, steps.length), total: steps.length });
  $('#tut-text').textContent = tr(step.text);
  if (relocalizing) return;
  announce(tr(step.text));
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
      el.textContent = tr('R{r} C{c}', { r: y + 1, c: x + 1 }) + `: ${CELL_NAMES[t] || t}${wtr ? ', ' + tr('{n} water', { n: wtr }) : ''}`;
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
      b.setAttribute('aria-label', tr('Row {r} column {c}', { r: y + 1, c: x + 1 }) + `: ${CELL_NAMES[s.cells[i]]}${wtr ? ', ' + tr('{n} water', { n: wtr }) : ''}`);
    }
  }
}

// ---------------------------------------------------------------- replay

function watchReplay() {
  const s = game.session;
  if (!s || game.watching) return;
  // Undo is part of the deterministic command log (the rules engine replays
  // it exactly), so the full log is re-run — filtering it would diverge.
  const commands = s.state.commands.slice();
  closeOverlay('overlay-results');
  const fresh = new Session(game.level, sessionOpts());
  // Suppress terminal handling and persistence during watch: replaying commands
  // must not recreate the cleared resume snapshot of a finished round.
  fresh.onTerminal = () => {};
  fresh._persist = () => {};
  game.watching = true;
  game.springDry = false;
  const watchSession = game.session;
  game.session = fresh;
  if (renderer) { renderer.loadLevel(game.level, game.level.theme); fullSync(); }
  toast(() => tr('Watching replay…'));
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

/**
 * Save conflict (another device wrote the cloud slot since our last load):
 * keep the better of both sides — stages completed on either device with the
 * higher score, every challenge and daily result, the larger counters, every
 * achievement with its earliest unlock and both local boards — keep this
 * device's settings and the round in play, then save the merge again.
 */
function mergeCloud(remote) {
  const m = mergeRecords({ progress, achievements: loadAchievements(), boards: loadBoards() }, remote);
  Object.assign(progress, m.progress);
  saveAchievements(m.achievements);
  saveBoards(m.boards);
  saveProgress(progress); // persist point: the records listener mirrors the merge to the cloud
  refreshTitleStats();
}

/** Display name of a local board id. */
function boardName(id) {
  if (id === 'journey') return tr('Journey');
  let m;
  if ((m = /^daily-(.+)$/.exec(id))) return tr('Daily — {date}', { date: m[1] });
  if ((m = /^challenge-(.+)$/.exec(id))) {
    const ch = CHALLENGES.find((c) => c.id === m[1]);
    return ch ? levelName(ch) : id;
  }
  return id;
}

function refreshTitleStats() {
  const done = Object.keys(progress.journeyCompleted).length;
  $('#journey-prog').textContent = `(${done}/${JOURNEY.length})`;
  $('#daily-key').textContent = `(${dailyKey(now())})`;
  $('#btn-resume').hidden = !loadSessionSnapshot();
}

let lastLevelsMode = null;
function buildLevelsScreen(mode) {
  lastLevelsMode = mode;
  const list = $('#level-list');
  const setup = $('#practice-setup');
  list.innerHTML = '';
  setup.hidden = mode !== 'practice';
  const desc = $('#levels-desc');

  if (mode === 'learn') {
    $('#levels-h').textContent = tr('Learn');
    desc.textContent = tr('Interactive lessons. Each introduces one rule and asks you to perform it.');
    TUTORIALS.forEach((lv) => {
      list.appendChild(levelButton(lv, mode, settings.tutorialsDone.includes(lv.id)));
    });
  } else if (mode === 'journey') {
    $('#levels-h').textContent = tr('Journey');
    desc.textContent = tr('Forty stages of rising depth. Every fourth stage is a mastery check.');
    const firstIncomplete = JOURNEY.findIndex((l) => !progress.journeyCompleted[l.id]);
    JOURNEY.forEach((lv, i) => {
      const done = !!progress.journeyCompleted[lv.id];
      const locked = firstIncomplete !== -1 && i > firstIncomplete;
      list.appendChild(levelButton(lv, mode, done, locked));
    });
  } else if (mode === 'challenge') {
    $('#levels-h').textContent = tr('Challenge');
    desc.textContent = tr('Constrained goals: tight budgets, speed targets, altered rules.');
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
  const part = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };
  b.append(part('strong', '', levelName(lv)), part('span', 'dim small', `${lv.w}×${lv.h} · ` + tr('need {n}', { n: lv.targetNeed })));
  if (done) b.append(part('span', 'stars', '✓' + (best ? ' · ' + tr('best {n}', { n: fmtInt(best) }) : '')));
  if (locked) b.append(part('span', 'dim small', tr('locked')));
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
  if (!ids.length && !platform.ownServer) {
    root.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'dim';
    p.textContent = tr('No scores yet. Win a daily, journey, or challenge round to post one.');
    root.appendChild(p);
    return;
  }
  for (const id of ids) {
    const h = document.createElement('h3');
    h.textContent = boardName(id);
    root.appendChild(h);
    const table = document.createElement('table');
    table.className = 'board-list';
    table.innerHTML = '<thead><tr><th>#</th><th></th><th></th><th></th><th></th></tr></thead>';
    [N('Score'), N('Ticks'), N('Assists'), N('Seed')].forEach((k, i) => { table.tHead.rows[0].cells[i + 1].textContent = tr(k); });
    const tb = document.createElement('tbody');
    boards[id].slice(0, 10).forEach((e, i) => {
      const tr = document.createElement('tr');
      if (e.name === 'You') tr.className = 'you';
      tr.innerHTML = `<td>${i + 1}</td><td class="num">${fmtInt(e.score)}</td>` +
        `<td class="num">${e.durationTicks}</td><td>${e.assists === 'none' ? tr('none') : e.assists}</td><td class="dim">${e.seed}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    root.appendChild(table);
    // Server-validated daily board (own backend; silent when absent).
    if (id.startsWith('daily-') && platform.ownServer) {
      platform.fetchDailyBoard(id).then(async (entries) => {
        if (!entries || !entries.length) return;
        const h2 = document.createElement('h3');
        h2.textContent = tr('{board} — validated', { board: boardName(id) });
        root.appendChild(h2);
        const t2 = document.createElement('table');
        t2.className = 'board-list';
        t2.innerHTML = '<thead><tr><th>#</th><th></th><th></th></tr></thead>';
        t2.tHead.rows[0].cells[1].textContent = tr('Player');
        t2.tHead.rows[0].cells[2].textContent = tr('Score');
        const tb2 = document.createElement('tbody');
        for (let i = 0; i < entries.slice(0, 10).length; i++) {
          const e = entries[i];
          const pid = String(e.playerId || '');
          const name = (pid && platform.hosted) ? await platform.profileFor(pid) : (pid || 'anon');
          const tr = document.createElement('tr');
          if (pid && pid === platform.userId) tr.className = 'you';
          tr.innerHTML = `<td>${i + 1}</td><td>${name}</td><td class="num">${fmtInt(e.score)}</td>`;
          tb2.appendChild(tr);
        }
        t2.appendChild(tb2);
        root.appendChild(t2);
      }).catch(() => {});
    }
  }
}

function buildAchievements() {
  const got = loadAchievements();
  const ul = $('#achv-list');
  ul.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const li = document.createElement('li');
    li.className = got[a.key] ? '' : 'locked';
    li.innerHTML = `<span><strong></strong><br><span class="dim small"></span></span>` +
      `<span>${got[a.key] ? '✓' : '—'}</span>`;
    li.querySelector('strong').textContent = tr(a.name);
    li.querySelector('.dim').textContent = tr(a.desc);
    ul.appendChild(li);
  }
}

function applySettingsToUI() {
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('large-text', settings.largeText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  // Help card reflects current control mappings.
  const k = (a) => platform.keyLabel(a);
  $('#help-keys').textContent = tr('Move cursor: {up}, {left}, {down}, {right} · Dig: {carve} · Release: {release} · Undo: {undo} · Hint: {hint} · Reset camera: {camera} · Pause: {pause} · Gamepad: stick/d-pad move, A dig, X release, Y hint, Start pause.', {
    up: k('up'), left: k('left'), down: k('down'), right: k('right'), carve: k('carve'), release: k('release'),
    undo: k('undo'), hint: k('hint'), camera: k('cameraReset'), pause: k('pause'),
  });
}

/** Reflect `settings` into the settings form (after cloud/KV values land). */
function syncSettingsForm() {
  for (const [id, key] of [['set-master', 'volMaster'], ['set-music', 'volMusic'], ['set-effects', 'volEffects'],
    ['set-ambience', 'volAmbience'], ['set-voice', 'volVoice']]) $(`#${id}`).value = settings[key];
  for (const [id, key] of [['set-muted', 'muted'], ['set-motion', 'reducedMotion'], ['set-contrast', 'highContrast'],
    ['set-largetext', 'largeText'], ['set-lefthand', 'leftHanded'], ['set-hold', 'holdToCarve'],
    ['set-timing', 'timingAssist'], ['set-haptics', 'haptics']]) $(`#${id}`).checked = !!settings[key];
  $('#set-palette').value = settings.palette;
  $('#set-camera').value = settings.cameraView;
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
  buildGfxPanel();
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
    toast(() => tr('Tutorials reset — find them under Learn.'));
  });
  $('#btn-wipe').addEventListener('click', () => {
    if (!confirm(tr('Erase all local progress, scores, and achievements?'))) return;
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
    b.textContent = tr('Info');
    b.addEventListener('click', () => {
      $('#rail-left').classList.toggle('open');
      $('#rail-right').classList.remove('open');
      syncInfoState();
    });
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', 'rail-left');
    $('#tray').prepend(b);
  }
  $('#rail-left').classList.remove('open');
  $('#rail-right').classList.remove('open');
  syncInfoState();
  placeTutorialPanel();
}

// On compact layouts the lesson card floats over the playfield so guidance
// is visible without opening the Info drawer; wide layouts keep it in the rail.
function placeTutorialPanel() {
  const panel = $('#tutorial-panel');
  if (!panel) return;
  const compact = window.matchMedia('(max-width: 1023px)').matches;
  const target = compact ? $('.playfield-wrap') : $('#rail-left');
  if (panel.parentElement !== target) target.appendChild(panel);
  panel.classList.toggle('floating', compact);
}
window.addEventListener('resize', () => { if (!$('#screen-game').hidden) placeTutorialPanel(); });

function syncInfoState() {
  const b = $('#tray-info');
  if (b) b.setAttribute('aria-expanded', $('#rail-left').classList.contains('open') ? 'true' : 'false');
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
    else toast(() => tr('Nothing to resume.'));
  });
  $('#btn-scores').addEventListener('click', () => { buildScoresScreen(); openOverlay('overlay-scores'); });
  $('#btn-achievements').addEventListener('click', () => { buildAchievements(); openOverlay('overlay-achv'); });
  $('#btn-help').addEventListener('click', () => openOverlay('overlay-help'));
  $('#btn-settings').addEventListener('click', () => { refreshGfxPanel(); openOverlay('overlay-settings'); });

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
  $('#btn-pause-settings').addEventListener('click', () => { refreshGfxPanel(); openOverlay('overlay-settings'); });
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
  // A modal overlay (pause, settings, help…) freezes solo simulation; cosmetic
  // rendering below continues so the board stays alive behind the sheet.
  if (game.session && !game.watching && !document.hidden && !anyOverlayOpen()) {
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

  step(15, tr('Loading rules…'));
  applySettingsToUI();
  bindUI();
  bindSettings();
  bindPointer();
  bindKeyboard();
  bindLifecycle();

  // Mirror the save records to the cloud slot after every persist point.
  onRecordsChange(() => {
    if (!platform.hosted) return;
    platform.saveCloud({ settings, progress, achievements: loadAchievements(), boards: loadBoards() });
    platform.mirrorSettings(settings);
  });
  $('#btn-signin').addEventListener('click', () => platform.signIn());
  $('#btn-invite').addEventListener('click', async () => {
    const ok = await platform.copyInvite();
    toast(() => (ok ? PT.inviteCopied : PT.inviteFailed));
  });
  platform.onAuth((a) => {
    if (!a.signedIn) toast(() => PT.signedOut, 4000);
    renderProfileLine();
  });
  // Another device saved first: merge both sides and save again.
  platform.onConflict((remote) => mergeCloud(remote));

  step(35, tr('Synchronising clock…'));
  platform.onSync(renderProfileLine);
  try { platform.init(); } catch { /* offline */ }
  try {
    await Promise.race([syncServerTime(), new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* local clock */ }
  if (platform.hosted) {
    // Remote save wins over the local cache (records are applied in place —
    // settings/progress are shared references throughout the app).
    try {
      await Promise.race([platform.fetchProfile(), new Promise((r) => setTimeout(r, 2000))]);
    } catch { /* nickname lands whenever it resolves */ }
    const remote = await platform.loadCloud();
    if (remote) {
      if (remote.settings) { Object.assign(settings, remote.settings); saveSettings(settings); }
      if (remote.progress) { Object.assign(progress, remote.progress); saveProgress(progress); }
      if (remote.achievements) saveAchievements(Object.assign(loadAchievements(), remote.achievements));
      if (remote.boards) saveBoards(remote.boards);
    }
    // Platform settings KV wins over the saved preferences.
    const kv = await platform.getSettings();
    if (Object.keys(kv).length) { Object.assign(settings, kv); saveSettings(settings); }
    syncSettingsForm();
    applySettingsToUI();
    audio.applyVolumes();
  }
  await platform.loadBindings();
  applySettingsToUI();
  renderProfileLine();

  step(60, tr('Building scene…'));
  await initRenderer();
  refreshGfxPanel();

  step(85, tr('Preparing content…'));
  refreshTitleStats();

  step(100, tr('Ready.'));
  lastFrame = performance.now();
  requestAnimationFrame(loop);
  showScreen('title');
}

boot().catch((err) => {
  console.error(err);
  $('#boot-status').textContent = tr('Failed to start: {reason}', { reason: err.message });
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
