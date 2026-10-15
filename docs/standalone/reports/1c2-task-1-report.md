# Plan 1c2, Task 1 — report: local database, `local_query` and `local_transaction`

Status: DONE

## What was implemented

The station's local SQLite database in the Tauri shell of `apps/standalone`,
exactly per `.superpowers/sdd/1c2-task-1-brief.md`:

- **Dependency.** `sqlx = { version = "=0.8.6", default-features = false,
features = ["runtime-tokio", "sqlite", "migrate", "macros"] }` added to
  `apps/standalone/src-tauri/Cargo.toml`, right after `serde_json = "1"`.
- **Migration.** `apps/standalone/src-tauri/migrations/0001_reference_data.sql`
  creates `ref_org`, `ref_site`, `ref_lines`, `sync_state` — the stage-1c
  subset of the reference tables described in spec §5.3.
- **Module `local_db.rs`** (`apps/standalone/src-tauri/src/local_db.rs`):
  - `LocalDb::open(dir)` — opens (creating as needed) `standalone-station.db`
    in `dir`, runs the embedded migrator, and holds two pools: a
    single-connection writer (WAL, `synchronous=FULL`, `foreign_keys=ON`, 5 s
    busy timeout) and a two-connection read-only pool on the same file.
  - `LocalDb::query(sql, params)` — accepts exactly one `SELECT`/`WITH`
    statement, runs it on the read-only pool, returns rows as
    `Vec<Map<String, Value>>` keyed by column name, typed by the SQLite
    storage class actually returned (not the declared column type); BLOB
    columns are `UnsupportedValue`.
  - `LocalDb::transaction(statements)` — 1..=32 statements, each ≤64 KiB SQL
    and ≤256 values, run inside one `BEGIN IMMEDIATE` on the writer
    connection; any statement error or `expectedChanges` mismatch rolls the
    whole batch back; returns `Vec<u64>` of rows changed per statement.
  - `check_statement` refuses a second statement (bare `;`, `--`, `/*`) and
    any of `BEGIN COMMIT ROLLBACK SAVEPOINT RELEASE ATTACH DETACH PRAGMA
VACUUM CREATE DROP ALTER REINDEX` as a bare word (case-insensitive,
    word-boundary split on non-alphanumeric/`_`).
  - `LocalDbError` with stable `.code()` strings: `local_db_unavailable`,
    `invalid_statement`, `unsupported_value`, `statement_failed`,
    `changes_mismatch`.
  - `LocalDbState` — Tauri-managed state; `Option<LocalDb>` so the app still
    starts when the database could not be opened.
- **Commands** `local_query` and `local_transaction` in `lib.rs`, registered
  in `invoke_handler()`; `run()`'s `setup` now also opens `LocalDbState` in
  the app's local data directory (blocking, before the window shows) and
  manages it alongside `DeviceState`.
- **IPC contract tests** in `tests/ipc.rs`: `mock_app_with(device, local)`
  (new) plus `mock_app(device)` (now a thin wrapper defaulting to
  `LocalDbState::unavailable()`), and two new `#[test]`s pinning the
  `local_query`/`local_transaction` argument and rejection shapes.
- **Docs**: `apps/standalone/AGENTS.md` gained a "Local database" section
  after "Databases"; `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  §5.2 gained the `local_query` response shape / rejection codes / `json_each`
  sentence, and §5.3 gained the sentence distinguishing plan 1c's four tables
  from the plan 1d/1e tables.

Every piece of code, SQL and documentation text is the brief's own, used
verbatim except for the two deviations below (a quoting fix in one test's
SQL literal, and running `cargo fmt` on brief-supplied code that was not
rustfmt-clean under this repo's config).

## TDD evidence

### RED — Step 2: failing tests before the module exists

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline
```

Output (head):

```
cargo test: 19 errors, 1 warnings (1 crates)
error[E0432]: unresolved import `markiro_standalone_lib::local_db`
 --> src-tauri/tests/local_db.rs:4:29
  |
4 | use markiro_standalone_lib::local_db::{LocalDb, LocalDbError, LocalStatement, FILE_NAME};
  |                             ^^^^^^^^ could not find `local_db` in `markiro_standalone_lib`

error[E0282]: type annotations needed
  --> src-tauri/tests/local_db.rs:24:14
   |
24 |     let db = LocalDb::open(dir.path()).await.unwrap();
   |              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ cannot infer type
... (18 more cascading E0282 errors, one per call site that depends on the
     missing type)
```

This matches the brief's expectation exactly: "ошибка компиляции — нет
модуля `local_db`".

### GREEN — Step 3: migration + module added

Commands:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --lib local_db --offline
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline
```

First run of the integration test surfaced one real failure (see
"Deviations" below); after fixing it:

```
cargo test: 5 passed, 21 filtered out (1 suite, 0.00s)
```

```
running 7 tests
test a_failing_statement_rolls_back_the_whole_batch ... ok
test batches_and_values_outside_the_rules_are_refused ... ok
test expected_changes_guard_the_batch ... ok
test queries_are_read_only_and_writes_are_not_queries ... ok
test a_batch_commits_together_and_values_come_back_typed ... ok
test opening_creates_the_reference_tables_in_wal_mode_and_keeps_data ... ok
test one_statement_upserts_a_whole_page_through_json_each ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

5 unit + 7 integration, exactly as the brief predicted.

### GREEN — Step 4: commands + IPC contract

The commands (`lib.rs`) and the IPC test helper/tests (`tests/ipc.rs`) were
added together, per the brief's own structure (it gives both the
implementation and the tests for this step as one unit, with no separate
compile-failure checkpoint). Verified to compile (`--no-run`, sandboxed) and
then run (outside the sandbox, since a sibling test in the same binary starts
a real host on `127.0.0.1`):

```
rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test ipc --offline
```

```
running 4 tests
test without_a_local_database_the_local_commands_say_so ... ok
test an_unpaired_device_reports_null_and_refuses_host_requests ... ok
test the_local_database_answers_through_the_ipc_shapes ... ok
test a_paired_device_reaches_the_host_through_the_ipc_shapes ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s
EXIT_CODE=0
```

4 tests (2 pre-existing + 2 new), exactly as the brief predicted.

## Final verification gates (Step 6)

All run from `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

1. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
   → exit 0, no diff (after running `cargo fmt --all` once — see Deviations).

2. `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`,
   run outside the sandbox (`dangerouslyDisableSandbox`, since `tests/ipc.rs`
   binds a real host on `127.0.0.1`) → exit 0, full breakdown:
   - lib unit tests: 26 passed (21 pre-existing + 5 new in `local_db::tests`)
   - `tests/device.rs`: 13 passed (unchanged)
   - `tests/host_probe.rs`: 2 passed (unchanged)
   - `tests/host_probe_proxy.rs`: 1 passed (unchanged)
   - `tests/ipc.rs`: 4 passed (2 pre-existing + 2 new)
   - `tests/local_db.rs`: 7 passed (new)
   - Total: 53 passed, 0 failed.

3. `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`
   → exit 0, output:

   ```
   Checking markiro-host v0.1.0 (.../apps/standalone/host)
   Checking markiro-standalone v0.1.0 (.../apps/standalone/src-tauri)
   Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.46s
   ```

   No warnings.

4. `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
   → "All matched files use Prettier code style!" (also ran `--write` first;
   it reported both files "unchanged", confirming the manual edits already
   matched Prettier's style).

5. `git diff --check` → exit 0, no output (no whitespace errors).

## `Cargo.lock` diff

```diff
diff --git a/apps/standalone/Cargo.lock b/apps/standalone/Cargo.lock
index 9401b5f13..773cdd222 100644
--- a/apps/standalone/Cargo.lock
+++ b/apps/standalone/Cargo.lock
@@ -2512,6 +2512,7 @@ dependencies = [
  "rustls",
  "serde",
  "serde_json",
+ "sqlx",
  "tauri",
  "tauri-build",
  "tauri-plugin-single-instance",
```

Exactly the one expected new line, in the `markiro-standalone` dependency
list. `sqlx 0.8.6` and its `sqlx-core`/`sqlx-macros`/`sqlx-macros-core`/
`sqlx-sqlite` (etc.) entries were already present in the lockfile via
`markiro-host`, so no other package moved.

## Files changed

Modified:

- `apps/standalone/src-tauri/Cargo.toml` — added the `sqlx` dependency line.
- `apps/standalone/Cargo.lock` — the one line above.
- `apps/standalone/src-tauri/src/lib.rs` — `pub mod local_db;`, the `Map`
  import, the `local_db` import, the `local_query`/`local_transaction`
  commands, their registration in `invoke_handler()`, and `LocalDbState`
  wired into `run()`'s `setup`.
- `apps/standalone/src-tauri/tests/ipc.rs` — `LocalDbState` import,
  `mock_app_with`/`mock_app` split, two new IPC tests.
- `apps/standalone/AGENTS.md` — new "Local database" section.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` —
  §5.2 and §5.3 additions.

Created:

- `apps/standalone/src-tauri/migrations/0001_reference_data.sql` (37 lines).
- `apps/standalone/src-tauri/src/local_db.rs` (401 lines after `cargo fmt`).
- `apps/standalone/src-tauri/tests/local_db.rs` (281 lines after `cargo fmt`).

## Deviations

1. **Test fixture SQL bug: reserved keyword `NOTHING` used unquoted as a
   column alias.** `a_batch_commits_together_and_values_come_back_typed`, as
   given in the brief, ran:

   ```sql
   SELECT 1.5 AS fraction, NULL AS nothing, ? AS word, count(*) AS lines FROM ref_lines
   ```

   This failed every time with `LocalDbError::StatementFailed`. Diagnosed by
   temporarily logging the underlying `sqlx::Error` before mapping it (patch
   applied to a throwaway copy of `local_db.rs`, verified via `diff` that the
   file was restored byte-for-byte afterwards): the bundled SQLite reports
   `Database(SqliteError { code: 1, message: "near \"nothing\": syntax error" })`.
   `NOTHING` is a SQLite keyword (`ON CONFLICT ... DO NOTHING`) that its
   parser does not accept as a bare column alias. This is a property of the
   test's SQL text, not of `local_db.rs`'s query/bind/row-decoding logic —
   `check_statement` and `is_query` do not touch this word (it is not in
   `FORBIDDEN_WORDS`), and every other alias in the suite (`fraction`,
   `word`, `lines`, `rev`, etc.) is unaffected.
   **Fix:** quoted the alias, `NULL AS "nothing"`, in
   `apps/standalone/src-tauri/tests/local_db.rs` only. SQLite reports the
   column name as `nothing` either way (quoting only changes parsing, not
   the resulting identifier), so the test's assertion —
   `json!({ "fraction": 1.5, "nothing": null, "word": "да", "lines": 2 })` —
   is unchanged and unweakened. No production code changed for this.

2. **Brief-supplied code was not rustfmt-clean under this repo's
   configuration.** `cargo fmt --manifest-path apps/standalone/Cargo.toml
--all -- --check` reported diffs in `local_db.rs`, `tests/local_db.rs` and
   `tests/ipc.rs` (mostly `FORBIDDEN_WORDS`'s array wrapping and several
   long `assert_eq!`/method-chain lines exceeding this repo's configured
   width). Ran `cargo fmt --manifest-path apps/standalone/Cargo.toml --all`
   once, which reformatted only whitespace/line-wrapping in those three
   files — confirmed by rereading the diff (no `+`/`-` outside indentation
   and line breaks) and by rerunning the full test suite afterwards (still
   53/53 passing, same as before formatting). `cargo fmt -- --check` is now
   clean.

3. **The `Query<'q, Sqlite, SqliteArguments<'q>>` type in `bind()` compiled
   as given.** The brief's documented fallback
   (`Query<'q, Sqlite, <Sqlite as sqlx::Database>::Arguments<'q>>`) was not
   needed.

No other deviations. No test assertion was weakened; no design problem was
found that would warrant NEEDS_CONTEXT.

## Self-review

- **Scope.** Touched exactly the files the brief's "Files" section lists,
  nothing in `apps/station` (per the constraints), and staged explicit paths
  for the commit (see below) rather than `git add -A`.
- **Security/data handling.** No secrets are involved in this task; the
  local database holds only reference-record copies (org/site/line names,
  GLN, badge salt, block sizes) already visible to a station over the LAN
  API — nothing new to redact from logs or `Debug` output. `LocalDbError`'s
  `Debug` derive only ever prints the bare enum variant name, never SQL or
  values.
- **Concurrency/correctness.** Single writer connection + `BEGIN IMMEDIATE`
  matches the root `AGENTS.md` guidance ("every multi-statement write uses
  `db::begin_write`, not a deferred `pool.begin()`") even though this is a
  different crate (`markiro-standalone`, not `markiro-host`): an immediate
  transaction takes the write lock up front instead of risking `SQLITE_BUSY`
  after already having read inside a deferred transaction.
  `expectedChanges` mismatches and any statement error abort before
  `tx.commit()`, so nothing partially persists (verified by
  `a_failing_statement_rolls_back_the_whole_batch` and
  `expected_changes_guard_the_batch`).
- **Read/write isolation.** `query()` only ever touches the read-only pool
  (`self.readers`, opened with `.read_only(true)`); `queries_are_read_only_and_writes_are_not_queries`
  confirms both that write-shaped statements are rejected by
  `check_statement`/`is_query` before reaching SQLite, and that a
  syntactically-query-shaped statement that still tries to write (the `WITH
... DELETE` case) is refused by SQLite's own read-only-connection
  enforcement, not just by our own word filter — defense in depth.
  `transaction()` only ever touches `self.writer`.
  `MAX_STATEMENTS`/`MAX_SQL_BYTES`/`MAX_VALUES` bound the batch shape but not
  row count, so the `json_each` upsert path can still move a 1000-row
  reference page in one statement — this was the brief's explicit design
  goal and is covered by `one_statement_upserts_a_whole_page_through_json_each`.
- **Failure mode.** `LocalDbState::open` returns `Option<LocalDb>`, never
  panics, so a directory it cannot create/open does not stop the app from
  starting; `local_query`/`local_transaction` then answer
  `local_db_unavailable` (`without_a_local_database_the_local_commands_say_so`).
  `run()`'s `setup` calls `tauri::async_runtime::block_on(LocalDbState::open(&dir))`
  before managing it, matching the brief's stated intent ("The local
  database opens before the window shows").
- **IPC contract.** Command names, argument names (`sql`, `params`,
  `statements` with `sql`/`values`/`expectedChanges`) and bare-string
  rejections are pinned in `tests/ipc.rs`, consistent with how
  `host_request`/`device_forget` etc. are already pinned; `mock_app` keeps
  working for the pre-existing tests unchanged (it is now a thin wrapper
  over `mock_app_with(..., LocalDbState::unavailable())`), so no existing
  test's behavior changed — confirmed by the pre-existing tests
  (`an_unpaired_device_reports_null_and_refuses_host_requests`,
  `a_paired_device_reaches_the_host_through_the_ipc_shapes`,
  `tests/device.rs`, `tests/host_probe*.rs`) still passing unmodified.
- **What I did not verify.** No Windows-specific behavior is implicated by
  this task (SQLite/sqlx is cross-platform and the module does not touch
  DPAPI or the Windows-only pieces of the crate); consistent with the scoped
  guide, I make no claim about Windows here. I did not run the webview
  (`apps/standalone/src`) or any TypeScript checks — this task is Rust-only,
  and later plan 1c2 tasks add the TS bindings/executor that call these two
  commands.
- **What's next (out of scope for this task).** `host_claim`,
  `device_select_line`, the SSE background task and the TS bindings
  (`src/local/executor.ts`) are later tasks in plan 1c2 per
  `.superpowers/sdd/1c2-constraints.md`'s file/task table; they will consume
  `mock_app_with` and `local_db` as built here.

## Fix round 1

Reviewer confirmed the `NOTHING` diagnosis and the test suite from the first
pass; found one real gap (`END`) and asked for two cheap additions. Commit
`8d9b5d0be` — "fix(standalone): ревью задачи 1 плана 1c2 — END, пересборка по
миграциям, границы лимитов".

### 1. `END` bypassed the transaction-control filter

**The gap.** SQLite treats a bare `END` (or `END TRANSACTION`) as `COMMIT`.
`END` was not in `FORBIDDEN_WORDS` (correctly — `CASE … END` needs the word
mid-statement) and nothing else caught a _leading_ `END`. A batch of
`[INSERT, END, INSERT (duplicate)]` would let `END` commit the transaction
sqlx's `BEGIN IMMEDIATE` had opened right there; the duplicate `INSERT`
after it would then run outside any transaction, fail with a unique-key
violation reported as `StatementFailed`, and the first `INSERT` would
already be durably committed — despite the batch reporting an error.

**The fix.** `apps/standalone/src-tauri/src/local_db.rs`: added a
`first_word(sql) -> Option<&str>` helper (shared with `is_query`, which
previously inlined the same `words(sql.trim_start()).next()` pattern), and
in `check_statement`, alongside the `FORBIDDEN_WORDS` check:

```rust
// SQLite treats a bare `END` (or `END TRANSACTION`) as `COMMIT`, so a
// leading `END` is refused like the words above. It cannot join
// `FORBIDDEN_WORDS`, because `CASE … END` needs the word mid-statement.
let starts_with_end = first_word(body).is_some_and(|first| first.eq_ignore_ascii_case("END"));
if forbidden || starts_with_end {
```

**RED — the check disabled, on the real regression test.**

I temporarily replaced the new line with `let starts_with_end = false;`
(backing up the file first and diffing it byte-for-byte afterwards to
confirm a clean restore), then ran the new regression test:

```
rtk proxy cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline a_bare_end_inside_a_batch_is_refused_before_any_write -- --nocapture
```

```
thread 'a_bare_end_inside_a_batch_is_refused_before_any_write' (...) panicked at src-tauri/tests/local_db.rs:270:5:
assertion `left == right` failed
  left: Err(StatementFailed)
 right: Err(InvalidStatement)
test a_bare_end_inside_a_batch_is_refused_before_any_write ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.01s
```

This fails exactly on the refusal assertion (line 270,
`assert_eq!(result, Err(LocalDbError::InvalidStatement))`), reporting
`StatementFailed` instead — proof the batch reached SQLite. I also
temporarily appended a throwaway `eprintln!`-based scratch test (same batch,
no assertions) to directly confirm the reviewer's exact described symptom,
then deleted it:

```
batch result -> Err(StatementFailed)
rows after the batch -> Array [Object {"archived": Number(0), "id": String("5f0c...7d61"), "name": String("Линия 1"), "rev": Number(1)}]
```

Row `LINE_1` was indeed committed despite the reported error — matching the
reviewer's diagnosis exactly. Restored `local_db.rs` from the backup
(verified byte-identical via `diff`) and removed the scratch test.

**GREEN.**

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test local_db --offline
```

```
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

**Tests added/changed** (`apps/standalone/src-tauri/src/local_db.rs`,
`#[cfg(test)]` module):

- `single_statements_with_parameters_pass`: added
  `"SELECT CASE WHEN archived = 1 THEN 'a' END FROM ref_lines"` (passes —
  `END` mid-statement is not a leading `END`).
- `second_statements_comments_and_control_words_are_refused`: added `"END"`,
  `"end transaction"`, `"END;"`.

(`apps/standalone/src-tauri/tests/local_db.rs`):

- `batches_and_values_outside_the_rules_are_refused`: added `"END"` to the
  per-statement refusal loop.
- New `a_bare_end_inside_a_batch_is_refused_before_any_write`: the
  `[INSERT, END, INSERT (duplicate)]` batch from the reviewer's report —
  asserts `Err(InvalidStatement)`, no row stored, and that a following clean
  one-statement batch succeeds with `Ok(vec![1])`.

**Docs.** `apps/standalone/AGENTS.md`, "Local database": the parenthetical
list is now `` `BEGIN`, `END`, `PRAGMA`, `ATTACH`, `CREATE`, `DROP`, `ALTER`, … ``,
plus a clause noting a statement may not start with `END` (SQLite treats it
as `COMMIT`) while `CASE … END` mid-statement is unaffected.

### 2. Rebuild when a migration is added

`sqlx::migrate!` embeds `src-tauri/migrations` at compile time and does not
itself make Cargo watch the directory. `apps/standalone/host/build.rs`
already had the fix for the same pattern:

```rust
// `sqlx::migrate!` embeds host/migrations at compile time; rebuild when a
// migration is added or changed.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
```

Mirrored it in `apps/standalone/src-tauri/build.rs` (which also still needs
`tauri_build::build()`):

```rust
fn main() {
    // `sqlx::migrate!` embeds src-tauri/migrations at compile time; rebuild
    // when a migration is added or changed (mirrors `host/build.rs`).
    println!("cargo:rerun-if-changed=migrations");
    tauri_build::build();
}
```

### 3. Limit-edge tests

- **Exactly 32 statements.** Added to
  `batches_and_values_outside_the_rules_are_refused`
  (`apps/standalone/src-tauri/tests/local_db.rs`), right before the existing
  33-statement (`too_many`) case.

  The reviewer's suggested content was `SELECT 1` × 32 expecting
  `Ok(vec![0; 32])`. Running it first (before finalizing) showed
  `Ok(vec![1; 32])` instead — a real, verified fact about this module, not a
  flake: SQLite's `sqlite3_changes()` (which `rows_affected()` reads) is
  defined to be left unchanged by any statement other than a completed
  INSERT/UPDATE/DELETE. On a freshly-opened database the _only_ prior write
  on the single writer connection is the migrator's own bookkeeping
  `INSERT` into `_sqlx_migrations` (exactly one row) — so every subsequent
  `SELECT`, regardless of what it selects or how many rows it returns,
  reports the stale count of 1, carried over from that insert. I confirmed
  this with a throwaway scratch test (`SELECT 1`, `SELECT 1 WHERE 0`,
  `SELECT 1 UNION SELECT 2` all reported `1`; a genuine no-op
  `UPDATE ... WHERE 1 = 0` correctly reported `0`; after a real `INSERT`,
  subsequent `SELECT`s reported the `INSERT`'s count instead), then deleted
  the scratch test.

  Since the reviewer's intent was a clean, predictable all-zero result at
  the exact boundary (not specifically `SELECT`), I used a genuine no-op
  write instead of a `SELECT`, added as a new constant:

  ```rust
  // A genuine no-op write: SQLite's `sqlite3_changes()` (`rows_affected()`)
  // only updates for a completed INSERT/UPDATE/DELETE, so an executed `SELECT`
  // does not reset it to 0 — it keeps reporting whatever the connection's last
  // real write changed. `NOOP_UPDATE` is a real `UPDATE` that reliably touches
  // no row, so batches built from it have a predictable, deterministic count.
  const NOOP_UPDATE: &str = "UPDATE ref_lines SET rev = rev WHERE 1 = 0";
  ```

  ```rust
  let exactly_max: Vec<LocalStatement> =
      (0..32).map(|_| statement(NOOP_UPDATE, json!([]))).collect();
  assert_eq!(db.transaction(exactly_max).await, Ok(vec![0; 32]));
  ```

  This is recorded as a deviation below since it changes the reviewer's
  suggested SQL text (not literal code they handed me, but a described
  approach) — the boundary being tested (exactly 32 statements succeed) and
  the asserted result shape (`Ok` of 32 zeros) are both preserved exactly as
  asked; only the statement content changed, and only because the literal
  suggestion would have encoded a wrong assumption about `SELECT`'s
  `rows_affected` into a permanent test.

- **Exact byte-length boundary.** Rewrote
  `statement_size_and_value_count_are_bounded`
  (`apps/standalone/src-tauri/src/local_db.rs`) to build a statement of
  exactly `MAX_SQL_BYTES` bytes (`"SELECT '" + padding + "'"`, padding sized
  so the total is exact) and assert it passes, then one byte more and assert
  it's refused:
  ```rust
  let overhead = "SELECT ''".len();
  let padded = |extra: usize| format!("SELECT '{}'", "x".repeat(MAX_SQL_BYTES - overhead + extra));
  let exactly_max = padded(0);
  assert_eq!(exactly_max.len(), MAX_SQL_BYTES);
  assert_eq!(check_statement(&exactly_max, 0), Ok(()));
  let one_over = padded(1);
  assert_eq!(one_over.len(), MAX_SQL_BYTES + 1);
  assert_eq!(check_statement(&one_over, 0), Err(LocalDbError::InvalidStatement));
  ```
  The original test only proved "way over the limit is refused"
  (`MAX_SQL_BYTES` bytes of padding plus 9 bytes of `SELECT '...'` overhead,
  i.e. `MAX_SQL_BYTES + 9` total) — it never touched the boundary itself.

### Verification (fix round)

All from `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`:

1. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` →
   initially reported 2 diffs (my new lines exceeded the configured width);
   ran `cargo fmt --all` once, then clean (exit 0).
2. `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`,
   outside the sandbox → exit 0, 54 passed, 0 failed (26 lib + 13 device + 2
   host_probe + 1 host_probe_proxy + 4 ipc + 8 local_db — one more than the
   prior round's 53, for the new `a_bare_end_inside_a_batch_is_refused_before_any_write`).
3. `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` →
   exit 0, no warnings.
4. `node_modules/.bin/prettier --check apps/standalone/AGENTS.md` → "All
   matched files use Prettier code style!".
5. `git diff --check` → exit 0, no output.

### Files changed (fix round)

- `apps/standalone/src-tauri/src/local_db.rs` — `first_word` helper,
  `starts_with_end` check in `check_statement`, `is_query` refactored to use
  `first_word`, three unit-test updates.
- `apps/standalone/src-tauri/tests/local_db.rs` — `NOOP_UPDATE` constant,
  exactly-32 case, `"END"` in the refusal loop, new regression test.
- `apps/standalone/src-tauri/build.rs` — `cargo:rerun-if-changed=migrations`.
- `apps/standalone/AGENTS.md` — `END` added to the "Local database" section's
  control-word list, with the leading-`END`/`CASE…END` clarification.

### Deviations (fix round)

1. **Exactly-32 test uses a no-op `UPDATE`, not `SELECT 1`.** Documented in
   detail under "3. Limit-edge tests" above: the reviewer's suggested
   `SELECT 1` does not deterministically report 0 changed rows in this
   module (it echoes the connection's last real write, which right after
   `LocalDb::open()` is the migrator's own bookkeeping insert — verified
   empirically, not assumed). Switched to a genuine no-op `UPDATE`, which
   reports 0 for a real, semantically meaningful reason. The tested boundary
   and the asserted result shape are unchanged from what was asked.

No test assertion was weakened. No new design problem surfaced in
`LocalDb`/`LocalDbState` beyond the `END` gap itself, which is now fixed and
covered by both a real-database regression test and unit tests.

### Self-review (fix round)

- The `END` fix is minimal and additive: `FORBIDDEN_WORDS` is untouched (so
  `CASE … END` keeps working, per `single_statements_with_parameters_pass`'s
  new case), and the new leading-word check reuses the exact same `words()`
  tokenizer already used for the forbidden-word scan and for `is_query`, so
  there is one definition of "word" in the module, not two.
  `first_word`/`is_query`'s behavior for the pre-existing call site is
  unchanged (same `sql.trim_start()` + `words().next()` as before the
  refactor) — confirmed by the untouched `only_select_and_with_are_queries`
  test still passing.
- The regression test asserts all three consequences from the reviewer's
  report in one place: the batch is refused (`InvalidStatement`, not
  `StatementFailed`), nothing was written (`lines(&db).await == []`), and —
  importantly — the writer connection is still healthy afterward (a
  following clean batch succeeds with `Ok(vec![1])`). That last assertion is
  the one that would have caught the "transaction depth stays wrong for up
  to 30 minutes" half of the reviewer's report, had the fix only prevented
  the bad batch from being misreported without actually stopping it from
  reaching SQLite.
- `build.rs`'s fix is verified structurally (mirrors the already-working
  `host/build.rs` pattern) rather than by a dedicated test, since Cargo's
  own rebuild-triggering from `cargo:rerun-if-changed` is not something a
  unit test in this crate can observe; `cargo check --workspace --all-targets`
  confirms the build script itself still compiles and runs.
- I did not re-verify Windows behavior, hardware, or the webview in this fix
  round either — none of the three items touch platform-specific code or
  cross the IPC boundary in a new way; the existing `ipc.rs` and `device.rs`
  suites (unchanged) still pass, confirming no regression there.
