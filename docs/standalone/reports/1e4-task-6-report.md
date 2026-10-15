# Plan 1e4, Task 6 report: copy and delete of a template (D3)

Status: DONE (concerns below are notes, not blockers). Base 8ac5ae5ec, commit ffa8d38bb `feat(standalone): копия и удаление шаблона этикетки` (one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). `git status --short` empty after the commit; the delayed-setImmediate stand files were removed.

## What changed

- `/templates/:id/copy` -> `CopyTemplatePage` (stock templates included): the source is read by the shared `OpenedTemplate` (read this visit, `not_found`, read failure, unreadable layout), the editor opens as a NEW template named `<name> — копия` with the source's purpose, flag, categories and layout; the purpose can change and the layout stays (`layoutFollowsPurpose` is passed only by `NewTemplatePage`).
- Stock row: «Копировать» (`office.templates.copyNamed`) instead of «Изменить»; `/templates/:id` of a stock template explains and offers «Копировать» (`copyOf`).
- Editor header, when editing: «Копировать» (secondary), «Удалить» (`destructive-outline`), «К шаблонам». `DeleteTemplateDialog` (destructive submit, `deleteTemplate`, `onDeleted` -> `backToList` with «Шаблон «…» удалён.»). `backToList` is shared with save and drops the list cache (`removeQueries`, exact `officeKeys.templates`).
- `deleteFailure`: default conflict (whose), `stock_template` -> `stockDelete`, `not_found` -> `missing`, rest -> `alertFailure`.
- Host check (`host/src/routes/templates.rs` 360-363): the host refuses a delete of a stock template with `conflict`/`stock_template`; `deleteFailure` maps that code. The UI cannot reach the delete dialog for a stock template anyway (stock `/templates/:id` shows no editor).
- Files: new `DeleteTemplateDialog.tsx`; modified `editor-failure.ts`, `TemplateEditor.tsx`, `TemplateEditorPage.tsx` (whole), `routes.tsx`, `TemplatesPage.tsx`, `ru.json`; tests `template-editor.test.tsx`, `editor-failure.test.ts`, `templates-page.test.tsx`. Plan fragments applied verbatim (all anchors matched once after the controller's patch); the code of Step 3 was applied exactly.

## Tests

- Baseline before: 53 files / 1234 tests (as the controller expected). After: 53 files / 1247 tests = 1234 + 6 (plan: 1 in `editor-failure`, 5 new in `template-editor`) + 7 extras of mine. The plan's expected 1240 before extras matches.
- RED (3 files): `Tests  8 failed | 104 passed (112)`: `TypeError: deleteFailure is not a function`; `Unable to find an accessible element with the role "button" and name "Копировать шаблон «Коробка 58×40»"`, `… "Копировать"`, three times `… "Удалить"`; the stock explanation test; the row-buttons test. (112 vs the plan's 82 because of earlier tasks' extras.)
- GREEN (3 files): 112 passed before my extras, 119 after them. `--reporter=verbose`: stderr 0 bytes, no `act(`/`Unhandled`/`Warning` in the output. Same 3 files under the delayed-`setImmediate` stand (3 ms): 119 passed; stand files deleted.
- Final gates: `typecheck` 0, `lint` 0 (one `no-useless-assignment` in my first draft of the markup test, fixed), `prettier --check` on the ten files clean, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, package `test` 53 files / 1247 tests. No Rust, no cargo, no shell/dist build run (task touches neither).

## Extras beyond the plan (7 tests) and what each pins

1. copies the source's own purpose (pallet), flag, categories (null = all) and layout (300 dpi) and drops the cached list (second list read held pending: «Загрузка…» shown, no stale «Молоко» row).
2. drops the cached list after a delete (same pending technique).
3. both roles (`SESSION.user`, `TECHNOLOGIST`): «Копировать» on the stock row, «Копировать» and «Удалить» (class `mk-btn--destructive-outline`) in the editor, delete works.
4. a copy page that cannot open its source (not_found, unreadable layout, transport error + «Повторить»): heading «Копия шаблона», no «Копировать» on offer, «К шаблонам» works.
5. an earlier refusal is cleared while the next delete is in flight (second `deleteTemplate` pending), and the categories of a default are named («Упакованная вода, Молочная продукция»).
6. two clicks of the delete submit in one `act` send one delete.
7. markup characters (`<i>…</i><img src=x onerror=alert(1)>`) in the name: delete dialog body, copy page heading and name field value, «удалён» notice are text, no `img, i, b, script` in the DOM.

## Mutant table (all scratch, each restored: sha256 identical before/after and `cmp` against `/tmp/claude/t6-before-<id>` silent; runner `/tmp/claude/t6-mut.py`, full outputs `/tmp/claude/t6-mut-<id>.txt`)

Runs: `vitest run test/template-editor.test.tsx test/editor-failure.test.ts test/templates-page.test.tsx` (119 tests); "killed by" lists the failing tests (names shortened).

| Id          | One-line mutant                                                   | Killed by                                                                                                  |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M1 (plan 1) | copy name = `source.name`                                         | copies a stock template from its row; copies the source's own purpose…; copy page cannot open; markup test |
| M2 (plan 2) | drop `layoutFollowsPurpose &&`                                    | keeps the layout when the copy's purpose changes                                                           |
| M3 (plan 3) | drop `copyOf={template.id}`                                       | explains a template it cannot open (plan test)                                                             |
| M4 (plan 4) | drop `submitVariant="destructive"`                                | deletes after a destructive confirmation                                                                   |
| M5 (plan 5) | `onDeleted()` -> `onClose()`                                      | 5 tests (destructive confirmation, cached list, either role, one delete for two clicks, markup)            |
| M6 (plan 6) | `stockDelete` -> `errors.api.conflict`                            | deleteFailure unit test + deletion is refused                                                              |
| M7 (plan 7) | `template.stock ? (` -> `false ? (`                               | row buttons test, copies stock row, copy page, either role, edit open                                      |
| M8          | copy purpose `source.purpose` -> `"box"`                          | extra 1 (the plan tests only use box)                                                                      |
| M9          | copy `enabled: source.enabled` -> `true`                          | copies a stock template from its row                                                                       |
| M10         | copy scope -> all categories                                      | copies a stock template from its row                                                                       |
| M11         | copy layout -> `startingSpec(source.purpose)`                     | copies stock row; extra 1                                                                                  |
| M12         | drop `removeQueries` in `backToList`                              | extra 1, extra 2, plus earlier create/edit tests                                                           |
| M13         | drop `setFailure(null)` at submit start                           | extra 5 (old alert while the next try is pending)                                                          |
| M14         | dialog `groups={undefined}`                                       | extra 5 (categories by name)                                                                               |
| M15         | scratch in `FormDialog.tsx`: drop `if (inFlight.current) return;` | extra 6 and the existing «sends one request for a double click»                                            |
| M16         | copy page title -> `editTitle`                                    | extra 4                                                                                                    |
| M17         | add `copyOf={id}` to the unreadable page                          | extra 4                                                                                                    |
| M18         | drop `not_found` branch of `deleteFailure`                        | unit test + deletion is refused                                                                            |
| M19         | drop the default-conflict branch of `deleteFailure`               | unit test + deletion is refused + extra 5                                                                  |
| M21         | header Delete `destructive-outline` -> `secondary`                | extra 3                                                                                                    |
| M22         | stock row copy navigates to `/templates/:id` (edit)               | copies stock row; extra 4                                                                                  |
| M23         | editor header copy navigates to `/templates/:id`                  | copies from its editor; extra 1; markup test                                                               |
| M26         | drop `layoutFollowsPurpose` from `NewTemplatePage`                | 5 Task 3/4 tests (purpose-follows-layout, size, duplicate)                                                 |
| M28         | delete sends `template.name` instead of `template.id`             | deletes after a destructive confirmation                                                                   |
| M29         | `useCan("editCatalog")` -> `("editReference")` in `TemplatesPage` | 93 tests (technologist is the default test role); coarse but killed                                        |
| M30         | delete notice uses the `saved` text                               | destructive confirmation, either role, markup                                                              |
| M31         | `deleting` condition inverted                                     | 8 delete tests                                                                                             |
| M32         | `dangerouslySetInnerHTML` for the dialog body                     | markup test (extra 7)                                                                                      |

Argued equivalent (not claimed killed): `error.code === "conflict" &&` in the `stock_template` branch of `deleteFailure`. Dropping it only changes the result for an error whose `details.constraint` is `"stock_template"` with another code, which the host never sends; no role gate exists in the editor header (D3: both roles) to mutate, so test 3 pins the behaviour rather than a guard.

## Concerns and notes

- Copy name length: a source name of 193-200 characters gets `— копия` appended and exceeds the 200-character rule; saving is refused under the name field (existing validation), the user shortens it. Not changed (plan text is verbatim).
- Known queued minors not touched and not made worse: sidebar `NavLink` `end` highlighting on editor pages; the old load error flash while the record is re-read (copy page shares `OpenedTemplate`, so it inherits that behaviour).
- «Копировать» in the editor header copies the record as the host has it (the page re-reads the source), not unsaved edits; Task 7's leave confirmation will sit between header actions and navigation, so the new tests that click «Копировать» in the editor start from an unmodified draft and should survive it (the markup test cancels the dialog first and does not edit).
- `graphify update .` not run: this worktree has no `graphify-out`.
- Not verified: browser, Windows, real host; automated jsdom tests only.
