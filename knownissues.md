# Known Issues — Channel Keeper

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on local5090 (HauhauCS Q3_K_P, 32k ctx),
alongside the game's own unit tests and browser smoke suite.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`tests/run-tests.mjs`) | 27/27 pass, 0 fail |
| `node --check` on all modules | clean (`js/*.js`, `server.js`, `tests/*.mjs`) |
| `tests/smoke.mjs` (headless Chrome) | PASS — 22/22 checks, "SMOKE OK", no console errors |
| HTTP fuzz of `server.js` (directories, traversal, malformed encodings, 20 malformed bodies on all 8 API routes) | survived; no crash, no traversal |

## Confirmed defects

Defects 6 and 7 were reproduced by calling the shipped `server.js` submission API directly.

### 1. Undo rewinds `state.seq`, producing duplicate sequence numbers in the append-only command log

- **File:** `js/rules.js:248-259` (`applyCommand`, `case 'undo'`), with the log append at `js/rules.js:270-271`
- **Trigger:** carve → undo → carve, on any level with `mechanics.undoAllowed` (all practice levels have it).
- **Behaviour:** the undo branch deliberately preserves two fields across the restore —
  `state.undoStack = keepUndo` and `state.commands = keepCommands` (lines 255-256, with the comment
  "replay log is append-only") — but `Object.assign(state, snap)` on line 254 also overwrites `state.seq`
  with the snapshot's older value. The next command then does `state.seq++` and pushes
  `{ id, seq: state.seq, ... }` into the preserved log, so the log contains repeated `seq` values.
- **Expected:** spec.md §2 "Objective and rules contract" requires "a monotonically increasing turn/tick
  number"; the code's own comment states the log is append-only.
- **Evidence:**

  ```
  state.seq = 3
  command log: [{"id":"c1","seq":1,"type":"carve"},{"id":"u1","seq":1,"type":"undo"},
                {"id":"c2","seq":2,"type":"carve"},{"id":"u2","seq":2,"type":"undo"},
                {"id":"c3","seq":3,"type":"carve"}]
  seq strictly increasing across the log: false
  duplicate seq values: true
  ```

### 2. `snapshot()` aliases `wHist`, so undo snapshots mutate after they are taken

- **File:** `js/rules.js:113-123` (`snapshot`), with `js/rules.js:275-279` (`pushUndo`) and the in-place
  writes at `js/rules.js:387-388`
- **Trigger:** take a snapshot (directly, or implicitly via `pushUndo` on a carve/release), then run any
  flow tick.
- **Behaviour:** `snapshot` copies `cells`, `clean`, `dirty`, `commands`, `lastEvents` and `mechanics`,
  but not `wHist` — the shallow `Object.assign({}, state)` leaves `c.wHist === state.wHist`.
  `stepFlow` writes `state.wHist[1] = state.wHist[0]; state.wHist[0] = h2;` in place, so every previously
  taken snapshot, including every entry on the undo stack, sees the new values. `undo` then restores via
  `Object.assign(state, snap)`, which cannot rewind the stagnation history it shares.
- **Expected:** the function's own docstring calls it "the replay-safe snapshot"; a snapshot must be
  independent of subsequent simulation.
- **Evidence:**

  ```
  snapshot(state).wHist === state.wHist : true
  after 3 ticks: state.wHist=[1436764135,1436764135] snapshotTakenBefore.wHist=[1436764135,1436764135]
  the pre-release snapshot has been mutated: true
  ```

  (`stagnant` is a number and *is* copied, so only the array is affected.)

### 3. `stateHash` does not cover the stagnation state

- **File:** `js/rules.js:126-143` (`stateHash`, field list at lines 129-135)
- **Trigger:** two sessions that agree on every hashed field but differ in `wHist` / `stagnant`.
- **Behaviour:** the canonical field list omits both `wHist` and `stagnant`, so such states hash
  identically. Those two fields drive the "settled-dry" terminal (`js/rules.js:385-389`, `stagnant >= 6`),
  so a replay that has diverged in stagnation tracking passes every intermediate hash check and only
  differs once `terminalReason` changes.
- **Expected:** spec.md §5 "Determinism, replay, and security" — the replay hash is the mechanism that
  proves a client's run matches the server's re-execution.
- **Evidence:** two states built from the same level, one with `stagnant = 5, wHist = [12345, 6789]`:

  ```
  stateHash ignores stagnant/wHist: true (a=9788680e b=9788680e)
  ```

### 4. Sideways water movement contradicts the documented "never oscillate" invariant

- **File:** `js/rules.js:335` (`if (occ(i) - occ(j) < 1) continue;`), against the comment at
  `js/rules.js:302-305`
- **Trigger:** two adjacent open cells whose fill levels differ by exactly 1, with the way down blocked.
- **Behaviour:** the comment states that sideways spread happens "only into a strictly lower fill level
  (diff >= 2), which guarantees pools equalize and never oscillate". The code's guard skips only when the
  difference is below 1, i.e. it moves whenever the difference is >= 1. `tryMove(..., 1)` transfers one
  unit, which inverts the pair (5/4 becomes 4/5), and the next tick moves it back — a period-2
  oscillation. The engine ships a period-2 stagnation detector (`js/rules.js:106-107, 385-389`) precisely
  to bound this, which is a workaround rather than the stated guarantee.
- **Expected:** the invariant documented at line 304 (`diff >= 2`).
- **Evidence:** the code at line 335 compares against `1`, not `2`; the stagnation history `wHist` holds
  two entries and is compared as `h2 === state.wHist[1]` (line 385), i.e. it is explicitly looking for a
  two-tick cycle.

### 5. `maxTicks: 0` is silently replaced by the default 400

- **File:** `js/rules.js:97` (`maxTicks: level.maxTicks || 400`)
- **Trigger:** authored content with `maxTicks: 0`.
- **Behaviour:** `||` treats `0` as absent, so the level runs with a 400-tick budget instead of the
  authored value. `parTicks` on the next line has the same shape (`level.parTicks || 0`) but there the
  fallback and the falsy value coincide, so only `maxTicks` is affected.
- **Expected:** content is spec'd (§2 "Difficulty and content generation") as versioned data whose
  declared bounds are honoured; the intended guard is `??`.
- **Evidence:** `R.createState({ ...level, maxTicks: 0 }, seed).maxTicks` returns `400`.

### 6. Any past or future daily board can be submitted to

- **File:** `server.js:46-52` (`validateDailySubmission`)
- **Trigger:** call `submitDailyScore(playerId, '2027-11-03', envelope)` — or POST the equivalent to
  `/api/v1/daily/submit`.
- **Behaviour:** the day key is taken from the client (`const day = dateKey || envelope.dailyKey || dailyKey(new Date())`)
  and validated only for shape, `/^\d{4}-\d{2}-\d{2}$/`. `dailyLevel(date)` is deterministic, so every
  past and future daily is generatable and solvable offline right now, and the seed check on line 52
  passes because the client derived its seed from the same function. There is no submission window.
- **Expected:** spec.md §2 "Modes" — "Daily: one shared seed and ruleset per UTC day, synchronized to
  platform time"; the comment on line 46 says "The daily level is derived from the immutable day key;
  never trust the client", which is true of the *level* but not of *which day*.
- **Evidence:** auto-solved submissions for three different days, all accepted:

  ```
  2026-08-20: phase=won validate.ok=true score=820 | submit={"ok":true,"rank":1,"score":820}
  2027-11-03: phase=won validate.ok=true score=770 | submit={"ok":true,"rank":1,"score":770}
  2019-01-01: phase=won validate.ok=true score=840 | submit={"ok":true,"rank":1,"score":840}
  ```

### 7. One player can fill the daily board with duplicate entries

- **File:** `server.js:72-85` (`submitDailyScore`), specifically the unconditional `list.push(entry)` on
  line 81
- **Trigger:** submit the same valid envelope repeatedly under one `playerId`.
- **Behaviour:** there is no per-player dedupe or best-only replacement — each accepted submission appends
  a new row. `rateOk(playerId)` (line 73) throttles the rate but the `playerId` is itself client-supplied,
  and the board is capped only at 200 entries (line 83), so a single player can occupy all of them.
- **Expected:** spec.md §6 "Achievements and leaderboards" — a board is a ranking of players, and every
  other game in this batch keeps one row per identity.
- **Evidence:** five identical submissions from `playerId: 'spammer'`:

  ```
  after 5 identical submissions from one playerId: {"ok":true,"rank":6,"score":820}
  ```

  Six rows on the board, all the same run.


## Suspected — not confirmed

### 1. Undo does not rewind stagnation tracking

- **File:** `js/rules.js:248-259`, following from confirmed defect 2
- **Concern:** because the undo stack's snapshots share the live `wHist` array, undoing a command issued
  before a run of flow ticks restores `tick`, `cells`, `clean` and `dirty` to their earlier values while
  `wHist` keeps the later ones. The engine could then declare "settled-dry" earlier or later than a fresh
  run of the same command sequence would.
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
