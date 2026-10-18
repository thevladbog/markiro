# Plan ХП, Task 3 — report

Status: DONE_WITH_CONCERNS (minor). Commit `a457f1a35` on `claude/m1` (/tmp/claude/wt/m1), base `093297a7f`. Tree clean after the commit. Evidence dir: `/tmp/claude/impl-hp-t3/`.

## What was done

- `src/floor/work/WorkScreen.tsx`:
  - module `closeLosingBadSerials(close)`: repeats the close up to `PALLET_SERIAL_TRIES` (3) calls in all while the result is `invalid_serial` (each such answer has spent exactly one serial). Used by `closeFullPallet` and by the early close (`closePallet`, wrapped around `closeSettled`, so a stale retry stays inside each try). The retry after `palletSupply.topUp()` in `closePallet` uses the same wrapper.
  - `settlePallet` no longer calls `palletSupply.topUp()`: the work queue never waits for the host for a full pallet.
  - `afterClosed` now tracks the whole chain `topUp -> onRecorded -> (pallet only) palletArrived.current()` as one gate piece; `palletArrived` is a ref set by a `useLayoutEffect` (after `settlePalletSafely`) that queues `queue.run(...)` with `if (stopRef.current === null) await settlePalletSafely(); await refreshQuietly()` — the same discipline as the link-back turn.
  - `topUpTracked` removed (its only user was `afterClosed`). `pendingClose` untouched: no change to when a close intention is dropped. No new serial arithmetic: each loop iteration is one call of the existing close, which spends one bad serial; no skipping or reuse.
- Tests: `floor-work-pallets.test.tsx` (new: held-host test, closes-early-past-a-lost-serial, three-lost test with cursor `[3]` and next serial 3, plus an extra stop-standing test), `floor-work-close-pallets.test.tsx` (two tests now hold serials 0,1,2).

## RED / GREEN

- RED (`red.txt`): 4 failed / 71 passed. The three named tests + `says the pallet did not close when its serial was lost…` (close-pallets, see adaptation 1).
- GREEN: the 4 suites of the brief (`floor-work-pallets`, `-close-pallets`, `-pallet-exceptions`, `floor-pallets`) 161 passed. After adding the extra test: pallets+close-pallets verbose 76 passed, `stderr |` = 0; under the delayed-`setImmediate` stand (3 ms) pallets+close-pallets+pallet-exceptions 131 passed, `stderr |` = 0; stand files deleted.
- typecheck 0, lint 0 (after one fix, adaptation 2), build 0, prettier gate live-proved (scratch file `[warn]`, exit 1, deleted) and clean on the three files, `git diff --check` clean, `grep '\u04'` only `pairing-code.ts:66`.
- Full package `run test`: 4613 passed / 3 failed, all in `template-editor.test.tsx` 5 s timeouts under load; that file alone with `--testTimeout=60000`: 97 passed.
- No Rust touched: no cargo run (per the brief's rule).

## Mutants (WorkScreen.tsx restored each time from a copy; sha256 `f783ca55…ccf2b` before and after, `cmp` silent; after the final lint fix the committed file is the sha of the commit)

| #   | one-line mutant                                                       | killed by                                                                                                                                                    |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | `closePallet`'s `close` without `closeLosingBadSerials`               | "closes early past a serial…", "says the early close did not take after three…", close-pallets "says the pallet did not close…"                              |
| M2  | `settlePallet` waits `palletSupply.topUp()` on `no_serials` again     | "keeps the line going while the host holds…"                                                                                                                 |
| M3  | drop `await palletArrived.current()`                                  | "keeps the line going…" and "closes the full pallet in the box's own turn when the host hands…"                                                              |
| M4  | `PALLET_SERIAL_TRIES = 1`                                             | 5 tests (early close, three-lost, loses-in-a-few-tries, stops-after-three, close-pallets retry)                                                              |
| M5  | `PALLET_SERIAL_TRIES = 4` (one extra serial spent)                    | "says the early close did not take after three…" (cursor), "stops losing serials after three tries…", close-pallets x2                                       |
| M6  | `palletArrived` ignores `stopRef` (settles under a stop)              | new "closes no pallet in the turn a pallet block queues while a stop stands on the line"                                                                     |
| M7  | `palletArrived` without `refreshQuietly`                              | "keeps the line going…", "closes the full pallet in the box's own turn…"                                                                                     |
| M8  | `closeFullPallet` without the loop                                    | "loses the pallet serials… in a few tries", "stops losing serials after three tries…"                                                                        |
| M9  | loop on `"stale"` instead of `"invalid_serial"`                       | 5 tests                                                                                                                                                      |
| M10 | chain in `afterClosed` not handed to `track`                          | "closes the full pallet in the box's own turn when the host hands…"                                                                                          |
| M12 | drop `onRecorded()` after a stored top-up                             | survived the brief's tests; killed after adding the `onRecorded` count (+1) assertion to the new stop-standing test                                          |
| M14 | drop the `topped.kind !== "stored"` guard                             | "stops losing serials after three tries…"                                                                                                                    |
| M13 | `const pallet = true` (box block arrival also queues the pallet turn) | SURVIVES. Equivalent in behaviour: the extra turn finds the pallet still without serials and does nothing; only the queue timing differs. Not killed; noted. |

## Test totals

Plan: no counts stated. Measured: pallets+close-pallets 76 (75 + the one extra test), with exceptions + `floor-pallets` neighbours 162; full package 4613 passed + 3 `template-editor` timeouts (all pass alone at 60 s).

## Files changed

`apps/standalone/src/floor/work/WorkScreen.tsx`, `apps/standalone/test/floor-work-pallets.test.tsx`, `apps/standalone/test/floor-work-close-pallets.test.tsx`.

## Anchor adaptations

All brief fragments matched exactly once. Differences:

1. Brief step 2 says both close-pallets tests PASS before the implementation. Measured: `says the pallet did not close when its serial was lost, keeps the shift open, and takes the next serial on «Повторить»` FAILS before (with serials 0,1,2 held, the first close loses only 0 and «Повторить» then loses 1, so no `pallet_closed`); it goes green with the loop (3 tries lose 0,1,2, «Повторить» takes 3). The second one (`palletBlock: false`) passes before and after. Not a semantic difference in the final behaviour.
2. `useRef<() => Promise<void>>(async () => undefined)` failed `@typescript-eslint/require-await`; written as `() => Promise.resolve()`.
3. The new test "keeps the line going while the host holds the request…" works as written; a test that uses `work.scan` while the host request is held would deadlock (the gate drain waits for the held request): the stop-standing test therefore also uses `act` + `turnsUntil`.

## Added beyond the brief

- Test "closes no pallet in the turn a pallet block queues while a stop stands on the line" (box without a printer assignment -> label stop; the pallet block comes while it stands; block stored and the floor told, no `pallet_closed`). It kills M6 and M12.

## Self-review / concerns

- Data integrity: the loop calls the existing close; each `invalid_serial` has spent exactly one serial, so three tries spend at most three and the cursor assertions (`[2]`, `[3]`) pin it. Early close stops with `pallet_failed` only after three in a row.
- Work queue: for a full pallet it no longer waits for the host at all; the early close still asks the host inside the queue (decision Д3 of the plan, on the operator's own press).
- A box turn that runs while a pallet-block request hangs leaves a tracked piece in the gate (the leaving floor waits for that request as before, since the top-up was already tracked).
- M13 survives as an equivalent mutant (see table).
- Not exercised: real Windows/printer/host; only jsdom with the fake hardware.
