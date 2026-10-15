# Plan 2a6 — final-wave fix report

Worktree `/tmp/claude/wt/2a6`, branch `claude/2a6-scanning`, BASE `32b25f879`. Scratch and logs: `/tmp/claude/fix-2a6-final/`.

Status: DONE.

## Commits

| #   | hash        | subject                                                                                                                                              |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `e82890932` | test(standalone): the final review's test fixes: a formatted scan-source test, no stale plan pin, receipts after the link is gone, an honest 413 row |
| 2   | `5e9c17dea` | fix(standalone): comments say what the host answers to an over-limit body and what a supply's failure means                                          |
| 3   | `940fb4a35` | fix(standalone): one rule decides that a box is full, for the close helper and the work screen                                                       |

Each has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `git status --short` is empty after the last commit.

## Commit 1 (tests only)

- `test/floor-scan-source.test.ts`: reformatted with Prettier (the 2-element array wraps).
- `test/floor-schema.test.ts`: deleted the pin of the `coalesce(sum(to_serial + 1 - next_serial) …)` statement (no code runs it). Its comment now says that the blocks with room are pinned above (`BLOCKS_WITH_ROOM_SQL`, `:634`).
- `test/host-link-facts.test.ts`:
  - "reports nothing once the link is gone…" now has `await waitFor(() => expect(station.unsent()).toBe(0))` after the late answer.
  - Row «a 413» is now «a 413, which only something in front of the host would send». The `payload_too_large`/413 case in `factsFailureOf` stays, with a comment that the host itself answers 400 `validation_failed` (that case already has its own row, «a 400 of a batch that was correct»).

PRETTIER GATE proof (live): a deliberately mis-formatted scratch file made `prettier --check` exit 1 ("Checking formatting…", `[warn]` on the scratch file); the range run before the fix failed on exactly `floor-scan-source.test.ts` (as the review said); after the fix, over all 44 non-`.rs` files of `git diff --name-only 84c056f80..HEAD` (re-run at the end on the final HEAD range), "All matched files use Prettier code style!". Scratch file deleted.

Mutant (Mk, the review's): in `host-link.ts` the `sendFacts` handed to `sendFactBatch` is wrapped as `async (records) => { const receipts = await sendFacts(records); if (!active) throw …; return receipts; }` (receipts dropped after unmount).

| mutant                                                               | test that fails                                                                                                        | restore                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Mk: answer discarded when `!active`, before the receipts are written | `host-link-facts` «reports nothing once the link is gone, though the batch is still on its way» (1 failed, 25 skipped) | copy `/tmp/claude/fix-2a6-final/host-link.ts.orig`; `shasum -c` OK, `cmp` silent |

The relabelled row, the deleted pin and the formatting are not behaviour.

## Commit 2 (production comments only)

- `facts-sender.ts`: `MAX_BATCH_BYTES` doc says the host's over-limit answer is 400 `validation_failed` (axum's default 2 MiB limit; the host sets none); `withinBudget` doc says what follows if the first record were over the limit (refused with 400 on every send, blocking the queue) and why it cannot happen (`outboxStatement` keeps no record over 16 KiB); the `sendFactBatch` doc paragraph (the 105-column line) is re-wrapped.
- `shell.ts` (`FactsFailure`) and `floor/facts.ts` (`MAX_RECORD_BYTES`): 413 replaced by the 400 wording.
- `block-supply.ts`:
  - `SupplyResult.failed` doc: no answer, so the request stays and is repeated; or an answer the station does not keep (another prefix or extension, an inverted range, an overlap, `validation_failed`), so the request is dropped.
  - `createBlockSupply` doc mentions the overlap/other-answer drop and that nothing reports it through `onHostError`.
  - `remainingSerials` doc gets the one sentence on a serial whose SSCC another box holds (counted here, lost by the close as `invalid_serial`; no host produces that state today).
- Triage said "FIX doc (m3); CARRY reporting to ОЧ/2b", so the overlap drop is NOT made reported in code (nothing more than the table). No production behaviour changed, so there is no mutant; the four touched suites (`facts-sender`, `floor-block-supply`, `floor-facts`, `shell`) pass (236).

## Commit 3 (production refactor + tests)

- `box-close.ts`: exported `boxIsFull(itemCount, capacity)` (`itemCount >= capacity`); `closeIfFull` uses it.
- `WorkScreen.tsx`: `attemptClose` uses it, and so does the settle pre-filter after an accepted scan (`outcome.itemCount >= boxCapacity`). That was a third copy of the same comparison; I included it so the rule really has one place. Behaviour is identical.
- `AGENTS.md`: the sentence "`closeIfFull` is the same rule for a caller outside the screen" now names `boxIsFull`.
- New test (`floor-box-close.test.ts`): the boundary of `boxIsFull` (0, 11, 12, 13 of 12; 1 of 1). RED before: `TypeError: boxIsFull is not a function`.

| mutant (one line)                                                 | fails                                                                                                                                                      | restore                                                                                      |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A: `boxIsFull` returns `itemCount > capacity`                     | `floor-box-close` 3 tests (the new boundary test and two `closeIfFull` ones) AND `floor-work-screen` 32 tests; `floor-scan-pipeline` does not call a close | `cmp` against `/tmp/claude/fix-2a6-final/{box-close.ts,WorkScreen.tsx}.orig`, `shasum -c` OK |
| B: `attemptClose` asks `boxIsFull(…, boxCapacity + 1)`            | `floor-work-screen` 32                                                                                                                                     | same                                                                                         |
| C: `closeIfFull` back to its own comparison (`< boxCapacity + 1`) | `floor-box-close` 2                                                                                                                                        | same                                                                                         |
| D: settle pre-filter `false && boxIsFull(…)`                      | `floor-work-screen` 20                                                                                                                                     | same                                                                                         |

A shows that the predicate decides both call sites (pipeline close helper test and screen tests both fail). Note: the "pipeline test" that fails is `floor-box-close`, the file that drives `closeIfFull`; `floor-scan-pipeline` has no close in it.

## Gates (final HEAD `940fb4a35`)

- typecheck 0, lint 0, webview build 0 (no cargo: the shell was not touched, so `local_db`/`ipc` were not run).
- Prettier gate on the whole range, live-proven (above): clean. `git diff --check 84c056f80..HEAD` clean. `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`.
- Verbose run of the changed/touched Vitest files (`floor-box-close`, `floor-work-screen`, `floor-scan-pipeline`, plus commit 1's three): stderr 0 bytes. Delayed-`setImmediate` stand (3 ms; temp files deleted): `floor-box-close` + `floor-work-screen` 87 passed, stderr 0; `host-link-facts` 26 passed, stderr 0.
- ONE full Vitest at `--testTimeout=60000 --hookTimeout=60000`: **101 files, 3011 tests passed** (3010 + the new `boxIsFull` test), stderr 0 bytes, 152 s.

## Not done (as carried by the report)

22–24 ms accepted-count read per scan (2a8); partial-box stop offers only «Повторить» (2a8); attempts counter counts scans offline (ОЧ); N21 (owner); N16 runtime guard and N18 m2 comment wording (dropped); reporting of the dropped overlap (ОЧ/2b); merge-time receipt codes and the AGENTS `PROTOCOL_VERSION` sentence (merge checklist, not this wave).

## Concerns

None blocking. The `AGENTS.md` sentence about `box_closed` raising `PROTOCOL_VERSION` is still stale for the merge (checklist item 3). The plan's «Отклонения при исполнении» draft (report section (c), Task 8 line) already says the rule is `boxIsFull`.
