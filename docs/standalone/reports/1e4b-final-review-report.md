# Plan 1e4b — final whole-part review (range 9f05b3c0c..6b66eb6ad)

**Verdict: WITH FIXES.** Critical 0, Important 0, Minor 3 new (plus the 14 queued, triaged below).

The part works as one machine. The preview, the downloads and the cloud station ask the rasterizer the same things. Every async path is cancelled and none redraws forever. The heavy code really loads on demand, fonts are bundled, layout text reaches only canvas, React text and attributes, and the documents are honest about what jsdom cannot prove. Nothing blocks the part. A small final wave (one fixer, four commits, below) should land the cheap queued fixes and correct two document sentences.

## What I checked (by seam)

1. **Preview ≡ download ≡ station print.**
   - `compositeTextRasters` (`label-renderer.ts:384-390`) passes `fontFamily: "sans-serif"`, `ptToDots(fontSizePt, spec.dpi)`, `bold ?? false`, `maxWidthPx = mmToDots(maxWidthMm)` and `maxLines ?? 1`. These are exactly the arguments of `packages/domain/src/labels/zpl.ts:171-177` and `tspl.ts:249-255`.
   - The download (`TemplateEditor.tsx:278-298`) uses the same `labelSampleData`/`labelRenderOptions` as the preview. These are stable module constants, so the preview's effect deps do not churn. It writes `latin1Bytes`, which is byte-identical to the station's `latin1ToBytes` (`apps/station/src/lib/print-label.ts:20`).
   - The duplicate uses `kmDataMatrix: "raster"`, as the station's `product-labels/fields.ts:83` does.
   - `src/labels/rasterizer.ts` behaves exactly like `apps/station/src/lib/rasterizer.ts`: same `mapFontFamily`, measuring, wrapping, clamp, line height and `document.fonts.load(font, text)`.
   - Gap: the cloud station prints at the PRINTER's dpi (`withPrinterDpi`), but the preview and files use the layout's own dpi (Minor 1).
2. **Async lifecycle.**
   - `PreviewPane`: one `cancelled` flag per effect run covers both passes. `paintCodeRasters` re-checks after the import, and `compositeTextRasters` re-checks after each `await` before painting. The font check drops late answers.
   - Deps are `[spec, data, options, context, rasterizeText]`. All are stable (constants, `BROWSER_LABEL_RENDERING`, the `labels` default) and no draw effect sets state, so there is no infinite redraw.
   - `TemplateThumb` has the same pattern. `whenVisible` is cleaned up on unmount/filter, and `useOfficeQuery`'s `enabled` keeps the read back until the row is visible.
   - A failed chunk load leaves the code white (`.catch(() => null)`) or raises the download alert. No setState after unmount matters (React 19 does not warn).
   - The delayed-`setImmediate` stand over the 6 new or changed test files: 165/165 passed, with no stderr output.
3. **Bundle and offline.**
   - Production code imports `opentype.js` only in `font-coverage.ts`, which is itself only imported dynamically or as `import type`. Generators and `rasterizeGs1DataMatrix` come only through `import("./label-print.js")`.
   - `dist` (built 01:02, after HEAD 01:00): `index` 875,879 B with no bwipp/opentype symbols. Separate chunks: `bwip-js-gen` 903.7 KiB, `font-coverage` 231.8 KiB (it embeds `/assets/ibm-plex-{sans,mono}-{latin,cyrillic}-400-normal-*.woff`, all four present in `dist/assets`), and `label-print` 7.2 kB.
   - The bold Cyrillic `@font-face` subsets the rasterizer loads are in `dist`.
   - The Tauri CSP (`connect-src 'self' …`, `default-src 'self'`) allows the same-origin `fetch` of the `.woff` files and the dynamic chunks. No CDN, no network.
   - The `test/setup.ts` silencer is verified by its own `process.stderr.write` test, and it hides nothing in the 6 files. Queued item 6 is real (`office.test.tsx:151`, `operators-page.test.tsx:193`, `users-page.test.tsx:75`) and harmless today.
4. **Caches.**
   - `templateLayout(id, rev)` uses `staleTime: Infinity`, and the default `gcTime` collects old revisions 5 min after they are unobserved. Nothing invalidates `["office"]` broadly, and the editor's `resetQueries` is `exact` on the list. The list cache never holds a layout (two tests).
   - A failed read stays in the error state without data, so it is stale. It is read again per visit, only for rows within 200 px of the viewport: a dozen or two requests at most, no retry loop (`retry: false`). Low risk.
   - Mutant `staleTime` dropped: killed by 2 tests.
5. **Untrusted text.**
   - No `dangerouslySetInnerHTML`, `innerHTML` or `<Trans>` in the part. The one pre-existing `dangerouslySetInnerHTML` is `PairingDataMatrix.tsx` from bwip SVG, outside the part.
   - Layout text reaches only `fillText`, names only React text, and the file name goes through `templateFileName`. Markup tests exist for preview, thumbnail, hidden names and file name.
   - Size bounds: the preview canvas is ≤ 900 × 900 px (schema 10–300 mm × 3), the thumbnail ≤ 64 × 48. The rasterizer canvas is bounded only by the browser (queued item 1, CARRY). Text length is capped by the host's 256 KB, and an oversized canvas yields no context or throws, which is caught and keeps the native drawing.
6. **Accessibility/UI.**
   - The preview is a `figure` with a `figcaption`, and the canvas is `role="img"` named by size. Font warnings are `Alert` (`role="alert"`). The thumbnail is `aria-hidden` with no name of its own, and the name sits beside it.
   - Task 6 diff read in full. The guard `title !== null && title !== "" && title !== label` is right: `[]` is schema-valid and would read «Категорий: 0 ()». Each part of the guard is killed by a test (single group, empty list).
   - The `title` is kept beside the hidden names. Some screen readers may read the names twice; this needs a live check.
   - Download buttons: the pressed one shows busy, both are off while busy or while the duplicate is broken, and JSON stays on. Queued items 8 and 9 are real.
7. **Documents.** 1e4b is described as done, nowhere as next, and spec §8 still names 1e4 as the editor plan, which is correct. Not run in a real window: all of it, stated in both documents. Two inaccuracies (Minors 1, 2). The sentences tied to queued items 4 and 8 must change with their fixes.
8. **Tests as a suite.**
   - Count arithmetic matches the ledger (59 / 1410). Titles are mostly precise; exceptions are queued item 10, the casts (item 11) and the 600 ms wait (item 12).
   - Mutants I ran, each restored byte-identical (`cmp` and sha256 equal, `git status` empty):
     - (A) `catalog-queries.ts` without `staleTime: Infinity`: killed by 2.
     - (B) `TemplateThumb.tsx` cancellation `() => false`: killed, but only by the 600 ms timing test, confirming item 12.
     - (C) `label-renderer.ts:405` (the Task 2 fix's white fill of the bitmap's own rectangle) removed: killed by 4.
   - The argued equivalents (Task 1 R39 etc., Task 2 E38/E40/E90/X14/E96, Task 4 E4, Task 5 X20) were checked by their task reviews. I re-read X20 and E4 and agree.
9. **Scope and process.** Paths: `apps/standalone/{src,test,AGENTS.md}` plus the spec only. `git diff --stat` on host/proto/src-tauri/station/packages/lockfile/manifest is empty. No new dependency. 8 commits, each with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git diff --check` is clean, and the `\u04` grep finds only `pairing-code.ts:66`.

## (a) Findings (new; most severe first)

**Minor 1. The documents overstate «what a station would send»: it holds only at the layout's own resolution.** `apps/standalone/AGENTS.md:1263-1265` («so it is what a station would send to its printer») and spec §5.5 («байт в байт … как у станции»).

- The files and the preview are made at `spec.dpi`. The cloud station prints every template at its printer's dpi (`withPrinterDpi`, `apps/station/src/lib/print-label.ts:52-57`; DPI-neutral templates since PR #470), and plan 2a may do the same.
- Scenario: a technologist downloads the ZPL of a 203-dpi layout, sends it to a 300-dpi Zebra and gets a label at about 2/3 scale. Meanwhile the documents promise the station's bytes.
- Fix (DOC): «… what a station whose printer has the layout's resolution would send» in both documents; the same qualifier for «предпросмотр = печать» of the bitmaps. No code change.

**Minor 2. Stale bundle figure.** `apps/standalone/AGENTS.md:572` says «the main chunk stays near 873 kB». That was Task 3's 872.66 kB; HEAD's chunk is 875.87 kB. Fix (DOC): «about 876 kB», or drop the number.

**Minor 3. `vi.resetModules()` leaks for the rest of the file.** `test/template-thumbs.test.tsx:539` resets the module registry with no restore. Every later dynamic import in the file then re-evaluates `label-print.js`/`@markiro/domain` under a fresh registry: slower, and class identity differs, e.g. `instanceof RasterUnavailableError` across registries. It exists only to slow the import for the timing kill. Fix: delete it together with the queued item 12 fix.

Not findings, but recorded:

- The two `void paintCodeRasters(…)` chains have no `.catch`. Every thrower inside is already caught, or also runs synchronously in `drawLabel` first, so no unhandled rejection is reachable on a schema-valid layout.
- A code download that finishes after the user has left the editor still saves the file (harmless).

## (b) TRIAGE of the queued minors

| #   | Decision                        | Reason                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CARRY (plan 2a)                 | Canvas size is bounded only by the browser in all three copies; the station's printing is the right place, with one limit shared by all three.                                                                                                                                                                                                                                     |
| 2   | FIX (cheap, fold into commit 4) | Theoretical now (`test/setup.ts` always defines the own property, so the saved descriptor exists), but one line removes the trap. The same pattern is in `template-preview.test.tsx:96-108` `installWebviewCanvas`: restore unconditionally or throw when nothing was saved.                                                                                                       |
| 3   | DROP (+ DOC under Minor 2)      | Measured: no bwip/opentype in the main chunk (875.87 kB); only the document's number is stale.                                                                                                                                                                                                                                                                                     |
| 4   | FIX                             | A real wrong signal: a stale «нет кириллицы / не удалось проверить» flashes for a different layout. Keep the verdict tied to the check that produced it (e.g. `{ for: checkSeq, value }`, or reset by keying), avoiding a bare setState-in-effect. Then delete the AGENTS/spec sentence «a warning from an earlier check may show again until the new answer arrives».             |
| 5   | FIX (cheap)                     | Keep a module-level `Map<LabelFontFamily, Promise<boolean>>` in `BROWSER_LABEL_RENDERING.checkFamilyCoverage` that keeps only fulfilled answers (drop the entry on rejection, so a failed fetch is retried). Test through the real `BROWSER_LABEL_RENDERING` with a stubbed `fetch`.                                                                                               |
| 6   | FIX (cheap)                     | Pass `labels={quietLabelRendering()}` in the three `rerender(<Office …/>)` calls.                                                                                                                                                                                                                                                                                                  |
| 7   | CARRY (owner/domain)            | Non-ASCII barcode data → control byte. Download ≡ station, so the fix belongs in `packages/domain` emitters (reject or escape); out of this app's scope.                                                                                                                                                                                                                           |
| 8   | FIX (plan-mandated text)        | Neutral wording, one key covering every failure, e.g. «Файл не собран: не удалось нарисовать русский текст или загрузить модуль печати. Попробуйте ещё раз.», or a second key for the chunk path. Move the alert ABOVE the buttons as D6 says, and update AGENTS/spec («below the buttons … Russian text» → the new text/place).                                                   |
| 9   | FIX (cheap)                     | Render only while `!duplicateInvalid`. Optionally clear `codeFailed` when the layout or purpose changes (the advice is stale then too).                                                                                                                                                                                                                                            |
| 10  | FIX (cheap)                     | The test checks that disabled buttons start nothing, not a same-moment double press. In a real browser a discrete click flushes `preparing` before the next click, so the guard is adequate; rename the title, do not add a ref.                                                                                                                                                   |
| 11  | FIX                             | Typed fakes: build a full `IntersectionObserverEntry` (`target`, `time`, `intersectionRatio`, `boundingClientRect: element.getBoundingClientRect()`, `intersectionRect`, `rootBounds: null`, `isIntersecting`), and pass a `FakeObserver` that implements `IntersectionObserver` (root, rootMargin, thresholds, takeRecords, unobserve) as the second callback argument. No casts. |
| 12  | FIX                             | Remove the 600 ms wait and `vi.resetModules()` (Minor 3). Unmount in the `clearRect` hook as now, then `await act(async () => { await import("../src/office/templates/label-print.js"); await new Promise((r) => setTimeout(r, 0)); })`, the pattern `template-preview.test.tsx:323-331` already uses. Re-run mutant B (`() => false`) to show a deterministic kill.               |
| 13  | DROP (or CARRY to polish)       | Not quite as described: a state/categories write replaces the row in place, the same `TemplateThumb` stays `visible`, and the new key is read at once. The blank lasts one LAN round trip. `placeholderData` would widen the shared `useOfficeQuery` options and keep a stale picture over a failed read, so it is not risk-free.                                                  |
| 14  | CARRY (visual check)            | It applies to the preview too (3 px/mm in CSS px). Decide on `devicePixelRatio` scaling only after looking at a scaled Windows display.                                                                                                                                                                                                                                            |

Proposed fix wave (one fixer, 4 commits, each with focused Vitest, then the controller's gates):

1. `fix(standalone): предупреждение о шрифте — только от своей проверки, удачный ответ запоминается` (items 4 and 5; PreviewPane + label-rendering + template-preview tests).
2. `fix(standalone): отказ выгрузки кода — над кнопками, общими словами, не при сломанном дубликате` (items 8 and 9; TemplateEditor + ru.json + template-code-downloads tests + item 10 rename).
3. `test(standalone): миниатюры без приведений и без ожидания по времени` (items 11, 12 and Minor 3).
4. `test(standalone)+docs(standalone): тихие инструменты в повторных рендерах офиса; документы` (items 6 and 2 in tests; AGENTS.md/spec: Minors 1 and 2 plus the sentences changed by items 4 and 8). The doc edits may go into commits 1 and 2 instead, to keep each behaviour and its text together.

Expected test count after the wave: +2 to +4 (font memo, stale-warning case, alert-hidden-while-broken); the fixer reports the exact figure.

## (c) DEVIATIONS TO RECORD («Отклонения при исполнении», draft)

- Задача 1: исполнитель добавил 18 тестов сверх брифа (рисование `rasterizeTextSync` записывающим холстом); три мутации признаны эквивалентными и подтверждены ревью.
- Задача 2: по ревью растр печати сначала закрывает белым свой собственный прямоугольник (`88d9d0f15`), иначе у центрированного и выровненного вправо русского текста из-под растра проступал его собственный рисунок; облако получало то же непрозрачным растром. Одна проверка добавлена, три — на один вызов рисования больше.
- Задача 3: главный чанк — 872,66 kB при задаче 3 и 875,87 kB в конце части (план ждал ≈ 875,82); чанк печати — 7,16 kB, после выгрузок (при задаче 3 — 1,59 kB).
- Задача 4: отказ выгрузки показан под кнопками, а не над ними (D6), и одним текстом про русский текст для любого сбоя, включая незагрузившийся чанк; <исправлено в финальной волне / оставлено — по итогу волны>.
- Задача 5: неудавшееся чтение макета миниатюры не хранится: строка, видимая на экране, читает его снова при каждом открытии «Шаблонов» (без повторов и без сообщения).
- Задача 6: к условию брифа добавлено `scope.title !== ""`, иначе пустой список категорий (`[]` допустим схемой) читался бы «Категорий: 0 ()»; отдельного ревью задачи нет, её разобрало итоговое ревью части.
- Задача 7: тексты документов сверены с итоговым кодом, а не с брифом (белый прямоугольник растра, скрытые названия только при непустом списке, место и текст отказа выгрузки, ограничение домена на данные кода вне ASCII).
- Итоговое ревью: файлы кода и предпросмотр делаются в разрешении макета; облачная станция печатает в разрешении своего принтера (`withPrinterDpi`), поэтому «то, что отправит станция» верно только для принтера с разрешением макета — уточнено в документах.

Additions to «Перенесено» (if not already there): item 7 (domain: emitters neither reject nor escape non-ASCII barcode data); item 14 together with the preview (canvas in CSS pixels on scaled displays); item 1 (canvas size limit for plan 2a, shared by the three rasterizer copies).

## (d) What could not be verified

Only jsdom and recording contexts were exercised; no real window was opened. Still unverified:

- canvas pixels and sharpness of the preview and thumbnails, including `devicePixelRatio`;
- CSS layout of the figure and the 64 × 48 thumbnail inside a wrapped name cell;
- `document.fonts.load` with Cyrillic and the rasterizer in WebView2/WKWebView;
- `fetch` of the `.woff` files and dynamic chunk loading over Tauri's protocol (CSP reading says it is allowed);
- `IntersectionObserver` in the webview;
- `<a download>` for ZPL/TSPL/JSON in WebView2/WKWebView;
- printing a downloaded ZPL/TSPL on a real Zebra/TSC;
- how a screen reader reads the categories cell with both `title` and the hidden names, the async `role="alert"` font warning on editor open, and the busy download buttons.

I did not re-run the whole Vitest suite, typecheck, lint or build (the controller's gate: 59 / 1410, all 0). I relied on the existing `dist` timestamped after HEAD for the bundle reading. No cargo (no Rust changed).

## (e) Owner questions

- **`<a download>` live on Windows:** check it before relying on it. It takes about ten minutes on Windows 10 and 11 with a release build. WebView2 generally saves a blob-anchor download to the user's Downloads folder, but whether Tauri 2's default download handling lets it through has never been tried here. If it fails, add one shell save command (dialog plus byte write) that all three downloads use. That is a `src-tauri` and capabilities change. macOS (WKWebView) matters less for a Windows product.
- **`fitSpecElements` and the samples into `@markiro/domain`:** yes, as its own small plan. There are now three consumers in this app (fitting, preview, thumbnails), and the cloud has its own copies. Do it before plan 2a so the station's print sample cannot drift. Rendering stays in the app.
- **One shared rasterizer package for admin, station and standalone:** recommended before plan 2a, which would otherwise make the standalone station a fourth consumer of a third copy. A small DOM-dependent workspace package with today's tests carries «предпросмотр = печать» by construction rather than by comment. If the owner declines, add at least a parity test over the three copies' behaviour.
- **Stay in the editor after saving:** recommended, now that the preview makes layout edits iterative. Stay on `/templates/:id` with an inline «Сохранено» notice; a new template moves to its own id. Leaving remains «К шаблонам». This changes the 1e4-tested flow (the notice on the list, the `resetQueries` timing), so it should be its own small task, not part of the 1e4b wave.
