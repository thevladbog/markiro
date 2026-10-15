# ДРВ Task 4 report — printer profile with a printing mode; the driver page render

Status: DONE_WITH_CONCERNS (concerns minor, below). Commit: `8ced48d64` feat(standalone): a printer profile prints RAW or through the Windows driver, which gets a mono-raster page (plan ДРВ task 4), branch `claude/prt` (base 1b099398d). Webview/TS only: no Rust, fixtures, manifests or lockfile touched, so no cargo run and no parity tests were required.

## What was done

- `workstation-settings.ts`: `PRINTER_MODES`, `PrinterMode`, `PrinterProfile.mode?`, `printerMode()`; `parsePrinterProfile` reads `mode`: absent -> no field (legacy = RAW, nothing invented), unknown/`null` -> profile refused, `windows_driver` only with a `usb` (Windows queue) target.
- Boundaries: parse on read (`readWorkstationSettings` drops a bad profile and unassigns its purposes), write (`saveWorkstationSettings` already validates by `readsBack(parsePrinters)` -> `InvalidSettingsError`; now covers the mode), form (`profileOf` writes `mode` only for a usb kind in driver mode, RAW = no key), job snapshot (`print-jobs.ts` `toJob` parses the stored printer through the same `parsePrinterProfile`, unchanged). The profile never crosses the host (no proto/Zod host shape).
- `printer-draft.ts` replaced as in the brief (`mode` in `PrinterDraft`, `NEW_PRINTER`, `draftOf`, `profileOf`).
- `rasterizer.ts`: strict `rasterizeDriverText`. `label-emitters.ts`: exports `renderMonoLabel`, `encodeMonoRaster`. `label-render.ts`: `LabelPrinter.mode?`, driver branch (`renderMonoLabel` + `encodeMonoRaster` at `withPrinterDpi`), RAW path unchanged (`rasterize` param now optional; defaults applied inside). `printer-format.ts` new; `ru.json` key `floor.setup.printers.formats.windowsDriver`.

## RED / GREEN

- RED: `vitest run test/printer-driver-profile.test.ts` -> failed to resolve `printer-format.js` (`/tmp/claude/impl-drv-t4/red.log`).
- GREEN: 18 tests pass (brief had 9; +9 added).
- Final gates: typecheck 0, lint 0, build 0; prettier gate live (scratch mis-formatted file -> exit 1, deleted; the 8 changed files pass); `git diff --check` clean; `grep '\u04'` only `src/host/pairing-code.ts:66`; `git status --short` empty after commit.
- Focused verbose (printer-driver-profile, floor-label-render, floor-setup, floor-print-jobs, label-raster): 5 files / 171 tests passed, stderr 0 bytes.
- Full Vitest: 150 files / 4671 tests: 4652 passed, 19 failed ONLY by 5 s timeouts in `template-editor`, `shifts-page`, `shift-dialog` (the `pnpm test -- --testTimeout` flags did not reach vitest; load). Re-run of those three files alone with `--testTimeout=60000 --hookTimeout=60000`: 3 files / 187 tests passed, stderr 0. So effectively all 4671 pass. (Task 3 had 149 files / 4653 tests; +1 file, +18 tests = this file.)

## Mutants (scratch one-line; `/tmp/claude/impl-drv-t4/mutate.py`, log `mut.log`; originals in `/tmp/claude/impl-drv-t4/orig/`; each restore sha256- and `cmp`-verified, files touched) — 27 mutants, 27 killed

All killed by `test/printer-driver-profile.test.ts` (test name shortened):

| #   | Guard                                  | Mutant                                  | Killed by                                                                                                        |
| --- | -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0   | unknown mode refused                   | `if (false) return null`                | "only for a Windows queue, and nothing this build does not know"                                                 |
| 1   | driver only for usb                    | `kind === "tcp"` instead of `!== "usb"` | same (serial case added by me)                                                                                   |
| 2   | driver only for usb                    | check dropped                           | same                                                                                                             |
| 3   | RAW is not invented                    | `mode: mode ?? "raw"`                   | "RAW for every profile stored before it existed"                                                                 |
| 4   | mode kept on read                      | spread dropped                          | same                                                                                                             |
| 5   | `printerMode` default                  | `?? "windows_driver"`                   | same                                                                                                             |
| 6   | form: driver only for usb              | `kind === "usb"` dropped                | "writes the driver only for a Windows queue"                                                                     |
| 7   | form: RAW writes no key                | driver = `kind === "usb"`               | same                                                                                                             |
| 8   | form: RAW = no field                   | `mode: "raw"` always written            | same                                                                                                             |
| 9   | `draftOf` reads mode                   | `"raw"`                                 | "opens a stored profile with its way of printing"                                                                |
| 10  | `NEW_PRINTER.mode` raw                 | `"windows_driver"`                      | same                                                                                                             |
| 11  | strict rasterizer: no `document.fonts` | falls back to drawing                   | "refuses without document.fonts, though the canvas would draw" (canvas faked so the refusal is not the canvas's) |
| 12  | face loaded nothing                    | `loaded.length` check dropped           | "refuses a face that loaded nothing"                                                                             |
| 13  | face not usable                        | `check` dropped                         | "draws a text once its face is loaded..." (check called) + "not usable"                                          |
| 14  | empty text sample                      | `sample = text`                         | same (load/check called with "Аа")                                                                               |
| 15  | load failure fails label               | `.catch(() => [{}])`                    | "lets a failed face load fail the label"                                                                         |
| 16  | driver branch                          | `if (false)`                            | "mono-raster-v1 page of the template at the printer's resolution"                                                |
| 17  | RAW stays RAW                          | branch for `mode !== "raw"`/all         | "leaves a RAW printer on the printer's language"                                                                 |
| 18  | driver default rasterizer is strict    | `?? rasterizeText`                      | "what a driver label draws its text with unless told otherwise"                                                  |
| 19  | given rasterizer used (driver)         | always `rasterizeDriverText`            | mono-raster test (`rasterize` called with the text)                                                              |
| 20  | page at printer dpi                    | `spec` instead of `printSpec`           | mono-raster test (decoded dpi 203/300)                                                                           |
| 21  | given rasterizer used (RAW)            | ignored                                 | RAW-unchanged test                                                                                               |
| 22  | RAW default is not strict              | `?? rasterizeDriverText`                | "unless told otherwise, and RAW is not so strict"                                                                |
| 23  | RAW TSPL path                          | `=== "zpl"`                             | RAW-unchanged test                                                                                               |
| 24  | format text                            | condition inverted                      | "printer's format in words"                                                                                      |
| 25  | format text                            | `toUpperCase` dropped                   | same                                                                                                             |
| 26  | i18n words                             | text changed                            | same                                                                                                             |

Save-time rejection (new guard via `readsBack`) is covered by "refused when written for anything but a Windows queue, or unknown" (killed by mutants 0-2 too, together with the parse test).

## Anchor adaptations

- The brief's test uses SSCC `046006820000035007` with the domain's stock box template; `renderMonoLabel` draws the SSCC as GS1-128 and bwip-js rejects it (`AI 00: Bad checksum`, first GREEN run failed). The old `floor-label-render` tests use the same SSCC only with the shift snapshot's TSPL template. Test data defect, mechanical: used `046006820000035008` (valid check digit) as `VALID_SSCC`.
- All other anchors matched exactly once; `printer-draft.ts` whole-file replacement was extracted from the brief and the diff against the old file is the expected 14 lines.
- No cast needed for `i18n.t.bind(i18n)` (typechecks).

## Tests beyond the brief

Serial (COM) driver profile refused; save refusal of driver-on-TCP/unknown/null with storage unchanged; reading a stored profile with an unknown mode drops it and unassigns its purposes; COM draft keeps no mode key; RAW path (zpl, explicit `mode:"raw"`, tspl) unchanged, driver profile ignores its stored `language`; the driver rasterizer's four refusals + success + empty-text sample + load failure; default rasterizer choice per mode.

## Self-review / concerns

- The delayed-`setImmediate` stand was not run: the new test file has no React/effects; none of the changed behaviour is effect-driven.
- `printerFormatText` and `renderLabel`'s driver branch are not yet used by screens/print-jobs (Tasks 5-6): `print-jobs.ts` passes the parsed profile (with `mode`) to `renderLabel`, so jobs for a driver profile will already render a page; sending it is Task 5.
- The jsdom test of `rasterizeDriverText` success uses a faked canvas/`document.fonts`; real IBM Plex loading in WebView2 is not verified here.
- `graphify update .` not run.
