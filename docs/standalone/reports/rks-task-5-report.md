# Plan РК-С, Task 5 — report

Status: DONE_WITH_CONCERNS. Commit `f19f855ba` (docs(standalone): plan РК-С in AGENTS, the restore runbook and the pilot spec) on `claude/floor-2a7` at /tmp/claude/wt/flr, base `6e8b48b5f`. Tree clean after the commit. Docs only (3 files, +315 -64).

## What was done

- `apps/standalone/AGENTS.md`
  - Local database: `floor_restore_epochs` is Disposable; 24 tables, 12 Disposable (was 23 / 11).
  - Reference sync: the epoch wipe is described as done (`FROM_ZERO_SQL`), no longer "not read yet".
  - Connection to the host: `hello` read before each stream, `restoreEpoch` in the `Online` status.
  - Backups and restore: the retry is `RESTORE_HOLD_RETRY_MS`; the "page keeps no count" sentence is replaced by the `reconciled` column; "is meant to send" becomes "sends".
  - "The station's side is NOT written" is replaced by the real design. It covers the obligation row and `restoreDue`, `reconcileRestore`, blocks in parts of 64 oldest first, retiring refused blocks, the one end transaction, `RESEND_WINDOW_MS == RETENTION_MS`, `held` with the 60 s wait and the `factsHeld` gate, the three status-bar lines, and the office card.
  - A "Left open" list (below) and an I1 paragraph.
  - Verification: a new bullet for the manual training restore. It says explicitly that nothing ran on Windows, WebView2, two stations or a real printer, and that the `hello` read was only exercised against a host on 127.0.0.1 with a test-written epoch.
  - Retention note (line ~3424): "checking the clock is plan РК-С's" became "not part of plan РК-С and stays open". The plan does not do the clock check, so the old sentence was false.
- `docs/runbooks/standalone-backup-restore.md`
  - Intro: the lines that said stations do not return blocks are rewritten, and an explicit "not covered: new PC" and a "not verified ever" bullet are added.
  - Section 5 step 8: the one-minute retry, the status-bar texts, the block return, the jump of "Не отправлено" after the reopen, and the "Блоки SSCC" column.
  - Section 6: step 4 and step 5 are extended, and a new subsection "Что теряет восстановление на новом ПК (открытое решение владельца)" is added. It covers I1 under option (3), what to do, and the three options.
  - Section 7: the intro is rewritten (the line ~232 passage); check 1 is mandatory on a new PC; check 5 is rewritten (the line ~341 passage) with the M2, no-blocks and failed-`hello` caveats; the consent text matches `confirmCheck`.
  - Section 8: the bullets for the feeds, the 30-day window (M3), a no-blocks station and the optimistic «Вернула» (M2), refused blocks (count only), reset while owed (M5), and the new PC.
  - Section 9: the checklist is updated.
  - Section 10, item 9: the training restore, with a second run (network off) and a third run (new PC), and a plain list of what was never run.
- `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`
  - §11 and §22 pointers now say §24.
  - A new §24 "Уточнения плана РК-С" is appended after §23, not between §22 and §23. It covers the design, what «вернула» does and does not mean, the window, the not-done list, the open I1 decision and the not-verified list.

## Checks

- Prettier gate, live proof: scratch `apps/standalone/src/zz.ts` gave `[warn]`, exit 1 (deleted). A deliberately malformed table appended to `AGENTS.md` also failed, so the `.md` files are not ignored (restored with `cp` from a backup). All 3 docs are clean afterwards.
- `git diff --check`: clean (also on `HEAD~1..HEAD`). `grep -c '\u04'` on the AGENTS and the runbook: 0.
- No docs test or CI script reads these three files. The only mention is a doc comment in `host/src/restore.rs`. `ru.json` was not touched.
- Not run, because the task is docs-only and no code changed since Task 4: the full cargo and Vitest runs (the brief's Step 2). The last measured values are Task 4: Vitest 148 files / 4594 passed; cargo `--workspace` from Task 2: 1122 passed. I did not re-run them here, so the plan's "full check" is not freshly evidenced for this commit.

## Anchor adaptations

- Spec section: the brief's §22 is §24 here. §22 is РК and §23 is УСТ. The numbering note in the new section lists 18 ПЛ-Х, 19 ПЛ-Ц, 20 ЧЗ, 21 О-Ф, 22 РК, 23 УСТ. The new section is appended at the end of the file instead of after the §22 bullet. The pointers in §11 and §22 say §24, and the runbook header says "11, 22 и 24".
- AGENTS table: the brief's "19 tables / 11 Disposable / 8 DeviceData" no longer matches. The tree has 23 tables, with `floor_print_jobs`, the two pallet tables and `workstation_settings`. I applied the new count by meaning: 24 tables, 12 Disposable (checked against `TABLE_CLASSES`: 12 Disposable, 11 DeviceData, 1 Workstation).
- AGENTS "Verification": the bullet is inserted before the "Windows service and DPAPI" bullet, after the 2a7 printing bullet. The brief's anchor (after "Neither shows a real host") no longer ends the previous bullet.
- AGENTS "Backups and restore" line ~3842: "No station code keeps count of returned blocks, so neither does the page" is also rewritten. It was stale and the brief did not list it.
- Runbook: the brief's text for steps 8, 9 and 10 was applied by meaning. The check 5 text is extended with the failed-`hello` caveat, the no-blocks and new-PC «Не вернула», and the M2 note. The consent-text fragment is aligned with the actual `confirmCheck` in `ru.json` ("…зная, какие станции не вернули свои блоки").
- Plan path `docs/superpowers/plans/2026-10-11-standalone-rk-s-station-restore.md` is referenced from §24. The file exists on the controller's branch and not in this worktree. It will resolve at merge.

## Binding duties from the addenda

- Old text that said stations do not return blocks (runbook ~16, ~232, ~341, ~361, ~422) is rewritten. A grep for "не возвраща", "пока всегда 0" and "станции блоков не" finds only unrelated hits.
- I1 is stated honestly in the AGENTS, the runbook and §24. Four things never reach the restored host: records acknowledged after the copy, the unsent records (they stay on the disk, and forget refuses until confirmed), the open shift with labelled boxes, and the post-copy SSCC blocks. SSCC uniqueness rests on the +100 000 margin and check 1, which is mandatory. The runbook section is labelled "открытое решение владельца", lists the three options, and says it is written for option (3).
- The no-blocks station staying «Не вернула» is documented as not a failure, with the host follow-up (an empty list, or a `hasBlocks` flag). M2, M3, forget-while-owed (M5, not done) and the missing status-bar line for stranded records are documented.

## Deviations observed in Tasks 1-4 (for the controller to write into the plan; I did not touch the plan)

1. Task 1: two extra tests beyond the brief (the clear on forget, and a link swapped without passing through unpaired). `--test connection` has 8 tests (plan 7).
2. Task 2:
   - `REOPEN_SQL` gets `AND outcome IS NOT NULL` (neutral by the CHECK, so the planner can use `outbox_settled`).
   - The SQL texts are exported constants, pinned on both SQLites, with a TS-to-Rust text-agreement test.
   - Migration is `0009` (0007 and 0008 were taken).
   - Anchors for the lists and for `TABLE_CLASSES` moved (print and pallet tables).
   - Counts: local_db 29, Vitest 243 for 5 files (plan 236), +17 tests in `restore-reconcile`.
   - Review: APPROVED 0 critical / 1 important (I1) / 7 minor. The minors include M1 (no-blocks), M2, M3, M4 (refused codes, a column in `0009` before it ships), and M5 (the stuck line, counts, forget).
3. Task 3:
   - `epochNoted` is replaced by the shared `noting` write (one write per epoch).
   - `factsHeld` hold gate: no trigger sends during the host's minute.
   - The status bar's stuck-delivery line is suppressed while held or owed.
   - Extras: 108 tests in 4 files (plan 90); 390 in the 4 related files.
   - No per-task review yet; the final review must check sender gating, the hold gate, the shared epoch write and the 60 s wait.
4. Task 4:
   - `blocksNote` and `confirmNoBlocks` are new, and `confirmCount` is plural (`_one/_few/_many/_other`).
   - 8 extra tests; 43 tests in the page file (plan 35).
5. Counts differ from the plan's scratch copy throughout: Vitest 148 files / 4594 (plan 109 / 3138); cargo 71 result lines / 1122 (plan 63 / 962). The known timeout in `template-editor` under load.

## Concerns

1. The runbook is written for option (3) of I1. If the owner picks (1) or (2), section 6's subsection, the intro bullet, check 1's "always mandatory" clause and the §24 / AGENTS paragraphs need rewriting.
2. Final-wave items are documented as they stand today and will go stale if the controller changes them:
   - Refused blocks keep a count only; the codes column of M4 is not added.
   - There is no forget-while-owed warning.
   - The stuck line still counts from `created_at` (`HEAD_RECORD_SQL`) after a non-held failure.
   - The no-blocks station stays «Не вернула».
   - M2 stays optimistic.
3. Runbook section 4 line ~136 still says "В коде станции на этой ветке такого хранения ещё нет (оно в плане 2a8)". This is stale, because 2a8 retention is merged. It is outside this task and I left it.
4. The brief's Step 2 full check (cargo workspace, whole Vitest, build) was not re-run, because no code changed. Task 4 and Task 2 numbers stand.
5. Not verified anywhere: Windows, WebView2, a real `markiro-host restore` on a real PC, two stations, real hardware. The docs say so.
