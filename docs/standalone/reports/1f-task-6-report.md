# Plan 1f, task 6 — report

Status: DONE_WITH_CONCERNS. Commit 094447a56 «feat(standalone): цех — вход оператора, заглушка после входа, выход по бездействию» (base 0fecfaf69; one trailer line, `git status --short` empty).

## Counts

- Baseline before: 62 files / 1610 tests (confirmed).
- Plan's expectation with the +128 shift: 63 / 1620 (floor-operator 5, app 5). Measured at the end: **63 files / 1641 tests** (+21 own extras: floor-operator 13, app 8). Focused: floor-operator 18, app 80, operator-sign-in unchanged. The plan's RED run: floor-operator fails to compile (`Failed to resolve import "../src/floor/FloorOperatorScreen.js"`), app 5 failed | 67 passed (72) (plan says 66 passed: the file has one more test than the plan's scratch copy).
- typecheck, lint, prettier --check, `git diff --check`: clean. `\u04` grep: only `pairing-code.ts:66`. `floor.body|FloorScreen` grep: nothing. Build not run (no shell/dist change). Cargo not touched.
- `--reporter=verbose`: stderr empty, no `act` warnings. Delayed-`setImmediate` stand: 143/143 on 5 consecutive runs of the three files after fixing my own timing margins (see concerns); stand files removed.

## What was done / deviations from the brief (each is a deviation to report)

1. Plan code applied verbatim: `idle-lock.ts`, `FloorOperatorScreen.tsx`, `operatorStillAllowed`, `ru.json` (`floor.operator`, `floor.body` gone), `screens.tsx` without `FloorScreen`, the 7 `app.test.tsx` anchors (all matched exactly once) and the five plan tests.
2. (a) `OperatorSignIn.lineId` is now REQUIRED (`lineId: string | null`); `App` passes `lineId={pairedStatus.lineId}` and `pairing={pairedStatus}`, and keys the screen by `hostId:deviceId:lineId`. Consequence: the three constructions in `test/operator-sign-in.test.tsx` got `lineId={null}` / `lineId: null` (3 added lines, no assertion touched).
3. (b) `onSync` goes through a small request gate in `App.tsx` (`createRequestGate`, `SIGN_IN_SYNC_GAP_MS = 2000`, exported for the test): first request at once, later ones inside the wait fold into ONE run at its end, cleared on unmount. Finding: `useHostLink`'s request already coalesces concurrent triggers (`createSyncScheduler`: a trigger during a run sets `again`), but a scan after each finished sync would still ask a sync per scan; `not_ready` refusals are not counted by the lockout, so nothing else bounds them. The gate wraps only the sign-in's asks (LineSelect still uses `requestSync` directly).
4. (c) The late sign-in answer. The reducer's `operator_signed_in` does not check the view, and a view check inside the reducer or a ref in `App` cannot close the window between dispatch and commit, so I added none; the screen's own `alive` guard (unmount) is the barrier, verified end to end by an App test (check held by a gated executor, probe answers `host_too_old` → host_missing, «Проверить снова» → floor with a fresh sign-in screen, THEN the first check finishes and must not sign anybody in). That test kills the removal of the `alive` check deterministically (m30). A first draft of this test finished the check before the retry; it was found to depend on hash timing, so it now waits for the sign-in's final write (`wrote()`).
5. (d) Session identity: `App` bakes the session into the sign-out callback. `operatorSignedIn` dispatches a COPY of the operator (`{ ...operator }`); `operatorSignedOut` is bound to the session's operator object and ignores itself unless a layout-effect ref says that object is still the committed `state.operator`. Without a `shell.ts` change (not my file). The callback changes only per session, so the idle timer is not restarted by link events (tested). Test: the real `FloorOperatorScreen` is rendered through a pass-through `vi.mock` that records each mount's `onSignOut`; session 1's callback is called late after sign-out + sign-in of the same operator and session 2 survives (m21).
6. (e) The post-sync check follows the brief (fail OPEN on an unreadable/unready copy). Reasoning: failing closed would sign every operator off a working line on one transient SQLite error (offline-first, D2/spec §5.6); a removed operator is not left in for long: the check runs again after every later successful sync (tested: failed read → nobody signed out → next sync reads again → «removed»), and the lockouts/readiness of the next sign-in are fail-closed. Residual risk: a removed operator stays until the next successful sync after a failed read. No `error.message` is displayed or logged (console spy test; the rejection handler is `() => undefined`).
7. (f) The operator state is `{id, login, name, role}`: pinned by a new test that `signInWithPin` hands over a NEW object with exactly those four keys, never the credential row (m29). The name is rendered as a React text child; one markup-characters test with its mutant (m14).

## RED / GREEN

RED: `/tmp/claude/t6-red.txt` (above). GREEN: plan tests 76/76 with the plan's files; final 63 / 1641.

## Mutant table (every mutant restored byte-identically: `cmp` silent, sha256 before = after, copies under /tmp/claude)

| #   | mutant (one line)                                             | test that failed                                                                                                                                                  |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FloorOperatorScreen: delete `lock.start();`                   | app «signs the operator out after the idle timeout and says so»                                                                                                   |
| 2   | `onSignOut("removed")` → `return`                             | floor-operator «…no longer hold them», app «…tombstone for them»                                                                                                  |
| 3   | `operatorStillAllowed`: not ready → `return false`            | floor-operator «keeps the operator when the copies cannot be read or are not…»                                                                                    |
| 4   | App: `notice={state.floorNotice}` → `null`                    | app idle-timeout test                                                                                                                                             |
| 5   | idle-lock: drop `"touchstart"`                                | lock «restarts the wait on a touch», «listens for exactly a pointer, a key and a touch…», app touch test                                                          |
| 6   | idle-lock: drop `if (!active) return;`                        | «waits ten minutes by default…»                                                                                                                                   |
| 7   | idle-lock: `stop()` skips `removeEventListener`               | «listens for exactly …»                                                                                                                                           |
| 8   | screen: drop `if (sync.synced === 0) return;`                 | «reads nothing before the first sync of this run»                                                                                                                 |
| 9   | check effect deps without `sync.synced`                       | «checks again after every later sync», «…reads again after the next sync»                                                                                         |
| 10  | drop `!cancelled &&`                                          | «drops a check that lands after the screen is gone», «…replaced»                                                                                                  |
| 11  | `OPERATOR_PRESENT` without `NOT_QUARANTINED_OPERATOR`         | «signs out an operator whose newer record waits in quarantine»                                                                                                    |
| 12  | `rows.length > 0` → `> 1`                                     | «keeps an operator the copies hold», «checks again…»                                                                                                              |
| 13  | role line without the `!== null` guard                        | «shows no empty line for an operator without a role»                                                                                                              |
| 14  | name via `dangerouslySetInnerHTML`                            | «shows the operator's name as text…»                                                                                                                              |
| 15  | `onIdle: () => onSignOut("idle")` → `null`                    | «signs the operator out as idle after the timeout…»                                                                                                               |
| 16  | failure handler `() => console.error(error)`                  | «signs nobody out on a failed read, says nothing of it…»                                                                                                          |
| 17  | effect cleanup removed                                        | «…and not after the screen is gone»                                                                                                                               |
| 18  | App: drop the `idleTimeoutMs` spread                          | app idle, touch, link-event tests                                                                                                                                 |
| 19  | App: always the keyboard source                               | «takes the scans of the scan source it is given»                                                                                                                  |
| 20  | `operatorSignedOut` deps `[signedIn, state.link]`             | «does not start the wait again on every event of the link» (first draft of this test SURVIVED the mutant: it asserted with `findByText`; made tight, then killed) |
| 21  | drop the session guard `currentOperator.current !== signedIn` | «ends only its own session…»                                                                                                                                      |
| 22  | `onSync={requestSync}` (no gate)                              | «asks the host for a sync at most once in a while…»                                                                                                               |
| 23  | gate: drop the trailing run                                   | same                                                                                                                                                              |
| 24  | gate: remove the unmount `cancel()` effect                    | «leaves no wait behind when the app is gone»                                                                                                                      |
| 25  | drop the `key` of `OperatorSignIn`                            | «drops what was typed when the office moves the station to another line»                                                                                          |
| 28  | gate: drop `cooling = true`                                   | burst test and «leaves no wait behind…»                                                                                                                           |
| 29  | `signedIn()` returns the row object                           | «is a new object of identity fields only each time…»                                                                                                              |
| 30  | OperatorSignIn: drop `if (!alive.current) return;`            | the probe-moved-off-the-floor-and-back test                                                                                                                       |

Argued equivalent, NOT killed (ran green on their mutants):

- 26 `lineId={pairedStatus.lineId}` → `null`: redundant by construction with the `key` that contains the line (a line change remounts, the old instance is dead and `alive` drops its answer); the screen's own `lineId` check is covered at unit level in `operator-sign-in.test.tsx` (the «station's line» cases). Kept because the binding note asks for it.
- 27 `{ ...operator }` → `operator`: `signedIn()` in `sign-in.ts` already builds a fresh object per call, so identity differs anyway; the premise is pinned by test 29 so a future change of `sign-in.ts` cannot silently turn the session guard off. The copy is defence in depth.
- `pairedDeviceId !== null` guard in `operatorSignedIn`: the floor view exists only with a paired status; type guard only.
- Idle-lock `start()` calling `stop()` first: duplicate registration of the same listener reference is a no-op in DOM and `activity()` clears the timer anyway.

## Concerns

- One timing finding of my own, fixed: the burst and touch tests first used margins of 100–200 ms of fake time; the fake clock (`shouldAdvanceTime`) also runs with real time, and under the delayed-`setImmediate` stand with three parallel files the gate's wait expired early (4 of 6 runs failed). Margins are now 800+ ms; 5/5 + 6/6 stand runs green. These tests rely on `fakeRetryTimers` like the existing retry tests.
- The 2 s gap and the fail-open decision (e) are my choices, open for the owner.
- `OperatorSignIn.tsx` and `operator-sign-in.test.tsx` (task 5 files) changed only as stated in (a); `app.test.tsx` has a file-wide pass-through `vi.mock` of `FloorOperatorScreen` (renders the real component; only records props).
- Not verified here: real keyboard-wedge hardware, Tauri shell, Windows.

## Fix round 1

Base `094447a56`; commit `04baef8ad` fix(standalone): вход оператора учитывает линию и экран, на которых он начат (one `Co-Authored-By: Claude Opus 5.5` line).

### What changed

- `shell.ts` (Task 4's file, approved): `operator_signed_in` carries `lineId` (the line the check began on) and `address` (the local host address, needed by `nextShellView`). The reducer refuses (state returned unchanged, `toBe`) when (1) `status.lineId !== action.lineId`, (3) the view for `action.address` is neither `floor` nor `floor_operator` (bootstrap, version screens, `line_select`, `office_login`/`office`, `device_rejected`, `other_host`, loading), (2) an operator is already signed in. The old clauses (device id, rejection, other_host, office, lineless station) stay. `floor_operator` is allowed in (3) so that (2) and (3) are independent clauses.
- `OperatorSignIn.tsx`: `onSignedIn(operator, lineId)`; `lineId` is the screen's closure value of the `attempt` that started the check (not the current prop).
- `App.tsx`: `operatorSignedIn(operator, lineId)` dispatches `lineId` and `address`. New prop `signInSyncGapMs` (default `SIGN_IN_SYNC_GAP_MS`), mirroring `idleTimeoutMs`, so the burst test can use a 30 s gap (Minor 4).
- Tests adapted without weakening: `operator-sign-in.test.tsx` (9 `toHaveBeenCalledWith(operator)` now also pin the line: `null`, and `LINE` in the test whose screen has one); `shell.test.ts` — the two `signIn` constants gain `lineId`/`address`; "ignores a late sign-out..." signs Anna out before Boris signs in (a repeat sign-in no longer replaces a session); the table row «a sign-in while somebody is signed in replaces them» became three `survives: true` rows and the special case for `operator_signed_in` in the table test is gone; "signs in a device of the office or the handheld kind without a line" sends `lineId: null` (and now also asserts that an answer carrying a line is refused for it).

### RED (before the fix, commands: `vitest run test/shell.test.ts test/app.test.tsx -t "operator|line|sign"`)

7 failed / 108 passed: the new scenario `does not sign an operator in on the new line when the answer lands in the batch of the line change` (received «Вошёл: Анна Кузнецова, табельный номер 0042.»), the two new `operator_signed_in` table rows (Boris replaces Anna; other line), `refuses a sign-in that began on another line...`, `never replaces a running session...`, `refuses a sign-in whose floor is not on screen...`, and the adapted office/handheld test.

### New tests

- `app.test.tsx`: the batch scenario (gated check; the office's move held on a promise; in ONE `act` the move resolves, the gate releases and the write is awaited; ends on the prompt, no stub, no «Сменить оператора»); «waits two seconds between the sign-in's syncs unless it is told otherwise» (spy on `setTimeout`, asserts `SIGN_IN_SYNC_GAP_MS === 2000`).
- `shell.test.ts`: `refuses a sign-in that began on another line than the station has now` (other line, null, queued behind `device_refreshed`, and the new line's own sign-in passes), `never replaces a running session...` (other operator, same operator by a copy; works again after sign-out), `refuses a sign-in whose floor is not on screen...` (wizard, host too old, app too old, another host's certificate; also asserts the view kind), `signs in a station paired with a host in the network, whatever the local probe says`, plus the three table rows.

### Mutants (each: scratch edit, focused files run, restore by `cp` from `/tmp/claude/mut6/`, sha256 before = after, `cmp` silent)

| #   | Mutant                                                      | Failing tests (key)                                                                             | Restore                                |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| M1  | drop the `lineId` clause                                    | `refuses a sign-in that began on another line...`; office/handheld test; the app batch scenario | sha equal, cmp 0                       |
| M2  | drop the view clause                                        | `refuses a sign-in whose floor is not on screen...`                                             | sha equal, cmp 0                       |
| M3  | drop the `state.operator !== null` clause                   | table row (Boris replaces Anna); `never replaces a running session...`                          | sha equal, cmp 0                       |
| M4  | read the view with address `""` instead of `action.address` | `refuses a sign-in whose floor is not on screen...`                                             | `103cb8a28a4e`-style equal shas, cmp 0 |
| M5  | `OperatorSignIn` passes `null` instead of `lineId`          | `operator-sign-in` «still answers when only a callback changed meanwhile» (expects `LINE`)      | sha 103cb8a28a4e = 103cb8a28a4e, cmp 0 |
| M6  | `App` sends `lineId: null`                                  | 9 app tests (every badge sign-in on a station with a line)                                      | sha 68806d1805eb = 68806d1805eb, cmp 0 |
| M7  | `signInSyncGapMs` default `0`                               | `waits two seconds between the sign-in's syncs...`                                              | sha equal, cmp 0                       |
| M8  | `App` ignores the `signInSyncGapMs` prop                    | `asks the host for a sync at most once in a while...`                                           | sha equal, cmp 0                       |

Equivalent, named: `App` reading the current `pairedStatus?.lineId` instead of the screen's argument is indistinguishable in every observable path today, because `attempt` (and with it `onSignedIn`) is the closure of the render that started the check, so both carry the old line; the argument is the contract the reducer relies on, the type forces it. A wrong `address` in `App` changes nothing the app tests can see (the screen is already gone through `alive`); the reducer's use of it is pinned by M4.

### Minor 4 (burst test)

Plain fake timers cannot be used throughout: RTL's `asyncWrapper` awaits a `setTimeout(0)` that never fires on a stopped fake clock (verified: the test hung at `onTheFloor`). So the gap became a prop: the test runs with a 30 s gap, the "not yet" check is at gap − 5 s and the boundary at +10 s, i.e. at least 5 s of slack instead of 0.8 s; the burst itself has ~30 s of slack.

### Evidence

- Focused (`shell`, `app`, `floor-operator`, `operator-sign-in`) `--reporter=verbose`: 4 files / 252 tests passed, stderr 0 bytes.
- Delayed-`setImmediate` stand, 5 consecutive runs of the same four files: 252/252 each time (stand files removed after each; `git status --short` empty).
- Whole package: 63 files / 1649 tests passed (1641 + 8 new: 6 in `shell.test.ts` counting the 3 table rows less the replaced one... measured, not derived: shell +6 tests/rows, app +2).
- typecheck 0, lint 0, `prettier --check` clean, `git diff --check` 0, `\u04` grep: only `src/host/pairing-code.ts:66`.

### Not done (as instructed; for the queue)

- Minor 2 (explicit session counter instead of object identity), Minor 3 (failed-read exposure; retry once after a delay), Minor 5 (stale name/role on the stub), Task 5 minors 3 and 6 (wave queue #14, #17), and the rest of the Task 5 queue: unchanged.

### Concerns

1. No `line_changed` notice appears in the batch scenario, and the reducer cannot add one under the "return state unchanged" rule: `device_refreshed` sets `line_changed` only when an operator is signed in, and nobody was yet. The operator who scanned sees the sign-in prompt again with no explanation. If the owner wants one, the line-mismatch refusal could set `floorNotice: "line_changed"`; I did not.
2. The new `signInSyncGapMs` prop is a test seam in production code (same kind as `idleTimeoutMs`).
3. The review's rationale in the Task 6 report («a reducer check cannot close the window») was wrong, as the reviewer said; this commit is the correction.
