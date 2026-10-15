# Plan 1c1, Task 5: change feed `GET /v1/changes` — report

## What was implemented

The reference-data change feed on the standalone host, per
`.superpowers/sdd/1c1-task-5-brief.md`:

- **`tombstones(entity, id, rev)`** table (migration `0006_change_feed.sql`),
  plus `lines_rev` and `tombstones_rev` indexes for the feed query.
- **Proto types** (`apps/standalone/proto/src/lib.rs`): `entities` module
  (`ORG_PROFILE`, `SITE`, `LINES`), `ChangesResponse`, `ChangeItem`,
  `OrgRecord`, `SiteRecord`, `LineRecord`, placed right after `DeviceRecord`
  as the brief specified.
- **Fixture** `apps/standalone/proto/fixtures/changes-response.json` and a new
  Rust round-trip test in `proto/tests/fixtures.rs`.
- **Zod mirrors** in `apps/standalone/src/host/protocol.ts`
  (`changeItemSchema`, `changesResponseSchema`, `orgRecordSchema`,
  `siteRecordSchema`, `lineRecordSchema`), placed right after
  `deviceRecordSchema`, plus a new "change feed" case in
  `test/protocol.test.ts`.
- **`error::ApiQuery<T>`**: a `Query<T>` extractor whose rejections become
  `validation_failed`, following the same pattern as `ApiJson`/`ApiPath`.
- **`GET /v1/changes` handler** (`host/src/routes/changes.rs`): validates
  `since`/`limit`, reads the current host revision and a page of changed keys
  inside one read transaction (so a concurrent write cannot interleave),
  resolves each key's live record (or marks it `deleted` from `tombstones`),
  and returns `{ hostId, rev, hasMore, items }`. A page never splits a
  revision: if the requested `limit` would cut a revision in half, the page
  stops before that revision unless the revision alone is larger than the
  whole page, in which case it is returned whole.
- Route registered in `protected_routes()` (`server.rs`, behind the protocol
  guard and `AuthDevice`, no office session required) and the module wired
  into `routes/mod.rs` in alphabetical order.
- Host test suite `host/tests/changes.rs` (7 tests) covering: empty feed on a
  fresh host, the wizard's org/site/lines all landing at revision 1, a
  revision that touches no station-visible row still moving the device's
  `rev` forward, page-never-splits-a-revision (three sub-cases), archived
  lines staying visible plus deleted records becoming tombstones, query
  validation (`since < 0`, `limit` out of `1..=1000`, non-numeric `since`),
  and the auth requirement (device key needed, no office session).

## TDD evidence

**RED** — `apps/standalone/host/tests/changes.rs` created before any
implementation code:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline
```

```
---- the_feed_needs_a_device_key_but_no_office_session stdout ----
thread '...' panicked: assertion `left == right` failed
  left: 404
 right: 401

---- the_feed_checks_its_query stdout ----
thread '...' panicked: assertion `left == right` failed: ?since=-1
  left: 404
 right: 400

---- a_fresh_host_has_an_empty_feed stdout ----
thread '...' panicked: {"error":{"code":"not_found","message":"no route for GET /v1/changes"}}
  left: 404
 right: 200

---- archived_lines_stay_and_deleted_records_come_as_tombstones stdout ----
thread '...' panicked: called `Result::unwrap()` on an `Err` value:
  Database(SqliteError { code: 1, message: "no such table: tombstones" })

---- after_the_wizard_the_feed_holds_the_organization_the_site_and_the_lines stdout ----
thread '...' panicked: {"error":{"code":"not_found","message":"no route for GET /v1/changes"}}
  left: 404
 right: 200

---- a_page_never_splits_a_revision stdout ----
thread '...' panicked: called `Option::unwrap()` on a `None` value

---- revisions_without_station_records_still_move_the_device_forward stdout ----
thread '...' panicked: assertion `left == right` failed
  left: 404
 right: 200

test result: FAILED. 0 passed; 7 failed; 0 ignored; 0 measured; 0 filtered out
```

This matches the brief's predicted failure mode exactly (missing route → 404;
missing `tombstones` table → SQLite error).

**GREEN** — after the migration, `ApiQuery`, and the handler were added:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline
```

```
running 7 tests
test the_feed_needs_a_device_key_but_no_office_session ... ok
test a_fresh_host_has_an_empty_feed ... ok
test the_feed_checks_its_query ... ok
test archived_lines_stay_and_deleted_records_come_as_tombstones ... ok
test after_the_wizard_the_feed_holds_the_organization_the_site_and_the_lines ... ok
test a_page_never_splits_a_revision ... ok
test revisions_without_station_records_still_move_the_device_forward ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.18s
```

All 7 tests passed on the first implementation attempt — no fixes were needed
for `bool` decoding of the `UNION ALL` literal `deleted` column, `archived`,
or the `?1`/`?2` numbered SQL parameters (see "Deviations" below).

## Every verification command and its result

| #   | Command                                                                                                                         | Result                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cargo test -p markiro-proto --test fixtures --offline` (Step 1, before host code)                                              | 19 passed (18 pre-existing + 1 new `the_change_feed_fixture_round_trips_with_typed_records`)                                                                                                                                |
| 2   | `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts` (Step 1)           | 42 passed (1 test file)                                                                                                                                                                                                     |
| 3   | `cargo test -p markiro-host --test changes --offline` (Step 2, RED)                                                             | 0 passed; 7 failed (expected — see above)                                                                                                                                                                                   |
| 4   | `cargo test -p markiro-host --test changes --offline` (Step 3, GREEN)                                                           | 7 passed                                                                                                                                                                                                                    |
| 5   | `cargo test -p markiro-host --offline` **inside sandbox**                                                                       | 5 tests in `hello.rs` failed with `PermissionDenied`/"cannot listen on 127.0.0.1:0: Operation not permitted" — confirmed sandbox-caused (matches the constraints doc's known list of port-binding tests), not a code defect |
| 6   | `cargo test -p markiro-host --offline` **outside sandbox** (`dangerouslyDisableSandbox: true`)                                  | **102 passed** (15 suites; 95 pre-existing + 7 new), 0 failed                                                                                                                                                               |
| 7   | `cargo build -p markiro-host --tests --offline` unfiltered, outside sandbox                                                     | `Finished`, zero warning lines                                                                                                                                                                                              |
| 8   | `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (first run)                                             | Failed: line-wrapping diffs in the brief's verbatim code in `host/tests/changes.rs` and `proto/tests/fixtures.rs`                                                                                                           |
| 9   | `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` (apply)                                                            | Reformatted `host/src/routes/changes.rs`, `host/tests/changes.rs`, `proto/tests/fixtures.rs` (whitespace/line-wrap only)                                                                                                    |
| 10  | `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (re-run)                                                | Exit 0, clean                                                                                                                                                                                                               |
| 11  | `cargo test -p markiro-host --offline` outside sandbox (after fmt)                                                              | 102 passed again — formatting did not change behavior                                                                                                                                                                       |
| 12  | `cargo test -p markiro-proto --test fixtures --offline` (after fmt)                                                             | 19 passed again                                                                                                                                                                                                             |
| 13  | `node_modules/.bin/prettier --check` on `proto/fixtures/changes-response.json`, `src/host/protocol.ts`, `test/protocol.test.ts` | "All matched files use Prettier code style!"                                                                                                                                                                                |
| 14  | `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                | Clean (`tsc -p tsconfig.json --noEmit`, no errors)                                                                                                                                                                          |
| 15  | `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts` (final)            | 42 passed                                                                                                                                                                                                                   |
| 16  | `git diff --check`                                                                                                              | Exit 0, no whitespace errors                                                                                                                                                                                                |
| 17  | `git status --short` before commit                                                                                              | Exactly the 11 files the brief lists, nothing extra                                                                                                                                                                         |
| 18  | `git log -1 --format=%B` after commit                                                                                           | `feat(standalone): лента изменений справочников на хосте` + blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` — matches exactly                                                                        |

Not run (out of scope for this task per the brief/constraints): `cargo test
--workspace` (would need `apps/standalone/dist` built), `src-tauri` tests,
Windows/DPAPI checks, `apps/station` — none of these are touched by this
task.

## Files changed

Modified:

- `apps/standalone/host/src/error.rs` — import `Query`; add `ApiQuery<T>`.
- `apps/standalone/host/src/routes/mod.rs` — `pub mod changes;` (alphabetical).
- `apps/standalone/host/src/server.rs` — register `GET /v1/changes`.
- `apps/standalone/proto/src/lib.rs` — `entities`, `ChangesResponse`,
  `ChangeItem`, `OrgRecord`, `SiteRecord`, `LineRecord`.
- `apps/standalone/proto/tests/fixtures.rs` — import + round-trip test.
- `apps/standalone/src/host/protocol.ts` — five new Zod schemas/types.
- `apps/standalone/test/protocol.test.ts` — import + "change feed" case.

Created:

- `apps/standalone/host/migrations/0006_change_feed.sql`
- `apps/standalone/host/src/routes/changes.rs`
- `apps/standalone/host/tests/changes.rs`
- `apps/standalone/proto/fixtures/changes-response.json`

Commit: `b0a4c0ef4` — `feat(standalone): лента изменений справочников на хосте`.

## Deviations

None. Every ambiguity the brief called out in advance resolved in the
brief's own favor without a fallback being needed:

- `sqlx::FromRow`'s `bool` field (`Key::deleted`) decoded correctly from the
  `UNION ALL` literal columns `0 AS deleted` / `1 AS deleted`, and
  `LineRecord`'s `archived: bool` decoded correctly from the `lines.archived`
  `INTEGER` column. No `i64`-plus-comparison fallback was needed.
- The numbered SQLite parameters `?1`/`?2` in `FEED_KEYS` (with `?1` repeated
  across all four `UNION ALL` branches) worked as written with
  `.bind(since).bind(last)` — SQLite treats a given numbered placeholder as
  one parameter slot regardless of how many times it appears in the text, and
  sqlx's sequential `.bind()` calls line up with slots 1 and 2 correctly.
- All of the brief's supplied code compiled and passed as given. The only
  changes made anywhere were `cargo fmt`'s automatic re-wrapping of long
  lines in the two test files (whitespace only, no logic or assertion
  changes) — needed because the brief's inline code samples were not
  rustfmt-wrapped, and `cargo fmt --check` is one of the required final
  gates.

## Self-review findings

- **Completeness**: every item in the brief's "Produces" list is present —
  the `tombstones` table, the three `entities` constants, all five new proto
  types, the route, `ApiQuery`, and all five Zod schemas. All four steps'
  file lists match `git status` exactly (11 files, no extras, nothing
  missing).
- **YAGNI**: no speculative abstraction added beyond the brief — `FEED_KEYS`
  and `record()` are structured exactly as described so that plans 1d/1e can
  extend them with one branch each, per the module doc comment already in
  the brief's code.
- **Existing patterns followed**: `ApiQuery<T>` mirrors `ApiJson<T>`/`ApiPath<T>`
  in `error.rs` field-for-field; the handler uses `ApiError::validation` /
  `ApiError::internal` exactly like sibling routes (`devices.rs`,
  `bootstrap.rs`); `routes/mod.rs` stays alphabetical; the route sits with
  the other `/v1/device*` routes in `protected_routes()`; the read path takes
  one transaction the same way `bootstrap.rs` takes one write transaction,
  for the same reason (a consistent snapshot).
- **No audit row for this endpoint**: correct per the design — `GET
/v1/changes` is a read, and `AGENTS.md`'s audit rules apply to office
  changes, logins, pairing and initialization, not read-only device polling;
  no sibling read route (`GET /v1/device`, `GET /v1/office/org`, `GET
/v1/office/sscc`) writes an audit row either.
- **Test output is clean**: 102/102 `markiro-host` tests, 19/19
  `markiro-proto` fixture tests, 42/42 Vitest tests, zero compiler warnings,
  `cargo fmt --check` and `prettier --check` both clean.
- **Nothing outside scope touched**: `apps/station` untouched; no new
  dependency added; no `pnpm install`/`pnpm add` run; no `git stash` used;
  only the 11 files the brief named were staged.
- **One thing worth flagging for whoever does Task 6**: the read handler
  takes `state.pool.begin()` (a deferred `BEGIN`, not `db::begin_write`'s
  `BEGIN IMMEDIATE`) since it never writes — consistent with `AGENTS.md`'s
  "Writes" section, which only mandates `begin_write` for multi-statement
  writes. Task 6's SSE stream will need its own subscription mechanism
  (`db::commit_with_revision` per the constraints doc) since this task does
  not add any notify-after-commit hook — by design, that's explicitly
  Task 6's job.
