// Channel Keeper — versioned content: level generator, validators,
// tutorial lessons, journey progression, challenges, daily seeds, themes.

import { makeRng, hashString } from './rng.js';
import { CELL, PHASE, createState, applyCommand } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Deterministically generate a level from a seed and difficulty parameters.
 * params: { w, h, rockDensity, contamPools, contamSize, hardDensity,
 *           budgetSlack, sourceUnits, targetNeed, maxTicks, mechanics }
 * A solvable carve route is guaranteed by random-walking source→target and
 * leaving that corridor as ordinary soil (the player still has to carve it).
 */
export function generateLevel(seed, id, name, params, extra = {}) {
  const rng = makeRng(seed, 'content');
  const w = params.w, h = params.h;
  const cells = new Array(w * h).fill(CELL.SOIL);
  const at = (x, y) => y * w + x;

  // Rock border (the "cut face" frame).
  for (let x = 0; x < w; x++) { cells[at(x, 0)] = CELL.ROCK; cells[at(x, h - 1)] = CELL.ROCK; }
  for (let y = 0; y < h; y++) { cells[at(0, y)] = CELL.ROCK; cells[at(w - 1, y)] = CELL.ROCK; }

  // Interior rock clusters.
  const rockCount = Math.floor(w * h * (params.rockDensity || 0));
  for (let n = 0; n < rockCount; n++) {
    const x = rng.int(1, w - 2), y = rng.int(1, h - 2);
    cells[at(x, y)] = CELL.ROCK;
    if (rng.chance(0.5) && x + 1 < w - 1) cells[at(x + 1, y)] = CELL.ROCK;
    if (rng.chance(0.35) && y + 1 < h - 1) cells[at(x, y + 1)] = CELL.ROCK;
  }

  // Hard-rock veins (cost 2 to carve) once that mechanic exists.
  if (params.hardDensity) {
    const hardCount = Math.floor(w * h * params.hardDensity);
    for (let n = 0; n < hardCount; n++) {
      const x = rng.int(1, w - 2), y = rng.int(1, h - 2);
      if (cells[at(x, y)] === CELL.SOIL) cells[at(x, y)] = CELL.HARD;
    }
  }

  // Contaminant pools (blobs).
  const pools = params.contamPools || 0;
  for (let p = 0; p < pools; p++) {
    const cx = rng.int(2, w - 3), cy = rng.int(2, h - 3);
    const size = params.contamSize || 3;
    for (let n = 0; n < size; n++) {
      const x = Math.min(w - 2, Math.max(1, cx + rng.int(-1, 1)));
      const y = Math.min(h - 2, Math.max(1, cy + rng.int(-1, 1)));
      cells[at(x, y)] = CELL.CONTAM;
    }
  }

  // Source near the top, target near the bottom.
  const sx = rng.int(1, w - 2), sy = 1;
  const tx = rng.int(1, w - 2), ty = h - 2;
  cells[at(sx, sy)] = CELL.SOURCE;
  cells[at(tx, ty)] = CELL.TARGET;

  // Guaranteed solvable corridor: random walk from under the source to the
  // target, forcing every cell on the walk back to SOIL.
  let x = sx, y = sy + 1;
  const walkPath = [];
  let guard = w * h * 4;
  while ((x !== tx || y !== ty) && guard-- > 0) {
    if (cells[at(x, y)] !== CELL.TARGET) cells[at(x, y)] = CELL.SOIL;
    walkPath.push(at(x, y));
    const r = rng.next();
    if (r < 0.55 && y < ty) y++;
    else if (r < 0.775) x += x < tx ? 1 : -1;
    else x += rng.chance(0.5) ? 1 : -1;
    x = Math.min(w - 2, Math.max(1, x));
    y = Math.min(h - 2, Math.max(1, y));
  }
  cells[at(sx, sy)] = CELL.SOURCE;
  cells[at(tx, ty)] = CELL.TARGET;
  walkPath.push(at(sx, sy), at(tx, ty)); // endpoints also need clean flanks

  // Keep the guaranteed corridor contamination-safe: any foul pocket
  // touching a corridor cell is neutralized back to soil.
  for (const i of walkPath) {
    const cx = i % w, cy = Math.floor(i / w);
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (cells[j] === CELL.CONTAM) cells[j] = CELL.SOIL;
    }
  }

  // Guaranteed-route carve cost informs a fair dig budget.
  const route = findRoute(cells, w, h);
  const minCarves = route == null
    ? Math.floor((w + h) / 2)
    : route.reduce((sum, i) => sum + (cells[i] === CELL.HARD ? 2 : cells[i] === CELL.SOIL ? 1 : 0), 0);
  const budget = minCarves + (params.budgetSlack != null ? params.budgetSlack : 4);

  const level = {
    id,
    version: CONTENT_VERSION,
    name,
    seed: seed >>> 0,
    w, h, cells,
    sourceUnits: params.sourceUnits || 60,
    targetNeed: params.targetNeed || 20,
    carveBudget: budget,
    parCarves: minCarves,
    parTicks: params.parTicks || 120,
    maxTicks: params.maxTicks || 400,
    mechanics: Object.assign({ midFlowCarve: true, undoAllowed: false }, params.mechanics),
    theme: params.theme || 'bedrock',
    difficulty: params.difficulty || 1,
    tutorial: params.tutorial || null,
    goal: params.goal || `Deliver ${params.targetNeed || 20} units of clean water.`,
  };
  return Object.assign(level, extra);
}

/**
 * Gravity-aware route search: water can only descend or spread sideways,
 * never climb. DFS from the cell below (or beside) the source to the target
 * over carvable/open cells, avoiding contaminant pockets.
 * Returns an array of cell indices to carve, or null.
 */
export function findRoute(cells, w, h) {
  const passable = (t) => t === CELL.SOIL || t === CELL.HARD || t === CELL.CHANNEL || t === CELL.TARGET;
  const si = cells.indexOf(CELL.SOURCE);
  const ti = cells.indexOf(CELL.TARGET);
  if (si === -1 || ti === -1) return null;
  // A route cell may never touch a contaminant pocket: any open contact
  // (below or beside) would foul the water running through it.
  const touchesContam = (j) => {
    const x = j % w, y = Math.floor(j / w);
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (cells[ny * w + nx] === CELL.CONTAM) return true;
    }
    return false;
  };
  const prev = new Array(w * h).fill(-2);
  prev[si] = -1;
  // Iterative DFS, down-first so routes prefer gravity.
  const stack = [si];
  while (stack.length) {
    const i = stack.pop();
    if (i === ti) {
      const path = [];
      for (let j = ti; j !== si && j >= 0; j = prev[j]) path.push(j);
      return path;
    }
    const x = i % w, y = Math.floor(i / w);
    // Push sides first so "down" is popped first (LIFO).
    const moves = [[-1, 0], [1, 0], [0, 1]];
    for (const [dx, dy] of moves) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (prev[j] !== -2) continue;
      const t = cells[j];
      if ((t === CELL.TARGET || (passable(t) && t !== CELL.CONTAM)) && !touchesContam(j)) {
        prev[j] = i;
        stack.push(j);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offline validator: legality, reachable goal, bounded duration, no soft lock.
// ---------------------------------------------------------------------------

export function validateLevel(level) {
  const problems = [];
  if (!level.id || typeof level.id !== 'string') problems.push('missing id');
  if (!Number.isInteger(level.seed)) problems.push('missing seed');
  if (!Array.isArray(level.cells) || level.cells.length !== level.w * level.h) {
    problems.push('cell array size mismatch');
    return { ok: false, problems };
  }
  const sources = level.cells.filter((c) => c === CELL.SOURCE).length;
  const targets = level.cells.filter((c) => c === CELL.TARGET).length;
  if (sources !== 1) problems.push(`expected 1 source, found ${sources}`);
  if (targets !== 1) problems.push(`expected 1 target, found ${targets}`);
  if (level.carveBudget < 1) problems.push('carve budget < 1');
  if (level.sourceUnits < level.targetNeed) problems.push('source cannot meet target');
  if (!(level.maxTicks > 0 && level.maxTicks <= 10000)) problems.push('unbounded duration');

  // Reachability: gravity-aware route must exist (no soft lock).
  const route = findRoute(level.cells, level.w, level.h);
  const reachable = route != null;
  if (!reachable) problems.push('goal unreachable (soft lock)');

  // Solve simulation: carve corridor greedily, release, run to terminal.
  if (reachable) {
    const st = createState(level, level.seed);
    const solved = autoSolve(st);
    if (!solved) problems.push('auto-solver failed to reach terminal state');
    else if (st.phase !== PHASE.WON) problems.push(`auto-solve ended in ${st.phase}/${st.terminalReason}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Solver used by the validator and tests: carve the gravity-aware route,
 * release, tick to terminal. Returns true if a terminal phase was reached.
 */
export function autoSolve(state) {
  let n = 0;
  const route = findRoute(state.cells, state.w, state.h);
  if (!route) return false;
  for (const i of route) {
    const t = state.cells[i];
    if (t === CELL.SOIL || t === CELL.HARD) {
      applyCommand(state, { id: `solve-${n++}`, type: 'carve', x: i % state.w, y: Math.floor(i / state.w) });
    }
  }
  applyCommand(state, { id: 'solve-release', type: 'release' });
  let guard = state.maxTicks + 10;
  while (state.phase === PHASE.FLOWING && guard-- > 0) {
    applyCommand(state, { id: `solve-tick-${n++}`, type: 'tick' });
  }
  return state.phase === PHASE.WON || state.phase === PHASE.LOST;
}

// ---------------------------------------------------------------------------
// Tutorials (Learn mode) — one rule at a time; the player performs each act.
// ---------------------------------------------------------------------------

function tutorialLevel(id, name, build, steps, params) {
  const w = params.w, h = params.h;
  const cells = new Array(w * h).fill(CELL.SOIL);
  for (let x = 0; x < w; x++) { cells[x] = CELL.ROCK; cells[(h - 1) * w + x] = CELL.ROCK; }
  for (let y = 0; y < h; y++) { cells[y * w] = CELL.ROCK; cells[y * w + w - 1] = CELL.ROCK; }
  build(cells, w, h);
  return {
    id, version: CONTENT_VERSION, name, seed: hashString(id),
    w, h, cells,
    sourceUnits: params.sourceUnits || 40,
    targetNeed: params.targetNeed || 10,
    carveBudget: params.carveBudget,
    parCarves: params.carveBudget,
    parTicks: params.parTicks || 90,
    maxTicks: params.maxTicks || 300,
    mechanics: Object.assign({ midFlowCarve: true, undoAllowed: true }, params.mechanics),
    theme: params.theme || 'bedrock',
    difficulty: 0,
    tutorial: { steps },
    goal: params.goal,
  };
}

export const TUTORIALS = [
  tutorialLevel('tut-1', 'First Dig', (c, w, h) => {
    c[1 * w + 3] = CELL.SOURCE; c[(h - 2) * w + 3] = CELL.TARGET;
  }, [
    { text: 'Water is trapped at the spring up top. Carve a channel straight down to the well.', hint: 'carve', focus: [3, 2] },
    { text: 'Good. Keep carving downward — soil gives way with one dig.', hint: 'carve', focus: [3, 3] },
    { text: 'Now release the water and watch it follow your channel.', hint: 'release' },
  ], { w: 7, h: 8, carveBudget: 8, targetNeed: 8, sourceUnits: 30, goal: 'Carve a channel and release the water.' }),

  tutorialLevel('tut-2', 'Sideways Flow', (c, w, h) => {
    c[1 * w + 2] = CELL.SOURCE; c[(h - 2) * w + 5] = CELL.TARGET;
    for (let y = 2; y < h - 2; y++) c[y * w + 3] = CELL.ROCK;
  }, [
    { text: 'A rock wall blocks the direct path. Water can flow sideways through open channel.', hint: 'carve', focus: [2, 2] },
    { text: 'Carve down on the left, across the bottom, and back up is unnecessary — water sinks. Route down, then across to the well.', hint: 'carve', focus: [4, 7] },
    { text: 'Release when your channel reaches the well.', hint: 'release' },
  ], { w: 8, h: 9, carveBudget: 16, targetNeed: 8, sourceUnits: 30, goal: 'Route around the rock wall.' }),

  tutorialLevel('tut-3', 'Foul Pockets', (c, w, h) => {
    c[1 * w + 4] = CELL.SOURCE; c[(h - 2) * w + 4] = CELL.TARGET;
    c[4 * w + 4] = CELL.CONTAM; c[5 * w + 4] = CELL.CONTAM; c[4 * w + 3] = CELL.CONTAM;
  }, [
    { text: 'Those ochre pockets are contaminants. Water that touches them turns foul and scores nothing.', hint: 'carve', focus: [3, 2] },
    { text: 'Carve a channel that goes around the pockets — keep the water clean.', hint: 'carve', focus: [2, 4] },
    { text: 'Release and keep every drop clean.', hint: 'release' },
  ], { w: 9, h: 9, carveBudget: 20, targetNeed: 8, sourceUnits: 30, goal: 'Deliver water without touching contaminants.' }),

  tutorialLevel('tut-4', 'Packed Clay', (c, w, h) => {
    c[1 * w + 3] = CELL.SOURCE; c[(h - 2) * w + 3] = CELL.TARGET;
    for (let x = 2; x <= 4; x++) c[4 * w + x] = CELL.HARD;
  }, [
    { text: 'Banded clay is tougher: it costs 2 digs. Your dig budget is limited — spend it well.', hint: 'carve', focus: [3, 4] },
    { text: 'You can go through the clay or around it. Around is cheaper here.', hint: 'carve', focus: [1, 4] },
    { text: 'Release the water.', hint: 'release' },
  ], { w: 7, h: 9, carveBudget: 14, targetNeed: 8, sourceUnits: 30, goal: 'Manage your dig budget around packed clay.' }),

  tutorialLevel('tut-5', 'Live Reroute', (c, w, h) => {
    c[1 * w + 2] = CELL.SOURCE; c[(h - 2) * w + 5] = CELL.TARGET;
    c[3 * w + 2] = CELL.CONTAM; c[4 * w + 2] = CELL.CONTAM;
  }, [
    { text: 'Release first this time — trust me.', hint: 'release' },
    { text: 'The water is heading for a foul pocket! You can dig while water flows. Carve a side escape to the right before it arrives.', hint: 'carve', focus: [3, 2] },
    { text: 'Crisis handled. Finish the route down to the well.', hint: 'carve', focus: [5, 6] },
  ], { w: 8, h: 9, carveBudget: 18, targetNeed: 8, sourceUnits: 40, goal: 'Redirect flowing water mid-run.' }),
];

// ---------------------------------------------------------------------------
// Journey — 40 authored-progression stages (fixed seeds, tuned difficulty).
// One new concept at a time, then combination, then a mastery stage.
// ---------------------------------------------------------------------------

const JOURNEY_THEMES = ['bedrock', 'bedrock', 'aquifer', 'aquifer', 'ember', 'ember', 'frost', 'frost', 'verdant', 'verdant'];

function journeyParams(i) {
  // i: 0..39. Difficulty curve: size, density, hazards, tighter budget.
  const tier = Math.floor(i / 4); // 0..9
  const within = i % 4;
  const mastery = within === 3; // every 4th stage is a mastery check
  const w = Math.min(8 + Math.floor(tier / 2), 13);
  const h = Math.min(9 + tier, 16);
  const p = {
    w, h,
    rockDensity: Math.min(0.04 + tier * 0.012, 0.16),
    contamPools: tier >= 1 ? Math.min(1 + Math.floor(tier / 2), 5) : 0,
    contamSize: 2 + Math.floor(tier / 3),
    hardDensity: tier >= 2 ? Math.min(0.05 + tier * 0.008, 0.13) : 0,
    budgetSlack: mastery ? 1 : Math.max(1, 5 - Math.floor(tier / 2)),
    sourceUnits: 50 + tier * 8,
    targetNeed: 16 + tier * 4,
    parTicks: 90 + tier * 14,
    maxTicks: 320 + tier * 20,
    theme: JOURNEY_THEMES[tier],
    difficulty: tier + 1,
    mechanics: { midFlowCarve: tier >= 1, undoAllowed: false },
  };
  if (mastery) {
    p.contamPools += 1;
    p.parTicks = Math.floor(p.parTicks * 0.85);
  }
  return p;
}

export const JOURNEY = [];
for (let i = 0; i < 40; i++) {
  const mastery = i % 4 === 3;
  const name = mastery ? `Mastery ${Math.floor(i / 4) + 1}` : `Stage ${i + 1}`;
  JOURNEY.push(generateLevel(0xC0FFEE + i * 7919, `journey-${i + 1}`, name, journeyParams(i)));
}

// ---------------------------------------------------------------------------
// Challenge mode — constrained goals.
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  generateLevel(hashString('chal-moves-seed'), 'chal-moves', 'Shovel-Rationed', {
    w: 9, h: 11, rockDensity: 0.08, contamPools: 2, contamSize: 3, hardDensity: 0.06,
    budgetSlack: 0, sourceUnits: 60, targetNeed: 20, parTicks: 110, maxTicks: 320,
    theme: 'ember', difficulty: 3, mechanics: { midFlowCarve: true, undoAllowed: false },
  }, { goal: 'Win with the exact minimum dig budget. No slack.' }),
  generateLevel(hashString('chal-speed-seed'), 'chal-speed', 'Flash Flood', {
    w: 9, h: 10, rockDensity: 0.06, contamPools: 1, contamSize: 3, hardDensity: 0,
    budgetSlack: 4, sourceUnits: 60, targetNeed: 18, parTicks: 60, maxTicks: 140,
    theme: 'aquifer', difficulty: 3, mechanics: { midFlowCarve: true, undoAllowed: false },
  }, { goal: 'Beat the flood clock: fill the well before tick 140.' }),
  generateLevel(hashString('chal-noflow-seed'), 'chal-noflow', 'Blind Commit', {
    w: 10, h: 12, rockDensity: 0.1, contamPools: 3, contamSize: 3, hardDensity: 0.08,
    budgetSlack: 2, sourceUnits: 70, targetNeed: 22, parTicks: 130, maxTicks: 340,
    theme: 'frost', difficulty: 4, mechanics: { midFlowCarve: false, undoAllowed: false },
  }, { goal: 'No digging once the water is released. Plan the whole route first.' }),
  generateLevel(hashString('chal-maze-seed'), 'chal-maze', 'The Warrens', {
    w: 13, h: 14, rockDensity: 0.18, contamPools: 4, contamSize: 4, hardDensity: 0.1,
    budgetSlack: 2, sourceUnits: 90, targetNeed: 28, parTicks: 170, maxTicks: 420,
    theme: 'bedrock', difficulty: 5, mechanics: { midFlowCarve: true, undoAllowed: false },
  }, { goal: 'Thread a maze of rock and foul pockets.' }),
  generateLevel(hashString('chal-clay-seed'), 'chal-clay', 'Clay Heart', {
    w: 10, h: 12, rockDensity: 0.05, contamPools: 2, contamSize: 3, hardDensity: 0.22,
    budgetSlack: 3, sourceUnits: 70, targetNeed: 22, parTicks: 130, maxTicks: 340,
    theme: 'verdant', difficulty: 4, mechanics: { midFlowCarve: true, undoAllowed: false },
  }, { goal: 'Packed clay everywhere. Every dig costs double — budget carefully.' }),
  generateLevel(hashString('chal-purity-seed'), 'chal-purity', 'Purity Trial', {
    w: 11, h: 13, rockDensity: 0.07, contamPools: 6, contamSize: 4, hardDensity: 0.05,
    budgetSlack: 3, sourceUnits: 80, targetNeed: 26, parTicks: 150, maxTicks: 380,
    theme: 'frost', difficulty: 5, mechanics: { midFlowCarve: true, undoAllowed: false },
  }, { goal: 'A field of foul pockets. Deliver every drop clean.' }),
];

// ---------------------------------------------------------------------------
// Daily — one shared seed per UTC day. Immutable once published.
// ---------------------------------------------------------------------------

export function dailyKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dailyLevel(date = new Date()) {
  const key = dailyKey(date);
  const seed = hashString(`channel-keeper-daily-${key}`);
  // Deterministic per-day difficulty: weekday-graded.
  const dow = date.getUTCDay();
  const tier = 2 + (dow % 5);
  const level = generateLevel(seed, `daily-${key}`, `Daily — ${key}`, {
    w: 9 + (tier % 3), h: 11 + tier,
    rockDensity: 0.06 + tier * 0.012,
    contamPools: 1 + Math.floor(tier / 2),
    contamSize: 3,
    hardDensity: 0.05 + tier * 0.008,
    budgetSlack: 3,
    sourceUnits: 60 + tier * 6,
    targetNeed: 20 + tier * 2,
    parTicks: 110 + tier * 10,
    maxTicks: 340,
    theme: JOURNEY_THEMES[tier % JOURNEY_THEMES.length],
    difficulty: tier,
    mechanics: { midFlowCarve: true, undoAllowed: false },
  });
  level.dailyKey = key;
  return level;
}

// ---------------------------------------------------------------------------
// Practice — selectable difficulty, undo allowed, unranked.
// ---------------------------------------------------------------------------

export const PRACTICE_DIFFICULTIES = [
  { id: 'easy', name: 'Easy', params: { w: 7, h: 9, rockDensity: 0.04, contamPools: 0, hardDensity: 0, budgetSlack: 6, sourceUnits: 50, targetNeed: 14, parTicks: 100, maxTicks: 300, difficulty: 1 } },
  { id: 'medium', name: 'Medium', params: { w: 9, h: 11, rockDensity: 0.08, contamPools: 2, contamSize: 3, hardDensity: 0.06, budgetSlack: 4, sourceUnits: 60, targetNeed: 20, parTicks: 120, maxTicks: 340, difficulty: 2 } },
  { id: 'hard', name: 'Hard', params: { w: 11, h: 13, rockDensity: 0.12, contamPools: 4, contamSize: 4, hardDensity: 0.12, budgetSlack: 2, sourceUnits: 80, targetNeed: 26, parTicks: 150, maxTicks: 400, difficulty: 4 } },
];

export function practiceLevel(difficultyId, seed) {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.id === difficultyId) || PRACTICE_DIFFICULTIES[0];
  return generateLevel(seed >>> 0, `practice-${difficultyId}-${seed >>> 0}`, `Practice — ${d.name}`,
    Object.assign({}, d.params, { mechanics: { midFlowCarve: true, undoAllowed: true } }));
}

// ---------------------------------------------------------------------------
// Themes — presentation data only; never affect rules.
// ---------------------------------------------------------------------------

export const THEMES = {
  bedrock: {
    name: 'Bedrock', sky: 0x0b0e14, fog: 0x0b0e14,
    soil: 0x6b4f35, hard: 0x8a7a68, rock: 0x3a3f4a, channel: 0x241a12,
    contam: 0xc9a227, water: 0x3ec6ff, dirty: 0xb8860b, source: 0x59d8ff,
    target: 0x7dffc8, ambient: 'deep',
  },
  aquifer: {
    name: 'Aquifer', sky: 0x06121a, fog: 0x06121a,
    soil: 0x4f5e52, hard: 0x6e7f72, rock: 0x2c3a40, channel: 0x12201c,
    contam: 0xc9a227, water: 0x46e0d4, dirty: 0xb8860b, source: 0x6ef0e4,
    target: 0x9dffd8, ambient: 'wet',
  },
  ember: {
    name: 'Ember Deep', sky: 0x140a08, fog: 0x140a08,
    soil: 0x6e4534, hard: 0x8a6a52, rock: 0x402e2a, channel: 0x241310,
    contam: 0xd4b03a, water: 0x4fc0ff, dirty: 0xc07020, source: 0x66d0ff,
    target: 0xffc890, ambient: 'warm',
  },
  frost: {
    name: 'Frost Vein', sky: 0x0a1018, fog: 0x0a1018,
    soil: 0x5a6a78, hard: 0x8294a4, rock: 0x323e4c, channel: 0x18222c,
    contam: 0xc9a227, water: 0x62c8ff, dirty: 0xb8860b, source: 0x8adcff,
    target: 0xa8ffe0, ambient: 'cold',
  },
  verdant: {
    name: 'Verdant Root', sky: 0x0a120a, fog: 0x0a120a,
    soil: 0x5e5233, hard: 0x7e7452, rock: 0x35402e, channel: 0x1c1a10,
    contam: 0xc9a227, water: 0x3ec6ff, dirty: 0xb8860b, source: 0x59d8ff,
    target: 0xa0ffb0, ambient: 'deep',
  },
};

export function getTheme(id) {
  return THEMES[id] || THEMES.bedrock;
}

// ---------------------------------------------------------------------------
// Achievements — stable lowercase keys, idempotent unlocks.
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  { key: 'first_flow', name: 'First Flow', desc: 'Deliver clean water for the first time.' },
  { key: 'mechanic_mastery', name: 'Rule Scholar', desc: 'Complete every tutorial lesson.' },
  { key: 'streak_3', name: 'Three-Day Keeper', desc: 'Play the daily challenge on 3 different days.' },
  { key: 'milestone_20', name: 'Deep Delver', desc: 'Complete 20 journey stages.' },
  { key: 'long_haul', name: 'Reservoir', desc: 'Deliver 500 total units of clean water.' },
  { key: 'purity_10', name: 'Crystal Clear', desc: 'Win 10 rounds with zero contamination.' },
];
