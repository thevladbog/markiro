# Plan РК, task 4 — report (backups in the office)

Status: DONE_WITH_CONCERNS (concerns: a hung share and the process-exit class, one deviation from the dispatch wording, Windows untested).
Commit: `66f44751d` feat(standalone): backups in the office — the state, a copy now, the second folder tried before it is saved (branch claude/infra-rk, base 8109f5d21). Worktree clean after the commit.

## What was done

Brief applied: `routes/backups.rs` (new: `PROBE_TIMEOUT`, `get_backups`, `start_backup`, `put_settings`, private `read_settings`, `read_hold`, `answer`), `routes/mod.rs`, three routes in `server.rs` (`GET`/`POST /v1/office/backups`, `PUT /v1/office/backups/settings`), `audit::actions::BACKUP_SETTINGS_UPDATE`, tests `backup_routes.rs` (7 of the brief) and `backup_start.rs` (+1: `the_office_of_a_started_host_reads_its_copies`, the shared `start_host` helper).

### Answers to the dispatch's attention list

- **Who may change the folders:** administrators only (`require_admin` before the probe; `require_admin_in` again inside the write transaction, so a user turned off after the extractor saves nothing). The technologist may read the state (all office roles) and gets 403 on `POST`/`PUT`. A device key without an office session gets 401 `credential: session` on all three verbs (tested for POST and PUT beyond the brief).
- **Path validation (`second_dir`)**: trimmed; 1-260 characters (chars, not bytes); no control character (NUL, newline, BEL, ...); must be absolute (`Path::is_absolute`; a drive path or `\\PC\Share`); **added beyond the brief:** no `..` part (checked on both separators on every platform, so `C:\x\..\y` is caught on any host and `a..b` is still fine) and no Windows verbatim/device namespace (`\\?\`, `\\.\`, and the `//?/`, `//./` spellings). Errors are `validation_failed` with `details.field = "secondDir"`; the message text is static, the path is never echoed back (tested). `canonicalize` in `folder::probe` (Task 2) still refuses a folder inside the data directory (`inside_data_dir`) even through a symlink. A body without `secondDir` is a 400 and clears nothing (Zod/serde `Option::deserialize` from Task 1).
- **Probe** runs before the write transaction, off the async threads (`spawn_blocking`), for at most 8 s; failures are `409 conflict`, `details {constraint: "backup_dir", reason}` with `missing | not_a_directory | access_denied | unwritable | timeout | inside_data_dir`. The timeout path is now testable (`probe_within(limit, work)` seam) and tested.
- **Audit rows:** `backup.settings.update`, actor = the administrator (`office_user`/id), target `backup_settings`/`1`, result `ok`, details `{"changed":["secondDir"],"secondDir":{"from":<old path or null>,"to":<new path or null>}}`. **The folder path is logged in the metadata, as the plan's table says** (an administrator-supplied path can contain a computer or share name; it contains no secret and the host writes no credential into it). No row, no revision, no wake for: refused requests (400/401/403/404/409), the same folder again, a stale form. `POST` (copy now) writes no row itself; the worker writes the `backup.create` row (actor = the asking user) after the copy. Nothing is logged to the process log from these routes except the generic `ApiError::internal` cause.
- **Concurrency:** `expectedRev` is compared with `backup_settings.rev` inside the `BEGIN IMMEDIATE` transaction; a mismatch is `409 stale_revision` with `currentRev` (tested for a never-read revision 99 and for a form read before another administrator's change). The check precedes the "same folder" no-op, so a stale same-folder request is still refused.
- **Make a copy now:** `202` with the state showing `running {trigger: manual, startedAt}`; while a copy runs or waits the second request is `409 conflict` `{constraint: "backup_running"}` and changes nothing: the first request's `startedAt` is kept, no second request is queued (tested: two more asks after the first, the worker runs once, `run_manual()` returns `None` afterwards, then a new ask is accepted with its own time). **Deviation from the dispatch wording:** the dispatch says "returns the running state"; the brief (single source) says `conflict` on `backup_running` and its test asserts 409, so 409 it is; the running state is read from `GET`.
- **Status is the worker's real state:** `GET` and the `202` answer read `Backups::state` (the worker's in-memory status written by its own `finish()` and scan) plus the settings row and the hold in one read transaction; there is no route-side cache. Tested end to end through the routes: set the second folder, worker runs a manual copy, `GET` shows both folders' `lastAttempt` and one copy each; remove the share, run again, `GET` shows the local folder ok with two copies and the second folder `ok:false, code: destination_unavailable`, and the audit row `failed` with the second outcome.
- **Shapes:** 401 (extractor), 403 `forbidden`, 404 `not_found` when `AppState` has no `Backups` (tested for POST and PUT as an administrator: no rows, no revision), 409 `conflict`/`stale_revision`, 400 `validation_failed`.
- **Protocol/fixtures/Zod:** no change needed in this task: the shapes (`BackupState`, `BackupSettingsUpdate`, `RestoreHold*`), fixtures and the Zod schemas for them came with Task 1 and are additive (protocol stays 3 on this tree). The route answers are asserted field for field against the JSON shape in `backup_routes.rs`; `HostApi` calls are Task 7.

## RED / GREEN

- RED: `cargo test … --test backup_routes` before the routes: 7 failed, 0 passed (/tmp/claude/impl-rk-t4/red.txt).
- GREEN with the brief verbatim: 7 passed (green0.txt). Final: `backup_routes` 13 passed (7 + 6 new), unit `routes::backups` 3 passed (new), `backup_start` 3 passed (2 + Task 3's stop test) outside the sandbox.
- ONE final unsandboxed `cargo test --offline --locked --workspace`: exit 0, 60 `test result` lines, 885 passed, 0 failed (Task 3: 59 / 868; +1 binary, +17 tests = 6 + 3 new + 7 brief + 1 brief in backup_start). Plan count: brief says 7 and 2; measured 13 + 3 unit, and 3 in `backup_start` (Task 3 added a third before).
- `cargo fmt --check` clean, `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings, `git diff --check` clean, `\u04` grep finds only `pairing-code.ts:66`, no `\u0` in the files I wrote. No webview file changed (Vitest, typecheck, lint, the delayed-`setImmediate` stand: not applicable). Prettier gate proven live (mis-formatted scratch `.ts`: exit 1, deleted); no changed file is prettier-covered.

## Tests beyond the brief (all in `backup_routes.rs` or the unit module)

`a_dot_dot_part_or_a_device_path_is_refused_even_when_the_folder_exists` (a real folder reached through `..`, the backslash spelling, `//?/`, `//./`; nothing written; the answer does not echo the path), `a_host_without_copies_answers_not_found_to_every_verb_and_writes_nothing`, `a_device_key_without_an_office_session_reaches_no_verb`, `a_second_ask_while_a_copy_runs_starts_nothing_and_keeps_the_first`, `a_form_read_before_a_change_is_stale_after_it`, `the_state_is_what_the_worker_did_in_each_folder`; unit tests `a_folder_that_does_not_answer_in_time_is_a_timeout_not_a_hang`, `a_folder_that_answers_is_taken_as_it_answers` (ok, a named problem, a panicking probe is a 500, not a pass), `the_folder_text_is_trimmed_and_checked_without_being_echoed`.

## Mutants (script /tmp/claude/impl-rk-t4/mut.py; each file copied to /tmp/claude/impl-rk-t4/orig first, restored, `cmp` + sha256 equal, `touch`ed; log /tmp/claude/impl-rk-t4/mutants.txt, restored=True for all)

| #               | Mutant                                                               | Test that failed                                                                               |
| --------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| M1              | no `require_admin_in` in the transaction                             | `an_administrator_turned_off_after_the_extractor_saves_nothing`                                |
| M2              | `commit_with_revision(.., 0)` (nobody woken)                         | `the_second_folder_is_tried_saved_audited_and_cleared`                                         |
| M3              | no probe before saving                                               | `a_folder_that_cannot_take_copies_is_refused_before_anything_is_written`                       |
| M4              | same folder again counts as a change                                 | `the_second_folder_is_tried_saved_audited_and_cleared`                                         |
| M5              | relative path accepted                                               | `a_folder_that_cannot_take_copies_is_refused_…`                                                |
| M6              | no `require_admin` on POST                                           | `an_administrator_asks_for_a_copy_and_the_worker_makes_it`                                     |
| M7              | lib.rs: the started host gives the routes no `Backups` (unsandboxed) | `the_office_of_a_started_host_reads_its_copies` (the two older start tests keep passing)       |
| M8              | `reconciled: known.is_some()`                                        | `a_held_host_lists_its_stations_…`                                                             |
| M9              | revoked stations listed                                              | `a_held_host_lists_its_stations_…`                                                             |
| N1 / N1u        | `..` check `false`                                                   | `a_dot_dot_part_or_a_device_path_…` / unit `the_folder_text_is_trimmed_…`                      |
| N2a / N2b / N2u | `//?/` check off / `//./` check off / both                           | `a_dot_dot_part_or_a_device_path_…` (both halves) / unit                                       |
| N3              | timeout mapped to `missing`                                          | unit `a_folder_that_does_not_answer_in_time_…`                                                 |
| N4              | probe limit 1 h instead of the argument                              | same unit test                                                                                 |
| N5              | a panicking probe treated as success                                 | unit `a_folder_that_answers_is_taken_as_it_answers`                                            |
| N6              | `expectedRev` not compared                                           | `a_stale_form_and_a_technologist_are_refused`, `a_form_read_before_a_change_is_stale_after_it` |
| N7 / N7u        | no `trim()`                                                          | `the_second_folder_is_tried_saved_audited_and_cleared` / unit                                  |
| N9              | GET needs the administrator                                          | `every_office_role_reads_the_state_and_a_device_key_alone_does_not`                            |
| N10             | audit `target_id` "0"                                                | `the_second_folder_is_tried_saved_audited_and_cleared`                                         |
| N11             | POST answers 200, not 202                                            | `a_second_ask_while_a_copy_runs_…`, `an_administrator_asks_for_a_copy_…`                       |
| N13             | control characters accepted                                          | `a_folder_that_cannot_take_copies_is_refused_…`                                                |
| N14 / N14u      | length bound 261                                                     | same test / unit                                                                               |

Note: M7 first ran in the sandbox, where all three start tests failed on `bind`, which proves nothing; it was re-run unsandboxed and only the intended test fails.

## Anchor adaptations

1. `routes/mod.rs`: the brief's anchor shows a three-line module list; the tree has many more modules after `pub mod bootstrap;`. Applied by meaning: `pub mod backups;` inserted before `pub mod bootstrap;` (mechanical). All other fragments (backup_start.rs x3, server.rs, audit.rs, lib.rs for M7) matched exactly once.

## Files changed

`apps/standalone/host/src/routes/{backups,mod}.rs`, `host/src/{server,audit}.rs`, `host/tests/{backup_routes,backup_start}.rs`.

## Self-review / concerns

1. **Probe thread on a dead share.** The 8 s timeout abandons the probe but the blocking thread lives until the OS call returns (cannot be cancelled). Repeated attempts on an unreachable share add blocked threads (tokio blocking pool cap is 512; only administrators can trigger it). Same class as rk-minors item 5: a plain `Runtime` drop at process exit waits for such threads; Task 5's `shutdown_timeout` in `main.rs`/`service.rs` should bound it (addendum applies to the probe too).
2. `start_backup`: if the state read after `request_manual` failed (a database error), the response is 500 although the copy is queued. Harmless (the copy happens, the page re-reads) but noted.
3. Time of check vs time of use: the folder is tried before the write transaction and saved later; it can disappear in between. The worker reports that as `destination_unavailable` on the next copy, which is the intended path.
4. The `..` and `\\?\` rules go beyond the brief; they only narrow what the administrator may type. A legitimate `\\?\UNC\...` path would be refused (the runbook should say to use `\\PC\Share`).
5. Control characters are refused, but other invisible Unicode (bidi marks, zero-width) is not; the UI (Task 7) shows the path in a table cell, so a spoofing paste is theoretically possible. Low risk (administrator-only input).
6. Not verified: Windows (UNC timeouts, service account rights on the share, `\\?\` handling, drive-letter behaviour), a real USB drive being removed during the probe, the browser/WebView2 side (Task 7).
7. `rk-implementer-rules.md` opens with another plan's scoping paragraph; ignored as instructed.
