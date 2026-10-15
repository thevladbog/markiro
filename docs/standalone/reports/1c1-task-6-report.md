# Plan 1c1, Task 6 — report

SSE change stream `GET /v1/changes/stream`, `db::commit_with_revision`, and
ending open streams when the host stops.

## What was implemented

1. **Dependency.** `apps/standalone/host/Cargo.toml`: added
   `futures-util = "=0.3.34"` in `[dependencies]` after `base64` (used for
   `futures_util::stream::unfold` in the stream handler).

2. **`db::commit_with_revision`** (`host/src/db.rs`): commits a write
   transaction, then wakes change-stream subscribers via
   `watch::Sender::send_if_modified`, only if the given revision is newer than
   the last-announced one. Notifying strictly after the commit is the point:
   a subscriber that reacts immediately already reads the committed rows.

3. **`AppState` additions** (`host/src/server.rs`):
   - `revisions: Arc<watch::Sender<i64>>` — newest committed revision, seeded
     at 0 in `AppState::new`.
   - `stopping: Arc<watch::Sender<bool>>` — flips to `true` once, ending open
     streams.
   - `stream_heartbeat: Duration` — SSE keep-alive interval, 15 s by default.
   - `AppState::with_stream_heartbeat(Duration)` builder (tests shorten it).
   - Route `GET /v1/changes/stream` registered in `protected_routes()`
     next to `GET /v1/changes`.

4. **Writers now commit through `commit_with_revision`** instead of a plain
   `tx.commit()`, in every transaction that calls `next_revision`:
   `routes/bootstrap.rs` (`bootstrap`), `routes/org.rs` (`put_org`),
   `routes/sscc.rs` (`put_counter`, `put_block_sizes`),
   `routes/office_users.rs` (`create_user`, `update_user`, and
   `replace_password`, whose signature changed to
   `Result<i64, ApiError>` so its two callers can pass the new revision
   through), `routes/office_users.rs::set_password` and
   `routes/office_auth.rs::change_password` (both now bind
   `let rev = replace_password(...).await?;` first).
   Verified after the edits: `grep -n "tx.commit()"` across those five files
   now only matches login, logout and denied/audit-only paths (none of which
   call `next_revision`) — see the RED/GREEN section.

5. **Stream handler** (`host/src/routes/changes.rs::stream`): subscribes to
   both `revisions` and `stopping` _before_ reading the current revision (so
   a commit racing the initial read still surfaces as one more event, never
   lost), sends the current revision as the first `rev` event, then one `rev`
   event per commit that moves the revision, ends when `stopping` becomes
   true, and rides axum's `Sse::keep_alive` for the heartbeat comment.
   `rev_event` builds `Event::default().event("rev").data(json)`.

6. **Graceful stop** (`host/src/lib.rs`): `RunningHost` now carries
   `stopping: Arc<watch::Sender<bool>>` instead of a one-shot `shutdown`
   sender; `stop()` calls `self.stopping.send_replace(true)`, which both
   unblocks `server::serve`'s graceful-shutdown future (`stopped.wait_for(...)`
   in `start()`) and ends every open change stream through the same
   subscription, so a graceful stop does not wait for an idle SSE connection.

7. **Docs**: `apps/standalone/AGENTS.md` — new bullet under "Writes" about
   `commit_with_revision`, and a new "Change feed" section describing both
   `GET /v1/changes` and `GET /v1/changes/stream`. Spec
   `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
   §4.5 table: the `/v1/changes` row now documents `hostId` in the response
   shape, the 1000-item cap, "a page never splits a revision", and "`rev` is
   the host's current revision when nothing new follows"; the
   `/v1/changes/stream` row now also documents the first event carrying the
   current revision and the stream ending when the host stops. Reformatted
   with `node_modules/.bin/prettier --write` (table pipes realigned).

## Deviation from the brief

The brief's `stream` handler code, copied verbatim, did not compile:

```
error[E0505]: cannot move out of `stopping` because it is borrowed
```

`tokio::select!` keeps every arm's future alive (as part of an internal
"whichever completes" enum) until the whole `select!` expression finishes.
One arm calls `stopping.wait_for(|s| *s)` (borrows `stopping` via `&mut`);
the _other_ arm's body tried to move `stopping` by value into the next
`unfold` state — a real conflict from the borrow checker's point of view,
even though only one arm's body ever runs.

Fix (smallest change that keeps the intent and every assertion): resolve
only the new revision (`Option<i64>`) inside `let rev = tokio::select! {
... };`, so the borrow from the losing arm's future is dropped at that
statement's end; then unwrap with a second `let rev = rev?;` and build the
`(Ok(rev_event(rev)), (None, revisions, stopping))` tuple in code _after_
both `select!` arms, once `stopping` is no longer borrowed. Behavior is
unchanged: the `changed.ok()?` short-circuit and the `stopping`-wins-ends-
the-stream case both still return `None` from the outer `unfold` closure
exactly as before. See the comment left in `changes.rs` above the `select!`.

No other deviations. Every other file matches the brief's code verbatim
(module `cargo fmt` reformatting of line wraps).

## TDD evidence

**RED** — command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline
```

output (after creating `host/tests/changes_stream.rs` from the brief, before
touching `db.rs`/`server.rs`):

```
error[E0599]: no method named `with_stream_heartbeat` found for struct `AppState` in the current scope
  --> host/tests/changes_stream.rs:92:35
   |
92 |     app.state = app.state.clone().with_stream_heartbeat(Duration::from_millis(50));
   |                                   ^^^^^^^^^^^^^^^^^^^^^ method not found in `AppState`

error[E0609]: no field `revisions` on type `AppState`
   --> host/tests/changes_stream.rs:113:32
    |
113 |     let latest = || *app.state.revisions.borrow();
    |                                ^^^^^^^^^ unknown field
    |
    = note: available fields are: `pool`, `host_id`, `clock`, `login_limiter`, `claim_limiter`, `endpoint`
```

Matches the brief's expected RED exactly.

**GREEN** — after implementing `commit_with_revision`, the `AppState`
fields/builder/route, the five writers, the `stream` handler (with the
`select!` fix above) and the `RunningHost`/`start` changes, command (run
outside the sandbox — the last test binds `127.0.0.1:0`):

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes_stream --offline
```

output:

```
cargo test: 5 passed (1 suite, 0.32s)
```

Unfiltered listing of the five tests (from the full workspace run, see
below): `the_stream_needs_a_device_key`, `open_streams_end_when_the_host_stops`,
`the_stream_sends_a_heartbeat_comment`, `the_stream_sends_the_current_revision_then_every_new_one`,
`every_revision_bump_wakes_subscribers_after_its_commit` — all `ok`.

Note on sandboxing: the first attempt (inside the default sandbox) failed
only `open_streams_end_when_the_host_stops` with
`PermissionDenied: cannot listen on 127.0.0.1:0: Operation not permitted`,
the local-port-binding restriction the constraints doc predicted; the other
four in-process tests passed inside the sandbox. Re-run outside the sandbox
gave the clean 5/5 above.

## Every verification command and its result

All run from `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

| Command                                                                                                                             | Result                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo tree --manifest-path apps/standalone/Cargo.toml -p markiro-host -i futures-util --offline`                                   | `futures-util v0.3.34`, pulled in by `axum`, `hyper-util`, `sqlx-core`, `sqlx-sqlite`, `tower`, `tower-http`, and now directly by `markiro-host`                            |
| `git diff apps/standalone/Cargo.lock` (after Step 1)                                                                                | exactly one line added: `+ "futures-util",` in the `markiro-host` dependency list, alphabetically between `base64 0.22.1` and `http-body-util`                              |
| `cargo test -p markiro-host --test changes_stream --offline` (before impl)                                                          | RED, as above                                                                                                                                                               |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --offline` (after Step 3+4, before the `select!` fix)           | 1 error (E0505), as above                                                                                                                                                   |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --offline` (after the fix)                                      | `cargo build (2 crates compiled)` — clean                                                                                                                                   |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all`                                                                        | reformatted `changes.rs`, `server.rs`, `tests/changes_stream.rs` (line wraps only)                                                                                          |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                             | clean, no output                                                                                                                                                            |
| `cargo test -p markiro-host --test changes_stream --offline` (sandboxed)                                                            | 4 passed, 1 failed (`open_streams_end_when_the_host_stops`, `EPERM` binding `127.0.0.1:0` — sandbox limit, not a code issue)                                                |
| `cargo test -p markiro-host --test changes_stream --offline` (outside sandbox)                                                      | **5 passed**                                                                                                                                                                |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside sandbox)                                     | **165 passed (26 suites)**, 0 failed; confirmed via unfiltered `rtk proxy` run — every suite's `test result: ok`, no `warning:`/`FAILED`/`error[` lines anywhere in the log |
| `cargo test -p markiro-host --offline -- --list` (via `rtk proxy`)                                                                  | **107 tests** (102 before this task + the 5 new stream tests)                                                                                                               |
| `cargo check -p markiro-host --tests --offline` (forced recompile, via `rtk proxy`)                                                 | clean, zero warnings                                                                                                                                                        |
| `git diff --check`                                                                                                                  | clean, no output                                                                                                                                                            |
| `node_modules/.bin/prettier --write apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | AGENTS.md unchanged; spec's §4.5 table pipes realigned                                                                                                                      |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | "All matched files use Prettier code style!"                                                                                                                                |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                    | clean (`tsc -p tsconfig.json --noEmit`)                                                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                         | clean (eslint, no findings)                                                                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                         | **236 passed (19 files)**                                                                                                                                                   |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                        | succeeded (`dist/` produced); pre-existing "chunk larger than 500 kB" advisory notice only, unrelated to this task (no TS/webview source touched)                           |
| `node --test tools/ci/test/affected.test.mjs`                                                                                       | **20 passed**, 0 failed                                                                                                                                                     |

This task touches only `apps/standalone/host` (an existing, already-mapped CI
source area), so `tools/ci/affected.mjs` needed no changes; the 20 existing
cases still pass unmodified.

## `Cargo.lock` diff committed

```diff
@@ -2469,6 +2469,7 @@ dependencies = [
+ "futures-util",
   "http-body-util",
   "if-addrs",
   "markiro-proto",
```

One line, in alphabetical position inside `markiro-host`'s `dependencies`
array. No new `[[package]]` block: `futures-util 0.3.34` was already present
in the lockfile as a transitive dependency of `axum`/`sqlx-core`/etc.

## Plan-final checklist — "Cargo.lock новых пакетов только if-addrs 0.15.0"

Checked across the whole plan 1c1, not just this task: `git log --oneline -- apps/standalone/Cargo.lock apps/standalone/host/Cargo.toml` shows only one plan-1c1 commit touched `Cargo.lock` before this one — `5de751fe2` (`подключение устройства по коду`, task 2), whose diff adds exactly one new `[[package]]` block, `if-addrs 0.15.0`, plus the corresponding dependency-list line in `markiro-host`. `git diff 5de751fe2 HEAD -- apps/standalone/Cargo.lock` (committed history only) shows no further new package blocks before this task. This task's own change (above) adds a dependency edge to an already-existing package, not a new block. So across all six tasks, `if-addrs 0.15.0` is indeed the only new package — confirmed, not just asserted.

## Files changed (this commit, `766dc9ba0`)

```
apps/standalone/AGENTS.md                                                       |  17 ++
apps/standalone/Cargo.lock                                                      |   1 +
apps/standalone/host/Cargo.toml                                                 |   1 +
apps/standalone/host/src/db.rs                                                  |  21 ++
apps/standalone/host/src/lib.rs                                                 |  11 +-
apps/standalone/host/src/routes/bootstrap.rs                                    |   6 +-
apps/standalone/host/src/routes/changes.rs                                      |  60 +++++
apps/standalone/host/src/routes/office_auth.rs                                  |   8 +-
apps/standalone/host/src/routes/office_users.rs                                 |  24 +-
apps/standalone/host/src/routes/org.rs                                          |   6 +-
apps/standalone/host/src/routes/sscc.rs                                         |  10 +-
apps/standalone/host/src/server.rs                                              |  19 +-
apps/standalone/host/tests/changes_stream.rs                                    | 257 ++++++++++++++
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md            |  46 +--
14 files changed, 440 insertions(+), 47 deletions(-)
```

Untouched by design: `apps/station` (forbidden by the constraints doc), all
other `apps/standalone/host/src/routes/*.rs` files that commit but never call
`next_revision` (`devices.rs`, `pairing.rs`, plus login/logout/denied paths
within `office_auth.rs` — confirmed by the `grep -n "tx.commit()"` check in
the "What was implemented" section above).

An untracked file, `docs/superpowers/plans/2026-09-27-standalone-1c2-app-shell-sync.md`,
was present in the worktree before this task started and is not part of Task
6's file list; it was left untouched and unstaged, per the rule to preserve
pre-existing work that isn't this task's.

## Self-review

- Every writer that calls `next_revision` (verified by `grep -n
next_revision apps/standalone/host/src/routes/*.rs`, matching the six
  sites the brief named) now commits through `commit_with_revision`; every
  other `tx.commit()` in the same files is a non-revision path
  (login/logout/denied/audit-only), confirmed by grep after the edit.
- `commit_with_revision` commits _before_ notifying (`tx.commit().await?;`
  then `send_if_modified`), matching the stated invariant, and uses
  `send_if_modified` (not unconditional `send`) so an out-of-order or
  duplicate call never regresses `revisions` backwards — relevant because
  `put_counter`'s and `put_block_sizes`' no-op branches return before ever
  calling `next_revision`, so they never call `commit_with_revision` at all
  (verified by reading both functions again after editing).
- The stream handler subscribes to both watches _before_ the initial
  `SELECT rev FROM host_revision`, so a commit racing that read still shows
  up as a second event rather than being silently missed — this is exactly
  what `every_revision_bump_wakes_subscribers_after_its_commit` and the
  first stream test exercise, and both pass.
- Confirmed by reading axum 0.8.9's vendored source
  (`~/.cargo/registry/.../axum-0.8.9/src/response/sse.rs`) that
  `Event::default().event("rev").data(json)` serializes to exactly
  `event: rev\ndata: <json>\n\n` (one `HttpBody` frame per `Event`), and that
  `Event::DEFAULT_KEEP_ALIVE` is `:\n\n` — both match the test helpers'
  literal expectations byte-for-byte; this is why the tests pass rather than
  merely "probably" matching.
- `RunningHost::stop` no longer holds a one-shot channel; `stopping` is
  shared between the graceful-shutdown future in `server::serve` and every
  open stream's `unfold` state, so one `send_replace(true)` unblocks both.
  The dedicated test (`open_streams_end_when_the_host_stops`) exercises the
  real network path (`start`/`stop`, not the in-process router) and passed
  in under 5 s outside the sandbox — no hang, no flake observed across two
  runs (the initial full-suite run and the isolated re-run).
- The one deviation (the `select!` borrow-checker restructuring) preserves
  every original branch's behavior and every test assertion; nothing was
  weakened, no timeout lengthened, no assertion loosened.
- Did not run `cargo clippy`: not listed as a gate anywhere in
  `apps/standalone/AGENTS.md`'s Verification section or in this task's
  brief/constraints; only `cargo fmt --check` is the required Rust style
  gate, which passes.

## Not verified (external / out of scope for this task)

Per the plan's final checklist, explicitly not exercised here:

- A second PC on the network, a real pairing-code exchange, and SSE working
  over an actual LAN connection — these need a manual check after plan 1c3.
- The `standalone-windows-build` CI job (LAN interface enumeration on
  Windows) — it only runs on push/CI, not locally in this worktree.

Everything else in the "Итоговая проверка плана" checklist that can run
locally was run above (workspace Cargo tests, `cargo fmt --check`,
`git diff --check`, the four `pnpm` gates, `affected.test.mjs`, and the
`Cargo.lock` new-package audit) and is green.
