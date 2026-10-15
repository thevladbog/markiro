# plan СКЛ, Task 1 report: warehouse reprint wire (proto, Zod, fixtures, HostApi)

Status: DONE. Commit: `056b157ac feat(standalone): warehouse reprint wire types and fixtures (plan СКЛ task 1)` on `claude/wh` (base 2c726efba). Tree clean after commit.

## What was done

All seven steps of the brief, in order: nine `proto/fixtures/warehouse-*.json`; `proto/tests/warehouse.rs`; the Rust types, constants and `warehouse_receipt_codes` in `proto/src/lib.rs` (after `CodeCheck`); `test/warehouse-protocol.test.ts`; the Zod mirrors in `src/host/protocol.ts` (after `factReceiptsSchema`); `HostApi.warehouseLookup` / `sendWarehouseRecords` in `src/host/api.ts`; the fake in `test/support/office.tsx`; the `api.test.ts` test. Beyond the brief: extra negative/edge tests (see mutants) in `warehouse-protocol.test.ts`, `warehouse.rs`, `api.test.ts`.

## RED / GREEN

- RED Rust: `cargo test ... -p markiro-proto --test warehouse` -> exit 101, E0432 unresolved imports `WarehouseLookup`, ... (`/tmp/claude/impl-skl-t1/red-rust.log`). GREEN: 4 tests ok (brief) -> 6 after the extra tests.
- RED Vitest: `vitest run test/warehouse-protocol.test.ts` -> 5 failed, `Cannot read properties of undefined (reading 'parse')` (`red-vitest.log`). GREEN: warehouse-protocol + api: 2 files, 123 tests passed (verbose, 0 `stderr`).

## Mutants (all KILLED, every restore verified by sha256 before/after and `cmp` against the pre-mutation copy under /tmp/claude/impl-skl-t1/orig/)

Harness `/tmp/claude/impl-skl-t1/mut.py`, logs `mut-*.log`. 63 TS mutants (Vitest `warehouse-protocol` + `api`), 22 Rust mutants (`--test warehouse`), 1 typecheck mutant. Summary by guard:

| Guard                                                                              | One-line mutant                                                                              | Killed by                                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| lookup is exactly one of codeHash / sscc, strict                                   | drop `.strict()` on either member; make both optional                                        | "asks one thing at a time" + "refuses a lookup that carries anything beyond" |
| source.kind enum                                                                   | `z.string()`                                                                                 | "refuses a found record with a kind the host does not print"                 |
| source subjectId / identity non-empty                                              | drop `.min(1)`                                                                               | "empty subject id" / "empty identity"                                        |
| source shiftId / deviceId uuid                                                     | `z.string()`                                                                                 | "... is no uuid"                                                             |
| source itemCount / boxCount nonneg int                                             | drop `.nonnegative()` / `.int()`                                                             | negative / fractional cases                                                  |
| boxCount, canonical, sscc optional (absent on unit/pallet)                         | make required                                                                                | fixture round-trip, api test                                                 |
| canonical / sscc are text                                                          | `z.unknown()`                                                                                | "is no text" cases                                                           |
| counterpartyName / operatorName nullable, not optional                             | `.nullish()`                                                                                 | "is missing" cases                                                           |
| product required                                                                   | `.optional()`                                                                                | "a product that is missing"                                                  |
| unavailable reason enum + vocabulary                                               | `z.string()`; add `"lost"`                                                                   | "refuses an answer of another shape"                                         |
| found requires source                                                              | `.optional()`                                                                                | same                                                                         |
| constants (kinds, reasons, outcomes, receipt codes)                                | drop one value                                                                               | "knows the host's receipt codes, reasons and outcomes" / fixtures            |
| record strict                                                                      | drop `.strict()`                                                                             | "refuses a record with a field the host would refuse"                        |
| record id/sessionId/jobId/operatorId uuid                                          | `z.string()`                                                                                 | per-field cases                                                              |
| attempt / templateRev nonneg int (0 allowed)                                       | drop nonneg / int / use `.positive()`                                                        | per-field + edge test (attempt 0, rev 0)                                     |
| subjectKind / reasonCode / outcome enums                                           | `z.string()`                                                                                 | per-field cases + all-values edge test                                       |
| subjectId / identity / templateId non-empty                                        | drop `.min(1)`                                                                               | per-field cases                                                              |
| repair literal, nullable, required                                                 | string / not nullable / nullish                                                              | cases + fixtures                                                             |
| errorCode / operatorId / occurredAt required                                       | `.nullish()` / `.optional()`                                                                 | "is missing" cases                                                           |
| batch 1..100, strict                                                               | drop min / max 101 / drop max / drop strict                                                  | "takes 1 to 100 records", "refuses a record with a field..."                 |
| HostApi paths, bodies, `.receipts`, answer schema, no timeout, no office token     | change path / wrap body / drop `.receipts` / `z.any()` / add `timeoutMs` / add `officeToken` | `api.test.ts` (added "refuses a warehouse answer of another shape")          |
| office fake lacks a member                                                         | delete `warehouseLookup:` line                                                               | `pnpm typecheck` fails (TS2322 office.tsx:32)                                |
| Rust deny_unknown_fields on Lookup/Record/Batch                                    | remove each                                                                                  | warehouse.rs tests                                                           |
| Rust skip_serializing_if (code_hash, sscc x2, canonical, box_count)                | remove each                                                                                  | round-trip of fixtures                                                       |
| Rust names (`as_str` x3, kind/unavailable/result case, tag name, camelCase source) | alter each                                                                                   | `the_names_on_the_wire...`, fixture round trips                              |
| Rust record.subject_kind typed                                                     | `String`                                                                                     | `a_batch_and_a_record_refuse...`                                             |
| Rust constants and `warehouse_receipt_codes::*` values / ALL                       | alter                                                                                        | `the_receipt_codes_reasons_and_outcomes_are_the_fixtures`                    |

Two harness mutants first targeted `sendFacts` by mistake (identical neighbouring text); they were redefined to hit `sendWarehouseRecords` and re-run (killed by the warehouse api tests).

## Gates

- Vitest warehouse-protocol + api: 123 passed, no stderr. Delayed-`setImmediate` stand not run (no React/effect code in this task).
- `typecheck` 0, `lint` 0, `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings.
- Prettier gate: live proof with a scratch file (`[warn] ...zz-scratch.ts`, exit 1, deleted); changed files + fixtures: "All matched files use Prettier code style!".
- `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; `\u0` in the written JSON/Rust only the plan's `\u001d` (fixture `warehouse-lookup-found-unit.json:7`, and the Rust test's `'\u{1d}'`).
- Focused: `cargo test -p markiro-proto --test warehouse --test fixtures` 6 + 52 passed.
- ONE final full `cargo test --workspace --offline --locked` (unsandboxed): 72 test binaries ok, 1130 tests passed, 0 failed, 0 warnings.

## Test totals

Plan: 4 Rust warehouse tests, 5 Vitest tests in warehouse-protocol + 1 in api. Measured: 6 Rust tests in `warehouse.rs`; `warehouse-protocol.test.ts` expands to 57 cases (it.each); `api.test.ts` +2 tests; two files total 123 passed.

## Anchor adaptations

None semantic. Mechanical only: (1) prettier reformatted the one-line `WAREHOUSE_RECEIPT_CODES` array (over 100 cols) into a multi-line array, and a few `expect(...)` wrappings in the brief's test code; (2) in `api.ts` the new members sit before `sendFacts` (after `checkCode`) as the brief says. All fragments matched exactly once.

## Self-review / concerns

- Rust deserialises a missing `Option` field (e.g. `repair`) as `None`, while the Zod record schema requires the key (nullable, not optional). That is intentional strictness on the station side; the host-side route (Task 2) should decide whether to require presence.
- `lookup` Zod does not enforce 64-hex / 18-digit shapes (the brief says `z.string()`); the host route must validate them. The `WarehouseSource` struct (Rust) has no `deny_unknown_fields` (as in the brief); Zod `warehouseSourceSchema` strips unknown keys.
- No Windows/hardware checks apply; nothing in this task touches them.
