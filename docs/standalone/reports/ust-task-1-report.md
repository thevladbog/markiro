# УСТ Task 1 report — the host installs itself as the `MarkiroHost` service behind a seam

Status: DONE_WITH_CONCERNS (Windows behaviour not run; see Concerns).
Commit: `297a00bf8` feat(standalone): the host installs itself as the MarkiroHost service behind a testable seam (on `claude/infra-rk`, on top of `cf08ddf07`; ИМП Task 2+ untouched).

## What I did

The brief's Task 1 is platform-neutral: `host/src/install.rs` (the seams `Services` and `Commands`, `service_spec`, the order of steps `install`/`uninstall`/`stop`, `icacls` by SID, the firewall rule as an `-EncodedCommand` PowerShell script, waits capped at 30 s) plus `pub mod install;` in `lib.rs` and the `SERVICE_NAME`/comment edit in `service.rs`. The Windows adapter (`install_windows.rs`) and the `install`/`uninstall`/`stop-service` subcommands in `main.rs` are the plan's Task 2, not this task. I wrote nothing there.

The brief's `install.rs` and `tests/install.rs` were applied verbatim first (RED, then GREEN), then extended TDD-style beyond the brief for the dispatch's security items.

### Additions beyond the brief (all in `install.rs` and `tests/install.rs`)

1. **Rollback of a failed FRESH install.** `install` now reads whether a service existed (`stop()` already returns it). If `configure`, the firewall rule or `start` fails and nothing existed before, `undo_fresh_install` runs: read state, `stop` if not stopped, `delete`, remove the firewall rule. It is best effort, waits for nothing, and its own failures never replace the install's error. After `start()` succeeded, a failing wait (`Timeout`, `StoppedAfterStart`) deliberately does NOT roll back: a slow start (big database migration) must not lose the service, and a host that refuses to start because of an interrupted restore must stay installed with its restart policy. A failed UPGRADE does not delete the customer's existing service (re-running converges).
2. `InstallError::StoppedAfterStart` text now points at an unfinished restore (`markiro-host restore again`), since the intent marker makes `start` refuse (see Concerns 2).
3. Extra tests: hand-quoting (a Cyrillic path with spaces is one plain argument, no `"`; service executable and arguments stay separate for the service manager's own quoting), a second install over a stopped service, the rollback cases above. `FakeServices` got a `refuses` list (additive; the brief's tests are unchanged).

## Compatibility with РК (restore / shutdown_runtime / intent marker)

- `service.rs` keeps `crate::shutdown_runtime(runtime)` (5 s); only the name constant and the comment changed.
- The service definition: automatic start, LocalService, restarts after 5/30/60 s, `reset_after` 24 h, failure actions on non-crash exits. An administrator's `sc stop` is a clean stop (exit 0), so the recovery policy does not restart it and `restore` can take the lock; the restore's own message already says `sc stop MarkiroHost`. The installer's wait limits (30 s start/stop) exceed `RunningHost::stop` 10 s + `shutdown_runtime` 5 s.
- `install` converges when repeated and stops an old running service before reconfiguring, so a restore is never raced by an installer-side start.

## RED / GREEN

- RED 1 (brief tests, no implementation): `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml -p markiro-host --test install` → `error[E0432]: unresolved imports markiro_host::install` (`/tmp/claude/impl-ust-t1/red.txt`).
- GREEN 1 (brief code verbatim): `--test install --lib` → install 11 passed, lib 89 passed, no warnings (`green1.txt`).
- RED 2 (my extra tests): 15 passed, 5 FAILED — the four rollback tests (`a_fresh_install_whose_firewall_rule_fails…`, `…start_is_refused…`, `…configuration_stops_half_way…`, `a_failed_undo_never_hides…`) and `a_start_that_fails_after_the_wait_points_at_a_restore…` (`red2.txt`). The upgrade/never-rolled-back/quoting/idempotency tests passed already (they pin existing behaviour).
- GREEN 2: install 20 passed, 0 failed (`green2.txt`).
- Final: ONE unsandboxed `cargo test --offline --locked --manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast`: exit 0, 64 `test result` lines, 980 passed, 0 failed, 0 ignored, 0 `warning:` (`workspace.txt`).

## Test totals: plan vs measured

Plan: `install` 11, host lib 57. Measured: `install` 20 (11 brief + 9 mine), host lib 89 (the base has grown since the plan: РК/ИМП modules). Workspace: 64 result lines / 980 tests (РК Task 8 baseline differs because ИМП Task 1 and later РК work are in).

## Mutants (script `/tmp/claude/impl-ust-t1/mutate.py`, mutants `mutants.json`, results `mutants.out.json`, log `mutants.log`)

Each was applied to `host/src/install.rs`, the `--test install` run recorded, then the file restored from `/tmp/claude/impl-ust-t1/install.rs.orig`; every restore was checked with `cmp` and sha256 (`3ae9be6b…5624` before and after, all 24 `True` in the log) and the file touched. `git status` is clean after the commit.

| #   | One-line mutant                                                        | Killed by (first/main)                                                                        |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| M1  | `failure_actions_on_non_crash: false`                                  | `the_service_runs_as_local_service_at_boot_and_restarts_after_any_failure`                    |
| M2  | install no longer stops an old service (`existed = state().is_some()`) | `install_over_a_running_service_stops_it_first_and_starts_it_again`                           |
| M3  | stopped service after start → `sleep` instead of `StoppedAfterStart`   | `a_service_that_stops_right_after_its_start_fails_the_install`                                |
| M4  | uninstall deletes unconditionally                                      | `uninstall_without_a_service_still_removes_the_rule`                                          |
| M5  | rollback on upgrades too (`if true`)                                   | `an_upgrade_that_fails_leaves_the_installed_service_registered_and_the_rule_alone`            |
| M6  | undo forgets `delete` of a stopped service                             | `a_fresh_install_whose_firewall_rule_fails…` (+2)                                             |
| M7  | undo does not `stop` a pending service                                 | `a_fresh_install_whose_start_is_refused_is_taken_back_and_a_pending_service_is_stopped_first` |
| M8  | undo keeps the firewall rule                                           | 4 rollback tests                                                                              |
| M9  | undo error propagates (`delete().unwrap()`)                            | `a_failed_undo_never_hides_the_error_that_caused_it`                                          |
| M10 | a failed wait also rolls back                                          | `a_service_that_started_is_never_taken_back_when_the_wait_fails`                              |
| M11 | `stop` asks a stopped service to stop                                  | `stop_answers_whether_there_was_a_service…` (+2)                                              |
| M12 | data dir hand-quoted with `"`                                          | `a_path_with_spaces_and_cyrillic_is_one_plain_argument…` (+2)                                 |
| M13 | `POLL_EVERY` 1000 ms                                                   | `a_service_that_never_runs_fails_after_the_wait_limit…` (+1)                                  |
| M14 | restore hint removed from `StoppedAfterStart` text                     | `a_start_that_fails_after_the_wait_points_at_a_restore_that_was_not_finished`                 |
| M15 | LocalService grant widened to Everyone (`S-1-1-0`)                     | `install_hardens_the_data_dir…`                                                               |
| M16 | firewall `-Profile Any`                                                | `the_firewall_rule_opens_the_port_on_private_and_domain_networks_from_the_local_subnet_only`  |
| M17 | firewall `-RemoteAddress Any`                                          | same test                                                                                     |
| M18 | account `LocalSystem`                                                  | `the_service_runs_as_local_service_at_boot…`                                                  |
| M19 | uninstall sends another script than the rule removal                   | `uninstall_stops_and_removes_the_service_and_the_rule_and_never_touches_the_data`             |
| M20 | `icacls` refusal ignored                                               | `a_refused_access_list_registers_nothing`                                                     |
| M21 | any exit code accepted (`code.is_some()`)                              | `a_refused_access_list_registers_nothing` (+3)                                                |
| M22 | firewall opened before `configure`                                     | 8 order tests                                                                                 |
| M23 | `automatic: false`                                                     | `the_service_runs_as_local_service_at_boot…`                                                  |
| M24 | wait limit 59 reads                                                    | `a_service_that_never_runs_fails_after_the_wait_limit…` (+1)                                  |

The brief's four mutations are M1, M2, M3, M4; all fail their named tests. No mutant survived.

## Windows-only code: what was and was not run

- Probe crate (uncommitted, `/tmp/claude/impl-ust-t1/probe`, `#![deny(warnings)]`, `windows-service =0.8.1`, `base64 =0.22.1`, stubs of the crate items, `#[path]` to the real `service.rs` and the real `install.rs`): `cargo check --offline --target x86_64-pc-windows-msvc` → 0 errors, 0 warnings, and also `aarch64-apple-darwin` → clean. The `cfg(windows)` branch of `SystemCommands` (`CommandExt::creation_flags`) is really compiled: a mutant copy with `creation_flagz` fails the msvc probe only (`E0599`), not the macOS one.
- NOT run on Windows: `icacls` against a real ACL (inheritance propagation to an existing `host.db`, the effective rights of LocalService), the PowerShell script on a real machine (`New-NetFirewallRule -Profile Private,Domain -RemoteAddress LocalSubnet`), `CREATE_NO_WINDOW`, the service manager (Task 2), the full `service.rs` against the SCM, and `sc stop` vs the restore lock. `standalone-windows-build` / the owner's manual checks are the only places.

## Anchor adaptations

- `host/src/lib.rs`: the brief's fragment `pub mod error; pub mod feed; pub mod logging; pub mod network;` does not exist as such (the tree has `pub mod facts;` between `error` and `feed`). Mechanical: inserted `pub mod install;` between `feed` and `logging` (alphabetical). Compiles on every OS (the module has no Windows dependency; the `cfg(windows)` there is only `SystemCommands`).
- `host/src/service.rs`: both fragments matched exactly once (the file had gained `shutdown_runtime`, outside the fragments).
- No other deviation. The brief's tests and code are verbatim except for the additions listed above; `cargo fmt` reformatted nothing that I did not write.

## Gates

`cargo fmt --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets --offline --locked` 0 warnings; `git diff --check` clean; `grep -rnF '\u04' apps/standalone/src apps/standalone/test` → only `src/host/pairing-code.ts:66`; no `\u0` in the two new Rust files; prettier gate proven live (mis-formatted scratch `.ts` → exit 1, deleted) — no prettier-covered file changed (Rust only); no webview file changed, so Vitest/typecheck/lint/build/delayed-`setImmediate` stand are not applicable; `git status --short` empty after the commit.

## Security review notes

- Least privilege: service runs as `NT AUTHORITY\LocalService`; data dir ACL = inheritance removed, SYSTEM and Administrators full, LocalService modify, by SID (no Users/Everyone) — pinned by test and M15. `host.db` and copies therefore stop being readable to ordinary users once `install` ran; the directory must exist before `icacls` (the Task 2 subcommand must create it first with `HostPaths::ensure`).
- Firewall: TCP port only, Private and Domain profiles, local subnet only; no `-Program`. Pinned by the exact script test and M16/M17.
- No secrets: nothing in this module touches or logs credentials, PINs, hashes or keys; `CommandOutput.stdout` is never logged; error texts carry program name, exit code, the service manager's own text.
- Uninstall never calls `icacls` or touches the data directory (test asserts it); no purge flag exists.
- No shell strings: `std::process::Command` with argument vectors; the one script goes through `-EncodedCommand`.

## Concerns (for the controller / Tasks 2, 5, 7)

1. **Windows unverified** (above). Notably `icacls /inheritance:r` without `/T`: new and inherited children follow the directory, but a child file with an explicit (non-inherited) ACE would keep it. The data directory is created by the host itself, so this is expected to be fine, but only a Windows run proves it.
2. **Interrupted restore vs the service policy.** With `host.restore-intent` present, `start` refuses, the service exits with `ServiceSpecific(1)`, and — because `failure_actions_on_non_crash` is on — Windows retries every 60 s indefinitely (each try takes the lock briefly, so an administrator re-running `markiro-host restore` may meet the "locked" refusal once and must repeat; `sc stop` first is the runbook's step). That is bounded and logged, not defeating the marker, but the Task 7 runbook should say so. A reinstall over an unfinished restore ends in `StoppedAfterStart` (installer error, service stays); Task 5's NSIS hook may want to treat it as a warning with the restore hint.
3. `icacls_args` uses `Path::display()`, which is lossy only for unpaired UTF-16 surrogates (practically never in a data dir path); Cyrillic and spaces are exact (tested). `Commands` takes `&[String]` per the brief.
4. A service in `StartPending` may refuse a stop control on Windows; whether `Services::stop` (Task 2's adapter) maps that refusal is Task 2's concern. `install::stop` would then propagate the error.
5. The rollback and the `StoppedAfterStart` hint are additions beyond the plan's text (the dispatch asked for failure rollback); if the controller prefers the plan's strict behaviour, they are isolated in `undo_fresh_install`/`register_and_start`.

## Files changed

- `/tmp/claude/wt/inf/apps/standalone/host/src/install.rs` (new)
- `/tmp/claude/wt/inf/apps/standalone/host/tests/install.rs` (new)
- `/tmp/claude/wt/inf/apps/standalone/host/src/lib.rs`, `/tmp/claude/wt/inf/apps/standalone/host/src/service.rs`
- Evidence under `/tmp/claude/impl-ust-t1/` (RED/GREEN outputs, mutant harness, probe crate).
