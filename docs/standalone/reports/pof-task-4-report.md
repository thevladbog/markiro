# Plan О-Ф, Task 4 report: the cloud forms' inputs from the host's rows, drawn by the domain in the office

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `a041000fe`. Commit **`262e41f2a` feat(standalone): the office draws a shift's printed forms with the cloud's inputs and bytes** (one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` empty after the commit. Artefacts (RED/GREEN outputs, mutant runner `mut.py`, mutant list `mutants.py`, per-mutant JSON in `out/`, results `results_*.json`, campaign log) are in `/tmp/claude/impl-pof-t4/`.

Status: **DONE_WITH_CONCERNS** (notes only; nothing blocks).

## What was done

Brief Steps 1-6 in order. The four files of the brief (`src/office/forms/form-data.ts`, `render-form.ts`, `test/form-data.test.ts`, `test/forms-parity.test.ts`) were extracted mechanically from the brief's fenced blocks and are byte-identical to them (no anchor problems: all four are "create"). One file beyond the brief: `apps/standalone/test/form-data-rules.test.ts` (19 tests), added because the mutant campaign showed the brief's tests let mutants live (see below). No production code beyond the brief's.

### Anchor adaptations

None (create-only task). No semantic difference found.

### Changed since the plan (as the dispatch said)

Golden has 12 runs (task 3 fix round: golden SHA-256 `58d40eb3...520f`, cases SHA-256 `2a971a11...2974`). `forms-parity.test.ts` therefore has 13 tests (1 key-set + 12 runs), not 11. The port reproduces the golden for EVERY run key byte for byte (all 12 `it.each` runs pass, plus the key-set test `covers every case the cloud's golden has`, which compares the case names with `Object.keys(golden)`). Verified `cases.json`/`golden.json` are untouched by this task.

## Evidence

RED (`red.txt`): `pnpm ... exec vitest run test/form-data.test.ts test/forms-parity.test.ts` with the two `src` files absent: exit 1, `Failed to resolve import "../src/office/forms/form-data.js"` and `"../src/office/forms/render-form.js"`, `Tests  no tests`.

GREEN (`green1.txt`, brief's two files, verbose): `Test Files  2 passed (2)  Tests  21 passed (21)` (plan: 19; golden +2 runs), stderr 0 bytes. Final (`final.txt`, three files, verbose): `Test Files  3 passed (3)  Tests  40 passed (40)` = form-data 8 + forms-parity 13 + form-data-rules 19, stderr 0 bytes (no `act` warnings, no unhandled rejection).

Other gates (all after the last edit, tree = commit): `typecheck` rc 0; `lint` rc 0; `build` rc 0; `git diff --check` clean (also on the staged diff); `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`; no `\u0` escapes in `src/office/forms`. PRETTIER GATE live: from the worktree root with `--ignore-path .prettierignore` and repo-relative paths, a scratch `zz_gate_probe.ts` (`const   x  =  1`) printed `[warn]` rc 1 (file deleted); the five changed files then: `Checking formatting... All matched files use Prettier code style!` (my rules test needed one `--write` pass first). The delayed-`setImmediate` stand does not apply: none of the three files renders React or has an effect (pure functions).

Full `@markiro/standalone` Vitest, one run at load 50-80: `Test Files 1 failed | 100 passed (101)`, `Tests 4 failed | 3110 passed (3114)`; the 4 failures are `Test timed out in 5000ms` in `test/template-editor.test.tsx` (the load-sensitive suite the plan names; not touched). Alone with `--testTimeout=60000`: `97 passed (97)`. No green full run at the default limit was obtained (same as tasks 1-2). Counts, plan vs measured: plan "+2 files, 19 tests" vs measured +3 files, 40 tests (21 from the brief's two files because of the golden's 12 runs, 19 mine); whole package 3114 tests in 101 files.

Not run: cargo (this task touches no Rust). Not verified by any automated check here: the real WebView2 rendering/printing of these HTML bytes (Tasks 5-7), the organization's real zone on a customer PC.

## Cross-check of the mapping against the cloud's loaders (beyond the golden)

I read `CodeSearchService.boxReportData/palletReportData/shiftPlacardsData/palletPlacardData` (`code-search.service.ts:1174-1470`) and `ShiftsService.taskFormData` (`:592`) against the port:

- SSCC: loaders use `formatSsccWithAi` (`00` + 18 digits); port `machineSscc`. Status: cloud `disassembledAt ? disassembled : closedAt ? closed : open`; port `lifecycle` identical.
- Pallet boxes: cloud orders `closedAt, id` and includes every box with `pallet_id`; the host sends them in that order and the port neither sorts nor filters (pinned by mutants P2, and by rules test with a non-closing-order list). Retired box: the host sends 0 units, the cloud its count at disassembly; the domain prints `—` and leaves it out of totals either way (task 3: X3 equivalent).
- Placard: boxes' production date = the shift's declared date (cloud reads the box's own shift; on the host a pallet's boxes are all of its shift); a pallet taken apart prints with the watermark; open/no-SSCC pallet refused (`PALLET_NOT_CLOSED` -> `null`); the shift set = closed, not taken apart, with an SSCC, closed first first then id (cloud `orderBy(closedAt, id)`); empty set -> `null` (`SHIFT_HAS_NO_PALLETS`).
- Blank: closed shift -> `null` (`SHIFT_TASK_FORM_CLOSED`); the standalone has no `plannedDate` (one date, Ф3), no photo, no SSCC issuer, no validation print settings: the port passes the cloud's neutral values (`null`, `none`, `none`, `false`) which are also what the cloud's DB defaults give.
- Expiry: the placard shelf-life date is computed by the domain (`productionDate + N - 1`, killed by task 3's D7); the port passes `shelfLifeDays` and the shift's date unchanged (rules test pins both, and K4 pins that it is NOT taken from the pallet's close day, which is the next day for a night shift).
- Time zone: box and pallet forms take `formTimeZone(organization)` (organization's IANA zone, PC's only for an unknown one); verified by rules test that Vladivostok and UTC give different hours in the HTML (`08.10.2026 16:05` vs `06:05`). Logo: Markiro's (P15), `logo: null`.
- No CDN, no network: the port only builds strings from the domain; fonts are the domain's own (`Arial, sans-serif`/`monospace` system fonts, as the cloud; barcodes inline SVG).

## Mutants (restored byte-identically)

Method: `mut.py` copies `form-data.ts` / `render-form.ts` to `orig/`, applies ONE exact-once replacement (anchor count checked), runs the three test files with the JSON reporter, restores from the copy, `filecmp` + sha256 against the pre-mutation hash (`restored=True` for all 89 runs), `touch`. After the campaign `cmp` of both source files against the copies taken before any mutation: SAME (and equal to the committed blobs). Every row's single mutation is one line. "rules ONLY" = killed only by `form-data-rules.test.ts` (a test I added beyond the brief); "brief tests" = killed by the brief's two files alone.

| #   | Mutant                             | Killed by     | Example failing test                                                   |
| --- | ---------------------------------- | ------------- | ---------------------------------------------------------------------- |
| M1  | brief M1                           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) writes an SSCC in th |
| S2  | null SSCC becomes 00null           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) writes an SSCC in th |
| O1  | org INN dropped                    | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| O2  | org name from inn                  | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| L1  | closed beats disassembled          | brief + rules | printed forms parity with the cloud (plan О-Ф) box-disassembled: the o |
| L2  | no closed state                    | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| L3  | no disassembled state (box/pallet) | brief + rules | printed forms parity with the cloud (plan О-Ф) box-disassembled: the o |
| A1  | null instant becomes epoch         | brief + rules | the forms' inputs from the host's rows (plan О-Ф) dates every box of a |
| B1  | box status args swapped            | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B2  | box product name                   | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B3  | box openedAt from closedAt         | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B4  | codes reversed                     | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B5  | GS stripped from KM                | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B6  | KM trimmed                         | rules ONLY    | a box's form data (plan О-Ф) keeps a code's text byte for byte: the gr |
| B7  | gtin/serial swapped                | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B8  | box SSCC bare                      | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| B9  | box disassembledAt dropped         | brief + rules | printed forms parity with the cloud (plan О-Ф) box-disassembled: the o |
| P1  | pallet product name                | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| P2  | pallet boxes reversed              | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| P3  | pallet box units dropped           | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| P4  | pallet box SSCC bare               | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| P5  | pallet status args swapped         | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| P6  | unknown pallet answers the first   | brief tests   | the forms' inputs from the host's rows (plan О-Ф) knows no pallet the  |
| P7  | pallet disassembledAt dropped      | rules ONLY    | a pallet's form data (plan О-Ф) calls an unclosed pallet open and a pa |
| H1  | hasPlacard OR                      | brief + rules | the forms' inputs from the host's rows (plan О-Ф) has a placard only f |
| H2  | hasPlacard no SSCC check           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) has a placard only f |
| H3  | hasPlacard no close check          | rules ONLY    | the shift's placards (plan О-Ф) leaves out a pallet taken apart, one o |
| K1  | brief M2                           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) has a placard only f |
| K2  | placard GTIN                       | brief + rules | printed forms parity with the cloud (plan О-Ф) placard-a4: the office  |
| K3  | placard shelf life                 | brief + rules | printed forms parity with the cloud (plan О-Ф) placard-a4: the office  |
| K4  | placard date from close day        | rules ONLY    | a pallet's form data (plan О-Ф) maps every field of a placard, a box t |
| K5  | placard units dropped              | brief + rules | the forms' inputs from the host's rows (plan О-Ф) dates every box of a |
| K6  | placard box disassembledAt dropped | brief + rules | printed forms parity with the cloud (plan О-Ф) placard-a4: the office  |
| K7  | placard without close/SSCC drawn   | brief tests   | the forms' inputs from the host's rows (plan О-Ф) has a placard only f |
| K8  | placard product name               | brief + rules | printed forms parity with the cloud (plan О-Ф) placard-a4: the office  |
| Q1  | brief M3                           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| Q2  | brief M4                           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| Q3  | id descending                      | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| Q4  | close descending                   | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| Q5  | close to the second                | rules ONLY    | the shift's placards (plan О-Ф) orders by the full instant, to the mil |
| Q6  | id only                            | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| Q7  | (equiv: copy)                      | SURVIVED      |                                                                        |
| Q8  | localeCompare for byText           | SURVIVED      |                                                                        |
| Q9  | pallet with no boxes dropped       | rules ONLY    | the shift's placards (plan О-Ф) leaves out a pallet taken apart, one o |
| N1  | no pallets answers an empty set    | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| N2  | shift number from id               | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| N3  | placards reversed after sorting    | brief + rules | the forms' inputs from the host's rows (plan О-Ф) prints the shift's p |
| T1  | closed shift gets a blank          | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T2  | planned has no blank               | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T3  | blank token from product           | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T4  | blank number                       | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T5  | blank status fixed                 | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T6  | blank mode fixed                   | rules ONLY    | the blank's data (plan О-Ф) carries the plan, the pallet rule, the mod |
| T7  | blank organization name            | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T8  | blank productId                    | rules ONLY    | the blank's data (plan О-Ф) maps every field of a planned shift, with  |
| T9  | blank product name from print name | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T10 | blank print name                   | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T11 | blank GTIN                         | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T12 | blank photo                        | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T13 | blank line                         | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T14 | brief M5                           | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T15 | blank production date              | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T16 | blank plan                         | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T17 | blank box capacity                 | brief + rules | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| T18 | pallets flag from capacity         | brief tests   | printed forms parity with the cloud (plan О-Ф) task-form-pallets-off-s |
| T19 | capacity hidden when pallets off   | rules ONLY    | the blank's data (plan О-Ф) passes the pallet switch and the capacity  |
| T20 | blank counterparty                 | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T21 | issuer = counterparty              | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| T22 | blank print mode                   | rules ONLY    | the blank's data (plan О-Ф) maps every field of a planned shift, with  |
| T23 | blank verification                 | rules ONLY    | the blank's data (plan О-Ф) maps every field of a planned shift, with  |
| T24 | blank reprocess flag               | rules ONLY    | the blank's data (plan О-Ф) maps every field of a planned shift, with  |
| T25 | blank clock                        | brief + rules | the forms' inputs from the host's rows (plan О-Ф) draws the blank of a |
| R1  | box zone                           | brief + rules | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| R2  | pallet zone                        | brief + rules | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| R3  | placard format                     | brief tests   | printed forms parity with the cloud (plan О-Ф) placard-a5-disassembled |
| R4  | placards format                    | brief tests   | printed forms parity with the cloud (plan О-Ф) shift-placards-a5: the  |
| R5  | placards shift number              | brief tests   | printed forms parity with the cloud (plan О-Ф) shift-placards-a5: the  |
| R6  | box file name                      | rules ONLY    | the forms' files (plan О-Ф) names the box's and the blank's file, a bo |
| R7  | pallet file name                   | brief + rules | the forms' inputs from the host's rows (plan О-Ф) names each form's fi |
| R8  | placard file name paper            | brief + rules | the forms' inputs from the host's rows (plan О-Ф) names each form's fi |
| R9  | placards file name paper           | brief tests   | the forms' inputs from the host's rows (plan О-Ф) names each form's fi |
| R10 | task file name                     | rules ONLY    | the forms' files (plan О-Ф) names the box's and the blank's file, a bo |
| R11 | task clock                         | brief tests   | printed forms parity with the cloud (plan О-Ф) task-form-planned: the  |
| R12 | brief M6                           | brief tests   | the forms' inputs from the host's rows (plan О-Ф) writes times in the  |
| R13 | org zone ignored (Moscow)          | brief tests   | the forms' inputs from the host's rows (plan О-Ф) writes times in the  |
| R14 | unknown zone falls to UTC          | brief tests   | the forms' inputs from the host's rows (plan О-Ф) writes times in the  |
| R15 | pallet kind                        | brief tests   | printed forms parity with the cloud (plan О-Ф) pallet-report-closed: t |
| R16 | box codes dropped                  | brief tests   | printed forms parity with the cloud (plan О-Ф) box-closed: the office  |
| R17 | open box refused                   | brief tests   | printed forms parity with the cloud (plan О-Ф) box-open-empty: the off |

Survivors (2): **Q7** (copy the pallets array before filtering: equivalent by construction, `filter` already copies; the deep-freeze rules tests would kill an in-place `sort` of `rows.pallets`); **Q8** (`localeCompare` instead of code-unit order in `byText`): equivalent for the inputs the host can hold (ISO instants of one fixed width and lower-case hyphenated UUIDs, forced by the host's validation), so no test can kill it without a hostile input. Initially surviving, killed after I added a test: **K4**, **Q9**, **T19** (rows above); plus B6, P7, H3, Q5, T6, T8, T22-T24, R6, R10 which the brief's tests do not bind (killed only by `form-data-rules.test.ts`).

Mutants one-line each were applied to: SSCC machine form (M1, S2), org (O1, O2), lifecycle (L1-L3), `at` (A1), box (B1-B9), pallet (P1-P7), `hasPlacard` (H1-H3), placard (K1-K8), placard set order/filter (Q1-Q9, N1-N3), blank (T1-T25), renderer (R1-R17).

## Files changed

- `apps/standalone/src/office/forms/form-data.ts` (new, brief)
- `apps/standalone/src/office/forms/render-form.ts` (new, brief)
- `apps/standalone/test/form-data.test.ts` (new, brief)
- `apps/standalone/test/forms-parity.test.ts` (new, brief)
- `apps/standalone/test/form-data-rules.test.ts` (new, beyond the brief)

## Self-review / concerns

1. **The blank's "Сформирован" time is always Moscow time.** `formatGeneratedAt` in the domain hard-codes `Europe/Moscow` and `renderShiftTaskFormHtml(data)` takes no zone; the cloud's bytes are the same, so parity forces it. For an organization in another zone (e.g. Vladivostok) the blank prints the generation time in Moscow time. Not changeable here (domain is out of scope and the golden pins it); flag to the owner. The box/pallet forms use the organization's zone as required.
2. **File names use the host's bare SSCC text** (`Состав короба <sscc>.html`, as the brief). The host stores SSCCs as 18 digits, but the Zod schema reads them as plain text (for the form to say what is wrong), so a device-supplied SSCC with `/` or `\\` would reach a file name. Task 5's `open_office_file`/`office-files` must validate or sanitize file names (its brief says it opens only `.html` from the office folder); this task does not sanitize because the brief pins the exact names.
3. **R14 (unknown zone falls back to UTC instead of the PC's zone) is killed only when the machine running the test is not in UTC** (the brief's test compares with `Intl...resolvedOptions().timeZone`, which is `UTC` on a UTC machine). On a UTC CI runner that mutant would survive; the real behaviour (PC zone) is still asserted but not distinguishable from UTC there. Not fixed (would need `process.env.TZ` control in the test).
4. The order of the shift's placards is compared as text (`closedAt` ISO strings, then id); equal to the cloud for the canonical device instants the host stores. Pinned to the millisecond (Q5) and for ties in both host orders (Q2, Q3, Q6).
5. Counts differ from the plan: golden 12 runs (not 10); the plan's "19 tests" is 21 for the brief's two files; mine +19.
6. Full-package Vitest: 4 timeouts in `template-editor.test.tsx` at the default 5 s under load (97/97 alone at 60 s); the gate was left at the default; no green full run at the default limit.
