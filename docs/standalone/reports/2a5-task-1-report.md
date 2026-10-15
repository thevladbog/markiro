# Plan 2a5, Task 1 report: migration 0006, the station's production tables

Status: DONE_WITH_CONCERNS (see Concerns). Commit `e7943ab49` on `claude/2a5-floor` (worktree `/tmp/claude/wt/2a5-floor`, base `claude/integration` 16fdf718a). Nothing pushed.

## Setup (stream)

`git -C <main> worktree add -b claude/2a5-floor /tmp/claude/wt/2a5-floor claude/integration`; then (P = `pnpm --dir /tmp/claude/wt/2a5-floor --config.verifyDepsBeforeRun=false`):

- `P install --frozen-lockfile --prefer-offline --filter '@markiro/standalone...'` (allowed_domains registry.npmjs.org): Done 23 s, package.json / lockfile untouched.
- `P exec turbo run build --filter='@markiro/standalone^...'` (3 tasks, cached).
- `P --filter @markiro/standalone build` (web build, dist for the shell).
- `P --filter @markiro/standalone exec pwd` -> `/private/tmp/claude/wt/2a5-floor/apps/standalone`.
- `cargo build --offline --locked --manifest-path /tmp/claude/wt/2a5-floor/apps/standalone/Cargo.toml -p markiro-standalone --lib`: exit 0.
  (Gotcha: a zsh variable holding `pnpm --dir ...` does not word-split; use a function or `${=P}`.)

## What was done

- `src-tauri/migrations/0006_floor_production.sql`: the eight tables of §5.3 with the plan's SQL, plus one hardening (below).
- `src-tauri/src/local_db.rs`: eight `TableClass::DeviceData` entries in `TABLE_CLASSES` (sorted, `floor_sign_in_failures` stays `Disposable`, doc says why); `unsent_records` no longer asks `outbox_exists`; docs updated.
- `tests/local_db.rs`, `tests/ipc.rs`: temporary `OUTBOX` constants gone; `outbox_record` / `outbox_sql` / `device_records` / `unsent_record` / `acked_record` helpers; a clearing test that writes one row into each device table and checks each survives (named list, independent of `TABLE_CLASSES`).
- `test/local-executor.test.ts`: table list; `test/floor-schema.test.ts` (new): the plan's 10 tests + 15 more (25 total).

## Anchor adaptations (the real tree has more than the plan's scratch base)

1. `tests/local_db.rs` / `ipc.rs` carry 2a4's later tests (corrupt-database counting, race test, set-aside, split sets, `unsent_row`, `database_file`...). Every use of the old 4-column `OUTBOX` / `INSERT INTO outbox VALUES (...)` was converted to the real table by intent: 26 `local_db` tests and 26 `ipc` tests (plan: 16 / 18).
2. Plan fragment 2 (FK check inside `every_table_has_a_forget_class`) not applied: the real tree already has the separate `no_table_has_a_foreign_key` test. Class assertions applied as in the plan.
3. "Outbox that cannot be counted" (2a4 tests, three places): the table now exists, so the test does `DROP TABLE outbox` + `CREATE TABLE outbox (id TEXT PRIMARY KEY)` on a raw connection. The "readable database with no outbox" case of `unopened_unsent_records` (an older build's file) is kept as `DROP TABLE outbox`; `outbox_exists` stays for that path only (mutant M8 proves the case is still covered).
4. `a_forget_refuses...` keeps its third record (`c`, other host) via `outbox_record`; the race test inserts its late record through `outbox_sql`; `UPDATE outbox SET acked_at` became `SET outcome = 'accepted', acked_at` (the real table requires both).
5. The plan's `kept_device_records` raw table is replaced by `device_records()` as in the plan; `lib.rs:167` still mentions "the forget screen (plan 2a5)": left for task 8/9.

## Deviation from the plan's SQL (please confirm or revert)

`block_id`, `request_id`, and `id` of `floor_boxes`, `floor_scans`, `floor_exceptions` are `TEXT NOT NULL PRIMARY KEY` instead of `TEXT PRIMARY KEY`. SQLite takes NULL in a single-column non-INTEGER primary key (I inserted a `floor_boxes` row with `id NULL` on the plan's SQL: accepted). Mutants X13, N18, E13, B9, R2 pin it. The header comment of the migration says why.

## RED / GREEN

- RED Vitest (`floor-schema` + `local-executor`): `Tests 11 failed | 53 passed (64)`, as the plan says (`no such table: ...`).
- RED `local_db`: 8 failed / 18 passed (plan expected 5; the real tree has 3 more outbox tests). RED `ipc` (outside sandbox): 8 failed / 18 passed (plan 2).
- GREEN: Vitest 64 passed; `local_db` 26 passed; `ipc` 26 passed.
- Final: Vitest `floor-schema` + `local-executor` 79 passed (verbose: stderr empty, 0 bytes; delayed-`setImmediate` stand: 79 passed; stand files removed). Full package `test`: 80 files, 2191 tests; under load average ~70 eight old office files timed out at 5 s (32 tests: product-dialog, shift-delete-close, shift-dialog, shift-edit, shifts-page, template-defaults-page, template-editor, templates-page), none touch the local DB; re-run with `--maxWorkers=2` all passed except `template-editor` (known heavy), which passes 97/97 with `--maxWorkers=1 --testTimeout=60000`. `typecheck`, `lint` clean. `cargo test -p markiro-standalone` (outside sandbox) exit 0: lib 134, claim 5, connection 6, device 15, hardware_shapes 1, host_probe 2, host_probe_proxy 1, host_request_timeout 6, ipc 26, line 16, local_db 26, lockdown 4, printer 15; no warnings. `cargo check -p markiro-host -p markiro-proto --all-targets`: 0 warnings. `cargo fmt --check`, prettier, `git diff --check`: clean. `\u04` grep: only `pairing-code.ts:66`.

## Mutants

Plan mutants (Step 5): 1 (km CHECK short-circuit, `N9plan`) killed by "never keep the text of a scan..." ; 2 (open-box index not partial, `X11`) killed by "hold one open box per shift..." ; 3 (clear filter takes every class, `M3`) killed by `a_forget_refuses_while_unsent_records_remain`, `clearing_the_copies_empties_the_disposable_tables_and_nothing_else`, `sent_records_and_other_pairings_do_not_stop_a_forget`; 4 (`outbox` Disposable, `M4`) killed by `every_table_has_a_forget_class`, `a_forget_refuses_...`, `sent_records_...`.
Restore proof: harness `/tmp/claude/mut/run_sql_mutants.py` / `run_rust_mutants.py` copies the original to `/tmp/claude/mut/`, applies one replacement, runs the suite, copies back, asserts `sha256` + `cmp`. Migration sha256 before/after every mutant `81246b1d86d664ead95535a62560c82f558f9919eccf920f64341df8356e1a40`; `local_db.rs` `5ba8db2d7a1900b8c02356c1413259d5c878dbfb5f6a2bb49a9300e0b449460c`. Migration mutants run against `floor-schema` + `local-executor` (Vitest reads the migration directory on each open).

**96 SQL mutants: all killed by the final tests. Only 40 were killed by the plan's own tests (`-t` on the plan's 10 tests + the table list): 56 survived it** (column "plan tests"). Surviving mutants led to the added tests: column/type/NOT NULL/default/PK pin, index pin (unique, partial), query-plan check that the sender's read uses `outbox_unsent`, shift flag/origin/number checks, block bounds (single-serial block, from 0, used-up, one past, below `from`), request extension, each missing part of a closed box and each stray part of an open box, code key per pairing, verdict/source/kind/length lists, each field of a km scan, each field of each non-km class, each field of each exception kind, outbox outcomes/details/attempts, payload kept whole (120 KB UTF-8).

| mutant (one line of 0006)                       | plan tests alone | final: result and covering test                                                                                        |
| ----------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S1 status CHECK dropped                         | killed           | killed: keep a snapshot exactly for a shift the station entered, and close only such a shift                           |
| S2 pallets_enabled CHECK dropped                | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S3 created_from CHECK dropped                   | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S4 planned_qty CHECK dropped                    | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S4b planned_qty > 0 -> >= 0                     | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S5 box_capacity CHECK dropped                   | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S5b box_capacity > 0 -> >= 0                    | **survived**     | killed: limit a shift's flags, origin and numbers                                                                      |
| S6 snapshot json_valid dropped                  | killed           | killed: keep a snapshot exactly for a shift the station entered, and close only such a shift                           |
| S7 local_state CHECK dropped                    | killed           | killed: keep a snapshot exactly for a shift the station entered, and close only such a shift                           |
| S8 shifts PK loses device_id                    | killed           | killed: keep one row per shift and pairing, so another pairing to the same host has its own; fixes every column: its t |
| S9 snapshot=entered CHECK dropped               | killed           | killed: keep a snapshot exactly for a shift the station entered, and close only such a shift                           |
| S10 local_state needs entered CHECK dropped     | killed           | killed: keep a snapshot exactly for a shift the station entered, and close only such a shift                           |
| S11 shifts.number NOT NULL dropped              | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key                                  |
| S12 floor_shifts_line index dropped             | **survived**     | killed: fixes the indexes: which are unique, which are partial; serve the reads the floor makes from an index          |
| B1 block extension CHECK dropped                | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B2 from_serial >= 0 -> > 0                      | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B3 from_serial CHECK dropped                    | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B4 to >= from -> >                              | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B5 to >= from CHECK dropped                     | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B6 cursor upper bound +1 -> +2                  | killed           | killed: move a block's cursor only from the value read, within the block; limit an SSCC block's serials and its cursor |
| B6b cursor upper bound +1 -> +0                 | killed           | killed: move a block's cursor only from the value read, within the block; limit an SSCC block's serials and its cursor |
| B7 cursor CHECK dropped                         | killed           | killed: move a block's cursor only from the value read, within the block; limit an SSCC block's serials and its cursor |
| B8 cursor lower bound from_serial -> 0          | **survived**     | killed: limit an SSCC block's serials and its cursor                                                                   |
| B9 block_id NOT NULL dropped                    | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; refuse a row whose key is missi |
| B10 blocks prefix index dropped                 | **survived**     | killed: fixes the indexes: which are unique, which are partial                                                         |
| R1 request extension CHECK dropped              | **survived**     | killed: keep a block request once and with its own extension                                                           |
| R2 request_id NOT NULL dropped                  | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; refuse a row whose key is missi |
| X1 item_count CHECK dropped                     | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X1b item_count default 0 -> 1                   | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; close a box only whole: each of |
| X2 needs_fix CHECK dropped                      | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X3 open box may have sscc                       | killed           | killed: close a box whole, with its SSCC, block and serial, or keep it open without them; close a box only whole: each |
| X4 open box may have block_id                   | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X5 open box may have serial                     | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X6 open box may be disassembled                 | killed           | killed: close a box whole, with its SSCC, block and serial, or keep it open without them                               |
| X7 closed box may lack sscc                     | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X8 closed box may lack block_id                 | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X9 closed box may lack serial                   | **survived**     | killed: close a box only whole: each of the SSCC, the block and the serial, and nothing before                         |
| X10 SSCC index not unique                       | killed           | killed: hold one open box per shift and pairing, and an SSCC on one box under any pairing; fixes the indexes: which ar |
| X10b SSCC unique only within a pairing          | killed           | killed: hold one open box per shift and pairing, and an SSCC on one box under any pairing                              |
| X11 open index not partial                      | killed           | killed: hold one open box per shift and pairing, and an SSCC on one box under any pairing; fixes the indexes: which ar |
| X12 open index loses device_id                  | killed           | killed: hold one open box per shift and pairing, and an SSCC on one box under any pairing                              |
| X12b open index not unique                      | killed           | killed: hold one open box per shift and pairing, and an SSCC on one box under any pairing; fixes the indexes: which ar |
| X13 boxes.id NOT NULL dropped                   | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; refuse a row whose key is missi |
| X14 boxes.host_id NOT NULL dropped              | killed           | killed: tag every row with its pairing and have no foreign key; fixes every column: its type, whether it is required,  |
| C1 codes PK loses device_id                     | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; hold a code once per pairing, a |
| C2 codes PK loses host_id                       | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; hold a code once per pairing, a |
| C3 codes PK is only the hash                    | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; hold a code once per pairing, a |
| N1 scan verdict CHECK dropped                   | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N2 duplicate_source CHECK dropped               | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N3 raw_kind CHECK dropped                       | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N4 raw_length CHECK dropped                     | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N4b raw_length >= 0 -> > 0                      | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N5 conflict CHECK dropped                       | **survived**     | killed: take a scan only as one of the four verdicts, with a known source, kind and size                               |
| N6 duplicate<->source CHECK dropped             | killed           | killed: name a box for an accepted scan only, and a source for a duplicate only                                        |
| N7 invalid<->not km CHECK dropped               | killed           | killed: never keep the text of a scan that is no code of marking; keep nothing of a scan that is no code of marking, o |
| N8 ok<->box CHECK dropped                       | killed           | killed: name a box for an accepted scan only, and a source for a duplicate only; take a scan only as one of the four v |
| N8b ok<->box becomes box only needed for ok     | killed           | killed: name a box for an accepted scan only, and a source for a duplicate only; take a scan only as one of the four v |
| N9 km CHECK dropped                             | killed           | killed: never keep the text of a scan that is no code of marking; keep a code of marking whole: its hash, GTIN, serial |
| N9plan km CHECK short-circuit (plan mutant 1)   | killed           | killed: never keep the text of a scan that is no code of marking; keep a code of marking whole: its hash, GTIN, serial |
| N10 km may lack code_hash                       | **survived**     | killed: keep a code of marking whole: its hash, GTIN, serial and canonical form together                               |
| N11 km may lack gtin14                          | **survived**     | killed: keep a code of marking whole: its hash, GTIN, serial and canonical form together                               |
| N12 km may lack serial                          | **survived**     | killed: keep a code of marking whole: its hash, GTIN, serial and canonical form together                               |
| N13 km may lack canonical                       | **survived**     | killed: keep a code of marking whole: its hash, GTIN, serial and canonical form together                               |
| N14 non-km may keep code_hash                   | killed           | killed: never keep the text of a scan that is no code of marking; keep nothing of a scan that is no code of marking, o |
| N15 non-km may keep gtin14                      | **survived**     | killed: keep nothing of a scan that is no code of marking, of any class                                                |
| N16 non-km may keep serial                      | killed           | killed: never keep the text of a scan that is no code of marking; keep nothing of a scan that is no code of marking, o |
| N17 non-km may keep canonical                   | killed           | killed: never keep the text of a scan that is no code of marking; keep nothing of a scan that is no code of marking, o |
| N18 scans.id NOT NULL dropped                   | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; refuse a row whose key is missi |
| N19 floor_scans_shift index dropped             | **survived**     | killed: fixes the indexes: which are unique, which are partial; serve the reads the floor makes from an index          |
| E1 exception kind CHECK dropped                 | killed           | killed: take an exception with the fields of its kind only                                                             |
| E2 kind CASE dropped                            | killed           | killed: take an exception with the fields of its kind only; take an exception with every field of its kind and none of |
| E3 undo may lack code_hash                      | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E4 undo may lack target time                    | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E5 undo may have a reason                       | killed           | killed: take an exception with the fields of its kind only                                                             |
| E6 clear may have code_hash                     | killed           | killed: take an exception with the fields of its kind only                                                             |
| E7 clear may have target time                   | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E8 clear may have a reason                      | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E9 reprint/disassemble may have code_hash       | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E10 reprint/disassemble may have target time    | **survived**     | killed: take an exception with every field of its kind and none of another                                             |
| E11 reprint/disassemble may lack a reason       | killed           | killed: take an exception with the fields of its kind only                                                             |
| E12 reason_text CHECK dropped                   | killed           | killed: take an exception with the fields of its kind only; take an exception with every field of its kind and none of |
| E13 exceptions.id NOT NULL dropped              | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; refuse a row whose key is missi |
| O1 outbox.id UNIQUE dropped                     | killed           | killed: keep outbox records in their order, with a receipt and its time together                                       |
| O2 payload json_valid dropped                   | killed           | killed: keep outbox records in their order, with a receipt and its time together                                       |
| O3 attempts CHECK dropped                       | **survived**     | killed: settle an outbox record with a known outcome, and details only with an outcome                                 |
| O4 outcome CHECK dropped                        | killed           | killed: keep outbox records in their order, with a receipt and its time together                                       |
| O5 outcome_details json_valid dropped           | **survived**     | killed: settle an outbox record with a known outcome, and details only with an outcome                                 |
| O6 outcome<->acked_at CHECK dropped             | killed           | killed: keep outbox records in their order, with a receipt and its time together                                       |
| O7 code/details need outcome CHECK dropped      | killed           | killed: keep outbox records in their order, with a receipt and its time together; settle an outbox record with a known |
| O7b details alone allowed                       | **survived**     | killed: settle an outbox record with a known outcome, and details only with an outcome                                 |
| O7c code alone allowed                          | killed           | killed: keep outbox records in their order, with a receipt and its time together                                       |
| O8 unsent index not partial                     | **survived**     | killed: fixes the indexes: which are unique, which are partial                                                         |
| O9 unsent index dropped                         | **survived**     | killed: fixes the indexes: which are unique, which are partial; serve the reads the floor makes from an index          |
| O10 outbox.payload NOT NULL dropped             | **survived**     | killed: fixes every column: its type, whether it is required, its default and its key; settle an outbox record with a  |
| O11 outbox.host_id NOT NULL dropped             | killed           | killed: tag every row with its pairing and have no foreign key; fixes every column: its type, whether it is required,  |
| O12 seq AUTOINCREMENT (creates sqlite_sequence) | killed           | killed: has exactly the shell's tables                                                                                 |

Rust mutants (`cargo test --test local_db`, restore proven by sha/cmp):

| mutant                                   | failed tests                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3 clear filter `                        | _                                                                                                                                                                                       | true` | a_forget_refuses_while_unsent_records_remain, clearing_the_copies_empties_the_disposable_tables_and_nothing_else, sent_records_and_other_pairings_do_not_stop_a_forget |
| M4 `outbox` Disposable                   | every_table_has_a_forget_class, a_forget_refuses_..., sent_records_...                                                                                                                  |
| M5 `floor_codes` Disposable              | every_table_has_a_forget_class, clearing_the_copies_... (the clearing test alone first survived: its expectation followed `TABLE_CLASSES`; fixed with a named list of the eight tables) |
| M6 `floor_scans` unclassed               | every_table_has_a_forget_class                                                                                                                                                          |
| M7 `floor_sign_in_failures` DeviceData   | every_table_has_a_forget_class                                                                                                                                                          |
| M8 unopened count reads a missing outbox | a_database_that_did_not_open_is_counted_without_being_changed                                                                                                                           |
| M9 `floor_shifts` Workstation            | every_table_has_a_forget_class                                                                                                                                                          |

## Self-review

- No foreign keys (Rust `no_table_has_a_foreign_key` and the Vitest check both pass); `outbox` unsent = `acked_at IS NULL` and the forget guard counts exactly that; no `AUTOINCREMENT` (O12 shows `sqlite_sequence` would fail the table-list test and the class test).
- No test can hang: the Vitest tests are synchronous `node:sqlite`; the Rust race test keeps its 1 s margin and 10 s timeout (unchanged).
- Files changed: the six in the commit; `git status --short` empty; no stray `.cc-writes` in the stream or the main worktree (the sandbox lists one in the main worktree: ignored, pre-existing).

## Concerns

- The NOT NULL hardening above deviates from the plan's SQL text (intentional; migration is unapplied anywhere).
- `outbox.payload CHECK (json_valid(payload))` accepts any JSON (`[]`, `"x"`, `null`); a `FactRecord` is an object. The plan's SQL says json_valid, so I kept it; `json_type(payload) = 'object'` would be a one-line tightening for 2a6 to decide (a new migration then).
- Two things the schema cannot enforce and that 2a6-2a8 must: `floor_boxes.block_id` / `floor_codes.box_id` / `floor_scans.box_id` point at rows by convention only (no foreign keys, by rule); `floor_sign_in_failures` stays `Disposable` (open owner question).
- Counts differ from the plan's: `local_db` 26 (plan 16), `ipc` 26 (plan 18), Vitest 80 files / 2191 tests (plan 75 / 1939 + later tasks).
- Not run: Windows, a real WebView, `graphify update` (no local graph in the stream worktree).

---

# Fix round (review: Important 1 and Minors 1-6)

BASE `e7943ab49`, fix commit `dce8f8aeb` on `claude/2a5-floor` (`fix(standalone): the floor tables get the indexes of the reads that repeat on every scan, and objects only`). Tests are in the same commit. Four files: `0006_floor_production.sql`, `tests/local_db.rs`, `tests/ipc.rs`, `test/floor-schema.test.ts`.

## What changed

- `0006` (unreleased, edited in place): four indexes `outbox_settled (host_id, device_id, outcome) WHERE outcome IS NOT NULL`, `floor_codes_box (host_id, device_id, box_id, code_hash)`, `floor_codes_shift (host_id, device_id, shift_id)`, `floor_boxes_shift (host_id, device_id, shift_id, closed_at)`; `json_valid(x) AND json_type(x) = 'object'` on `snapshot`, `payload`, `outcome_details` (NULL still allowed for the two nullable ones); header comment explains both (and why `outbox_settled` is partial, and the three-counts contract).
- Two test comments (`ipc.rs`, `local_db.rs`) no longer say "an older build left it": they say a damaged or foreign table that no build of the app ever made. The "no outbox at all" case comments were accurate and stay.
- Minors 3 (SSCC collision), 4 (needs_fix scan) and 7 (spec §5.3 drift) and the three-counts note are in `.superpowers/sdd/2a5-minors.md`.

## The reviewer's claims, verified with EXPLAIN QUERY PLAN (node:sqlite 3.53.4 probe; the shell's 3.46 is pinned by the Rust test below)

Exact SQL from plan 2a6 (`readOutboxStatus`, `readWorkTotals`, `closeOpenBox`, `sendFactBatch`):

| read                                    | before                                                                                    | after                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| status bar, one `count(*) FILTER` query | `SCAN outbox`                                                                             | still `SCAN outbox` (so: three counts)                                             |
| unsent count (`acked_at IS NULL`)       | `SEARCH … outbox_unsent`                                                                  | same                                                                               |
| rejected / conflict counts              | `SCAN outbox`                                                                             | `SEARCH … COVERING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)` |
| accepted codes of a shift               | `SEARCH … sqlite_autoindex_floor_codes_1 (host_id=? AND device_id=?)` (the whole pairing) | `SEARCH … COVERING INDEX floor_codes_shift (… AND shift_id=?)`                     |
| closed boxes of a shift                 | `SCAN floor_boxes`                                                                        | `SEARCH … floor_boxes_shift (… AND shift_id=? AND closed_at>?)`                    |
| last SSCC                               | `SCAN floor_boxes` + temp B-tree                                                          | `SEARCH … floor_boxes_shift` + temp B-tree over that shift's closed boxes only     |
| codes of a box (digest)                 | `SEARCH … sqlite_autoindex_floor_codes_1 (host_id=? AND device_id=?)`                     | `SEARCH … COVERING INDEX floor_codes_box (… AND box_id=?)`                         |
| sender SELECT, forget count             | `outbox_unsent`                                                                           | `outbox_unsent`                                                                    |
| `sent_at` UPDATE (`id IN json_each`)    | `sqlite_autoindex_outbox_1 (id=?)`                                                        | same                                                                               |
| receipt UPDATE                          | `outbox_unsent`                                                                           | `outbox_unsent`                                                                    |

A side effect the reviewer did not list: the receipt transaction's `needs_fix` UPDATE flips from the `id` primary key to the `(host_id, device_id)` prefix of `floor_boxes_shift` (and it already did for `floor_scans_shift`). It is 2a6's SQL; with unary plus (`+host_id = ? AND +device_id = ?`) both are PK searches again (probed). Recorded as minor 2 for 2a6.

## RED / GREEN

- RED before the migration change: Vitest `floor-schema.test.ts` `3 failed | 23 passed (26)` (the index list, "serve the reads…", the new object test); Rust `the_floors_repeating_reads_search_an_index` failed: `should search outbox_settled (host_id=? AND device_id=? AND outcome=?), its plan is ["SCAN outbox"]` (exit 101).
- GREEN: Vitest `floor-schema.test.ts` + `local-executor.test.ts`: 2 files, 80 passed (was 79: one new test), verbose stderr 0 bytes; `local_db` 27 passed (was 26), `ipc` 26 passed (outside the sandbox); `typecheck`, `lint` clean; `cargo fmt --check` clean; `cargo check -p markiro-standalone --all-targets` 0 warnings; prettier and `git diff --check` clean; no `\u0` in the migration or the two Rust test files. The delayed-`setImmediate` stand was not run: the changed tests have no React or passive effects (plain executor calls over node:sqlite).

## Tests added

- "fixes the indexes": the four new indexes with `unique` and `partial`.
- "serve the reads the floor makes from an index": 2a6's exact reads, now matching the equality terms of the plan (`outbox_settled (host_id=? AND device_id=? AND outcome=?)`, `floor_boxes_shift (… shift_id=?`, …), the sender and the receipt still on `outbox_unsent`, the `sent_at` UPDATE on the record's key. The comment records the 3.53 vs 3.46 difference.
- Rust `the_floors_repeating_reads_search_an_index` (`tests/local_db.rs`): 12 reads on a raw connection of the shell's own SQLite; each plan must name its index and contain no `SCAN` of a table (json_each aside). It also holds the forget's count in `src/local_db.rs`'s own wording.
- "keep a record, a snapshot and receipt details as objects only": `{}` and a real record accepted for `payload`, `snapshot` and `outcome_details`; `[]`, `[1]`, `"x"`, `5`, `null`, `true` refused in each of the three columns (18 refusals); `outcome_details` NULL stays covered by the existing accepted cases.

## Mutants (restore proof: original copied to `/tmp/claude/fix-2a5-t1/0006.orig`; after every mutant `cmp` and `shasum -a 256` equal `4c957d7040d7d5c2c836ddb116ec8a722d6ec3ac36c516aee4b888abe529573e`; harness `/tmp/claude/fix-2a5-t1/mut.py`, output in `mut-all.txt`; final check "final sha ok True")

Run against Vitest `floor-schema.test.ts` (V) and the Rust plan test (C).

| mutant (one replacement in 0006)            | result                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| I1 drop `outbox_settled`                    | V killed ("fixes the indexes", "serve the reads"); C killed (`should search outbox_settled …, its plan is ["SCAN outbox"]`)               |
| I2 drop `floor_codes_box`                   | V killed (both); C killed (plan is the PK prefix)                                                                                         |
| I3 drop `floor_codes_shift`                 | V killed (both); C killed                                                                                                                 |
| I4 drop `floor_boxes_shift`                 | V killed (both); C killed (`SCAN floor_boxes`)                                                                                            |
| I5 `outbox_settled` not partial             | V killed (both); C killed (the unsent count moves to `outbox_settled`)                                                                    |
| I6 `outbox_settled` on `seq`, not `outcome` | V killed ("serve the reads"); C killed                                                                                                    |
| I7 `floor_codes_box` on `shift_id`          | V killed; C killed                                                                                                                        |
| I8 `floor_boxes_shift` loses `shift_id`     | V killed; C killed                                                                                                                        |
| I9 `floor_codes_shift` loses `device_id`    | V killed; C killed                                                                                                                        |
| I10 `outbox_unsent` not partial             | V killed ("fixes the indexes", "serve the reads"); C SURVIVED (the plan names the index either way; the partial flag is pinned by V only) |
| J1 `payload` object check dropped           | V killed (new object test)                                                                                                                |
| J2 `snapshot` object check dropped          | V killed (new object test)                                                                                                                |
| J3 `outcome_details` object check dropped   | V killed (new object test)                                                                                                                |
| J4 `payload` requires `'array'`             | V killed (3 tests)                                                                                                                        |
| J8 `snapshot` also accepts JSON `null`      | V killed (new object test)                                                                                                                |
| J9 `payload` also accepts JSON text         | V killed                                                                                                                                  |
| J10 `outcome_details` also accepts arrays   | V killed                                                                                                                                  |
| J5 `payload` loses `json_valid`             | SURVIVED, equivalent: `json_type` of malformed text raises, which is still a refused statement (`statement_failed`)                       |
| J6 `snapshot IS NULL OR` dropped            | SURVIVED, equivalent: a CHECK that evaluates to NULL passes in SQLite, so the branch is redundant (kept for readability, as before)       |
| J7 `outcome_details IS NULL OR` dropped     | SURVIVED, equivalent, the same reason                                                                                                     |

The older "json_valid dropped" mutants O2/O5/S6 of the first round are now equivalent (the malformed-text case is refused by `json_type` raising); J5 documents it.

## Concerns

- Only the SQLite versions in this machine are exercised (3.53 and the shell's 3.46 through `cargo test`); no Windows run.
- `outbox_settled` makes `acked_at IS NULL` counts depend on the planner keeping `outbox_unsent`: pinned by the plan tests, but only if 2a6 writes the status as three counts (minor 1 in `2a5-minors.md`).
- 2a6's receipt `needs_fix` query needs the unary-plus rewrite (minor 2); not mine to change.
