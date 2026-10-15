# plc Task 2 report — migration 0008 (pallets in the station's database, pallets in shift copies, retention)

Status: DONE (with the notes under Concerns). Commit: `426787f6c` feat(standalone): the station's pallets in its database (migration 0008), its shift copies and its retention (worktree /tmp/claude/wt/flr, BASE b1b0984e7). Tree clean after the commit.

## What was done

- `src-tauri/migrations/0008_floor_pallets.sql` (new): `floor_shifts.pallet_box_capacity` (CHECK > 0) and `pallet_template_id`; `floor_boxes.pallet_id` (CHECK only a closed box) + `floor_boxes_pallet`; `floor_pallets` (+ `floor_pallets_sscc` unique, `floor_pallets_open` unique partial); `floor_pallet_exceptions`. Additive only.
- **Added beyond the brief:** `floor_pallets_shift (host_id, device_id, shift_id)`. A DELETE by shift_id on `floor_pallets` would otherwise full-scan (the only other index is partial on `closed_at IS NULL`); it also serves the later per-shift pallet reads. `floor_pallet_exceptions` has NO shift index on purpose: it is a rare table, scanned once per purged shift exactly like `floor_exceptions` (pinned in both plan tests as a scan, with the same comment).
- `src-tauri/src/local_db.rs`: two `TABLE_CLASSES` entries (DeviceData) + doc comment.
- `new-shift.ts` (`createdCopy`), `shift-copies.ts` (`ShiftCopy` + HOST_FIELDS + copyRow + COPY_COLUMNS + toCopy), `retention.ts` (`RETAINED_TABLES` += `floor_pallet_exceptions`, `floor_pallets`).
- Tests: brief's edits to `src-tauri/tests/local_db.rs`, `floor-schema.test.ts`, `local-executor.test.ts`, `retention.test.ts`, `shift-copies.test.ts`, new `floor-pallet-schema.test.ts`; plus the additions below.

## RED / GREEN

- RED (`/tmp/claude/impl-plc-t2/red.txt`): the 5 Vitest files — 32 failed | 135 passed (167). (Brief predicted fewer; the real tree has more retention tests that read every table.)
- GREEN after implementation: 3 failed left, all in `floor-schema.test.ts` (column-shape, index list, retention plans — files the brief did not list but which pin every column/index/plan); fixed there (see below). Then 5 files 167 passed.
- Final: 5 target files + my additions: all green; verbose run of `floor-new-shift`, `floor-pallet-schema`, `shift-copies`, `retention`: 4 files / 177 tests, `stderr` count 0; delayed-`setImmediate` stand on `floor-new-shift.test.tsx`: 90 passed (stand files deleted, tree clean).
- Full package: `Test Files 117 passed, Tests 3567 passed` (Task 1 left 116 / 3557; plan's scratch numbers 113/2673 are a different tree). typecheck, lint, build, `cargo fmt --check`, `git diff --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets`: 0 warnings; `grep '\u04'`: only `pairing-code.ts:66`.
- Cargo: `--test local_db` 28 passed (plan said 16; real tree has more tests, +1 mine); ONE final unsandboxed `cargo test --offline --locked --workspace`: 54 test binaries, 816 tests passed, 0 failed, 0 warnings (log: `/tmp/claude/impl-plc-t2/workspace.txt`). Not run: Windows/hardware (nothing in this task touches them).
- PRETTIER GATE: live-proven (scratch mis-formatted file failed, then deleted); changed files clean (it reformatted one of my added test lines in `floor-new-shift.test.tsx`).

## Anchor adaptations

- Rust test file: fragment 3 (`floor_exceptions`/`floor_print_jobs`) occurs three times in the real file (indent 12 twice: table list + device_data list; indent 8: "keeps its row" list) — applied to all three by meaning. Fragments 4/5 comments applied as given. The `let reads: [(&str, &str); 50]` literal became 51 with my new DELETE pin.
- `id TEXT PRIMARY KEY` in the brief's SQL → `id TEXT NOT NULL PRIMARY KEY` for both tables (every earlier migration says `NOT NULL PRIMARY KEY`; in SQLite a non-INTEGER `PRIMARY KEY` alone admits NULL). Pinned by the column-shape test.
- `floor-schema.test.ts`: besides the brief's DEVICE_TABLES edit, the column map (floor_shifts +2, floor_boxes +1, two new tables), the index list (+4 indexes), `bySearch`/the scan list (`floor_pallets_shift` searched; `floor_pallet_exceptions` scanned), the "pinned on the shell's SQLite" retention list (7 → 8 statements, literal `for table in [...]`) were updated by meaning — the brief did not list these.
- `floor-new-shift.test.tsx` (not in the brief): `createdCopy(PLANNED)` toEqual now includes `palletBoxCapacity: null`/`palletTemplateId: null`; added a pallets-shift case.
- `retention.ts` fragment: doc-comment wording as given.

## Added tests beyond the brief

- `floor-pallet-schema.test.ts`: closed pallet without `block_id` / without `serial` refused; "migration 0008 over a database of 0007" (Node SQLite: seeded 0001–0007 shift with `local_state='closing'`, closed box, outbox record → apply 0008 → all rows intact, new columns NULL, new tables empty, old box can take a `pallet_id`).
- `tests/local_db.rs`: `migration_0008_keeps_the_rows_of_a_database_of_0007` — the same on the shell's own SQLite (3.46) through a `Migrator` truncated to versions ≤ 7 and then `LocalDb::open`; plus the `DELETE FROM floor_pallets` plan pin and the scan pin for `floor_pallet_exceptions`.
- `retention.test.ts`: a purge deletes a shift's pallets and pallet exceptions and leaves the same ids of another shift and of another pairing.
- `shift-copies.test.ts`, `floor-new-shift.test.tsx`: as in the brief / createdCopy with pallets.

## Mutants (all restored: backup copy, `cmp`, sha256 equal, `touch`; script `/tmp/claude/impl-plc-t2/mut.py`)

| Mutant                                                                          | Killed by                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M1 pallet SSCC extension unchecked                                              | pallet-schema «close a pallet whole…»                                                                    |
| M2 drop `floor_pallets_open`                                                    | pallet-schema «hold one open pallet…», floor-schema «fixes the indexes»                                  |
| M3 / M3b drop `floor_pallets` / `floor_pallet_exceptions` from RETAINED_TABLES  | retention (many, incl. «names every table») and, alone, my «deletes a shift's pallets…» (M3n/M3m)        |
| M4 / M4b drop `pallet_box_capacity` / `pallet_template_id` from HOST_FIELDS     | shift-copies «keep its boxes per pallet…» (+ «work the shift…» for capacity)                             |
| M4c / M4d `toCopy` returns null for capacity / template                         | shift-copies «keep its boxes per pallet…»                                                                |
| M5 / M17 no TABLE_CLASSES entry for `floor_pallets` / `floor_pallet_exceptions` | cargo `every_table_has_a_forget_class`                                                                   |
| M6 / M6r drop `floor_pallets_shift`                                             | floor-schema «fixes the indexes», «serve the reads…»; cargo `the_floors_repeating_reads_search_an_index` |
| M7 nullable `id`                                                                | floor-schema column shape                                                                                |
| M8 open box may carry `pallet_id`                                               | pallet-schema «put only a closed box on a pallet»                                                        |
| M9 capacity `>= 0`                                                              | pallet-schema «keep a shift's boxes per pallet…»                                                         |
| M10 words with any reason                                                       | pallet-schema «take a pallet's exception…»                                                               |
| M11 / M11b closed pallet without serial / without block                         | pallet-schema «close a pallet whole…» (needed my added cases)                                            |
| M12 open pallet may be `disassembled_at`                                        | same                                                                                                     |
| M13 exception kind unchecked                                                    | pallet-schema exception test                                                                             |
| M14 `floor_pallets_sscc` not unique                                             | pallet-schema «hold one open pallet…», floor-schema indexes                                              |
| M15 drop `floor_boxes_pallet`                                                   | floor-schema «fixes the indexes»                                                                         |
| M16 / M16d `createdCopy` leaves capacity / template undefined                   | floor-new-shift (two tests)                                                                              |
| M16b / M16c `createdCopy` drops capacity / template                             | floor-new-shift «…with pallets keep its boxes per pallet…»                                               |
| M18 old boxes get `pallet_id DEFAULT ''`                                        | cargo `migration_0008_keeps_the_rows_of_a_database_of_0007`                                              |

## Files

Created: `apps/standalone/src-tauri/migrations/0008_floor_pallets.sql`, `apps/standalone/test/floor-pallet-schema.test.ts`. Modified: `src-tauri/src/local_db.rs`, `src-tauri/tests/local_db.rs`, `src/floor/shifts/new-shift.ts`, `src/floor/shifts/shift-copies.ts`, `src/local/retention.ts`, `test/floor-schema.test.ts`, `test/local-executor.test.ts`, `test/retention.test.ts`, `test/shift-copies.test.ts`, `test/floor-new-shift.test.tsx`.

## Concerns

- Extra index `floor_pallets_shift` is not in the brief's «Produces» list (decision above, for delete/read plans); later tasks' index-list pins in `floor-schema.test.ts` must include it (already do).
- Later pallet-exceptions reads by shift would scan; if Task 4's `readClosedPallets`/exception reads need an index on `floor_pallet_exceptions`, add it in a new migration (0008 is now committed) — and move it from the scan list in the two plan pins.
- `floor_pallets_open` guards one open pallet per shift only for rows with the same pairing, as the brief says.
