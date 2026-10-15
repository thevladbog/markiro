# plan 2a6 Task 7 report: the floor's status bar (outbox counts, serials left, delivery failure)

Status: DONE_WITH_CONCERNS. Commit `02c68e8ab feat(standalone): the status bar counts the outbox and the serials left` (on 3ff974da9, branch claude/2a6-scanning, worktree /tmp/claude/wt/2a6). `git status --short` is empty after the commit; exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## What was done

- `src/floor/outbox-status.ts` (new)
  - `readOutboxStatus`: THREE separate counts (addendum 1), each statement exported (`UNSENT_COUNT_SQL`, `REJECTED_COUNT_SQL`, `CONFLICT_COUNT_SQL`, text `SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? AND acked_at IS NULL` / `... AND outcome = 'rejected'` / `... 'conflict'`), run with `Promise.all`.
  - `readDeliveryStuck` (N19): the oldest undelivered record (`HEAD_RECORD_SQL`: `... AND acked_at IS NULL ORDER BY seq LIMIT 1`, the one the sender retries first): `waitedMs` (now - `created_at`, never negative), `attempts`, `sinceLastAttemptMs` (from `sent_at`, `null` if never sent). Unparseable `created_at`/`sent_at` reject the read (the bar then omits the line).
  - `waitUnits(ms)`: the two largest units, rounded down (`2 ч 5 мин`, `1 сут 3 ч`, `7 мин`), empty under a minute.
  - `readSerialsLeft` (`SHIFT_PREFIX_SQL`: snapshot `issuerPrefix` of this pairing's shift copy; `null` for no copy/no snapshot) -> `remainingSerials`. `SERIALS_LOW = 100`.
- `src/floor/work/block-supply.ts` (Task 5 file, changed on purpose; see "Data attention"): `remainingSerials` now counts exactly as the box close takes serials.
- `src/floor/FloorStatusBar.tsx`: props `outboxVersion`, `factsFailure`, optional `now`; items «Номеров SSCC», «Не отправлено» (always when readable), «Отклонено хостом» / «Конфликтов» (only > 0); warnings in the EXISTING always-mounted polite region (`.floor-status__alerts`), every `Alert` with `role="presentation"` (heard once, no `alert` role): `factsHost`, `factsLocal` (not while `refusalHeld`), the stuck line (any failure kind incl. `offline`, not while `refusalHeld`), `serialsLow` (1..100 left, warn) and `serialsNone` (0, error). A 10 s timer (`REFRESH_MS`) re-reads the head record and the serials while a send fails or the serials are running out (cleaned on unmount / when the reason ends).
- `src/app/App.tsx`: passes `state.outboxVersion`, `state.factsFailure`. `src/i18n/ru.json`: keys `serials, unsent, rejected, conflicts, serialsLow, serialsNone, factsHost, factsLocal, stuck, stuckLast, wait.{none,minute,hour,day}`.
- Query-plan lists (addendum 5/27), BOTH: Node `test/floor-schema.test.ts` takes the bar's statements from the modules (a changed statement changes the plan under test) and asserts no `SCAN`/`TEMP B-TREE` for any of the six; a new parity test requires each of the six texts verbatim in `src-tauri/tests/local_db.rs` (line continuations folded). Shell `tests/local_db.rs::the_floors_repeating_reads_search_an_index`: 27 -> 29 entries (counts re-texted `AS n`, head record, shift prefix lookup added, the old `sum(...)` blocks entry replaced by the new blocks read).

## Anchor adaptations (brief -> real tree)

1. Brief's single `count(*) FILTER` query replaced by the three counts (addendum 1); `FloorStatusBar` second `<div aria-live="polite">` of the brief NOT added: the 2a5 bar already has the always-mounted polite region and a test pins that warnings sit in a region that was there before; mine go into it, with `role="presentation"` (the brief's alerts had no role override).
2. Brief's `remainingSerials` consumer (`sum(to_serial + 1 - next_serial)`) was too coarse; replaced (below). The Task 5 test list entry and the shell list entry for that statement were re-texted.
3. Existing test `names no shift of a pairing other than its own` (floor-status-bar) counted `FROM floor_shifts` reads == 1; the bar now also reads the prefix of the shift (same table), so it waits for 2 reads. This also happens with the brief's own code.
4. Testing-library's default text matcher collapses the non-breaking space inside `getByText` strings (`1 234`), while `textContent` assertions (`shown()`) keep ` `; tests use each accordingly.
5. All other fragments of the brief matched/applied by meaning (App fragment, i18n keys, FloorStatusBar props), list above.

## Data attention: the serials left

`remainingSerials(local, pairing, issuerPrefix, extension = 0)` now: reads `BLOCKS_WITH_ROOM_SQL` (this pairing, prefix and extension, `next_serial <= to_serial`, as `closeOpenBox` selects blocks), clamps each block to the prefix's last serial (`ssccSerialCapacity(prefix) - 1`: a serial past it makes `buildSscc` throw SSCC_RANGE and is lost, never used by a box), sorts by cursor, and counts the UNION of the spans (a serial covered by two kept blocks is counted once; the host never makes that state and `sharesSerials` refuses it, but a restored host could, and a box carries a serial once). Never counts another pairing's blocks, another prefix, the pallet extension, used-up blocks (cursor = `to + 1`). Not knowable from the table: SSCCs a former pairing's box already holds (`floor_boxes_sscc`); the close spends those serials, the bar counts them.

Warning threshold: `SERIALS_LOW = 100` (warn at 1..100 left, error text at 0; 101 is silent). Rationale: the half rule asks for a block when the newest has < half left, so <= 100 means the request did not land (link down, host slow, host exhausted); one box = one serial. This is my choice, not the plan's: one constant, pinned by boundary tests (101/100/1/0).

N19: age = oldest undelivered record's `created_at` (`sent_at` is overwritten on every attempt, so the first failure time is not stored); `attempts` and the last attempt (relative) are shown; no quarantine anywhere.

## RED -> GREEN

The implementation was written before the tests (order slip); RED was therefore produced afterwards by restoring the pre-task sources (`git show HEAD:...` for FloorStatusBar, App, ru.json, block-supply; outbox-status.ts moved away) and running the new test file, then restoring byte-identically (`cmp` silent): `/tmp/claude/impl-2a6-t7/red.txt`: `Tests 17 failed | 20 passed (37)` (the 17 new tests all fail, the 20 old pass). GREEN: `floor-status-bar` 39 passed (20 old + 19 new; the later two tests were added after mutant survivors).

## Final checks

| check                                                                                                                                        | result                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| new/changed files, `--reporter=verbose --testTimeout=60000` (floor-status-bar, floor-outbox-status, floor-block-supply, floor-schema, app)   | 5 files, 251 passed; `stderr                                                                                                                                                       | `count 0, no unhandled, no`act(` |
| delayed-`setImmediate` stand, twice (floor-status-bar, app, floor-outbox-status)                                                             | 3 files, 166 passed, both runs; the first stand run found a real race in my timer-count assertions (effect not yet run); fixed with a `flushEffects()` helper; stand files removed |
| full `vitest run --testTimeout=60000`                                                                                                        | **98 files, 2931 tests passed** (before: 97/2895; brief expects 94/2305 -> 94/2305+4 on the plan copy; the real tree differs)                                                      |
| full `vitest run` at default 5 s (load average ~63)                                                                                          | 96 files pass, 2 fail: 6 tests that time out at 5000 ms in UNTOUCHED `shifts-page.test.tsx` and `template-editor.test.tsx`, the same family as in Task 6; green at 60 s            |
| `typecheck`, `lint`, `build` (standalone)                                                                                                    | exit 0                                                                                                                                                                             |
| `cargo test --offline --locked ... -p markiro-standalone --test local_db` (unsandboxed)                                                      | 27 passed (includes the 29-entry plan list on SQLite 3.46)                                                                                                                         |
| `... --test ipc`                                                                                                                             | 26 passed                                                                                                                                                                          |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                      | clean                                                                                                                                                                              |
| prettier gate (`--ignore-path <root>/.prettierignore --check`, 10 repo-relative paths run through `bash -c` because zsh does not split `$F`) | "All matched files use Prettier code style!"; live proof: scratch `export const   x =  1` -> `[warn]`, exit 1 (file removed)                                                       |
| `git diff --check`; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`; `\u0` in local_db.rs                                        | clean; only `src/host/pairing-code.ts:66`                                                                                                                                          |

Counts as the brief states vs measured: brief `floor-status-bar` 17 tests after (14 + 3); real tree had 20 before, now 39; new file `floor-outbox-status.test.ts` 12 tests; `floor-block-supply` +2; `app.test` +2; `floor-schema` +1.

## Mutants (harness `/tmp/claude/impl-2a6-t7/mut.py`; originals under `/tmp/claude/impl-2a6-t7/orig/`; after each: `cmp` against the copy and `shasum -a 256` equal, "restored True" in every log line `/tmp/claude/impl-2a6-t7/mut-log.txt`)

Files: O = floor-outbox-status.test.ts, S = floor-status-bar.test.tsx, B = floor-block-supply.test.ts, P = floor-schema.test.ts, A = app.test.tsx.

`outbox-status.ts`

| id                  | mutant                                                                                                      | killed by                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| U1                  | unsent count `acked_at IS NOT NULL`                                                                         | O "count a pairing's records ..."                              |
| U2 / U3             | rejected count filters `'conflict'` / conflict count filters `'rejected'`                                   | same                                                           |
| U4 / U5 / U5b / U5c | host `<>` in unsent; device `<>` in rejected / conflict; host `<>` in conflict                              | same                                                           |
| U8 / U8b            | head `ORDER BY seq DESC` / `ORDER BY created_at`                                                            | O "is read from the oldest record not delivered ..."           |
| U9 / U10 / U10b     | head: acked filter dropped; device `<>`; host `<>`                                                          | same                                                           |
| U11                 | wait from `sent_at`                                                                                         | same                                                           |
| U12                 | no `Math.max(0, ...)`                                                                                       | O "is nothing when no record waits, and never a negative wait" |
| U13                 | never-sent -> 0 instead of null                                                                             | O "has no last attempt for a record that was never sent"       |
| U14                 | attempts + 1                                                                                                | O head test                                                    |
| U15                 | no instant validation                                                                                       | O "is not read from a time it cannot understand"               |
| U16, b-f            | `days > 1`; `hours > 1`; filter `>= 0`; hours without `% DAY`; minutes without `% HOUR`; minute = 60 001 ms | O "is written as the two largest units ..."                    |
| U17 / U18 / U18b    | shift prefix: `id <>`; device `<>`; host `<>`                                                               | O "are those of the shift's own issuer prefix and pairing"     |
| U19                 | prefix hard-coded                                                                                           | same                                                           |
| U20                 | null prefix not checked                                                                                     | O "are not known for a shift without a snapshot"               |
| U21a / U21b         | `SERIALS_LOW` 101 / 99                                                                                      | S "warns, in the polite region ..., and says so at zero"       |

`block-supply.ts` (`remainingSerials`)

| id           | mutant                                                              | killed by                                                           |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| B1           | no clamp to the last serial                                         | B "counts no serial past the prefix's last one"                     |
| B6           | clamp at `capacity` instead of `capacity - 1`                       | same                                                                |
| B4           | overlap `continue` dropped                                          | B "..." / overlap test                                              |
| B3 / B9 / B5 | `from = span.from` (double count) / `counted = span.from` / no sort | B "counts a serial that two kept blocks cover once, whatever order" |
| B10          | `to - from` (off by one)                                            | B "asks for a block when it has none ..."                           |
| B7, b, c, d  | extension / device / host / prefix `<>` in the SQL                  | B existing supply tests                                             |

`FloorStatusBar.tsx` / `App.tsx`

| id                         | mutant                                                                                                | killed by                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| F1 / F2 / F2b / F29 / F28a | `outboxVersion` out of the deps of counts / serials / stuck; `tick` out of serials deps / stuck deps  | S counts, serials, "starts no timer ...", "says how long ...", "reads the oldest record again by itself"              |
| F3                         | serials of a former shift not dropped                                                                 | S "shows the serials left ... and none outside it"                                                                    |
| F4 / F5 / F6               | rejected / conflicts shown at 0 (`>= 0`); unsent hidden at 0                                          | S counts, serials                                                                                                     |
| F7 / F8 / F9               | `cancelled` guard dropped in counts / serials / stuck effects                                         | S "keeps the ... of the newest read when an older one lands late" (x3)                                                |
| F10 / F11 / F12            | failed read does not clear counts / serials / stuck                                                   | S "forgets the counts ...", "leaves the serials out ...", "forgets the wait ..."                                      |
| F13                        | stuck not reset when the failure ends                                                                 | S "says it for a failure of the link, ..."                                                                            |
| F14a / b / c               | timer only for failures / only for low serials / always                                               | S "starts no timer ...", "reads the oldest record again ..."                                                          |
| F15a / b                   | `REFRESH_MS` 5 000 / 20 000                                                                           | S "reads the oldest record again by itself every ten seconds" (9.0 s / 10.5 s steps)                                  |
| F16                        | `clearInterval` dropped                                                                               | same + unmount assertions                                                                                             |
| F17a / b / c               | host / local / stuck shown while `refusalHeld`                                                        | S "does not say the host fails the delivery, or that the link is up, while the host's refusal waits"                  |
| F18a / b                   | `offline` shown as host failure / `offline` shown as local                                            | S "says in the polite region when the host or this computer, not the link, fails ..."                                 |
| F19a / b / c / d           | zero shows the low text too; low text at 101; `<` for `<=` in the warning; `<` in the timer condition | S "warns ... at zero", "keeps reading the serials by itself exactly while the warning stands"                         |
| F20a-e                     | `role="presentation"` dropped on stuck / serialsNone / factsHost / serialsLow / factsLocal            | S (`heardOnce`: in the region that was there before AND no `alert` role)                                              |
| F24a-e                     | `formatQuantity` -> `String` for unsent / rejected / conflicts / serials / attempts                   | S "shows every count with the thousands separator", serials test, stuck test                                          |
| F25 / F26 / F27 / F30      | stuck/stuckLast swapped; "less than a minute" branch; unit join `""`; `now` replaced by epoch         | S "says how long ..."                                                                                                 |
| A1 / A2                    | App passes `outboxVersion={0}` / `factsFailure={null}`                                                | A "shows the floor's status bar what waits ..." / "tells the floor's status bar when the host fails the delivery ..." |

Query-plan / parity mutants (P): P1 `+acked_at` in the unsent count (plan SCAN), P2 head `ORDER BY created_at` (TEMP B-TREE), P3 `+id` in the shift prefix, P4 `+issuer_prefix` in the blocks read: all fail "serve the reads the floor makes from an index". P5/P6/P7: changing the text of the unsent count / head record / blocks statement in `local_db.rs` fails "are pinned on the shell's SQLite with the status bar's own statements". Shell list: expected index of the head entry changed to `outbox_unsentX` -> `the_floors_repeating_reads_search_an_index` FAILED ("should search outbox_unsentX ... its plan is [SEARCH outbox USING INDEX outbox_unsent ...]"), file restored (cmp + shasum equal).

Survivors / equivalents, with the fix applied where it was a test gap:

- `.filter(span.from <= span.to)` in `remainingSerials` survived: redundant with the `continue` guard (a span clamped below its cursor is skipped by `span.to < from`). Removed from the code.
- `{ n: formatQuantity(serialsLeft) }` in the low warning survived: n <= 100 never has a separator. Simplified to `{ n: serialsLeft }`.
- `AND next_serial <= to_serial + 1` (B8, SQL clause loosened) survives: equivalent, because a block with cursor = `to + 1` yields an empty span; the clause stays as in the box close's select and is pinned by the plan lists.
- F19d first survived (the timer count was asserted inside `waitFor`, whose own polling is a timer): test rewritten to read the count after an effect flush; now killed.

## Self-review

- Tenant/pairing: every read is keyed by `host_id` + `device_id` (counts, head, prefix, blocks); cross-pairing denial tested at the unit level (other device and other host with the same record shape) and for blocks.
- Offline-first: nothing here writes; reads are indexed (no scan), run once per outbox change and every 10 s only while something is wrong. A failed read hides the figure, never the floor.
- The bar never calls the link «На связи» while a refusal is held: the 2a5 branch (`status` forced `offline`) stays; additionally the delivery warnings are not shown while `refusalHeld`.
- No quarantine, no skipping of a record anywhere (N19).

## Concerns

1. **Task 8 obligation (mandatory addendum candidate): a stored SSCC block does not bump `outboxVersion`.** The bar re-reads the serials on every outbox change (a scan, a close, a receipt) and, while a warning stands, every 10 s by itself, so a false «Номера SSCC закончились» heals within 10 s even if nothing else writes. Task 8's work screen should still dispatch `outbox_changed` after `topUp` returns `stored` so the healthy figure updates at once.
2. The warning threshold 100 and the wording of `serialsLow`/`serialsNone`/`stuck` are mine (owner may tune; one constant and four ru.json strings).
3. "How long delivery has been stuck" is the age of the oldest undelivered record, not the time since the first failed send (not stored). After a long offline stretch it can read «2 ч» right after the link returns and the host answers 500; the line says what it measures («Самая старая запись ждёт отправки уже ...»).
4. `remainingSerials` is a Task 5 function; I changed its SQL, so the Task 5 test list entry (`floor-block-supply.test.ts`, the `startsWith` statement) and the shell list entry changed too. Behaviour for every earlier case is unchanged (all Task 5 tests pass).
5. N21 (rejected receipts flag nothing on the floor) is unchanged: the bar shows the count «Отклонено хостом» only.
6. Machine load ~63: the 5 s default run times out in untouched office tests (`shifts-page`, `template-editor`), as in Task 6; green at 60 s. Timer tests keep a 1 s margin to the 10 s tick (repo rule: >= 800 ms) with real time advancing the fake clock.
7. Not verified: a real shell/Windows host; the production-browser suites; every host call and the SQLite 3.46 plan exercised only through the shell's Rust test.
