# Plan РК, task 1 — report

Status: DONE (with one decision for the controller: migration ordering, below).
Commit: `53390e8ef` feat(standalone): the backup contract — migration 0011, proto backup shapes and fixtures, hello's restore epoch (branch claude/infra-rk, base 370ec784c). Worktree clean after the commit.

## What was done

Contract layer only: `host/migrations/0011_backups.sql` (`backup_settings`, `site.restore_epoch`, `site.facts_held_since`, `devices.known_blocks_epoch`); `proto/src/backup.rs` (all shapes, code lists); `codes::RESTORE_PENDING` (+ in `ALL`); `Hello.restore_epoch` (`skip_serializing_if`); host `hello` reads the epoch from `site` in the same query as `initialized`; `HostPaths::backups_dir()` created by `ensure`; 9 new fixtures + `error-codes.json`; webview `src/host/backups.ts`, `helloSchema.restoreEpoch` (optional uuid), `API_ERROR_CODES` + `errors.api.restore_pending`.

No restore code, no rollback path, nothing in the contract can lower a counter: the only counter-related data here are `facts_held_since` / `restore_epoch` / `known_blocks_epoch` markers; the counter rise is task 5/6.

## Migration numbering (investigated, sqlx 0.8.6, `sqlx-core/src/migrate/migrator.rs::run_direct`)

- `db::MIGRATOR = sqlx::migrate!("./migrations")`, default settings (`ignore_missing: false`, `locking: true`). Tree has 0001–0010 and 0012; 0011 is added.
- Fresh database: all apply in version order (0011 before 0012).
- Database that already has 0012 applied (made from the integration branch before РК): sqlx does NOT reject a lower, not-yet-applied version. `run_direct` (1) refuses only `Dirty` and `VersionMissing` (an applied version absent from the embedded set, `validate_applied_migrations`), (2) loops over ALL embedded migrations in version order and applies every one the `_sqlx_migrations` table lacks, failing only on checksum mismatch of an applied one (`VersionMismatch`). So 0011 is applied late, after 0012, with data kept. The "previously applied but missing" error would only appear if an applied migration were REMOVED from the tree — not the case here. 0012 is untouched.
- Proven by an extra test `a_database_that_already_has_0012_takes_0011_late` (builds a Migrator without version 11, runs it, checks 12 present/11 absent, sets `initialized_at`, then runs the full `MIGRATOR`: 0011 and 0012 both `success`, count equals the embedded count, `site` data kept, new columns NULL, `backup_settings` row `(NULL, 0)`). Note: the test builds `Migrator { migrations, ..Migrator::DEFAULT }` — those fields are `#[doc(hidden)]` and semver-exempt; if sqlx is upgraded the test may need a touch.
- Rule: nothing is installed anywhere (pilot not deployed), and even if some DB were created from the integration branch, 0011 is accepted out of order. No renumbering; the only forbidden thing is editing an applied migration. A later reviewer should know: `_sqlx_migrations` order on such a DB will be 0012 before 0011 (cosmetic).

## RED / GREEN

- RED proto: `cargo test … -p markiro-proto --test backup` → `E0432 unresolved import markiro_proto::backup`, `E0425 RESTORE_PENDING`, `E0609 restore_epoch` (file /tmp/claude/impl-rk-t1/red-proto.txt). The host (`backups_dir`) and Vitest REDs were not captured separately before implementation (tests and implementation were applied in one pass after the proto RED); the mutants below show each test failing on its guard.
- GREEN: proto 5+6+47 passed (`backup` 6, `fixtures` 47 incl. `the_error_code_fixture_lists_every_code`; plan said 40), `backup_schema` 5 passed (plan 4: +1 extra), Vitest `backups.test.ts` 8 tests (plan 6: +2 extra), with `protocol.test.ts`/`errors.test.ts` 270+ green, stderr empty.

## Mutants (all restored byte-identically: copy to /tmp/claude/impl-rk-t1/orig, `cmp` and sha256 equal after; Rust files touched)

| #       | Mutant                                                               | Test that failed                                                                                                                   |
| ------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| M1      | hello: `restore_epoch.filter(\|_\| false)`                           | backup_schema `hello_names_the_restore_epoch_only_once_there_is_one`                                                               |
| M2      | CHECK `BETWEEN 1 AND 261`                                            | `the_settings_table_holds_one_row_and_a_bounded_folder`                                                                            |
| M2b     | CHECK `BETWEEN 0 AND 260`                                            | same                                                                                                                               |
| M2c     | `CHECK (id > 0)`                                                     | same                                                                                                                               |
| M3      | drop `deserialize_with = "Option::deserialize"`                      | proto `the_settings_update_is_strict_and_clears_with_null`                                                                         |
| M4      | drop `restoreEpoch` in helloSchema                                   | vitest `read hello with and without the restore epoch`                                                                             |
| M4b     | `restoreEpoch: z.string()` (not uuid)                                | same                                                                                                                               |
| M5      | `RESTORE_PENDING` out of `codes::ALL`                                | proto `a_held_host_names_its_stations…`                                                                                            |
| M6      | Hello.restore_epoch without `skip_serializing_if`                    | `hello_carries_the_restore_epoch_only_after_a_restore`                                                                             |
| M7      | `ensure` without `backups_dir()`                                     | `the_backups_folder_is_part_of_the_data_folder`                                                                                    |
| M8      | BackupSettingsUpdate without `deny_unknown_fields`                   | `the_settings_update_is_strict_and_clears_with_null`                                                                               |
| M9      | KnownBlocksRequest without `deny_unknown_fields`                     | `known_blocks_round_trip_and_the_request_is_strict` (survived at first; test strengthened with a top-level extra key, then killed) |
| M9b     | KnownBlock without `deny_unknown_fields`                             | same                                                                                                                               |
| M10/M11 | `TIMEOUT = "timed_out"` / `MISSING` dropped from `dir_problems::ALL` | `the_code_lists_match_their_fixture`                                                                                               |
| M12     | `restore_pending` out of error-codes.json                            | proto fixtures `the_error_code_fixture_lists_every_code`                                                                           |
| M13     | knownBlocksRequestSchema not strict                                  | vitest `read the known blocks…` (after strengthening)                                                                              |
| M14     | knownBlockSchema not strict                                          | same                                                                                                                               |
| M15     | extension without `.min(0).max(9)`                                   | new test `send only blocks that are a block…`                                                                                      |
| M16     | `fromSerial` without `.nonnegative()`                                | same                                                                                                                               |
| M17     | block id `z.string()` instead of uuid                                | same                                                                                                                               |
| M18     | backupSettingsUpdateSchema not strict                                | `send the settings strictly…`                                                                                                      |
| M19     | `restore_pending` out of `API_ERROR_CODES`                           | `errors.test.ts` `list exactly the host's error codes`                                                                             |
| M20     | ru.json key renamed                                                  | `errors.test.ts` `have a text for every code…`                                                                                     |

## Checks

- `cargo fmt --check` clean (after `cargo fmt` of my two test files); `cargo check -p markiro-host -p markiro-proto --all-targets` 0 warnings.
- `typecheck`, `lint` clean. Prettier gate: live proof with a mis-formatted scratch file (exit 1, deleted), then clean on all changed JSON/TS/TSX files (one fix to `backups.test.ts` applied). `git diff --check` clean. `grep '\u04'` finds only `pairing-code.ts:66` (and old pairing/facts fixtures with `\u` that are not mine); none in files I wrote.
- Full Vitest: 101/102 files, 3026/3031 tests; 5 failures in `template-editor.test.tsx` = the known 5 s timeouts under load (5.4–5.8 s); re-run alone with `--testTimeout=60000`: 97/97 pass. Tests added here are pure schema tests (no React/effects), so the delayed-`setImmediate` stand was not applicable.
- ONE final unsandboxed `cargo test --offline --locked --workspace`: exit 0, 55 `test result` lines, 824 passed, 0 failed.

## Anchor adaptations

1. `server.rs::hello`: the tree reads `initialized` via `crate::db::is_initialized(&state.pool)`, the plan anchors a different shape. Applied by meaning: replaced with the plan's single `SELECT initialized_at IS NOT NULL, restore_epoch FROM site` query (one snapshot); `db::is_initialized` is left in place (still public, unused by hello).
2. `hello-restored.json`: `protocol` is `3` (the tree's `PROTOCOL_VERSION` and `hello.json` are 3), not the plan's 2.
3. Test totals differ from the plan: fixtures.rs has 47 tests here (plan 40) — the tree has more fixtures.
   All other fragments (lib.rs ×4, config.rs, errors.ts, protocol.ts, ru.json, error-codes.json) matched exactly once.

## Beyond the brief

Tests added: out-of-order migration test; top-level extra key rejected in KnownBlocksRequest (Rust and Zod); Zod rejection of a non-uuid `restoreEpoch`; Zod block field bounds (extension 0–9, non-negative integer serials, uuid id). The rules file `rk-implementer-rules.md` opens with text copied from another plan (station local migration 0006…); I followed the working/evidence rules and ignored that scoping text.

## Concerns / notes for later tasks

- Zod `knownBlockSchema.extension` max 9 while Rust `extension: u8` has no upper bound at the proto layer; the host route (task 6) must return `range_invalid` for extensions outside the counters.
- `restore_epoch` is stored as text; the Zod side requires a uuid, so task 5 must write a UUID (v4) there.
- Not verified here (as the plan states): anything Windows/UNC/service-related; this task has none.
