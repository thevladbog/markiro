# plan hp, Task 5 report — host tests: release and rescan in one batch, consumption of blocks

Status: DONE_WITH_CONCERNS (known failures only; one pre-existing flake noted)
Commit: a8558af61 `test(standalone): the host keeps codes freed and scanned again in one batch, and the scenario pins the blocks' use` (branch claude/m1, BASE 4a6856785). Host sources unchanged (Д6); only the two test files.

## What was done

- `host/tests/facts.rs`: `codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan` (brief verbatim, appended): 13 records in one batch (disassemble + rescan into another box, clear + rescan, undo + rescan); all accepted, no conflict, registry owned by the new scans, per-box items, replay returns the same receipts and `fact_rows` unchanged.
- `host/tests/floor_scenario.rs`: helper `consumed` and the assertion `consumed == [(0, Some(1502)), (1, Some(41))]` in `the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers`.
- No RED phase possible: host behaviour already correct (brief: Д6). Mutants below serve as the RED proof. Both tests passed first time (`/tmp/claude/hp5-g1.txt`, `/tmp/claude/hp5-g2.txt`).

## Mutants (script /tmp/claude/impl-hp-t5/mut.py, outputs /tmp/claude/impl-hp-t5/*.out; every file restored: sha256 equal before/after, `cmp` identical to the pre-mutation copy, `touch`ed)

| #                   | One-line mutant of host code                                                             | Killed by                                                                                                                                                                                                              | Key                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A1 (brief H1)       | exception.rs: `registry::release(...)` removed                                           | new batch test                                                                                                                                                                                                         | receipts 5,6,10,13 are `conflict` instead of `accepted` (facts.rs:7446) |
| A2                  | exception.rs: undo selects `added_at <> ?`                                               | new batch test                                                                                                                                                                                                         | receipt 13 `conflict`                                                   |
| A3                  | exception.rs: clear selects `added_at > ?`                                               | new batch test                                                                                                                                                                                                         | receipt 10 `conflict`                                                   |
| A4                  | exception.rs: disassemble takes nothing (`AND 0`)                                        | new batch test                                                                                                                                                                                                         | receipts 5,6 `conflict`                                                 |
| A5                  | exception.rs: taken-out items set `displaced_at` instead of `removed_at`                 | new batch test                                                                                                                                                                                                         | box 1 items assertion (facts.rs:7457)                                   |
| A6                  | routes/facts.rs: batch applied scans first, exceptions last (the cloud's #650 bug shape) | new batch test                                                                                                                                                                                                         | conflicts on 5,6,10,13 and receipts out of order                        |
| A7                  | registry.rs: `release` deletes `scan_id <>` (other owners)                               | new batch test                                                                                                                                                                                                         | conflicts on 10,13                                                      |
| A8                  | facts/mod.rs: a stored record is applied again before its stored receipt is returned     | new batch test                                                                                                                                                                                                         | replay answers 500 `internal` (support/app.rs:619)                      |
| A9                  | facts/mod.rs: stored digest never matches                                                | new batch test                                                                                                                                                                                                         | replay receipts differ (facts.rs:7498)                                  |
| S1 (brief H2 / HM2) | pallet_closed.rs: `blocks::consume` removed                                              | floor_scenario scenario                                                                                                                                                                                                | `(1, None)`                                                             |
| S2                  | box_closed.rs: `blocks::consume` removed                                                 | floor_scenario scenario                                                                                                                                                                                                | `(0, None)`                                                             |
| S3                  | blocks.rs: `max(...)` -> `min(...)`                                                      | floor_scenario scenario                                                                                                                                                                                                | `(0, Some(1500))`                                                       |
| S4                  | blocks.rs: consume writes the last serial (no max)                                       | NOT killed by the scenario (closes arrive in ascending order); killed by two existing `--test facts` tests (`a_box_closes_with_an_sscc_of_its_devices_block...`, `one_sscc_closes_one_box_whichever_arrives_first...`) | the "never lower" rule is pinned there                                  |
| S5                  | blocks.rs: consume writes serial+1                                                       | floor_scenario scenario                                                                                                                                                                                                | values off by one                                                       |

Honest gap: the final "nothing written again" check (`fact_rows` equal after the replay) is not independently killed by any one-line host mutant I could construct: the replay mutants A8/A9 are already killed earlier by the receipts/500 assertions. It remains a belt-and-braces check, as the plc review noted.

## Gates

- `cargo fmt --all -- --check` 0; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `git diff --check` clean; no `\u0` in the changed Rust files; `git status --short` empty after the commit.
- Focused: `--test facts <new>` 1 passed; `--test floor_scenario` 5 passed.
- Final full `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed: 1128 passed, 0 failed (expected >= 1127).
  - The first full run (without `--no-fail-fast`) hit one failure in an EXISTING test, `the_office_reads_a_shifts_totals_from_its_facts` (facts.rs:7055 `assert!(other > floor.station)`): it draws up to 64 random device UUIDs hoping one sorts after the station's, so it is a probabilistic flake (not touched by this task; it passed in the second full run and when the target file ran in the mutant runs). Concern for the controller: it can fail when the station's random id sorts very high.
- Parity: `export-parity.test.ts` all pass; `forms-parity.test.ts` 3 failed (placard-a4, placard-a5-disassembled, shift-placards-a5): the KNOWN `ПАЛЕТА`/`ПАЛЛЕТА` failures, not touched. Vitest totals of the two files: 250 passed, 3 failed.
- The 3 domain `print-forms-snapshot` failures (same cause) were not run here (domain untouched).

## Anchor adaptations

None; both floor_scenario fragments matched exactly once; the facts.rs test appended at the end. `cargo fmt` reflowed nothing semantically.

## Self-review / concerns

1. Known failures: 6 tests (ПАЛЕТА vs ПАЛЛЕТА; 3 here in forms-parity).
2. Pre-existing flake in `the_office_reads_a_shifts_totals_from_its_facts` (see above).
3. S4 is not killed by the scenario itself; no addition made because existing tests cover it.
