# Plan 2a2, Task 3: code check, `GET /v1/device/codes/{codeHash}`

BASE `1d72a9ef6a307bfcdc9dbd481c2a3a06c983c61a`, commit `385a29ada` on `claude/2a2-facts` (worktree `/tmp/claude/wt/2a2-facts`). Status: DONE_WITH_CONCERNS.

## What was done

The plan's code was applied as written: `routes/codes.rs`, the route, `CodeCheck` in `proto`, two fixtures, the fixture test, the three plan tests in `host/tests/codes.rs`.

One finding went beyond the plan. **The plan's central invariant did not hold through the router.**

- `AuthDevice::from_request_parts` ran `UPDATE devices SET last_seen_at … WHERE … (last_seen_at IS NULL OR last_seen_at <= now-1min)` on every device request, even when the row was fresh.
- In SQLite, an `UPDATE` takes the write lock even when it matches no row. The extractor therefore waited for any writer (`busy_timeout` is 5 s), and it did so _before_ the handler ran.
- The plan's test calls `check_code` directly. The existing tests in `device_shifts.rs:1227` and `facts.rs:1117` say outright that the extractor writes `last_seen_at`, so no test could see this. A station's real HTTP check was not read-only.
- RED, proven: the added test `a_check_through_the_router_does_not_wait_for_a_writer_either` failed on the plan's code (`the check waited for the writer`, timeout at 1 s).
- Fix in `host/src/auth.rs`:
  - The extractor's `SELECT` now also reads `last_seen_at`.
  - The `UPDATE` runs only when the stored value is NULL or `<= now - 1 minute`.
  - The `WHERE` stays as the guard against a concurrent touch. Behaviour for any device is otherwise unchanged (`pairing.rs` still passes: the touch happens when due, synchronously).
  - This affects every device route. It makes all of them skip a pointless write lock.

## Anchor adaptations

- `apps/standalone/AGENTS.md`: the brief's anchor («…displaced device and the office's review come with plan 2b.\n\n## Marking rules») no longer matches because Task 2 added the timestamp-formats paragraph after it. I applied the brief's intent on the current text. The new paragraph goes right after the registry paragraph, before «Two timestamp formats…». I kept Task 2's text. I also added two sentences on the `last_seen_at` rule and its residual (below).
- `host/src/routes/codes.rs` did not exist ("FILE MISSING" is expected): it is created by this task.
- All other brief anchors (`mod.rs`, `server.rs`, `proto/src/lib.rs`, `fixtures.rs` x2) matched exactly once.

## Evidence

- RED (plan): `--test codes` failed to compile (`unresolved import markiro_host::routes::codes`, plus E0282 x2); `-p markiro-proto` failed (`unresolved import markiro_proto::CodeCheck`). Logs: `/tmp/claude/t3-red-host.txt`, `/tmp/claude/t3-red-proto.txt`.
- GREEN (plan code): `--test codes` 3 passed; `-p markiro-proto` 5 + 43 passed.
- RED (my router test, on the plan's code): 3 passed, 1 failed (`/tmp/claude/t3-red2.txt`).
- GREEN after the fix: `--test codes` 7 passed.
- Full run, outside the sandbox: `cargo test -p markiro-host -p markiro-proto --offline --locked` exit 0, 35 suites, **449 tests passed, 0 failed**. `proto` has 5 + 43 = 48, so host has 401. The brief says "host counts shifted by +7 (T1) and +7 (T2)" and the plan's own host figure for Task 3 is +3. My run has +7 beyond the plan (4 added tests and what T2 added), so the total is not comparable one-to-one with the plan's 393. I report the measured number only. Log: `/tmp/claude/t3/full.txt`.
- `cargo fmt --all -- --check` clean; `cargo check -p markiro-host -p markiro-proto --all-targets` 0 code warnings (only the environmental `xcrun` note); clippy shows nothing in `codes.rs`, `auth.rs` (the warnings it lists are older, in other files). `prettier --check` on the AGENTS and the two fixtures clean; `git diff --check` clean; no `\u0` in the new files. `git status --short` empty after the commit.

## Tests added beyond the plan (all in `host/tests/codes.rs`)

1. `a_check_through_the_router_does_not_wait_for_a_writer_either`. A writer holds `begin_write`, a real `GET` goes through the router under `timeout(1 s)`, and the precondition `last_seen_at == now` is asserted. Deterministic: the lock is held, there is no timing hope.
2. `only_a_live_device_of_a_supported_protocol_may_ask`:
   - a revoked key and an unknown key give 401 `credential: device`, with a valid hash and with a bad one (so a refused key is never turned into a `validation_failed`);
   - no key with a bad hash is 401;
   - another live device is unaffected by the revocation;
   - no protocol header gives `protocol_unsupported`;
   - POST, PUT and DELETE give 405.
3. `only_an_accepted_scan_owns_a_code_and_the_check_names_the_winner`:
   - `duplicate`, `wrong_gtin` and `invalid` scans leave the code free;
   - a later scan that lost leaves the owner unchanged;
   - the `winner` of the `conflict` receipt equals the check's `owner` for the same asker, and `sameDevice` flips for the owner's own device.
4. `a_check_moves_last_seen_once_the_minute_is_up_and_not_before`: 59 s leaves it, 60 s moves it, a NULL value is touched at once. It pins my auth change.

## Mutants (each restored byte-identically: sha256 equal and `cmp` against a copy; table from `/tmp/claude/t3/mut-results.jsonl`, harness `/tmp/claude/t3/mut.py`)

| Mutant (one change)                                        | Failed tests                                                                                | Restored |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| M1 plan: `is_code_hash` -> `code_hash.is_empty()`          | `only_a_code_hash_is_asked_for_and_only_by_a_device`                                        | yes      |
| M2 plan: `pool.acquire()` -> `begin_write`                 | `a_check_never_waits_for_a_batch_being_written`, `a_check_through_the_router_…`             | yes      |
| M3 plan: `to_wire(&device.id)` -> `to_wire("")`            | `a_code_is_free_until…`, `only_an_accepted_scan_owns…`                                      | yes      |
| M4 `is_code_hash` accepts upper case (`is_ascii_hexdigit`) | `only_a_code_hash_is_asked_for…`                                                            | yes      |
| M5 `len() == 64` -> `>= 64`                                | `only_a_code_hash_is_asked_for…`                                                            | yes      |
| M6 free and taken swapped                                  | 5 tests                                                                                     | yes      |
| M7 route registered as POST                                | 7 tests                                                                                     | yes      |
| M8 auth: touch always (`if true`)                          | `a_check_through_the_router_does_not_wait_for_a_writer_either` (the only test that sees it) | yes      |
| M9 auth: `seen <= due` -> `<`                              | `a_check_moves_last_seen_once…`                                                             | yes      |
| M10 auth: NULL never touched (`is_some_and`)               | `a_check_moves_last_seen_once…`                                                             | yes      |
| M11 auth: revoked key accepted                             | `only_a_live_device_of_a_supported_protocol_may_ask`                                        | yes      |
| M12 auth: never touched (`if false`)                       | `a_check_moves_last_seen_once…`                                                             | yes      |
| M13 handler: `ApiPath` before `AuthDevice`                 | compile error: the direct call in the no-wait test pins the order                           | yes      |
| M14 proto: tag `status` -> `state`                         | `code_check_fixtures_round_trip…`                                                           | yes      |
| M15 proto: `rename_all` -> camelCase                       | none; **equivalent** (`free` and `taken` are single words)                                  | yes      |
| M16 handler lower-cases the hash before validating         | `only_a_code_hash_is_asked_for…`                                                            | yes      |

M13's behavioural twin (401 before 400 for a bad hash plus a bad key) is covered by test 2, but the compile-time pin fires first.

## Review points the lead listed

- **Authorization.** "Station only / wrong kind": the plan says any device may ask and its test asserts an `office` device gets 200 with `sameDevice: false`. I kept it. Revoked or unknown key -> 401 (new test).
- **Validation.** The path rejection is `validation_failed` with `details.field = "codeHash"` (the plan's test; the handler's own check, not an `ApiPath` rejection, since the param is a `String`).
- **Shapes.** `free` is exactly `{status:"free"}`; `taken` has exactly the five `owner` keys. Asserted with whole-object equality, so a leak would fail.
- **Owner rules.** Earliest scan wins (the plan test displaces the owner with an earlier scan). A losing scan changes nothing. Non-`ok` verdicts own nothing (new test).
- **Headers.** The plan does not mention `Cache-Control`, and no route in the host sets it. I added nothing. Another response header would be a one-line `Cache-Control: no-store` if the lead wants it; the station's client is not a caching proxy.
- **Process log.** The handler logs nothing; `ApiError::internal` logs only the database error text. The host has no request-path logging layer (no `TraceLayer`), so the hash in the path never reaches the log. Task 8 should add a `GET codes` call to `no_secrets_in_logs.rs` to pin it.

## Concerns

1. **Residual wait for a stale device (needs a decision).** A device whose `last_seen_at` is more than a minute old still runs the touch `UPDATE` in the extractor on its next request. If a writer holds the lock at that moment, that one request waits for the writer (typically milliseconds; worst case `busy_timeout` 5 s, then a 500). (CORRECTED by the fix section below: the touch is at most once a minute per device, and the first request after each full minute, a scanning station's too, took the write lock. Only the code check is writer-free after the fix.) Options:
   - accept as is (documented in AGENTS);
   - make the touch best-effort and non-blocking: a detached task, but `tests/pairing.rs:229` reads `last_seen_at` right after a request, so that test would change;
   - a short `timeout` around the touch.

   I did not take the last two (invasive, and a cancelled sqlx statement has side effects on the pooled connection). This matters for plan 2a6: the station's 300 ms timeout is safe in steady state, but the first check after an idle minute can in theory time out and fall back to its own copy, which the plan already allows.

2. The `auth.rs` change touches every device route. It is semantically neutral (same update condition) and the full host suite is green, but the final reviewer should look at it, since it is outside the plan's file list.
3. Equivalent mutant M15 is noted above.

## Files

Created: `apps/standalone/host/src/routes/codes.rs`, `host/tests/codes.rs`, `proto/fixtures/code-check-free.json`, `proto/fixtures/code-check-taken.json`. Modified: `host/src/routes/mod.rs`, `host/src/server.rs`, `host/src/auth.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `apps/standalone/AGENTS.md`.

## Fix section (review Important 1; BASE 385a29ada, fix 93e5f03dd, comments 61501873f)

Overclaim corrected in three places: the doc/code comment (`host/src/auth.rs`, `routes/codes.rs`), `apps/standalone/AGENTS.md` (the codes paragraph), and Concern 1 above. The truth now stated: the touch happens at most once a minute per device, and the first request after each full minute (a scanning station's too) takes the write lock; ONLY the code-check route is writer-free.

Change: `auth.rs` keeps `AuthDevice` (touching) and adds `AskingDevice(pub AuthDevice)`, the read-only twin. Both call a private `authenticate(parts, state, touch)` with the same key lookup, the same 401 for a revoked/unknown/absent key, and the same kind parse; `touch = false` skips the `last_seen_at` UPDATE entirely. `routes/codes.rs::check_code` takes `AskingDevice(device)`; no other route changed.

RED (new test on the unfixed code, `/tmp/claude/t3fix-red.txt`): `a_check_after_the_touch_minute_does_not_wait_for_a_writer` FAILED, "the check waited for the writer: Elapsed(())" (station asks at +30 s, again at +60 s with the test clock while a writer holds `begin_write`; 1 s deadline against `busy_timeout` 5 s). GREEN after the fix: `--test codes` 8 passed.

Tests (all in `host/tests/codes.rs`): new `a_check_after_the_touch_minute_does_not_wait_for_a_writer` (a station and an office device answered `free` within 1 s at +60 s; after revocation the 401 `credential: device` also comes without waiting); `a_check_moves_last_seen_once…` replaced by `a_check_never_moves_last_seen_and_another_device_route_does_once_a_minute` (a check at +60 s leaves a stale value, a NULL stays NULL; `GET /v1/device` touches NULL at once, not at +59 s, yes at +60 s); the direct-call test uses `AskingDevice(AuthDevice {..})`. The revoked-key refusal and the office-kind 200 are still pinned by `only_a_live_device_of_a_supported_protocol_may_ask` and the first test.

Mutants (harness `/tmp/claude/t3fix/mut.py`, output `/tmp/claude/t3fix/mut-out.txt`; `auth.rs` restored from `/tmp/claude/t3fix/auth.rs.orig`, sha256 equal and `cmp` equal each time; run with `--test codes --test pairing`):

| Mutant (one change)                                                       | Failed                                                                                                                                   | Restored |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A `AskingDevice` calls `authenticate(.., true)` (the route touches again) | `a_check_after_the_touch_minute_does_not_wait_for_a_writer`, `a_check_never_moves_last_seen_and_another_device_route_does_once_a_minute` | yes      |
| B touching extractor never touches (`if touch` -> `if false`)             | `a_check_never_moves_last_seen_and_another_device_route_does_once_a_minute` (`pairing` stays green under B, see the note below)          | yes      |
| C revoked key accepted (`AND revoked_at IS NULL` dropped)                 | `only_a_live_device_of_a_supported_protocol_may_ask`, `a_check_after_the_touch_minute_does_not_wait_for_a_writer`                        | yes      |
| D touch threshold 1 min -> 30 s                                           | `a_check_never_moves_last_seen_and_another_device_route_does_once_a_minute`                                                              | yes      |

(Mutant A is also what the review calls "the route uses the touching check again".) Note on B: `pairing` stayed green under B, so only the new test pins the touching extractor; the earlier M12 row said the same of the old test.

Minors: 1 done (test comments in `device_shifts.rs`, `facts.rs`, `sscc_blocks.rs` now say the authentication "may write `last_seen_at` once a minute"; the plan text line 2148 is the plan document and was not edited). 2 and 3 listed in `.superpowers/sdd/2a2-minors.md` (items 6 and 7; Task 6 must expect `codes` = 8 tests plus its own), with the Task 8 log-check note (item 8).

Counts after the fix (sandbox, focused): codes 8, pairing 7, device_shifts 17, facts 17, sscc_blocks 13, claim 9, proto 5 + 43. `cargo fmt --check` 0, `cargo check -p markiro-host -p markiro-proto --all-targets` exit 0 (only the environmental `xcrun` build-script warning), clippy exit 0 with nothing in `auth.rs`/`codes.rs`, prettier on AGENTS clean, `git diff --check` clean, `git status --short` empty. The full host suite was NOT re-run (loopback tests). Not run: plan Task 6 anchors in `tests/codes.rs` (the `facts::receive` call is unchanged).
