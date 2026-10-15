# Plan 1f, Task 1 report — copies bound to the pairing

Status: DONE_WITH_CONCERNS (concerns are notes, not blockers).
Base 79f077c1d; commit `b74133992 fix(standalone): копии справочников привязаны к подключению, а не только к хосту` (one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## What was done

Steps 1–4 of the brief were applied verbatim (all anchors matched exactly once, including the 87/5 perl counts). In `reference-sync.ts`: `SyncOptions.deviceId`, `Pairing`, `copiesReady`, `WRITE_STATE` with `device_id`, `WRITE_PAIRING` and `DROP_LAST_REV`, `pairingGuard` (`expectedChanges: 2`) in place of `hostGuard`, the wipe condition for another host or another device id, and the stamp plus `last_rev` drop for a state without a complete stamp. `useHostLink` takes `deviceId`, `App` passes `linked?.deviceId`. `DEVICE_ID` in fixtures.

Beyond the brief, six extra tests (see below). Not touched: the host, `proto`, the shell, `apps/standalone/AGENTS.md` (it still says `hostGuard` at lines 390, 580, 628, 652: those are Task 7's documents).

## Counts

|                               | brief / plan                    | measured                             |
| ----------------------------- | ------------------------------- | ------------------------------------ |
| baseline Vitest               | 59 files / 1418                 | 59 / 1418                            |
| RED (2 files)                 | 25 failed / 103 passed (128)    | 25 failed / 103 passed (128)         |
| GREEN (2 files) before extras | 128 (reference-sync 62, app 66) | 128                                  |
| GREEN (2 files) with extras   | n/a                             | 134 (reference-sync 67, app 67)      |
| full package                  | 59 / 1423                       | 59 / **1429** (1423 + 6 extra tests) |

Verbose run of both files: 134 passed, stderr 0 bytes. Delayed-`setImmediate` stand: 134 passed, stderr 0 bytes; stand files removed. typecheck 0, lint 0, prettier --check clean, `git diff --check` clean, `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.

RED evidence: `/tmp/claude/1f1-red.txt` (25 failures: `device_id` row missing, `copiesReady is not a function`, `expected the previous pairing's page to fail`, `expected "vi.fn()" to be called with arguments: [ +0 ]`, guard batch `[1,…]` vs `[2,…]`, app `expected {} to deeply equal { Object (value) }`).

## Plan mutants (all FAIL as the plan expects; each restored byte-identically: sha256 equal, `cmp` silent)

| #   | mutant                                                          | failing test                                                  | key line                                                                |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | guard `values: [hostId, hostId], expectedChanges: 1`            | fails a page of the previous pairing with the same host …     | `Error: expected the previous pairing's page to fail`                   |
| 2   | wipe condition on host only                                     | wipes the copies of an earlier pairing with the same host …   | `expected { org: [], site: [], …(2) } to deeply equal …`                |
| 3   | stamp without `DROP_LAST_REV`                                   | stamps device_id beside a host_id an older build left alone … | `expected [ { key: 'device_id' …(1) }, …(3) ] to deeply equal [ …(2) ]` |
| 4   | drop `stored.deviceId === pairing.deviceId &&` in `copiesReady` | copiesReady > answers yes only after …                        | `expected true to be false`                                             |

## My additional mutants (also restored byte-identically, hash and cmp checked by script)

| mutant                                                                        | killed by                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copiesReady` without the host check                                          | copiesReady yes-only-after                                                                                                                                                                   |
| `copiesReady` without the entity-set check (anchor `…lastRev !== null\n  );`) | copiesReady yes-only-after (`expected true to be false`)                                                                                                                                     |
| `copiesReady` without the `lastRev` check (`true`)                            | older-build test (`expected true to be false`)                                                                                                                                               |
| `copiesReady` with `true` instead of the entity-set check                     | copiesReady yes-only-after                                                                                                                                                                   |
| `WRITE_PAIRING` writes the literal `'x'` as `device_id`                       | 15+ tests (copiesReady, first full sync, …)                                                                                                                                                  |
| `WRITE_STATE` writes `hostId` as `device_id`                                  | 15+ tests                                                                                                                                                                                    |
| wipe condition without the device clause (`&& false`)                         | wipes the copies of an earlier pairing …                                                                                                                                                     |
| continuing branch without `stored.deviceId === deviceId`                      | older-build test (`called with arguments: [ +0 ]`)                                                                                                                                           |
| stamp branch only for `hostId === null`                                       | older-build test (state lacks `device_id`)                                                                                                                                                   |
| wipe batch `[stamp, ...WIPE]` (WIPE deletes the stamp)                        | 4 tests incl. the same-host wipe and the stale in-flight pair                                                                                                                                |
| guard `expectedChanges: 1` with the real two-row SQL                          | 15+ tests                                                                                                                                                                                    |
| guard SQL both clauses on `device_id`                                         | 15+ tests                                                                                                                                                                                    |
| guard after the wipe (`[...WIPE, guard, …]`)                                  | 15+ tests                                                                                                                                                                                    |
| guard on `device_id` alone (`values: [deviceId], expectedChanges: 1`)         | NEW it.each: «host alone was repointed», «host row is gone» (this mutant SURVIVED the brief's tests until the extras)                                                                        |
| guard on `host_id` alone (`values: [hostId], expectedChanges: 1`)             | previous-pairing test + NEW it.each: «device id alone», «device id row is gone»                                                                                                              |
| stamp branch only for `deviceId === null`                                     | NEW test «only a matching device_id is left» (survived before it)                                                                                                                            |
| App passes `deviceId: null`                                                   | 7+ App tests (nothing syncs; the app device_id assertion)                                                                                                                                    |
| `deviceId` dropped from the `useHostLink` effect dependencies                 | NEW hook test (survived the brief's tests; the first version of my test also survived because `dispatch: vi.fn()` per render restarted the effect by itself, fixed by one stable `dispatch`) |

Not killable / argued equivalent: (1) order of `DROP_LAST_REV` and `stamp` inside the one preamble transaction: independent rows, one atomic transaction, no observable difference. (2) `if (hostId === null || deviceId === null)` reduced to `hostId === null` in the hook: the type `string | null` for `deviceId` passed to `syncReferences` no longer typechecks, and by the contract `deviceId` is `null` exactly when `hostId` is. (3) The `last_rev` drop in the very-first-sync case (no `last_rev` present): a no-op delete, observable only through the batch length `[2, 30]` that the worst-case test pins (dropping `DROP_LAST_REV` gives `[1, 30]`, checked by reasoning; mutant 3 covers the older-build effect).

## Extra tests added (6; the reason for 1429 and not 1423)

In `reference-sync.test.ts`:

- `it.each` ×4 «fails a late page and rolls the whole batch back when only half the stamp still matches»: while an old run's request is in flight the stamp is changed (host alone repointed; device id alone repointed; `device_id` row gone; `host_id` row gone); the late page (rewrites `LINE_1`, adds `LINE_2`, moves `last_rev` on) must fail with `changes_mismatch` and leave every table byte-identical to the snapshot before it landed (rollback of the whole batch, the guard first).
- «stamps the pairing and starts from zero when only a matching device_id is left, keeping the copies until a page lands» (state with `device_id`, `last_rev`, `entity_set` and copies, no `host_id`).

In `app.test.tsx`: `useHostLink` «starts the link and a sync over when the pairing changes its device id under the same host» (`renderHook`, `rerender` with another device id, same host: the link is stopped and re-subscribed once, `changes` called `[[0],[0]]`, `device_id` and `last_rev` re-written). The test uses one stable `dispatch` and waits on `device_id` + `last_rev` together (`device_id` alone is stamped before the first fetch).

Adversarial scenarios checked: a state with only `host_id` (brief's test), only `device_id` (new), `device_id` with another host and `OTHER_DEVICE` (brief's «another host» tests use both different), the same host with another device id (brief's tests, both in-flight and wipe), the stamp racing the wipe (the batch order mutant; the rollback of the whole batch on a failed guard asserted by `tables(db)` snapshots), a re-pair, and the 30-statement worst case (`[2, 30]`, 8 entities, within the shell's 32).

## Self-review / concerns

- Security: no secret enters logs or errors; fixtures use test UUIDs. `pairingGuard`'s `changes_mismatch` message is the SQL text (as before).
- Concern 1: `apps/standalone/AGENTS.md` still names `hostGuard` in four places (lines 390, 580, 628, 652) — to be updated by Task 7 (documents). Line 390 already speaks of the guard being scoped to the pairing.
- Concern 2: I added one test to `app.test.tsx` that goes beyond the brief (a hook-level test); the alternative was a new file. If the controller prefers it in `host-link.test.ts`, it can move without changes.
- Concern 3: `app.test.tsx` and `reference-sync.test.ts` tests with real timing (`vi.waitFor`) passed under the delayed-`setImmediate` stand, no flakiness seen over the runs done (3 runs of each file plus the full suite once).
- Not run: cargo (no Rust change), browser/Windows/hardware.

## Fix round 1

Base b74133992 -> commit a5109dbd6 `test(standalone): чужой хост без device_id стирает копии сразу` (test-only, `apps/standalone/test/reference-sync.test.ts`, +29; no source file changed).

Finding (Important): the host clause of the immediate wipe was masked by the device clause. Added the test "wipes the copies of another host at once when an older build left no device_id, so the old host's lines stop being usable" after the same-host-wipe test: copies + `last_rev` + `host_id = OTHER_HOST` + `entity_set`, no `device_id` row; sync for `HOST_ID`/`DEVICE_ID` with an offline feed; asserts `offline` called with 0, all copy tables empty, state equals `stamp()` (device_id + host_id only), `copiesReady` false.

Mutants (reference-sync.ts restored byte-identically each time: sha256 de532bdf...63f6 before/after, `cmp` silent):

| Mutant                                                                               | Result                                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `(stored.hostId !== null && stored.hostId !== hostId) \|\|` -> `(false && ...) \|\|` | NEW test fails (1 failed, 134 passed of 135)                          |
| device clause -> `(false && stored.deviceId !== deviceId)`                           | killed: same-host-wipe test, app.test.tsx device-id change hook test  |
| `if (stored.hostId === null \|\| stored.deviceId === null)` -> `if (false)`          | killed (many tests)                                                   |
| same -> `if (stored.hostId === null)`                                                | killed: "stamps device_id beside a host_id an older build left alone" |
| same -> `if (stored.deviceId === null)`                                              | killed: "only a matching device_id is left"                           |
| host clause without the `!== null` guard                                             | killed: "only a matching device_id is left", worst-case batch test    |
| device clause without the `!== null` guard                                           | killed: "stamps device_id beside a host_id...", worst-case batch test |

No other clause survived; no further test added.

Checks: `reference-sync.test.ts` + `app.test.tsx` verbose: 135 passed, stderr empty. Whole package: 59 files / 1430 passed (1429 + 1). prettier --check, `git diff --check` clean; `\u04` grep only `src/host/pairing-code.ts:66`. Commit has exactly one Co-Authored-By (Opus 5.5); `git status --short` empty.
