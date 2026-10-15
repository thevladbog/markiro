# Report: Plan 1d2, Task 2 — Контрагенты `GET/POST/PUT /v1/office/counterparties`

## Pre-flight: brief vs. codebase

Before editing, I read every "fragment … replace with …" anchor in the brief
against the current files (`validate.rs`, `error.rs`, `audit.rs`, `server.rs`,
`routes/mod.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`,
`host/tests/support/app.rs`) and the spec fragments in
`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
(§4.3, §4.5, §4.9), plus the migration 0007 table shape and `AppState`/`db.rs`/
`auth.rs` signatures the new route code calls. Every fragment matched byte for
byte, so I implemented the brief's code verbatim with no improvisation.

## What I implemented

- `validate::company` (host `validate.rs`): the field checks pulled out of
  `validate::org` — name 1-200 chars, INN 10/12 digits or none, GLN 13 digits,
  ≤10 distinct GS1 prefixes of 4-12 digits, `path(prefix, name)` for the JSON
  path. `org()` now delegates to `company()` and adds only the time-zone check,
  keeping the same field paths (`org.gln`, etc.) as before.
- `ApiError::details()` (host `error.rs`): exposes the structured detail map
  for tests (and future callers) without touching `with_details`/response
  behaviour.
- `audit::actions::COUNTERPARTY_CREATE` / `COUNTERPARTY_UPDATE` (host
  `audit.rs`).
- Proto types (`proto/src/lib.rs`): `CounterpartyRecord`, `CounterpartyCreate`
  (`deny_unknown_fields`), `CounterpartyUpdate` (`deny_unknown_fields`, full
  record + `archived` + `expectedRev`), all `camelCase`.
- `host/src/routes/counterparties.rs`: `list_counterparties` (any office role,
  no admin check), `create_counterparty` and `update_counterparty`
  (`require_admin` early + `require_admin_in` inside the write transaction).
  Both writers validate before opening a transaction, use
  `begin_write`/`next_revision`/`commit_with_revision`, and `update_counterparty`
  returns the current record unchanged (no revision bump, no row write, no
  audit row) when `audit::update_details` reports nothing changed. Wired into
  `routes/mod.rs` and `server.rs` (`GET/POST /v1/office/counterparties`,
  `PUT /v1/office/counterparties/{id}`).
- Test support (`host/tests/support/app.rs`): `Admin` (`app, key, token, id`),
  `admin()`, `Admin::{call, call_as, technologist, row}`, `host_revision`,
  `AuditRow`, `audit_trail` — shared harness for this and future 1d2 task
  tests.
- `host/tests/counterparties.rs`: 5 integration tests (create/list/update/
  archive/no-op-update/stale-revision, station-feed exclusion, per-field
  validation parity with the org profile, technologist read-only enforcement,
  not-found ordering after a valid body).
- `proto/fixtures/counterparty-{record,create,update}.json` and the matching
  round-trip/`deny_unknown_fields` test in `proto/tests/fixtures.rs`.
- Docs: `apps/standalone/AGENTS.md` "Audit" section (denied writes take no
  row) and spec §4.3 (counterparty field rules), §4.5 (fixture list), §4.9
  (denied-write rule) in
  `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.

## TDD evidence

### RED

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test counterparties --offline`
(after adding the test support fragment and `tests/counterparties.rs`, before
any implementation):

```
thread 'an_administrator_creates_lists_and_updates_counterparties' panicked:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/office/counterparties"}}
  left: 404
 right: 200
...
test result: FAILED. 0 passed; 5 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.19s
```

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib validate --offline`
(after adding the `validate::tests` module, before the `company`/`details`
implementation) — compile errors, exactly the three named in the brief plus
one collateral type-inference error caused by the missing `details()` method:

```
error[E0425]: cannot find function `company` in this scope
error[E0422]: cannot find struct, variant or union type `ValidCompany` in this scope
error[E0599]: no method named `details` found for struct `error::ApiError` in the current scope
error[E0282]: type annotations needed
```

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
(after updating the import block and adding the new test, before adding the
proto types):

```
error[E0432]: unresolved imports `markiro_proto::CounterpartyCreate`, `markiro_proto::CounterpartyRecord`, `markiro_proto::CounterpartyUpdate`
 --> proto/tests/fixtures.rs:4:34
```

### GREEN

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test counterparties --offline`
→ `cargo test: 5 passed (1 suite, 0.21s)`

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
→ `cargo test: 18 passed (1 suite, 0.16s)` (16 previous + 2 new `validate::tests`)

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test bootstrap --offline`
→ `cargo test: 6 passed (1 suite, 0.21s)` (wizard/org validation still uses the same field paths through `validate::company`)

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
→ `cargo test: 22 passed (1 suite, 0.00s)`

All four counts match the brief's "Expected: PASS" exactly.

## Verification commands and results

| Command                                                                                                                                                                                                                                                  | Result                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                                                                                                  | clean, no output                                         |
| `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/counterparty-*.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`                                                                   | "All matched files use Prettier code style!"             |
| `git diff --check`                                                                                                                                                                                                                                       | clean, no output                                         |
| `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline`                                                                                                                                        | `cargo build (2 crates compiled)` — 0 warnings           |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                                                                                                                                             | `cargo build (3 crates compiled)` — 0 warnings           |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox: the workspace also holds `hello.rs`, `platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs` and the `src-tauri` tests, which bind real sockets) | `cargo test: 240 passed (31 suites, 5.68s)`, exit code 0 |

Byte checks for Cyrillic text added through the edit tool (`grep -n '\uXXXX'`)
came back empty for every touched file — no literal escape artifacts.

`apps/standalone/dist` already existed in this worktree, so no
`turbo run build` was needed before the full workspace test/check.

## Files changed

Modified:

- `apps/standalone/AGENTS.md`
- `apps/standalone/host/src/audit.rs`
- `apps/standalone/host/src/error.rs`
- `apps/standalone/host/src/routes/mod.rs`
- `apps/standalone/host/src/server.rs`
- `apps/standalone/host/src/validate.rs`
- `apps/standalone/host/tests/support/app.rs`
- `apps/standalone/proto/src/lib.rs`
- `apps/standalone/proto/tests/fixtures.rs`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Created:

- `apps/standalone/host/src/routes/counterparties.rs`
- `apps/standalone/host/tests/counterparties.rs`
- `apps/standalone/proto/fixtures/counterparty-create.json`
- `apps/standalone/proto/fixtures/counterparty-record.json`
- `apps/standalone/proto/fixtures/counterparty-update.json`

Commit: `32a5b36d3` "feat(standalone): контрагенты на хосте", trailer verified
with `git log -1 --format=%B` to be exactly one
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## Deviations

None. Every "fragment … replace with …" in the brief matched the codebase
byte for byte before editing, and the code, fixtures and doc text were applied
verbatim.

## Self-review

- **Completeness**: every file in the brief's "Files" list was touched exactly
  as specified; `git status --short` before staging showed only those 15
  paths (10 modified, 5 new), matching the brief's Modify/Create/Test split.
- **Names**: `ValidCompany`, `validate::company`, `ApiError::details`,
  `actions::COUNTERPARTY_CREATE/UPDATE`, `CounterpartyRecord/Create/Update`,
  and the test-support `Admin`/`admin`/`host_revision`/`AuditRow`/`audit_trail`
  all match the brief's Interfaces section exactly (fields, parameter order,
  return types).
- **No overbuilding**: no extra fields, routes, validations or test cases were
  added beyond the brief; `org()` keeps its own signature and error paths
  unchanged from the caller's point of view.
- **Tests verify behaviour, not just status codes**: the main integration test
  checks the full JSON body (including a trimmed/deduplicated/normalized
  `gs1Prefixes` and `inn: null` from a blank string), the exact audit row
  (actor, action, target, result, parsed `details`), the no-op update leaving
  the revision and audit trail untouched, and the ordering of validation
  before existence lookup for `PUT` on an unknown id.
- **Pristine output**: `cargo fmt --check`, both `cargo check` scopes, and
  `cargo test --workspace` all came back clean with zero warnings and zero
  failures.

## Concerns

None. The one thing worth flagging for whoever reviews plan 1d2 as a whole:
the full-workspace `cargo test` had to run outside the sandbox only because
of pre-existing test binaries that bind real sockets (`hello.rs`,
`platform.rs`, `no_secrets_in_logs.rs`, `changes_stream.rs`,
`src-tauri/tests/*`); none of the new counterparty tests need that — they run
in-process against the router via `tower::ServiceExt::oneshot`, same as every
other host route test.
