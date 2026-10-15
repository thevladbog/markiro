# Plan 1e4b, Task 2 report: label-renderer.ts

Base 3212beec4. Files: `apps/standalone/src/office/templates/label-renderer.ts`, `label-print.ts` (verbatim from the brief), `apps/standalone/test/label-renderer.test.ts` (the brief's 7 tests verbatim, one helper change, 24 extra tests).

## RED / GREEN

- RED: `vitest run test/label-renderer.test.ts` before the sources existed: exit 1, `Failed to resolve import "../src/office/templates/label-renderer.js"`, 0 tests.
- GREEN (brief's 7 tests, before extras): `--reporter=verbose`: 7 passed, stderr empty; same file under the delayed-setImmediate stand: 7 passed.
- Final: 31 passed in `--reporter=verbose` (stderr 0 bytes) and under the stand (31 passed); stand files removed, `git status` clean apart from the three new files before commit.

## Counts

- Plan/brief: label-renderer 7 tests; package 56 files / 1311 tests (1329 with Task 1's +18 shift).
- Measured: baseline 55 files / 1322 tests confirmed before starting; final 56 files / 1353 tests (1322 + 31). The brief's 1311 + 18 = 1329 plus my 24 extra tests = 1353.
- typecheck, lint, prettier --check, `git diff --check`: clean; `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.

## Deviations

- The brief's `recordingRasterizer()` got an optional `raster` parameter (default is the brief's one-dot bitmap) so the 300 dpi tests can use a two-dot bitmap. The brief's 7 tests are otherwise unchanged. Prettier reformatted nothing in them.
- Scratch note: I first created `/tmp/claude/1e4t2/` (name reused from plan 1e4 task 2) and overwrote its `red.txt`, `green.txt`, `delay.txt`, `green.err` before noticing; all my work then moved to `/tmp/claude/1e4b-t2/`. Those four old files are scratch evidence of the earlier plan only.

## The brief's 9 mutants (with the brief's `-t` filter): all KILLED, restore hash and `cmp` identical every time

| mutant                                    | killed test                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| M1 box x inset                            | paints the label white, then each element...                                    |
| M2 `column <= raster.width` -> `<`        | paints a bitmap's black dots as one rectangle per run                           |
| M3 `drawX = xPx`                          | paints the label white...                                                       |
| M4 fontFamily "IBM Plex Sans"             | asks the rasterizer what the print asks it                                      |
| M5 drop `if (cancelled()) return;`        | keeps the drawing of an element its bitmap failed for, and stops once cancelled |
| M6 drop the white cover                   | covers each element's drawing and paints its bitmap...                          |
| M7 drop `offsetDots`                      | covers each element's drawing...                                                |
| M8 drop `isStationRaster` skip            | leaves a product duplicate's code white...                                      |
| M9 drop `cancelled()` in paintCodeRasters | leaves a product duplicate's code white...                                      |

## Extra mutants (my own, 106 + 22 one-line mutants)

Run 1 (brief's 7 tests only): 41 of 106 killed, 65 SURVIVED. They were: right/center/default alignment and the no-width branch, `maxLines` default, line height and line index, the `measureText` hookup, box y/x inset and lineWidth, line end y / start y / strokeStyle, field display value (`textOf`), every matrix-code detail (white square, quiet zone, seed, density, rows/cols, ink, hash, PRNG, qr/datamatrix branches, literal vs field data, module size), every linear-code detail (width from `elementBoundsMm`, empty text, segment, jitter, cursor, bar height, white fill), the three `isStationRaster` conditions, bitmaps wider than a byte, all the dpi-dependent arithmetic (300 dpi), alignment argument and width of `rasterAlignOffsetDots`, cancel/failure ordering, the chunk-load failure and the no-load-without-raster paths, the `catch/continue` for an unencodable code, the code-filter, the code dpi.
I added 24 tests (describes: "text inside its width", "ink", "boxes and lines", "schematic codes", "which codes the station rasterizes", "the encoder's chunk", "bitmaps and the print at other resolutions") and re-ran all of them: 101 of 106 killed. A further 22 mutants (X1..X40, found while reviewing): 21 killed, 1 survived. Totals: 122 of 128 killed; 6 survive and are argued equivalent below. Restore proof for every mutant: sha256 before == after and `cmp` against the backup copy under `/tmp/claude/1e4b-t2/` (the script `mut.py` checks both; none failed; final hash 5b148abee28143b33f8b8439f5062a5f13c820de6dffbe02d5508eab72f8c66d before and after).

Added tests worth knowing:

- Matrix pattern golden: the 20x20 module pattern of the text "ABC" is pinned. I verified it is bit-for-bit the pattern of the cloud's `simpleHash`/`mulberry32` (copied cloud code run in node, `/tmp/claude/1e4b-t2/cloud.mjs`), so the port keeps the cloud's schematic.
- Preview = generator also for TSPL and at 300 dpi: preview calls equal `generateZpl` and `generateTspl` calls one to one.
- The chunk tests use `vi.doMock` + `vi.resetModules` + a dynamic import of the renderer (a chunk that throws on load leaves the code white; no load at all for a layout without a station raster; one load otherwise); `afterEach` unmocks and resets modules.
- The "ink" test wraps `fillText` to record `fillStyle` (the brief's recorder does not record it, so text drawn white would pass).

## Survivors, argued equivalent (reviewers should try to kill them)

- E38 `return hash >>> 0` -> `return hash`: the seed is only ever used through `(state + c) | 0` and `Math.imul`/`^`, all int32 coercions; hash and hash+2^32 coincide mod 2^32, so the pattern is identical.
- E40 `t ^ (t >>> 14)` -> `>>> 13`: the result is used only as `< 0.5`, i.e. its top bit; `t >>> k` (k >= 1) has a zero top bit, so the top bit of the xor is the top bit of `t` for any shift 1..31. (Changing the shift to 0 would change it; that is not a one-line variant of this code.) The golden pattern is therefore unchanged. The other PRNG constants (X35, X36, E39, E41) are killed by the golden.
- E70: my own construction, a no-op expression (`+ 0 * ...`): equivalent by construction. The real row-index mutant (X1) is killed.
- E90 and X14 pass or drop `options` to `elementBoundsMm`: in `compositeTextRasters` only text/field elements are measured, and `bounds.ts` never reads `options` for them; in `paintCodeRasters` only `bounds.x`/`bounds.y` are read, and every barcode branch returns `x: element.xMm, y: element.yMm` whatever the options (they change only w/h).
- E96 `print === null || cancelled()` -> `cancelled()`: with a null `print`, the deref throws a TypeError inside the `try` and `continue` leaves everything unpainted, the same observable result; it also would not typecheck (`print` possibly null).

## Mutant table (all 128; "before" = status with the brief's 7 tests only)

| mutant                                             | before extra tests | killed by (after)                                                                                                                   |
| -------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| E01 bold 700->400                                  | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E02 fontPx without scale                           | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E03 baseline                                       | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E04 no-box align stays                             | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E05 right align x                                  | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E06 center half                                    | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E07 default align left->center                     | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E08 maxLines default                               | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E09 line height em                                 | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E10 line index                                     | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E11 fillText maxWidth                              | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E12 measure                                        | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E13 box width wrap                                 | SURVIVED           | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| E14 box y inset                                    | SURVIVED           | boxes and lines > insets a box's stroke by half its thickness at its own coordinates                                                |
| E15 box x uses y                                   | SURVIVED           | boxes and lines > insets a box's stroke by half its thickness at its own coordinates                                                |
| E16 box w                                          | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E17 box h                                          | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E18 box lineWidth                                  | SURVIVED           | boxes and lines > insets a box's stroke by half its thickness at its own coordinates                                                |
| E19 box strokeStyle                                | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E20 line y2                                        | SURVIVED           | boxes and lines > draws a diagonal line from its start to its end at its thickness                                                  |
| E21 line x2                                        | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E22 line from y                                    | SURVIVED           | boxes and lines > draws a diagonal line from its start to its end at its thickness                                                  |
| E23 line from x                                    | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E24 line thickness                                 | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E25 line strokeStyle                               | SURVIVED           | boxes and lines > draws a diagonal line from its start to its end at its thickness                                                  |
| E26 field textOf                                   | SURVIVED           | text inside its width > draws a field as the print formats it                                                                       |
| E27 field drawn from raw                           | SURVIVED           | text inside its width > draws a field as the print formats it                                                                       |
| E28 matrix white fill                              | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E29 matrix height                                  | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E30 matrix seed                                    | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E31 matrix density                                 | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E32 matrix quiet col                               | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E33 matrix quiet row                               | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E34 matrix rows                                    | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E35 matrix cols                                    | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E36 matrix ink                                     | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E37 hash mult                                      | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E38 hash unsigned                                  | SURVIVED           | SURVIVED (equivalent, see below)                                                                                                    |
| E39 prng const                                     | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E40 prng shift                                     | SURVIVED           | SURVIVED (equivalent, see below)                                                                                                    |
| E41 prng 61                                        | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E42 qr not matrix                                  | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E43 dm not matrix                                  | SURVIVED           | schematic codes > draws a datamatrix as a pattern of modules seeded by its text, inside its quiet zone                              |
| E44 literal data                                   | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E45 data lookup                                    | SURVIVED           | schematic codes > seeds the pattern with the text a field holds just as with a literal                                              |
| E46 module size                                    | SURVIVED           | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| E47 linear width bounds                            | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E48 linear w scale                                 | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E49 linear height scale                            | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E50 linear empty                                   | SURVIVED           | schematic codes > draws an empty linear code as one bar, as wide as the printer would make it                                       |
| E51 linear segment                                 | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E52 linear white                                   | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E53 linear jitter                                  | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E54 linear jitter mod                              | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E55 linear cursor                                  | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E56 linear bar height                              | SURVIVED           | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| E57 raster check opt                               | SURVIVED           | which codes the station rasterizes > draws a datamatrix of the marking code when drawn natively as a schematic: datamatrix          |
| E58 raster check format                            | SURVIVED           | which codes the station rasterizes > draws a qr of the marking code as a schematic: qr                                              |
| E59 raster check data                              | SURVIVED           | which codes the station rasterizes > draws a datamatrix of another field as a schematic: datamatrix                                 |
| E60 drawLabel clear                                | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E61 label bg                                       | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E62 label height                                   | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E63 text el uses element.text                      | KILLED             | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| E64 raster filter kind field                       | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E65 raster filter kind text                        | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E66 raster filter negate                           | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E67 raster filter all                              | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E68 paintRaster ink                                | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E69 paintRaster byte col                           | SURVIVED           | bitmaps and the print at other resolutions > reads a bitmap wider than a byte, a row at a time                                      |
| E70 paintRaster byte row                           | SURVIVED           | SURVIVED (equivalent, see below)                                                                                                    |
| E71 paintRaster bit mod                            | SURVIVED           | bitmaps and the print at other resolutions > reads a bitmap wider than a byte, a row at a time                                      |
| E72 paintRaster bit order                          | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E73 paintRaster dot h                              | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E74 paintRaster run w                              | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E75 paintRaster x                                  | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E76 paintRaster y                                  | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E77 paintRaster runStart reset                     | KILLED             | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| E78 composite dpi dot                              | SURVIVED           | bitmaps and the print at other resolutions > puts each bitmap in whole dots of the layout's resolution, aligned within its width    |
| E79 composite maxWidth dpi                         | SURVIVED           | bitmaps and the print at other resolutions > asks for the bitmaps the print of either language asks for, at the layout's resolution |
| E80 composite font size dpi                        | SURVIVED           | bitmaps and the print at other resolutions > asks for the bitmaps the print of either language asks for, at the layout's resolution |
| E81 composite bold                                 | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E82 composite maxLines                             | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E83 composite fail continue                        | KILLED             | the print bitmaps over the drawing > keeps the drawing of an element its bitmap failed for, and stops once cancelled                |
| E84 composite fail not continue                    | KILLED             | the print bitmaps over the drawing > keeps the drawing of an element its bitmap failed for, and stops once cancelled                |
| E85 composite align arg                            | SURVIVED           | bitmaps and the print at other resolutions > puts each bitmap in whole dots of the layout's resolution, aligned within its width    |
| E86 composite align width                          | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E87 composite align maxw                           | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E88 composite y dots                               | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E89 composite x unrounded                          | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E90 composite cover bounds opt                     | SURVIVED           | SURVIVED (equivalent, see below)                                                                                                    |
| E91 composite cover white                          | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E92 composite cover w                              | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E93 composite cover x                              | KILLED             | the print bitmaps over the drawing > covers each element's drawing and paints its bitmap where the printer puts it                  |
| E94 composite cancel before bitmap                 | SURVIVED           | bitmaps and the print at other resolutions > stops asking once cancelled, even when the bitmap it was waiting for failed            |
| E95 composite text of                              | KILLED             | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| E96 code cancelled                                 | SURVIVED           | SURVIVED (equivalent, see below)                                                                                                    |
| E97 code import catch                              | SURVIVED           | the encoder's chunk > leaves the code white when the chunk does not load                                                            |
| E98 code catch continue                            | SURVIVED           | which codes the station rasterizes > skips a code too small to encode and still paints the others                                   |
| E99 code catch drop                                | SURVIVED           | which codes the station rasterizes > skips a code too small to encode and still paints the others                                   |
| E100 code early exit                               | SURVIVED           | the encoder's chunk > loads the chunk only for a layout that has a raster to paint                                                  |
| E101 code dpi dot                                  | SURVIVED           | which codes the station rasterizes > paints the raster in the dots of the layout's own resolution                                   |
| E102 code side dpi                                 | SURVIVED           | which codes the station rasterizes > paints the raster in the dots of the layout's own resolution                                   |
| E103 code x                                        | KILLED             | drawing a label layout > leaves a product duplicate's code white, then paints it as the raster the station prints                   |
| E104 code y                                        | KILLED             | drawing a label layout > leaves a product duplicate's code white, then paints it as the raster the station prints                   |
| E105 code km field                                 | KILLED             | drawing a label layout > leaves a product duplicate's code white, then paints it as the raster the station prints                   |
| E106 code filter raster                            | SURVIVED           | which codes the station rasterizes > paints the raster of the marking code's datamatrix only, not of the other codes                |
| X1 raster row index                                | n/a (added later)  | drawing a label layout > leaves a product duplicate's code white, then paints it as the raster the station prints                   |
| X2 raster rows                                     | n/a (added later)  | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| X9 composite maxWidthPx                            | n/a (added later)  | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| X10 composite fontSizePx                           | n/a (added later)  | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| X11 drop line case                                 | n/a (added later)  | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| X11b drop box case                                 | n/a (added later)  | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| X11c drop barcode case                             | n/a (added later)  | drawing a label layout > draws the same schematic code for the same layout every time                                               |
| X14 code bounds opts                               | n/a (added later)  | SURVIVED (equivalent, see below)                                                                                                    |
| X19 text ink                                       | n/a (added later)  | ink > draws every text in black over the white label                                                                                |
| X28 textAlign                                      | n/a (added later)  | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| X29 lineHeight scale                               | n/a (added later)  | text inside its width > aligns, wraps and cuts the lines as the printer does                                                        |
| X30 font weight bold sense                         | n/a (added later)  | drawing a label layout > paints the label white, then each element in black at the scale, with the sample's text                    |
| X31 composite bold passthrough                     | n/a (added later)  | the print bitmaps over the drawing > asks the rasterizer what the print asks it, for the text that is not printable ASCII only      |
| X32 composite maxLines passthrough                 | n/a (added later)  | bitmaps and the print at other resolutions > asks for the bitmaps the print of either language asks for, at the layout's resolution |
| X33 paintRaster ink style                          | n/a (added later)  | drawing a label layout > paints a bitmap's black dots as one rectangle per run, within its width                                    |
| X34 composite keeps native on reject (raster null) | n/a (added later)  | the print bitmaps over the drawing > keeps the drawing of an element its bitmap failed for, and stops once cancelled                |
| X35 mulberry mult-state                            | n/a (added later)  | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| X36 mulberry t^t                                   | n/a (added later)  | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| X37 simpleHash charCode                            | n/a (added later)  | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |
| X38 jitter 0.6                                     | n/a (added later)  | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| X39 jitter 0.8                                     | n/a (added later)  | schematic codes > draws a linear code as bars over its printed width and the element's height                                       |
| X40 matrix module size w                           | n/a (added later)  | schematic codes > draws a qr as a pattern of modules seeded by its text, inside its quiet zone                                      |

## Self-review

- All fragments are new files, applied verbatim; no anchor problems. Rasterizer options are the generators' (`"sans-serif"`), checked by comparing with `generateZpl` and `generateTspl`.
- Bitmaps are placed in whole printer dots plus `rasterAlignOffsetDots` (tested at 203 and 300 dpi with left/center/right).
- No Rust, no `test/setup.ts` change, no dependency change. The `label-print.ts` chunk is only imported dynamically from the renderer.

## Concerns

- None blocking. Task 3 note: the doMock tests in "the encoder's chunk" call `vi.resetModules()`; if Task 3 changes `test/setup.ts` module state, those two tests still import the renderer fresh, so they should be unaffected.

## Fix round 1

Base `ffb046dc0`, fix commit `88d9d0f15` (`fix(standalone): растр печати закрывает собственный прямоугольник в предпросмотре`). The commit has one `Co-Authored-By: Claude Opus 5.5` line and the tree is clean.

**Important 1 (fix).**

- `compositeTextRasters` now fills `LABEL_BACKGROUND` over the bitmap's own rectangle before `paintRaster`.
- The rectangle is `(xPx, yPx, raster.width·dotPx, raster.height·dotPx)`, the same whole-dot position the dots use. `xPx` and `yPx` are computed once and shared by the fill and `paintRaster`.
- The `elementBoundsMm` cover stays, so the white is the union of the two. The JSDoc now says so.

**Test changes.**

- "covers each element's drawing…" now expects, per element: bounds cover, white rectangle of the bitmap, black dots. This is the brief's expectation, adjusted only for the new drawing call.
- "keeps the drawing of an element its bitmap failed for…" now expects 3 operations instead of 2 (the second element's cover, its white rectangle, its dots). The assertion keeps its meaning.
- The 300 dpi "puts each bitmap in whole dots…" expects the extra white rectangle per element. Its positions are unchanged.
- New test "whites out the native text of centred and right-aligned text before the bitmap's dots":
  - Native text extent comes from `drawLabel`: x and y from the `fillText` operation, width from `min(characters·10, box width)`.
  - A 484×40-dot bitmap is composited on a separate canvas.
  - A white rectangle painted before the first black fill must contain the native extent. The tolerance is one printer dot, because `mmToDots` rounding makes the right edge differ by about 0.1 px in the fake canvas.

**Minors.**

- The `it.each` title no longer prints the format in place of the boolean. Each name now says "as a schematic" or "not as a schematic". The rows and assertion are unchanged.
- The `recordingRasterizer` JSDoc now says the one-dot bitmap is the default.

**RED on the old code.** I restored `label-renderer.ts` from the index, ran the new tests, and put the fix back with `cp` (`shasum` 9bdf5793…, `cmp` identical). 4 failed, 28 passed:

- "covers each element's drawing…": black dots where the white rectangle is expected.
- "whites out…": `{ align: 'center', covers: false }`.
- "keeps the drawing…": length 2, expected 3.
- "puts each bitmap in whole dots…": 6 operations, expected 9.

**Mutants** (before `cp` of the fixed file to `/tmp/claude/pre-mutant.ts`; restored with `cp`, `cmp` against the fixed copy, sha 9bdf5793… after each).

| Mutant                                               | Failing tests                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Drop the new `fillRect` line                         | the same 4 tests as the RED run                                                    |
| Swap the order (fill after `paintRaster`)            | "covers each element's drawing…", "whites out…", "puts each bitmap in whole dots…" |
| Fill height `dotPx` instead of `raster.height·dotPx` | "whites out…" only (the other bitmaps are 1 dot high)                              |

**Checks.**

- `label-renderer.test.ts` with `--reporter=verbose`: 32 passed, stderr 0 bytes.
- Under the delayed-`setImmediate` stand: 32 passed, stderr 0 bytes. Both stand files were deleted afterwards.
- `typecheck` and `lint`: exit 0.
- Full package suite: 56 files, 1354 tests. That is 1353 plus the one new test.
- `prettier --check` on both files and `git diff --check`: clean.
- The `\u04` grep finds only `src/host/pairing-code.ts:66`.

**Concerns.**

- The one-dot tolerance in the new test is deliberate. The fake canvas measures in round pixels, so a stricter bound would pin rounding rather than the behaviour.
- Nothing here is a browser check. The real Canvas output with real fonts is still untested until the editor wires the preview in (Task 3).
