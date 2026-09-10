# Channel Keeper — Game Design Document (running spec)

**Status:** shipped; this document describes the game as it runs today.
**Ruleset:** `RULES_VERSION 1`, `CONTENT_VERSION 1`, build `1.0.0`.

## 1. Overview

**Pitch.** Carve channels through a cross-section of underground earth so the spring's water sinks and spreads its way into the well — without touching a foul pocket — inside a dig budget and a flood clock.

| | |
|---|---|
| Genre | Gravity flow puzzle (falling-sand water on a grid) |
| Players | 1; asynchronous local score boards |
| Session | Lessons ~1–2 min; Journey/Daily/Challenge rounds 2–5 min; a title-to-results loop under 90 s on tutorial 1 |
| Platforms | Desktop browsers (keyboard, mouse, gamepad) and mobile browsers (touch), portrait and landscape |
| Rendering | Three.js r-module in `vendor/three.module.js`, instanced meshes, ACES tone mapping; a DOM button-grid fallback when WebGL is unavailable |
| Simulation | Fixed 220 ms tick, fully deterministic, replay-hash verified |

**File map**

| Path | Responsibility |
|---|---|
| `index.html` | All screens, overlays, live regions, HUD, tray, settings form; loads `js/main.js` as a module |
| `css/style.css` | Palette tokens, layout grid, drawers/tray breakpoints, overlays, reduced-motion and high-contrast classes |
| `js/rules.js` | Pure rules engine: `createState`, `applyCommand`, `stepFlow`, `scoreBreakdown`, `stateHash`, `replay`, `legalActions`, `explainCarve`, `compareResults` |
| `js/content.js` | Level generator, `findRoute`, `validateLevel`/`autoSolve`, 5 tutorials, 40 Journey stages, 6 challenges, daily seed, practice tiers, 5 themes, 6 achievements |
| `js/session.js` | `Session`: command ids, fixed-step `advance`, undo, `skipToEnd`, resume snapshots, replay envelope |
| `js/rng.js` | FNV-1a `hashString`, mulberry32 `makeRng(seed, stream)` |
| `js/render.js` | `BoardRenderer`: scene, instanced cells/water, decor, particles, shake, camera fit, raycast pick, palettes |
| `js/audio.js` | `AudioEngine`: WebAudio buses, authored Opus clips with synthesized fallbacks, generative pad, ambience, captions |
| `js/storage.js` | Versioned + checksummed localStorage documents: settings, progress, achievements, session snapshot, boards |
| `js/ui.js` | Screen switching, overlay stack with focus trap/restore, `announce`, `toast`, `caption`, `fmtInt` |
| `js/main.js` | Controller: boot, screen flow, input (pointer/keyboard/gamepad), HUD, tutorials, mirror grid, results, progression, replay watch, telemetry |
| `server.js` | StarHermit game script: static files, `/api/v1/*` (time, version, daily, replay-validated submit, board, achievement, events, presence) |
| `assets/` | `key-art.webp` (title), `well-filled.webp`, `water-spent.webp` (results illustrations) |
| `sfx/` | 17 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` |
| `coverart.png`, `icon.png`, `favicon.svg` | Platform cover (1200×675), icon, tab icon |
| `starhermit.txt` | `name`, `launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png` |
| `tests/run-tests.mjs` | 28 rules/content tests (`npm test`) |
| `tests/e2e.mjs` | Playwright-core playthrough at desktop and mobile viewports (`npm run test:e2e`) |
| `tests/smoke.mjs`, `tests/capture.mjs` | Older puppeteer smoke run and screenshot capture (dev only) |
| `knownissues.md` | QA log of confirmed, resolved and suspected defects |

## 2. Vision and design pillars

1. **Water only sinks.** Every rule is a consequence of gravity: water falls first, spreads only when it cannot fall, and never climbs. Rules in: cheap-to-read boards, "route down then across" planning, live rerouting while it flows. Rules out: pumps, valves, pressure, anything that would let the player push water uphill.
2. **The dig is the decision.** The only verbs are carve and release. Budget (soil 1, packed clay 2) turns every dig into a trade-off; par ticks turn the route shape into a speed score. Rules in: hints that point at one next dig; undo only in unranked modes. Rules out: multi-tool inventories, timers on the editing phase, rotating pieces.
3. **Clean or nothing.** Fouled water scores negative and never counts toward the well. Rules in: foul pockets as the sole hazard, spiked shape plus ochre colour, an assertive announcement the moment water fouls. Rules out: partial credit for dirty water, filters, cleanup mechanics.
4. **Same seed, same flood.** Every round is a pure function of level, seed and command log: replays, daily boards, resume-after-crash and server validation all use one `replay()`. Rules in: `stateHash`, idempotent command ids, cosmetic RNG on separate streams. Rules out: any rule that reads the wall clock, frame rate or renderer.
5. **A cut face you can read with the lights off.** The cross-section is the hero, but cell type, water state, cursor legality and goal are all carried by shape, contrast, the DOM mirror grid and captions — not by bloom or particles. Rules in: five colour-vision palettes, high-contrast mode, reduced-motion path that keeps state changes instant. Rules out: hover-only information, colour-only hazards, camera moves during editing.

## 3. Player experience

**Target player.** Someone who likes short logic puzzles with a physical feel (sand games, pipe puzzles) and wants a two-minute round on a phone or a deeper 40-stage climb on desktop.

**First 60 seconds.** Boot shows a progress bar (rules → clock sync ≤1.5 s → scene → content). The title screen presents key art, `Play`, `Daily Challenge (date)`, `Journey (n/40)`, and `Scores / Achievements / Help / Settings`. `Play` opens six mode cards; `Learn` lists five lessons. Lesson 1 "First Dig" (7×8) opens with the tutorial panel: "Water is trapped at the spring up top. Carve a channel straight down to the well." The cursor is pre-placed one cell below the spring; each carve advances the step and moves the cursor one row lower; the third step says "Now release the water". Release, ~11 ticks of visible flow, then the results sheet ("Well filled!") with the four-line score breakdown, `Next lesson`, `Watch replay`. Lessons 2–5 each add one rule: sideways flow, foul pockets, packed clay, live rerouting. Outside Learn, the `Help` overlay's six cards (dig, clay, foul pockets, spring, well, controls) and the `Hint` button teach on demand.

**Session shape.** Title → mode → (level list) → editing (plan and carve) → release → flowing (watch, optionally reroute) → results → retry / next / replay / title. Interrupted rounds persist and reappear as `Resume interrupted round`.

**Emotional beat.** The release: after quiet planning, the sluice-gate sound, a camera impulse and the glowing water pouring down the channel you cut, with the tension of whether it reaches the well clean before the spring runs dry.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; the controller and renderer never mutate state except through `Session.command()` → `applyCommand()`.

### Board and entities (`CELL`, `createState`)

| Cell | Value | Carvable | Open to water | Notes |
|---|---|---|---|---|
| ROCK | 0 | no | no | Border frame and clusters |
| SOIL | 1 | cost 1 | no | Becomes CHANNEL when carved |
| HARD (packed clay) | 2 | cost 2 | no | Banded look |
| CHANNEL | 3 | already open | yes | Carved cell |
| CONTAM (foul pocket) | 4 | already open | yes | Fouls any clean water that enters |
| SOURCE (spring) | 5 | no | yes | Emits; never receives |
| TARGET (well) | 6 | no | yes | Absorbs; never emits |

Constants: `CELL_CAP = 4` units per cell, `EMIT_PER_TICK = 2`. State fields: `cells`, `clean[]`, `dirty[]`, `budget`, `movesUsed`, `invalidCount`, `sourceLeft`, `deliveredClean`, `deliveredDirty`, `tick`, `seq`, `phase`, `terminalReason`, `maxTicks`, `targetNeed`, `parTicks`, `mechanics {midFlowCarve, undoAllowed}`, `commands[]`, `wHist`, `stagnant`, `undoStack`.

### Commands (`applyCommand`)

Every command is `{ id, type, x?, y? }`; `id` is a 1–64 character string; a repeated id is accepted as a no-op duplicate. After WON/LOST only `tick` is not refused (`game-over`).

| Type | Precondition (`explainCarve` / phase) | Effect |
|---|---|---|
| `carve` | in bounds; not ROCK/SOURCE/TARGET; not already open; `budget ≥ cost`; phase EDITING, or FLOWING when `mechanics.midFlowCarve` | cell → CHANNEL, `budget -= cost`, `movesUsed++`, event `carve {x,y,cost,hard}` |
| `release` | phase EDITING | phase → FLOWING, event `release` |
| `tick` | phase FLOWING | one `stepFlow` |
| `undo` | `mechanics.undoAllowed`, undo stack non-empty, not terminal | restores the snapshot taken before the last carve/release; `commands` log and `seq` are kept (undo is itself logged and replayed) |
| `abandon` | any non-terminal | phase LOST, reason `abandoned` |

Invalid commands increment `invalidCount` and return one of `INVALID.*` (`out-of-bounds`, `blocked-rock`, `already-open`, `is-source`, `is-target`, `no-budget`, `wrong-phase`, `already-flowing`, `not-flowing`, `undo-disabled`, `nothing-to-undo`, `game-over`, `unknown-command`, `bad-payload`). The undo stack holds at most 100 snapshots.

### Flow resolution order (`stepFlow`, one tick)

1. `tick++`.
2. **Emit.** Each SOURCE adds `min(4 − fill, 2, sourceLeft)` clean units and decrements `sourceLeft`.
3. **Move** into delta arrays (no chain moves within a tick). Cells are scanned bottom row to top, left to right; TARGET cells never emit. For each wet cell: try **down** up to 2 units into an open non-source cell with room. If nothing fell, try **sideways** up to 1 unit into each horizontal neighbour whose occupancy (including pending deltas) is at least 1 lower; the side tried first alternates with tick parity. A cell that already sent water this tick cannot receive (anti-bounce). Dirty units move before clean ones.
4. **Apply.** Clean water in a CONTAM cell becomes dirty (event `contaminate`). Any water in a TARGET cell is absorbed into `deliveredClean`/`deliveredDirty` (event `deliver`).
5. **Terminal checks**, in order: `deliveredClean ≥ targetNeed` → WON `target-filled`; `tick ≥ maxTicks` → LOST `timeout`; otherwise a stagnation hash of the water distribution is compared with the value two ticks ago — with the spring empty and no delivery, six consecutive period-2 repeats, or a tick in which nothing moved at all, → LOST `settled-dry`.

### Scoring (`scoreBreakdown`)

- cleanWater = `deliveredClean × 10`
- efficiency = `budget remaining × 25` (0 unless WON)
- speed = `max(0, parTicks − tick) × 5` (0 unless WON)
- contamination = `−deliveredDirty × 15`
- total (WON) = `max(0, sum)`; total (LOST) = `max(0, cleanWater + contamination)`

Worked example (lesson 1, e2e run): 8 clean units delivered, 4 of 8 budget left, tick 11, par 90 → 80 + 100 + 395 − 0 = **575**.

### Tie-break (`compareResults`, `storage.submitScore`)

Won before lost; higher total; fewer invalid actions; fewer ticks; then session id. Local boards sort by score, then ticks, then session id.

### Seeding and determinism

`makeRng(seed, stream)` is mulberry32 seeded by `hashString(stream) XOR seed`; rules use no RNG at all, content uses stream `content`, renderer decoration `decor`, audio pitch variance `audio`. Journey seeds are `0xC0FFEE + i × 7919`; challenges hash fixed strings; the daily seed is `hashString('channel-keeper-daily-YYYY-MM-DD')` on the UTC day; tutorials hash their id; practice takes a random 32-bit seed. `stateHash` is FNV-1a over a canonical field list, and `replay(level, seed, commands)` must reproduce it (tested).

### Hints and undo

`doHint` (`main.js`) runs `findRoute` — a down-first DFS from the spring over carvable/open cells that never touches a foul pocket — and moves the cursor and green ghost to the first uncarved cell on that route; with no uncarved cell it says "release the water" or "let it flow"; with no clean route it suggests restarting. Undo is legal only in Learn and Practice (`mechanics.undoAllowed`).

## 5. Modes and progression

| Mode | Content | Undo | Mid-flow carve | Ranked | Notes |
|---|---|---|---|---|---|
| Learn | 5 authored tutorials (`TUTORIALS`) | yes | yes | no | Completion stored in `settings.tutorialsDone`; `Replay tutorials` resets it |
| Journey | 40 generated stages, fixed seeds | no | from tier 1 | local board `journey` | Sequential unlock: stages after the first incomplete one are locked |
| Daily | one generated board per UTC day | no | yes | local board `daily-<key>` | Title button shows the key; server clock offset applied |
| Practice | generated, 3 difficulties, random seed | yes | yes | no | Never posts to boards |
| Challenge | 6 authored parameter sets | no | per level | local board `challenge-<id>` | `Blind Commit` forbids mid-flow carving |
| Score Chase | overlay of local boards | – | – | – | Top 10 rows per board id |

**Journey curve** (`journeyParams`, tier = ⌊i/4⌋, every fourth stage is "Mastery n"): width 8→12, height 9→16, rock density 0.04→0.148, foul pools from tier 1 (1→5, +1 on mastery, size 2→5), packed clay from tier 2, budget slack 5→1 (mastery: 1), spring 50→122 units, well need 16→52, par 90→216 ticks (mastery ×0.85), max ticks 320→500, themes bedrock → aquifer → ember → frost → verdant. Every stage passes `validateLevel` (one spring, one well, gravity-reachable clean route, auto-solve wins within `maxTicks`).

**Daily**: tier = 2 + (weekday mod 5) (Sun/Fri easiest, Thu hardest), board 9–11 wide × 13–17 tall, 3 slack, immutable for the day; `dailyDays` counts distinct days played.

**Practice**: Easy 7×9 no hazards, slack 6; Medium 9×11, 2 pools, clay; Hard 11×13, 4 pools, slack 2.

**Achievements** (`ACHIEVEMENTS`): First Flow, Rule Scholar (all lessons), Three-Day Keeper (3 daily days), Deep Delver (20 journey stages), Reservoir (500 clean units), Crystal Clear (10 zero-contamination wins). Unlocks are idempotent and local.

## 6. Controls and interaction

| Action | Keyboard (rebindable in `settings.bindings`) | Mouse / touch | Gamepad |
|---|---|---|---|
| Move cursor | Arrows / WASD | Hover (mouse) or touch position | Left stick / d-pad |
| Dig | Enter / Space | Press on a cell; with `Hold/drag to dig` (default on) dragging carves every cell crossed; with it off, a tap under 400 ms and 8 px toggles a single cell | A |
| Release | R | `Release water` (rail) / `Release` (tray) | X |
| Undo | U | `Undo` | B |
| Hint | H | `Hint` | Y |
| Reset camera | C | `Reset camera` (rail) | – |
| Pause | Esc | `Pause` | Start |
| Fast-forward | – | `Fast-forward` (rail, visible while flowing) | – |
| Info drawer (compact) | – | `Info` (tray) | – |

Input locking: nothing is accepted while `game.watching` (replay) or while any overlay is open (the frame loop also stops advancing the simulation); keyboard is ignored when focus is in a form control; Esc closes the topmost overlay except results. Feedback: every legal carve plays dig-soft/dig-hard, bursts soil particles, vibrates 15 ms and announces the row/column; illegal input plays deny-buzz, toasts the reason ("solid rock cannot be dug", "dig budget exhausted"…), flashes a red ghost and vibrates 40 ms; cursor moves play ui-tick; the cursor outline and ring turn red on an illegal cell; the HUD `Cursor` line names the cell type and its water.

## 7. Screens and UI flow

`showScreen` toggles `boot → title → mode → levels → game`; overlays stack on top (`overlay-pause`, `overlay-results`, `overlay-settings`, `overlay-help`, `overlay-achv`, `overlay-scores`) with `aria-modal`, focus trap and focus restoration.

```
boot ─► title ─► mode ─► levels ─► game(editing) ─release─► game(flowing) ─► results
          │        │(daily)                ▲                     │ (pause/settings/help overlays)
          └────────┴───────────────────────┴──── retry / next / replay / back to title
```

**Desktop (≥1024 px):** three-column grid — left rail (Objective, Delivered bar, Dig budget, Fouled, Tick, tutorial panel; 13–17 rem), playfield, right rail (Actions, Cursor, cell info; 11–15 rem). **Compact (<1024 px):** rails become off-canvas drawers; the tray (`Info · Release · Undo · Hint · Pause`, 44 px targets, safe-area padded) docks at the bottom; portrait gives the board the full width, landscape keeps the tray slim. The title screen stacks logo, tagline, key art (≤34 vh, cropped with `object-fit: cover`), menu and guest line, and scrolls if needed. Never cut off: the tray, the Delivered bar, the results total and its buttons, the tutorial text (drawer scrolls). All screens pad by `env(safe-area-inset-*)`.

## 8. Art direction

**Palette (CSS tokens):** background `#0b0e14`, panel `#151a24` / `#1c2330`, text `#e8edf4`, dim `#9aa7b8`, accent/water `#3ec6ff`, well `#7dffc8`, danger `#ff6050`, focus `#ffd75e`. High-contrast mode swaps to `#000` / `#fff` / `#00e5ff` / `#ffff00`.

**Themes (`THEMES`, presentation only):**

| Theme | soil | clay | rock | channel | foul | water | dirty | spring | well |
|---|---|---|---|---|---|---|---|---|---|
| Bedrock | `#6b4f35` | `#8a7a68` | `#3a3f4a` | `#241a12` | `#c9a227` | `#3ec6ff` | `#b8860b` | `#59d8ff` | `#7dffc8` |
| Aquifer | `#4f5e52` | `#6e7f72` | `#2c3a40` | `#12201c` | `#c9a227` | `#46e0d4` | `#b8860b` | `#6ef0e4` | `#9dffd8` |
| Ember Deep | `#6e4534` | `#8a6a52` | `#402e2a` | `#241310` | `#d4b03a` | `#4fc0ff` | `#c07020` | `#66d0ff` | `#ffc890` |
| Frost Vein | `#5a6a78` | `#8294a4` | `#323e4c` | `#18222c` | `#c9a227` | `#62c8ff` | `#b8860b` | `#8adcff` | `#a8ffe0` |
| Verdant Root | `#5e5233` | `#7e7452` | `#35402e` | `#1c1a10` | `#c9a227` | `#3ec6ff` | `#b8860b` | `#59d8ff` | `#a0ffb0` |

Colour-vision palettes override water/dirty/foul/well hues (deuteranopia, protanopia, tritanopia, contrast). Hazards are also spiked (three cones per foul pocket) so they never rely on colour alone.

**Shape language.** The board is a cut face of instanced 0.94-unit boxes with seeded depth jitter, a rock slab behind, a floor and scattered dodecahedron boulders per quality tier. Water is an emissive box scaled to fill (0–4 units); the spring is a tilted metal pipe with a cyan point light; the well is a pulsing torus with a mint point light. Selection is a white edge outline plus a grounded ring; the ghost is a translucent green (legal) or red (illegal) box.

**Typography.** System UI stack; logo `clamp(2rem, 6vw, 3.2rem)` in accent with a soft glow; rail headings uppercase 0.8 rem; tabular numerals in the score table; `Larger text` raises the root size to 20 px.

**Motion.** Camera fit/close transitions ease in-out over 0.6 s; shake impulses 0.08 (clay dig), 0.12 (release), 0.22/0.30 (win/lose) with fast decay; particles have a 2048 hard cap and 300/800/2000 per tier; the well ring and spring glow breathe. Reduced motion (setting or body class) kills CSS transitions, snaps the camera, disables shake and idle breathing, caps bursts at 4 particles; water fill still interpolates between ticks.

**Hero.** The glowing channel of water descending the cut face; UI stays flat and dark around it. The key art (`assets/key-art.webp`) and cover reproduce exactly that: rusted spring pipe, cyan fall through soil and clay bands, mint well, ochre crystal pockets.

**Visual assets:** `assets/key-art.webp` (title backdrop, cover source), `assets/well-filled.webp` (results, win), `assets/water-spent.webp` (results, loss), `coverart.png`, `icon.png`, `favicon.svg`. No 3D model assets: every prop is procedural geometry, which the design prefers for instancing, palette overrides and context-loss recovery.

## 9. Audio direction

**Mix.** Four gain buses under master (`music`, `effects`, `ambience`, `voice`), squared volume curves, mute, and a 0.2 s duck to silence when the tab is hidden. Audio unlocks on the first pointer/key gesture. Ambience is a looped brown-noise low-pass at 320 Hz with a 0.07 Hz LFO; music is a generative pentatonic pad (220–440 Hz sine + sub triangle) that steps every 1.4 s. Every event also emits a caption (`#captions`) so sound is never the only channel. Authored clips are lazy-fetched Opus files; while loading or unavailable the seeded synth of the same event plays, and pitch variance uses the `audio` RNG stream so replays sound identical.

**SFX event table** (source of `sfx/manifest.txt`; all on the effects bus):

| Event id | File | Sound | Usage |
|---|---|---|---|
| `ui` | ui-tick.opus | Soft plastic button tick | Cursor moves, mode/level buttons |
| `select` | menu-select.opus | Two-tone marimba tap | A round starts |
| `carve` | dig-soft.opus | Shovel scoop into loose soil | Soil cell carved |
| `carveHard` | dig-hard.opus | Heavy strike into packed clay | Clay cell carved (+shake) |
| `invalid` | deny-buzz.opus | Dull low error buzz | Illegal carve, double release, refused undo |
| `release` | water-release.opus | Sluice gate, sustained gush | Release pressed |
| `splash` | water-splash.opus | Small splash in a shallow pool | Bound; no rules event emits it yet |
| `deliver` | well-fill.opus | Droplet plink echoing in a stone well | Each tick water enters the well |
| `contaminate` | water-fouled.opus | Sour gurgling sizzle | Clean water fouled |
| `undo` | undo-rewind.opus | Tape rewind sliding down | Undo accepted |
| `win` | round-win.opus | Rising bell arpeggio | Terminal target-filled |
| `lose` | round-lose.opus | Descending mallet phrase | Terminal settled-dry / timeout / abandoned |
| `achievement` | achievement-chime.opus | Three-note wind chime | Achievement unlocked |
| `hint` | hint-glimmer.opus | Glassy two-note glimmer rising | Hint pressed, ghost shown |
| `springDry` | spring-dry.opus | Last trickle from an iron pipe, final drip | First tick with `sourceLeft` 0 (with toast and announcement) |
| `pause` | pause-hush.opus | Muffled cloth thump, low hum fading | Pause sheet opens |
| `resume` | resume-swell.opus | Short upward swell with a light tap | Pause sheet closes |

## 10. Localization

The game ships in **English only**: every string is hard-coded in `index.html` and `js/main.js` / `js/content.js`, `<html lang="en">`, and `fmtInt` formats with `en-US`. No language selection exists and no translation table is loaded. Layout allowances already in place for expansion: buttons wrap (`.btn-row.wrap`), the title menu is a column, help cards and settings columns reflow with `auto-fit`, and rails scroll. Shipping en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT is listed under "Design intent not yet implemented".

## 11. Accessibility

- **Keyboard-only path:** skip link → title buttons → mode cards → level buttons → `#playfield` (`role=application`, arrows/WASD + Enter/R/U/H/C/Esc) → rail buttons → overlays with Tab trapping and focus restored to the opener on close.
- **Screen reader:** `#live` (polite) announces level start, digs with row/column and budget, hints, tutorial steps, pause/resume, spring dry; `#alert` (assertive) announces fouling, illegal digs and round end. `#board-mirror` is a visually hidden `role=grid` whose cells read "R3 C4: soil — dig for 1, 2 water", updated on every event. The canvas is `aria-hidden`.
- **Captions:** every audio event writes a short caption above the tray for 1.8 s.
- **Contrast and colour:** high-contrast body class, five hue palettes, spiked hazards, red/white cursor legality, focus ring `#ffd75e` 3 px.
- **Motion:** `Reduced motion` setting (see §8).
- **Timing:** `Timing assistance` slows the tick from 220 ms to 340 ms; the editing phase has no timer.
- **Targets:** all buttons ≥44 px; fallback grid cells 44 px; `Left-handed controls` mirrors the tray; `Hold/drag to dig` can be switched to tap-toggle; haptics toggle.
- **No WebGL:** the DOM fallback grid (`#fallback-grid`) exposes every cell as a labelled button and carving works identically.

## 12. StarHermit integration

Manifest `starhermit.txt` declares `name`, `launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png` per https://wiki.starhermit.com/ conventions. The **server script** (`server.js`) serves the distribution and exposes `GET /api/v1/time`, `GET /api/v1/version`, `GET /api/v1/daily` (key, seed, content version), `POST /api/v1/daily/submit` (replay-validated: schema, content version, ≤20 000 commands, seed must match the day's level, today's UTC board only, `stateHash` must match a fresh `replay`, one row per player, top 200, 30 requests/min), `GET /api/v1/daily/board`, `POST /api/v1/achievement` (idempotent, known keys only), `POST /api/v1/events` and `POST /api/v1/presence` (accepted sinks).

The **client uses today**: `/api/v1/time` at boot (round-trip-adjusted offset that dates the Daily key), `/api/v1/events` beacons (`start`, `tutorial_step`, `round_end`, `retry`, `settings_change`, `error`) and a `/api/v1/presence` heartbeat every 30 s while a round is flowing or finished. All calls are fire-and-forget; offline play is unaffected.

**Not used by the client:** platform identity (the title always reads "Playing as guest"), remote leaderboards (`/api/v1/daily/submit` and `/board` have no client caller; boards are local), remote achievements, hosted sessions/multiplayer, cloud saves.

## 13. Technical architecture

- **Loop** (`main.js loop`): `requestAnimationFrame`; `Session.advance(dt)` fires as many 220 ms ticks as owed (max 50 per frame, dt clamped to 100 ms) unless an overlay is open, the tab is hidden or a replay is being watched; the renderer receives `(state, prevSnapshot, alpha)` and interpolates water fill.
- **Session** (`session.js`): command ids `s<base36 time>-<n>:<k>`; `_persist` saves a checksummed snapshot after every accepted command (cleared on terminal, suppressed during replay watch); `restore` rebuilds from `channelkeeper.session` when the level id matches; `exportReplay` yields `{schema 1, rulesVersion, contentVersion, levelId, seed, commands, stateHash, terminal}`.
- **Persistence** (`storage.js`): keys `channelkeeper.settings | progress | achievements | session | boards`, each `{v:1, data, sum}` with an FNV-1a checksum; corrupt or foreign documents fall back to defaults; `Erase local progress` clears localStorage and reloads.
- **Renderer** (`render.js`): quality tiers low (dpr 1, 300 particles, no AA/shadows), medium (1.5, 800, AA), high (2, 2000, AA, PCF shadows); auto picks low on coarse pointers or screens under 800 px, else high. One instanced mesh for cells, one for water, one for spikes; raycasts hit only an invisible pick plane; context loss rebuilds the level from retained descriptors; shaders are pre-compiled on load.
- **Budgets:** boards ≤ 13×16 = 208 cells; per-tick work is O(cells); render ≤ ~10 draw calls plus particles; assets total ≈ 0.85 MB (three.js excluded); no external network dependency at runtime.
- **E2E** (`tests/e2e.mjs`): starts its own static server on an ephemeral port with stubbed `/api/v1/time|events|presence`, launches headless Chrome via playwright-core and clicks the real UI at 1280×800 and 390×844 (touch). `window.__ckTest` exposes `phase()`/`state()` read-only for synchronisation; every action is real input.

## 14. Testing and acceptance criteria

`npm test` (28 tests, `tests/run-tests.mjs`): state creation and serialisation; carve costs and each invalid reason; budget exhaustion; release/tick phase rules; duplicate ids; undo restore and refusal; mid-flow carve refusal; `legalActions`; terminal `settled-dry`, `timeout`, contamination outcome; integer score coherence; comparator order; stable hashes; replay determinism on three levels; replay with undo; 400-command malformed fuzz; every tutorial/journey/challenge validates; daily immutability per UTC day; practice tiers; golden hashes; 150-seed generator fuzz; hint route after carving.

`node tests/e2e.mjs` (desktop + mobile, 13/12 steps): title loads; settings persists quality; Learn list has 5 lessons; lesson 1 shows the tutorial panel; keyboard carves leave budget 4 and 4 moves; release wins and results total > 0; progress and `first_flow` persisted; watch replay returns to results (desktop); retry; pause/resume; pause freezes `tick`; pointer/tap carves via raycast; leave → results → title; zero non-benign console errors.

QA bar (agents/qa.md) as checkable statements: lesson 1 explains the first mechanic before any input; every button, card and overlay is reachable by mouse, touch and keyboard; no console errors at 1280×800 or 390×844; the tray and results total are visible without horizontal scroll in portrait and landscape; `Hint`, `Undo`, `Fast-forward`, `Reset camera`, `Watch replay`, palettes and every settings control do something observable.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` | Title backdrop (1200×672) | FLUX.2 klein, seed 5401 | generated in this pass |
| `assets/well-filled.webp` | Results illustration, win (640×400) | FLUX.2 klein, seed 5402 | generated in this pass |
| `assets/water-spent.webp` | Results illustration, loss (640×400) | FLUX.2 klein, seed 5403 | generated in this pass |
| `coverart.png` | Platform cover 1200×675 (256-colour PNG) | key-art scaled | replaced in this pass (was a generic placeholder) |
| `icon.png`, `favicon.svg` | Icon 256², tab icon | authored SVG/PNG | shipped |
| `sfx/ui-tick … achievement-chime.opus` (13) | Core event clips | MOSS-SFX v2 | shipped |
| `sfx/hint-glimmer.opus` | `hint` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/spring-dry.opus` | `springDry` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/pause-hush.opus` | `pause` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/resume-swell.opus` | `resume` | MOSS-SFX v2, 100 steps | generated in this pass |
| `vendor/three.module.js` | Renderer library | three.js (MIT) | shipped |
| 3D models / character animation | – | – | none: all geometry procedural; no humanoid |

## 16. Known limitations

- Sideways spreading moves into any neighbour at least 1 unit lower (`stepFlow`), while the code comment claims a 2-unit threshold; the period-2 stagnation detector bounds the resulting slosh, and tightening the rule breaks authored solvability (see `knownissues.md`).
- `compareResults` and board sorting tie-break with `localeCompare`; session ids are ASCII so order is stable in practice.
- On compact layouts the right rail (`Reset camera`, `Fast-forward`) has no drawer toggle; only the left `Info` drawer is reachable, so those two actions are desktop-only.
- The results table prints `-0` for zero contamination (`fmtInt(-0)`).
- Local boards name every entry "You"; there is no remote board or identity, so "Board rank" only compares your own runs.
- `splash` is bound to a clip but no rules event emits it; the `voice` bus carries nothing.
- Key bindings are stored in settings but there is no UI to rebind them.
- `tests/smoke.mjs` and `tests/capture.mjs` hard-code ports 8917/8918 and spawn `server.js`; `tests/e2e.mjs` ignores `BASE_URL`/`PORT` and binds an ephemeral port.
- `server.js` serves non-HTML files with `cache-control: immutable`, so a deployed asset change needs a new path or a hard refresh.
- Music and ambience are synthesized, not authored.

## Design intent not yet implemented

- Localization into en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT with a string table and language selection.
- Client submission of Daily replays to `/api/v1/daily/submit` and display of the shared `/api/v1/daily/board`, plus platform identity replacing "Playing as guest".
- Remote achievement delivery through `/api/v1/achievement`.
- A right-rail drawer toggle on compact layouts.
