# Plan 1e4b, Task 4 report: ZPL and TSPL downloads in the template editor

Base fa87d3ea0, commit e8082efd7 `feat(standalone): выгрузки ZPL и TSPL в редакторе шаблона` (one trailer line, verified with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## What was done

- `download.ts`: `latin1Bytes`, `zplBlob` (`text/plain`), `tsplBlob` (`application/octet-stream`), verbatim from the brief.
- `label-print.ts`: also re-exports `generateTspl`, `generateZpl`.
- `TemplateEditor.tsx`: `preparing`, `codeFailed`, `downloadCode`, two buttons, the failure `Alert`, and imports, all verbatim. All 8 anchors of Step 3 matched exactly once at the start of the step; the 9th, in `ru.json`, matched once too.
- `ru.json`: `downloadZpl`, `downloadTspl`, `codeFailed`.
- `test/template-code-downloads.test.tsx`: the plan's 6 tests plus 7 of mine (13 in all).
- The downloads use only `useLabelRendering().rasterizeText`, `labelSampleData(draft.purpose)` and `labelRenderOptions(draft.purpose)`. They do not use the preview's state.

## RED / GREEN

- RED: `vitest run test/template-code-downloads.test.tsx` before the implementation gave `Tests 6 failed (6)`, with the six names of the brief (output kept at /tmp/claude/red1.txt).
- GREEN, plan files: `vitest run --reporter=verbose test/template-code-downloads.test.tsx test/template-editor.test.tsx` gave 2 files, 103 tests, stderr empty. That equals the brief's 103 because the 7 extras were added later.
- GREEN, final: the same two files gave 2 files, 110 tests, stderr empty (no `act` warnings, no unhandled rejections).
- Delayed-`setImmediate` stand (both temporary files removed afterwards): 2 files, 110 tests, passing.
- `prettier --check` on the 5 files: clean. `git diff --check`: clean. `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`. `typecheck` and `lint`: exit 0.
- Full `pnpm ... test`: 58 files, 1386 tests. The baseline was 57 files and 1373 tests.

## Counts

|       | brief | measured |
| ----- | ----- | -------- |
| Files | 58    | 58       |
| Tests | 1325  | 1386     |

The difference is 61. That is the 54 added by Tasks 1–3 beyond the plan, plus my 7 extras. Check: 1373 + 13 new = 1386. The step-4 figure of 103 for the two files matched exactly with the plan's six tests only.

## Mutants

The command is `vitest run test/template-code-downloads.test.tsx [-t …]`. After every mutant: `cmp` against `/tmp/claude/before` was silent and `shasum -a 256` was unchanged (harness /tmp/claude/mut.py checks both and printed `restore cmp 0 hash same True` every time).

Plan's mutants (run with the plan's `-t` filter):

| #   | Mutant                                   | Test that failed                                                        | Key line                                                         |
| --- | ---------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | `zplBlob` takes the raw string           | keeps each character a byte                                             | `expected [ 65, 195, 191 ] to deeply equal [ 65, 255 ]`          |
| 2   | `tsplBlob` takes the raw string          | saves the domain's TSPL with the bitmap's bytes one for one             | `expected [ 83, 73, …(128) ] to deeply equal [ …(126) ]`         |
| 3   | ZPL button without `duplicateInvalid`    | keeps both code downloads off while a product duplicate breaks its rule | `to have property "disabled" with value true`                    |
| 4   | no `rasterizeText` in deps               | saves the domain's ZPL …                                                | `expected [] to deeply equal [ 'Молоко-58-40.zpl' ]`             |
| 5   | `labelSampleData("pallet")` always       | saves the domain's ZPL …                                                | `[ 'Партия', '240 шт.' ] to deeply equal [ 'Партия', '20 шт.' ]` |
| 6   | `setCodeFailed(true)` removed            | says the file was not made … (plus my chunk test)                       | `Unable to find role="alert"`                                    |
| 7   | `finally { setPreparing(null) }` removed | keeps both code downloads off while one file is being made              | `to have property "disabled" with value false`                   |

Extra mutants (full file, no filter). The last column is the tests that failed:

| #       | Mutant                                                      | Failed                                                                                                                                                |
| ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1      | ZPL MIME `text/plain;charset=utf-8`                         | keeps each character a byte; saves the domain's ZPL                                                                                                   |
| E2      | TSPL MIME `text/plain`                                      | keeps each character a byte; saves the domain's TSPL                                                                                                  |
| E3      | `& 0x7f` instead of `& 0xff`                                | keeps each character a byte; TSPL bytes one for one                                                                                                   |
| E5      | extension always `.zpl`                                     | 5 tests: TSPL one for one, the two busy tests, retry, markup                                                                                          |
| E6      | file name `draft.name.trim()` instead of `templateFileName` | 7 tests (ZPL name and others)                                                                                                                         |
| E7      | `deps = { rasterizeText }` (no render options)              | product_duplicate own sample and render options                                                                                                       |
| E8      | `labelSampleData("box")` always                             | product_duplicate and pallet                                                                                                                          |
| E9, E10 | spinner on the wrong button (ZPL, TSPL)                     | one at a time, marks only the pressed button                                                                                                          |
| E11     | ZPL button without `preparing !== null`                     | one file is being made; one at a time after TSPL                                                                                                      |
| E12     | TSPL button without `preparing !== null`                    | one at a time after «Скачать ZPL» (`rasterize` called 2 times, not 1). This one survived the first version of my test; I made it a two-case `it.each` |
| E13     | TSPL button without `duplicateInvalid`                      | breaks its rule                                                                                                                                       |
| E14     | `setCodeFailed(false)` removed                              | retry clears the notice (alert still present)                                                                                                         |
| E15     | alert always shown                                          | retry clears the notice                                                                                                                               |
| E16     | `setPreparing(null)` only on the success path               | buttons back on after a failure; chunk failure                                                                                                        |
| E17     | `await import()` moved outside the `try`                    | chunk does not load (no alert)                                                                                                                        |
| E18     | `setPreparing(language)` removed                            | one file at a time; one at a time (spinner)                                                                                                           |
| E19     | ZPL button calls `downloadCode("tspl")`                     | ZPL name, duplicate, pallet                                                                                                                           |
| E20     | JSON button disabled with a broken duplicate                | breaks its rule, and the JSON on                                                                                                                      |
| E21     | ZPL/TSPL swapped in `downloadCode`                          | 4 tests                                                                                                                                               |
| E22     | `startingSpec` instead of `draft.spec`                      | ZPL of the layout; failure; retry                                                                                                                     |

E4 (drop `& 0xff`) survives and is equivalent. `Uint8Array` element assignment performs ToUint8, which is modulo 2^8, so the mask changes no result for any code unit. I left it as the brief writes it. E3 shows the neighbouring change (`& 0x7f`) is caught. In practice the generators send everything above U+007F through the rasterizer, so a character above U+00FF cannot reach `latin1Bytes` except as a bitmap byte.

## Extra tests

All seven are in the second `describe`.

- `it.each(product_duplicate, pallet)`: the file equals `generateZpl(startingSpec(purpose), labelSampleData(purpose), { rasterizeText, ...labelRenderOptions(purpose) })`. It also asserts this differs from the box-sample/native output, so the test cannot be vacuous. This kills E7 and E8. For `box`, `labelRenderOptions` is `{}`, so the plan's tests could not see it.
- `it.each` over which button is pressed (2 cases): only the pressed button shows `.mk-spin`; a second press of either button starts nothing (one `rasterize` pair, one blob, one name).
- Failure then retry: after a failure both buttons are on again and nothing is saved; a retry saves the file and the alert is gone.
- Chunk failure: `vi.doMock` of `label-print.js` throws, so the alert shows and the buttons come back (`afterEach` does `vi.doUnmock`).
- Markup test: the name `<b id="x">Кега</b> ../ "50 л" & Co` saves as `b-id-x-Кега-b-50-л-Co.tspl`; no `<b>` and no `a[download]` is left in the document. The alert has no user text, so the name appears only in the file name (an anchor property). Its mutant is E6, which fails it along with others.

## Notes and concerns

- I ran `prettier --write` on the test file after pasting. Prettier reported the plan's block already formatted. Only my additions were reflowed.
- Not touched, per the brief: the `<a download>` question in WebView2/WKWebView (no `src-tauri` change). The `downloadFile` revoke timing is unchanged and is already covered by `template-editor.test.tsx`.
- Not verified by any test: real bwip-js chunk splitting in a production build. `build` was not run (the task changes no shell code and the rules ask for it only then).
- The controller's three queued Task 3 items were not touched, as stated.
- No concerns about the plan's text. The only deviation is the count difference above.

Files: apps/standalone/src/office/templates/{download.ts,label-print.ts,TemplateEditor.tsx}, apps/standalone/src/i18n/ru.json, apps/standalone/test/template-code-downloads.test.tsx.
