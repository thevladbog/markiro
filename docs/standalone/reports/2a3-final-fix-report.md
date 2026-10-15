# Plan 2a3: final fix wave report

Worktree `/tmp/claude/wt/2a3-office`, branch `claude/2a3-office`. BASE `f543a551b`, HEAD `105ad8bca` (12 commits, test and production separate, one Co-Authored-By trailer each). Only `apps/standalone/{src,test,AGENTS.md}` and the stage 2a spec changed. `git status --short` empty; stand files deleted after each run.

## Commits

| #   | SHA       | Subject (short)                                                                                 | Items             |
| --- | --------- | ----------------------------------------------------------------------------------------------- | ----------------- |
| 1   | 38bc4ab96 | test: 400-year leap rule, exact failure texts, admin exhausted pallet counter                   | 3, 5, 16, 20      |
| 2   | 69fbcd0ab | test: refused record kept as marked choice, date note frozen, defaults hint (RED)               | 9, 10, 12, M4     |
| 3   | 618d0bd4c | fix: same, production                                                                           | 9, 10, 12, M4     |
| 4   | 28565b4d3 | test: lost answer re-reads the list in plan/delete/close (RED)                                  | 13, M3            |
| 5   | ce458c0ab | fix: `useRereadShiftsOnLostAnswer` in all four dialogs                                          | 13, M3            |
| 6   | 8b1c136c6 | test: search ignores placeholder/mark, exact lookups note, focus to notice (RED)                | 6, 7, 14          |
| 7   | 327a7eb8d | fix: same, production                                                                           | 6, 7, 14          |
| 8   | bd21c5e85 | test: Enter in the reason inserts no line break, hint (RED)                                     | 15                |
| 9   | 3172eb29e | fix: same                                                                                       | 15                |
| 10  | f2ed0148f | test: device dialog, no-line text (RED)                                                         | 18                |
| 11  | f6f83fac9 | fix: same                                                                                       | 18                |
| 12  | 105ad8bca | docs: I1, M1, M2, M5, shrunken known gaps, sentences of every changed behaviour, item 2 comment | I1, M1, M2, M5, 2 |

Items 4, 8, 11, 17, 19 untouched (DROP/CARRY). The plan file is not edited.

## What changed per item

- **3** `civil-date.test.ts`: 2100-02-29 and 2200-02-29 refused, 2400-02-29 accepted, day counts 2100 (1) and 2400 (2). Mutant `year % 200` now killed (it survived before).
- **5** `civil-date.test.ts`: PC-calendar test is `it.skipIf(process.platform === "win32")` with the reason. Mutant `"win32"`→`"darwin"` makes it skipped (32 passed, 1 skipped).
- **16** `shift-delete-close.test.tsx`: five failure tests (206, 222, 240, 521, 539 of the old numbering; the review named three) assert the exact words (`LOST_WORDS`, `FORBIDDEN_WORDS`). The alert puts an icon glyph "✕" before the words, so `toContain`, not `toBe`.
- **20** `sscc-page.test.tsx`: admin sees an exhausted PALLET counter as "!Номера закончились" with no button, the box counter keeps its "Изменить". Killed only by the new test: mutant `isExhausted(counter) && counter.extension === 0 ? null : (` in `SsccPage.tsx`.
- **9** `ShiftForm` freezes `today`/`dateNote` at mount (`useState(() => …)`). New file `test/shift-dialog-date-note.test.tsx` (held query client, as `shifts-refetch.test.tsx`): success then failing refetch shows no note; failure then success keeps the note and the date.
- **10** new key `office.shifts.fields.defaultsUnavailable` under the template while `shift === null && defaults.isError`. Tests: water (no template) and milk (preference) both show it; nothing is said when the defaults loaded.
- **12 + M4** `keep(options, ids, label)` in `ShiftDialog`: the form's product (create only), line (`[shift.lineId, current]`) and counterparty (`[own, current]`) stay offered if missing, via `recordLabel`; a product that is not archived but not active gets the new key `office.shifts.draftName` "«{{name}} (черновик)»". The counterparty is never cleared; a test resends and sees the same `counterpartyId`, then picks «Не выбран» on purpose and sees `null`. The old it.each "no longer offered" test was rewritten to "the select shows the marked record" (5 rows: inactive, unknown, draft, line, counterparty) plus one edit-mode test (line then counterparty chosen and refused).
- **13 + M3** `shift-reread.ts`: hook `useRereadShiftsOnLostAnswer` (invalidates `officeKeys.shifts` on `HostError.kind === "transport"`), used by `ShiftPlanDialog`, `DeleteShiftDialog`, `CloseShiftDialog` and, replacing its own copy, `ShiftDialog`. The delete test pinning one `listShifts` call now expects 2. Added "leaves the list alone after a refusal" tests for delete, close and plan.
- **6** `ShiftsPage` passes `searchName` (the record's own name, `""` when absent) to `findShifts`; `shift-list.ts` comment updated.
- **7** `lookupsFailed` reworded as the review proposed; exact-text test with only the templates failing.
- **14** `Alert id/tabIndex=-1` + effect `[notice]` focusing it. Helper `expectFocusedNotice` in `test/support/shifts.ts`; tests for create, edit, plan, delete (row gone) and close. RED showed the focus on `<main tabindex=-1>`, not body.
- **15** `keepOneLine` on the textarea: Enter (any modifier) is `preventDefault`ed unless `nativeEvent.isComposing`; `reasonHint` = "От 3 до 500 символов, одной строкой. …". Paste is still refused by the rule (existing test).
- **18** two keys, `shiftOnStation` (to a line, unchanged) and `shiftOnStationNoLine` ("Если убрать линию, станция доделает начатую работу, выведет оператора и попросит выбрать линию; …"), chosen by `watch("lineId") === ""`.
- **2** comment: "Days since 1970-01-01 (negative before it)".
- **Docs** AGENTS.md: devices bullet (two texts, silent-note left to owner), «Смены» bullet (I1: `totals` in every `OfficeShift` incl. the list, fixture `office-shift.json`, no detail fixture, the branch merging second updates schema and test shifts), lookups note, search, create dialog (frozen note, defaults note, marked choices, counterparty never cleared), reason (Enter, hint), revision bullet (M1: stale_revision for change/close, own-words alert on delete's `shift_status` and `not_found`; M2: delete sends no `expectedRev`; lost answer re-reads in all four dialogs; focus), Known gaps shrunk to: calendar Tab leak, M5 (duplicate on resend), server-side paging carry, generic text for a change of a shift opened meanwhile; Known-unverified totals sentence. Spec §16: same points in Russian (first bullet, search, "today", templates, edit choices, M1/M2/lost answer/focus/Enter bullet, devices, M5).

## RED / GREEN

RED outputs (run before the production commits; failing reasons checked):

- W2: 10 tests failed (`expected [...] to include 'Молоко 3,2% 0,9 л (в архиве)'`, 'Линия 2 (в архиве)', 'ООО «Северный берег» (в архиве)', `(черновик)`; defaults hint `expected undefined to be 'Умолчания…'`; date-note tests: note present / note absent). GREEN: 86/86 in the 3 files.
- W3: 3 failed (`expected "vi.fn()" to be called 2 times, but got 1 times` for delete, close, plan). GREEN 130/130 over 4 files.
- W4: 5 focus tests (`expected <main tabindex="-1"> to be <div role="alert">`) + 2 (search finds the placeholder; old lookups text). GREEN 174/174 over 5 files.
- W5: 3 failed (old hint twice, `expected true to be false` for Enter). GREEN 45/45.
- W6: 1 failed (no-line text missing). GREEN 36/36.
- W1/W7: no behaviour change; proof by mutants.

## Mutants (all killed; each restored with `shasum -a 256` before = after and `cmp` silent against a copy in `/tmp/claude/fix2a3/orig/`)

| Item | Mutant (one line)                                                                                          | Killed by                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 3    | `year % 400 === 0` → `% 200`                                                                               | "applies the 400-year leap rule…"                                         |
| 3    | `% 400 === 1`                                                                                              | same + fixture row 2000-02-29                                             |
| 16   | Delete dialog `setFailure(outcome)` → generic `errors.api.conflict`                                        | lost/forbidden/"takes the failure away" tests (3)                         |
| 16   | same in Close dialog                                                                                       | stale-close, lost, "takes the failure away" (3)                           |
| 20   | `SsccPage` action cell `isExhausted(counter) && extension === 0 ? null :`                                  | new admin-pallet test only                                                |
| 20   | `isExhausted` ignores extension 1                                                                          | new test and the technologist test                                        |
| 5    | `win32` → `darwin`                                                                                         | test becomes skipped (32 passed, 1 skipped)                               |
| 12   | `keep(productOptions, [], …)`                                                                              | 3 product rows                                                            |
| 12   | line keep without the form value                                                                           | line row + edit test                                                      |
| 12   | counterparty keep without the form value                                                                   | counterparty row, "never clears", edit test                               |
| 12   | own line keep dropped (`["", lineId]`)                                                                     | "lets the person go back to the shift's own marked choices"               |
| 12   | draft label → `false`                                                                                      | draft row                                                                 |
| 10   | `shift === null && defaults.isError` → `false`                                                             | defaults hint test                                                        |
| 9    | un-frozen `{ today, dateNote }`                                                                            | both date-note tests                                                      |
| 13   | hook rereads on any HostError                                                                              | forbidden/internal "leaves alone" tests (delete, close, plan, create)     |
| 13   | hook never rereads                                                                                         | 6 lost-answer tests                                                       |
| 13   | drop `rereadIfLost` in Delete / Close / Plan / Shift dialog (4 mutants)                                    | one lost-answer test each                                                 |
| 6    | search uses `productName`                                                                                  | "searches the product's own name only"                                    |
| 6    | placeholder "Товар" as the fallback name                                                                   | same                                                                      |
| 6    | archive mark searchable                                                                                    | same                                                                      |
| 14   | no focus effect                                                                                            | 5 focus tests                                                             |
| 14   | no `tabIndex`                                                                                              | 5 focus tests                                                             |
| 14   | focus only when "удалена"                                                                                  | 4 focus tests                                                             |
| 15   | any key prevented / composing Enter prevented / Shift+Enter let through / handler not attached (4 mutants) | "lets Enter and Shift+Enter…"                                             |
| 18   | condition swapped / always line text / always no-line text (3 mutants)                                     | the new test (and the old one for the swapped and always-no-line mutants) |

Mutant outputs are kept in `/tmp/claude/fix2a3/{w2,w3,w4}-mutants.log` and were printed by `/tmp/claude/fix2a3/mut.sh`.

## Checks

- Full package suite at the HEAD of every production commit and the docs commit: `test`, `typecheck`, `lint` all exit 0. Counts: base 76 files / 2006 tests; now **77 files / 2027 tests** (+21: leap 1, sscc 1, date-note 2, defaults 2, marked-choice rows +1 and "never clears" 1, edit 1, W3 3, W4 2+5 focus, W5 1, W6 1).
- Verbose runs of every new or changed file: stderr 0 bytes (checked per group).
- Delayed-`setImmediate` stand (3 ms, real clock, files deleted after): W1 files 88/88, W2 files 86/86, W3 128/128, W4 174/174, W5 45/45, W6 36/36; stderr 0 bytes each. The `shift-dialog-date-note` file passed under it too.
- `prettier --check` on every changed file, `git diff --check`, `grep -rnF '\u04'` (only `pairing-code.ts:66`), one trailer per commit: OK.
- No `build`, no cargo: nothing in the shell or Rust changed.

## Decisions that differ from, or add to, the instructions

1. **Item 16**: I tightened five alert assertions (the review named three line numbers; the other two were the same pattern). `toContain` because the alert's icon glyph is part of its text.
2. **M5 optional create-specific text NOT done.** Cheap to write, but which transport codes mean "the answer may have been lost" (`unreachable`, `invalid_response`, plan 2a4's new `timeout`) is a decision that belongs after the 2a4 merge; `certificate_mismatch`, `not_paired`, `invalid_request` and `config_unreadable` mean the request was never sent, and the text would then be false. It is recorded in Known gaps instead.
3. **Item 12 draft mark**: `recordLabel` marks only archived records, and `product_inactive` also means "draft". I added the key `office.shifts.draftName` ("(черновик)") used for the product's marked choice only, instead of changing `recordLabel` (the list rows keep their wording).
4. **Item 13 as a hook**: instead of copying the three-line `invalidateQueries` into four dialogs I added `shift-reread.ts` and moved `ShiftDialog` onto it (behaviour unchanged, still covered).
5. **Item 14** focus goes to the `Alert` through `id` + `tabIndex={-1}` + `document.getElementById(...).focus()` (the `Alert` type has no `ref`); the page behind the dialog had been left with the focus on `<main tabindex="-1">`, not `<body>`.
6. **Item 2** went into the docs commit (the review's W7), not into a code commit.
7. **Test commits are RED by design** (2, 4, 6, 8, 10); each was committed after `typecheck`, `lint` and prettier but not the full suite. The commit after each is GREEN.

## Concerns

- Items 12/M4 are verified in jsdom only: `<select>` falling back to the first option when the value matches none is React behaviour per the review, which the tests reproduce (RED), but no WebView2 run.
- The focus-on-notice effect relies on the dialog's cleanup restoring focus before the page's effect runs; verified in jsdom with the real `Modal`, not in WebView2.
- The I1 merge rule (second branch carries `totals` in `officeShiftSchema` and the test shifts) is documented but not exercised: neither 2a2 nor 2a4 was merged.
- Controller to write «Отклонения»/«Перенесено» in the plan: the review's section (c) draft plus: M5 optional text not done (above), item 12 draft key, five (not three) tightened assertions.
