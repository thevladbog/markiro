# Plan 2a3: final whole-part review (tasks 1–8)

Worktree `/tmp/claude/wt/2a3-office`, branch `claude/2a3-office`, base `51925bae2`, HEAD `f543a551b` (12 commits). I read every production file of the part in full from the tree: `src/office/shifts/*`, `src/lib/civil-date.ts`, `src/lib/box-template-choice.ts`, the additions to `src/lib/rules.ts`, `src/host/{protocol,requests,api}.ts`, `OfficePager`, `access`, `nav`, `office-query`, `routes`, `DeviceDialog`, `station-shift`, `CreateOperatorDialog`, `operator-forms`, `SsccPage`, `counter-kind`, `shell.css`, the `ru.json` diff and the docs diff. I compared them with the host's `routes/office_shifts.rs`, `shifts.rs`, `validate.rs`, `routes/device_shifts.rs` and `proto` `ShiftUpdate`/`ShiftClose`. I also read the parallel branches `claude/2a4-shell` (the `timeout` transport code) and plan 2a2's «Контракт для 2a3».

### Verdict

**WITH FIXES.** The part works as one machine and nothing in it is unsafe. Contract parity with the host holds. Every host refusal reaches the person somewhere visible. The dialogs share one convention. I found no Critical issue. One Important item is a merge-order and contract hazard with plan 2a2: it needs no code change in this wave, but it needs docs and a decision now. The queued minors and five new minors should go into one final fix wave.

Counts: **Critical 0 · Important 1 · Minor 5** (new findings). The 20 queued minors are triaged separately in (b).

Automated checks I ran myself, on HEAD:

- Full suite `vitest run`: **76 files / 2006 tests passed**. This matches the Task 7 count; Task 8 changed only docs.
- `typecheck` 0, `lint` 0.
- `prettier --check` on all 48 added or modified files: clean.
- `git diff --check`: clean.
- Scope: only `apps/standalone/{src,test,AGENTS.md}` and `docs/` changed. No Rust, manifest, lockfile, host or proto file.
- Every commit carries exactly one `Co-Authored-By: Claude Opus 5.5` trailer.
- No `\u04` escape in the diff. No `any`, cast or non-null `!` in the sources. All literal i18n keys exist in `ru.json`, and so does every dynamic family (`blockers.*`, `statuses.*`, `modes.*`, `statusFilters.*`, `closeReasons.*` against `@markiro/domain` `SHIFT_CLOSE_REASON_CODES`, `unknown.*`, `fields.localDate*`). Cyrillic in the sources appears in comments only. `escapeValue: false`, and names render as React text. Every CSS variable used (`--fg-2`, `--fg-3`, `--err-fg`, `--text-body-sm`) is defined in `packages/ui/src/tokens.css`.

My own mutants: ten one-line mutants, run with focused Vitest. Every file was copied first to `/tmp/claude/rev-2a3-final/orig/`, restored afterwards, and checked with `shasum -a 256 -c` (all OK) plus `cmp` (silent). All ten were **killed**:

| #   | task            | mutant                                                                  | killed by                                           |
| --- | --------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| F1  | 3               | `officeKeys.shiftList` no longer under the `["office","shifts"]` prefix | 26 tests (list re-reads after every write, devices) |
| F2  | 5 fix 2be76fee4 | no-op edit check `length === 1` → `=== 0`                               | «sends nothing … blanks only»                       |
| F3  | 3               | period re-asked only when `from` changes                                | «asks again when only the second date … changes»    |
| F4  | 3               | `days + 1 > 366` → `days > 366`                                         | 3 tests (unit + page)                               |
| F5  | 7               | `stationShift` drops `status === "active"`                              | 3 tests                                             |
| F6  | 4               | `localDate` / `localDateZone` swapped                                   | 2 tests                                             |
| F7  | 4 fix ae12228dc | `keepCalendarEscape` stops every Escape                                 | «closes only the calendar on Escape …»              |
| F8  | 5 fix a00f9d9be | edit-mode product refusal routed to the (absent) control                | 3 tests                                             |
| F9  | 4 fix f88d6c8fe | no `lines.refetch()` after a line refusal                               | 2 tests                                             |
| F10 | 4 fix f88d6c8fe | no `counterparties.refetch()` after a refusal                           | 1 test                                              |

Delayed-`setImmediate` stand: 3 ms, on the **real** clock, so that fake-timer tests are not frozen. I ran it once over the 12 new or changed test files (shifts ×5, devices, operators, sscc, civil-date, shift-form, shift-list, box-template-choice): **281/281 passed, stderr 0 bytes**. The temporary setup and config files were deleted, and `git status --short` is empty.

A first attempt wrapped the delay in the _global_ `setTimeout`. It froze 15 pre-existing pairing-code tests in `devices-page` that use `vi.useFakeTimers`. That was an artefact of my stand, not of the code. With the real `setTimeout` captured at setup time, everything passed.

The fix rounds that were never re-reviewed (Task 4: `ae12228dc`, `f88d6c8fe`; Task 5: `a00f9d9be`, `2be76fee4`) are correct, and F2 and F7–F10 pin them. Their only flaws are the queued items 9–12, plus the doc overstatement in M1 below.

---

## (a) Findings, most severe first

### I1 (Important): plan 2a2 puts `totals` in **every** `OfficeShift`; 2a3's docs and Task 9 assume it appears only in `GET …/{id}`. Whichever branch merges second turns standalone Vitest red.

- **What 2a2 says.** Plan 2a2, «Контракт для 2a3», line 160 of `docs/superpowers/plans/2026-10-09-standalone-2a2-host-facts.md`: `OfficeShift` (list, `GET …/{id}`, `POST`, `PUT`, `close`) gets a **required** `totals: { acceptedUnits, closedBoxes, openBoxes, lastFactAt: string|null, deviceIds: string[] }`. Its fixture is **`office-shift.json`**: «Итоги есть и в списке, отдельный запрос на строку не нужен». Task 7 of plan 2a2 modifies `proto/fixtures/office-shift.json` and touches no webview file.
- **What the current code does.** `officeShiftSchema` (`src/host/protocol.ts`) is a plain `z.object`, deliberately not `.strict()`, as are all response schemas here. A running host that adds `totals` is therefore tolerated: the field is stripped, and the test «tolerates a field added by a newer host» proves it. So no runtime break.
- **Where it breaks.** `test/protocol.test.ts:292-295`, «response fixture office-shift.json parses without losing a field» (`expect(schema.parse(fixture)).toEqual(fixture)`), **fails** as soon as the fixture carries `totals`. This is the intended tripwire. It means that whichever of 2a2 and 2a3 merges second must add `totals` to `officeShiftSchema` in the same PR. It must also add `totals` to every `OfficeShift` literal in `test/support/shifts.ts` and the test files, which become type errors once the field is required.
- **Stale docs.** `apps/standalone/AGENTS.md` («Смены» bullet: «`totals` in `GET /v1/office/shifts/{id}`»; Known-unverified: «The «Итоги» window is not built») and spec §16, first bullet («итоги — окно «Итоги» … (`GET /v1/office/shifts/{id}`)»), describe a contract 2a2 no longer has.
- **Task 9 will stop.** Plan 2a3 Task 9 expects a separate `office-shift-detail.json`. Its Step 0 says to stop and ask if that fixture is absent or the meaning differs, and with plan 2a2 as written it will hit that stop condition.
- **Fix in this wave (docs only).** Reword both doc places: plan 2a2 adds `totals` to every `OfficeShift`, list included. Record the deviation in the plan («Отклонения», (c)). Decide the merge rule now: the PR that lands second (2a2's Task 7 or 2a3) carries the schema and test-fixture update.
- **For Task 9** (see (e)): rewrite it before execution. Make `totals` a required `shiftTotalsSchema` field of `officeShiftSchema` (non-negative ints; `lastFactAt` as `z.iso.datetime().nullable()`; `deviceIds` as `z.array(z.uuid())`). Spec §5.6 originally wanted accepted units and boxes in the list row, so the row should show them now. Decide whether the «Итоги» window is still needed or becomes a smaller detail (device names for admins, last-fact time).

### M1 (Minor, docs and test fidelity): `shift_status` never reaches PUT or close. The host checks the revision first, and every status change bumps `rev`.

- **Host behaviour.** `office_shifts.rs` `update_shift` and `close_shift` compare `expectedRev` **before** the status. A station's open (`device_shifts.rs:337`, `rev = ?`) and every close take a new revision. So in the edit, plan and close dialogs, a shift opened or closed meanwhile comes back as `stale_revision`: the generic «Данные изменились…» with «Загрузить заново», save left on. It never comes back as `nowActive` / `nowClosed` / `notOpen`.
- **Where `shift_status` does occur.** Only on **DELETE**, which takes no `expectedRev`. `not_found` on PUT or close does occur.
- **Consequence.** The UI paths are harmless, and stale is still recoverable. But `test/shift-edit.test.tsx:226,279,638,795` and `test/shift-delete-close.test.tsx:476,481,501` fake an answer the real host never gives for those routes. AGENTS.md («A shift opened, closed or deleted meanwhile (`shift_status` …, `not_found`) is an alert in words of its own») and spec §16 («`shift_status` и `not_found` на записи — предупреждение своими словами») overstate the case. The Task 5 report already noted this as its concern 2.
- **Fix (DOC).** Say that for a change or a close the host refuses an opened or closed shift as `stale_revision` («Загрузить заново»). Say that the own-words alert covers `not_found` everywhere and `shift_status` on a delete. Keep the code: a later host might reorder its checks.
- **Optional.** Let `stale_revision` in these three dialogs also call `onOutdated`, so the list behind the dialog refreshes without a click. This is a small design call; leave it to the controller.

### M2 (Minor, docs): «Every write sends the opened row's revision» is untrue for delete and create.

AGENTS.md, «Смены» bullets. `deleteShift` sends no `expectedRev` (the host takes none: `DELETE` checks only the status), and a create has no revision. A planned shift edited elsewhere can therefore be deleted without a stale refusal. That is by design, but the docs should say so. **Fix (DOC):** «Every change and close sends the opened row's revision; a delete sends none, so it removes a planned shift whatever was changed in it meanwhile.»

### M3 (Minor, family divergence; widens queued item 13): after a lost answer, only `ShiftDialog` re-reads the shifts.

`ShiftDialog.tsx:265-267` invalidates `officeKeys.shifts` on any `transport` failure, for an **edit as well as a create**. `ShiftPlanDialog`, `DeleteShiftDialog` and `CloseShiftDialog` never do. A lost answer to a plan change, delete or close leaves the list behind stale until a click. **Fix:** in the wave for item 13, do the same in all three. The Task 6 delete test pins `listShifts` at one call («explains a failed request, reads nothing again …», `shift-delete-close.test.tsx:201`) and must be changed to expect the re-read.

### M4 (Minor, new evidence that raises queued item 12): after a select refusal, the native select shows a **different** record than the form holds.

- **Mechanism.** `@markiro/ui` `Select native` renders `<option>`s. When `value` matches no option, React's `updateOptions` selects **the first non-disabled option**; the placeholder option is disabled.
- **Product or line, after a refusal and the re-read.** The select shows the first in-use product or line while the form still holds the refused id.
- **Counterparty.** The select shows «Не выбран» while the form holds the archived id.
- **Why it traps the person.** Picking the option already shown fires no `change`, so they cannot pick «Не выбран» or that first product without first choosing something else. A resubmit is refused again, so no wrong data is written; it is still a trap.
- **Fix (item 12).** Keep the current form value as a **marked choice** for product, line and counterparty, the way `templateOptions(…, [shift?.boxTemplateId ?? "", field.value], …)` already keeps the template. The refused record then shows «… (в архиве)» with the refusal under it, and the person picks another. Do not clear the counterparty to `""`: a resend would then silently plan a shift with no counterparty, and the counterparty is printed on the box label.

### M5 (Minor, honesty of the known gaps): a resend after a lost create answer can plan a second shift.

The create has no request id (2a1 design). After `unreachable` the dialog stays open with «Нет связи с хостом…», and the list behind it is re-read. Nothing tells the person to look at that list before pressing «Запланировать» again, so a duplicate planned shift is possible. It can be deleted, but its number is spent. **Fix:** DOC it in «Known gaps». Optionally (owner's choice) show a create-specific transport text in `ShiftDialog` only, for example «Ответ хоста не пришёл: проверьте список смен за окном — смена могла быть запланирована».

### Confirmed and not findings

- **Every host refusal of `office_shifts.rs` is visible in every dialog:**
  - `validation_failed` on each request field: under its control. On `productId` in edit, where there is no control, it is the dialog's alert, pinned by F8.
  - `validation_failed` on `mode`, `palletsEnabled` or with no field: the generic alert.
  - `product_inactive`: under the product, or the alert in edit.
  - `template` refusals: under the template, with the template kept as a marked choice.
  - `shift_status` and `not_found`: an outdated alert with save off (but see M1).
  - `stale_revision`: «Загрузить заново».
  - `forbidden`, `unauthorized`, `internal`: the alert via `errorMessageKey`.
  - A delete's `not_found`: taken as deleted.
- **`timeout`.** It exists only on `claude/2a4-shell`, and only when a caller passes `timeoutMs`; office calls do not. After the merge, `errorMessageKey` maps it generically (`errors.transport.timeout`, which 2a4 adds to `ru.json`), and `ShiftDialog`'s transport branch tests `kind`, not the code, so it is covered.
- **Request contract.** Field names match. `null` appears only in `plannedQty` and `counterpartyId` (the strict `shiftUpdateSchema` refuses it elsewhere). The trimmed reason is sent. Code points are counted as the host counts them (`characters` vs `chars()`; the control-character class `\p{Cc}` matches `char::is_control`). Civil dates are exact. `expectedRev` is the opened row's: the dialog keeps its `shift` snapshot across list re-reads (tested).
- **Cache.** `officeKeys.shiftList(*)` all sit under `officeKeys.shifts` (F1). `DeviceDialog` shares `shiftList(null)` and is refreshed by shift writes. Lookups are not invalidated by shift writes, which is correct.
- **Roles.** Only two office roles exist, and both may plan. The route needs no `RequireRole`. The 64 px rule is the floor's (`AGENTS.md:556`); office pages use `size="compact"`, as the rest of the office does.
- **Dates.** `civilToday` uses `Intl` with the zone and is tested at the Moscow midnight, across New York's DST end, at Kamchatka's year end, and with year padding. The period is inclusive, limited to 366 days, and both ends are percent-encoded.

---

## (b) Triage of `2a3-minors.md` items 1–20, with the proposed wave

| #   | Decision                                                 | Reason / what to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **DROP** (verified)                                      | `closeReasonRule` refuses `\n` with `rules.controlCharacter` and nothing is sent (`shift-delete-close.test.tsx`, `CONTROL_WORDS` rows, «trailing line break»). The UX half is item 15.                                                                                                                                                                                                                                                                                               |
| 2   | **FIX**                                                  | `civil-date.ts:39`: «Days since 1970-01-01 (negative before it)», since `getTime()/86 400 000` counts from the epoch. Comment only.                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **FIX** (test)                                           | Add `isCivilDate("2100-02-29") === false`, `"2200-02-29" === false` (kills `year % 200`) and `"2400-02-29" === true`, plus `civilDaysBetween("2100-02-28","2100-03-01") === 1` and `("2400-02-28","2400-03-01") === 2`.                                                                                                                                                                                                                                                              |
| 4   | **DROP** (done in Task 4)                                | `isKnownTimeZone` plus the «Этот ПК не знает часовой пояс организации…» caption are tested («starts on this PC's date and says so when this PC does not know the organization's zone»; F6 kills the swap). The controller's leaning «CARRY 4 (paging server-side → host)» does not match item 4's text. Server-side paging of `GET /v1/office/shifts` is a separate host carry, not a numbered minor: the 366-day bound stands in for it, and it should be recorded for a host plan. |
| 5   | **FIX** (test)                                           | `it.skipIf(process.platform === "win32")` on «falls back to the PC's own calendar day…», with a comment that Node re-reads `TZ` only on POSIX. Keep the `getDate() === 9` precondition. CI's Vitest runs on ubuntu.                                                                                                                                                                                                                                                                  |
| 6   | **FIX**                                                  | `findShifts` must search the record's own name only: pass `(shift) => products.data?.find(p => p.id === shift.productId)?.name ?? ""`. Neither the «Товар xxxxxxxx…» placeholder nor the «(в архиве)» marker should be searchable. Test: products pending or failed, «товар» finds nothing, a number search still works.                                                                                                                                                             |
| 7   | **FIX**                                                  | Reword `office.shifts.lookupsFailed`, for example «Не все справочники загрузились: названия, которых нет, показаны началами кодов, а смены, которые не откроются, могут быть не помечены.»                                                                                                                                                                                                                                                                                           |
| 8   | **DROP**                                                 | No action. Only sources are cast-free by rule; tests may use `as HTMLElement`. Sources verified clean.                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | **FIX**                                                  | Freeze `today` and `dateNote` at the first settled render of the create dialog (for example a lazy `useState` in `ShiftForm` from the props at mount), so a later failed or successful profile refetch cannot change the caption under an unchanged value. Two tests: success then failing refetch → no caption; failure then success → the caption stays.                                                                                                                           |
| 10  | **FIX**                                                  | `ShiftDialog`: while `defaults.isError`, a hint under the template, for example «Умолчания шаблонов не загрузились: шаблон берётся только из товара — проверьте выбор». One test.                                                                                                                                                                                                                                                                                                    |
| 11  | **CARRY** → `@markiro/ui` Modal/overlay task (task chip) | `Modal` should ignore an Escape whose `defaultPrevented` is set and give `DatePicker`/`Select` an overlay portal container. Then remove `keepCalendarEscape` and re-test Tab inside the dialog.                                                                                                                                                                                                                                                                                      |
| 12  | **FIX** (raised by M4)                                   | Keep the current value as a marked choice for product, line and counterparty, like the template keep-list. Never clear the counterparty to `""`. Test: after a refusal and the re-read, the select's displayed option is the refused record marked «(в архиве)».                                                                                                                                                                                                                     |
| 13  | **FIX** (with M3)                                        | `ShiftPlanDialog`, `DeleteShiftDialog` and `CloseShiftDialog` invalidate `officeKeys.shifts` on a `transport` failure, as `ShiftDialog` does. Update the delete test that pins one `listShifts` call.                                                                                                                                                                                                                                                                                |
| 14  | **FIX**                                                  | After `saved()`, move focus to the notice: a wrapper with `tabIndex={-1}` focused in an effect keyed on the notice. Do it for every saved outcome, not only delete and close, whose row button vanishes. Test `document.activeElement`.                                                                                                                                                                                                                                              |
| 15  | **FIX**                                                  | Close reason: Enter in the textarea inserts no line break (`onKeyDown` Enter → `preventDefault`), and `reasonHint` says «одной строкой». Pasted line breaks are still refused with `rules.controlCharacter`. Test.                                                                                                                                                                                                                                                                   |
| 16  | **FIX** (test)                                           | Assert the exact alert text: «Нет связи с хостом…» for `unreachable` and the `forbidden` text (`shift-delete-close.test.tsx` ~:206, 240, 521).                                                                                                                                                                                                                                                                                                                                       |
| 17  | **DROP**                                                 | c17 already fails the run: Vitest exits non-zero on the unhandled `TypeError`, which turns CI red, and the report added «dialog stays, no notice» assertions. An assertion-level kill would need unhandled-rejection listeners, which is test plumbing without product value. If the controller insists, FIX by registering `unhandledrejection` in that one test.                                                                                                                   |
| 18  | **FIX**                                                  | Two texts chosen by `watch("lineId") === ""`. To a line: «…доделает начатую работу, выведет оператора и покажет смены новой линии…». To «Не выбрана»: «…доделает начатую работу, выведет оператора и попросит выбрать линию…». Both end with «смена останется открытой…». Update the AGENTS devices bullet.                                                                                                                                                                          |
| 19  | **CARRY** → owner (already DOC'd)                        | The AGENTS devices bullet already says the dialog is silent when the shifts do not load. Adding a note is the owner's call.                                                                                                                                                                                                                                                                                                                                                          |
| 20  | **FIX** (test)                                           | Administrator view of an **exhausted pallet counter**: «Номера закончились», and no «Изменить» in that row (kills K2).                                                                                                                                                                                                                                                                                                                                                               |

New items for the same wave: **M1, M2, M5 → DOC**; **M3 → with 13**; **M4 → with 12**; **I1 → DOC** plus the plan deviation plus the merge rule (no code).

**Proposed wave: one fixer; test commits and production commits separate; RED shown in the report.**

- **W1, test only:** 3, 5, 16, 20.
- **W2, `ShiftDialog`:** 9, 10, 12 (with M4). A test commit, then a production commit.
- **W3, family transport:** 13 (with M3). Test, then production.
- **W4, page:** 6, 7, 14. Test, then production.
- **W5, close reason:** 15. Test, then production.
- **W6, devices text:** 18. Test, then production.
- **W7, docs, one commit:**
  - item 2 (the `civil-date.ts` comment);
  - AGENTS.md and spec §16 for M1, M2, M5 and I1;
  - shrink «Known gaps of the page» to what remains: 11, M5, 19 if kept, and the open M1 stale-text nuance;
  - rewrite the devices bullet after 18;
  - record the Task 9 rewrite in the plan.

  Then re-run the package's `test`, `typecheck` and `lint`, `prettier --check`, `git diff --check` and the delayed-`setImmediate` stand over the touched tests (real-clock delay).

---

## (c) Deviations to record in the plan's «Отклонения при исполнении» (Russian draft)

```markdown
- Задача 1: сверх плана добавлены тесты построителей и схем (null-план и null-контрагент в `shiftCreate`,
  null вне плана/контрагента в `shiftUpdate` отвергается, отсутствие любого поля ответа — отказ); план
  оставлял в живых 41 из 100 однострочных мутантов.
- Задача 2: тесты сверх плана (точная форма 4-2-2, годы 0024/0099, весь диапазон 0001–9999, полночь
  зоны с точностью до секунды и переход Нью-Йорка с летнего времени); `isKnownTimeZone` добавлена
  (в плане не было), чтобы форма могла сказать, что зона организации этому ПК неизвестна.
- Задача 4: фокус на первое отклонённое поле сделан своими силами (`shouldFocusError: false`,
  `SHIFT_FIELD_ORDER`, `id` у каждого элемента): `Select`/`DatePicker` из `@markiro/ui` не принимают
  `ref`. На время записи выключены все элементы окна. Подпись «Этот ПК не знает часовой пояс
  организации…» (`localDateZone`) — сверх плана. Исправления после ревью: Escape календаря закрывает
  только календарь (`keepCalendarEscape`, обход — причина в `Modal` из `@markiro/ui`; Tab из
  календаря по-прежнему выводит из окна, перенесено в задачу `@markiro/ui`); после отказа на товаре,
  линии, шаблоне или контрагенте перечитывается соответствующий список, после потерянного ответа —
  списки смен (у создания нет идентификатора запроса).
- Задача 5: `shiftWriteFailure` применяется только к правке; создание оставлено на `writeFailure`
  (`not_found` создания — «хост не настроен», а не «смену удалили»). Исправления после ревью: отказ на
  товаре в правке (у правки нет поля товара) — предупреждение окна; правка, ничего не изменившая для
  хоста, ничего не шлёт и закрывает окно; после «смену открыли/закрыли/удалили» кнопка записи
  выключена до «Загрузить заново». Своя модель шаблона правки, когда список товаров не загрузился
  (`ownTemplate`).
- Задача 6: «устаревшее» состояние (смена открыта/закрыта/удалена тем временем) перенесено и в
  удаление и закрытие: свои слова, кнопка выключена, «Загрузить заново»; у `DeleteShiftDialog`
  появился `onReload`. Поле причины на время записи — только чтение, а не выключено (фокус после отказа).
- Задача 7: в форме оператора фокус на отклонённое поле получают все отказы хоста по полю, не только
  «похожий номер».
- Задача 8: предложение об «Устройствах» записано с оговорками (для «Не выбрана» оно неточно; при
  неудачной загрузке смен окно молчит); порядок меню («Смены» перед «Операторы») исправлен.
- Хост проверяет ревизию раньше статуса (`update_shift`, `close_shift`), а открытие и закрытие смены
  берут новую ревизию: поэтому правка, план и закрытие смены, которую тем временем открыли или закрыли,
  получают `stale_revision` («Загрузить заново»); `shift_status` своими словами доходит только до
  удаления (у него нет `expectedRev`). Ветки `shift_status` в правке и закрытии оставлены на случай
  другого порядка проверок; тесты подставляют такой ответ сами.
- Контракт итогов: план 2a2 (написан после этого плана) кладёт обязательное `totals` в каждый
  `OfficeShift`, список тоже, с фикстурой `office-shift.json`; отдельной `office-shift-detail.json`
  нет. Задача 9 переписывается до исполнения (см. её шаг 0): `totals` — обязательное поле
  `officeShiftSchema`, строка списка показывает принятые единицы и короба (§5.6), объём окна «Итоги»
  решает контролёр. Ветка, которая сливается второй (задача 7 плана 2a2 или этот план), сама
  обновляет схему и тестовые смены, иначе тест «response fixture office-shift.json parses without
  losing a field» падает.
- Список смен хоста не постраничный; предел периода в 366 дней его заменяет. Постраничность
  `GET /v1/office/shifts` — перенос в план хоста.
- Пункты 1, 4, 8, 17 очереди сняты (1 и 4 исполнены, 8 и 17 без действия), 11 — в задачу
  `@markiro/ui` (`Modal`), 19 — владельцу; остальные — в финальной волне (см. итоговое ревью).
```

(Adjust the last bullet once the wave lands. If plan 2a4 merges its spec section first, «§16» becomes «§17», as the plan's own rule says.)

---

## (d) What could not be verified

- **Platforms.** No WebView2, no Windows, no real host or station, no browser. Everything ran under jsdom with a fake `HostApi`. Unchecked in particular:
  - the `DatePicker` calendar inside the legacy `Modal` (Tab leak, Escape);
  - `Intl`/ICU output in WebView2 (zone, no-break space, `toLocaleLowerCase("ru")`, collator);
  - focus restoration of the real `Modal`;
  - a station opening an office-planned shift (plan 2a5).
- **`build` not run.** It writes `dist` into the reviewed worktree. `typecheck`, `lint` and the full test suite are green.
- **No cargo.** No Rust changed.
- **Merges.** The 2a2 and 2a4 merges were not exercised. I read their branch and plan, but did not merge them. The I1 and §16/§17 numbering effects are inferred.
- **Probes not run.** The host's actual `timeout` behaviour for office calls, and a host with months of shifts or a 366-day period.

---

## (e) What plans 2a5, О-Ф and 2a2's counterpart Task 9 must know

- **Task 9 (after 2a2):**
  - Step 0 will hit its stop condition: 2a2 has no `office-shift-detail.json`, and `totals` is in every `OfficeShift` (I1).
  - Make `totals` a required field of `officeShiftSchema`: `acceptedUnits` is `u64` on the host, and JS numbers are exact to 2^53, which is fine.
  - Add `totals` to every `OfficeShift` in `test/support/shifts.ts` and the test files.
  - Show accepted units and boxes in the list row (spec §5.6); the docs' «the list carries no totals» goes away.
  - Re-scope or drop the «Итоги» window (device names for admins only, last-fact time in the organization's zone with the same frozen-at-mount caption rule as item 9).
  - Keep response schemas non-strict: a newer host's field is stripped, and the fixture test is the tripwire.
- **Plan 2a5 (floor):**
  - `suggestBoxTemplate` and `civilToday` are shared and tested; the station's new shift must use them.
  - The «Устройства» sentence promises what 2a5 must build: finish the work, sign the operator out, then show the new line's shifts, or ask for a line when none is chosen (item 18's split text).
  - `stationShift` relies on `ownerDeviceId` and `status === "active"`, so a station's open must keep setting both.
  - A change from the office reaches an opened shift only as a plan change; everything else meets `stale_revision`.
- **Plan О-Ф / other office plans:**
  - Reuse `OfficePager` (`office.common.pager.*`; only the `label` key stays per page).
  - Reuse the dialog family convention:
    - first refused field focused;
    - all controls locked in flight, or read-only for single-field dialogs;
    - an outdated state with its own words, save off and «Загрузить заново»;
    - `stale` keeps save on;
    - a lost answer re-reads the affected lists (after W3, everywhere).
  - Remember that the host checks the revision before the status.
- **Host carry:** server-side paging of `GET /v1/office/shifts`; today the 366-day client bound stands in for it.
- **Spec numbering:** 2a4's «Уточнения плана 2a4» becomes §17 if 2a3 merges first.
