# 2a8 final fix wave: report

Worktree `/tmp/claude/wt/flr`, branch `claude/floor-2a7`, base `d43cec932`. Three commits, tree clean after the last.

| Commit      | Subject                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `059d7d367` | test(standalone): the close's last guards and the retention of a finished office-closed shift are pinned                  |
| `19810fe91` | fix(standalone): the close summary after a lost answer shows the shift closed, tells the outbox, and guards every re-show |
| `33231f9eb` | docs(standalone): what the retention deletes after an office-closed shift is finished, and the stale comments             |

Each message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## Triage rows implemented

- **I1** (docs, retention test): AGENTS «Floor exceptions and close» and spec §22 now say a shift the office closed that the station then finished (`accepted` + `alreadyClosed`) is purged like any other; only one the station never closes stays. `facts-sender.ts` JSDoc: the sender never deletes, retention does. Test: `retention.test.ts` "deletes a finished office-closed shift too".
- **m1**: `floor-shift-close.test.ts` "lets no record of the shift follow its close once the host has answered it either" (copy turned `closed`, a scan gives `changes_mismatch`, outbox and scans unchanged).
- **m2 + T4 m3 + m9**: `WorkScreen.tsx` `foundClosed` (tells the floor + closed stop) used by `showSummary` for a `closed` blocker (opening the summary, fresh read, read back after a failed write); catch path uses `showSummary(again, "failed")` (label named by its SSCC); a failed re-read shows the new hedged note `unknown` («Смена могла закрыться: нажмите «Подтвердить закрытие» ещё раз»), `ru.json` `floor.close.notes.unknown`.
- **m3**: `attempt` carried by the `close` stop, passed to `ShiftClosePanel`, in `viewOf`.
- **m4**: `.catch(() => setStop({ kind: "system_error", cause: "write" }))` on the tracked close.
- **m5**: comment at `confirmClose` (defence in depth today; ПЛ-Ц must pin it with a held non-scan job). CARRY stays ПЛ-Ц.
- **m6**: `WorkScreen` JSDoc (office close removed from the leave list), `floor-app.test.tsx` title, spec §21 HTML comment (§20 to §22), `ShiftList` JSDoc, `facts-sender` `+outcome` is defensive, AGENTS/spec carry owners and `floor_exceptions (host_id, device_id, shift_id)`, AGENTS close guard now names the plan pin and the open-box guard (spec also gained the open-box guard).
- **m7**: `REFUSED_CLOSES_SQL` exported from `shift-close.ts`; its plan is pinned in `floor-schema.test.ts` (first step `SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)`, no SCAN, no TEMP; word-for-word presence in the Rust file) and in `src-tauri/tests/local_db.rs` (`REFUSED_CLOSES` constant, entry in `reads` (49 to 50), first-step and no-TEMP assertions).
- **m8**: one sentence in AGENTS and spec §22 (registry of a purged shift's codes goes with it; decision 31).
- **Not implemented (DROP/CARRY):** m9, m10 (the two surviving reviewer mutants R3 and the host `fact_rows` check are triaged DROP; left as is), all CARRY rows.

## Deviation from the proposed wave

The review put the three WorkScreen tests in commit 1 ("fail before commit 2"). To keep every commit green, those tests went into commit 2 with the fix. RED evidence below. Commit 1 holds only tests that pass on the base.

## RED / GREEN

- RED: with `WorkScreen.tsx`, `ShiftClosePanel.tsx`, `ru.json` checked out at the base and the new tests in place: `floor-work-close.test.tsx` 8 failed | 49 passed (5 new tests and 3 updated expectations: `recorded(work)` +1 in two existing tests, `UNKNOWN` instead of `FAILED` in "keeps the summary it showed when the write failed and the summary cannot be read again"). Log `/tmp/claude/fix-red.log`. Restored byte-identically (`cmp` on all three).
- GREEN: `floor-work-close.test.tsx` 57 passed (verbose, stderr empty).

## Mutants (all killed; each file restored, sha256 equal, `cmp` silent, `git status` clean afterwards)

| #   | Mutant (one line)                                                  | Killed by                                                                                                               |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| F1  | `facts.ts` outbox guard `local_state IS NOT NULL` to `= 'closing'` | floor-shift-close "…once the host has answered it either" ("promise resolved instead of rejecting")                     |
| Ra  | `DUE_SHIFTS_SQL` plus `AND o.outcome_details IS NULL`              | retention "deletes a finished office-closed shift too" (dueIds)                                                         |
| Rb  | `DONE_WITH` plus `AND o.outcome_details IS NULL`                   | same test (purge count)                                                                                                 |
| Pa  | `REFUSED_CLOSES_SQL` without `AND outcome = 'rejected'`            | floor-schema (`SCAN outbox`) and the word-for-word shell-list test                                                      |
| Pb  | `REFUSED_CLOSES_SQL` `ORDER BY seq` to `ORDER BY outcome_code`     | floor-schema (`USE TEMP B-TREE FOR ORDER BY`)                                                                           |
| Pc  | Rust `REFUSED_CLOSES` without the `outcome` clause                 | `cargo test --test local_db the_floors_repeating_reads_search_an_index` ("should search outbox_settled… `SCAN outbox`") |
| A1  | `showSummary` ignores a closed blocker                             | 6 tests in floor-work-close (incl. "closed stop at once")                                                               |
| A2  | `foundClosed` does not call `onRecorded`                           | 6 tests (the `recorded(work)` expectations)                                                                             |
| A3  | re-show keeps the attempt (`attempt: now.attempt`)                 | "restarts the guard … two alike in a row too"                                                                           |
| A4  | `viewOf` ignores the attempt                                       | that test and the lost-answer test                                                                                      |
| A5  | the tracked close has no `.catch`                                  | "does not leave an unhandled rejection…"                                                                                |
| A6  | failed re-read says `failed` instead of `unknown`                  | lost-answer test and "keeps the summary it showed…"                                                                     |
| A7  | `unknown` re-show keeps the attempt                                | lost-answer test (second `unknown`, echo tap ignored)                                                                   |
| A8  | `showSummary` forgets the waiting label (`waitingSscc = null`)     | the new label-after-failed-write test, plus 2 older label tests                                                         |
| A9  | catch path never shows a read-back summary                         | 6 tests                                                                                                                 |

Driver `/tmp/claude/fix-2a8/mut.py`, logs `/tmp/claude/fix-2a8/mut/*.log`.

## Gates

- `typecheck`, `lint` 0 at each commit and at the end; webview `build` 0 (after commit 2 source).
- Prettier gate live: a deliberately mis-formatted `apps/standalone/src/zz-probe.ts` gave exit 1 with `[warn]` and was deleted; changed files then print "All matched files use Prettier code style!" (one file, `floor-schema.test.ts`, was reformatted first).
- Focused verbose Vitest: `floor-shift-close`, `retention`, `floor-schema` 114 passed; `floor-work-close`, `floor-app`, `floor-work-screen`, `floor-shift-close` 248 passed; `floor-app`, `facts-sender`, `floor-work-close`, `floor-shift-list` 210 passed; stderr empty (0 lines of `stderr`).
- Delayed-`setImmediate` stand (3 ms) on `floor-work-close`: 57 passed. Stand files deleted.
- Final full Vitest: 116 files, 3543 passed (baseline 3536; plan of the wave +7: 1 shift-close, 1 retention, 5 floor-work-close).
- Cargo: `the_floors_repeating_reads_search_an_index` passed in the sandbox; one full `cargo test --workspace --offline --locked` unsandboxed: 815 passed, 0 failed (same as the 2a8 baseline of 815); `cargo fmt --all -- --check` clean.
- `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` only `src/host/pairing-code.ts:66`; no literal `\u0` in `ru.json`; `git status --short` empty.

## Concerns

- `cause: "write"` for the m4 catch follows the review literally; its text («Скан не записан») is imprecise for a close whose write is unknown. The path needs a throw out of the status-bar callback, so it is defensive.
- `onRecorded` is now called when a summary finds the shift closed (previously only on a close this screen wrote or read back after a lost answer): two existing tests changed from `before` to `before + 1`, with the reason in their comments. The callback is idempotent for the status bar.
- Not verified: browser, Windows, WebView2, touch panel, a live host (the wave is webview and tests plus docs).
