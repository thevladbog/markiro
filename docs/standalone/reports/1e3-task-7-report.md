# Plan 1e3, Task 7 report: «Умолчания шаблонов» — умолчания категорий (D8)

Status: DONE_WITH_CONCERNS (the concerns are notes for the controller; none blocks).
Commit: `141562f79 feat(standalone): «Умолчания шаблонов» — умолчания категорий` (base `043523a97`; exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, `git log -1 --format=%B | grep -c Co-Authored-By` = 1). `git status --short` is empty after the commit. 8 files, +1320 / -84.
Tests: whole suite 47 files / 1101 tests (baseline 47 / 1073 confirmed before I started; plan +12 = 1085; my 16 extras = 1101). This task's two files: `defaults-form` 9 (4 + 3 plan + 2 extras), `template-defaults-page` 49 (26 + 9 plan + 14 extras). Typecheck 0, lint 0, prettier clean, `git diff --check` and `git diff --cached --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.

## What changed (behavior)

- Card «Для категорий» (second-level heading) on «Умолчания шаблонов»: only the categories that HAVE a default, by category name (Russian order, numbers by value) then purpose (box, pallet, duplicate); sorted at output, the page keeps and sends its own order. A row: the group's name (the code where the lookup lacks it or did not load), the purpose on its tag, a select of the templates that fit that category and purpose WITHOUT «Не выбран» (a default that no longer fits stays a marked choice), and «Убрать» (accessible name «Убрать умолчание: <категория>, <назначение>»).
- «Добавить умолчание категории» (off until the groups AND the templates are loaded, pending or failed) opens `CategoryDefaultDialog`: a category that still has a purpose without a default, such a purpose, a template that fits both (`templateOptions`); a new category starts purpose and template afresh, a new purpose the template; empty fields are errors under them; with no fitting template the dialog says so (hint). The added row joins the page's document, «Сохранить» sends it whole.
- `defaultsFailure(error, sent)` finds the row of a `validation_failed` on `categories.{i}.templateId` / `.chzProductGroupCode` / `categories.{i}` by its index in the SENT list (`slotKey`) and puts «Шаблон больше не подходит…» / «Хост не принял эту категорию.» / «Это умолчание задано дважды.» under that row's template choice; the template list is re-read; a change of that row's template or its removal takes the message away, a change of another row does not.
- `defaults-form.ts`: `withCategoryDefault`, `withoutCategoryDefault`, `freePurposes`, `defaultsFailure(error, sent = [])`. `TemplateDefaultsPage.tsx` replaced WHOLE by the brief's text. `ru.json` keys as in the brief. Docs: `apps/standalone/AGENTS.md` («Office pages») and spec §5.5, verbatim from the brief; I re-read both passages whole against the page: nothing in them is false (two wording notes in «Concerns»).
- No in-flight lock (`|| saving`) anywhere, as the dispatch said (queued for the final wave).

## Counts: the brief's numbers and the measured ones

|                                      | brief                                    | dispatch                 | measured                                             | cause                              |
| ------------------------------------ | ---------------------------------------- | ------------------------ | ---------------------------------------------------- | ---------------------------------- |
| Baseline whole suite                 | —                                        | 47 / 1073                | 47 / 1073 (exit 0)                                   | as expected                        |
| Step 2 RED                           | `12 failed \| 17 passed (29)`            | 2 files, 12 failed of 42 | `Tests  12 failed \| 30 passed (42)`, 2 files failed | +13 Task 6 extras in the page file |
| Step 4 GREEN (plan-only state)       | 2 files, 29 (`defaults-form` 7, page 22) | 42 (7 + 35)              | 42 passed (7 + 35)                                   | same shift                         |
| Step 4 GREEN (final, with my extras) | —                                        | —                        | 58 passed (9 + 49)                                   | +16 extras                         |
| Step 7 whole suite                   | 47 / 1042                                | 47 / 1085 before extras  | 47 / 1101                                            | 1073 + 12 plan + 16 extras         |
| Mutants 4 and 6                      | `3 failed \| 26 passed (29)`             | —                        | `3 failed \| 39 passed (42)`                         | same shift                         |

RED (`/tmp/claude-501/t7/red.out|err`): `TypeError: withCategoryDefault is not a function`, `TypeError: freePurposes is not a function`, `AssertionError: expected { kind: 'alert', …(1) } to strictly equal { Object (kind, key, ...) }` (defaults-form, 3 failed); page 9 failed: `Unable to find an accessible element with the role "heading" and name "Для категорий"`, `Unable to find an element with the text: Умолчаний категорий нет.`, `Unable to find an accessible element with the role "button" and name "Добавить умолчание категории"` (x5), `Unable to find a label with the text of: Шаблон: Молочная продукция, Короб`, `Unable to find an element with the text: Справочник товарных групп не загрузился…`.

## Known break of a Task 6 extra (fixed without weakening, count unchanged)

First GREEN run (`/tmp/claude-501/t7/green1.err`): 41 passed, 1 failed: «keeps one live region for the note about unsaved changes: empty while nothing changed, the same element once something did» (`expected null to be 'polite'`): its query took the FIRST `.office-note` in the form, now the new categories hint. Fix: `.closest("form")` -> `.closest(".standalone-form__actions")`; every assertion kept (`aria-live` polite, empty text while clean, the same element once dirty, still connected). It cannot now pass on the hint. No other Task 6 extra broke (42/42 after that one edit). This is the only edited existing test.

## Hygiene runs (Vitest)

- Plan-only state: plain 42 passed; `--reporter=verbose` 42 passed, stderr 0 bytes; delayed-`setImmediate` stand 42 passed, stderr 0 bytes.
- Final state (58 tests, 2 files): `--reporter=verbose` 58 `✓`, stderr 0 bytes; four more plain runs, all exit 0, stderr 0 bytes each; three runs under the stand (the plan's two files, created and deleted each time by `/tmp/claude-501/t7/stand.sh`), 58 passed, stderr 0 bytes. Stand files deleted (`ls` confirms); `git status --short` clean.
- Whole suite: exit 0, no `Errors`/`Unhandled` line; stderr is only pnpm's `$ vitest run` echo.
- My tests: every `findBy*` is followed only by assertions on state that a click or a change set synchronously (the dialog's errors), never on effect-driven state; «exactly N reads» use `settle()` (two scheduler passes) after a `waitFor`; pending lookups are released inside `act`; no test clicks twice.

## Mutants

Procedure for every run: `cp` to `/tmp/claude-501/t7/mut/<label>.before`, sha256 before, the anchor must match exactly once (the runner aborts otherwise), one-line mutation, Vitest, `finally` restore, `filecmp` byte compare and sha256 after. All 98 runs printed `restored=True`. Final sha256 of the mutated files equals the pre-mutation ones (full hashes in `shasum -a 256`; prefixes): `TemplateDefaultsPage.tsx` `4c919c308aed096b`, `defaults-form.ts` `c427cf4eca73cdd4`, `CategoryDefaultDialog.tsx` `40900e16c6e5f814`, `ru.json` `1a28ddf9c0a16ef7`, `i18n/index.ts` `5f3a3f63c525fc39`, `template-options.ts` `80f810566483ea18`. Runner, survey scripts and every output are outside the tree: `/tmp/claude-501/t7/{mutrun,survey,survey2,survey3,survey4}.py`, `/tmp/claude-501/t7/mut/*.out`, `survey*.json`.

### The brief's 11 (run with its commands, plan-only tests; all killed with the named messages)

| #   | mutant                                     | failing test(s)                                                                                                                                         | key line                                                                                                                                                                                          |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sent = [...draft.categories].reverse()`   | page «puts a refused category default under its row…» (`-t "refused category default"`)                                                                 | `expected null to be 'mk-select-_r_5_-error'`                                                                                                                                                     |
| 2   | `defaultsFailure(error)`                   | same                                                                                                                                                    | `Unable to find an element with the text: Шаблон больше не подходит: его выключили, сузили или удалили. Выберите другой.`                                                                         |
| 3   | no `$` in the path regexp                  | defaults-form «puts a refusal of a category default…»                                                                                                   | `categories.1.purpose: expected { Object (kind, key, ...) } to strictly equal { kind: 'alert', …(1) }`                                                                                            |
| 4   | `freePurposes` ignores the category        | `Tests  3 failed \| 39 passed (42)`: form «offers the purposes…», page «adds a category default…», page «puts a refused…»                               | `expected [ 'pallet', 'product_duplicate' ] to strictly equal [ Array(3) ]`; `expected [ 'Не выбрана' ] to deeply equal [ 'Не выбрана', …(2) ]`; `expected <div role="dialog" …> to be null`      |
| 5   | «Не выбран» back in a row                  | page «lists the category defaults…»                                                                                                                     | `expected [ 'Не выбран', 'Коробка 58×40', …(2) ] to deeply equal [ 'Коробка 58×40', …(2) ]`                                                                                                       |
| 6   | `categories: [...draft.categories, entry]` | `Tests  3 failed \| 39 passed (42)`: form «puts a category default in its slot…», page «changes a category default's template…», page «puts a refused…» | `expected [ …(3) ] to strictly equal [ …(2) ]`; `expected [ …(4) ] to have a length of 3 but got 4`; `Found multiple elements with the text of: Шаблон: Альтернативная табачная продукция, Короб` |
| 7   | `rows={[...draft.categories]}`             | page «lists the category defaults…»                                                                                                                     | `expected [ [ 'Упакованная вода', …(1) ], …(3) ] to deeply equal [ …(4) ]`                                                                                                                        |
| 8   | add without a template                     | page «asks for the category…»                                                                                                                           | `Unable to find an element with the text: Выберите шаблон`                                                                                                                                        |
| 9   | any change clears the message              | page «puts a refused…»                                                                                                                                  | `Unable to find an element with the text: Шаблон больше не подходит…`                                                                                                                             |
| 10  | dialog templates for `null`                | page «adds a category default…»                                                                                                                         | `expected [ 'Не выбран', 'Паллета 58×40', …(1) ] to deeply equal [ 'Не выбран', 'Паллета 58×40', …(2) ]`                                                                                          |
| 11  | add enabled while templates fail           | page «keeps «Добавить умолчание категории» off while the templates do not load»                                                                         | `expected <button type="button" …(2)></button> to have property "disabled" with value true`                                                                                                       |

### My own survey: 67 further one-line mutants against the PLAN's tests (+ Task 6 extras)

Killed by the plan's own tests (35): P02 purpose tie-break dropped; P03 purposes reversed; P05 names compared reversed; P15 `defaultsFailure(error, rows)` (the SORTED rows instead of the sent list); P17 removal clears any row's message; P19 a row change does not clear its message; P20 add button opens nothing; P21 `onAdd` leaves the dialog open; P22 the page hands the dialog a no-op `onClose`; P24 rows' `templateOptions` for category `null`; P25 «Убрать» label without names; P26 row select label without names; P27 name cell prints the code; P28 every tag violet; P30 hint paragraph removed; P31 groups warning shows the templates text; P32 groups warning removed; P35 add button never shown; D01 dialog categories unsorted; D04 fully taken categories still offered; D05 every purpose offered; D09 no-fit hint threshold `=== 0`; D10a category change keeps the purpose; D10e keeps the category error; D15 the dialog hands `FormDialog` a no-op `onClose`; F01 replace-in-place replaces every row; F02 prepend instead of append; F03 `withoutCategoryDefault` keeps the slot; F04 `freePurposes` with `||`; F05 ignores the purpose; F07 refusal messages swapped; F08 `sent[0]`; F09 key by code only; F10 index counted from the end; X1 `escapeValue: true` (Task 6's markup test).

Survived the plan's tests: 32, of which 28 are killed by the new tests below and 4 are equivalent:

| mutant                                        | killed by new test | key failure                                                                                       |
| --------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| P01 rows by code (tie-break kept)             | T1                 | `expected [ 'Группа 10', 'Яблоки', …(2) ] to deeply equal [ 'Арбузы', 'Груп…`                     |
| P04 page collator without `numeric`           | T1                 | `expected [ 'Арбузы', 'Группа 10', …(2) ] to deeply equal [ 'Арбузы', 'Груп…`                     |
| D02 dialog categories by code                 | T1                 | `expected [ 'Не выбрана', 'Группа 10', …(4) ] to deeply equal …`                                  |
| D03 dialog collator without `numeric`         | T1                 | `expected [ 'Не выбрана', 'Арбузы', …(4) ] to deeply equal …`                                     |
| P11 card title `h3`                           | T2                 | `Unable to find an accessible element with the role "heading" and name "Для категорий"` (level 2) |
| P12 first header = purpose                    | T2                 | `expected [ 'Назначение', 'Назначение', …(2) ] to deeply equal [ 'Категория…`                     |
| P13 «Убрать» text -> «Удалить» (`ru.json`)    | T2                 | `expected 'Удалить' to be 'Убрать'`                                                               |
| P33 add button `primary`                      | T2                 | `expected false to be true` (`mk-btn--secondary`)                                                 |
| P34 `adding` initially true                   | T2                 | `expected <div role="dialog" …> to be null`                                                       |
| P06 row select on while templates load        | T4                 | `expected <select …> to have property "disabled" with value true`                                 |
| P14 add off only on errors (on while pending) | T4                 | `expected <button …> to have property "disabled" with value true`                                 |
| D06 purpose select always off                 | T5                 | `expected <select …> to have property "disabled" with value false`                                |
| D07 template select always off                | T5                 | same, third select                                                                                |
| D08 no-fit hint with no purpose chosen        | T5                 | `expected <span …></span> to be null`                                                             |
| D10b category change keeps the template       | T7                 | `Unable to find an element with the text: Выберите шаблон`                                        |
| D10c category change keeps the purpose error  | T6                 | `expected [ false, true, false ] to deeply equal [ false, false, false ]`                         |
| D10d category change keeps the template error | T6                 | `expected [ false, false, true ] to deeply equal [ false, false, false ]`                         |
| D11a purpose change keeps the template        | T7                 | `Unable to find an element with the text: Выберите шаблон` (the stale template was added)         |
| D11b purpose change keeps the purpose error   | T6                 | `[ false, true, false ]`                                                                          |
| D11c purpose change keeps the template error  | T6                 | `[ false, false, true ]`                                                                          |
| D12 template change keeps its error           | T6                 | `[ false, false, true ]`                                                                          |
| D14 `onAdd` purpose hard-coded `"box"`        | T8                 | `expected [ [ …(2) ], …(1) ] to deeply equal [ [ …(2) ], …(1) ]`                                  |
| P07 rows' `kept` empty                        | T10, T11 (+ T4)    | `expected [ 'Коробка 58×40', …(2) ] to deeply equal [ 'Коробка 58×40', …(3) ]`                    |
| P08 `kept` = the draft's choice only          | T10                | `expected [ … ] to include 'Старая коробка — не подходит'`                                        |
| P09 `kept` = the loaded choice only           | T11                | `expected [ 'Коробка 58×40', 'Молоко 58×40' ] to deeply equal [ …(3) ]`                           |
| P10 dialog `taken` = the loaded categories    | T8                 | `expected [ 'Не выбрано', 'Короб', …(2) ] to deeply equal …`                                      |
| P29 row key = index                           | T8                 | `expected <select …> to be <select …>` (the row's element is replaced)                            |
| F06 regexp `\d` for `\d+`                     | T15                | `expected { kind: 'alert', …(1) } to strictly equal { kind: 'field', key: '…`                     |

Equivalent (4, no test): P18 `removeCategory` does not clear its own message (the row that shows it goes with it; a re-add goes through `chooseCategory`, which clears it); P23 `true &&` for `canEdit` on the actions row (both roles hold `editCatalog`, as Task 6's S19); D13 `templateOptions(…, [templateId], t)` in the dialog (the purpose and category handlers always clear `templateId`, so it is `""` or an offered id); D16 the dialog's `choices` branch without `purpose === ""` (`templateFitsSlot` compares the purpose, so an empty one fits nothing and the list is `[none]` either way).

### Further mutants, run against the extended tests (20; all killed; 11 + 67 + 20 = 98 runs in all)

P36 every tag teal (T2); P37 re-read of the templates only after an organization refusal (T11: `expected [ 'Коробка 58×40', …(2) ] to deeply equal …`); P41 `loadedTemplate` found by purpose only (the plan's list test); P43 sorting `draft.categories` in place (plan: 3 failed); P44 add off only while templates fail (plan + T4); P45 row select off only on errors (T4); markup, T12: M1 `dangerouslySetInnerHTML` in the name cell (`expected 'Группа & "x"' to be '<b>Группа</b> & "x"'`), M2 hand-escaped category label in the dialog (`expected [ 'Не выбрана', …(2) ] to include '<b>Группа</b> & "x"'`), M3 hand-escaped label in `template-options.ts` (`expected [ '&lt;u>Шаблон&lt;/u> & "z"', …(1) ] to include …`; also Task 6's markup test), M4 hand-escaped «Убрать» label (`Unable to find an accessible element with the role "button" and name …`), X1m `escapeValue: true` run with `-t "markup characters as plain text in the rows"` (`Unable to find a label with the text of: Шаблон: <b>Группа</b> & "x", Короб`); F11 and F12 `...draft` dropped from `withCategoryDefault` / `withoutCategoryDefault` (T16: `expected { categories: [ { …(3) }, …(2) ] } to match object { …(3) }`; the plan's page tests also fail on them, but by crashing in `templateOptions`); P46 no `wrap: true` on the category column (T2: `expected 'nowrap' to be 'normal'`); P47 groups warning tone `error` (T13); P48a the groups warning's «Повторить» reads the templates (plan + T13); P48b it reads both (T13: `expected "vi.fn()" to be called 1 times, but got 2 times`); P49 «Сохранить» off when the category list is empty (T9: `Unable to find an element with the text: Есть несохранённые изменения.`); D17 `«Не выбрано» ignored for the purpose` and D18 `«Не выбрана» ignored for the category` (T5: `expected <select …> to have property "disabled" with value true`).

## Tests added beyond the plan (16; page file 14, form file 2; each in a separate `describe` marked «Beyond the plan», so the plan's text is intact)

Page (`describe("office template defaults: the categories', beyond the plan")`, local helpers `shown`, `openDialog`, `closeDialog`):

- T1 rows and the dialog's categories ordered by name, numbers by value, not by code or the lookup's order (data: «Яблоки» 8, «Арбузы» 13, «Группа 10» 3, «Группа 2» 21, «Дыни» 5: the plan's fixture has the same order by name and by code).
- T2 card is an `h2`, four named columns, «Убрать» in its own words, a tag of its tone per purpose, the category cell wraps, add is a secondary button, no dialog until asked.
- T3 both roles see and use add, the row's choice and «Убрать» (D9; killed no new mutant).
- T4 adding and the rows' choices stay off while the groups and templates are pending (not only failed), rows show «Код 8» and «Шаблон a3b4c5d6…» meanwhile, and turn on as the lists arrive (templates first: add stays off until the groups come).
- T5 purpose on after a category, template on after a purpose, off again when the choice is taken back; the no-fit text only after a lookup.
- T6 an error goes as soon as its field or the field before it changes, and not before.
- T7 a purpose change drops the template, a category change drops purpose and template: nothing chosen for another slot is added.
- T8 the dialog offers the slots the page holds now (an added one is not offered, a removed one is), a row keeps its DOM element when another is added, a non-box default can be added (the plan adds only `box`), «Отменить изменения» brings the loaded ones back.
- T9 removing the last category default sends `categories: []` with the loaded revision and shows «Умолчаний категорий нет.».
- T10 a loaded category default the list does not offer stays a marked choice, also while another template is chosen, and can be taken back.
- T11 a refused category default's template is marked «— не подходит» once the list is re-read, the choice kept under the message.
- T12 (the dispatch's item 4, ONE test) names with markup characters (`<b>Группа</b> & "x"`, `<i>Вторая</i> & 'y'`, `<u>Шаблон</u> & "z"`) are plain text in the name cell, the row select's `aria-label`, «Убрать …», the row's options, the dialog's category and template options: no `b`, `i` or `u` is created.
- T13 the group lookup's warning is a warning, and its «Повторить» reads the groups and nothing else.
- T14 one save carries an organization default, a changed row, an added row and a removed row, rows in the page's order (killed no new mutant: pins D8's one document end to end).

Form (`describe("the defaults form: category defaults, beyond the plan")`):

- T15 an index of more than one digit (`categories.11.templateId`, `categories.10`).
- T16 `withCategoryDefault` / `withoutCategoryDefault` keep the organization's three defaults.

## Self-review

- A script compared every block of the brief's Steps 1, 3 and 6 with the tree: all nine fragment replacements present exactly once (the before-blocks are gone where they are not part of the after-block), `CategoryDefaultDialog.tsx` and `TemplateDefaultsPage.tsx` byte-equal to the brief's blocks. Output ALL OK. All nine anchors matched exactly once before editing; no patch to the brief was needed.
- The page test file is the brief's text (Task 6 part, Task 7 `describe` inserted after the plan's last Task 6 test, Task 6's extras after it) plus my `describe` at the end and the one-line scoped query.
- TypeScript: no `any`, casts or `!` in the code; in tests only `as const` and `as const` role literals. Names in the code go to the DOM only as React text children or attribute values (no `dangerouslySetInnerHTML`, no `Trans`), pinned by T12.
- Order of work: Step 1 tests (RED), Step 3 code, Step 4 GREEN (+ the known break fixed), hygiene runs, the brief's mutants, my survey, extras (RED by survival, then GREEN), docs, gates, commit, a last throwaway check (below) restored byte-identically.

## Checks not run

`pnpm build` (the task changes neither the shell nor `src-tauri`; left to the plan's final gate as in Tasks 4–6), cargo (no Rust in this plan), `graphify update .` (this worktree has no graph). No browser, visual, Windows or real-webview check: the page and the dialog are verified by jsdom component tests only (focus order, the real look of the actions row and the table, the `Modal`'s behavior in WebView2 are not observed).

## Concerns and notes for the controller

1. **The «нет подходящего шаблона» text vanishes when «Добавить» is pressed (plan-mandated, verified).** `Select` shows `error || hint`, so with no template fitting the chosen category and purpose, «Добавить» replaces «Нет включённых шаблонов этого назначения для этой категории.» with «Выберите шаблон» and the explanation is gone exactly when the list is empty. I confirmed it with a throwaway test (not committed; file restored, hashes equal). Cheap fix for the wave: when the template list is empty, make the no-fit text the field's error message (or skip the template error and keep the hint). I did not change the brief's code.
2. Focus after «Убрать»: the clicked button leaves the DOM and focus falls to `<body>` (a keyboard user loses their place in the table). Plan-mandated, minor; a fix would move focus to the next row's choice or the card's «Добавить…» button.
3. The selects, «Убрать» and «Добавить умолчание категории» stay enabled while a save is on its way (plan-mandated; minors #16, queued for the wave across ALL controls of the finished page). Not touched.
4. Docs wording (verbatim from the brief, not false): (a) «the template list and the product groups, which the page reads once per visit» holds for the template list; `useProductGroups` has `staleTime: Infinity`, so the groups are a cached lookup read once while cached (the «Товары» bullet says it that way). (b) Like Task 6's bullet (minors #20), it does not say what the rows do while the template list loads or failed: the choices are off, a warning offers «Повторить», the stored templates show as «Шаблон a3b4c5d6…»; T4 pins the loading case. One clause each in the wave.
5. The host's «Хост не принял эту категорию.» (`.chzProductGroupCode`) and «Это умолчание задано дважды.» (`categories.{i}`) cannot be provoked by this UI in practice (the dialog offers only groups from the host's own lookup and never a taken slot): they are defensive, kept as the brief says and covered by the plan's tests.
6. A removed row's message is cleared in `removeCategory` (P18) with no visible effect, since the row carrying it goes away; harmless, not worth a test.
7. New tests rely on `@markiro/ui` class names (`mk-badge--*`, `mk-btn--secondary`, `mk-alert--warn`) as Tasks 4–6 do, and T2 reads the `Table` cell's inline `white-space` to pin the brief's `wrap: true` (an implementation-coupled but deliberate assertion: long ЧЗ group names must wrap).
8. Task 6 reviewer's minor 3 (the title of the extra at `test/template-defaults-page.test.tsx` «reads the templates again after a refused default only…», minors #19) and #16/#17 are untouched, as the dispatch scoped.
9. One slip, harmless: a scratch-file command began with `cd /tmp/claude-501/t7` (outside the repo); I checked that no stray `.claude/.cc-writes` directory was left there and that the shell's directory was the repository root again.

## Files changed

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/CategoryDefaultDialog.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` (replaced whole)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/defaults-form.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/defaults-form.test.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/template-defaults-page.test.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Scratch files live only under `/tmp/claude-501/t7/` (runner, survey scripts, outputs, backups, commit message); none in the tree.
