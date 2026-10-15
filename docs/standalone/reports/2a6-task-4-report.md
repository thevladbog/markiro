# plan 2a6 Task 4 report: closing a box (commit aa2481c27 on 29208c111, branch claude/2a6-scanning)

Status: DONE_WITH_CONCERNS (concerns at the end; none blocks the commit).

## What was done

- `apps/standalone/src/floor/work/box-close.ts` (new): the brief's code as written, plus the addendum-3 SSCC collision pre-check and a shared `loseSerial` helper.
  - `closeOpenBox(context, steps = [])`:
    1. Reads the open box; an empty box or none gives `empty`, and no serial is spent.
    2. Reads the codes of the box.
    3. Reads the cursor of the earliest block of the snapshot's prefix, extension `BOX_EXTENSION = 0`, with room.
    4. Builds the SSCC with `buildSscc` (never re-implemented).
    5. If `buildSscc` throws `SSCC_RANGE`, or a box already holds the SSCC (`SELECT 1 AS n FROM floor_boxes WHERE sscc = ? LIMIT 1`, the global unique key), the serial is spent alone by the same cursor comparison. The result is `invalid_serial` and the box stays open.
    6. Otherwise one transaction: spend (`WHERE block_id = ? AND next_serial = ?`, `expectedChanges: 1`), box close (`closed_at IS NULL AND item_count = ?`, `expectedChanges: 1`), the `box_closed` outbox record, then the steps' statements.
    - `changes_mismatch` becomes `stale`; any other error rejects.
  - `closeIfFull`: closes a box with `itemCount >= boxCapacity`, else `null`.
  - Pallet and print extension point: `CloseStep` / `CloseAddition`. With `steps = []` (the default, and everything until plans 2a7 and ПЛ-Ц pass theirs) it adds nothing to the write. The JSDoc on `CloseStep` says so, and a test pins that the close writes only the box, the cursor and the record.
- `test/support/floor-work.ts`: `rows(db, sql, ...params)`, `SECOND`, `SeededBlock`, `seedBlock`.
- `test/floor-box-close.test.ts` (new): 28 tests (the brief's 10 plus 18 of mine).
- Query plans (addendum item 5), in BOTH lists:
  - `test/floor-schema.test.ts`: 4 lines.
  - `src-tauri/tests/local_db.rs::the_floors_repeating_reads_search_an_index`: 15 → 19 entries.
  - The 4 new statements: the block read, the SSCC check, the spend `UPDATE`, the close `UPDATE`.
  - A recording test in `floor-box-close.test.ts` EXPLAINs the SQL the code actually sends and requires an index and no `SCAN`.
  - The codes read and the open-box read were already in both lists.

### Anchor adaptations

- `floor-work.ts` fragment 3 (`    },\n  };\n}`) is not unique: it occurs at the end of `holdingWrites`, `failingWrites` and others. I appended `SECOND`, `SeededBlock` and `seedBlock` at the end of the file, which is the only place the plan can mean. Fragments 1 and 2 matched once.
- The brief's `box-close.ts` and its first 10 tests were applied verbatim and passed (10/10) before I added anything. The copies are in `/tmp/claude/impl-2a6-t4/box-close.brief.ts` and `floor-box-close.brief.test.ts`.

### Additions beyond the brief

1. Addendum 3: the SSCC collision pre-check.
2. `loseSerial` shared by the range path and the collision path.
3. 18 extra tests (listed under "Tests").
4. The `CloseStep` documentation, and the `CloseResult` documentation extended with the collision case.
5. The four new plan lines in two lists.
6. No other change to the brief's code.

## Evidence

### RED

- Brief tests, no implementation: `/tmp/claude/impl-2a6-t4/red1-kept.out`. `Failed to resolve import "../src/floor/work/box-close.js"`, `Tests no tests`.
- All 29 tests (before I removed one redundant test) against the brief's implementation, `red2.out`: 2 failed, 27 passed.
  - The collision test: `promise rejected "LocalDbError: Error: UNIQUE constraint fa…" instead of resolving`. That is the generic `statement_failed` the addendum describes.
  - The recording plan test: `expected 5 to be 6`, because the SSCC check statement did not exist.

### GREEN

All commands were run from the root with `pnpm --dir /tmp/claude/wt/2a6 --config.verifyDepsBeforeRun=false --filter @markiro/standalone …`, `--testTimeout=60000` unless noted.

| Check                                                                                       | Result                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/floor-box-close.test.ts`                                                              | 28 passed; also with the default 5 s timeout: 28 passed                                                                                                                                                          |
| verbose run of `floor-box-close`, `floor-schema`, `floor-scan-pipeline`, `floor-work-reads` | 4 files, 114 tests passed, stderr 0 bytes                                                                                                                                                                        |
| delayed-`setImmediate` stand (3 ms) on `floor-box-close` + `floor-schema`                   | 54 passed, stderr 0 bytes; the stand's two files were removed                                                                                                                                                    |
| full Vitest                                                                                 | 94 files, 2790 tests passed, stderr 0 bytes (the plan states 91 / 2273 on its copy; on the real tree the base is 93 files / 2762, since `floor-schema` gained assertions inside an existing test, not a new one) |
| `typecheck`                                                                                 | exit 0                                                                                                                                                                                                           |
| `lint`                                                                                      | exit 0                                                                                                                                                                                                           |
| `build`                                                                                     | exit 0                                                                                                                                                                                                           |
| `cargo fmt --check`                                                                         | exit 0                                                                                                                                                                                                           |
| `cargo test --offline --locked -p markiro-standalone --test local_db` (unsandboxed)         | 27 passed                                                                                                                                                                                                        |
| `--test ipc` (unsandboxed)                                                                  | 26 passed                                                                                                                                                                                                        |
| `git diff --check` and `git diff --cached --check`                                          | clean                                                                                                                                                                                                            |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                 | only `src/host/pairing-code.ts:66`                                                                                                                                                                               |
| `\u0` in `local_db.rs`                                                                      | nothing                                                                                                                                                                                                          |

- Prettier gate: `node_modules/.bin/prettier --ignore-path /tmp/claude/wt/2a6/.prettierignore --check <repo-relative paths>` from the root printed "Checking formatting..." and "All matched files use Prettier code style!" for the 4 TS files. I proved the gate live: a scratch `zz-scratch.ts` with `const  x   =  1;` gave `[warn]` and exit 1, and was then deleted.
- `git status --short` is empty after the commit. Commit message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Tests

The brief's 10 are unchanged. My 18:

- Collision (1): another pairing's box holds the SSCC of serial 1500, and another box holds 1499's. The close gives `invalid_serial`, the cursor is at 1501, the box is open, there is no `box_closed` record, and the next close takes 1501.
- Range, race (1): the lost-serial spend is compared on the cursor. A cursor moved meanwhile gives `stale` and no double spend.
- Block boundaries (2):
  - A block 20..21 runs through its last serial; the cursor ends at 22 (to+1); then `no_serials`; then the next block is taken.
  - A block of another host is not used.
- Record (2):
  - The record is unsent, ordered after its scans, stamped `created_at` = `closedAt`, and nothing else is written with no steps.
  - The membership digest equals the digest in the host's fixture `proto/fixtures/box-digest.json` for its 3-hash case, with codes of a closed box, of another shift's box, and rows of another host and of another device that carry this box's id.
- Retry and idempotence (6):
  - A failed write leaves nothing; the retry takes the same serial 1500.
  - A committed write whose answer is lost: the retry gives `empty`, and there is one box, one record, one spent serial.
  - A second close gives `empty`.
  - A record that cannot be kept (outbox id collision) rolls back the serial too.
  - An unknown field spends no serial.
  - A box closed by another path while the close is in flight: `stale`, and the SSCC is not overwritten.
- Steps (3): the step gets the exact `ClosingBox` (including sorted `codeHashes`) before anything is written, in order. A throwing step stops the close with nothing written. Step statements commit in step order, after the close's own.
- `closeIfFull` (2): none for a shift without a box; an over-capacity box (13) closes too.
- Plans (1): the recording EXPLAIN test over the 6 repeated statements.

## Mutant table

All mutants were scratch, one-line (a few two-line), run with `/tmp/claude/impl-2a6-t4/mut.py` and `mut2.py`. Each was anchor-checked, restored from the in-memory original, and `sha256` and `cmp` against `/tmp/claude/impl-2a6-t4/box-close.before` are identical after every run. Full output is in `mut-all.out`. The Rust source was not mutated; the one migration mutant was restored (`cmp` ok, sha `4c957d70…`) and touched.

Test names are shortened (T = `test/floor-box-close.test.ts`).

| id  | mutant                                                 | first killer (T unless noted)                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | spend without cursor comparison (`AND ? IS NOT NULL`)  | "never gives one SSCC to two boxes…", "a serial past the range > is spent by the same comparison"                                                                                                                                                                     |
| M2  | spend without `expectedChanges`                        | same two                                                                                                                                                                                                                                                              |
| M3  | close without `item_count = ?`                         | "does not close a box that took another code…"                                                                                                                                                                                                                        |
| M4  | empty box closes                                       | "spends no serial on a shift without an open box or with an empty one"                                                                                                                                                                                                |
| M5  | `next_serial < to_serial`                              | "has no serials without a block…", "runs a block through its last serial…"                                                                                                                                                                                            |
| M6  | `ORDER BY from_serial DESC`                            | "takes the next serial of the earliest block…"                                                                                                                                                                                                                        |
| M7  | any prefix                                             | "has no serials without a block…", plan test                                                                                                                                                                                                                          |
| M8  | steps' statements in a second transaction              | "commits what a later plan adds…"                                                                                                                                                                                                                                     |
| M9  | added data not in the record                           | "refuses a field the record does not know…" (2 tests)                                                                                                                                                                                                                 |
| M10 | closeIfFull `<=`                                       | "closes once it holds the capacity…", "found full when the work screen opens…"                                                                                                                                                                                        |
| M11 | closeIfFull capacity - 1                               | "closes once it holds the capacity, and not one code before"                                                                                                                                                                                                          |
| M12 | lost serial not spent                                  | range test, collision test, "loses a serial past the prefix's range…"                                                                                                                                                                                                 |
| M13 | added data overrides record fields                     | "commits what a later plan adds…"                                                                                                                                                                                                                                     |
| M14 | **no SSCC collision pre-check**                        | collision test (generic `statement_failed`)                                                                                                                                                                                                                           |
| M15 | collision: serial not spent, `invalid_serial` returned | collision test (next close hits the same SSCC)                                                                                                                                                                                                                        |
| M16 | collision query binds the serial, not the SSCC         | collision test                                                                                                                                                                                                                                                        |
| M17 | lost serial ignores `stale`                            | "a serial past the range > is spent by the same comparison"                                                                                                                                                                                                           |
| M18 | close UPDATE without `closed_at IS NULL`               | "does not close a box that was closed while the close was on its way"                                                                                                                                                                                                 |
| M19 | close UPDATE without `id = ?`                          | "never gives one SSCC to two boxes…", plan test                                                                                                                                                                                                                       |
| M20 | `BOX_EXTENSION = 1`                                    | 20 tests                                                                                                                                                                                                                                                              |
| M21 | digest drops one code                                  | "takes the next serial…", "digests the codes of this box as the host does"                                                                                                                                                                                            |
| M22 | codes of any box                                       | digest test, plan test                                                                                                                                                                                                                                                |
| M23 | codes of any device                                    | digest test (row of another device), plan test                                                                                                                                                                                                                        |
| M24 | codes of any host                                      | digest test (row of another host), plan test                                                                                                                                                                                                                          |
| M25 | blocks of any device                                   | "has no serials without a block…", plan test                                                                                                                                                                                                                          |
| M26 | blocks of any host                                     | "takes none from a block of another host", plan test                                                                                                                                                                                                                  |
| M27 | outbox `created_at` from a second clock reading        | "is kept unsent after the scans it closes, stamped with the closing time"                                                                                                                                                                                             |
| M28 | outbox record in its own transaction after the close   | 12 tests, e.g. "writes nothing when its record cannot be kept"                                                                                                                                                                                                        |
| M29 | serial spent in its own transaction before             | 7 tests, e.g. "refuses a field the record does not know without spending the serial"                                                                                                                                                                                  |
| M30 | stored serial off by one                               | 19 tests                                                                                                                                                                                                                                                              |
| M31 | SSCC built with extension 1                            | 6 tests, e.g. "takes the next serial…"                                                                                                                                                                                                                                |
| M33 | every write failure is `stale`                         | "wrote nothing when its write failed…", "commits what a later plan adds…"                                                                                                                                                                                             |
| M34 | no failure is `stale`                                  | race tests (4)                                                                                                                                                                                                                                                        |
| M35 | closeIfFull without the `box === null` guard           | "is none to close when the shift has no open box"                                                                                                                                                                                                                     |
| M36 | closeIfFull only at exact capacity (`!==`)             | "closes a box that holds more than the capacity as well"                                                                                                                                                                                                              |
| M38 | steps' statements in reverse order                     | "commit their statements in the order of the steps"                                                                                                                                                                                                                   |
| M39 | steps get no code hashes                               | "get the box as it will be written…", digest test                                                                                                                                                                                                                     |
| M41 | wrong operator on the box and record                   | 20 tests                                                                                                                                                                                                                                                              |
| M42 | `closedAt` = opening time                              | "takes the next serial…", "is kept unsent… stamped with the closing time"                                                                                                                                                                                             |
| M43 | first step skipped                                     | 6 tests                                                                                                                                                                                                                                                               |
| Q1  | SSCC check `sscc \|\| '' = ?` (defeats the index)      | "the statements a close repeats > search an index…"                                                                                                                                                                                                                   |
| Q2  | spend `block_id \|\| '' = ?`                           | same plan test                                                                                                                                                                                                                                                        |
| S1  | migration without `floor_boxes_sscc`                   | `floor-schema.test.ts` ("fixes the indexes", "serve the reads the floor makes from an index"), `floor-box-close` plan test; Rust: `the_floors_repeating_reads_search_an_index` fails with `should search floor_boxes_sscc (sscc=?), its plan is ["SCAN floor_boxes"]` |

M23 and M24 survived the first version of the digest test: a row of another pairing with both ids different is excluded by either filter alone. I added one row of another host and one of another device, reran M22–M24, and all three are now killed by the digest test as well as by the plan test.

I deleted one test I wrote, the collision cursor race. It passed on the brief's implementation for the wrong reason (the main write was held and went `stale`), so it did not discriminate. The range race covers the shared `loseSerial`.

### Equivalent or unkillable mutants (named, not hidden)

- E1: drop `ORDER BY code_hash` from the codes read. It survives, and I ran it to confirm. `boxMembershipDigestV1` sorts its input and `floor_codes_box` delivers hashes in order. The digest order cannot be observed, so the clause only makes `ClosingBox.codeHashes` deterministic.
- Dropping `host_id` and `device_id` from the close `UPDATE`'s `WHERE`: `floor_boxes.id` is a global primary key, so the id already fixes the row. I did not mutate these.
- Dropping the `block_id` tie-break from `ORDER BY from_serial, block_id`: the host issues disjoint ranges, so two blocks with equal `from_serial` do not occur. I did not mutate it.
- Q3 (whitespace-only change in the SQL) is a control and passes, as it should.

## Data-integrity review (what I checked)

- **Serial never reused or lost silently.**
  - The cursor moves in the same transaction as the box close and the outbox record. Mutants M28 and M29 (the record or the spend written separately) are killed, and so is a record that cannot be kept.
  - A failure before the write (a step throws, the record schema refuses, the outbox id collides) leaves the cursor untouched, and the retry takes the same serial.
  - The `sscc_exhausted` path belongs to Task 5. Here an exhausted block is skipped (`next_serial <= to_serial`), and `no_serials` is returned if none has room. The box stays open and the screen must say why (Task 8).
- **SSCC.** Built only by `buildSscc(0, issuerPrefix, serial)`. The 18-digit result matches the host's `names_serial` and `sscc.len() == 18` checks.
- **Digest.** `boxMembershipDigestV1` over the box's `floor_codes` rows. A test with the host's own fixture hashes asserts the digest the host fixture expects for them, plus non-members under another box, shift, host and device.
- **Retry ("Повторить").** A failed close writes nothing, so a retry cannot double-close or double-spend. If a write commits but its answer is lost, the retry sees a closed box and returns `empty` (tested: one box, one record, one serial spent).
- **Pallet hook.** `steps = []` is a no-op, documented, and tested.

## Files changed

- `apps/standalone/src/floor/work/box-close.ts` (new)
- `apps/standalone/test/floor-box-close.test.ts` (new)
- `apps/standalone/test/support/floor-work.ts`
- `apps/standalone/test/floor-schema.test.ts` (plan lines)
- `apps/standalone/src-tauri/tests/local_db.rs` (plan entries, 15 → 19; test lines only)

## Concerns

1. **Task 8 must handle `empty` after a failed close attempt.** If the transaction committed but its answer was lost, the retry returns `{ kind: "empty" }` for a box that is in fact closed. Task 8 should re-read the shift's last closed box instead of treating `empty` as "nothing happened", so that 2a7's label and print job are not skipped. The answer should be re-read from `floor_boxes`, not from this result.
2. **A step's statement with a failing `expectedChanges` is reported as `stale`** (`commit` maps every `changes_mismatch`), so a later plan's step with a persistent mismatch would look like a transient conflict and be retried up to the 3 times Task 8 allows. This is documented on `CloseStep`. Plans 2a7 and ПЛ-Ц should give their statements no `expectedChanges`, or check their own preconditions in the step.
3. **Digest consistency under non-queued writers.** The close reads the box, then the codes, and the `item_count = ?` guard catches any change that alters the count. A net-zero change between the two reads (undo plus a new scan) could be digested from different codes than the count implies. All box writers go through the Task 3 queue, which prevents this, so I did not add a codes-set guard. Plan 2a8's exceptions must stay inside the queue.
4. **A collided SSCC loses one serial per attempt.** That is the addendum's design, and the loss is harmless unless a whole block collides, which cannot happen in normal operation.
5. **Overfill (N11)** is Task 8's: `closeIfFull` closes an over-capacity box (tested), but nothing here prevents scans reaching `processScan` at capacity.
6. **Load.** The machine's load average was around 60 (the shell's uptime reading was 60/60/62). No test needed more than the default 5 s on its own; the full suite was run with `--testTimeout=60000`.
7. **Not exercised.** Browser, hardware, Windows, real shell invoke (`local_transaction` through the Tauri bridge). The shell's SQLite 3.46 planner was exercised through `local_db.rs`, which passed.
