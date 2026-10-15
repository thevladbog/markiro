# Plan 1e4 — Task 3 report (new template page, import, categories, JSON download, create)

Status: DONE_WITH_CONCERNS (concerns are observations for the controller; nothing blocks).
Base: ceefd43f0. Commit: ef9dbe851 `feat(standalone): редактор шаблона — новый шаблон с импортом, категориями и выгрузкой JSON` (one trailer line, Claude Opus 5.5; verified with `git log -1 --format=%B`). `git status --short` empty after the commit.

## What was done

Applied the brief's Steps 1-6 in order. Step 1 fragments 1-4 of `templates-page.test.tsx` were applied strictly in order by a script asserting exactly one match for each fragment at its turn (fragment 3 matched 2x on the original file, 1x after fragment 2; fragment 4 matched 3x originally and once after 2 and 3: as the controller said). `ru.json`, `shell.css`, `routes.tsx`, `TemplatesPage.tsx`, `TemplateFailureAlert.tsx`: fragments matched once. Created `download.ts`, `editor-failure.ts`, `TemplateEditor.tsx`, `TemplateEditorPage.tsx`, `editor-failure.test.ts`, `template-editor.test.tsx` verbatim. Only files named in the brief were touched.

## Evidence

- RED (`vitest run templates-page editor-failure template-editor`): `Test Files 2 failed | 1 passed (3)`, `Tests 13 failed | 47 passed (60)`; `editor-failure.test.ts` failed on `Failed to resolve import "../src/office/templates/editor-failure.js"`, all 13 `template-editor` tests failed (no «Создать шаблон»). Exactly as the brief.
- GREEN: 3 files, 64 tests (templates-page 47, editor-failure 4, template-editor 13); `--reporter=verbose`: stderr empty (no `act`, no unhandled); delayed-`setImmediate` stand: 64 pass; the stand's two files removed.
- With my extras: the same three files: 75 tests, verbose clean, delay stand clean (stand removed again).
- Full package: `Test Files 53 passed (53)`, `Tests 1203 passed (1203)`, no stderr. Prettier clean on all 12 files, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, `typecheck` and `lint` exit 0. No `build` (no shell touch), no cargo.
- Counts: plan's author measured 51/1150 -> 53/1167 (+17). Measured here: 53 files, 1203 tests = 1175 (baseline, as the controller stated) + 17 plan + 11 mine (not separately measured before starting; derived from the totals). I did not edit the plan.

## Mutants (all by `/tmp/claude/mut.py`: copies the file, sha256 before, one replacement, runs vitest, restores from the copy, prints sha before -> after and `cmp`; every run below printed identical hashes and `cmp True`)

Plan's mutants 1-12, all killed with the key line the brief expects:

| #   | mutant                              | killed by                   | key line                                                                                                                                          |
| --- | ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `name: draft.name`                  | creates the template…       | `expected { name: '  Молоко 58×40 ', …(4) } to strictly equal …`                                                                                  |
| 2   | codes in selection order            | same                        | `expected { name: 'Молоко 58×40', …(4) } to strictly equal …`                                                                                     |
| 3   | drop `removeQueries`                | same                        | `Unable to find an element with the text: Загрузка…`                                                                                              |
| 4   | JSON name over typed one            | JSON import's name          | `expected <input …> to have property "value" with value 'Своё'`                                                                                   |
| 5   | fieldset not disabled               | double click                | `expected false to be true`                                                                                                                       |
| 6   | drop `inFlight` guard               | double click                | `called 1 times, but got 2 times`                                                                                                                 |
| 7   | drop `disabled={duplicateInvalid}`  | duplicate rule              | `to have property "disabled" with value true`                                                                                                     |
| 8   | no starting layout per purpose      | starting layout             | `Unable to find … Размер: 100 × 150 мм · 203 dpi`                                                                                                 |
| 9   | drop focus assignment               | focuses the refused control | `expected <main tabindex="-1"…> to be <input …>`                                                                                                  |
| 10  | `{false && (` EGAIS                 | EGAIS                       | `Unable to find … Поле ЕГАИС …`                                                                                                                   |
| 11  | `return null` notice                | creates the template        | `Unable to find … Шаблон «Молоко 58×40» создан.`                                                                                                  |
| 12  | drop `chzProductGroupCodes` mapping | 2 tests                     | `expected { kind: 'alert', …(1) } to strictly equal { kind: 'field', field: 'scope', …(1) }` and `Unable to find … Хост не принял эти категории…` |

My extras. The plan's tests let these live (found by trying them; each now killed):

| mutant (one-line)                                                                             | survived the plan's tests? | killed by my test                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1a drop `setFailure(null)` at start of `submit`                                              | yes                        | «keeps the old alert and refusal only until the next save»                                                                                                                                                                                                          |
| X1b drop `setFieldError(null)` at start of `submit`                                           | yes                        | same                                                                                                                                                                                                                                                                |
| X2 scope `onChange` without `"scope"` (refusal under categories never clears)                 | yes                        | «clears a refusal under the categories when they change, not when the name does»                                                                                                                                                                                    |
| X3 clear refusal on any field (`fieldError?.field === field` dropped)                         | yes                        | same                                                                                                                                                                                                                                                                |
| X4 refused scope focuses the name                                                             | yes                        | «moves the focus to the categories when they are refused»                                                                                                                                                                                                           |
| X6 `loading={false}` on «Сохранить»                                                           | yes                        | «keeps «Сохранить» busy while the host answers…»                                                                                                                                                                                                                    |
| X7 `onReload` always passed (stale create shows a reload button)                              | yes                        | same                                                                                                                                                                                                                                                                |
| X8 `initialFormat="zpl"`                                                                      | yes                        | «opens the import on the layout's format and resolution, and closes it without a change»                                                                                                                                                                            |
| X9 `initialDpi={203}` (needed a 300 dpi import; I extended `importCode` with an optional dpi) | yes                        | same                                                                                                                                                                                                                                                                |
| X10 `onClose` no-op                                                                           | yes                        | same                                                                                                                                                                                                                                                                |
| X11a drop `document.body.append(anchor)` in `downloadFile`                                    | yes                        | «a file saved from the webview…» (records `isConnected` at click)                                                                                                                                                                                                   |
| X11b revoke before click                                                                      | yes                        | same                                                                                                                                                                                                                                                                |
| X11c/d no `remove` / no `revoke`                                                              | killed also by plan test   | both                                                                                                                                                                                                                                                                |
| X13 `Card` without `titleAs="h2"`                                                             | yes                        | «lays the form out in three cards with their notes and the page's heading»                                                                                                                                                                                          |
| X15a start layout always pallet                                                               | killed also by plan test   | «starts each purpose with its own layout…»                                                                                                                                                                                                                          |
| X15b compare against the box layout instead of the current purpose                            | yes                        | «starts each purpose…» (cycle box->duplicate->pallet->box)                                                                                                                                                                                                          |
| X19 raw name in the JSON                                                                      | killed by plan test        |                                                                                                                                                                                                                                                                     |
| X20 purpose `"box"` in the JSON                                                               | yes                        | «downloads a template with the purpose and the starting layout it has, named or not»                                                                                                                                                                                |
| X20b starting spec instead of the draft's                                                     | killed by both             |                                                                                                                                                                                                                                                                     |
| X5 (plan-style) drop `\|\| saving` in the focus effect                                        | killed by plan test        | «refuses an empty name…»                                                                                                                                                                                                                                            |
| MK-A notice via `dangerouslySetInnerHTML` (TemplatesPage)                                     | killed                     | plan's notice test and my markup test                                                                                                                                                                                                                               |
| MK-B category checkbox label via `dangerouslySetInnerHTML` (CategoryScopeField)               | yes                        | my markup test only («shows names and imported text with markup as text, never as markup»: group name `<img src=x onerror=alert(1)>Молоко`, imported JSON name `<i>Из файла</i>` in the input, saved notice; `document.querySelector("img, i, b, script")` is null) |

Other extras without a mutant of their own: «refuses a name over 200 characters before sending» (201 refused, 200 sent: pins `templateNameRule` use, not only emptiness).

Equivalent or unreachable (argued):

- `name.error.issues[0]?.message ?? "office.templateEditor.errors.name"`: a failed parse always has an issue and `templateNameRule`'s message is that same key, so the fallback is dead.
- `checkedSpec(draft.spec) === null` branch (`errors.spec`): the draft's layout always comes from `startingSpec` or an import, both already valid, so the UI cannot reach it; `checkedSpec` is covered by task 1's tests. The mutant "send `draft.spec` instead of the parsed `spec`" gives identical bodies for specs without unknown keys, and a type error besides.
- `canEdit ? <Button…> : undefined` always true: `officeRoleSchema` is `admin | technologist` and both hold `editCatalog`, so no role can see the difference now.
- `removeQueries({…, exact: true})` -> non-exact: `officeKeys.templates = ["office","templates"]` has no other key beneath it today. Task 5 adds `template(id)`, whose test should pin `exact`.
- EGAIS `Alert tone="warn"` tone: presentational; the text carries the meaning.

## Hand-over from the Task 2 review (256 KB serialized-layout cap)

`editorFailure` maps `validation_failed` on `spec` to `office.templateEditor.errors.specRejected`: «Хост не принял макет: он больше 256 КБ или вложен глубже 64 уровней.» It is a specific text, not generic, and it is tested (`editor-failure.test.ts` and the editor's third refusal). Not changed. Observations:

- The editor does no client-side size check; the user only learns after the round trip, and the text says nothing about what to do (cut elements, shorten texts).
- Measured via `analyzeImport`: 200 one-text-element lines of ZPL (5.7 KB) became a 26 KB spec (about 130 bytes per element); 1000 such elements are refused by the import itself («not ok»), so the cap is not reachable by element count alone. It is reachable by long text or field data, as the review said.
- A pre-check in the editor (`new TextEncoder().encode(JSON.stringify(spec)).length > 256 * 1024`) would explain it before sending. Not added; outside the brief. For the controller's decision.

## Other concerns

1. `submit()` has no `duplicateInvalid` guard: only the disabled submit button stops an invalid duplicate (a disabled default button also blocks implicit submission by Enter, so users cannot get around it; a programmatic `requestSubmit` could). The host never checks layouts (D1). A one-line `if (duplicateInvalid) return;` would be defence in depth; not added because the brief gives the code verbatim.
2. I changed one brief helper in `template-editor.test.tsx`: `importCode` takes `"tspl"` as a format and an optional dpi (default behaviour unchanged), via a `CODE_LABELS` map instead of the ternary. The brief's own tests run unchanged against it.
3. The notice is read from router state at mount and history state survives a reload of the webview, so «Шаблон … создан.» can come back after a reload. By the plan's design (state of the transition); noting it.
4. Not verified (not exercised here): real WebView2/WKWebView download of the blob (`<a download>` in the Tauri webview), a keyboard walk through the editor in a browser, Windows. Only jsdom.

## Files (all under /Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone)

Created: `src/office/templates/{download.ts,editor-failure.ts,TemplateEditor.tsx,TemplateEditorPage.tsx}`, `test/{editor-failure.test.ts,template-editor.test.tsx}`.
Modified: `src/office/templates/{TemplateFailureAlert.tsx,TemplatesPage.tsx}`, `src/office/routes.tsx`, `src/i18n/ru.json`, `src/app/shell.css`, `test/templates-page.test.tsx`.

## Self-review

Matches the brief and the global constraints: write in `try` only, `catch` ends in `return`, double submit guarded by a ref plus `fieldset disabled`, all texts are keys in `ru.json`, user text only as React text children or attribute values. No `git stash`, no `cd`, no install, no cargo, no push. Scratch files (`/tmp/claude/*`, the delay stand, two throwaway measuring tests) are gone from the tree.

## Fix round 1

Base ef9dbe851. Fix for Important 1 (test only; no source file changed).

- `test/template-editor.test.tsx`: the loop is now `[SESSION.user, TECHNOLOGIST]` (`SESSION` from `./support/fixtures.js`; `SESSION.user.role` is `admin`). `session(user = TECHNOLOGIST)` is unchanged, so the other editor tests still run as the technologist.
- Same pitfall elsewhere: none. `templates-page.test.tsx:127` passes `undefined` straight to `fakeOfficeSession`, which falls back to `SESSION.user` (the administrator), so it is correct. The loops at `:535` and `:1008` use an explicit `{ ...TECHNOLOGIST, role: "admin" }`. No other «both roles» claim in either file.
- Mutant (`TemplatesPage.tsx:247` `canEdit ? (` -> `canEdit && !useCan("editReference") ? (`): the test FAILED with `Unable to find an accessible element with the role "button" and name "Создать шаблон"` (1 failed | 23 skipped). Before the fix the same mutant passed. Unmutated: passes. Restore proof: sha256 `ceb551c0...ec9ec` before and after, `cmp` silent.
- Checks: the two files with `--reporter=verbose`: 71 passed, stderr empty. Whole package: 53 files / 1203 tests passed. prettier --check and `git diff --check` clean.
- Not run: the delayed-`setImmediate` stand (the change is one array literal).
