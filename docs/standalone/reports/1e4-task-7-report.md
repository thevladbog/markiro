# Plan 1e4, Task 7 report — leave confirmation (D6)

Status: DONE (one finding to decide, see Concerns).
Commit: 1fb64ef7f `feat(standalone): редактор шаблона спрашивает, прежде чем уйти с несохранёнными правками` (base ffa8d38bb; trailer is exactly one `Co-Authored-By: Claude Opus 5.5` line).

## What was done

- `TemplateEditor.tsx`: `useBlocker` with a `BlockerFunction` (`dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname`, `useCallback` on `[dirty]`), `leaving` ref set in `backToList` before `navigate`, `FormDialog` (destructive submit calls `blocker.proceed()`, `onClose` calls `blocker.reset()`), imports as in the brief. `ru.json`: `office.templateEditor.leave.{title,body,submit}` verbatim.
- Tests: brief's edit 1 (old «шаблона больше нет» test now confirms the leave) and the three brief tests. Anchor note: brief edit 2 anchors on the end of the file in the plan's scratch copy (`...(2));\n  });\n});`); in this tree no such tail exists (0 matches), so the new `describe("leaving a label template with unsaved changes")` and its `leaveDialog()` helper were inserted after the «copying and deleting» describe (so `deleteDialog()` is in scope), before «a file saved from the webview». Code in it is verbatim.

## Counts

- Baseline measured: 53 files / 1247 tests. Plan expected +3 (1250); I added 4 extras, so measured now 53 files / 1254 tests (1247 + 3 + 4). The editor file: 67 -> 74.
- Editor file after commit: verbose run, 74 passed, stderr 0 bytes; delayed-`setImmediate` stand, 74 passed, stderr 0 bytes; stand files removed, `git status --short` empty after commit.
- typecheck, lint: exit 0. prettier --check (3 files), `git diff --check`: clean. `grep -rnF '\u04'`: only `src/host/pairing-code.ts:66`.

## RED / GREEN

- RED (`vitest run test/template-editor.test.tsx`, before Step 3): `Tests 3 failed | 30 passed` in the plan's numbering (here 3 failed of 70): old «шаблона больше нет» test (`Unable to find ... button "Уйти без сохранения"`), «asks before «К шаблонам»…» and «asks before the menu and «Копировать»…» (`role "dialog" name "Уйти со страницы?"` / the button). The third new test («leaves without asking») passes on the old code by design (it pins that the blocker does not over-block).
- GREEN after Step 3: 70 passed (67 + 3), stderr empty. Extras added afterwards: 74 passed.

## Extras (beyond the plan), 4 tests

1. «does not ask once the changes are typed back, and a save after «Отмена» leaves without asking» — revert to the opened value, then menu leaves without asking; after «Отмена» a save still leaves without the dialog.
2. «asks before a new template with a typed name and a changed copy are dropped, but not an untouched copy» — new template + copy variants (plan only pinned the untouched new template).
3. «does not ask after a stale save is loaded again» — remount through `key={template.rev}` leaves no active blocker/edits.
4. «does not ask for a navigation that stays on the page, such as a changed search, and asks for another page» — own memory router (`NewTemplatePage` + two `Link`s inside the real providers); needed because no UI path navigates to the same pathname, so Office's internal router cannot exercise the guard. The first run had an `act` warning (categories arriving during `settle`); fixed with `await act(async () => { await settle(); })`, stderr is now empty.

## Mutants (all restored; `cmp`/sha256 equal, script printed `restored True` for every one; copy at /tmp/claude/t7-before)

| #   | Mutant (one line)                                                   | Result: failing tests / key line                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | drop `leaving.current = true;`                                      | brief's «creates the template» fails: `Unable to find role="heading" and name "Шаблоны этикеток"`; full file: 9 failed (save, double-click, markup-notice, edit save, resized save, delete-after-dirty «leaves without asking»: `Unable to find ... удалён.`, extra 1) |
| M1b | same, run only «deletes a template after»                           | PASSES (that test deletes an unchanged editor); the dirty-delete path is killed by «leaves without asking …» (M1c: `Unable to find an element with the text: Шаблон «Молоко 58×40» удалён.`)                                                                           |
| M2  | drop `dirty &&`                                                     | 10 failed (`leaves without asking…`, copy/default tests, extras 1–3)                                                                                                                                                                                                   |
| M3  | condition replaced by `false`                                       | 5 failed: `Unable to find ... dialog "Уйти со страницы?"` / button «Уйти без сохранения» (includes the old «шаблона больше нет» test)                                                                                                                                  |
| M4  | `onClose` -> `blocker.proceed()`                                    | 3 failed: `Unable to find a label with the text of: Название`                                                                                                                                                                                                          |
| M5  | drop `submitVariant="destructive"`                                  | 1 failed: `expected false to be true`                                                                                                                                                                                                                                  |
| M6  | `useCallback` deps `[dirty]` -> `[]` (stale closure)                | 5 failed: dialog never appears                                                                                                                                                                                                                                         |
| M7  | drop the same-pathname clause                                       | killed only by extra 4: `expected '' to be '?x=1'` (the search change was blocked). Without extra 4 this mutant survives the plan's tests (no UI navigation keeps the pathname)                                                                                        |
| M8  | drop `!leaving.current` from the condition                          | 9 failed (same set as M1)                                                                                                                                                                                                                                              |
| M9  | `onSubmit`: `proceed()` -> `reset()`                                | 4 failed: `Unable to find role="heading" ...`                                                                                                                                                                                                                          |
| M10 | `onClose` -> no-op                                                  | 1 failed: `expected <div role="dialog"> to be null`                                                                                                                                                                                                                    |
| M11 | block only existing templates (`template !== null &&`)              | 1 failed (extra 2): dialog not found for a new template                                                                                                                                                                                                                |
| M12 | flip `!==` to `===`                                                 | 6 failed                                                                                                                                                                                                                                                               |
| M13 | (Task 5 file) drop `key={template.rev}` in `TemplateEditorPage.tsx` | 2 failed: stale-reload test and extra 3                                                                                                                                                                                                                                |
| M14 | `leaving.current = false`                                           | brief's «creates the template» fails: heading not found                                                                                                                                                                                                                |

No mutant is called equivalent.

## Findings / concerns

- `beforeunload` (closing the webview window or app): the brief and the code do nothing; closing the window with unsaved edits drops them silently. Matches the brief's note that the end of the session unmounts the office without asking (AGENTS.md), but it is a gap worth a decision (a Tauri close-requested guard would live in the shell, which is not ours).
- Browser Back: the office uses `createMemoryRouter` (no window history), so there is no Back button path; the blocker also guards POP navigations in a memory router, but no UI issues one and the office router is internal, so this is not tested.
- A save in flight while the user confirms leaving through the menu: the later `backToList` navigates to «Шаблоны» from an unmounted editor (pre-existing behaviour, not changed here).
- Header «Копировать»/«Удалить»: Task 6's existing tests click «Копировать» only from an unmodified draft and pass unchanged; with a dirty draft «Копировать» asks (covered by brief test 2), «Удалить» opens its own dialog and the delete then leaves without asking (covered by brief test 3, M1c).
- Test-file note: the brief's edit-2 anchor does not exist in this tree (see above); placement is the only deviation.

## Files

- /Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/office/templates/TemplateEditor.tsx
- /Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/src/i18n/ru.json
- /Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/apps/standalone/test/template-editor.test.tsx
