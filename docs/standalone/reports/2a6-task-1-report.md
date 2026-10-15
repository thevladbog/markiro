# plan 2a6 - Task 1 report (protocol of the floor)

Status: DONE_WITH_CONCERNS (concerns are notes, none blocks Task 2).
Commit: `7c9643035 feat(standalone): the floor's facts in the webview: records, receipts, the code check and SSCC blocks` on `claude/2a6-scanning` (base `84c056f80`). Tree clean after the commit.

## What was done

- `src/host/protocol.ts`: `codeOwnerSchema`, `codeCheckSchema`, `ssccBlockSchema`, `FACT_OUTCOMES`, `FACT_RECEIPT_CODES`, `factReceiptSchema`, `factReceiptsSchema` (lenient responses), `ssccBlockRequestSchema`, `SCAN_VERDICTS`, `SCAN_RAW_KINDS`, `scannedCodeSchema`, `scanFactSchema`, `boxClosedFactSchema`, `boxLabelFactSchema`, `boxExceptionFactSchema`, `shiftClosedFactSchema`, `factRecordSchema`, `MAX_FACT_BATCH = 100`, `factBatchSchema` (strict requests), as in the brief, verbatim (only the en-dashes in three doc comments became hyphens). No pallet fields (protocol 3 / PL-Kh is a separate stream); `PROTOCOL_VERSION` stays 2.
- `src/floor/facts.ts` (new): `RecordHead`, five record builders, `scannedCode`, `MAX_RECORD_BYTES = 16 * 1024`, `RecordTooLargeError`, `outboxStatement`, verbatim from the brief.
- `src/host/api.ts`: `requestSsccBlock`, `checkCode` (`encodeURIComponent`, `timeoutMs: CODE_CHECK_TIMEOUT_MS = 300`), `sendFacts` (returns `.receipts`).
- `test/support/office.tsx`: `fakeHostApi` refuses the three new calls with `unexpected`.
- Tests: `test/floor-facts.test.ts` (new), `test/api.test.ts`, `test/protocol.test.ts` - the brief's tests plus the extra tests listed below.

## Wire contract check (host as executed in 2a2, protocol 2)

Compared the schemas with `proto/src/lib.rs` (`FactRecord`/`FactBatch` deny_unknown_fields; `ScanFact`, `ScannedCode`, `BoxClosedFact`, `BoxLabelFact`, `BoxExceptionFact`, `ShiftClosedFact` deny_unknown_fields; `FactReceipt` lenient, `code: Option<String>`, `details: Option<Map>`; `CodeOwner`, `CodeCheck` tag `status`; `SsccBlock` lenient, `SsccBlockRequest` deny_unknown_fields, `extension: u8`), with `receipt_codes::ALL` (same 11 codes, same order as `fact-receipt-codes.json` and `FACT_RECEIPT_CODES`) and with the fixtures `facts-request/response`, `code-check-free/taken`, `sscc-block(-request)`. No difference found; the brief's schemas match the host. Enum value lists (`SCAN_VERDICTS`, `SCAN_RAW_KINDS`, outcomes, exception kinds, label outcomes) match the Rust enums' snake_case names (pinned by literal lists in the tests, as there is no fixture for them).

## Anchor adaptations

- `test/api.test.ts`: the file's client import is multi-line (`createHostApi, type HostApi` is on its own line, `client.js` import is separate) - brief fragment 1 applied to the single line `import { createHostApi, type HostApi } from "../src/host/api.js";` (mechanical). Fragment 6 (end of file) applied by appending the new `describe` after the last `describe`; fragments 2-5 matched verbatim.
- `test/protocol.test.ts`: fragments 1-5 matched verbatim (`RESPONSES`/`REQUESTS` arrays exist); fragment 6's anchor (end of the "unauthorized errors" describe) is the end of the file; the "facts of the floor" describe is appended there.
- `src/host/api.ts`, `src/host/protocol.ts`, `test/support/office.tsx`: all fragments matched verbatim, once each.
- Nothing semantic differed: `HostRequestOptions.timeoutMs` exists in `src/host/client.ts` (validated 1..max by the shell's bounds), `Pairing` is in `src/local/reference-sync.ts`, `LocalStatement` in `src/local/executor.ts`, the `outbox` table of migration 0006 has the columns the INSERT names (`acked_at` too).

## Addenda from 2a5

Items 1-3, 5, 26, 27, N3, N9, N10 concern the receipt transaction, status bar, work gate and later tasks, not Task 1 (no SQL read or gate here). Item N10 applied (adaptations listed above). Nothing further owed in Task 1. For Task 6/7: item 2 (`+host_id` on the `needs_fix` UPDATE), item 3 (`SELECT 1 FROM floor_boxes WHERE sscc = ?` before the close transaction), item 5/27 (query-plan lists in both test files) are still to be done by the tasks that write those statements.

## RED / GREEN

- RED (`/tmp/claude/impl-2a6-t1/red.txt`): `pnpm ... exec vitest run test/api.test.ts test/floor-facts.test.ts test/protocol.test.ts` -> `Test Files 3 failed (3)`; `api.test.ts` and `protocol.test.ts`: `TypeError: Cannot read properties of undefined (reading 'parse')` (schemas missing), `floor-facts.test.ts`: `Failed to resolve import "../src/floor/facts.js"` - exactly as the plan expects.
- GREEN: same command -> `Test Files 3 passed (3)`, `Tests 337 passed (337)`.
- Verbose run (`--reporter=verbose`): 337 passed, stderr 0 bytes. Delayed-`setImmediate` stand (3 ms; React is only imported through `test/support/office.tsx`, never rendered here): 337 passed, stderr 0 bytes; the two stand files were removed (git status clean).
- Full suite, default 5 s timeout (load ~50): `Test Files 2 failed | 88 passed (90)`, `Tests 4 failed | 2677 passed (2681)` - the 4 failures are 5 s timeouts in old office suites this task does not touch (`shift-totals.test.tsx` 1, `template-editor.test.tsx` 3). Re-run with `--testTimeout=60000`: `Test Files 90 passed (90)`, `Tests 2681 passed (2681)`.
- Counts: plan says 88 files / 2240 tests after Task 1 (measured on its scratch copy). Real tree: base was 89 files / 2636 tests (api+protocol alone 292 at base), now 90 files / 2681 tests: +1 file, +45 tests: floor-facts 12, api +6 (66 -> 72), protocol +27 (226 -> 253; 12 of them are the new `describe.each` fixture rows: 4 responses x 2 + 2 requests x 2). Three files: 337 now.
- typecheck 0, lint 0, `prettier --check` on the 7 files clean, `git diff --check` clean, `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`, `cargo fmt --check` clean (no Rust touched; cargo check not run for that reason; no `build` - the task does not touch the shell or the dist it embeds).

## Tests beyond the brief

api.test.ts: only the code check carries a limit (`timeoutMs` absent on block/facts); the hash goes into the path as one encoded segment (`a/b?c` -> `a%2Fb%3Fc`); `sendFacts` sends the outbox's records unread (a record with a field this build does not know goes out untouched); the fake refuses each of the three calls with its own name and honours an override.
protocol.test.ts: batch of exactly 1/100 accepted, one unreadable record fails the batch; all six fixture records read without losing a field; every record and its `data` and `data.code` refuse an extra key (strict, like `deny_unknown_fields`); every key of envelope/data/code is required (nullable ones are `null`, not absent); a table of 36 wrong-type/out-of-range values per field (uuid, int, negative, 0 for positive fields, enums); edges accepted (0 serial, 0 rawLength, 1 itemCount, every enum value, plannedQtySnapshot null/1, actualQty 0, nullable fields null); exact lists of verdicts/raw kinds/outcomes; receipts: id null/string only, code text (not the list), details a record with the winner kept whole, lenient extra keys on receipt and batch answer, missing `receipts`; code check: unknown status, owner fields typed (uuid/bool/text), lenient extra keys on owner and free answer; block: each field required/typed, extension 0..9, serials 0 accepted and negative/fractional refused (lenient extra key is covered by the `RESPONSES` row); block request: each field required/typed, extension 0..9.
floor-facts.test.ts: builders give exactly the five keys with their kind and keep `operatorId: null` as a key; `scannedCode` is accepted by the strict `scannedCodeSchema`, has the separator and no `]d2`, another serial is another hash; the outbox row for all six fixture records (kind, shift, id, payload, created_at, seq order); the payload is the schema-read record whatever order the keys came in; the same record twice fails as `statement_failed` and keeps the first row; wide/wrong-kind/missing-`code` records are refused and nothing is written; `MAX_RECORD_BYTES` pinned to 16384 and `MAX_FACT_BATCH` to 100; the error carries the byte count and name; a scan of the longest code the host takes (1024 bytes) is under 2 KiB.

## Mutant table

Method: for each mutant the file was copied to `/tmp/claude/impl-2a6-t1/mut/<id>.orig`, one anchor-checked replacement applied (the replacement fails if the anchor is not unique), the three test files run (`vitest run --testTimeout=60000 --reporter=json`), the file restored from the copy, then `cmp` against the copy and `shasum -a 256` before/after (column "restored" = both equal). Script: `/tmp/claude/impl-2a6-t1/mutate.py`, logs `mut.log` / `mut-run1.log`, per-mutant JSON in `mut/`. 119 mutants (the brief's M1-M9 and 110 more), 119 killed, 0 survive. Two mutants survived the first run and led to new tests: F21 (payload from the unchecked record instead of the schema-read one) -> test "keeps the record as the schema reads it, whatever order its keys came in"; F22 (`INSERT OR IGNORE`) -> test asserts `statement_failed` for a repeated id. R6-R8 had a non-unique anchor in run 1 and were re-run with a longer anchor (all killed). The brief's M1-M9 each fail the test the plan names (verified from the JSON); M5 also fails 4 more tests. Several mutants that weaken a response field (e.g. S4, S5, X5) are killed by `api.test.ts` failing to load (its module-level `factBatchSchema.parse(fixture(...))`), which is a valid but coarse kill; the finer tests fail too.

| id  | mutant                             | result (failing tests) | first failing test                                                                                             | restored |
| --- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| M1  | check without the 300 ms limit     | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| M2  | no sscc_taken in the receipt codes | KILLED (1)             | facts of the floor know every receipt code of the host                                                         | True     |
| M3  | batch of 101                       | KILLED (1)             | facts of the floor send 1 to 100 records in a batch                                                            | True     |
| M4  | empty batch                        | KILLED (1)             | facts of the floor send 1 to 100 records in a batch                                                            | True     |
| M5  | scan data unchecked                | KILLED (5)             | the outbox row of a record refuses a record this build cannot form, and writes nothing                         | True     |
| M6  | row without schema check           | KILLED (1)             | the outbox row of a record refuses a record this build cannot form, and writes nothing                         | True     |
| M7  | hash depends on tail               | KILLED (1)             | the builders of the outbox's records carry a code as the domain read it: the hash without the tail, the canoni | True     |
| M8  | record at limit refused            | KILLED (1)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| M9  | size in characters                 | KILLED (1)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| A1  | block path                         | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A2  | hash not encoded                   | KILLED (1)             | HostApi floor work puts the hash into the path as one segment, whatever it holds                               | True     |
| A3  | facts body is the bare array       | KILLED (2)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A4  | check by POST                      | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A5  | sendFacts returns the whole answer | KILLED (2)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A6  | facts path                         | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A7  | block request body altered         | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A8  | timeout constant                   | KILLED (1)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| A9  | receipts unchecked                 | KILLED (1)             | HostApi floor work rejects a block, a check or receipts in another shape                                       | True     |
| A10 | block answer unchecked             | KILLED (1)             | HostApi floor work rejects a block, a check or receipts in another shape                                       | True     |
| A11 | check answer unchecked             | KILLED (1)             | HostApi floor work rejects a block, a check or receipts in another shape                                       | True     |
| A12 | fake names the wrong call          | KILLED (1)             | HostApi floor work is stood in for by a fake that refuses the three calls loudly until a test stubs them       | True     |
| A13 | fake gives another message         | KILLED (1)             | HostApi floor work is stood in for by a fake that refuses the three calls loudly until a test stubs them       | True     |
| P1  | owner.sameDevice is text           | KILLED (4)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| P2  | owner.shiftId any text             | KILLED (1)             | facts of the floor read the code check by its status, with the owner of a taken code in full                   | True     |
| P3  | owner.deviceId any text            | KILLED (1)             | facts of the floor read the code check by its status, with the owner of a taken code in full                   | True     |
| P4  | taken without owner                | KILLED (1)             | facts of the floor take a receipt code a newer host adds, and refuse a taken code without its owner            | True     |
| P5  | taken strict                       | KILLED (1)             | response fixture code-check-taken.json tolerates a field added by a newer host                                 | True     |
| P6  | free strict                        | KILLED (2)             | response fixture code-check-free.json tolerates a field added by a newer host                                  | True     |
| P7  | block extension up to 10           | KILLED (1)             | facts of the floor read a block of serials, in full and in range                                               | True     |
| P8  | block extension negative           | KILLED (1)             | facts of the floor read a block of serials, in full and in range                                               | True     |
| P9  | block fromSerial negative          | KILLED (1)             | facts of the floor read a block of serials, in full and in range                                               | True     |
| P10 | block toSerial negative            | KILLED (1)             | facts of the floor read a block of serials, in full and in range                                               | True     |
| P11 | block id any text                  | KILLED (1)             | facts of the floor read a block of serials, in full and in range                                               | True     |
| P12 | block strict                       | KILLED (1)             | response fixture sscc-block.json tolerates a field added by a newer host                                       | True     |
| P13 | request extension up to 10         | KILLED (1)             | facts of the floor send a block request that names its id, prefix and an extension of 0 to 9                   | True     |
| P14 | request not strict                 | KILLED (1)             | request fixture sscc-block-request.json rejects an unknown field, like the host                                | True     |
| P15 | request id any text                | KILLED (1)             | facts of the floor send a block request that names its id, prefix and an extension of 0 to 9                   | True     |
| P16 | request extension negative         | KILLED (1)             | facts of the floor send a block request that names its id, prefix and an extension of 0 to 9                   | True     |
| R1  | extra outcome                      | KILLED (1)             | facts of the floor know the three outcomes of the host, and a receipt of each shape                            | True     |
| R2  | no conflict outcome                | KILLED (6)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| R3  | receipt id not nullable            | KILLED (7)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| R4  | receipt code from the list only    | KILLED (1)             | facts of the floor take a receipt code a newer host adds, and refuse a taken code without its owner            | True     |
| R5  | receipt code required              | KILLED (6)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| R6  | receipt details required           | KILLED (7)             | HostApi floor work asks for a block, checks a code within 300 ms and sends facts, with the device key only     | True     |
| R7  | receipt details any value          | KILLED (1)             | facts of the floor know the three outcomes of the host, and a receipt of each shape                            | True     |
| R8  | receipt strict                     | KILLED (1)             | facts of the floor know the three outcomes of the host, and a receipt of each shape                            | True     |
| R9  | receipts answer strict             | KILLED (2)             | response fixture facts-response.json tolerates a field added by a newer host                                   | True     |
| R10 | receipt codes reordered            | KILLED (1)             | facts of the floor know every receipt code of the host                                                         | True     |
| R11 | extra receipt code                 | KILLED (1)             | facts of the floor know every receipt code of the host                                                         | True     |
| R12 | no wrong_gtin verdict              | KILLED (2)             | facts of the floor know the verdicts and the kinds of a scan the host knows, and no other                      | True     |
| R13 | no sscc kind                       | KILLED (2)             | facts of the floor know the verdicts and the kinds of a scan the host knows, and no other                      | True     |
| R14 | extra verdict                      | KILLED (1)             | facts of the floor know the verdicts and the kinds of a scan the host knows, and no other                      | True     |
| S1  | scannedCode not strict             | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| S2  | scan data not strict               | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| S3  | negative rawLength                 | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| S4  | duplicateSource not nullable       | KILLED (3)             | (suite fails to load: api.test.ts fixture parse)                                                               | True     |
| S5  | code not nullable                  | KILLED (3)             | (suite fails to load: api.test.ts fixture parse)                                                               | True     |
| S6  | scan boxId any text                | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| S7  | extra duplicate source             | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| S8  | scan boxId may be absent           | KILLED (1)             | facts of the floor need every field of the envelope and of the data, null where the host takes null            | True     |
| S9  | scan scannedAt optional            | KILLED (1)             | facts of the floor need every field of the envelope and of the data, null where the host takes null            | True     |
| B1  | serial positive only               | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| B2  | itemCount may be 0                 | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| B3  | box_closed data not strict         | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| B4  | blockId any text                   | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| B5  | serial fractional                  | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| B6  | closedAt nullable                  | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| L1  | extra label outcome                | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| L2  | box_label data not strict          | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| L3  | no skipped outcome                 | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| X1  | no clear exception                 | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| X2  | exception data not strict          | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| X3  | reasonText may be absent           | KILLED (1)             | facts of the floor need every field of the envelope and of the data, null where the host takes null            | True     |
| X4  | exception boxId any text           | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| X5  | exception codeHash not nullable    | KILLED (3)             | (suite fails to load: api.test.ts fixture parse)                                                               | True     |
| X6  | exception reasonCode not nullable  | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| X7  | extra exception kind               | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| C1  | plan snapshot may be 0             | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| C2  | negative actualQty                 | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| C3  | negative closedBoxCount            | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| C4  | shift_closed data not strict       | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| C5  | plan snapshot not nullable         | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| C6  | close reason not nullable          | KILLED (1)             | facts of the floor take the edges of a field and the null where the host takes null                            | True     |
| E1  | operator not nullable              | KILLED (1)             | facts of the floor read a record's data by its kind, and no other                                              | True     |
| E2  | record id any text                 | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| E3  | record shiftId any text            | KILLED (1)             | facts of the floor refuse a value of the wrong type or range in every field, as the host does                  | True     |
| E4  | operator any text                  | KILLED (3)             | the outbox row of a record refuses a record this build cannot form, and writes nothing                         | True     |
| E5  | scan envelope not strict           | KILLED (2)             | the outbox row of a record refuses a record this build cannot form, and writes nothing                         | True     |
| E6  | box_closed envelope not strict     | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E7  | box_label envelope not strict      | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E8  | box_exception envelope not strict  | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E9  | shift_closed envelope not strict   | KILLED (1)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E10 | label record reads closed data     | KILLED (3)             | (suite fails to load: api.test.ts fixture parse)                                                               | True     |
| E11 | shift_closed data unchecked        | KILLED (3)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E12 | box_exception data unchecked       | KILLED (3)             | facts of the floor refuse a field the record or its data does not have, like the host                          | True     |
| E13 | batch limit 99                     | KILLED (2)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| E14 | batch not strict                   | KILLED (1)             | request fixture facts-request.json rejects an unknown field, like the host                                     | True     |
| F1  | scan builder kind                  | KILLED (4)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F2  | closed builder kind                | KILLED (2)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F3  | label builder kind                 | KILLED (2)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F4  | exception builder kind             | KILLED (2)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F5  | shift builder kind                 | KILLED (2)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F6  | scan builder drops operator        | KILLED (5)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F7  | shift builder blanks operator      | KILLED (1)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F8  | closed builder wrong shift         | KILLED (1)             | the builders of the outbox's records build every record of facts-request.json exactly                          | True     |
| F9  | host and device swapped            | KILLED (1)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F10 | no expectedChanges                 | KILLED (1)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F11 | constant kind column               | KILLED (1)             | the outbox row of a record keeps a record of every kind under its own kind, shift and id, in the order written | True     |
| F12 | shift column is the id             | KILLED (2)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F13 | created_at lost                    | KILLED (3)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F14 | limit 15 KiB                       | KILLED (1)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| F15 | error carries characters           | KILLED (1)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| F16 | error without name                 | KILLED (1)             | the outbox row of a record keeps no record larger than a batch of 100 can carry under the host's 2 MiB         | True     |
| F17 | gtin and serial swapped            | KILLED (2)             | the builders of the outbox's records carry a code as the domain read it: the hash without the tail, the canoni | True     |
| F18 | canonical without separators       | KILLED (2)             | the builders of the outbox's records carry a code as the domain read it: the hash without the tail, the canoni | True     |
| F19 | id column is the shift             | KILLED (2)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F20 | payload is the data only           | KILLED (3)             | the outbox row of a record keeps the whole record as its payload, under the pairing, in one row                | True     |
| F21 | payload from the unchecked record  | KILLED (1)             | the outbox row of a record keeps the record as the schema reads it, whatever order its keys came in            | True     |
| F22 | insert or ignore                   | KILLED (1)             | the outbox row of a record is a plain insert: the same record twice is refused and keeps the first row         | True     |

Final shas of the committed sources: protocol.ts `4a095188...7097`, api.ts `46c0f0f3...0bd8`, facts.ts `5969deea...8870`, office.tsx `778091a3...8837`.

## Self-review / concerns

- Instants (`scannedAt`, `openedAt`, `closedAt`, `at`, `occurredAt`, `targetScannedAt`) are `z.string()` as the brief has them; the host enforces the `Date.toISOString` form (`device-instants.json`). A malformed instant would be kept in the outbox and rejected by the host for good (`invalid_record`). The builders of later tasks must use `now()` = `toISOString`; if the owner wants the station to refuse it earlier, a refinement can be added in Task 3 where the clock is used. Not changed here (brief is exact).
- `codeHash` is `z.string()`, not 64-hex; same reasoning (the host checks the shape).
- Task 6 needs `sendFacts(records: readonly unknown[])` fed with parsed payloads; the schema is deliberately not applied on the way out, and a test pins it.
- The brief's counts (88 / 2240) and the expected `292 passed` for the three files do not apply to the real tree (see counts above); not edited in the plan.
- Under heavy load (load 50-70) the default 5 s timeout fails old office suites in the full run (listed above); the 60 s run is green.
