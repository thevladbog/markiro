# Plan 2a5, Task 5 — report

Status: DONE (one equivalent mutant noted, a brief-code observation in Concerns).
BASE d209d57f8 (Task 4), branch claude/2a5-floor, worktree /tmp/claude/wt/2a5-floor. Two commits (one trailer each, Opus 5.5 as the repository pins):

- `44bfec4ad` test(standalone): the shift reader neither reports nor retries a read for a station that is not paired (minors item 9)
- `96ccdd853` feat(standalone): the floor lists its line's shifts and enters one, with the host or from its stored snapshot (Task 5 + minors item 6)

## What was done

- Minors item 9 (separate small commit, first): `test/host-link-shifts.test.ts` — "say nothing and are not retried when the shell has no pairing to read for": `deviceShifts` rejects `HostError({kind:"transport", code:"not_paired"})` → `deviceShifts` called once, no `shifts_read`, no `device_rejected`, and still once after advancing 3 s (retry would be due at 2 s). Mutant "delete the guard line `if (error instanceof HostError && error.code === "not_paired") return;` (host-link.ts:250)" now FAILS: `expected [ { type: 'shifts_read', ok: false } ] to deeply equal []`; restored (cmp silent, sha256 525bd51d… before = after).
- Task 5 per the brief, verbatim code: `shift-text.ts`, `shift-entry.ts`, `ShiftCard.tsx`, `ShiftList.tsx` (new), `ru.json` (`floor.shifts.*`) and `shell.css` (`.shift-list`, `.shift-card*`) edits, `test/floor-shift-list.test.tsx` (new).
- Controller decision (a) / minors item 6: `storedWork` in `shift-entry.ts` returns `{ kind: "refused", reason: "closed" }` when the stored copy has `status !== "active"` or `localState !== null` (the only deviation from the brief's code; a doc comment says why). Reason `closed` is the existing refusal ("Смена закрыта.").
- Extra tests (beyond the 21 of the brief, 10 more in the shift-list file):
  - describe "entering a shift without the host" (direct `enterShift` calls with a stale list copy): enters an active kept shift offline; refuses a host-closed stored shift (link online/offline via the "request found no host" path) ×2; refuses a stored shift with `localState` closing/closed ×2; does not even ask the host for a copy whose `localState` is set (link online/offline) ×2.
  - "reads its copies again after a refusal" (host's list lands during the entry, shift disappears).
  - "shows the newest read of its copies when an older one lands last" (stale read race).
  - "hands the answer of an entry to the handlers of the screen as it is when the answer lands" (props change during the entry).

## Anchor adaptations

None. Both `ru.json` and `shell.css` fragments matched exactly once; all `Создать` blocks were extracted mechanically from the brief (python), then prettier reported "unchanged".

## RED / GREEN

- RED (brief test file, implementation absent — the four new source files moved aside): `Error: Failed to resolve import "../src/floor/shifts/ShiftList.js" from "test/floor-shift-list.test.tsx"`, `Test Files 1 failed (1)`; files moved back byte-identically.
- RED for item 6 (implementation per the brief without my `storedWork` check, my 5 direct tests added): `Tests 4 failed | 22 passed (26)` — the four "refuses a stored shift the office closed / this station is closing" cases; the brief's 21 tests passed (as the plan states: 21).
- GREEN after the `storedWork` check: `Tests 26 passed (26)`; after the four extra tests of the second round: `Tests 31 passed (31)` (shift-list file). `host-link-shifts.test.ts`: 16 passed (was 15).
- Verbose run of both files (`--reporter=verbose`): `Test Files 2 passed`, `Tests 47 passed (47)`, stderr 0 bytes, no `stderr`/`act(`/unhandled in stdout.
- Delayed-`setImmediate` stand (3 ms, plan's two temp files, removed after): the same two files `47 passed (47)`, stderr 0 bytes; `git status` clean of stand files.

## Mutants (each applied by a script as an exact one-occurrence replacement; file copied to /tmp/claude/impl-2a5-t5/orig-_, restored, `cmp` silent and sha256 equal — `restored True` in every harness line, outputs in /tmp/claude/impl-2a5-t5/mut-_.txt)

Plan mutants 1–5:

| Mutant                                                                        | Failing test(s)                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 `transport` → `{refused,no_link}` instead of `storedWork` (shift-entry.ts) | "continues from the stored snapshot when the request finds no host though the link said online" (+ my "refuses a stored shift the office closed, link online true") |
| M2 delete the `checkShiftSnapshot` line                                       | "neither keeps nor works a shift whose layout this build does not read"                                                                                             |
| M3 delete `if (running.current) return;`                                      | "enters one shift at a time and keeps «Сменить оператора» while an entry hangs"                                                                                     |
| M4 delete `if (!alive.current) return;`                                       | "drops an entry whose answer lands after the screen is gone"                                                                                                        |
| M5 `enabled: online \|\| copy.entered` → `true`                               | "does not continue a shift of this station whose snapshot it lost, until the host answers"                                                                          |

New guard of item 6 and further mutants hunted:

| Mutant                                                                                                        | Failing test(s)                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6 drop the `status !== "active"` half of the new `storedWork` check                                          | my "refuses a stored shift the office closed, with the link online false / true" (2)                                                                                                                                                                                        |
| M7 drop the `localState !== null` half                                                                        | my "refuses a stored shift this station is closing or has closed (closing / closed)" (2)                                                                                                                                                                                    |
| M8 delete the first line `if (copy.localState !== null) …closed` of `enterShift` — SURVIVED the brief's tests | strengthened: my "does not even ask the host to enter a shift this station is closing" (online true/false) now fails it (2)                                                                                                                                                 |
| M9 delete `if (!context.online) return storedWork(…)`                                                         | 4 (incl. "continues the shift this station entered … without the host")                                                                                                                                                                                                     |
| M10 delete the `not_found` mapping                                                                            | "says a shift the office deleted is gone"                                                                                                                                                                                                                                   |
| M11 drop `setAttempt` re-read after a refusal — SURVIVED                                                      | strengthened: my "reads its copies again after a refusal: the host may have changed the shift" fails it                                                                                                                                                                     |
| M12 `cardAction` ignores `localState === "closing"`                                                           | "offers nothing on a shift another station opened or one this station is closing"                                                                                                                                                                                           |
| M13 `ownerDeviceId !== deviceId` → `===`                                                                      | 5 tests                                                                                                                                                                                                                                                                     |
| M14 «Новая смена» enabled offline                                                                             | "keeps a planned shift and a new one closed without the host, and says why"                                                                                                                                                                                                 |
| M15 «Сменить оператора» disabled while an entry runs                                                          | "enters one shift at a time and keeps «Сменить оператора» while an entry hangs"                                                                                                                                                                                             |
| M16 drop `if (!cancelled)` in the copies effect — SURVIVED                                                    | strengthened: my "shows the newest read of its copies when an older one lands last" fails it                                                                                                                                                                                |
| M17 swap `notRead`/`empty` texts                                                                              | "reads its copies again after every read…", "says the shifts were never read…" (2)                                                                                                                                                                                          |
| M18 drop `shiftReads.done` from the effect deps                                                               | "reads its copies again after every read of the host's list"                                                                                                                                                                                                                |
| M19 `shift_busy` mapped to `closed`                                                                           | "says why the host refused the entry (shift_busy) and keeps the list"                                                                                                                                                                                                       |
| M20 delete the `shellActionFor … rejected` line                                                               | "hands a refused device key to the shell"                                                                                                                                                                                                                                   |
| M21 skip `keepEnteredShift`                                                                                   | "opens a planned shift …" and "enters one shift at a time…" (2)                                                                                                                                                                                                             |
| M23 `current.current.onEntered` → `onEntered` (stale handler)                                                 | my "hands the answer of an entry to the handlers of the screen as it is when the answer lands"                                                                                                                                                                              |
| M22 `online: current.current.online` → `online`                                                               | EQUIVALENT: the click handler that reads it is the latest render's closure, so the ref and the prop are the same value at that moment; no test can tell them apart (the ref matters for `onEntered`/`onHostError`, which are read after the await — M23). Not strengthened. |

## Counts

- Task-5 file: plan states 21; measured 21 (brief) + 10 mine = 31.
- Full package run: the default 5 s timeout run under load average 125–137 failed 248 tests in 19 files (all `Test timed out in 5000ms` in old office/other files: `devices-page`, `operators-page`, `operator-badges`, `products-page`, `app.test.tsx` …; none in this task's files). Re-run of the whole suite with `--testTimeout=60000 --hookTimeout=60000`: `Test Files 83 passed (83)`, `Tests 2339 passed (2339)`. Task 4 had 82 files / 2307 tests; +1 file, +32 tests = 21 + 10 (shift-list) + 1 (host-link-shifts). (Plan counts for Task 5: 78 files / 2009 tests are from the scratch base and differ on the real tree.)
- typecheck 0, lint 0, build 0, prettier --check clean (changed files, incl. ru.json and shell.css), `git diff --check` clean, `grep -rnF '\u04' apps/standalone/src apps/standalone/test` finds only `src/host/pairing-code.ts:66`. `git status --short` empty after the final commit. No Rust, no host, no proto, no manifests touched; cargo not run (nothing for it).

## Files changed

- apps/standalone/src/floor/shifts/shift-entry.ts, shift-text.ts, ShiftCard.tsx, ShiftList.tsx (new)
- apps/standalone/src/i18n/ru.json, apps/standalone/src/app/shell.css
- apps/standalone/test/floor-shift-list.test.tsx (new), apps/standalone/test/host-link-shifts.test.ts

## Self-review

- The operator is never trapped: «Сменить оператора» is not held by an entry (M15 pins it); one entry at a time via a ref (M3); the answer after unmount is dropped (M4); a refused key goes to the shell (M20).
- A refused entry re-reads the copies (M11), so a shift the host closed or took away disappears.
- Item 6 covers both ways a stored shift can be unusable: host-closed and locally closing/closed; the unconditional first guard on the list copy is also pinned (M8).
- No `any`/casts/`!` in the sources; `import type` used; only `@markiro/ui` components; every button is `size="floor"`.

## Concerns / notes for Tasks 6–7

1. Online path of `enterShift`: after `keepEnteredShift` the copy read back may be `closed` if the answer was behind the stored status (a late answer after an office close); the brief's code (and the controller's decision (a), which names the offline path) return `entered` there. Task 7's work gate should decide what a closed entered shift shows (the minors item already assigns that to it). Not changed here.
2. The refusal `closed` ("Смена закрыта.") is reused for a stored-but-closed shift on the offline path; no new text key was added.
3. Full default-timeout runs are unusable at the current machine load (136); the 83/2339 green result needs `--testTimeout=60000 --hookTimeout=60000`.
4. M22 is equivalent (see table).
