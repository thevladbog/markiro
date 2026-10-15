# А4 — final fix wave report

Worktree `/tmp/claude/wt/prt`, branch `claude/prt`, base `6801b17fc`. Source: `a4-final-review-report.md`.
I3 (warehouse reprint × A4/logo) was NOT done: it belongs to the controller's integration merge.
The plan's «Отклонения при исполнении» were not written (the controller writes them).

## Commits (5)

| SHA         | Subject                                                                 | Review items                                                         |
| ----------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `0bde8ef5d` | fix(standalone): driver labels of a shift keep the bundled face         | I1                                                                   |
| `e40a9a141` | feat(standalone): a planned shift can go back to the main A4 sheet      | I2 (+ AGENTS line)                                                   |
| `8db996c1f` | fix(standalone): A4 polish — resolution scale, logo pixel cap, «паллет» | M1, M3 (comment + cap), M4, M8 (office hint)                         |
| `66d042c67` | docs(standalone): A4 runbook and §29 — logo checks, main sheet, limits  | M11, M8, M9, M2, M3 (doc), M4 in docs                                |
| `f82ba4b0f` | fix(standalone): only a limited logo picture waits for its load event   | fixes a hang that commit 3 introduced (found by the full Vitest run) |

Each commit ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked).
`git diff --check 6801b17fc..HEAD` is clean. `git status --short` is empty at the end. 27 files, +756/−94.

## What changed

### I1: driver labels keep the bundled face (`src/floor/print/shift-render.ts`)

`shiftLabelRender` no longer sets `deps.rasterize ?? rasterizeText`. It passes `deps.rasterize` to
`renderLabel` unchanged, so `renderLabel` picks `rasterizeDriverText` for `windows_driver` and
`rasterizeText` for RAW. The unused import is gone, and the `ShiftRenderDeps.rasterize` doc says
what happens when it is left out.
New `test/shift-render-face.test.ts` replaces the app's rasterizers with `vi.fn` spies through
`vi.mock(... importOriginal)` and checks four things:

- a driver page reaches only `rasterizeDriverText`;
- a driver page is refused (`RasterUnavailableError`) when that rasterizer refuses;
- a RAW label reaches only `rasterizeText`;
- a caller's rasterizer reaches both paths unchanged.

### I2: `ShiftUpdate.palletSheetTemplateId` can be `null` = main sheet

- **proto:** `Option<Option<String>>` with the existing `nullable` helper (as `counterparty_id`); the doc explains the three states.
- **host `update_shift`:**
  - `Some(Some(id))` names a sheet. On a planned shift it is checked when it changes.
  - `None` keeps the current sheet while pallets stay on, and takes the main sheet when pallets have just been turned on.
  - `Some(None)` (explicit `null`) = `default_sheet(&mut tx)`. It is read inside the edit's transaction, so it means "the main sheet at THIS edit"; none if there is no main sheet. It needs no check because `default_sheet` only returns an enabled sheet.
  - Without pallets, a named sheet is still refused (`validation_failed`) and `null` passes and asks for nothing.
  - On an open shift, `null` goes through `fixed_changed`: OK when it resolves to the sheet the shift already holds, `shift_status` conflict otherwise.
  - The resolved id is stored in `shifts.pallet_sheet_template_id`, and the opening freezes it into the snapshot as before. A later change of the main sheet does not reach the planned shift.
  - The audit row is the usual `update_details` `{from, to}`. A no-op `null` gives no revision and no audit row. The fn doc says all this.
- **Zod:** `shiftUpdateSchema.palletSheetTemplateId: z.uuid().nullable().optional()` (strict); doc updated.
- **requests.ts:**
  - `ShiftPallets.sheetId?: string | null`.
  - `shiftCreate` leaves the field out for `null` and `undefined`.
  - `shiftUpdate` sends `null` only from a shift that holds a sheet of its own. A shift with pallets and no sheet sends nothing; pallets just turned on leave the field out, so the host gives the main sheet.
- **shift-form.ts:** «Основной лист» (`""`) becomes `sheetId: null`.
- **sheet-options.ts:** «Основной лист организации» is always offered; doc rewritten.
- **New fixture** `proto/fixtures/shift-update-main-sheet.json` `{palletSheetTemplateId: null, expectedRev: 72}`. Both parity tests read it:
  - Rust `a_shift_update_sends_the_main_sheet_as_null`;
  - TS: the parity table, plus the builder producing exactly the fixture.
- **Host tests:**
  - `a_planned_shift_goes_back_to_the_main_sheet_with_null`:
    - `null` without a main sheet gives no sheet;
    - `null` with a main sheet gives that sheet; stored value and exact audit rows checked for both;
    - `null` again: no revision, no audit;
    - a later change of the main sheet does not reach the shift;
    - an edit without the key keeps the sheet;
    - a shift that had no sheet takes the current main sheet;
    - pallets turned on with `null` take the main sheet.
  - `null_without_pallets_asks_for_nothing_and_an_open_shift_keeps_its_sheet`:
    - no pallets: `null` is a no-op (no rev, no audit);
    - `palletsEnabled:false` + `null` clears;
    - an open shift takes `null` together with its plan when the main sheet is the one it holds;
    - `shift_status` 409 once the main sheet differs, and the revision is unchanged.
  - `device_shifts::the_main_sheet_a_planned_shift_went_back_to_is_the_one_its_entry_freezes`: the entry freezes the main sheet of the edit, not of the opening.
- **Office tests:**
  - `sheet-options`: «main» is offered to a shift that holds a sheet, and also while the list loads.
  - `shift-form`: `""` gives `null`, create omits it, a sheeted shift sends `null`, a bare shift sends nothing.
  - `shift-edit`: the dialog lists «main» first for a sheeted shift, and choosing it sends `{palletSheetTemplateId: null, expectedRev: 72}`; option counts updated.
- **AGENTS:** the shifts paragraph describes the `null` semantics.

### M1: resolution (`src-tauri/src/printer/sheet.rs`)

I went with the report's recommendation and also made the arithmetic itself refuse other
resolutions, as asked. The scale now comes from a `match c.dpi_x { 300 => 1, 600 => 2, 1200 => 4, _ => return Err(GeometryMismatch) }`.
This replaces the separate whitelist plus `c.dpi_x / 300` integer division, so 360/450 dpi can
never silently print at 83 %/67 %. The refusal list in the test now has 150, 203, 299, 301, **360**,
400, **450**, **900**, 1201, **1800**, 2400.

### M3: decompression bomb (`src/labels/logo.ts`)

- The `MAX_LOGO_FILE_BYTES` comment now says the cap bounds the FILE, not the decoded size.
- New `MAX_LOGO_SOURCE_PIXELS = 8192 × 4096` (128 MiB as RGBA).
- `decodeLogoImage(src, scale, maxSourcePixels = +∞)`: with a finite limit it waits for `load`/`error`, reads `naturalWidth × naturalHeight`, and throws `too_many_pixels` BEFORE `decode()` and before any canvas exists. Then `decode()` runs, then the empty-size check.
- `decodeLogoFile` passes the limit for PNG/JPEG/WebP and `+∞` for SVG, whose declared size is not counted because it is drawn at logo size.
- New `LogoDecodeFailure` code `too_many_pixels` with ru.json wording, plus a row in the org-logo-card error table.
- Tests use a fake `Image` with `onload`/`onerror`/"never".
- Commit 5 correction: the first version waited for `load` on EVERY picture, and the full Vitest run hung `floor-work-print` «no logo can be had» because jsdom never fires `load`. Unlimited decodes (the bundled logo, SVG) now go straight to `decode()` as before, and a test pins that an unlimited decode settles when `load` never fires.

### M4/M8 in UI

- «палет» → «паллет» in the 9 ru.json occurrences (`paperHint`, a4 test product, logo intro, `palletSheetHint`, `palletSheets.title`/`intro` ×2, `importInvalid`, `fileTooLarge`), and in the tests that pin them (shift-dialog 2, a4-test 1, pallet-sheets-page 5).
- The stock sheet names «Палета А4 · …» come from `@markiro/domain` presets (cloud parity, not ru.json) and were left as they are; the runbook quotes them as the UI shows them.
- `palletSheetHint` gained: «Основной лист берётся на момент сохранения смены: его последующая замена смену не меняет.»

### Docs (commit 4)

- **Runbook** «Листы паллет А4»:
  - step 14: an A4 pallet printer with a shift without a sheet gives `render_failed` per pallet and no warning at entry (M9);
  - step 15: the main sheet is taken at save, and how to go back to it (M8 + I2);
  - step 16: the logo is in every snapshot, so `snapshot_too_large` is possible (M2).
- **New runbook subsection** «Логотип организации на этикетках» (M11):
  - PNG/JPEG/SVG upload in WebView2;
  - an SVG with an external `href` loads nothing;
  - a non-image and a huge-declared PNG are refused and the window stays alive;
  - the Markiro logo and the own logo on Zebra ZPL and TSC TSPL at 203/300 dpi, codes still scan;
  - removing the logo;
  - a driver label stays in IBM Plex.
- **§29:** heading spelling; main sheet at save; A4 printer + no sheet; logo in every snapshot vs the snapshot limit; the 8192 × 4096 cap.
- **AGENTS:** the logo file guards, and `shiftLabelRender` passing the rasterizer through.

## RED / GREEN evidence

| Item    | RED (before fix)                                                                                                                                                                                                                                                   | GREEN                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| I1      | `vitest run test/shift-render-face.test.ts`: 2 failed. The driver page had `rasterizeDriverText` "expected to be called at least once"; the refusal test failed with "promise resolved … instead of rejecting" (log `/tmp/claude/impl-a4-fix/i1-red.log`)          | 14/14 with shift-render.test.ts, stderr empty                                           |
| I2 Rust | The HEAD versions of `proto/src/lib.rs` + `office_shifts.rs` restored temporarily: proto fixtures failed to compile (`E0308`); host `device_shifts` `the_main_sheet_…` FAILED (left = landscape id, right = portrait). Files restored, `cmp` OK, touched (`red2/`) | proto 5+6+57+0 passed; host device_shifts 33, office_shifts 43, pallet_sheets 16 passed |
| I2 TS   | HEAD versions of protocol.ts/requests.ts/sheet-options.ts/shift-form.ts temporarily: 13 failed / 450 (`red2ts/red.log`), restored and `cmp` OK                                                                                                                     | 515/515 (protocol, shift-form, sheet-options, shift-edit, shift-dialog), stderr empty   |
| M3      | HEAD `logo.ts`: 3 new label-logo tests failed (`red3/red.log`), restored                                                                                                                                                                                           | label-logo + org-logo-card + floor-work-print 115/115                                   |
| M1      | No RED by design: the old whitelist already refused these resolutions. The change is structural; its proof is the review's surviving mutant R8 now being killed (M1a–M1c)                                                                                          | `printer::sheet` 20 passed                                                              |

## Mutant table (every restore: sha256 equal, `cmp` equal, file touched; logs `/tmp/claude/impl-a4-fix/mut/`)

| ID  | One-line mutant                                                            | Killed by                                                                    | Restore         |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------- |
| I1a | `renderLabel(..., deps.rasterize ?? rasterizeText, logo)` (the regression) | shift-render-face: driver page bundled-face only; refusal                    | 89470ffd3f22 == |
| I1b | `deps.rasterize ?? rasterizeDriverText`                                    | shift-render-face: RAW label best-effort                                     | 89470ffd3f22 == |
| H2a | `None \| Some(None) if current.pallets_enabled => current…` (null keeps)   | office_shifts both new tests, device_shifts new test                         | 71c01e4a6b20 == |
| H2b | pallets off: `if update.pallet_sheet_template_id.is_some()` (null refused) | `null_without_pallets_…`                                                     | ==              |
| H2c | `\|\| pallet_sheet_template_id != current…` → `\|\| false`                 | `an_open_shift_keeps_its_sheet_and_takes_no_other`, `null_without_pallets_…` | ==              |
| H2d | `Some(None) => None` (null clears instead of main)                         | office_shifts both new, device_shifts new                                    | ==              |
| P2a | proto field without `with = "nullable"`                                    | `a_shift_update_sends_the_main_sheet_as_null`                                | b292f865029e == |
| T2a | Zod `palletSheetTemplateId: z.uuid().optional()` (no null)                 | protocol: parity, builder bodies, refusal test                               | 7d977e7b90ff == |
| T2b | builder always sends `null`                                                | protocol pallets bodies, shift-form ×2, shift-edit pallets-on                | a3010b7de897 == |
| T2c | builder never sends `null`                                                 | protocol bodies, shift-form, shift-edit «back to main»                       | ==              |
| T2d | `if (ownId === null) options.push(main)` (old rule)                        | sheet-options ×2, shift-edit ×2                                              | f6f6012eef5b == |
| T2e | form `""` → no `sheetId` (old)                                             | shift-form ×2, shift-edit «back to main»                                     | 1177d319ef5c == |
| T2f | `shiftCreate` sends `null`                                                 | protocol pallets test, shift-form A4 test                                    | ==              |
| M1a | `600 => 2, 450 => 1,`                                                      | `a_sheet_is_drawn_whole_number_times_…` (450)                                | f957ec5c0d83 == |
| M1b | `1200 => 4, 900 => 3,`                                                     | same (900)                                                                   | ==              |
| M1c | `300 \| 360 => 1,`                                                         | same (360)                                                                   | ==              |
| M3a | cap check → `if (false)`                                                   | label-logo: over-cap refused undecoded; file over cap                        | 97920a5a18bd == |
| M3b | `>` → `>=`                                                                 | exactly-the-cap decodes                                                      | ==              |
| M3c | SVG exemption dropped                                                      | file test: SVG declared size not counted                                     | ==              |
| M3d | `decodeLogoFile` passes no limit                                           | file test: raster bomb refused                                               | ==              |
| M3e | `await image.decode();` before the cap check                               | over-cap undecoded (`calls == []`), file tests                               | ==              |
| M3f | `onerror` → `resolve()`                                                    | limited picture that does not load                                           | ==              |
| M3g | always wait for load (`if (false)` on the unlimited branch)                | unlimited decode settles when `load` never fires (timeout)                   | ==              |

23 mutants, 23 killed. The I1/I2 TS mutants were re-run on the final code of their files. The M3
mutants were re-run on the final (commit 5) `logo.ts`.

## Gates (final)

- typecheck 0, lint 0, `build` 0. The build was rebuilt after commit 5.
- Focused verbose Vitest of every new or changed file: stderr empty each time.
- Delayed-`setImmediate` stand (3 ms `setImmediate`, scratch setup + config copied into the Vite root and removed after each run):
  - I1 files 14/14;
  - I2 files 515/515;
  - commit-3 files 169/169;
  - commit-5 files 115/115.
- **Full Vitest** `exec vitest run --testTimeout=60000 --hookTimeout=60000`:
  - the first run after commit 4 had 1 failed / 5053: `floor-work-print` «no logo» timed out at 60 s. That was a real hang, fixed by commit 5.
  - Final: **169 files, 5054 passed, stderr empty**.
- `cargo fmt --check` clean.
- `cargo check -p markiro-host -p markiro-proto --all-targets` and `-p markiro-standalone --all-targets`: 0 warnings.
- Focused cargo: proto all; host `office_shifts`, `device_shifts`, `pallet_sheets`; shell `--lib printer::sheet`.
- **ONE full `cargo test --workspace --offline --locked --no-fail-fast`**, unsandboxed: rc=0, **1257 passed, 0 failed, 0 ignored, 73 test binaries**.
  - It ran after commit 4; commit 5 touched only TS.
  - The shell embedded the dist from the build before commit 5 (dist was rebuilt afterwards); no Rust test reads the logo decoder.
- Parity: Rust `proto/tests/fixtures.rs` (in the workspace run) and `test/protocol.test.ts` (in full Vitest) both pass with the new fixture.
- Prettier gate: proven live once with a deliberately mis-formatted scratch file (`[warn] … rc=1`, file deleted); every changed TS/TSX/JSON/MD file checked from the worktree root with repo-relative paths.
- `grep -rnF '\u04' src test`: only `src/host/pairing-code.ts:66`.

Counts: the review measured 293 on 13 focused files; the full suite is 5054 here. No plan counts apply to the fix wave.

## Anchor adaptations

None that matter. The report's fix-wave text was applied by meaning. M1 went further than "add 360/450/2400 to the test", as the dispatch asked: the arithmetic refuses by construction, and 2400 was already in the list.

## Self-review / concerns

1. **M3 relies on WebView2's lazy decode.** The cap assumes Chromium/WebView2 knows `naturalWidth/Height` at `load` without a full pixel decode, which is how Chromium behaves for an unattached `<img>`. This was not verified in WebView2. Runbook logo step 3 asks the owner to load a huge-declared PNG and confirm the window stays alive. Header sniffing (PNG IHDR / JPEG SOF / WebP), as the report's CARRY suggests, would remove that assumption.
2. **A pallets shift without a sheet still keeps none.** When a planned shift with pallets but no sheet of its own is edited, the form shows «Основной лист организации (X)» but sends nothing (the report's rule: `null` only from a shift that holds a sheet), so the shift keeps none even if a main sheet now exists. The office label can therefore name a main sheet the shift will not get. Choosing a named sheet works, and choosing "main" on such a shift does nothing. Possible follow-up: send `null` from every pallets shift when "main" is chosen, accepting a request on otherwise-empty edits.
3. **«main» label while loading.** With the sheet list not loaded (or failed), «main» is offered with «(не выбран)» even when the host has a main sheet. This was already true for new shifts; it now also applies to sheeted shifts.
4. **I3 not done.** The warehouse reprint seam is the controller's job at the integration merge.
5. **External checks not run.** Windows, WebView2, printers and hardware were not exercised. Everything above is host/jsdom only, so the owner checklist in the review report still applies.
