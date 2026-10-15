# Plan 1c2 — final-review follow-up: report

Status: DONE. All items A–L applied as one commit on top of `6065521be`.
Commit: `65cb2602e` — "fix(standalone): итоговое ревью 1c2 — исполнитель
тестов, связь, маршруты".

## Per item: what changed and the test that pins it

### A — node:sqlite executor bound every number as REAL

`apps/standalone/test/support/local-db.ts::toSqlValue` now binds
`Number.isInteger(value) ? BigInt(value) : value` for numbers (booleans stay
0/1, `null`/strings pass through, non-finite numbers/arrays/objects are
refused with `unsupported_value`), matching the shell's `as_i64`/`as_f64`
split in `local_db.rs::bind`. node:sqlite binds a JS `bigint` as SQLite
INTEGER and a `number` as REAL, so an integral value now round-trips through
a TEXT column the same way in tests and in the shell.

Pinned by `apps/standalone/test/local-executor.test.ts` → "local database on
node:sqlite" → **"binds an integral number as an integer, not a real"**:
inserts `5` into `sync_state.value` (TEXT) and asserts it reads back as
`"5"` (not `"5.0"`), and that a REAL `1.5` still reads back as `1.5` through
`SELECT ? AS x`.

**RED (captured before applying the fix):**

```
AssertionError: expected [ { value: '5.0' } ] to deeply equal [ { value: '5' } ]
- Expected
+ Received
  [
    {
-     "value": "5",
+     "value": "5.0",
    },
  ]
 ❯ test/local-executor.test.ts:163:6
```

Exactly the failure mode the brief predicted. Restored the fix and re-ran:
GREEN (see full suite run below).

### B — the node:sqlite executor enforced none of the shell's statement rules

- Created `apps/standalone/src-tauri/tests/fixtures/local-sql.json`:
  `{ statements: { accepted, refused }, queries: { accepted, refused } }`,
  built from the existing `local_db.rs` unit-test cases
  (`single_statements_with_parameters_pass`,
  `second_statements_comments_and_control_words_are_refused`,
  `only_select_and_with_are_queries`) plus a `CASE … END` query (in
  `queries.accepted`) and `ANALYZE` (in `statements.refused`, item K).
- `local_db.rs`: new unit test **`the_shared_sql_fixture_matches_the_rules`**
  reads the fixture with `include_str!("../tests/fixtures/local-sql.json")` +
  `serde_json`, and asserts `check_statement`/`is_query` for every case.
  Existing unit tests kept unchanged.
- `test/support/local-db.ts`: ported the rules as `checkStatement(sql,
valueCount)` and `isQuery(sql)` — same trim/one-trailing-`;`/no inner
  `;`/no `--`/no `/*`/forbidden-word/leading-`END`/64 KB/256
  values/1–32-statements rules as the shell. `nodeExecutor.query` and
  `.transaction` now call them and throw `LocalDbError("invalid_statement",
…)` exactly where the shell would.
- `test/local-executor.test.ts`: new describe block **"SQL rules match the
  shell (shared fixture)"** reads the same fixture (`import.meta.url` bound
  to `moduleUrl` first, per `test/protocol.test.ts`'s pattern) and asserts
  every case via `it.each`, plus **"refuses a batch of 33 statements"**.

**A real bug the fixture caught while building this:** my first port of
`words()` filtered out empty segments (`sql.split(/[^A-Za-z0-9_]+/).filter(w
=> w.length > 0)`), which silently diverged from the shell's `words`
(`str::split` on a `char` predicate, which never filters and yields a
leading `""` before a non-word character). That made `firstWord("(SELECT
1)")` return `"SELECT"` instead of `""`, so `isQuery("(SELECT 1)")` came
back `true` in TypeScript against `false` in Rust — caught immediately by
`sqlFixture.queries.refused` (`"(SELECT 1)"` is in that list, ported
straight from the Rust test). Fixed `words()` to split one character at a
time and keep empty segments, and made `firstWord` return `string` (never
`undefined`), matching item D's finding that `first_word` never actually
returns `None`.

**RED (captured before adding rule enforcement to `nodeExecutor`, using a
snapshot of the pre-fix file with the old `toSqlValue` and no
`checkStatement`/`isQuery` calls):**

```
✗ refuses a batch of 33 statements
Error: expected the call to fail
 ❯ test/local-executor.test.ts:217:19
```

— i.e. the one refused case (33 statements in one `transaction`) passed
silently before the fix, exactly as the brief said it must. The same RED run
also failed all 22 `refuses … as a statement` fixture cases (forbidden
words, comments, `;`, `END`), since the pre-fix executor enforced none of
them. Restored the fix afterward: GREEN.

### C — the writer connection did not recover from a stuck transaction depth

`LocalDb::open` (`local_db.rs`) now gives the writer `SqlitePoolOptions` a
`before_acquire` hook:

```rust
.before_acquire(|conn, _| {
    Box::pin(async move {
        Ok(<sqlx::sqlite::SqliteTransactionManager as sqlx::TransactionManager>::get_transaction_depth(conn) == 0)
    })
})
```

Checked against the real sqlx 0.8.6 sources in `~/.cargo/registry`:
`TransactionManager::get_transaction_depth(conn: &<DB as
Database>::Connection) -> usize` (`sqlx-core-0.8.6/src/transaction.rs`) and
`SqliteTransactionManager` (`sqlx-sqlite-0.8.6/src/transaction.rs`) both
exist exactly as the brief's snippet uses them, and `PoolOptions::
before_acquire`'s closure type (`Fn(&mut DB::Connection,
PoolConnectionMetadata) -> BoxFuture<'_, Result<bool, Error>>`) accepts it
unchanged — the brief's code compiled as given, no adaptation needed.
Returning `Ok(false)` makes the pool close the connection and open a fresh
one (`sqlx-core-0.8.6/src/pool/options.rs`'s doc comment on
`before_acquire`), which starts at depth 0.

Pinned by the new unit test in `local_db::tests`,
**`a_writer_connection_with_a_stuck_transaction_is_never_reused`**: opens a
`LocalDb`, `begin_with("BEGIN IMMEDIATE")`, commits with a raw `sqlx::query("COMMIT")`
(bypassing `check_statement`) instead of `tx.commit()`, drops `tx` (its
background rollback then fails, since SQLite has nothing left to roll back),
and asserts a following `db.transaction(...)` with a valid statement still
succeeds.

**RED (hook temporarily removed):**

```
thread '...' panicked at src-tauri/src/local_db.rs:502:9:
assertion `left == right` failed
  left: Err(StatementFailed)
 right: Ok([1])
```

Exactly the "every later `begin_with` fails" symptom the brief described.
Hook restored: GREEN.

### D — local DB docs and comments

- `local_db.rs::first_word`: doc corrected — `str::split` always yields at
  least one item, so `first_word` returns `Some("")` before any word
  character, never `None`.
- Documented that `changes`/`expectedChanges` are meaningful only for
  `INSERT`/`UPDATE`/`DELETE`/`REPLACE` (SQLite does not reset the changed-row
  count for a non-writing statement) on `LocalStatement::expected_changes`,
  on `LocalDb::transaction`, and in `AGENTS.md`'s "Local database" section.
- `AGENTS.md` "Local database": re-wrapped the ragged
  "JSON parameter per entity through" line along with the rest of that
  paragraph.

No dedicated test (doc-only); covered incidentally by the existing
`local_db` test suite still passing unchanged.

### E — link task: pin the sequence the webview relies on

- `tests/connection.rs`: added `next_status` (the very next report, panics
  if it is not a status — unlike `status_in`, which skips non-matching
  reports). `a_paired_device_comes_online_and_hears_every_revision` now
  asserts the exact first two statuses: `Connecting { last_contact_at: None,
last_error: None, seq: 1 }`, then `Online` with `seq: 2`.
  `the_link_goes_offline_with_the_host_and_returns_with_it` now asserts that
  right after the captured `Offline` status, the very next status is
  `Connecting` with `seq == offline.seq + 1`, before searching on for the
  eventual `Online`.
- `connection.rs`: extracted `next_pause(backoff, pause, came_online) ->
(Duration, Duration)` from `hold`'s pause step (returns `(sleep_now,
next)`; `hold` now does `let (sleep_now, next) = next_pause(backoff,
pause, came_online); sleep(sleep_now).await; pause = next;`). Behavior is
  identical to the inlined version (verified by inspection and by the full
  suite staying green).

Pinned by `connection::tests::next_pause_grows_when_the_link_never_came_online`
(1, 2, 4, 8, 16, 30, 30) and
`next_pause_resets_to_initial_after_a_session_that_came_online`, plus the two
updated `tests/connection.rs` integration tests above (run outside the
sandbox against a real host).

**RED for the reset (`next_pause`'s `came_online` branch temporarily
disabled, always returning the carried-over pause):**

```
thread '...next_pause_resets_to_initial_after_a_session_that_came_online' panicked...
assertion `left == right` failed
  left: 30s
 right: 1s
```

Restored: GREEN. The two `tests/connection.rs` integration tests were also
run three times in a row outside the sandbox to check for flakiness in the
exact-sequence assertions; all green every time.

### F — link task: pin every wire string and the refusal rule

- New unit test `connection::tests::every_link_state_and_error_serializes_to_its_wire_string`
  asserts every `LinkState` (`online`, `connecting`, `offline`) and every
  `LinkError` (`unreachable`, `certificate_mismatch`, `key_rejected`,
  `stream_refused`, `stream_ended`) serializes to its exact JSON string.
- `a_rejected_device_key_is_told_apart_from_other_refusals`: added a 401
  case with `details.credential: "session"` → asserts `LinkError::StreamRefused`
  (not `KeyRejected`), distinguishing a rejected office session from a
  rejected device key.

### G — link task: consistent snapshots

- `ConnectionState::publish` now delegates to a new `publish_with(events,
update: impl FnOnce(&mut HostStatus))`, which applies the closure and bumps
  `seq` inside one lock acquisition, then publishes. `unpaired` now clears
  `state`, `last_error` **and** `last_contact_at` through the same
  `publish_with` call — a `connection_status` racing it can no longer
  observe `lastContactAt: null` paired with the pre-update `state`/`seq`
  (the old `unpaired` took the lock once to clear `last_contact_at` and
  again, separately, inside `publish`).
- `hold` now clears `last_contact_at` on its first `Connecting` publish for
  a fresh link (a `fresh_link` flag, cleared after the first iteration),
  inside that same atomic `publish_with` call — so even if the watch channel
  coalesced a quick forget-and-re-pair's transient `None` (skipping the
  `unpaired` publish entirely), the new link's very first status still never
  shows the previous host's contact time.
- Documented on `HostStatus::last_contact_at` and on `ConnectionState::touch`
  that a heartbeat advances `lastContactAt` without bumping `seq`, so
  `connection_status` can report a newer contact time than the last event
  the webview received, while an event's own `lastContactAt` is always the
  value current when that event was published.
- `src/host/connection.ts`'s `ConnectionApi.watch` doc comment now states
  that a revision announced before `watch` resolves is not replayed, and
  that a caller needing it syncs once after `watch` resolves.

No dedicated new test (not in the brief's red-run list for L); covered by
the full `connection.rs`/`tests/connection.rs` suites staying green, which
exercise `publish`, `unpaired` and `hold`'s first-iteration path.

### H — `device_select_line` mapped every 400 to `LineRejected`

`DeviceState::select_line` (`device.rs`) now maps a 400 through a new
`line_refusal(body)`, reading the body the way `claim_refusal` does: a
`validation_failed` naming `details.field == "lineId"` → `LineRejected`; any
other 400 (a different field, a malformed body's own `validation_failed`
with no `field`, `protocol_unsupported` after a host upgrade, or anything
else unparsable) → `RequestFailed`. 401 still maps to `KeyRejected`.

Pinned by the new unit test `device::tests::line_refusals_keep_the_reason_the_webview_explains`
(pure function, like `claim_refusals_keep_the_reason_the_webview_explains`).
The existing `tests/line.rs` cases stay green unmodified —
`an_unknown_line_is_rejected_and_nothing_is_saved` exercises the real host's
`ApiError::validation("lineId", …)` response and still gets `LineRejected`.

**RED (`line_refusal` temporarily reverted to the old blanket "every 400 is
LineRejected"):**

```
thread '...line_refusals_keep_the_reason_the_webview_explains' panicked...
assertion `left == right` failed
  left: LineRejected
 right: RequestFailed
```

Restored: GREEN.

### I — `validate_path` did not refuse a route ending in `/`

`host_client.rs::validate_path` now also refuses when the route part (before
`?`) ends with `/` (`!route.ends_with('/')`), since no host route has a
trailing slash. Added refused cases `"/v1/device/line/"` and `"/v1/office/"`
to `only_host_api_paths_pass`; `"/v1/device"` stays allowed. Added
`("PUT", "/v1/device/line/")` to the refused-routes loop in
`the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route`
(`tests/line.rs`) — this route passes `device::webview_may_reach`'s
string-level `LINE_ROUTE` exclusion today (`"/v1/device/line/" !=
"/v1/device/line"`), so `validate_path` is what actually stops it.

**RED (`!route.ends_with('/')` temporarily removed):**

```
thread '...only_host_api_paths_pass' panicked at src-tauri/src/host_client.rs:357:13:
assertion `left == right` failed: /v1/device/line/
  left: Ok(())
 right: Err(InvalidRequest)
```

Restored: GREEN, and `tests/line.rs` (outside the sandbox, real host) passes
with the new case included.

### J — AGENTS.md wording

- "gives up after 2 s to connect and 10 s per request" now reads "gives up
  after 2 s to connect. `PinnedClient` also gives up after 10 s per request;
  `StreamClient` … has no per-request limit and instead treats 45 s of
  silence as a lost connection."
- "Change it together with `src/host/client.ts`, `device.ts`, `probe.ts` and
  `connection.ts` and `src/local/executor.ts`" (double "and", mixed paths) →
  "`src/host/client.ts`, `src/host/device.ts`, `src/host/probe.ts`,
  `src/host/connection.ts` and `src/local/executor.ts`".
- "`{ rev }` for every stream event" → "for every `rev` event" (heartbeats
  emit nothing on `standalone://host-revision`).

### K — `ANALYZE` is refused

Added `"ANALYZE"` to `FORBIDDEN_WORDS` in `local_db.rs` (with a comment: it
creates `sqlite_stat1`, a schema-level effect) and to
`local-sql.json`'s `statements.refused`. Also added to the TS
`FORBIDDEN_WORDS` mirror in `test/support/local-db.ts`, and mentioned in
`AGENTS.md`'s "Local database" control-word list, since that paragraph was
already being touched for item D.

## Deviations

None from the brief's described intent. Two implementation notes, not
deviations:

1. **Item C's `before_acquire` snippet compiled verbatim** against the real
   sqlx 0.8.6 sources — no adaptation was needed (checked
   `~/.cargo/registry/src/*/sqlx-core-0.8.6` and `sqlx-sqlite-0.8.6`
   directly per the brief's instruction, rather than assuming).
2. **Item B's TS port surfaced and fixed a real bug in the port itself**
   (the empty-segment filtering in `words()` — see item B above). This is
   exactly the kind of drift the shared fixture exists to catch, so it is
   reported as a finding, not a deviation from the brief.

No existing assertion was weakened anywhere; no timeout was lengthened to
get a run green.

## Verification commands and results

All from `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

| Command                                                                                             | Result                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                             | Clean, exit 0 (one `cargo fmt --all` pass applied first — brief's/my own inline code exceeded the wrap width in `connection.rs`, `device.rs`, `tests/connection.rs`; reformatting only, re-verified by rerunning the full test suite after) |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`        | Clean, 0 warnings                                                                                                                                                                                                                           |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox) | **221 passed, 0 failed**, exit 0 (baseline 215 + 6 new Rust test functions: 2 in `local_db.rs`, 3 in `connection.rs`, 1 in `device.rs`)                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                         | **307 passed** across 21 files, exit 0 (baseline 268 + 39 new: 1 integer-binding test + 38 fixture-driven/batch-size cases)                                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                    | Clean, exit 0                                                                                                                                                                                                                               |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                         | Clean, exit 0                                                                                                                                                                                                                               |
| `node_modules/.bin/prettier --check` on every changed TS/JSON file plus `AGENTS.md`                 | "All matched files use Prettier code style!"                                                                                                                                                                                                |
| `git diff --check` (excluding the controller's in-progress plan file)                               | Clean, exit 0                                                                                                                                                                                                                               |
| `git log -1 --format=%B` (after commit)                                                             | Verified subject + exact trailer                                                                                                                                                                                                            |

Sandboxed vs. not: `local_db.rs`'s own tests (unit and `tests/local_db.rs`)
never bind a port and were run inside the sandbox throughout. `tests/connection.rs`
and `tests/line.rs`, and the full-workspace `cargo test`, bind a real
`markiro-host` on `127.0.0.1` and were run with the sandbox disabled, per the
execution notes.

Not run / out of scope for this follow-up: any `apps/station` or
`apps/standalone/host` check (neither was touched — confirmed via `git
status --short apps/station apps/standalone/host`, empty both times), any
Windows-specific check, any browser/manual verification. `apps/standalone/Cargo.lock`
and `Cargo.toml` are unchanged (no new dependency needed for any of A–K).

## Files changed

Modified:

- `apps/standalone/AGENTS.md`
- `apps/standalone/src-tauri/src/connection.rs`
- `apps/standalone/src-tauri/src/device.rs`
- `apps/standalone/src-tauri/src/host_client.rs`
- `apps/standalone/src-tauri/src/local_db.rs`
- `apps/standalone/src-tauri/tests/connection.rs`
- `apps/standalone/src-tauri/tests/line.rs`
- `apps/standalone/src/host/connection.ts`
- `apps/standalone/test/local-executor.test.ts`
- `apps/standalone/test/support/local-db.ts`

Created:

- `apps/standalone/src-tauri/tests/fixtures/local-sql.json`

Not staged/committed: `docs/superpowers/plans/2026-09-27-standalone-1c3-webview-pairing-sync.md`
(being edited concurrently by the controller in this shared worktree, per
instruction).
