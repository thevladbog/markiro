# Plan 2a3, Task 4 — «Запланировать смену» (report)

Worktree `/tmp/claude/wt/2a3-office`, branch `claude/2a3-office`. BASE `2ae038ebb`. Commit `1756f5664 feat(standalone): the office plans a shift` (trailer: one `Co-Authored-By: Claude Opus 5.5` line, verified). Nothing pushed; `git status --short` is empty after the commit; the delayed-`setImmediate` stand files were removed.

Status: DONE_WITH_CONCERNS (concerns at the end are small).

## What was done

All plan steps were applied (anchors matched exactly once: ru.json x2, access.ts, ShiftsPage.tsx x8, support/shifts.ts x4; the three created files are the plan's text). Then I hunted the lessons list and changed/added beyond the plan:

Source changes beyond the plan's text

1. Focus to the first refused field. `@markiro/ui` `Select`/`DatePicker` take no `ref`, so react-hook-form's own focus reaches only the two `register`ed inputs (it would have focused the plan before an unchosen product). Now `useForm({ shouldFocusError: false })`, every control has an `id` (`useId` prefix + field name), `handleSubmit`'s second argument records the first invalid field in form order (`SHIFT_FIELD_ORDER`, new export of `shift-form.ts`), a host-refused field is recorded too, and a render effect focuses it once `isSubmitting` is false (same `focusAfterRender` pattern as `TemplateEditor`).
2. In-flight lock of all seven controls (`disabled={locked || …}`, `locked = formState.isSubmitting`): a product chosen mid-flight would move capacity/template under the request. `FormDialog` already locks the buttons/close/second submit.
3. `clearErrors(["boxCapacity","boxTemplateId"])` in `chooseProduct`: a refused "capacity/template" message no longer outlives the value the product just set (setValue does not revalidate; the plan deliberately avoids `shouldValidate` because it is async).
4. Minors item 4 (silent time-zone fallback): new `isKnownTimeZone` in `src/lib/civil-date.ts` (+1 test in `test/civil-date.test.ts`). A profile whose zone this runtime does not know now starts on this PC's date and says so with a new key `office.shifts.fields.localDateZone` («Этот ПК не знает часовой пояс организации: «сегодня» — по часам этого ПК.»); profile not loaded keeps the plan's `localDate`. `ShiftForm` prop `zoneKnown: boolean` became `dateNote: "localDate" | "localDateZone" | null`.

Tests beyond the plan (`test/shift-dialog.test.tsx`: 17 plan tests + 16 mine = 33): loading dialog while the profile is read (button off, no fields); default date on both sides of the organization's midnight (Moscow 20:59:59Z / 21:00:00Z); unknown zone caption; capacity/template error cleared by the product; `productId` / `productionDate` / `boxCapacity` refusals under their fields; `forbidden` as an alert above the fields; focus order (and that the form's own focus does not visit the plan first); focus on the host-refused field; lock of all seven controls + Cancel in flight, freed after a refusal, typed values kept, retry goes out; hints and disabled selects when products / lines / counterparties lists fail; closing drops input, sends nothing, reopens clean; notice gone when the next dialog opens; alert gone at the next submit; hostile product name shown as text. `test/support/shifts.ts` as the plan says (`user`, org + defaults defaults, `openShifts` returns `RenderResult`); `openCreate` in the test file returns the view for the midnight loop.

Not changed: host rules were read (`office_shifts.rs::create_shift`, `shifts.rs::shift_product/check_counterparty/check_box_template`, `require_active_line`): the form sends exactly the `ShiftCreate` fields (`mode: aggregation`, `palletsEnabled: false`, `plannedQty`/`counterpartyId` null for none); refusals `validation_failed` on productId/lineId/counterpartyId/boxTemplateId/productionDate/plannedQty/boxCapacity and `conflict`/`product_inactive` are all mapped; there is no `expectedRev` on a create and no `details.currentRev` use.

## Evidence

RED (before wiring; `ShiftDialog.tsx`/`shift-form.ts` already present, page not wired): `vitest run test/shift-dialog.test.tsx` — 17 failed (17), each `Unable to find an accessible element with the role "button" and name "Запланировать смену"` (grep count 17).

GREEN: `vitest run test/shift-dialog.test.tsx test/shifts-page.test.tsx test/civil-date.test.ts --reporter=verbose` — 3 files, 96 tests passed, stderr empty (0 bytes). Same files under the delayed-`setImmediate` stand (3 ms): 96 passed, stderr empty.
The one `act(...)` warning I met along the way (async revalidation after choosing a product after a failed submit) is handled in the test by waiting for the product's own error to go.

Gates: `typecheck` 0; `lint` 0; `prettier --check` on all changed files clean; `git diff --check` clean; `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`; no `var(--…)` in the new sources (no CSS touched); no `any`/casts/`!` in sources (`as const satisfies` only).

Full suite `pnpm … test`: 73 files, 1895 tests passed, exit 0, stderr only the `$ vitest run` banner. The plan says 72 files / 1839 (1822 + 17). My count is the plan's 17 + 16 of mine in the dialog file + 1 in civil-date = +34 over the pre-task base, i.e. a base of 72 files / 1861 tests on this branch (other plans' tests landed before); both numbers reported, plan not edited.

## Mutants (one-line scratch mutants; each file restored: `cmp` silent and sha256 equal before/after, checked by the script for every row; ran `shift-dialog.test.tsx` + `shifts-page.test.tsx`)

| Mutant                                                                                        | Killed by (test in "office shifts: planning a shift >")                                 | Result                     |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| M1 capacity not set from product (plan 1)                                                     | takes the box capacity and the template from the product… (and 16 others)               | killed                     |
| M2 draft product offered (plan 2)                                                             | offers the products in use by name… ; lets the product be chosen only once…             | killed                     |
| M2b archived product offered                                                                  | offers the products in use by name…                                                     | killed                     |
| M3 template refusal does not re-read templates (plan 3)                                       | puts a template switched off meanwhile under the template and reads the templates again | killed                     |
| M4 today by this PC's clock (plan 4)                                                          | starts on today in the organization's time zone                                         | killed                     |
| M5 product_inactive not under product (plan 5)                                                | puts a product no longer in use under its field…                                        | killed                     |
| M6 product enabled before templates/defaults read (plan 6)                                    | lets the product be chosen only once the templates and the defaults are read…           | killed                     |
| M7 drop `clearErrors([capacity, template])`                                                   | takes a refused capacity and template error away once a product fills them              | killed                     |
| M8 host-refused field not focused                                                             | puts the focus on the field the host refused                                            | killed                     |
| M9 focus order: line before product                                                           | puts the focus on the first refused field in the form's order                           | killed                     |
| M29 remove `shouldFocusError: false`                                                          | same test (after I added the focus-spy on the plan input; it SURVIVED before that)      | killed after strengthening |
| M10 `locked = false`                                                                          | holds every control while the write is on its way…                                      | killed                     |
| M10a–g lock dropped per control (product, line, date, plan, capacity, template, counterparty) | same test, each                                                                         | 7 killed                   |
| M11 unknown zone taken as known                                                               | starts on this PC's date and says so when this PC does not know…                        | killed                     |
| M12 the two captions swapped                                                                  | zone-unknown and profile-not-loaded tests                                               | killed                     |
| M13 `if (org.isPending)` → `if (false)`                                                       | waits for the organization's profile behind a loading dialog…                           | killed                     |
| M14 `setNotice(null)` dropped in `open` (ShiftsPage)                                          | takes the notice away when the next dialog opens                                        | killed                     |
| M15 `setFailure(null)` dropped                                                                | takes the alert away when the next submit starts                                        | killed                     |
| M16 `return;` dropped in `catch` (falls to `onSaved`)                                         | 13 tests                                                                                | killed                     |
| M17 productId refusal unmapped                                                                | puts a product the host does not find under its field                                   | killed                     |
| M18 productionDate refusal unmapped                                                           | puts a date the host does not take under its field                                      | killed                     |
| M19 boxCapacity refusal unmapped                                                              | puts a capacity the host does not take under its field                                  | killed                     |
| M19b plannedQty / M19c lineId / M19d counterpartyId unmapped                                  | the it.each refusal tests (3 tests fail for lineId)                                     | 3 killed                   |
| M20 «Не выбран» offered as a template                                                         | the product-dependent template option tests (3 fail)                                    | killed                     |
| M21 archived line offered / M22 archived counterparty offered                                 | offers the products in use… (lines and counterparties lists)                            | 2 killed                   |
| M23 cleared date sent as `undefined`                                                          | refuses an empty product, line, template, capacity and date…; clear-date path           | killed                     |
| M24 no counterparty sent as `""`                                                              | sends no plan and no counterparty as null…                                              | killed                     |
| M25 template select not off before a product                                                  | offers the products in use… (disabled assertion)                                        | killed                     |
| M26 template list by group `null`                                                             | takes the box capacity and the template from the product…                               | killed                     |
| M31–M34 hint dropped for products / lines / counterparties / templates lists that failed      | says when a list does not load…; keeps the template off and says why…                   | 4 killed                   |
| M28 effect focuses without `isSubmitting` check                                               | none                                                                                    | SURVIVED (see concerns)    |
| M30 `Number(...)                                                                              |                                                                                         | null` for the plan         | none | SURVIVED, equivalent (`Number(" 1200 ")` is the same number; trimming of counts is pinned by Task 2's rule tests and by the `" 1200 "`/`" 20 "` inputs end to end) |

## Files

Created: `apps/standalone/src/office/shifts/ShiftDialog.tsx`, `apps/standalone/src/office/shifts/shift-form.ts`, `apps/standalone/test/shift-dialog.test.tsx`.
Modified: `apps/standalone/src/office/shifts/ShiftsPage.tsx`, `apps/standalone/src/office/access.ts` (`planShifts`), `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/lib/civil-date.ts` (+`isKnownTimeZone`), `apps/standalone/test/support/shifts.ts`, `apps/standalone/test/civil-date.test.ts`.

## Self-review / concerns

- M28: the `isSubmitting` guard in the focus effect cannot be observed: React batches RHF's `setError` and the `isSubmitting` reset of the same microtask, so the effect never runs while the controls are still disabled. It is kept as a cheap defence (a render in between would lose the focus because a disabled control cannot take it); no test can force that render. Remove it if you prefer no unobservable code.
- A cached `org` (visited «Организация» earlier) opens the form at once and the background refetch cannot move the already-fixed default date; a dialog left open across the organization's midnight keeps the old default (the same as any form default).
- A product that turns inactive while the dialog is open is caught by the host (`product_inactive` under the product), not by the list.
- The plan's expected numbers (72 files / 1839 tests) differ from the measured 73 / 1895; the difference is the base of this branch plus my 17 extra tests, see above.
- Not exercised: a real WebView2 / keyboard focus ring; only jsdom.
- Earlier I ran a few `cd` commands into `/tmp/claude` and `/dev/null` (never inside the repo); no `.cc-writes` directory was left under `/tmp/claude`.

## Fix round (review `2a3-task-4-review.md`; BASE 1756f5664)

Commits: `ae12228dc fix(standalone): Escape in the shift calendar closes only the calendar` (Important 1), `f88d6c8fe fix(standalone): a planned shift's failed create and refusals refresh the lists behind the dialog` (Minor 1 and Minor 4). One `Co-Authored-By: Claude Opus 5.5` line each. Only `ShiftDialog.tsx` and `shift-dialog.test.tsx` changed. Minors 2 and 3 are queued as `2a3-minors.md` items 9 and 10; items 11 (Tab out of the dialog, needs `packages/ui`) and 12 (refused id stays in the form value) are new.

### Important 1 — Escape in the calendar

- Event path verified: Radix `DismissableLayer` listens for Escape on `document` in the capture phase, closes the popover and calls `preventDefault()`; React's root listener then bubbles the synthetic `keydown` through the React tree (the portal does not cut it) to `Modal`'s `onKeyDown` on the overlay element, which closes on any Escape. So `defaultPrevented` is already true when the event reaches a wrapper around the `DatePicker`.
- Fix: `<div onKeyDown={keepCalendarEscape}>` around the `DatePicker`; `keepCalendarEscape` calls `stopPropagation()` for `Escape && defaultPrevented`.
- RED (pre-fix code, new test «closes only the calendar on Escape and keeps the dialog with what was typed»): `Unable to find an accessible element with the role "dialog" and name "Новая смена"` at the check after the calendar closed. GREEN: 34 passed.
- Tab out of the dialog: NOT fixed. The calendar sits outside the legacy `Modal`'s DOM and `OverlayPortalContext` is internal to `@markiro/ui` (Modal does not provide it), so only a `packages/ui` change fixes it cleanly (queued as minors item 11). A Tab handler in the webview would duplicate the popover's focus management.

| Mutant                                              | Test that failed                                                                                                                                                                                            | Key line                                   | Restore proof            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| `stopPropagation()` → `void 0`                      | closes only the calendar…                                                                                                                                                                                   | dialog gone after Escape                   | cmp silent, shasum equal |
| drop `&& event.defaultPrevented`                    | same test (the second Escape, on the date button with the calendar shut, must still close the dialog; first version of the test sent it to «Товар», outside the wrapper, and would have missed this mutant) | `expected <div role="dialog"…> to be null` | cmp silent, shasum equal |
| (equivalent, not run) drop `event.key === "Escape"` | none expected: other prevented keys in the calendar (arrows) reach no handler of the dialog                                                                                                                 |                                            |                          |

### Minor 1 and Minor 4 — lists behind the dialog

- Transport failure of the create: `queryClient.invalidateQueries({ queryKey: officeKeys.shifts })`; an answer of the host (`internal`) does not.
- Refusal on `productId` (also `product_inactive`) → `products.refetch()`, `lineId` → `lines.refetch()`, `counterpartyId` → `counterparties.refetch()` (the template's existed). Refusals on date, plan, capacity re-read nothing. No design decision was needed for the re-read; what to do with the refused id in the form value is queued (item 12).
- RED (new tests on the pre-fix code): 5 failed, 38 passed: lost-answer re-read (`expected "vi.fn()" to be called 2 times, but got 1 times`) and the four «reads the list again after the host refused …» cases (`expected true to be false`: the record was still offered). The 4 negative tests (no re-read after `internal`, after a date/plan/capacity refusal) pass on both sides, as they should. Note: the dialog's mount already re-reads the lists (staleTime 0), so the list tests count calls relative to the moment before the submit.
- GREEN: `shift-dialog` 43 passed.

| Mutant                                   | Test(s) that failed                                                             | Restore proof |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ------------- |
| transport condition → `false`            | reads the shifts again behind the dialog after a lost answer…                   | cmp, shasum   |
| transport condition → `true`             | does not read the shifts again after an answer of the host that planned nothing | cmp, shasum   |
| drop `products.refetch()`                | 2 (product_inactive, productId)                                                 | cmp, shasum   |
| drop `lines.refetch()`                   | the lineId case                                                                 | cmp, shasum   |
| drop `counterparties.refetch()`          | the counterpartyId case                                                         | cmp, shasum   |
| `lines.refetch()` on every field refusal | 3: reads no list again after a date / plan / capacity                           | cmp, shasum   |

All 6 killed; copies under `/tmp/claude/fix-2a3-t4/`.

### Gates

- `shift-dialog` verbose: 43 passed, stderr 0 bytes, no `act(`/`Warning`. Delayed-`setImmediate` stand (3 ms) on `shift-dialog` + `shifts-page`: 74 passed, stderr 0 bytes; stand files removed.
- `typecheck`, `lint` clean; prettier, `git diff --check` clean; `\u04` grep finds only `pairing-code.ts:66`; `git status --short` empty.
- Full `test` after commit 1: 4 failures, all `Test timed out in 5000ms` (`shifts-page` period test, three `template-editor` tests; the set changed between runs; machine load average 11–18, disk nearly full); the same two files with `--testTimeout=60000`: 128 passed. Full `test` after commit 2: 73 files, 1905 passed (before the fix round: 1896; +9 = 1 Escape + 8 list tests).
- Not exercised: real WebView2 keyboard behaviour; only jsdom.
