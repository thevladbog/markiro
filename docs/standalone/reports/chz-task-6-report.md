# plan ЧЗ, task 6 — report (what the export dialog knows before it forms a file)

Status: DONE_WITH_CONCERNS (concerns are findings for Task 8 and the coordinator, none blocks).

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `77acbdd36`.

## Commit

- `603cf565b feat(standalone): what the export dialog knows before it forms a file` (one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no push; tree clean afterwards).

Files (all new): `apps/standalone/src/office/exports/export-checks.ts`, `apps/standalone/test/export-checks.test.ts` (brief's test, byte-identical to the brief's fenced block: `cmp` silent), `apps/standalone/test/export-checks-warnings.test.ts` (mine, beyond the brief).

## Anchor adaptations

None. Both brief files are "create". The brief's source is kept verbatim; my additions are an extra import (`OfficePallet`), three union members, three exports and one private helper (see below). Prettier reformatted nothing in the brief's text.

## What was added beyond the brief (and why)

Dispatch asked for: Ч1 warning with a COUNT (brief already has `disassembled_pallets`), the late-box flag (plh-minors item 8) and the `boxCountReported` vs live count mismatch "if the brief's contract allows". The brief does NOT cover the last two. Its contract (the existing outputs of `exportWarnings`, `palletOffers`, `PalletOffer`) allows adding them without changing any result the brief's tests pin, so I added them as new, additive members:

- `ExportWarning` gains `{ kind: "late_boxes"; boxes }` and `{ kind: "pallet_count_mismatch"; pallets }`.
- `exportWarnings(rows, format, formedAt)`: for a pallets format whose source is allowed, appends `late_boxes` AFTER the brief's three kinds (order: late_data, open_pallets, disassembled_pallets, late_boxes). The count is of boxes the shift document writes (closed, not taken apart, with codes) on a pallet with an SSCC and a close, whose own `closedAt` is strictly after the pallet's, compared as instants to the millisecond. Not emitted for flat/box formats.
- `palletWarnings(rows, palletId)`: same signal for ONE pallet's document (counts every closed, not-taken-apart box of that pallet, empty ones too, because the pallet document lists them); `[]` when the pallet's document is refused.
- `reportedCountWarnings(pallets: readonly OfficePallet[])`: takes the host's `listShiftPallets` output (the only place `boxCountReported` exists; `ShiftExportRows` does not carry it), counts pallets that are not taken apart, have a reported count and `boxCountReported !== boxes`. One `pallet_count_mismatch` with the count, or `[]`.
- I did not put these in `PalletOffer` (would break the brief's `toEqual`) — a separate function, so Task 8 decides whether to show them.

Ч1: nothing more needed in the logic: `disassembled_pallets` carries the COUNT of pallets taken apart that the document still names (`snapshot.disassembledPalletCount`).

## User-visible Russian texts

Task 6 produces data only; no user-visible strings are written here, so `src/i18n/ru.json` is untouched. Task 8 must add texts for all five `ExportWarning` kinds and for the `ExportSourceRefusal` codes (and, per Task 5 review's observation, explain `INVALID_ORG_INN` for a 12-digit sole-proprietor INN in words).

## Counts: plan vs measured

| What                                    | Plan | Measured       |
| --------------------------------------- | ---- | -------------- |
| `export-checks.test.ts`                 | 7    | 7              |
| `export-checks-warnings.test.ts` (mine) | -    | 12             |
| both together                           | -    | 19 passed (19) |

(The plan's accumulated Vitest totals are already shifted by Task 5's +21 golden runs and +39 rules tests; I did not re-count the whole package for this task — it adds two files and 19 tests only. The webview build, typecheck and lint pass.)

## TDD evidence

- RED 1 (brief test only, no source): exit 1, `Failed to resolve import "../src/office/exports/export-checks.js" from "test/export-checks.test.ts"`, `Tests  no tests` (`/tmp/claude/impl-chz-t6/red.txt`).
- GREEN 1 (brief's source verbatim): `Tests  7 passed (7)`, 7 `✓` (`green1.txt`).
- RED 2 (my test file against the brief's source): 8 failed (3 assertion failures of `late_boxes` missing/`[]`, 4 `palletWarnings is not a function`, 1 `reportedCountWarnings is not a function`; the two negative cases passed trivially) (`red2.txt`).
- GREEN 2: both files, verbose, `Test Files 2 passed (2)  Tests 19 passed (19)`, stderr 0 bytes.
- `typecheck` exit 0, `lint` exit 0, `build` (webview) exit 0.
- PRETTIER GATE live: `node_modules/.bin/prettier --ignore-path .prettierignore --check <3 repo-relative paths>` from the worktree root prints `Checking formatting...` / `All matched files use Prettier code style!`; a mis-formatted scratch file (`const   x  =  1`) in the same command made it exit 1 first, then was deleted. (My first attempt passed the paths as one string in zsh and the gate said "No files matching" — caught, redone with an array.)
- `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`.
- Delayed-`setImmediate` stand: not applicable (pure functions, no React rendering).

## Mutants (runner `/tmp/claude/impl-chz-t6/mutate.py`: backup `orig.ts`, anchor must match exactly once, vitest of both files via the JSON reporter, restore, `filecmp` + sha256 against the pre-mutation hash; every row `restored: true`; final `cmp orig.ts export-checks.ts` silent)

Brief's K1–K9:

| Mutant                                         | Result                               | Fails | First failing test                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1 palletsformats always offered               | KILLED                               | 1     | are every format for a shift with pallets, the five without ...                                                                                                                                |
| K2 open pallets first                          | KILLED                               | 1     | are closed ones by their close and SSCC, open ones last ...                                                                                                                                    |
| K3 open box counted closed                     | KILLED                               | 1     | count the codes, those in closed boxes ...                                                                                                                                                     |
| K4 late-data warning removed                   | KILLED                               | 2     | brief's warn test (+ mine)                                                                                                                                                                     |
| K5 drop the "pallets format only" early return | KILLED (brief says PASS, equivalent) | 1     | mine: "is a warning of the pallets formats only ..." — no longer equivalent, because `late_boxes` is computed outside the snapshot; the early return is now what keeps it off flat/box formats |
| K6 folder by UTC                               | KILLED                               | 1     | the folder of an export                                                                                                                                                                        |
| K7 number not sanitized                        | KILLED                               | 1     | the folder of an export                                                                                                                                                                        |
| K8 taken-apart pallet counts as closed         | KILLED                               | 1     | count the codes ...                                                                                                                                                                            |
| K9 12-hour clock                               | KILLED                               | 1     | the folder of an export                                                                                                                                                                        |

Mine (L = late boxes, C = reported-count):

| Mutant (one line)                                           | Result                                                                        | Test that killed it                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| L1 `>` to `>=` (box closed at the pallet's instant is late) | KILLED (2)                                                                    | is not counted when the box closed at the pallet's own instant or before it |
| L2 compare to the second (`slice(0,19)`)                    | KILLED (2)                                                                    | is counted ... however little later (100 ms)                                |
| L3 shift format counts a box without codes                  | KILLED                                                                        | leaves out a box the shift formats do not write                             |
| L4 pallet document counts every pallet's boxes              | KILLED                                                                        | leave out the boxes of another pallet ...                                   |
| L5 taken-apart box counted                                  | KILLED                                                                        | same                                                                        |
| L6 pallet with a close but no SSCC counted                  | KILLED                                                                        | is not counted for a box on a pallet that has no SSCC yet ...               |
| L7 unknown pallet crashes (no `undefined` guard)            | KILLED                                                                        | same (pallet not in rows)                                                   |
| L8 `closedAt === undefined` instead of `null`               | SURVIVES, equivalent: `Date.parse(null)` is NaN and `>` is false, same answer |
| L9 `palletId === undefined` instead of `null`               | SURVIVES, equivalent: a null-pallet box finds no owner and returns false      |
| L10 `palletWarnings` without the refusal guard              | KILLED                                                                        | are none for a pallet whose document cannot be formed                       |
| L11 `exportWarnings` never adds `late_boxes`                | KILLED (3)                                                                    | counted ...                                                                 |
| L12 `palletWarnings` count constant 1                       | KILLED after I added "count each late box" (it survived the first set)        | count each late box                                                         |
| L13 `exportWarnings` count constant 1                       | KILLED                                                                        | is counted by box, not once for the shift                                   |
| L14 `late_boxes` first instead of last                      | KILLED                                                                        | is a warning of the pallets formats only, and sits after the other warnings |
| L15 shift format ignores the "has codes" rule               | KILLED                                                                        | leaves out a box the shift formats do not write                             |
| C1 mismatch inverted                                        | KILLED                                                                        | are counted once each when ...                                              |
| C2 taken-apart pallet counted                               | KILLED                                                                        | ignore a pallet the station reported no count for and one taken apart       |
| C3 null report counted                                      | KILLED                                                                        | same                                                                        |
| C4 compares to `units` not `boxes`                          | KILLED                                                                        | are counted once each ...                                                   |
| C5 count constant 1                                         | KILLED                                                                        | are counted once each (two pallets)                                         |
| C6 `> 1` threshold                                          | KILLED                                                                        | are counted once each (single pallet)                                       |

Full log: `/tmp/claude/impl-chz-t6/mut.log`.

## Concerns / things the coordinator should know

1. Brief's K5 is stated equivalent; with the late-box addition it is killed. No plan edit made.
2. The late-box signal is computed from `ShiftExportRows` (box and pallet `closedAt`). The count mismatch needs `OfficePallet.boxCountReported` from `listShiftPallets`, which the dialog does not fetch today (it only has the export-source rows). Task 8 must either fetch `listShiftPallets` or drop the mismatch warning; the function is ready and pure. Both warnings are information only (no byte of a file changes).
3. The shift's pallets formats count late boxes also on a taken-apart pallet (it is still written as a pallet, Ч1); the UI may want to show the two warnings together or suppress the late one when the pallet is taken apart — Task 8's choice.
4. The brief's `exportFolder` uses the organization's time zone: the caller (Task 8) must supply the IANA zone of the organization profile; there is no default here.
5. Dispatch item "plan counts 198/206 shift by +21" is Task 5's concern and was not touched; I report only this task's 7 + 12 tests.
6. The Task 5 review's Minors 1-3 and 4 (m4: log non-domain errors) live in `chz-minors.md` for the final wave and are not part of this task; nothing here changes them.
