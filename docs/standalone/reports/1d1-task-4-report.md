# Task 4 report — «Сброс подключения очищает локальные копии — `src-tauri`»

## What was implemented

- `LocalDb::clear_copies(&self) -> Result<(), LocalDbError>` (`apps/standalone/src-tauri/src/local_db.rs`):
  one `BEGIN IMMEDIATE` writer transaction that sets `PRAGMA defer_foreign_keys = ON`,
  reads every table name from `sqlite_master` (excluding `_sqlx_migrations` and
  `sqlite_*`), issues one `DELETE FROM "<table>"` per table (in `sqlite_master`
  name order, so foreign-key ordering does not matter because the deferred
  check only runs at commit), and commits.
- `device_forget` (`apps/standalone/src-tauri/src/lib.rs`) now also takes
  `tauri::State<'_, LocalDbState>`. If the local database is available it
  calls `clear_copies()` first and maps a failure to the `"storage"` string
  (via `DeviceError::Storage.code()`); only then does it call
  `DeviceState::forget()`. If the local database never opened
  (`LocalDbState::get()` is `Err`), clearing is skipped and forgetting
  proceeds, so a broken local database can never permanently block the reset
  screen.
- IPC contract unchanged: the webview still calls `device_forget` with no
  arguments and reads back `null` on success.
- Docs updated: `apps/standalone/AGENTS.md` (end of "Local database" section)
  and `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  §5.2, both exactly as specified in the brief.
- Controller amendment: reworded the "webview's reference sync is the only
  writer" sentence in both shell migrations' header comments
  (`0001_reference_data.sql`, `0002_sync_quarantine.sql`) to say the webview's
  reference sync writes the rows and `device_forget` (`LocalDb::clear_copies`)
  empties every table. Only that sentence's wording changed; SQL and all other
  comment text are byte-identical to before. Paragraphs were rewrapped to the
  same column width already used in each file (lines stayed in the same
  ~74–78-character range the files already used).

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies
```

Output:

```
cargo test: 1 errors, 0 warnings (1 crates)
error[E0599]: no method named `clear_copies` found for struct `LocalDb` in the current scope
   --> src-tauri/tests/local_db.rs:372:19
    |
372 |     assert_eq!(db.clear_copies().await, Ok(()));
    |                   ^^^^^^^^^^^^ method not found in `LocalDb`
```

Matches the brief's expected failure exactly.

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device
```

Output:

```
thread 'forgetting_the_device_clears_the_local_copies_first' panicked at src-tauri/tests/ipc.rs:382:5:
assertion `left == right` failed
  left: Ok(Null)
 right: Err(String("storage"))
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.04s
```

Matches the brief's expected failure exactly.

### GREEN

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies
```

Output:

```
cargo test: 1 passed, 8 filtered out (1 suite, 0.01s)
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device
```

Output:

```
cargo test: 1 passed, 7 filtered out (1 suite, 0.04s)
```

## Every verification command and result

| Command                                                                                                                             | Result                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                             | clean, no output                                                                                                                                   |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | "All matched files use Prettier code style!"                                                                                                       |
| `git diff --check`                                                                                                                  | clean, no output                                                                                                                                   |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                        | "cargo build (2 crates compiled)" / "Finished `dev` profile ... in 7.03s", 0 warnings                                                              |
| `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone...'`                                         | 4/4 tasks successful (only an unrelated `telemetry.vercel.com` sandbox network deny from turbo's own telemetry ping, no functional effect)         |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside sandbox)                                     | "224 passed (30 suites, 5.40s)" — exactly the expected 30 suites / 224 tests (222 + 2 new); `grep -i warning` over the full output matched nothing |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                         | "Test Files 29 passed (29)", "Tests 515 passed (515)"                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test -- --reporter=verbose`                                   | same 29/515, no stderr output, no `act(...)` warnings                                                                                              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                    | clean (`tsc -p tsconfig.json --noEmit`, no errors)                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                         | clean (`eslint .`, no errors)                                                                                                                      |
| `git diff --stat` (before commit)                                                                                                   | exactly the 8 files in scope: the 6 from the brief's Files section plus the 2 migration files from the amendment                                   |

## Files changed

- `apps/standalone/src-tauri/src/local_db.rs` — `LocalDb::clear_copies`.
- `apps/standalone/src-tauri/src/lib.rs` — `device_forget` clears copies first.
- `apps/standalone/src-tauri/tests/local_db.rs` — new test
  `clearing_the_copies_empties_every_table_but_the_migration_journal`.
- `apps/standalone/src-tauri/tests/ipc.rs` — new `run_raw` helper and test
  `forgetting_the_device_clears_the_local_copies_first`.
- `apps/standalone/AGENTS.md` — documents `clear_copies`/`device_forget` ordering.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — §5.2 note.
- `apps/standalone/src-tauri/migrations/0001_reference_data.sql` — comment reword (amendment).
- `apps/standalone/src-tauri/migrations/0002_sync_quarantine.sql` — comment reword (amendment).

## Deviations

- Controller amendment applied as instructed: reworded the "webview's reference
  sync is the only writer" sentence in both migration header comments to
  reflect that `device_forget` (`LocalDb::clear_copies`) now empties every
  table too. **This kind of after-the-fact rewording of an already-migrated
  file is safe only because no build has shipped and no real station database
  has these migrations applied yet; sqlx checksums each migration file, so
  this must never be done again once a release exists.** Rust tests were run
  after the edit (`cargo test --workspace`, 224 passed) — the migrator
  re-checksums the files at build/open time, so the green run proves the
  migrations still apply.
- No other deviations from the brief. Interfaces, names, error codes, and IPC
  contract are exactly as specified.

## Self-review findings

- Completeness: all of Steps 1–6 from the brief plus the controller amendment
  are done; nothing from the brief was skipped.
- Names: `clear_copies`, `device_forget(state, local)`, doc comments — all
  match the brief verbatim (the brief gave exact code, which was applied
  as-is).
- No overbuilding: `clear_copies` does exactly what's described (one
  transaction, tables from `sqlite_master`, no extra logging, no new public
  surface beyond what's asked). `device_forget`'s early-return-on-clear-failure
  and skip-when-unavailable branches are exactly the two cases the brief and
  constraints describe, nothing more.
- Tests verify behaviour, not implementation: the Rust test builds a
  cross-table foreign-key pair itself and shows clearing would fail without
  `defer_foreign_keys`; it also proves the migration journal and later-added
  tables survive/are covered. The IPC test proves the transaction rolls back
  whole (via a `BEFORE DELETE` trigger that raises `ABORT`) and that the
  pairing file survives a failed clear, then succeeds once the obstruction is
  removed.
- Output is pristine: no compiler warnings in `cargo check --all-targets` or
  `cargo test --workspace`; `cargo fmt --check` and `prettier --check` are
  clean; `git diff --check` found no whitespace issues; Cyrillic text in the
  new test code was checked byte-for-byte (`grep -n "Линия"`) and landed as
  real UTF-8, not `\uXXXX` escapes.
- Verified non-Rust checks were run even though the task is Rust-only, per the
  root AGENTS.md per-area table: `typecheck`, `lint`, and the full Vitest
  suite for `@markiro/standalone` all pass, confirming the migration comment
  edits did not disturb the webview's own migration-parity tests.

## Concerns

- The brief's Step 6 states the webview suite should show "29 файлов, 513
  тестов" ("TypeScript задача не меняет" — this task doesn't change
  TypeScript). The actual count on this branch, both before and after my
  changes (I touched zero `.ts`/`.tsx` files), is **29 files, 515 tests**.
  This is pre-existing state inherited from the already-committed tasks 1–3
  (HEAD `0b2019118`) — the plan document's expected count appears to be
  slightly stale relative to what actually landed earlier in the plan. It is
  not a regression from this task and every test passes; flagging it since
  the brief's exact number didn't match reality.
- Not verified (matches the plan's own stated scope limits, listed here for
  completeness, not newly discovered): the `tauri dev` window, a real host
  with a damaged/newer feed record, live-link retry behavior on two real PCs,
  `device_forget` on real Windows (DPAPI, a database file locked by another
  process), and the `standalone-windows-build` CI job (needs a push). None of
  these are exercised by any check available in this sandboxed, offline,
  single-worktree environment.

## Fix round 1

Commit `34b283cd5` on top of `d85df47fe`. The review found the production
code of task 4 correct; these four items address the tests and docs.

### Item 1 — the IPC rollback assertion could not fail

**Problem.** `clear_copies` deletes tables in `ORDER BY name`. The refusing
table was named `extra_kept`, which sorts _before_ `ref_lines`, `ref_org`,
`ref_site`, `sync_quarantine` and `sync_state`. Its `BEFORE DELETE` trigger
therefore aborted the transaction on the very first statement, before any
other table's delete had even run. `copies() == { "n": 3 }` (nothing changed)
would hold whether or not the rest of the deletes were wrapped in a real
transaction, because nothing else had been touched yet either way.

**Fix.** Renamed the table and trigger to `zz_kept`/`zz_kept_stays`
(`apps/standalone/src-tauri/tests/ipc.rs`), which sorts _after_ every real
copy table. Now `ref_lines`, `ref_org`, `ref_site`, `sync_quarantine` and
`sync_state` all get deleted for real before `zz_kept`'s delete aborts, so
the assertion only holds if those deletes are actually rolled back. Added an
ordering comment above the `run_raw` call explaining why the name was chosen,
in the style of the existing comment in `tests/local_db.rs` (`extra_holder`
sorting first for the FK-ordering test).

**Mutation check.** Temporarily changed `LocalDb::clear_copies` to run every
statement directly against `&self.writer` (no `BEGIN IMMEDIATE`/`tx`, so each
`DELETE` commits on its own), then ran:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device_clears_the_local_copies_first -- --nocapture
```

Result — the test failed, exactly as expected:

```
thread 'forgetting_the_device_clears_the_local_copies_first' panicked at src-tauri/tests/ipc.rs:395:5:
assertion `left == right` failed: the clearing rolled back whole
  left: Array [Object {"n": Number(1)}]
 right: Array [Object {"n": Number(3)}]
```

(`n = 1`: `ref_lines` and `sync_state` had really been deleted since they
auto-committed before `zz_kept`'s delete failed; only `zz_kept`'s own row
survived because its delete never went through.) Reverted the mutation
immediately afterward; `local_db.rs`'s final diff contains no trace of it
(confirmed with `git diff`). Re-ran the same test and the FTS5 test — both
green again.

### Item 2 — tables `sqlite_master` lists but a plain DELETE must not touch

**Problem.** `clear_copies` selected table names from `sqlite_master WHERE
type = 'table'`, which also lists a virtual table's shadow tables (FTS5:
`<name>_data`, `_idx`, `_content`, `_docsize`, `_config`). Deleting those
directly, instead of through the virtual table, corrupts the index.

**Fix.** Changed the query to `SELECT name FROM pragma_table_list WHERE
schema = 'main' AND type IN ('table', 'virtual') AND name <>
'_sqlx_migrations' AND name NOT GLOB 'sqlite_*' ORDER BY name`
(`apps/standalone/src-tauri/src/local_db.rs`). `pragma_table_list` tags a
virtual table's shadow tables `type = 'shadow'`, so restricting to `('table',
'virtual')` skips them automatically; the main virtual table itself (type
`virtual`) is still cleared, and through it SQLite maintains the shadow
tables correctly. `pragma_table_list` is available: the bundled SQLite via
`libsqlite3-sys 0.30.1` is recent enough (3.37+ per the review note, and this
crate is confirmed via `Cargo.lock`), so no "stop and report" was needed.
Updated `clear_copies`'s doc comment to describe the new source and the
shadow-table exclusion.

**Test.** Added `clearing_the_copies_leaves_a_virtual_table_usable`
(`apps/standalone/src-tauri/tests/local_db.rs`): creates `CREATE VIRTUAL
TABLE search USING fts5(body)` with one row via a raw connection (FTS5's own
`CREATE VIRTUAL TABLE` needs schema privileges the webview's statement rules
already forbid, so it's created the same way the file's other "a later
migration might add this" tables are), calls `clear_copies`, asserts the
table is empty, then inserts and queries it again through the normal
`db.transaction`/`db.query` paths to prove the index is still usable, not
just emptied.

**RED, before the fix** (temporarily reverted the query back to the old
`sqlite_master`-based one and added throwaway `eprintln!`s to surface the
otherwise-discarded sqlx error; both reverted immediately after, confirmed
with `git diff`):

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies_leaves_a_virtual_table_usable -- --nocapture
```

```
SCRATCH DEBUG query: Database(SqliteError { code: 1, message: "invalid fts5 file format (found 0, expected 4 or 5) - run 'rebuild'" })
thread 'clearing_the_copies_leaves_a_virtual_table_usable' panicked at src-tauri/tests/local_db.rs:425:10:
called `Result::unwrap()` on an `Err` value: StatementFailed
test result: FAILED. 0 passed; 1 failed; ...
```

This is the concrete corruption the review predicted (worded slightly
differently from "fts5: corruption found", but the same root cause: directly
wiping FTS5's shadow tables leaves its on-disk format in an invalid state).

**GREEN, after the fix:**

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline clearing_the_copies
```

```
test clearing_the_copies_leaves_a_virtual_table_usable ... ok
test clearing_the_copies_empties_every_table_but_the_migration_journal ... ok
test result: ok. 2 passed; 0 failed; ...
```

### Item 3 — unopened-database branch had no sandbox-safe test

Added `forgetting_the_device_without_a_local_database_still_forgets`
(`apps/standalone/src-tauri/tests/ipc.rs`), using `mock_app` (which wires
`LocalDbState::unavailable()`, unlike `mock_app_with`). It saves a genuine,
well-formed `DeviceConfig` on disk via `device_config::save` (not a
malformed one — this test is about the local-database-unavailable branch, not
the config-unreadable one already covered elsewhere), then calls
`device_forget` and asserts the answer is `Ok(Value::Null)` and
`device.json` no longer exists. Needs no host, so it runs inside the sandbox:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline forgetting_the_device
```

```
test forgetting_the_device_without_a_local_database_still_forgets ... ok
test forgetting_the_device_clears_the_local_copies_first ... ok
test result: ok. 2 passed; 0 failed; ...
```

### Item 4 — wording

- `apps/standalone/AGENTS.md` (end of "Local database" section): changed
  "there is nothing to clear" to "there is nothing **this app** can clear"
  (matching `lib.rs`'s own doc comment) and added "plan 1d3 revisits this
  before PIN and badge hashes land."
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` §5.2:
  added the same branch next to the `device_forget()` parenthetical — "если
  локальная база не открылась, для этого приложения очищать нечего — план
  1d3 пересмотрит это до того, как хеши PIN и бейджей лягут в локальную
  базу."

### Verification commands and results (fix round 1)

| Command                                                                                                                             | Result                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                             | clean, no output                                                                                                                            |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                        | "Finished `dev` profile ... in 5.55s", 0 warnings                                                                                           |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside sandbox)                                     | `cargo test: 226 passed (30 suites, 4.75s)` — 224 + 2 new tests; `grep -ci warning` over the full raw output (via `rtk proxy`) returned `0` |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | "All matched files use Prettier code style!"                                                                                                |
| `git diff --check`                                                                                                                  | clean, no output                                                                                                                            |
| `git diff --stat` (before commit)                                                                                                   | exactly the 5 files these four items touch: `local_db.rs`, `tests/local_db.rs`, `tests/ipc.rs`, `AGENTS.md`, the spec                       |

### Files changed (fix round 1)

- `apps/standalone/src-tauri/src/local_db.rs` — `pragma_table_list` instead
  of `sqlite_master`; updated doc comment.
- `apps/standalone/src-tauri/tests/local_db.rs` — new FTS5 regression test.
- `apps/standalone/src-tauri/tests/ipc.rs` — `zz_kept` rename + ordering
  comment; new sandboxed "local database unavailable" test; new imports
  (`markiro_proto::DeviceKind`, `device_config::{self, DeviceConfig}`,
  `secret_store::{ProtectedSecret, Scheme}`).
- `apps/standalone/AGENTS.md` — wording fix.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` —
  wording fix (§5.2).

### Deviations (fix round 1)

- None from the four items as specified. `pragma_table_list` was available
  as expected, so the "stop and report" branch of item 2 did not apply.
- Scope discipline: `apps/standalone/AGENTS.md` still says (unchanged) "The
  tables come from `sqlite_master`" one paragraph earlier than the sentence
  item 4 named. This became slightly imprecise once item 2 switched the
  implementation to `pragma_table_list`, but the coordinator's item 4 named
  only the "there is nothing to clear" sentence for that file (a different
  sentence), and the instructions were "these four items and nothing else."
  Left it as scoped; flagging it here in case a deliberate follow-up is
  wanted. (The `local_db.rs` doc comment right above the code, which item 2
  does own, was updated to say `pragma_table_list`.)

### Self-review (fix round 1)

- Each of the four items was implemented exactly as specified, with the
  mutation check (item 1) and a RED/GREEN pair (item 2, done for extra rigor
  though not explicitly requested) as evidence.
- No scratch/debug code left behind: `git diff` on `local_db.rs` shows only
  the intended `pragma_table_list` change and doc-comment update, nothing
  else.
- Names: `zz_kept`/`zz_kept_stays` are deliberately meaningless-but-sorts-last
  names, consistent with `extra_holder`/`extra_item`/`extra_kept`'s existing
  "scratch table" naming convention in these two test files.
- `git diff --stat` confirms only the 5 files these four items name were
  touched; `apps/station` and everything else untouched.

### Concerns (fix round 1)

- None beyond the AGENTS.md `sqlite_master` phrase noted under Deviations.
