# Plan 1e4 (part 1e4a) — final fix wave: report

Work tree `ecstatic-swirles-7f0ae8`, branch `claude/autonomous-desktop-station-9e6f13`. HEAD at dispatch `7dc6d54b9`; HEAD now `64ba912c1`.

**Status: DONE_WITH_CONCERNS** (concerns at the end: three deviations from the brief, all argued, and the unverified live surfaces).

## Commits

| #   | SHA         | Subject                                                                                                    |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `75ade8b15` | test(standalone): тесты редактора — без приведения, без формулировок V8 и с подписанными случаями          |
| 2   | `d1f6eb1cf` | fix(standalone): запись в редакторе — уход во время сохранения, повторная загрузка и товары после удаления |
| 3   | `ba43c407b` | fix(standalone): редактор измеряет макет до сохранения                                                     |
| 4   | `13c667735` | fix(standalone): доступность редактора и импорта                                                           |
| 5   | `64ba912c1` | docs(standalone): итоговая волна плана 1e4a — AGENTS.md и спецификация §5.5                                |

Each commit message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked with `git log -1 --format=%B | grep -c`: 1 for all five).

## Counts

- Baseline: Vitest 53 files / 1259 tests.
- After commit 1: 54 / 1273 (+14). After commit 2: 54 / 1278 (+5). After commit 3: 54 / 1290 (+12). After commit 4: 54 / 1293 (+3). Final: **54 files / 1293 tests, all green** (+1 file, +34 tests).
- `pnpm … typecheck` 0, `lint` 0 at every commit and at the end. `prettier --check` (via `rtk proxy`, because the plain `rtk prettier` output is unreliable) clean on every changed file. `git diff --check` clean.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- `git diff --stat 7dc6d54b9 -- apps/station packages apps/standalone/host apps/standalone/proto apps/standalone/src-tauri pnpm-lock.yaml apps/standalone/package.json`: empty.
- Delayed-`setImmediate` stand (3 ms) after each commit on the touched files plus neighbours: commit 1 five files / 134 tests; commit 2 four files / 212; commit 3 three files / 122; commit 4 four files / 209; all green. Both stand files deleted after each run; `git status --short` empty after each commit.
- Verbose runs of the touched files: stderr empty (no `act(...)` warnings, no unhandled rejections).
- No cargo (no Rust touched), no browser, no hardware.

## What changed per item

### Commit 1 (tests, titles, one comment)

- **1 + 6**: new `test/domain-internal-errors.test.ts` with `vi.mock("@markiro/domain", …)`: `assertDuplicateTemplate` and `parseLabelCode` throw `TypeError`. Tests: `duplicateLayoutInvalid(BLANK_SPEC, "product_duplicate")` → `toThrow(TypeError)`; the other purposes still `false`; `analyzeImport` ZPL and TSPL → `toThrow(TypeError)`. The only cast in `apps/standalone` (`null as unknown as string`) is gone with its test in `import-analysis.test.ts`.
- **7**: `import-code-dialog.test.tsx` carries the markup through the domain's message: ZPL `^FD{{<b>x</b>}}^FS` → `unknown label field placeholder "<b>x</b>"`; no V8 wording left.
- **16**: `restoreBlobUrls` is run by a file-level `afterEach`; the three `urls.restore()` calls are gone. Finding while doing it: Node's `URL` has a native `createObjectURL`, so the old `Reflect.deleteProperty` restore removed it for good (not "restored" jsdom's absence). The helper now captures the own property descriptors and puts them back, and `recordBlobUrls` first asserts that the environment's `createObjectURL`/`revokeObjectURL` are the ones seen at module load (a leaked stub fails loudly). New test «moves the focus to the name or the categories the host refuses» (host `field: "name"` and `field: "chzProductGroupCodes"`; the control is not focused before the save).
- **19**: the size dialog's alert is asserted by its text (`within(alert).getByText(…)`), without the glyph.
- **22 + 25**: `it.each` for the looped tests (roles ×3: new template, opening an edit, copy/delete; cases ×2: pages that cannot show the editor, copy pages that cannot open the source; the last «down» tail of the copy test became its own `it`). Titles carry `$role` / `$case`.
- **29**: `byNameThenId` unit tests in `records.test.tsx` (reflexive 0 for the same and an equal record; id tie-break both ways with `Math.sign`; name outranks id; numeric collation).
- **31**: comment of `templateOptions` rewrapped.

### Commit 2 (editor write path)

- **26 + N1**: `mounted` ref (set in an effect, cleared on unmount); `backToList` still drops the templates list (the write landed), then returns when not mounted, so no navigation and no notice. «Копировать» and «Удалить» are `disabled={saving}`; «К шаблонам» stays on.
- **13**: `if (duplicateInvalid) return;` at the top of `submit`; tested with `form.requestSubmit()` on an invalid duplicate (the button is disabled, the form is still submitted).
- **20**: `OpenedTemplate` checks `!template.isFetchedAfterMount` → `PageLoading` before the error branch (the later `data === undefined` check stays).
- **24**: `onDeleted` also removes the exact `officeKeys.products` query before `backToList`.
- **11**: dropped, line untouched (no `replace: true`).

### Commit 3 (item 10)

- `editor-model.ts`: `MAX_SPEC_BYTES = 256 * 1024`, `specBytes(spec)` (`new TextEncoder().encode(JSON.stringify(spec)).length`), `specTooLarge(spec)` (`> MAX_SPEC_BYTES`, the limit itself passes, as `validate::template_spec`'s `text.len() > MAX_SPEC_BYTES`).
- `TemplateEditor.submit`: after `checkedSpec`, before the write, `specTooLarge(spec)` → alert `office.templateEditor.errors.specTooLarge` («Макет больше 256 КБ: хост его не примет. Сократите тексты или импортируйте код поменьше.»). Both create (copy) and update paths.
- `errors.specRejected` reworded without «64 уровней» («Хост не принял макет: он больше 256 КБ. Сократите тексты или импортируйте код поменьше.»); the host mapping in `editor-failure.ts` stays as backstop (its doc comment says so).
- Tests: model (exact byte counts incl. Cyrillic, euro sign, emoji, escaped quote and backslash; exact-size layout builder; boundary MAX−1/MAX/MAX+1; Cyrillic under 256 K characters but over 256 KB; the schema-made layout is what is measured) and editor (one byte over, Cyrillic one byte over, Cyrillic double → alert, nothing sent, button back on; exactly 256 KB and Cyrillic exactly 256 KB → sent, `specBytes(sent) === MAX`; copy of an oversize layout → alert, `createTemplate` not called).

### Commit 4 (accessibility)

- **5**: the result is always inside an `aria-live="polite"` wrapper (`template-import__analysis`), content conditional inside.
- **15**: the refusal focus target gets `role="group"` and `aria-label={t("office.templateEditor.categories")}`. Deviation: `aria-labelledby` is not possible, `Card` (`packages/ui`, off limits) gives its heading no id. The existing focus test now finds the target by role and name, so it still checks the focus.
- **4**: `style={{ font: "var(--text-code)" }}` on the code `Textarea` (`--text-code` exists in `packages/ui/src/tokens.css:191`), dead `font-family` line deleted in `shell.css`. jsdom cannot show a rendered font: the test asserts only the inline `style.font`.
- **12**: `NavLink` without `end` (see deviations), test for «Шаблоны» on the list, `/templates/new`, `/templates/:id`, `/templates/:id/copy`, «Умолчания шаблонов» only on its own page, «Обзор» only on `/`.

### Commit 5 (documents)

`apps/standalone/AGENTS.md` «Office pages» and spec §5.5: the highlight sentence, the 256 KB sentence, products read after a delete, header buttons off during a save, answer after leaving through the menu, `requestSubmit` guard, «Загрузка…» instead of an earlier failure. AGENTS.md wrapped at 77 (matches the existing greedy wrap, max 77 ≤ 80), spec at 86 (max 86, as before); no backtick span split (checked per line); `prettier --check` clean. The plan file is untouched.

## RED / GREEN

Commit 1 is tests only: its "RED" is the mutant table. Commits 2–4 were written test first and run on the old code:

- Commit 2 RED (5 failures on the untouched source): `createTemplate` "called 1 times" for the `requestSubmit` test; «Загрузка…» not found for the reopening test and for the products test; `heading "Товары"` not found (the late save pulled the user back to «Шаблоны») for the leave test; `disabled` not true for «Копировать». GREEN: 88 tests in `template-editor.test.tsx`.
- Commit 3 RED: `TypeError: specBytes is not a function` (model file, 6 tests) and the editor file failing at collection with the same error; GREEN 122 tests in three files.
- Commit 4 RED (5 failures): live region not among the earlier regions; `style.font` was `var(--text-body)`; `role="group"` named «Категории» not found (two tests); `aria-current` list `[]` instead of `["Шаблоны"]` on `/templates/new`. GREEN 209 tests in four files.

## Mutant table (each: copy to `/tmp/claude/fix1/` first, `shasum -a 256` before/after, `cmp` against the copy; all restores identical, `git status` as expected after each)

| Mutant                                                                               | Test that failed                                                                               | Key line                                                                                                             |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| m1 `throw error;` → `return true;` (`duplicateLayoutInvalid`)                        | domain-internal-errors «is not taken for an invalid duplicate layout»                          | expected function to throw an error, but it didn't                                                                   |
| m2 drop `if (!(error instanceof DomainError)) throw error;` (`analyzeImport`)        | domain-internal-errors «…when ZPL or TSPL is checked»                                          | AssertionError: zpl                                                                                                  |
| m3 error message rendered with `dangerouslySetInnerHTML`                             | import-code-dialog «renders imported code, names and messages as text»                         | expected '✕Код не разобран: unknown label field…' to contain 'unknown label field placeholder "<b>x…'                |
| m4a/m4b focus target always `scopeId` / always `nameId`                              | editor «moves the focus to the name or the categories the host refuses»                        | expected `<div id=…-scope>` to be `<input id=…-name>` and the reverse                                                |
| m5 drop `restoreBlobUrls?.()` in the `afterEach`                                     | the two later blob tests                                                                       | expected [Function value] to be [Function createObjectURL]                                                           |
| m5b restore by `Reflect.deleteProperty` (the old way)                                | same two tests                                                                                 | expected [Function createObjectURL] to be [Function createObjectURL] (a different function: the native one was gone) |
| m6a `(a.id < b.id ? -1 : 1)` (the surviving mutant of item 29)                       | records «byNameThenId … is zero for a record against itself…»                                  | expected 1 to be +0                                                                                                  |
| m6b drop the id tie-break                                                            | records «puts equal names in the order of their ids…» and activeFirstByName tie test           | expected +0 to be -1                                                                                                 |
| m6c swap the id signs                                                                | same two                                                                                       | expected 1 to be -1                                                                                                  |
| m6d reverse the name comparison                                                      | byNameThenId name test, three activeFirstByName tests                                          | expected 1 to be -1 …                                                                                                |
| n1 drop `if (!mounted.current) return;`                                              | «stays where the user went when a save lands after the editor was left…»                       | heading "Товары" not found                                                                                           |
| n2 `mounted` check before `removeQueries`                                            | same                                                                                           | «Загрузка…» not found (old rows shown)                                                                               |
| n3 drop `disabled={saving}` on «Копировать»                                          | «keeps «Копировать» and «Удалить» off while a save…»                                           | disabled not true                                                                                                    |
| n4 drop `disabled={saving}` on «Удалить»                                             | same                                                                                           | disabled not true                                                                                                    |
| n5 drop `if (duplicateInvalid) return;`                                              | «sends nothing for a product duplicate… without its button»                                    | `createTemplate` called 1 times                                                                                      |
| n6 drop `if (!template.isFetchedAfterMount) return <PageLoading />;`                 | «shows «Загрузка…», not the earlier failure…» and «reads the template again on every opening…» | «Загрузка…» not found                                                                                                |
| n7 drop the products `removeQueries`                                                 | «reads the products again after a delete…»                                                     | «Загрузка…» not found                                                                                                |
| p1 `>` → `>=` in `specTooLarge`                                                      | model «finds a layout too large…», Cyrillic test; editor «is sent as it is» ×2                 | `createTemplate`/`updateTemplate` called 0 times                                                                     |
| p2 `> MAX` → `> MAX + 1`                                                             | model ×2; editor «is explained with a remedy…» ×2 and the copy test                            | expected '✕Что-то пошло не так…' to contain 'Макет больше 256 КБ…'                                                   |
| p3 count characters, not bytes (`JSON.stringify(spec).length`)                       | model: UTF-8 bytes, exact-size builder, Cyrillic; editor Cyrillic over-limit                   | expected 1 to be 2                                                                                                   |
| p4 `specTooLarge(spec) && false`                                                     | the 4 refusal tests                                                                            | expected '✕Что-то пошло не так…' to contain 'Макет больше 256 КБ…'                                                   |
| p5 check only on update (`template !== null && …`)                                   | «is explained when a copy of it is created…»                                                   | same                                                                                                                 |
| q1a drop `aria-live` from the wrapper                                                | «announces the check in a live region that is already on the page»                             | expected null not to be null                                                                                         |
| q1b `key={String(analysis !== null)}` (the region remounts with its text, as before) | same                                                                                           | expected [ … ] to include `<div><strong>`                                                                            |
| q2 drop the inline code font                                                         | «sets the code in the code font…»                                                              | expected 'var(--text-body)' to be 'var(--text-code)'                                                                 |
| q3a / q3b drop `role="group"` / drop the `aria-label`                                | both focus tests                                                                               | Unable to find role "group" and name «Категории»                                                                     |
| q4c add `end` back to the `NavLink`                                                  | «marks «Шаблоны» in the menu on the editor's pages…»                                           | expected [] to deeply equal ['Шаблоны']                                                                              |

Not mutant-guarded, with the reason: the deleted `font-family` line in `shell.css` (CSS; dead code before and after, no test can observe it); the glyph-free assertion of item 19 and the `it.each` relabelling (they weaken nothing and add no guard); the editor/doc text changes.

**Equivalent mutant, argued (the only one):** `end={item.to === "/"}` versus no `end` at all. In react-router 8.3.0 `NavLink` (`dist/development/lib/dom/lib.js:387-388`) `endSlashPosition` is `toPathname.length` for `/`, i.e. 1, and a location is active when `locationPathname.charAt(1) === "/"`; no location of the office has `//` after the root, so `/` is active only on `/` with or without `end`. A mutant `end={false}` (what I first tried as «never `end`») therefore survived, and I did not keep the brief's expression: see below.

## Deviations from the brief (decided, with reasons)

1. **Item 12**: no `end` at all instead of `end={item.to === "/"}`. The brief's form is behaviourally identical (argued above) but leaves an equivalent mutant; dropping `end` is simpler and the test (with the «Обзор only on /» assertion) guards the router's behaviour. The test kills «add `end` back» (q4c).
2. **Item 15**: `aria-label` (same ru key as the card heading) instead of `aria-labelledby`, because the Card's heading has no id and `packages/ui` is off limits. The group is still named like its card.
3. **Item 19**: only the assertion the queue names was changed. The same glyph-coupled pattern (`"✕…"`, `"⧉…"` in `textContent` checks) is used by many other assertions in `template-editor.test.tsx` and `import-code-dialog.test.tsx`; I left them (brittle against an icon change, but not part of this item).
4. Item 16 went a bit further than asked (descriptor-exact restore plus a leak assertion) because the plain «move into `afterEach`» would have kept the old deleting restore, which I found removes Node's native `URL.createObjectURL` for the rest of the file.
5. Item 5: the wrapper is a `div.template-import__analysis` (a grid with `gap: 12px`), so when empty it adds one 12 px grid gap at the bottom of the source column. I did not hide it (`display: none` would take the live region out of the accessibility tree); not looked at in a browser.

## Concerns / not verified

- No browser, Tauri webview, WebView2, Windows, screen reader or live host was exercised (the repository's report rules): the live region announcement, the group's focus announcement, the code font rendering, the sidebar highlight and the 12 px empty-wrapper gap are verified in jsdom only, as DOM facts.
- The byte count equals the host's `serde_json::to_string` length by argument (report seam 1), not measured against a running host.
- I ran one `cd /tmp/claude` inside a single Bash call by mistake (the mutant helper then failed with «No projects found» and nothing was touched); no stray `.claude/.cc-writes` under the repository (`git status` clean at every step).
- Carried as the review decided: items 8, 14, 18, 23, 27 and N3. Dropped: 2, 3, 9, 11, 17, 21, 28, 30.
- `graphify update .` was not run (nothing in the brief asks for it; the graph is ignored by Git).

## Fix round 1

Base: `64ba912c1`. Finding: Minor 1 (a list page left for during a save stayed stale after the save landed).

**Change.** `TemplateEditor.tsx` `backToList`: `removeQueries({ queryKey: officeKeys.templates, exact: true })` became `void queryClient.resetQueries(...)` (comment updated). It was the only `removeQueries` on `officeKeys.templates` in `src`; the other one (`officeKeys.products` after a delete) runs under the modal delete dialog, so no products page can be mounted then, and it is unchanged. `apps/standalone/AGENTS.md` (editor paragraph): «dropped all the same» became «reset all the same, with `resetQueries`, so a list page the user left for meanwhile reads it again». Spec §5.5 already says «сбрасывается», so it is unchanged.

**Test.** `test/template-editor.test.tsx`, `it.each` of two cases (leave through «К шаблонам», leave through the menu's «Шаблоны»): save held, leave and confirm, list page on screen shows the old row, then the save resolves; expects the new row, the old row gone, exactly one more `listTemplates` call, and no notice.

**RED.** On the previous code: both cases fail, `Unable to find an element with the text: Молоко 60×40`.
**GREEN.** `template-editor.test.tsx` verbose: 97 passed, stderr empty (0 bytes); under the delayed-`setImmediate` stand: 97 passed, stderr empty (stand files removed).

**Mutant.** `resetQueries` replaced by `removeQueries` (one line): both new tests fail with the same message, 95 others pass. Restore: sha256 before and after `db8921e5e59df50d273cd1ddb829b78dbc4669e79110996dd28bbf223650e0a5`, `cmp` against `/tmp/claude/TE.fixed` identical.

**Gates.** typecheck, lint exit 0; whole package 54 files / 1295 tests (1293 + 2); prettier --check clean; `git diff --check` clean; `\u04` grep only `src/host/pairing-code.ts:66`; the existing tests that the list is dropped/read again pass unchanged.
