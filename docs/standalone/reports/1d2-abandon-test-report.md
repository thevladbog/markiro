# 1d2: route-level test of an abandoned revoke request (report)

Status: DONE. Commit `8f8ffa7bc` on `claude/autonomous-desktop-station-9e6f13`:
`test(standalone): отзыв устройства, оборванный после коммита, всё равно будит потоки`
(trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, exactly one, verified with
`git log -1 --format=%B`).

## What was added

Test-only, two files:

- `apps/standalone/host/tests/commit.rs` (+230 lines, the three existing tests are byte-identical)
  - `hang_up_after_commit(handler, committed) -> bool`: the driver. It polls the handler future by
    hand with its own `Waker` (a `Notify` permit), only when that waker has fired. After every wake it
    asks `committed()` (a fresh pool read) BEFORE the next poll; on `true` it drops the handler and
    returns `true`. A wake that let the handler finish first returns `false` (nothing abandoned); a
    handler that failed panics with its error.
  - `office_context(&Admin)`: the `OfficeContext` is built by the router's own extractor
    (`OfficeContext::from_request_parts` on the admin's device key + session token), not by a struct
    literal, so it is exactly what a request would get.
  - `is_revoked` (`devices.revoked_at IS NOT NULL`) and `is_deactivated` (`operators.active = 0`), read
    through `state.pool`.
  - `a_revocation_abandoned_after_its_commit_still_wakes_the_streams`: 20 rounds, each a fresh station
    device. It calls `markiro_host::routes::devices::revoke_device(State, OfficeContext, ApiPath)`
    directly, subscribes to `state.revocations` first, abandons the handler right after COMMIT, then
    requires `revocations.changed()` within 5 s and the counter to equal `round + 1` (one wake-up per
    revocation). After the rounds: at least one round abandoned, and the `device.revoke` audit trail
    equals the exact rows (actor, action, target, result, details) for every device.
  - `a_deactivation_abandoned_after_its_commit_still_wakes_the_stations` (the optional second test,
    `commit_with_revision` through `update_operator`, `active: false`): 20 rounds, each a fresh
    operator. It requires `revisions.changed()` within 5 s, the watch value to equal the host revision
    (creation revision + 1), at least one abandoned round, and finally the exact tombstones and the
    exact `operator.update` audit rows.
- `apps/standalone/host/tests/support/app.rs` (+24 lines): `pub const PIN_4821` and
  `pub async fn add_operator(admin, login) -> (id, rev)`. `tests/badges.rs::operator` already does the
  same thing, so a local copy in `commit.rs` would have been the second copy that AGENTS.md says to put
  in the shared support instead. The older local copies (`badges.rs`, `operators.rs`, `changes.rs`,
  `no_secrets_in_logs.rs`) are untouched; moving them is a separate cleanup.

## Production visibility change

None. `revoke_device`, `update_operator`, `OfficeContext` (pub fields and pub extractor), `ApiPath`,
`ApiJson` and `AppState::revocations` were already `pub`. `git diff` of `host/src` is empty.

## Why the drop lands in the window, deterministically

sqlx-sqlite 0.8.6's `Transaction::commit` sends `Command::Commit` to the connection's worker thread and
waits on an acked channel; the worker executes `COMMIT` first and only then `blocking_send`s the
result, which is what wakes the awaiting future (`sqlx-sqlite/src/connection/worker.rs`). So the wake
that reports the COMMIT arrives after the row is visible to other WAL connections, and a read that
starts after that wake sees `revoked_at` set. The driver reads before it polls, so the handler is
dropped without ever learning that its commit returned. In the sequential shape that loses
`send_modify`; in `commit_and_notify` the notification runs in the spawned task, which the drop does
not cancel.

## Mutation checks (final test code; outputs are the relevant lines of `cargo test ... --test commit`)

All three were applied with an exact-match script, tested, and restored by `cp` from a backup taken
before any change; each restore was checked with `cmp` and `git diff --exit-code -- src`. Checksums
before and after are identical: `db.rs 6e9254e3...c16f4`, `devices.rs c9b95e43...3317ff5`,
`operators.rs f7dfd6c6...bc32b9`.

M1. `revoke_device`: `tx.commit().await?; state.revocations.send_modify(..)` in the handler's own
future (the old sequential shape):

    test a_revocation_abandoned_after_its_commit_still_wakes_the_streams ... FAILED
    round 0: the revocation committed, but its wake-up was lost
    test result: FAILED. 4 passed; 1 failed; ... finished in 5.10s

Repeated on the final binary: failed 10 of 10 runs, 10 of 10 in round 0. Every other test in the
binary stayed green, so before this commit nothing pinned that call.

M2. `update_operator`: `tx.commit().await?; state.revisions.send_if_modified(..)` (the old
`commit_with_revision` body inlined):

    test a_deactivation_abandoned_after_its_commit_still_wakes_the_stations ... FAILED
    round 0: the deactivation committed, but its wake-up was lost
    test result: FAILED. 4 passed; 1 failed; ...

Repeated on the final binary: failed 10 of 10, 10 of 10 in round 0. Only the new operator test fails.

M3 (extra). `commit_and_notify` without `tokio::spawn` (commit, then notify, in the caller's future):

    FAILED: a_panic_after_the_commit_is_reported_without_its_message,
            a_commit_abandoned_in_flight_still_lands_and_still_wakes_the_streams,
            a_deactivation_abandoned_after_its_commit_still_wakes_the_stations (round 0),
            a_revocation_abandoned_after_its_commit_still_wakes_the_streams (round 0)
    test result: FAILED. 1 passed; 4 failed

So the new route-level tests also catch the helper losing its atomicity.

A mutant can never pass: an abandoned round fails at its own `changed()` assertion, and if no round
is abandoned the `abandoned > 0` assertion fails.

## Robustness on the real code (the driver must not flake on CI, which runs these on ubuntu and windows)

An earlier version of the driver panicked if a handler finished before it could be dropped. That never
happened, but a stale wake could in theory cause it, so the final driver tolerates it (see above) and
each test requires `abandoned > 0`.

On the earlier, strict driver version (before it was made tolerant):

- 200 runs of each new test unloaded (4000 rounds each): 0 failures.
- 150 runs of each under CPU contention (24 busy processes on 12 cores): 0 failures.

On the tolerant driver (the committed one):

- Instrumented copy (print removed afterwards, file restored and its checksum verified), 100 runs of
  both tests under contention: 200 of 200 measurements printed `ABANDONED 20/20`, 0 failures. Every
  round exercises the window; the tolerant path was never taken.
- Final binary after the last edit (helper moved to the shared support): 60 runs of both tests
  (2400 rounds), 0 failures.

## Commands and results

- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test commit --offline`
  (in the sandbox; the binary binds no sockets): 5 passed (3 existing + 2 new).
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` inside the sandbox:
  failed with `cannot listen on 127.0.0.1:0: Operation not permitted (os error 1)` in
  `changes_stream::open_streams_end_when_the_host_stops` (sandbox, not code).
- Same command outside the sandbox: exit 0, 36 suites, 335 passed (baseline 333 + 2), 0 failed,
  0 ignored, 0 warning lines. Raw log:
  `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8/.superpowers/sdd/1d2-abandon-test-workspace.log`
  (test names and results only). Ran on the final tree, after the last source edit.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: exit 0.
- `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`:
  exit 0, 0 warnings (raw output counted, not the summarised one).
- `git diff --check` and `git diff --cached --check`: clean.
- `cargo clippy -p markiro-host --tests --offline`: one pre-existing `type_complexity` warning in
  `tests/support/app.rs` (`audit_trail`); nothing from the new code.
- No `git stash`, no `pnpm install`, nothing under `apps/station`; explicit paths staged.
- `graphify update .` was not run: there is no `graphify-out/` in this worktree.

## Notes and concerns

- Process cleanup: my first CPU-contention run started 24 `yes` burners and tried to stop them with
  `kill $pids`. zsh does not word-split an unquoted variable, so that failed silently and the burners
  survived as orphans (PPID 1, identical start time, exactly 24). I noticed from the load average,
  listed and killed exactly those 24 PIDs from outside the sandbox (the sandbox blocks `ps`/`kill` on
  the process list), and confirmed 0 `yes` processes remained. Later contention runs used
  self-terminating burners (a hard deadline inside each process). Nothing else was touched.
- The tests rely on sqlx-sqlite acking a commit only after `COMMIT` has executed (verified in 0.8.6).
  If a future sqlx acked earlier, rounds would finish first, `abandoned > 0` would fail on the real
  code: loud, not silent.
- Not covered on purpose: the already-revoked branch of `revoke_device` (it bumps without an `.await`
  after the decision, so a drop cannot separate anything), and a wake-up sent BEFORE the commit
  (a different bug from the one this pins).
- The older duplicate copies of `PIN_4821` / the operator helper in other test files remain.
