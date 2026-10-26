// Channel Keeper on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, session and the store are
// the browser build's js/*.js (ES modules) unchanged; this module is what
// js/main.js did around them — the screen flow (title → modes → levels →
// game ⇄ pause → results), the cursor and its keyboard, pointer, touch and
// gamepad input, digging with its explanations, releasing, undo, hints, the
// fast-forward and the replay viewer, the lessons' steps, outcomes (journey,
// challenge and daily records, achievements, the local score-chase boards),
// the interrupted round's snapshot, posting a ranked round to the high-score
// board, and the lifecycle. The screens and HUD are drawn by screens.ts
// (starhermit:ui), the dig face by render.ts (starhermit:scene).
//
// The flow's clock is the runtime's fixed steps (60 a second) fed to
// Session.advance: a pause, an open sheet or a hidden window never moves the
// water, and play scripts replay exactly.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onPlayerChange, onSessionEnded } from "starhermit:platform";
import { CELL, PHASE } from "../js/rules.js";
import { ACHIEVEMENTS, CHALLENGES, CONTENT_VERSION, JOURNEY, TUTORIALS, dailyKey, dailyLevel, findRoute, practiceLevel } from "../js/content.js";
import { Session } from "../js/session.js";
import { loadBoards, loadSessionSnapshot, submitScore, unlockAchievement } from "../js/storage.js";
import * as audio from "./audio.ts";
import { N, pt, tr } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { initStyles } from "./style.ts";

export type Level = (typeof JOURNEY)[number];
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge";
export type ScreenName = "title" | "modes" | "levels" | "play";
export type OverlayName = "pause" | "results" | "settings" | "help" | "achievements" | "scores" | "info";
export interface Results {
  won: boolean; reason: string; score: { cleanWater: number; efficiency: number; speed: number; contamination: number; total: number };
  tick: number; movesUsed: number; invalidCount: number; deliveredClean: number; deliveredDirty: number; budgetLeft: number;
  sessionId: string; levelId: string; seed: number; durationMs: number;
}
interface RulesEvent { t: string; x?: number; y?: number; hard?: boolean; clean?: number; dirty?: number; won?: boolean; reason?: string }

const STEP_MS = 1000 / 60;
const now = (): number => frame().time;

export const app = {
  screen: "title" as ScreenName,
  levelsMode: "journey" as "learn" | "journey" | "challenge" | "practice",
  /** Frame the screen or sheet opened on (the action that opened it must not also act on it). */
  openedFrame: 0,
  overlayOpenedFrame: 0,
  focusNext: null as string | null,
  overlays: [] as OverlayName[],
  toast: null as { text: () => string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  results: null as Results | null,
  newly: [] as string[],
  lb: null as { pending?: boolean; posted?: boolean; rank?: number | null } | null,
  confirmErase: false,
  signedOut: false,
  practiceDiff: "easy",
};
export const game = {
  session: null as Session | null,
  level: null as Level | null,
  mode: "practice" as Mode,
  cursor: { x: 0, y: 0 },
  tutStep: 0,
  springDry: false,
  watching: false,
  watch: null as { commands: { type: string; x?: number; y?: number }[]; i: number; wait: number; saved: Session } | null,
};
export const settings = platform.settings;

// ------------------------------------------------------------------ helpers
export function progress(): platform.Doc["progress"] { return platform.getDoc().progress; }
export function tutorialsDone(): string[] { return platform.getDoc().tutorialsDone; }
export function achievements(): Record<string, number> { return platform.getDoc().achievements as Record<string, number>; }
export function todayKey(): string { return dailyKey(new Date(platform.nowMs())); }
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** A transient toast; `text` re-reads in the current language. */
export function toast(text: () => string, seconds = 2.6): void { app.toast = { text, until: now() + seconds }; }
function haptic(ms: number): void { if (settings.haptics) vibrate(ms); }
function sound(name: string): void {
  audio.event(name);
  const cap = audio.CAPTIONS[name];
  if (cap) app.caption = { text: cap, until: now() + 1.8 };
}

/** Level names are authored as "Stage n", "Mastery n", "Daily — date", "Practice — Easy". */
export function levelName(lv: { name?: string } | null): string {
  const name = (lv && lv.name) || "";
  let m;
  if ((m = /^Stage (\d+)$/.exec(name))) return tr("Stage {n}", { n: m[1]! });
  if ((m = /^Mastery (\d+)$/.exec(name))) return tr("Mastery {n}", { n: m[1]! });
  if ((m = /^Daily — (.+)$/.exec(name))) return tr("Daily — {date}", { date: m[1]! });
  if ((m = /^Practice — (.+)$/.exec(name))) return tr("Practice — {level}", { level: tr(m[1]!) });
  return tr(name);
}
export function levelGoal(lv: { goal?: string } | null): string {
  const goal = (lv && lv.goal) || N("Deliver clean water to the well.");
  const m = /^Deliver (\d+) units of clean water\.$/.exec(goal);
  return m ? tr("Deliver {n} units of clean water.", { n: m[1]! }) : tr(goal);
}
const CELL_KEYS: Record<number, string> = {
  [CELL.ROCK]: N("solid rock — cannot be dug"),
  [CELL.SOIL]: N("soil — dig for 1"),
  [CELL.HARD]: N("packed clay — dig for 2"),
  [CELL.CHANNEL]: N("open channel"),
  [CELL.CONTAM]: N("foul pocket — contaminates water"),
  [CELL.SOURCE]: N("the spring"),
  [CELL.TARGET]: N("the well"),
};
/** The cursor's cell in words (the old HUD line and board mirror). */
export function cellInfo(x: number, y: number): string {
  const s = game.session?.state;
  if (!s) return "";
  const i = y * s.w + x;
  const water = s.clean[i] + s.dirty[i];
  const k = CELL_KEYS[s.cells[i]];
  return `${k ? tr(k) : tr("unknown")}${water ? " · " + tr("{n} water", { n: water }) : ""}`;
}
export function explainReason(r: string): string {
  const keys: Record<string, string> = {
    "out-of-bounds": N("outside the dig face"),
    "blocked-rock": N("solid rock cannot be dug"),
    "already-open": N("already open"),
    "is-source": N("that is the spring"),
    "is-target": N("that is the well"),
    "no-budget": N("dig budget exhausted"),
    "wrong-phase": N("not while water flows (this ruleset)"),
    "game-over": N("the round is over"),
  };
  return keys[r] ? tr(keys[r]!) : r;
}

// ------------------------------------------------------------------ screens and overlays
export function showScreen(name: ScreenName, focus: string | null = null): void {
  app.screen = name;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  if (name !== "play") app.overlays = app.overlays.filter((o) => o === "settings" || o === "help" || o === "scores" || o === "achievements");
  render.setVisible(name === "play");
  ui.setFocus(null);
}
export function topOverlay(): OverlayName | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function openOverlay(name: OverlayName): void {
  if (topOverlay() === name) return;
  app.overlays.push(name);
  app.overlayOpenedFrame = frame().frame;
  app.confirmErase = false;
}
export function closeOverlay(name: OverlayName | null = topOverlay()): void {
  if (!name) return;
  app.overlays = app.overlays.filter((o) => o !== name);
  app.confirmErase = false;
  if (name === "pause") { sound("resume"); announce(tr("Resumed.")); }
}
export function goTitle(): void {
  stopWatch();
  game.session = null;
  game.level = null;
  app.overlays = [];
  showScreen("title", "btn-play");
}
export function openLevels(mode: typeof app.levelsMode): void {
  app.levelsMode = mode;
  showScreen("levels", mode === "practice" ? "btn-practice-start" : "level-0");
}

// ------------------------------------------------------------------ level flow
function sessionOpts(): Record<string, unknown> {
  return { mode: game.mode, settings, seed: game.level!.seed, onEvents: handleEvents, onTerminal: handleTerminal };
}
export function startLevel(level: Level, mode: Mode, resume = false): void {
  stopWatch();
  game.level = level;
  game.mode = mode;
  game.tutStep = 0;
  let session: Session | null = null;
  if (resume) session = Session.restore(level, sessionOpts());
  if (!session) session = new Session(level, sessionOpts());
  game.session = session;
  game.springDry = session.state.sourceLeft <= 0;
  app.overlays = [];
  app.results = null;
  render.loadLevel(level);
  // Cursor starts below the source.
  const si = level.cells.indexOf(CELL.SOURCE);
  game.cursor = { x: si % level.w, y: Math.min(level.h - 1, Math.floor(si / level.w) + 1) };
  showScreen("play");
  updateCursor();
  if (game.mode === "learn" && level.tutorial) showTutorialStep();
  if (resume && session.state.tick > 0) {
    const st = session.state;
    toast(() => tr("Welcome back — {n} units delivered, tick {tick} when you left.", { n: st.deliveredClean, tick: st.tick }));
  }
  announce(tr("{name}. {goal} Dig budget {n}.", { name: levelName(level), goal: levelGoal(level), n: level.carveBudget }));
  sound("select");
}
export function startDaily(): void { startLevel(dailyLevel(new Date(platform.nowMs())) as Level, "daily"); }
export function startJourney(): void {
  const p = progress();
  startLevel(JOURNEY.find((l) => !p.journeyCompleted[l.id]) || JOURNEY[0]!, "journey");
}
export function startPractice(): void {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  startLevel(practiceLevel(app.practiceDiff, seed) as Level, "practice");
}
export function hasSnapshot(): boolean { return !!loadSessionSnapshot(); }
export function resumeSnapshot(): void {
  const snap = loadSessionSnapshot() as { levelId?: string; mode?: Mode; seed?: number } | null;
  const all = [...TUTORIALS, ...JOURNEY, ...CHALLENGES] as Level[];
  const lv = all.find((l) => l.id === snap?.levelId) ||
    (snap?.levelId?.startsWith("daily") ? dailyLevel(new Date(platform.nowMs())) as Level : null) ||
    (snap ? practiceLevel("medium", snap.seed ?? 0) as Level : null);
  if (lv && snap) startLevel(lv, snap.mode || "practice", true);
  else toast(() => tr("Nothing to resume."));
}
export function restartRound(): void {
  if (!game.level) return;
  startLevel(game.level, game.mode);
}

function handleEvents(events: RulesEvent[], state: Session["state"]): void {
  for (const e of events) {
    switch (e.t) {
      case "carve":
        sound(e.hard ? "carveHard" : "carve");
        announceCell(e.x!, e.y!);
        advanceTutorial("carve");
        break;
      case "release":
        sound("release");
        announce(tr("Water released."));
        advanceTutorial("release");
        break;
      case "deliver": sound("deliver"); break;
      case "contaminate":
        sound("contaminate");
        announce(tr("Water fouled by a contaminant pocket!"), true);
        break;
      case "undo": sound("undo"); break;
      case "tick":
        if (state.sourceLeft <= 0 && !game.springDry) {
          game.springDry = true;
          sound("springDry");
          toast(() => tr("The spring has run dry."));
          announce(tr("The spring has run dry. The water still in the channels must reach the well on its own."));
        }
        break;
    }
  }
  render.events(events);
  updateCursor();
}
function announceCell(x: number, y: number): void {
  const s = game.session?.state;
  if (!s) return;
  const t = s.cells[y * s.w + x];
  announce(tr(t === CELL.CHANNEL ? "Dug a channel at row {r}, column {c}. Budget {n}." : "Dug at row {r}, column {c}. Budget {n}.", { r: y + 1, c: x + 1, n: s.budget }));
}
export function updateCursor(): void {
  const s = game.session;
  if (!s) return;
  const { x, y } = game.cursor;
  render.setSelection(x, y, s.explain(x, y) === null);
}
export function moveCursor(dx: number, dy: number): void {
  const s = game.session;
  if (!s) return;
  game.cursor.x = Math.max(0, Math.min(s.state.w - 1, game.cursor.x + dx));
  game.cursor.y = Math.max(0, Math.min(s.state.h - 1, game.cursor.y + dy));
  updateCursor();
  sound("ui");
  announce(tr("Row {r} column {c}", { r: game.cursor.y + 1, c: game.cursor.x + 1 }) + ": " + cellInfo(game.cursor.x, game.cursor.y));
}

// ------------------------------------------------------------------ actions
function canAct(): boolean { return !!game.session && !game.watching && app.screen === "play" && !app.overlays.length; }
export function tryCarve(x: number, y: number, quiet = false): boolean {
  const s = game.session;
  if (!s || game.watching) return false;
  const reason = s.explain(x, y);
  if (reason) {
    if (!quiet) {
      sound("invalid");
      app.caption = { text: "not allowed: " + reason, until: now() + 1.8 };
      toast(() => explainReason(reason));
      announce(tr("Cannot dig: {reason}", { reason: explainReason(reason) }), true);
      render.setGhost(x, y, false);
      haptic(40);
    }
    return false;
  }
  const res = s.carve(x, y);
  if (res.ok) haptic(15);
  return res.ok;
}
export function doRelease(): void {
  if (!game.session || game.watching) return;
  const res = game.session.release();
  if (!res.ok && res.reason !== "duplicate") {
    sound("invalid");
    toast(() => tr("Already released."));
  }
}
export function doUndo(): void {
  if (!game.session || game.watching) return;
  const res = game.session.undo();
  if (!res.ok) {
    sound("invalid");
    const key = res.reason === "undo-disabled" ? N("Undo is only allowed in Practice and Learn.") : N("Nothing to undo.");
    toast(() => tr(key));
  } else toast(() => tr("Undone."));
}
export function doHint(): void {
  const s = game.session;
  if (!s || game.watching) return;
  // Hints use the same legality and route APIs as play; never a separate rulebook.
  const route = findRoute(s.state.cells, s.state.w, s.state.h) as number[] | null;
  if (!route) { toast(() => tr("No clean route exists from here — consider restarting.")); return; }
  const next = route.find((i) => s.state.cells[i] === CELL.SOIL || s.state.cells[i] === CELL.HARD);
  if (next == null) {
    const key = s.state.phase === PHASE.EDITING ? N("The route is open — release the water!") : N("The route is set; let it flow.");
    toast(() => tr(key));
    return;
  }
  const x = next % s.state.w, y = Math.floor(next / s.state.w);
  game.cursor = { x, y };
  updateCursor();
  render.setGhost(x, y, true);
  toast(() => tr("Try digging row {r}, column {c}.", { r: y + 1, c: x + 1 }));
  announce(tr("Hint: dig row {r}, column {c}.", { r: y + 1, c: x + 1 }));
  sound("hint");
}
export function doSkip(): void { if (game.session && !game.watching) game.session.skipToEnd(); }
export function pauseGame(): void {
  if (!game.session || game.watching || app.overlays.length) return;
  openOverlay("pause");
  sound("pause");
  announce(tr("Paused."));
}
export function resumeGame(): void { closeOverlay("pause"); }
export function leaveRound(): void {
  closeOverlay("pause");
  game.session?.abandon();
}

// ------------------------------------------------------------------ lessons
function showTutorialStep(): void {
  const steps = game.level?.tutorial?.steps;
  if (!steps) return;
  const step = steps[Math.min(game.tutStep, steps.length - 1)]!;
  announce(tr(step.text));
  if (step.focus) { game.cursor = { x: step.focus[0]!, y: step.focus[1]! }; updateCursor(); }
}
function advanceTutorial(action: string): void {
  if (game.mode !== "learn" || !game.level?.tutorial) return;
  const steps = game.level.tutorial.steps;
  if (game.tutStep >= steps.length) return;
  if (steps[game.tutStep]!.hint === action) {
    game.tutStep++;
    if (game.tutStep < steps.length) showTutorialStep();
  }
}

// ------------------------------------------------------------------ outcomes
function handleTerminal(results: Results): void {
  sound(results.won ? "win" : "lose");
  applyResults(results);
  app.results = results;
  app.overlays = ["results"];
  app.overlayOpenedFrame = frame().frame;
  render.setGhost(null);
  announce(results.won ? tr("Round complete. Score {n}.", { n: results.score.total }) : tr("Round failed."), true);
  // Signed in, ranked rounds (not Learn, Practice or abandoned) post to the high-score board.
  app.lb = null;
  if (platform.signedIn() && game.mode !== "practice" && game.mode !== "learn" && results.reason !== "abandoned") {
    const lb: { pending?: boolean; posted?: boolean; rank?: number | null } = { pending: true };
    app.lb = lb;
    void platform.postLeaderboard(results.score.total).then((r) => { if (app.lb === lb) app.lb = r; });
  }
}
export function boardId(): string {
  if (game.mode === "daily") return `daily-${game.level?.dailyKey || todayKey()}`;
  if (game.mode === "challenge") return `challenge-${game.level!.id}`;
  return "journey";
}
function assistsUsed(): string {
  const a: string[] = [];
  if (settings.timingAssist) a.push("timing");
  if (game.session?.state.mechanics.undoAllowed) a.push("undo");
  return a.join("+") || "none";
}
function applyResults(r: Results): void {
  app.newly = [];
  const unlock = (key: string): void => {
    if (unlockAchievement(key)) {
      app.newly.push(key);
      sound("achievement");
      const meta = ACHIEVEMENTS.find((a) => a.key === key);
      announce(tr("Achievement unlocked: {name}", { name: tr(meta?.name || key) }));
    }
  };
  const p = progress();
  if (r.won) {
    p.totalCleanWater += r.deliveredClean;
    if (r.deliveredDirty === 0) p.cleanWins++;
    unlock("first_flow");
    if (game.mode === "journey") {
      p.journeyBest[r.levelId] = Math.max(p.journeyBest[r.levelId] || 0, r.score.total);
      p.journeyCompleted[r.levelId] = { score: r.score.total, won: true };
      if (Object.keys(p.journeyCompleted).length >= 20) unlock("milestone_20");
    }
    if (game.mode === "learn") {
      const done = tutorialsDone();
      if (!done.includes(r.levelId)) done.push(r.levelId);
      if (TUTORIALS.every((t) => done.includes(t.id))) unlock("mechanic_mastery");
    }
    if (game.mode === "daily") {
      const key = game.level?.dailyKey || todayKey();
      p.daily[key] = { score: r.score.total, won: true, clean: r.deliveredClean };
      if (!p.dailyDays.includes(key)) p.dailyDays.push(key);
      if (p.dailyDays.length >= 3) unlock("streak_3");
    }
    if (game.mode === "challenge") p.challengesCompleted[r.levelId] = { score: r.score.total };
    if (p.totalCleanWater >= 500) unlock("long_haul");
    if (p.cleanWins >= 10) unlock("purity_10");
  }
  p.sessionsPlayed++;
  platform.persist();
  // Ranked-ish local boards: daily, journey, challenge (practice and lessons stay off).
  if (r.won && game.mode !== "practice" && game.mode !== "learn") {
    submitScore(boardId(), {
      name: "You", score: r.score.total, levelId: r.levelId, seed: r.seed,
      ruleset: `rules-v${CONTENT_VERSION}`, assists: assistsUsed(),
      durationTicks: r.tick, sessionId: r.sessionId, when: Date.now(),
    });
  }
}
/** The next stage or lesson after a win, or null. */
export function nextLevel(): Level | null {
  const r = app.results;
  if (!r || !r.won) return null;
  const list = game.mode === "journey" ? JOURNEY : game.mode === "learn" ? TUTORIALS : null;
  if (!list) return null;
  const i = (list as Level[]).findIndex((l) => l.id === r.levelId);
  return i >= 0 && i + 1 < list.length ? (list[i + 1] as Level) : null;
}
export function boardRank(): string {
  const r = app.results;
  if (!r) return "";
  if (game.mode === "practice") return tr("Practice round — unranked.");
  if (game.mode === "learn" || !r.won) return "";
  const board = (loadBoards() as Record<string, { sessionId: string }[]>)[boardId()] || [];
  const rank = board.findIndex((e) => e.sessionId === r.sessionId);
  return rank >= 0 ? tr("Board rank #{rank} of {total}.", { rank: rank + 1, total: board.length }) : "";
}

// ------------------------------------------------------------------ replay viewer
export function watchReplay(): void {
  const s = game.session;
  if (!s || game.watching || !game.level) return;
  // Undo is part of the deterministic command log (the rules engine replays it
  // exactly), so the whole log is run again; filtering it would diverge.
  const commands = s.state.commands.slice() as { type: string; x?: number; y?: number }[];
  const fresh = new Session(game.level, sessionOpts());
  // No terminal handling or persistence while watching: replaying must not
  // recreate the cleared resume snapshot of a finished round.
  fresh.onTerminal = () => undefined;
  (fresh as unknown as { _persist: () => void })._persist = () => undefined;
  app.overlays = [];
  game.watching = true;
  game.springDry = false;
  game.watch = { commands, i: 0, wait: 0, saved: s };
  game.session = fresh;
  render.loadLevel(game.level);
  toast(() => tr("Watching replay…"));
}
function stepWatch(): void {
  const w = game.watch;
  if (!w) return;
  if (w.wait > 0) { w.wait--; return; }
  if (w.i >= w.commands.length) { stopWatch(true); return; }
  const c = w.commands[w.i++]!;
  game.session!.command(c.type, c.x, c.y);
  w.wait = Math.round((c.type === "tick" ? 90 : 260) / STEP_MS);
}
function stopWatch(reopen = false): void {
  const w = game.watch;
  game.watch = null;
  game.watching = false;
  if (w) {
    game.session = w.saved;
    if (reopen) { app.overlays = ["results"]; app.overlayOpenedFrame = frame().frame; }
  }
}

// ------------------------------------------------------------------ settings hooks
export function replayTutorials(): void {
  platform.getDoc().tutorialsDone = [];
  platform.persist();
  toast(() => tr("Tutorials reset — find them under Learn."));
}
export function eraseProgress(): void {
  platform.eraseAll();
  app.confirmErase = false;
  app.overlays = [];
  toast(() => tr("Local progress erased."));
  showScreen("title", "btn-play");
}

// ------------------------------------------------------------------ input
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame && frame().frame !== app.overlayOpenedFrame;
  const top = topOverlay();
  if (top) {
    if (e.action === "pause" && fresh) {
      if (top === "pause") resumeGame();
      else if (top !== "results") closeOverlay(top);
    }
    return;
  }
  if (app.screen !== "play") {
    if (e.action === "pause" && fresh && app.screen !== "title") showScreen(app.screen === "levels" ? "modes" : "title", app.screen === "levels" ? "mode-learn" : "btn-play");
    return;
  }
  if (!canAct()) return;
  switch (e.action) {
    case "up": ui.setFocus(null); moveCursor(0, -1); break;
    case "down": ui.setFocus(null); moveCursor(0, 1); break;
    case "left": ui.setFocus(null); moveCursor(-1, 0); break;
    case "right": ui.setFocus(null); moveCursor(1, 0); break;
    case "carve": if (!ui.focused()) tryCarve(game.cursor.x, game.cursor.y); break;
    case "release": doRelease(); break;
    case "undo": doUndo(); break;
    case "hint": doHint(); break;
    case "camera": render.resetCamera(); break;
    case "pause": if (fresh) pauseGame(); break;
  }
});

// Board pointer and touch: hold/drag digs (the Hold to dig setting), else a
// tap digs; the mouse hovering previews the cell. Touch and the mouse can
// both report one tap: a pointer press right after a touch is skipped.
const drag = { active: false, last: null as { x: number; y: number } | null, at: 0, x: 0, y: 0, moved: false };
let lastTouch = -1e9;
function boardDown(px: number, py: number): void {
  if (!canAct() || ui.pointerOver()) { drag.active = false; return; }
  drag.active = true; drag.last = null; drag.at = now(); drag.x = px; drag.y = py; drag.moved = false;
  ui.setFocus(null);
  const cell = render.pick(px, py);
  if (!cell) return;
  game.cursor = cell;
  updateCursor();
  if (settings.holdToCarve) { tryCarve(cell.x, cell.y); drag.last = cell; }
}
function boardMove(px: number, py: number, mouse: boolean): void {
  if (!canAct()) return;
  const cell = render.pick(px, py);
  if (!drag.active) {
    if (mouse && cell && !ui.pointerOver()) {
      // hover preview (never required)
      game.cursor = cell;
      updateCursor();
      render.setGhost(cell.x, cell.y, game.session!.explain(cell.x, cell.y) === null);
    }
    return;
  }
  if (Math.hypot(px - drag.x, py - drag.y) > 8 * frame().scale) drag.moved = true;
  if (settings.holdToCarve && cell && (!drag.last || drag.last.x !== cell.x || drag.last.y !== cell.y)) {
    game.cursor = cell;
    updateCursor();
    tryCarve(cell.x, cell.y, true);
    drag.last = cell;
  }
}
function boardUp(px: number, py: number): void {
  if (!drag.active) return;
  drag.active = false;
  const tap = !drag.moved && now() - drag.at < 0.4;
  if (canAct() && !settings.holdToCarve && tap) {
    const cell = render.pick(px, py);
    if (cell) { game.cursor = cell; updateCursor(); tryCarve(cell.x, cell.y); }
  }
  render.setGhost(null);
}
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  if (e.pressed) boardDown(e.x, e.y); else boardUp(e.x, e.y);
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) boardMove(x, y, true); });
onTouch((e) => {
  if (!e.primary || e.control) return;
  lastTouch = now();
  if (e.phase === "start") boardDown(e.x, e.y);
  else if (e.phase === "move") boardMove(e.x, e.y, false);
  else if (e.phase === "end") boardUp(e.x, e.y);
  else { drag.active = false; render.setGhost(null); }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyPrefs(): void {
  const p = preferences();
  render.setReducedMotion(p.reducedMotion);
  render.setPalette(settings.palette, p.highContrast);
  render.setCameraView(settings.cameraView);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  applyLook();
  applyPrefs();
  showScreen("title", "btn-play");
});
onPreferencesChange(() => applyPrefs());
platform.onSettingsChange(() => applyPrefs());
onSessionEnded(() => { app.signedOut = true; toast(() => pt("signedOut"), 4); });
onPlayerChange((p) => { if (p) app.signedOut = false; });
// Backgrounding pauses the round (the browser build's flow stopped while the tab was hidden).
onSuspend(() => {
  if (game.session && !game.watching && !app.overlays.length && app.screen === "play") pauseGame();
  platform.flush();
});
onQuit(() => platform.flush());

onFixedUpdate(() => {
  const s = game.session;
  if (!s || app.screen !== "play") return;
  if (game.watching) { stepWatch(); return; }
  // A sheet over the round (pause, settings, help…) freezes the flow.
  if (!app.overlays.length) s.advance(STEP_MS);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t = now();
  if (app.toast && app.toast.until < t) app.toast = null;
  if (app.caption && app.caption.until < t) app.caption = null;
});
onRender(() => {
  drawScreens();
  const s = game.session;
  if (s && app.screen === "play") render.syncState(s.state, s.prev, s.alpha());
  render.update(frameDt);
});
