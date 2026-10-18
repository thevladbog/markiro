# Plan РК-С, Task 4 — report

Status: DONE_WITH_CONCERNS. Commit `6e8b48b5f` on `claude/floor-2a7` (/tmp/claude/wt/flr), base `c1da39169`. Tree clean. Only TS/JSON touched (no Rust, no host/proto), so no cargo run (Rust unchanged since Task 2's full workspace run, 1122 passed).

## What was done

- `BackupsPage.tsx`: column «Блоки SSCC» (Вернула / Не вернула, words not colour) from `station.reconciled`; `returned` count; dialog line with `returned`/`total`; doc comment rewritten.
- `ru.json`: keys `hold.blocks`, `.returned`, `.notReturned`, `.confirmNoBlocks` (new); `blocksNote`, `confirmCheck`, `restore.after` rewritten; `confirmCount` replaced by plural forms.
- Tests: `test/backups-page.test.tsx` (brief's five edits + 8 new tests).

## Deviations from the brief (by meaning, binding duties)

1. **No-blocks stations.** The host never marks a station with no blocks «Вернула» (route rejects an empty list). The host returns only `reconciled` per station, so the office cannot tell «never took blocks» from «has not returned yet». Cell texts stay as the brief's («Вернула» / «Не вернула»); `blocksNote` now says «Станция, которая ещё не получала блоков SSCC, остаётся «Не вернула»: возвращать ей нечего.» and a new dialog line `confirmNoBlocks` says «Не вернула» is not always a failure and to check counters per the memo for the rest.
2. **M2 (optimistic mark).** `blocksNote` says «Отметка «Вернула» ставится, когда хост принял первую часть её блоков.» (the host marks on the first chunk); the dialog count stays «Вернули свои блоки SSCC: N из M станций.» verbatim.
3. **Plural.** `confirmCount` is `confirmCount_one/_few/_many/_other` (i18next, `count: total`) so one station reads «из 1 станции» / «из 21 станции» and others «станций». Strings are the brief's otherwise. The runbook (Task 5) still contains the old «станции не возвращают» texts (lines ~16, 232, 341); Task 5 must rewrite them.
4. `confirmCheck` and `restore.after` verbatim from the brief. `blocksNote` = brief's text plus the two sentences above (test pins the full string).

## RED / GREEN

- RED (`vitest run test/backups-page.test.tsx`, after tests only): `10 failed | 33 passed (43)` (/tmp/claude/impl-rks-t4/red.txt). Brief expected 2 failed (my 8 extra tests are new; the two named ones fail too).
- GREEN: `backups-page + backup-warnings`: `53 passed (53)` (brief expected 44; plan counts 35+9; mine 43+10). Delayed-`setImmediate` stand (3 ms; scratch config+setup deleted): `43 passed`. Verbose run: stderr 0 bytes.
- Full package: `148 files, 4594 tests passed` (Task 3: 4586; +8). typecheck 0, lint 0, build 0. Prettier gate live-proved (scratch `src/zz.ts` gave `[warn]`, deleted); the test file needed `prettier --write` once, then clean on 3 files. ru.json duplicate-key script: none. `grep '\u04'`: only `pairing-code.ts:66`. `git diff --check` clean.

## Mutants (restore proof: `cmp` silent and sha256 equal for BackupsPage.tsx b0fafe06… and ru.json 22afcb91…; backups in /tmp/claude/impl-rks-t4/)

| #   | one-line mutant                                 | killed by                                                                             |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| O1  | every station «Вернула»                         | shows the stations… which gave their blocks back; marks every station by its own flag |
| O2  | count = all stations                            | confirm-resume test; 5 count cases (6 failed)                                         |
| O3  | no `count` param                                | 12 failed (plural key unresolved)                                                     |
| O4  | `total: returned`                               | confirm-resume; counts (6)                                                            |
| O5  | labels swapped                                  | shows the stations…; marks every station…                                             |
| O6  | no `confirmNoBlocks` line                       | confirm-resume test                                                                   |
| O7  | column removed                                  | shows the stations…; marks every station…                                             |
| O8  | `_one` form says «станций»                      | counts 1/1, 0/1, 1/21                                                                 |
| O9  | count of NOT reconciled                         | confirm-resume; counts (6)                                                            |
| O10 | card shows another note instead of `blocksNote` | shows the stations…                                                                   |
| O11 | no-blocks sentence dropped from note            | shows the stations…                                                                   |
| O12 | first-part (M2) sentence dropped                | shows the stations…                                                                   |
| O13 | `_few` says «станции»                           | counts 2 из 3 (+confirm-resume)                                                       |

## Anchor adaptations

- Brief's test fragments matched once. Added tests beyond the brief: plural/count `it.each` (6), per-station flag with order (1), `restore.after` text (1).

## Concerns

1. Cell «Не вернула» is ambiguous for no-block stations (host data has no way to tell): honest wording only; the real fix is host-side (accept an empty list, or expose `hasBlocks`) — follow-up outside this plan's files.
2. Runbook still says stations do not return blocks (Task 5).
3. Not exercised: real browser/visual, Windows, real restore.
