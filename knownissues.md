# Known Issues — Channel Keeper

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and browser smoke suite. Re-verified and fixed 2026-09-04.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/run-tests.mjs`) | 27/27 pass, 0 fail (verified) |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.mjs`) |
| `node tests/e2e.mjs` (headless Chrome, desktop + mobile) | E2E OK — both passes complete clean, exit 0 |

## Resolved defects

All fixes were applied and verified on 2026-09-04.

### 1. Undo rewinds `state.seq`, producing duplicate sequence numbers in the append-only command log — RESOLVED

- **Fixed at** `js/rules.js:248-259` (`applyCommand`, `case 'undo'`). Added `const keepSeq = state.seq;`
  before `Object.assign(state, snap)` and restored `state.seq = keepSeq` afterward, so the monotonic
  command counter no longer rewinds on undo. Verification: `seq` after carve→undo→carve is now
  `[1, 2, 3]` (no duplicates).

### 2. `snapshot()` aliases `wHist`, so undo snapshots mutate after they are taken — RESOLVED

- **Fixed at** `js/rules.js:113-123` (`snapshot`). Added `c.wHist = state.wHist.slice();` so the
  replay-safe snapshot owns an independent copy of the stagnation history. Verification:
  `snapshot(state).wHist === state.wHist` is now `false`.

### 3. `stateHash` does not cover the stagnation state — RESOLVED

- **Fixed at** `js/rules.js:126-143` (`stateHash`, field list). Added `s.wHist.join(',')` and
  `s.stagnant` to the canonical field list. Verification: two states differing only in `wHist` /
  `stagnant` now hash differently (`d475e04d` vs `3ee536c1`).

### 4. Sideways water movement contradicts the documented "never oscillate" invariant — NOT FIXED (documented)

- **Status:** the code-vs-comment mismatch is real (`js/rules.js:335` guards on `diff >= 1`, the
  comment at `js/rules.js:302-305` claims `diff >= 2`), but the documented Expected behaviour is
  **harmful to apply**. Changing the guard to `< 2` breaks actual level solvability: the shipped
  `autoSolve` (which carves the correct route then releases) could no longer deliver the target volume
  on `journey-2` and on random generator seeds, so those rounds ended `settled-dry`/`lost` and the
  `all shipped content passes the offline validator` and `generator fuzz` tests failed. The period-2
  oscillation the defect describes is already bounded safely by the engine's period-2 stagnation
  detector (`wHist` + `stagnant >= 6` at `js/rules.js:385-389`), which terminates the round instead of
  hanging. The physics was therefore left unchanged.

### 5. `maxTicks: 0` is silently replaced by the default 400 — RESOLVED

- **Fixed at** `js/rules.js:97`. Changed `maxTicks: level.maxTicks || 400` to
  `maxTicks: level.maxTicks ?? 400`, honouring an authored `0` budget. Verification:
  `createState({ ...level, maxTicks: 0 }, seed).maxTicks` returns `0`.

### 6. Any past or future daily board can be submitted to — RESOLVED

- **Fixed at** `server.js:46-55` (`validateDailySubmission`). After validating the day-key shape/date,
  added a window check `if (day !== dailyKey(new Date())) return { ok: false, error: 'daily not open' };`
  so only today's UTC board is open for submission. Verification: today's envelope validates `ok:true`;
  envelopes derived for `2019-01-01`, `2027-11-03` and `2035-06-06` are all rejected (`ok:false`).

### 7. One player can fill the daily board with duplicate entries — RESOLVED

- **Fixed at** `server.js:80-84` (`submitDailyScore`). The board now keeps one row per `playerId`:
  existing rows for that identity are filtered out before the new entry is appended, sorted and capped.
  Verification: five identical submissions from one `playerId` now return `{ ok:true, rank:1 }` (a
  single row) instead of accumulating six rows.

## Suspected — not confirmed

### 1. Undo does not rewind stagnation tracking — RESOLVED

- **File:** `js/rules.js:248-259`, following from confirmed defect 2
- **Concern:** because the undo stack's snapshots share the live `wHist` array, undoing a command issued
  before a run of flow ticks restores `tick`, `cells`, `clean` and `dirty` to their earlier values while
  `wHist` keeps the later ones. The engine could then declare "settled-dry" earlier or later than a fresh
  run of the same command sequence would.
- **Resolution (2026-09-04):** superseded by the defect 2 fix. `snapshot()` now copies `wHist`
  (`state.wHist.slice()`), so each undo snapshot owns an independent stagnation history and `undo`
  restores `tick`, `cells`, `clean`, `dirty` and `wHist` together to the pre-command values.
- **Why unconfirmed:** on the practice levels I could drive, the round reached a terminal phase within a
  few ticks of `release`, and `undo` is refused once the phase is WON/LOST
  (`js/rules.js:188-189`, `applyCommand` returns `game-over`). I could not construct a level where undo
  is still legal after enough ticks to make the divergence visible.

### 2. `compareResults` tie-break uses `localeCompare`

- **File:** `js/rules.js:453`
- **Concern:** `String(a.sessionId).localeCompare(String(b.sessionId))` is locale- and ICU-dependent,
  which is at odds with a deterministic engine whose ordering the server relies on.
- **Why unconfirmed:** shipped session ids are ASCII alphanumerics, for which common collations agree
  with code-unit order; I could not produce a divergence with realistic ids.

## Checked, no defects found

- `js/rules.js:146-198` — `explainCarve` cell-type guards and cost calculation; `legalActions` phase and
  budget gating; `applyCommand`'s payload validation, command-id length bound, duplicate-id idempotency,
  and terminal-state refusal.
- `js/rules.js:137-142` — FNV-1a implementation (`Math.imul` with `>>> 0`) is correct 32-bit unsigned
  arithmetic; `cells.join('')` is unambiguous because every CELL value is a single digit.
- `js/storage.js` — corrupt-storage harness: every zero-argument loader (`loadAchievements`, `loadBoards`,
  `loadProgress`, `loadSessionSnapshot`, `loadSettings`) was called against a fake `localStorage`
  pre-filled with `{`, `null`, `[]`, `{"v":9999}`, `"a"`, `0`, `undefined`, `{"v":1}`,
  `{"v":1,"data":null,"crc":0}` and `{"data":{"progress":null}}`. None threw; all returned defaults.
- `server.js` — HTTP fuzz: directory paths (`/js`, `/css`, `/src`, `/tests`) all return 500 rather than
  crashing; `../`, `%2e%2e%2f`, `....//` and `%c0%ae` traversals all refused; 20 malformed bodies POSTed
  to each of `/api/v1/daily/submit`, `/api/v1/daily/board`, `/api/v1/daily`, `/api/v1/achievement`,
  `/api/v1/events`, `/api/v1/presence`, `/api/v1/time`, `/api/v1/version` left the process alive.
  `server.js:41-60` rebuilds the daily level server-side from the day key (`dailyLevel(date)`), checks
  the schema and `contentVersion`, caps the command count, shape-checks every command, replays the log
  deterministically, and requires the recomputed `stateHash` to equal the client's before deriving the
  score from the replayed state (line 61). A client cannot substitute its own level definition or claim
  a score it did not earn — defects 6 and 7 are about *which day* and *how many rows*.
- `server.js:125, 166-167` — static path handling: `new URL` collapses `..` before `path.join(ROOT, p)`,
  and a `startsWith(ROOT)` guard backs it up; percent-encoded dots are not re-decoded into separators.

## Not tested

- Sustained play and the WebGL renderer beyond what `tests/smoke.mjs` exercises (it plays tutorial 1 to
  completion at one viewport size).
- Audio output (`js/audio.js`) — no audio device in headless Chrome.
- `tests/capture.mjs` was not run; it is a screenshot-capture tool, not an assertion suite, and it writes
  into `tests/captures/` inside the game folder.
- The smoke suite hard-codes port 8917 and starts its own server, so it could not be moved into the
  assigned port range; it was run as shipped.
