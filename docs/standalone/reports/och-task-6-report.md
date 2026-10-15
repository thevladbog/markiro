# Plan ОЧ, Task 6 — report

Status: DONE. Commit `cb896ae38` on `claude/m1` (/tmp/claude/wt/m1), base `b129d010a`. Tree clean. Rust untouched, so no cargo run (the task touches only `src/` and `test/`).

## What was done

- `block-supply.ts`: `dropBlock` (INSERT into `floor_block_drops` ... ON CONFLICT (host_id, device_id, block_id) DO NOTHING + DELETE of the request in ONE transaction); the mismatch/overlap branch computes `mismatch` and writes reason `mismatch` / `overlap`; docstrings of `SupplyResult` and `createBlockSupply` updated. `validation_failed`, `sscc_exhausted` and every other path still use `dropRequest` and leave no row.
- `host-link.ts`: `factsNow.current` returns while `factRetry !== null` (a failed send's pause or the restore hold), else triggers; doc comments of `requestFacts` and `useHostLink` updated. Going online, a revision, the reconciler and the pause's own end still call `factSender.trigger()` directly.
- Tests: the brief's three block-supply changes; the brief's rewritten host-link-facts test; plus: columns/pairing/request/`dropped_at` test, mismatch-wins-over-overlap test, first-record-kept-once test, atomicity test (insert fail / delete fail), no-row assertion added to the `validation_failed on %s` each, a boundary test of the attempts count (asks through pause 1 do not count; pause end = attempt 2; asks through pause 2 do not count; pause end = attempt 3; after a success a request sends at once), and the "says whether a failed send was..." test moved to fake timers and now waits the pause's end instead of relying on an immediate send (it would otherwise take a real 2 s).

## RED / GREEN

- RED (`/tmp/claude/impl-och-t6/red.txt`): 3 failed (both block-supply tests, new host-link test: send called 3 times) as the brief expects.
- GREEN: focused verbose (block-supply, host-link-facts): 91 passed, stderr empty (0 bytes, 0 `stderr |`); neighbours host-link-restore, floor-work-screen, app: pass unchanged (315 over 5 files before the extra tests). Delayed-setImmediate stand x3 on 6 files (block-supply, host-link-facts, host-link-restore, floor-work-screen, app, floor-app): 410 passed each. Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 152 files, 4718 passed, 0 failed (base 4712). typecheck 0, lint 0, build 0. Prettier gate live-proved (scratch file -> `[warn]`, rc 1, deleted); the 4 changed files clean. `git diff --check` clean. `grep '\u04'`: only `pairing-code.ts:66`.
- One stand failure found and fixed on the way: my boundary test's first version used 1.9 s of a 2 s pause and drifted past it under the slowed stand; margins are now 0.7 s / 1.6 s.

## Mutants (script `/tmp/claude/impl-och-t6/mut.py`, log `mutants.log`; `restored=True` = sha256 identical, final sha 1518ca59… block-supply, ed792ff4… host-link, backups in /tmp/claude/impl-och-t6/bk)

| id                                                                        | one-line mutant                                                       | killed by                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| H1                                                                        | `if (factRetry !== null) return;` removed                             | new pause test, boundary test                                           |
| H2                                                                        | guard inverted (`=== null`)                                           | 5 tests incl. "goes when a screen asks", "waits again from first pause" |
| H3                                                                        | guard on `factsHeld` only                                             | new pause test, boundary test                                           |
| B1                                                                        | reasons swapped                                                       | 6 tests (mismatch, overlap, columns...)                                 |
| B1b                                                                       | overlap tested before mismatch                                        | "mismatch even when it also overlaps"                                   |
| B2                                                                        | mismatch alone not dropped (only overlap)                             | prefix/extension test, pallet test, once-per-id test                    |
| B3                                                                        | no ON CONFLICT clause                                                 | prefix/extension test (same block id 3x), once-per-id test              |
| B4                                                                        | DO UPDATE instead of DO NOTHING                                       | same two tests                                                          |
| B5                                                                        | request not deleted in `dropBlock`                                    | 5 tests                                                                 |
| B6 / B6b                                                                  | insert and delete in two transactions (either order)                  | atomicity test                                                          |
| B7                                                                        | `dropped_at` = epoch                                                  | columns test                                                            |
| B8                                                                        | request_id = block id                                                 | columns, atomicity                                                      |
| B9                                                                        | device_id = host id                                                   | columns test                                                            |
| B10                                                                       | prefix/extension from the request, not the block                      | prefix/extension test                                                   |
| B11                                                                       | to_serial = from_serial                                               | prefix test, columns, once-per-id                                       |
| B12                                                                       | `dropRequest` also writes a drops row (validation_failed leaves none) | refusal tests, requestId test, validation each                          |
| H1-H3 were re-run after the final test timing edit: all killed, restored. |

## SQL / query plans

No new read statement. The new INSERT ... ON CONFLICT is keyed on the table's primary key (a pure write; there is no scan plan to pin) and its DELETE (`WHERE request_id = ?`) is the existing statement already pinned in `floor-schema.test.ts` and `local_db.rs`. The drops table's read (`count(*) ... WHERE host_id = ? AND device_id = ?`) was pinned in both by Tasks 1 and 5. No change in either pin file.

## Anchor adaptations

- None semantic. The brief's `rows` import in host-link-facts already existed. The "replaced" test text matched. Step 3a: the only neighbour that asked for a send during a pause and would wait for it is "says whether a failed send was the link's, the host's or this computer's" (host-link-facts): it passed unchanged but now took a real 2 s pause; rewritten to fake timers + wait for the pause's end. host-link-restore and floor-app uses of `requestFacts` needed no change.

## Concerns

- Offline scan attempts: `factRetry` is armed only while the link is `online`; an offline link sends nothing (REPK-S rule unchanged), so offline scans never count an attempt either way; attempts are counted once per pause end / online / revision / reconcile trigger. Not changed.
- Second block with the same id but another reason is not re-recorded (DO NOTHING by the brief); the first reason stays.
- Status-bar display of drops was done in Task 5; not exercised in a real shell or on Windows.
