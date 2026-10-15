# CI fix, round 2: report

Worktree `/tmp/claude/wt/integ`, branch `claude/integration`. Base `ef3ac51bb`, HEAD `88a4a6315`, tree clean. Nothing was pushed.

## Status: DONE_WITH_CONCERNS

The concerns are things only a real Windows run can settle. They are listed at the end.

## Commits (oldest first)

| Commit      | Subject                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `5b65a35ea` | test(standalone-host): the backup folder test builds an absolute path on Windows too          |
| `c0b7bb1bb` | chore(standalone-host): no Windows-only compiler warnings                                     |
| `422193694` | fix(standalone): the SQL migrations keep LF on a Windows checkout                             |
| `d2ce9dd27` | test(standalone-host): Windows-safe copies of open databases and path checks                  |
| `c31d92c73` | fix(standalone-shell): a set-aside retries a refused move; a failed migration closes its pool |
| `4ce9f0b02` | test(standalone-shell): Windows-aware pairing key, closed-port limit and device names         |
| `63166861f` | build(standalone-shell): the Windows manifest is linked into every target, tests included     |
| `17b1b2f22` | ci(standalone): cargo test runs with --no-fail-fast in both standalone jobs                   |
| `88a4a6315` | test(standalone): 30 s test and hook timeouts for the office suites under CI load             |

Every commit message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked per commit).

## What the Windows log showed

- The workspace **compiled** on windows-latest. Only one test binary ran: the host lib, with 119 passed and 1 failed (`routes::backups::tests::the_folder_text_is_trimmed_and_checked_without_being_echoed`). cargo then stopped.
- These **never ran on Windows**: host `main.rs` unit tests, all 55 host integration test files, the src-tauri lib and its 15 integration test files, and proto.
- Windows-specific tests that **passed**:
  - `backup::identity::tests::windows_closes_the_key_file_to_all_but_system_the_administrators_and_its_owner`
  - `backup::key_file::windows_tests::while_the_host_holds_the_key_file_nobody_else_can_open_move_or_delete_it`
  - all `restore::` unit tests
- There were **3 Windows-only warnings**:
  - `unused_mut` at `host/src/restore.rs:151`
  - `unused_mut` at `host/src/restore.rs:1351`
  - unused import at `host/tests/backup_copy.rs:11`

## A tool I added here: a Windows type-check on macOS

The installed `x86_64-pc-windows-msvc` std, plus stub `cc`/`ar`/`llvm-rc` scripts (they only create their output files; kept under `/tmp/claude/ci2fix/fakecc/`), make this work locally:

```
cargo check --workspace --tests --target x86_64-pc-windows-msvc
```

- It reproduces exactly the 3 warnings CI printed.
- The final tree checks with **0 warnings and 0 errors**, including every new `#[cfg(windows)]` test and the build script.
- Its output also shows that the build script emits `/MANIFEST:EMBED` and `/MANIFESTINPUT:…`, and that tauri's generated `resource.rc` no longer carries a manifest, so there is no duplicate.
- It type-checks only. Nothing is linked or run.

## (1) The failing test

- **What was wrong:** at `host/src/routes/backups.rs` the test fed `/srv/copies`. On Windows that path has no drive or share, so it is not absolute.
- **The fix:** a `ROOT` constant, `C:\srv` under `cfg(windows)` and `/srv` elsewhere. Every case is now built from `ROOT`:
  - the trimmed accept;
  - `..` in both separators, and a trailing `..`;
  - the control character;
  - the 260/261-character bound, now with an explicit `chars().count() == 260` check;
  - `a..b`.
- The cases that do not depend on the root stay literal: `//?/C:/copies`, `//./PhysicalDrive0`, `relative/copies` and the empty string.
- **New Windows-only test** `a_rooted_path_without_a_drive_is_not_absolute_on_windows`: `/srv/copies` is refused with "must be an absolute path", and `\\PC\Share\copies` is accepted.
- **Mutant proof:** I changed `part == ".."` to `part == "..."`. The test failed at `"/srv/../etc"` (killed). I restored the file and `cmp` showed it identical.

## (2) Windows static audit

I audited all of host/src, host/tests (55 files + support), src-tauri/src (test modules), src-tauri/tests (15 files), proto/tests and the fixtures. Four parallel read-only audit passes did the reading; I checked every finding in the source before fixing it.

Real issues found and fixed:

| #   | Where                                                                                                                                                                   | What fails on Windows                                                                                                                                                                                                                                                                                                                                                                    | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `host/src/routes/backups.rs:351`                                                                                                                                        | `/srv/...` is not absolute on Windows                                                                                                                                                                                                                                                                                                                                                    | platform `ROOT`, plus a Windows-only test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| W2  | `.gitattributes` with `host/src/db.rs:15` and `src-tauri/src/local_db.rs:111`                                                                                           | **Production bug.** `sqlx::migrate!` checksums the raw bytes of each migration. A CRLF checkout (`core.autocrlf`) builds a host or shell whose checksums differ from every LF build. Each would then refuse the other's databases, and `restore.rs:587` refuses copies made by the other kind of build.                                                                                  | Pinned to `eol=lf`: `apps/standalone/host/migrations/*.sql`, `apps/standalone/src-tauri/migrations/*.sql`, and as hygiene `proto/fixtures/*.json` and `src-tauri/tests/fixtures/*.json`. Added a test in each crate (`the_migrations_are_embedded_with_lf_line_endings`) that fails if an embedded migration contains `\r`. All 815 files are already LF in the index, so nothing needed renormalizing.                                                                                                                                                                             |
| W3  | `host/tests/restore.rs:358, 917, 954` (`crashed_folder` is used by 3 more tests)                                                                                        | `std::fs::copy` of host.db, -wal and -shm while a SQLite connection holds them. On Windows that is CopyFileExW, which opens the source without sharing write access, so it gets a sharing violation beside SQLite's read/write handle. 5 tests affected.                                                                                                                                 | `copy_open_file` helper: `File::open` (shares read, write and delete) plus `io::copy`. The 4 other copies are of closed files and are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| W4  | `host/tests/backup_routes.rs:416, 430`                                                                                                                                  | The verbatim-path case `format!("/{dir}/sub").replacen("//","//?/",1)` does nothing on a drive path, so it was refused for the wrong reason. The "no echo" check `contains(&dir)` is vacuous on Windows because JSON doubles every backslash.                                                                                                                                            | Verbatim path built from `dir` in both separators. The echo check also looks for the JSON-written form. Mutant: dropping the production `//?/` refusal fails this test.                                                                                                                                                                                                                                                                                                                                                                                                             |
| W5  | `src-tauri/tests/ipc.rs:446`                                                                                                                                            | `save_pairing_at` hard-coded `Scheme::Plain`. On Windows the native scheme is DPAPI, so the pairing is `Unreadable`. `host_request_takes_a_limit_in_milliseconds` gets `config_unreadable`, and `a_corrupt_database_without_this_pairings_unsent_records_is_set_aside` takes the any-pairing guard (`unsent_facts`). 6 more tests pass on Windows only by accident.                      | `secret_store::protect("device-key-value")`, as `host_request_timeout.rs` does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| W6  | `src-tauri/tests/host_request_timeout.rs:142`                                                                                                                           | A closed loopback port with a 100 ms limit. Windows refuses a closed loopback port only after about 2 s of SYN retries, so the result is `Timeout`, not `Unreachable`.                                                                                                                                                                                                                   | Non-Windows: still strictly `Unreachable` at 100 ms. Windows: `Unreachable` or `Timeout` at 100 ms, since either proves the request went out. Plus a new assertion everywhere: 10 000 ms (the upper bound) is `Unreachable`.                                                                                                                                                                                                                                                                                                                                                        |
| W7  | `src-tauri/src/local_db.rs` (`set_aside_unopened_at`, `LocalDb::open`); tests at `src-tauri/tests/local_db.rs:2717, 2956, 3134, 3203` and the ipc `device_forget` tests | **Production robustness issue.** SQLite opens files without `FILE_SHARE_DELETE`. sqlx closes a failed connection's handle on its own thread after `open` returns, and `open` dropped the writer pool without closing it when a migration failed. A set-aside right after a failed open could therefore fail at once with os error 32. An antivirus scan on a factory PC can do the same. | Each move and put-back now goes through `rename_retrying`: 5 attempts, 200 ms apart, with `NotFound` final. This is the host's `rename_retrying` policy. `LocalDb::open` now closes the writer before returning a migration error. Tests: a unit test of the policy; `a_set_aside_tries_a_refused_move_again` (Unix: the folder is read-only for 300 ms); `a_set_aside_waits_for_a_handle_that_still_holds_the_database` (Windows: a handle opened with share read/write held for 300 ms). The split-set test's own rename now uses `rename_once_released` (retries for up to 5 s). |
| W8  | `src-tauri/build.rs`                                                                                                                                                    | **Build change.** tauri-build links its Common-Controls-v6 manifest through a resource that only bins get (`embed-resource`: `rustc-link-arg-bins`). Every src-tauri test executable on Windows can die before `main` with STATUS_ENTRYPOINT_NOT_FOUND. This is the known reason the station job uses `--no-run` (ci.yml:636-639).                                                       | On windows-msvc only: `WindowsAttributes::new_without_app_manifest()`, plus `cargo:rustc-link-arg=/MANIFEST:EMBED` and `/MANIFESTINPUT:src-tauri/windows-app-manifest.xml` (a byte copy of tauri-build 2.6.3's manifest). These apply to every target, tests included. Icon and version resources are unchanged. Linux and macOS builds are untouched.                                                                                                                                                                                                                              |
| W9  | `src-tauri/src/office_files.rs:1458`                                                                                                                                    | Best-effort writes of `con.html`, `CON.HTML`, `nul.html`, `com1.html`. Before Win11/Server 2025 these open the device (COM1 exists on Azure VMs).                                                                                                                                                                                                                                        | On Windows only, skip the write for device stems. All assertions are kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| W10 | `host/src/restore.rs:151, 1351`; `host/tests/backup_copy.rs:11`                                                                                                         | Windows-only `unused_mut` and unused-import warnings                                                                                                                                                                                                                                                                                                                                     | `#[cfg_attr(not(unix), allow(unused_mut))]`; the import moved into the `cfg(unix)` test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Checked with no finding:

- hard-coded `/tmp`, `/srv`, `/var` (the `/data` and `/tmp/h` cases in `restore.rs` and `main.rs` are pure `PathBuf` comparisons, and the restore ones already passed on Windows);
- spawning `sh` (only `#[cfg(unix)] installer_cli::network_check`);
- unix permissions and symlinks (all cfg-gated; the Windows build compiles);
- separators in expected strings (everything compares `display()` of the same path);
- CRLF in fixtures read by Rust tests (all JSON, parsed only; `product_groups.rs` normalizes CRLF and already tests it; the `sqlite_master` checks in `office_shifts.rs:3101` pass with CRLF);
- generated text against literals;
- case-insensitive names;
- fixed ports (all `127.0.0.1:0`);
- directory fsync (production already uses `FILE_FLAG_BACKUP_SEMANTICS`);
- `ErrorKind` expectations;
- tight timing (only "still pending" checks, which coarse timers cannot break);
- time zones (UTC `time` crate only);
- MAX_PATH (deepest about 223 UTF-16 units under the 240 cap);
- tests that touch real OS facilities (DPAPI, `PowerCreateRequest`, `OpenPrinterW` on a missing queue, lockdown with a mock HWND): none hang or open UI.

## (3) CI

- **Workflow:** in `.github/workflows/ci.yml`, both standalone cargo test steps now end in `--workspace --no-fail-fast`:
  - standalone-rust (Linux)
  - standalone-windows-build (Windows)
- **New test** in `tools/ci/test/workflow.test.mjs`: each of the two jobs runs `cargo test` exactly once, ending in `--manifest-path apps/standalone/Cargo.toml --workspace --no-fail-fast`.
- **Mutant:** dropping the flag from the Windows step fails that test. Restored, `cmp` identical.
- **Existing pin:** `tools/standalone-release/test/workflow.test.mjs` pins the Windows command by substring, and it still passes.

## (4) Vitest timeouts

- **Config:** `apps/standalone/vitest.config.ts` now sets `testTimeout: 30_000` and `hookTimeout: 30_000`, with a comment. No test bodies changed.
- **Delay stand:** `vitest.delay.config.ts` does not exist in the repo. It is the throwaway stand from the plans' «Заметки для исполнения», which is created and removed per task. The recipe in those plans copies the config by hand, so the next stand made from it will not inherit the 30 s. Either copy the two keys into it, or `mergeConfig` it with `vitest.config.ts`. I did not edit the plans.
- **Full suite, default invocation** (`vitest run`, no flags), load about 6: **187 files, 5555 tests, all passed, 96.8 s.**
- **Per-test timing**, CI vs local for the old suites (local run with the JSON reporter, the four heavy files together, under a concurrent cargo build):
  - **template-editor:** CI slowest was 5.8 s (9 tests over 2.5 s). Locally the slowest was 2.7 s.
  - **shifts-page:** CI slowest 3.5 s. Locally 1.6 s.
  - **template-defaults-page:** CI slowest 1.8 s.
  - **print-form-dialog:** 9.5 s in CI. It already has its own 60 s timeout. Locally 3.0 s.
  - **Conclusion:** no single test needs anything near 15 s of CPU locally. The CI failures were load on a 457 s run, not hidden hangs. 30 s gives at least 3× headroom over the worst CI time seen.

## Gates

| Gate                                                                                      | Result                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo fmt --check`                                                                       | clean                                                                                                                                                        |
| Full `cargo test --workspace --offline --locked --no-fail-fast` (unsandboxed, 3 min 53 s) | **80 suites, 1451 passed, 0 failed, 0 ignored; 0 warnings**                                                                                                  |
| Windows cross type-check (`--workspace --tests --target x86_64-pc-windows-msvc`)          | 0 warnings, 0 errors                                                                                                                                         |
| `node --test tools/ci/test/*.test.mjs`                                                    | 60/60. Run unsandboxed: the sandbox blocks `mktemp` in `/var/folders`, which makes 2 classifier tests fail inside it.                                        |
| `node --test tools/standalone-release/test/*.test.mjs`                                    | 51/51                                                                                                                                                        |
| Parity tests `export-parity.test.ts` + `forms-parity.test.ts`                             | 2 files, 253 tests passed                                                                                                                                    |
| Standalone typecheck, eslint on the config                                                | clean                                                                                                                                                        |
| Prettier gate (vitest.config.ts, workflow.test.mjs, ci.yml)                               | clean. Proven live: a misformatted scratch file was flagged (exit 1) and deleted. The `.xml` has no prettier parser; `prettier --check .` skips it silently. |
| `git diff --check ef3ac51bb..HEAD`                                                        | clean                                                                                                                                                        |
| `git status --short`                                                                      | empty                                                                                                                                                        |

Focused runs during the work:

- host `--test restore --test backup_routes`: 51 + 14 passed
- shell `--lib --test ipc --test host_request_timeout --test local_db`: 251 + 6 + 32 + 41 passed

## Mutant table (each restored, then `cmp` identical and `touch`ed)

| Mutant                                                                            | Result                                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| backups `part == ".."` → `"..."`                                                  | killed (`/srv/../etc` accepted)                                                                    |
| one host migration and one shell migration rewritten to CRLF (simulated checkout) | killed: both `the_migrations_are_embedded_with_lf_line_endings` fail                               |
| `rename_retrying` guard → `if false && …` (no retry)                              | killed (unit test: 3 calls expected)                                                               |
| `rename_retrying` without the `NotFound` exclusion                                | killed (unit test: 1 call expected)                                                                |
| set-aside call site back to a plain `std::fs::rename`                             | killed by `a_set_aside_tries_a_refused_move_again` (Unix)                                          |
| production `//?/` refusal removed                                                 | killed by `backup_routes` `a_dot_dot_part_or_a_device_path_is_refused_even_when_the_folder_exists` |
| ci.yml Windows step without `--no-fail-fast`                                      | killed by the new CI policy test                                                                   |

Guards that only Windows can kill:

- W3: copying through `fs::copy`.
- W5: the plain scheme. On Unix plain is the native scheme.
- W6: the `cfg(windows)` branch.
- W7: the pool close after a failed migration, and the held-handle test.
- W8: the manifest.
- W9: the device-name skip.

The Unix strict branches and the cross-platform tests still pin the intent of each.

## Concerns (only CI on Windows can settle them)

1. **W8 is inferred, not observed for the standalone.** It is the documented failure of the cloud station's Tauri tests on Server 2025. If `/MANIFESTINPUT` does not cure it, the fallback is the station's pattern: `--exclude markiro-standalone` plus `-p markiro-standalone --no-run`. It also changes the shipped app's manifest source: same content, but embedded by the linker. link.exe also adds its default `asInvoker` UAC fragment, which is benign. The installer smoke test in the same job will exercise it.
2. **icacls on Windows.** `platform_guard()` runs the real `icacls.exe` on the identity `.partial` that `key_file` holds open with `share_mode(0)`. The host unit test for it passed on Windows, but the integration tests that put the identity beside a copy (about 15 in `restore.rs`, plus `the_worker_puts_the_host_identity_beside_each_copy_in_both_folders`) have never run there. If icacls cannot open the file, production silently makes copies without the identity, and those tests fail.
3. **Behaviour seen only by static reading.** CopyFileExW's share mode (W3) and the 2 s refusal on a closed loopback port (W6) come from reading, not from a run. Both fixes are correct on any platform either way.
4. **`installed()` in `host/tests/restore.rs`** closes a pool and restores at once. The production `rename_retrying` should cover a connection that is still closing; if it flakes, reuse `stop()`'s checkpoint loop there.
5. **Low risk, not Windows-specific:** `office_reports.rs` requires a 300-pallet report to finish in under 10 s.
6. **Not run locally (no Windows here):** the Windows runtime, the installer build and the smoke test.
