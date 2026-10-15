# Plan 1c1, Task 4 — report

Station line selection (`PUT /v1/device/line`) and the office device list
(`GET /v1/office/devices`). `device_info` and the two new handlers move into a
new `routes/devices.rs` module, per the brief.

## What was implemented

- **Protocol** (`apps/standalone/proto/src/lib.rs`): `DeviceLineRequest { line_id }`
  (`deny_unknown_fields`) and `DeviceRecord { id, kind, name, line_id, app_version,
paired_at, last_seen_at, revoked_at }`, placed right after `DeviceInfo`.
  Fixtures `device-line-request.json` and `device-record.json` added; both
  round-trip in `proto/tests/fixtures.rs`, and the request fixture is checked
  to reject an unknown field.
- **Zod** (`apps/standalone/src/host/protocol.ts`): `deviceRecordSchema`
  (lenient, like other host-response schemas) added after `deviceInfoSchema`,
  with a matching `it("device record", …)` case in `test/protocol.test.ts`.
- **Host** (`apps/standalone/host/src/routes/devices.rs`, new module):
  - `device_info` (`GET /v1/device`), moved verbatim from `pairing.rs`, refactored
    into a small `read_info` helper shared with `select_line` so both read
    through the same query (the write path reads it through the open
    transaction instead of a second pooled connection).
  - `select_line` (`PUT /v1/device/line`): only a `station` device (403
    otherwise); validates the target line exists and is not archived (400
    `validation_failed`/`lineId` otherwise); no-ops (no row write, no audit
    row) when the line does not change, via `audit::update_details`; writes
    one `device.line` audit row (`Actor::Device`) when it does. Never calls
    `next_revision` — devices are intentionally outside the change feed.
  - `list_devices` (`GET /v1/office/devices`, admin-only): every paired
    device (revoked ones included), ordered by `(paired_at, id)`.
  - `routes/mod.rs` gained `pub mod devices;` (alphabetical).
  - `routes/pairing.rs` lost `device_info` and the now-unused `DeviceInfo`/
    `AuthDevice` imports; its module doc no longer mentions `GET /v1/device`.
  - `server.rs`: `/v1/device` now points at `devices::device_info`; added
    `PUT /v1/device/line` → `select_line` and `GET /v1/office/devices` →
    `list_devices`.
  - `audit.rs`: `actions::DEVICE_LINE = "device.line"` added alongside the
    other action constants.
- **Test**: `apps/standalone/host/tests/device_line.rs` (new), 4 tests, taken
  verbatim from the brief.

## TDD evidence

**RED** — before any implementation, only the test file existed:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --offline
```

```
---- the_administrator_lists_paired_devices stdout ----
thread 'the_administrator_lists_paired_devices' panicked at host/tests/device_line.rs:133:5:
assertion `left == right` failed
  left: 404
 right: 200

---- a_station_chooses_an_active_line stdout ----
thread 'a_station_chooses_an_active_line' panicked at host/tests/device_line.rs:56:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for PUT /v1/device/line"}}
  left: 404
 right: 200

---- only_an_existing_active_line_is_accepted stdout ----
thread 'only_an_existing_active_line_is_accepted' panicked at host/tests/device_line.rs:100:9:
assertion `left == right` failed: 8d9c35e1-63ca-48e4-b3b5-f1d63e650850
  left: 404
 right: 400

---- only_a_station_works_on_a_line stdout ----
thread 'only_a_station_works_on_a_line' panicked at host/tests/device_line.rs:119:5:
assertion `left == right` failed
  left: 404
 right: 403

test result: FAILED. 0 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s
```

All four failed with 404 (`not_found`) rather than 405 for the `PUT` case —
per the brief's own note ("Expected red in Step 2"), no route at all matches
`/v1/device/line` yet, so axum's `fallback(not_found)` answers before the
method-not-allowed fallback would apply. This is the anticipated, acceptable
red; recorded as instructed rather than treated as a problem.

**GREEN** — after implementing `routes/devices.rs`, wiring `server.rs`, and
adding `audit::actions::DEVICE_LINE`:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --test pairing --offline -- --nocapture
```

```
     Running tests/device_line.rs
running 4 tests
test only_a_station_works_on_a_line ... ok
test only_an_existing_active_line_is_accepted ... ok
test a_station_chooses_an_active_line ... ok
test the_administrator_lists_paired_devices ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.20s

     Running tests/pairing.rs
running 6 tests
test protected_routes_require_the_protocol_header ... ok
test local_pairing_from_the_network_is_refused ... ok
test refused_local_pairing_writes_no_audit_row ... ok
test invalid_local_pair_requests_are_validation_errors ... ok
test a_local_station_pairs_and_only_the_key_hash_is_stored ... ok
test a_device_reads_itself_with_its_key_until_revoked ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

(`pairing.rs` re-run confirms `device_info`'s move did not change its
observable behavior — the pre-existing device-info test there still passes.)

## Every verification command and result

All commands below returned exit code 0 unless noted.

1. Step 1 (protocol/fixtures), before writing host tests:
   - `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` → **18 passed** (was 17; +1 new `device_line_and_record_fixtures_round_trip`).
   - `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts` → **41 passed** (was 40; +1 new "device record").
2. Step 2 (RED): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --offline` → **4 failed** as expected (see above).
3. Step 3 (GREEN): `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test device_line --test pairing --offline` → **10 passed** (4 + 6).
4. Full `markiro-host` crate, **outside the sandbox** (`hello.rs`, `platform.rs`, `no_secrets_in_logs.rs` bind real ports):
   `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` → **95 passed, 0 failed**, across 14 test binaries + unit tests + 0 doctests. Matches the brief's "current numbers" exactly: 91 pre-existing + 4 new = 95.
5. Re-ran after `cargo fmt` (see Deviations): same result, **95 passed, 0 failed**, exit code 0.
6. `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` (final gate) → **18 passed**.
7. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts` (final gate) → **41 passed**.
8. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` → **initially failed** (see Deviations); **passed** after `cargo fmt --all`.
9. `node_modules/.bin/prettier --check apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/proto/fixtures/device-line-request.json apps/standalone/proto/fixtures/device-record.json` → **all matched files use Prettier code style**.
10. `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` (`tsc -p tsconfig.json --noEmit`) → **exit 0**, no diagnostics.
11. `git diff --check` → **exit 0**, no whitespace errors.
12. Bonus self-review check, not in the brief's list: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` → **exit 0**, clean.

Not run, deliberately out of this task's scope: `cargo test --workspace` (would
require building `apps/standalone/dist` for the `markiro-standalone`/Tauri
crate, which this task does not touch), `cargo clippy`, and any Windows/browser
verification. This task is a pure host route + protocol change exercised
entirely by in-process axum router tests; there is no UI, hardware, or
Windows-specific surface in it.

## Files changed

Staged and committed exactly the paths listed in the brief's Step 4:

- `apps/standalone/host/src/routes/devices.rs` (new)
- `apps/standalone/host/src/routes/mod.rs` (modified — added `pub mod devices;`)
- `apps/standalone/host/src/routes/pairing.rs` (modified — removed `device_info` + its now-unused imports + doc mention)
- `apps/standalone/host/src/server.rs` (modified — rewired `/v1/device`, added the two new routes)
- `apps/standalone/host/src/audit.rs` (modified — added `actions::DEVICE_LINE`)
- `apps/standalone/host/tests/device_line.rs` (new)
- `apps/standalone/proto/src/lib.rs` (modified — added `DeviceLineRequest`, `DeviceRecord`)
- `apps/standalone/proto/tests/fixtures.rs` (modified — import + round-trip test)
- `apps/standalone/proto/fixtures/device-line-request.json` (new)
- `apps/standalone/proto/fixtures/device-record.json` (new)
- `apps/standalone/src/host/protocol.ts` (modified — added `deviceRecordSchema`)
- `apps/standalone/test/protocol.test.ts` (modified — import + "device record" test)

Commit: `3366daeff` — `feat(standalone): выбор линии станцией и список устройств для офиса`.
Trailer verified with `git log -1 --format=%B`:

```
feat(standalone): выбор линии станцией и список устройств для офиса

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Deviations

1. **RED status code was 404, not 405**, for `PUT /v1/device/line` before the
   route existed. The brief itself flagged this as an open ambiguity ("either
   is a valid red; record what you actually see") — no route at all matched
   the path, so axum's `fallback(not_found)` answered before a
   method-not-allowed case could apply. No code change needed; recorded as
   instructed.
2. **`cargo fmt --all` reformatted three files** (`routes/devices.rs`,
   `server.rs`, `host/tests/device_line.rs`) after I transcribed the brief's
   code verbatim: the brief's own snippets are not rustfmt-clean (mostly
   line-wrapping of long `.route(...)` calls, a multi-line closure body, and
   long tuple types in the test file). Per the constraints file ("Перед
   каждым коммитом: `cargo fmt` ... `--all` and `--all -- --check`"), I ran
   `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` and re-verified
   `--check` passes. This is purely mechanical reformatting — I re-read all
   three files afterward and confirmed no logic, assertions, or behavior
   changed, then re-ran the full host suite (still 95/95 green).
3. **Commit trailer uses "Claude Opus 5.5"**, not the session-default
   "Claude Sonnet 5" from the generic attribution reminder. This matches the
   explicit, repeated instruction in this task's brief and in
   `1c1-constraints.md` ("трейлер ровно `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`"), and is the exact convention already used by
   every prior commit on this branch for plan 1c1 (tasks 1-3: `e25a2fbc1`,
   `5de751fe2`, `b6dee46ce`, `41bab6e7e`, `500994d71` all carry this same
   trailer). Kept the branch consistent rather than switching conventions
   mid-plan.

No other deviations. All brief-supplied code compiled and behaved as written
once formatted; no assertions were weakened or altered.

## Self-review

- **Completeness**: all four brief steps done in order (protocol/fixtures →
  failing tests → implementation → gates/commit); every interface the brief
  listed as "Produces" exists exactly as specified (`DeviceLineRequest`,
  `DeviceRecord`, both routes, `routes::devices::{device_info, select_line,
list_devices}`, `actions::DEVICE_LINE`, `deviceRecordSchema`).
- **YAGNI**: no renaming, reassignment-from-office, or revoke logic added —
  the brief explicitly defers those to plan 1d, and I did not anticipate them.
  `DeviceRow`/`read_info` are the minimum shared plumbing the two read paths
  need; no speculative abstraction beyond that.
- **Matches existing patterns**: `select_line` follows the same shape as
  `select_line`'s siblings elsewhere in the codebase — `begin_write` for the
  transaction, reads through `&mut *tx` rather than a second pooled
  connection (per the "Writes" rules in `apps/standalone/AGENTS.md`), a
  no-op short-circuit via `audit::update_details` before any write, and
  `ApiError::validation`/`ApiError::forbidden` used the same way `pairing.rs`
  and `office_users.rs` use them. `list_devices` mirrors `office_users::list_users`'s
  admin-gate-then-list shape, and its `DeviceKind` parse from a DB TEXT column
  uses the exact `serde_json::from_value(Value::String(..))` idiom already in
  `auth.rs:56-57`, as the task brief pointed out. No revision bump anywhere in
  `select_line`, matching the constraint that devices are excluded from the
  change feed.
- **Clean test output**: full `markiro-host` run outside the sandbox shows
  95 passed, 0 failed, 0 ignored, and `grep -c warning` over the captured log
  found zero compiler warnings. `git status --short` is clean after the
  commit (nothing left uncommitted, nothing untracked).
- Verified `apps/station` was not touched (not in the diff, not in
  `git status`).
- Verified no new Cargo dependencies were introduced (`Cargo.lock` not in the
  diff).
- Did not use `git stash`; did not run `pnpm install`/`pnpm add`; did not pipe
  test output through `tail`/`grep` when an exit code was the thing being
  checked (used explicit `echo "EXIT_CODE=$?"` capture instead, and used
  `tail`/`grep` only after the pass/fail determination was already made from
  the un-truncated run or the exit code).
