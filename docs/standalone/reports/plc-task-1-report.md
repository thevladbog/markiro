# plc Task 1 report — protocol 3 on the station

Status: DONE. Commit: `b1b0984e7` feat(standalone): protocol 3 on the station — a shift's pallets, its pallet layout, the pallets' records and receipt codes (worktree /tmp/claude/wt/flr, BASE 33231f9eb). Only TS/JSON/i18n touched; no Rust, proto or fixtures, so no cargo run was needed.

## What was done

- `src/host/protocol.ts`: `DeviceShift` += optional `palletBoxCapacity`, `palletTemplateId`; snapshot += optional `palletTemplate`; `DeviceShiftCreate` += `palletsEnabled`, `palletBoxCapacity`, `palletTemplateId`; `boxClosedFactSchema.palletId`; `palletClosedFactSchema`, `palletLabelFactSchema`, `palletExceptionFactSchema` (strict) and their types; three new variants of `factRecordSchema`; comment of `ssccBlockRequestSchema` (extension 1 = pallet).
- `src/floor/facts.ts`: `palletClosedRecord`, `palletLabelRecord`, `palletExceptionRecord`.
- `src/host/requests.ts`: `DeviceShiftInput.pallets?`, `deviceShiftCreate` sends the three fields only with pallets.
- `src/floor/shifts/shift-snapshot.ts`: `SnapshotTemplate`, `CheckedSnapshot.palletTemplate`, `checkShiftSnapshot(raw, palletsEnabled = false)`, a pallets shift without a readable pallet layout is refused (`layout`).
- `src/floor/shifts/shift-entry.ts`: `pallet_template_not_fit` refusal + mapping; entry check passes `answer.palletsEnabled`. `ru.json`: its words.
- `src/floor/shifts/shift-copies.ts`: `readStoredWork` passes `row.pallets_enabled === 1`; `keepEnteredShift` passes `shift.palletsEnabled`.

## RED / GREEN

- RED: `vitest run test/floor-facts.test.ts test/floor-shift-list.test.tsx test/protocol.test.ts test/shift-copies.test.ts` — 9 failed | 364 passed (373) (plan said 7 failures; the extra ones are the two fixture round-trips already counted by the plan's list differently, see below). Output: /tmp/claude/impl-plc-t1-red.txt.
- GREEN: same command — 4 files, 373 passed; after the extra tests below, 375 passed (plan: 288 on its scratch copy; the real tree has more tests in these files).
- Full package: 116 files, 3557 tests passed (plan scratch: 112/2666 -> different tree). typecheck, lint, `git diff --check` clean. `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.
- Verbose run: stderr empty; delayed-`setImmediate` stand on `floor-shift-list.test.tsx`: 52 passed; stand files deleted.
- PRETTIER GATE: `node_modules/.bin/prettier --ignore-path .prettierignore --check <11 repo-relative files>` clean; proven live with a mis-formatted scratch file (failed, then deleted).

## Anchor adaptations

- `FACT_RECEIPT_CODES` already contained the four pallet codes and the test «know every receipt code of the host» already passed: the fragment 5 of protocol.ts was skipped (nothing to fix).
- `shiftSnapshotTemplateSchema` already existed (fragment used as is); `officeShiftSchema` already had the pallet fields (not touched).
- Test anchors in `floor-facts.test.ts` («record(5) … carry a code …») and in `protocol.test.ts` (shift shapes, receipt codes) were applied by meaning: the new tests are inserted before the named test / at the start of the describe.
- Beyond the plan (mechanical, same intent): `keepEnteredShift` also called `checkShiftSnapshot(snapshot)` without the flag; it now passes `shift.palletsEnabled`, otherwise a pallets answer without a layout could still be stored. Tests added for it, for `readStoredWork`, for `enterShift`, for `checkShiftSnapshot(pallets)` with pallets off (palletTemplate -> null), and for strictness of the three pallet records (`addedLater` key).

## Mutants (all restored byte-identically: backup copy, `cmp`, sha256 equal; script /tmp/claude/impl-plc-t1/mut.py)

| Mutant                                              | Failing test                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M1 box_closed `palletId` z.string                   | protocol «read the pallets' records of protocol 3…»                                                                |
| M2 `boxCount` nonnegative                           | same                                                                                                               |
| M3 drop `palletsEnabled && pallet === null` refusal | shift-copies «reads a shift's pallet layout…», «keeps a pallets shift…»                                            |
| M4 drop `pallet_template_not_fit` mapping           | floor-shift-list «says why the host refused the entry (pallet_template_not_fit)»                                   |
| M5 `palletTemplate: pallet` regardless of flag      | shift-copies «reads a shift's pallet layout…»                                                                      |
| M6 `keepEnteredShift` ignores flag                  | shift-copies «keeps a pallets shift…»                                                                              |
| M7 `readStoredWork` ignores flag                    | same                                                                                                               |
| M8 `enterShift` ignores flag                        | floor-shift-list «neither keeps nor works a shift with pallets whose answer has no pallet layout»                  |
| M9 builder drops `palletTemplateId`                 | protocol «a station's new shift with pallets…»                                                                     |
| M10 builder always sends pallet fields              | same + two existing builder tests                                                                                  |
| M11 `DeviceShift.palletBoxCapacity` nonnegative     | protocol «read a station's shift with pallets…»                                                                    |
| M12 `DeviceShift.palletTemplateId` any string       | same                                                                                                               |
| M13 `pallet_label.outcome` any string               | protocol «read the pallets' records…»                                                                              |
| M14 `pallet_exception.reasonCode` nullable          | same                                                                                                               |
| M15 `pallet_exception` allows `undo`                | same                                                                                                               |
| M16 `pallet_closed` not strict                      | same                                                                                                               |
| M17 `palletClosedRecord` wrong kind                 | floor-facts «build every record of facts-request-pallets.json exactly»                                             |
| M18 snapshot schema drops `palletTemplate`          | protocol «device-shift-entered-pallets.json parses without losing a field», «read a station's shift with pallets…» |

## Concerns

- None blocking. Plan counts differ from measured (plan 288 / 2666 on scratch; measured 375 in the four files, 3557 in the package). The full package run was green (no load-induced timeouts this time).
- Task 2 (migration 0008) must add the pallet columns of the shift copy: `fields` JSON written by `keepEnteredShift` now carries `palletBoxCapacity`/`palletTemplateId` when present; the copy reading of them is Task 2's.
