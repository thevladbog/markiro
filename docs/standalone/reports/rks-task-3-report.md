# Plan РК-С, Task 3 — report

Status: DONE_WITH_CONCERNS. Commit `c1da39169` on `claude/floor-2a7` at /tmp/claude/wt/flr, base `91a49c1f4`. Tree clean after the commit. No Rust touched, so no cargo run (Rust unchanged since Task 2's full workspace run).

## What was done

- `shell.ts`: `FactsFailure` gains `"held"`.
- `host-link.ts` (brief steps 2-16 applied, anchors matched exactly once; extras below):
  - `RESTORE_HOLD_RETRY_MS = 60_000`, `restoreHeld`, `factsFailureOf(restore_pending) === "held"`.
  - `registerKnownBlocks` option; a new `reconciler` scheduler (noteEpoch, `reconcileRestore`, on `reconciled`: `outbox_changed`, `scheduler.trigger()`, `factSender.trigger()`); retried with `nextSyncRetryMs`; triggered by `everything`, by a new `restoreEpoch` in an online status, and on return to online while it has failed; cancelled with the link (`stopAll`, offline).
  - Sender: `await noteEpoch(); if (await restoreDue(...)) return;` before `sendFactBatch` (epoch written FIRST, then the gate).
  - Held failure retries after `RESTORE_HOLD_RETRY_MS`.
- `App.tsx` passes `hostApi.registerKnownBlocks`.
- `FloorStatusBar.tsx`: `readRestoreStatus` with the outbox (re-read on `outboxVersion`, stale-read and failed-read safe), three alerts in the existing polite region (`role="presentation"`), `ru.json` keys `restoreHeld`, `restoreDue`, `restoreRefused` (unique, checked by script).

## Additions beyond the brief (all with tests and mutants)

1. Hold gate (`factsHeld`): while the host's minute runs, no other trigger (local write `requestFacts`, revision event, `requestSync`) sends; otherwise each scan would knock a held host and reset the wait. Set exactly when the hold's timer is set, cleared with it (`cancelFactRetry`), by the timer firing, and by the link going offline (so a link that returns asks at once). This is the "never a hot retry loop" duty.
2. One shared write of the epoch (`noting`): the sender and the reconciler both ask at start and raced to write twice; now one write per epoch, a failed write is forgotten and written again on the next ask (brief's `epochNoted` replaced; semantics otherwise as the brief).
3. Status bar: the stuck-delivery line ("oldest record waits N days") is suppressed while `factsFailure === "held"` or blocks are owed (`stuckIsRestore`), because a reconcile reopens up to 30 days of records and their `created_at` is old (Task 2 review M5). The "refused" line is NOT hidden by `refusalHeld` (facts about blocks stay true); "held"/"due" are.
4. No-blocks station: reconcile settles without a route call, so the "due" line disappears and nothing says failure; a test pins that no line about a restore or a host failure remains.
5. Block supply: a refused (retired) block gives no serials (`remainingSerials` 0) through the hook wiring test; `block-supply.ts` already selects `next_serial <= to_serial`, no change needed.
6. Key rejected during the settling: link stops (`device_rejected` dispatched, register once, nothing sent).

## RED / GREEN

- RED (`vitest run` of the 4 files after step 1 only): `Test Files 2 failed | 2 passed (4)`, `Tests 7 failed | 83 passed (90)` — exactly as the brief (/tmp/claude/impl-rks-t3/red.txt).
- GREEN, brief's 4 files: `4 passed`, `90 passed (90)` after step 3; with my extras the same 4 files give `108 passed (108)`.
- `test/app.test.tsx test/floor-app.test.tsx test/shell.test.ts test/host-link.test.ts`: `390 passed` (brief said 348; the base has more tests).
- Delayed-`setImmediate` stand (3 ms; scratch config + setup deleted afterwards): the 4 files `108 passed`.
- Verbose run of the 4 files: stderr 0 bytes, no `act(...)` warnings.
- Full package Vitest: `148 files, 4586 tests`: first run 4585 passed, 1 failed (`template-editor.test.tsx`, known load timeout); alone `97 passed`. Plan expectation 3138 on its scratch copy; base before this task about 4559.
- typecheck 0, lint 0, build 0, `git diff --check` clean, `grep '\u04'`: only `pairing-code.ts:66`, prettier gate live-proved (scratch `zz.ts` gave `[warn]`, exit 1, deleted) and clean on 10 files. ru.json key-uniqueness script: no duplicates.
- Parity tests (`test/protocol.test.ts` in the full run passed; no Rust or fixture change).

## Mutants (all restored; `cmp` silent, sha256 identical; scripts and outputs in /tmp/claude/impl-rks-t3/mut/, `mutants.txt`, `mutants2.txt`)

| #   | one-line mutant                           | killed by (first)                                     |
| --- | ----------------------------------------- | ----------------------------------------------------- |
| L1  | delete `restoreDue` gate                  | sends no record while the blocks are owed (+2)        |
| L2  | sender does not write epoch first         | gives the blocks back first, then syncs from zero     |
| L3  | hold uses the ordinary wait               | waits a minute… / asks once a minute                  |
| L4  | no `held` mapping                         | waits a minute… / tells the hold apart                |
| L5  | `everything` does not trigger reconciler  | sends no record while owed (+2)                       |
| L6  | epoch of status not read                  | gives the blocks back first (+2)                      |
| L7  | no feed sync after reconcile              | gives the blocks back first                           |
| L8  | no hold gate                              | asks once a minute, whatever else asks                |
| L9  | `cancelFactRetry` keeps the hold          | asks again at once when the link comes back           |
| L10 | timer does not clear the hold             | asks once a minute / waits a minute                   |
| L11 | offline keeps reconcile retry             | does not knock while the link is down                 |
| L12 | `reconciler.stop()` missing in stopAll    | ends the link when the host rejects the key           |
| L13 | `cancelReconcileRetry` missing in stopAll | asks nothing more after the link ends (timer count 0) |
| L14 | no reconcile retry on return to online    | does not knock while down, asks at once               |
| L15 | failure count not incremented             | sends no record while owed (+2)                       |
| L16 | no `stopAll` on rejected key              | ends the link when the host rejects the key           |
| L17 | no `outbox_changed` after the epoch write | tells the status bar at once that the station owes    |
| L18 | hold flag never set                       | asks once a minute                                    |
| L19 | new epoch is not written again            | settles another epoch the host shows later            |
| L20 | failed write remembered                   | writes the epoch again after a write failed           |
| L21 | no sharing of the write                   | writes an epoch down once                             |
| S1  | due line off                              | says while the station owes… (+2)                     |
| S2  | refused threshold 2                       | says while… owes / keeps the refused blocks           |
| S3  | held line off                             | says in the polite region… (+1)                       |
| S4  | stuck not hidden when held                | does not call a wait of weeks stuck                   |
| S5  | stuck not hidden when due                 | same                                                  |
| S6  | held line shown during refusal            | keeps the refused blocks when the refusal waits       |
| S7  | due line shown during refusal             | same                                                  |
| S8  | refused line hidden during refusal        | same                                                  |
| S9  | restore read ignores `outboxVersion`      | counts this pairing's records… (+2)                   |
| S10 | stale read overwrites                     | keeps what the newest read says of a restore          |
| S11 | failed read keeps the old line            | drops what it said when the next read fails           |

First round: L13, L19, L20 survived; fixed by the timer-count assertion and the shared-write test (then the shared write became the `noting` design; L19-L21 redefined and all 21 L mutants re-run after it: all killed). Equivalent, unguarded: `changed &&` in the epoch write's `outbox_changed` (an extra dispatch only re-reads counts), `status.restoreEpoch !== epochSeen` in `onStatus` (a repeated trigger returns `none`).

## Anchor adaptations

- None for TS anchors: all brief fragments matched once. The brief's `epochNoted` was replaced by the shared `noting` write (addition 2). Edits applied with an exact-once script (`rep.py`).
- Counts: plan 90 / 348 vs measured 108 (with extras) / 390.

## Self-review

- Order: epoch written first in both sender and reconciler; sender returns without scheduling anything when due (the reconciler's success triggers it); a reconcile failure retries on its own timer.
- Held: `held` is a failure state with one `facts_failed` dispatch per attempt, a 60 s wait, no data loss (records stay in the outbox), the floor unaffected (code checks already skip the scan on any failure, `scan-pipeline.ts hostOwner`).
- Effects: every timer is cancelled on unmount/offline; `reconciler.stop()`; status-bar effect has `cancelled` cleanup.

## Concerns

1. `restore_pending` arrives with the holding path only for `/v1/device/facts` and `/v1/device/codes/*` (host `held_by_a_restore`); the blocks route is not held, as the design needs.
2. After a reconcile that completes while the host's other failures persist (not held, not due), the stuck line would show the old `created_at` (weeks). It comes from `outbox-status.ts` (`HEAD_RECORD_SQL`), outside this task's files; the right fix is to base the wait on the reopening time. Not done.
3. A station with no blocks is never marked «Вернула» by the host (route rejects an empty list): the status bar says nothing about it; Tasks 4/5 must not present it as failure.
4. The hold gate delays a scan's delivery up to a minute after the hold ends on the host; this matches `Retry-After`.
5. Forget-while-owed warning (M5) and the "old pairing's records not sent" line (I1) were not added (outside the brief's files / owner decision pending).
6. Not exercised: Windows, WebView2, real `markiro-host restore`, two stations.

## Files

Created: `apps/standalone/test/host-link-restore.test.ts`. Changed: `src/app/shell.ts`, `src/app/host-link.ts`, `src/app/App.tsx`, `src/floor/FloorStatusBar.tsx`, `src/i18n/ru.json`, `test/{floor-status-bar,host-link-facts,host-link-shifts,app}.test.ts(x)`.
