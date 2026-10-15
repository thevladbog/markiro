# Plan 2a3, Task 5 — «Правка запланированной смены и план активной» (report)

Worktree `/tmp/claude/wt/2a3-office`, branch `claude/2a3-office`. BASE `f88d6c8fe5b34eb9a24faacc6fc91264b20f7eb6`. Commit `80f99e34f feat(standalone): the office changes a planned shift and an active shift's plan` (one `Co-Authored-By: Claude Opus 5.5` line, verified with `git log -1 --format=%B`). Nothing pushed; `git status --short` empty after the commit; the delayed-`setImmediate` stand files were removed before `lint`.

Status: DONE_WITH_CONCERNS (concerns at the end are small).

## What was done

Plan steps applied in order: tests first (the plan's `shift-edit.test.tsx`, `shift-form.test.ts`, the two `cells(...).slice(0, 7)` edits in `shifts-page.test.tsx`), RED, then the implementation, then my extra tests and the mutants.

Files: `src/i18n/ru.json`, `src/office/shifts/{ShiftDialog.tsx,ShiftPlanDialog.tsx (new),ShiftsPage.tsx,shift-form.ts}`, `test/{shift-edit.test.tsx,shift-form.test.ts (new),shifts-page.test.tsx}`.

Anchors that matched verbatim (applied as written): all six `ru.json` fragments (steps 1–5), all of `ShiftsPage.tsx` (steps 17–22), all of `shift-form.ts` (steps 23–26), `ShiftPlanDialog.tsx` (step 16, new file), both `shifts-page.test.tsx` edits.

## Anchor adaptations (ShiftDialog.tsx; re-derived by hand on top of the Task 4 code)

The checker's NO MATCH for steps 6–15 was real; each edit was re-derived, every Task 4 behaviour (focus order, in-flight lock, `clearErrors`, `isKnownTimeZone` caption, Escape, refresh of lists) kept, and **no existing shift-dialog test was changed** (all 43 stay green unchanged).

- Steps 6–7 (imports, props, wrapper): `shift`, `onReload`, `onOutdated` added to `ShiftDialogProps`; `useOfficeQuery(officeKeys.org, …, { enabled: props.shift === null })`; the edit branch (`props.shift !== null`) returns `ShiftForm` BEFORE the `org.isPending` check (a disabled query stays pending forever, so the order matters), with `dateNote={null}` (Task 4 replaced the plan's `zoneKnown` prop with `dateNote`).
- Step 8 (signature): destructures `shift, onReload, onOutdated` next to the Task 4 `dateNote`.
- Step 9 (mutation): `shift === null ? createShift(shiftCreate(toShiftInput(values))) : updateShift(shift.id, shiftUpdate(shift, toShiftChange(values)))`.
- Step 10 (`useForm`): `isDirty` added to the existing `formState` destructuring (with Task 4's `isSubmitting`); `defaultValues` by `shift`; Task 4's `shouldFocusError: false` kept.
- Step 11 (own line / counterparty as marked options): pushed after the option lists, before `chooseProduct`, as in the plan; plus a new `ownTemplate` list (see "beyond the plan").
- Steps 12–13 (failure): Task 4's `outcome` handling has field / alert branches with focus and list re-reads. `shiftWriteFailure` is used only for a change (`shift !== null`); a new shift keeps `writeFailure` (see concern 1). `if (outdated) onOutdated();` sits after the field/alert branches, before the `return`, so the Task 4 re-reads (`products/lines/templates/counterparties.refetch()`, the transport-failure `invalidateQueries`) still run.
- Step 14 (JSX header and product): title / `submitLabel` / `submitDisabled={shift !== null && !isDirty}` / `WriteFailureAlert onReload`; the product `Controller` goes into the `shift === null` branch unchanged (with Task 4's `id`, `locked` and hint), edit shows `productFixed` (`recordLabel("product", …)`).
- Step 15 (template `kept`): `[shift?.boxTemplateId ?? "", field.value]` in the Task 4 call.

## Beyond the plan

Sources

1. Template select of a change whose product record is unknown (products list failed): the plan would leave `options=[]` and the select blank. Now it offers the shift's own template (by name, or `Шаблон xxxxxxxx…`), no "fits" claim; placeholder is `templatePlaceholder` (not «Сначала выберите товар») when editing; hint «Список товаров не загрузился…» under the template.
2. Counterparty hint while editing and the list failed: new key `office.shifts.fields.counterpartiesUnavailableEdit` «Список контрагентов не загрузился: контрагент смены не меняется.» (the create text says «смена будет без контрагента», false for a change whose counterparty is kept).
3. `ShiftPlanDialog`: `readOnly={isSubmitting}` on the plan (read-only, not disabled: a disabled input would lose the focus given back to a refused value); `setError(..., { shouldFocus: true })` for a field refusal; RHF's own focus covers the zod refusal (single registered input).

Tests beyond the plan (19 added; `shift-edit.test.tsx` 10 plan + 19 = 29): all six fields changed at once sent trimmed and without the product; Save off again after an edit is undone; opens without the organization profile (`getOrg` never asked, a never-resolving `getOrg` does not hold the dialog); archived product named; line/counterparty/template missing from the lists named by id; lists failing (own choices kept, disabled, hints); going back to the shift's own marked choices after leaving them (template `kept`), Save off when back; close drops edits, nothing sent, reopens on own values; line refused by the host (message under the select, focus, lines re-read); in-flight lock of all six controls + Cancel, freed after a refusal, same revision resent; lost answer re-reads the shifts; `shift_status` then a re-read list with a newer revision: the dialog still sends the OPENED revision (72, not 99); a new shift's `not_found` is not "deleted shift" and re-reads nothing; plan dialog: starts empty + hint + first plan; refused plan focus (zod); host-refused plan under the field with focus; plan and Cancel held in flight; stale -> reload closes and re-reads; `not_found` -> gone message and re-read.

## Evidence

RED (plan tests, before code): `vitest run test/shift-edit.test.tsx test/shift-form.test.ts` -> 2 files failed, 14 tests failed (10 + 4 as the plan says): 7x `Unable to find … name "Изменить смену OCT26-005"`, 2x `… "Изменить план смены OCT26-004"`, 1x role button, 2x `shiftFields is not a function`, 2x `shiftWriteFailure is not a function` (`/tmp/claude/t5/red1.txt`).

GREEN: `vitest run test/shift-edit.test.tsx test/shift-form.test.ts test/shift-dialog.test.tsx test/shifts-page.test.tsx --reporter=verbose` -> 4 files, 107 tests passed, stderr 0 bytes, no `act(`. Same four files under the delayed-`setImmediate` stand (3 ms): 107 passed, stderr 0 bytes (stand files removed).

Gates: `typecheck` 0; `lint` 0; `prettier --check` (changed src/test/json) clean; `git diff --check` clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`; no `any`, casts or `!` in the sources (the casts in tests are the existing `as HTMLSelectElement` style); no CSS touched.

Full `pnpm … test`: **75 files, 1938 tests passed**, exit 0, no timeouts (plan: 74 files, 1853 = 1839 + 14, measured on a copy before Task 4's fix rounds; mine 1905 before this task + 33: 14 plan + 19 extra; files +2).

## Mutants (all killed; each reverted byte-identically: `cmp` silent, `shasum -a 256` equal before/after, backups in `/tmp/claude/t5/orig/`, logs `/tmp/claude/t5/mut-m*.log`, harness `/tmp/claude/t5/mut.py`)

| #           | Mutant (one line)                                                     | Tests that failed                                              |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| m1 (plan 1) | `lineOptions.some(...)` -> `lineOptions.length < 0`                   | marked choices; go back to own marked choices                  |
| m2 (plan 2) | `gone` `outdated: true` -> `false`                                    | shift: deleted meanwhile; plan: deleted meanwhile              |
| m3 (plan 3) | `status === "active"` -> `"closed"` for `nowActive`                   | shift-form: outdated in words of its own                       |
| m4 (plan 4) | `toCount(...)` -> `Number(...)` in the plan dialog                    | active plan alone, clears it with null                         |
| m5 (plan 5) | `submitDisabled={false}`                                              | opens with own values, saves only after a change               |
| m6          | own counterparty condition inverted                                   | marked choices; go back                                        |
| m7          | `counterpartyId` dropped from `toShiftChange`                         | clears the plan and counterparty with null; all fields changed |
| m8          | `boxCapacity` dropped from `toShiftChange`                            | marked choices; all fields changed                             |
| m9          | template `kept` `[own, value]` -> `[value]`                           | go back to own marked choices                                  |
| m10         | page hands the dialog the fresh list row instead of the opened one    | keeps the revision it was opened with                          |
| m11         | org query `enabled: true`                                             | opens without the organization profile (`getOrg` not asked)    |
| m12         | edit branch removed from the wrapper (waits for org)                  | same test                                                      |
| m13         | `shiftWriteFailure` also for a new shift                              | a new shift's `not_found` is not a deleted shift               |
| m14         | `if (outdated) onOutdated()` removed (ShiftDialog)                    | shift: deleted meanwhile                                       |
| m15         | same, ShiftPlanDialog                                                 | plan: deleted meanwhile                                        |
| m16         | `readOnly={isSubmitting}` -> `false`                                  | holds the plan and Cancel in flight                            |
| m17         | `shouldFocus: true` -> `false`                                        | host-refused plan focus                                        |
| m18         | page `reload` does not re-read                                        | both stale tests                                               |
| m19         | `ownTemplate` always `[]`                                             | lists do not load                                              |
| m20         | counterparty `disabled` without `locked`                              | holds every control in flight                                  |
| m21         | counterparty hint condition inverted                                  | lists do not load                                              |
| m22         | template placeholder for edit back to «Сначала выберите товар»        | lists do not load                                              |
| m23         | `const own = null` (own counterparty never kept)                      | marked choices; go back                                        |
| m24         | «Изменить» for every non-closed status                                | offers change / plan / nothing for closed                      |
| m25         | edit notice «Смена … запланирована» instead of «Изменения сохранены.» | sends only what changed                                        |
| m26         | body = `{...toShiftChange(values), expectedRev}` (every field sent)   | sends only what changed                                        |
| m27         | plan body also carries `counterpartyId: null`                         | active plan alone; first plan alone                            |
| m28         | product named through the line list                                   | opens with own values and product named                        |

## Self-review notes

- Host rules re-read (`update_shift`): planned changes every sent field except the product, active takes `plannedQty` only (unchanged fixed fields are no change), closed refused, `expectedRev` checked BEFORE the status, `plannedQty`/`counterpartyId` `null` clears; the bodies sent match.
- No retry with `details.currentRev` anywhere; `stale_revision` -> «Загрузить заново» closes the dialog and re-reads (edits dropped).

## Concerns

1. Deviation from the plan text: `shiftWriteFailure` is used only for a CHANGE; a new shift keeps `writeFailure`. The host can answer a create with `not_found` ("the host is not initialized", `shifts.rs:296`), which `shiftWriteFailure` would show as «Этой смены больше нет: её удалили». Pinned by a test and mutant m13.
2. Because `update_shift` compares the revision first, `shift_status` is reachable only when the revision still matches; in practice a shift opened/closed meanwhile mostly comes back as `stale_revision` (-> «Загрузить заново»). The `shift_status` / `not_found` paths exist as the brief wants and are tested with mocked refusals. After `shift_status` the dialog stays (brief), Save stays on and resends the OPENED revision, which the host then answers `stale_revision`.
3. A change that is dirty for RHF but empty for the host (for example the plan typed as spaces over no plan) sends `{ expectedRev }` alone; the host answers the current record without a write ("Изменения сохранены."). Left as the brief describes (`isDirty`); no test pins it.
4. Queue items 11 (Tab leaves the dialog from the calendar) and 12 (the refused id stays in the form value while its option disappears) apply to the edit dialog too; not changed.
5. Plan counts differ from the plan's measured ones: plan 4 files / 44 tests -> measured 4 files / 107 (Task 4's extra tests); full 74 / 1853 -> 75 / 1938.
6. jsdom only: no real WebView2 keyboard/focus behaviour, no browser pass.

Report path: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/.superpowers/sdd/2a3-task-5-report.md`

---

# Fix round (review Important 1, Minors 1-3)

BASE `80f99e34f`. Commits: `a00f9d9be fix(standalone): a refusal on the product is shown in the shift edit dialog`, `2be76fee4 fix(standalone): an edit that changes nothing sends nothing; an outdated shift cannot be saved again`. One `Co-Authored-By: Claude Opus 5.5` line each. Nothing pushed; `git status --short` empty. Scratch (harness, logs, restore copies): `/tmp/claude/fix-2a3-t5/`.

## Commit 1 - Important 1 (a product refusal in the edit dialog)

- `ShiftDialog.tsx`: in the catch, a `field` outcome on `productId` for a changed shift (`shift !== null`) is `setFailure({ kind: "alert", message })` and `products.refetch()`; no `setError`, no focus on a control that is not rendered. A new shift keeps the field path (create tests cover it, mutant c1-m4).
- A line under the product text: `openBlocker(shift, products.data, undefined)` (the list page's own rule, product part only) renders `office.shifts.blockers.product_archived` / `product_draft` ("Не откроется: ..."). No new i18n key.
- Tests (RED on the old code, both): "says a product that is no longer in use refused the change, and reads the products again" (archived product, templates `[BOX_58, BOX_70]`, choose BOX_70, `updateShift` rejects `conflict` `product_inactive`; asserts the alert text, `listProducts` re-read and the exact body `{ boxTemplateId, expectedRev: 72 }`) and "says under the product that a shift of an archived or draft product will not open" (archived, draft, and none for an active product).
  - RED: `Unable to find an element with the text: Товар больше не в работе: он в архиве или стал черновиком` and `... Не откроется: товар в архиве` (`red1.log`, `Tests 2 failed | 29 skipped`).
  - GREEN: `shift-edit` 31 passed.

| Mutant (one line)                                                          | Test that failed                                                                                                              | Restore            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| c1-m1 drop `setFailure(alert)`                                             | "...refused the change, and reads the products again"                                                                         | sha equal, `cmp` 0 |
| c1-m2 drop `products.refetch()` in that branch                             | same test                                                                                                                     | sha equal, `cmp` 0 |
| c1-m3 hint never rendered (`false &&`)                                     | "...will not open"                                                                                                            | sha equal, `cmp` 0 |
| c1-m4 drop `shift !== null &&` (create's product refusal becomes an alert) | `shift-dialog`: "puts a product no longer in use under its field...", "puts a product the host does not find under its field" | sha equal, `cmp` 0 |
| c1-m5 hint always "archived"                                               | "...will not open"                                                                                                            | sha equal, `cmp` 0 |

Gates: four focused files (`shift-edit`, `shift-dialog`, `shifts-page`, `shift-form`) verbose 109 passed, stderr 0 bytes; delayed-`setImmediate` stand (3 ms) 109 passed, stderr 0 bytes; stand files removed. Full package `test`: 75 files / 1940 passed; typecheck, lint, prettier, `git diff --check` clean; the `\u04` grep finds only `pairing-code.ts:66`.

## Commit 2 - Minors 1, 2, 3

- Minor 1: in the dialog and `ShiftPlanDialog` the request body is built in the submit handler (`shiftUpdate(...)`); when it holds only `expectedRev` (`Object.keys(...).length === 1`), the dialog calls `onClose()` with no request and no "Изменения сохранены.". The mutation now takes `{ create } | { id, update }`.
- Minor 2: a new state `outdatedMessage` (set for the `outdated` outcome, which is an alert): `submitDisabled` includes it, and the alert is `StaleAlert` with that message and «Загрузить заново» (`onReload` closes and re-reads, like the stale case). Both dialogs.
- Minor 3: the lost-answer test title lost "and keeps the opened revision".
- **Changed earlier test (disclose):** "keeps the revision it was opened with when the list behind it is read again" used a `shift_status` refusal and then pressed «Сохранить» again; that resend is exactly what Minor 2 removes. It now triggers the re-read with a lost answer (transport error: the alert shows, the list is re-read and shows the shift `Активна`, resend carries `expectedRev: 72`). Same assertion, different trigger. No other earlier test was touched; shift-dialog and shifts-page are unchanged.
- New tests (5, all RED on the old code, `red2.log`: `Tests 5 failed | 31 passed`): blanks-only edit (dialog), blanks-only plan (plan dialog), outdated x2 (`shift_status` active, `not_found`) in the dialog, outdated (`shift_status` closed) in the plan dialog. Each outdated test asserts «Сохранить» off, the reload button, what was typed kept, the dialog closing on the button, and one `updateShift` call.
- GREEN: `shift-edit` 36 passed.

| Mutant (one line)                                       | Test that failed                                                                   | Restore            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| c2-d1 dialog: `length === 1` -> `99`                    | "sends nothing and closes without a word when the form differs ... in blanks only" | sha equal, `cmp` 0 |
| c2-d2 plan: same                                        | "...when the plan differs ... in blanks only"                                      | sha equal, `cmp` 0 |
| c2-d3 dialog: `onClose()` -> `onSaved(shift!)` (notice) | the dialog blanks-only test                                                        | sha equal, `cmp` 0 |
| c2-d4 plan: `onClose()` -> `onSaved(shift)`             | the plan blanks-only test                                                          | sha equal, `cmp` 0 |
| c2-d5 dialog: outdated branch off                       | both "switches «Сохранить» off ... was opened/deleted"                             | sha equal, `cmp` 0 |
| c2-d6 plan: outdated branch off                         | "...once the shift was closed"                                                     | sha equal, `cmp` 0 |
| c2-d7 dialog: Save not disabled when outdated           | both dialog outdated tests                                                         | sha equal, `cmp` 0 |
| c2-d8 plan: Save not disabled when outdated             | the plan outdated test                                                             | sha equal, `cmp` 0 |

(A ninth, meaningless mutant on the create path also failed 22 shift-dialog tests; not counted.)

Gates: four focused files verbose 114 passed, stderr 0 bytes; stand 114 passed, stderr 0 bytes; full `test` first run 1943/1945 (two `templates-page` 5 s timeouts under load; that file alone 55 passed), re-run: 75 files / 1945 passed; typecheck, lint, prettier, `git diff --check` clean.

Not run: cargo (no Rust change), WebView2/real browser. Minor 4 (template defaults loaded in edit) left as is (optional). The plan docs were not touched for Minor 1.
