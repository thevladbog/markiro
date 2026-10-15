# plan 2a6 Task 5 report: re-ordering SSCC blocks (half rule, request kept until its block)

Status: DONE_WITH_CONCERNS. Commit `d8dcb7d6f feat(standalone): SSCC blocks by the half rule, a request kept until its block` (on aa2481c27, branch claude/2a6-scanning, worktree /tmp/claude/wt/2a6). `git status --short` is empty after the commit; exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## What was done

- `apps/standalone/src/floor/work/block-supply.ts` (new): the brief's code verbatim, plus ONE addition of mine (see "Beyond the brief" 1).
- `apps/standalone/test/floor-block-supply.test.ts` (new): the brief's 11 tests (one data change, see "Anchor adaptations") plus 44 more = 55 tests.
- `apps/standalone/test/floor-schema.test.ts`: lines for the new repeated reads in the Node query-plan list (addendum 5).
- `apps/standalone/src-tauri/tests/local_db.rs`: the same lines in the shell's list (`the_floors_repeating_reads_search_an_index`): `[(&str, &str); 19]` becomes 23, plus one bounded-scan assertion (see "Beyond the brief" 2).
- Nothing else touched: no host, proto, migration, manifest, lockfile; no change to `box-close.ts` (N15: the module never rewrites a kept block's `next_serial`; pinned by test and mutants).

## Anchor adaptations

The brief's fragments were new files, so no anchors were involved. Differences from the brief:

1. Brief test 2 ("asks once the newest block has less than half left, and not at half") seeds blocks 1-2000 and 2001-4000 and lets the host answer with the default block 3500-5499, which lies inside the second kept block. With my overlap guard (Beyond 1) that answer is refused. I changed only the host's answer in that test to `blockFor(request, 4001)` (4001-6000); the half-rule boundary values (3001 = exactly half, 3002 = less) and the expected `remainingSerials` total (2000 + 999 + 2000) are unchanged.
2. Test imports of the brief extended (closeOpenBox, processScan, LocalDbError, enteredShift, km, scanContext) for my extra tests. `DatabaseSync` type import kept.

## Beyond the brief

1. **Overlap guard** (the task text: "serial ranges of stored blocks never overlap"). `sharesSerials`: before a block is kept, `SELECT 1 FROM floor_sscc_blocks WHERE host_id/device_id/issuer_prefix/extension = ? AND block_id <> ? AND from_serial <= newTo AND to_serial >= newFrom LIMIT 1` (index `floor_sscc_blocks_prefix`). A hit drops the request and returns `failed` (never filed, never asked for again), like a block of another prefix. Scenario it protects: a host restored from a backup with its counter set back would otherwise issue serials this station has already put on boxes. `block_id <> ?` keeps an exact repeat of a kept block (same id) a harmless duplicate (`ON CONFLICT DO NOTHING`, cursor untouched). Blocks of another pairing, prefix or extension never block. Adjacent ranges are fine.
2. **Query plans.** `waitingRequest` filters by host/device/prefix/extension on `floor_block_requests`, whose only index is its primary key (migration 0006 is not mine), so its plan is `SCAN floor_block_requests`. The table holds at most one row per pairing and prefix. The shell's list forbids any `SCAN`, so I added a separate assertion to the Rust test and the Node test: the plan's only scan is exactly `SCAN floor_block_requests`. Every other new statement is on an index: newest, remaining and overlap reads on `floor_sscc_blocks_prefix`; the request's DELETE on `sqlite_autoindex_floor_block_requests_1 (request_id=?)`. A recording test EXPLAINs the SQL the code actually sends (scenario: one exhausted top-up, one stored top-up, one `remainingSerials`; counts per statement: newest 2, waiting 2, overlap 1, remaining 1, DELETE 2).
3. 44 extra tests (the table below names the guard each pins).

## Test coverage added (beyond the brief's 11)

Half rule: odd size 7 (4 left = enough, 3 left = ask); one-serial block (1 left = enough, 0 left = ask); newest block used up with an older one still holding serials (older cursor untouched); newest is by `from_serial` not by `received_at` or insertion order; four foreign-key variants (prefix/extension/device/host) in BOTH directions (newer foreign block nearly used must not trigger; newer foreign full block must not hide an exhausted own block); `remainingSerials` with no block, with another host's block, with `extension` 1.
Pending request: offline with a pending request is `offline`, request kept, no call; offline with enough serials is `enough`; pending request is the one sent when wanted and no second request is created; oldest by `requested_at` first (id order contradicts it); a foreign pairing/prefix/extension request is never replayed nor touched; request and block rows carry host/device and the stamped times (`requested_at` first clock tick, `received_at` second).
Block kept: answered twice = stored once, cursor (`next_serial`) and `received_at` unchanged (N15); one-serial block kept; overlap refused (5 ranges incl. touching ends); adjacent ranges kept; same range of another pairing/prefix/extension/host kept; atomicity both ways (removal fails: no block; insert fails: request stays; same supply continues and replays); exhausted drops the request, asks again with a NEW id next call, and no kept serial is touched (501 still counted).
Errors: six failure shapes (transport, revoked device, 500, transport carrying a host code, transport carrying `sscc_exhausted`, unreadable answer) are handed to the shell once and the request stays and is replayed with the same id; `validation_failed` on other fields or none drops once and asks no more in that call; nothing is handed to the shell for refusals; exhaustion/refusal/foreign block drop only their own request; a rejected top-up does not stick (the next call runs afresh).
Integration with Task 4: with the supply and `closeOpenBox` together, the close takes serials 1506..1509 of the older block, then 3500 of the supplied block.

## Evidence

RED (before the implementation existed): `vitest run test/floor-block-supply.test.ts` fails to load: `Failed to resolve import "../src/floor/work/block-supply.js"` (`/tmp/claude/impl-2a6-t5/red1.out`). With only the brief's code and the 11 brief tests: `Tests 11 passed (11)` (`green1.out`, verbose, stderr 0 bytes). RED for the extras against the brief implementation: 4 failed | 48 passed (`red2.out`): the overlap refusal test and the query-plan test (no overlap read) were genuine REDs; two more were my test-data mistakes (corrected: the half-rule is "exactly half = enough").

GREEN: `vitest run test/floor-block-supply.test.ts`: 55 passed (55). `test/floor-schema.test.ts`: 26 passed (26).

Counts: the plan says the full run after Task 5 is 92 files / 2284 tests on the copy (11 new tests). Measured on the real tree: 95 files / 2845 tests (before this task 94 / 2790; this task adds 1 file and 55 tests, of which 11 are the brief's). Full run default 5 s timeout: 94 passed, 1 failed file: `template-editor.test.tsx` two tests timed out at 5000 ms (untouched code, known machine-load class); alone `template-editor.test.tsx` passes 97/97; whole suite with `--testTimeout=60000`: Test Files 95 passed (95), Tests 2845 passed (2845) (`full60.out`).

Hygiene:

- `vitest --reporter=verbose` on floor-block-supply + floor-schema: 81 passed, stderr 0 bytes, no `act`/warning lines.
- Delayed-`setImmediate` (3 ms) stand on the same two files: 81 passed, stderr 0 bytes; both stand files removed.
- `typecheck` exit 0; `lint` exit 0.
- Prettier gate (via `pnpm --dir /tmp/claude/wt/2a6 exec prettier --ignore-path .prettierignore --check <repo-relative paths>`): printed "Checking formatting..." and "All matched files use Prettier code style!" for block-supply.ts, floor-block-supply.test.ts, floor-schema.test.ts. Live proof: a scratch `apps/standalone/test/zz-gate-scratch.ts` with `const  x   =  1;` gave `[warn] ... Code style issues found`, exit 1, then deleted.
- `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` finds only `src/host/pairing-code.ts:66`; `local_db.rs` has no `\u0`.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` exit 0 (I ran `cargo fmt --all` once to format my own Rust lines; only `local_db.rs` changed).
- `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db` (unsandboxed): 27 passed, includes `the_floors_repeating_reads_search_an_index` on the shell's SQLite 3.46 with the 4 new lines and the bounded-scan assertion. `--test ipc` not run: the shell's list of commands is untouched (only a test list in `local_db.rs`).
- Live check of the Node list: switching the overlap line's plan to `+host_id` made `serve the reads the floor makes from an index` fail; restored (sha256 `980aea3f…cfec15` before and after, `cmp` silent).

## Mutants

Runner `/tmp/claude/impl-2a6-t5/mut.py`, log `/tmp/claude/impl-2a6-t5/mut-all-run1.out` (N34-N36 re-run after strengthening the plan test, `mut.py N34 N35 N36`). All mutants applied to `src/floor/work/block-supply.ts`; original copy `/tmp/claude/impl-2a6-t5/block-supply.before`; after every run the file was restored (runner compares content and sha256) and at the end `cmp` is silent and sha256 is `7a0357d13d8588a4cb02c974f66ce0ad82f8ac8c095395279851359f7b0ad6d4` as before. Each row: killed, failing test named (one of the killers; count in brackets). All 12 brief mutants M1-M12 also run, all killed.

| id    | one-line mutant                                                         | killing test (count)                                                                                                      |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M1    | `left * 2 <= size`                                                      | asks once the newest block has less than half left, and not at half (+ close integration) (2)                             |
| M2    | `ORDER BY from_serial` (oldest)                                         | asks when the newest block is used up…, judges the block with the greatest first serial… (3)                              |
| M3    | online check removed                                                    | asks nothing while offline…; request that waits is not sent while offline (2)                                             |
| M4    | new request after refusal without `fresh`                               | drops a request the host refuses as another prefix's…, once (1)                                                           |
| M5    | no new request after refusal                                            | same test (1)                                                                                                             |
| M6    | exhausted keeps the request                                             | (exhaustion) drops its own request…; asked once more after exhaustion; drops the request when the host has no serials (3) |
| M7    | other prefix accepted                                                   | keeps no block of another prefix or extension (1)                                                                         |
| M8    | other extension accepted                                                | same test (1)                                                                                                             |
| M9    | no single-flight                                                        | runs one top-up at a time (1)                                                                                             |
| M10   | pending request not replayed                                            | 12 tests (repeat after failure, restart, the six failure shapes…)                                                         |
| M11   | request written after the send                                          | 35 tests (first: asks for a block…, keeping the request before it asks)                                                   |
| M12   | request not removed with the block                                      | 10 tests (first: foreign-request test; brief's test 1)                                                                    |
| N1    | `left < Math.floor(size/2)` (odd sizes)                                 | 3 (odd-sized block test among them)                                                                                       |
| N2    | size without `+1`                                                       | 3                                                                                                                         |
| N3    | left without `+1`                                                       | asks at less than half of an odd-sized block…; one-serial block (4)                                                       |
| N4    | newest by `received_at DESC`                                            | judges the block with the greatest first serial… (3)                                                                      |
| N5 x4 | newest read ignores host / device / prefix / extension                  | the four "does not take a newer block of another X" tests (3 each)                                                        |
| N5 x4 | waiting read ignores host / device / prefix / extension                 | foreign-request tests and "drops its own request and no other" (1-4)                                                      |
| N5 x4 | overlap read ignores host / device / prefix / extension                 | "is kept beside a block of another X with the same serials" (3 each)                                                      |
| N5 x4 | remaining ignores host / device / prefix / extension                    | counts no serial where there is no block…; plan test (2-3)                                                                |
| N6    | pending ordered by id only                                              | is the oldest of the pending ones, by the time it was kept (1)                                                            |
| N7    | offline check before the "enough" check                                 | request that waits is not sent while offline… (1)                                                                         |
| N8    | pending request not replayed when not wanted                            | is kept once when the host answers it twice…; repeats… (2)                                                                |
| N9    | pending sent while offline                                              | request that waits is not sent while offline (1)                                                                          |
| N10   | request time wrong                                                      | is kept with the time it was made… (1)                                                                                    |
| N11   | block time wrong                                                        | same test (1)                                                                                                             |
| N12   | request host/device swapped                                             | 10                                                                                                                        |
| N13   | block host/device swapped                                               | 5 (first: time/host test)                                                                                                 |
| N14   | cursor starts at `toSerial`                                             | 5                                                                                                                         |
| N15a  | duplicate block `DO UPDATE SET next_serial`                             | is kept once when the host answers it twice, and its cursor stays (1)                                                     |
| N15b  | duplicate block plain INSERT                                            | same test (1)                                                                                                             |
| N15c  | `INSERT OR REPLACE`                                                     | is never kept without its request going… (1; also rewrites the cursor)                                                    |
| N16   | dropRequest deletes every request                                       | "(a refusal) drops its own request and no other" (3)                                                                      |
| N17   | store deletes every request                                             | foreign-request test (3)                                                                                                  |
| N18   | overlap `from_serial <`                                                 | is not kept when it shares a serial… (1)                                                                                  |
| N19   | overlap `to_serial >`                                                   | same test (1)                                                                                                             |
| N20   | overlap counts the block itself                                         | is kept once when the host answers it twice (1)                                                                           |
| N21   | overlap not checked                                                     | is not kept when it shares a serial… (2)                                                                                  |
| N22   | single-serial block refused (`<=`)                                      | is kept when it is a single serial (1)                                                                                    |
| N23   | any `validation_failed` retried                                         | "(validation_failed on X) drops the request and asks no more" and others (4)                                              |
| N24   | transport error read as the host's                                      | the two transport-with-host-code cases (2)                                                                                |
| N25   | other failures not handed to the shell                                  | 8                                                                                                                         |
| N26   | refusal also handed to the shell                                        | does not tell the shell…, refusal tests (3)                                                                               |
| N27   | `running` never reset                                                   | 15                                                                                                                        |
| N28   | `sum` without `coalesce`                                                | counts no serial where there is no block… (2)                                                                             |
| N29   | remaining off by one                                                    | 7                                                                                                                         |
| N30   | remaining default extension 1                                           | 6                                                                                                                         |
| N31   | request kept with extension 1                                           | 18                                                                                                                        |
| N32   | request kept with another prefix                                        | 18                                                                                                                        |
| N34   | remaining read loses its index (`+host_id`)                             | the statements a top-up repeats (1)                                                                                       |
| N35   | overlap read loses its index                                            | same (1)                                                                                                                  |
| N36   | request DELETE by an unindexed expression                               | same (1), after strengthening the plan test (see below)                                                                   |
| N33   | block filed under the block's prefix/extension instead of the request's | SURVIVES: EQUIVALENT, the two are equal after the mismatch check                                                          |

One test was strengthened because of a surviving mutant: N36 first survived because the plan recorder keyed statements by SQL text, so the two sites sharing `DELETE FROM floor_block_requests WHERE request_id = ?` (the drop and the store) were checked once, and the scenario never ran the drop. The scenario now runs an exhausted top-up first and the recorder keeps every send with an exact count per statement; N36 is then killed.

## Self-review against the data-integrity points

- Never lose a block: the block and the removal of its request are one transaction; a failing write rejects (the request stays, the same supply replays it with the same id; tested both ways).
- Request stored before send, replayed whole after crash/lost answer/restart (restart test on a file DB); host replay returns the same block; a block received twice is stored once with its cursor untouched.
- Never request while pending: a pending request for the key is always the one sent; `keepRequest` runs only when none waits; pending requests of other pairing/prefix/extension are ignored and untouched.
- Unused serials of a kept block are never discarded or rewritten (exhaustion, failures, duplicate answer, overlap refusal all leave the rows byte-identical).
- Overlap guard: see Beyond 1. Exhausted is explicit (`{ kind: "exhausted" }`) and not sticky: the next call asks again with a fresh request id.
- The box close (Task 4) takes the earliest block with serials left; the integration test shows 1506..1509 of the older block then 3500 of the new one.

## Concerns

1. The overlap guard and the changed host answer in brief test 2 are my additions on the plan's text (the task asked for the non-overlap invariant; the plan has no such check). If the owner prefers the plan as written, remove `sharesSerials` and the overlap tests; nothing else depends on it.
2. `floor_block_requests` has no index except its primary key, so the waiting-request read scans that table (bounded, at most one row per pairing and prefix). A later migration could add `(host_id, device_id, issuer_prefix, extension)`; I cannot (migration 0006 and the shell are outside this task). The query-plan lists pin the scan as the only allowed one.
3. A pending request of another prefix (a shift of a prefix that is no longer used) is never replayed; the host's block for it is never fetched. This follows the brief ("the request this pairing keeps for the prefix").
4. A block id that exists in another pairing's rows (a host-side UUID collision) would be silently not filed (`ON CONFLICT DO NOTHING`) and its request removed; not guarded, because UUIDs do not collide.
5. A cwd slip: I ran one `cd` in a Bash command while exploring (read-only commands, early), and one while proving the prettier gate (before switching to `pnpm --dir`); no stray `.claude/.cc-writes` check was made, `git status` shows a clean tree.
6. The full default-timeout run showed two 5 s timeouts in `template-editor.test.tsx` (untouched, passes alone, and the whole suite passes with `--testTimeout=60000`).
7. Not exercised: the real Tauri `local_transaction` through invoke, the work screen wiring (Task 8: `topUp` calls on open/after close/link return, the `onHostError` hook), Windows.

Files: `/tmp/claude/wt/2a6/apps/standalone/src/floor/work/block-supply.ts`, `/tmp/claude/wt/2a6/apps/standalone/test/floor-block-supply.test.ts`, `/tmp/claude/wt/2a6/apps/standalone/test/floor-schema.test.ts`, `/tmp/claude/wt/2a6/apps/standalone/src-tauri/tests/local_db.rs`. Evidence directory: `/tmp/claude/impl-2a6-t5/`.
