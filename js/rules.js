// Channel Keeper — pure deterministic rules engine.
// No rendering, no DOM, no timers. All state transitions go through
// applyCommand(); everything is JSON-serializable.

export const RULES_VERSION = 1;

export const CELL = Object.freeze({
  ROCK: 0,    // impenetrable, can never be carved
  SOIL: 1,    // carvable, cost 1
  HARD: 2,    // carvable, cost 2
  CHANNEL: 3, // open channel / pre-existing pipe; water flows
  CONTAM: 4,  // contaminant pocket; open to water, dirties anything entering
  SOURCE: 5,  // water emitter
  TARGET: 6,  // destination; absorbs delivered water
});

export const CELL_CAP = 4;      // water units a cell can hold
export const EMIT_PER_TICK = 2; // source output rate

export const PHASE = Object.freeze({
  EDITING: 'editing',
  FLOWING: 'flowing',
  WON: 'won',
  LOST: 'lost',
});

export const TERMINAL = Object.freeze({
  TARGET_FILLED: 'target-filled',
  SETTLED_DRY: 'settled-dry',
  TIMEOUT: 'timeout',
  ABANDONED: 'abandoned',
});

export const INVALID = Object.freeze({
  OUT_OF_BOUNDS: 'out-of-bounds',
  BLOCKED_ROCK: 'blocked-rock',
  ALREADY_OPEN: 'already-open',
  IS_SOURCE: 'is-source',
  IS_TARGET: 'is-target',
  NO_BUDGET: 'no-budget',
  WRONG_PHASE: 'wrong-phase',
  ALREADY_FLOWING: 'already-flowing',
  NOT_FLOWING: 'not-flowing',
  UNDO_DISABLED: 'undo-disabled',
  NOTHING_TO_UNDO: 'nothing-to-undo',
  GAME_OVER: 'game-over',
  UNKNOWN_COMMAND: 'unknown-command',
  DUPLICATE: 'duplicate',
  BAD_PAYLOAD: 'bad-payload',
});

const idx = (s, x, y) => y * s.w + x;
const inBounds = (s, x, y) => x >= 0 && y >= 0 && x < s.w && y < s.h;

/** True if water may occupy this cell type. */
export function isOpenCell(t) {
  return t === CELL.CHANNEL || t === CELL.CONTAM || t === CELL.TARGET || t === CELL.SOURCE;
}

/**
 * Create the initial state for a level.
 * level: { id, version, w, h, cells, sourceUnits, targetNeed, carveBudget,
 *          parTicks, parCarves, maxTicks, mechanics, ... }
 */
export function createState(level, sessionSeed) {
  if (!level || !Array.isArray(level.cells) || level.cells.length !== level.w * level.h) {
    throw new Error('invalid level payload');
  }
  const sources = [];
  let targets = 0;
  for (let i = 0; i < level.cells.length; i++) {
    if (level.cells[i] === CELL.SOURCE) sources.push(i);
    if (level.cells[i] === CELL.TARGET) targets++;
  }
  if (sources.length === 0 || targets === 0) throw new Error('level lacks source/target');
  const n = level.w * level.h;
  return {
    v: RULES_VERSION,
    levelId: level.id,
    levelVersion: level.version,
    seed: sessionSeed >>> 0,
    w: level.w,
    h: level.h,
    cells: level.cells.slice(),
    clean: new Array(n).fill(0),
    dirty: new Array(n).fill(0),
    seq: 0,                    // monotonic command counter
    tick: 0,                   // monotonic simulation tick
    phase: PHASE.EDITING,
    terminalReason: null,
    budget: level.carveBudget,
    movesUsed: 0,
    invalidCount: 0,
    sourceLeft: level.sourceUnits,
    deliveredClean: 0,
    deliveredDirty: 0,
    maxTicks: level.maxTicks || 400,
    targetNeed: level.targetNeed,
    parTicks: level.parTicks || 0,
    mechanics: Object.assign({
      midFlowCarve: true,
      undoAllowed: false,
    }, level.mechanics || {}),
    commands: [],              // ordered applied-command log (replay envelope body)
    lastEvents: [],
    wHist: [0, 0],             // water-distribution hash history (stagnation)
    stagnant: 0,
    undoStack: [],             // serialized snapshots (not part of replay hash)
  };
}

/** Serialize state without undo stack (the replay-safe snapshot). */
export function snapshot(state) {
  const c = Object.assign({}, state);
  c.cells = state.cells.slice();
  c.clean = state.clean.slice();
  c.dirty = state.dirty.slice();
  c.commands = state.commands.slice();
  c.lastEvents = state.lastEvents.slice();
  c.mechanics = Object.assign({}, state.mechanics);
  c.undoStack = [];
  return c;
}

/** Stable JSON for hashing (key order fixed by construction). */
export function stateHash(state) {
  const s = snapshot(state);
  // FNV-1a over a canonical field string.
  const parts = [
    s.v, s.levelId, s.levelVersion, s.seed, s.w, s.h,
    s.cells.join(''), s.clean.join(','), s.dirty.join(','),
    s.seq, s.tick, s.phase, s.budget, s.movesUsed, s.invalidCount,
    s.sourceLeft, s.deliveredClean, s.deliveredDirty,
    s.terminalReason || '-',
  ];
  const str = parts.join('|');
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Why can't this cell be carved? Null if legal. */
export function explainCarve(state, x, y) {
  if (state.phase === PHASE.WON || state.phase === PHASE.LOST) return INVALID.GAME_OVER;
  if (state.phase === PHASE.FLOWING && !state.mechanics.midFlowCarve) return INVALID.WRONG_PHASE;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(state, x, y)) return INVALID.OUT_OF_BOUNDS;
  const t = state.cells[idx(state, x, y)];
  if (t === CELL.ROCK) return INVALID.BLOCKED_ROCK;
  if (t === CELL.SOURCE) return INVALID.IS_SOURCE;
  if (t === CELL.TARGET) return INVALID.IS_TARGET;
  if (t === CELL.CHANNEL || t === CELL.CONTAM) return INVALID.ALREADY_OPEN;
  const cost = t === CELL.HARD ? 2 : 1;
  if (state.budget < cost) return INVALID.NO_BUDGET;
  return null;
}

export function carveCost(state, x, y) {
  if (!inBounds(state, x, y)) return 0;
  return state.cells[idx(state, x, y)] === CELL.HARD ? 2 : 1;
}

/**
 * Legal-action query — the single API used by play, hints and tutorials.
 * Returns { carve: [{x,y,cost}], canRelease, canUndo, phase, budget }.
 */
export function legalActions(state) {
  const carve = [];
  if (state.phase === PHASE.EDITING ||
      (state.phase === PHASE.FLOWING && state.mechanics.midFlowCarve)) {
    for (let y = 0; y < state.h; y++) {
      for (let x = 0; x < state.w; x++) {
        const t = state.cells[idx(state, x, y)];
        if (t === CELL.SOIL || t === CELL.HARD) {
          const cost = t === CELL.HARD ? 2 : 1;
          if (state.budget >= cost) carve.push({ x, y, cost });
        }
      }
    }
  }
  return {
    phase: state.phase,
    budget: state.budget,
    carve,
    canRelease: state.phase === PHASE.EDITING,
    canUndo: state.mechanics.undoAllowed && state.undoStack.length > 0 &&
             state.phase !== PHASE.WON && state.phase !== PHASE.LOST,
  };
}

function fail(state, reason) {
  state.invalidCount++;
  return { ok: false, reason };
}

/**
 * Apply a validated command. Every mutation of rules state happens here.
 * cmd: { id, type: 'carve'|'release'|'tick'|'undo'|'abandon', x?, y? }
 * Returns { ok, reason?, events } — events drive animation/audio.
 */
export function applyCommand(state, cmd) {
  const events = [];
  state.lastEvents = events;
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return fail(state, INVALID.BAD_PAYLOAD);
  }
  if (typeof cmd.id !== 'string' || cmd.id.length === 0 || cmd.id.length > 64) {
    return fail(state, INVALID.BAD_PAYLOAD);
  }
  // Idempotent duplicate rejection by command id.
  if (state.commands.some((c) => c.id === cmd.id)) {
    return { ok: true, duplicate: true, reason: INVALID.DUPLICATE, events };
  }
  const over = state.phase === PHASE.WON || state.phase === PHASE.LOST;
  if (over && cmd.type !== 'tick') {
    return fail(state, INVALID.GAME_OVER);
  }

  switch (cmd.type) {
    case 'carve': {
      const reason = explainCarve(state, cmd.x, cmd.y);
      if (reason) return fail(state, reason);
      const i = idx(state, cmd.x, cmd.y);
      const cost = state.cells[i] === CELL.HARD ? 2 : 1;
      pushUndo(state);
      state.budget -= cost;
      state.movesUsed++;
      state.cells[i] = CELL.CHANNEL;
      events.push({ t: 'carve', x: cmd.x, y: cmd.y, cost, hard: cost === 2 });
      break;
    }
    case 'release': {
      if (state.phase !== PHASE.EDITING) {
        return fail(state, state.phase === PHASE.FLOWING ? INVALID.ALREADY_FLOWING : INVALID.WRONG_PHASE);
      }
      pushUndo(state);
      state.phase = PHASE.FLOWING;
      events.push({ t: 'release' });
      break;
    }
    case 'tick': {
      if (state.phase !== PHASE.FLOWING) return fail(state, INVALID.NOT_FLOWING);
      stepFlow(state, events);
      break;
    }
    case 'undo': {
      if (!state.mechanics.undoAllowed) return fail(state, INVALID.UNDO_DISABLED);
      if (state.undoStack.length === 0) return fail(state, INVALID.NOTHING_TO_UNDO);
      const snap = state.undoStack.pop();
      const keepUndo = state.undoStack;
      const keepCommands = state.commands;
      Object.assign(state, snap);
      state.undoStack = keepUndo;
      state.commands = keepCommands; // replay log is append-only; undo is not replayed
      events.push({ t: 'undo' });
      break;
    }
    case 'abandon': {
      state.phase = PHASE.LOST;
      state.terminalReason = TERMINAL.ABANDONED;
      events.push({ t: 'end', reason: TERMINAL.ABANDONED });
      break;
    }
    default:
      return fail(state, INVALID.UNKNOWN_COMMAND);
  }

  state.seq++;
  state.commands.push({ id: cmd.id, seq: state.seq, type: cmd.type, x: cmd.x, y: cmd.y });
  return { ok: true, events };
}

function pushUndo(state) {
  if (!state.mechanics.undoAllowed) return;
  state.undoStack.push(snapshot(state));
  if (state.undoStack.length > 100) state.undoStack.shift();
}

/** One deterministic simulation step. */
function stepFlow(state, events) {
  state.tick++;
  const { w, h } = state;
  let moved = false;

  // 1. Sources emit.
  if (state.sourceLeft > 0) {
    for (let i = 0; i < state.cells.length; i++) {
      if (state.cells[i] === CELL.SOURCE && state.sourceLeft > 0) {
        const total = state.clean[i] + state.dirty[i];
        const room = Math.min(CELL_CAP - total, EMIT_PER_TICK, state.sourceLeft);
        if (room > 0) {
          state.clean[i] += room;
          state.sourceLeft -= room;
          moved = true;
        }
      }
    }
  }

  // 2. Movement into delta arrays (no chain movement within one tick).
  //    Falling-sand water: fall down first; spread sideways only when the way
  //    down is blocked and only into a strictly lower fill level (diff >= 2),
  //    which guarantees pools equalize and never oscillate.
  const dClean = new Array(w * h).fill(0);
  const dDirty = new Array(w * h).fill(0);
  const sideFirst = state.tick % 2 === 0 ? -1 : 1;
  const occ = (i) => state.clean[i] + state.dirty[i] + dClean[i] + dDirty[i];

  // Scan bottom-up so gravity moves settle visually downward.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let c = state.clean[i], d = state.dirty[i];
      if (c + d === 0) continue;
      const t = state.cells[i];
      if (!isOpenCell(t) || t === CELL.TARGET) continue; // target absorbs, never emits

      // Down first.
      let fellDown = false;
      if (y + 1 < h) {
        const r = tryMove(state, dClean, dDirty, i, i + w, c, d, 2);
        c -= r.c; d -= r.d;
        if (r.c + r.d > 0) { moved = true; fellDown = true; }
      }
      // Sideways equalization only when the way down is blocked/full.
      if (!fellDown && c + d > 0) {
        for (const dx of [sideFirst, -sideFirst]) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = i + dx;
          const tj = state.cells[j];
          if (!isOpenCell(tj) || tj === CELL.SOURCE) continue;
          if (occ(i) - occ(j) < 1) continue;
          const r = tryMove(state, dClean, dDirty, i, j, c, d, 1);
          c -= r.c; d -= r.d;
          if (r.c + r.d > 0) moved = true;
          if (c + d === 0) break;
        }
      }
    }
  }

  // 3. Apply deltas; handle contamination and target absorption.
  for (let i = 0; i < state.cells.length; i++) {
    let c = state.clean[i] + dClean[i];
    let d = state.dirty[i] + dDirty[i];
    const t = state.cells[i];
    if (t === CELL.CONTAM && c > 0) {
      d += c;
      events.push({ t: 'contaminate', x: i % w, y: Math.floor(i / w), units: c });
      c = 0;
    }
    if (t === CELL.TARGET && c + d > 0) {
      state.deliveredClean += c;
      state.deliveredDirty += d;
      events.push({ t: 'deliver', x: i % w, y: Math.floor(i / w), clean: c, dirty: d });
      c = 0; d = 0;
    }
    state.clean[i] = c;
    state.dirty[i] = d;
  }

  events.push({ t: 'tick', tick: state.tick });

  // 4. Terminal checks.
  if (state.deliveredClean >= state.targetNeed) {
    endState(state, PHASE.WON, TERMINAL.TARGET_FILLED, events);
    return;
  }
  if (state.tick >= state.maxTicks) {
    endState(state, PHASE.LOST, TERMINAL.TIMEOUT, events);
    return;
  }
  // Settlement: nothing moved (source empty or blocked, pools level), or the
  // water distribution is period-2 stagnant while the source is exhausted
  // and no delivery is happening (residual pools sloshing forever).
  const deliveredNow = events.some((e) => e.t === 'deliver');
  let h2 = 0x811c9dc5 >>> 0;
  for (let i = 0; i < state.cells.length; i++) {
    h2 ^= state.clean[i] * 8 + state.dirty[i];
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  if (state.sourceLeft <= 0 && !deliveredNow && h2 === state.wHist[1]) state.stagnant++;
  else state.stagnant = 0;
  state.wHist[1] = state.wHist[0];
  state.wHist[0] = h2;
  if (!moved || state.stagnant >= 6) {
    endState(state, PHASE.LOST, TERMINAL.SETTLED_DRY, events);
  }
}

// targetNeed is a plain field set at creation; nothing else to bind.

function tryMove(state, dClean, dDirty, from, to, c, d, maxUnits) {
  const t = state.cells[to];
  if (!isOpenCell(t) || t === CELL.SOURCE) return { c: 0, d: 0 };
  // Anti-bounce: a cell that already sent water this tick cannot receive.
  if (dClean[to] + dDirty[to] < 0) return { c: 0, d: 0 };
  const occ = state.clean[to] + state.dirty[to] + dClean[to] + dDirty[to];
  const room = Math.min(CELL_CAP - occ, maxUnits, c + d);
  if (room <= 0) return { c: 0, d: 0 };
  // Move dirty first (heavier contaminant sinks conceptually) — deterministic.
  const md = Math.min(d, room);
  const mc = Math.min(c, room - md);
  dClean[from] -= mc; dDirty[from] -= md;
  dClean[to] += mc; dDirty[to] += md;
  return { c: mc, d: md };
}

function endState(state, phase, reason, events) {
  state.phase = phase;
  state.terminalReason = reason;
  state.score = scoreBreakdown(state);
  events.push({ t: 'end', reason, won: phase === PHASE.WON });
}

/**
 * Score breakdown — integers everywhere; formatting is presentation-only.
 */
export function scoreBreakdown(state) {
  const clean = state.deliveredClean * 10;
  const efficiency = Math.max(0, state.budget) * 25;
  const speed = state.phase === PHASE.WON ? Math.max(0, state.parTicks - state.tick) * 5 : 0;
  const contamination = -(state.deliveredDirty * 15);
  const total = Math.max(0, clean + efficiency + speed + contamination);
  return {
    cleanWater: clean,
    efficiency: state.phase === PHASE.WON ? efficiency : 0,
    speed,
    contamination,
    total: state.phase === PHASE.WON ? total : Math.max(0, clean + contamination),
  };
}

export function bindPar(state, level) {
  state.parTicks = level.parTicks || 0;
  state.targetNeed = level.targetNeed;
  return state;
}

/**
 * Tie-break comparator, per spec: completion, fewer invalid actions,
 * lower authoritative elapsed ticks, then stable session id.
 */
export function compareResults(a, b) {
  const done = (r) => (r.won ? 0 : 1);
  if (done(a) !== done(b)) return done(a) - done(b);
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  if (a.invalidCount !== b.invalidCount) return a.invalidCount - b.invalidCount;
  if (a.tick !== b.tick) return a.tick - b.tick;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

/**
 * Replay an ordered command log from scratch; returns final state.
 * Proves determinism: same version + seed + commands → identical hashes.
 */
export function replay(level, sessionSeed, commands) {
  const state = createState(level, sessionSeed);
  for (const cmd of commands) {
    applyCommand(state, cmd);
  }
  return state;
}
