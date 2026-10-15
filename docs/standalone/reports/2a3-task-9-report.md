# Plan 2a3, Task 9 — report («Итоги смены», `totals` in every OfficeShift)

Worktree `/tmp/claude/wt/integ`, branch `claude/integration`, base `24460a280`. Commit: **`1095d4af4`** feat(standalone): a shift's figures in the office — totals in every shift, the output column, the «Итоги» window. One trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git status --short` empty after the commit. No push, no stash, no cd, cargo not run.

Status: DONE_WITH_CONCERNS (concerns at the end are minor).

## What was done

All 14 step-3 edits, 18 step-1 items, step-6 documents applied by a script that parses the brief and requires every anchor to match exactly once (script and logs under `/tmp/claude/impl-2a3-t9/`). Every anchor matched exactly once; **Anchor adaptations: none.**

Step 0: `ShiftTotals` in `proto/src/lib.rs` has exactly the six fields; `proto/fixtures/office-shift.json` carries `totals` 547 / 540 / 45 / 1 / `2026-10-08T09:41:07Z` / one UUID. Running `-t "office-shift.json"` before the task: FAIL «response fixture office-shift.json > parses without losing a field» (`expected { …(21) } to deeply equal { …(22) }`), as the brief says.

## RED (step 2)

The 7 files with step-1 tests only (`red.txt`): 18 failed | 421 passed (439). The brief's 15 are all there (8 in shift-totals, 1 in shift-edit, 2 in shifts-page, 2 in protocol, 2 in api). 3 more failures were timeouts of other shifts-page tests ("Test timed out in 5000ms": refuses a period; pager 24/25/26/51; back to first page) at machine load average 60-90; not related to the task, passed in GREEN.

## GREEN (step 4)

- `--reporter=verbose --testTimeout=60000`, 7 files: 7 passed, 439 passed (brief's tests); stderr file empty (0 bytes), no `stderr` blocks, no `act(...)` warnings.
- After my extra tests: 7 files, **445 passed**, verbose, stderr empty (0 bytes), 0 `stderr` blocks (`green2.txt`, `green2.err`).
- Delayed-`setImmediate` stand (3 ms; both stand files created, run, removed; `git status` clean): 7 files, 439 passed with the brief's tests, 445 passed with the extra ones (`delay.txt`, `delay2.txt`).
- Machine load average 60–128 during the work. The default 5 s Vitest timeout was therefore not used for iteration: runs used `--testTimeout=60000` (the code and the tests in the repo are not changed for timeouts).

## Full Vitest

- Plan: before the task 80 files / 2251 tests (one red by design), after 81 files / 2263 tests.
- Measured full `pnpm … test` run (default timeouts): **81 files / 2269 tests**; 2264 passed, 5 failed, all five are `test/template-editor.test.tsx` "Test timed out in 5000ms" at load average ~120 (a file that this task does not touch). `template-editor.test.tsx` alone, default timeout: 95 passed / 2 failed (the same kind of timeout; load 116); alone with `--testTimeout=60000`: **97 passed / 97**. So 2269 tests all pass when the timeouts are not the load. 2269 = 2251 + 12 (plan) + 6 (mine: 5 new tests in `shift-totals.test.tsx` — 13 there instead of 8 — and 1 in `protocol.test.ts`). Files: 81 as planned.

## Other checks

- `prettier --check` on every changed/new TS/TSX/JSON/MD (the list of the brief): clean. `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- `typecheck`: exit 0. `lint`: exit 0 (no output beyond the command line). `build`: exit 0; main chunk `index-MUQuMAxf.js` 950.94 kB (plan said "about 943 kB" before this task's additions; not a failure).
- Not run: cargo (not touched), WebView2/WKWebView, a live host with real facts, `Intl` of WebView2.

## Mutants

Procedure per mutant: copy of the file under `/tmp/claude/impl-2a3-t9/m<ID>/before`, `shasum -a 256` before/after, one-line edit, vitest run, `cp` back, `cmp` (silent), `shasum` again. Every row below printed `restored_cmp=True` and equal `sha_before`/`sha_after` (first 12 hex shown by `mut.py`; the logs `brief_mut.log`, `extra_mut.log`, `surv_mut.log`, `surv2_mut.log` have them). `X` = against the brief's tests, `S` = the same mutant re-run against the strengthened tests.

### The brief's mutants 1–10 (all killed as the brief predicts)

| #                 | mutant                                                                                                                                         | killed by                                                                  | key line                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1                 | `getShift` path `/v1/office/shifts?id=`                                                                                                        | api.test «getShift sends the office token to the right route»              | `expected [ { method: 'GET', …(3) } ] to deeply equal …`                       |
| 2                 | `unitsInClosedBoxes` without `.nonnegative()`                                                                                                  | protocol «read a shift's figures…»                                         | `unitsInClosedBoxes: -1: expected true to be false`                            |
| 3                 | «Выпуск» uses `acceptedUnits`                                                                                                                  | shifts-page «shows what an active and a closed shift put in closed boxes…» | `expected '547 шт · 45 кор.' to be '540 шт · 45 кор.'`                         |
| 4                 | totals button only for `active`                                                                                                                | shift-totals «offers the figures of an active and a closed shift…»         | cannot find button «Итоги смены OCT26-001/S»                                   |
| 5                 | no `timeZone` in the formatter                                                                                                                 | shift-totals «reads the shift when the dialog opens…»                      | deep-equal of the figures differs                                              |
| 6                 | zone not frozen (`useState` → plain array)                                                                                                     | shift-totals «keeps the time in the organization's zone…»                  | `expected '08.10.2026, 12:41' to be '08.10.2026, 21:41'`                       |
| 7                 | revoked device not marked (`!== "never"`)                                                                                                      | shift-totals «reads the shift when the dialog opens…»                      | deep-equal differs (devices row)                                               |
| 8                 | `enabled: true` on listDevices                                                                                                                 | shift-totals «shows a technologist the devices…»                           | `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| 9                 | no `devices.isError` note                                                                                                                      | shift-totals «…list of devices does not load…»                             | cannot find «Список устройств не загрузился…»                                  |
| 10                | unknown zone called «не загрузился»                                                                                                            | shift-totals «writes the time by this PC's clock…»                         | cannot find «Этот ПК не знает часовой пояс организации…»                       |
| 11 (brief's note) | `staleTime: Infinity` on the detail call (my first try put it on the devices query — wrong target, passes, as expected; the correct one is X1) | —                                                                          |                                                                                |

### Mutants beyond the brief

Killed by the brief's tests already: X1 (`staleTime: Infinity` on the detail `useOfficeQuery`) → shift-totals «offers to read the figures again…and reads them anew at every opening»; X9 (`onRetry` does nothing) → same test; X10 (`slice(0,7)`) → three shift-totals tests; X11 (`plannedQty ?? 0`) → «says when no fact has arrived…»; X17 (no `isKnownTimeZone`) → «writes the time by this PC's clock…»; X21 (`role !== "admin"`) → three tests; X13 (list shows «—» for non-closed), X14/X14b (`String` instead of the thousands format in the list), X14c (`openBoxes` instead of `closedBoxes`) → shifts-page «shows what an active and a closed shift put in closed boxes…»; X18 (`lastFactAt` `.nullish()`), X19 (`totals` `.optional()`), X20 (`deviceIds` `z.array(z.string())`) → protocol «read a shift's figures…» (X19 also api «returns one shift with its figures…»).

**Survived the brief's tests (finding), killed after strengthening** — tests added beyond the brief:

| mutant                                                                                                                     | new test (shift-totals.test.tsx unless said)                                                                                                                                               | key line after                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| X2 `officeKeys.shift` without the id                                                                                       | «shows no figures of the shift opened before while its own are read» (opens the active shift, closes, opens the closed one whose read is held back: no terms of the other shift must show) | S2 FAIL                                                                                                         |
| X3 drop `org.isPending` from the loading gate                                                                              | «shows only the loading until the profile and the list of devices have both answered, whichever is first» (both orders, held-back promises)                                                | S3 first run still passed (the devices wait covered it in one order) → test rewritten to both orders → S3b FAIL |
| X4 drop `isAdmin && devices.isPending`                                                                                     | same test                                                                                                                                                                                  | S4 / S4b FAIL                                                                                                   |
| (extra) `devices.isPending` without `isAdmin` (a technologist's disabled query stays pending forever)                      | brief's technologist test and the «adds no note…» test                                                                                                                                     | S9 FAIL (2 tests)                                                                                               |
| X5 time note shown when no fact has arrived                                                                                | «adds no note about the time or the devices to a shift that has none»                                                                                                                      | S5 FAIL                                                                                                         |
| X6 devices note shown for a shift with no devices                                                                          | same test                                                                                                                                                                                  | S6 FAIL                                                                                                         |
| X7a–d `String(…)` instead of the thousands format for accepted / in closed boxes / closed boxes / open boxes in the dialog | «writes every count with its thousands apart» (12 010 / 12 000 / 1 000 / 1 100 with no-break spaces)                                                                                       | S7a–d FAIL                                                                                                      |
| X8 footer «Закрыть» button without `onClose`                                                                               | «closes from its own button as well as from the cross»                                                                                                                                     | S8 FAIL                                                                                                         |
| X16 `shiftTotalsSchema` as `z.strictObject` (a newer host's extra figure would fail every list)                            | protocol «tolerate a figure a newer host adds to a shift's figures»                                                                                                                        | S16 FAIL                                                                                                        |
| T1 only the zone frozen, the note not                                                                                      | brief's «keeps the time in the organization's zone…» (assertion that no «по часам этого ПК» note appears)                                                                                  | T1 FAIL                                                                                                         |

**Not killable (equivalent):** X12a/X12b, dropping `canPlan &&` from the write buttons in the actions column. The role table (`src/office/access.ts`, `planShifts: ["admin", "technologist"]`) has only these two roles, so `canPlan` is always true in this build; no test can observe the guard. It is the same guard as before the task (kept as the brief says). Likewise `devices={isAdmin ? devices.data : undefined}` is equivalent to `devices.data` (a disabled query has no data).

Cosmetic `mono`/`align: "right"` on the «Выпуск» column are not asserted (no one-line behavioural mutant; would need class assertions).

## Files changed (commit `1095d4af4`, 17 files, +835/-42)

`apps/standalone/src/host/protocol.ts`, `src/host/api.ts`, `src/i18n/ru.json`, `src/office/office-query.ts`, `src/office/shifts/ShiftsPage.tsx`, new `src/office/shifts/ShiftTotalsDialog.tsx`; tests `test/api.test.ts`, `protocol.test.ts`, `shift-delete-close.test.tsx`, `shift-dialog.test.tsx`, `shift-edit.test.tsx`, `shifts-page.test.tsx`, `support/office.tsx`, `support/shifts.ts`, new `test/shift-totals.test.tsx`; docs `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`.

## Self-review

- Brief followed verbatim; the only additions are tests (5 in `shift-totals.test.tsx`, 1 in `protocol.test.ts`), no source changes beyond the brief.
- Decision (c): the «Выпуск» column placed after «Статус», as the brief says.
- `git diff` of the brief's own test code untouched; my 5 tests are appended to the end of `shift-totals.test.tsx` (prettier clean).

## Concerns

1. The test «keeps the time in the organization's zone while the dialog is open, though the profile read again fails» (the brief's) depends on the order of two settled promises: `getShift` (resolved) must be seen before the cached profile's refetch rejects (`retry: false` in the test client). It passed in every run here (including the 3 ms stand), but it is a latent order dependency; the same holds for the real behaviour: if the profile's refetch fails before the figures arrive, the dialog shows the PC's time with a note, not the organization's. Not changed (the freeze happens at first display, as the plan says).
2. The full default-timeout run failed 5 `template-editor.test.tsx` tests by the 5 s limit at load ~120 on this machine (they pass alone with `--testTimeout=60000`: 97/97); not task-related. Timeouts not raised in the repo.
3. `canPlan &&` guards are unobservable with the current two-role table (see equivalent mutants).
4. Main chunk is 950.9 kB (the plan's figure of ~943 kB predates this task); lazy loading of office pages remains the plan's carried item.
5. Not verified: WebView2/WKWebView rendering of the table with the new column, a live host with real facts (totals subqueries, host `lastFactAt`), WebView2's `Intl` for «08.10.2026, 21:41» and the no-break space (taken from Node's ICU).
