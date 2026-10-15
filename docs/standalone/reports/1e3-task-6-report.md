# Plan 1e3, Task 6 report: «Умолчания шаблонов» — умолчания организации и сохранение документа (D8)

Status: DONE (concerns below are notes for the controller; none blocks).
Commit: `043523a97 feat(standalone): страница «Умолчания шаблонов» — умолчания организации` (base `05a1d6789`; exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, checked with `git log -1 --format=%B | grep -c Co-Authored-By` = 1). `git status --short` is empty after the commit.
Tests: whole suite 47 files / 1073 tests (baseline 45 / 1042 confirmed before I started; plan +18 = 1060; my 13 extras = 1073). This task's files: `defaults-form` 4, `form-dialog` 13, `template-defaults-page` 13 plan tests + 13 extras = 26. Typecheck 0, lint 0, prettier clean, `git diff --check` clean, `\u04` grep finds only `src/host/pairing-code.ts:66`.

## What changed (behavior)

- New menu item «Умолчания шаблонов» in «Каталог» right after «Шаблоны», both roles; route `/template-defaults` with no `RequireRole`.
- `TemplateDefaultsPage`: reads ONE document (`useTemplateDefaults`, `officeKeys.templateDefaults`, `staleTime` 0) and the template list once per visit (in the page component); the form is re-created on every new revision (`key={defaults.data.rev}`) and reads nothing itself.
- Card «Для организации»: three selects (box, pallet, duplicate) from `templateOptions(..., null, [loaded, draft], t)`; a default the list does not offer stays a marked choice.
- Edits live in a draft (`defaults-form.ts`); live note about unsaved changes (`aria-live="polite"`), «Отменить изменения», «Сохранить» (off without changes) sends the WHOLE document `templateDefaultsUpdate(defaultsInput(draft), document.rev)` with the LOADED revision, `null` for «Не выбран»; a ref guard drops a second click; the answer goes into the cache (`setQueryData`), the form starts anew; the notice «Изменения сохранены.» goes when the next save starts.
- `validation_failed` on an organization default shows under its select («Шаблон больше не подходит…») and re-reads the template list; a change of that select takes the message away.
- `stale_revision`: «Загрузить заново» with its own text (the profile moves the revision too). `StaleAlert({ onReload, message? })` and `WriteFailureAlert({ failure, onReload?, staleMessage? })` got the optional text.
- Docs: `apps/standalone/AGENTS.md` («Office pages», one new bullet) and spec §5.5 (menu sections bullet + one new bullet), verbatim from the brief. I re-read «Office pages» and §5.5 whole: the new text matches its neighbours; nothing there became false.

## Counts: the brief's numbers and the measured ones

|                    | brief / dispatch                                       | read                                                 | cause                      |
| ------------------ | ------------------------------------------------------ | ---------------------------------------------------- | -------------------------- |
| Baseline           | 45 files / 1042                                        | 45 / 1042 (exit 0)                                   | as expected                |
| Step 2 RED         | `14 failed \| 12 passed (26)`                          | `Tests  14 failed \| 12 passed (26)`, 3 files failed | as the brief               |
| Step 4 GREEN       | 3 files, 30 tests (4 + 13 + 13)                        | 3 files, 30 tests                                    | as the brief               |
| Step 7 whole suite | 47 / 1030 (brief); 47 / 1060 (dispatch, before extras) | 47 / 1073                                            | 1042 + 18 plan + 13 extras |

RED detail (`/tmp/claude-501/red.txt`): `test/defaults-form.test.ts` does not load (`Failed to resolve import "../src/office/templates/defaults-form.js"`); `form-dialog` 1 failed (`Unable to find an element with the text: Умолчания или профиль организации изменились…`); `template-defaults-page` all 13 failed, 12 with `Unable to find role="link" and name "Умолчания шаблонов"`; the first (the menu test) fails on `AssertionError: expected [ Array(4) ] to deeply equal [ Array(4) ]` instead, since it reads the list of items rather than looking for a link. Immaterial.

## Hygiene runs (Vitest)

- GREEN, plain: 3 files, 30 passed. `--reporter=verbose`: 30 passed, stderr 0 bytes (no `act(...)`, no unhandled rejection).
- With my extras (3 files, 43 tests): verbose run 26 passed in the page file, stderr 0 bytes; five more plain runs of the 3 files, all exit 0, stderr 0 bytes each.
- Delayed-`setImmediate` stand (the plan's two files, created and deleted each time): 30 passed on the plan-only state; 43 passed on the final state in three consecutive runs, stderr 0 bytes each. Stand files deleted; `git status --short` clean.
- Whole suite output has no `Errors` line (only pnpm's `$ vitest run` echo on stderr).

## Mutants

Procedure for every row: `cp` to `/tmp/claude-501/mut/<label>.before`, `sha256` before, the anchor must match exactly once (the runner aborts otherwise), one-line mutation, Vitest, `finally` restore, `cmp` (identical) and `sha256` after. Every row printed `same=True cmp-identical=True` (or `restored`). Final hashes of the mutated files equal the pre-mutation ones: `TemplateDefaultsPage.tsx` `e99670ea40a27982`, `defaults-form.ts` `a1eb41d321098c75`, `page-state.tsx` `9f26afa24c75bba2`, `catalog-queries.ts` `31e8bc3e20293e16`, `i18n/index.ts` `5f3a3f63c525fc39`, `template-options.ts` `80f810566483ea18`. The runner and every output are outside the tree: `/tmp/claude-501/mut.py`, `/tmp/claude-501/mut/*.out`.

### The plan's 12 (run with the brief's commands, before my extras; all killed with the named messages)

| #   | mutant                                           | failing test(s)                                                                                        | key line                                                                                                                                                                                 |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `categories: []` in `defaultsInput`              | `defaults-form` «holds an organization default…», page «saves the whole document…»                     | `Tests  2 failed \| 15 passed (17)`; `expected { …(4) } to strictly equal { …(4) }`, `expected [ Array(1) ] to strictly equal [ Array(1) ]`                                              |
| 2   | `id = (value) => value` (`""` instead of `null`) | same two                                                                                               | same two lines                                                                                                                                                                           |
| 3   | `document.rev + 1`                               | «saves the whole document…» (`-t "loaded revision"`)                                                   | `expected [ Array(1) ] to strictly equal [ Array(1) ]`                                                                                                                                   |
| 4   | `cancel` without `setDraft(loaded)`              | «says when there are unsaved changes…» (`-t "unsaved changes"`)                                        | `expected <select …(4)>…(2)</select> to have property "value" with value ''`                                                                                                             |
| 5   | `org !== undefined && path === "never"`          | `defaults-form` «puts a refusal…», page «puts a refused default…»                                      | `Tests  2 failed \| 15 passed (17)`; `expected { kind: 'alert', …(1) } to strictly equal { kind: 'field', …(2) }`, `Unable to find an element with the text: Шаблон больше не подходит…` |
| 6   | no `void templates.refetch();`                   | «puts a refused default…» (`-t "refused default"`)                                                     | `expected "vi.fn()" to be called 4 times, but got 1 times`                                                                                                                               |
| 7   | `setFieldError(null)` on any choice              | same                                                                                                   | `Unable to find an element with the text: Шаблон больше не подходит…`                                                                                                                    |
| 8   | no `staleMessage=`                               | «offers to load the defaults again after a stale save…» (`-t "stale save"`)                            | `Unable to find an element with the text: Умолчания или профиль организации изменились…`                                                                                                 |
| 9   | no `if (inFlight.current) return;`               | «sends one request for a double click…» (`-t "double click"`)                                          | `expected "vi.fn()" to be called 1 times, but got 2 times`                                                                                                                               |
| 10  | `useTemplates();` in the form                    | «reads the document and the templates again on every visit» (`-t "every visit"`)                       | `expected "vi.fn()" to be called 2 times, but got 3 times`                                                                                                                               |
| 11  | no `onSubmitStart();`                            | «explains any other failure…» (`-t "any other failure"`)                                               | `expected <div …(1)></div> to be null`                                                                                                                                                   |
| 12  | `StaleAlert` ignores `message`                   | `form-dialog` «says a stale write in the form's own words…», page «offers to load the defaults again…» | `Tests  2 failed \| 24 passed (26)`; `Unable to find an element with the text: Умолчания или профиль организации изменились…`                                                            |

### My own survey: 32 further one-line mutants against the plan's tests

Killed by the plan's tests (15): S03 no `key` on the form (stale-reload test, `expected <select …> to have property "value" with value '1a5c8f6e-…'`: the draft survives the reload); S05 `setFieldError(null)` removed from `submit` (refusal test, `expected 'mk-select-…-error' to be 'mk-select-…-hint'`: `findByText` returns the previous refusal's message); S20 nav item for `admin` only (13 page tests) and S21 route behind `RequireRole(admin)` (12); S22 `staleTime: Infinity` (every-visit test); C01 `slotKey` without the purpose, C02 `sameDraft` with `.some`, C03 without the length check, C04 without the template compare, C05 `withOrgDefault` pallet writes the duplicate, C06 `draftOf` pallet from the duplicate, C07 pallet purpose `box`, C09 failure message `errors.api.validation_failed`, C10 `StaleAlert` default text `errors.api.forbidden` (6 failures in the stale-alert users: org page, product dialog, templates page, `form-dialog`, defaults page; `Unable to find an element with the text: Данные изменились, пока вы их редактировали…`), C12 `WriteFailureAlert` drops `staleMessage`.

Survived the plan's tests (17): 2 equivalent, 15 killed by the new tests below.

| mutant                                                               | new test that kills it                                                                                                                 | key failure                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 `isPending` returns `null`                                       | shows that the document is loading, with no form, until it arrives                                                                     | `Unable to find an element with the text: Загрузка…`                                                                                                                                            |
| S04a `cancel` keeps the field error; S04b `cancel` keeps the failure | takes away a refusal under a select, and a failure above the form, when «Отменить изменения» brings the document back                  | message still present after the click                                                                                                                                                           |
| S06 `templates.refetch()` after any failure                          | reads the templates again after a refused default only, not after a stale write or another failure                                     | `listTemplates` called 3 times, not 1                                                                                                                                                           |
| S07 no `event.preventDefault()`                                      | keeps the webview from submitting the form itself                                                                                      | `expected [ false ] to deeply equal [ true ]`                                                                                                                                                   |
| S08 cancel enabled while saving                                      | keeps «Отменить изменения» off while the save is on its way                                                                            | `waitFor` expects `disabled` true                                                                                                                                                               |
| S09 the live `<p>` mounted only when dirty                           | keeps one live region for the note about unsaved changes…                                                                              | the note is missing while nothing changed                                                                                                                                                       |
| S10 selects enabled while the list is pending (`templates.isError`)  | keeps the choices off while the templates are loading…                                                                                 | `disabled` false while pending                                                                                                                                                                  |
| S11 `kept` = `[draft]` only                                          | keeps a loaded default the list does not offer as a marked choice when another template is chosen…                                     | the «— не подходит» option is gone                                                                                                                                                              |
| S12 `kept` = `[loaded]` only                                         | marks the template a refusal names as one that no longer fits once the list is read again…                                             | the refused template's option is gone                                                                                                                                                           |
| S15a notice tone `error`; S15b list warning tone `error`             | shows the warning about the template list as a warning and the notice of a save as a success                                           | `mk-alert--warn` / `mk-alert--ok` missing                                                                                                                                                       |
| S17a cancel `primary`; S17b save `secondary`; S18 card title `h3`    | shows the organization's card as a second-level heading, «Сохранить» as the primary button and «Отменить изменения» as a secondary one | class / heading `level: 2` missing                                                                                                                                                              |
| S02 `savedRev !== null` for the notice; S19 `true &&` for `canEdit`  | none: equivalent                                                                                                                       | S02: nothing moves the revision between a save and the next submit (`Office` never reloads an open page, `onSubmitStart` clears the notice at every submit); S19: both roles hold `editCatalog` |

Four more mutants, run against the new tests and against the plan-only filter (`-t "the organization's [a-z]"`: the plan's 13 plus my heading test, which has nothing to do with them), each SURVIVED the plan's tests and is KILLED by one new test:

| mutant                                                                           | new test                                                                                                                  | plan-only | new tests                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| X16 `chooseOrg` also calls `onSubmitStart()` (the notice goes at the first edit) | keeps the notice of a save while the next edits are made, and reads neither the document nor the templates again          | survived  | killed                                                                         |
| X17 `onSaved` also invalidates the templates query                               | same                                                                                                                      | survived  | killed                                                                         |
| X18 `src/i18n/index.ts`: `escapeValue: true`                                     | shows template names with markup characters as plain text in the choices and in the mark of a default that no longer fits | survived  | killed (`expect [...] to include '<i>Старый</i> & "x" — не подходит'`)         |
| X21 `template-options.ts`: the option label hand-escaped (`<` → `&lt;`)          | same                                                                                                                      | survived  | killed (`expected [ 'Не выбран', …(3) ] to include '<b>Тест</b> & "кавычки"'`) |

The markup test is the dispatch's item 3: a name `<b>Тест</b> & "кавычки"` as an offered choice and `<i>Старый</i> & "x"` as the marked unfit default; it checks the option texts and that no `b`/`i` element was made. The page renders a template name only in `<option>` text (through `Select`, a `@markiro/ui` component that takes strings), so there is no `dangerouslySetInnerHTML` site to mutate here; the stale and failure texts carry no name. The `escapeValue` flip covers the `t()` path of the mark, the hand-escaped label covers the plain-name path.

## Tests added beyond the plan (13; all in `template-defaults-page.test.tsx`, a separate `describe` appended at the end, under a «Beyond the plan» comment)

1. the organization's card is a second-level heading, «Сохранить» primary, «Отменить изменения» secondary;
2. the document's loading state, no form until it arrives;
3. «Отменить изменения» takes away a refusal under a select and a failure above the form;
4. the templates are read again after a refused default only (not after a 500 or a stale write);
5. the webview is kept from submitting the form itself (`submit` seen at `document` is already default-prevented);
6. «Отменить изменения» is off while the save is on its way;
7. one live region for the unsaved-changes note: empty while clean, the same element once dirty;
8. the choices are off while the template list loads (shown by id), on once it is there;
9. a loaded unfit default stays as a marked choice when another template is chosen, and can be taken back;
10. a refused template is marked «— не подходит» once the list is read again (`listTemplates` answers a changed list the second time), the choice kept;
11. template names with markup characters are plain text in the choices and in the mark;
12. the list warning is a warning, the save notice a success;
13. the notice stays while the next edits are made, and neither the document nor the templates are read again after a save.

Placement: Task 7's anchors are the last lines of both test files. I kept them intact: `    ).toBeNull();\n  });\n});` occurs once in the page file (the plan's last test) and `    });\n  });\n});` once in `defaults-form.test.ts` (I added nothing there); the page file now ends with my last test, which ends differently. Task 7's replacement will insert its `describe` between the plan's and mine.

## Self-review

- A script compared every block of the brief's Steps 1, 3 and 6 with the tree: the four `Create` blocks (the page test is the plan's text as a prefix, my extras follow), and all 14 fragment replacements are present exactly once (the before-blocks are gone where they are not part of the after-block). Output ALL OK.
- All anchors matched exactly once; no patch to the brief was needed.
- TypeScript: no `any`, casts or `!` in my code; the brief's code already satisfies `exactOptionalPropertyTypes` (the conditional spread for `message`).
- Order of work: tests first (RED), implementation, GREEN, hygiene, mutants, extras (RED by survival, then GREEN), docs, gates, commit.

## Checks not run

`pnpm build` (the task touches neither the shell nor `src-tauri`; as in Tasks 4 and 5 it is left to the plan's final gate), cargo (no Rust in this plan), `graphify update .` (this worktree has no graph). No browser, visual, Windows or real-webview check: the page is verified by jsdom component tests only. The `preventDefault` test pins the submit event's default being prevented, not the navigation a real webview would do.

## Concerns and notes for the controller

1. The selects stay enabled while a save is on its way (plan-mandated code). An edit made during the request is dropped when the form restarts from the answer. LAN latency makes this a millisecond window; if it matters, `disabled={... || saving}` on the selects is a one-token fix and would need a test.
2. `savedRev === defaults.data.rev` is a defensive check with no UI path today (S02 above). If Task 7 or a later page ever refetches the document in the background, it starts to matter.
3. Pre-existing future-tense statements stay for Task 8's sweep: `apps/standalone/AGENTS.md:555-558` («The template screens and the defaults screen come with plan 1e3») and the spec's §5.5 sentence on `labelTemplateSpecSchema` «в экранах шаблонов плана 1e3» (lines 696-697).
4. The new tests rely on `@markiro/ui` class names (`mk-btn--primary`, `mk-btn--secondary`, `mk-alert--ok`, `mk-alert--warn`) as Tasks 4 and 5 already do.
5. The brief's anchors and count line («47 файлов, 1030 тестов») were as the dispatch predicted; nothing else deviates.

## Files changed

- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/defaults-form.ts` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateDefaultsPage.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/office-query.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/catalog-queries.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/page-state.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/nav.ts`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/routes.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/defaults-form.test.ts` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/template-defaults-page.test.tsx` (new)
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/form-dialog.test.tsx`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/AGENTS.md`
- `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Scratch files live only under `/tmp/claude-501/` (runner, outputs, backups, commit message); none in the tree.
