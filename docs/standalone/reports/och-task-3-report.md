# Plan ОЧ, Task 3 — report

Status: DONE (with the concerns below). Commit `26e0c234e` on `claude/m1` (/tmp/claude/wt/m1), base `06df8e6d4`. Tree clean.

## What was done

- `src/floor/queue/outbox-recovery.ts` (brief's code, prettier-formatted, one adaptation below): `readQueue`, `readStrandedRecords`, `resendRefused`, `dismissRecord`, `StaleQueueError`, `UnreadableRecordError`, `RESEND_CHUNK = 50` and the seven SQL constants.
- `test/outbox-recovery.test.ts`: the brief's 9 tests plus 16 more (25 in all).
- `test/floor-schema.test.ts`: the brief's two tests (plan pin on Node 3.53; text agreement with the Rust file, 7 distinct statements).
- `src-tauri/tests/local_db.rs`: seven `QUEUE_*` constants word for word; `reads` 92 -> 98 (`QUEUE_UNSENT`, `QUEUE_SETTLED`, `QUEUE_RESEND_READ`, `QUEUE_RESEND_INSERT`, `QUEUE_RESEND_MARK`, `QUEUE_DISMISS`); the stranded count has its own exact-plan assertion outside the generic loop (the loop forbids a `SCAN`).

## Data-integrity properties (each tested)

- «Отправить снова» creates NEW records (new ids), `data` byte for byte, in the old `seq` order, linked by `resent_as`; INSERT of the copies and MARK of the originals are ONE `local.transaction` with `expectedChanges: part.length` on both. Tests: a mark that fails (RAISE ABORT trigger) takes the copy back; a mark that changes no row (RAISE IGNORE trigger) takes the copy back and reports `StaleQueueError` (without MARK's `expectedChanges` a live duplicate would stay).
- Idempotent: two simultaneous presses write exactly one set of copies (one `Promise.allSettled` fulfils, the other is `StaleQueueError`); a second press finds nothing; a crash between parts (second transaction throws) leaves 50 resent + 50 live, and the next press carries only the remaining 5, order preserved, no id doubled; a copy refused again is sent once more and the first stays resolved.
- Only `rejected`, unresolved, this pairing's, this shift's records go again: conflicts, waiting, accepted, other shift, other device, other host, already resolved are untouched (module level and, with direct statement runs, INSERT/MARK level).
- «Снять с очереди» writes `resolution`, `resolved_at`, `resolved_by` together (`expectTied` checks `(resolution IS NULL) = (resolved_at IS NULL) = (resolved_by IS NULL)` and `resent_as` only with `resent` after every writing test); never a `shift_closed`; never another pairing's, waiting, accepted, resent or unknown record (`StaleQueueError`, table unchanged byte for byte).
- The sender never sends a dismissed or resent-away record: real `sendFactBatch` after dismiss + resend sends exactly the waiting record and the new copy, once (second run sends nothing).
- Records of the previous pairing: `stranded` counts unsent records of any other device OR host (not receipted ones, not this pairing's); read-only (count), nothing in the module writes to them.

## RED / GREEN

- RED (`/tmp/claude/impl-och-t3/red.txt`): both files fail with `Failed to resolve import "../src/floor/queue/outbox-recovery.js"` (written before the implementation existed).
- GREEN: `outbox-recovery` + `floor-schema` 62 passed (verbose, `stderr` count 0; no React in these tests, so the delayed-`setImmediate` stand is not applicable). cargo `--test local_db` 32 passed. Full package Vitest (`--testTimeout=60000 --hookTimeout=60000`): 151 files / 4657 passed / 0 failed (base 4630; +27 = 25 new + 2 schema). typecheck 0, lint 0, `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto -p markiro-standalone --all-targets` 0 warnings. Prettier gate live-proved (scratch `const  x = 1` -> `[warn]`, rc 1, deleted); changed files clean. `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`.
- ONE final `cargo test --workspace --offline --locked --no-fail-fast` unsandboxed after the commit: exit 0, 71 binaries, 1130 passed, 0 failed, 0 warnings (no new Rust test functions; the existing plan test gained six reads and the stranded assertion).

## Mutants (restore proof: sha256 of `outbox-recovery.ts` 26ec1f17… identical after every run, restored from `/tmp/claude/impl-och-t3/bk`; `local_db.rs` 1ebaffea… identical, `cmp` clean, touched after each Rust mutant; logs `mutants.log`, per-mutant output `out-*.txt`, `rust-*.txt`)

First run was discarded (a stray second runner corrupted it); the table is the clean sequential re-run. "B" = killed by behaviour tests, "S" = killed only by the plan pin / text-agreement.

| id         | one-line mutant                                                       | killed by                                                                                                                           |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R1         | READ drops `resolved_at IS NULL`                                      | B (doubled-resend, chain, sender tests)                                                                                             |
| R2/R2b/R2c | READ host-or-device / drops host / drops device                       | B (takes-off-nothing test) + S                                                                                                      |
| R3         | READ drops the shift term                                             | B (sends-again-only-the-shift test)                                                                                                 |
| R4         | READ takes conflicts too                                              | B (same)                                                                                                                            |
| R5         | READ `ORDER BY seq DESC`                                              | B (order tests)                                                                                                                     |
| I1         | INSERT drops ORDER BY and the list is reversed in code                | B (order tests)                                                                                                                     |
| I1b        | INSERT drops ORDER BY only                                            | S only: behaviourally equivalent today (the list drives the join order); the ORDER BY is a pinned guarantee, not observable         |
| I2/I3      | INSERT drops host / device guard                                      | B (statement-guards test) + S                                                                                                       |
| I4         | INSERT takes any settled outcome                                      | B (statement-guards)                                                                                                                |
| I5         | INSERT drops `resolved_at` guard                                      | B                                                                                                                                   |
| I6         | INSERT writes kind `scan` for all                                     | B (close-carrying test)                                                                                                             |
| K1-K4      | MARK drops host / device / outcome / resolved_at guard                | B (statement-guards)                                                                                                                |
| K5-K7      | MARK sets no resolved_at / resolved_by / resent_as                    | B (11 tests)                                                                                                                        |
| K8         | MARK writes `dismissed`                                               | B (9 tests)                                                                                                                         |
| D1-D3      | DISMISS drops host / device / id                                      | B (takes-off-nothing, dismiss tests)                                                                                                |
| D4         | DISMISS only `rejected`                                               | B (brief's conflict dismissal)                                                                                                      |
| D4b        | DISMISS any settled outcome                                           | B (accepted -> Stale)                                                                                                               |
| D5         | DISMISS takes a close                                                 | B (brief's test)                                                                                                                    |
| D6         | DISMISS drops `resolved_at` guard                                     | B (resent/dismissed -> Stale)                                                                                                       |
| D7-D9      | DISMISS writes no resolved_at / resolution / resolved_by              | B                                                                                                                                   |
| C1         | no empty-list check                                                   | B                                                                                                                                   |
| C2         | INSERT without `expectedChanges`                                      | SURVIVES: equivalent by design — MARK has the same guards and its `expectedChanges` rolls the whole transaction back (C3 is killed) |
| C3         | MARK without `expectedChanges`                                        | B (RAISE IGNORE test: a live duplicate would stay)                                                                                  |
| C4         | dismiss without `expectedChanges`                                     | B                                                                                                                                   |
| C5         | `RESEND_CHUNK = 100`                                                  | B (new budget test `RESEND_CHUNK * MAX_RECORD_BYTES <= 1 MiB`; was surviving)                                                       |
| C5b        | no chunking                                                           | B                                                                                                                                   |
| C6/C7      | `changes_mismatch` not mapped to `StaleQueueError` (resend / dismiss) | B                                                                                                                                   |
| C8         | no data comparison                                                    | B (reordered-keys test)                                                                                                             |
| C9         | no `"data" in raw` check                                              | SURVIVES: equivalent — the schema check already requires `data`; the narrowing is for TypeScript                                    |
| C9b        | no schema check                                                       | B (new test: record with data but unknown kind; was surviving, TypeError instead of `UnreadableRecordError`)                        |
| C10/C11    | new id not written / old id wins                                      | B                                                                                                                                   |
| C12        | one id for all records                                                | B                                                                                                                                   |
| C13        | INSERT and MARK in separate transactions                              | B (RAISE ABORT test)                                                                                                                |
| Q1         | settled not sorted                                                    | B (conflict-first test)                                                                                                             |
| Q2/Q2c     | unsent sorted by kind only / newest first                             | B (new: scan older than the labels; were surviving)                                                                                 |
| Q2b        | unsent ties not by kind                                               | SURVIVES: equivalent while `GROUP BY kind` returns ascending kinds and `sort` is stable                                             |
| Q3-Q5      | settled includes resolved / only rejected / host-or-device            | B                                                                                                                                   |
| Q6-Q8      | sscc without payload / box / pallet arm                               | B (sscc test)                                                                                                                       |
| Q9         | shift join not by pairing                                             | S (plan pin)                                                                                                                        |
| Q10-Q11    | unsent counts receipted / host-or-device                              | B                                                                                                                                   |
| Q12-Q14    | stranded host-or-device / counts own too / not read                   | B                                                                                                                                   |
| Q15        | stranded without `INDEXED BY`                                         | S (plan pin, Node and shell)                                                                                                        |
| RS1        | Rust `QUEUE_DISMISS` without `kind <> 'shift_closed'`                 | vitest text agreement                                                                                                               |
| RS2        | Rust pin of `QUEUE_RESEND_READ` names `outbox_unsent`                 | cargo `the_floors_repeating_reads_search_an_index`                                                                                  |
| RS3        | Rust `QUEUE_STRANDED` without `INDEXED BY`                            | cargo (plan walks `COVERING INDEX outbox_shift`)                                                                                    |
| RS4        | Rust pin of `QUEUE_UNSENT` names `outbox_shift`                       | cargo                                                                                                                               |

## Test totals

Plan: brief's 9 + 2 schema tests (+7 Rust reads). Measured: 25 + 2 (+6 Rust reads, the 7th is the exact-plan assertion). Full Vitest 4657 (base 4630); cargo workspace 1130 (unchanged).

## Anchor adaptations

- `STRANDED_COUNT_SQL`: the brief's text planned as `SCAN outbox USING COVERING INDEX outbox_unsent`, but since migration 0010 (ХП) both SQLite 3.53 and the shell's 3.46 walk `outbox_shift` (the WHOLE outbox) instead. Measured on 300 000 records: 11 ms vs 0.08 ms. Adapted by meaning: `FROM outbox INDEXED BY outbox_unsent`, plan pinned as `SCAN outbox USING INDEX outbox_unsent` (Node) and the same in an exact-plan assertion on the shell; the generic loop of the Rust test forbids a `SCAN`, so this statement has its own assertion after the loop.
- `RESEND_READ` plan: the brief left the index open; both runtimes name `outbox_settled (host_id=? AND device_id=? AND outcome=?)`. Pinned exactly in Node (no other step) and as that index in the shell.
- The brief's "no SCAN" filter line for `RESEND_READ` was replaced by the exact-plan equality.
- The module was run through prettier (the brief's code had lines over 100 columns); texts of the SQL constants are unchanged.
- `vi.spyOn(local, "transaction")` worked as is.

## Self-review

- The sender is safe by construction (it reads `acked_at IS NULL`; every resolvable record has an outcome hence `acked_at`; receipts apply only to `acked_at IS NULL`), and tested against the real `sendFactBatch`.
- Migration 0013 does not tie `resolved_at` to `resolution`; the module is the only writer and writes both in one statement (checked by `expectTied` and mutants D7/D8/K5).
- No UI: confirmation wording and reasons are Task 4 (the module requires nothing but the operator id; dismissal is irreversible per record, there is no undo statement).

## Concerns

- `RESEND_READ`/`QUEUE_SETTLED` walk the pairing's `rejected`/`conflict` records through `outbox_settled`, including resolved ones (index is by outcome, not partial on resolution): O(refusals ever recorded for the pairing) per screen opening, filtered by `resolved_at`. Fine at human volumes; a covering partial index on unresolved refusals is the same open item as Task 2's (new migration 0014+, final review).
- `INDEXED BY outbox_unsent` makes the statement fail if that index is ever renamed or dropped (the shell and Node plan pins would flag it first).
- Equivalent survivors: I1b, C2, C9, Q2b (see table).
- A dismissed/resent record of a pairing that was forgotten stays on disk (DeviceData) — unchanged from Task 1.
- Not exercised: the Windows shell with a real host, a screen (Task 4).
