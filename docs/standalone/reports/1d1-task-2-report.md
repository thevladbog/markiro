# Plan 1d1, Task 2 — Report

Класс сбоя и повтор с отступом — `src/app/shell.ts`, `src/app/host-link.ts`

## What was implemented

1. **`apps/standalone/src/app/shell.ts`**
   - New exported type `SyncFailure = "host" | "local" | "feed"`.
   - `SyncState` gained `failure: SyncFailure | null` and `quarantined: number`.
   - `ShellAction`'s `sync_failed` variant now carries `failure: SyncFailure`.
   - `IDLE_SYNC` updated to `{ kind: "idle", synced: 0, failure: null, quarantined: 0 }`.
   - `shellReducer`:
     - `sync_started` still spreads `...state.sync`, so `failure`/`quarantined` survive into the retry's own run (comment added explaining this).
     - `sync_finished` (non-`other_host` branch) now sets `failure: null` and `quarantined: action.result.quarantined`.
     - `sync_failed` sets `failure: action.failure`, leaves `quarantined` untouched (via `...state.sync` spread).
     - `other_host` absorption and `paired`/`forgotten` resets unchanged in behavior (they already reset via `IDLE_SYNC`/literal `other_host` objects, now carrying the new fields automatically).

2. **`apps/standalone/src/app/host-link.ts`** (rewritten whole file per the brief)
   - `RETRY_MS = [2000, 4000, 8000, 16000, 32000]`, `RETRY_CAP_MS = 60_000`.
   - `nextSyncRetryMs(attempt)`: returns `RETRY_MS[attempt - 1] ?? RETRY_CAP_MS` → 2/4/8/16/32 s then 60 s for every later attempt.
   - `syncFailureOf(error)`: `HostError` → `"host"`, except `kind: "transport"` + `code: "invalid_response"` → `"feed"`; `LocalDbError` → `"local"`; anything else (including `SyncFeedError`) → `"feed"`.
   - `useHostLink` now tracks `online`, `running`, `failures` (consecutive failures) and a single `retry` timer per effect instance:
     - Every run (revision, `syncNow`, or the retry's own trigger) starts by calling `cancelRetry()` — one cancellation point, not one per trigger site, per the plan's note that separate cancellation at each call site is unnecessary.
     - A successful run resets `failures = 0`.
     - A failed run dispatches `sync_failed` with `syncFailureOf(error)` unconditionally; only when `shellActionFor` found **no** rejection (`action === null`) does it increment `failures` and, if the link is currently `online`, schedule a retry via `setTimeout(nextSyncRetryMs(failures))`.
     - `onStatus`: updates `online`; going non-`online` cancels the pending retry; coming back `online` after a failed run with no pending timer (`failures > 0 && !running && retry === null`) triggers a sync at once.
     - Effect cleanup calls `cancelRetry()` in addition to the existing `scheduler.stop()`/`unwatch()`.

3. **Tests**
   - Created `apps/standalone/test/host-link.test.ts` (new): unit tests for `nextSyncRetryMs` and `syncFailureOf`.
   - `apps/standalone/test/shell.test.ts`: updated all `SyncState` literals to the 4-field shape, updated `sync_failed` calls to carry `failure`, and added a new test "keeps why a sync failed through its retry, and the quarantine of the last success".
   - `apps/standalone/test/line-select.test.tsx`: replaced wholly; added a local `syncState(kind, synced)` helper (no failure, no quarantine) since `SyncState` now has 4 fields; behavior of these tests is unchanged.
   - `apps/standalone/test/app.test.tsx`: added `afterEach` import, a module-level `hostDown()` helper (`HostError` `kind: "transport"`/`code: "unreachable"`), "exactly once" double-`setImmediate` checks in the two existing watch/sync tests, and a new `describe("reference sync retries", …)` block with 6 tests (backoff timing, stop-on-success, link-down drops retry / link-back syncs at once, revision drops pending retry, unmount clears timer, retry landing on another host clears timer).

4. **Docs**
   - `apps/standalone/AGENTS.md` ("App shell" section): documented the retry schedule, failure classification, and how `failure`/`quarantined` behave across retries.
   - `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` §5.4: replaced "неудачный прогон ждёт следующего события" with the retry description (schedule, reset-on-success, immediate trigger on revision/request, drop-on-offline, immediate resume on reconnect).

All fragments given in the brief were verified byte-for-byte against the pre-change files before editing (see "Deviations" — none needed; every "before" fragment matched exactly).

## TDD evidence

### RED

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link.test.ts test/app.test.tsx test/line-select.test.tsx
```

Result: **13 failed, 79 passed (92)** — matches the brief's predicted RED exactly:

```
 ❯ test/host-link.test.ts (2 tests | 2 failed)
     × waits 2, 4, 8, 16 and 32 s, then 60 s before every later retry
     × blames the host, this computer or the feed
 ❯ test/shell.test.ts (35 tests | 5 failed)
     × counts the syncs that brought the copies up to date
     × keeps why a sync failed through its retry, and the quarantine of the last success
     × keeps sync at other_host until a new pairing, absorbing every other sync action
     × forgets the link, the sync and the revision with the pairing
     × resets the link, the sync and the revision on a new pairing, not just on forgetting
 ❯ test/app.test.tsx (46 tests | 6 failed)
     × retries a failed sync after 2 s, then after 4 s, while the link is online
     × stops retrying once a sync succeeds
     × drops the pending retry while the link is down and syncs at once when it is back
     × syncs at once on a revision, dropping the pending retry
     × leaves no retry behind when the app unmounts
     × leaves no retry behind when a retry finds another host

Test Files  3 failed | 1 passed (4)
     Tests  13 failed | 79 passed (92)
```

Sample failure messages (matching brief's description):

- `host-link.test.ts`: `TypeError: nextSyncRetryMs is not a function`, `TypeError: syncFailureOf is not a function`.
- `shell.test.ts`: `expected { kind: 'running', synced: +0 } to deeply equal { kind: 'running', synced: +0, …(2) }` (missing `failure`/`quarantined`).
- `app.test.tsx`: `expected "vi.fn()" to be called 2 times, but got 1 times` (×2), `expected "vi.fn()" to be called 3 times, but got 2 times` (revision test), `expected +0 to be 1` on `vi.getTimerCount()` (×2), `Unable to find an element with the text: Устройство подключено к другому хосту`.
- `line-select.test.tsx`: passed (0 failures) — it only moved to the `syncState` helper.

### GREEN

Command:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/shell.test.ts test/host-link.test.ts test/app.test.tsx test/line-select.test.tsx
```

Result:

```
 Test Files  4 passed (4)
      Tests  92 passed (92)
```

Matches the brief's expected breakdown: 35 in `shell.test.ts`, 2 in `host-link.test.ts`, 46 in `app.test.tsx`, 9 in `line-select.test.tsx`.

## Verification commands and results

| Command                                                                                                                                                                         | Result                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                     | PASS — `Test Files 29 passed (29)`, `Tests 499 passed (499)`                                                                                                                                                    |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                | PASS — `tsc -p tsconfig.json --noEmit`, no errors                                                                                                                                                               |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                     | PASS — `eslint .`, no errors                                                                                                                                                                                    |
| `node_modules/.bin/prettier --check` on all 8 changed files (shell.ts, host-link.ts, host-link.test.ts, shell.test.ts, line-select.test.tsx, app.test.tsx, AGENTS.md, spec .md) | PASS — "All matched files use Prettier code style!"                                                                                                                                                             |
| `git diff --check`                                                                                                                                                              | PASS — no output (no whitespace errors)                                                                                                                                                                         |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run --reporter=verbose` (run once, full output inspected)                                     | PASS — `Test Files 29 passed (29)`, `Tests 499 passed (499)`; output inspected line-by-line: every non-blank, non-summary line is a `✓` pass line — no `act(...)` warnings, no console noise, no stderr content |
| `grep -n '\\u04'` on all changed files                                                                                                                                          | No matches — no literal `\uXXXX` escapes introduced for the Cyrillic text added                                                                                                                                 |
| `grep -rln "sync_failed\|SyncFailure"` outside `apps/standalone`                                                                                                                | No matches — confirms the change is fully isolated to the standalone app (no `apps/station` impact, none intended or found)                                                                                     |

## Files changed

- `apps/standalone/src/app/shell.ts` (modified)
- `apps/standalone/src/app/host-link.ts` (modified, whole file per brief)
- `apps/standalone/test/host-link.test.ts` (created)
- `apps/standalone/test/shell.test.ts` (modified)
- `apps/standalone/test/line-select.test.tsx` (modified, whole file per brief)
- `apps/standalone/test/app.test.tsx` (modified)
- `apps/standalone/AGENTS.md` (modified)
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (modified, §5.4)

Commit: `090f97a60a8dcaf83758188ce9620a084b6dd667`

```
feat(standalone): класс сбоя синхронизации и повтор с отступом, пока хост на связи

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Verified with `git log -1 --format=%B`: exactly one `Co-Authored-By` line, matching the required trailer verbatim. Staged via explicit paths only (`git add <8 files>`), confirmed against `git status --short` before committing (no unrelated files picked up).

## Deviations

None. Every "before" fragment in the brief (shell.ts's 5 fragments, shell.test.ts's 7 fragments, app.test.tsx's 5 fragments, AGENTS.md's fragment, the spec's fragment) was read from the actual files first and matched byte-for-byte before editing, as required by the task instructions ("the brief's fragments should match the current files byte for byte... if one does not, stop and report NEEDS_CONTEXT"). The two whole-file replacements (`host-link.ts`, `line-select.test.tsx`) were written exactly as given in the brief. No improvisation was needed.

## Self-review findings

- **Completeness against the brief**: all interfaces listed as "Produces" exist with the exact names and shapes: `SyncFailure`, the 4-field `SyncState`, the `sync_failed` action with `failure`, `nextSyncRetryMs`, `syncFailureOf`, `useHostLink` keeping its prior signature, and the module-level `hostDown()` test helper in `app.test.tsx` (for task 3 to reuse, per the brief).
- **Names**: match the brief exactly (`nextSyncRetryMs`, `syncFailureOf`, `RETRY_MS`, `RETRY_CAP_MS`, `SyncFailure`, `hostDown`, `syncState`, `fakeRetryTimers`, `elapse`, `firstSyncFailed`).
- **No overbuilding**: no UI wiring was added (that's task 3's job — `HostStatusLine`, `LineSelect`, `App`, `screens.tsx`, `shell.css`, `ru.json` were left untouched, and I confirmed via `grep` that no other production file references `SyncFailure`/`sync_failed`/the new `SyncState` fields). No extra exports, no speculative helpers beyond what the brief specifies.
- **Tests verify behavior, not implementation**: the retry tests assert on observable outputs (`host.getChanges` call counts, `vi.getTimerCount()`, rendered text) at specific elapsed-time boundaries, not on internal state shape. The `host-link.test.ts` unit tests exercise the two new pure functions directly against real error classes (`HostError`, `LocalDbError`, `SyncFeedError`), not fakes.
- **Output pristine**: confirmed via a dedicated `--reporter=verbose` run whose entire output (except the run header and final summary/blank lines) consists solely of `✓` lines — no `act(...)` warnings or other console noise.
- No issues found that required further fixes.

## Concerns

None. All checks specified in the brief and in `apps/standalone/AGENTS.md`/root `AGENTS.md` passed on the first implementation attempt after RED. This is a webview-only (TypeScript/React) change; it does not touch `src-tauri`, so no Cargo/Windows/hardware verification applies here (that surface is untouched by this task, consistent with the plan's file map).

## Follow-up (post-review, on top of 090f97a60)

The review approved task 2 as matching the brief byte-for-byte, and asked for four small fixes in one new commit, on top of `090f97a60`. All four are done, in `03aec7141`.

### Item 1 — two rules with no failing test

**(a) Reset on success.** Added `it("resets the failure count after a successful run, so the next failure waits 2 s again", …)` to the `describe("reference sync retries", …)` block in `apps/standalone/test/app.test.tsx`. It fails once (armed retry, 2 s), lets that retry succeed (`feedPage(42)`, `rev` unchanged so the rollback branch in `reference-sync.ts` does not fire a second internal fetch), then drives a revision-triggered run that fails again, and asserts the following retry fires at 2 s (`elapse(500)` → still not fired, `elapse(2000)` more → fired), not 4 s.

**(b) The offline arming guard.** Added `it("does not arm a retry while the link is not online, and syncs at once once it is", …)` to the same block. It uses a small inline `ConnectionApi` fake whose `watch` reports `state: "connecting"` (not `online`) before the first run fails, asserts `vi.getTimerCount()` is `0` right after the failure, then flips the same handlers to `online` and confirms exactly one new run happens (`waitFor` to 2 calls, then the empty-lines message).

**Mutation check, item 1(a)** — deleted the `failures = 0;` reset line in `apps/standalone/src/app/host-link.ts` (right after `const result = await syncReferences(...)`), then ran:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "resets the failure count"
```

Result — fails as expected:

```
FAIL  test/app.test.tsx > reference sync retries > resets the failure count after a successful run, so the next failure waits 2 s again
AssertionError: expected "vi.fn()" to be called 4 times, but got 3 times
 ❯ test/app.test.tsx:1203:29
    1201|     expect(host.getChanges).toHaveBeenCalledTimes(3);
    1202|     await elapse(2000);
    1203|     expect(host.getChanges).toHaveBeenCalledTimes(4);
       |                             ^

 Test Files  1 failed (1)
      Tests  1 failed | 47 skipped (48)
```

Reverted the deletion (restored `failures = 0;`) immediately after recording this output.

**Mutation check, item 1(b)** — removed the `if (online) { … }` guard around the `retry = setTimeout(...)` arming in `host-link.ts` (kept the body, dropped the condition), then ran:

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "does not arm a retry"
```

Result — fails as expected:

```
FAIL  test/app.test.tsx > reference sync retries > does not arm a retry while the link is not online, and syncs at once once it is
AssertionError: expected 1 to be +0 // Object.is equality
- Expected
+ Received
- 0
+ 1
 ❯ test/app.test.tsx:1223:32
    1221|     await firstSyncFailed();
    1222|     // Not online: nothing was worth arming a retry against.
    1223|     expect(vi.getTimerCount()).toBe(0);
       |                                ^

 Test Files  1 failed (1)
      Tests  1 failed | 47 skipped (48)
```

Reverted the guard removal immediately after recording this output. `git diff HEAD -- apps/standalone/src/app/host-link.ts` after both reverts showed only the intended item-4 doc-comment change (below), confirming both mutations were fully undone before committing.

### Item 2 — the racy line-select retry test

Removed `it("retries a failed reference sync from the line-select screen", …)` from `describe("App", …)` (it used the default `fakeConnection()`, which reports `online` immediately, so the real `HostError` failure armed a genuine 2 s `setTimeout`; the test only passed because the synchronous button click's `cancelRetry()` always won the race against that real timer).

Replaced it with `it("retries a failed reference sync from the line-select screen, and a request drops the pending retry", …)` inside `describe("reference sync retries", …)`, using `fakeRetryTimers()`. It fails once, clicks «Повторить» (asserting the resulting second `getChanges` call, which also fails), then asserts the _next_ automatic retry — armed by that second failure — fires after 4 s, not 2 s (`elapse(2500)` → still 2 calls, `elapse(2000)` more → 3 calls), before the third call succeeds and «Линия 1» renders. This directly exercises "a request drops the pending retry" and that the failure streak (not reset by a manual request) continues.

### Item 3 — the tight timing margin

In `it("retries a failed sync after 2 s, then after 4 s, while the link is online", …)`, changed the first `elapse(1000)` / `elapse(1500)` pair (cumulative 1000 ms "not yet" check against the 2000 ms threshold — a bare 1000 ms nominal margin that `shouldAdvanceTime`'s background drift can erode below the plan's "at least 1 s" rule) to `elapse(500)` / `elapse(2000)` (cumulative unchanged at 2500 ms for the "now" check, but the "not yet" checkpoint now sits at 500 ms — a 1500 ms margin below the 2000 ms threshold). No other `elapse` pair in the file had a margin this tight (the next-smallest, the second retry's 4 s threshold, already carries a ≥1500 ms margin), so no other lines needed changing.

### Item 4 — docs

- `apps/standalone/src/app/shell.ts` (`SyncFailure` doc): "the host did not answer the request" → "the host could not be reached, or it refused or failed the request (`HostError`, except an answer this build cannot read)", so an API error (e.g. a 500) reads as `host`, not just an unreachable host.
- `apps/standalone/src/app/host-link.ts` (`syncFailureOf` doc): same rewording — "the host did not answer" → "the host could not be reached, or it refused or failed the request (a `HostError`, except an answer this build cannot read)".
- `apps/standalone/AGENTS.md` ("App shell" section): reworded "a status that is not `online` drops it, and an `online` status after a failed run whose retry was dropped syncs at once" to also cover a run that failed while the link was never `online` (so no retry was ever armed to drop): "a status that is not `online` drops it (a run that failed while the link was already not `online` never armed one); and an `online` status after a failed run with no retry pending — dropped, or never armed — syncs at once."

### Commands and results

| Command                                                                                                                                                                                               | Result                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/host-link.test.ts test/shell.test.ts --reporter=verbose` (after both mutations reverted) | PASS — `Test Files 3 passed (3)`, `Tests 85 passed (85)`; inspected line-by-line, every non-blank/non-summary line is a `✓` pass line |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                                           | PASS — `Test Files 29 passed (29)`, `Tests 501 passed (501)` (499 + net 2: one racy test removed, three added)                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                                      | PASS — no errors                                                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                           | PASS — no errors                                                                                                                      |
| `node_modules/.bin/prettier --check` on the 4 changed files (`AGENTS.md`, `host-link.ts`, `shell.ts`, `app.test.tsx`)                                                                                 | PASS — "All matched files use Prettier code style!"                                                                                   |
| `git diff --check`                                                                                                                                                                                    | PASS — no output                                                                                                                      |
| `grep -n '\\u04'` on the 4 changed files                                                                                                                                                              | No matches — no literal `\uXXXX` escapes in the added Cyrillic text                                                                   |

### Files changed (this follow-up)

- `apps/standalone/AGENTS.md`
- `apps/standalone/src/app/host-link.ts`
- `apps/standalone/src/app/shell.ts`
- `apps/standalone/test/app.test.tsx`

### New commit

`03aec71418bf82d13b09e40084dc323a73a17619`

```
test(standalone): ревью задачи 2 плана 1d1 — сброс счёта и повтор без связи в тестах, гонка с таймером

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Verified with `git log -1 --format=%B`: exactly one `Co-Authored-By` line, matching the required trailer. Staged via explicit paths only (`git add` the 4 files above), matching `git status --short` before committing.

### Concerns

None.
