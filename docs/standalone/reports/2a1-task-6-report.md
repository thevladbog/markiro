# Plan 2a1, Task 6 report: the office closes an active shift

Status: DONE (one note under Concerns). BASE 403ed99392f634438f1da95c7978f94d9a64adf0, commit ab4978911.

## What was done

Plan steps 1-5 applied in order, anchors matched once each, no improvisation:

- `POST /v1/office/shifts/{id}/close` (`office_shifts::close_shift`, route in `server.rs`), `audit::actions::SHIFT_CLOSE`, `validate::close_reason`, `markiro_proto::ShiftClose` (`deny_unknown_fields`), fixture `proto/fixtures/shift-close.json`, proto fixture test, AGENTS.md «Shifts» paragraph.
- Two lines of the module doc in `office_shifts.rs` were re-wrapped to 80 columns (the plan's text left one line over-long); no semantic change.
- Own extra tests (the plan's two tests let several mutants survive): four new tests in `host/tests/office_shifts.rs` (list below).

## RED / GREEN

- RED host: `cargo test ... -p markiro-host --test office_shifts` gave 15 passed, 2 failed (`the_office_closes_an_active_shift_with_its_reason`, `only_an_active_shift_closes_and_only_with_a_reason`). The brief says 2 of 13 (11 earlier pass); this tree has 15 earlier tests.
- RED proto: `error[E0432]: unresolved import markiro_proto::ShiftClose`.
- GREEN host `--test office_shifts`: 21 passed (15 + 2 plan + 4 mine; brief: 13). GREEN proto: 5 unit + 39 fixtures (brief: 5 + 39).
- Full run, outside the sandbox, `cargo test ... -p markiro-host -p markiro-proto --offline --locked`: exit 0, 0 failures. Host 346 (brief: 330; the difference is earlier tasks' extra tests, 15 vs 11 in this file earlier, plus my 4), proto 44 (brief: 44).
- `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, prettier on `shift-close.json` and `AGENTS.md` clean, `git diff --check` clean, `\u04` grep only `pairing-code.ts:66`. The only `\u{..}` in the Rust tests are intentional escapes (U+0085, U+007F, U+00A0). No Vitest/TS files touched, so no vitest/typecheck run. `git status --short` is empty after the commit.

## Tests added beyond the plan (all in `host/tests/office_shifts.rs`)

1. `a_close_writes_only_the_closing_columns_and_wakes_the_streams`: 23 other columns of the shift unchanged (snapshot, owner, opened_at, late_data_at...), a bystander shift unchanged, counters and participants unchanged, exactly one audit row more, `state.revisions` wakes with the close's revision (`has_changed`, value, current), `rev` of the answer equals it, GET equals the answer.
2. `a_reason_is_trimmed_counted_in_characters_and_free_of_control_characters`: rejects "", whitespace-only, 1 char, `\n`, U+0085, U+007F, 501 chars with and without padding, non-string reasons (array, null, number); `reason` bad before the shift lookup (400, not 404); unknown field `reasonCode`, missing and string `expectedRev` are 400; nothing written. Accepts and stores trimmed: exactly 3 Cyrillic chars, interior space, 500 chars with padding, NBSP inside; the audit `details.reason` is the stored text.
3. `the_state_machine_and_the_revision_decide_before_anything_is_written`: stale revision on a planned and on a closed shift is `stale_revision` (revision is checked before status), the right revision gives `shift_status` with the status named, a deleted shift is 404; nothing written, the planned shift's columns unchanged.
4. `a_technologist_closes_in_their_name_and_a_user_turned_off_or_a_device_cannot`: a device key alone gets 401 `credential: session`; a user turned off after the extractor passed is refused in the transaction with no revision or audit row; another technologist closes and the audit row (exact actor, target, result, details) and `closed_by`/`closed_by_kind` name them.

## Mutants (each run on `--test office_shifts`; restored byte-identical, sha256 compared before and after, all `restored: True`)

| Mutant                                                                      | Failing tests                                                                           | Caught by plan tests alone?          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------ |
| M1 `!= Active` -> `== Closed` (planned closes)                              | only_an_active_shift_closes..., state_machine...                                        | yes (plan M1)                        |
| M1b `!= Active` -> `== Planned` (closed closes again)                       | the_office_closes..., state_machine...                                                  | yes                                  |
| M2 min `>= 1`                                                               | reason_is_trimmed..., only_an_active_shift...                                           | yes (plan M2)                        |
| M2b min `>= 2`                                                              | same two                                                                                | yes                                  |
| M2c min 4 chars                                                             | reason_is_trimmed... only                                                               | NO (exact 3 never accepted): my test |
| M3 max 501 / M3b max 499                                                    | reason_is_trimmed..., only_an_active_shift...                                           | yes                                  |
| M4 no trim                                                                  | reason_is_trimmed..., only_an_active..., the_office_closes...                           | yes                                  |
| M4b validate on trimmed, return the raw text                                | reason_is_trimmed..., the_office_closes...                                              | yes                                  |
| M5 byte length, no control check                                            | reason_is_trimmed..., only_an_active...                                                 | yes                                  |
| M5b char count, no control check                                            | same                                                                                    | yes                                  |
| M6 drop the stale-revision check                                            | only_an_active..., state_machine...                                                     | yes                                  |
| M6b stale check after status check                                          | state_machine... only                                                                   | NO: my test                          |
| M7 drop `require_shift_planning_in`                                         | technologist_closes...turned_off                                                        | NO: my test                          |
| M8 `closed_by_kind = 'device'` / M8b `closed_by` = shift id                 | the_office_closes..., technologist_closes...                                            | yes                                  |
| M9 store raw reason / M10 audit raw reason                                  | reason_is_trimmed..., the_office_closes...                                              | yes                                  |
| M11 audit details key changed                                               | reason_is_trimmed..., the_office_closes..., technologist_closes...                      | yes                                  |
| M12 close also clears `owner_device_id`                                     | close_writes_only_the_closing_columns                                                   | NO: my test                          |
| M13b sets `late_data_at` / M13c clears `snapshot` / M13d clears `opened_at` | close_writes_only_the_closing_columns                                                   | NO: my test                          |
| M14 plain `tx.commit()` (no revision wake)                                  | close_writes_only_the_closing_columns                                                   | NO: my test                          |
| M15 stamp the old `rev`                                                     | close_writes_only..., the_office_closes...                                              | yes (via rev 5)                      |
| M16 `closed_at` not now                                                     | the_office_closes...                                                                    | yes                                  |
| M17 also sets `close_reason_code`                                           | the_office_closes...                                                                    | yes                                  |
| M18 skip `close_reason` validation (trim only)                              | reason_is_trimmed..., only_an_active...                                                 | yes                                  |
| M19 audit action string `shift.closed`                                      | reason_is_trimmed..., the_office_closes..., technologist_closes...                      | yes                                  |
| P1 drop `deny_unknown_fields` on `ShiftClose`                               | proto `a_shift_close_carries_the_reason_and_the_revision` and host reason_is_trimmed... | yes                                  |

(M13 `late_data_at = closed_at` was an equivalent mutant: SQLite evaluates the right side with the old, NULL, value; replaced by M13b.)

Not mutable to a failing test (equivalent): deleting the early `require_shift_planning()` call. `OfficeRole` has only Admin and Technologist and both plan shifts, so the early check cannot refuse anyone; the in-transaction re-check (M7) is the effective guard and is covered.

## Concerns

- Not exercised, by design: concurrent closes (serialised by `begin_write`), station-side behaviour after an office close (plan 2a2), the `late_data_at` marking (2a2).
- A rejected-before-lookup order (bad reason on an unknown shift gives 400, not 404) is now pinned by my test; if the owner prefers 404 first, that test line changes together with the route.

## Files

- Modified: `apps/standalone/host/src/routes/office_shifts.rs`, `host/src/validate.rs`, `host/src/audit.rs`, `host/src/server.rs`, `host/tests/office_shifts.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `apps/standalone/AGENTS.md`.
- Created: `apps/standalone/proto/fixtures/shift-close.json`.
- Untouched: manifests, lockfiles, migrations.

## Fix round (review Important 1, Minor 3)

Base `ab4978911`. Production code untouched.

- `host/tests/office_shifts.rs`: in `a_close_writes_only_the_closing_columns_and_wakes_the_streams` the bystander is now ACTIVE (`open_directly`) and its WHOLE row (new helper `whole_row`: every column from `pragma_table_info('shifts')`, so `status`, `rev`, `closed_*`, `close_reason_text` are compared) is equal before and after the close; the bystander's `status` is asserted `active` first. The closed shift's own `status` is asserted `closed` and `rev` equals the close's revision. The tautological `"status IS NOT NULL"` entry is removed from `untouched_columns` (24 -> 23 columns).
- `apps/standalone/AGENTS.md`: the `shift.close` audit row with `{ reason }` (trimmed) and the refusal order (bad reason 400 even for an unknown id, then 404, then `stale_revision`, then `shift_status`, as in `PUT`) are stated; wrapped at 80, prettier clean.
- GREEN: `--test office_shifts` 21 passed (same count; one test strengthened). fmt, `cargo check --all-targets` (0 warnings), prettier, `git diff --check` clean.

| Mutant                                                                        | Result                                                                                                                                                                                                                         | Restore proof                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| UPDATE `WHERE id = ?` -> `WHERE id = ? OR status = 'active'` in `close_shift` | KILLED: `a_close_writes_only_the_closing_columns_and_wakes_the_streams` fails at the bystander whole-row `assert_eq` (bystander shows `status: closed`, `rev: 6`); 20 passed, 1 failed. Before the fix it survived (21 passed) | route file copied to `/tmp/claude/route_base.rs` before, `cmp` silent and `shasum -a 256 -c` OK after |

The planned-bystander case is no longer the only guard: the active bystander compares every column.
