# А4 Task 7 report — A4 page mode on the Windows driver path

Status: DONE_WITH_CONCERNS (the concerns are verification limits: nothing Windows ran). Commit `341166479` feat(standalone): A4 pages on the Windows driver path — DMPAPER_A4, whole-number scale, the printable area checked before sending (plan А4, task 7), branch claude/prt (base 0adf58faf).

## What was done

- `src-tauri/src/printer/sheet.rs` (new, pure, any host): `Orientation`, `SheetRaster`, `DeviceCaps`, `DrawPlan`, `SheetError` (`NotA4` -> `invalid_artifact`, `GeometryMismatch` -> `geometry_mismatch`), `sheet_orientation`, `sheet_draw_plan` as in the brief, plus `From<&Raster>` / `From<Caps>`, host-side values `DMPAPER_A4=9`, `DMORIENT_*`, `DMDUP_SIMPLEX=1` and `Orientation::devmode()`, and test-only page builders (`blank_page_bytes`, `a4_page_bytes`). `pub mod sheet;` in `printer.rs`.
- `printer/driver.rs`:
  - `Paper` {Label, A4}, `Request` {Label, Sheet(Orientation)}; `paper_of` (absent = label, exactly `"a4"` = sheet, any other word refused, not echoed); `request_of` (a sheet page must be a 300 dpi A4 page; orientation from the header).
  - Pure, host-tested seams for what `native` needs: `mode_holds` (merged DEVMODE kept orientation, copies 1, scale 100 and for a sheet DMPAPER_A4 and simplex when `DM_DUPLEX` is set), `plan_of` (label: the old `check_geometry`; sheet: `sheet_draw_plan`), `devmode_fits`, `sheet_blit_ok` (`> 0`), `sheet_blit_detail`.
  - `print` / `print_logged` take `paper: Option<String>`. Order of refusals: paper word, artifact, page decode, sheet-is-A4, queue, document name (all `before_start`, `invalid_artifact` for the first four after the artifact).
  - `native::Device::open(name, page, request, log)`: label branch is byte-for-byte the old DEVMODE setup. Sheet branch drops FORMNAME/PAPERWIDTH/PAPERLENGTH, sets ORIENTATION|PAPERSIZE|COPIES|SCALE|DUPLEX, `dmPaperSize = DMPAPER_A4`, copies 1, scale 100, simplex; post-merge `dmSize`/`dmDriverExtra` check (sheet only, cloud parity); `mode_holds` replaces the inline mode check for both; after `CreateDCW` the `Device` is built BEFORE the plan check so every refusal still runs `DeleteDC`; the plan is stored in `Device.plan`.
  - `draw`: sheet plan present -> `SetStretchBltMode(COLORONCOLOR)` then `StretchDIBits(dc, plan.x, plan.y, plan.width, plan.height, 0, 0, w, h, ...)`; a result `<= 0` is a failure after `StartDocW` (already `delivery_unknown`, abort, no resend). Label draw untouched.
  - Compile-time asserts in `native` that the host-side DEVMODE values equal `windows-sys`'s.
  - Diagnostics (stderr, numbers and call names only, nothing of the label/queue/document/paper word): `step=paper reason=unknown_paper`, `step=paper reason=not_a4 page_dpi= page_dots= page_mm=`, `step=DEVMODE.size.merged`, `step=SetStretchBltMode`, `step=StretchDIBits returned= expected>0 scale= at= blit=`, and the existing `step=geometry` line now also carries `request=label|a4_portrait|a4_landscape` and `mode_duplex=`.
- `driver_commands.rs`: `print_windows_raster(queue, payloadBase64, documentName, paper: Option<String>)`; registration unchanged. (There is no preflight command in the ДРВ code, so nothing to extend.)
- `src/hardware/hardware.ts`: `printWindowsRaster(queue, bytes, documentName, paper?: "a4")`; `paper` is put into the `invoke` arguments only when given (no `paper: undefined` key). The 30 s `DRIVER_WAIT`, the webview 20 s limit, `sending`-before-transport and never-auto-resend are untouched (no change in print-runtime; Task 8 will pass `"a4"`).
- `Cargo.toml`: not changed (`Win32_Graphics_Gdi` already enabled; the probe compiles every name used). No lockfile/manifest change.

## Anchor adaptations

- The brief names `test/hardware.test.ts`; the bridge's tests are in `test/windows-printing.test.ts` (`createTauriWindowsPrinting`), used there. Method name is `printWindowsRaster` (not `printDriverRaster`).
- The driver module is `printer/driver.rs` (+ `driver_commands.rs`); `open_page`/`preflight_page` of the cloud do not exist here: the standalone `Device::open` got a `Request` parameter, and `print` got `paper`.
- `DMDUP_SIMPLEX` is already `i16` in windows-sys (clippy `unnecessary_cast` on the probe); no cast.
- The brief's `native` pre-merge DEVMODE size check was inlined; it is now `devmode_fits` (same condition, host-testable). Label behaviour unchanged.
- Brief said "if the sheet check fails return the SheetError code"; the early NotA4 check runs in `print_logged` (before the queue is opened), the `GeometryMismatch` one after `GetDeviceCaps`.
- Removed my own extra "bounds inside the raster" clause from `sheet_draw_plan` after analysis showed it is redundant with the guard comparisons (an equivalent-mutant factory); documented in a comment.

## RED / GREEN

- RED: `sheet_orientation`/`sheet_draw_plan` stubbed with `todo!()`: `cargo test ... --lib printer::sheet` = 5 failed, 0 passed (`/tmp/claude/impl-a4-t7/red.txt`). GREEN with the brief's code: 5 passed; then extended to 20 sheet tests.
- Focused: `--lib printer::` 118 passed (was 75 at ДРВ final fix + sheet 20 + driver ~23 new/changed); `--test ipc driver_printing` 2 passed (new `driver_printing_takes_the_paper_of_a_sheet`); `windows-printing.test.ts` 48 passed, stderr empty.
- Full Vitest `exec vitest run --testTimeout=60000 --hookTimeout=60000`: 163 files / 4975 tests passed (task 6: 4973; +2), stderr 0 bytes.
- ONE final `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed): 73 result lines, 1253 passed, 0 failed, 0 ignored, 0 warnings (ДРВ final: 1166).
- Parity: Rust `--test hardware_shapes` 1 passed; TS `hardware.test.ts`/`windows-printing.test.ts` pass in the full run (fixture untouched; no new wire shapes, only a request argument).
- typecheck 0, lint 0, webview build 0, `cargo fmt --check` 0, `cargo check --workspace --all-targets` 0 warnings, `cargo clippy -p markiro-standalone --lib --tests` clean for the changed files, `git diff --check` clean, `grep '\u04'` only `pairing-code.ts:66`, prettier gate live (mis-formatted scratch -> exit 1, deleted; changed TS pass), tree clean after the commit.

## Windows code: probe crate

`/tmp/claude/prt-probe` includes `raster.rs`, `sheet.rs`, `driver.rs` of the worktree by path (windows-sys 0.61.2 with the manifest's features).

- `cargo clippy --offline --locked --tests --target x86_64-pc-windows-msvc -- -D warnings`: clean; `cargo check --tests` for the same target: clean, 0 warnings. The first clippy run found two `unnecessary_cast` on `DMDUP_SIMPLEX` (proof the check is live); fixed.
- Planted-error proof: `SetStretchBltMode(self.dc, "x")` in `native` -> probe fails (`E0308 expected i32, found &str`); restored (sha256 `1296ff4c...` equal, `cmp` same, touched); probe clean again.

## Unsafe review (line by line, new code)

- DEVMODE buffer is `Vec<u64>` (8-aligned), `needed >= size_of::<DEVMODEW>()` (220) and `<= 1 MiB` before any field access, so every field read/write (`dmFields`, `Anonymous1.Anonymous1.{dmOrientation,dmPaperSize,dmCopies,dmScale}`, `dmDuplex`, `dmSize`, `dmDriverExtra`) is inside the buffer. The merge goes to a clone (`output`), so the private tail is preserved. Post-merge size check for the sheet; the label path reads the same in-bounds fields as before.
- `dmFields & DM_DUPLEX != 0` : `&` binds tighter than `!=` in Rust; `then_some` reads `dmDuplex` eagerly, which is in bounds and only used when the flag is set.
- `dmOrientation`/`dmPaperSize` i16 and `dmDuplex` i16 take `i16` values; constants checked at compile time against the host values.
- Strings: no new UTF-16 (queue name `wide()` as before, NUL-terminated, interior NUL refused earlier).
- `StretchDIBits`: same `Info` (40-byte header + 2 RGBQUAD, top-down) and `dib_pixels` buffer (DWORD rows, `stride * height`); the source rectangle is the whole raster (`0,0,w,h`) so source reads stay inside; negative destination origin is intended (`-offset`) and clipped by the device; `plan.width/height` <= 3508 * 4 so no i32 overflow. Result `> 0` is the only success.
- `SetStretchBltMode` is called after `StartPage` (the brief's and the cloud's place); a 0 result is a failed step after `StartDocW` (abort, `delivery_unknown`).
- `Device` is built right after `CreateDCW` and before the plan check, so `DeleteDC` still runs on a `geometry_mismatch` (the first draft would have leaked the DC).
- Bounds on the raster: header sides 10..300 mm and dpi 203/300 (decoder); A4 at 300 dpi = 1 087 544 bytes < `MAX_BYTES` (2 MiB), pinned by tests; `width*height` cannot overflow (decoder: u32 product of <= 3543 x 3543; sheet: exactly 2480 x 3508). Scale <= 4.

## Mutants (one-line, scripts `/tmp/claude/impl-a4-t7/mut.py`, `mut2.py`, `tsmut.py`; originals in `orig/`; every restore: sha256 equal + `cmp` + file touched, "restore True" in `mut.log`)

| Guard / mutant                                                                                                | Killed by                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S1 dpi `!= 300` -> `< 300`                                                                                    | the_dots_of_a_sheet_and_its_resolution_must_be_a4_at_300_dpi                                      |
| S2 `near` tolerance 0.01 -> 0.1                                                                               | the_millimetres_of_a_sheet_are_a4_within_a_hundredth                                              |
| S3/S3b width or height dots check -> false                                                                    | the_dots_of_a_sheet...                                                                            |
| S4 portrait returns Landscape                                                                                 | 11 tests                                                                                          |
| S5 accept 2400 dpi                                                                                            | a_sheet_is_drawn_whole_number_times_at_300_600_and_1200_dpi                                       |
| S6 `dpi_y != dpi_x` dropped                                                                                   | a_device_that_reports_nonsense..., letter_paper_unequal...                                        |
| S7/S7b offset_x / offset_y `< 0` dropped                                                                      | a_device_that_reports_nonsense...                                                                 |
| S8 `offset+printable > width` -> `>=` / S8b y axis dropped                                                    | a_device_that_reports_nonsense..., the_origin...                                                  |
| S9 mm check `                                                                                                 |                                                                                                   | `->`&&`; S9b height 0.5 -> 1.0; S9c portrait mm swapped | the_device_page_is_a4_within_half_a_millimetre_on_each_axis, 9 more |
| S10 scale `/300` -> `/600`                                                                                    | 8 tests                                                                                           |
| S11 guard `ceil` -> `floor`                                                                                   | the_guard_follows_the_resolution (300 dpi: floor accepts sheet dot 25)                            |
| S12 guard 0.5 mm -> 0.4 mm; S13 guard constant 12                                                             | the_guard_follows_the_resolution, the_required_area_keeps...                                      |
| S14 bounds not multiplied by scale                                                                            | an_empty_or_leaving..., the_guard_follows...                                                      |
| S15a-d each of the 4 edge comparisons `<`/`>` -> `<=`/`>=`                                                    | the_required_area_keeps_half_a_millimetre... (exact boundary), the_guard_follows...               |
| S17/S17b `right <= left` / `bottom <= top` dropped                                                            | an_empty_or_leaving_required_area_is_no_sheet                                                     |
| S18a-d plan x sign / y source / width / height not scaled                                                     | portrait, landscape, whole-number-times, origin tests                                             |
| S19a-c DMPAPER_A4 9->8, landscape devmode value, DMDUP_SIMPLEX 1->2                                           | the_devmode_values_are_the_windows_ones, a_sheet_keeps_a4...                                      |
| S20a/b `From<&Raster>` width/height swapped, `From<Caps>` offsets swapped                                     | the_checked_page_and_the_driver_caps_become_sheet_inputs_field_by_field                           |
| S21 `GeometryMismatch` code -> `invalid_artifact`                                                             | the_failure_codes_are_the_driver_paths                                                            |
| D1 paper `"A4"` accepted                                                                                      | the_paper_is_absent_for_a_label_or_exactly_a4, an_unknown_paper...                                |
| D2 unknown word reads as label                                                                                | same                                                                                              |
| D3 request always Portrait; D4 sheet check skipped                                                            | a_sheet_page_must_be_a_300_dpi_a4_page..., a_page_that_is_not_a4_never_reaches_a_queue_as_a_sheet |
| D5a sheet orientation always portrait                                                                         | a_sheet_keeps_a4...                                                                               |
| D5b copies / D5c scale rule dropped                                                                           | a_label_keeps..., a_sheet_keeps...                                                                |
| D5d A4 paper rule dropped; D5e duplex unset refused (`is_some_and`); D5f duplex compare inverted              | a_sheet_keeps_a4...                                                                               |
| D5g sheet's paper rule applied to the label                                                                   | a_label_keeps_what_it_asked_of_the_driver_and_only_that                                           |
| D6a label uses sheet plan; D6b label refusal code; D6c sheet uses label check; D6d sheet refusal code mapping | the_plan_of_a_label_is_the_labels_geometry_check_and_of_a_sheet...                                |
| D7a/b/c `devmode_fits` `>=`/`<=` boundaries, extra ignored                                                    | a_driver_devmode_must_claim_a_size_that_fits_its_buffer                                           |
| D8a blit `> 0` -> `>= 0`; D8b detail x/y swapped                                                              | a_sheet_blit_is_a_positive_number_of_scan_lines                                                   |
| D9a paper/request checked after the queue; D9b paper parsed after the artifact                                | an_unknown_paper..., a_page_that_is_not_a4...                                                     |
| D10/D10b paper refusal code or its line dropped                                                               | same                                                                                              |
| D11 `print_logged` ignores the paper                                                                          | a_page_that_is_not_a4_never_reaches_a_queue_as_a_sheet                                            |
| D12a-c geometry line `request=` key, `a4_landscape` name, duplex `none`                                       | the_geometry_line_sets_the_page_against..., the_request_names...                                  |
| D14 unknown-paper line empty                                                                                  | an_unknown_paper..., the_paper_is_absent...                                                       |
| D15/D15b not_a4 line width/height swapped (survived the square fixture; killed after adding the A5 case)      | a_sheet_page_must_be_a_300_dpi_a4_page...                                                         |
| C1 command drops `paper`                                                                                      | ipc `driver_printing_takes_the_paper_of_a_sheet`                                                  |
| T1 `paper` key always sent (undefined); T2 constant `"a4"`; T3 never sent; T5 argument ignored                | windows-printing "asks the driver for an A4 page only when told"                                  |

Survivors, equivalent by construction: S7c `c.width <= 0` and S7d `c.printable_width <= 0` (both implied by the 0.5 mm page check and the guard comparisons; kept as the brief's defence in depth), T4 (`{ paper: "a4" as const }` — `"a4"` is the only value of the type). D6c first draft did not compile (type error) and was rerun in a compiling form (killed).

Not mutable on the host (Windows-only, probe crate only): the DEVMODE field assignments in `native::Device::open` (Sheet arm), `SetStretchBltMode`/`StretchDIBits` calls, `DeleteDC` ordering, `last_error()` capture.

## Test totals (plan vs measured)

The brief fixed no totals. Measured: sheet.rs 20 tests (5 from the brief), driver.rs +17 new tests and 6 adapted, ipc +1, windows-printing +2; Vitest 4975 (+2 vs task 6); cargo workspace 1253.

## Not verified (all of it is Windows/hardware)

- `mod native` never ran: no `DocumentPropertiesW` with `DMPAPER_A4`/orientation/duplex on a real driver, no `CreateDCW`, no `GetDeviceCaps` for a landscape DC (the code assumes GDI reports PHYSICALWIDTH/HEIGHT in the DEVMODE's orientation, and that `HORZRES`/`PHYSICALOFFSETX` give the printable area in device pixels), no `StretchDIBits` scaling with COLORONCOLOR on a real laser driver, no real A4 print or measurement of margins/scale; whether a driver keeps `StartPage` attributes (the stretch mode is set after `StartPage`, as in the cloud) is unknown.
- Which of the new stderr lines a real failure produces, and that `GetLastError` still holds the code when read, is Windows-only.
- Fonts, WebView2, the whole Task 8 flow (profile paper, work screen, test print) are out of this task.
- `cargo test` host runs prove the pure arithmetic and the fake-driver call order only. No Windows CI job was available to run.

## Concerns

1. Nothing in `native` has run (see above); the probe is type-level only.
2. The sheet blit success test is `> 0` (brief/cloud). For the label path the repo uses `== h`; for a scaled blit the return value's exact meaning on printer drivers is unverified, and a driver that returns 0 for a successful scaled blit would make every sheet end `delivery_unknown` (the manual Windows check must watch for that line).
3. `sheet_draw_plan` refuses a sheet with an empty required area (`[0,0,0,0]`) as `geometry_mismatch`; Task 8's renderer must always give real bounds.
4. The queue is still freed at 30 s while a Win32 call may run on (ДРВ M3): an A4 sheet is far larger (1 MB spool) so a slow driver makes that more likely.
5. `graphify update .` not run (no graph in this worktree).
