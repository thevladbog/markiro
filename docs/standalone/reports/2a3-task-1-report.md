# Plan 2a3, Task 1 — report (implementer)

Status: DONE_WITH_CONCERNS (concerns are only the plan-count differences below; nothing blocked)

BASE: 51925bae261f62b954db55f5cdf2fb7e5fe95f3c (worktree /tmp/claude/wt/2a3-office, branch claude/2a3-office)
Commit: 3ca597c7d "feat(standalone): the webview's shift schemas, request builders and HostApi methods" (one trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). `git status --short` is empty afterwards (stand files removed, no stray files).

## What was done

Plan steps 1, 3 applied verbatim in order; every anchor matched exactly once (scripted replacement that aborts on a count other than 1). Files: `src/host/{protocol,requests,api}.ts`; tests `test/{protocol,api,probe}.test.ts`, `test/support/{fixtures.ts,office.tsx}`. Host, proto, src-tauri, manifests, lockfile untouched. No cd was needed except two stray `cd` in my own shell snippets (both into /tmp/claude or the worktree root; no `.claude/.cc-writes` was left anywhere — checked `/tmp/claude` and `git status --untracked-files=all`).

## RED (step 2)

`vitest run test/protocol.test.ts test/api.test.ts test/probe.test.ts` -> exit 1: `Test Files 2 failed | 1 passed (3)`, `Tests 13 failed | 199 passed (212)`; `test/api.test.ts` did not load (`TypeError: Cannot read properties of undefined (reading 'parse')`, the fixture schemas missing); the 13 failing `protocol.test.ts` tests: 8 request/response fixture rows (`parses without losing a field`, `rejects an unknown field`, `tolerates a field added by a newer host`), 2 builder tests (`shiftUpdate is not a function`), 3 `shift shapes` tests (`parse` / `safeParse` of undefined). `probe.test.ts` passed. Exactly as the plan's Expected.

## GREEN (step 4)

Plan tests alone: 3 files, 260 tests passed (plan: 260), stderr empty (0 bytes), verbose.
After my additions: 3 files, 268 tests (260 + 8), stderr 0 bytes, verbose; and under the delayed-`setImmediate` stand (3 ms) 268 passed, stderr 0 bytes. Stand files removed.

## Added beyond the plan (tests only; the plan's tests let 41 of 100 one-line mutants survive)

`test/protocol.test.ts` (+4 tests):

- builders: `shiftCreate` with `plannedQty: null` and `counterpartyId: null` sends both as null (the plan's fixture has 1200 and a counterparty, so a `?? undefined` mutant survived), plus mode/pallets still named; round-trips through `shiftCreateSchema`.
- `shift shapes`: a mode `validation`, a plan of 1, and a close reason code unknown to this build (`a_code_a_newer_host_adds`) are read (pins the "text, not enum" rule); refusals for `number` "" / non-string, `palletsEnabled`, `closedAt`/`lateDataAt`/`createdAt` form, `closeReasonCode`/`closeReasonText` non-string, the date with leading/trailing text (anchors), and every field of an `officeShift` missing; the three request schemas refuse wrong types/ids/non-positive counts, missing required fields, `expectedRev` non-integer/missing, `reason` missing (the plan only fixture-parses them and tests null-in-update).
  `test/api.test.ts` (+4 tests, new `describe("HostApi shifts")`): list/create/update/close return the parsed shift(s); list rejects an item that is no shift and a single shift object; each write rejects a non-shift answer and a list; `deleteShift` resolves `undefined` and rejects an answer with a body; both ends of the period are percent-encoded in the query.

## Mutants (100 one-line scratch mutants; harness `/tmp/claude/mutate.py`, list `/tmp/claude/muts.json`)

Each mutant: file copied to `/tmp/claude/before_mut`, sha256 before, mutation, `vitest run test/protocol.test.ts test/api.test.ts`, restore, `cmp` against the copy and sha256 after. "pre" = result against the PLAN's tests only; "post" = against the final tests. All 100 restored byte-identically (restore column), all 100 KILLED post. 41 were not killed by the plan's tests (marked SURVIVED/ANCHOR in the pre column; `ANCHOR` = the harness anchor was ambiguous in that first pass and was fixed, the mutant then ran only in the post pass). The plan's five mutants are P1–P5; their plan-named tests also fail (the table prints the first failing test in sorted order, which for P1 is my added create-with-nulls test; the plan's own test `a shift to plan…` fails on it as well because `toStrictEqual` sees 8 keys vs 9).

| mutant                                       | pre (plan tests only) | post   | first failing test                                                                                                                    | restore |
| -------------------------------------------- | --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1 create drops mode                         | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| P2 update sends unchanged plan               | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| P3 update schema lineId nullable             | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| P4 period 'to' repeats from                  | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > listShifts for a period sends the office token to the right route                        | yes     |
| P5 shift plannedQty accepts 0                | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| B1 create drops palletsEnabled               | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B2 create plannedQty null -> absent          | SURVIVED              | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B3 create counterpartyId null -> absent      | SURVIVED              | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B4 create spreads the form                   | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B5 create drops boxCapacity                  | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B6 create mode validation                    | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B7 create pallets true                       | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| B8 update expectedRev +1                     | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B9 update lineId always                      | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| B10 update date always                       | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| B11 update template always                   | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B12 update capacity always                   | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B13 update counterparty always               | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B14 update plannedQty null skipped           | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B15 update counterparty null skipped         | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| B16 update never sends lineId                | ANCHOR2               | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B16b update lineId dropped                   | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B17 update date value wrong                  | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B18 update template dropped                  | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| B19 update capacity dropped                  | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| B20 close rev +1                             | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| B21 close reason trimmed (extra)             | KILLED                | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift to plan, one moved to another line and day with its  | yes     |
| S1 create not strict                         | KILLED                | KILLED | test/protocol.test.ts: request fixture shift-create.json > rejects an unknown field, like the host                                    | yes     |
| S2 create plannedQty positive->nonneg        | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S3 create boxCapacity positive->nonneg       | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S4 create productId string                   | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S5 create lineId string                      | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S5b create boxTemplateId string              | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S6 create plannedQty not nullable            | SURVIVED              | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| S7 create counterpartyId not nullable        | SURVIVED              | KILLED | test/protocol.test.ts: request builders produce their fixtures exactly > a shift planned with no plan and no counterparty names both  | yes     |
| S8 create mode string                        | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S9 create palletsEnabled any                 | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S10 create productionDate required->optional | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S11 update not strict                        | KILLED                | KILLED | test/protocol.test.ts: request fixture shift-update.json > rejects an unknown field, like the host                                    | yes     |
| S12 update expectedRev not int               | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S12b update expectedRev optional             | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S13 update lineId string                     | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S14 update boxTemplateId string              | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S15 update boxCapacity nonneg                | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S16 update plannedQty nonneg                 | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S17 update plannedQty not nullable           | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| S18 update counterparty not nullable         | KILLED                | KILLED | test/protocol.test.ts: request builders send only what changes > names only the shift fields that differ, clears a plan or a counterp | yes     |
| S18b update counterparty string              | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S19 update mode string                       | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S19b update palletsEnabled any               | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S20 update mode nullable                     | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| S21 update palletsEnabled nullable           | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| S22 update productionDate nullable           | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| S23 update boxTemplateId nullable            | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| S24 update boxCapacity nullable              | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse null in a shift's update where the host would read it as keep, and take it for the plan  | yes     |
| S25 close not strict                         | KILLED                | KILLED | test/protocol.test.ts: request fixture shift-close.json > rejects an unknown field, like the host                                     | yes     |
| S26 close expectedRev not int                | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| S27 close reason optional                    | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| R1 closeReasonCode enum                      | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > read a mode and a close reason code this build does not know, and a plan of one unit            | yes     |
| R2 closeReasonCode not nullable              | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > closeShift sends the office token to the right route                                     | yes     |
| R3 closeReasonText not nullable              | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > closeShift sends the office token to the right route                                     | yes     |
| R4 number no min                             | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R5 closedAt plain string                     | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R6 lateDataAt plain string                   | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R7 createdAt plain string                    | ANCHOR4               | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R8 openedAt plain string                     | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R9 rev not int                               | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R10 date regex no end anchor                 | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R11 date regex no start anchor               | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R12 date any string                          | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R13 palletsEnabled any                       | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > refuse a shift whose times, number, flag, reason or date are of another form                    | yes     |
| R14 object strict (not tolerant)             | KILLED                | KILLED | test/protocol.test.ts: response fixture office-shift.json > tolerates a field added by a newer host                                   | yes     |
| R15 id string                                | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R16 ownerDeviceId not nullable               | KILLED                | KILLED | test/protocol.test.ts: shift shapes > read a planned shift without a plan, a counterparty, an owner or times, and a closed one        | yes     |
| R17 counterpartyId not nullable              | KILLED                | KILLED | test/protocol.test.ts: shift shapes > read a planned shift without a plan, a counterparty, an owner or times, and a closed one        | yes     |
| R18 plannedQty not nullable                  | KILLED                | KILLED | test/protocol.test.ts: shift shapes > read a planned shift without a plan, a counterparty, an owner or times, and a closed one        | yes     |
| R19 plannedQty not int                       | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R20 boxCapacity nonneg                       | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R21 status enum widened                      | KILLED                | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| R22 mode enum widened                        | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse a shift to plan, to move or to close with a field of another form, and one that lacks wh | yes     |
| R23 origin enum widened                      | KILLED                | KILLED | test/protocol.test.ts: shift shapes > refuse an unknown status, mode or origin, an id that is no UUID, a count that is no positive wh | yes     |
| R24 status enum narrowed                     | KILLED                | KILLED | test/protocol.test.ts: shift shapes > read a mode and a close reason code this build does not know, and a plan of one unit            | yes     |
| R25 mode enum narrowed                       | SURVIVED              | KILLED | test/protocol.test.ts: shift shapes > read a mode and a close reason code this build does not know, and a plan of one unit            | yes     |
| R26 origin enum narrowed                     | KILLED                | KILLED | test/protocol.test.ts: shift shapes > read a planned shift without a plan, a counterparty, an owner or times, and a closed one        | yes     |
| A1 from not encoded                          | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > encodes both ends of a period in the query                                                         | yes     |
| A2 to not encoded                            | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > encodes both ends of a period in the query                                                         | yes     |
| A3 from takes to                             | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > listShifts for a period sends the office token to the right route                        | yes     |
| A4 period inverted                           | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > listShifts for a period sends the office token to the right route                        | yes     |
| A5 list schema any                           | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| A6 list schema not array                     | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| A7 create schema any                         | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| A8 update schema any                         | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| A9 close schema any                          | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > rejects a list that is no list of shifts and a write whose answer is no shift                      | yes     |
| A10 delete schema any                        | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > resolves a delete with nothing, and rejects an answer that carries a body                          | yes     |
| A11 delete returns answer                    | SURVIVED              | KILLED | test/api.test.ts: HostApi shifts > resolves a delete with nothing, and rejects an answer that carries a body                          | yes     |
| A12 delete no token                          | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > deleteShift sends the office token to the right route                                    | yes     |
| A13 update path no id                        | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > updateShift sends the office token to the right route                                    | yes     |
| A14 close method PUT                         | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > closeShift sends the office token to the right route                                     | yes     |
| A15 create no token                          | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > createShift sends the office token to the right route                                    | yes     |
| A16 update body dropped                      | KILLED                | KILLED | test/api.test.ts: HostApi office endpoints > updateShift sends the office token to the right route                                    | yes     |

## Test totals

Plan: protocol/api/probe 3 files, 260 tests; whole package 67 files, 1768 tests (1744 + 24). Measured: 260 for the three files before my additions (matches); whole package 67 files, 1776 tests = 1768 + 8 (my 8 added tests). typecheck 0, lint 0 (first lint run flagged two unused `_gone` destructurings in my added test; rewritten with `Object.fromEntries(...filter)`, mutants relying on it re-run: S4, S5, S5b, S10, S12b, S27 all KILLED), `prettier --check` on the 8 files clean, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.

## Self-review / notes

- `officeShiftSchema` is loose (tolerates new fields, R14 mutant killed by the fixture row), request schemas are `.strict()`; `closeReasonCode` is plain text.
- `shiftUpdate` never emits `null` except for `plannedQty` and `counterpartyId`; `shiftUpdateSchema` refuses null in lineId/productionDate/boxTemplateId/boxCapacity/mode/palletsEnabled (mutants S20–S24, P3 killed).
- Not exercised: nothing outside the webview (no host, shell, browser); the PROTOCOL_VERSION constant swap in `probe.test.ts` and `test/support/fixtures.ts` is covered only by those suites passing.
- `proto/fixtures/error-with-details.json` ("1..=1") is untouched, as the brief says.

## Concerns

- The main worktree (`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`) showed an `M apps/standalone/test/protocol.test.ts` and several other `M` files that are not in the dispatch snapshot; I did not touch them (my one accidental relative-path `prettier --write` there reported `(unchanged)` for both files, so it changed nothing). Someone else is working there.
- Cargo not run (not required for this task).
