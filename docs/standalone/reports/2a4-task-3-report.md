# Plan 2a4, Task 3 report: the device name in `DeviceStatus` and `device.json`

Status: DONE. Worktree `/tmp/claude/wt/2a4-shell`. BASE `094f969c1d72d9eb7a962ac2c0bcd923f7033045`. Commit `ffd77c3bf feat(standalone): the station keeps the name the host has for it` (one trailer line, checked with `git log -1 --format=%B`). `git status --short` is empty after the commit.

## What was done

- Steps 1 and 3 were applied by a script that checks every «фрагмент» matches exactly once. All 12 test fragments and all 19 implementation fragments matched on the first try; there was no anchor drift after Task 2 and its fix rounds.
- Rust: `DeviceConfig.device_name: Option<String>`, `DeviceStatus.device_name`, and `DeviceState::keep_record` instead of `keep_line` (refresh and select_line compare line AND name, and write only when either differs). `remember` takes `name` and stores `name.trim()`. `lib.rs` has a doc-comment change only. No `serde(default)`.
- Webview: `deviceStatusSchema.deviceName = z.string().min(1).nullable()`, and `DEVICE_STATUS.deviceName` in the fixtures.

## RED and GREEN

- RED, Rust: `cargo test --offline --locked … -p markiro-standalone --test line --test ipc --no-run` failed to compile with 3 × E0560 (`DeviceConfig` has no field `device_name`) and 2 × E0609 (`device_name` on `DeviceStatus`), exactly as the plan says.
- RED, TS: `exec vitest run test/device.test.ts` gave 6 failed and 26 passed, the 6 the plan names. The two «rejects … without/empty device name» cases passed before the change, as the plan allows.
- GREEN, Rust, in the sandbox: lib 49, as the plan says.
- GREEN, Rust, outside the sandbox (the whole package, `--no-fail-fast`):

| Suite                | Result |
| -------------------- | ------ |
| lib                  | 49     |
| claim                | 5      |
| connection           | 6      |
| device               | 15     |
| host_probe           | 2      |
| host_probe_proxy     | 1      |
| host_request_timeout | 5      |
| ipc                  | 13     |
| line                 | 16     |
| local_db             | 12     |
| lockdown             | 4      |

All pass. `cargo check --all-targets` has 0 warnings and `cargo fmt --check` is clean.

- GREEN, TS: 67 files, 1751 tests pass. `typecheck`, `lint` and `build` pass, and prettier is clean. `--reporter=verbose` on `test/device.test.ts` printed no `stderr`. The new TS tests render no React, so the delayed-`setImmediate` stand was not needed.
- The Cyrillic grep finds only `pairing-code.ts:66`, and `\u0` finds nothing in the Rust files I touched. `git diff --check` is clean.

## Counts: plan versus measured

| Item             | Plan   | Measured | Why it differs                                                                                      |
| ---------------- | ------ | -------- | --------------------------------------------------------------------------------------------------- |
| Vitest           | 1749   | 1751     | Task 2's fix rounds added 2 tests before mine. This task adds 3: 1 plan test and 2 `it.each` cases. |
| `line`           | 15     | 16       | I added 1 test.                                                                                     |
| `device`         | 13     | 15       | I added 2 tests.                                                                                    |
| `claim`          | 4      | 5        | I added 1 test.                                                                                     |
| lib 49, `ipc` 13 | 49, 13 | 49, 13   | none                                                                                                |

## Tests I added where the plan's did not catch a mutant

The plan's tests do not pin the trimmed pairing name. The ipc and claim fixtures use unpadded names. In `line.rs`, `select_line` overwrites the pairing's name with the host's. So the mutant `Some(name.to_owned())` survived the plan's tests.

- `tests/device.rs::pairing_keeps_the_name_the_host_stores`
  - Pairs with `"  " + 100 × «Я» + " \u{a0} "` and expects the full 100-character name without padding in `status`, in the host's own `GET /v1/device` record, and after reloading `device.json`.
  - 100 characters is the host's limit, and the existing test already covers 101 being rejected.
- `tests/device.rs::a_device_paired_before_the_name_gets_it_with_the_first_refresh`
  - Removes `deviceName` from a real `device.json` and loads it through `DeviceState`.
  - Checks `device_name == None` and a serialized `deviceName: null` (the key is present), and that it equals the pairing's status apart from the name.
  - The first `refresh` brings the name in, and the file on disk now has `deviceName`.
  - This is the old-file compatibility path end to end. The plan's lib test checks only `device_config::load`.
- `tests/claim.rs::a_station_paired_by_code_keeps_the_trimmed_name`: the same trimming check for the `claim` path.
- `tests/line.rs::choosing_a_line_brings_a_rename_with_it`
  - Renames the device in the office, then calls `select_line` on the same line.
  - Expects the new name and the same line, and expects it to persist.
  - The plan covers a rename only through `refresh`.

## Mutants

Each mutant was applied from a copy, run, restored with `cp`, and checked with `cmp` and `shasum -a 256`. In every case the restore matched byte for byte (the sha256 prefix is 335d8056dd7e for `device.rs`, 4fd6a41f7e33 for `device_config.rs`, 6bd333011d98 for `protocol.ts`). Cargo stops after the first failing test binary, so mutants M3a, M3b, M6 and M8 were re-run with `--no-fail-fast`, and the table lists the full set.

| Mutant         | Change                                                                 | Tests that failed                                                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 (plan)      | drop `&& name == device.config.device_name`                            | `a_station_takes_the_name_the_office_gives_it`, `choosing_a_line_brings_a_rename_with_it`                                                                                                                                 |
| M2 (plan) = T1 | `.nullable().optional()` in `protocol.ts`                              | «rejects a pairing without the device name»                                                                                                                                                                               |
| M3a            | `remember` stores `Some(name.to_owned())` (untrimmed)                  | `a_station_paired_by_code_keeps_the_trimmed_name`, `pairing_keeps_the_name_the_host_stores`                                                                                                                               |
| M3b            | `remember` stores `None`                                               | the same two, `a_device_paired_before_the_name_gets_it_with_the_first_refresh`, and the ipc tests `a_paired_device_reaches_the_host_through_the_ipc_shapes` and `a_device_claims_a_code_through_the_ipc_shapes`           |
| M4             | drop `device_name: name,` from the new `DeviceConfig` in `keep_record` | `a_station_takes_the_name_the_office_gives_it`, `choosing_a_line_brings_a_rename_with_it`                                                                                                                                 |
| M5             | `&&` becomes `\|\|`                                                    | 8 `line` tests, including `a_station_takes_the_name_the_office_gives_it`                                                                                                                                                  |
| M6             | `DeviceState::status` returns `device_name: None`                      | `pairing_keeps_the_name_the_host_stores`, `a_device_paired_before_the_name_gets_it_with_the_first_refresh`, both ipc pairing tests, `a_station_paired_by_code_keeps_the_trimmed_name`, and the two rename tests in `line` |
| M8             | `deserialize_with` makes `deviceName` required (the old-file path)     | lib `a_file_from_before_the_device_name_still_loads`, `a_device_paired_before_the_name_gets_it_with_the_first_refresh`                                                                                                    |
| M11            | `claim` passes `""` as the name to `remember`                          | `a_station_paired_by_code_keeps_the_trimmed_name`                                                                                                                                                                         |
| M13            | the guard becomes `if false` (always write)                            | `a_refresh_that_finds_the_same_line_and_name_writes_nothing` (bytes or inode)                                                                                                                                             |
| T2             | `.min(1)` dropped from the TS schema                                   | «rejects a pairing with an empty device name»                                                                                                                                                                             |
| T3             | `.nullable()` dropped from the TS schema                               | «accepts a pairing whose device name is not known yet»                                                                                                                                                                    |

No mutant survived. Output files are under `/tmp/claude/t3/` (`mut-*.txt`), outside the repository.

## Concerns, none blocking

1. If the host ever returned an empty `name`, the shell would store `Some("")` and the strict TS schema would reject the status as `invalid_response`. The host validates names as 1-100 characters, so this is a protocol invariant and not reachable today. The plan says `Some(info.name)` and I kept it.
2. The new integration tests, like the existing `line`/`device` suites, run against a real local host with no overall time limit, so a host that never answers would hang them. Task 2's own tests that wait on a silent host do carry bounds. I did not change this.
3. The in-memory `Current::Paired` pairing is replaced only when the name or the line changed, as before. A refresh that fails (unreachable host) leaves the name untouched, which is the intended offline behaviour.
4. Not exercised: the Windows and Tauri webview runtime. Only host-side Rust and Vitest were run.

## Files changed

All under `apps/standalone/`:

- `src-tauri/src/device.rs`
- `src-tauri/src/device_config.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/line.rs`
- `src-tauri/tests/ipc.rs`
- `src-tauri/tests/claim.rs`
- `src-tauri/tests/device.rs`
- `src/host/protocol.ts`
- `test/support/fixtures.ts`
- `test/device.test.ts`
