# Task 6 report — Устройства: `PUT /v1/office/devices/{id}` и отзыв с концом потоков и сессий

**Status:** DONE (one plan-count deviation, see "Deviations"; two low-severity observations, see "Concerns")

**Commit:** `dc8355920` — `feat(standalone): устройства в офисе хоста, отзыв закрывает ключ, сессии и потоки`
Trailer verified with `git log -1 --format=%B`: exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
Base: HEAD `b0ce2be75`. Working tree clean after the commit.

## What was implemented

- `POST /v1/office/devices/{id}/revoke` (administrators): in one write transaction it sets `revoked_at`, deletes the device's
  `office_sessions`, writes one `device.revoke` audit row (`{ kind, name }`) and returns the `DeviceRecord` with `revokedAt`. After the
  commit it raises `AppState::revocations` (`watch<u64>`, `send_modify(wrapping_add(1))`). A second revoke returns 200 with the unchanged
  record and writes no row and no audit row. The device stays in `GET /v1/office/devices`.
- `PUT /v1/office/devices/{id}` (administrators) with `DeviceUpdate { name?, lineId?: string | null }`: name is trimmed and checked (1-100),
  `lineId: null` clears, a line is accepted only for a station and only if it exists and is not archived (`validation_failed`, `field: lineId`).
  The body is validated before the record is looked up (`not_found` only for a valid body). Nothing changed means no write and no audit row.
  Audit `device.update` carries `update_details` for `name` and `lineId`. The host revision is not touched (devices have no `rev`, not in the feed).
- `require_active_line` is now shared by `PUT /v1/device/line` (`select_line`, behaviour unchanged) and the office `PUT`.
- Change stream (`routes/changes.rs`): `stream` takes the `AuthDevice`, subscribes to `revisions`, `revocations` and `stopping` first, then
  re-checks that the device is not revoked (`device_active`) before reading the current revision (a revoke between `AuthDevice` and the
  subscription is caught here and answered `unauthorized`/`credential: device`). The `unfold` state is now a `Follow` struct; a `Wake` enum
  (`Revision`, `Revocation`, `Stop`) says what woke the stream; on `Revocation` the stream re-reads its own device and ends if it was revoked
  (a failed re-read also ends it: the device reconnects and `AuthDevice` checks the key again).
- `validate::device_name(field, name)` (also used by `device_registration`), `actions::DEVICE_UPDATE` / `DEVICE_REVOKE`,
  `markiro_proto::DeviceUpdate` (`deny_unknown_fields`, `nullable` for `lineId`), the `revocations` field of `AppState`, two routes in `server.rs`.
- Docs: `apps/standalone/AGENTS.md` («Change feed», «Device key and office session») and the spec §4.5 and §4.7.

## TDD evidence

### RED (before any implementation code)

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test devices --offline` — 6 of 6 fail, all with 404 where 200/400/403 is expected:

```
thread 'an_administrator_renames_a_device_and_sets_its_line' panicked at host/tests/devices.rs:40:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for PUT /v1/office/devices/<id>"}}
  left: 404
 right: 200
thread 'a_device_line_is_an_active_line_and_only_a_stations' panicked at host/tests/devices.rs:132:9:
  left: (404, Null)
 right: (400, String("lineId"))
thread 'revoking_a_device_refuses_its_key_and_ends_its_office_sessions' panicked at host/tests/devices.rs:183:5:
  ... "no route for POST /v1/office/devices/<id>/revoke"   left: 404  right: 200
thread 'an_administrator_may_revoke_the_device_they_use' panicked at host/tests/devices.rs:254:5:
  ... "no route for POST /v1/office/devices/<id>/revoke"   left: 404  right: 200
thread 'technologists_cannot_manage_devices' panicked at host/tests/devices.rs:275:5:
  left: 404
 right: 403
thread 'an_unknown_device_is_not_found_once_the_body_is_valid' panicked at host/tests/devices.rs:295:5:
  left: (404, Null)
 right: (400, String("name"))
test result: FAILED. 0 passed; 6 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.25s
```

`cargo test ... -p markiro-host --test changes_stream revoking --offline`:

```
test revoking_a_device_ends_its_open_stream_and_no_other ... FAILED
thread 'revoking_a_device_ends_its_open_stream_and_no_other' panicked at host/tests/changes_stream.rs:338:5:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/office/devices/<id>/revoke"}}
  left: 404
 right: 200
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.09s
```

`cargo test ... -p markiro-host --lib validate --offline`:

```
error[E0425]: cannot find function `device_name` in this scope
   --> host/src/validate.rs:465:20
   (4 occurrences, lines 465-468)
error: could not compile `markiro-host` (lib test) due to 4 previous errors
```

`cargo test ... -p markiro-proto --test fixtures --offline`:

```
error[E0432]: unresolved import `markiro_proto::DeviceUpdate`
 --> proto/tests/fixtures.rs:6:19
error: could not compile `markiro-proto` (test "fixtures") due to 1 previous error
```

### GREEN (after the implementation)

`cargo test ... -p markiro-host --test devices --test device_line --offline`:

```
tests/device_line.rs: 4 passed (only_a_station_works_on_a_line, only_an_existing_active_line_is_accepted,
                                a_station_chooses_an_active_line, the_administrator_lists_paired_devices)
tests/devices.rs:     6 passed (an_administrator_renames_a_device_and_sets_its_line, a_device_line_is_an_active_line_and_only_a_stations,
                                revoking_a_device_refuses_its_key_and_ends_its_office_sessions,
                                an_administrator_may_revoke_the_device_they_use, technologists_cannot_manage_devices,
                                an_unknown_device_is_not_found_once_the_body_is_valid)
```

`cargo test ... -p markiro-host --test changes_stream --offline` (outside the sandbox, `open_streams_end_when_the_host_stops` binds 127.0.0.1):

```
running 8 tests ... revoking_a_device_ends_its_open_stream_and_no_other ... ok (and the 7 existing ones)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s
```

`cargo test ... -p markiro-host --lib --offline`: `test result: ok. 27 passed; 0 failed` (includes `validate::tests::a_device_name_is_trimmed_to_1_to_100_characters`; the brief says 26, see "Deviations").

`cargo test ... -p markiro-proto --test fixtures --offline`: `test result: ok. 26 passed; 0 failed` (includes `a_device_update_tells_a_cleared_line_from_an_absent_one`).

### Mutation check (is the stream test behavioural?)

Temporarily removed the `state.revocations.send_modify(...)` call from `revoke_device`; `revoking_a_device_ends_its_open_stream_and_no_other` then
failed with `the revoked device's stream ends within 5 s: Elapsed(())` (5.10 s). The file was restored byte-for-byte from the brief's block
(`diff` identical) and the test passes again. The committed code is the un-mutated version.

## Verification commands and results

| Command                                                                                                                                                                               | Where           | Result                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `cargo test ... -p markiro-host --test devices --test device_line --offline`                                                                                                          | sandbox         | 6 + 4 passed                                                                                     |
| `cargo test ... -p markiro-host --test changes_stream --offline`                                                                                                                      | outside sandbox | 8 passed                                                                                         |
| `cargo test ... -p markiro-host --lib --offline`                                                                                                                                      | sandbox         | 27 passed (brief: 26)                                                                            |
| `cargo test ... -p markiro-proto --test fixtures --offline`                                                                                                                           | sandbox         | 26 passed                                                                                        |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                               | sandbox         | clean (exit 0), re-run just before the commit                                                    |
| `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/device-update.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | sandbox         | "All matched files use Prettier code style!"                                                     |
| `git diff --check`, `git diff --cached --check`, `git show --check HEAD`                                                                                                              | sandbox         | clean (exit 0 each)                                                                              |
| `cargo check ... -p markiro-host -p markiro-proto --all-targets --offline`                                                                                                            | sandbox         | 0 warnings                                                                                       |
| `cargo check ... --workspace --all-targets --offline`                                                                                                                                 | sandbox         | 0 warnings, 0 errors                                                                             |
| `cargo test ... --workspace --offline`                                                                                                                                                | outside sandbox | exit 0; 32 test binaries, 282 passed, 0 failed, 0 ignored; 0 warnings (3 doc-test runs, 0 tests) |
| non-ASCII check of every added line                                                                                                                                                   | sandbox         | only Cyrillic letters and an em dash; no literal `\uXXXX` in any touched file                    |

Not run: Vitest, `typecheck`, `lint`, `build` of the webview (the task touches no TypeScript; `apps/standalone/src/host/protocol.ts` and its Zod schemas
are plan 1d3 for the new fixtures, and no Vitest suite enumerates `proto/fixtures`); `graphify update .` (no `graphify-out/` in this worktree).
Not exercised at all: Windows service, DPAPI, real LAN pairing, real (non-in-process) TLS clients for the revoke path, hardware. The revoke path was
exercised in-process (router `oneshot`) and, for the stream, through `open_streams_end_when_the_host_stops` only for the pre-existing stop path.

## Files changed (12, +736 -89)

- Created: `apps/standalone/host/tests/devices.rs` (verbatim from the brief; `diff` identical), `apps/standalone/proto/fixtures/device-update.json`
- Rewritten (whole file, verbatim from the brief; `diff` identical): `apps/standalone/host/src/routes/devices.rs`
- Modified: `apps/standalone/host/src/validate.rs`, `audit.rs`, `server.rs`, `routes/changes.rs`; `apps/standalone/proto/src/lib.rs`;
  tests `apps/standalone/host/tests/changes_stream.rs`, `apps/standalone/proto/tests/fixtures.rs`;
  docs `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
- Not touched: `apps/station`, `src-tauri`, the webview.

All 18 brief anchors matched the current files byte for byte. (My first attempt at the changes.rs `use` block used a range that included the
closing code fence of the brief, so the edit helper refused it without writing anything; I corrected my range and re-applied. That was my own
extraction slip, not an anchor mismatch.)

## Deviations

1. **Host `--lib` count is 27, not the brief's 26.** Cause: `b0ce2be75` (the task 5 review fix) added
   `validate::tests::a_zero_padded_iteration_count_is_a_second_spelling_and_is_refused` after the plan's expected number was computed. HEAD had
   26 lib tests (audit 3, network 2, pairing_code 2, secrets 8, server 3, validate 8); the new `a_device_name_...` test makes 27. No defect; the
   controller may want to update the number in the plan text for later tasks that quote the lib count.
2. None otherwise: code, SQL, wire shapes, test cases and values are the brief's, copied programmatically from it where long (devices.rs, both new
   test blocks, the changes.rs stream block, the docs blocks) so no typing slips crept in.

## Self-review findings

- Completeness against the brief: Steps 1-6 all done; every item of "Produces" exists with the stated name and signature
  (`AppState::revocations`, `validate::device_name`, `actions::DEVICE_UPDATE`/`DEVICE_REVOKE`, `DeviceUpdate`, the two routes).
- Tests verify behaviour, not just status codes: exact audit rows (actor, id, action, target, result, parsed details), host revision unchanged,
  session rows deleted for that device only, another device's session still valid, revoked key refused on three paths, the revoked stream ends
  within 5 s while the heartbeat is 15 s, the other stream stays open and receives the next revision; the mutation check above proves the stream test
  fails without the wake.
- Rules from `apps/standalone/AGENTS.md` «Writes»: `begin_write`, `require_admin_in` inside the transaction, no-ops write nothing, no pool use while a
  write transaction is open (the stream's `device_active` on the pool runs in the stream, not in a write path), the revision is not bumped (devices are not in the feed).
- Logs and audit: no secret, key, token or hash in `details`, nothing is logged by the new code.
- Output pristine: 0 warnings in `cargo check --workspace --all-targets` and in the full workspace test run.
- No overbuilding: nothing beyond the brief was added (no extra tests, no refactors besides the brief's `require_active_line`/`record`/`read_record` helpers).

## Concerns (none blocking)

1. **The refusal branch of the recheck-after-subscribe in `stream()` has no deterministic test.** The window between `AuthDevice` and the
   subscription cannot be hit through HTTP, so only the happy path of `device_active` at open is executed (every stream-open test passes through it).
   A follow-up could call `markiro_host::routes::changes::stream(State(state), AuthDevice { id, kind })` directly (`routes::changes` is `pub`) for a
   device revoked by SQL and assert a 401 from `.into_response()`. Not added: outside the brief's test list.
2. **A revoked device can still be renamed or given a line by `PUT`** (the brief does not forbid it). Harmless (its key is dead), and probably wanted for
   record keeping; noting it in case the screen in plan 1d3 should disable those controls for a revoked row.
3. **Login racing a revocation leaves a session row on a revoked device** (the key is checked by `AuthDevice` before the revoke commits, the session is
   opened after the delete). Harmless: `AuthDevice` refuses that key on every later request and `open_session` purges idle sessions. It sits in
   `routes/office_auth.rs`, which is not in this task's file list, so I left it.
4. Environment note for future runs: with `dangerouslyDisableSandbox: true`, `$TMPDIR` resolves to another directory than inside the sandbox
   (`/var/folders/...` versus `/tmp/claude-501`), so redirects to `$TMPDIR/...` fail outside the sandbox; use an absolute path there. (My first
   workspace-test run failed at the redirect and ran nothing; the rerun with an absolute path is the one reported.)
