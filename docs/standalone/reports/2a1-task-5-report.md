# Plan 2a1, Task 5 report: a station enters a shift

Status: DONE. BASE 2481310f4b5af8ea973988799e22c8026541d427, commit e0b31018b
"feat(standalone): a station enters a shift; the host opens it and freezes its snapshot"
(trailer: the single Opus 5.5 line the rules pin; the system reminder's Sonnet line was not used).

## What was done

Plan steps 1-5 applied verbatim (all anchors matched once, including the patched AGENTS.md anchor; the added
"a retry after the office deleted it plans a new shift" sentence is kept). Step 6 (M1-M3) run, plus about 50 extra
mutants. Five extra host tests were added in tests/device_shifts.rs (see below). No manifest, lockfile, migration,
src-tauri or src/ file touched; no TS touched (so no Vitest runs).

## RED (before step 3)

- host: `device_shifts`: 5 passed, 3 FAILED (entering_a_planned_shift..., a_plan_that_no_longer_fits..., a_shift_takes_one_station...):
  "no route for POST /v1/device/shifts/<id>/enter" (404). Output: /tmp/claude/2a1t5/red-host.txt.
- proto: does not compile: E0609 no field `snapshot` on `DeviceShift`, E0560 struct has no field named `snapshot`.

## GREEN

- host `--test device_shifts`: 8 passed (the plan's 3 new + 5 earlier; the brief says 7), 13 after my 5 extra tests.
- proto: 5 unit + 38 fixture tests = 43 (matches the brief).
- Full `cargo test -p markiro-host -p markiro-proto --offline --locked`, sandbox disabled: exit 0, 0 failures,
  host 339 tests, proto 43 (brief: host 328, proto 43; host is shifted by earlier tasks' extras plus my 5).
- `cargo fmt --check` clean; `cargo check ... --all-targets --offline --locked` 0 warnings; prettier on the two
  fixtures and AGENTS.md clean; `git diff --check` clean; no literal \\u0 in the Rust/JSON files I wrote.

## Extra tests (the plan's tests let mutants survive)

1. an_entry_names_the_first_rule_it_breaks_and_the_owner_keeps_its_shift: guard order (line before product_inactive,
   product_inactive before template_not_fit, busy before the plan check, line before busy, shift_status before line for
   off-line stations and unassigned ones, owner moved to another line gets shift_line); handheld is forbidden; the owner
   re-enters after the product was archived and the template disabled and gets the same snapshot with no revision and no
   audit row; refusals write nothing; the station's list carries no `snapshot` key.
2. a_station_shift_without_a_counterparty_opens_on_a_template_that_names_its_group: station-made shift (/S in the
   audit number), counterpartyName null in snapshot and response, template with codes [15, 8] opens, whole snapshot and
   audit row compared (template rev from the PUT answer).
3. a_template_deleted_behind_the_plan_does_not_open_it: template row gone (SQL) gives template_not_fit, not 500.
4. a_layout_of_the_largest_size_is_frozen_whole: 256 KiB compact Cyrillic spec fits the 320 KB CHECK; snapshot spec equals it, re-entry identical.
5. two_stations_entering_together_leave_one_owner: tokio::join! of two stations: one 200, one shift_busy, one participant, one shift.open row.

## Mutants (all killed; each restored with cmp silent and sha256 equal; harness /tmp/claude/2a1t5/mut.py, outputs mut-_.txt, summaries mut-summary_.txt)

Plan: M1 second station enters (device_shifts: a_shift_takes_one_station..., an_entry_names..., two_stations...);
M2 line unchecked (a_shift_takes_one_station..., an_entry_names...); M3 fits replaced by Some(_) (a_plan_that_no_longer_fits...).
Mine (test that failed):

| mutant                                                                                                                                                         | killed by                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| X1 require_station dropped                                                                                                                                     | a_shift_takes_one_station..., an_entry_names...                                          |
| X2 closed check dropped                                                                                                                                        | a_shift_takes_one_station..., an_entry_names...                                          |
| X3 closed check after line check                                                                                                                               | an_entry_names... (plan tests missed it)                                                 |
| X4 busy before line                                                                                                                                            | an_entry_names... (plan tests missed it)                                                 |
| X5 station without a line passes the line check                                                                                                                | a_shift_takes_one_station..., an_entry_names...                                          |
| X6 re-entry stamps first_entered_at                                                                                                                            | entering_a_planned_shift...                                                              |
| X7 re-entry does not stamp last_entered_at                                                                                                                     | entering_a_planned_shift...                                                              |
| X8 re-entry recomputes the snapshot                                                                                                                            | entering_a_planned_shift..., an_entry_names...                                           |
| X9 re-entry re-runs the product/template check                                                                                                                 | an_entry_names... (plan tests missed it)                                                 |
| X10 re-entry takes a revision                                                                                                                                  | entering_a_planned_shift..., an_entry_names...                                           |
| X11 re-entry writes an audit row                                                                                                                               | entering_a_planned_shift..., an_entry_names...                                           |
| X12 shifts.rev not stamped on opening                                                                                                                          | entering_a_planned_shift...                                                              |
| X13 wrong opened_at                                                                                                                                            | entering_a_planned_shift...                                                              |
| X14 / X15 wrong participant last / first entry                                                                                                                 | entering_a_planned_shift...                                                              |
| A1 action, A2 target_type, A3 target_id, A4 outcome, A6 templateId, A7 templateRev, A8 actor, A9 details key                                                   | entering_a_planned_shift..., a_station_shift_without_a_counterparty...                   |
| A5 /S dropped from audit number (station origin)                                                                                                               | a_station_shift_without_a_counterparty... (plan tests missed it)                         |
| S1 purpose Box to Pallet                                                                                                                                       | seven tests incl. entering_a_planned_shift...                                            |
| S2 template category None instead of group                                                                                                                     | a_station_shift_without_a_counterparty... (plan tests missed it)                         |
| S3 archived not checked                                                                                                                                        | a_plan_that_no_longer_fits..., an_entry_names...                                         |
| S4 status not checked                                                                                                                                          | a_plan_that_no_longer_fits...                                                            |
| S5 product id, S6 gtin14, S7 name, S8 print_name, S9 group, S10 shelf life, S11 template id, S12 template name, S13 template rev, S15 issuer prefix, S20 rev+1 | entering_a_planned_shift... and/or a_station_shift_without_a_counterparty...             |
| S14 spec replaced by {}                                                                                                                                        | entering_a_planned_shift..., a_station_shift_without..., a_layout_of_the_largest_size... |
| S16 counterparty name always None                                                                                                                              | entering_a_planned_shift...                                                              |
| S17 shift_busy constraint renamed                                                                                                                              | a_shift_takes_one_station..., an_entry_names..., two_stations...                         |
| S18 template_not_fit renamed                                                                                                                                   | a_plan_that_no_longer_fits..., a_template_deleted...                                     |
| S19 missing template passes                                                                                                                                    | a_template_deleted_behind_the_plan...                                                    |
| P1 DeviceShift.snapshot serialised as null in lists                                                                                                            | a_station_creates_a_shift..., a_station_sees_the_open_shifts..., an_entry_names...       |
| P2 route renamed                                                                                                                                               | eight tests                                                                              |
| A5 and S16 first failed to compile (scratch-mutant typing); redone with typed variants (summary2).                                                             |
| Not mutable: the "product has no group" arm of the active check (an active product always has one) and the internal "vanished" errors.                         |

## Files

apps/standalone/host/src/{audit.rs,server.rs,shifts.rs,routes/device_shifts.rs}, host/tests/device_shifts.rs,
proto/src/lib.rs, proto/tests/fixtures.rs, proto/fixtures/{device-shift-entered,error-shift-busy}.json, apps/standalone/AGENTS.md.

## Self-review and concerns

- The checker's 3 NO MATCH were not run by me; expected per dispatch.
- The sandbox was disabled only for the full run (127.0.0.1 binds); mutant runs were in the sandbox.
- Not exercised: Windows, a real station; the host never validates the layout (documented).
- The concurrency test depends on begin_write serialising writers (it passes with it).
- Used a one-time `cd` into /tmp for editing the scratch harness; no stray .cc-writes in the repo (git status clean).

## Fix round: review findings 1 (Important) and 2 (Minor)

Tests only; `host/src/` untouched (`routes/device_shifts.rs` sha256 `aaad9757...efcef` before and after every mutant, `cmp` against `/tmp/claude/fix5/device_shifts.rs.orig` silent).

- **Finding 1.** `entering_a_planned_shift_opens_it_and_freezes_its_snapshot` subscribes to `state.revisions` before the entry and asserts `has_changed()`, the value 6 (watch and `borrow()`) after the opening; after the owner's re-entry (and after a `borrow_and_update()` that drops the wake of the intervening catalog/template/org edits) it asserts `!has_changed()` and the value unchanged.
- **Finding 2.** New `an_entry_waiting_for_the_write_lock_sees_the_entry_that_held_it`: the test holds `begin_write`, writes a colleague's opening (active, owner, snapshot, participant) inside it, calls `enter_shift` and asserts it is still pending after 200 ms, commits, and asserts `409 shift_busy`, one participant (the colleague), no `shift.open` audit row. The handler is called directly (`State`, `AuthDevice`, `ApiPath`, the pattern of `tests/commit.rs`), because through the router the device authentication's `UPDATE devices SET last_seen_at` (it takes the write lock even when it matches no row) waits for the lock before the handler opens its transaction, and the deferred mutant then passed (first attempt: the mutant survived with the router version). The station id is read before the lock is taken for the same reason. `two_stations_entering_together_leave_one_owner` is kept unchanged.

| #   | Mutant (one line)                                                                                | Result                                                                                                                                                                                                                                    | Restore                |
| --- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A   | `routes/device_shifts.rs:381` `commit_with_revision(tx, &state.revisions, rev)` -> `tx.commit()` | killed: `entering_a_planned_shift...` at `assert!(wake.has_changed().unwrap())` (13 passed, 1 failed)                                                                                                                                     | sha256 and `cmp` equal |
| B   | `:274` `begin_write(&state.pool)` -> `state.pool.begin()` (deferred), 6 runs                     | killed 6/6 by `an_entry_waiting_for_the_write_lock...` ("the entry answered while another writer held the lock", the read ran before the lock and the write failed at once); the old two-stations test survived 5 of 6 on the same mutant | sha256 and `cmp` equal |

- GREEN: `cargo test -p markiro-host --test device_shifts --offline`: 14 passed (13 before + 1). RED for finding 1 was mutant A; RED for finding 2 mutant B.
- `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, `git diff --check` clean. Full host run not done (about 20 minutes, out of scope).
- Finding 3 (typed re-serialization of the stored snapshot) not touched: queued for the final wave.
