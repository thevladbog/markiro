# А4 Task 1 report — logo and sheet in the webview

Status: DONE_WITH_CONCERNS. Commit `26513900a` feat(standalone): the Markiro print logo, the wire logo and the A4 sheet render in the webview (plan А4, task 1), branch `claude/prt` (base 7c1458672). Webview/TS only (no Rust, no proto, no manifests).

## What was done

- `src/assets/markiro-print-logo.svg`: byte copy of `apps/station/src/assets/markiro-print-logo.svg` (the cloud asset; sha256 `d341de9b29681ccb62f5625c1ef1a934181f1e086556bba92b9230e6d6858f45`).
- `src/labels/logo.ts` (brief code) plus, for untrusted image data: `LogoDecodeError` with codes `too_large | unsupported_type | decode_failed | empty | canvas_unavailable`; `decodeLogoFile` checks MIME whitelist (png/jpeg/webp/svg+xml) and a 4 MiB size cap before reading a byte; `decodeLogoImage` maps decoder rejection to `decode_failed`. Wire reads keep the brief's bounds (1024x512, 90 000 base64, canonical spelling, domain validation).
- `src/labels/rasterizer.ts`: `overflow === "error"` selects `wrapTextToWidthStrict`; `rasterizeSheetText` (default overflow error). The face-load check of the existing `rasterizeDriverText` (ДРВ) was extracted into one private `rasterizeWithBundledFace` shared by both (behaviour of the driver one unchanged, its tests pass).
- `src/labels/sheet-render.ts` (brief code; `downsampleMonoRaster` additionally refuses a factor that is not an integer >= 1).
- Tests: `label-logo.test.ts` (new, 24 tests), `sheet-render.test.ts` (new, 10 + 3 stock sheets), `label-raster.test.ts` (+5).

## Anchor adaptations

- Domain `dist` was stale (no `organizationInn` on `PalletSheetContext`, which src has since #707); rebuilt with `pnpm --filter @markiro/domain build` (gitignored output). Not a plan difference.
- `rasterizeSheetText` expressed via the shared helper instead of a second copy of the font check (the brief's body is identical in effect); error messages follow the existing file ("Font loading is unavailable", "The bundled label font is unavailable").
- Test-only: `fileURLToPath(import.meta.url)` fails under jsdom, used `readFileSync(new URL(..., import.meta.url))` like the other tests; the brief's strict-mode test was rewritten around `rasterizeText(..., {overflow})` (the exported function name); a Blob type is lowercased by the platform, so the "image/PNG" case is not a refusal.
- The brief's pinned base64 `8MAPQA==` was correct; no deviation.
- Spec section §29 is a later task (docs, Task 8); nothing written to the spec here.

## Evidence

- RED/GREEN: code and tests were written together in one pass (brief gives both); first runs failed only on test-environment details (above), fixed in the tests. Final: `vitest run --reporter=verbose test/label-logo.test.ts test/sheet-render.test.ts test/label-raster.test.ts` = 3 files / 80 tests passed, stderr 0 bytes (`/tmp/claude/impl-a4-t1/final.err`). No React/effects in the new tests, so the delayed-setImmediate stand was not applicable.
- Gates: typecheck 0, lint 0, build 0, `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`, prettier gate live (scratch mis-formatted file -> exit 1, deleted; changed files pass), tree clean after commit.
- Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 154 files / 4762 tests, 4758 passed, 4 failed: 3 in `forms-parity.test.ts` (placard-a4, placard-a5-disassembled, shift-placards-a5: golden still says «ПАЛЛЕТА» while domain src says «ПАЛЕТА») and 1 in `print-form-dialog.test.tsx` (load flake; alone: 36/36 pass, stderr 0). The forms-parity failures are PRE-EXISTING at this base: the golden fix is commit `26572c386` on `claude/integration`, which is not an ancestor of `claude/prt` (checked `merge-base --is-ancestor` = 1). Not touched here. Plan baseline for comparison: ДРВ task 4 reported 150 files / 4671 tests.

## Mutants (scratch one-line, `/tmp/claude/impl-a4-t1/mutate.py`; originals in `/tmp/claude/impl-a4-t1/orig/`; every restore verified sha256 + byte `cmp`, final `cmp` of all three source files against the originals = same). 50 mutants, 46 killed

Test files run: label-logo, sheet-render, label-raster.

| Guard                                                                                | Mutant                                        | Killed by                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| canonical base64                                                                     | return bytes without the re-encode compare    | decodes nothing from a text over the bound, and only the canonical spelling       |
| length bound before decode                                                           | `false` instead of the length test            | same (atob spy not called)                                                        |
| width / height bound                                                                 | `+ 1`                                         | reads nothing from a size outside 1..1024 x 1..512                                |
| read validation (padding, length)                                                    | validate call dropped                         | reads nothing from a logo whose padding bits are set                              |
| write validation                                                                     | validate dropped                              | refuses to write a bitmap the domain would not print                              |
| fitLogoSize never enlarges / nonzero sides                                           | `Math.min(2,..)`, `Math.max(0,..)`            | shrinks to 1024 x 512..., never returns a zero side                               |
| decode failure precise                                                               | plain Error                                   | refuses a picture the webview cannot decode, with a precise code                  |
| empty width / height                                                                 | `< 0`                                         | refuses a picture with no size...                                                 |
| white background, background painted                                                 | black / fillRect dropped                      | draws on white at the scaled size...                                              |
| canvas unavailable                                                                   | check dropped                                 | refuses a picture with no size and a webview with no canvas                       |
| MIME whitelist                                                                       | dropped                                       | refuses any other type unread                                                     |
| size cap (and boundary `>=`)                                                         | dropped / `>=`                                | refuses ... a file over the size cap unread (the file at exactly the cap decodes) |
| object URL freed                                                                     | revoke dropped                                | decodes a PNG... and frees its object URL                                         |
| bundled once / failure not kept / 3.5 scale                                          | `=` instead of `??=`; reset dropped; scale 3  | the three loadBundledMarkiroLogo tests                                            |
| labelLogo own preferred / survives missing Markiro                                   | inverted / rethrow                            | the two labelLogo tests                                                           |
| sheetLogoOf digest                                                                   | constant                                      | names its source and the domain's fingerprint                                     |
| strict wrap                                                                          | `false ? strict : ellipsis`; `!== "ellipsis"` | refuses a text that needs more lines...; ellipsis kept by default for labels      |
| sheet default is error / caller may override                                         | `?? "ellipsis"`; always `"error"`             | refuses a text it cannot place unless the caller asks for the ellipsis            |
| no document.fonts / nothing loaded / not usable / empty-text sample                  | each dropped                                  | loads the face for the text and refuses to draw without it                        |
| sheet default rasterizer                                                             | `rasterizeText`                               | draws its text with the bundled face only                                         |
| sample INN / name / SSCC prefix 9999                                                 | changed                                       | sampleSheetContext test, stock-sheet test                                         |
| downsample factor guard / integer                                                    | dropped / `factor < 1` only                   | refuses a factor that is not a whole number of at least 1                         |
| padding bits ignored (first survivor, test strengthened: stray bit in row 0 padding) | `x >= widthDots` dropped                      | maps each dot to its square... ignores the padding bits                           |
| row mapping, white fill, MSB-first                                                   | `y * width`, `.fill(0)`, `1 << bit`           | same test                                                                         |
| paint: canvas width set, origin, no-context                                          | each                                          | paintMonoRaster tests                                                             |

Survivors (4, all equivalent): `logoFromWire` `width < 1`, `height < 1`, `!Number.isInteger(width)`, `!Number.isInteger(height)` -> weakened: the domain's `validateMonoBitmap`, which runs right after, refuses the same values (0, fractions, NaN), so no input distinguishes them. Kept as the brief has them (cheap early refusal before base64 decode).

## Concerns

1. The 3 `forms-parity` failures are in the branch base (golden fix `26572c386` lives on `claude/integration`), unrelated to this task; the controller should merge/rebase that commit.
2. `decodeLogoFile` now refuses blobs whose MIME type is not png/jpeg/webp/svg+xml (including an empty type) and files over 4 MiB, with `LogoDecodeError`. Task 5 (office upload) must pass real `File` objects or give its tests typed Blobs, and word the error codes. Browsers set `File.type` from the extension; an unknown extension gets an empty type and is refused.
3. Real-webview decoding (`Image.decode` of the bundled SVG at 3.5x, WebView2 IBM Plex loading, SVG without intrinsic size) is not exercised: jsdom tests use a stubbed `Image`/canvas.
4. `graphify update .` not run.
