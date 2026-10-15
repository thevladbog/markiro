# Plan 1e3, Task 4 report: «Шаблоны» — включение и выключение с объяснением умолчаний (D5, D7)

Status: DONE.
Commit: `ba4ccd076 feat(standalone): «Шаблоны» — включение и выключение с объяснением умолчаний` (base `4f74ebea6`; one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, verified with `git log -1 --format=%B`).
Tests: whole suite 44 files, 1017 tests (baseline 1004 + 8 plan + 5 extras); `test/templates-page.test.tsx` 35 (22 existing + 8 plan + 5 extras). Typecheck 0, lint 0, prettier clean, `git diff --check` clean.

## What changed (behavior)

- `TemplatesPage`: a seventh column «Действия» (only under `useCan("editCatalog")`, which both roles satisfy) with «Выключить» / «Включить», accessible name «Выключить шаблон «<name>»». The button opens `TemplateStateDialog`; a success notice (`Alert tone="ok"`) appears above the list and goes when the next dialog opens.
- `TemplateStateDialog` (new): confirmation, `destructive` submit when switching off, `primary` when switching on; sends only `templateUpdate(template, { enabled: !turningOff })` built from the opened summary row, so the body is `{ enabled, expectedRev: <opened rev> }`. The write sits alone in `try`; `onSaved` runs after `try/catch`; the `catch` ends with `return`.
- `TemplateFailureAlert` (new, Task 5 reuses it): `template_is_default` explained in words (organization, categories by name or `Код N`, where to choose another); `stale_revision` offers «Загрузить заново»; anything else by its code via `WriteFailureAlert`.
- The answer is merged into the cached summary in place (`useChangeList` + `withTemplateChange`); the list is not re-read; the layout never enters the cache.
- `ru.json`: 13 new keys exactly as the brief gives them. Docs: `apps/standalone/AGENTS.md` («Office pages») and spec §5.5, verbatim from the brief; I re-read both items whole afterwards (no mention of categories; «every role reads it» stays true).

All brief code was applied verbatim, checked mechanically afterwards with a script that compares each of the brief's Step 1, 3 and 6 after-blocks to the files (the two new files are byte-equal to their blocks; every TemplatesPage, `ru.json`, AGENTS.md and spec block is present verbatim; the plan's test blocks are verbatim and my extras start after the plan's last test).

## Counts: the two shifts, as measured

|                                  | brief says                   | read                            | cause                              |
| -------------------------------- | ---------------------------- | ------------------------------- | ---------------------------------- |
| Step 2 RED                       | `8 failed \| 14 passed (22)` | `8 failed \| 22 passed (30)`    | +8 extras of Task 3                |
| Step 4 `templates-page.test.tsx` | 22                           | 30 (35 with my five extras)     | same                               |
| Step 7 whole suite               | 999 (991 + 8)                | 1012 (1017 with my five extras) | +13 earlier (Task 2: 5, Task 3: 8) |

Baseline before I started: 44 files, 1004 tests (confirmed).

## RED / GREEN evidence

- RED (`vitest run test/templates-page.test.tsx` after Step 1, before Step 3): `Tests  8 failed | 22 passed (30)`; every failure is `Unable to find (an accessible element with the) role="button" and name "Выключить шаблон «…»"` / `"Включить шаблон «Вода и молоко»"` (output kept in `/tmp/claude/1e3-t4-impl/t4-red.txt`).
- GREEN after Step 3: first run `2 failed | 28 passed (30)`: two Task 3 extras that count exactly six columns now see seven (see «Edited tests of Task 3»); after the fix `30 passed (30)`.
- Final file (35 tests): `--reporter=verbose`: 35 passed, stderr 0 bytes, no `act(...)`, no unhandled rejection. Delayed-`setImmediate` stand (the plan's two temporary files, created and deleted twice): 35 passed on the final file in three runs, stderr 0 bytes (plus four runs on the earlier 35-test revision). Stand files are gone; `git status --short` was empty after the commit.
- Whole suite after the last edit: `Test Files  44 passed (44)`, `Tests  1017 passed (1017)`; stderr is only pnpm's `$ vitest run` echo.

## Mutant table

Procedure for every row: `cp` of the file to `/tmp/claude/1e3-t4-impl/backups/`, `sha256` before, anchor must match exactly once (the harness aborts otherwise), one-line mutation, Vitest, restore with `cp`, `cmp` (silent) and `sha256` again; every row reported `cmp-identical=True` and equal sha256 (TemplatesPage `a031d87bc116…`, TemplateStateDialog `ec656e7ee989…`, TemplateFailureAlert `6353adcb655d…`; the same hashes were printed again after the last mutant and at commit time). The harness is `/tmp/claude/1e3-t4-impl/harness.py` (outside the tree).

### The plan's ten (run with the brief's `-t` filters, before my extras; all killed with the messages the brief names)

| #   | mutant                                                     | failing test                                             | key line                                                                                          |
| --- | ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | `useCan("editReference")`                                  | lets both office roles…                                  | `Unable to find role="button" and name "Выключить шаблон «Коробка 58×40»"`                        |
| 2   | `enabled: turningOff`                                      | both «switches a…» tests                                 | `expected [ [ 'office-session-token', …(2) ] ] to strictly equal …`                               |
| 3   | `+ chzProductGroupCodes: []`                               | both «switches a…» tests                                 | same                                                                                              |
| 4   | `void templates.refetch();` instead of the merge           | switches a template off…                                 | `expected [ 'Молоко 58×40', 'Короб', …(4) ] to deeply equal …`                                    |
| 5   | `{ ...each, ...template }` instead of `withTemplateChange` | keeps the cached list a list of summaries…               | `expected [ { …(11) }, { …(11) }, …(5) ] to strictly equal …`                                     |
| 6   | `submitVariant="primary"`                                  | switches a template off…                                 | `expected false to be true`                                                                       |
| 7   | no `setFailure(null)`                                      | explains any other failure…                              | `expected <div …(1)></div> to be null`                                                            |
| 8   | `groups={undefined}`                                       | explains why a default stays on…                         | `Unable to find an element with the text: Шаблон выбран по умолчанию для организации. … Код 99 …` |
| 9   | `alertFailure as templateFailure`                          | same                                                     | same                                                                                              |
| 10  | `reload` without `setDialog(null)`                         | offers to load the templates again after a stale switch… | `expected <div role="dialog" …(5)>…(3)</div> to be null`                                          |

### My own 32 (29 one-line mutants of the page, dialog and alert, plus the controller's three)

Killed by the plan's tests (19): E1 notice kept when the next dialog opens (switches a disabled template on…); E2 dialog kept after a save (switches a template off…); E3 no `setNotice(message)` and E4 notice texts swapped (five tests each); E5 `onClose` does nothing (double click / «Отмена»); E6 reload without `refetch` (stale switch); E7 no `aria-label` (eight tests); E8 `aria-label` always «Выключить…» (three); E15 no `onReload` to the alert (stale switch); E16 body keys swapped, E17 title keys swapped, E18 submit labels swapped, E19 `turningOff` inverted; E21 wrong cache key (`officeKeys.products`); E23 failure not kept; E28 actions header titled «Состояние», E29a `wrap: true` and E29b `mono: true` on the actions column (these three by the two Task 3 tests I extended); E22 no `return` after a refused write is killed only by Vitest's unhandled-error check (`Tests 30 passed`, `Errors 3 errors`, `TypeError: Cannot read properties of undefined (reading 'enabled')`, exit 1): the code throws before any state changes, so no DOM assertion can see it.

Survived the plan's tests (13): two are equivalent, eleven killed by five new tests.

| mutant                                                                                              | new test that kills it                                                                                                          | key line                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E13 drop `canEdit &&` before the dialog; E14 `if (true)` for the column                             | none: equivalent, since both roles hold `editCatalog` and no role lacks it                                                      | survive by design                                                                                                                                                                                                                                                                         |
| C1 drop `value={search}`; C2 drop `value={purpose}`; C3 drop `value={state}` (controller's request) | keeps what was typed and picked in the search and both filters through a failed reload and its retry                            | `expected <input id="mk-input-…" …(8)></input> to have property "value" with value '58×40'`; `… <select …> to have property "value" with value 'box'`; `… with value 'enabled'` (all three also run with the new test excluded: `34 passed \| 1 skipped`, i.e. only this test kills them) |
| E9 constant visible text `Выключить`; E10a button variant `primary`; E10b default size              | says the action in each button's own text, which its accessible name starts with, as a compact secondary button                 | `expected 'Выключить' to be 'Включить'`; `expected false to be true` (×2)                                                                                                                                                                                                                 |
| E20 dialog gets the live row from the cache instead of the opened row                               | sends the revision of the row as it was opened, even when the list is read again under the dialog                               | `expected [ [ 'office-session-token', …(2) ] ] to strictly equal …` (`expectedRev` 61, not 60)                                                                                                                                                                                            |
| E11 notice tone `error`; E12 default explanation tone `info`                                        | shows the notice as a success and the explanation of a default as an error                                                      | `expected false to be true` (both)                                                                                                                                                                                                                                                        |
| E30 dialog body through `dangerouslySetInnerHTML`; E31 notice through `dangerouslySetInnerHTML`     | shows a name with markup characters as plain text in the button's name, the dialog, the explanation of a default and the notice | `Unable to find an element with the text: Шаблон «<b>Тест</b> & "кавычки"» перестанет …` / `… выключен.`                                                                                                                                                                                  |

A finding about my own test: the first draft of the E20 test did not kill E20. TanStack batches the observers' notification into a later timer, so my submit click ran before React had taken the re-read list in (the mutant's dialog still held revision 60). I made the re-read row visibly different (another admin narrowed the categories: «Категорий: 2» appears behind the dialog), wait for it with `findByText`, and only then submit; the mutant is now killed.

## Tests added beyond the plan (5; all in `templates-page.test.tsx`, after the plan's last test, under a «Beyond the plan» comment)

1. keeps what was typed and picked in the search and both filters through a failed reload and its retry (the controller's request): type «58×40», pick «Короб» and «Включённые», trigger a stale switch, make the reload's `listTemplates` reject once, assert the error replaced the filters, press «Повторить», assert the input value, both select values, the narrowed rows and «Найдено: 2 из 7». It also pins what a failed refetch with cached data does: `LoadError` replaces `FilterBar` and the table, and the page keeps `search`, `purpose` and `state`.
2. says the action in each button's own text, which its accessible name starts with, as a compact secondary button.
3. sends the revision of the row as it was opened, even when the list is read again under the dialog.
4. shows the notice as a success and the explanation of a default as an error (an organization-only conflict, then a second try that succeeds).
5. shows a name with markup characters as plain text in the button's name, the dialog, the explanation of a default and the notice (item 4 of the controller's note: `escapeValue: false`).

## Edited tests of Task 3 (count unchanged)

Two of Task 3's extras asserted exactly six columns and failed with the new seventh column, so I extended them to name it rather than slice it away: «titles the six columns…» became «titles the seven columns, the last one «Действия», …» (header list now ends with «Действия»), and «sets the size and the resolution in the mono face…» now also expects the seventh cell to be not mono and `nowrap` (title extended with «; the button stays on one line»). The brief's own «.slice(0, 6)» comment already anticipated the write column for the cell-text assertions.

## Files changed

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateFailureAlert.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateStateDialog.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplatesPage.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/templates-page.test.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

## Checks run (all from the repository root, no `cd`)

- `node_modules/.bin/prettier --check` on the seven files: clean (my one over-wide `summary(...)` line was wrapped to prettier's form first).
- `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`: exit 0; `lint`: exit 0; `test`: 44 files / 1017 tests.
- Not run: `build` (the task touches neither the shell nor the dist it embeds), cargo (no Rust in this plan), `graphify update .` (this worktree has no graph). No browser, visual, Windows or hardware check was made: the page, the dialogs and the alerts are verified by jsdom component tests only.

## Concerns and notes for the controller

- Two Task 3 tests were edited (above); count unchanged, they pin the seventh column now.
- E13 and E14 are equivalent mutants today. If a third role without `editCatalog` ever exists, a test for it belongs next to «lets both office roles…».
- `AGENTS.md` still says in the future tense that plan 1e3's screens «come» (around lines 556 and 670, «Catalog and label templates» / «Protocol»); those places are Task 8's sweep, not this brief's.
- Observation, not verified by a test (reasoned from TanStack Query semantics): `TemplateStateDialog` calls `useProductGroups()` itself, so opening the dialog while the lookup is in the error state mounts a second observer and re-reads the lookup (default `retryOnMount`). Harmless, and the products dialog does the same; it can only make the category names appear.
- The success notice is an `Alert` (`role="alert"`, assertive) as on the other pages; I kept that for consistency.
- Scratch files live only under `/tmp/claude/1e3-t4-impl/` (harness, mutant scripts, outputs, backups); the older `/tmp/claude/mutate.py` belongs to another task and I did not touch it.
