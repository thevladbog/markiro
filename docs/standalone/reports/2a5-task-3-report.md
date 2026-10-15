# Plan 2a5, Task 3 report: shift copies and the snapshot check on the station

Status: DONE_WITH_CONCERNS (concerns are design notes for later tasks, none blocking)
BASE: 018fc54c5ff47ee5a0deb644b6b22fca830a6f73 (branch claude/2a5-floor, worktree /tmp/claude/wt/2a5-floor)
Commit: 904f15276 `feat(standalone): the station keeps its line's shifts and the snapshot of each it entered` (one trailer line, Claude Opus 5.5; `git status --short` empty after)

## What was done

Created `src/floor/shifts/shift-snapshot.ts` (exactly the plan's), `src/floor/shifts/shift-copies.ts` (the plan's, hardened, see below) and `test/shift-copies.test.ts` (the plan's 12 tests plus 24 mine = 36). The plan's code was first applied verbatim: 12/12 GREEN. I then probed it with adversarial tests: 8 failed against the plan's SQL (status going backwards after a host close, a late entry answer over a close, snapshot replaced by a later entry, an unchecked snapshot stored, and four test mistakes of mine fixed afterwards). The hardening below made them pass.

### Deviations from the plan's code (intent kept; each has a mutant and a test)

1. Status monotonicity replaces the plan's "entered AND excluded planned" clause. Host verified: `enter_shift` refuses a closed shift, the host moves a shift planned -> active -> closed only, so `rank(excluded.status) < rank(stored)` can only be a list or answer read earlier and applied later (two overlapping refreshes, a list read before the entry). The list upsert `WHERE NOT (BEHIND)` skips such a row whole (status, owner, times, seen_at). This subsumes the plan's rule and also stops a host-closed shift (entered or not) from being reopened by a stale `active`, and `[A active, A planned]` in one list from ending planned. Plan mutant 1 adapted to the new clause.
2. `KEEP_ENTERED` (entry answer): the host's fields are kept as stored when the answer is behind the stored status (late answer of an entry the office closed meanwhile), through a per-column `CASE WHEN BEHIND`; the snapshot and entry time are always written.
3. Snapshot immutability: `snapshot = coalesce(floor_shifts.snapshot, excluded.snapshot)` (plan: `excluded.snapshot`). The host freezes the snapshot at open and returns the same one on every re-entry; a shift whose boxes were already printed must not be worked from another one, and re-entry cannot repair an unreadable one anyway (same bytes). The plan's docstring promise "the next entry brings a dropped field again" is gone: a snapshot stored by an older build stays as it was parsed (newer fields are optional/defaulted by the host's own rule).
4. `keepEnteredShift` runs `checkShiftSnapshot` itself and throws (`Error`, "a snapshot to work from is required (reason)") before touching the database, so no path stores a snapshot this build cannot work from. The entry screen (Task 5) must still check first to show the reason.
5. `readStoredWork` is one SELECT (copy columns + snapshot) so the copy and the snapshot are of the same moment (plan: two reads).
6. The plan test "take a shift the station created ... and keep it through a stale list" claimed more than it checked (no stale list in its body); I renamed it to what it checks. See concern 2.

### Anchor adaptations

None: nothing in the plan's text for this task is an anchored edit (all files are new). `@markiro/domain` was already built (dist present).

## RED / GREEN

- RED (plan's test file only): `Failed to resolve import "../src/floor/shifts/shift-copies.js"`, 1 suite failed (`/tmp/claude/t3/red.txt`).
- GREEN, plan's code verbatim: `Test Files 1 passed`, `Tests 12 passed (12)` (the plan's number).
- Probe of the plan's code with my added tests: 8 failed | 24 passed (32); after the hardening and 4 test-expectation fixes of mine: 32 passed; then +4 tests: 36 passed.
- Final: `Tests 36 passed (36)` for `test/shift-copies.test.ts`; `--reporter=verbose`: stderr 0 bytes, no `act(`/unhandled; delayed-`setImmediate` stand: 36 passed (the file renders no component, so it is a formality; the two stand files were deleted, `git status` clean).
- `typecheck` clean, `lint` clean, `prettier --check` clean on the 3 files, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.
- Whole package `test`: `Test Files 1 failed | 80 passed (81)`, `Tests 2 failed | 2254 passed (2256)`. The 2 failures are 5 s timeouts in `test/template-editor.test.tsx` (a different test each run: 5047 ms / 6649 ms, then 1 failure of 5735 ms alone) at load average 90-107; with `--testTimeout=90000` the file passes 97/97. Nothing in it touches this task. Not re-verified on an idle machine; no timeout was changed in the tree. The plan's count for task 3 was 76 files / 1960 tests on the scratch copy; the real tree has more files (tasks 2a2-2a4 extras), mine adds 1 file / 36 tests.

## Mutants (script `/tmp/claude/t3/mutant.py`; every restore checked by sha256 before/after and `cmp` against a copy: all `restore True`)

Plan's five (P1 adapted to deviation 1) and mine. "Key test" = first failing test.

| Mutant                                                        | Key test(s) that fail                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 list upsert `WHERE NOT (BEHIND)` -> `WHERE true`           | keep the first entry's time and never take an entered shift back to planned; status goes forward (stale list, host close) (5 fail)         |
| P2 drop `entered_at IS NULL` in DROP_UNLISTED                 | keep a shift this station entered ...; leave another pairing's rows alone ... (4)                                                          |
| P3 DROP_UNLISTED pairing -> `? IS NOT NULL AND ? IS NOT NULL` | leave another pairing's rows alone; another host with the same device id (2)                                                               |
| P4 `entered_at = excluded.entered_at`                         | keep the first entry's time ...; a snapshot, once taken (2)                                                                                |
| P5 readShiftCopies shows `closed`                             | keep a shift this station entered ...; floor's list (3)                                                                                    |
| M6 snapshot = excluded.snapshot                               | a snapshot, once taken: is the first one (ONLY this test; the plan's tests pass it)                                                        |
| M7 `closed` ranks as `active`                                 | status goes forward (3)                                                                                                                    |
| M8 `planned` ranks as `active`                                | keep the first entry's time ...; status forward; replayed create (4)                                                                       |
| M9 entry takes a late answer whole (no CASE)                  | late answer of an entry: the shift stays closed (ONLY this test)                                                                           |
| M10 keepEnteredShift skips the snapshot check                 | is refused before it is stored (only)                                                                                                      |
| M11 two transactions in replaceShiftCopies                    | is one transaction: a list the table refuses takes nothing (only)                                                                          |
| M12 list shows a locally closed shift                         | show a shift this station is closing ... (only)                                                                                            |
| M13 readShiftCopy ignores the device                          | **survived the first suite**; strengthened (pairing `it.each` device/host); now fails: are not this pairing's when only the device differs |
| M14 readStoredWork ignores the host                           | pairing tests (2)                                                                                                                          |
| M15 list clears `local_state`                                 | show a shift this station is closing; never touches the snapshot, the entry time or the local close (2)                                    |
| M16 list clears snapshot and entry                            | 5 tests incl. the same two                                                                                                                 |
| M17 `palletsEnabled` never true                               | round-trips the mode, the pallet flag ... (only; the plan's tests never had a pallets shift)                                               |
| M18 `ORDER BY number, id`                                     | the floor's list: by production date, then number (only)                                                                                   |
| M19 DROP_UNLISTED `NOT IN` -> `IN`                            | 6 tests                                                                                                                                    |
| M20 keepEnteredShift `expectedChanges` 2                      | 18 tests                                                                                                                                   |
| M21 keepCreatedShift does nothing                             | take a shift the station created ...                                                                                                       |
| M22 list leaves `seen_at`                                     | notes when a list last saw a shift (only)                                                                                                  |
| M23 readShiftCopies ignores the line                          | list by date; floor's list (2)                                                                                                             |
| M24 readShiftCopies ignores the pairing                       | 5 tests                                                                                                                                    |
| M25 upsert moves `host_id`                                    | 11 tests                                                                                                                                   |
| S1 GTIN length regex dropped                                  | refuses a layout, a GTIN and a prefix                                                                                                      |
| S2 GTIN check digit dropped                                   | same                                                                                                                                       |
| S3 prefix regex unanchored                                    | same + takes a nine-digit prefix                                                                                                           |
| S4 prefix not checked                                         | 3 tests                                                                                                                                    |
| S5 layout not checked                                         | 5 tests                                                                                                                                    |
| S6 raw layout handed on instead of the domain's               | hands on the domain's reading of the layout (only)                                                                                         |
| S7 GTIN reason wrong                                          | 3 tests                                                                                                                                    |
| S8 shape not checked                                          | 3 tests                                                                                                                                    |
| S9 prefix `^[0-9]{9}$` -> `^\d{9}$`/u                         | survives: EQUIVALENT mutant (JS `\d` is ASCII-only even with `u`; the Arabic-Indic digits test passes either way)                          |

## Tests I added (24), by hunt item

- refresh while worked: snapshot/entry time/`local_state` untouched by a list (host fields do change); same list twice = same rows (whole-row dump); one transaction (a list the table refuses: `plannedQty: 0` -> `statement_failed`, the earlier deletions rolled back, rows identical); 800-shift list in one go and shrinking to 300; a shift listed twice keeps the higher status; `seen_at` moves for a taken row and not for a skipped one.
- status monotonic: stale lists planned/active/closed, entered and not; a late entry answer over a host close (status/closedAt kept, snapshot+entry still stored); a replayed `keepCreatedShift` over an entered, active shift.
- snapshot: a second entry with different contents does not replace it; an unchecked one is refused before storage (nothing written); a ~240 KB layout with Cyrillic and a key the domain strips is stored byte-for-byte as `JSON.stringify` of the answer; every unreadable reason through `readStoredWork` (`shape` x2, `gtin`, `prefix`, `layout`).
- host text kept as is: `"null"`, `'; DROP TABLE floor_shifts; --`, JSON-looking text, tabs/newlines, emoji, `"0"` round-trip through `->>`; mode/pallets/office/plan values.
- pairing isolation: another host with the same device id (entered + listed rows untouched, nothing readable, `readStoredWork` missing); `it.each` device-only and host-only difference, each reading its own row.
- floor list: ordering by date, number, id; other line, host-closed and locally closed excluded, a closing one included.
- `checkShiftSnapshot` edges: newline/space/Arabic-Indic digits refused, `000000000` accepted, domain's reading handed on (unknown key stripped), non-object layouts are `shape` and unreadable objects are `layout`.

## Query plans (node:sqlite 3.53, checked by hand; not added to a test list)

`readShiftCopies`: `SEARCH ... USING INDEX floor_shifts_line (host_id,device_id,line_id)` + temp b-tree for the small ORDER BY; `readShiftCopy`/`readStoredWork`: `SEARCH ... USING COVERING INDEX sqlite_autoindex_floor_shifts_1`; DROP_UNLISTED: `SEARCH ... floor_shifts_line (host_id,device_id)`, subquery materialised once. These reads happen per refresh/entry, not per scan, so I did not add lines to `floor-schema.test.ts` or the Rust `the_floors_repeating_reads_search_an_index` (queued minor 5 only concerns repeated reads; a one-line addition to both lists is trivial if the reviewer wants it).

## Concerns

1. Contract for Task 5: `keepEnteredShift` now THROWS if the snapshot fails `checkShiftSnapshot` (and rejects with `LocalDbError` on a DB failure). The entry code must call `checkShiftSnapshot(entered.snapshot)` first, show the reason, and not call keep. A re-entry never refreshes the snapshot (deviation 3).
2. A list read before a station-created shift existed and applied before the shift is entered deletes that not-yet-entered copy (it is not "entered", and the list cannot know it). Self-healing: `createDeviceShift` is followed immediately by `enterShift`, whose `keepEnteredShift` reinserts the row from the full answer, and the next list brings a planned one back if entry fails. Making the delete spare it would need a "read at" parameter that the plan's signature does not have; I did not add it.
3. A stored row with a `mode` this build's Zod enum does not know (a newer build wrote it, then a downgrade) would fail `readShiftCopies` as a whole (`invalid_response`). The list route already rejects such a list at the protocol layer, so only a downgrade reaches it. Not handled.
4. A host list that is partial can only be caught by the caller: `replaceShiftCopies(..., [])` legitimately deletes every not-entered copy of the pairing. Callers must call it only with a successfully parsed full response (Task 4's host-link reads), never in a failure path; entered copies survive in any case.
5. Full-suite timeouts (template-editor) are load-related (see above); please re-run the full suite on an idle machine.

---

## Fix section (review Important 1, Minors 1-4)

BASE 904f15276; fix commit `e81e6b15d fix(standalone): a re-entry brings the snapshot fields the stored copy lost` (one Claude Opus 5.5 trailer; `git status --short` empty).

Changes:

- Important 1: `KEEP_ENTERED` again `snapshot = excluded.snapshot` (re-entry replaces the stored text; the snapshot is checked inside `keepEnteredShift`), `entered_at = coalesce(stored, new)` kept; the list upsert still never writes `snapshot`. Docstrings of `KEEP_ENTERED` and `keepEnteredShift` say what is true (the stored text is this build's Zod reading, a re-entry brings back dropped fields, the first entry time stays). The other hardening is untouched (status only forward, closed terminal, late entry answer behind a host close, throw on an unchecked snapshot).
- Minor 1: new test "keep an entered shift the host closed after it has left the list, with its snapshot and entry time" (closed list, then `[]`).
- Minor 2: new test with a stale two-item list, the behind item second, in both orders (not-yet-entered rows).
- Minor 3: `DROP_UNLISTED` docstring corrected (planned shifts deleted/moved by the office, old line's shifts after a move, shifts closed before this station entered them; another station's open shift stays as a busy copy; an entered host-closed shift stays); `replaceShiftCopies` states its contract (the host's whole parsed answer, never a fallback or partial list; `[]` drops every not-entered copy).
- Minor 4: NOT refused in `readStoredWork` (plan §5.4 has the work screen show a host-closed shift with the notice «Смену закрыли в офисе», which needs the copy and snapshot, so refusing `ready` could contradict Task 7). Documented on `StoredWork` that `ready` means only a readable snapshot and the caller checks `status`/`localState`; requirement added as item 6 of `.superpowers/sdd/2a5-minors.md` for the Task 5 (`enterShift` offline path must refuse a non-active copy) and Task 7 executors.

Tests: the old "a snapshot, once taken: is the first one" is replaced by "is replaced by a re-entry's answer, which may carry what the stored text lost; the entry time stays" (first entry without a `futureKey` layout key, re-entry answer with it) and "is never touched by a list, whatever the list carries" (lists `[ACTIVE]`, `[]`, `[PLANNED]`, edited ACTIVE).

RED (`/tmp/claude/fix3/red.txt`, new tests against the unchanged source): `Tests 1 failed | 38 passed (39)`, the failing one is the re-entry test (stored snapshot lacks `futureKey`). The Minor 1/2 tests describe existing behaviour and pass at once; they are justified by the mutants below.
GREEN: `Tests 39 passed (39)` (was 36), `--reporter=verbose` run: no `act(` / unhandled output. typecheck 0, lint 0, `prettier --check` clean, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`. The delayed-`setImmediate` stand was not re-run: the file renders no component (formality, as in the first report). Full package test not re-run (heavily loaded machine; the change is confined to one source file and its test).

Mutants (`/tmp/claude/fix3/mut.py`, output `/tmp/claude/fix3/mut.txt`; every restore verified by sha256 and `cmp` against `/tmp/claude/fix3/shift-copies.after.ts`: all `restore True True`):

| Mutant                                                                                               | Failing test(s)                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A re-entry keeps the stale text (`coalesce(floor_shifts.snapshot, excluded.snapshot)`)               | re-entry replaces the stored text (1)                                                                       |
| B list upsert also writes `snapshot = excluded.snapshot`                                             | 8 tests incl. "is never touched by a list", "never touches the snapshot, the entry time or the local close" |
| C refresh drops entered `closed` rows (`entered_at IS NULL OR status = 'closed'`), review's survivor | keep an entered shift the host closed after it has left the list (1)                                        |
| D drop protects only the first listed id (`json_each(?) LIMIT 1`), review's survivor                 | stale list of two shifts, the behind one second (1)                                                         |
| E re-entry overwrites the entry time (`entered_at = excluded.entered_at`)                            | re-entry test, "keep the first entry's time ..." (2)                                                        |

Concerns: none new. Item 6 in `2a5-minors.md` must be picked up by Task 5 (offline path refuses `status !== 'active'`) and Task 7.
