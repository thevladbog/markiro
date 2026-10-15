# Plan ХП, Task 1 — report

Status: DONE. Commit `32146bb07` on `claude/m1` (/tmp/claude/wt/m1), base `2c726efba`. Tree clean.

## What was done

- Host `POST /v1/device/sscc/blocks/known`: accepts 0–64 blocks (`> MAX_BLOCKS` is the only length refusal, message "0-64 blocks"); the empty list is checked after the epoch like any other (before a restore: 409 `no_restore`); after a restore: `200 {"results":[]}`, `known_blocks_epoch` set, no revision, no audit row, no block change.
- Fixture `proto/fixtures/known-blocks-request-empty.json`; Rust round-trip in `proto/tests/backup.rs`; Zod `knownBlocksRequestSchema` `.max(64)`.
- Station `reconcileRestore`: `do … while` — exactly one empty request for a pairing without blocks, none extra after a full 64.
- Office: `confirmNoBlocks` -> `confirmNotReturned`; `blocksNote` and confirm text per brief.

## RED / GREEN

- RED (`/tmp/claude/impl-hp-t1/red-vitest.txt`, `red-cargo.txt`): vitest 6 failed (read the known blocks…, asks the next sync…, sends one empty request…, keeps owing when the host answers the empty request…, two backups-page text tests); cargo `known_blocks`: `a_station_without_blocks_is_marked_by_an_empty_list_and_nothing_else_changes` FAILED (400 on empty list).
- GREEN: vitest `backups, restore-reconcile, backups-page, host-link-restore, app, api`: 335 passed. cargo `--test known_blocks` 13 passed (12 existing + new, plus my 64/65 test), `-p markiro-proto --test backup` 6 passed.
- Verbose run of the 3 changed files: stderr 0 (`grep -c "stderr |"` = 0); delayed-`setImmediate` stand: 81 passed (stand files deleted).
- Full package `run test`: 4521 passed / 91 failed, ALL timeouts (5 s) in 11 old office suites under load (cargo workspace was running at the same time); re-run of those 11 files with `--testTimeout=60000`: 527 passed, 1 failed = `floor-status-bar.test.tsx` "says nothing of a restore for a station that owes nothing, with no block either" — a REAL dependent test (expected no call for a pairing without blocks); fixed by meaning (`expect(asked.mock.calls).toEqual([[{ blocks: [] }]])`), file now 47 passed verbose, stderr 0. typecheck 0, lint 0, build 0.
- `cargo test --workspace --offline --locked` (unsandboxed, one final run): exit 0, 71 test binaries, 1126 passed, 0 failed, 0 warnings. `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings.
- Prettier gate live-proved (scratch `src/zz-scratch.ts` -> `[warn]`, exit 1, deleted); all changed files clean. `git diff --check` clean. `grep '\u04'`: only `pairing-code.ts:66`. `grep confirmNoBlocks`: none.

## Mutants (restore proof: sha256 of the 5 mutated source files identical before/after, `cmp` silent; backups in /tmp/claude/impl-hp-t1/bk; known_blocks.rs touched)

| #   | one-line mutant                                                 | killed by                                                                                               |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| M1  | `for`-style `while (start < blocks.length)` (no empty request)  | sends one empty request…, never-restored on empty, empty fails, empty answered, asks the next sync… (5) |
| M2  | host `is_empty() \|\|` back in the check                        | `a_station_without_blocks_is_marked…`                                                                   |
| M3  | Zod without `.max(64)`                                          | read the known blocks a station sends…                                                                  |
| M4  | Zod `.max(65)`                                                  | same                                                                                                    |
| M5  | host `len() >= MAX_BLOCKS`                                      | `a_request_of_the_largest_size_is_heard_and_one_block_more_is_not` (added)                              |
| M11 | host `len() > MAX_BLOCKS + 1`                                   | same + `only_a_station_after_a_restore_is_heard`                                                        |
| M6  | `while (start <= blocks.length)` (extra empty request after 64) | "sends exactly 64 blocks in one request…" (added)                                                       |
| M7  | drop `if (neverRestored) break`                                 | 3 never-restored tests (incl. new empty one)                                                            |
| M8  | chunk step 63                                                   | chunking tests (4)                                                                                      |
| M9  | page uses old key `confirmNoBlocks`                             | 12 backups-page tests                                                                                   |
| M10 | blocksNote old sentence                                         | shows the stations a restore waits for…                                                                 |
| M12 | host answers empty list before the epoch check                  | `a_station_without_blocks_is_marked…` (no_restore before restore)                                       |
| M13 | the `known_blocks_epoch` UPDATE never matches                   | `a_station_without_blocks…` and `…only_known_blocks_is_marked…`                                         |

## Tests added beyond the brief

Host: 64 accepted / 65 refused; vitest: exactly 64 blocks -> one request; never-restored host hears the empty request and the pairing settles; failing empty request keeps the pairing owing.

## Test totals

Plan did not state counts. Measured: focused 335 vitest, host `known_blocks` 13, proto `backup` 6, workspace cargo 1126.

## Files

fixture (new), `proto/tests/backup.rs`, `host/src/routes/known_blocks.rs`, `host/tests/known_blocks.rs`, `src/host/backups.ts`, `src/local/restore-reconcile.ts`, `src/office/backups/BackupsPage.tsx`, `src/i18n/ru.json`, tests `backups`, `restore-reconcile`, `backups-page`, `floor-status-bar` (the last by meaning, in the same commit).

## Anchor adaptations

None: all brief fragments matched exactly once. Only deviation: `test/floor-status-bar.test.tsx` (not in the brief's file list) fixed by meaning as the brief's step 4 anticipates for tests expecting no call.

## Concerns

- 11 old office suites time out at 5 s under load (pre-existing, pass with `--testTimeout=60000`).
- Not exercised: real restore on Windows, real host+station over LAN.
- The runbook/AGENTS.md/§25 texts are Task 6's (not touched here).
