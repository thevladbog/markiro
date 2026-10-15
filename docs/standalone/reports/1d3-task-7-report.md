# Task 7 of plan 1d3 — the station adopts the line the office assigns (`device_refresh`): report

Status: DONE. Every step of the brief was applied in its order; all 45 «фрагмент → заменить на» anchors matched exactly once; no deviation from the brief.

Commit: `59b5c29c4 feat(standalone): станция подхватывает линию, назначенную в офисе` — 13 paths, exactly the brief's list. The trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once (`git log -1 --format=%B | grep -c '^Co-Authored-By:'` = 1; no other trailer). Nothing pushed, no branch created, no stash. The tree is clean after the commit (`git diff HEAD --quiet`, nothing staged, nothing untracked).

## What I implemented

The brief's code was applied by script, never retyped: `$TMPDIR/t7/apply-brief.mjs` parses the brief, matches each anchor as a block of whole lines (an empty first or last line of a fence is a real line), demands exactly one match in the file as it stands at that point, and replaces it. A dry run over all 45 items in sequence came first (0 mismatches); then the items were applied per step: Step 1 (tests), RED, Steps 3 and 4 (implementation), GREEN, Step 6 (docs).

Rust, `apps/standalone/src-tauri/src`:

- `device.rs`: `DEVICE_ROUTE` (`/v1/device`); `DeviceState::refresh()` — `pairing` lock, `paired()`, `GET /v1/device` with the device key, `200` continues, `401` is `KeyRejected`, any other status `RequestFailed`, a transport failure is `DeviceError::Request(..)` (so `unreachable` for a host that is away) and changes nothing; `keep_line(&self, &PairedDevice, Option<Value>)` is the old tail of `select_line`, now shared by `select_line` and `refresh`: it parses `DeviceInfo`, returns at once without any write when the line is the one already kept, otherwise writes `device.json` first and then the pairing in memory. Doc comments updated as in the brief.
- `lib.rs`: the `device_refresh` command (no arguments, answer `DeviceStatus`, rejection = `DeviceError::code()`), registered in `invoke_handler` after `device_select_line`.

Webview, `apps/standalone/src`:

- `host/device.ts`: `DeviceApi.refresh: () => Promise<DeviceStatus>` — a function-typed property, so `useHostLink` can take it unbound; `refresh: async () => parseStatus(await run("device_refresh", {}))`.
- `app/shell.ts`: `ShellAction` `device_refreshed`; reducer case that replaces `device.status` only for the same pairing (`deviceId` and `hostId`) and only when `lineId` differs, otherwise returns the same state object; exported `deviceRejection(error)` (`key_rejected` → `key_rejected`, `certificate_mismatch` → `host_changed`, anything else `null`); `shell.ts` now imports `DeviceError` as a value.
- `app/host-link.ts`: `HostLinkOptions.refresh`; a second `createSyncScheduler` («refresher») calls `refresh()` once at a time and dispatches `device_refreshed`; a rejection (`deviceRejection`) stops both schedulers and dispatches `device_rejected`, any other error is swallowed (the next event tries again). It is triggered after the first sync start (in the `watch` success branch and in its failure branch) and on every revision event, and stopped with the sync scheduler on cleanup and when a sync finds `other_host` or a rejection. `refresh` is in the effect's dependency list.
- `app/App.tsx`: passes `refresh: deviceApi.refresh`; `selectLine` now uses `deviceRejection` instead of its two hand-written branches.

Docs: `apps/standalone/AGENTS.md` (six fragments: «Local database» and «Reference sync» now say plan 1d4, «Network and TLS», «Device key and office session», «App shell» twice) and `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (four fragments: §4.4/§4.5 feed note, the §4.5 device-update bullet, the new §5.1 paragraph, §5.2 command list with `device_refresh()` and 1d4).

Tests added: `src-tauri/tests/line.rs` 8 (adopts and keeps across restarts; same line writes nothing incl. Unix inode; line cleared; host away; key unknown; no pairing; forget during the read; refresh and select at the same moment), `src-tauri/tests/ipc.rs` 2 (`device_refresh` shapes; unpaired = `not_paired`), Vitest 10 (`device.test.ts` 2, `shell.test.ts` 3, `app.test.tsx` 5).

## What I tested and the results

Automated, in the order of the brief's last step (Vitest, typecheck, lint, build and prettier inside the sandbox; host-backed cargo outside it):

- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`: 32 files, 625 tests passed (baseline 615, +10; 625 is the true expectation as you said). Run again on the committed tree: same.
- The three changed files: 124 passed (29 + 38 + 57).
- `typecheck`, `lint`, `build`: exit 0 (the >500 kB chunk warning of `build` is the existing one).
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox): 36 suites, 345 passed, 0 failed, 0 ignored (baseline 335: +8 `line`, +2 `ipc`), no compiler warning in the log. `--test line`: 13, `--test ipc`: 11.
- `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`: exit 0, 0 warnings.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: exit 0, empty output.
- `node_modules/.bin/prettier --check` on the 9 changed TS/TSX/MD files: all use Prettier code style. `git diff HEAD --check`, `--cached --check`: clean.
- `grep -rnF '\u04' apps/standalone/src apps/standalone/test …` (and the two docs, `src-tauri`): only the known `src/host/pairing-code.ts:66`. The commit message file was checked byte by byte (real UTF-8).
- `graphify update .` not run: there is no `graphify-out/graph.json` in this worktree.

Verbose run of the changed files: `vitest run --reporter=verbose test/device.test.ts test/shell.test.ts test/app.test.tsx` with stdout and stderr redirected apart: 124 passed, stderr 0 bytes, no `stderr |` block in stdout, no `act(...)` warning. The full run (`pnpm … test`) has no `stderr |`/`stdout |` blocks either.

Effect-race stand (recipe from the memory note «Vitest effect race harness», found and used as written): a temporary setup file inside the Vite root that replaces `globalThis.setImmediate` with `realSetTimeout(cb, 3)` (real timeout captured at load), and a temporary `vitest.scratch.config.ts` with `setupFiles: [scratch, "test/setup.ts"]`. I proved the stand engages with a throw-away test (`setImmediate` takes >= 2.5 ms under the stand config, 0.097 ms without it; `app.test.tsx` test time 3.26 s against 2.41 s). Results at 3 ms:

- `test/app.test.tsx`: 57/57, three runs in a row;
- the new `describe("the line the office assigns")` alone: 5/5, ten runs in the stand and ten in the normal config, all green;
- the whole suite: 32 files / 625 tests green.
  None of the brief's tests is racy; I added no sleeps and changed no test. All three scratch files were deleted (`git status` clean, no untracked files).

## TDD evidence

RED (after Step 1 only, implementation untouched):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/device.test.ts test/shell.test.ts test/app.test.tsx
    Test Files  3 failed (3)
         Tests  10 failed | 114 passed (124)

- `device.test.ts` (2 of 29): `TypeError: refresh is not a function`, `TypeError: createTauriDeviceApi(...).refresh is not a function`.
- `shell.test.ts` (3 of 38): `TypeError: deviceRejection is not a function`, `TypeError: Cannot read properties of undefined (reading 'device')`, `AssertionError: expected undefined to be { …(8) }` (the reducer does not know `device_refreshed`).
- `app.test.tsx` (5 of 57): three times `expected "vi.fn()" to be called 1 times, but got 0 times` (nobody calls `refresh`), and for the two rejection rows `Unable to find an element with the text: Хост не принимает это устройство`.
- Rust: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --offline --no-run` (after `pnpm … turbo run build --filter='@markiro/standalone...'`): `error[E0599]: no method named `refresh`found for struct`DeviceState` in the current scope` (plus the E0282 it causes for `tokio::join!`); rustc ends with `could not compile `markiro-standalone` (test "line") due to 18 previous errors`, exit 101.
- Rust, in the sandbox: `cargo test … -p markiro-standalone --test ipc --offline an_unpaired_device_has_nothing_to_refresh`: `left: Err(String("Command device_refresh not found"))`, `right: Err(String("not_paired"))`.
  All expected, for the reason the brief gives.

GREEN (after Steps 3 and 4):

    same vitest command                      -> Test Files 3 passed (3), Tests 124 passed (124)
    (also with --reporter=verbose            -> 124 passed, stderr empty)
    pnpm … turbo run build --filter='@markiro/standalone...', then, outside the sandbox:
    cargo test … -p markiro-standalone --test line --test ipc --offline
                                             -> ipc: 11 passed; line: 13 passed

Run inside the sandbox first, `--test ipc` fails in exactly the four tests that start a host: `cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)`; `an_unpaired_device_has_nothing_to_refresh` passes there, as the brief says. (The user can allow local binding with `sandbox.network.allowLocalBinding: true` instead of leaving the sandbox.)

## Mutation checks

Baseline for the literal «git diff shows nothing» check: `device.rs` was staged before the mutations (the implementation was not committed yet), a copy was taken (`sha256 52e63799bf9e21423ed883e4ebf29351344eac9a3890dd703e38f1e1f6bd2180`), and each mutation was undone by copying it back.

(a) The `pairing` lock removed from `refresh` only (`let _pairing = self.pairing.lock().await;` deleted):

    cargo test … -p markiro-standalone --test line --offline      (outside the sandbox)
    test a_refresh_does_not_bring_back_a_forgotten_pairing ... FAILED
    panicked at src-tauri/tests/line.rs:332:5:
    assertion `left == right` failed
      left: Ok(Some(DeviceStatus { … }))
     right: Ok(None)
    test result: FAILED. 12 passed; 1 failed

The answer of the host arrived after the forget and put the pairing (and `device.json`) back. `a_refresh_and_a_line_choice_never_undo_each_other` PASSED without the lock, as the brief says it may (probabilistic). Reverted: `cmp` with the pre-mutation copy silent, `sha256` `52e63799…6bd2180` again, `git diff --quiet -- device.rs` exit 0 (worktree equals the staged baseline).

(b) `refresh` rewrites `device.json` even when the line is unchanged (the `if info.line_id == device.config.line_id { return Ok(device.status()); }` early return removed from `keep_line`):

    test a_refresh_that_finds_the_same_line_writes_nothing ... FAILED
    panicked at src-tauri/tests/line.rs:236:5:       (the inode assertion; the content assertion above it passed)
    assertion `left == right` failed
      left: 278256393
     right: 278256389
    test result: FAILED. 12 passed; 1 failed

Reverted the same way: `cmp` silent, same `sha256`, `git diff --quiet -- device.rs` exit 0.

Extra mutations on the webview, run on the committed tree (each reverted from a backup; `git diff --quiet -- <file>` was exit 0 every time, and the tree is clean now):

- no `refresher.trigger()` on a revision event: 3 `app.test.tsx` tests fail (office clears/sets a line, one read per event, host unreachable);
- reducer without the «same line changes nothing» clause: `shell.test.ts` «keeps the state for a refresh that changes nothing or belongs to another pairing» fails;
- reducer without the `deviceId`/`hostId` guard: the same test fails;
- reads without single-flight (a plain function instead of `createSyncScheduler`): «reads the device once after the first sync and once per revision, one read at a time» fails;
- `deviceRejection` mapping `certificate_mismatch` to the wrong reason: 3 tests fail (its own test, the new certificate row, and the existing `selectLine` certificate test, which shows `App` really uses the shared helper);
- a refresh rejection ignored in `host-link.ts`: both rejection rows of the new `it.each` fail.

## Files changed (13, all from the brief's list)

- `apps/standalone/src-tauri/src/device.rs`, `apps/standalone/src-tauri/src/lib.rs`
- `apps/standalone/src-tauri/tests/line.rs`, `apps/standalone/src-tauri/tests/ipc.rs`
- `apps/standalone/src/host/device.ts`, `apps/standalone/src/app/shell.ts`, `apps/standalone/src/app/host-link.ts`, `apps/standalone/src/app/App.tsx`
- `apps/standalone/test/device.test.ts`, `apps/standalone/test/shell.test.ts`, `apps/standalone/test/app.test.tsx`
- `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

`git diff HEAD~1 --stat`: 682 insertions, 43 deletions. Nothing under `apps/station`, `apps/standalone/proto`, `apps/standalone/host`; no `Cargo.toml`, `package.json` or lockfile change; `src-tauri` only the four listed files (there is no app manifest or capability that lists commands — `build.rs` is plain `tauri_build::build()` — so `device_refresh` needs no other registration).

## Self-review findings

- Completeness: every step and fragment of the brief applied and checked; `device_refresh` is in the command definition and in `invoke_handler`; both docs updated; `keep_line` is really shared (`select_line` and `refresh` both end in `self.keep_line(&device, response.body)`).
- Quality and discipline: nothing beyond the brief; no file grew past the brief's intent (`host-link.ts` 187 → 220 lines, `device.rs` 658 → 708), so nothing to split.
- Testing: the tests assert behaviour (memory, `device.json` after a restart, inode, what the shell state is, how many reads run); every one I mutated fails for the intended reason; output is pristine.
- Checked against the host: `GET /v1/device` (`routes/devices.rs::device_info`) only reads, so a refresh takes no revision and cannot set off a refresh loop; the stream's first event after every reconnect makes the station read its record again, which covers a line assigned while the station was away.

## Concerns and observations (none blocks the task)

1. `select_line` changed slightly as a consequence of the shared tail: when the host confirms the line the station already keeps, `device.json` is no longer rewritten (it always was). The brief asks for exactly this («device.json is written only when the line differs»); all existing tests pass.
2. `refresh` holds the `pairing` lock across the network read (connect 2 s, request 10 s). While the host hangs, a `select_line` or `device_forget` started meanwhile waits behind it. This is the brief's design (the same lock as `select_line`, needed for the forget guarantee), and a host that is simply away fails fast at the 2 s connect.
3. `a_refresh_and_a_line_choice_never_undo_each_other` is probabilistic: mutation (a) shows it passes without the lock. The deterministic guards are the forget test (a) and the inode test (b), as the brief says.
4. The brief's replacement in AGENTS.md «App shell» (last fragment) leaves one line of about 98 characters between shorter ones; Prettier's markdown `proseWrap: preserve` accepts it and I kept the text verbatim.
5. Still «plan 1d3» in comments about operators and badges: `src-tauri/src/local_db.rs:220`, `src/local/reference-sync.ts:59` and `:299`, `test/reference-sync.test.ts:1131`. The brief's «Перенесено» section moves them to plan 1d4 together with the operators' work; I did not touch them.
6. Process notes: `$TMPDIR` differs outside the sandbox — my first attempt at mutation (b) ran the Node script from `$TMPDIR` in an unsandboxed command and failed with `MODULE_NOT_FOUND` before touching anything (`device.rs` verified untouched by `sha256`); I then applied the mutation in the sandbox and ran only cargo outside it. A stray recursive `grep -rn` over `apps/standalone` that also walked `target/` hit the 120 s limit and was moved to the background; I stopped it with TaskStop (read-only, no side effects). The rtk hook compresses `git diff` output; I used `rtk proxy git diff` where the full text mattered.

## Not verified, and why

- A real Tauri window (`tauri dev`), the webview reacting to a real assignment: not run here.
- Two PCs on a real network: a line assigned and cleared in the office and seen on a second station (floor <-> line choice), a station on an archived line, a revoked station with an open stream: not run; only the automated layers above.
- Windows: `a_refresh_that_finds_the_same_line_writes_nothing` checks only the content of `device.json` there (the inode assertion is `#[cfg(unix)]`); the `standalone-windows-build` job needs a push and was not run. A host-only Cargo run proves nothing about DPAPI or the Windows service.
- The «read and select line at the same moment» race is caught only probabilistically (see 3).
- `cargo clippy` is not part of the repository's standalone CI and was not run.

## Fix round 1

Status: DONE. Everything of `.superpowers/sdd/1d3-task-7-fix-1-brief.md` is done, plus one extra test (see «Beyond the brief»).

Commit: `0d7e67f21 fix(standalone): ревью задачи 7 плана 1d3 — сбой чтения устройства повторяется, тесты гонки и порядка блокировки`, one commit on top of `59b5c29c4`, 9 paths (the files the brief names, nothing else). The trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once (`git log -1 --format=%B`: 1 `Co-Authored-By:` line, no other). Nothing pushed, no stash, no `pnpm install`, nothing under `apps/station`, `proto`, `host`, no dependency change (`git diff HEAD~1 --name-only` filtered on those paths and on `Cargo.toml`/`package.json`/lockfiles: 0). `device.rs` is untouched (sha256 still `52e63799…6bd2180`). The tree is clean.

### What changed, per item

A. `apps/standalone/src/app/host-link.ts` — a failed read of the device is retried with the sync's own waits:

- new state next to the sync's: `refreshFailures`, `refreshRetry`, `cancelRefreshRetry()`;
- the refresher's run starts with `cancelRefreshRetry()` (any read replaces the pending retry); a success sets `refreshFailures = 0` and dispatches `device_refreshed` as before; in the `catch`: a rejection (`deviceRejection`) stops both schedulers, calls `cancelRetry()` and `cancelRefreshRetry()`, dispatches `device_rejected` and returns; a `DeviceError` with code `not_paired` returns without a retry; anything else does `refreshFailures += 1` and, `if (online)`, arms `refreshRetry = setTimeout(() => { refreshRetry = null; refresher.trigger(); }, nextSyncRetryMs(refreshFailures))`;
- `onStatus` is restructured into an early-return: a link that is not online cancels both retries; an online link keeps the sync's branch exactly as it was (`failures > 0 && !running && retry === null`) and adds `if (refreshFailures > 0 && refreshRetry === null) refresher.trigger()`;
- `syncNow.current` triggers both schedulers (the line-selection screen's «Повторить» — `requestSync` — now reads the device as well as syncing); the cleanup resets it to a no-op and calls `cancelRefreshRetry()`;
- the doc comment of `useHostLink` says a failed read is retried like a failed sync and that the returned function asks for a sync and a read; `DeviceError` is now imported as a value.
- Docs: `apps/standalone/AGENTS.md` («App shell») no longer says a failed read «keeps the station on its line» and stops there: it says any other failure keeps the line (offline first) and the read is tried again like a failed sync, with a failure count of its own, never for `not_paired`, that reads follow the same rules, and that the line-selection screen's «Повторить» asks for a sync and a read together. The spec §5.1 paragraph says the same in Russian (same waits 2, 4, 8, 16, 32 s then 60 s while the link is online, a lost link drops the retry, the link coming back and «Повторить» read at once, no pairing means no retry, a rejection or a certificate change goes to the rejection screen). Nowhere is a failed read called silent.

B. `apps/standalone/src-tauri/tests/line.rs`:

- `a_refresh_and_a_line_choice_never_undo_each_other` now uses `(assigned, chosen) = (&second, &first)` in every round (bound once before the loop), all assertions kept, doc comment rewritten (why the station's own line must differ from the office's line);
- new `a_refresh_queued_behind_a_forget_finds_no_pairing`: `tokio::join!(station.select_line(&line), station.forget(), station.refresh())` (the comment says both that the first poll of `join!` goes through the futures in the order given and that tokio's mutex is first come, first served — checked in tokio 1.53.1: `sync/mutex.rs` «guaranteed FIFO basis», and `macros/join.rs`, whose rotator starts at 0); asserts `selected` is the chosen line, `forget` is `Ok`, `refresh` is `Err(DeviceError::NotPaired)`, `station.status() == Ok(None)` and no `device.json`.

C. Comments and wording, no behaviour: «plan 1d3» became «plan 1d4» for the operators/badges copies in `src-tauri/src/local_db.rs` (`clear_copies` doc), `src/local/reference-sync.ts` (the two places) and `test/reference-sync.test.ts`; the legitimate 1d3 mentions (`device.rs`, `shell.ts`, the spec's counterparties, lines, devices and line-assignment lines) stay. `lib.rs` (`device_refresh` doc) and the spec §5.1 no longer say «after the first sync»: «at the same moments as the reference sync (once the link's `watch` has subscribed or failed, and after every revision event)» / «в те же моменты, что и синхронизация справочников».

Also in `test/app.test.tsx`: the two fake-timer helpers (`fakeRetryTimers`, `elapse`) moved from the «reference sync retries» describe to module scope so both retry describes share them (no behaviour change); the Task 7 describe restores real timers in an `afterEach`.

### Tests and exact totals

- Vitest: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`: 32 files, 631 tests passed (625 before; +5 for the brief's five new webview tests, +1 extra test, and the sixth item changes an existing test). `app.test.tsx`: 57 -> 63. `typecheck`, `lint`, `build`: exit 0. `node_modules/.bin/prettier --check` on the 6 changed TS/MD files: clean. `git diff HEAD --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`.
- Cargo (outside the sandbox, `--offline`, logs under `/tmp/claude/1d3t7/`): `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`: 36 suites, 346 passed, 0 failed, 0 ignored (345 before, +1 the lock-order guard), no warning in the log; `--test line`: 14, `--test ipc`: 11 (re-run on the committed tree too). `cargo check … --workspace --all-targets --offline`: exit 0, 0 warnings. `cargo fmt … --all -- --check`: exit 0. (rustfmt reformatted my first version of the `join!` call; the committed file is rustfmt-clean.)
- `app.test.tsx` with `--reporter=verbose`, stdout and stderr redirected apart: 63 passed, stderr 0 bytes, no `stderr |` block, no `act(...)` warning.
- 3 ms delayed-`setImmediate` stand (the recipe of the memory note, scratch setup and config files deleted afterwards): `app.test.tsx` 63/63 three runs in a row, stderr empty; the whole suite 32 files / 631 green; the Task 7 describe (11 tests) ten runs in the stand and ten in the normal config, all green. Measured before the extra test was added: the describe (10 tests then) also passed 4/4 while three full suites ran in parallel. The fake-timer tests use the same `shouldAdvanceTime` recipe and margins as the existing sync-retry tests; I added no sleeps.

### TDD evidence

RED, the six webview tests written first, implementation untouched (HEAD `59b5c29c4`):

    pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx
    Tests  3 failed | 59 passed (62)
    FAIL … > retries a failed read of the device after the sync's wait while the link is online
        AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times          (no retry)
    FAIL … > drops the retry while the link is down and reads at once when it is back
        AssertionError: expected +0 to be 1 // Object.is equality                          (`vi.getTimerCount()`: no retry armed)
    FAIL … > reads the device again on «sync now»
        AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times          (the request only synced)

`does not retry when there is no pairing`, `reads the device once when watch fails` and the tightened exact-count check pass on the old code by design (they guard behaviour the old code has by accident of having no retry, or already had); their teeth are shown by mutations (v) and (iv) below. The two Rust changes pass on the current Rust code by design too (`--test line`: 14 passed); their teeth are the mutations below.

GREEN after the implementation: the same command, `Tests 63 passed (63)` (with the extra test).

### Mutation checks

`host-link.ts`, `device.rs` and the test files were staged before the mutations, each mutation was undone from a copy, and `git diff --quiet -- <file>` (worktree against the staged baseline) was exit 0 after every one; the sha256 of `host-link.ts` before and after all of them is `2bbee817ee7a7c110785166424023841d62ac60003a49907be3128931ff2845e`.

Webview (`vitest run test/app.test.tsx`):

- (i) the retry scheduling deleted from the `catch`: 2 fail — `retries a failed read of the device after the sync's wait…` (`expected "vi.fn()" to be called 2 times, but got 1 times`) and `drops the retry while the link is down…` (`expected +0 to be 1`).
- (ii) `cancelRefreshRetry()` dropped from the offline branch: 1 fails — `drops the retry while the link is down and reads at once when it is back` (`expected 1 to be +0`: the timer survived the offline status).
- (iii) the second trigger dropped from `syncNow`: 1 fails — `reads the device again on «sync now»` (`expected "vi.fn()" to be called 2 times, but got 1 times`).
- (iv) the `refresher.trigger()` deleted from the failed-`watch` branch: 1 fails — `reads the device once when watch fails` (`expected "vi.fn()" to be called 1 times, but got 0 times`).
- extra (v) the `not_paired` early return removed: 1 fails — `does not retry when there is no pairing` (`expected 1 to be +0`).
- extra (vi) `nextSyncRetryMs(refreshFailures)` replaced by `nextSyncRetryMs(1)`, and (vii) `refreshFailures = 0` removed on success: both SURVIVED the brief's six tests (62/62 green); the extra test below kills both (vi: `expected "vi.fn()" to be called 2 times, but got 3 times`; vii: `expected "vi.fn()" to be called 5 times, but got 4 times`).

Rust (`cargo test … --test line --offline`, outside the sandbox):

- B1, the lock removed from `refresh` (`let _pairing = self.pairing.lock().await;` deleted): the strengthened `a_refresh_and_a_line_choice_never_undo_each_other` FAILS in 10 of 10 runs, every time at `line.rs:391` in `round 1` — `assertion left == right failed: round 1`, `left: Some(<second line id>)`, `right: Some(<first line id>)`: the stale answer of the read put the office's line over the station's choice in memory. With the lock in place it passes 10 of 10. For comparison, the OLD version of the test (round 0 only, restored from `HEAD~1` for the run) PASSED 10 of 10 without the lock — it never saw the race, as the review said.
- B2, the lock and the read swapped in `refresh` (`let device = self.paired()?;` before `let _pairing = self.pairing.lock().await;`): `a_refresh_queued_behind_a_forget_finds_no_pairing` FAILS (`line.rs:362:5`, `left: Ok(DeviceStatus { … })`, `right: Err(NotPaired)`: the refresh, holding the pairing it read before waiting, asked the host with the forgotten key and brought the pairing back), 5 of 5 runs; the other 13 tests of the file PASS with the swap, including the older forget test and the race test — which is why the guard was needed. Reverted: `cmp` with the pre-mutation copy silent, sha256 `52e63799bf9e21423ed883e4ebf29351344eac9a3890dd703e38f1e1f6bd2180` again, `git diff --quiet -- device.rs` exit 0.

### Beyond the brief

One extra webview test, `waits longer after each failed read in a row, and starts over after a read succeeds` (three failures and successes with 2 s, 4 s and a reset), because mutations (vi) and (vii) survived the six the brief lists: without it nothing pinned that the read's waits grow like the sync's or that the count starts over. It is the only addition; drop it if you want exactly six (the Vitest total would then be 630).

### Concerns and observations

1. The button on the line-selection screen is «Повторить» (`shell.lineSelect.retry`, `requestSync`), not «Синхронизировать»; the test title keeps the brief's «sync now», the docs say «Повторить».
2. The refresher has no `running` guard like the sync's `failures > 0 && !running && retry === null` (the brief's condition is `refreshFailures > 0 && refreshRetry === null`): an `online` status that arrives while a read is in flight asks for at most one more read afterwards. Bounded, and `online` is published once per (re)connect.
3. A device rejection found by the sync's own `catch` (or a link status) stops the schedulers but does not cancel a pending `refreshRetry` timer itself; the timer would fire a no-op (`refresher` is stopped) and the effect cleanup, which runs right after the re-render with `hostId: null`, cancels it. Same as the sync's own retry today; nothing to fix.
4. Not verified, as before: a real Tauri window, two real PCs (a retry after a real 5xx or timeout, the link dropping and coming back), the Windows CI job. The retry is proven with fake timers and fake connections only.
