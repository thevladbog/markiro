# Plan 1e4b — final fix wave report

Base HEAD at dispatch: `6b66eb6adb67c10655c0f24c66a0de13b147e6fb`. Status: DONE_WITH_CONCERNS (concerns at the end, all minor).

## Commits

| #   | SHA         | Subject                                                                                         |
| --- | ----------- | ----------------------------------------------------------------------------------------------- |
| 1   | `320b83ec2` | fix(standalone): предупреждение о шрифте — только от своей проверки, удачный ответ запоминается |
| 2   | `8b6c952fd` | fix(standalone): отказ выгрузки кода — над кнопками, общими словами, не при сломанном дубликате |
| 3   | `a3d1065bc` | test(standalone): миниатюры без приведений и без ожидания по времени                            |
| 4   | `0f4967a2a` | test(standalone)+docs(standalone): тихие инструменты в повторных рендерах офиса; документы      |

Each commit message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked with `git log -1 --format=%B`). `git status --short` is empty.

## What changed per item

### Commit 1 — items 4 and 5

- Item 4 (`PreviewPane.tsx`): the font-check effect's cleanup now also does `setCoverage("ok")`. The verdict belongs to the check that produced it. When that check ends (the layout loses its Cyrillic text, or the tools change), the verdict is cleared. A later check shows only its own answer. It is a state write in a cleanup, not a bare `setState` in the effect body. The component docblock says so. The same-check case (one Cyrillic text replaced by another, deps unchanged) keeps its warning.
- Item 5 (`label-rendering.tsx`): `BROWSER_LABEL_RENDERING.checkFamilyCoverage` is now `checkFamilyCoverageOnce`, backed by a module-level `Map<LabelFontFamily, Promise<boolean>>`. A check still running is shared. A rejected one is dropped (`asked.catch(...)`, guarded by identity), so a failed fetch is retried. A fulfilled one stays. `forgetFontCoverageAnswers()` is exported to reset the map in tests.
- Tests (`template-preview.test.tsx`, +5): one stale-warning test and four webview-font-check tests.
  - Stale warning: missing verdict shown; another Cyrillic text keeps it with one check; ASCII then Cyrillic again shows no alert until the second check answers; its answer shows the alert again.
  - Font check, run through the real `BROWSER_LABEL_RENDERING` with a stubbed `fetch` that serves the bundled `.woff` bytes:
    - files are read once however often it is asked;
    - families are kept apart;
    - concurrent asks share one check;
    - a failed check is not kept.

### Commit 2 — items 8, 9, 10

- `ru.json` `codeFailed` is now «Файл не собран. Попробуйте ещё раз.», one neutral text for every failure.
- `TemplateEditor.tsx`: the alert is rendered above the actions row and only while `codeFailed && !duplicateInvalid`. I also corrected the code comment above `downloadCode`, which said «what a station would send to its printer», to say «a printer of the layout's own resolution».
- Item 10: the repeat-press test is renamed «marks only «%s» as busy while its file is being made, and starts nothing when pressed again». I did NOT add a same-`act` double-click test. Inside one `act` the buttons are not yet disabled in the DOM, so the second click would start a second file. That is a real property of the current guard (a browser flushes a discrete click before the next one), and the review said to rename and not to add a ref. I recorded the reasoning in the commit message.
- Tests (+1): the alert is gone while the duplicate breaks its rule. Existing failure tests now check the exact wording and that the alert comes before the ZPL and JSON buttons, for both failure kinds (generator error and chunk-load failure).

### Commit 3 — items 11, 12, Minor 3 (`template-thumbs.test.tsx`)

- Casts removed. `FakeObserver implements IntersectionObserver` has `root`, `rootMargin`, `scrollMargin` (the installed `lib.dom` requires it), `thresholds`, `observe`, `unobserve`, `disconnect` and `takeRecords`. `entry(isIntersecting, target)` builds a full `IntersectionObserverEntry`. The callback gets the fake observer instance as its second argument. No `as` remains in the file (grep).
- The 600 ms wait and `vi.resetModules()` are gone (Minor 3). The test now awaits the same `import("../src/office/templates/label-print.js")` inside `act`, then `setTimeout(0)`.

### Commit 4 — item 6, item 2, documents

- Item 6: the three `rerender(<Office …/>)` calls (`office.test.tsx`, `operators-page.test.tsx`, `users-page.test.tsx`) pass `labels={quietLabelRendering()}`.
- Item 2: `label-raster.test.ts` saves the `getContext` descriptor in `beforeEach` (throws if `test/setup.ts` left none) and restores it unconditionally in `afterEach`. I added a two-test pair, so the restore is observable.
- Same pattern in `template-preview.test.tsx` `installWebviewCanvas` (the report's item 2 row names it). It throws when nothing was saved and restores unconditionally. This file was not on commit 4's list in the brief. I included it because the report's triage names it and commit 1 already touched the file; say if you want it split out.
- Documents, `apps/standalone/AGENTS.md` and the spec §5.5 (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`):
  - «what a station would send» now carries «at the layout's own resolution». The cloud station prints at its printer's dpi (`withPrinterDpi`, `apps/station/src/lib/print-label.ts`), and the same qualifier is added for the preview's bitmaps.
  - Main chunk figure «near 873 kB» → «near 876 kB».
  - The sentence «a warning from an earlier check may show again…» is replaced by the new behaviour: the warning is the answer of the running check, a successful answer is kept per family, a failed one is not.
  - The alert text, its placement above the buttons, and its absence while the duplicate is broken.
- AGENTS.md added lines are ≤ 78 columns, with no backtick span split. The spec lines are ≤ 91 characters (neighbouring lines are 80–88). The plan file is untouched.

## RED / GREEN

- Commit 1 RED, with the two source files reverted to HEAD and the tests in place: `vitest run test/template-preview.test.tsx` gave 5 failed, 19 passed. The stale-warning test failed with `expected <div role="alert" …> to be null`. The four font-check tests failed with `forgetFontCoverageAnswers is not a function` (the export did not exist yet). The mutants below show the memo guards fail for behavioural reasons. GREEN: 24/24.
- Commit 2 RED, with the tests updated and the source at HEAD: 3 failed, 11 passed. Two failed on the old wording (`expected '✕Файл не собран: русский текст этикет…' to be …`), one on the missing new alert. GREEN: 14/14.
- Commits 3 and 4 are test-only or docs. There is no RED for the restructure. The proof is the mutants below, plus 19/19 and 29/29 green.

## Mutants (each restored byte-identically: `cmp` silent, sha256 equal before and after)

| Mutant (one line unless noted)                                                                                                   | Killed by                                                                                               | sha256 prefix before = after |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `PreviewPane.tsx`: remove `setCoverage("ok")` from the check cleanup                                                             | «shows no warning of an earlier check for a layout whose own check has not answered»                    | `9164ec0d3c69`               |
| `label-rendering.tsx`: remove `coverageAnswers.set(family, asked)`                                                               | 4 tests: reads once; apart by family; shares one check; does not keep a failed check                    | `ea4d4b52fe4b`               |
| `label-rendering.tsx`: remove the delete on rejection                                                                            | «does not keep a check that failed: the next ask reads the files again»                                 | `ea4d4b52fe4b`               |
| `label-rendering.tsx`: `coverageAnswers.get(family)` → `.get("IBM Plex Sans")`                                                   | «keeps the answers apart by family»                                                                     | `ea4d4b52fe4b`               |
| `TemplateEditor.tsx`: `codeFailed && !duplicateInvalid` → `codeFailed`                                                           | «leaves the failure notice out while the duplicate breaks its rule…»                                    | `943b5d8f6e12`               |
| `TemplateEditor.tsx`: alert block moved below the buttons (scripted multi-line move)                                             | both failure tests via the `isBefore` assertions (2 failed)                                             | `943b5d8f…`                  |
| Old wording: the RED run of commit 2 shows both wording tests failing                                                            | see RED above                                                                                           | —                            |
| `TemplateThumb.tsx`: `() => cancelled` → `() => false`, run 3 times plain, once under the stand, once with the test alone (`-t`) | «does not paint a duplicate's code after its row has gone», every time, no timing dependence            | `04dbe943abf3`               |
| `label-rendering.tsx`: `entries.some((e) => e.isIntersecting)` → `entries.length === 0`                                          | «watches the element 200 px ahead, ignores what is not on screen…»                                      | `ea4d4b52fe4b`               |
| `label-raster.test.ts`: drop the unconditional restore in `afterEach`                                                            | the new «are gone again in the next test…» (the mutant first passed all 27 tests, so I added that pair) | `3f0d762e8ae7`               |

Not mutated, with the reason:

- The `throw` when no descriptor was saved (item 2 and the preview helper) cannot fire while `test/setup.ts` defines the property. I mutated it to `return`: all 27 tests passed. This is a trap guard with no test-visible effect today, not an equivalence I argue away.
- Item 6 (quiet `labels` in three re-renders) adds no guard. It only stops the real webview tools being used silently. Nothing observable changes either way, as the review said ("harmless today").

## Checks

- After each commit: `prettier --check` on the changed files, `git diff --check`, and the `\u04` grep (only `src/host/pairing-code.ts:66`). Also typecheck and lint for each commit, all exit 0.
- Focused files with `--reporter=verbose`: stderr empty, no `act` warnings.
- Delayed-`setImmediate` stand (stand files created and removed around each run, none in the tree):
  - `template-preview` 24/24;
  - `template-code-downloads` 14/14;
  - `template-thumbs` 19/19, correct code, and the mutant under the stand fails;
  - the commit-4 set (`office`, `operators-page`, `users-page`, `label-raster`, `template-preview`) 111/111.
- Whole package: `test` 59 files / 1418 tests passed (baseline 1410, +8: +5 preview, +1 downloads, +2 label-raster). `typecheck` 0, `lint` 0, `build` 0.
- Build chunks: `index` 875.93 kB, `bwip-js-gen` 925.37 kB, `font-coverage` 237.41 kB, `label-print` 7.16 kB, CSS 44.08 kB. The main chunk is still about 876 kB.
- `git diff --stat 6b66eb6ad -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri pnpm-lock.yaml apps/standalone/package.json` is empty.
- Not run: cargo (no Rust changed), `production-browser` suites, and anything needing a real window, Windows, a printer or `<a download>` in the webview. The review's list in (d) still stands.

## Decided differently, concerns

1. The font verdict is cleared in the effect cleanup (`setCoverage("ok")`). It is not keyed by a check number, as the review proposed. The effect is the single owner of the check's lifetime, and the cleanup runs on every path that ends it. If a reviewer dislikes a state write in a cleanup, the alternative is `{ for: token, value }` with a ref.
2. Item 10: no same-`act` double-press test. Reason above: the current guard would fail it, and the review said not to add a ref.
3. `template-preview.test.tsx` `installWebviewCanvas` is hardened in commit 4, beyond the brief's file list (the report's item 2 row names it).
4. The new `label-raster` pair of tests depends on file order (the second looks at what the first left). Vitest runs a file's tests in order, and a comment says so. If that coupling is unwanted, drop the pair, and the restore then has no test-visible guard.
5. The documents were edited in commit 4 as the brief says, so after commits 1 and 2 the AGENTS/spec sentences were stale until commit 4. This is not a problem at the HEAD of the series.
6. The plan file was not edited. The controller still has to write «Отклонения при исполнении»/«Перенесено» from the review's section (c).
