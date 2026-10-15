# Plan 1e4b, Task 3 report: preview in the template editor

Status: DONE (one adaptation, see Concerns)
Commit: `fa87d3ea0 feat(standalone): предпросмотр макета в редакторе шаблона` (base 88d9d0f15; trailer verified: exactly one `Co-Authored-By: Claude Opus 5.5` line). `git status --short` is empty after the commit.

## What was done

Steps 1-6 of the brief, verbatim code: `label-rendering.tsx` (`LabelRendering`, `BROWSER_LABEL_RENDERING`, `LabelRenderingProvider`, `useLabelRendering`), `PreviewPane.tsx`, `Office` `labels` prop with the provider inside `Office`, `PreviewPane` in `TemplateEditor` (`draft.spec`, `draft.purpose`), keys `office.templateEditor.preview.*` in `ru.json`, CSS, `quietLabelRendering()` plus `renderOffice` default in `test/support/office.tsx`, jsdom `getContext` silencer in `test/setup.ts`. All anchors matched exactly once.

## Evidence

- Baseline before edits: 56 files / 1354 tests (matches the controller's number).
- RED: `vitest run test/template-preview.test.tsx` -> exit 1, `Failed to resolve import "../src/office/templates/label-rendering.js"`, `Tests no tests`.
- GREEN: `--reporter=verbose test/template-preview.test.tsx test/office.test.tsx test/template-editor.test.tsx` -> 3 files, 130 tests, 0 stderr lines (this was with the brief's 8 tests; same number the brief expects). Same files under the delayed-`setImmediate` stand -> 130 passed. Later, with my 19-test file: `template-preview + label-raster + label-renderer` verbose -> 78 passed, stderr empty, no "Not implemented"; under the stand -> 78 passed. Stand files deleted before `lint` and the commit.
- Gates: prettier --check on all 9 files clean; `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`; typecheck exit 0; lint exit 0; full `test`: 57 files / 1373 tests passed.

## Counts

- Brief: 57 files / 1319 tests. Brief +43 (Tasks 1-2 extras) = 1362 expected. I added 11 tests beyond the brief (19 in `template-preview.test.tsx` vs the brief's 8), so 1362 + 11 = 1373 measured.
- Brief's mutation 1 expects `length of 7 but got 9`; measured `7 but got 10`: the Task 2 fix round paints one extra white `fillRect` per element. The test itself needed no adaptation (it compares against the length before the late bitmap).

## Brief mutants (restore proof: `shasum -a 256` before and after equal, `cmp` silent, for every row; script `/tmp/claude/muts.py`)

| #   | Mutant                                    | Failing test(s)                                           | Key line                                                                       |
| --- | ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | cleanup `return () => {}`                 | paints no bitmap of a layout that changed (+3 of mine)    | `expected [ ...(10) ] to have a length of 7 but got 10`                        |
| 2   | drop `if (!needsCheck) return undefined;` | checks the font only for Cyrillic text (+1 of mine)       | `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| 3   | `shown = coverage`                        | checks the font only for Cyrillic text                    | `expected <div role="alert" ...> to be null`                                   |
| 4   | family "IBM Plex Mono"                    | checks the font only for Cyrillic text                    | `expected "vi.fn()" to be called with arguments: [ 'IBM Plex Sans' ]`          |
| 5   | no `paintCodeRasters`                     | paints a product duplicate's code as the station's raster | `expected 0 to be greater than 50`                                             |
| 6   | `opened.spec`                             | shows the layout being edited (+1 of mine)                | `Unable to find ... name "Предпросмотр этикетки 58,06 × 40,04 мм"`             |
| 7   | provider value `BROWSER_LABEL_RENDERING`  | shows the layout being edited                             | `expected [] to deep equally contain [ 'fillText', 'Партия' ]`                 |

## My extra tests (11) and their mutants

Extra tests: markup test; redraw on purpose/context/rasterizer change; slow older bitmap vs newer layout; unmount while pending; duplicate-code encoder loading while layout changes; font check once + stale answers (resolve and reject); default tools without a provider; default tools through `Office` without `labels`; quiet tools behaviour; jsdom `getContext` silent; editor passes the purpose to the preview.

| #   | Mutant (one line)                                       | Test that fails                                                                 | Key line                                                                       |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| E1  | draw deps drop `data, options`                          | draws again when only the purpose, context or rasterizer changes                | `expected [ ...(4) ] to deep equally contain [ 'fillText', '04600000000015' ]` |
| E2  | draw deps drop `context, rasterizeText`                 | same test                                                                       | `expected [] to deep equally contain [ 'fillText', '04600000000015' ]`         |
| E3  | draw deps drop `rasterizeText` only                     | same test                                                                       | `expected "vi.fn()" to be called 1 times, but got 0 times`                     |
| E4  | draw deps `[]`                                          | 6 tests incl. brief's "draws again when the layout changes"                     | `expected [] to deeply equal [ 'Партия' ]`                                     |
| E5  | `paintCodeRasters(..., () => false)`                    | paints no duplicate code of a layout that changed while its encoder was loading | `expected [ ...(1008) ] to deeply equal []`                                    |
| E6  | check deps add `spec`                                   | checks the font once while the layout keeps its Cyrillic text                   | `to be called 1 times, but got 2 times`                                        |
| E7  | resolve branch without `!cancelled`                     | same test                                                                       | `expected <div role="alert"> to be null`                                       |
| E8  | reject branch without `!cancelled`                      | same test                                                                       | `expected <div role="alert"> to be null`                                       |
| E9  | check cleanup removed                                   | same test                                                                       | `expected <div role="alert"> to be null`                                       |
| E10 | `SCALE = 4`                                             | 3 tests (size 232 vs 174, clearRect)                                            | `expected '232' to be '174'`                                                   |
| E11 | editor `purpose="box"`                                  | previews the layout the chosen purpose starts with                              | `Unable to find an element with the text: Образец с синтетическим кодом...`    |
| E12 | sample note for every purpose                           | tells that a duplicate's code is a synthetic sample (+1)                        | `expected <p class="office-note"></p> to be null`                              |
| E13 | `getContext("webgl")`                                   | draws on the webview's 2D canvas when no tools are given                        | `expected [ 'webgl' ] to deeply equal [ '2d' ]`                                |
| E14 | context default `{...BROWSER, context: () => null}`     | same test                                                                       | `expected [] to deeply equal [ '2d' ]`                                         |
| E15 | `Office` default `labels` with null context             | gives the office the webview's canvas unless a test passes its own              | `expected undefined to deeply equal [ 'clearRect', 0, 0, 174, 120 ]`           |
| E16 | quiet font check resolves true                          | is quiet in tests                                                               | `expected true to be 'silent'`                                                 |
| E17 | quiet `context` calls the real one                      | is quiet in tests                                                               | `expected { ops: [], ... } to be null`                                         |
| E18 | quiet rasterizer rejects with a plain Error             | is quiet in tests                                                               | `expected Error: x to be an instance of RasterUnavailableError`                |
| E19 | silencer value = jsdom's own `getContext`               | has a jsdom canvas that answers null without a «Not implemented» error          | `expected "Mock" to not be called at all, but actually been called 1 times`    |
| E20 | caption as `dangerouslySetInnerHTML` of the layout text | markup test (+ caption test)                                                    | `expected <img src="x" onerror="alert(1)"> to be null`                         |
| E21 | aria-label size dropped                                 | 4 tests                                                                         | `Unable to find ... name "Предпросмотр этикетки 58 × 40 мм"`                   |

Findings while doing this: my first E19 (the `console.error` spy) passed on the mutant, because jsdom writes «Not implemented» straight to `process.stderr`; I rewrote the test to spy on `process.stderr.write` and it now kills the mutant. My first version of the default-through-Office test restored `getContext` before its awaits finished (helper restored in `finally` of a sync wrapper); fixed by an `installWebviewCanvas` restore function used in try/finally.

Equivalent mutant, argued: dropping `cancelled` from the font-check cleanup only for the unmount case changes nothing observable (React 19 does not warn on setState after unmount and nothing reads the state afterwards); the guard itself is covered by E7-E9 through the layout-change path.

## Markup (note 4)

The preview renders no template or field names in the DOM: layout text goes to canvas `fillText` only, the size is a number string in an attribute, warnings are fixed keys. The markup test draws a text `<img src=x onerror=...> &amp; <b>Партия</b>`, asserts `fillText` got it verbatim and the figure's DOM contains no `img`/`b`/`onerror` (mutant E20).

## getContext silencer and `label-raster.test.ts`

`label-raster.test.ts` saves `realGetContext` at module load; with the silencer it is the silencer's own descriptor (configurable, writable), and its `afterEach` restores that. Checked by running it alone and together with the new file (verbose and under the delay stand): 78 passed, no stderr, no «Not implemented»; also full suite green. Real jsdom `getContext` is no longer reachable in the suite; the silencer test above covers that.

## Bundle

`pnpm ... build` (writes only git-ignored `dist`): exit 0. Main chunk `index-PEa6kUiA.js` 872.66 kB (plan: ~875.82). Separate chunks: `bwip-js-gen` 925.37 kB, `font-coverage` 237.41 kB (opentype.js), `label-print` 1.59 kB, `PairingDataMatrix` 0.67 kB, `rolldown-runtime` 0.58 kB. bwip-js is not in the main chunk (the main chunk only names `bwip-js-gen-*.js` as a dynamic import). The plan's "≈ 7 kB" third chunk measures 1.59 kB here (label-print); Tasks 4-5 may still add to it.

## Files changed (9)

`apps/standalone/src/office/templates/{label-rendering.tsx,PreviewPane.tsx (new),TemplateEditor.tsx}`, `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/app/shell.css`, `apps/standalone/test/{template-preview.test.tsx (new),setup.ts,support/office.tsx}`.

## Not verified

No browser/visual check of the preview in a real webview (CSS `--paper`/`--line-strong` exist in `packages/ui/src/tokens.css` but the look was not seen), no real canvas, no real font file check (the opentype.js check only ran as a build chunk, not in tests), no Rust/cargo (not applicable).

## Concerns

- Measured vs brief numbers differ as explained above (+43 shift, +11 mine, mutation 1 shows 10 not 9).
- Earlier stale `.claude/.cc-writes` directory exists in the worktree root (git-ignored, predates my work; I never used `cd`).
