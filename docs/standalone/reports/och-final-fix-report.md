# Plan ОЧ — final fix wave report

Worktree `/tmp/claude/wt/m1`, branch `claude/m1`, base `96209f28b`. Three commits. Commit 4 of the review (the СКЛ merge gate, I-2) is not part of this wave. The plan's «Отклонения при исполнении» are left to the controller.

| Commit      | Subject                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `d0d34a4d1` | feat(standalone): the queue screen takes off a shift's refusals at once and bounds its list                                       |
| `81ee7e297` | fix(standalone): the stock warnings say «или меньше», and the retention keeps a shift for a conflict that lands before the delete |
| `59f495265` | docs(standalone): ОЧ limits measured                                                                                              |

`git status --short` is empty after the last commit. Each message ends with exactly one `Co-Authored-By: Claude Opus 5.5` line.

## 1. I-1: take off a shift's refusals at once, and bound the list (`d0d34a4d1`)

### Module (`src/floor/queue/outbox-recovery.ts`)

- **`DISMISS_SHIFT_SQL` and `dismissShiftRefusals(context, shiftId, expected)`.** One guarded `UPDATE`:

  ```sql
  UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ?
  WHERE host_id = ? AND device_id = ? AND shift_id = ? AND outcome = 'rejected'
  AND kind <> 'shift_closed' AND resolved_at IS NULL
  ```

  - It runs in one transaction and writes the three columns together.
  - It touches only the current pairing's records. The shift's close and conflicts are excluded.
  - `expectedChanges` equals the count the person confirmed. Any other count (a refusal that arrived since, or one resolved meanwhile) writes nothing and raises `StaleQueueError`.
  - `expected < 1` is always a `StaleQueueError`, so "nothing taken off" is never reported as success.
  - Any other database failure passes through unchanged.

- **`QUEUE_LISTED_PER_SHIFT = 20`.** `QUEUE_SETTLED_SQL` is now bounded:
  - A window `row_number() OVER (PARTITION BY shift_id, outcome ORDER BY seq)` runs over the partial index `outbox_settled`.
  - Only rows with `place <= ?` are looked up by `seq` (rowid) and joined. Only those payloads are read.
  - Refusals and conflicts are bounded separately.
- **`QUEUE_TALLY_SQL`** is the separate count read: `GROUP BY shift_id, outcome, kind` over `outbox_settled`.
- **`QueueView`** has a new `tallies` field. `readQueue` documents that the reads are separate statements. If a count no longer holds when someone decides, the result is a `StaleQueueError`.

### Screen (`QueueScreen.tsx`)

- Each shift group lists at most 20 refusals, then «…и ещё N». The conflicts section gets the same «…и ещё N» line, summed per shift.
- **New per-group button «Снять с очереди все отказы смены».** It appears only when the shift has refusals other than its close.
  - The confirmation says: «Снять с очереди все отказы смены N (count), не отправляя? … Вернуть их в очередь будет нельзя …». It adds a kinds line that excludes the close.
  - When the shift's close is refused, the confirmation adds: «Отказанное закрытие смены этим не снимается и останется в очереди: его можно только отправить снова. Если хост не знает эту смену, закрытие он не примет — сообщите администратору.»
  - The confirm button reads «Снять все (N)» and is destructive.
  - The 400 ms guard, Escape/«Отмена», focus handling and the "target gone → stale" behaviour are shared with the existing questions.
- The «Отправить снова» confirmation now takes its count and kinds from the tallies, so it covers all of the shift's refusals, including those not listed.
- A shift is never counted below what it lists. This matters if the count was read before a refusal landed.
- New i18n keys: `dismissShift`, `more`, `confirmDismissShift`, `confirmDismissShiftClose`, `dismissShiftConfirm`, `notice.dismissedShift`.

### Plans pinned in both builds

| Statement           | Pin                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUE_SETTLED_SQL` | Exact 10-step plan, identical on Node 3.53 (`floor-schema.test.ts`) and shell 3.46 (`local_db.rs`). Moved out of the generic loop and pinned exactly, because it has `SCAN (subquery-3)` and `SCAN f`: walks over the numbered rows only. |
| `QUEUE_TALLY_SQL`   | `SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)` + `USE TEMP B-TREE FOR GROUP BY`                                                                                                                     |
| `DISMISS_SHIFT_SQL` | `SEARCH … outbox_settled (…)` only                                                                                                                                                                                                        |

- `QUEUE_TALLY_SQL` and `DISMISS_SHIFT_SQL` are pinned exactly on Node and added to the shell's loop.
- `reads` is now `[_; 99]`.
- The text-agreement test now covers 9 statements.

### Docs

- **Runbook check 5.** The bullet is rewritten as a three-step procedure:
  1. Reconcile the shift's work with the office and enter it by hand.
  2. Use the bulk button. Its confirmation names the shift and the count; it is irreversible; a stale count writes nothing.
  3. What remains is the refused close, one per such shift. It cannot be taken off. Resending it is useless, and the office cannot close the shift because the host does not have it. It holds the shift from the retention and shows «Отклонено хостом: 1». Whether it may be taken off is the owner's decision; the engineer tells the developer how many such shifts there are and on which stations, and does not delete station data.
- **AGENTS «Outbox recovery».**
  - Describes the bounded list.
  - Corrects «the office closes the shift»: true only for a shift the host knows. A close refused `unknown_shift`/`not_entered` stays, and that is an open owner question.
  - New bullet for `dismissShiftRefusals`.
  - The known-limits bullet is corrected to match.
- **Spec §27.** The screen bullet covers the bulk action, the bound and the remaining close.

### Measured on node:sqlite 3.53 (`/tmp/claude/impl-och-fix/bench.mjs`)

| Case                                  | Old list            | New list        | Tally  | Bulk `UPDATE`         |
| ------------------------------------- | ------------------- | --------------- | ------ | --------------------- |
| 50 000 refused, one pairing, 3 shifts | 307 ms, 50 000 rows | 166 ms, 60 rows | 142 ms | 24 ms for 16 667 rows |
| 10 000 refused + 600 000 accepted     | 60 ms               | 46 ms           | 10 ms  | 2.9 ms                |

The bigger gain is not rendering and IPC for thousands of rows on every receipt batch.

## 2. m-5 wording and m-6 test (`81ee7e297`)

- **Stock texts.** All four `ru.json` texts now say «— четверть блока или меньше.» / «— десятая часть блока или меньше.» (boxes and pallets).
  - The tests that pin the wording (`floor-status-bar.test.tsx`: 2 full strings, 4 regexes, the pallet tenth string) are updated.
  - A new data test fails on any old phrasing in any of the four texts. This also covers the pallet quarter, which no test pinned before.
- **Retention race (m-6).** New `retention.test.ts` case: a `conflict` lands between `DUE_SHIFTS_SQL`'s read and the guarded delete, and the shift stays whole while the other shift goes. It kills M18.
- AGENTS and §27: the known-limit bullet about the dishonest wording is removed, and the stock paragraph says the thresholds are inclusive.

## 3. Docs: measured limits (`59f495265`)

- **m-2 (AGENTS «Known limits of the retention», §27).** The final review's numbers:
  - About 0.2 µs per record of a held shift.
  - 131 → 289 ms with all 12 shifts of 50 000 held; 132 → 200 ms with 10 of 300 shifts held; 57 → 117 ms at 300 000 with none held.
  - The base of about 130 ms is ХП's `outbox_settled` walk.
  - The pass runs at start and hourly, on a reader connection, and does not block writes.
  - The covering partial index (160 ms) is deferred to the next shell migration.
- **m-1 (carried).** The receipt's `needs_fix` clearing walks the box's whole shift per marked box (≈10 ms per box, ≈1 s per batch worst case). Added as an AGENTS known limit and to §27 «Не сделано»: add its index with the next shell migration.
- **m-3.** New AGENTS «Known limits» bullet: the queue screen is a fact writer the forget's conditions do not cover, and the only window (a part committed between the clear and the removal of `device.json`) is harmless. Also in §27 «Известные пределы».
- **m-4.** In `watchFailed` mode no pause is armed and attempts count requests again. Added to the AGENTS known limits and the link paragraph, and to §27.
- **m-7.** An older host refuses a part with `more: true` (`deny_unknown_fields`); only stations with more than 64 blocks send it; versions ship together. This replaces the false AGENTS clause «an older host still reads what a new station sends», and a clause is added to §27 «Вернула».
- **m-9.** The `RESEND_CHUNK` comment now says:
  - A part's payloads stay under 1 MiB.
  - The JSON list escapes each payload again and is bound twice.
  - The shell bounds SQL text and the number of values, not the size of one value.

  The chunk test title is corrected to match.

## RED / GREEN evidence

| Run                                                                                                                                          | Result                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| RED: new module tests against the base module (`git show HEAD:…outbox-recovery.ts`, restored, `cmp` ok; `/tmp/claude/impl-och-fix/red1.log`) | 10 failed / 25 passed (35); `dismissShiftRefusals is not a function`, list not bounded, no tallies |
| RED: screen tests against the base screen (restored, `cmp` ok; `red-qs.log`)                                                                 | 10 failed / 34 passed (44), at the time 44 tests; the button-count test plus 9 new ones            |
| RED: status bar with new wording vs old `ru.json` (`red2.log`)                                                                               | 3 failed / 52 passed (55)                                                                          |
| GREEN: `outbox-recovery`                                                                                                                     | 35                                                                                                 |
| GREEN: `floor-queue-screen`                                                                                                                  | 46 (two tests added after the RED run: count race and kind order)                                  |
| GREEN: `floor-status-bar`                                                                                                                    | 56                                                                                                 |
| GREEN: `retention`                                                                                                                           | 48                                                                                                 |
| GREEN: `floor-schema`                                                                                                                        | 37                                                                                                 |

## Mutants

- Every mutant was restored with a sha256 check (`run.py` compares the hash before and after; all "restore ok"). Restored `.rs` files were touched (`os.utime`).
- Logs: `/tmp/claude/impl-och-fix/mut/*.log`. Runner: `run.py`. Specs: `c1.json`, `c1b.json`, `c1rs.json`, `c2.json`.
- Restored hashes: `outbox-recovery.ts` `88ff199c…` (then `ab11581a…` after the guard was simplified), `QueueScreen.tsx` `d0d49c6f…`, `local_db.rs` `9d69a1e9…`, `retention.ts` `df3ac078…`, `ru.json` `1e05fca4…`.

| Mutant       | One-line change                                                  | Killed by                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1           | dismiss-shift pairing guard `OR 1`                               | takes nothing of another pairing… (Stale: 3 changes ≠ 1)                                                                                                                                                                         |
| D2           | drop `kind <> 'shift_closed'`                                    | takes off every refused record… leaves its close                                                                                                                                                                                 |
| D3           | drop `resolved_at IS NULL`                                       | takes nothing … resolved (resent/dismissed rows rewritten)                                                                                                                                                                       |
| D4a          | `outcome IN ('rejected','conflict')`                             | takes nothing … in conflict                                                                                                                                                                                                      |
| D4b          | `(outcome = 'rejected' OR 1)`                                    | same test (waiting/accepted taken)                                                                                                                                                                                               |
| D5           | shift guard `OR 1`                                               | same test (other shift)                                                                                                                                                                                                          |
| D6           | drop `expectedChanges: expected`                                 | writes nothing when the number confirmed no longer holds                                                                                                                                                                         |
| D7           | `if (expected < 1)` → `if (false)`                               | is never a success for nothing                                                                                                                                                                                                   |
| D7b          | `!Number.isInteger(expected) \|\| expected < 1` → `expected < 1` | **survived (equivalent)**: the executor's `expectedChanges` makes 1.5/NaN a mismatch anyway. The guard was simplified to `expected < 1`, the non-integers were dropped from the test, and D7 was re-run on the new guard: killed |
| D8           | swap `resolved_at`/`resolved_by`                                 | exact values in the takes-off test                                                                                                                                                                                               |
| D9           | stale mapping → `throw error`                                    | stale test (LocalDbError instead of StaleQueueError)                                                                                                                                                                             |
| L1           | `f.place <= ?` → `<`                                             | lists the first QUEUE_LISTED_PER_SHIFT…                                                                                                                                                                                          |
| L2           | `PARTITION BY shift_id` only                                     | bounds the refused records and the conflicts each on their own                                                                                                                                                                   |
| L3           | list subquery without `resolved_at IS NULL`                      | counts nothing resolved…                                                                                                                                                                                                         |
| L4           | `QUEUE_LISTED_PER_SHIFT = 21`                                    | screen «…и ещё 6» / 20 buttons                                                                                                                                                                                                   |
| T1           | tally without `resolved_at IS NULL`                              | counts nothing resolved…                                                                                                                                                                                                         |
| T2           | tally pairing `OR 1`                                             | same                                                                                                                                                                                                                             |
| P1 / P2 / P3 | `+host_id` in tally / list / dismiss-shift (TS)                  | `floor-schema` plan pins (and text agreement)                                                                                                                                                                                    |
| R1 / R2 / R3 | `+host_id` in the shell consts                                   | `the_floors_repeating_reads_search_an_index`: R1 the exact list pin, R2 and R3 the loop's index assertion                                                                                                                        |
| S1           | resend count `records.length`                                    | counts every refused record … (26)                                                                                                                                                                                               |
| S2           | bulk button at `dismissible >= 0`                                | offers no taking off at once for a shift whose only refusal is its close                                                                                                                                                         |
| S3a / S3b    | close sentence always / never                                    | says nothing of a close… / takes off every refusal…                                                                                                                                                                              |
| S4           | decide passes `records.length`                                   | takes off every refusal… (Stale with 25)                                                                                                                                                                                         |
| S5           | 400 ms guard exempts `dismissShift`                              | ignores a press on its confirmation for 400 ms                                                                                                                                                                                   |
| S6 / S7      | «и ещё» line off (refusals / conflicts)                          | list tests                                                                                                                                                                                                                       |
| S8           | drop the `Math.max` clamp                                        | never counts a shift below what it lists…                                                                                                                                                                                        |
| S9a / S9b    | kinds alphabetical / unlisted kind first                         | names a shift's kinds in order… / (26) test                                                                                                                                                                                      |
| S10          | target lookup without `dismissible > 0`                          | closes its question when the shift's refusals were taken off meanwhile                                                                                                                                                           |
| S11          | bulk confirm not destructive                                     | takes off every refusal… (class)                                                                                                                                                                                                 |
| S12          | close kept in the bulk kinds line                                | takes off every refusal… («Скан — 25.»)                                                                                                                                                                                          |
| M18          | `DONE_WITH` `r` only `'rejected'`                                | keeps a shift that took a conflict between its reading and its delete                                                                                                                                                            |
| W1–W4        | each stock text back to «меньше …»                               | `floor-status-bar` full-string tests and the new data test                                                                                                                                                                       |

## Gates

| Gate                                                                                                  | Result                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`, `lint`, `build`                                                                          | 0, before each commit and at the end                                                                                                                                                                                                                                                                                  |
| Prettier gate                                                                                         | Run from the worktree root with `--ignore-path`. Proven live: the scratch `zz-scratch-prettier.ts` failed, then was deleted. The first run also caught 3 unformatted files, which were fixed. Docs rewrapped where prettier would break inline code across lines. Final: «All matched files use Prettier code style!» |
| Focused verbose Vitest                                                                                | stderr 0 bytes, 0 `stderr \|`: commit 1 files 118 passed; commit 2 files 104; commit 3 file 35                                                                                                                                                                                                                        |
| Delayed-`setImmediate` stand (config and setup in `/tmp/claude/impl-och-fix/stand`, outside the tree) | `floor-queue-screen` + `outbox-recovery`: 81 passed twice; `floor-status-bar`: 56 passed twice; 0 `stderr \|`                                                                                                                                                                                                         |
| Full Vitest (`--testTimeout=60000 --hookTimeout=60000`)                                               | 152 files, 4745 passed, 0 failed (also 4743 before commit 1's test edits)                                                                                                                                                                                                                                             |
| `cargo fmt --check`                                                                                   | 0                                                                                                                                                                                                                                                                                                                     |
| `cargo check -p markiro-standalone --tests`                                                           | 0, 0 warnings                                                                                                                                                                                                                                                                                                         |
| Focused `--test local_db` (unsandboxed)                                                               | 32 passed                                                                                                                                                                                                                                                                                                             |
| Final full `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed, once)             | exit 0; 71 suites, 1134 passed, 0 failed, 0 ignored                                                                                                                                                                                                                                                                   |
| Parity tests                                                                                          | `floor-schema` (Node 3.53) 37 passed; `local_db` `the_floors_repeating_reads_search_an_index` (shell 3.46) passed; both plans identical                                                                                                                                                                               |
| `git diff --check`                                                                                    | clean                                                                                                                                                                                                                                                                                                                 |
| `grep -rnF '\u04'` over `src`/`test`                                                                  | only `src/host/pairing-code.ts:66`                                                                                                                                                                                                                                                                                    |
| Final `git status --short`                                                                            | empty                                                                                                                                                                                                                                                                                                                 |

## Anchor adaptations

None needed. The review's sketch had the bulk count derived from the listed records. Because the list is bounded, the count and the kinds come from the separate tally read, and the decision passes the tally count as `expectedChanges`.

## Self-review and concerns

- **Bulk scope.** The bulk action covers refusals only (`outcome = 'rejected'`), as the brief says ("the shift's REFUSED records"). Conflicts are still settled one by one. Mass conflicts after a restore are not the I-1 scenario.
- **The refused close.** A close refused `unknown_shift`/`not_entered` for a shift the restored host does not know still cannot be removed. Whether it may be taken off is an owner decision (the review's CARRY). The docs now say so instead of promising the office closes it.
- **List and counts are separate reads**, as the brief asks, so they are not one snapshot. A receipt between them is handled: never counted below what is listed, «и ещё» clamped at 0, and a decision on a stale count is `StaleQueueError` with a re-read.
- **Cost of the new reads.** The bounded list still sorts all of the pairing's unresolved refused and conflicting records once per read (166 ms at 50 000 on node:sqlite). That is human-scale and the list shrinks after a bulk take-off. No new index was added (no shell migration before the beta).
- **m-11 not folded in.** Many buttons still share the name «Снять с очереди» (no `aria-describedby`); it stays carried.
- **Not run.** Windows, WebView2, a real touch panel, a real restored host refusing a whole shift, and the bulk take-off on hardware. `graphify update` was not run (untracked graph).
