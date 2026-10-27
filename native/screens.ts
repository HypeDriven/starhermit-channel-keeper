// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame: the title (key art, Play, Resume, Daily,
// Journey, Scores / Achievements / Help / Settings, the account line, Invite
// and Sign in), the mode cards, the level lists and the practice setup, the
// game (the Objective rail with the delivered bar, budget, fouled and tick
// counters and the lesson card; the Actions rail with Release, Undo, Hint,
// Fast-forward, Reset camera, Pause, the cursor and its cell), the touch
// tray and the Info drawer, the toast and the caption line, and the sheets
// (pause, results, settings, how to play, achievements, score chase). The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: both rails docked beside the board) and compact (the
// rails' content in the Info drawer, the actions a tray along the bottom,
// the lesson card floating over the board); landscape phones (≤ 540 px
// tall) put the key art beside the title menu. The left-handed setting
// swaps the rails and the tray's order. The dig face (render.ts) is framed
// into the play area the rails and tray leave.
import { frame, openMenu, clipboard } from "starhermit:engine";
import { bindingLabel } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import { TextureLoader, type Texture } from "starhermit:scene";
import { PHASE } from "../js/rules.js";
import { ACHIEVEMENTS, CHALLENGES, CONTENT_VERSION, JOURNEY, PRACTICE_DIFFICULTIES, TUTORIALS } from "../js/content.js";
import { loadBoards } from "../js/storage.js";
import { N, currentLocale, pt, tr } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  achievements, app, boardRank, cellInfo, closeOverlay, doHint, doRelease, doSkip, doUndo, eraseProgress, explainReason, game,
  goTitle, hasSnapshot, levelGoal, levelName, nextLevel, openLevels, openOverlay, pauseGame, progress, replayTutorials,
  restartRound, resumeGame, resumeSnapshot, leaveRound, settings, showScreen, startDaily, startJourney, startLevel,
  startPractice, todayKey, toast, topOverlay, tutorialsDone, watchReplay, type Level, type Mode, type OverlayName,
} from "./main.ts";
import { COLORS } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; shortLand: boolean; phone: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left / sc, oy: sa.top / sc, wide: lw >= 1024, shortLand: lw > lh && lh <= 540, phone: lw < 600 };
}
const lastHeight = new Map<string, number>();

function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; selected?: boolean; act: () => void; content?: () => void }
const PLAIN = ["btn"];
const buttonWidth = (b: Btn): number => textWidth(b.text, b.style ?? PLAIN, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (width != null && buttonWidth(b) > width) {
    const inner = width - 36;
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, width != null ? { width } : null).id(b.id).button(b.text, opts)) b.act();
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, align: "start" | "center" | "end" = "center", gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, align, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls: string | null = "body", id?: string, center = false): void {
  if (!text) return;
  const styles: (string | ui.Style)[] = cls ? [cls] : ["body"];
  if (center) styles.push({ text: { align: "center" } });
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: "h2" | "h3", text: string, width: number, id?: string): void {
  if (ui.measureText(text, { kind: "heading", style: cls }).width / ui.preferences().scale <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
/** Label / value rows (the old score table and HUD stats). */
function table(label: string, rows: [string, string, string?][], w: number, kCls = "score-th", vCls = "score-td"): void {
  ui.grid(label, () => {
    for (const [k, v, cls] of rows) { para(k, w * 0.7, cls ?? kCls); ui.style(cls ?? vCls).label(v); }
  }, { columns: [{ fr: 1 }, { width: "auto", align: "end" }], gap: { row: 4, column: 12 }, width: w });
}
function rule(w: number): void {
  ui.widget("", { role: "none", size: { width: w, height: 1 }, draw: (r) => draw.rect(r.x, r.y, r.width, Math.max(1, r.height), COLORS.line) });
}
// The player's locale; +0 turns a rounded -0 (a zero penalty) into 0.
const fmtInt = (n: number): string => new Intl.NumberFormat(currentLocale()).format(Math.round(n) + 0);
const keyOf = (action: string): string => bindingLabel(action);

// ------------------------------------------------------------------ art
const art: Record<string, Texture | null> = { key: null, won: null, lost: null };
let artAsked = false;
function loadArt(): void {
  if (artAsked) return;
  artAsked = true;
  const loader = new TextureLoader();
  // Decorative: a failed load simply leaves the art out.
  loader.loadAsync("assets/key-art.webp").then((t) => { art.key = t; }, () => undefined);
  loader.loadAsync("assets/well-filled.webp").then((t) => { art.won = t; }, () => undefined);
  loader.loadAsync("assets/water-spent.webp").then((t) => { art.lost = t; }, () => undefined);
}
/** A picture cropped to w × h in its framed box (the CSS object-fit: cover). */
function artImage(tex: Texture, w: number, h: number, cls: string): void {
  const ar = tex.width / Math.max(1, tex.height), box = w / h;
  const uv = ar > box
    ? { min: [(1 - box / ar) / 2, 0] as [number, number], max: [1 - (1 - box / ar) / 2, 1] as [number, number] }
    : { min: [0, (1 - ar / box) / 2] as [number, number], max: [1, 1 - (1 - ar / box) / 2] as [number, number] };
  ui.style(cls).column(`${cls}-box`, () => { ui.image("", tex, { width: w - 2, height: h - 2 }, uv); }, { clip: true });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  loadArt();
  const L = layoutNow();
  const f = frame();
  const playing = app.screen === "play" && !!game.session;
  if (!playing) draw.rect(0, 0, f.width, f.height, COLORS.bg);
  if (playing) playScreen(L);
  else if (app.screen === "title") titleScreen(L);
  else if (app.screen === "modes") modesScreen(L);
  else if (app.screen === "levels") levelsScreen(L);
  overlays(L);
  feedback(L, playing);
  // a screen that just opened focuses its first control once laid out
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

/** A screen: its column centred, scrolling when taller than the window. */
function screen(key: string, L: Layout, maxW: number, build: (inner: number) => void, center = false): void {
  const width = Math.max(200, Math.min(maxW, L.lw - 32));
  const h = lastHeight.get(key) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: L.ox, y: L.oy }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-panel`, () => build(width), { width, spacing: 16, align: center ? "center" : "start", padding: { top: 16, bottom: 16 } });
      lastHeight.set(key, r.height / L.sc);
    };
    if (h > L.lh) {
      ui.scrollArea(`${key}-scroll`, { width: L.lw, height: L.lh }, () => {
        ui.column(`${key}-scroll-col`, body, { width: L.lw - 12, align: "center" });
      });
    } else ui.column(`${key}-center`, body, { height: L.lh, width: L.lw, justify: center ? "center" : "start", align: "center" });
  }, { width: L.lw, height: L.lh });
}

// ------------------------------------------------------------------ title
function titleScreen(L: Layout): void {
  const side = L.shortLand && !!art.key;
  const p = progress();
  screen("title", L, side ? 900 : 712, (w) => {
    const menu = (mw: number): void => {
      ui.style("logo", L.shortLand ? { text: { size: 32 } } : L.phone ? { text: { size: 36 } } : null).id("title-h").label("Channel Keeper");
      para(tr("Carve the earth. Guide the water. Keep it clean."), mw, "tagline", "tagline", true);
      const bw = Math.min(352, mw);
      if (!side && art.key) {
        const aw = Math.min(mw, 576);
        artImage(art.key, aw, Math.min(aw * 0.47, L.lh * 0.34), "title-art");
      }
      ui.column("title-menu", () => {
        button({ id: "btn-play", text: tr("Play"), style: ["btn", "btn-primary", "btn-big"], act: () => showScreen("modes", "mode-learn") }, bw);
        if (hasSnapshot()) button({ id: "btn-resume", text: tr("Resume interrupted round"), act: resumeSnapshot }, bw);
        const sub = (id: string, text: string, extra: string, act: () => void): void => {
          button({
            id, text: `${text} ${extra}`, act,
            content: () => ui.row(`${id}-face`, () => { ui.label(text); ui.style("dim").label(extra); }, { spacing: 6, align: "center" }),
          }, bw);
        };
        sub("btn-daily", tr("Daily Challenge"), `(${todayKey()})`, startDaily);
        sub("btn-journey", tr("Journey"), `(${Object.keys(p.journeyCompleted).length}/${JOURNEY.length})`, startJourney);
        flow("title-small", [
          { id: "btn-scores", text: tr("Scores"), style: ["btn", "btn-small"], act: () => openOverlay("scores") },
          { id: "btn-achievements", text: tr("Achievements"), style: ["btn", "btn-small"], act: () => openOverlay("achievements") },
          { id: "btn-help", text: tr("Help"), style: ["btn", "btn-small"], act: () => openOverlay("help") },
          { id: "btn-settings", text: tr("Settings"), style: ["btn", "btn-small"], act: () => openOverlay("settings") },
        ], bw, "center");
      }, { spacing: 10, width: bw, align: "center" });
      const sync = platform.syncState();
      const line = platform.signedIn()
        ? tr("Playing as {name} · {sync}", { name: platform.displayName(), sync: sync === "synced" ? tr("progress synced") : sync === "saving" ? tr("saving…") : tr("cloud sync unavailable") })
        : tr("Playing as guest — progress is stored locally.");
      para(line, mw, "dim-small", "profile-line", true);
      if (app.signedOut) para(pt("signedOut"), mw, "dim-small", "signed-out", true);
      const plat: Btn[] = [];
      const link = platform.inviteLink();
      if (link) plat.push({ id: "btn-invite", text: pt("invite"), style: ["btn", "btn-small"], act: () => {
        try { clipboard.writeText(link); toast(() => pt("inviteCopied")); } catch { toast(() => pt("inviteFailed")); }
      } });
      if (!platform.signedIn()) plat.push({ id: "btn-signin", text: pt("signIn"), style: ["btn", "btn-small"], act: () => { void requestSignIn().catch(() => undefined); } });
      if (plat.length) flow("title-platform", plat, mw, "center");
    };
    if (side) {
      const artW = Math.min(w * 0.5, 440);
      ui.row("title-side", () => {
        artImage(art.key!, artW, Math.min(artW * 0.6, L.lh - 40), "title-art");
        ui.column("title-col", () => menu(w - artW - 24), { width: w - artW - 24, spacing: 8, align: "center" });
      }, { spacing: 24, align: "center", width: w });
    } else ui.column("title-col", () => menu(w), { width: w, spacing: 14, align: "center" });
  }, true);
}

// ------------------------------------------------------------------ modes and levels
const MODE_CARDS: { mode: Mode | "scores"; name: string; desc: string; meta: string }[] = [
  { mode: "learn", name: N("Learn"), desc: N("Interactive lessons, one rule at a time."), meta: N("Unranked · ~2 min each") },
  { mode: "journey", name: N("Journey"), desc: N("40 authored stages with rising depth."), meta: N("Progress saved · ~2–4 min each") },
  { mode: "daily", name: N("Daily"), desc: N("One shared seed per UTC day for everyone."), meta: N("Ranked locally · ~3 min") },
  { mode: "practice", name: N("Practice"), desc: N("Pick a difficulty. Undo allowed. Unranked."), meta: N("Unranked · your pace") },
  { mode: "challenge", name: N("Challenge"), desc: N("Tight budgets, speed targets, hard rules."), meta: N("Ranked locally · ~3–5 min") },
  { mode: "scores", name: N("Score Chase"), desc: N("Compare your best runs on local boards."), meta: N("Asynchronous comparison") },
];
function modesScreen(L: Layout): void {
  screen("modes", L, 712, (w) => {
    heading("h2", tr("Choose a mode"), w, "mode-h");
    const gap = 12;
    const cols = Math.max(1, Math.floor((w + gap) / (240 + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("mode-grid", () => {
      for (let i = 0; i < MODE_CARDS.length; i += cols) {
        ui.row(`mode-r${i}`, () => {
          for (const c of MODE_CARDS.slice(i, i + cols)) {
            const inner = cw - 34;
            const face = (): void => {
              ui.column(`mode-${c.mode}-face`, () => {
                ui.style("card-name").label(tr(c.name));
                ui.style("card-desc").paragraph(tr(c.desc), inner);
                ui.style("card-meta").paragraph(tr(c.meta), inner);
              }, { spacing: 5, width: inner });
            };
            if (ui.style("card", { width: cw }).id(`mode-${c.mode}`).button(tr(c.name), { content: face })) {
              if (c.mode === "daily") startDaily();
              else if (c.mode === "scores") openOverlay("scores");
              else openLevels(c.mode);
            }
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    button({ id: "btn-modes-back", text: tr("Back"), act: () => showScreen("title", "btn-play") }, w);
  });
}

function levelsScreen(L: Layout): void {
  const mode = app.levelsMode;
  const p = progress();
  const done = tutorialsDone();
  screen("levels", L, 712, (w) => {
    const titles: Record<string, [string, string]> = {
      learn: [N("Learn"), N("Interactive lessons. Each introduces one rule and asks you to perform it.")],
      journey: [N("Journey"), N("Forty stages of rising depth. Every fourth stage is a mastery check.")],
      challenge: [N("Challenge"), N("Constrained goals: tight budgets, speed targets, altered rules.")],
      practice: [N("Practice"), ""],
    };
    const [h, desc] = titles[mode]!;
    heading("h2", tr(h), w, "levels-h");
    if (desc) para(tr(desc), w, "dim", "levels-desc");
    if (mode === "practice") {
      ui.column("practice-setup", () => {
        ui.style("dim").label(tr("Difficulty"));
        flow("pdiff", PRACTICE_DIFFICULTIES.map((d) => ({
          id: `pdiff-${d.id}`, text: tr(d.name), style: ["btn", "btn-small", ...(app.practiceDiff === d.id ? ["btn-primary"] : [])],
          selected: app.practiceDiff === d.id, act: () => { app.practiceDiff = d.id; },
        })), w - 34, "start");
        para(tr("Practice allows undo and never affects ratings."), w - 34, "dim-small");
        button({ id: "btn-practice-start", text: tr("Start practice round"), style: ["btn", "btn-primary"], act: startPractice });
      }, { style: "setup-panel", width: w, spacing: 11 });
    } else {
      const list: { lv: Level; done: boolean; locked: boolean }[] = [];
      if (mode === "learn") for (const lv of TUTORIALS) list.push({ lv: lv as Level, done: done.includes(lv.id), locked: false });
      else if (mode === "journey") {
        const first = JOURNEY.findIndex((l) => !p.journeyCompleted[l.id]);
        JOURNEY.forEach((lv, i) => list.push({ lv, done: !!p.journeyCompleted[lv.id], locked: first !== -1 && i > first }));
      } else for (const lv of CHALLENGES) list.push({ lv: lv as Level, done: !!p.challengesCompleted[lv.id], locked: false });
      const gap = 8;
      const cols = Math.max(1, Math.floor((w + gap) / (144 + gap)));
      const cw = (w - gap * (cols - 1)) / cols;
      ui.column("level-list", () => {
        for (let i = 0; i < list.length; i += cols) {
          ui.row(`level-r${i}`, () => {
            list.slice(i, i + cols).forEach(({ lv, done: d, locked }, k) => {
              const idx = i + k;
              const best = p.journeyBest[lv.id];
              const cls = ["btn", "level-item", ...(d ? ["level-done"] : []), ...(lv.name.startsWith("Mastery") ? ["level-mastery"] : [])];
              const inner = cw - 22;
              const name = levelName(lv);
              const meta = `${lv.w}×${lv.h} · ` + tr("need {n}", { n: lv.targetNeed });
              const aria = [name, meta, d ? tr("complete") : "", locked ? tr("locked") : ""].filter(Boolean).join(", ");
              if (ui.style(...cls, { width: cw }).id(`level-${idx}`).button(aria, {
                disabled: locked,
                content: () => ui.column(`level-${idx}-face`, () => {
                  para(name, inner, "level-name");
                  para(meta, inner, "level-meta");
                  if (d) ui.style("level-stars").label("✓" + (best ? " · " + tr("best {n}", { n: fmtInt(best) }) : ""));
                  if (locked) ui.style("level-meta").label(tr("locked"));
                }, { spacing: 2, width: inner }),
              }) && !locked) startLevel(lv, mode as Mode);
            });
          }, { spacing: gap, align: "stretch" });
        }
      }, { spacing: gap, width: w });
    }
    button({ id: "btn-levels-back", text: tr("Back"), act: () => showScreen("modes", `mode-${mode}`) }, w);
  });
}

// ------------------------------------------------------------------ play
const phaseOf = (): string => (game.session ? String(game.session.phase) : "");
function objectiveRail(w: number, withLesson: boolean): void {
  const s = game.session!.state;
  ui.style("rail-h").label(tr("Objective").toUpperCase());
  para(levelGoal(game.level), w, "body", "hud-objective");
  const need = s.targetNeed || 1;
  const kw = 84;
  ui.row("hud-delivered", () => {
    ui.style("hud-k", { width: kw }).label(tr("Delivered"));
    const bw = Math.max(40, w - kw - 70);
    ui.widget(tr("Delivered"), {
      role: "image", size: { width: bw, height: 11 },
      draw: (r) => {
        draw.roundRect(r.x, r.y, r.width, r.height, r.height * 0.36, "#0d1420");
        const fw = r.width * Math.min(1, s.deliveredClean / need);
        if (fw > 0) draw.roundRect(r.x, r.y, fw, r.height, r.height * 0.36, COLORS.water);
      },
    });
    ui.style("hud-v", { text: { weight: "400" } }).id("hud-delivered-v").label(`${fmtInt(s.deliveredClean)} / ${fmtInt(need)}`);
  }, { spacing: 8, align: "center", width: w });
  const stat = (id: string, k: string, v: string | number): void => {
    ui.row(id, () => { ui.style("hud-k", { width: kw }).label(k); ui.style("hud-v").id(`${id}-v`).label(String(v)); }, { spacing: 8, align: "center" });
  };
  stat("hud-budget", tr("Dig budget"), s.budget);
  stat("hud-dirty", tr("Fouled"), fmtInt(s.deliveredDirty));
  stat("hud-tick", tr("Tick"), s.tick);
  if (withLesson) lessonCard(w, "tutorial-panel");
}
function lessonCard(w: number, cls: string): void {
  if (game.mode !== "learn" || !game.level?.tutorial) return;
  const steps = game.level.tutorial.steps;
  const step = steps[Math.min(game.tutStep, steps.length - 1)]!;
  ui.column("tutorial", () => {
    para(tr("{name} — step {n} of {total}", { name: levelName(game.level), n: Math.min(game.tutStep + 1, steps.length), total: steps.length }), w - 28, "tut-h", "tut-step-h");
    para(tr(step.text), w - 28, "tut-text", "tut-text");
  }, { style: cls, width: w, spacing: 4 });
}
interface Action { id: string; text: string; key: string; primary?: boolean; enabled: boolean; act: () => void }
function actions(): Action[] {
  const s = game.session!;
  const legal = s.legal();
  const free = !game.watching;
  const list: Action[] = [
    { id: "btn-release", text: tr("Release water"), key: keyOf("release"), primary: true, enabled: legal.canRelease && free, act: doRelease },
    { id: "btn-undo", text: tr("Undo"), key: keyOf("undo"), enabled: legal.canUndo && free, act: doUndo },
    { id: "btn-hint", text: tr("Hint"), key: keyOf("hint"), enabled: free && phaseOf() !== PHASE.WON && phaseOf() !== PHASE.LOST, act: doHint },
  ];
  if (phaseOf() === PHASE.FLOWING && free) list.push({ id: "btn-skip", text: tr("Fast-forward"), key: "", enabled: true, act: doSkip });
  list.push({ id: "btn-camera", text: tr("Reset camera"), key: keyOf("camera"), enabled: true, act: render.resetCamera });
  list.push({ id: "btn-pause", text: tr("Pause"), key: keyOf("pause"), enabled: free, act: pauseGame });
  return list;
}
function actionButton(a: Action, w: number): void {
  if (ui.style("btn", ...(a.primary ? ["btn-primary"] : []), { width: w }).id(a.id).button(a.text + (a.key ? ` (${a.key})` : ""), {
    disabled: !a.enabled,
    content: () => ui.row(`${a.id}-face`, () => {
      ui.label(a.text);
      if (a.key) ui.style("kbd").label(a.key);
    }, { spacing: 6, align: "center" }),
  })) a.act();
}
function cursorBits(w: number): void {
  const { x, y } = game.cursor;
  ui.row("hud-cursor", () => { ui.style("hud-k", { width: 84 }).label(tr("Cursor")); ui.style("hud-v").id("hud-cursor-v").label(`${x + 1}, ${y + 1}`); }, { spacing: 8, align: "center" });
  para(cellInfo(x, y), w, "dim-small", "hud-cellinfo");
}

function playScreen(L: Layout): void {
  const left = !!settings.leftHanded;
  let freeX = 0, freeW = L.lw, freeY = 0, freeH = L.lh;
  if (L.wide) {
    const leftW = Math.max(208, Math.min(272, L.lw * 0.2));
    const rightW = Math.max(176, Math.min(240, L.lw * 0.175));
    // the objective rail at the start (the end when left-handed), the actions opposite
    const objX = left ? L.lw - leftW : 0, actX = left ? 0 : L.lw - rightW;
    ui.place("rail-left", { anchor: "top-start", x: L.ox + objX, y: L.oy }, () => objectiveRail(leftW - 26, true),
      { style: left ? "rail-right" : "rail-left", width: leftW, height: L.lh, spacing: 11 });
    ui.place("rail-right", { anchor: "top-start", x: L.ox + actX, y: L.oy }, () => {
      ui.style("rail-h").label(tr("Actions").toUpperCase());
      for (const a of actions()) actionButton(a, rightW - 26);
      cursorBits(rightW - 26);
    }, { style: left ? "rail-left" : "rail-right", width: rightW, height: L.lh, spacing: 11 });
    freeX = left ? rightW : leftW;
    freeW = L.lw - leftW - rightW;
  } else {
    // the touch tray along the bottom: Info, Release, Undo, Hint, Pause
    const s = game.session!;
    const legal = s.legal();
    const tray: Btn[] = [
      { id: "tray-info", text: tr("Info"), act: () => openOverlay("info") },
      { id: "tray-release", text: tr("Release"), style: ["btn", "btn-tray", "btn-primary"], disabled: !legal.canRelease || game.watching, act: doRelease },
      { id: "tray-undo", text: tr("Undo"), disabled: !legal.canUndo || game.watching, act: doUndo },
      { id: "tray-hint", text: tr("Hint"), disabled: game.watching, act: doHint },
      { id: "tray-pause", text: tr("Pause"), disabled: game.watching, act: pauseGame },
    ];
    if (left) tray.reverse();
    const gap = 8, pad = 8;
    const bw = (L.lw - pad * 2 - gap * (tray.length - 1)) / tray.length;
    const trayH = 60;
    ui.place("tray", { anchor: "top-start", x: L.ox, y: L.oy + L.lh - trayH }, () => {
      ui.row("tray-row", () => {
        for (const b of tray) {
          const style = b.style ?? ["btn", "btn-tray"];
          const fits = textWidth(b.text, style) + 10 <= bw;
          const opts: ui.ButtonOptions = { disabled: !!b.disabled };
          if (!fits) opts.content = () => ui.style({ text: { size: 12, align: "center" } }).paragraph(b.text, bw - 14);
          if (ui.style(...style, { width: bw, padding: { start: 4, end: 4 } }).id(b.id).button(b.text, opts)) b.act();
        }
      }, { spacing: gap, align: "center", width: L.lw - pad * 2 });
    }, { style: "tray", width: L.lw, height: trayH });
    freeH = L.lh - trayH;
    // the lesson card floats over the board
    if (game.mode === "learn" && game.level?.tutorial) {
      const cw = Math.min(L.lw - 16, L.shortLand ? Math.min(352, L.lw * 0.46) : 544);
      const r = ui.place("tut-float", { anchor: "top-start", x: L.ox + (L.shortLand ? 8 : (L.lw - cw) / 2), y: L.oy + 8 }, () => lessonCard(cw, "tutorial-floating"), { width: cw });
      if (!L.shortLand) { const used = r.height / L.sc + 12; freeY = used; freeH -= used; }
    }
  }
  render.setPlayfield((L.ox + freeX) * L.sc, (L.oy + freeY) * L.sc, freeW * L.sc, freeH * L.sc, frame().width, frame().height);
}

// ------------------------------------------------------------------ sheets
function dialogFrame(name: OverlayName, title: string, L: Layout, maxW: number, build: (w: number) => void, closable = true): void {
  const w = Math.min(maxW, L.lw - 32 - 44);
  const avail = L.lh - 32 - 44;
  const h = lastHeight.get(`dlg-${name}`) ?? 0;
  const body = (): void => {
    const r = ui.column(`${name}-body`, () => {
      if (title) heading("h2", title, w, `${name}-h`);
      build(w);
    }, { spacing: 13, width: w });
    lastHeight.set(`dlg-${name}`, r.height / L.sc);
  };
  const open = ui.dialog(name, "", true, () => {
    if (h > avail) ui.scrollArea(`${name}-scroll`, { width: w + 14, height: avail }, body);
    else body();
  });
  // The Escape that opened it must not close it the same frame; results only close by a choice.
  if (!open && closable && frame().frame !== app.overlayOpenedFrame) closeOverlay(name);
}
function overlays(L: Layout): void {
  const top = topOverlay();
  if (!top) return;
  switch (top) {
    case "pause": pauseSheet(L); break;
    case "results": resultsSheet(L); break;
    case "settings": settingsSheet(L); break;
    case "help": helpSheet(L); break;
    case "achievements": achievementsSheet(L); break;
    case "scores": scoresSheet(L); break;
    case "info": infoDrawer(L); break;
  }
}
function pauseSheet(L: Layout): void {
  dialogFrame("pause", tr("Paused"), L, 384, (w) => {
    button({ id: "btn-resume-game", text: tr("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
    button({ id: "btn-pause-settings", text: tr("Settings"), act: () => openOverlay("settings") }, w);
    button({ id: "btn-pause-help", text: tr("Help"), act: () => openOverlay("help") }, w);
    button({ id: "btn-pause-restart", text: tr("Restart round"), act: () => { closeOverlay("pause"); restartRound(); } }, w);
    button({ id: "btn-pause-leave", text: tr("Leave round"), style: ["btn", "btn-danger"], act: leaveRound }, w);
  });
}
function resultsSheet(L: Layout): void {
  const r = app.results;
  if (!r) { closeOverlay("results"); return; }
  dialogFrame("results", tr(r.won ? "Well filled!" : "The water is spent"), L, 672, (w) => {
    const pic = r.won ? art.won : art.lost;
    if (pic && L.lh >= 480) artImage(pic, w, Math.max(110, Math.min(200, L.lh * 0.22)), "results-art");
    const reasons: Record<string, string> = {
      "target-filled": N("The well drank its fill of clean water."),
      "settled-dry": N("The water settled before reaching the well."),
      timeout: N("Time ran out — the flood stalled."),
      abandoned: N("Round abandoned."),
    };
    para(reasons[r.reason] ? tr(reasons[r.reason]!) : r.reason, w, "dim", "results-reason");
    table("score-table", [
      [tr("Clean water"), fmtInt(r.score.cleanWater)],
      [tr("Terrain efficiency"), fmtInt(r.score.efficiency)],
      [tr("Speed"), fmtInt(r.score.speed)],
      [tr("Contamination"), fmtInt(r.score.contamination)],
    ], w);
    rule(w);
    table("score-total", [[tr("Total"), fmtInt(r.score.total), "score-total"]], w);
    const bits: string[] = [];
    if (game.mode === "journey") bits.push(tr("Journey: {n} / {total} stages complete.", { n: Object.keys(progress().journeyCompleted).length, total: JOURNEY.length }));
    if (game.mode === "learn") bits.push(tr("Lessons: {n} / {total}.", { n: tutorialsDone().length, total: TUTORIALS.length }));
    bits.push(tr("{clean} clean · {fouled} fouled · {digs} digs · tick {tick}.", { clean: fmtInt(r.deliveredClean), fouled: fmtInt(r.deliveredDirty), digs: r.movesUsed, tick: r.tick }));
    para(bits.join(" "), w, "dim", "results-progress");
    para(boardRank(), w, "dim", "results-compare");
    const lb = app.lb;
    if (lb) para(lb.pending ? pt("lbPosting") : !lb.posted ? pt("lbNotPosted") : lb.rank ? pt("lbRank", { rank: lb.rank }) : pt("lbPosted"), w, "dim", "results-lb");
    const earned = ACHIEVEMENTS.filter((a) => achievements()[a.key]).length;
    if (earned) ui.style("achv-chip").id("results-achv").label(tr("{n} / {total} achievements", { n: earned, total: ACHIEVEMENTS.length }));
    for (const k of app.newly) {
      const a = ACHIEVEMENTS.find((x) => x.key === k);
      para(tr("Achievement unlocked: {name}", { name: tr(a?.name || k) }), w, "body");
    }
    const next = nextLevel();
    const btns: Btn[] = [{ id: "btn-retry", text: tr("Retry"), style: ["btn", "btn-primary"], act: restartRound }];
    if (next) btns.push({ id: "btn-next-level", text: tr(game.mode === "learn" ? N("Next lesson") : N("Next stage")), act: () => startLevel(next, game.mode) });
    btns.push({ id: "btn-watch-replay", text: tr("Watch replay"), act: watchReplay });
    btns.push({ id: "btn-results-exit", text: tr("Back to title"), act: goTitle });
    flow("results-buttons", btns, w);
    para(tr("seed {seed} · ruleset v{version} · session {session}", { seed: r.seed, version: CONTENT_VERSION, session: r.sessionId }), w, "dim-small", "results-seed");
  }, false);
}
const PALETTE_OPTIONS: [string, string][] = [
  ["default", N("Default")], ["deuteranopia", N("Deuteranopia-safe")], ["protanopia", N("Protanopia-safe")],
  ["tritanopia", N("Tritanopia-safe")], ["contrast", N("High-contrast hues")],
];
function settingsSheet(L: Layout): void {
  dialogFrame("settings", tr("Settings"), L, 760, (w) => {
    const checks: ["leftHanded" | "holdToCarve" | "timingAssist" | "haptics", string][] = [
      ["leftHanded", tr("Left-handed controls")], ["holdToCarve", tr("Hold/drag to dig (off = tap toggle)")],
      ["timingAssist", tr("Timing assistance (slower water)")], ["haptics", tr("Haptics")],
    ];
    // two columns (the old auto-fit grid) when every checkbox's label fits in one
    const colW = (w - 12) / 2;
    const two = checks.every(([, t]) => textWidth(t, "body") + 44 <= colW - 28);
    const gw0 = two ? colW : w;
    const group = (id: string, legend: string, build: (gw: number) => void): void => {
      ui.column(id, () => { ui.style("legend").label(legend); build(gw0 - 28); }, { style: "fieldset", width: gw0, spacing: 8 });
    };
    const view = (): void => group("set-view", tr("Graphics"), (gw) => {
      ui.row("set-camera-row", () => {
        ui.label(tr("Camera"));
        const views = ["fit", "close"];
        const i = ui.id("set-camera").select(tr("Camera"), Math.max(0, views.indexOf(settings.cameraView)), [tr("Fit board"), tr("Close")]);
        if (views[i] && views[i] !== settings.cameraView) platform.setSetting("cameraView", views[i]!);
      }, { spacing: 12, align: "center", width: gw });
      para(tr("Graphics quality, frame rate, reduced motion, audio, language and controls are in the StarHermit Options."), gw, "dim-small");
      button({ id: "btn-open-options", text: tr("Open Options"), style: ["btn", "btn-small"], act: () => openMenu() });
    });
    const access = (): void => group("set-access", tr("Accessibility"), (gw) => {
      ui.row("set-palette-row", () => {
        ui.label(tr("Color palette"));
        const i = ui.id("set-palette").select(tr("Color palette"), Math.max(0, PALETTE_OPTIONS.findIndex(([v]) => v === settings.palette)), PALETTE_OPTIONS.map(([, t]) => tr(t)));
        const v = PALETTE_OPTIONS[i]?.[0];
        if (v && v !== settings.palette) platform.setSetting("palette", v);
      }, { spacing: 12, align: "center", width: gw });
      for (const [key, label] of checks) {
        const cur = !!settings[key];
        const next = ui.id(`set-${key}`).checkbox(label, cur);
        if (next !== cur) platform.setSetting(key, next);
      }
    });
    const data = (): void => group("set-data", tr("Data"), (gw) => {
      if (app.confirmErase) {
        para(tr("Erase all local progress, scores, and achievements?"), gw, "body", "erase-q");
        flow("erase-confirm", [
          { id: "btn-erase-yes", text: tr("Erase"), style: ["btn", "btn-small", "btn-danger"], act: eraseProgress },
          { id: "btn-erase-no", text: tr("Cancel"), style: ["btn", "btn-small"], act: () => { app.confirmErase = false; } },
        ], gw, "start");
      } else {
        flow("data-btns", [
          { id: "btn-replay-tuts", text: tr("Replay tutorials"), style: ["btn", "btn-small"], act: replayTutorials },
          { id: "btn-wipe", text: tr("Erase local progress"), style: ["btn", "btn-small", "btn-danger"], act: () => { app.confirmErase = true; } },
        ], gw, "start");
      }
    });
    if (two) {
      ui.row("settings-cols", () => {
        ui.column("settings-col-a", () => { access(); }, { spacing: 12, width: colW });
        ui.column("settings-col-b", () => { view(); data(); }, { spacing: 12, width: colW });
      }, { spacing: 12, align: "start", width: w });
    } else { view(); access(); data(); }
    button({ id: "btn-settings-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("settings") }, w);
  });
}
type Icon = "soil" | "hard" | "contam" | "source" | "target" | "keys";
function icon(kind: Icon): void {
  ui.widget("", {
    role: "none", size: { width: 32, height: 32 },
    draw: (r) => {
      const { x, y, width: s } = r;
      switch (kind) {
        case "soil": draw.roundRect(x, y, s, s, s * 0.19, "#6b4f35"); break;
        case "hard":
          draw.roundRect(x, y, s, s, s * 0.19, "#6b5f52");
          for (let k = -1; k < 3; k++) draw.line(x + k * s * 0.375, y + s, x + (k + 1) * s * 0.375 + s * 0.2, y, "#8a7a68", s * 0.13, { clip: r });
          break;
        case "contam": draw.polygon([[x + s / 2, y], [x + s, y + s], [x, y + s]], "#c9a227"); break;
        case "source": draw.roundRect(x, y, s, s, s * 0.19, "#1a4a66"); draw.roundRect(x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6, s * 0.3, "#59d8ff"); break;
        case "target": draw.roundRect(x, y, s, s, s / 2, "#1a5a44"); draw.roundRect(x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6, s * 0.3, "#7dffc8"); break;
        case "keys": draw.roundRect(x, y, s, s, s * 0.19, "#555566"); draw.roundRect(x + 1, y + 1, s - 2, s - 2, s * 0.17, "#222233"); break;
      }
    },
  });
}
function helpSheet(L: Layout): void {
  dialogFrame("help", tr("How to play"), L, 672, (w) => {
    const k = keyOf;
    const cards: [Icon, string, string][] = [
      ["soil", tr("Dig channels"), tr("Click or tap soil to carve a channel. Water flows through open cells.")],
      ["hard", tr("Packed clay"), tr("Banded clay costs 2 digs. Watch your budget.")],
      ["contam", tr("Foul pockets"), tr("Spiked ochre pockets foul any water that touches them. Route around.")],
      ["source", tr("The spring"), tr("Water flows down, then spreads sideways. It can never climb.")],
      ["target", tr("The well"), tr("Fill the glowing well with clean water before the spring runs dry.")],
      ["keys", tr("Controls"), tr("Move cursor: {up}, {left}, {down}, {right} · Dig: {carve} · Release: {release} · Undo: {undo} · Hint: {hint} · Reset camera: {camera} · Pause: {pause} · Gamepad: stick/d-pad move, A dig, X release, Y hint, Start pause.", {
        up: k("up"), left: k("left"), down: k("down"), right: k("right"), carve: k("carve"), release: k("release"),
        undo: k("undo"), hint: k("hint"), camera: k("camera"), pause: k("pause"),
      })],
    ];
    const gap = 11;
    const cols = Math.max(1, Math.floor((w + gap) / (208 + gap)));
    const cw = (w - gap * (cols - 1)) / cols;
    ui.column("help-cards", () => {
      for (let i = 0; i < cards.length; i += cols) {
        ui.row(`help-r${i}`, () => {
          for (const [ic, h, body] of cards.slice(i, i + cols)) {
            ui.column(`help-${ic}`, () => {
              icon(ic);
              para(h, cw - 26, "h3");
              ui.style("help-text").paragraph(body, cw - 26);
            }, { style: "help-card", width: cw, spacing: 4 });
          }
        }, { spacing: gap, align: "stretch" });
      }
    }, { spacing: gap, width: w });
    button({ id: "btn-help-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("help") }, w);
  });
}
function achievementsSheet(L: Layout): void {
  const got = achievements();
  dialogFrame("achievements", tr("Achievements"), L, 384, (w) => {
    ui.column("achv-list", () => {
      for (const a of ACHIEVEMENTS) {
        ui.row(`achv-${a.key}`, () => {
          ui.column(`achv-${a.key}-t`, () => {
            para(tr(a.name), w - 70, "hud-v");
            ui.style("dim-small").paragraph(tr(a.desc), w - 70);
          }, { spacing: 2, width: w - 70 });
          ui.label(got[a.key] ? "✓" : "—");
        }, { style: got[a.key] ? "achv-item" : "achv-locked", width: w, spacing: 12, align: "center" });
      }
    }, { spacing: 8, width: w });
    button({ id: "btn-achv-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("achievements") }, w);
  });
}
/** Display name of a local board id. */
function boardName(id: string): string {
  if (id === "journey") return tr("Journey");
  let m;
  if ((m = /^daily-(.+)$/.exec(id))) return tr("Daily — {date}", { date: m[1]! });
  if ((m = /^challenge-(.+)$/.exec(id))) {
    const ch = CHALLENGES.find((c) => c.id === m![1]);
    return ch ? levelName(ch) : id;
  }
  return id;
}
function scoresSheet(L: Layout): void {
  const boards = loadBoards() as Record<string, { name: string; score: number; durationTicks: number; assists: string; seed: number }[]>;
  dialogFrame("scores", tr("Score chase"), L, 672, (w) => {
    para(tr("Local asynchronous boards. Seeds and rulesets are recorded with every entry."), w, "dim-small");
    const ids = Object.keys(boards).sort();
    if (!ids.length) para(tr("No scores yet. Win a daily, journey, or challenge round to post one."), w, "dim", "scores-empty");
    const cw = [32, 80, 64, 96];
    const seedW = Math.max(40, w - cw.reduce((a, b) => a + b, 0) - 40);
    for (const id of ids) {
      para(boardName(id), w, "h3");
      ui.grid(`board-${id}`, () => {
        for (const hd of ["#", tr("Score"), tr("Ticks"), tr("Assists"), tr("Seed")]) ui.style("board-th").label(hd);
        boards[id]!.slice(0, 10).forEach((e, i) => {
          const cls = e.name === "You" ? "board-you" : "board-td";
          ui.style(cls).label(String(i + 1));
          ui.style(cls).label(fmtInt(e.score));
          ui.style(cls).label(String(e.durationTicks));
          ui.style(cls).label(e.assists === "none" ? tr("none") : e.assists);
          ui.style("dim-small").label(String(e.seed));
        });
      }, { columns: [{ width: cw[0]! }, { width: cw[1]!, align: "end" }, { width: cw[2]!, align: "end" }, { width: cw[3]! }, { width: seedW }], gap: { row: 4, column: 10 }, width: w });
    }
    button({ id: "btn-scores-close", text: tr("Done"), style: ["btn", "btn-primary"], act: () => closeOverlay("scores") }, w);
  });
}
function infoDrawer(L: Layout): void {
  if (!game.session || app.screen !== "play") { closeOverlay("info"); return; }
  dialogFrame("info", "", L, 320, (w) => {
    objectiveRail(w, true);
    cursorBits(w);
    const extra: Btn[] = [];
    if (phaseOf() === PHASE.FLOWING && !game.watching) extra.push({ id: "info-skip", text: tr("Fast-forward"), style: ["btn", "btn-small"], act: () => { closeOverlay("info"); doSkip(); } });
    extra.push({ id: "info-camera", text: tr("Reset camera"), style: ["btn", "btn-small"], act: () => { closeOverlay("info"); render.resetCamera(); } });
    flow("info-btns", extra, w, "start");
    button({ id: "btn-info-close", text: tr("Close"), style: ["btn", "btn-primary"], act: () => closeOverlay("info") }, w);
  });
}

// ------------------------------------------------------------------ toast and captions
function feedback(L: Layout, playing: boolean): void {
  const bottom = playing && !L.wide ? 60 + 12 : 16;
  const w = Math.min(L.lw - 32, 560);
  let y = bottom;
  if (app.toast) {
    const text = app.toast.text();
    const r = ui.place("toast", { anchor: "bottom", y: L.oy + y }, () => para(text, w - 40, "body", "toast-text", true), { style: "toast" });
    y += r.height / L.sc + 8;
  }
  if (app.caption) {
    const m = /^not allowed: (.+)$/.exec(app.caption.text);
    const text = m ? tr("not allowed: {reason}", { reason: explainReason(m[1]!) }) : tr(app.caption.text);
    ui.place("captions", { anchor: "bottom", y: L.oy + y + 8 }, () => para(text, w, "captions", "caption-text", true));
  }
}
