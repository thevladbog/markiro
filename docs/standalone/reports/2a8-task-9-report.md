# 2a8 Task 9 report — documents (AGENTS.md, spec section 22)

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `2d2cf3d31`.
Commit: `d43cec932` docs(standalone): the floor's exceptions and close in AGENTS.md, spec section 22 (one trailer, `git status --short` empty after).

## What I did

Docs only; no Rust or code. Files: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-08-standalone-2a-shift-and-boxes-design.md`. The plan file is not touched.

AGENTS.md:

- Shifts list passage: the list now shows the shift the office closed after this station entered it, until this station closes it («Завершить»); brief fragment 1 by meaning.
- Addendum (b), passage 1 (the entry gate): rewritten. `enterShift` enters an office-closed copy from the stored snapshot, with or without the host; `FloorApp` turns back only a copy that is neither active nor closed-by-office or has a `localState`; an office-closed one gets `officeClosed` and the shell is told of the work. The «Смену N закрыли в офисе.» text is gone.
- Addendum (b), passage 2 (the leave): the office's close removed from the list of leaves and the «upgrades a waiting leave» sentence replaced by: the office's close is no leave, the screen stays in finish mode. (Brief fragment 2.)
- «Floor work» tail: the pointer now names «Floor exceptions and close» (brief fragment 3).
- New section «Floor exceptions and close» before «Marking rules» (brief fragment 4, verbatim), with these changes: done text «Смена закрыта на этой станции. Данные будут отправлены автоматически» (addendum a); the office-closed paragraph mentions `WorkScreenProps.officeClosed` and that the office's close starts no wait; the retention paragraph adds the inclusive boundary (`acked_at <= now − 30 × 24 h`, fixed UTC span), that only an ACCEPTED close starts the clock (refused or office-closed shifts are never purged), and the forgotten-pairing note (rows never purged, pairing-scoped; a known limit); a new «Known limits of the retention» list with M1 (full-scan deletes on `outbox`/`floor_exceptions`, 176 ms vs 37 ms, ~31 MB WAL per 1000 print jobs under `secure_delete`, needs a migration with the two indexes), M2 (refused/conflicting records purged with the shift after 30 days, ОЧ / owner), M3 (clock set forward purges early, РК-С) and M4 (a failed pass leaves no trace).
- «Verification»: the 2a8 manual Windows list (brief fragment 5) plus one extra item (retention on a real database after 30 days).
- Stale statements of the future made current: the `0006` header note and the `0007` note (retention now exists, `RETAINED_TABLES` lists `floor_print_jobs`), the «Продолжить без этикетки» limit (T2 restored the reference to «Исключения», with a test), the 30 000-jobs retention duty (done).

Spec (new §22, see anchor note): the brief's text, with: done text «на этой станции» and the §5.7.7 quote updated to it (cross-referencing §22); the close transaction also checks the copy's plan (the T3 plan pin); `officeClosed`, no queued leave, entry with or without the host; retention details as above (inclusive boundary, forgotten pairing, accepted-only); the carried limits M1–M4 under «Принято и оставлено открытым»; the «if the number is taken…» sentence removed.

## Anchor adaptations

1. Spec fragment 1 (the `~HS` bullet) is mid-list in §21 (more bullets follow), so replacing it with itself + a section would split §21. The new section is appended at the end of the file instead. Numbering: §15–§21 are taken in the 2a spec file, so the next free is **§22** (the brief said §20, the plan's own comment in §21 also says «берёт §20»; both are stale). The pilot spec's РК §22/УСТ §23 are in another file, so no clash in this file; I did not touch the pilot spec or renumber anything. The HTML comment of §21 («План 2a8 берёт §20») is left as is; it is now wrong and the controller may want to fix it.
2. AGENTS.md fragments 2, 3, 5 matched by meaning, not exactly (the file had moved since the brief's text: the list sentence, the leave passage and the verification list had different line wrapping and the leave passage also carried the «upgrades» sentence); fragment 1 likewise. Fragment 4's anchor `it is open (\`SystemAwake.hold\`).`is followed in the file by the «What plan 2a7 accepted…» block, so the section was inserted directly before`## Marking rules`, not after that sentence.
3. The existing «Verification» entry is for plan 2a6 («The floor's work (plan 2a6)»); the 2a8 entry is placed before it, as the brief's fragment 5 does.

## Gates

- Prettier gate: live-proved (a mis-formatted `zz-probe.ts` flagged, exit 1, deleted); the two docs clean, exit 0, "Checking formatting..." printed.
- `git diff --check` clean. No Vitest/grep check named by the brief; `grep 'закрыли в офисе'` in AGENTS.md now 0.

## Deviations observed in the reports of Tasks 1–8 (for the controller's «Отклонения при исполнении» of 2a8; I did not edit the plan)

- T1: `exceptionStatements` moved from `box-exceptions.ts` to `facts.ts` (exported; the row id is taken before the record id, 2a7's order) so 2a7's `reprintStatements` shares it; 25 tests beyond the plan's 16. Shell query-plan list lines for the new reads were added later (commit `425e08b10`).
- T2: `WorkScreen` names per the executed code; `exceptions` block in `ru.json` as a sibling of `print` (anchor absent); `work-screen__reasons` replaced by `exceptions__choices`; the test support gained `labelClock`/`pause()` for the 400 ms guard; skip text restored with the «Исключениях» reference (2a7 minors item 6) and a test of the reprint after a skip; the confirmation does not name the reprint's printer (fixed in `05716ce71` fix round: the exceptions name the printer and never run unseen behind a label); 41 tests instead of the plan's 10.
- T3: the plan pin (`s.planned_qty IS ?`) and the no-open-box guard (`NOT EXISTS … closed_at IS NULL`) in the close transaction are beyond the brief; "no record follows the close" expects `StaleJobError` from `reprintBox`, not `changes_mismatch`; fix round: outbox guard host scope pinned, JSDoc states the queue rule (closeShift is a queued, tracked job), plan pin of the guard's lookup in both query-plan lists.
- T4: done text «Смена … закрыта на этой станции» (brief: «закрыта»), own scan refusal text for the closed stop; `ClosedNumbers` instead of a full `ShiftClosedFact` in the closed stop; Back offered while the summary loads; plan-result line, irreversibility sentence, ✓ sign, label SSCC + «Перейти к этикетке» beyond the brief; `toLabel` has no stop re-check; 51 tests.
- T5: the brief's fourth receipt statement planned as `outbox_settled` (slow); fixed with unary pluses (`+host_id`, `+device_id`, `+outcome`) and the plan pin added to `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs` (outside the brief's file list); `receiptStatements` is a separate function in the executed code; tests spy `performance.now` for the 400 ms guard.
- T6: `office_closed` kind / `officeClosed` key added beside the existing `shift_closed`; `refuse` got a third parameter; `FloorApp` `entered` guard lets an office-closed copy through, `storedWork` and `enterShift` accept `closed`; the notice-priority branch in `leave` removed; the late entry answer on an office-closed shift now opens the work screen in finish mode and tells the shell (`work_entered`); many existing tests inverted/adapted (`floor-shift-list`, `floor-app`, `shift-copies`, `app.test`).
- T7: `DUE_SHIFTS_SQL` replaced in the fix round (plan SQL cost shifts × records; new text walks the accepted closes once, `DISTINCT`, `ORDER BY` dropped; 60 ms vs 6.5 s on 600 000 rows); `RETAINED_TABLES` includes `floor_print_jobs`; the app test strengthened (rejected scan record, purge gated until the bar counted, `outbox_changed` proven); an `app.test` fragment inserted by meaning (executed tail is a `try/finally` test).
- T8: the four `box_exception` ids in `floor-scenario.json` differ from the plan's (undo `…0011`→`…0012`, clear `…0014`→`…0015`, disassemble `…0022`→`…0023`, reprint `…0025`→`…0026`) because the executed exception modules take a row id before the record id; nothing else differed.
- Plan-count differences: the measured Vitest total is far above the plan's (116 files / 3536 vs 112 / 2643) as every task added tests beyond the brief; Rust 815 passed at Task 8.

## Concerns

1. §22 vs the brief's §20 (see Anchor adaptations 1); the stale comment in §21 («План 2a8 берёт §20») remains.
2. The carried minors M1/M2/M3 are documented as known limits only; M1 needs a migration (owner/РК decision), M2 an ОЧ/owner decision.
3. Not run: Vitest/cargo (docs-only), browser, Windows.
