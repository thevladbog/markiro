# 2a8 FINAL whole-part review: the floor's exceptions and the shift's close

Branch `claude/floor-2a7`, worktree `/tmp/claude/wt/flr`. HEAD `d43cec932`, base `0ffeb4f58` (end of 2a7), 14 commits, 38 files, +10 129 / −250.

## Verdict

**WITH FIXES.** Critical 0, Important 1, Minor 10 (2 of them DROP).

The part holds as one piece:

- Every close and exception write is a queued, tracked job (N9/N13).
- `shift_closed` is always the shift's last record: one guard in `outboxStatement`, pinned for the host and device scope.
- The receipt moves `closing` to `closed` inside the existing receipt transaction.
- The office's close no longer strands a box or a label.
- Retention deletes only whole shifts whose close the host accepted 30 days ago, re-checks that inside its own write, and never touches another pairing or the SSCC blocks.
- The host replays the station's fixture and ends with the station's numbers.

The replaced `DUE_SHIFTS_SQL` (`c765f9890`) is equivalent to the old guards. Its plans are pinned on both SQLite builds; I re-ran the shell pin myself.

The single Important is documentation that now lies about what retention deletes. `AGENTS.md` and spec §22 say a shift the office closed is never purged. In fact, once the station finishes it («Завершить»), its close is answered `accepted` + `alreadyClosed`, the copy becomes `closed`, and retention purges it 30 days later. Separately, the `sendFactBatch` JSDoc still says "a record is never deleted".

The other findings are rare double-failure paths on the close summary, coverage gaps (the outbox guard for a `closed` shift survives every close test), and stale comments.

---

## (a) Findings, most severe first

### Important

**I1. The documents misstate what retention deletes (a document that now lies; FIX, doc plus one test)**

- **Where:**
  - `apps/standalone/AGENTS.md:3219-3221` (new «Floor exceptions and close»): «Only an ACCEPTED close starts the clock: a refused close, and a shift the office closed, are never purged here.»
  - Spec `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md:1569-1570` (§22): «Смена, закрытая офисом, и отклонённое закрытие срок хранения не запускают.»
  - `apps/standalone/src/local/facts-sender.ts:143`: «A record is never deleted, and one with a receipt never goes again.»
- **What the code does:**
  - `retention.ts:36-42` (JSDoc: "`alreadyClosed` too") and `DUE_SHIFTS_SQL`/`DONE_WITH` test `kind = 'shift_closed' AND outcome = 'accepted'`, never `outcome_details`.
  - The receipt operator (`facts-sender.ts:117-124`) makes an `alreadyClosed` close `closed`.
  - So a shift the office closed, which the station finished, is purged 30 days after the receipt. That is the intended ВП1 А outcome: the plan's own text says retention removes its records later.
  - Only a shift the office closed that the station never closes stays forever.
  - Since Task 7, outbox rows ARE deleted, by retention.
- **Why Important:** these sentences describe data deletion, and plans ОЧ and РК-С will build on exactly them: what stays on the station, and what can still be resent.
- **No test pins the finished office-closed case:** `test/retention.test.ts` has no `alreadyClosed` receipt.
- **Fix:**
  - AGENTS: «…a refused close, and a shift the office closed that this station has not closed itself, are never purged here; one the station finished («Завершить», answered `alreadyClosed`) is purged like any other.»
  - Spec §22: the same in Russian.
  - `facts-sender.ts:143`: «The sender never deletes a record (retention does, 30 days after its shift's accepted close, `src/local/retention.ts`), and one with a receipt never goes again.»
  - Add one retention test: an accepted `shift_closed` with `outcome_details = {"alreadyClosed":true}` is due and purged.

### Minor

**m1. The outbox guard is unpinned for a `closed` shift (FIX, test)**

- **Where:** `facts.ts:102`, `… AND local_state IS NOT NULL)`.
- **Mutant F1:** `IS NOT NULL` → `= 'closing'` SURVIVES `floor-shift-close`, `floor-facts`, `facts-sender`, `floor-work-close`, `floor-scenario` and `floor-box-exceptions` (6 files).
- Every test writes after the close while the shift is still `closing`; none writes after the receipt has made it `closed`.
- Not reachable from a screen today: the closed stop is terminal, and `entered` refuses a `localState`. But it is the plan's contract («пока у её смены нет `local_state`»), and ПЛ-Ц's pallet records and ОЧ lean on it.
- **Fix:** one case in `floor-shift-close.test.ts`: mark the copy `closed` (as the receipt does), then any writer gives `changes_mismatch` and the outbox is unchanged.

**m2. The close summary's double-failure path (Task 4 m2 + m3 + m9; FIX, WorkScreen)**

- **Where:** `WorkScreen.tsx`:
  - `showSummary`/`readSummary` show a `closed` blocker as a summary with «Назад к работе».
  - In `confirmClose`, the fresh-closed path (`:1234-1237`) does not call `onRecorded`.
  - The failed re-show (`:1262-1272`) states «не закрыта» and sets `waitingSscc: null`.
- **Scenario:** the commit succeeds, its answer is lost, and the re-read fails too.
  1. The note says the shift is not closed. Back returns to a live screen on a `closing` shift, where every scan becomes the «write» system error.
  2. The next press finds the shift closed through the fresh path, so the status bar and the outbox are not prompted.
  3. Data stays safe, and the operator can leave.
- **Fix:**
  - A `closed` blocker in `showSummary`/`readSummary` → `showClosed`.
  - Call `onRecorded` on the fresh-closed path; it is harmless when the record was already told.
  - Hedge the failed note when the re-read failed.
  - Use `showSummary(again, "failed")` in the catch.

**m3. Two re-shows in a row keep the view key (Task 4 m5; FIX, ShiftClosePanel)**

- **Where:** `ShiftClosePanel.tsx:91-94`, view key `summary:<blocker>:<note>`.
- A second stale (or failed) re-show keeps the same key, so neither the 400 ms guard nor the focus restarts over «Подтвердить закрытие», which cannot be taken back.
- Rare: it needs two out-of-queue changes in a row.
- **Fix:** add an attempt counter to the `close` stop and put it in `viewOf`.

**m4. The tracked close has no `.catch` (Task 4 m8; FIX)**

- **Where:** `WorkScreen.tsx:1231` (`void live.current.track(queue.run(…))`).
- A future throw in its `catch`/`finally` would be an unhandled rejection.
- **Fix:** `.catch(() => setStop({ kind: "system_error", cause: "write" }))`.

**m5. `confirmClose`'s queueing is defence in depth today (Task 4 m1; DOC + CARRY ПЛ-Ц)**

- Mutant D (outside the queue, still tracked) is equivalent today: while the `close` stop stands, every queued scan is refused in its turn.
- **Fix:**
  - A comment at `confirmClose`.
  - ПЛ-Ц must pin it with a held non-scan job once «Закрыть паллету и смену» queues pallet work before the close.

**m6. Stale comments, titles and doc details (FIX, DOC)**

- `WorkScreen.tsx:113-116`: «a leave started by a timer or an answer (the idle lock, the office closing the shift)». The office's close starts no leave now; drop it from the list.
- `test/floor-app.test.tsx:1221`: the title «does not call a shift the office closed on the way the office's when this station began to close it too» names the removed notice. Retitle to what it checks: no work screen and no `work_entered` for a shift this station is closing, whatever the office did.
- Spec `:1392`, the §21 HTML comment «План 2a8 берёт §20»: 2a8 took §22.
- `ShiftList.tsx:52-62` JSDoc: "read again after every read of the host's list". It is now also read after every write and batch of receipts (`outboxVersion`), and the refused close is among what the list says (Task 5 m6).
- `facts-sender.ts:73-76`: `+outcome` is listed among the measured pluses, but it is defensive (with `+host_id` the index's leftmost column is unusable anyway; Task 5 m2).
- `AGENTS.md` «Known limits of the retention, carried to the final review»: name the carry owners now (РК/ПЛ-Ц migration, ОЧ/owner, РК-С). The reviewer's measured index is `floor_exceptions (host_id, device_id, shift_id)`, not `(shift_id)` (also in spec §22).
- `AGENTS.md`/spec: «(no waiting label, the same counts…)» omits the close's plan pin and its no-open-box guard. The spec bullet mentions the plan; AGENTS does not.

**m7. `readRefusedCloses` is a repeated read with no plan pin (Task 5 m4; FIX, test-only)**

- **Where:** `shift-close.ts:219-224`. It runs on every `outboxVersion` bump while the list is shown, including every batch of a reconnect drain.
- Its plan is good today (`outbox_settled`, bounded by the pairing's refused records), but `AGENTS.md:312` requires "a line in both lists".
- **Fix:** add it to the Node plan test and to `the_floors_repeating_reads_search_an_index` (test-only, as Tasks 2, 3, 5 and 7 did).

**m8. Retention forgets the station's registry of a purged shift's codes (DOC)**

- `floor_codes` is in `RETAINED_TABLES`, and it is also the station's own duplicate registry (`sqlite_autoindex_floor_codes_1 (host_id, device_id, code_hash)`).
- After a purge, a code of a shift accepted more than 30 days ago, scanned again with the host away, is accepted locally. Only the host catches it (`conflict`, then `needs_fix` on its box).
- With the link up, the host's code check refuses it first.
- SSCC reuse is not at risk: the blocks and their cursors are kept, and `sharesSerials` reads the blocks.
- This follows decision 31. State it in «Floor exceptions and close» and §22.

**m9. The host replay's "nothing written" check never fired on my host mutants (DROP)**

- `host/tests/floor_scenario.rs:145-151` compares `fact_rows`, the counts of 8 fact tables.
- My H1 (replay re-applies the record) and H2 (stored receipt ignored) die on a 500: the unique `(device_id, record_id)` indexes of every fact table refuse the second insert.
- H3 (re-apply with its error ignored) passes `fact_rows`, because nothing new lands in those tables. It is killed by the next assertion, `late_data_at` set on the shift row, which `fact_rows` does not count.
- So the test catches a host that writes twice (3/3), and the schema makes a silent double insert into a fact table structurally impossible.
- Adding the shift row (`late_data_at`, `rev`) to the snapshot would make the check itself discriminate. Not needed.

**m10. The due read's unanswered guard is covered for scans only (DROP)**

- My R3 narrows `DUE_SHIFTS_SQL`'s unanswered guard to `u.kind = 'scan'`, and `test/retention.test.ts` (35 tests) stays green.
- It is behaviourally equivalent: `PURGE_COPY_SQL` (`DONE_WITH`, every kind) refuses the copy delete, and `changes_mismatch` is swallowed. The cost is one extra transaction attempt an hour.
- Also, an accepted `shift_closed` implies every earlier record of the pairing was answered, since batches go in `seq` order.

---

## Seams checked (what I did)

### (1) Queue and tracking duty (N9/N13) for every close and exception write

- **Exceptions:**
  - `exception()` (`WorkScreen.tsx:1084-1119`) is `track(queue.run(…))`, starts nothing once leaving, and re-checks `stopRef.current?.kind === "exceptions"` in its turn (Task 2 I2).
  - `openExceptions` queues label settlement first.
  - `reprint`/`disassemble` re-read `labelWaits()` in the turn.
  - `box-exceptions.ts` states the queue rule in its header.
- **Close:**
  - `readSummary` and `confirmClose` are tracked queue jobs.
  - `closeRunning` stops a double press.
  - Nothing starts once leaving.
- **The close stop refuses a queued scan:**
  - A scan already being written when «Закрыть смену» is pressed is counted (held-write tests at `floor-work-close.test.tsx:218,245`).
  - A scan queued but not yet started is refused in words, flash and tone (`refuse`), because the `close` stop is set at the press. Nothing is dropped silently.
  - My W7 (the closed stop swallows scans) is killed.
- **Retention** runs outside the work queue, by design. Each shift is one write transaction that re-checks `DONE_WITH`. A due shift has no unsent record and no open job, so no work-screen writer can touch it: its copy is `closed`, and `entered` refuses it.

### (2) WorkScreen and FloorApp state machines

- **`Stop`** gains `exceptions`, `close` and `closed` (terminal).
- **Scan routing order:**
  1. exceptions box choice (a verdict, or fall through to refusal);
  2. label check;
  3. any stop → refuse (`shift_closed` text at the closed stop);
  4. `closeBox(true)`;
  5. `officeClosed` → refuse;
  6. `processScan`, its only call.
- **Buttons:**
  - «Исключения» and «Закрыть смену» are disabled at any stop and while leaving.
  - «Выйти из смены» is never inside a panel.
  - «К списку смен» on the closed panel is `aria-disabled` only while leaving.
- **FloorApp:**
  - The office's close sets `officeClosed` on the open work view only; it no longer calls `leave`.
  - `entered` lets a closed copy without a `localState` through and turns everything else back.
  - The leave priority is now only "sign-out outranks".
  - My S1 (online «Завершить» asks the host) is killed.

### (3) Receipts `closing` → `closed`, and finishing an office-closed shift

- **Receipt operator:**
  - The fourth statement is in the same transaction.
  - It is pairing-scoped, `closing`-guarded, kind- and outcome-guarded and batch-scoped.
  - My F2 (any outcome) is killed by `facts-sender`.
- **List:**
  - It reads again on `outboxVersion`; my L1 (dependency dropped) is killed.
  - A refused close is named on a `closing` card only.
- **Office-closed shift:**
  - It is listed only when `entered_at IS NOT NULL` and it has no `local_state`.
  - «Завершить» is offered without the link, from the stored snapshot.
  - The host answers `alreadyClosed`, and the shift becomes `closed`. Retention then purges it (I1).

### (4) Task 7's retention and the replaced `DUE_SHIFTS_SQL` (adversarial re-verification)

- **Equivalence with the old guards**, clause by clause:

| Old (`floor_shifts s` driver + `DONE_WITH`)          | New (`outbox o` driver)                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `s.host_id = ? AND s.device_id = ?`                  | `o.host_id = ? AND o.device_id = ?` + `EXISTS (copy by its key)` |
| `EXISTS (o … shift_closed, accepted, acked_at <= ?)` | the driver's own `outcome`, `kind` and `acked_at <= ?`           |
| no unsent record of the shift                        | `NOT EXISTS (u … u.acked_at IS NULL)`, same link                 |
| no open job (`OPEN_JOB_SQL`)                         | same, linked through `o`                                         |
| `ORDER BY s.id`                                      | `DISTINCT o.shift_id`, no order                                  |

- The parameter order (host, device, cutoff) is identical.
- The `floor_shifts` PK is `(host_id, device_id, id)`, so the answer is the same set.
- `outbox.shift_id` is `NOT NULL` (`0006:227`).
- Nothing consumed the order; it was dropped.
- **Guards, re-checked:**
  - My R1 (no copy `EXISTS`) and R2 (age from `created_at`) are killed by `retention.test.ts` alone, so the kill is behavioural.
  - My R3 survives as equivalent (m10).
  - The implementer's D1–D8, P1–P3 and R1/R2/R4 cover the rest; I did not re-run them.
- **Plan pins, in BOTH lists:**
  - Node (`floor-schema.test.ts:8399-8424` of the package): the first step is `SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)`, `outbox_settled` appears once, there is no `SCAN`, and the only TEMP line is `USE TEMP B-TREE FOR DISTINCT`. `PURGE_COPY` has no TEMP. The six statement texts must appear word for word in the Rust file.
  - Shell (`local_db.rs`): the `DUE_SHIFTS`/`PURGE_COPY` constants, 4 index entries each, and the same three assertions after the loop.
  - I ran `cargo test -p markiro-standalone --test local_db the_floors_repeating_reads_search_an_index` myself (in the sandbox): 1 passed.
- **`PURGE_COPY`** still uses `DONE_WITH`. Its accepted-close `EXISTS` walks `outbox_settled` in rowid order up to the shift's close. That is bounded by the unpurged records before it; as the oldest due shift, those are mostly its own records plus never-purged ones (refused or unfinished shifts). Accepted.
- **Atomicity, restart and scope:**
  - One shift per transaction, with the copy delete first and `expectedChanges: 1`.
  - Only `changes_mismatch` is swallowed.
  - No foreign keys, so the delete order is free.
  - Every statement is scoped by host and device.
  - Blocks and block requests are kept, and SSCC reuse is not possible: block cursors, `sharesSerials`.

### (5) Task 8's host replay (my host-side mutants)

- `host/src/facts/mod.rs` `receive`:
  - **H1:** the stored-digest branch re-applies the record before answering. Killed (500 at `:81`).
  - **H2:** stored receipts ignored. Killed (500).
  - **H3:** re-apply with its error swallowed. Killed at `:168` (late flag); it passed the `fact_rows` equality (m9).
- The fixture's sends: receipts (5), unreachable (18), lost (18), receipts (the same 18 ids). The "lost then sent again" replay is therefore exercised twice, plus the explicit last-batch replay.

### (6) Irreversible-action UX

- **Clear, reprint and disassemble:** each needs a confirmation naming the box.
- **Disassembly** says «Отменить это нельзя: снимите этикетку с короба.».
- **Undo:** no confirmation (ВП3). Its result tells how to undo it (scan again).
- **Reprint:** names the printer, or the absence of one, before the confirmation (Task 2 I1).
- **Close:**
  - «Подтвердить закрытие» is natively disabled until a required reason is chosen.
  - The 400 ms guard and focus-to-view work, except m3.
  - The panel shows the irreversibility sentence.

### (7) Offline-first, restart, idempotency

- **The close needs no host.** The app test closes offline, sees «Закрывается» in the list, then delivers 5 records in order with `shift_closed` last.
- **A crash after the commit** leaves `closing`; the outbox resends with the same ids; the receipt makes it `closed`.
- **The host answers the same ids with the same receipts.** Proven by the replay, and H1–H3 show a deviation is caught.
- **Retention** runs per whole shift, and the next pass retries.

### (8) Pairing scope, secrets, a11y, dead code

- **Pairing scope:**
  - Every new read and write carries host and device.
  - The guard's host and device scope are pinned (`it.each(FOREIGN)`).
  - Retention has cross-pairing tests for every subquery.
- **Secrets:** no `console.` in `src/floor/exceptions`, `src/floor/close` or `retention.ts`, and no codes in texts.
- **a11y:**
  - All buttons are `size="floor"`.
  - State is said in words, with a ✓ beside `aria-pressed`.
  - Alerts are `role="presentation"` inside polite regions.
  - Focus returns to «Исключения» / «Закрыть смену» after Back.
- **i18n:** a script checked all 117 new keys under `floor.exceptions`, `floor.close`, `floor.work.officeClosed`, `floor.work.last.{closed,officeClosed}` and `floor.shifts.{closeRefused,finishHint,status.office_closed,action.finish}`. Each is used literally or through a template prefix; none is orphaned. `floor.shifts.officeClosed` is gone.
- **Dead code:**
  - The texts `exceptions.result.label` and `label_waiting` (kept for ПЛ-Ц, T2 m6).
  - The `else if (stopRef.current?.kind === "close")` guard in `confirmClose` is unreachable (T4 m4, defensive).
  - `ShiftListNotice` is removed.

### (9) Hygiene

- **Trailers:** 14 of 14 commits have exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- **Checks:** `git diff --check` is clean, and `\u04` matches only `src/host/pairing-code.ts:66`.
- **Scope:** no change under `apps/station`, `packages`, `host/src`, `proto/src`, `src-tauri/src`, `src-tauri/migrations`, manifests, `Cargo.lock` or `pnpm-lock.yaml` (empty stat).
- **Rust:** `cargo fmt --all -- --check` is clean.
- **Prettier gate, proved live:**
  - A probe `apps/standalone/src/zz-final-probe.ts` gave exit 1 with `[warn]`, then was deleted.
  - The 36 changed ts/tsx/json/css/md paths (repo-relative, via `xargs` from the worktree root) printed "Checking formatting..." and "All matched files use Prettier code style!" (exit 0).
- **Test hygiene:** no `.only`/`.skip`/`.todo` in the new files. The two `setTimeout(0)` loops are step-bounded (200 turns). The test casts are in `floor-shift-close.test.ts:689` (a stray code, intended), `app.test.tsx:3423` and `floor-schema.test.ts:929` (T7 M6).

---

## (b) TRIAGE

| Item                                                                                            | Source              | Decision                    | Reason                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T4 dispatch: `closeShift` queued and tracked, held-write `actualQty` test, terminal panel       | addenda (T3 fix)    | DROP (done)                 | `confirmClose`/`readSummary` are tracked queue jobs; tests at `floor-work-close.test.tsx:218,245`; exceptions are disabled at the closed stop.                                                                |
| `RETAINED_TABLES` ∋ `floor_print_jobs`; plan pin and open-box guard kept                        | addenda (T3 notes)  | DROP (done) + deviation     | `retention.ts:24-31`; the guards are in `closeShift` and recorded in (c).                                                                                                                                     |
| «…закрыта на этой станции» carried to T5/T6/T9                                                  | addenda (T4)        | DROP (done)                 | Tests, AGENTS and §5.7.7/§22 follow it.                                                                                                                                                                       |
| AGENTS: two passages on the removed behaviour                                                   | addenda (T6)        | DROP (done)                 | Rewritten (diff `AGENTS.md:2419-2444,2450-2466`).                                                                                                                                                             |
| `WorkScreen.tsx:113-115` JSDoc; `floor-app.test.tsx` title (now `:1221`)                        | addenda (T6 m2, m3) | **FIX** (m6)                | Still stale.                                                                                                                                                                                                  |
| Full-scan deletes on `outbox`/`floor_exceptions` + ~31 MB WAL per 1000 jobs (M1)                | addenda (T7)        | CARRY ПЛ-Ц / РК (owner)     | Needs a migration. ПЛ-Ц already adds local `0008_floor_pallets`, so the two indexes `outbox (host_id, device_id, shift_id)` and `floor_exceptions (host_id, device_id, shift_id)` can ride there. Documented. |
| Refused/conflicting records purged after 30 days (M2)                                           | addenda (T7)        | CARRY ОЧ / owner            | Plan-faithful (decision 31). Owner choice: hold the shift, or state the window in ОЧ. Documented.                                                                                                             |
| A wrong clock purges early (M3)                                                                 | addenda (T7)        | CARRY РК-С                  | Documented.                                                                                                                                                                                                   |
| A failed pass leaves no trace (M4)                                                              | addenda (T7)        | CARRY 2b / РК               | Documented. A process-log line with the error code only needs the log plumbing of stage 5.                                                                                                                    |
| Forgotten pairing's rows never purged (M5)                                                      | addenda (T7)        | DROP (done)                 | Stated in AGENTS and §22.                                                                                                                                                                                     |
| Two casts in tests (M6)                                                                         | addenda (T7)        | DROP                        | Tests, not sources; harmless.                                                                                                                                                                                 |
| `DUE_SHIFTS_SQL` replaced, `ORDER BY` dropped                                                   | addenda (T7 fix)    | deviation (c)               | Equivalence verified in (4).                                                                                                                                                                                  |
| T2 I1 printer not named; I2 unseen undo/clear                                                   | T2 review           | DROP (done)                 | Fixed in `05716ce71`, 24 mutants.                                                                                                                                                                             |
| T2 m1 listener race; m2 tones; m3 «Ничего не сделано»; m4 irreversibility; m5 vacuous assertion | T2 review           | DROP (done)                 | Fixed in `05716ce71`.                                                                                                                                                                                         |
| T2 m6 unreachable result texts                                                                  | T2 review           | DROP                        | Kept for the ПЛ-Ц contract.                                                                                                                                                                                   |
| T2 fix concern: I2 refusal is a 700 ms flash only                                               | T2 fix report       | DROP                        | Nothing ran; the floor's signal convention.                                                                                                                                                                   |
| T3 Important: codes count unpinned; m2 host scope; m3 JSDoc; m4 title and plan list             | T3 review           | DROP (done)                 | Fixed in `fa1638e9d`/`43bec1122`.                                                                                                                                                                             |
| T3: `reprintBox` on a closed shift → `StaleJobError`                                            | T3 report           | DROP                        | Unreachable from screens; ОЧ/ПЛ-Ц may type it if needed.                                                                                                                                                      |
| T4 m1 `confirmClose` queueing equivalent                                                        | T4 review           | DOC + CARRY ПЛ-Ц (m5)       | Pin when pallet work queues before the close.                                                                                                                                                                 |
| T4 m2 closed blocker → Back to a live screen                                                    | T4 review           | **FIX** (m2)                | Cheap; the scans then fail as system errors.                                                                                                                                                                  |
| T4 m3 failed note overclaims; fresh path skips `onRecorded`                                     | T4 review           | **FIX** (m2)                | Same change.                                                                                                                                                                                                  |
| T4 m4 unreachable `stopRef` guard                                                               | T4 review           | DROP                        | Defensive; comment optional.                                                                                                                                                                                  |
| T4 m5 same view key on repeated re-shows                                                        | T4 review           | **FIX** (m3)                | Guard over the irreversible button.                                                                                                                                                                           |
| T4 m6 third copy of the view guard                                                              | T4 review           | DROP                        | A later tidy-up; the copies differ.                                                                                                                                                                           |
| T4 m7 texts and anchors                                                                         | T4 review           | DROP (done)                 | Applied in T5/T6/T9.                                                                                                                                                                                          |
| T4 m8 no `.catch`                                                                               | T4 review           | **FIX** (m4)                | One line.                                                                                                                                                                                                     |
| T4 m9 `waitingSscc: null` on the failed re-show                                                 | T4 review           | **FIX** (m2)                | Same change.                                                                                                                                                                                                  |
| T4 concern 1: held refusal waits for the leave of a closed shift                                | T4 report           | CARRY 2b / owner            | Needs a FloorApp/App prop; the closed panel says so when `linkHeld`.                                                                                                                                          |
| T4 concern 2: ms window between the screen's read and the model's                               | T4 report           | DROP                        | The model's write guard keeps the database consistent; a reason change gives `reason_required`.                                                                                                               |
| T5 m1 report misnamed an equivalent mutant                                                      | T5 review           | DROP                        | Report only.                                                                                                                                                                                                  |
| T5 m2 `+outcome` called measured                                                                | T5 review           | **FIX** (m6, doc)           | One phrase.                                                                                                                                                                                                   |
| T5 m3 `src-tauri/tests/local_db.rs` touched                                                     | T5 review           | deviation (c)               | Test-only; forced by the plan's own pin test.                                                                                                                                                                 |
| T5 m4 `readRefusedCloses` unpinned                                                              | T5 review           | **FIX** (m7)                | Repeated read; both lists.                                                                                                                                                                                    |
| T5 m5 `ORDER BY seq` untested                                                                   | T5 review           | CARRY ОЧ                    | Matters only after a resend is refused again.                                                                                                                                                                 |
| T5 m6 stale `ShiftList` JSDoc                                                                   | T5 review           | **FIX** (m6)                | One sentence.                                                                                                                                                                                                 |
| T6 m1 AGENTS passages                                                                           | T6 review           | DROP (done)                 | T9 rewrote both.                                                                                                                                                                                              |
| T6 m2, m3                                                                                       | T6 review           | **FIX** (m6)                | As above.                                                                                                                                                                                                     |
| T6 observation: a finished office-closed shift still needs a close (reason if plan unmet)       | T6 review           | DROP                        | ВП1 А.                                                                                                                                                                                                        |
| T6 concern 2: host stops listing a closed shift, copy stays `active`                            | T6 report           | DROP                        | Pre-existing status-forward rule; outside 2a8.                                                                                                                                                                |
| T7 Important: due select cost shifts × records                                                  | T7 review           | DROP (done)                 | `c765f9890`, re-verified in (4).                                                                                                                                                                              |
| T1 concerns 1–6                                                                                 | T1 report           | DROP (done/intended)        | Shell list (`425e08b10`); `TemplateChangedError` added in T2; clear without a row count is intended; disassembly while a label waits is gated by the screen (T2 R8).                                          |
| T8 concern: no host mutants                                                                     | T8 report           | DROP (done)                 | My H1–H3 are killed (m9).                                                                                                                                                                                     |
| T9 concern: §21 HTML comment                                                                    | T9 report           | **FIX** (m6)                | Says §20.                                                                                                                                                                                                     |
| Plan «Перенесено»: clock back between scan and clear                                            | plan                | DROP (resolved) + deviation | T1 stamps a clear at max(now, newest `scanned_at`) (`clearOpenBox`, mutant C2).                                                                                                                               |
| **I1** retention docs lie; no `alreadyClosed` retention test                                    | final               | **FIX**                     | See (a).                                                                                                                                                                                                      |
| m1 guard for `closed` unpinned                                                                  | final               | **FIX**                     | One test.                                                                                                                                                                                                     |
| m8 registry of purged codes                                                                     | final               | **DOC**                     | Decision 31 consequence.                                                                                                                                                                                      |
| m9 `fact_rows` blind to the shift row                                                           | final               | DROP                        | End assertions catch it; schema uniqueness.                                                                                                                                                                   |
| m10 due read covered for scans only                                                             | final               | DROP                        | Equivalent through `PURGE_COPY`.                                                                                                                                                                              |

### Proposed fix wave (ONE fixer, separate commits)

1. **`test(standalone)`: the close's last guards and the retention of a finished office-closed shift are pinned.** These tests fail before commit 2 where they test behaviour:
   - `floor-shift-close.test.ts`: a writer after the copy turned `closed` gives `changes_mismatch`, outbox unchanged (kills F1).
   - `retention.test.ts`: an accepted close with `{"alreadyClosed":true}` is due and purged.
   - `floor-schema.test.ts` + `src-tauri/tests/local_db.rs`: the `readRefusedCloses` plan (`outbox_settled (host_id=? AND device_id=? AND outcome=?)`, no TEMP), and its text in the shell list.
   - `floor-work-close.test.tsx`:
     - a summary opened on a shift found closed shows the closed stop;
     - the fresh-closed path tells `onRecorded`;
     - two stale re-shows in a row each restart the 400 ms guard.
2. **`fix(standalone)`: the close summary after a lost answer shows the shift closed, tells the outbox, and guards every re-show.**
   - `WorkScreen.tsx`: m2 and m4 (`.catch`).
   - `ShiftClosePanel.tsx`: m3 (an attempt in `viewOf`, carried by the `close` stop).
   - `ru.json`: the hedged failed note.
   - A mutant for each change.
3. **`docs(standalone)`: what retention deletes, and the stale comments.**
   - I1: AGENTS, §22, `facts-sender.ts:143`.
   - m6: all items.
   - m8: one sentence in AGENTS and §22.
   - m5: a comment at `confirmClose`.

Gates for the wave:

- focused `floor-shift-close`, `retention`, `floor-schema`, `floor-work-close`, `floor-app`;
- the delayed-`setImmediate` stand on `floor-work-close`;
- typecheck and lint;
- the live prettier gate;
- `cargo test -p markiro-standalone --test local_db the_floors_repeating_reads_search_an_index`;
- `cargo fmt --check`;
- `git diff --check`;
- the `\u04` grep;
- one trailer per commit.

---

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении», in Russian)

- **Задача 1.**
  - `exceptionStatements` перенесён из `box-exceptions.ts` в `facts.ts`: экспортирован, id строки берётся до id записи, как в 2a7. Им же пишет `reprintStatements` плана 2a7 (`print-resolution.ts`), то есть у исключений один писатель.
  - Сверх плана добавлено:
    - удаление строки кода при снятии требует `expectedChanges: 1` и совпадения кода и `scan_id`;
    - `occurredAt` очистки — позднейшее из «сейчас» и `scanned_at` последнего снимаемого кода. Это закрывает пункт «Перенесено» о часах, отступивших между сканом и очисткой;
    - перепечатка начинается двумя сторожевыми `UPDATE`: короб закрыт и не расформирован, его последнее задание — прочитанное;
    - последнее задание короба выбирается по rowid.
  - Тестов 41 вместо 16.
  - Строки плана запросов в списке оболочки добавлены отдельным коммитом `425e08b10` (`src-tauri/tests/local_db.rs`, `test/floor-schema.test.ts`, вне списка файлов).
- **Задача 2.**
  - Имена — по исполненному `WorkScreen`.
  - Блок `exceptions` в `ru.json` — соседом `print`.
  - `work-screen__reasons` заменён на `exceptions__choices`.
  - Опора тестов получила `labelClock`/`pause()` для защиты 400 мс.
  - Текст пропуска этикетки снова ссылается на «Исключения», и тест перепечатывает оттуда (`test/floor-work-print.test.tsx`, вне списка файлов).
  - Волна исправлений `05716ce71`:
    - подтверждение перепечатки называет принтер, или его отсутствие с «Настроить принтер»;
    - исключение, ждавшее в очереди, не выполняется, если экран исключений уже снят;
    - вердикт скана выбора короба — тоном и словами;
    - честные тексты `failed`/`stale`;
    - необратимость расформирования;
    - подсказка после снятия кода.
  - Тестов 54.
- **Задача 3.**
  - Сверх плана в транзакции закрытия — сверка плана копии (`s.planned_qty IS ?`) и отсутствия открытого короба.
  - Тест «ни одной записи после закрытия» ждёт от `reprintBox` `StaleJobError`, а не `changes_mismatch`.
  - Волна исправлений:
    - сверка числа кодов закреплена отдельным тестом;
    - область хоста в проверке `outboxStatement` закреплена;
    - JSDoc `closeShift` называет правило очереди;
    - план запроса проверки — в обоих списках (`src-tauri/tests/local_db.rs`, вне списка файлов).
- **Задача 4.**
  - Тексты «Смена … закрыта на этой станции» и «Смена закрыта на этой станции. Данные будут отправлены автоматически.» (решение контроллера: отличает от смены, закрытой офисом).
  - Свой текст отказа скана на закрытой смене.
  - `ClosedNumbers` вместо полного `ShiftClosedFact`.
  - «Назад» есть и пока сводка читается.
  - Экранная сверка показанной сводки (`sameSummary`).
  - SSCC ждущей этикетки и «Перейти к этикетке».
  - Строка итога по плану, знак ✓.
  - `test/floor-work-screen.test.tsx` — число кнопок 4 → 5.
- **Задача 5.**
  - Четвёртый оператор квитанций получил унарные плюсы (`+host_id`, `+device_id`, `+outcome`): текст плана планировался через `outbox_settled`, то есть все принятые записи подключения на каждую пачку.
  - План запроса закреплён в `test/floor-schema.test.ts` и `src-tauri/tests/local_db.rs` (вне списка файлов).
- **Задача 6.**
  - Добавлены вид `office_closed` у `Last` и ключ `officeClosed` рядом с `shift_closed`.
  - `refuse` получил третий параметр.
  - `storedWork` и `enterShift` принимают `closed`.
  - Ворота `entered` пропускают смену, закрытую офисом. Поздний ответ входа на такую смену открывает рабочий экран в режиме завершения, и оболочке сообщается `work_entered`.
  - Ветка приоритета уведомления в `leave` удалена.
  - Адаптированы прежние тесты `floor-shift-list`, `floor-app`, `shift-copies` и `app.test` (последний — вне списка файлов).
- **Задача 7.**
  - `DUE_SHIFTS_SQL` плана заменён: стоимость была «смены × записи», 6,5 с на 600 000 строк. Новый текст идёт от принятых закрытий, проходит принятые записи один раз (`DISTINCT`, 60 мс), а `ORDER BY` снят. Условия и параметры те же; `DONE_WITH` и `PURGE_COPY_SQL` не менялись.
  - Тексты операторов экспортированы для закрепления планов.
  - Планы закреплены в обоих списках (`test/floor-schema.test.ts`, `src-tauri/tests/local_db.rs`, вне списка файлов).
  - Тест приложения усилен.
- **Задача 8.** Четыре id записей `box_exception` в фикстуре отличаются от плана (…0011→…0012, …0014→…0015, …0022→…0023, …0025→…0026): исполненный модуль берёт id строки до id записи. Остальное совпало.
- **Задача 9.**
  - Раздел спецификации — §22 (§15–§21 заняты; план говорил §20).
  - Раздел AGENTS «Floor exceptions and close» вставлен перед «Marking rules».
  - Переписаны два абзаца AGENTS о выходе из смены, закрытой офисом.
  - Добавлены известные ограничения срока хранения (M1–M4).
- **Пути вне списка файлов плана:** `src-tauri/tests/local_db.rs` (задачи 2, 3, 5, 7 — только тесты, требование правила «строка в обоих списках»), `test/floor-schema.test.ts`, `test/floor-work-print.test.tsx`, `test/floor-work-screen.test.tsx`, `test/app.test.tsx` (задача 6), `src/floor/print/print-resolution.ts` (задача 1).
- **Счёт тестов на настоящем дереве:** Vitest 116 файлов, 3536 тестов после задачи 8 (на копии плана — 112/2643). Rust workspace — 815 пройдено (задача 8); `--test floor_scenario` — 2.
- **Итоговое ревью:**
  - замена `DUE_SHIFTS_SQL` проверена на равносильность прежним условиям и мутантами;
  - тест повтора хоста ловит хост, пишущий дважды (три мутанта хоста убиты);
  - [плюс то, что сделает волна исправлений: I1, m1–m4, m6–m8].

---

## Evidence

**Baselines** (my runs):

- Vitest, 10 files: `floor-shift-close`, `floor-facts`, `facts-sender`, `floor-work-close`, `floor-scenario`, `floor-box-exceptions`, `retention`, `floor-shift-list`, `floor-app`, `app`. Result: 473 passed (`/tmp/claude/rev-2a8-final/vitest-base.log`).
- `cargo test -p markiro-host --test floor_scenario`: 2 passed (`cargo-base.log`).
- `cargo test -p markiro-standalone --test local_db the_floors_repeating_reads_search_an_index`: 1 passed (`localdb.log`).
- All three ran in the sandbox.

**My mutants:**

- Driver `/tmp/claude/rev-2a8-final/mut.py`; definitions `muts.json`, `muts2.json`, `muts3.json`; logs `<id>.log`.
- Each file was copied first, then restored with `cp`, with `cmp` silent and sha256 equal (`restore True` for all 12). The Rust file was `touch`ed.
- `git status --short` is empty at the end.

| #   | Seam            | Mutant                                                 | Result                                                                   |
| --- | --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| F1  | T3 outbox guard | `local_state IS NOT NULL` → `= 'closing'`              | **SURVIVED** (6 files): m1                                               |
| F2  | T5 receipt      | `+outcome = 'accepted'` → `IS NOT NULL`                | killed (`facts-sender`)                                                  |
| R1  | T7 due read     | copy `EXISTS` removed                                  | killed (`retention` alone)                                               |
| R2  | T7 due read     | age from `created_at`                                  | killed (`retention` alone)                                               |
| R3  | T7 due read     | unanswered guard only for `scan`                       | **SURVIVED**, equivalent: m10                                            |
| W6  | T4 close        | fresh-closed branch removed                            | killed (`floor-work-close`)                                              |
| W7  | T4/T6 stops     | closed stop swallows a scan silently                   | killed (`floor-work-close`)                                              |
| S1  | T6 entry        | «Завершить» asks the host when online                  | killed (`floor-shift-list`/`floor-app`/`app`)                            |
| L1  | T5 list         | `outboxVersion` dropped from the effect's dependencies | killed                                                                   |
| H1  | T8 host         | stored branch re-applies the record                    | killed (500)                                                             |
| H2  | T8 host         | stored receipts ignored                                | killed (500)                                                             |
| H3  | T8 host         | re-apply, error swallowed                              | killed (`late_data_at`, `floor_scenario.rs:168`); passed `fact_rows`: m9 |

**Hygiene:** trailers 14/14, `git diff --check` clean, `\u04` only at `pairing-code.ts:66`, forbidden paths empty, `cargo fmt --check` clean. Prettier gate proved live (`prettier-probe.log` exit 1, `prettier.log` exit 0 over 36 paths).

**Not run / not verifiable:**

- the full Vitest suite and the full cargo workspace (load; per instructions);
- the delayed-`setImmediate` stand (no React file changed by me);
- Windows, WebView2, touch panel, scanners, printers, a live host, a screen reader.
- Tasks 1, 8 and 9 had no separate review. Task 1 was spot-checked through the baseline and Task 2's R6. Task 8 was checked by H1–H3. I reviewed Task 9's documents myself (I1, m6).
