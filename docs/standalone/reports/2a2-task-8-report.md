# Plan 2a2, Task 8 report: process log with facts; spec refinements; full check

BASE `ceea2c126`; commit `1d783cf7f` "test(standalone): the process log holds no code of marking; the stage 2a spec takes plan 2a2's refinements" (trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, one line). Branch `claude/2a2-facts`, nothing pushed. `git status --short` empty after the commit.

Files (3): `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/AGENTS.md` («Logs»), `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md` (new section **§19**). No `host/src` change (the test is a fence; mutants prove it).

## What the test does now (wider than the brief's 4 records)

`secrets_never_reach_the_process_log` (the existing walk, extended) sends through the real HTTPS server, after the SSCC block is issued and before/after the office close:

- Production-like values: 31-character GS1 key (`01`+GTIN14+`21`+13-char serial) + `\u{1d}91EE11\u{1d}92` + 44-char crypto tail; codeHash = real SHA-256 of the canonical text; 18-digit SSCCs with the real GS1 check digit (`support::app::sscc_under`), serials taken from the issued block; reasons in Russian words with markers.
- Batch 1 (25 records, receipts asserted one by one): scans ok (2), `gtin_mismatch` (refused), `wrong_gtin` / `duplicate` / `invalid` journal rows, a scan with a NUL in the canonical (`invalid_record` on `data.code.canonical`), a scan of an owned code in another box (`conflict`, winner), `undo` (accepted), `undo` in an unknown box (`box_unknown`), `disassemble`/`reprint` of an open box with words (`box_state`), a 201-char reason (`invalid_record`), `box_closed` accepted, the same box closed again under another SSCC (`box_already_closed`), a box on a serial beyond the block (`sscc_not_issued`), a box with an SSCC of another issuer (`sscc_not_issued` through `names_serial`), a second box closed, `box_label`, `reprint` and `disassemble` accepted with words, a record with an unreadable id (`id: null`), an unknown kind, an unknown shift, a scan into a closed box (`box_closed`).
- The same batch again (every stored receipt returned, equal to the first); three records re-sent with other content (`payload_mismatch`).
- Code check: `GET /v1/device/codes/{hash}` for a taken code (`taken`), a free one (`free`) and an upper-case hash (400) (minors note 8 / Task 3).
- Totals: `GET /v1/office/shifts/{id}` and the list, after the facts (asserted `acceptedUnits` 1, `closedBoxes` 1).
- Office closes the shift; then a late scan (accepted) and the station's own `shift_closed` (accepted, `alreadyClosed`).
- A 500: a `scans` row for a record id is inserted directly (a state no route leaves), the batch with that record fails on `scans_record` and answers 500 `internal`; the log must show `request failed` + `UNIQUE constraint failed` (SQLite's words) and none of the payload.
- A second shift closed by the station (`shift_closed` closes it, a later scan marks it late, a second `shift_closed` = `alreadyClosed`), read back (`closed`, `closeReasonCode`, `lateDataAt`, totals).
- After the walk: the host kept every accepted canonical text, the three SSCCs, the two reason texts; it kept none of the refused texts. The log contains every receipt code of the walk (`gtin_mismatch`, `payload_mismatch`, `invalid_record`, `box_unknown`, `box_state`, `box_closed`, `box_already_closed`, `sscc_not_issued`, `unknown_shift`) and the ids of ten refused records; so absence of the needles proves something.
- Needles (all must be absent): for each of 12 codes the canonical text, the 31-char key, the serial, the crypto tail, the hash; the NUL-carrying variant; all SSCCs (full and the 17-digit body, incl. the refused ones); membership digests; the upper-case malformed hash; every `fact_receipts.digest` (any hash); all reason words and the `reason-marker` stem; `.418Z` (a device instant: any record dumped whole) and seven field names of fact data (`membershipDigest`, `closedBoxCount`, `plannedQtySnapshot`, `targetScannedAt`, `duplicateSource`, `reasonText`, `rawLength`).

New second test `the_host_prints_nothing_and_the_facts_path_logs_only_its_two_audited_lines` (beyond the brief; +1 test): reads `host/src` and asserts (a) no `print!/println!/eprint!/eprintln!/dbg!` anywhere except `main.rs` (the CLI), (b) the facts path (`facts/*`, `routes/facts.rs`, `routes/codes.rs`, `routes/office_shifts.rs`, 12 files) has exactly 2 `tracing::` calls, both in `facts/mod.rs`. Why: see "Levels" below.

## Levels and what the walk cannot see

The test uses the production `logging::init` (file layer, `LevelFilter::INFO`, no env filter), so it sees `info!/warn!/error!` written to the file. It does NOT see `eprintln!`/`println!` (console, not the file) and `debug!`/`trace!` are filtered. Mutants S4/S5/E5 below pass the walk on purpose; the static test kills them. I did not lower the subscriber level in the walk: production cannot show `debug!` either (hard-coded INFO), and a different level would test a configuration the host does not run. If someone adds an env filter later, the static count of 2 will still hold the facts path.

## Mutants (32; each applied to one file, the covering run executed, restored; `cmp` + sha256 equal before/after, `restored=True` for all; `git status` clean of `host/src` afterwards; script `/tmp/claude/t8/mutate.py`, results `/tmp/claude/t8/mutants.txt`)

W = `secrets_never_reach_the_process_log`, S = the static test. FAILED = the mutant is caught.

| #   | Mutant (one line added unless noted)                                       | W             | S      | Key line of W                                         |
| --- | -------------------------------------------------------------------------- | ------------- | ------ | ----------------------------------------------------- |
| S1  | scan.rs: `info!(canonical)` before the GTIN check (plan M1)                | FAILED        | FAILED | log contains the canonical text                       |
| S2  | scan.rs: `warn!(code_hash)`                                                | FAILED        | FAILED | contains the hash                                     |
| S3  | scan.rs: `info!(record body)`                                              | FAILED        | FAILED | contains the key                                      |
| S4  | scan.rs: `debug!(canonical)`                                               | ok (filtered) | FAILED | -                                                     |
| S5  | scan.rs: `eprintln!(canonical)`                                            | ok (console)  | FAILED | -                                                     |
| S6  | scan.rs: the scans INSERT's `map_err` carries the code (500 path)          | FAILED        | ok     | contains `...1Cd5mHt8Jp3Qs` (the failing batch's key) |
| S7  | scan.rs: journal-only scan logs its code                                   | FAILED        | FAILED | contains the key                                      |
| B1  | box_closed.rs: `info!(sscc)`                                               | FAILED        | FAILED | contains `046006820000000013`                         |
| B2  | box_closed.rs: `info!(membership digest)`                                  | FAILED        | FAILED | contains the digest                                   |
| B3  | box_closed.rs: `info!(record body)`                                        | FAILED        | FAILED | contains the SSCC                                     |
| B4  | box_closed.rs: `info!(members hashes)`                                     | FAILED        | FAILED | contains the hash                                     |
| B5  | box_closed.rs: refusal of a form-wrong SSCC logs it                        | FAILED        | FAILED | contains `099999999900000021`                         |
| E1  | exception.rs: `info!(reason words)`                                        | FAILED        | FAILED | contains the reprint words                            |
| E2  | exception.rs: `info!(code hash)`                                           | FAILED        | FAILED | contains the hash                                     |
| E3  | exception.rs: `info!(record body)`                                         | FAILED        | FAILED | contains the hash                                     |
| E4  | exception.rs: `box_state` refusal logs the words                           | FAILED        | FAILED | contains the refused-state words                      |
| E5  | exception.rs: `trace!(words)`                                              | ok (filtered) | FAILED | -                                                     |
| C1  | shift_closed.rs: `info!(record body)`                                      | FAILED        | FAILED | contains `.418Z`                                      |
| C2  | box_label.rs: `info!(record body)`                                         | FAILED        | FAILED | contains `.418Z`                                      |
| R1  | mod.rs: `record = %value` instead of `?id` in the rejection warn (plan M2) | FAILED        | ok     | contains the hash                                     |
| R2  | mod.rs: payload_mismatch warn gains `body = %value`                        | FAILED        | ok     | contains the key                                      |
| R3  | mod.rs: replay (stored digest equal) logs the body                         | FAILED        | FAILED | contains the key                                      |
| R4  | mod.rs: every record logged whole at the top of `receive`                  | FAILED        | FAILED | contains the key                                      |
| R5  | mod.rs: rejection warn gains the record digest                             | FAILED        | ok     | contains a `fact_receipts.digest`                     |
| U1  | mod.rs: unknown-shift refusal logs the body                                | FAILED        | FAILED | contains the key                                      |
| U2  | mod.rs: unreadable-id refusal logs the body                                | FAILED        | FAILED | contains the key                                      |
| U3  | mod.rs: replay logs the receipt's details                                  | FAILED        | FAILED | contains `.418Z` (winner instant)                     |
| F1  | routes/facts.rs: whole batch `info!(?batch)`                               | FAILED        | FAILED | contains the key                                      |
| K1  | routes/codes.rs: `info!(hash)` of the check                                | FAILED        | FAILED | contains the hash                                     |
| K2  | routes/codes.rs: malformed hash logged                                     | FAILED        | FAILED | contains the upper-case hash                          |
| T1  | routes/office_shifts.rs: GET shift (totals) logs all SSCCs (extra query)   | FAILED        | FAILED | contains the SSCC                                     |
| T2  | routes/office_shifts.rs: list (totals) logs all SSCCs                      | FAILED        | FAILED | contains the SSCC                                     |

Findings of the first matrix that I fixed in the test (then re-ran the whole matrix on the final file, the table above is that run):

- B5 passed: the walk had no record refused by `names_serial` (a serial beyond the block is refused later) -> added a `box_closed` with an SSCC of another issuer.
- K2 passed: the needle was the lower-case hash, the request carried the upper-case one -> added the malformed hash as a needle.
- C1/C2 passed: the bodies of `shift_closed` and `box_label` hold no code/SSCC/words -> added the device-instant needle `.418Z` and the field-name needles, which catch any whole-record dump.
- R5 passed: a record digest is "a hash" (AGENTS «Logs») but not a code hash -> added every `fact_receipts.digest` as a needle.

Mutant caveats: S6 (500 path) is caught only because the test provokes a real 500; the DB error text itself (`UNIQUE constraint failed: scans.device_id, scans.record_id`) carries no values, as SQLite's messages do not.

## Anchor adaptations

1. Brief step 1.2/1.3/1.4 (the 4-record walk and the final assertions): the brief's single-batch walk, one `canonical`, one `sscc` and `kept_codes == vec![canonical]` do not fit the wider walk; the intent was applied by hand: canonical/SSCC are asserted as sets of what the host kept, refused ones asserted absent, and the needle loop is the brief's `for marking in [...]` generalised. The brief's rawLength 57 and short canonical replaced by production-like values.
2. Step 3.1 (AGENTS «Logs»): the anchor matched (once); the replacement text is the brief's intent extended with the 500 path, the levels caveat and the static test.
3. Step 3.2 (spec): the anchor matched (end of §15); the section is **§19**, not §16 (§16 = 2a3, §17 = 2a4, §18 = plans 2a6 on other branches; RECORD FOR THE MERGE: renumber if the merge order differs, there is an HTML comment in §19 saying so). Its text is the brief's list updated to what the code does after the Task 3-7 fixes: unique `(device_id, record_id)`, `sscc_taken` on `(block_id, serial)`, the instant-based `undo`/`clear` and the shape requirement for the station (`codeHash`+`targetScannedAt` unchanged), the later label check replaces the earlier, `AskingDevice` (no `last_seen_at` touch) on the code check, a 500 on a DB error and the retry/resend rules of minors 2-3, the late mark of a station's own post-close facts, and the log rule.
4. Step 4 mutants M1/M2 were applied (S1, R1) plus 30 more; step 2 "1 test passes" is 2 (the static test).
5. The brief says the host log test "passes at once" and the mutants prove it: true; the wider walk found 4 weaknesses of its own first draft (above) and was strengthened.

## Final check of the plan

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: clean. `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked`: no compiler warnings (the only warning is the build script's sandbox `xcrun` cache message, environmental).
- `cargo test --workspace --offline --locked` (outside the sandbox, one run, ~9 min): **46 suites, 603 tests, 0 failed**. The plan expects 46 suites / 556 tests; the difference is the extra tests of Tasks 2-8 (host 440 vs plan 393: `facts` 53, `codes` 8, `office_shifts` 23, `no_secrets_in_logs` 2 (plan 1), lib 58 ...; `proto` 48 = plan 48; shell 115 = plan 115). Host lib `src/lib.rs` 58 + `src/main.rs` 3 included in the 440.
- Vitest (`pnpm --dir ... --filter @markiro/standalone test`): 68 files, 1829 tests (the plan says 1779; the branch moved), **1 failed**: `test/template-editor.test.tsx` "marks «Шаблоны» in the menu ..." with `Test timed out in 5000ms` (5.4 s under a machine load average of 100-180). The same file/test failed again in a rerun under the same load, and **passed alone with `--testTimeout=60000`** (1 passed). This is the single known timeout flake of this file (plan's observation: it also failed once on the 2a1 baseline); no `src/` file changed in this plan. `test/fact-rules.test.ts` passes. Not conclusive on a quiet machine: re-run once the machine is idle.
- `typecheck`: exit 0. `lint`: exit 0.
- `prettier --check` on AGENTS.md and the spec: clean. `git diff --check`: clean. Hygiene greps: `\u04` only at `src/host/pairing-code.ts:66`; `\u0` absent in my Rust file.
- `git diff 0a21a3f2c --name-only` for Cargo.toml/Cargo.lock/package.json/pnpm-lock, `apps/station`, `packages/*`, `apps/standalone/src/`, `src-tauri`, migrations `0001`-`0009`: nothing. Webview: one new test file (`test/fact-rules.test.ts`). (The same diff also lists plan documents 2a5 and IMP, which come from the branch history, not this plan.)

## What was not verified

- Facts are not sent by any client yet: the batches are built by hand from fixture shapes; the webview builders and their check against `facts-request.json` are plan 2a6.
- The 300 ms bound of the code check on a factory network and the batch throughput on a factory PC: manual (spec 2a §7); the tests only prove the check does not wait for the writer.
- Totals' query cost at the volume of a real shift (hundreds of thousands of items): not measured here (Task 7 measured a synthetic 1.3M-item DB; end-to-end figure with 2a8).
- CI jobs `standalone-rust` and `standalone-windows-build` (need a push); the host service on Windows; nothing Windows-specific was added.
- Browser, hardware, printer checks: not applicable to this task.
- The static test pins the source text with plain `contains`/`matches` counts; a logging macro written through another crate (none is a dependency) or via a macro alias would escape it.

## Concerns

1. Host `tracing::error!(%error)` in `ApiError::internal` logs any internal error's text. SQLite's messages carry column names, not values, which the 500 case shows; a future `internal(format!(...))` with a payload is what S6 simulates. The runtime test would catch it only on a path the walk drives (scans INSERT today).
2. `tests/no_secrets_in_logs.rs` grew from 700 to ~1700 lines (helpers `Marking`, `scan_data`, `record`, `exception_data`, `box_closed_data`, `send_facts`, `assert_receipt`). It runs in about 1.5 s.
3. The static test is an addition outside the brief (test count: host +1). Remove it if the owner prefers one test; then S4/S5/E5 become the documented blind spots.
4. The vitest timeout flake above; plus the machine was at load 100-180 for the whole session (all timings are inflated).
