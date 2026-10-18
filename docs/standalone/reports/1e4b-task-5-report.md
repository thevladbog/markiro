# Plan 1e4b, Task 5 report: thumbnails on «Шаблоны»

Status: DONE_WITH_CONCERNS (concerns are notes, see the end). Base `e8082efd7`, commit `c58007a0d feat(standalone): миниатюры шаблонов в списке «Шаблоны»`. Trailer: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `git status --short` empty after the commit; no stash, no cd into the repo, no cargo, no dependency change.

## What was done

Steps 1-6 of the brief, verbatim code and values: the 2 `office.tsx` and 1 `templates-page.test.tsx` fragments, `template-thumbs.test.tsx` (the plan's 6 tests), `officeKeys.templateLayout`, `OfficeQueryOptions.enabled`, `useTemplateLayout`, `LabelRendering.whenVisible` (+ the browser implementation), `TemplateThumb`, `TemplatesPage` (thumb + `span.template-name__text`, doc comment), CSS. Every non-mutation anchor matched exactly once (the commit applied by `Edit`, which refuses non-unique anchors).

## Counts

- Baseline before my change: Vitest 58 files / 1386 tests (confirmed).
- Plan's expected totals read 61 lower (shift +61 as the dispatch says): plan 59 files / 1331 tests; tree-adjusted expected 59 / 1392 (1386 + 6 plan tests).
- Measured after: **59 files / 1405 tests** = 1392 + 13 extra tests of mine.
- RED run (plan's Step 2): `Tests  11 failed | 45 passed (56)`, the same eleven tests the plan names (6 new + 5 `names()` tests of `templates-page.test.tsx`). Output in `/tmp/claude/t5-red.txt`.
- GREEN Step 4 files (`template-thumbs`, `templates-page`, `template-editor`), `--reporter=verbose`: 3 files, 166 tests (plan 153 + 13 extras), stderr empty (0 bytes, no `stderr |` blocks). Same files under the delayed-`setImmediate` stand (3 ms): 166 passed, stderr empty; stand files removed.
- `prettier --check` (9 files) clean, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`, `typecheck` 0, `lint` 0, `test` 59 / 1405 green. The three tests that re-render `<Office>` without `labels` (office.test.tsx:151, operators-page.test.tsx:193, users-page.test.tsx:75) pass; they never open «Шаблоны», so the real `IntersectionObserver`-less path is not reached by them.
- `build` not run (task does not touch the shell or embedded dist beyond CSS/TSX, and the rules ask for it only then). Not run: cargo, browser, real IntersectionObserver in a webview (jsdom has none; the real `whenVisible` is tested against a stub class).

## Extra tests (13) and what they pin

In `template-thumbs.test.tsx` (the plan's `screenRows` gained a `watching()` count; `afterEach` also `vi.unstubAllGlobals()`):

1. watches a row until it is on screen and stops once it has come (watcher counts 2 -> 1 -> 0)
2. stops watching the rows that leave: with the search, and with the page
3. reads only the rows that come on screen, each under its own id, among 24 rows (3 shown -> exactly 3 requests, with those ids, not the others)
4. fits the label by the tighter side (pallet 100x150 -> 32x48, `clearRect` size) and draws with the purpose's sample (pallet qty "240 шт.", not the box's)
5. keeps a layout drawn while its row leaves the list with the search and comes back (not read again)
6. puts the layout under the literal key `["office","template-layout",id,60]`, nothing under `officeKeys.template(id)`, summaries without `spec`, exactly one layout in the cache
7. markup-characters test (escapeValue:false), stock+disabled row: name `<img src="x" onerror="alert(1)"> & "q" <b>x</b>` stays one text node (no `img`/`b`, no element children), thumb attributes exactly `aria-hidden`+`class`, canvas attributes exactly `class,height,width`, thumb has no text, name once (no label/title/alt duplicates), «Типовой» once, layout read for a stock/disabled row
8. draws a product duplicate op for op as the station's raster at the thumbnail's scale (reference computed with literal `{kmDataMatrix:"raster"}`)
9. does not paint a duplicate's code after its row has gone (`vi.resetModules()` makes the print-code import real; the page unmounts in a microtask right after `drawLabel`; 600 ms later no black rectangle)
   10-13. the webview's `whenVisible` (real `BROWSER_LABEL_RENDERING.whenVisible`): no observer -> calls at once and the stop is harmless; with an observer -> `{rootMargin:"200px"}`, observes the element, ignores `[]` and not-intersecting entries, on an intersecting entry calls once and disconnects; stop disconnects; and an integration test: no observer, every row reads at once, failed reads leave no alert and no canvas.

## Mutant table

Procedure per mutant (script `/tmp/claude/t5s/mut.py`): copy before, `sha256` before, one-line edit, run the whole `template-thumbs.test.tsx`, restore the copy, `cmp`, `sha256` after. All 31 rows below: restore OK, hash identical (first 12 hex shown only in the script output `/tmp/claude/t5s/mut*.txt`).

Plan's six (all FAIL as the brief expects):

| #   | mutant                              | failing test(s) (plan's one first)                           | key line                                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| M1  | `useTemplateLayout(template, true)` | reads a row's layout once the row is on screen (+ 5 more)    | `expected "vi.fn()" to not be called at all, but actually been called 2 times` |
| M2  | `enabled: true` in `useOfficeQuery` | same                                                         | same                                                                           |
| M3  | key without `rev`                   | keeps a layout by id and revision                            | `expected <canvas …(3)></canvas> to be null`                                   |
| M4  | drop `staleTime: Infinity`          | keeps a layout by id and revision                            | `expected "vi.fn()" to be called 1 times, but got 2 times`                     |
| M5  | drop `aria-hidden`                  | is a picture beside the name that assistive technology skips | `expected null to be 'true'`                                                   |
| M6  | delete `paintCodeRasters` call      | paints a product duplicate's code as the station's raster    | `expected 0 to be greater than 50`                                             |

Mine (each one line; every one failed one or more tests):

| #   | mutant                                                                                                              | killed by                                                | key line                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| X1  | drop `\|\| visible` in the watch effect                                                                             | extra 1                                                  | `expected 2 to be 1`                                                           |
| X2  | `whenVisible(...)` result not returned (no cleanup)                                                                 | extra 1, extra 2                                         | `expected 2 to be 1`                                                           |
| X3  | key without `id`                                                                                                    | plan's «empty frame», plan's «once the row», extras 3, 6 | `expected "vi.fn()" to be called 3 times, but got 1 times`                     |
| X4  | `Math.min` -> `Math.max`                                                                                            | plan test 1, extra 4                                     | `expected '70' to be '64'`                                                     |
| X5  | `BOX_HEIGHT_PX` 48 -> 44 (plan test 1 survives it)                                                                  | extra 4                                                  | `expected '29' to be '32'`                                                     |
| X6  | sample of `"box"` instead of the purpose's                                                                          | plan duplicate test, extra 4, extra 8                    | `expected [ '20 шт.' ] to deeply equal [ '240 шт.' ]`                          |
| X7  | render options of `"box"` instead of the purpose's (plan tests survive: native barcode paints 193 black rects > 50) | extra 8 (and 9)                                          | `expected [ …(208) ] to deeply equal [ …(1021) ]`                              |
| X8  | drop `cancelled = true` in the cleanup                                                                              | extra 9                                                  | `expected [ [ 'fillRect', '#000000' ], …(1007) ] to deeply equal []`           |
| X9  | `entries.some(isIntersecting)` -> `entries.length === 0`                                                            | extra 11                                                 | `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| X10 | drop `observer.disconnect()` in the callback                                                                        | extra 11                                                 | `expected +0 to be 1`                                                          |
| X11 | `rootMargin` 200px -> 0px                                                                                           | extra 11                                                 | `expected { rootMargin: '0px' } to deeply equal { rootMargin: '200px' }`       |
| X12 | stop returns `() => undefined`                                                                                      | extra 12                                                 | `expected +0 to be 1`                                                          |
| X13 | no-observer branch does not call `onVisible`                                                                        | extras 10 and 13                                         | `expected "vi.fn()" to be called 2 times, but got 0 times`                     |
| X14 | name via `dangerouslySetInnerHTML`                                                                                  | extra 7                                                  | `row.querySelector("img, b")` non-null / children length                       |
| X15 | `aria-label={template.name}` on the thumb                                                                           | extra 7                                                  | `expected [ Array(3) ] to deeply equal [ 'aria-hidden', 'class' ]`             |
| X16 | canvas fallback text `{template.name}`                                                                              | extra 7 and 6 others (duplicate name text)               | multiple-elements / text assertions                                            |
| X17 | layout stored under `officeKeys.template(id)`                                                                       | plan cache test, plan revision test, extra 6             | `expected undefined to strictly equal { …(8) }`                                |
| X18 | `readSpec(...)` replaced by a raw cast                                                                              | plan «empty frame»                                       | `TypeError: spec.elements is not iterable`                                     |
| X19 | thumb placed after the name                                                                                         | plan a11y test                                           | `expected undefined to be 'Молоко 58×40'`                                      |
| X20 | drop `template.purpose` from the draw effect's deps                                                                 | SURVIVED                                                 | see below                                                                      |

X20 survived and is argued, not killed: a row keeps one purpose for one id; a change of purpose is a write that gives a new revision, hence a new query key, a new `layout.data` and a new `spec` object, so the effect re-runs through `spec` anyway. `react-hooks/exhaustive-deps` (lint) rejects the omission, so the dependency stays as the brief has it. A reviewer may try to kill it with a rerender that changes only `template.purpose` on the same loaded layout: that cannot happen through `TemplatesPage`.

## Self-review and concerns

- Brief's code used verbatim; nothing beyond the brief's files touched (`template-thumbs.test.tsx` carries all extras).
- `useOfficeQuery` with `enabled:false` still creates a (data-less) cache entry per row; the cache test therefore counts only entries with data. Harmless; entries are per session client.
- Concern, unchanged by me: a failed layout read is not cached (error state), so returning to the page re-reads it once per visible row; no alert, one request per row per visit, no retry loop (`retry:false`).
- Concern, extra 9 depends on `vi.resetModules()` and a 600 ms real wait (about 0.7 s of test time). It kills X8 deterministically here (import resolution is real after the reset); not weakened elsewhere. It resets the module registry for later dynamic imports in that file only.
- Queued items not touched: the preview's old font warning, the font check re-reading font files, the three tests re-rendering `<Office>` without `labels` (they still pass, and my change makes no new reach into real canvas/observer for them).
- `/tmp/claude/t5/` was a shared scratch directory of earlier implementers; before I noticed, I wrote `mut.py`, `before` and `mut1.txt` there (overwriting any files of those names); my scratch afterwards is in `/tmp/claude/t5s/`. Nothing in the repository tree is affected.
- Not verified: a real webview's IntersectionObserver, a visual look at the thumbnail (browser pane not used), `pnpm build`.
