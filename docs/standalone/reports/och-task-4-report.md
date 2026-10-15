# Plan ОЧ, Task 4 — report

Status: DONE_WITH_CONCERNS. Commit `c3957d1ea` on `claude/m1` (/tmp/claude/wt/m1), base `26e0c234e`. Tree clean. No Rust touched (no cargo run needed).

## What was done

- `src/floor/queue/QueueScreen.tsx` (new), `ShiftList` (`onQueue`, floor button, held while an entry runs, open without the host), `FloorApp` (view `queue`, passes `link`, `outboxVersion`, `onChanged={recorded}`), `ru.json` (`floor.shifts.queue`, `floor.queue.*`, keys unique), tests.
- Beyond the brief (UX / irreversible action):
  - Confirmation names what is dropped: record kind, time, SSCC, reason in words; «Снять» is a destructive-variant button, says the host never gets it and it cannot be undone; resend says new records, new numbers, original order, sent when the link is up, and names the shift and count by kind. Counts are taken from the queue as it is now (not a snapshot).
  - 400 ms press guard (`VIEW_GUARD_MS`, injectable `clock`) after a question opens; sync `running` ref against two presses in one turn; all buttons held while a write runs.
  - Focus: question takes focus; Escape/«Отмена» close it (not while writing) and return focus to the asking button; decision notice takes focus.
  - Stale: `StaleQueueError` -> notice + re-read; extra `outboxVersion` prop re-reads when the shell's outbox changes; a question whose record/shift vanished closes with the "queue changed" notice (silently on an unreadable queue); late reads dropped.
  - Separate notice for settled conflict; `onChanged` called also after a failed/partial write and after the operator left (tracked-by-status-bar, decision is not lost).
  - Stranded (older pairing): warning text only, read-only, "cannot be sent from here", do not delete data, tell the administrator / runbook; the screen has no button for them (test: only «Назад» present).
  - Code words checked against `proto/src/lib.rs::receipt_codes`; reworded invalid_record, box_closed, box_already_closed, no_pallets, pallet_already_closed.

## Anchor adaptations

- Brief's `QueueScreenProps` extended with optional `outboxVersion`, `clock` (defaults keep the brief's interface valid). `Card` nested replaced by `<section className="shift-card">` (allowed by the brief). Back-button focus fallback uses a wrapper ref (`Button` has no `ref` in its types). Brief's `ru.json` texts changed as listed above; the brief's regexes still match.
- Test 2 of the brief expected "2, ... 2 ч 5 мин" is not applicable after resend (new records are kept "now"): asserted "меньше минуты".
- The screen writes outside the work queue/gate (opened from the list only, no work running; same as ShiftList entry writes). `FloorApp.leave` outside a work view finishes at once, so an idle sign-out mid-decision unmounts the screen; the write completes (module is crash-safe, parts resumable) and the status bar is still told (tested).

## Evidence

- RED: not captured as a separate run (implementation was written before the first run); each guard is proven by its mutant below failing its test.
- GREEN: 3 changed files verbose 179 passed, stderr 0; delayed-`setImmediate` stand x3: 179 passed, stderr 0. Full Vitest (`--testTimeout=60000 --hookTimeout=60000`): 152 files / 4698 passed / 0 failed (base 4657). typecheck 0, lint 0, build 0. Prettier gate live-proved (scratch -> `[warn]`, rc 1, removed); changed files clean; `git diff --check` clean; `grep '\u04'` only `pairing-code.ts:66`; ru.json keys unique.
- New tests: 35 in `floor-queue-screen` (brief's 7 + 28), 3 in shift-list, 3 in floor-app. Plan: 7 + 1 + 1.

## Mutants (all in /tmp/claude/impl-och-t4/mutants.py, log mutants.log; sha256 of QueueScreen/ShiftList/FloorApp identical before/after every run, `restored=True`). 57 run, 57 killed (S5 survived once: the assertion raced the effect; test fixed with an `act` flush, now killed).

| id     | one-line mutant                                                                                                                                                                        | killed by                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| G1-G5  | guard removed / `<=` / no `since>=0` / not restarted at ask / window 0                                                                                                                 | press-guard tests (400 ms, boundary, clock back, second question)  |
| R1/R2  | no `running` ref guard / never released                                                                                                                                                | two presses in one turn; decision flow                             |
| B1-B3  | resend button / confirm / cancel not held while writing                                                                                                                                | "holds every button while a decision is written"                   |
| K1-K6  | no focus on question / notice / cancel no focus back / Escape dead / Escape while busy / no key handler                                                                                | focus + Escape tests                                               |
| E1-E7  | stale/unreadable mapped to local, conflict notice wrong, onChanged only when mounted / only on success, no re-read, pending kept                                                       | stale, unreadable, local, unmount tests                            |
| S1-S8  | outboxVersion ignored, late read kept, gone target kept / silent / stale on failed read, empty question for vanished record, read failure unshown, snapshot count                      | outboxVersion, late-read, vanish, failed-reread, busy-vanish tests |
| U1-U16 | close offered for dismissal, stranded >=0, age from now, kind counts, variants, conflict reason, unknown code/kind raw, dash, SSCC dropped, operator id, back, link line, list filters | screen tests                                                       |
| L1-L4  | queue button always / not held / held offline / not floor size                                                                                                                         | shift-list tests                                                   |
| F1-F5  | queue not opened / back / onChanged / outboxVersion / link not passed                                                                                                                  | floor-app tests                                                    |

## Concerns

- No real browser/touch/Windows check of the screen (jsdom only); 64 px is asserted by the `floor` Button class, not measured.
- A dismissal's `resolved_by` is the signed-in operator id; roles are not checked (plan O2).
- `outbox-recovery` open items from tasks 2-3 (covering partial index for unresolved refusals) unchanged.
- A mid-decision idle sign-out is not held by the work gate (screen is not a work screen); the write still completes.
- `graphify update` not run.
