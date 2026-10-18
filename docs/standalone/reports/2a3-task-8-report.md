# Plan 2a3, Task 8 — report (documents)

Worktree `/tmp/claude/wt/2a3-office`, branch `claude/2a3-office`. BASE `63e6c3dc7`. Commit `f543a551b docs(standalone): the office's shifts in AGENTS.md and the stage 2a spec` (one `Co-Authored-By: Claude Opus 5.5` line, checked with `git log -1 --format=%B`). Not pushed; `git status --short` empty. Git run through `/Library/Developer/CommandLineTools/usr/bin/git`.

Status: DONE (see Concerns for text that will go stale if the final wave fixes minors).

## What was done

Docs only: `apps/standalone/AGENTS.md` (+144/-7 lines) and the stage 2a spec (§16 «Уточнения плана 2a3», +42; the file ended at §15, so the number is 16). The plan file, host, proto, src, tests are untouched. Every anchor of the brief matched exactly once (checked before editing); the brief's text was corrected against the final code of Tasks 1-7, not applied verbatim.

AGENTS.md places:

1. «Operators and badges»: the similar number text («Похож на занятый табельный номер 0042: …»), `similarLogin` in `operator-forms.ts`, the cursor moves to the number, an equal / non-text / absent `similarLogin` reads as taken.
2. «Protocol»: the shift builders (`shiftCreate` every field with `null`, `aggregation`, `false`; `shiftUpdate` only the differing fields, `null` only for plan and counterparty, strict `shiftUpdateSchema`; `shiftClose` the trimmed reason), `officeShiftSchema` loose with the close reason code as text, `listShifts` period percent-encoded, `deleteShift` answers nothing.
3. «Office pages», «Устройства»: a station with an active shift may be moved (В9, А); `stationShift`; the shifts are read when the dialog opens, for stations only; the live-region sentence appears for any other line, «Не выбрана» included; says honestly that the sentence promises what the station does from plan 2a5 and that the dialog is silent when the shifts do not load.
4. «Office pages», «Операторы»: the nav sentence now says «между «Смены» и «Устройства»» (the brief did not mention it; «Смены» sits between «Линии» and «Операторы» in `OFFICE_NAV`).
5. «Office pages»: six new bullets for «Смены» — list and names (fallback to the first 8 characters of the id, one lookup warning with «Повторить», the retry of a failed list also re-reads failed lookups), `openBlocker` marks, close reasons, search/filters/pages of 25/`OfficePager` (extracted from «Товары»), the period (`periodState`, `MAX_PERIOD_DAYS` = 366, `asked` keeps the earlier list), the create dialog (profile wait, `civilToday`, `isKnownTimeZone` caption, product options, `suggestBoxTemplate`, `clearErrors`, all controls locked while writing, focus to the first refused field in `SHIFT_FIELD_ORDER`, selects refused -> list re-read, lost answer to a create -> shift lists re-read), the row actions (edit variant: product as text, marked own choices, only what differs, unchanged edit sends nothing, `productId` refusal as the dialog alert; «Изменить план»; «Удалить» with `not_found` = deleted; «Закрыть» with `closeReasonRule` in code points, line break -> control-character rule, nothing sent), write outcomes (`officeKeys.shifts`, `stale_revision` -> «Загрузить заново», `shiftWriteFailure` for `shift_status`/`not_found`, save off until reload), and a «Known gaps» bullet.
6. «Shifts» section: link to the page, 366-day bound and why.
7. «Shifts» section, SSCC blocks: the exhausted counter («Номера закончились», `isExhausted`, no change offered, both extensions by the code).
8. «Verification»: what ran only under jsdom and what was never run (see below).

Spec §16 mirrors the brief with the corrections (period half-set/wrong keeps the old list, search, pages of 25, `isKnownTimeZone`, no «Не выбран» in the template choice, unchanged edit sends nothing, product shown as text in the edit, outdated shift cannot be re-sent, code points, line break, Devices silent when the shifts do not load and the station's behaviour is plan 2a5's) plus one bullet of what is not verified.

## Not verified, recorded in the docs

- jsdom only, against a fake `HostApi`; no WebView2, no real host, no browser.
- `DatePicker` calendar inside a dialog in WebView2 and the locked window; Tab from the calendar leaves the dialog until `@markiro/ui` `Modal` is fixed; Escape held back only by `keepCalendarEscape` (workaround).
- Organization time zone of a real profile; a zone the PC's ICU lacks; `Intl` output in WebView2 vs Node (the no-break space in «1 200», `toLocaleLowerCase("ru")`, the `ru` collator).
- A shift planned in the office and opened by a real station (plan 2a5); a station moved while on a shift; the list against months of shifts or a 366-day period.
- The «Итоги» window (Task 9) does not exist: it waits for plan 2a2's `totals` in `GET /v1/office/shifts/{id}`; AGENTS.md and §16 say so.

## Checks

- `node_modules/.bin/prettier --check` on both files: clean. `git diff --check`: clean.
- AGENTS.md: every added line <= 80 characters (python check over `git diff -U0`, characters not bytes; two lines were reflowed after the first pass).
- Every new code name grepped in `src`: `openBlocker`, `periodState`, `MAX_PERIOD_DAYS`, `suggestBoxTemplate`, `civilToday`, `isKnownTimeZone`, `shiftWriteFailure`, `closeReasonRule`, `isExhausted`, `similarLogin`, `stationShift`, `SHIFT_PAGE_SIZE`, `OfficePager`, `keepCalendarEscape`, `SHIFT_FIELD_ORDER`, `planShifts`, `shiftCreate/Update/Close`, `shiftUpdateSchema`, `officeShiftSchema`, `templateFitsSlot`, `isShiftCloseReasonCode`, `shiftOnStation`, `officeKeys.shifts`: all exist. `grep -rnF '\u04' src test` finds only `src/host/pairing-code.ts:66`.
- No tests run (docs only).

## Deviations from the brief's text (for the controller's «Отклонения при исполнении»)

- «Operators» sentence also names the cursor move and the "no text / absent" cases; nav order sentence fixed («Смены» now precedes «Операторы»).
- «Устройства»: the brief's sentence says the dialog shows «the new line's shifts» for any choice; I record that this is inexact for «Не выбрана» and that the dialog is silent when the shift list fails (both known gaps of Task 7), and that the behaviour promised is plan 2a5's.
- The brief's «Smeny» bullet was split into six bullets and extended with Task 4-6 additions (focus order, locks, `clearErrors`, list refreshes, edit variant details, outdated state, code points, control character) and a «Known gaps» bullet.
- §16 number is 16 (no §16 existed). The brief's «Итоги … задача 9» wording is "last task of plan 2a3, waits for plan 2a2", and states the window is not built.
- Task 1's 8 extra tests, Task 3's extra tests and the test counts are not written into the docs (the AGENTS.md convention does not record counts); they belong to the plan's «Отклонения».

## Concerns

- The AGENTS.md «Known gaps» bullet and the Devices "silent" sentence describe the state at this commit (placeholder search match, silent template defaults failure, refused id staying in the form value, no re-read after a lost delete/close answer, calendar Tab leak, Devices silent on a shifts failure, inexact «Не выбрана» wording). If the final wave fixes any of minors 6, 10, 12, 13, 19, 18, the matching sentence must be edited in the same commit as the fix.
- `civil-date.ts` doc comment on `dayNumber` (minor 2) is still wrong in code ("since 0001-01-01"); I did not describe it in the docs.
- Minor 9 (the «часовой пояс не загрузился» caption when a cached profile fails its refetch) is not mentioned in the docs; the caption rule written is the intended one.
