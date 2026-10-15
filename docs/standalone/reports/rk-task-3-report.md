# Plan РК, task 3 — report (the backup worker)

Status: DONE_WITH_CONCERNS (concerns below are about what only Windows or a hung share can show, and two behaviours decided here).
Commit: `8109f5d21` feat(standalone): the backup worker — hourly while the data changes, daily, on request, the second folder (branch claude/infra-rk, base a36445511). Worktree clean after the commit.

## What was done

Brief applied: `backup/worker.rs` (new; `Backups`, `Worker`, `RunReport`, `scheduled_due`, `spawn`), `backup/mod.rs` re-exports, `audit::actions::BACKUP_CREATE`, `AppState::backups` + `with_backups`, `RunningHost` holds the worker handle and `stop()` waits for it up to `SHUTDOWN_DEADLINE`, `start()` builds `Backups::from_paths` and spawns the worker; tests `backup_worker.rs` (8 of the brief) and `backup_start.rs` (1 of the brief).

Beyond the brief (each has a test that kills its one-line mutant):

1. **Rotate only after `make_copy` succeeded** (rk-minors item 1). The brief rotated the local folder after every run, failed or not; now a failed run only `list`s (`folder::rotate` only when `made.is_some()`).
2. **`clean` never meets a copy in flight** (minors item 2): the worker is one task, a run is awaited to its end, and `clean` is called only inside `run_once`, before the copy, for both folders; stated in the module doc. Test: leftovers (`.partial`, `.db` without manifest, a foreign `notes.txt`) are removed in both folders before the next copy, the foreign file and the verified copies stay.
3. **Host clock going backwards** (`Worker.last_run`): a clock reading earlier than the last scheduled run starts the schedule over (the new hour is taken as served, one `warn`), makes no copy of its own; the next hour of the new clock is the next slot. Without it a set-back clock + changed data made an out-of-slot copy and a flapping clock one per hour flip. Ticks are every 60 s of real time, so nothing could spin even before.
4. **Stop during a copy** (new test with a 32 MB database): the host stops while the `.partial` exists; after `stop()` the copy is finished (manifest, no `.partial`, audit row). The brief's start/stop test could not catch a `stop()` that does not wait for the worker (the mutant survived until this test was added).
5. Restart test: a new `Backups`/`Worker` over the same folder lists the earlier copies (`scan`) and copies once at start, then follows the hourly rule.
6. Copies are sensitive files (minors item 3): nothing new written here except the audit row; copy/manifest/replica are owner-only from Task 2. The worker logs only paths, codes and OS/SQLite error text (`Failure.detail`); the audit row holds only the outcome codes, never error text; no hash is logged (file name and size only).

Properties checked against the dispatch list: host clock only (`Clock`, `ManualClock` in tests, no sleeps as synchronisation; the only waits are the polling loops in the task tests with a 10 s ceiling); one lock = one task; never blocks request handling (own connection, file work in `spawn_blocking`, std `Mutex` held only for field updates, never across an await); no long write transaction (VACUUM INTO is a reader; the audit row is one autocommit INSERT); second folder never fails the primary (`local` result independent, audit `failed` but status local `ok`); failure state and last success time in `GET`-state (`last_attempt` + `copies[0].created_at` per folder); bounded retry (a failed hour is retried at the next hour only); restart resumes from the folder manifests (`scan` + `newest_local`).

## RED / GREEN

- RED: lib/server/audit/mod.rs reverted to HEAD, worker absent: `cargo test … --test backup_worker --no-run` → `E0432 unresolved import markiro_host::backup::worker`, `unresolved imports Backups, Worker` (/tmp/claude/impl-rk-t3/red/worker.txt). Then files restored (cmp-identical copies kept in /tmp/claude/impl-rk-t3/mine).
- GREEN with the brief verbatim: `backup_worker` 8 passed (green0.txt). `backup_start` + `hello` outside the sandbox: 1 + 5 passed (green2.txt).
- GREEN final: `backup_worker` 12 passed (8 + 4 new), `backup_start` 2 passed (1 + 1 new; ran 8 times in a row, all green), `backup_copy` 26, `hello` 5.
- ONE final unsandboxed `cargo test --offline --locked --workspace`: exit 0, 59 `test result` lines, 868 passed, 0 failed (Task 2: 57 / 854; +2 binaries, +14 tests).
- `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, `\u04` grep only `pairing-code.ts:66`, no `\u0` in the files I wrote. No webview file changed (typecheck/lint/Vitest not applicable). Prettier gate proven live (mis-formatted scratch `.ts`, exit 1, deleted); no changed file is prettier-covered. Counts: plan says 8 and 1; measured 8 + 4 and 1 + 1.

## Mutants (script /tmp/claude/impl-rk-t3/mut.py; every file copied to /tmp/claude/impl-rk-t3/orig, restored, `cmp`+sha256 equal, `touch`ed; log in /tmp/claude/impl-rk-t3/mutants.txt, restored=True for all)

| #   | Mutant                                                  | Tests that failed                                                                                                                       |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `scheduled_due` without `changed                        |                                                                                                                                         | `   | `a_copy_is_due_when_the_data_changed_or_today_has_none`, `a_scheduled_copy_comes_once_an_hour…`, `the_second_folder_gets_every_copy…`, `a_clock_that_goes_back…`, `a_restarted_worker…` |
| M2  | `changed \|\| newest.is_none()` (no new-day rule)       | `a_copy_is_due_when…`, `a_scheduled_copy_comes_once_an_hour…`                                                                           |
| M3  | `self.last_hour = Some(hour)` removed from the run path | `a_failed_copy_is_in_the_status…_tries_again`, `a_scheduled_copy_comes_once_an_hour…`                                                   |
| M4  | `copied_version = version` removed                      | `a_scheduled_copy_comes_once_an_hour…`, `a_manual_copy_names_its_office_user…`                                                          |
| M5  | manual copy audited as `System`                         | `a_manual_copy_names_its_office_user…`, `the_worker_task_copies_at_start_and_at_once…`                                                  |
| M6  | `begin_scheduled` ignores a running/waiting copy        | `a_manual_copy_names_its_office_user…`                                                                                                  |
| M7  | audit `ok` ignores the second folder                    | `the_second_folder_gets_every_copy_and_its_failure_is_its_own`                                                                          |
| M8  | second folder `Ok(())` without a local copy             | `a_failed_local_copy_gives_the_second_folder_nothing`                                                                                   |
| M9  | host does not spawn the worker (lib.rs)                 | `backup_start`: both tests                                                                                                              |
| M10 | worker ignores `stopping`                               | `the_worker_task_copies_at_start_and_at_once…`                                                                                          |
| N1  | clock-back guard condition `false`                      | `a_clock_that_goes_back_starts_the_schedule_over…`                                                                                      |
| N2  | rotate always (even after a failed copy)                | `a_failed_copy_thins_out_nothing`                                                                                                       |
| N3  | no `clean` of the local folder                          | `what_a_broken_copy_left_is_cleaned…`                                                                                                   |
| N4  | no `clean` of the second folder                         | `what_a_broken_copy_left_is_cleaned…`                                                                                                   |
| N5  | `scan` lists nothing locally                            | `the_folders_are_read_at_start…`, `a_restarted_worker…`                                                                                 |
| N6  | clock-back guard does not move `last_hour`              | `a_clock_that_goes_back_starts_the_schedule_over…`                                                                                      |
| N7  | `stop()` waits 0 s for the worker (immediate abort)     | `a_host_that_stops_while_a_copy_is_made_lets_it_finish` (SURVIVED with the brief's tests alone; killed after the new test, 4 runs of 4) |
| N8  | hour-slot check `if false`                              | `a_failed_copy_is_in_the_status…`, `a_clock_that_goes_back…`, `a_scheduled_copy_comes_once_an_hour…`                                    |

## Anchor adaptations

None: every fragment of steps 3.2–3.10 matched exactly once (mod.rs, audit.rs, server.rs ×3, lib.rs ×4). Mechanical only: the worker file and tests were taken from the brief's code blocks and `cargo fmt` applied.

## Files changed

`apps/standalone/host/src/backup/{worker,mod}.rs`, `host/src/{audit,server,lib}.rs`, `host/tests/{backup_worker,backup_start}.rs`.

## Concerns / for later tasks

1. **Dead share can hang process exit.** A second-folder write to an unreachable UNC path blocks a `spawn_blocking` thread (Windows SMB timeouts are long). I did not add a timeout (a timed-out blocking call keeps writing, which would break "no `clean` beside a copy"); the office is told by the plan's «копия идёт дольше 30 минут». But `RunningHost::stop` aborts the worker after 10 s while the blocking thread lives on, and `main.rs`/`service.rs` drop a plain `Runtime::new()`, which waits for blocking threads indefinitely. A `runtime.shutdown_timeout(..)` in `main.rs`/`service.rs` (Task 5 touches `main.rs`) would bound it. Untestable on macOS.
2. After the 10 s abort, a copy still in flight is not cancelled (its run task is detached) and leaves a `.partial` that the next start's `clean` removes; no AbortOnDrop guard was added (untestable determinstically).
3. **Retention is relative to the copies' own times.** If the clock is set back by more than the rule's window (more than 24 newer hourly copies), the fresh copy would be the first rotated away. The worker does not guard this; it belongs to `retention::keep`/`rotate` (Task 2). Rare, noted.
4. A restart always copies at once (plan: «копия делается и при каждом запуске хоста»), even within the hour of the previous copy; a crash-looping service would make a copy per start (rotation bounds the disk). "Resumes the schedule from the manifest" is implemented as: folder manifests give the status and the day check; the hour slot is not seeded from them.
5. Worker audit rows take no revision (single `audit::record`), as the plan says; the `second` outcome is `null` when no second folder is set.
6. Not verified: Windows (service account, UNC, USB, antivirus on rename), a really full disk, a share that goes away mid-copy; unchanged from Task 2's list.
7. `rk-implementer-rules.md` opens with another plan's scoping text; ignored as instructed. Warm cargo target was the worktree's own `apps/standalone/target` (a first run with a separate `CARGO_TARGET_DIR` rebuilt everything cold and was deleted).
