# Task 5 report — editing a template with the opened record's revision

Status: DONE. Commit `8ac5ae5ec` feat(standalone): редактор шаблона — правка шаблона с ревизией открытой записи (base b98858bff). Trailer: one `Co-Authored-By: Claude Opus 5.5` line.

## What was done

Steps 1, 3 applied verbatim and in order (all non-mutation fragments matched exactly once, including the controller's patched fragment 2): `officeKeys.template(id)`, `TemplateEditor` edit mode (`template`, `onReload`, `templateUpdate` with the opened record, purpose disabled with hint, «Сохранить» off until dirty, `saved` notice), `EditTemplatePage` (read per opening, `isFetchedAfterMount`, `not_found`, `LoadError`, stock, unreadable, `key={rev}`), route `templates/:id`, row button «Изменить» (not for stock), ru.json keys. Only the 8 files of the brief changed.

## Counts

- Baseline before: 53 files / 1220 tests (confirmed).
- RED (step 2): 2 files, `8 failed` (7 new editor tests + the row-button test), matching the plan.
- GREEN (step 4) before extras: 95 tests in the 2 files (plan: 72; difference is the 23 tests of Tasks 3–4 that the plan's count predates).
- Final: 53 files / 1234 tests = 1220 + 7 (plan) + 7 (my extras). The plan's +7 gives 1227 on this tree, as the controller predicted.
- typecheck 0, lint 0, `prettier --check` clean, `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`.
- Verbose run of both files: 102 passed, no stderr, no `act(...)` warning. Delayed-`setImmediate` stand: 102 passed; stand files removed, `git status --short` empty after commit.
- Not run: cargo (no Rust changed), browser/Windows/host validation (jsdom tests only).

## Mutants — the plan's seven (all killed, restore verified by sha256 before/after)

| #   | mutant                                 | failing test                       | key line                                    |
| --- | -------------------------------------- | ---------------------------------- | ------------------------------------------- |
| 1   | drop `key={opened.rev}`                | stale save …                       | value 'Молоко (со склада)' expected         |
| 2   | drop `isFetchedAfterMount`             | on every opening                   | cannot find text «Загрузка…»                |
| 3   | `opened.stock && false`                | cannot open                        | Unable to find role="alert"                 |
| 4   | drop `disabled={template !== null}`    | purpose fixed                      | select `disabled` expected true             |
| 5   | Save `disabled={duplicateInvalid}`     | purpose fixed                      | submit `disabled` expected true             |
| 6   | `templateUpdate({...template, rev: 0}` | opened revision                    | strictEqual, `expectedRev: 0`               |
| 7   | edit button for stock too              | templates-page «Изменить» row test | `[Array(3)]` vs `['Выключить','Категории']` |

## Extra mutants found by me, and what killed them

First run (against the plan's tests only) these survived: E1 `purpose: "box"` in the page, E2 `enabled: true`, E10 LoadError heading, E11 `spec: template.spec` (layout edits ignored), E12 `chzProductGroupCodes: template.chzProductGroupCodes`, E17 shared query key without the id, E4 dropped `removeQueries` (killed only by the create-path test, edit path unpinned). New tests kill all of them:

| mutant                                                     | killed by (new test)                                                                | key line                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| E1 `purpose: "box"` (page)                                 | opens a disabled template … with another purpose                                    | select value 'pallet' expected   |
| E2 `enabled: true` (page)                                  | same                                                                                | aria-checked 'true' vs 'false'   |
| E10 `<PageHeader title="x">` in LoadError branch           | keeps the page's heading … on every page that cannot show the editor                | no heading «Шаблон»              |
| E11 `spec: template.spec`                                  | sends the categories and the resized layout …                                       | strictEqual (resized spec)       |
| E12 `codes: template.chzProductGroupCodes`                 | same                                                                                | strictEqual (`[8,13]`)           |
| E4b drop `removeQueries` (edit path)                       | same (pending list read, no stale row)                                              | no «Загрузка…»                   |
| E17 `template: () => ["office","template"]`                | reads each template under its own key (in-flight read of A is deduped into B)       | no heading «Шаблон «Вода 58×40»» |
| M1 `namedTitle` with `escapeValue: true` (double escaping) | shows a name with markup as text on the list, in the edit heading and in the notice | heading name literal mismatch    |
| R2 `editCatalog: ["technologist"]`                         | the plan's first test, after my role fix below                                      | cannot find «Изменить шаблон …»  |

Also verified killed by the existing or plan tests (so they are not gaps): E3 scope all, E5 `getTemplate(token,"")`, E6 retry noop, E7 reload noop, E8 no purpose hint, E9 every HostError as gone, E13 `enabled: template.enabled`, E14 «создан» for edits, E15 link by name, E16 wrong route, E18 «К шаблонам» noop, E19 unnamed heading, E20 update id "", E21 no `onReload` to the alert, R1 `editCatalog` admin-only (81 tests fail), L1 unnamed edit aria-label, X1 editor in create mode (`template={null}`), X2 unreadable guard dropped (TypeError). All restored byte-identically (sha before/after printed equal for every mutant).

## Changes to the plan's tests (strengthening only)

- Plan test «opens the template as the host has it…» looped over `[undefined, TECHNOLOGIST]`; `editSession(undefined)` takes the default `TECHNOLOGIST`, so the administrator was never exercised. Changed to `[SESSION.user, TECHNOLOGIST]` (as the Task 3 test does). R2 survived before, is killed now.
- Extras (+7 tests, all in `template-editor.test.tsx`, inside the same describe): heading and way back on every page that cannot show the editor; disabled/pallet/all-categories template opens as read and sends only the changed flag; changed categories + resized layout are sent (and the list from before the save is not shown); a second save after a stale save still sends the opened revision (61), never `currentRev` (64/66) and no re-read; failed reload after a stale save shows the transport error, «Повторить» re-reads, and the next save sends the re-read revision (64); separate query key per template; markup characters (list, heading, notice). The «second save after stale» test pins existing behaviour; I found no one-line mutant for it (the code has no place that could remember `currentRev`), so it has no mutant row.

## Queued items touched

None fixed. Sidebar `NavLink` `end` (not highlighting «Шаблоны» on `/templates/:id`) untouched; the notice stays in router state as before.

## Concerns (not in scope, for the controller)

- If a stale save is followed by «Загрузить заново» and the host answers with the SAME revision (a race the host's contract rules out), `key={rev}` does not change, so the editor does not remount and the stale alert stays; every real stale case carries a different revision.
- A failed reload swaps the editor for `LoadError` (edits are dropped, as they are by a successful reload); pinned by a test.
- `.claude/.cc-writes` exists in the worktree root; it is git-ignored (status clean) and was not created by a `cd` of mine.
