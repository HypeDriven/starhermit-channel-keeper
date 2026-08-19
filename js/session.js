// Channel Keeper — session controller. Owns the rules state, command ids,
// the fixed-step tick loop, undo, replay envelopes, and resume snapshots.
// UI and rendering never mutate rules state except through Session.command().

import {
  createState, applyCommand, legalActions, explainCarve, snapshot,
  stateHash, scoreBreakdown, replay as rulesReplay, PHASE,
} from './rules.js';
import { saveSessionSnapshot, loadSessionSnapshot, clearSessionSnapshot } from './storage.js';

const TICK_MS = 220;          // fixed simulation step
const TICK_MS_ASSIST = 340;   // timing-assistance option

let sessionCounter = 0;

export class Session {
  /**
   * @param level content level object
   * @param opts { mode, seed, settings, onEvents, onTerminal }
   */
  constructor(level, opts = {}) {
    this.level = level;
    this.mode = opts.mode || 'practice';
    this.settings = opts.settings || {};
    this.sessionId = `s${Date.now().toString(36)}-${(sessionCounter++).toString(36)}`;
    this.state = createState(level, opts.seed != null ? opts.seed : level.seed);
    this.prev = null;                 // snapshot before last tick (interpolation)
    this.onEvents = opts.onEvents || (() => {});
    this.onTerminal = opts.onTerminal || (() => {});
    this._acc = 0;
    this._cmdSeq = 0;
    this._terminalFired = false;
    this.startedAt = Date.now();
  }

  get tickMs() {
    return this.settings.timingAssist ? TICK_MS_ASSIST : TICK_MS;
  }

  get phase() { return this.state.phase; }

  legal() { return legalActions(this.state); }

  explain(x, y) { return explainCarve(this.state, x, y); }

  /** The single entry point for every rules mutation. */
  command(type, x, y) {
    const id = `${this.sessionId}:${this._cmdSeq}`;
    const before = this.state.seq;
    const res = applyCommand(this.state, { id, type, x, y });
    if (res.ok && !res.duplicate) {
      this._cmdSeq++;
      if (this.state.seq !== before || type === 'undo') {
        this.onEvents(res.events, this.state);
        this._persist();
      }
      if ((this.state.phase === PHASE.WON || this.state.phase === PHASE.LOST) &&
          !this._terminalFired) {
        this._terminalFired = true;
        clearSessionSnapshot();
        this.onTerminal(this.results());
      }
    }
    return res;
  }

  /**
   * Advance wall-clock time; fires as many fixed 'tick' commands as owed.
   * Simulation rate never depends on frame rate.
   */
  advance(dtMs) {
    if (this.state.phase !== PHASE.FLOWING) return;
    this._acc += dtMs;
    let guard = 50;
    while (this._acc >= this.tickMs && this.state.phase === PHASE.FLOWING && guard-- > 0) {
      this._acc -= this.tickMs;
      this.prev = snapshot(this.state);
      this.prev.undoStack = [];
      this.command('tick');
    }
    if (this.state.phase !== PHASE.FLOWING) this._acc = 0;
  }

  /** Skip/fast-forward: settle into the exact deterministic end state. */
  skipToEnd() {
    let guard = this.state.maxTicks + 10;
    while (this.state.phase === PHASE.FLOWING && guard-- > 0) {
      this.prev = snapshot(this.state);
      this.command('tick');
    }
  }

  undo() { return this.command('undo'); }
  release() { return this.command('release'); }
  carve(x, y) { return this.command('carve', x, y); }
  abandon() { return this.command('abandon'); }

  /** Interpolation alpha for the renderer (fraction of tick elapsed). */
  alpha() {
    return this.state.phase === PHASE.FLOWING ? Math.min(1, this._acc / this.tickMs) : 1;
  }

  results() {
    const s = this.state;
    return {
      won: s.phase === PHASE.WON,
      reason: s.terminalReason,
      score: s.score || scoreBreakdown(s),
      tick: s.tick,
      movesUsed: s.movesUsed,
      invalidCount: s.invalidCount,
      deliveredClean: s.deliveredClean,
      deliveredDirty: s.deliveredDirty,
      budgetLeft: s.budget,
      sessionId: this.sessionId,
      levelId: this.level.id,
      seed: s.seed,
      durationMs: Date.now() - this.startedAt,
    };
  }

  /** Replay envelope per spec: versions, seed, hashes, ordered commands. */
  exportReplay() {
    const s = this.state;
    return {
      schema: 1,
      rulesVersion: s.v,
      contentVersion: this.level.version,
      levelId: this.level.id,
      seed: s.seed,
      initialHash: null, // initial state is a pure function of level+seed
      timestampOffset: this.startedAt,
      commands: s.commands.slice(),
      stateHash: stateHash(s),
      terminal: { phase: s.phase, reason: s.terminalReason, score: s.score || null },
    };
  }

  /** Validate a replay envelope against fresh deterministic replay. */
  static verifyReplay(level, envelope) {
    const st = rulesReplay(level, envelope.seed, envelope.commands);
    return {
      ok: stateHash(st) === envelope.stateHash,
      hash: stateHash(st),
      expected: envelope.stateHash,
      terminal: { phase: st.phase, reason: st.terminalReason, score: st.score },
    };
  }

  /** Persist a resume-safe snapshot (solo play; cleared on terminal). */
  _persist() {
    if (this.state.phase === PHASE.WON || this.state.phase === PHASE.LOST) return;
    saveSessionSnapshot({
      levelId: this.level.id,
      mode: this.mode,
      seed: this.state.seed,
      savedAt: Date.now(),
      state: snapshot(this.state),
      sessionId: this.sessionId,
    });
  }

  /** Try to restore an interrupted session. Returns a Session or null. */
  static restore(level, opts = {}) {
    const snap = loadSessionSnapshot();
    if (!snap || snap.levelId !== level.id || !snap.state) return null;
    const s = new Session(level, opts);
    s.state = snap.state;
    s.state.undoStack = [];
    s.sessionId = snap.sessionId || s.sessionId;
    s._cmdSeq = s.state.commands.length;
    return s;
  }
}
