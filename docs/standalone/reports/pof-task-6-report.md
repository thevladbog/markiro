# plan О-Ф, task 6 — report (the card of a shift: `shifts/:id`, boxes, pallets, «Итоги», «Выгрузка», «Закрыть»)

Status: DONE_WITH_CONCERNS (concerns at the end).

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `0010233dc`.
Commit: `d552777f3 feat(standalone): the card of a shift — its boxes and pallets as the host has them, its figures, export and close` (one trailer; not pushed; tree clean after).

## What was done

Page `shifts/:id` (`ShiftCardPage.tsx`) + `shift-card.ts` (pure helpers), route, `officeKeys.shiftBoxes`, a link on the shift number in «Смены» (`Карточка смены …`), texts in `ru.json`, three CSS rules. It reuses `ShiftTotalsDialog`, `CloseShiftDialog` and `ExportDialog` as they are (no duplicate of «Итоги»/«Выгрузка»), reads `getShift` afresh (`officeKeys.shift`), and shares `officeKeys.shiftPallets` with the export dialog's cache. Any role reads; «Закрыть» is `planShifts` and only on an active shift; «Итоги»/«Выгрузка» only on non-planned shifts; a planned shift has no boxes/pallets sections and does not read them. Times are in the organization's zone (`formTimeZone`).

Mandatory addenda:

- **Late box** (minors plh item 8): a closed, not-taken-apart box whose `closedAt` is after its pallet's `closedAt` (instants via `Date.parse`, to the millisecond, same rule as the export's `lateBoxes`) gets a word chip «Закрыт после закрытия паллеты» in its state cell (`isLateBox`).
- **Count mismatch**: a closed (not taken apart) pallet whose `boxCountReported` differs from the live `boxes`, either direction, null = none counted, gets «Счёт коробов станции другой» (`palletCountDiffers`; same rule as `reportedCountWarnings`).
- **Disassembled pallet** (ЧЗ T2 concern 2): the card shows «Расформирована» + `disassembledAt`, and «—» in the boxes/units columns (the host keeps the link), and no count-mismatch chip (stale by design). A taken-apart box gets no digest-mismatch chip either.
- Accessibility: `<section aria-labelledby>` with `<h2>`, tables with localized `empty` and `scrollLabel`, labelled numeric filter + hint, polite live region for "Показано N из M" (plain text, no Alert inside any live region), error and loading states per section, "Повторить"; the close notice is an Alert that takes focus (tested); state is always glyph + word (`StatusChip`), never colour alone; office controls (`md` header buttons, `compact` in alerts/pager).
- Not needed: `useBlocker` (no unsaved state).

## Anchor adaptations (all mechanical)

1. `office-query.ts`: the brief adds `shiftBoxes` AND `shiftPallets`; `shiftPallets` already exists (plan ЧЗ). Added only `shiftBoxes`.
2. `ShiftsPage.tsx`: the brief's import anchor assumed `useQueryClient` as the first import; the file starts with `@markiro/domain`. Added `import { Link } from "react-router";` after `react-i18next`; the number-cell edit matched exactly.
3. `ru.json`, `routes.tsx`, `shell.css`: matched exactly.

## Deviations from the brief (each deliberate, each tested)

- **Brief bug fixed**: the brief's `t("office.shiftCard.pallets")` for the «Паллеты» definition term hits an object (`pallets.title`…), so i18next renders `key 'office.shiftCard.pallets (ru)' returned an object instead of string.` as the term (my facts test caught it). New key `office.shiftCard.palletsFact`.
- `ExportDialog` is `lazy` + `Suspense` (as in `ShiftsPage`), not a static import: a static import would pull the export renderers back into the page's chunk the list deliberately keeps out.
- `labelState` compares instants (`Date.parse`), not text: `…:01Z` and `…:01.500Z` are both valid `z.iso.datetime()` values and sort wrongly as text (tested; mutant M4).
- Pallet column of a box: while the pallets list is pending the cell says «Загрузка…», if it failed «Паллеты не загружены» (the brief would say «Паллета не найдена» for every box, a false statement); «Паллета не найдена» only for a pallet really absent from a loaded list.
- `PackStateCell`: each flag has one guard (box digest requires `closed`; pallet count in `palletCountDiffers`) so no redundant guard masks a mutant.
- Brief test 5 now also checks the focus on the notice and that the boxes are read again after the close.

## Tests

Brief tests: 9. Mine: 26 in the file (9 brief + 17 added). Plan said `Tests 9 passed (9)` for the file; measured 26. Added: product/line/counterparty/zone facts (Kamchatka), shift without pallets and counterparty, planned shift with pallets planned, disassembled pallet, pallet count either direction/null/equal, late box to the ms (+ mixed precision, taken-apart, open pallet), page reset on typing (140 boxes), figures+exports of a closed shift, per-section load failures with retry, stale close from the card, digest of a taken-apart box, pallet absent / pallets pending, page clamp when the boxes shrink, 3 helper unit tests.

Evidence:

- RED: `/tmp/claude/impl-pof-t6/red.txt` — `Failed to resolve import "../src/office/shifts/shift-card.js"`, no tests.
- GREEN: `vitest run test/shift-card.test.tsx --reporter=verbose` — 26 passed, no stderr/`act` warnings (`green8.txt`).
- Delayed-`setImmediate` 3 ms stand (temporary files deleted): `shift-card` + `shifts-page` + `shift-totals`, 3 files, 73 passed.
- `typecheck` 0, `lint` 0, `build` 0, prettier gate live (probe `zz_gate_probe.ts` exit 1 with "Checking formatting..."; 8 changed files then "All matched files use Prettier code style!"), `git diff --check` clean, `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`.
- Full package `test`: 103 files, 3156 tests: 3147 passed, 9 failed — 8 are 5 s timeouts (`shifts-page` 3, `template-editor` 4, `templates-page` 1, load average ~170) and 1 is `app.test` "shows a name the office changed…" (a 1 s `findByRole` miss on the floor under the same load). Re-run of those 4 files with `--testTimeout=60000`: 4 files, 296 passed.
- No Rust touched: cargo not run (nothing to run).
- Old tests changed deliberately: none. (`shifts-page.test` still passes unchanged: the number is now a link, `getByText(number).closest("tr")` still works.)

## Mutants (harness `/tmp/claude/impl-pof-t6/mutate.py`, anchor occurs once; file copied first, restored, `cmp` + sha256 equal for every row)

| #         | One-line mutant                               | Killed by (first failing tests)                                                                       | Restored |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| K1        | `endsWith` → `includes`                       | `filters by the digits an SSCC ends with`; `goes back to the first page…`                             | yes      |
| K2        | label state always `verified`                 | `reads the later label check of the two`                                                              | yes      |
| K3        | digest never mismatches                       | `opens from the shift's number…`; `says a closed box's digest…`                                       | yes      |
| M4        | label compared as text                        | `reads the label check by the instants…`                                                              | yes      |
| M5        | late: `>=` for `>`                            | `flags a box the station closed after its pallet…`; helper test                                       | yes      |
| M6        | late: taken-apart box counts                  | same two                                                                                              | yes      |
| M7        | late: text order                              | same two                                                                                              | yes      |
| M8        | late: drop `pallet.closedAt === null` guard   | SURVIVES — equivalent at runtime (`Date.parse(null)` is `NaN`, `>` false); the guard is for the types | yes      |
| M9        | count: null counts as different               | `…counted a closed pallet's boxes otherwise…`; helper                                                 | yes      |
| M10 / M11 | count: only more / only fewer reported        | same (+ brief test for M11)                                                                           | yes      |
| M12       | count: pallet taken apart counts              | `says a pallet taken apart by when…`; helper                                                          | yes      |
| M13       | box digest: taken-apart box counts            | `says a closed box's digest did not match…`                                                           | yes      |
| M14 / M15 | late chip not shown / late never computed     | `flags a box the station closed after its pallet…`                                                    | yes      |
| M16 / M17 | taken-apart pallet shows boxes / units        | `says a pallet taken apart by when…`                                                                  | yes      |
| M18       | no `disassembledAt` text                      | four card tests                                                                                       | yes      |
| M19       | page not reset when typing                    | `goes back to the first page…`                                                                        | yes      |
| M20       | page not clamped                              | `stays on the pages that are left…`                                                                   | yes      |
| M21       | PC zone, not the organization's               | facts test (Kamchatka) — needs a PC outside UTC+12                                                    | yes      |
| M22       | pallets asked for without pallets             | `keeps the boxes whose SSCC ends…` (now asserts no `listShiftPallets`)                                | yes      |
| M23 / M24 | boxes / shift not read again after close      | close tests                                                                                           | yes      |
| M25       | page size 51                                  | pager tests                                                                                           | yes      |
| M26       | tail not reduced to digits                    | tail tests                                                                                            | yes      |
| M27 / M28 | pallets / boxes of a planned shift            | planned-shift tests                                                                                   | yes      |
| M29 / M30 | totals offered for planned / close for closed | planned / closed tests                                                                                | yes      |
| M31       | stale reload does not read                    | stale-close test                                                                                      | yes      |
| M32       | notice not focused                            | close test (`expectFocusedNotice`)                                                                    | yes      |
| M33       | pallet absent from list shown as «—»          | `names the pallet of a box, says when it is not among…`                                               | yes      |
| M34       | mismatch chip dropped                         | brief test, digest test, count test                                                                   | yes      |
| M35 / M36 | pallets pending / failed shown as not found   | `does not call a pallet missing…`; `…did not load…`                                                   | yes      |

## Render cost (large shifts; the brief pages boxes at 50, pallets not paged)

Scratch test (deleted), jsdom, load average ~170 (so pessimistic): open card + boxes + pallets / one keystroke in the SSCC filter —
1500 boxes / 300 pallets: 871 ms / 45 ms; 10 000 / 300: 994 ms / 72 ms; 10 000 / 1000: 2229 ms / 159 ms (1052 DOM rows). One page of boxes is 50 rows whatever the size; the filter is one linear pass. 300 pallets (the stated size) render as one table without paging; 1000 pallets would justify paging pallets — not done (brief does not ask, real shifts have tens to hundreds).

## Self-review / concerns

1. The card does not refresh itself: an active shift's lists are as of opening (no `refetchInterval`, no «Обновить» button; a close or navigating back re-reads). The brief did not ask; flagging for the owner.
2. The role guard "closing is `planShifts`" has no negative test: both existing roles (admin, technologist) have it.
3. Mismatch/late chips say a fact, not the numbers (the pallet chip does not show "станция насчитала N, сейчас M") — the brief's texts kept.
4. `ShiftStatusLine` duplicates the list's status cell (chip, late data, close reasons); extracting a shared component would touch `ShiftsPage` more than the brief allows.
5. Focus on arrival at the card is not moved to the heading (as the other office pages).
6. Forms («Бланк», «Состав …») are Task 7; not present.
7. M8 equivalent mutant (above).
8. Not exercised: real WebView2, real browser look of the card, a real host answer (all tests stub `HostApi`).
