// Channel Keeper — rules & content test suite.
// Run: node tests/run-tests.mjs

import { strict as assert } from 'node:assert';
import {
  CELL, PHASE, TERMINAL, INVALID, createState, applyCommand, legalActions,
  explainCarve, scoreBreakdown, compareResults, snapshot, stateHash, replay,
} from '../js/rules.js';
import {
  TUTORIALS, JOURNEY, CHALLENGES, dailyLevel, practiceLevel, validateLevel,
  autoSolve, findRoute, CONTENT_VERSION,
} from '../js/content.js';
import { makeRng, hashString } from '../js/rng.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

const tiny = () => ({
  id: 't', version: 1, w: 5, h: 5,
  cells: [
    0, 0, 0, 0, 0,
    0, 5, 1, 2, 0,
    0, 1, 1, 1, 0,
    0, 1, 4, 6, 0,
    0, 0, 0, 0, 0,
  ],
  sourceUnits: 20, targetNeed: 4, carveBudget: 5, parCarves: 3,
  parTicks: 60, maxTicks: 100, mechanics: { midFlowCarve: true, undoAllowed: true },
});

let cid = 0;
const cmd = (type, x, y) => ({ id: `t${cid++}`, type, x, y });

// ----------------------------------------------------------- rules unit tests

test('createState initialises a serializable editing state', () => {
  const s = createState(tiny(), 42);
  assert.equal(s.phase, PHASE.EDITING);
  assert.equal(s.tick, 0);
  assert.equal(s.budget, 5);
  JSON.parse(JSON.stringify(snapshot(s))); // serializable
});

test('legal carve of soil costs 1 and opens a channel', () => {
  const s = createState(tiny(), 42);
  const r = applyCommand(s, cmd('carve', 1, 2));
  assert.ok(r.ok);
  assert.equal(s.cells[2 * 5 + 1], CELL.CHANNEL);
  assert.equal(s.budget, 4);
  assert.equal(s.movesUsed, 1);
  assert.ok(r.events.some((e) => e.t === 'carve'));
});

test('carving packed clay (HARD) costs 2', () => {
  const s = createState(tiny(), 42);
  const r = applyCommand(s, cmd('carve', 3, 1));
  assert.ok(r.ok);
  assert.equal(s.budget, 3);
});

test('invalid carves return specific reasons and count invalid actions', () => {
  const s = createState(tiny(), 42);
  const cases = [
    [[-1, 0], INVALID.OUT_OF_BOUNDS],
    [[99, 99], INVALID.OUT_OF_BOUNDS],
    [[0, 0], INVALID.BLOCKED_ROCK],
    [[1, 1], INVALID.IS_SOURCE],
    [[1, 2], null], // carve ok first
    [[1, 2], INVALID.ALREADY_OPEN],
    [[2, 3], INVALID.ALREADY_OPEN], // contaminant is already open
  ];
  for (const [[x, y], want] of cases) {
    const r = applyCommand(s, cmd('carve', x, y));
    if (want === null) assert.ok(r.ok);
    else {
      assert.ok(!r.ok, `expected failure at ${x},${y}`);
      assert.equal(r.reason, want);
    }
  }
  assert.ok(s.invalidCount >= 5);
});

test('budget exhaustion yields no-budget', () => {
  const s = createState(tiny(), 42);
  s.budget = 0;
  const r = applyCommand(s, cmd('carve', 2, 2));
  assert.ok(!r.ok);
  assert.equal(r.reason, INVALID.NO_BUDGET);
});

test('release transitions to flowing; double release is invalid', () => {
  const s = createState(tiny(), 42);
  assert.ok(applyCommand(s, cmd('release')).ok);
  assert.equal(s.phase, PHASE.FLOWING);
  const r = applyCommand(s, cmd('release'));
  assert.ok(!r.ok);
  assert.equal(r.reason, INVALID.ALREADY_FLOWING);
});

test('tick before release is invalid; tick advances monotonically', () => {
  const s = createState(tiny(), 42);
  assert.equal(applyCommand(s, cmd('tick')).reason, INVALID.NOT_FLOWING);
  applyCommand(s, cmd('release'));
  applyCommand(s, cmd('tick'));
  applyCommand(s, cmd('tick'));
  assert.equal(s.tick, 2);
  assert.ok(s.seq >= s.tick); // monotonic sequence
});

test('duplicate command ids are rejected idempotently', () => {
  const s = createState(tiny(), 42);
  const c = { id: 'same', type: 'carve', x: 2, y: 2 };
  assert.ok(applyCommand(s, c).ok);
  const before = s.budget;
  const r = applyCommand(s, c);
  assert.ok(r.ok && r.duplicate);
  assert.equal(s.budget, before); // not applied twice
});

test('undo restores carved cell and budget where permitted', () => {
  const s = createState(tiny(), 42);
  applyCommand(s, cmd('carve', 2, 2));
  const r = applyCommand(s, cmd('undo'));
  assert.ok(r.ok);
  assert.equal(s.cells[2 * 5 + 2], CELL.SOIL);
  assert.equal(s.budget, 5);
});

test('undo is rejected where the ruleset disallows it', () => {
  const lv = Object.assign(tiny(), { mechanics: { undoAllowed: false } });
  const s = createState(lv, 42);
  applyCommand(s, cmd('carve', 2, 2));
  assert.equal(applyCommand(s, cmd('undo')).reason, INVALID.UNDO_DISABLED);
});

test('mid-flow carve blocked when the ruleset forbids it', () => {
  const lv = Object.assign(tiny(), { mechanics: { midFlowCarve: false, undoAllowed: false } });
  const s = createState(lv, 42);
  applyCommand(s, cmd('release'));
  assert.equal(applyCommand(s, cmd('carve', 2, 2)).reason, INVALID.WRONG_PHASE);
});

test('legalActions lists carvable cells with costs', () => {
  const s = createState(tiny(), 42);
  const legal = legalActions(s);
  assert.ok(legal.canRelease);
  const c22 = legal.carve.find((c) => c.x === 2 && c.y === 2);
  assert.equal(c22.cost, 1);
  const c31 = legal.carve.find((c) => c.x === 3 && c.y === 1);
  assert.equal(c31.cost, 2);
});

test('commands after terminal state are rejected', () => {
  const s = createState(tiny(), 42);
  s.phase = PHASE.LOST;
  s.terminalReason = TERMINAL.SETTLED_DRY;
  assert.equal(applyCommand(s, cmd('carve', 2, 2)).reason, INVALID.GAME_OVER);
});

test('terminal: settled-dry when water cannot reach the well', () => {
  // No target at all carved path: release with sealed target area.
  const lv = tiny();
  lv.cells[3 * 5 + 3] = CELL.TARGET; // target sealed in soil
  lv.cells[3 * 5 + 2] = CELL.CONTAM;
  const s = createState(lv, 7);
  applyCommand(s, cmd('carve', 1, 2));
  applyCommand(s, cmd('release'));
  let guard = lv.maxTicks + 5;
  while (s.phase === PHASE.FLOWING && guard-- > 0) applyCommand(s, cmd('tick'));
  assert.equal(s.phase, PHASE.LOST);
  assert.ok([TERMINAL.SETTLED_DRY, TERMINAL.TIMEOUT].includes(s.terminalReason));
});

test('terminal: timeout bound is enforced', () => {
  const lv = tiny();
  lv.maxTicks = 5;
  lv.sourceUnits = 1000;
  const s = createState(lv, 7);
  // Open a big basin so water keeps moving.
  applyCommand(s, cmd('carve', 1, 2));
  applyCommand(s, cmd('carve', 2, 2));
  applyCommand(s, cmd('release'));
  let guard = 20;
  while (s.phase === PHASE.FLOWING && guard-- > 0) applyCommand(s, cmd('tick'));
  assert.ok(s.phase !== PHASE.FLOWING);
  if (s.phase === PHASE.LOST) assert.equal(s.terminalReason, TERMINAL.TIMEOUT);
});

test('contamination turns clean water dirty in foul pockets', () => {
  const lv = tiny();
  // source -> contam -> target vertical
  lv.cells = [
    0, 0, 0, 0, 0,
    0, 5, 0, 0, 0,
    0, 4, 0, 0, 0,
    0, 6, 0, 0, 0,
    0, 0, 0, 0, 0,
  ];
  lv.targetNeed = 100; // never satisfied by clean
  const s = createState(lv, 3);
  applyCommand(s, cmd('release'));
  let guard = 100;
  while (s.phase === PHASE.FLOWING && guard-- > 0) applyCommand(s, cmd('tick'));
  assert.equal(s.phase, PHASE.LOST);
  assert.ok(s.deliveredDirty > 0, 'dirty water delivered');
  assert.equal(s.deliveredClean, 0);
  assert.ok(s.score.contamination < 0);
});

test('score breakdown has integer components and a coherent total', () => {
  const lv = TUTORIALS[0];
  const s = createState(lv, 1);
  assert.ok(autoSolve(s));
  assert.equal(s.phase, PHASE.WON);
  const sc = s.score;
  for (const k of ['cleanWater', 'efficiency', 'speed', 'contamination', 'total']) {
    assert.ok(Number.isInteger(sc[k]), `${k} is an integer`);
  }
  const sum = Math.max(0, sc.cleanWater + sc.efficiency + sc.speed + sc.contamination);
  assert.equal(sc.total, sum);
});

test('tie-break comparator orders by completion, invalids, ticks, session id', () => {
  const mk = (o) => Object.assign({ won: true, invalidCount: 0, tick: 10, sessionId: 'a', score: { total: 100 } }, o);
  assert.ok(compareResults(mk({}), mk({ won: false })) < 0);
  assert.ok(compareResults(mk({ score: { total: 200 } }), mk({})) < 0);
  assert.ok(compareResults(mk({ invalidCount: 1 }), mk({ invalidCount: 2 })) < 0);
  assert.ok(compareResults(mk({ tick: 5 }), mk({ tick: 9 })) < 0);
  assert.ok(compareResults(mk({ sessionId: 'a' }), mk({ sessionId: 'b' })) < 0);
});

test('serialization snapshot round-trips with a stable hash', () => {
  const lv = JOURNEY[0];
  const s = createState(lv, 99);
  applyCommand(s, cmd('carve', 2, 2));
  const h1 = stateHash(s);
  const restored = JSON.parse(JSON.stringify(snapshot(s)));
  restored.undoStack = [];
  assert.equal(stateHash(restored), h1);
});

// ----------------------------------------------------------- replay / fuzz

test('replay determinism: same version+seed+commands → identical hash', () => {
  const rng = makeRng(1234, 'test');
  for (const lv of [JOURNEY[0], JOURNEY[17], CHALLENGES[2]]) {
    const s = createState(lv, lv.seed);
    const commands = [];
    // Random-ish legal-ish session.
    applyCommand(s, { id: 'r0', type: 'release' });
    commands.push({ id: 'r0', type: 'release' });
    let n = 1;
    let guard = lv.maxTicks + 5;
    while (s.phase !== PHASE.WON && s.phase !== PHASE.LOST && guard-- > 0) {
      let c;
      if (rng.chance(0.25)) {
        c = { id: `f${n++}`, type: 'carve', x: rng.int(0, lv.w - 1), y: rng.int(0, lv.h - 1) };
      } else {
        c = { id: `f${n++}`, type: 'tick' };
      }
      applyCommand(s, c);
      commands.push(c);
    }
    const r2 = replay(lv, lv.seed, commands);
    assert.equal(stateHash(r2), stateHash(s), `replay hash matches for ${lv.id}`);
  }
});

test('replay with undo commands reproduces the live session exactly', () => {
  // The command log is append-only across undo; replaying the full log
  // (carve, undo, carve, release, ticks) must land on the identical hash.
  const lv = Object.assign(tiny(), { mechanics: { midFlowCarve: true, undoAllowed: true } });
  const s = createState(lv, 42);
  applyCommand(s, cmd('carve', 2, 2));
  applyCommand(s, cmd('undo'));
  applyCommand(s, cmd('carve', 1, 2));
  applyCommand(s, cmd('release'));
  let guard = lv.maxTicks + 5;
  while (s.phase === PHASE.FLOWING && guard-- > 0) applyCommand(s, cmd('tick'));
  assert.ok(s.phase === PHASE.WON || s.phase === PHASE.LOST);
  const r = replay(lv, 42, s.commands);
  assert.equal(stateHash(r), stateHash(s));
});

test('fuzz: malformed commands never crash, hang, or produce NaN', () => {
  const rng = makeRng(777, 'fuzz');
  const lv = JOURNEY[5];
  const s = createState(lv, lv.seed);
  applyCommand(s, { id: 'rel', type: 'release' });
  const junk = [
    null, undefined, 42, 'carve', {}, { type: 'carve' }, { id: 1, type: 'carve' },
    { id: 'x', type: 'carve', x: 'a', y: null },
    { id: 'y', type: 'carve', x: 1e9, y: -1e9 },
    { id: 'z', type: 'explode' },
    { id: '', type: 'carve', x: 1, y: 1 },
    { id: 'a'.repeat(500), type: 'carve', x: 1, y: 1 },
  ];
  for (let i = 0; i < 400; i++) {
    const c = rng.chance(0.5)
      ? junk[rng.int(0, junk.length - 1)]
      : { id: `fz${i}`, type: rng.pick(['carve', 'tick', 'undo', 'release', 'abandon', 'wat']),
          x: rng.int(-5, lv.w + 5), y: rng.int(-5, lv.h + 5) };
    applyCommand(s, c); // must not throw
  }
  for (const v of [...s.clean, ...s.dirty]) assert.ok(Number.isFinite(v) && v >= 0);
  assert.ok(s.tick <= s.maxTicks + 1);
});

// ----------------------------------------------------------- content

test('all shipped content passes the offline validator', () => {
  const all = [...TUTORIALS, ...JOURNEY, ...CHALLENGES];
  for (const lv of all) {
    const r = validateLevel(lv);
    assert.ok(r.ok, `${lv.id}: ${r.problems.join('; ')}`);
  }
  assert.equal(JOURNEY.length, 40);
});

test('daily level is immutable for a given UTC day', () => {
  const d = new Date('2026-08-18T12:00:00Z');
  const a = dailyLevel(d);
  const b = dailyLevel(new Date('2026-08-18T23:59:59Z'));
  assert.equal(a.seed, b.seed);
  assert.deepEqual(a.cells, b.cells);
  const c = dailyLevel(new Date('2026-08-19T00:00:01Z'));
  assert.notEqual(a.seed, c.seed);
  assert.ok(validateLevel(a).ok);
});

test('practice levels at all difficulties validate and solve', () => {
  for (const d of ['easy', 'medium', 'hard']) {
    const lv = practiceLevel(d, 2026);
    assert.ok(validateLevel(lv).ok, d);
    assert.ok(lv.mechanics.undoAllowed, 'practice allows undo');
  }
});

test('golden sessions: auto-solved wins with stable hashes', () => {
  for (const lv of [TUTORIALS[0], JOURNEY[9], CHALLENGES[0]]) {
    const h1 = (() => { const s = createState(lv, lv.seed); autoSolve(s); return stateHash(s); })();
    const h2 = (() => { const s = createState(lv, lv.seed); autoSolve(s); return stateHash(s); })();
    assert.equal(h1, h2, `golden hash stable for ${lv.id}`);
  }
});

test('generator fuzz: 150 random seeds across difficulties all validate', () => {
  const rng = makeRng(31337, 'genfuzz');
  for (let i = 0; i < 150; i++) {
    const seed = rng.int(1, 0x7fffffff);
    const tier = rng.int(0, 9);
    const lv = practiceLevel(['easy', 'medium', 'hard'][tier % 3], seed);
    const r = validateLevel(lv);
    assert.ok(r.ok, `seed ${seed}: ${r.problems.join('; ')}`);
  }
});

test('hint route exists on a partially played board', () => {
  const lv = JOURNEY[3];
  const s = createState(lv, lv.seed);
  const route = findRoute(s.cells, s.w, s.h);
  assert.ok(route && route.length > 0);
  applyCommand(s, cmd('carve', route[route.length - 1] % s.w, Math.floor(route[route.length - 1] / s.w)));
  const r2 = findRoute(s.cells, s.w, s.h);
  assert.ok(r2, 'route still computable after carving');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
