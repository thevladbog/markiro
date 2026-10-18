# Plan 1e3, Task 5 report: «Шаблоны» — категории шаблона на `CategoryScopeField` (D6)

Status: DONE_WITH_CONCERNS (nothing blocks; two UX observations and unverified layout, see «Concerns»).
Commit: `89bfe7649 feat(standalone): «Шаблоны» — категории шаблона на CategoryScopeField` (base `ba4ccd076`; exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, verified with `git log -1 --format=%B`; `git status --short` empty after the commit).
Tests: whole suite 45 files, 1041 tests (baseline 1017 confirmed + 8 + 5 plan + 5 + 6 own); `test/category-scope-field.test.tsx` 13 (8 plan + 5 own); `test/templates-page.test.tsx` 46 (35 before + 5 plan + 6 own). Typecheck 0, lint 0, prettier clean, `git diff --check` clean.

## What changed (behavior)

- `category-scope.ts` (new): `scopeOf`, `scopeCodes` (`null` for every category, else a sorted copy, ascending), `sameCategories` (same categories in any order, `null` is every category), `visibleGroups` (case-insensitive search over names, trimmed, Russian order with numbers by value).
- `CategoryScopeField.tsx` (new, reusable; plan 1e4 takes it too): radio «Все категории» / «Только выбранные»; with the second, a live-region counter («Выбрано: N», `aria-live="polite"`), a search and one checkbox per group by name. The codes stay while «Все категории» is picked; while the lookup loads the field says so, when it failed it shows an error alert with «Повторить»; neither case loses the codes. The error handed in by the consumer goes under the choice via `errorProp`.
- `TemplateCategoriesDialog.tsx` (new): `templateUpdate(row, { chzProductGroupCodes })` with the OPENED row's revision; «Сохранить» is off while `sameCategories(codes, row)`; «Только выбранные» with no category sets the field's error and sends nothing; the write sits alone in `try`, `onSaved` after `try/catch`, the `catch` ends with `return`; `TemplateFailureAlert` (Task 4) explains `template_is_default` in the switch's words, `stale_revision` offers «Загрузить заново».
- `TemplatesPage`: the actions cell is a `RowActions` with the switch first and «Категории» second (`kind: "state" | "categories"`); the saved answer merges into the cached row in place and a notice «Категории шаблона «…» сохранены.» shows.
- `ru.json`: 5 keys `office.templates.*` and the group `office.categoryScope` (10 keys) exactly as the brief gives them (duplicate-key scan of the JSON: none). `shell.css`: `.category-scope`, `.category-scope__list`.
- Docs: `apps/standalone/AGENTS.md` («Office pages») and spec §5.5 applied verbatim, then both items re-read whole (see «Docs»).

The brief's blocks were applied mechanically by a script that asserted each fragment matched exactly once (all 12 anchors of Steps 1, 3 and 6 matched once at the start; the controller's patched test anchor included), so the code is verbatim; my extras and one edited test were added with the Edit tool.

## Counts: as the brief says, as measured

|                    | brief says                                     | measured                                                         | cause                                                   |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| baseline           | 44 files, 1017 (controller)                    | 44 files, 1017                                                   | confirmed before any edit                               |
| Step 2 RED         | `5 failed \| 22 passed (27)` for the page file | `5 failed \| 35 passed (40)` (field file fails to load, 0 tests) | the page file has 35 tests before this task             |
| Step 4 GREEN       | 35 (field 8 + page 27)                         | 48 (8 + 40), then 59 with my extras (13 + 46)                    | +13 in the page file                                    |
| Step 7 whole suite | 45 files, 1012                                 | 45 files, 1030 before extras, 1041 with                          | +18 earlier (Task 2: 5, Task 3: 8, Task 4: 5), +11 mine |
| mutants 1, 2, 8    | `2 failed \| 33 passed (35)`                   | `2 failed \| 46 passed (48)`                                     | same +13                                                |

RED wording differs in one place: the first unresolved import Vite names is `../src/office/templates/CategoryScopeField.js` (the brief says `category-scope.js`); both files are missing, Vite reports one.

## RED / GREEN evidence

- RED (`vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx` after Step 1, before Step 3): `Test Files 2 failed`, `Tests 5 failed | 35 passed (40)`; the five failures are `Unable to find an accessible element with the role "button" and name "Категории шаблона «…»"` (Коробка 100×100, Молоко 58×40 twice, Коробка 58×40, Обратный порядок).
- GREEN after Step 3, first run: `Tests 1 failed | 47 passed (48)`: the Task 4 extra «says the action in each button's own text…» threw `TestingLibraryElementError: Found multiple elements with the role "button"` (the known break). After the fix: `Test Files 2 passed (2)`, `Tests 48 passed (48)`. No other Task 3 or Task 4 test failed.
- Hygiene on the final files: `--reporter=verbose` 59 passed, stderr empty (0 `stderr |` blocks, 0 `act(...)`, 0 unhandled); the delayed-`setImmediate` stand (the plan's two temporary files) 59 passed twice, stderr empty (earlier also on the plan-only state: 48 passed); stand files deleted, `git status --short` empty at commit.
- Whole suite after the last edit: `Test Files 45 passed (45)`, `Tests 1041 passed (1041)`.

## Edited test (count unchanged)

One Task 4 extra: «says the action in each button's own text, which its accessible name starts with, as a compact secondary button». It took the row's only button with `getByRole("button")`; it now takes `getByRole("button", { name: new RegExp(`^${label}`) })` (the state button's name starts with «Выключить»/«Включить») plus a one-line comment. Every assertion stays (text equals the label, exact `aria-label`, `mk-btn--secondary`, `mk-btn--compact`). I checked the other Task 3/4 tests that look at the actions cell: «titles the seven columns…» and «…the button stays on one line» count cells, not buttons, and stay correct; the both-roles test finds buttons by name.

## Mutant table

Procedure for every run: `cp` of the file, `sha256`, the fragment must match exactly once (the harness aborts otherwise), one-line mutation (a few are two-line edits), Vitest, restore with `cp`, `cmp` (silent) and `sha256` again. Every one of the 84 runs below (10 plan + 37 own against the plan-only tests + 37 own against the final tests) reported `cmp=ok` and equal hashes; the files' sha256 prefixes: `category-scope.ts 42dca17fb478`, `CategoryScopeField.tsx 04a77800bbd1`, `TemplateCategoriesDialog.tsx b3dd9e804b9c`, `TemplatesPage.tsx 1cc6af5f2354`, `access.ts 59dbfd0fc479`; the two test files were swapped for plan-only copies during one batch and came back with the hashes they had (`0c80498c38a2`, `7db5201edc7b`), and the index matched the tree again. Harness and logs: `$TMPDIR/t5/` (outside the tree).

### The plan's ten (brief's `-t` filters, before my extras; all killed with the messages the brief names, counts +13)

| #   | mutant                           | failing tests                                                                    | key line                                                                                                                                                                                       |
| --- | -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `[...scope.codes]` (no sort)     | field «sends null…» and page «narrows a template…»                               | `expected [ 13, 100, 8 ] to strictly equal [ 8, 13, 100 ]`; `expected [ [ 'office-session-token', …(2) ] ] to strictly equal …`                                                                |
| 2   | order-sensitive `sameCategories` | field «sends null…», page «asks for at least one category…»                      | `expected false to be true`; `expected <button type="submit" …(3)></button> to have property "disabled" with value true`                                                                       |
| 3   | empty-choice guard deleted       | page «asks for at least one category…»                                           | `Unable to find an element with the text: Выберите хотя бы одну категорию или переключитесь на «Все категории».`                                                                               |
| 4   | `setScopeError(null)` dropped    | same                                                                             | `expected <span …(2)></span> to be null`                                                                                                                                                       |
| 5   | radio flipped                    | field «offers every category…», «keeps the chosen codes…»                        | `expected [ { mode: 'all', codes: [] } ] to strictly equal [ { mode: 'selected', codes: [] } ]`; `expected { mode: 'selected', codes: [ 8 ] } to strictly equal { mode: 'all', codes: [ 8 ] }` |
| 6   | checkbox replaces the choice     | field «checks the template's categories…»                                        | `expected { mode: 'selected', codes: [ 8 ] } to strictly equal { mode: 'selected', codes: [ 13, 8 ] }`                                                                                         |
| 7   | `codes: []` on «Все категории»   | field «keeps the chosen codes…»                                                  | `expected { codes: [], mode: 'all' } to strictly equal { mode: 'all', codes: [ 8 ] }`                                                                                                          |
| 8   | `{...errorProp(error)}` deleted  | field «shows an error under the choice…», page «asks for at least one category…» | `Unable to find an element with the text: Выберите хотя бы одну категорию` (and the longer text)                                                                                               |
| 9   | `submitDisabled={false}`         | page «asks for at least one category…»                                           | `expected <button type="submit" …(3)></button> to have property "disabled" with value true`                                                                                                    |
| 10  | `aria-live` removed              | field «offers every category…»                                                   | `expected null to be 'polite'`                                                                                                                                                                 |

### My own 37 mutants (against the plan-only tests, then against the final tests)

For «the plan's tests» I built the plan-only state mechanically: the brief's field file, HEAD's page file with the brief's fragment applied and the one-line fix of the Task 4 test (48 tests); the final state is the committed one (59).

Killed by the plan's tests already (17): `CS-empty-selection-is-null` (empty choice becomes `null`), `CS-length-check-dropped`, `CS-no-sort-at-all`, `CS-startsWith`, `F-prepend-code`, `F-count-from-shown`, `F-count-from-all-groups`, `F-toggle-leaves-selected-mode`, `F-search-ignored-in-field`, `D-disabled-on-raw-codes`, `D-sends-raw-codes`, `D-groups-undefined`, `D-reload-is-close`, `P-notice-as-html` (by Task 4's markup test), `P-state-kind-for-categories`, `P-notice-key`, `A-admin-cannot-edit-catalog` (`editCatalog: ["technologist"]`, by Task 4's both-roles test).

Survived the plan's tests (20): 19 killed by new tests, 1 equivalent.

| mutant                                                                                                                                                 | new test that kills it                                                                                                                        | key line (final run)                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CS-sort-by-code` (`.sort((a, b) => a.code - b.code)`: the plan's fixture has names in code order)                                                     | field «orders the groups by name in Russian order with numbers by value, whatever their codes»                                                | `expected [ 'Ёж', 'Группа 9', 'Елка', …(2) ] to strictly equal [ 'Группа 9', 'Группа 10', 'Ёж', …(2) ]`                                                                           |
| `CS-collator-not-numeric`                                                                                                                              | same                                                                                                                                          | `expected [ 'Группа 10', 'Группа 9', 'Ёж', …(2) ] to strictly equal …`                                                                                                            |
| `F-failed-alert-warn`, `F-retry-primary`, `F-retry-md`                                                                                                 | field «says a failed lookup as an error with a compact secondary «Повторить», and brings the list back…»                                      | `expected false to be true` (three times)                                                                                                                                         |
| `F-radio-order-swapped`                                                                                                                                | field «lists «Все категории» before «Только выбранные» and checks the one the value names»                                                    | `expected [ Array(2) ] to strictly equal [ [ 'Все категории', 'false' ], …(1) ]`                                                                                                  |
| `F-search-trimmed-on-type` (`setSearch(value.trim())`)                                                                                                 | field «keeps the search as it was typed, spaces and case included…»                                                                           | `expected <input id="mk-input-…" …(8)></input> to have property "value" with value ' ВОДА '`                                                                                      |
| `F-list-class`, `F-root-class`                                                                                                                         | field «keeps the field and its list in the boxes the stylesheet lays out»                                                                     | `expected false to be true`; `expected null not to be null`                                                                                                                       |
| `D-failure-not-cleared` (no `setFailure(null)`)                                                                                                        | page «takes the explanation of a failed try away when the next try starts…»                                                                   | `expected <div …(1)></div> to be null`                                                                                                                                            |
| `P-categories-text` (button text = its long name), `P-buttons-swapped`, `P-rowactions-removed`, `P-categories-variant-primary`, `P-categories-size-md` | page «puts a row's two actions in one box, the switch first and «Категории» second, each a compact secondary button named after its template» | `expected [ 'Выключить', …(1) ] to deeply equal [ 'Выключить', 'Категории' ]`; `expected [ 'Категории', 'Выключить' ] to deeply equal …`; `expected false to be true` (×3)        |
| `P-categories-onclose-noop`                                                                                                                            | page «closes the dialog with «Отмена» without a request or a notice, and the next opening starts from the row's categories»                   | `expected <div role="dialog" …(5)>…(3)</div> to be null`                                                                                                                          |
| `P-live-row-not-opened-row` (dialog gets the live row from the cache)                                                                                  | page «sends the revision and compares the categories of the row as it was opened, even when the list is read again under the dialog»          | `expected <button type="submit" …(3)></button> to have property "disabled" with value true` (the row read again has other categories; the final assertion pins `expectedRev: 60`) |
| `F-checkbox-label-as-html`, `D-title-as-html` (item 4 of the controller's note)                                                                        | page «shows a name with markup characters as plain text in the button's name, the dialog's title, the groups to choose from and the notice»   | `expected <i></i> to be null`; `Unable to find an accessible element with the role "dialog" and name "Категории шаблона «<b>Тест</b> & "кавычки"»"`                               |
| `CS-collator-not-russian` (`"en"` for `"ru"`)                                                                                                          | none: equivalent. Node's ICU orders Cyrillic alike under both (checked on ten names with Ё/ё, numerals, case)                                 | survives by design                                                                                                                                                                |

Also equivalent (not run, reasoned): dropping `canEdit &&` before the categories dialog (both roles hold `editCatalog`, the dialog can only open from a button that already needs it), like Task 4's E13.

A finding about my own tests: none of the first drafts failed to kill; the `P-live-row` test is built like Task 4's (re-read list under the open dialog, wait for «Категорий: 2» behind it before submitting).

## Tests added beyond the plan (11)

Field file (5), after the plan's last test under a «Beyond the plan» comment:

1. orders the groups by name in Russian order with numbers by value, whatever their codes (own data where name order, code order and code-point order all differ: «Группа 9», «Группа 10», «Ёж», «Елка», «Жук»).
2. lists «Все категории» before «Только выбранные» and checks the one the value names.
3. says a failed lookup as an error with a compact secondary «Повторить», and brings the list back without the failure or the loading note.
4. keeps the search as it was typed, spaces and case included, and brings the whole list back when it is cleared.
5. keeps the field and its list in the boxes the stylesheet lays out.

Page file (6), after the plan's last categories test: 6. lets both office roles change a template's categories, each button named after its template (D9: the plan's categories tests use the technologist only; its mutant `editCatalog` without `admin` is killed by it and by Task 4's test, so it has no mutant of its own). 7. puts a row's two actions in one box, the switch first and «Категории» second, each a compact secondary button named after its template. 8. closes the dialog with «Отмена» without a request or a notice, and the next opening starts from the row's categories. 9. sends the revision and compares the categories of the row as it was opened, even when the list is read again under the dialog. 10. takes the explanation of a failed try away when the next try starts, and asks for a category instead. 11. shows a name with markup characters as plain text in the button's name, the dialog's title, the groups to choose from and the notice.

## Docs

Both fragments went in verbatim. Re-reading the whole «Шаблоны» item of `AGENTS.md` («Office pages») and of §5.5 showed that both still said only «Both roles switch a template on and off» / «Включают и выключают шаблон обе роли», while the new sentences describe categories and the `TemplatesPage` comment (Step 3.7) already says both roles do both. I made two small edits: AGENTS «Both roles switch a template on and off and change its categories (`useCan("editCatalog")`; …)» (the paragraph's lines re-wrapped for three lines, one short line remains) and §5.5 «Категории шаблона обе роли меняют окном на `CategoryScopeField`». Categories are described as the dialog changes them, and `CategoryScopeField` is named as the field plan 1e4 is still to reuse. This deviates from the plan's literal text; revert the two edits if Task 8 wants it otherwise.

## Files changed

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/category-scope.ts` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/CategoryScopeField.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateCategoriesDialog.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplatesPage.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/app/shell.css`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/category-scope-field.test.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/templates-page.test.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

## Checks run (all from the repository root, no `cd`)

- `node_modules/.bin/prettier --check` on the ten files: clean (two over-wide lines of my extras in `templates-page.test.tsx` were wrapped by `prettier --write` first, which touched nothing else); `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`: exit 0; `lint`: exit 0; `test`: 45 files / 1041 tests.
- Not run: `build` (the task touches neither the shell nor the dist it embeds, as in Task 4), cargo (no Rust in this plan), `graphify update .` (this worktree has no graph). No browser, visual, Windows or hardware check was made: the field, the dialog and the buttons are verified by jsdom component tests only.

## Concerns and notes for the controller

1. Enter in the search box saves the dialog. `FormDialog` wraps its children in a `<form>` whose default button is the footer's «Сохранить» (`type="submit" form=…`). HTML implicit submission fires a click on the default button when it is enabled, so after the user has changed the categories, typing a search and pressing Enter saves the choice made so far and closes the dialog; with «Сохранить» off, Enter does nothing. The search is the only text field there. jsdom does not do implicit submission and the package has no `user-event`, so this is reasoned from the HTML rule, not shown by a test; the radio and checkbox buttons are not affected (Radix cancels Enter on them). Not changed here, since it goes beyond the plan's code and the 1e4 editor would take the same field. A one-line fix would be an `onKeyDown` on the field's search `Input` (`if (event.key === "Enter") event.preventDefault();`) and a test with `fireEvent.keyDown(search, { key: "Enter" })` returning `false`. Your decision.
2. A code the lookup lacks (a template with `[8, 99]`): it counts in «Выбрано: N», has no checkbox and cannot be taken away except by switching to «Все категории»; any change then goes with it and the host (`check_groups` against the same group table) would answer `validation_failed`. The lookup is seeded and static, so it can only arise if a later version drops a group. Low.
3. The empty-choice error under the radio group is tied by `aria-describedby` and `aria-invalid` (tested) but not announced when it appears: focus stays on «Сохранить», and `RadioGroup`'s error span is no live region. That is `@markiro/ui`'s control and the plan's design.
4. Layout is unverified: two buttons in `.mk-row-actions` (flex-wrap) inside a `nowrap` cell, and the 280 px scrolling list in the 480 px dialog. The `tools/production-browser` suite has no standalone checks.
5. `AGENTS.md` still speaks of plan 1e3's screens in the future tense in the places Task 4 already named; that is Task 8's sweep.
6. Both dialogs and the field call `useProductGroups()`: one cached query with several observers (as Task 4's dialog does); opening the dialog while the lookup is in the error state re-reads it on mount.
7. Scratch files are only under `$TMPDIR/t5/` (outside the tree): the helper scripts, the mutant batteries and every output.

## Fix round 1 (Important 1: Enter in the search box)

Base `89bfe7649841fa4ca5bedc254c548500f3e58569` (recorded first); commit `05a1d67891e42308b774954c5c9639626fd8b871` (short `05a1d6789`), subject «fix(standalone): Enter в поиске категорий не отправляет форму окна», one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (verified with `git log -1 --format=%B`: one such line). 3 files, +23 / −5. `git status --short` is empty after the commit.

### What changed (behavior)

The search box «Поиск категории» of `CategoryScopeField` now cancels Enter on `keydown`, so the browser's implicit submission of the form around the field never fires. Inside `FormDialog` that form's only submit button is the footer's «Сохранить», so before the fix Enter in the search box saved a half-made choice and closed the dialog. The plan-1e4 editor inherits the guard because it sits in the field. No other key is touched (Escape and Tab still reach `Modal`; nothing calls `stopPropagation`).

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/CategoryScopeField.tsx`: on the search `Input`, `onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}` (event type inferred, no cast), with a two-line comment saying why. `Input` spreads `...rest` onto the `<input>` (`packages/ui/src/components/Input.tsx:151`), so the handler lands on the control. +5 lines.
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/category-scope-field.test.tsx`: one test after the file's last one, under the existing «Beyond the plan» comment: «cancels Enter in the search box so the form around the field is never submitted, and leaves other keys alone». It renders the field with `scopeOf([13])` («Только выбранные»), waits for the group list, takes the search by its label «Поиск категории» and asserts `expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false)` and `expect(fireEvent.keyDown(search, { key: "a" })).toBe(true)`. +11 lines.
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md` («Office pages», the `CategoryScopeField` paragraph): one sentence after «…says why it lists nothing.»: «The search box cancels Enter: the field sits inside form dialogs, and the browser would otherwise submit the form and save a half-made choice.» It re-wraps the five lines that follow it (old `:1171-1175`, now `:1171-1177`) so the paragraph stays tidy; every new line is at most 80 columns, like the paragraph's longest. `:1153-1156` (the over-short line the review queues as a minor) and everything else are untouched. +7 / −5.

### RED / GREEN

Test added first, field unchanged (RED), `vitest run test/category-scope-field.test.tsx`, exit 1:

```
 ❯ test/category-scope-field.test.tsx (14 tests | 1 failed)
     × cancels Enter in the search box so the form around the field is never submitted, and leaves other keys alone
 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
 FAIL  test/category-scope-field.test.tsx > the category scope of a template > cancels Enter in the search box so the form around the field is never submitted, and leaves other keys alone
AssertionError: expected true to be false // Object.is equality
 ❯ test/category-scope-field.test.tsx:275:57
    275|     expect(fireEvent.keyDown(search, { key: "Enter" })).toBe(false);
```

Handler added (GREEN), same command, exit 0, stderr 0 bytes: `Test Files  1 passed (1)`, `Tests  14 passed (14)`.

Baseline before any edit (HEAD): the two files gave `Tests  59 passed (59)` (13 + 46), stderr empty.

### Mutant table

Driver: `/tmp/claude/1e3-fix1/mutants.py` (outside the tree). For each mutant it copies the field to `/tmp/claude/1e3-fix1/field.before.M<n>.tsx`, records `shasum -a 256`, applies a one-line edit (asserting the fragment occurs exactly once), runs `vitest run test/category-scope-field.test.tsx`, restores from the copy in a `finally`, then `cmp`s and hashes again. It ran twice: once before I re-wrapped the test's comment and once on the exact committed bytes; the results below are identical in both. Field sha256 before and after every mutant: `dad6695355a55fc229b4fe39eeee5f077b4ccfcf6d3144c19936845f08a28cac`; `cmp` silent («identical») every time. (At HEAD before the fix it was `04a77800bbd15ec7792bb91d96b557410a7fabb8a1cfced52d6aa469550f419e`.)

| #   | Mutant (one line)                                                                     | Test that failed | Key line                                                                                                                  | Restore proof                                   |
| --- | ------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| M1  | drop the `onKeyDown` handler (the one named in the dispatch)                          | the new test     | `AssertionError: expected true to be false` at `:275:57` (the Enter assertion); `1 failed \| 13 passed (14)`              | sha `dad66953…` before = after, `cmp` identical |
| M2  | `event.key === "Enter"` → `event.key === "Escape"` (named in the dispatch)            | the new test     | `expected true to be false` at `:275:57`                                                                                  | same                                            |
| M3  | cancel every key (drop the `if`, plain `event.preventDefault();`)                     | the new test     | `expected false to be true` at `:276:53`, the `{ key: "a" }` assertion, i.e. «leaves other keys alone» has its own mutant | same                                            |
| M4  | `event.stopPropagation()` instead of `event.preventDefault()` (a plausible wrong fix) | the new test     | `expected true to be false` at `:275:57`                                                                                  | same                                            |
| M5  | `=== "Enter"` → `!== "Enter"`                                                         | the new test     | `expected true to be false` at `:275:57`                                                                                  | same                                            |

M3 to M5 go beyond the two mutants the dispatch named; I ran them because the `{ key: "a" }` assertion otherwise had no mutant of its own. No mutant survived.

### Checks (all from the repository root, no `cd`; output redirected to files under `/tmp/claude/1e3-fix1/`, exit codes read directly)

| Check                                            | Command (prefix `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone`)                                                                                                     | Result                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused, verbose                                 | `exec vitest run --reporter=verbose test/category-scope-field.test.tsx test/templates-page.test.tsx`                                                                                        | exit 0; `Test Files  2 passed (2)`, `Tests  60 passed (60)` (14 `✓` lines for the field file + 46 for the page file, 0 `×`); stderr 0 bytes                                                           |
| Same two files after the commit                  | `exec vitest run test/category-scope-field.test.tsx test/templates-page.test.tsx`                                                                                                           | exit 0; 60 passed; stderr 0 bytes                                                                                                                                                                     |
| Delayed-`setImmediate` stand on the field's file | `exec vitest run --config vitest.delay.config.ts --reporter=verbose test/category-scope-field.test.tsx` with the two temporary files from `1e3-constraints.md`, removed in the same command | exit 0; `Tests  14 passed (14)`; stderr 0 bytes; both temporary files absent afterwards, `git status --short` shows only my three files                                                               |
| Typecheck                                        | `typecheck`                                                                                                                                                                                 | exit 0 (`tsc -p tsconfig.json --noEmit`)                                                                                                                                                              |
| Lint                                             | `lint`                                                                                                                                                                                      | exit 0 (`eslint . --ignore-pattern …`)                                                                                                                                                                |
| Whole suite                                      | `test`                                                                                                                                                                                      | exit 0; `Test Files  45 passed (45)`, `Tests  1042 passed (1042)` (was 1041); stderr is only pnpm's 13-byte echo `$ vitest run`                                                                       |
| Prettier                                         | `node_modules/.bin/prettier --check` on the field, the test and `AGENTS.md`                                                                                                                 | exit 0, «All matched files use Prettier code style!»                                                                                                                                                  |
| Whitespace                                       | `git diff --check` (working tree before the commit, and `HEAD~1 HEAD` after)                                                                                                                | exit 0 both                                                                                                                                                                                           |
| `\u04` grep                                      | `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                                                                                                                 | only `src/host/pairing-code.ts:66`; none in `AGENTS.md`                                                                                                                                               |
| Committed bytes                                  | `git show HEAD:<path> \| shasum -a 256` for the three files                                                                                                                                 | equal to the bytes tested: field `dad66953…`, test `3ec99f44ce1b25a242abdd8cf77578cce6f696390d84f4e850054dadcb24e709`, `AGENTS.md` `119b02d8dc5aa2bb01f0a036e509c81a0699c9b15fec33e6160eb3f6d0e6ac08` |

Counts: field file 13 → 14, page file 46 (unchanged), focused 60, whole suite 45 files / 1042 (the dispatch's expectation, met).

Not run: `build` (the fix touches neither the shell nor the dist it embeds), cargo (no Rust), `graphify update .` (this worktree has no `graphify-out/`). No browser, WebView2, Windows, screen-reader or visual check was made by me; see Concerns.

### Deviations from the dispatch

1. A two-line code comment above the handler explaining why Enter is cancelled (a reader of the 1e4 editor would otherwise see an unexplained handler and might delete it). It changes no behavior.
2. Three mutants beyond the two named (M3 to M5), as above.
3. The `AGENTS.md` sentence re-wraps five following lines (listed above) instead of leaving a very long line.
   All three are small; revert any of them if you prefer the literal brief.

### Self-review

- The guard is exactly the reviewer's proposal and nothing more: one key, `preventDefault` only, no `stopPropagation`, so `Modal`'s Escape and Tab handling and any other `keydown` listeners above the field still run.
- The test asserts on the cancelled default, not on a submit, because jsdom 29 does no implicit submission (the reviewer's observation, and the reason no existing test showed the hazard). The contract it pins is the one a real browser acts on: cancelling the `keydown` default stops the implicit submission, which the reviewer showed in Chromium 154.
- `fireEvent.keyDown` is synchronous and the test waits for the list with `findByRole` before taking the search, so nothing depends on a passive effect (the delayed-`setImmediate` stand agrees).

### Concerns

1. Browser behavior not re-verified by me: the only evidence that cancelling `keydown` stops the implicit submission in a real engine is the reviewer's Chromium 154 probe (the engine WebView2 uses). The jsdom test pins that the handler cancels Enter, not that a browser then stays quiet; WebView2 itself was not exercised.
2. The page-level dialog flow (open «Категории», pick a group, type in the search, press Enter, expect no `updateTemplate` call) has no test, since jsdom cannot submit implicitly. Only the field-level contract is pinned.
3. No `isComposing` guard: an Enter `keydown` is cancelled whatever the composition state, as the brief's code says. The search is Russian-layout keyboard text on a Windows WebView2 shell, so I left it as specified; I did not test an IME.
4. I did not audit other text inputs inside `FormDialog`s for the same implicit-submission hazard (out of scope for this fix; most of them should submit on Enter, and this field is the pick-from-a-list widget where it must not). If you want that audit, it is a separate sweep.
5. The review's Minor 1 to 5 are untouched, as instructed; in particular the over-short line at `AGENTS.md:1153-1156` and the spec's `:775-777` wording are unchanged.
6. Scratch files are only under `/tmp/claude/1e3-fix1/` (outside the tree): the mutant driver, mutant logs, run outputs and the commit-message file. The delayed-`setImmediate` stand's two files were created in the package and removed within the same command.
