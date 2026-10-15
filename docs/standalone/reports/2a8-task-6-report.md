# 2a8 Task 6 report — a shift the office closed is finished on the station, without new codes

Status: DONE_WITH_CONCERNS. Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `b5357b43e`.
Commit: `489874b19` feat(standalone): a shift the office closed is finished on the station, without new codes (one trailer; `git status --short` empty after).
Evidence: `/tmp/claude/impl-2a8-t6/` (driver `mutate.py`, results `mut.txt`, snapshots `before/`), RED `/tmp/claude/impl-t6-red.txt`, GREEN `impl-t6-g2.txt`, verbose `impl-t6-verbose.txt`, delay stand `impl-t6-delay.txt`, full `impl-t6-full2.txt`.

## 1. What I did

- `FloorApp`: `Leave`/`FloorView` lose `notice`; `FloorView.work` gains `officeClosed`; the read-after-host-list effect sets `officeClosed` on the open work view (no `leave`); `entered` opens the work screen for a closed (office) shift with `officeClosed: true`; `leave`'s notice-priority branch removed; `ShiftList` no longer gets `notice`; `Work` gets `officeClosed`.
- `WorkScreen`: `officeClosed` prop, kept in `live`; a scan after the box/stop pipeline is refused in words (`Last` `office_closed`, via `refuse(false, false, true)`), not journalled; warn Alert «Смену закрыли в офисе» (hidden at the terminal closed stop).
- `readShiftCopies`: shows a host-closed shift the station entered (`entered_at IS NOT NULL`) until the station closes it; `closing` stays «Закрывается» (`cardAction` checks `closing` first).
- `ShiftCard`/`ShiftList`: `CardAction` `finish` («Завершить», enabled without link, primary), tag «Закрыта в офисе» (phase `attention`), hint `finishHint`; `ShiftListNotice`, `notice`, `floor.shifts.officeClosed` deleted.
- `shift-entry`: a closed (office) copy is entered from the stored snapshot without asking the host; `storedWork` accepts `active` or `closed` (localState still must be null).
- ru.json: keys as in the brief.

## 2. Anchor adaptations (all by meaning)

1. Dispatch note 1: no exact-match test of «Смена OCT26-004 закр…» was in the Task 6 brief; the work-close test uses the executed constants (`TITLE`, `CLOSED_TITLE`).
2. `Last` already had `shift_closed` and ru.json `"closed"`: new `office_closed` kind / `officeClosed` key added next to them; `refuse` got a third parameter instead of the brief's inline `setLast`+`show` (executed `show` takes 3 args).
3. `FloorApp` executed code differs from the plan's (setup view, `backFromSetup`, `entered` guard, `leave` priority for the notice): the three `setView({kind:"list", notice:null})` became `{kind:"list"}`; the notice-priority `else if` in `leave` was removed; the `entered` guard now lets a closed-by-office copy (localState null) through (needed so «Завершить» reaches the work screen; matches the brief's `officeClosed: shift.copy.status === "closed"`).
4. `shift-entry`: the brief's one-line change was not enough in the executed code: `storedWork` itself refused non-`active` copies, so it also accepts `closed`.
5. Brief test for work-close: its direct `fireEvent.click` on the reason replaced by `work.press` (400 ms press guard of the executed panel); the new describe is appended at the end of the file (brief anchor `});\n});` is not unique).
6. Existing tests on the removed notice, not named by the brief, adapted by meaning (all pass):
   - `floor-shift-list`: the two polite-region tests that combined the notice with the link / not-updated state replaced by one for the not-updated state; the others lost `notice`; «refuses a stored shift the office closed» inverted to «enters … to finish it» (host not asked, online and offline).
   - `floor-app`: `holdingWork` records `officeClosed`, `WorkWithSetup` shows the flag; 7 tests that expected the notice / turning back now expect the work screen with the flag (setup back, late entry answer, another line, leave-then-close, unreadable copy), or the list with «Завершить» after the leave; vacuous `queryByText(OFFICE_CLOSED)` absence checks removed (the text no longer exists); added `officeClosed === false` for a shift this station is also closing.
   - `shift-copies`: «from a stale list … the host's close included» now expects the closed shift on the list.
   - `app.test`: «turns back an entry whose shift the office closed on the way» → «enters … to finish it, and holds a refused key until it is left» (the shell is now told of work).
7. Pins (dispatch note 3): no statement or query added; `readShiftCopies` only changes a predicate (`line_id = ?` index use unchanged), the plan pins in `floor-schema.test.ts` and `src-tauri/tests/local_db.rs` use their own simplified `SELECT id FROM floor_shifts … line_id = ?` and are unaffected; no change made there.

## 3. RED / GREEN

- RED (`impl-t6-red.txt`): 4 files, the brief's tests failing (floor-shift-list wholesale `notice.number`, floor-app / work-close / shift-copies named tests, plus the adapted ones).
- GREEN: `vitest run floor-app floor-shift-list floor-work-close shift-copies` → 4 files, 228 passed (brief: 68 on the scratch copy; the real tree has more tests). With `app.test` added, verbose: 5 files, 353 passed, `stderr |` count 0.
- Delayed-`setImmediate` stand (3 ms) on floor-app, floor-shift-list, floor-work-close: 3 files, 188 passed; the two stand files deleted.
- Full package (`--testTimeout=60000 --hookTimeout=60000`): 114 files, 3495 passed (before the task 114 / 3493 + 2 new tests; plan: 110 / 2632 on the scratch copy). A first full run caught `app.test.tsx` (above), fixed.
- Gates: typecheck 0, lint 0, build 0, prettier gate (live proof: probe `src/zz-probe.ts` flagged, exit 1, deleted; the 12 changed files clean), `git diff --check` clean, `grep -rnF '\u04'` only `pairing-code.ts:66`. No Rust touched.

## 4. Mutants (driver `mutate.py`; each restored from `before/`, `cmp` + sha256 equal, `touch`ed; all `restore True`)

| #   | Mutant                                           | Killed by                                                                    |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| M1  | effect does not set `officeClosed`               | floor-app «keeps the operator in the shift the office closed…» (+2)          |
| M2  | office-closed scan guard disabled                | floor-work-close «takes no new code…»                                        |
| M3  | list drops `entered_at IS NOT NULL`              | shift-copies (3 tests)                                                       |
| M4  | `finish` checked before `closing`                | floor-shift-list «offers to finish…»                                         |
| M5  | entry asks the host for a closed copy            | floor-shift-list «offers to finish…», «enters a stored shift… online true»   |
| M6  | work view starts with `officeClosed: false`      | floor-app «enters a shift the office closed on the way…»                     |
| M7  | `entered` turns back a closed copy               | floor-app (3 tests)                                                          |
| M8  | effect ignores `localState`                      | floor-app «does not take the operator out… while this station is closing it» |
| M9  | `storedWork` refuses `closed`                    | floor-shift-list (3 tests)                                                   |
| M10 | alert also shown at the terminal closed stop     | floor-work-close                                                             |
| M11 | `officeClosed={false}` passed to the work screen | floor-app (5 tests)                                                          |
| M13 | `finish` button disabled                         | floor-shift-list «offers to finish…»                                         |
| M14 | finish hint removed                              | floor-shift-list «offers to finish…»                                         |
| M17 | tag phase for closed back to planned             | floor-shift-list «offers to finish…»                                         |
| M18 | last-scan text changed                           | floor-work-close                                                             |

Not killed (equivalent): dropping `now.shift.copy.id === copy.id` in the effect's updater (the effect is keyed by the open shift id).

## 5. Concerns

1. Semantic consequence of the brief: a late entry answer on a shift the office has closed meanwhile now opens the work screen (finish mode) instead of turning back to the list; the shell is told of work (`work_entered`), so a refused key waits for the leave. The `app.test` / `floor-app` tests were changed to that. Please confirm it is intended (it follows from `entered` having to accept closed for «Завершить»).
2. If the host's list stops returning a closed shift and the station never saw `closed`, the local copy stays `active` (existing status-forward-only behaviour); not touched.
3. Not exercised: real WebView2, a live host.
