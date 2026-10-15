# Plan 2a1, Task 1 report — shift number, shared fixture, `ShiftOrigin`

Status: DONE_WITH_CONCERNS (one deviation: a 4th host test added; see Concerns).
BASE: 5ea7da95038a459f63ceab29768af213c47c5dda. Commit: a3284f712 `feat(standalone): the host's shift number, shared with the domain through a fixture` (trailer verified: one `Co-Authored-By: Claude Opus 5.5` line).

## What was done

Steps 1-7 of the brief applied verbatim and in order: `host/src/shifts.rs` (civil_date, month_key, month_key_of, format_number), `pub mod shifts` in `host/src/lib.rs`, `ShiftOrigin` in `proto/src/lib.rs` (+ `shift_origins()` list and parse/serde/error assertions in the proto tests), `proto/fixtures/shift-numbers.json` (22 dates, 5 numbers), `host/tests/shift_numbers.rs`, `test/shift-numbers.test.ts`, and the «Shifts» section of `apps/standalone/AGENTS.md`. All anchors matched exactly once. No manifests, lockfiles, migrations or other crates touched.

## RED

- `cargo test -p markiro-host --test shift_numbers`: `error[E0432]: unresolved import markiro_host::shifts` and `unresolved import markiro_proto::ShiftOrigin` (log /tmp/claude/2a1t1/red-host.txt).
- `cargo test -p markiro-proto`: `error[E0432]: unresolved import super::ShiftOrigin` (+ E0282) (red-proto.txt).
- Vitest `test/shift-numbers.test.ts` before the Rust change: 28 passed (domain already follows the rule), as the plan expects.

## GREEN

- host `--test shift_numbers`: 3 passed (plan) -> 4 passed with my extra test.
- proto: 5 unit + 34 fixture tests passed (matches plan).
- Vitest file: 28 passed; `--reporter=verbose`: stderr empty (0 bytes), 28 checkmarks; under the delayed-`setImmediate` stand: 28 passed (stand files removed by the script; `git status` clean of them).
- Full package gates: `typecheck` 0, `lint` 0, `test` 67 files / 1744 tests passed. `eslint test/shift-numbers.test.ts` 0, `prettier --check` (fixture, test, AGENTS.md) clean, `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets --offline` 0 warnings, `git diff --check` clean, `\u0` grep: only `src/host/pairing-code.ts:66`.
- Outside the sandbox: `cargo test -p markiro-host -p markiro-proto --offline --locked`: 31 result lines, all ok, 0 failed, 350 passed in total = 39 proto + 311 host (plan: 310 host, 39 proto; +1 is my extra test).

## Mutants (all reverted byte-identically; `cmp` against /tmp/claude/2a1t1/{shifts,proto}.orig silent after each; sha256 of shifts.rs before = after `3bf2a996…ed272c`; proto sha before/after file sha-before/after.txt identical)

| #   | Mutant (one line)                                      | Failing test                                                                                                                           | Key line                                                       |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| M1  | `{seq:03}` -> `{seq}`                                  | every_number_of_the_fixture_matches                                                                                                    | left "AUG26-3" right "AUG26-003"                               |
| M2  | delete `if year == 0 { return None; }`                 | the_year_zero_is_no_civil_date                                                                                                         | left Some(0000-01-15) right None                               |
| M3  | station suffix `"/S"` -> `""`                          | every_number_of_the_fixture_matches                                                                                                    | left "OCT26-004" right "OCT26-004/S"                           |
| M4  | swap "JUN","JUL" in the month table                    | every_month_key_of_the_fixture_matches                                                                                                 | left "JUN99" right "JUL99"                                     |
| M5  | drop the two separator checks (`bytes[4]`, `bytes[7]`) | SURVIVED the plan's tests (no fixture date has length 10 with other separators); added `only_digits_and_dashes_make_a_date`; now FAILS | left Some(2026-10-08) right None (for `2026/10/08`)            |
| M5b | drop `is_ascii_digit()` (wrapping arithmetic)          | only_digits_and_dashes_make_a_date                                                                                                     | left Some(2726-10-08) right None (`+026-10-08`)                |
| M6  | `year() % 100` -> `% 1000`                             | the_year_zero_is_no_civil_date                                                                                                         | left Some("DEC999") right Some("DEC99")                        |
| M7  | `ShiftOrigin::Office => "office"` -> `"admin"`         | proto stored_names_parse_back_into_their_variants                                                                                      | UnknownVariant{shift origin,"admin"} vs Ok(Office)             |
| M8  | drop `#[serde(rename_all="snake_case")]`               | same proto test                                                                                                                        | Err(UnknownVariant "office")                                   |
| M9  | `parse_variant("shift origin"` -> `("origin"`          | same proto test                                                                                                                        | "unknown origin \"admin\"" vs "unknown shift origin \"admin\"" |

Logs: /tmp/claude/2a1t1/m{1..9}.txt, m5.txt, m5b.txt.

## Files changed

apps/standalone/host/src/shifts.rs (new), host/src/lib.rs, host/tests/shift_numbers.rs (new), proto/src/lib.rs, proto/fixtures/shift-numbers.json (new), test/shift-numbers.test.ts (new), AGENTS.md.

## Self-review

Code is the plan's verbatim; the only addition is the test `only_digits_and_dashes_make_a_date` in `host/tests/shift_numbers.rs` (with a doc comment). Tree clean after commit.

## Concerns

- Host test total is 311, not the plan's 310, because of the extra test that kills the M5 mutant (the plan's fixture has no 10-byte non-ISO text, so separator and digit checks were unguarded). Later tasks' counts should add 1 to host figures. The fixture's 22/5 counts are untouched (the Vitest test pins them).
- The scratch logs in /tmp/claude overwrote two older files (`red1.txt`, `red2.txt`, `vt1.txt`) from earlier sessions; they are scratch only.
