# Plan 1e3 — final fix wave report

HEAD at dispatch `55156873d`. Four commits, each with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`:

| #   | SHA       | Subject                                                                                           |
| --- | --------- | ------------------------------------------------------------------------------------------------- |
| 1   | 96b7b59ab | test(standalone): pin that the bootstrap request forwards its templates; fix test titles          |
| 2   | 3a31f4db8 | fix(standalone): CategoryScopeField lists codes the lookup lacks and keeps focus after a retry    |
| 3   | a8e4383d7 | fix(standalone): «Умолчания шаблонов» locks while saving, moves focus, and keeps the no-fit text  |
| 4   | 8bd75ac12 | docs(standalone): describe the defaults page lock, focus moves and the category field's code rows |

Counts: Vitest 47 files, 1101 -> 1102 (commit 1, +1) -> 1107 (commit 2, +5) -> 1113 (commit 3, +6). Final: **47 files / 1113 tests passed**. `typecheck`, `lint` green after commits 1, 2, 3 (commit 4 is documents only). Prettier clean on every changed file, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`, `git diff --stat 55156873d -- apps/station packages apps/standalone/{host,proto,src-tauri}` is empty, `git status --short` empty. Every touched test file ran with `--reporter=verbose` (stderr 0 bytes) and under the delayed-`setImmediate` 3 ms stand (commit 2: category-scope-field + templates-page, 65/65; commit 3: defaults-form + template-defaults-page, 64/64); stand files deleted again. The defaults page file also ran twice more plainly with no flake.

## Commit 1

- Item 1: `test/api.test.ts` new `describe("HostApi bootstrap")` with one recording-client case; the `POST /v1/bootstrap` body strictly equals the parsed `proto/fixtures/bootstrap-request-templates.json` request (non-empty `templates`). GREEN on the code; RED on mutant `src/host/api.ts` `{ body: request, … }` -> `{ body: { ...request, templates: undefined }, … }` (1 failed / 41 passed), restored, sha256 `f5910145…8858` before and after, `cmp` silent.
- Items 15, 19, 28: titles/comments only. `openCategories` doc now says it asserts the dialog and does not wait for the lookup (tests that read a group rely on `openTemplates` returning after the groups loaded); extra 6 retitled («open «Категории» from the button named after the «Коробка 58×40» template»); Task 3's title now «the cell with the two action buttons stays on one line»; item 19 -> «does not read the templates again after a 500 or after a stale save»; T2 and T3 retitled to what they check; the T2 comment is now true: a second assertion pins the purpose cell as `nowrap` (no further inline-style assertions).

## Commit 2

- Item 11: `CategoryScopeField` lists the chosen codes the lookup lacks after the named groups as checkboxes «Код N» (`office.templates.groupCode`, the text path `groupName` uses), in ascending code order, shown while the search is empty, filtered by the search against that label text (so «код 9» finds «Код 99»; chosen: match on the label text, nothing special for a bare number). Unticking one removes it from the value. «Ничего не найдено» only when neither groups nor codes match. New pure helper `codesWithoutGroup` in `category-scope.ts`.
- Item 12: a ref flag set by the retry button; an effect on `groups.isSuccess` focuses the search box (found by a `useId` id, because `Input` does not forward a ref) and clears the flag. A plain load does not move focus (own test).
- Tests (field file): code list + order + search + untick; no code rows when the lookup names every group; focus after retry (`waitFor`); no focus move without a retry. Page test (`templates-page.test.tsx`): fixture «Вода и молоко» `[8, 13, 99]` shows «Код 99», unticking it and saving sends `[8, 13]` with `DRINKS.rev`.
- RED: field file 2 failed before the fix (code list, focus); the page test failed against the pre-fix `CategoryScopeField` (1 failed / 46 passed).

| Mutant                                                | Failing test                     | Restore                     |
| ----------------------------------------------------- | -------------------------------- | --------------------------- |
| `codesWithoutGroup` without `.sort`                   | code list test (order)           | sha `4ea91eb4…`, cmp silent |
| retry button without setting the focus flag           | «moves focus to the search box…» | sha `16e31c7e…`, cmp silent |
| code rows not filtered by the search                  | code list test                   | same                        |
| «nothing found» ignores code rows                     | code list test                   | same                        |
| `codesWithoutGroup` keeps the codes that HAVE a group | 3 tests                          | `4ea91eb4…`                 |

## Commit 3

- Items 16 + 25: `|| saving` on the three organization selects, the row selects, «Убрать», «Добавить умолчание категории» («Отменить изменения» as it was). Safeguard: `defaultsFailure(error, sent, current = sent)` returns the general alert (`alertFailure`) for a field refusal naming a category row that the draft no longer holds; the page passes `currentCategories` (a ref updated every render).
- Item 29: «Убрать» is also `disabled` while `!templates.isSuccess`; assertions added to the existing «keeps the choices off while the templates do not load…» and to its loading twin (disabled while pending/failed, enabled once the list is there).
- Items 22 + 26: one `focusAfterRender` ref plus a per-render effect (skipped while `saving`, because the controls are off then and cannot take focus). After «Убрать»: the next row's «Убрать» in the shown order, else the previous row's, else «Добавить умолчание категории». After a field refusal: the organization select by field or the row select by slot key. Ids are `useId`-based. Note: the page's prop is named `document`, so the effect uses `globalThis.document`.
- Item 21: dialog `nothingFits` (`purpose !== "" && choices.length === 1`); on submit with an empty template the error is `office.templateDefaults.noTemplateFits` when nothing fits, else `chooseTemplate`. The hint uses the same constant. No new i18n key.
- Tests added (+6): defaults-form unit for the safeguard; lock test (all controls disabled while held, back on after a 500 and after the answer; two held saves); focus after «Убрать» (middle -> next, last -> previous, previous again, only row -> Add button) and first row -> next; focus on refusal (500 leaves focus where it was, organization select, row select with `aria-describedby`); no-fit text under «Шаблон» (aria-invalid true, one text, no «Выберите шаблон», dialog open, no row added; with no purpose it still asks for the template).

| Mutant                                                | Failing test                              | Restore                     |
| ----------------------------------------------------- | ----------------------------------------- | --------------------------- |
| organization select without `\|\| saving`             | lock test                                 | sha `c3a1b654…`, cmp silent |
| row select without `\|\| saving`                      | lock test                                 | same                        |
| «Убрать» without `\|\| saving`                        | lock test                                 | same                        |
| «Убрать» without `!templates.isSuccess`               | the failed-list test and the loading twin | same                        |
| «Добавить умолчание категории» without `\|\| saving`  | lock test                                 | same                        |
| neighbour order prev-then-next                        | focus after «Убрать»                      | same                        |
| neighbour = next only                                 | focus after «Убрать»                      | same                        |
| removal sets no focus target                          | both removal tests                        | same                        |
| refusal sets no focus target                          | focus on refusal test                     | same                        |
| `defaultsFailure` safeguard clause replaced by `true` | defaults-form safeguard test              | sha `4198abe5…`             |
| dialog ignores `nothingFits`                          | no-fit dialog test                        | sha `26afa43b…`             |

## Mutants that survived (reported, not hidden)

1. `if (target === null || saving) return;` -> `if (target === null) return;` in the focus effect: all tests green. The guard only matters if React renders the refusal's `setFieldError` and the `.finally` `setSaving(false)` in two separate renders; they are batched, so the guard is defensive and the mutant equivalent in practice. I kept the guard (cheap, makes focus independent of batching) and did not find a way to split those renders from a test.
2. The page passing `sent` instead of `currentCategories.current` to `defaultsFailure`: green. With the lock in place a row cannot leave the draft while a save is on its way (the buttons are disabled and React ignores clicks on disabled buttons), so no UI path makes the draft differ from `sent`. The decision itself is killed by the defaults-form unit test; the page wiring is covered by typecheck only.

## Deviations and notes

- `apps/standalone/src/office/templates/category-scope.ts` (commit 2) and `defaults-form.ts` (commit 3) were edited although the brief names only the component files: the first gets the pure helper, the second the `current` parameter, which is what the named `defaults-form.test.ts` tests. No other file outside the brief changed.
- Safeguard test is a unit test of `defaultsFailure`, not a page test, for the reason in surviving mutant 2. I first wrote a page test for it, saw it test only the lock, and deleted it.
- Item 22 fallback: when the last row goes and «Добавить умолчание категории» is disabled at that moment (the group lookup failed), `focus()` on the disabled button does nothing and focus is not moved elsewhere (decision: leave it).
- The office shell keeps focus on `<main>` after navigation, so the "no focus move after a 500" assertion compares against the element focused before, not `<body>`.
- Not verified: no browser, no screen reader (focus scrolling and error announcement are jsdom-level `document.activeElement` only), no real host.
- The plan file was not touched; «Отклонения при исполнении» and «Перенесено» stay with the controller (the draft is in the final review report).
