# 2a8 Task 8 report — end-to-end floor scenario (fixture + Vitest + host replay)

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `c765f9890`.
Commit: `2d2cf3d31` test(standalone): one shift on one PC end to end, the station's records replayed through the host's router (one trailer, `git status --short` empty after). Evidence: `/tmp/claude/impl-2a8-t8/` (`mutate.py`, `mut.txt`, per-mutant outputs), `/tmp/claude/t8-*.txt`.

## What I did

Created, from the brief's blocks extracted programmatically (verbatim): `apps/standalone/host/tests/floor_scenario.rs`, `apps/standalone/proto/fixtures/floor-scenario.json`, `apps/standalone/test/floor-scenario.test.ts`. No source files touched (tests-only task).

## Anchor adaptations

1. Fixture ids of the four `box_exception` records: the executed exception modules allocate their ids in a different order than the plan's scratch copy (one id is taken before the record's id), so the first run failed only on ids: undo `…0011`→`…0012`, clear `…0014`→`…0015`, disassemble `…0022`→`…0023`, reprint `…0025`→`…0026` (in `records` and in the three `sends` id lists). Nothing else differed (data, kinds, order, sends identical). Host test is data-driven, unaffected. The addenda's text changes (done texts, finish mode, retention SQL, receipt statements) do not enter this scenario.

## RED / GREEN

- First Vitest run (verbatim fixture): 1 failed (fixture compare, only the 4 ids above) / 1 passed — `/tmp/claude/t8-v1.txt`. After the id adaptation: `test/floor-scenario.test.ts` 1 file, 2 passed, stderr count 0 (`t8-v2.txt`, verbose).
- `cargo test -p markiro-host --test floor_scenario` (in sandbox, router in-process): 2 passed, 0 failed.
- Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 116 files, 3536 passed (before: 115 / 3534; plan: 112 / 2643 on the scratch copy), stderr 0. Includes `protocol.test.ts` (Zod parity with the Rust fixtures).
- Rust parity (`proto/tests/fixtures.rs`) ran in the full workspace run: `cargo test --offline --locked --workspace` unsandboxed, exit 0, 54 result lines, 815 passed, 0 failed (before 813 at Task 7: +2).
- Gates: typecheck 0, lint 0, `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, prettier gate live-proved (probe flagged exit 1, deleted; json+ts clean), `git diff --check` clean, `grep '\u04'` only `pairing-code.ts:66`. Delayed-`setImmediate` stand not run: the new Vitest file has no React.

## Mutants (restore: copy in `/tmp/claude/impl-2a8-t8/before-*`, `cmp` + sha256 equal, `touch`ed; all `restore True True`)

| #   | Mutant                                       | Killed by                                     |
| --- | -------------------------------------------- | --------------------------------------------- |
| M1  | facts-sender `ORDER BY seq` → `seq DESC`     | Vitest: both tests                            |
| M2  | fixture `undo.targetScannedAt` = undo moment | cargo: both tests; Vitest: writes-the-records |
| X1  | fixture digest of box 1500 altered           | cargo: first test (digest_matches); Vitest    |
| X2  | close reason `other`                         | cargo both; Vitest                            |
| X3  | `acceptedUnits` 6                            | cargo both; Vitest                            |
| X4  | disassemble names box 1501                   | cargo both; Vitest                            |
| X5  | `clear` → `reprint`                          | cargo both; Vitest                            |
| X6  | 2nd send `lost` → `receipts`                 | Vitest (sends compare)                        |

## Concerns

1. The fixture ids differ from the plan's by the four exception ids (adaptation above) — if the plan is later re-derived from a fresh copy, expect the same.
2. Not exercised: host mutants (the "same batch again → nothing written" idempotency is asserted but I did not mutate host code); real Tauri shell/WebView2.
3. `graphify update .` not run.
