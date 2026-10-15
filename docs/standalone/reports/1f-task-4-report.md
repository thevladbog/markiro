# Plan 1f, Task 4 report: operator session in `src/app/shell.ts`

Status: DONE_WITH_CONCERNS (concerns below are about unreachable or view-gated paths; code is the brief's verbatim).
Base 509cf9b2a; commit `39bf3e9a9 feat(standalone): сеанс оператора цеха в состоянии оболочки` (one Co-Authored-By line, verified). `git status --short` empty after.

## What was done

- Step 1: the brief's 7 tests appended to `test/shell.test.ts` verbatim. All 15 Step-3 edits applied via a script that asserted each anchor matched exactly once (all 15 matched; edit 9 matches only `forgotten` after edit 8, as designed).
- Extras: a second `describe` (49 tests) with an exhaustive table over ALL action types.

## RED / GREEN

- Baseline before start: Vitest 61 files / 1502 tests (as the controller said).
- RED (`vitest run test/shell.test.ts`, 7 brief tests only): `Tests 7 failed | 38 passed (45)`; `TypeError: Cannot destructure property 'device' of 'state' as it is undefined`, `Cannot read properties of undefined (reading 'floorNotice')`.
- GREEN: `Tests 45 passed (45)` (brief tests), then 94 with extras. `--reporter=verbose`: 94 tests, stderr empty (0 bytes). Delayed-`setImmediate` stand: 94 passed; stand files removed.
- Gates: prettier clean, `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`, typecheck 0, lint 0.
- Full suite: 61 files / **1558 tests** = 1502 + 7 (plan) + 49 extras. The plan's own number (1459) is 1452 + 7; the measured base was 1502, so the shift is +50 from earlier tasks, as predicted. `shell.test.ts`: 45 by plan, 94 measured.
- `shell.ts` has no storage, `invoke` or `console` use (grep empty).

## Extras (49 tests, all in the second describe)

- Table: `Record<ShellAction["type"], Case[]>` (compile error when a new action type is added without a decision), 31 cases, each says whether Anna survives the action on her floor; one parameterised test per case.
- "never writes": spies `Storage.prototype.setItem` across all table actions.
- identity only: operator keys are exactly id, login, name, role; the state JSON has no pin/badge/hash/pbkdf/secret.
- every notice value (`idle`, `removed`, `line_changed`) is recorded by a matching sign-out.
- late `operator_signed_in` ignored after: forget; re-pair as another device; office requested and opened; line cleared; other host; key_rejected; certificate_mismatch; device not read (loading, unreadable).
- a sign-in works again after the office closed; office/handheld devices with no line sign in and reach `floor_operator`.
- floorNotice: cleared by sign-in, office, pairing, forget; kept by a refused sign-in; kept through a line change with nobody signed in; null stays null; `line_selected` gives no notice.
- view priority: line_select, device_rejected, other_host and office_login all win over an operator in state.
- initial state and fresh pairing have no operator and no notice.

## Mutant table (every run on the whole file unless `-t` given; restore proven after each: `sha256` equal and `cmp` against /tmp/claude/shell.before.ts silent)

Brief mutants (with the brief's `-t`):

| Mutant                                                | Failed test                                              |
| ----------------------------------------------------- | -------------------------------------------------------- |
| B1 drop `status.deviceId !== action.deviceId`         | signs nobody in from another pairing...                  |
| B2 sign-out `operator === null` instead of id compare | ignores a late sign-out for an operator who already left |
| B3 drop `operator: null` in device_refreshed          | signs the operator out when the office moves...          |
| B4 drop `operator: null` in office_requested          | signs the operator out for the office, a new pairing...  |

Own mutants (all killed; first failing tests listed):

| Mutant                                                                                                                                            | Killed by                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| X1 drop `rejection !== null` guard                                                                                                                | signs nobody in...; late sign-in test; notice test                    |
| X2 drop other_host guard                                                                                                                          | signs nobody in...; late sign-in test                                 |
| X3 drop office-closed guard                                                                                                                       | same two                                                              |
| X4 drop no-line guard (`false`)                                                                                                                   | same two                                                              |
| X5 no-line guard applied to every device kind                                                                                                     | signs in a device of the office or the handheld kind                  |
| X6, X35, X36 drop device-ready / status-null check (each part)                                                                                    | late sign-in test (+ signs nobody in for status null)                 |
| X7 sign-in keeps old notice                                                                                                                       | says why...; forgets the sign-out reason                              |
| X8 sign-in stores no operator                                                                                                                     | 32 tests                                                              |
| X9 sign-out drops notice                                                                                                                          | says why...; records the reason                                       |
| X10 sign-out keeps operator                                                                                                                       | table row; shows the signed-in floor                                  |
| X11 sign-out forces `idle`                                                                                                                        | records the reason; shows the floor                                   |
| X12 / X13 `paired` keeps operator / notice                                                                                                        | table row, brief test, fresh pairing / notice test                    |
| X14 / X15 `forgotten` keeps operator / notice                                                                                                     | table row, brief test / notice test                                   |
| X16 office_requested keeps notice                                                                                                                 | notice test                                                           |
| X17 device_rejected keeps operator                                                                                                                | both table rows, brief test                                           |
| X18 link_status rejection keeps operator                                                                                                          | both rows (key_rejected, certificate_mismatch), brief test            |
| X19 every link_status signs out                                                                                                                   | online/offline table rows; keeps-through-offline test                 |
| X20 other_host sync keeps operator                                                                                                                | table row, brief test                                                 |
| X21 line_selected keeps operator                                                                                                                  | table row; chosen-line test                                           |
| X22 refreshed notice always `line_changed`                                                                                                        | keeps the reason of an earlier sign-out                               |
| X23 refreshed never sets notice                                                                                                                   | brief line-change test                                                |
| X24 refreshed resets notice when nobody                                                                                                           | keeps the reason of an earlier sign-out                               |
| X25 view: operator before line_select                                                                                                             | view priority test                                                    |
| X26 view never `floor_operator`                                                                                                                   | 3 tests                                                               |
| X27 initial state has a notice                                                                                                                    | initial-state test                                                    |
| X28-X31 sync_started / sync_failed / host_revision / synced sign out                                                                              | table row + keeps-through-offline test (X31: table row)               |
| X32 same-line refresh signs out                                                                                                                   | 2 table rows + brief test                                             |
| X33 / X34 refreshed drops deviceId / hostId check                                                                                                 | other-pairing table rows (added a hostId row after finding X34 alive) |
| X37 sign-in writes `localStorage`                                                                                                                 | never-writes test                                                     |
| X38 operator gets an extra `pinHash` field                                                                                                        | 31 tests including the identity-only test                             |
| First run of X34 would have survived: the table had only a deviceId row; added the hostId row and re-ran: killed. No mutant is called equivalent. |

## Concerns for the controller (code is the plan's; not changed)

1. Reducer actions that do NOT sign the operator out and have no guard of their own: `office_opened` and `office_closed`, `device_loaded`, `device_unreadable`, `host_probed`. Reachability: `office_opened` only follows `office_requested` (operator already null; `operator_signed_in` is refused while the office is not closed); `device_loaded` / `device_unreadable` are dispatched once at mount (App.tsx 97/100), before anyone can sign in. `host_probed` can show `device_rejected host_changed` through the view while `operator` stays in state, and the floor returns with the same operator if the local probe flips back to matching. The brief lists local-probe host mismatch nowhere; I pinned the current behaviour in the table (comments explain) and did not widen the reducer. Decide whether the view-level `host_changed` should also sign out.
2. `operator_signed_in` stores `action.operator` by reference and cannot enforce that no hash rides along: the secrecy of the state depends on `sign-in.ts` (task 2 builds a fresh `{id, login, name, role}` object, which I checked in `signedIn()` there). My secrecy test checks the shape given a `FloorOperator`.
3. Counts: plan 1452→1459 versus measured 1502→1509 before extras (+50 shift as announced); 1558 after extras.

Files: `apps/standalone/src/app/shell.ts`, `apps/standalone/test/shell.test.ts`. Not run: build of the Tauri shell (untouched), cargo (untouched).

## Fix round 1

Base: 39bf3e9a9. Fixes Important 1 of the review (a signed-in operator survived `office_opened` and `host_probed`) and Minor 4; Minors 1, 3 are not changed (below).

### Change

- `src/app/shell.ts`: `host_probed` -> `{ ...state, localHost, operator: null }`; `office_opened` -> adds `operator: null, floorNotice: null`. Losing the host link still keeps the operator (the existing link/sync/offline rows pin that and pass).
- `test/shell.test.ts`: table rows `host_probed` (probing, `host_too_old`, found same host, found another host) and `office_opened` now `survives: false`, with the false comments replaced; four scenarios (bootstrap wizard -> `office_opened` without `office_requested` -> `office_closed` ends on `{ kind: "floor" }`; `office_opened` clears `floorNotice`; blocked version screen retried ends on the sign-in; another host found keeps no operator). The bootstrap scenario builds the operator-in-state explicitly (`{ ...probed, operator: ANNA }`) so it tests `office_opened` independently of `host_probed`.
- Minor 4: `TABLE` is now `{ [K in ShellAction["type"]]: [Case<K>, ...Case<K>[]] }` with `Case<K>` using `Extract`; `signIn` is typed as the `operator_signed_in` member so the spread row still compiles.

### RED (old reducer, new tests)

`vitest run test/shell.test.ts`: 9 failed | 92 passed (101): 4 `host_probed` table rows, the `office_opened` row, and the 4 new scenarios.

### GREEN

- `shell.test.ts` + `app.test.tsx`, `--reporter=verbose`: 168 passed, stderr empty. Same two files under the delayed-`setImmediate` stand: 168 passed, stderr empty (stand files removed).
- Typecheck, lint: clean. Whole package: 61 files, 1565 tests passed (1558 + 7: 3 new `host_probed` rows + 4 scenarios). prettier --check, `git diff --check` clean; `\u04` grep: only `src/host/pairing-code.ts:66`.
- No existing test in `app.test.tsx` or elsewhere depended on the old behaviour; nothing adapted.

### Mutants (each restored: `cp` from /tmp/claude, `cmp` silent, same sha256 f064e39e...a0ab before/after)

| Mutant                                                                                                     | Failing tests                                                                                                                                                                                | Result                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `host_probed` without `operator: null`                                                                     | 4 `host_probed` table rows, "blocked version screen is retried", "another one"                                                                                                               | 6 failed                                                            |
| `office_opened` without `operator: null`                                                                   | `office_opened` table row, "whatever the notice was", "bootstrap wizard opens" (after making that scenario independent of `host_probed`; before that it passed, which is why it was changed) | 3 failed                                                            |
| `office_opened` without `floorNotice: null`                                                                | "whatever the notice was"                                                                                                                                                                    | 1 failed                                                            |
| Minor 4 closure (scratch edit of the table: `host_revision: []`, a `sync_failed` row under `sync_started`) | `tsc`: TS2322 on both                                                                                                                                                                        | 2 errors; test file restored byte-identically (sha 32fce37a...5256) |

### Not changed, for later tasks

- Minor 1: a sign-in in flight across a line change lands on the new line (needs `lineId` in `operator_signed_in`).
- Minor 3: a late sign-out from an earlier session of the same operator ends the new session (Task 6 must key the idle timer and copy check to the session, or add a session sequence).
- Minor 5: the table has 38 cases in the previous round (the report said 31); it is now 41 (38 + 3 rows) of 101 tests in the file.
- New observation: `operator_signed_in` does not check the view, so a sign-in whose answer lands after a probe moved the screen off the floor (bootstrap, version screen) is accepted by the reducer. The hardening here (office_opened clearing the operator) makes the office path safe, but Task 5/6 should drop a late sign-in answer when the view is not `floor`.
