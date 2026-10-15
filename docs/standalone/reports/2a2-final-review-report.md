# Plan 2a2 — final whole-part review (tasks 1–8)

Worktree `/tmp/claude/wt/2a2-facts`, branch `claude/2a2-facts`, HEAD `1d783cf7f`, plan base `7cf28790e` (12 commits, `6fcee4307`..`1d783cf7f`). I reviewed the fix rounds of Tasks 3, 4 and 5 and all of Task 8, none of which had a re-review before, and the part as one machine.

### Verdict

**WITH FIXES.** Critical 0, Important 0, Minor 11.

- Nothing in the part breaks data, a trust domain or the delivery contract that plans 2a6 and 2a7 already fix on the station's side. The three fix rounds and Task 8 are correct.
- The final wave is the decided `unitsInClosedBoxes` plus cheap test and documentation fixes. It needs one fixer, with tests and production in separate commits (see (b)).
- Two guards survive one-line mutants (Minors 2 and 3). Both are test gaps: the production code is correct.

---

## (a) Findings, most severe first (all Minor)

**1. `acceptedUnits` is not the cloud's office number, and the fixture reads as if it were** (T7 Minors 1 and 6; the controller has DECIDED to fix it).

- Where: `host/src/routes/office_shifts.rs:34-36`, `proto/src/lib.rs:1467` (`ShiftTotals`), `proto/fixtures/office-shift.json:24`.
- Scenario: a shift closed from the office («Станция не отвечает») shows `acceptedUnits` 547 while 7 units sit in an open box. The future export refuses that shift (`BOX_COVERAGE_INCOMPLETE`), and the card has no number to explain why.
- The fixture's `540 / 45 closed / 1 open / capacity 12` can only happen under the cloud's definition, which is the opposite of the contract.
- Fix:
  - Add `unitsInClosedBoxes: u64` to `ShiftTotals`. Its value is `COUNT(*)` of live `box_items` (neither `removed_at` nor `displaced_at`) in this shift's boxes with `closed_at IS NOT NULL AND disassembled_at IS NULL`. That is the cloud's `containedUnits` / «Кодов в закрытых коробах».
  - Serve it as a sixth correlated subquery on `boxes_shift` → `box_items_live` (the same plan as `acceptedUnits`; checked with EXPLAIN, below).
  - Fixture: `acceptedUnits` 547, `unitsInClosedBoxes` 540.
  - Tests: extend `the_office_reads_a_shifts_totals_from_its_facts` (`facts.rs:6641`): box 1 = 2 after the colleague's displacement, box 4 disassembled = 0, open box 2 not counted. Also extend the planned-shift zeros in `facts.rs:6649` and in `office_shifts.rs`, plus the proto empty-shape assertion.
  - Mutants for the wave: count open boxes, count disassembled boxes, count displaced items.
  - Docs: AGENTS «Facts» totals paragraph and §19. The office label for `acceptedUnits` is «Принято кодов» (or 2a3's «Принято единиц», never «в коробах»); for `unitsInClosedBoxes` it is «Кодов в закрытых коробах».

**2. The `sscc = ?` half of the `sscc_taken` guard is not pinned by any test** (new; mutant MA survives).

- Where: `host/src/facts/box_closed.rs:96`, `SELECT 1 FROM boxes WHERE sscc = ? OR (block_id = ? AND serial = ?)`.
- Mutant MA: `(sscc = ? AND 0) OR …`. Result: facts 53/53, codes 8/8 and office_shifts 23/23 pass.
- Scenario: the same 18-digit string under another block. Example: the organisation's issuer prefix changes between shifts from `4600682` (serial width 9) to `46006820` (width 8). Serial 1500 of either block renders `046006820000015000`, but they are different `(block_id, serial)` pairs.
  - With the guard, the receipt is `sscc_taken`, which is correct.
  - Without it, `boxes_sscc` raises a UNIQUE error, the batch answers 500 and the station's outbox wedges forever (owner decision 2).
  - The implementer's note that the half is "redundant in the same block" is true. The other-block case is exactly why the half is needed.
- Fix (test only): a second shift whose snapshot prefix is the 8-digit one, with a block of it inserted the way the existing pallet-block test does. Closing a box with the colliding string must give `sscc_taken`, the box must stay open, and the answer must be 200, not 500. Kill MA.

**3. Millisecond precision of the registry within one second is still not pinned** (T2 Minor 1, open; mutant MG = the T2 review's K4 survives).

- Where: `host/src/facts/registry.rs:109`. Mutant: `claim.scanned_at[..19] >= owner.scanned_at[..19]`. Result: all three targets pass.
- Scenario: a later refactor normalises `scanned_at` to whole seconds. A scan 300 ms earlier within the same second then loses its code, and the suite stays green.
- Fix (test only): owner at `instant(60, 500)` and claim at `instant(60, 499)` must be accepted and displace the owner; then `instant(60, 500)` again must be a `conflict`.
- No `CHECK (length(scanned_at) = 24)`: IMP writes no scans (it is refused on a non-empty site), the handler already checks the format, and the test is the pin.

**4. `received_at` is read before the write lock** (T6 Minor 2).

- Where: `host/src/routes/facts.rs:43` (`state.timestamp()` before `begin_write`).
- Scenario: a batch arrives at t0 and waits behind a writer. The office closes the shift at t1 > t0 and wins the lock (SQLite's busy handler is not FIFO). The batch then stamps `late_data_at = t0`, which is earlier than `closed_at = t1`. Its receipts, `displaced_at` and `detected_at` also show arrival order, not commit order.
- Fix: read `received_at` right after `begin_write` and `require_live_in`. No other code changes.
- Test (RED today, deterministic):
  1. Hold `begin_write`.
  2. Start the batch and prove it is pending: `timeout(200 ms, &mut batch).is_err()`, the pattern at `facts.rs:1206`.
  3. Advance the `ManualClock` by a minute, then commit the holder.
  4. The receipts' `received_at` and the late mark carry the advanced time, and `late_data_at >= closed_at` of an office close made inside the holder.
- Mutant: move the read back before the lock.

**5. The lock-wait race test uses a 300 ms sleep, and its doc comment contradicts its assertions** (T6 Minor 1).

- Where: `host/tests/facts.rs:6252-6255` and `:6279`.
- The pass/fail outcome is deterministic: the holder takes the lock before the batch is built, so the office close always commits first.
- What the sleep cannot guarantee is that the batch reached the lock before the office write. Under the load seen here (load average 90 to 180), the batch may not have started yet. The test then still passes, but against a mutant that reads the shift BEFORE the lock (not the one I ran: MH, the deferred `BEGIN`, is killed) it would pass vacuously.
- The comment says "the batch takes no revision", while the test asserts `revision + 2` (the late scan takes the batch's revision).
- Fix:
  - Replace the sleep with the pending-poll above.
  - Reword the comment: "the batch's close is `alreadyClosed`; its late scan takes the batch's one revision".
  - In AGENTS «Facts» (`AGENTS.md:1885-1887`), "take no revision … but for a station's close" gains "and a closed shift's first late fact".

**6. §19 understates when a station's own facts mark its shift late** (Task 8, new).

- Where: spec `2026-10-08-standalone-2a-shift-and-boxes-design.md:969-971`, «…если её очередь ушла несколькими пачками».
- The code marks the shift late for ANY accepted fact that follows the station's own `shift_closed` in `seq`, in the same batch too: `entered_shift` re-reads the status per record. `a_batch_that_closes_its_shift_takes_one_revision` (`facts.rs:2798`) asserts `late_data_at` set within one batch.
- A 2a8 planner reading §19 could conclude that one batch is safe.
- Fix: «любой принятый факт, стоящий в очереди станции после её `shift_closed` (в той же пачке тоже), ставит `late_data_at`; поэтому 2a7/2a8 закрывают смену только после разрешения печати (`shiftLabelsSettled`)».

**7. The registry is described as "the earliest scan owns the code", which stops being true after a release** (T2 Minor 4 / T5 Minor 2, documentation part).

- Where: `0010_facts.sql:109-110`, `host/src/facts/registry.rs:1-7`, `AGENTS.md:1895-1896`.
- After `registry::release`, the next ARRIVING scan owns the code, not the earliest surviving claim. Example: a displaced item or a conflict loser, both earlier than the new scan.
- This is cloud parity and a 2b decision, but three texts state an unconditional rule.
- Fix: "the earliest accepted scan since the code was last freed (an exception's release does not hand the code back to an earlier displaced item or conflict loser: plan 2b)".
- 0010 is unreleased, and the T4 fix already amended it. A host database a developer applied locally must be recreated after the comment edit (sqlx checksum).

**8. A batch that fails with 500 does not name the failing record** (T2 Minor 2).

- Where: `host/src/routes/facts.rs:51` (the `?` on `facts::receive`). `ApiError::internal` logs only SQLite's words.
- Scenario: a host bug makes one valid record raise a database error. The station resends the same batch forever (decision 2: delay, not loss), and the log names neither the device nor the record. On the pilot's critical path that is the one failure support must diagnose.
- Fix: one `tracing::error!(device = %device.id, position = index, "a fact batch failed")` in the loop. Log the record's position in the batch, never `value["id"]`: an unvalidated id is device text.
- Test: the walk's 500 already exists (`no_secrets_in_logs.rs`). Assert that the line with the position is in the log. Update the static count (`routes/facts.rs` 0 → 1), the AGENTS «Logs» sentence ("exactly those two") and §19.

**9. Nothing says that a new fact kind or a new `data` field raises `PROTOCOL_VERSION`** (T2 Minor 3).

- Where: `AGENTS.md` «Facts» and «Protocol»; `proto/src/lib.rs` (`FactKind` doc).
- An older host refuses the unknown kind or field with `invalid_record` and keeps that refusal forever.
- ПЛ-Х already bumps to 3 for `pallet_*` and `palletId`, and 2a7 says the same of a `box_label` reason. The rule is followed but not written.
- Fix: one sentence in AGENTS «Facts» and in the `FactKind` doc.

**10. A test comment claims a webview check that does not exist yet** (T1 Minor 3).

- Where: `proto/tests/fixtures.rs:886-887`, "as the webview reads them from the same fixtures".
- Plan 2a6 adds that read (its Vitest test against `fact-receipt-codes.json`, 2a6:688-690), and 2a8 adds the one for `exception-reasons.json`.
- Fix: "as the webview will read them (plans 2a6, 2a8)".

**11. An oversized body gets 400 `validation_failed`, not 413** (new; contract note).

- Where: `host/src/error.rs:161-171`. `ApiJson` maps every `JsonRejection`, including axum's 2 MiB length limit, to `ApiError::malformed`.
- Plan 2a6's sender test assumes 413 `payload_too_large` (around 2a6:5456). Both answers are retried with the same batch, so no data is at risk.
- The station's 16 KiB-per-record cap (2a6:818; 100 × 16 KiB < 2 MiB, tested at 2a6:552-569) makes the case unreachable. Any 400 on a well-formed batch would wedge the outbox, and only a host bug can produce one.
- Fix: one clause in AGENTS «Facts» ("a body over axum's 2 MiB is `validation_failed`, like any unreadable body"). Carry to 2a6: correct the test's expectation, or treat 400 on a batch as "host error" (it already does).

### Checks that came back clean (seams 1–10)

- **Delivery contract (2a6/2a7 against the host)**, checked by a read-only sweep of plans 2a6, 2a7, 2a5 and spec §4.4/§5.5. No hard mismatch:
  - Envelope and data match `facts-request.json`. Every nullable field is always sent as explicit `null`, never omitted (Zod `.nullable()` + `.strict()`), and resends are the stored bytes. So the whole-record digest is stable.
  - Non-`ok` scans carry `code`, which the host requires.
  - Receipts are matched by position, with `id` equal or `null`, and `code`/`details` optional (the host uses `skip_serializing_if`).
  - All 11 receipt codes are listed on both sides.
  - Batches are 1–100 in `seq` order, one send at a time, with backoff, and any failure resends the same ids.
  - Every instant is `toISOString()`. `floor_codes.scanned_at` is bound from the same variable as `data.scannedAt` (2a6:2908-2918), so a 2a8 `undo` can satisfy `added_at = targetScannedAt`.
  - 2a7 `reprint` sends `reasonText: null` even for `other`, which the host accepts.
  - The 2a7 rule "labels settled before `shift_closed`" is stated, and `shiftLabelsSettled` is tested (2a7:3565, 2938). The `seq` ordering test is assigned to 2a8, which is not written yet.
- **SSCC uniqueness at every level.**
  - The string: code (unpinned, Minor 2) plus `boxes_sscc`.
  - `(block_id, serial)`: code plus `boxes_block_serial`. The T4 fix is correct, and its mutants A/B/C are recorded.
  - A disassembled box keeps its SSCC and serial.
  - `consumed_through = max(coalesce(ct, s), s)` is monotonic (T4 R5).
  - The registry decides earliest-wins in both arrival orders, and a tie goes to the owner (MC kills `>=` → `>`).
  - Undo/clear stale protection: MB kills `<=` → `<` through `a_late_clear_never_takes_out_a_code_scanned_after_it`.
- **Concurrency.**
  - Every write route here uses `begin_write`. The facts batch is ONE transaction, including receipts, audit, revision and wake: `commit_with_revision` only when a shift row changed.
  - `require_live_in` runs after the lock (T2 K5), and the shift status is re-read per record inside the transaction (T6 R2).
  - MH (deferred `pool.begin()`) is killed by both lock-wait tests.
  - The throttled touch is correct for every `AuthDevice` user. `AskingDevice` (the T3 fix) is used by `check_code` only and shares `authenticate`, so it has the same 401 and kind parse.
  - Users of `AuthDevice`: `bootstrap`, `office_auth`, `changes` (list and stream), `facts`, `devices` (`GET /v1/device`, line), `device_shifts` (list, create, enter), `sscc_blocks`, and every office route through `OfficeContext::from_request_parts` (`auth.rs:305`).
- **Authorization.**
  - Facts and the code check need a device key; an office session alone opens neither.
  - Only a participant passes `not_entered`, and only stations enter in 2a.
  - `boxes::find` and the block query scope to this device and shift.
  - `operatorId` is trusted for shape only (documented).
- **Data.**
  - `0010` is additive. `0001`–`0009` are byte-identical to the plan base: sha256 per file matches `git show 7cf28790e:…`, and `git diff --name-only 7cf28790e HEAD -- host/migrations` lists only `0010`.
  - A rescan of a code across shifts is allowed (no uniqueness on `scans.code_hash`).
  - The only `DELETE FROM shifts` removes planned shifts, which have no facts and no receipts with `shift_id`.
  - Devices and blocks are never deleted.
  - Numbering: РК takes `0011`, ПЛ-Х `0012`, IMP adds no migration and writes none of the 0010 tables.
- **EXPLAIN** (`/tmp/claude/rev-2a2-final/eqp.txt`, SQLite 3.53 over 0001–0010): every query on the receive path, the code check and the totals is an index SEARCH.
  - Receipt PK; shift PK + participants covering PK; box PK; owner PK + shift PK; `box_items` PK (displace) and `box_items_live` (members, undo `(box_id, code_hash)`, clear); block PK.
  - `sscc_taken` is a MULTI-INDEX OR over `boxes_sscc` / `boxes_block_serial`.
  - Totals use `boxes_shift` → `box_items_live` and the `fact_receipts_shift` covering index.
- **Protocol.**
  - `PROTOCOL_VERSION` stays 2 and the minimum stays 1.
  - Request types are strict, response types lenient.
  - `error-codes.json` is unchanged (no new top-level code).
  - Fixtures round-trip (proto 5 + 43).
- **Logs.**
  - Only two `warn!` calls in the facts path, carrying device, record id (a validated UUID or `None`) and receipt code.
  - `ApiError::internal` logs SQLite's words, which hold no values; the walk's real 500 proves it for the scans INSERT.
  - The static test closes the `debug!`/`trace!`/`eprintln!` blind spot of the walk. Its own blind spot is in (d).
- **Scope and process.**
  - No manifest or lockfile change; `apps/station`, `packages/*`, `src/` and `src-tauri` are untouched; the webview gains one test.
  - All 12 commits carry exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - `git diff --check 7cf28790e HEAD` is clean, and `cargo fmt --check` exits 0.
  - `cargo check -p markiro-host -p markiro-proto --all-targets` exits 0. The only warning is the environmental `xcrun` note from the build script.

### Evidence

- **Focused runs** (`--offline --locked --manifest-path /tmp/claude/wt/2a2-facts/apps/standalone/Cargo.toml`):
  - `--test facts` 53, `--test codes` 8, `--test office_shifts` 23 and `--test fact_rules` 12, all passed (sandbox).
  - `-p markiro-proto` 5 + 43 passed.
  - `--test no_secrets_in_logs` 2 passed (sandbox disabled).
  - Logs: `/tmp/claude/rev-2a2-final/base-*.txt`.
- **My mutants** (harness `/tmp/claude/rev-2a2-final/mut.py`, results in `mut-results.jsonl`, each run on `--test facts --test office_shifts --test codes --no-fail-fast`):

| #   | One-line mutant                                                        | Result                                                                          |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| MA  | `box_closed.rs:96` `(sscc = ? AND 0) OR (block_id = ? AND serial = ?)` | **survives** (Minor 2)                                                          |
| MB  | `exception.rs:98` clear `added_at < ?`                                 | FAIL `a_late_clear_never_takes_out_a_code_scanned_after_it`                     |
| MC  | `registry.rs:109` `>` (a tie takes the code)                           | FAIL `the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in`         |
| MD  | `mod.rs:356` receipt `shift_id: None`                                  | FAIL 4 (receipt rows, envelope, totals `lastFactAt`)                            |
| ME  | `mod.rs:343` late mark also for `shift_closed`                         | FAIL `a_station_closes_its_shift_once_and_the_office_sees_it_closed`            |
| MF  | `scan.rs:58` serial control characters allowed                         | FAIL `every_field_of_a_scan_is_checked_before_anything_is_written`, totals test |
| MG  | `registry.rs:109` compare to the second (`[..19]`)                     | **survives** (Minor 3; = T2 K4)                                                 |
| MH  | `routes/facts.rs:44` deferred `state.pool.begin()`                     | FAIL both lock-wait tests                                                       |

- **Restoration.**
  - Originals were copied to `/tmp/claude/rev-2a2-final/orig/`. `shasum -a 256 -c sha-before.txt` reports OK for all six files, and `cmp` against the copies is silent.
  - `restored: true` on every row.
  - `git -C /tmp/claude/wt/2a2-facts status --short` is empty, and HEAD is still `1d783cf7f`. No `git stash` was used.
- **Fix rounds read in full:**
  - T3: `auth.rs` `authenticate`/`AskingDevice`, `routes/codes.rs`, and the codes tests `a_check_after_the_touch_minute…` and `a_check_never_moves_last_seen…`.
  - T4: the `box_closed.rs` taken query and the index in `0010`.
  - T5: the `exception.rs` take-out queries and the late undo/clear tests (MB).
  - Task 8: `no_secrets_in_logs.rs` (the walk and the static test), AGENTS «Logs» and §19.
  - Except for Minor 6 (§19), they are true to the code.

---

## (b) TRIAGE

FIX = the final wave. DOC = text only, in the wave's documentation commit. CARRY = to the named plan. DROP = no action. OWNER = needs the owner's answer.

| Item   | Source                                                                                  | Decision                                 | Reason / target                                                                                                                                                                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1     | T2 review Minors 1–4                                                                    | see T2-1…T2-4                            | —                                                                                                                                                                                                                                                                                                                                            |
| Q2     | rejected receipts kept forever (owner decision 1)                                       | CARRY 2a6/ОЧ, РК                         | Kept. 2a6 already never resends under the same id; ОЧ resends refused records + their refused dependents under new ids in `seq` order; РК's `restore_hold` (503 `restore_pending` on facts and codes until resume) prevents permanent refusals after a restore.                                                                              |
| Q3     | 500 fails the whole batch (owner decision 2)                                            | CARRY 2a6 + FIX log (=T2-2)              | Kept. 2a6 classifies "host" apart from "offline" and caps records at 16 KiB.                                                                                                                                                                                                                                                                 |
| Q4     | distinct `(device_id, record_id)` in direct-insert tests                                | DROP                                     | Satisfied: one row per record, unique indexes in 0010, tests use distinct ids.                                                                                                                                                                                                                                                               |
| Q5     | `box_membership_digest` does not validate (T1-2)                                        | DOC                                      | `rules.rs` doc: its one caller reads live `box_items`, whose hashes passed `is_code_hash` and are distinct by `box_items_live`. The station sends only a digest. No `Result`.                                                                                                                                                                |
| Q6     | T3 changed `auth.rs`; `codes` = 8 tests                                                 | DEVIATION (c)                            | —                                                                                                                                                                                                                                                                                                                                            |
| Q7     | M15 equivalent (`rename_all` on `CodeCheck`)                                            | DROP                                     | `free`/`taken` are single words; the fixtures pin the tags.                                                                                                                                                                                                                                                                                  |
| Q8     | Task 8 must `GET` codes in the log walk                                                 | DROP (done)                              | The walk asks a taken hash, a free one and an upper-case one (400) and searches the log for all three.                                                                                                                                                                                                                                       |
| Q9     | `AskingDevice` read-only twin                                                           | DEVIATION (c)                            | Reviewed: correct. Its only user is `check_code`.                                                                                                                                                                                                                                                                                            |
| Q10    | SSCC check digit not verified (T4-1)                                                    | OWNER, recommend keep + CARRY ЧЗ/О-Х     | Decision 13 holds: the cloud ingest is the same, and a refusal cannot unprint a label. The integrity consequence is closed by `(block_id, serial)`. If wanted: detect-and-flag (`check_digit_ok` beside `digest_matches`) with a fixture shared with `buildSscc`, at the stage-4 card or the ЧЗ export, never a refusal.                     |
| Q11    | `closedAt < openedAt` accepted; close overwrites first-scan `opened_at` (T4-2)          | CARRY О-Х/О-Ф                            | Show both instants and flag an inverted pair.                                                                                                                                                                                                                                                                                                |
| Q12    | `itemCount` never compared; `digest_matches` stale (T4-3)                               | CARRY stage 4/О-Х, 2b + DOC              | Add to AGENTS «computed once, at close». Reports recompute from live items or join `code_conflicts`, and show `item_count_reported` beside the live count.                                                                                                                                                                                   |
| Q13    | block revoked before an offline close arrives (T4-4)                                    | CARRY 2b/РК                              | Revocation must keep serials used offline acceptable: revoke above a cursor, or accept `closedAt < revoked_at`.                                                                                                                                                                                                                              |
| Q14    | undo/clear match by instant (T5 fix)                                                    | DEVIATION (c) + OWNER confirm            | Trade-off: after the station clock steps back between a scan and its clear, the item stays live on the host (the cloud's `emptyBox` behaves the same).                                                                                                                                                                                       |
| Q15    | fact-shape requirement for undo/clear                                                   | CARRY 2a8/ОЧ                             | 2a6 binds `floor_codes.scanned_at` and `data.scannedAt` from one variable. 2a8's `undo` copies `codeHash` + `targetScannedAt` from that row byte-for-byte; `clear.occurredAt` = moment of the clear; ОЧ resends `data` byte-identical.                                                                                                       |
| Q16    | `release` never re-elects (T5-2)                                                        | CARRY 2b + DOC (Minor 7)                 | —                                                                                                                                                                                                                                                                                                                                            |
| Q17    | `digest_matches` stale after disassembly (T5-3)                                         | CARRY О-Х                                | Never show it for a disassembled box; show `disassembled_at`.                                                                                                                                                                                                                                                                                |
| Q18    | a later label check overwrites (T5-4)                                                   | CARRY stage 4, 2a7/2a8                   | Both columns can be set. A card orders the check against the latest `reprint` (`box_exceptions.occurred_at`). 2a7 does not rely on first-outcome.                                                                                                                                                                                            |
| Q19    | T5 Minor 1 (owners after undo)                                                          | DROP (done)                              | —                                                                                                                                                                                                                                                                                                                                            |
| T6-1   | test comment vs assertion; AGENTS sentence                                              | FIX test + DOC                           | Minor 5.                                                                                                                                                                                                                                                                                                                                     |
| T6-2   | `late_data_at` from `received_at` read before the lock                                  | FIX                                      | Minor 4 (production line + RED test).                                                                                                                                                                                                                                                                                                        |
| T6-3   | close-column invariants enforced only in handlers                                       | DOC (decision "handler-only")            | Two writers, both pinned by exact tests. Triggers would duplicate the six codes in SQL, need a parity test against `shift_close_reasons::ALL`, and add 0010 churn for no new protection. A rebuild CHECK is ruled out (FK parent). Record it in AGENTS «Shifts»/§19. Reopen if a third writer appears (IMP writes no shifts' close columns). |
| T6-4   | false "late data" from the station's own post-close facts                               | CARRY 2a7/2a8 + DOC (Minor 6)            | 2a7's `shiftLabelsSettled` gate and 2a8's test "no outbox record of a shift after its `shift_closed` in `seq`".                                                                                                                                                                                                                              |
| T6-5   | close authority = participation                                                         | CARRY 2b                                 | Decide `owner_device_id` vs participant when a second device can enter.                                                                                                                                                                                                                                                                      |
| T1-1   | `record_digest` depends on `serde_json/preserve_order` off                              | FIX optional (group C)                   | One line: `let mut canonical = record.clone(); canonical.sort_all_objects();`. Exists in the locked serde_json 1.0.151; a no-op today. The key-order test stays the pin. Otherwise DROP: the workspace feature union already makes the test fail loudly.                                                                                     |
| T1-2   | (=Q5)                                                                                   | DOC                                      | —                                                                                                                                                                                                                                                                                                                                            |
| T1-3   | `fixtures.rs:886` comment                                                               | FIX doc                                  | Minor 10.                                                                                                                                                                                                                                                                                                                                    |
| T1-4   | duplicated cross-language literals                                                      | DROP                                     | Drift risk only; both sides are checked against Python-computed values.                                                                                                                                                                                                                                                                      |
| T2-1   | ms precision within a second                                                            | FIX test                                 | Minor 3 (MG survives). No schema CHECK.                                                                                                                                                                                                                                                                                                      |
| T2-2   | 500 names no record                                                                     | FIX                                      | Minor 8.                                                                                                                                                                                                                                                                                                                                     |
| T2-3   | protocol bump rule                                                                      | DOC                                      | Minor 9.                                                                                                                                                                                                                                                                                                                                     |
| T2-4   | registry comment after release                                                          | DOC                                      | Minor 7.                                                                                                                                                                                                                                                                                                                                     |
| T3-1   | stale test comments                                                                     | DROP (done)                              | Commit `61501873f`.                                                                                                                                                                                                                                                                                                                          |
| T3-2   | unplanned `auth.rs` + counts                                                            | DEVIATION (c)                            | —                                                                                                                                                                                                                                                                                                                                            |
| T3-3   | M15                                                                                     | DROP                                     | =Q7.                                                                                                                                                                                                                                                                                                                                         |
| T4-1…4 | =Q10–Q13                                                                                | as above                                 | —                                                                                                                                                                                                                                                                                                                                            |
| T5-1…4 | =Q19, Q16–Q18                                                                           | as above                                 | —                                                                                                                                                                                                                                                                                                                                            |
| T7-1   | `acceptedUnits` ≠ cloud office number                                                   | FIX (decided)                            | Minor 1.                                                                                                                                                                                                                                                                                                                                     |
| T7-2   | closed shift's totals change through displacement from another shift, with no late mark | CARRY О-Х/О-В, 2b (OWNER)                | Cloud parity. Marking the displaced item's closed shift late changes `late_data_at` semantics and needs the owner; pilot impact is small (the same KM on two shifts is already a 2b anomaly). О-В must not promise byte-identical replays of a closed shift while this stands.                                                               |
| T7-3   | totals change without a revision                                                        | CARRY 2a3                                | 2a3's detail dialog reads on every open (`staleTime` 0). The list refetches on focus/interval or says "as of loading".                                                                                                                                                                                                                       |
| T7-4   | `lastFactAt` counts refused records                                                     | CARRY 2a3/О-Х                            | Label «Последние данные со станции» (2a3 already does). Never infer output or lateness from it.                                                                                                                                                                                                                                              |
| T7-5   | list cost; no host period cap                                                           | CARRY host pagination (2a3 «Перенесено») | Enforce 366 days on the host; re-check plans if `PRAGMA optimize` is added.                                                                                                                                                                                                                                                                  |
| T7-6   | fixture 540                                                                             | FIX with T7-1                            | 547 / 540.                                                                                                                                                                                                                                                                                                                                   |
| New    | `sscc = ?` half unpinned                                                                | FIX test                                 | Minor 2.                                                                                                                                                                                                                                                                                                                                     |
| New    | §19 own late facts                                                                      | DOC                                      | Minor 6.                                                                                                                                                                                                                                                                                                                                     |
| New    | 400 instead of 413 for an oversize body                                                 | DOC + CARRY 2a6                          | Minor 11.                                                                                                                                                                                                                                                                                                                                    |

**Proposed wave** (one fixer, in this order):

- **Commit 1, `test(standalone): …`** (RED where marked):
  - `unitsInClosedBoxes` in the totals test, the planned zeros (`facts.rs`, `office_shifts.rs`) and the proto empty-shape assertion. RED.
  - The same-second registry pair. Passes at once; kills MG.
  - The SSCC collision under a second prefix's block. Passes at once; kills MA.
  - `received_at` after the lock (pending-poll + clock advance). RED.
  - The lock-wait test made deterministic, with its comment fixed.
  - The 500's log line names the batch position, and the static count changes. RED.
- **Commit 2, `feat|fix(standalone): …`** (production):
  - `ShiftTotals.units_in_closed_boxes` + `office-shift.json` (547/540) + the sixth subquery.
  - `received_at` after `begin_write`.
  - The `error!` with the record's position in `routes/facts.rs`.
  - Optionally T1-1.
  - Mutants: units counting open, disassembled or displaced items; the clock read moved back; the log line dropped.
- **Commit 3, `docs(standalone): …`:**
  - AGENTS «Facts»: totals with labels, the revision sentence, the earliest-since-freed registry rule, `digest_matches` computed once, the protocol-bump rule, the 2 MiB → 400 clause.
  - AGENTS «Logs»: the batch line.
  - AGENTS «Shifts»: close columns handler-only.
  - §19: `unitsInClosedBoxes`, own late facts in one batch too, `received_at` after the lock, handler-only, the batch log line.
  - `registry.rs` and `0010` comments, the `fixtures.rs` comment, the `rules.rs` digest doc.
- **Gates:**
  - Focused `--test facts`, `--test office_shifts`, `--test codes` and `-p markiro-proto`; `--test no_secrets_in_logs` with the sandbox disabled.
  - fmt, `cargo check --all-targets` with 0 warnings, `git diff --check`, prettier on MD/JSON.
  - One `--workspace` run if the machine allows, since `ShiftTotals` is also read by the shell crate's fixture tests, if any.

---

## (c) Deviations to record in «Отклонения при исполнении» (Russian draft)

> **Задача 1.** Код и фикстуры — как в плане; сверх плана 7 тестов в `host/tests/fact_rules.rs` (12 вместо 5: секунда координации, 6- и 9-значные доли, годы 0000/9999, полноширинные и арабские цифры, повторы в дайджесте короба, порядок ключей отпечатка) и второй `describe` в `test/fact-rules.test.ts` (85 тестов). Совпадающие с доменом случаи сверх фикстур записаны литералами в обоих языках, а не общей фикстурой.
>
> **Задача 2.** Неопубликованная миграция `0010` усилена относительно плана: внешний ключ `scans.box_id → boxes`, проверки полей вердикта (`duplicate ⇔ duplicate_source`, `invalid ⇔ raw_kind <> 'km'`, поля кода все или ни одного, `length(code_hash) = 64`) и уникальные индексы `(device_id, record_id)` на `scans`, `box_exceptions`, `shift_close_events`. Ни один законный факт они не отвергают. Строка SQL `registry::owner` восстановлена с продолжениями строк. Документ `clock::format_timestamp` больше не называет свой формат единственным; в AGENTS «Facts» — абзац о двух форматах времени. Сверх плана 7 тестов.
>
> **Задача 3.** Вне списка файлов задачи изменён `host/src/auth.rs`: касание `last_seen_at` выполняется только когда минута истекла (даже `UPDATE` без совпавших строк берёт блокировку записи SQLite). По итогам проверки добавлен `AskingDevice` — двойник `AuthDevice` только для чтения (те же ключ, отзыв и вид, без касания `last_seen_at`); его использует только проверка кода, и это единственный маршрут устройства, который не ждёт писателя. Остальные маршруты касаются `last_seen_at` не чаще раза в минуту и первым запросом после каждой минуты могут ждать писателя. `--test codes` — 8 тестов вместо 3. Комментарии прямых вызовов в `device_shifts.rs`, `facts.rs`, `sscc_blocks.rs` исправлены отдельным коммитом.
>
> **Задача 4.** `sscc_taken` отвечает не только на тот же SSCC, но и на ту же серию того же блока при любой контрольной цифре; в неопубликованную `0010` добавлен уникальный индекс `boxes_block_serial (block_id, serial)`. Контрольную цифру хост по-прежнему не считает (решение 13; вопрос владельцу — в «Перенесено»). Абзац AGENTS стоит перед абзацем проверки кода (якорь плана сдвинулся). Сверх плана 9 тестов и помощники `sscc_under`, `sscc_off_by_a_digit`.
>
> **Задача 5.** Отклонение от SQL плана: `undo` снимает только живую позицию своего кода, добавленную ровно в `targetScannedAt`; `clear` — только живые позиции с `added_at <= occurredAt` (каноническое сравнение текста); `disassemble` — все. Исключение без совпадения принимается, ничего не снимает и хранится. Так поздняя повторная отправка под новым `id` (ОЧ) не снимает код, отсканированный после исключения. Цена (подтвердить владельцу): если часы станции отступили между сканом и очисткой, позиция на хосте остаётся живой — как в облачном `emptyBox`. Требование к станции: `codeHash` и `targetScannedAt` берутся из строки `floor_codes` без переформатирования, `occurredAt` очистки — её момент. Сверх плана 7 интеграционных тестов, юнит-тест `validate`, помощник `closed_and_open_box`, проверка владельцев после отмены.
>
> **Задача 6.** Код — как в плане; сверх плана 8 тестов (поля причины в событии и журнале, отсечение миллисекунд, не участники, гонка с закрытием офисом, откат пачки с закрытием, 14 точных отказов). Ожидания `--test codes` сдвинулись на тесты задачи 3.
>
> **Задача 7.** Тест итогов дописан в конец `facts.rs` (якорь сдвинулся); абзац AGENTS расширен (открытые и закрытые короба, вытеснение, целые секунды, порядок устройств, правило индексов). `--test facts` — 53, `--test office_shifts` — 23.
>
> **Задача 8.** Обход журнала шире плана: 25 записей всех видов, принятых и отвергнутых, повтор и несовпадающий повтор, проверка кода (занят, свободен, неверный хеш), итоги, закрытие офисом и поздний скан, ответ 500 (строка журнала вставлена напрямую), вторая смена, закрытая станцией. Сверх плана второй тест по исходникам: библиотека хоста ничего не печатает, а в пути фактов ровно два вызова журнала (`debug!`/`trace!`/`eprintln!` обход не видит). Уточнения записаны в §19, а не §16 (§16–§18 заняты планами 2a3, 2a4, 2a6 на других ветках; при слиянии номера сверить).
>
> **Счёт.** `cargo test --workspace` — 46 наборов, 603 теста (план — 556): хост 440 вместо 393 (`facts` 53, `codes` 8, `office_shifts` 23, `fact_rules` 12, `no_secrets_in_logs` 2, lib 58), `proto` 48, оболочка 115. Vitest — 68 файлов, 1829 тестов (ветка ушла вперёд; план — 1779). Под нагрузкой одиночный таймаут `test/template-editor.test.tsx`; отдельно с `--testTimeout=60000` проходит. Экранов этого файла план не касается.
>
> **Финальная волна** (дописать после исполнения): `ShiftTotals.unitsInClosedBoxes` (живые позиции в закрытых и не расформированных коробах, как облачное «Кодов в закрытых коробах»; фикстура 547/540); `received_at` пачки читается после блокировки записи; сбой пачки (500) пишет в журнал устройство и место записи в пачке; тесты одной секунды реестра и совпадения SSCC под блоком другого префикса; детерминированный тест ожидания блокировки; решение «инварианты колонок закрытия держат обработчики, не триггеры»; правки AGENTS, §19 и комментариев.

---

## (d) What could not be verified

- **The full host suite and `--workspace`.** Only focused targets were run: `facts` 53, `codes` 8, `office_shifts` 23, `fact_rules` 12, `no_secrets_in_logs` 2, `proto` 48. The 603/440 figure is Task 8's run.
- **Vitest.** Not run: no webview source changed, and Task 8 reported 1829 with one known timeout flake.
- **The planner's one-off failure** of `the_office_reads_a_shifts_totals_from_its_facts` in a `--workspace` run. Its output was not kept and it was not reproduced in my focused runs. Nothing in the test is time-dependent beyond the manual clock (20 minutes advanced, inside the 30-minute office idle limit), and its 64-try loop fails with probability 2^-64. Keep the output if it recurs.
- **Station behaviour.** No client sends facts yet. Plan 2a8 does not exist, so the `undo`/`clear`/`disassemble`/`shift_closed` builders, `clear.occurredAt` and the post-close `seq` test are unverifiable.
- **Field conditions.** Not tested: the 300 ms code-check bound on a factory network, throughput on a factory PC, totals cost at the volume of a real shift, Windows, the host service, and CI `standalone-rust` / `standalone-windows-build` (both need a push).
- **The log fences have blind spots:**
  - The walk sees only `info` and above in the file.
  - The static test counts the text `tracing::` in 12 facts-path files. A payload inside `ApiError::internal(format!(…))` on a path the walk does not drive (only the scans INSERT 500 is driven) would escape both.
  - Reviewers must keep `ApiError::internal` arguments to error values, never request data.
- **Owner answers pending:** the check digit (Q10), the clock-step trade-off of `clear` (Q14), cross-shift displacement of a closed shift (T7-2), and the handler-only decision (T6-3, recommended).

---

## (e) What other plans must know

- **2a3 (office):**
  - `totals` is in EVERY `OfficeShift` (list, detail, every write answer), fixture `office-shift.json`. 2a3's draft expects it on the detail only and a fixture `office-shift-detail.json` that does not exist; its Step 0 stops there.
  - After the wave, add `unitsInClosedBoxes`.
  - Labels: «Принято кодов»/«Принято единиц» for `acceptedUnits`, never «в коробах»; «Кодов в закрытых коробах» for the new number; «Последние данные со станции» for `lastFactAt` (refused records count).
  - Totals change without a revision, so the list must not rely on streams.
  - The host has no period cap on the list (pagination carry).
- **2a6 (floor sender):**
  - The contract matches. Fix the 413 assumption: an oversize body is 400 `validation_failed`.
  - Any 400 on a well-formed batch wedges the outbox and can only be a host bug. A 500 names the record's position in the host log after the wave.
  - `canonical` may hold control characters but not NUL; `serial` holds no control characters; `canonical` ≤ 1024 bytes, `serial` ≤ 64 bytes (host per-record limits under the 16 KiB cap).
  - The facts route still touches `last_seen_at` once a minute and may wait; only the code check never waits.
- **2a7 (printing):**
  - A `box_label` overwrites its own column, so both `print_verified_at` and `print_skipped_at` can be set.
  - A `reprint` of a disassembled box is `box_state`, refused forever: 2a7/2a8 must not offer «Напечатать снова» with a reason for a job whose box was taken apart.
  - Any accepted record after `shift_closed` in `seq`, in the same batch too, marks the shift late.
- **2a8 (exceptions, shift close):**
  - `undo` = `codeHash` + `targetScannedAt` copied byte-for-byte from `floor_codes`; `clear.occurredAt` = the clear's moment; `reasonText` optional for `other` (if sent: trimmed, 1–200 characters, no control characters); `alreadyClosed` on `shift_closed`.
  - Write the `seq` test: no record of a shift after its `shift_closed`.
- **ПЛ-Х:**
  - Re-anchor on the post-wave HEAD: `ShiftTotals` gains `unitsInClosedBoxes`, and the totals `SELECT` gains a sixth subquery, so ПЛ-Х's `closedPallets`/`openPallets` fragments shift.
  - Keep `box_closed.rs`'s `sscc = ? OR (block_id = ? AND serial = ?)` intact (the wave pins its first half). Its pallet taken-query should keep the same two halves.
  - Protocol 3 for the new kinds and `palletId` matches the rule written in the wave.
  - РК's `hello-restored.json` (`protocol: 2`) goes stale when ПЛ-Х bumps.
  - The `legacy_code_owners` ownership is circular between ПЛ-Х and IMP (П7).
- **ЧЗ:**
  - The host never verifies the SSCC check digit; the station's `buildSscc` is the guarantee. If ЧЗ documents need verification, the export detects and flags, it does not refuse.
  - `scans.canonical` keeps the crypto tail (the station sends `km.raw`). It stays in the host database and in every backup, and never in the process log.
- **РК:**
  - `restore_hold` (503 `restore_pending` on facts and codes) is what keeps receipts from becoming permanent refusals after a restore; keep it in front of both routes.
  - `fact_receipts`, `scans`, `box_items` and `code_conflicts` grow without retention, and receipts are kept forever by decision, so backup size and disk space grow linearly (stage-5 monitoring).
  - After a restore, a box whose opening scans were lost answers `box_unknown` forever to its close: РК-С must resend from the box's first scan under new ids.
  - Re-registered blocks keep `id = request_id`, so `boxes.block_id` stays valid.
- **IMP:**
  - No 0010 writes (refused on a non-empty site).
  - If `legacy_code_owners` is ever imported into the registry, its `scanned_at` must be 24-character device instants, or text order stops being instant order.
- **2b:**
  - A release never re-elects an owner.
  - A block revoked before an offline close arrives refuses that close.
  - Close authority with several participants.
  - The displaced device's notification and the `code_conflicts` review.
  - Cross-shift displacement of a closed shift's items with no late mark (T7-2).
  - The host's block-issue limit (2a1 queue item 19).
- **Stage 4, О-Х/О-В/О-Ф:**
  - `digest_matches` is computed once at close: recompute from live items, never show it for a disassembled box.
  - Flag `closedAt < openedAt`.
  - Order the label check against the latest `reprint`.
  - `late_data_at − closed_at` is no measure of lateness: device clock against host clock, and the arrival time before the wave.
  - List the late facts from `fact_receipts` (`(shift_id, received_at)` index) rather than trusting the one-time flag.
  - The check-digit flag, if the owner wants it.
