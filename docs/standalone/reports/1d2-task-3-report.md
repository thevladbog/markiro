# Task 3 report: Линии — `GET/POST/PUT /v1/office/lines`

## What was implemented

Added the office routes for production lines, exactly as specified in
`1d2-task-3-brief.md`:

- `GET /v1/office/lines` — every office role, lists all lines (including
  archived), ordered `archived, name_key, id`.
- `POST /v1/office/lines` `{ name }` — administrators only; validates and
  trims the name via the existing `validate::line_name`, inserts with
  `archived = 0`, takes a new host revision, writes a `line.create` audit row
  (`{ "name": … }`), returns the created `OfficeLine`.
- `PUT /v1/office/lines/{id}` `{ name?, archived?, expectedRev }` —
  administrators only; changes only the fields sent, requires `expectedRev`
  (409 `stale_revision` with `details.currentRev` on mismatch), takes a new
  revision and writes a `line.update` audit row only when something actually
  changed (`audit::update_details`), otherwise returns the record unchanged
  with no revision bump, no row write and no audit entry.
- A name already held by a non-archived line answers `409 conflict` with
  `details.constraint = "line_name"` on create, rename and un-archive, backed
  by the partial unique index `lines_active_name_key` from migration 0002
  (`name_key`, case-folded by the host, not by SQLite's ASCII-only `lower()`).
- Archiving a line does not touch devices assigned to it; a station stays on
  an archived line (only `PUT /v1/device/line`, unchanged in this task,
  refuses to _select_ an archived line).
- Added `actions::LINE_CREATE` / `actions::LINE_UPDATE` to `audit::actions`,
  and the wire types `OfficeLine { id, name, archived, rev }`,
  `LineCreate { name }`, `LineUpdate { name?, archived?, expectedRev }` to
  `markiro_proto`, each with a round-tripping JSON fixture.
- Updated spec `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  §4.3 (the `line_name` conflict rule and the archiving/device note) and §4.5
  (the new line fixtures).

No changes were needed to `validate.rs`, `db.rs`, `error.rs`, `auth.rs`, the
`lines` migration, `feed.rs` or `routes/changes.rs`: `validate::line_name`,
the `lines` table/index/feed-rev-index and the station feed's `lines` branch
were already in place from plans 1b1/1c1 and task 2's shared support. This
task only added the office-facing routes on top of them.

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test lines --offline
```

Output (all 6 tests failed as expected — no routes yet, host answers 404
where the tests expect 200/400):

```
---- archiving_a_line_leaves_its_stations_on_it stdout ----
thread 'archiving_a_line_leaves_its_stations_on_it' panicked at host/tests/lines.rs:12:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for GET /v1/office/lines"}}
  left: 404
 right: 200

---- an_administrator_creates_renames_and_archives_lines stdout ----
thread 'an_administrator_creates_renames_and_archives_lines' panicked at host/tests/lines.rs:43:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/office/lines"}}
  left: 404
 right: 200

---- line_names_are_checked stdout ----
thread 'line_names_are_checked' panicked at host/tests/lines.rs:224:9:
assertion `left == right` failed
  left: (404, Null)
 right: (400, String("name"))

---- line_names_are_unique_among_active_lines_regardless_of_case stdout ----
thread 'line_names_are_unique_among_active_lines_regardless_of_case' panicked at host/tests/lines.rs:12:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for GET /v1/office/lines"}}
  left: 404
 right: 200

---- an_unknown_line_is_not_found_once_its_body_is_valid stdout ----
thread 'an_unknown_line_is_not_found_once_its_body_is_valid' panicked at host/tests/lines.rs:320:5:
assertion `left == right` failed
  left: (404, Null)
 right: (400, String("name"))

---- technologists_read_lines_but_do_not_change_them stdout ----
thread 'technologists_read_lines_but_do_not_change_them' panicked at host/tests/lines.rs:260:5:
assertion `left == right` failed
  left: 404
 right: 200

test result: FAILED. 0 passed; 6 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.22s
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
```

Output (compile failure, as expected — the new types do not exist yet):

```
error[E0432]: unresolved imports `markiro_proto::LineCreate`, `markiro_proto::LineUpdate`, `markiro_proto::OfficeLine`
 --> proto/tests/fixtures.rs:6:5
  |
6 |     LineCreate, LineRecord, LineUpdate, LocalPairRequest, OfficeLine, OfficeLoginRequest,
  |     ^^^^^^^^^^              ^^^^^^^^^^                    ^^^^^^^^^^
  |     |                       |                             |
  |     |                       |                             no `OfficeLine` in the root
  |     |                       |                             help: a similar name exists in the module: `OfficeRole`
  |     |                       no `LineUpdate` in the root
  |     no `LineCreate` in the root
```

Both match the brief's predicted RED output exactly.

### GREEN

Implemented: `audit::actions::LINE_CREATE`/`LINE_UPDATE`, the proto types
(`OfficeLine`, `LineCreate`, `LineUpdate`), `routes/lines.rs`
(`list_lines`, `create_line`, `update_line`), wired the module in
`routes/mod.rs` and the two routes in `server.rs`.

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test lines --offline
```

Output:

```
running 6 tests
test an_unknown_line_is_not_found_once_its_body_is_valid ... ok
test archiving_a_line_leaves_its_stations_on_it ... ok
test line_names_are_checked ... ok
test line_names_are_unique_among_active_lines_regardless_of_case ... ok
test an_administrator_creates_renames_and_archives_lines ... ok
test technologists_read_lines_but_do_not_change_them ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.19s
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
```

Output:

```
running 23 tests
... (23 tests, including the new line_fixtures_round_trip_and_an_update_carries_only_what_changes)
test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Both match the brief's Step 4 expectations (PASS, 6 and 23 tests).

## Every verification command and its result

Ran in this order, all passing:

1. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — clean, exit 0.
2. `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-line.json apps/standalone/proto/fixtures/line-create.json apps/standalone/proto/fixtures/line-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` — "All matched files use Prettier code style!", exit 0.
3. `git diff --check` — clean, exit 0.
4. `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline` — 0 warnings, exit 0 (brief's Step 6 check).
5. `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` — 0 warnings, exit 0 (task hard-rule check; also compiles `src-tauri`, which needs `apps/standalone/dist` — already present in this worktree).
6. `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`, run outside the sandbox (binds 127.0.0.1 in `hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs`, `src-tauri/tests/*.rs`) — every binary green: markiro-host lib (18), markiro-host bin (3), `bootstrap` (6), `changes` (14), `changes_stream` (7), `claim` (8), `counterparties` (5), `device_line` (4), `foundation` (12), `hello` (5), **`lines` (6)**, `no_secrets_in_logs` (1), `office_admin` (8), `office_auth` (16), `pairing` (6), `pairing_codes` (3), `platform` (7), markiro-proto lib (2), `fixtures` (23), markiro-standalone-lib (43), markiro-standalone bin (0), `claim` (4, src-tauri), `connection` (6), `device` (13), `host_probe` (2), `host_probe_proxy` (1), `ipc` (9), `line` (5), `local_db` (10), plus 3 empty doc-test suites. Total 0 failed across the whole workspace. Exit code 0.
7. Re-ran `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` and `git diff --check` after the full workspace run — both still clean.

## Files changed

```
 apps/standalone/host/src/audit.rs                                       |   2 +
 apps/standalone/host/src/routes/lines.rs (new)                          | 182 +++++++++
 apps/standalone/host/src/routes/mod.rs                                  |   1 +
 apps/standalone/host/src/server.rs                                      |   8 +
 apps/standalone/host/tests/lines.rs (new)                               | 335 +++++++++++++++
 apps/standalone/proto/fixtures/line-create.json (new)                   |   1 +
 apps/standalone/proto/fixtures/line-update.json (new)                   |   1 +
 apps/standalone/proto/fixtures/office-line.json (new)                   |   1 +
 apps/standalone/proto/src/lib.rs                                        |  29 ++
 apps/standalone/proto/tests/fixtures.rs                                 |  22 +-
 docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md    |   7 +-
```

Exactly the file list the brief named — nothing else touched. `apps/station`
was not touched.

Commit: `ace5b6e33` "feat(standalone): линии в офисе хоста" on
`claude/autonomous-desktop-station-9e6f13`, on top of `32a5b36d3`. Message
body verified with `git log -1 --format=%B`; ends with exactly one
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## Deviations

None. Before touching any file, I read the current byte-for-byte contents of
every file the brief names a fragment in or against (`audit.rs`,
`proto/src/lib.rs`, `proto/tests/fixtures.rs`, `routes/mod.rs`, `server.rs`,
`validate.rs`, `db.rs`, `error.rs`, `auth.rs`, migration 0002, `changes.rs`,
the spec sections, `counterparties.rs` and `tests/support/app.rs` as the
established pattern) and confirmed every "replace X with Y" fragment matched
the file's current content exactly before applying it. All code, fixtures,
and spec text were used verbatim from the brief.

## Self-review findings

- **Completeness against the brief:** all six test scenarios pass; all
  produced interfaces (`actions::LINE_CREATE/LINE_UPDATE`, `OfficeLine`,
  `LineCreate`, `LineUpdate`, the three routes) exist with the exact shapes
  specified; both spec sections updated.
- **Names:** `list_lines`/`create_line`/`update_line`, `LineRow`,
  `name_taken` mirror the naming and structure of the sibling
  `routes/counterparties.rs` module task 2 already established (same
  `read`/handler split, same use of `context.require_admin()` +
  `context.require_admin_in(&mut tx)`, same `audit::update_details` no-op
  short-circuit). No inconsistent naming found.
- **No overbuilding:** the route file implements exactly the three endpoints
  the brief asks for, with no extra endpoints, fields, or abstractions beyond
  what the brief's code block specifies. No changes outside the listed files.
- **Tests verify behaviour, not just plumbing:** the suite checks the
  trimmed/normalized name, the exact audit row content (actor, action,
  target, parsed details), the station feed item content and revision, the
  full office list ordering (active before archived, alphabetical), the
  case-insensitive uniqueness constraint across create/rename/unarchive, that
  a no-op `PUT` bumps neither the host revision nor the audit log, that a
  stale `expectedRev` is refused with the correct `currentRev`, that
  `deny_unknown_fields` rejects an unknown body field, that a technologist is
  forbidden from writing but can read, and that archiving a line leaves an
  assigned device's `lineId` untouched.
- **Pristine output:** `cargo fmt --check`, `prettier --check`,
  `git diff --check`, `cargo check` (both the two-package and the full
  `--workspace --all-targets` forms) and the full `cargo test --workspace`
  all ran clean with zero warnings and zero failures.
- Verified no literal `\uXXXX` escapes were introduced by the edit tool in
  any of the Cyrillic text added (`grep -n '\\u0'` over every changed/created
  file found nothing).

## Concerns

None. The task's dependencies (validation helper, table/index, feed wiring,
shared test support) were all already in place and unmodified, so this task
was additive only, matching the brief's stated scope precisely.
