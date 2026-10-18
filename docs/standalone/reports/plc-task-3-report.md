# plc Task 3 report — the pallet model (box on a pallet, close when full and early, label, shift-close check, pallet SSCC blocks)

Status: DONE_WITH_CONCERNS (concerns below). Commit: `de255baa2` feat(standalone): a box joins the open pallet as it closes; a full pallet closes with it, early on demand, with pallet serials of its own (worktree /tmp/claude/wt/flr, BASE 426787f6c). Tree clean after the commit.

## What was done

- `src/floor/pallets/pallets.ts` (new): `PALLET_EXTENSION`, `shiftPallets`, `readOpenPallet`, `palletStep` (join/open in the box's transaction, `palletId` into `box_closed`, closes the pallet in the same transaction when `boxCount + 1 >= capacity`), `closeOpenPallet` (early close; empty refused before a serial), `closePalletIfFull`, `openPalletGuard`; verbatim from the brief except the exported SQL constants (below).
- `shift-close.ts`: `CloseBlocker` += `open_pallet`; summary `pallet_boxes`; `label-render.ts`: `palletLabelData`; `print-jobs.ts`: `readOpenJob` orders `created_at, purpose, id`; `block-supply.ts`: `BlockContext.extension` through `extensionOf` (half rule, waiting request, request, newest block).
- Tests: brief's `floor-block-supply.test.ts` edit, new `floor-pallets.test.ts`, `test/support/pallets.ts`; plus beyond the brief (below). Query-plan pins in BOTH `test/floor-schema.test.ts` (Node 3.53) and `src-tauri/tests/local_db.rs` (shell 3.46).

## Deviations from the brief (all semantic-neutral, listed for the reviewer)

1. **Summary `pallet_boxes` subquery rewritten (plan-driven).** The brief's `count(*) FROM floor_pallets p JOIN floor_boxes b …` plans as `SEARCH b USING INDEX floor_boxes_shift (host_id=? AND device_id=?)` — i.e. it walks every box of the pairing for each open pallet (partial index `floor_boxes_pallet` is not chosen for a join). Proven on both engines (the Rust mutant below failed on 3.46 with «should search floor_boxes_pallet»). Now: `(SELECT coalesce(sum((SELECT count(*) ${LIVE_BOXES})), 0) FROM floor_pallets p WHERE … p.closed_at IS NULL) AS pallet_boxes` — same value, plans `floor_pallets_open` + `floor_boxes_pallet`. `LIVE_BOXES` is exported from pallets.ts and imported by shift-close.ts.
2. **SQL texts exported as constants** (identical text): `OPEN_PALLET_SQL`, `CLOSE_PALLET_SQL`, `JOIN_PALLET_SQL`, `BOX_ONTO_PALLET_SQL`, `OPEN_PALLET_GUARD_SQL` (pallets.ts), `CLOSE_SUMMARY_SQL` (shift-close.ts), `OPEN_JOB_READ_SQL` (print-jobs.ts) so the plan pins use the real text.
3. **Old test adapted:** `test/floor-work-close.test.tsx` matched `readOpenJob`'s SQL by the substring `ORDER BY created_at, id LIMIT 1`, which the brief's required ORDER BY change breaks (deterministic failure, also alone with 60 s timeout). Now matches `sql === OPEN_JOB_READ_SQL`.
4. Plan pins added to `floor-schema.test.ts` (imports; new block before «The scan pipeline's own reads»; shell-text-agreement list 13 → 20) and `local_db.rs` (7 SQL constants; `reads` 51 → 64).

## Anchor adaptations

None needed: every fragment of the brief matched exactly once (block-supply, print-jobs, label-render, shift-close). `CloseBlocker` doc/union reformatted exactly as the brief shows.

## RED / GREEN

- RED (`/tmp/claude/impl-plc-t3/red.txt`): `floor-pallets.test.ts` — «Failed to resolve import … pallets.js»; `floor-block-supply.test.ts` — the new test «expected { kind: 'enough' } to deeply equal { kind: 'stored' … }», as the brief predicts.
- GREEN: brief's two files 69 passed (the real block-supply file has more tests than the scratch copy); final: `floor-pallets` 28, `floor-block-supply` 59, `floor-schema` 28.
- Full package: `Test Files 118 passed (118)`, `Tests 3597 passed (3597)` (Task 2 left 117 / 3567; this task +1 file, +30 tests; the plan's scratch numbers 114/2685 are a different tree). Verbose run of the three changed/new files: stderr count 0; full run stderr count 0. First full run had 2 failures: `floor-setup` 5 s timeout under load (passes alone) and the deterministic `floor-work-close` regression (deviation 3), fixed; the final full run is clean.
- Delayed-`setImmediate` stand on `floor-work-close.test.tsx` (the only React file touched): 57 passed; stand files deleted. The pallet tests are node-only (no React).
- typecheck, lint: clean. Prettier gate live-proven (mis-formatted scratch file failed, then deleted; the gate then ran from the worktree root with repo-relative paths and printed «Checking formatting…»; changed files clean — it reformatted my added test code). `cargo fmt --check`, `git diff --check`: clean. `grep '\u04'`: only `pairing-code.ts:66`.
- Cargo: `--test local_db the_floors_repeating_reads_search_an_index` ok on 3.46 (after adding the pins); ONE final unsandboxed `cargo test --offline --locked --workspace`: 54 binaries ok, 816 passed, 0 failed, 0 warnings (`/tmp/claude/impl-plc-t3/workspace.txt`). Only a test file of the shell crate changed (the pins); no Rust source.
- Not exercised: Windows, hardware printers, the work screen UI (tasks 5–7), the cloud/host.

## Query-plan pins (reviewer carry 4 of Task 2)

`readOpenPallet` (`floor_pallets_open` + `floor_boxes_pallet`), pallet close UPDATE (pallet key + `floor_boxes_pallet`), join UPDATE (pallet key), box-onto-pallet UPDATE (box key), `openPalletGuard` (shift key, `floor_pallets_open`, `floor_boxes_pallet`), close summary (shift key, `floor_pallets_open`, `floor_boxes_pallet`), `readOpenJob` (`floor_print_jobs_shift`; the only temp structure is `ORDER BY`). Node: no `SCAN`, and no `floor_boxes_shift (host_id=? AND device_id=?)` prefix walk for the pallet statements. The pallet-serial pick is the box close's statement with `extension` bound (already pinned). Plan mutants: P1 (the brief's JOIN form back) fails 2 Node tests; the same JOIN text in the Rust constant fails `the_floors_repeating_reads_search_an_index` on SQLite 3.46 (restore: cmp + sha256 `bbae3d2f…` before = after); P2 (changed `readOpenJob` text) fails the text-agreement test.

## Tests beyond the brief (what each pins)

a pallet of one box (opens and closes with its box; record order; `operatorId`, `closed_by`, job `created_at`/`operator_id`); units/boxes counted live (disassembled box leaves count and label); full label-field equality against an independent `palletLabelFields` call; early close at its own moment (`closed_at`, record, label); no printer for pallets or a failing render → job `failed` but the pallet closes; a box already on a pallet is never moved and an open box never joins (statement-level, `changes_mismatch`); join to a pallet closed meanwhile → `stale`; a rival open pallet → the box's close fails whole (unique index, nothing written); serial pick = earliest live pallet block of the prefix+pairing+extension (decoys: other prefix, other device, other host, exhausted, later block with smaller id); a close finding its serial gone → `stale`; a pallet finished by another path meanwhile → `stale`, one label; lone invalid-serial spend → `stale` not lost; out-of-range serial in `palletStep` leaves a full pallet open, serial unspent; exactly full pallet closes when serials come; `readOpenPallet` per shift/pairing (foreign rows sorted first), `shiftPallets` three half-configured cases; summary blocker order (open box > label > open pallet), other shift's pallet, closed pallet; guard vs other shift/closed pallet/all-disassembled/unknown shift; block-supply: a pallet supply leaves a box request waiting and vice versa.

## Mutants (restore: backup in /tmp/claude/impl-plc-t3/orig, `cmp` silent, sha256 before = after, `touch`; script `/tmp/claude/impl-plc-t3/mut.py`, log `mut-all.txt`; every mutant row restored=True)

| Mutant                                                                                                   | Killed by (first/key test)                                                        |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| M1 `>=`→`>` capacity (brief M1)                                                                          | fill test, «never closes a box without its pallet», one-box pallet, no-printer    |
| M1b drop `+ 1` in boxCount                                                                               | same four                                                                         |
| M1c drop `+ box.itemCount`                                                                               | fill test (qty 6)                                                                 |
| M1d openedAt always box's close                                                                          | fill test                                                                         |
| M2 close not comparing box count (brief M2)                                                              | «writes nothing when a box joins…» (+ text-agreement pin)                         |
| M2b drop `closed_at IS NULL` in pallet close                                                             | «not spent on a pallet that another close finished meanwhile» (new)               |
| M3 empty pallet closable (brief M3)                                                                      | «refuses an empty pallet…»                                                        |
| M4 guard no-op (brief M4)                                                                                | «checks in its own transaction…», guard test, plan pins                           |
| M4b / M4c guard drops `closed_at IS NULL` / `shift_id`                                                   | guard test, plan pins                                                             |
| M4d / M4e `LIVE_BOXES` drops `disassembled_at IS NULL` / uses `pallet_id IS NOT NULL`                    | 6 / 5 tests (empty pallet, units, scoping, plans)                                 |
| M5 readOpenJob order without `purpose` (brief M5)                                                        | fill test (+ text pin)                                                            |
| M6 no `open_pallet` blocker (brief M6)                                                                   | «is kept open by a pallet with boxes»                                             |
| M6b blocker order pallet before label                                                                    | «names an open box before a waiting label before an open pallet»                  |
| M6c / M6d summary drops `shift_id` / `closed_at IS NULL`                                                 | «kept by the shift's own pallet alone», plan pins                                 |
| M6e blocker `boxes` constant                                                                             | blocker tests                                                                     |
| M7 request extension box (brief M7)                                                                      | block-supply pallet half-rule test                                                |
| M7b / M7c / M7d newest-block / waiting-request / default extension                                       | pallet half-rule test / new «repeats its own waiting request alone» / both        |
| M8 join drops `closed_at IS NULL`                                                                        | «leaves the box and the pallet as they were when the pallet closes between…»      |
| M9 / M9b box-onto-pallet drops `pallet_id IS NULL` / `closed_at IS NOT NULL`                             | «refuses to move a box that is already on a pallet, or to put an open box on one» |
| M10a–e pallet-serial pick: extension 0, no prefix, no device, no host, no `next_serial<=to`, order by id | M10a: 12 tests; M10b–e: «is the earliest live pallet block…»                      |
| M11 serial spent without cursor compare                                                                  | «never closes a box without its pallet», «is lost…», «spent alone…»               |
| M12 invalid-serial spend never `stale`                                                                   | «spent alone, … stale»                                                            |
| M13 `closePalletIfFull` `<`→`<=`                                                                         | «closes a pallet that is exactly full once serials come»                          |
| M14a–e readOpenPallet drops shift / device / host / `closed_at`, items as count                          | per-shift/pairing test, units tests, plan pins                                    |
| M15a–c `shiftPallets` drops each of the three conditions                                                 | «worked by a shift with pallets alone…»                                           |
| M16 `palletId` not in `box_closed`                                                                       | «opens a pallet with the first box…»                                              |
| M17 range error not caught                                                                               | out-of-range tests                                                                |
| M18 / M18b record operator null / `closed_by` null                                                       | one-box pallet test                                                               |
| M19a–e job purpose, subject, template, created_at, operator                                              | fill test / one-box / units tests                                                 |
| M20a/c/d label fields swap counts, operator null, SSCC changed                                           | fill / units tests                                                                |
| M23 pallet `opened_at` wrong                                                                             | fill / first-box tests                                                            |
| M24 render not passed                                                                                    | fill test                                                                         |
| M25–M28 early close: `closedAt`=openedAt, itemCount=boxCount, boxCount=itemCount, operator               | units / scoping tests                                                             |
| P1, P2 plan-pin mutants                                                                                  | see above                                                                         |

**Survivor, equivalent:** M20b (`palletLabelData` passes a wrong `closedAt` to `palletLabelFields`): the station copy's `productionDate` is a non-null civil date (`ShiftCopy.productionDate: string`), so the domain never reads `closedAt` for the date fields; not reachable for station copies. Also equivalent (not mutated): the `b.host_id/b.device_id` conjuncts of `LIVE_BOXES` (a pallet id is a global primary key).

## Files

Created: `apps/standalone/src/floor/pallets/pallets.ts`, `apps/standalone/test/floor-pallets.test.ts`, `apps/standalone/test/support/pallets.ts`. Modified: `src/floor/close/shift-close.ts`, `src/floor/print/label-render.ts`, `src/floor/print/print-jobs.ts`, `src/floor/work/block-supply.ts`, `test/floor-block-supply.test.ts`, `test/floor-schema.test.ts`, `test/floor-work-close.test.tsx`, `src-tauri/tests/local_db.rs` (test lines only).

## Self-review / concerns

1. **Carry from Task 2 review item 5:** a copy with `palletsEnabled = true` but no capacity (or a snapshot without pallet layout) makes `shiftPallets` return `null`, so the work screen (tasks 5–7) would silently work boxes only. The brief fixes the signature; I pinned the behaviour (three cases) in a test. The caller in task 5 must treat `palletsEnabled && shiftPallets === null` as a stop, not as «no pallets»; today it is unreachable (host always sends both; old snapshots are refused by `layout`).
2. **A rival open pallet during a box close** fails the whole close as a raw `statement_failed` (unique index `floor_pallets_open`), not `stale`, because the brief's open-pallet INSERT is unconditional. Nothing is written and a retry succeeds, and the work queue serialises closes, so it is not reachable from the screen; pinned by test. Converting it to `stale` would need `INSERT … SELECT … WHERE NOT EXISTS` (not done: brief text kept).
3. `palletStep` with an out-of-range pallet serial leaves a full pallet open and does NOT spend the serial (every following box retries it); only the early close spends it as `invalid_serial` (the brief's behaviour; pinned by test). A prefix whose pallet block runs past its range needs an early close to move on.
4. `readOpenJob` sorts the shift's whole job history through `floor_print_jobs_shift` (`USE TEMP B-TREE FOR ORDER BY`) — pre-existing shape, now pinned as the only allowed temp structure.
5. Task 10 (AGENTS.md) must mention the new pins/constants; the dispatch asked nothing of docs here.

---

# Fix report — review Important 1 (a held pallet SSCC stopped every box close)

Status: DONE. Commit `d7a91fb56` fix(standalone): a pallet serial whose SSCC another pallet holds is lost, not retried for good (worktree /tmp/claude/wt/flr, BASE de255baa2). Minors untouched. Evidence in `/tmp/claude/impl-plc-fix/`.

## What changed

- `pallets.ts`: `PALLET_SSCC_HELD_SQL` (`SELECT 1 AS n FROM floor_pallets WHERE sscc = ? LIMIT 1`) and `freePalletSscc(local, prefix, serial)`, which replaces `palletSscc` and returns `null` for a serial past the range OR whose SSCC is held. Same rule as `box-close.ts` (`held` -> `loseSerial`).
  - `closeOpenPallet`: a `null` SSCC spends that serial alone (the same compare-and-set) and answers `invalid_serial` (or `stale`); the next close takes the next serial.
  - `palletStep`: a `null` SSCC leaves the full pallet open; the box is still closed and joined, the serial stays unspent. The pallet then closes through `closePalletIfFull` / the early close, which loses the bad serial (so it is always recorded by a spend, never skipped silently).
- Docs: `PalletCloseResult`, `palletStep`, and the `remainingSerials` sentence in `block-supply.ts` now name the pallet case.
- Plan pins in BOTH engines: `test/floor-schema.test.ts` (Node 3.53: `floor_pallets_sscc (sscc=?)`, no SCAN, text-agreement list 20 -> 21) and `src-tauri/tests/local_db.rs` (shell 3.46: constant + read, `reads` 64 -> 65).

## RED / GREEN

- RED (`red.txt`, `red.err`): 3 new tests in `floor-pallets.test.ts`; 2 fail with `UNIQUE constraint failed: floor_pallets.sscc` (`statement_failed`) from `closeOpenPallet` and from the box close; the decoy test passes.
- GREEN: focused three files (`floor-pallets`, `floor-schema`, `floor-block-supply`) 118 passed, stderr 0 bytes; full Vitest 118 files / 3600 passed (3597 + 3), stderr 0 bytes.
- New tests: (1) early close loses the held serial 0 (cursor 1, pallet open, no `pallet_closed`), the next close takes serial 1 (held serial 5 is a decoy); (2) box close with the full pallet's serial held: box closes and joins, cursor unspent, no pallet job, further box joins, `closePalletIfFull` loses serial 0 then closes on 1; (3) a held SSCC of another serial changes nothing (serial 0 used).

## Mutants (restore: backup in `orig/`, `cmp`/sha256 before = after, `touch`; `mut.py`, `mut1.txt`; all restored=True)

| Mutant                                                   | Killed by                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| F1 helper never reports held                             | tests 1 and 2                                                           |
| F2 held query bound to the prefix instead of the SSCC    | tests 1 and 2                                                           |
| F3 helper always reports held                            | fill, never-without-pallet, full-pallet-without-serials tests (+ decoy) |
| F4 early close answers `invalid_serial` without spending | test 1 (cursor) and 2 older invalid-serial tests                        |
| F5 `palletStep` bypasses the check                       | test 2 (+ out-of-range test)                                            |
| F6 `closeOpenPallet` bypasses the check                  | test 1 (+ 2 older tests)                                                |
| F7 held SQL unindexed (`sscc                             |                                                                         | ''`) | 2 floor-schema tests (plan pin, text agreement)                                                                                                                                                            |
| F8 Rust constant text drifts from the TS text            | text-agreement test                                                     |
| F9 Rust constant AND plan unindexed (`sscc               |                                                                         | ''`) | `cargo test --test local_db the_floors_repeating_reads_search_an_index` on 3.46: «should search floor_pallets_sscc», plan `SCAN … COVERING INDEX`; restored: sha256 `44970d68…` before = after, cmp silent |

## Gates

typecheck, lint, `cargo fmt --check`, `git diff --check`: clean. Prettier gate proven live (mis-formatted scratch failed, deleted), changed files clean. `grep '\u04'`: only `pairing-code.ts:66`. `cargo test --test local_db`: 28 passed (3.46). ONE final unsandboxed `cargo test --offline --locked --workspace` after the commit: 54 binaries ok, 816 passed, 0 failed, 0 warnings. Tree clean. Not exercised: Windows, hardware, UI (tasks 5-7).

## Notes for Task 5

`palletStep` leaves a full pallet open on a held SSCC (like the out-of-range case): `settlePallet` must run `closePalletIfFull` and treat `invalid_serial` as «try again», not as a stop (each call loses one bad serial).
