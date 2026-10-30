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
| Platforms | The StarHermit engine 1.29.0 (host API 1.31): natively in the StarHermit client and in browsers through the engine's web runtime (keyboard, mouse, gamepad, touch), portrait and landscape |
| Rendering | `starhermit:scene` (three.js-shaped): instanced meshes with WGSL material hooks, ACES tone mapping, image-based light, the runtime's post effects (ambient occlusion, bloom, grade, FXAA/SMAA/MSAA) per graphics level; UI on `starhermit:ui` |
| Simulation | Fixed 220 ms tick, fully deterministic, replay-hash verified |

**File map**

| Path | Responsibility |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.entry=native/main.ts`, `engine.version=1.29.0`, `engine.minor=31`, capabilities `platform,storage,clipboard`, `server=score-script.js`, ten `control.*` actions with `engine.gamepad.*` defaults |
| `native/main.ts` | Entry module: screen flow, cursor and input (actions, pointer, touch), digging/release/undo/hint/fast-forward, replay viewer, lessons, outcomes, boards, snapshot, lifecycle; the flow advances on the runtime's fixed 60 Hz steps |
| `native/screens.ts` | Every screen, the HUD rails, touch tray, Info drawer, toast/captions and sheets (pause, results, settings, help, achievements, score chase) on `starhermit:ui` |
| `native/render.ts` | The dig face on `starhermit:scene`: cells, water, spikes, pipe, well, cavern, boulders, cursor, ghost, particles, motes, camera fit/transition/shake, picking, the per-level look |
| `native/rounded.ts` | RoundedBoxGeometry (three.js's, which the engine lacks) |
| `native/quality.ts` | The old `gfx.js` presets and budgets keyed by the runtime's quality tier and level |
| `native/audio.ts` | Authored clips per event, rendered music and ambience clips, captions table |
| `native/platform.ts` | The save document, the `localStorage` shim for `js/storage.js`, game settings, browser-save and legacy-settings migration, player, invite, platform clock, high-score posting |
| `native/i18n.ts`, `native/style.ts` | Locale from the runtime's interface language; UI theme, tokens and styles (`assets/ui-style.json`) |
| `js/rules.js`, `js/content.js`, `js/session.js`, `js/rng.js`, `js/storage.js` | The rules engine, content, session, seeded RNG and store, unchanged from the browser build (storage.js only exports `wrap`/`unwrap`) |
| `js/migrate.js` | Pure save document helpers: normalize, browser-save import, merge, game-setting checks |
| `js/strings.js`, `js/i18n.js`, `js/platform-strings.js` | Translation tables (classic scripts, `CK_STRINGS` / `CKI18N`) and the account lines |
| `tools/ui-style.css` → `assets/ui-style.json` | The style sheet, class-based, converted with `starhermit css` (`npm run css`) |
| `tools/package-web.mjs`, `index.html`, `starhermit-files.json` | `npm run package` writes the engine's web loader and file index (never edited by hand) |
| `tools/browser-play.mjs` | Plays the web package in headless Chrome at desktop, phone and landscape viewports |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished round's total and posts it to the `high-score` leaderboard |
| `server.js` | Local dev server of the browser build (not packaged; the engine client does not call its routes) |
| `assets/` | `key-art.webp` (title), `well-filled.webp`, `water-spent.webp` (results), `ui-style.json` |
| `sfx/` | 17 Opus clips, `manifest.txt` (canonical), `manifest.json`, `manifest.md` |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform cover, cover source, icon |
| `tests/` | `run-tests.mjs` (rules/content), `i18n.test.mjs`, `migrate.test.mjs`, `native.mjs` + `native/*.play` |
| `knownissues.md` | QA log of confirmed, resolved and suspected defects |

## 2. Vision and design pillars

1. **Water only sinks.** Every rule is a consequence of gravity: water falls first, spreads only when it cannot fall, and never climbs. Rules in: cheap-to-read boards, "route down then across" planning, live rerouting while it flows. Rules out: pumps, valves, pressure, anything that would let the player push water uphill.
2. **The dig is the decision.** The only verbs are carve and release. Budget (soil 1, packed clay 2) turns every dig into a trade-off; par ticks turn the route shape into a speed score. Rules in: hints that point at one next dig; undo only in unranked modes. Rules out: multi-tool inventories, timers on the editing phase, rotating pieces.
3. **Clean or nothing.** Fouled water scores negative and never counts toward the well. Rules in: foul pockets as the sole hazard, spiked shape plus ochre colour, an assertive announcement the moment water fouls. Rules out: partial credit for dirty water, filters, cleanup mechanics.
4. **Same seed, same flood.** Every round is a pure function of level, seed and command log: replays, daily boards, resume-after-crash and server validation all use one `replay()`. Rules in: `stateHash`, idempotent command ids, cosmetic RNG on separate streams. Rules out: any rule that reads the wall clock, frame rate or renderer.
5. **A cut face you can read with the lights off.** The cross-section is the hero, but cell type, water state, cursor legality and goal are all carried by shape, contrast, announcements and captions — not by bloom or particles. Rules in: five colour-vision palettes, high-contrast mode, reduced-motion path that keeps state changes instant. Rules out: hover-only information, colour-only hazards, camera moves during editing.

## 3. Player experience

**Target player.** Someone who likes short logic puzzles with a physical feel (sand games, pipe puzzles) and wants a two-minute round on a phone or a deeper 40-stage climb on desktop.

**First 60 seconds.** The runtime's loader starts the game straight on the title. The title screen presents key art, `Play`, `Daily Challenge (date)`, `Journey (n/40)`, and `Scores / Achievements / Help / Settings`. `Play` opens six mode cards; `Learn` lists five lessons. Lesson 1 "First Dig" (7×8) opens with the tutorial panel: "Water is trapped at the spring up top. Carve a channel straight down to the well." The cursor is pre-placed one cell below the spring; each carve advances the step and moves the cursor one row lower; the third step says "Now release the water". Release, ~11 ticks of visible flow, then the results sheet ("Well filled!") with the four-line score breakdown, `Next lesson`, `Watch replay`. Lessons 2–5 each add one rule: sideways flow, foul pockets, packed clay, live rerouting. Outside Learn, the `Help` overlay's six cards (dig, clay, foul pockets, spring, well, controls) and the `Hint` button teach on demand.

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

`doHint` (`native/main.ts`) runs `findRoute` — a down-first DFS from the spring over carvable/open cells that never touches a foul pocket — and moves the cursor and green ghost to the first uncarved cell on that route; with no uncarved cell it says "release the water" or "let it flow"; with no clean route it suggests restarting. Undo is legal only in Learn and Practice (`mechanics.undoAllowed`).

## 5. Modes and progression

| Mode | Content | Undo | Mid-flow carve | Ranked | Notes |
|---|---|---|---|---|---|
| Learn | 5 authored tutorials (`TUTORIALS`) | yes | yes | no | Completion stored in the save's `tutorialsDone`; `Replay tutorials` resets it |
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

Actions are declared in `starhermit.txt`; players rebind keys and pads in the runtime's Options (F1).

| Action (`control.*`) | Keyboard | Mouse / touch | Gamepad |
|---|---|---|---|
| Move cursor (`up/down/left/right`) | Arrows / WASD | Hover (mouse) moves the cursor and shows the ghost | D-pad / left stick |
| Dig (`carve`) | Enter / Space | Press on a cell; with `Hold/drag to dig` (default on) dragging digs every cell crossed; off, a tap under 400 ms and 8 px digs one cell | South (A) |
| Release (`release`) | R | `Release water` (rail) / `Release` (tray) | West (X) |
| Undo (`undo`) | U | `Undo` | East (B) |
| Hint (`hint`) | H | `Hint` | North (Y) |
| Reset camera (`camera`) | C | `Reset camera` (rail, Info drawer) | Select |
| Pause (`pause`) | Escape | `Pause` | Start |
| Fast-forward | – | `Fast-forward` (rail / Info drawer, while flowing) | – |
| Info drawer (compact) | – | `Info` (tray) | – |

The action that was `cameraReset` in the browser build is `camera` (actions are lowercase on the engine); a binding the browser build stored for it is not carried over.

Input locking: nothing acts on the board while a replay plays or a sheet is open (the flow is frozen too); the pause action closes the top sheet except results; on menus it goes back (levels → modes → title). Arrow and Enter presses in play clear UI focus first so they drive the cursor, not the rail buttons. A pointer press over a UI widget never digs; a mouse press right after a touch is ignored. Feedback: every legal dig plays dig-soft/dig-hard, bursts soil particles, vibrates 15 ms (haptics setting) and announces the row/column; an illegal dig plays deny-buzz, shows a toast and caption with the reason, flashes a red ghost and vibrates 40 ms.

## 7. Screens and UI flow

`showScreen` switches `title → modes → levels → play`; sheets stack over them as `ui.dialog`s (pause, results, settings, help, achievements, scores, info). The 3D scene draws only in play (`renderer.camera` is null on menus).

```
title ─► modes ─► levels ─► play(editing) ─release─► play(flowing) ─► results
  │        │(daily)              ▲                    │ (pause / settings / help sheets)
  └────────┴─────────────────────┴──── retry / next / watch replay / back to title
```

**Title:** logo, tagline, key art, Play, Resume interrupted round (when a snapshot exists), Daily Challenge (date), Journey (n/40), Scores · Achievements · Help · Settings, the account line ("Playing as guest…" or "Playing as <name> · progress synced/saving…/cloud sync unavailable"), Invite a friend (signed in) and Sign in with StarHermit (guest). Landscape phones (≤ 540 px tall) put the art beside the menu. **Modes:** six cards (Learn, Journey, Daily, Practice, Challenge, Score Chase) in auto-fit columns. **Levels:** lesson / stage / challenge buttons (locked Journey stages disabled, ✓ and best score on finished ones) or the Practice setup (Easy/Medium/Hard, Start practice round).

**Wide (≥ 1024 logical px):** left rail (Objective, Delivered bar, Dig budget, Fouled, Tick, lesson card; 208–272 px), the board, right rail (Actions with key labels, Cursor, cell info; 176–240 px); left-handed swaps the rails. **Compact:** a 60 px tray (`Info · Release · Undo · Hint · Pause`, reversed left-handed) along the bottom, the lesson card floating over the board, the rails' content (plus Fast-forward and Reset camera) in the Info drawer. The board is framed into the free rectangle with a camera view offset. Toasts sit above the tray, captions above the toast. Results: illustration, reason, score breakdown, progress line, board rank, leaderboard line, achievements, Retry / Next stage or lesson / Watch replay / Back to title, seed line; it closes only by a choice. Settings: Accessibility (palette, left-handed, hold to dig, timing assistance, haptics), Graphics (camera Fit/Close, Open Options), Data (Replay tutorials, Erase local progress with an inline confirmation); two columns when the labels fit.

## 8. Art direction

**Palette (UI tokens, `tools/ui-style.css`):** background `#0b0e14`, panel `#151a24` / `#1c2330`, text `#e8edf4`, dim `#9aa7b8`, accent/water `#3ec6ff`, well `#7dffc8`, danger `#ff6050`, focus `#ffd75e`. High contrast is the runtime's (it forces the UI colours) and also switches the board to the contrast hues.

**Themes (`THEMES`, presentation only):**

| Theme | soil | clay | rock | channel | foul | water | dirty | spring | well |
|---|---|---|---|---|---|---|---|---|---|
| Bedrock | `#6b4f35` | `#8a7a68` | `#3a3f4a` | `#241a12` | `#c9a227` | `#3ec6ff` | `#b8860b` | `#59d8ff` | `#7dffc8` |
| Aquifer | `#4f5e52` | `#6e7f72` | `#2c3a40` | `#12201c` | `#c9a227` | `#46e0d4` | `#b8860b` | `#6ef0e4` | `#9dffd8` |
| Ember Deep | `#6e4534` | `#8a6a52` | `#402e2a` | `#241310` | `#d4b03a` | `#4fc0ff` | `#c07020` | `#66d0ff` | `#ffc890` |
| Frost Vein | `#5a6a78` | `#8294a4` | `#323e4c` | `#18222c` | `#c9a227` | `#62c8ff` | `#b8860b` | `#8adcff` | `#a8ffe0` |
| Verdant Root | `#5e5233` | `#7e7452` | `#35402e` | `#1c1a10` | `#c9a227` | `#3ec6ff` | `#b8860b` | `#59d8ff` | `#a0ffb0` |

Colour-vision palettes override water/dirty/foul/well hues (deuteranopia, protanopia, tritanopia, contrast). Hazards are also spiked (three cones per foul pocket) so they never rely on colour alone.

**Shape language.** The board is a cut face of instanced 0.94-unit boxes (rounded with the level's bevel segments and a procedural grain/pebble texture with a matching normal map when detailed) with seeded depth jitter, a textured cavern wall behind, a floor and scattered lumpy boulders (low-segment spheres with face normals). Packed clay carries horizontal strata and carved channels a damp, glossier floor (the cell's kind rides in each instance's custom slot; a WGSL surface hook draws both), so cell types differ by pattern too. Water is a translucent instanced box per cell whose height interpolates its fill between ticks, glowing from its instance colour with a shimmer (WGSL surface hook). The spring is a metal pipe with a glow light, the well a pulsing emissive ring with its own light; foul pockets carry three ochre spikes each. The cursor is a white (legal) or red (illegal) box outline and ring; the ghost previews a hover or hint in green or red.

**Graphics.** A key directional lamp (the engine's view-based shadow) plus a hemisphere fill, ACES filmic tone mapping (exposure 1.1); when detailed, a PMREM `RoomEnvironment` at `environmentIntensity` 0.28. Light intensities are the browser build's divided by π (the engine's convention). The post effects are the runtime's: ambient occlusion, bloom limited to the water, well ring and spring (threshold 0.86), a display-space grade with vignette, and FXAA/SMAA/MSAA.

**Graphics levels.** The runtime's Options choose the graphics level; `native/quality.ts` maps its quality tier (`frame().quality`) to the browser build's preset of the same name and scales counts by the level within the tier (`frame().levelIndex`, ×1.64 a level, at most 4×). Auto, render scale, adaptive resolution, the frame-rate limit and readout are the runtime's.

| Look | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows / AO / bloom / grade / AA | off / off / off / off / off | 1024 / off / on / on / FXAA | 2048 / on / on / on / SMAA | 4096 / high / on / on / MSAA |
| Surface detail, animated background and water | plain, static | detailed, animated | detailed, animated | detailed, animated |
| Materials (cells, water, spikes, cavern, rocks) | Lambert | Standard | Standard + clearcoat water (Physical) | same as High |
| Rounded-cell bevel segments (detailed) | 1 | 2 | 3 | 4 |
| Grain texture cells / cavern wall (detailed) | 64 / 128 px | 128 / 256 | 256 / 512 | 256 / 512 |
| Boulders at the tier's first level (plain = half) | 8 | 14 | 20 | 28 |
| Splash particles at the tier's first level | 200 (cap 300) | 600 | 1200 | 2000 |
| Bloom / AO resolution | ½ / ½ | ½ / ½ | ½ / ½ | full / full |

A level change that alters an asset (detail, material, bevel, grain, boulders) rebuilds the board in place; the round is untouched.

**Typography.** The runtime's UI font; logo 51 px (36 px on phones, 32 px on landscape phones) in accent; rail headings uppercase 12.8 px; the player's text size (Options) scales everything.

**Motion.** Camera fit/close transitions ease in-out over 0.6 s; shake impulses 0.08 (clay dig), 0.12 (release), 0.22/0.30 (win/lose) with fast decay; particles have a 2048 hard cap; the well ring, spring glow and lamp breathe and dust motes drift (animated background). Reduced motion (the runtime's preference) snaps the camera, disables shake and idle breathing, freezes the water's shimmer and caps bursts at 4 particles; state changes stay instant.

**Hero.** The glowing channel of water descending the cut face; UI stays flat and dark around it. The key art (`assets/key-art.webp`) and cover reproduce exactly that: rusted spring pipe, cyan fall through soil and clay bands, mint well, ochre crystal pockets.

**Visual assets:** `assets/key-art.webp` (title, cover source), `assets/well-filled.webp` (results, win), `assets/water-spent.webp` (results, loss), `cover.jpg`, `coverart.png`, `icon.png`. No 3D model assets: every prop is procedural geometry.

## 9. Audio direction

**Mix.** The runtime's buses and Options (volumes, mute, voice limit): music → `music`, effects and ambience → `effects`. The browser build's default bus levels are folded into each sound's gain (music 0.36, effects 0.81, ambience 0.25). Clips load one at a time once the mixer runs (in a browser after the first press). The ambience is a brown-noise loop low-passed at 320 Hz whose level swells with a 0.07 Hz sine, rendered once into a clip; the music is a generative pentatonic pad (a 220–440 Hz sine with a triangle an octave below) every 2.8 s, its six notes rendered into clips and picked by a seeded stream. The synthesized stand-ins the browser build played while a clip loaded are not ported. Every meaningful event also shows a caption.

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

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

- **Strings.** Code and content are authored in English and the English text is the lookup key. `js/strings.js` holds one row per key with es-419, de-DE, fr-FR, pt-BR and it-IT; en-GB, es-ES and fr-CA list only their differences (colour, se ha secado, pointage). `tr()` (`native/i18n.ts` → `js/i18n.js`) falls back regional → parent → English and fills `{name}` placeholders; `N()` marks keys translated where shown. Account lines come from `js/platform-strings.js`.
- **Language.** The runtime's interface language (`preferences().language`: the player's choice in Options › Language, else the account's or the device's) mapped to the nearest shipped locale (`es-MX → es-419`, `en-AU → en-GB`, `fr → fr-FR`, `pt-PT → pt-BR`). The UI is rebuilt every frame, so a change shows at once, the round untouched. The game's own Language menu (sh-language.js) is gone.
- `tests/i18n.test.mjs` collects every key from `native/*.ts` (`tr()`, `N()`) and the content, and fails when a locale lacks one, a translation drops a placeholder, or a table keeps an unused key. Long text wraps (paragraphs, wrapping button rows, auto-fit columns).

## 11. Accessibility

- **Keyboard and gamepad:** every screen opens with its first control focused; Tab/arrows move UI focus on menus and sheets; in play the arrows move the board cursor. Sheets are modal dialogs.
- **Screen reader:** the runtime's announcer (`ui.announce`) speaks level start, cursor moves with the cell ("Row 3 column 4: soil — dig for 1 · 2 water"), digs with row/column and budget, hints, lesson steps, pause/resume, spring dry (polite), and fouling, illegal digs and round end (assertive). Widgets carry their labels (level buttons say name, size, need, complete/locked). The browser build's hidden mirror grid is replaced by these cursor announcements.
- **Captions:** every audio event writes a short caption above the toast for 1.8 s.
- **Contrast and colour:** the runtime's high contrast, five hue palettes (setting), spiked hazards, red/white cursor legality, focus ring `#ffd75e` 3 px.
- **Motion and text size:** the runtime's reduced motion (§8) and text scale.
- **Timing:** `Timing assistance` slows the tick from 220 ms to 340 ms; the editing phase has no timer.
- **Targets:** buttons ≥ 44 px (small ones 40); `Left-handed controls` swaps the rails and reverses the tray; `Hold/drag to dig` can be switched to tap; haptics toggle.

## 12. StarHermit integration

The game is an engine script game (`engine.entry=native/main.ts`); browsers open the loader `index.html` that `npm run package` writes, which pins engine 1.29.0 on wiki.starhermit.com by hash.

| Feature | Used | How |
|---|---|---|
| Sign in / player | yes | `starhermit:platform` `player()`; guests see **Sign in with StarHermit** (`requestSignIn`); the title line shows the account's display name and the save's sync state; a session that ends shows a "signed out" toast and line |
| Cloud save | yes | `saves` holds `{ v: 1, progress, achievements, boards, tutorialsDone }` on the device and in the account; conflicts and another device's newer save merge (`mergeDocs`: better record per stage/challenge/daily, larger counters, earliest achievement unlock, both boards, union of lessons). The browser build's slot (`game:channel-keeper`, a foreign save) is merged in and replaced once (`replaceForeign`); its settings carry over to the game's settings |
| Game settings | yes | `settings` (`game.<key>`, synced): palette, leftHanded, holdToCarve, timingAssist, haptics, cameraView. The browser build's per-player settings keys are read once (`legacyKeys`), the game's options among them adopted unless set since, and all of them removed. Volumes, mute, graphics, reduced motion, high contrast and larger text are the runtime's Options now |
| Device storage | yes | The interrupted round's snapshot (`channelkeeper.session`) stays on the device through the `localStorage` shim |
| Controls | yes | Ten actions in `starhermit.txt` with gamepad defaults, rebindable in Options; on-screen keys from `bindingLabel` |
| Clock | yes | `serverTime()` / `serverNow()` date the daily (the device's UTC date until the platform answers) |
| Invite link | yes | Signed in, **Invite a friend** copies `inviteLink()` to the clipboard with a toast |
| Platform leaderboard | yes | Signed in, every finished Journey, Daily or Challenge round (not Learn, Practice or an abandoned round) posts its total through `score-script.js` on a practice session (`{type:'result', scores:{'high-score': n}}`) to the `high-score` board (integer, 0–100,000); the results sheet shows "Leaderboard rank: #N" (or posted / not posted) |
| Reports, language, graphics, audio options | runtime | The runtime's Options and report flow replace game-options.js, sh-language.js, ui-scale.js and browser-guard.js |
| Own-server routes | no | `server.js`'s daily validation/board, telemetry and presence were local-dev routes; the engine client does not call them |
| Platform achievements | no | Achievements stay local in the save |
| Sessions, matchmaking, chat, realtime, voice | no | Single-player puzzle |

## 13. Technical architecture

- **Loop:** `onFixedUpdate` at 60 Hz feeds `Session.advance(1000/60)`, which fires as many 220 ms (340 ms assisted) ticks as owed, unless a sheet is open or a replay is playing (the replay steps its commands every 260 ms, ticks every 90 ms, on the same steps). `onRender` builds the UI and hands the renderer `(state, prevSnapshot, alpha)` to interpolate the water. A suspended app pauses the round and flushes the save.
- **Session** (`session.js`, unchanged): command ids, `_persist` snapshot after every accepted command (cleared on terminal, suppressed during replay), `restore`, `exportReplay`.
- **Persistence:** `js/storage.js` reads and writes `localStorage`; `native/platform.ts` installs a shim whose `channelkeeper.progress | achievements | boards` keys are the save document (wrapped and checksummed as storage.js expects; a write saves) and whose other keys are the device's `starhermit:storage`. `Erase local progress` empties the save and the device keys.
- **Renderer:** see §8; one instanced mesh each for cells, water, spikes and boulders; picking intersects the camera ray with the board's plane; the board is fitted into the free rectangle with `camera.setViewOffset`.
- **Budgets:** boards ≤ 13×16 = 208 cells; per-tick work is O(cells); the package is about 1.1 MB.

## 14. Testing and acceptance criteria

`npm test` runs:
- `tests/run-tests.mjs` — rules and content (determinism, replay hashes, legality, scoring, every level validates);
- `node --test tests/i18n.test.mjs tests/migrate.test.mjs` — localization coverage and locale switching; the browser save and settings migration, the two-device merge, and `js/storage.js` over the shim;
- `tests/native.mjs` — the web index matches the files (`npm run package` ran), `tsc` (no skipLibCheck), `starhermit check .` with zero warnings, and four signed-out render-check play scripts in `tests/native/`: `journey-stage` (stage 1 dug by keyboard, water delivered, results 590, Next stage), `learn-lesson` (First Dig's three steps, results, Next lesson), `practice-tools` (hint, dig, undo, pause with Settings and Help, Leave round), `screens` (Scores, Achievements, Help, Settings with the erase confirmation, Challenge list, Daily with pause and Leave round).

`npm run test:browser` (`tools/browser-play.mjs`) serves the package on loopback and plays it in headless Chrome at 1366×768, 390×844 and 844×390 by keys and taps, failing on console errors or warnings or the runtime's error screen; `~/games/tools/engine-web-smoke.mjs` checks the start at desktop and phone sizes.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` | Title backdrop (1200×672) | FLUX.2 klein, seed 5401 | generated in this pass |
| `assets/well-filled.webp` | Results illustration, win (640×400) | FLUX.2 klein, seed 5402 | generated in this pass |
| `assets/water-spent.webp` | Results illustration, loss (640×400) | FLUX.2 klein, seed 5403 | generated in this pass |
| `coverart.png` | Platform cover 1200×675 (256-colour PNG) | key-art scaled | replaced in this pass (was a generic placeholder) |
| `icon.png` | Icon 256² | authored PNG | shipped |
| `sfx/ui-tick … achievement-chime.opus` (13) | Core event clips | MOSS-SFX v2 | shipped |
| `sfx/hint-glimmer.opus` | `hint` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/spring-dry.opus` | `springDry` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/pause-hush.opus` | `pause` | MOSS-SFX v2, 100 steps | generated in this pass |
| `sfx/resume-swell.opus` | `resume` | MOSS-SFX v2, 100 steps | generated in this pass |
| 3D models / character animation | – | – | none: all geometry procedural; no humanoid |

## 16. Known limitations

- Sideways spreading moves into any neighbour at least 1 unit lower (`stepFlow`), while the code comment claims a 2-unit threshold; the period-2 stagnation detector bounds the resulting slosh, and tightening the rule breaks authored solvability (see `knownissues.md`).
- `compareResults` and board sorting tie-break with `localeCompare`; session ids are ASCII so order is stable in practice.
- The results table prints `-0` for zero contamination (as the browser build did).
- Local boards name every entry "You", so "Board rank" only compares your own runs.
- `splash` is bound to a clip but no rules event emits it.
- Guests' browser-build progress in the browser's localStorage cannot be read by the engine (only the signed-in cloud save migrates); a binding the browser build stored for `cameraReset` is not carried over (the action is `camera`).
- The DOM fallback grid for browsers without WebGL is gone (the runtime renders everywhere it starts).
- Music and ambience are synthesized (rendered once into clips), not authored.

## Design intent not yet implemented

- Remote achievement grants and a server-validated daily board on the platform.
