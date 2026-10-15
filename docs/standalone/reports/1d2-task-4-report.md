# Task 4 report: операторы — потолок итераций PHC и `GET/POST/PUT /v1/office/operators`

## What was implemented

- `secrets::MAX_ITERATIONS = 1_000_000` (public, alongside `MIN_ITERATIONS`,
  now also public): `parse_phc` rejects an iteration count outside
  `MIN_ITERATIONS..=MAX_ITERATIONS`. This ceiling applies to every PHC string
  the host parses, so office passwords (600 000 iterations) fall safely under
  it too.
- `validate::operator_login` (3-12 ASCII digits, leading zeros preserved),
  `validate::operator_role` (optional, trimmed, blank → `None`, ≤120
  characters, via a new private `optional_text` helper), and
  `validate::pin_phc` (a PHC string `secrets::parse_phc` accepts).
- `audit::update_details_hiding`: like `update_details`, but takes a second
  slice of `(field, did_change)` pairs that are named in `changed` without a
  `{ from, to }` pair — used to record that `pinPhc` changed without ever
  writing the hash to the audit log. `update_details` is now a thin wrapper
  over it with an empty `hidden` slice. Added `actions::OPERATOR_CREATE` and
  `actions::OPERATOR_UPDATE`.
- `proto::nullable`: a serde helper module for
  `Option<Option<T>>` fields of a partial update (absent = keep, `null` =
  clear, value = set). Added `BadgeInfo`, `OfficeOperator`, `OperatorCreate`,
  `OperatorUpdate` to `proto/src/lib.rs`.
- `routes/operators.rs` (new): `GET /v1/office/operators`, `POST
/v1/office/operators`, `PUT /v1/office/operators/{id}`, administrator-only
  (technologist gets `forbidden`, including on `GET`). `POST` validates all
  fields, hashes nothing itself (the office already hashed the PIN),
  inserts the row, writes `operator.create` audit details `{ login, role }`,
  and returns the created record (`hasPin: true`, never a hash). `PUT`
  applies only the fields sent, requires `expectedRev` and answers
  `stale_revision` with `details.currentRev` otherwise; a deactivation
  (`active: true -> false`) writes a station-feed tombstone via
  `feed::remove`, a reactivation (`false -> true`) drops it via
  `feed::restore` and both bump `rev`; a request that changes nothing
  returns the record as-is without a new revision, row write or audit row.
  The audit detail for an update names `pinPhc` in `changed` (via
  `update_details_hiding`) without ever printing the hash.
- Wired the new routes into `server.rs` and `routes/mod.rs`.
- Updated spec `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  §4.3 (operator table: iteration ceiling, uniqueness conflict, role rule) and
  §4.5 (new operator fixtures) to match.

The host never sees a raw PIN (only the office-computed PHC string) and never
returns a hash to the office (`hasPin` and badge metadata only).

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline
```

Output (tail): all 8 new tests failed — the routes did not exist yet, so
every call hit the router's `not_found` fallback (`404`) where the test
expected `200`, `400` or `403`:

```
---- pin_hashes_must_be_domain_phc_strings_within_the_iteration_bounds stdout ----
thread '...' panicked at host/tests/operators.rs:152:9:
assertion `left == right` failed: 4821
  left: (404, Null)
 right: (400, String("pinPhc"))//
...
test result: FAILED. 0 passed; 8 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline
```

Output: compile failure —

```
error[E0432]: unresolved import `super::update_details_hiding`
  --> host/src/audit.rs:130:33
error[E0425]: cannot find function `operator_login` in this scope (x2)
error[E0425]: cannot find function `operator_role` in this scope (x5)
error[E0425]: cannot find function `pin_phc` in this scope (x3)
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
```

Output: compile failure —

```
error[E0432]: unresolved imports `markiro_proto::OfficeOperator`, `markiro_proto::OperatorCreate`, `markiro_proto::OperatorUpdate`
 --> proto/tests/fixtures.rs:7:5
```

All three RED runs match the brief's expected failures exactly.

### GREEN

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test operators --offline`
Output: `cargo test: 8 passed (1 suite, 0.24s)`

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib --offline`
Output: `cargo test: 23 passed (1 suite, 0.16s)`

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --test office_admin --offline`
Output: `cargo test: 24 passed (2 suites, 1.24s)` (16 + 8)

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline`
Output: `cargo test: 24 passed (1 suite, 0.00s)`

All four GREEN counts match the brief's expectations exactly (8, 23, 16+8, 24).

## Every verification command and its result

| Command                                                                                                                                                                                                                                                               | Result                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                                                                                                               | Clean, no output                                                                                    |
| `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/office-operator.json apps/standalone/proto/fixtures/operator-create.json apps/standalone/proto/fixtures/operator-update.json docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | "All matched files use Prettier code style!"                                                        |
| `git diff --check`                                                                                                                                                                                                                                                    | Clean, exit 0                                                                                       |
| `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline` (also re-run via `rtk proxy` to rule out truncation)                                                                                                | Clean, 0 warnings                                                                                   |
| `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox, `dangerouslyDisableSandbox: true`, per the task's hard rule that 127.0.0.1-binding tests must run there)                                                          | `cargo test: 261 passed (33 suites, 5.79s)` — whole workspace (host + proto + src-tauri), all green |
| `git status --short` after commit                                                                                                                                                                                                                                     | Clean                                                                                               |
| `grep -n '\uXXXX literal check'` on every new/edited file with Cyrillic                                                                                                                                                                                               | No literal `\uXXXX` escapes found; spot-checked rendered Cyrillic text directly                     |

`apps/standalone/dist` already existed in this worktree, so `cargo test
--workspace` did not need a fresh webview build first.

## Files changed

Modified:

- `apps/standalone/host/src/secrets.rs`
- `apps/standalone/host/src/validate.rs`
- `apps/standalone/host/src/audit.rs`
- `apps/standalone/host/src/server.rs`
- `apps/standalone/host/src/routes/mod.rs`
- `apps/standalone/proto/src/lib.rs`
- `apps/standalone/proto/tests/fixtures.rs`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Created:

- `apps/standalone/host/src/routes/operators.rs`
- `apps/standalone/host/tests/operators.rs`
- `apps/standalone/proto/fixtures/office-operator.json`
- `apps/standalone/proto/fixtures/operator-create.json`
- `apps/standalone/proto/fixtures/operator-update.json`

No changes to `apps/station` (verified: `git status --short | grep -i
apps/station` found nothing before commit).

Commit: `3e6688385` — "feat(standalone): операторы на хосте, потолок
итераций PHC", trailer verified with `git log -1 --format=%B` to be exactly
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and no other.

## Deviations

None. Every fragment the brief specified as "replace X with Y" matched the
target file byte for byte on the first `Edit` attempt (no retries needed),
confirming the plan's premise that this baseline is the same one the plan was
authored against. Every new file was written verbatim from the brief. The two
spec-doc fragments (§4.3, §4.5) also matched byte for byte before editing.

## Self-review findings

- Checked every symbol in the brief's "Produces" list against the diff:
  `secrets::MIN_ITERATIONS`/`MAX_ITERATIONS`, `validate::operator_login`,
  `validate::operator_role`, `validate::pin_phc`,
  `audit::update_details_hiding`, `actions::OPERATOR_CREATE/UPDATE`,
  `proto::nullable`, `BadgeInfo`, `OfficeOperator`, `OperatorCreate`,
  `OperatorUpdate`, `routes::operators::{read_operator, badge}` — all present
  with the exact signatures specified.
- Names match the brief exactly; no renaming or shortcuts taken.
- No overbuilding: badge routes (task 5) were deliberately left out of
  `routes/operators.rs` even though the module doc comment already
  anticipates them living there; no speculative helpers beyond the private
  `optional_text` the brief itself specifies.
- Tests assert actual behavior, not just status codes: exact JSON response
  shapes, exact audit rows (actor/action/target/details), exact feed items
  (including that a tombstone carries no `data` and a restored record carries
  the fresh `pinPhc`), and the office response never contains the substring
  `"pbkdf2"`.
- Verified by re-running `cargo check` through `rtk proxy` (per the plan's
  own warning that the `rtk` wrapper can truncate output) that there are
  truly zero warnings, not just a short summary line hiding them.
- Confirmed no PIN, hash, key or token appears in the new code's logging
  paths: `routes/operators.rs` only reaches `tracing::error!` through
  `ApiError::internal`, which logs the `sqlx::Error` display, never a request
  field.
- Confirmed every Cyrillic string added (test file, three new JSON fixtures,
  spec doc) round-trips as real UTF-8 text, not literal `\uXXXX` escapes.

## Concerns

None. All required checks are green, the diff matches the brief's file map
exactly, and the commit trailer is exactly as specified.
