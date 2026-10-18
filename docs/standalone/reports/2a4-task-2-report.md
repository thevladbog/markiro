# Plan 2a4, Task 2 report: `host_request` time limit (`timeoutMs`, code `timeout`)

Status: DONE_WITH_CONCERNS (concerns are only deviations/additions, listed below).
BASE: f459691dd. Commit: 38a7cf386 `feat(standalone): host_request takes a time limit, and running past it is timeout` (trailer: single `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`). `git status --short` empty afterwards.

## What was done

Plan code applied verbatim (every anchor matched exactly once): `RequestError::Timeout` + code `"timeout"`, `PinnedClient::send_within` (per-request `.timeout(limit)`, `lost` mapping `is_timeout()` to `Timeout` only when a limit is set, applied to both `send()` and `bytes()`), `device::{MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, request_limit}`, `DeviceState::request_within` (route check, then limit check, then `paired()`), `host_request` `timeout_ms` argument, webview `HostRequestOptions.timeoutMs`, `"timeout"` in `TRANSPORT_CODES`, `errors.transport.timeout` text. `send`/`request` delegate with `None`.

pnpm used as `pnpm --dir /tmp/claude/wt/2a4-shell ...` (verified: it resolved `/private/tmp/claude/wt/2a4-shell/apps/standalone`).

## Additions beyond the plan (all found by the mutant hunt)

1. `device.rs` unit test `a_timeout_must_lie_between_100_ms_and_10_s`: the plan's version used the constants themselves (`MIN_TIMEOUT_MS - 1`, `MAX_TIMEOUT_MS + 1`), so moving a bound survived (mutants F, G, H, I below passed with exit 0). Now it asserts `(MIN, MAX) == (100, 10_000)` and uses literals 100/101/300/9_999/10_000 accepted and 0/1/99/10_001/u64::MAX refused.
2. New 4th test in `host_request_timeout.rs`, `a_body_that_never_ends_is_a_timeout_too`: against a real `markiro-host` (already a dev-dependency) `PinnedClient::send_within("GET", "/v1/changes/stream", ..., Some(300 ms))` — headers arrive, body never ends, expected `Timeout`. Bounded by `tokio::time::timeout(5 s)`. The plan's tests did not cover the `bytes().map_err(lost)` path (mutant C).
3. `test/client.test.ts`: literal test that a rejected `"timeout"` becomes transport code `timeout` and `TRANSPORT_CODES` contains it (the plan's `it.each(TRANSPORT_CODES)` is derived from the list, so dropping `"timeout"` from the list survived).
4. `test/errors.test.ts`: `errorMessageKey` for `timeout` is `errors.transport.timeout` and the text is `Хост не ответил вовремя.` (changing the text survived the derived "text for every code" test).

## RED evidence

- `cargo test ... -p markiro-standalone --test host_request_timeout --test ipc --no-run` (`/tmp/claude/t2/red-cargo.txt`): compile FAIL, 7 errors: `E0599 no method named request_within found for struct DeviceState` (4x), `E0599 no variant or associated item named Timeout found for enum RequestError`, 2x `E0282 type annotations needed`; `error: could not compile markiro-standalone (test "host_request_timeout")`. (The plan said `ipc` compiles; it did.)
- `vitest run test/client.test.ts`: 1 failed | 14 passed — "passes a time limit in milliseconds only when one is asked for".

## GREEN evidence

- `cargo test -p markiro-standalone --lib` (inside sandbox): 48 passed.
- `--test host_request_timeout` (outside sandbox): 4 passed in 2.01 s (plan: 3; +1 mine). `--test ipc`: 13 passed.
- Full `cargo test --offline --locked -p markiro-standalone` (outside sandbox): lib 48, claim 4, connection 6, device 13, host_probe 2, host_probe_proxy 1, host_request_timeout 4, ipc 13, line 14, local_db 12, lockdown 4 — all ok, 0 warnings.
- `vitest run --reporter=verbose test/client.test.ts test/errors.test.ts`: 2 files, 22 tests (plan: 20; +2 mine), no `stderr |`. Full `pnpm test`: 67 files, 1748 tests (plan: 1746; +2 mine), 0 `stderr |`. `typecheck`, `lint`, `build`: exit 0.
- `cargo fmt --all -- --check` clean (after `cargo fmt` fixed import order in the new test file), `cargo check -p markiro-host -p markiro-proto --all-targets --offline`: 0 warnings, prettier check on changed TS/JSON clean, `git diff --check` clean, `grep -rnF '\u04' src test` finds only `src/host/pairing-code.ts:66`; no `\u0` in the Rust files I wrote.
- Delayed-`setImmediate` stand: not run — the changed TS tests render no React (the plan says the stand is not needed for them).

## Mutant table (every one restored byte-identically: `cmp` silent and sha256 equal before/after; raw outputs in `/tmp/claude/t2/mut-*.txt`)

| Mutant (one line)                                                                                             | Covering test that failed                                                                                 | Key line                                                               |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A (plan 1) `host_client.rs`: `limit.is_some() && error.is_timeout()` -> `error.is_timeout()`                  | `a_request_without_a_limit_still_ends_as_unreachable`                                                     | left `Err(Request(Timeout))`, right `Err(Request(Unreachable))`        |
| B (plan 2) drop the `if let Some(limit) ... request.timeout(limit)` block                                     | `a_request_past_its_own_limit_fails_with_timeout`, `a_body_that_never_ends_is_a_timeout_too`              | the second hits its own 5 s deadline (`expect` panic), does not hang   |
| C `bytes().map_err(lost)` -> `map_err(\|_\| Unreachable)`                                                     | `a_body_that_never_ends_is_a_timeout_too` (my new test; the plan's tests did not catch this)              | left `Err(Unreachable)`, right `Err(Timeout)`                          |
| P `Err(error) => Err(lost(error))` -> `Err(_) => Err(Unreachable)`                                            | `a_request_past_its_own_limit_fails_with_timeout`                                                         | left `Err(Unreachable)`, right `Err(Timeout)`                          |
| D `Timeout => "timeout"` -> `"unreachable"`                                                                   | `ipc::host_request_takes_a_limit_in_milliseconds` (and the lib unit test)                                 | left `Err("unreachable")`, right `Err("timeout")`                      |
| E `send` delegates with `Some(1 ms)` instead of `None`                                                        | `a_body_that_never_ends_is_a_timeout_too` (pairing through `send` breaks)                                 | `.unwrap()` panic                                                      |
| F MIN 100 -> 99                                                                                               | lib `a_timeout_must_lie_between_100_ms_and_10_s`                                                          | `left: (99, 10000)`; SURVIVED with the plan's test, fixed (addition 1) |
| G MIN 100 -> 101                                                                                              | same                                                                                                      | `left: (101, 10000)`; survived before the fix                          |
| H MAX 10_000 -> 10_001                                                                                        | same                                                                                                      | `left: (100, 10001)`; survived before the fix                          |
| I MAX 10_000 -> 9_999                                                                                         | same                                                                                                      | `left: (100, 9999)`; survived before the fix                           |
| J `..=` -> `..` (10 000 refused)                                                                              | same                                                                                                      | 10000 `Err(InvalidRequest)`, wanted `Ok(Some(10s))`                    |
| J2 lower bound exclusive (`MIN + 1..=MAX`)                                                                    | same                                                                                                      | 100 refused                                                            |
| K out-of-bounds returns `Ok(None)` (unlimited)                                                                | same                                                                                                      | `0`: `Ok(None)` vs `Err(InvalidRequest)`                               |
| L `Duration::from_millis` -> `from_secs` in `request_limit`                                                   | same                                                                                                      | `Ok(Some(100s))` vs `Ok(Some(100ms))`                                  |
| M `request_within` passes `None` to `send_within` instead of `limit`                                          | `a_request_past_its_own_limit_fails_with_timeout`                                                         | `Unreachable` vs `Timeout`                                             |
| Q limit check after `paired()` and the limit dropped                                                          | `a_limit_outside_its_bounds_is_refused_before_any_io`, `a_request_past_its_own_limit...`                  | `Unreachable` vs `InvalidRequest` for `0`                              |
| N `lib.rs` passes `None` instead of `timeout_ms`                                                              | `ipc::host_request_takes_a_limit_in_milliseconds`                                                         | `"unreachable"` vs `"timeout"`                                         |
| O `lib.rs` parameter renamed `timeout_ms` -> `limit_ms` (arg name `timeoutMs` no longer maps)                 | same ipc test                                                                                             | `"unreachable"` vs `"timeout"`                                         |
| T1 (plan 3) `client.ts` `...(timeoutMs === undefined ? {} : { timeoutMs })` -> `timeoutMs: timeoutMs ?? null` | 3 tests: both older exact-args tests and the new one                                                      | exact-args mismatch                                                    |
| T4 never send `timeoutMs`                                                                                     | "passes a time limit ..."                                                                                 |                                                                        |
| T5 always send `timeoutMs` (`...{ timeoutMs }`, undefined)                                                    | "passes a time limit ..." (the `not.toHaveProperty` half; `toHaveBeenCalledWith` alone ignores undefined) |                                                                        |
| T6 drop `"timeout"` from `TRANSPORT_CODES`                                                                    | my literal test "reads the shell's timeout as its own transport code"; survived the plan's `it.each`      |                                                                        |
| T7 drop the `timeout` text from `ru.json`                                                                     | errors.test "have a text for every code" and my text test                                                 |                                                                        |
| T8 change the `timeout` text                                                                                  | my text test only                                                                                         |                                                                        |

Mutant M's anchor first collided with a second occurrence and the script aborted before editing; the re-run used an anchor unique per file (restore proof still holds for every row).

## Files changed (9)

`apps/standalone/src-tauri/src/{host_client,device,lib}.rs`, `src-tauri/tests/{host_request_timeout (new),ipc}.rs`, `apps/standalone/src/host/client.ts`, `src/i18n/ru.json`, `test/{client,errors}.test.ts`. Not touched: `Cargo.toml`, `Cargo.lock`, `ci.yml`, host, proto.

## Self-review and concerns

- Behaviour note, per the plan's ordering: an out-of-bounds `timeoutMs` on an UNPAIRED device answers `invalid_request` (limit checked before `paired()`), not `not_paired`.
- The 300 ms timing assertion in `a_request_past_its_own_limit...` (< 1500 ms) and the 2 s no-limit test depend on the client's 2 s connect limit; same assumption as the plan.
- Counts differ from the plan: `host_request_timeout` 4 (plan 3), Vitest 1748 (plan 1746), `client`+`errors` files 22 tests (plan 20) — all differences are my four additions above.
- The prior `cd` slips: two Bash calls started with `cd /tmp/claude/wt/2a4-shell` (read-only greps); `find` found no stray `.cc-writes` and `git status` was clean.
- Not verified: anything on real Windows/hardware (not in this task's scope).

## Fix round (review Important 1 + Minors 2-3)

BASE 38a7cf386. Commits: 6c6be1836 `fix(standalone): a host that never accepts the connection is unreachable, not a timeout`; 094f969c1 `docs(standalone): the ipc timeoutMs test comment names the client's 2 s connect limit`. Single Opus trailer on both; `git status --short` empty.

- Production fix: `lost` in `host_client.rs` now `limit.is_some() && error.is_timeout() && !error.is_connect()`; `RequestError::Unreachable` doc says "one of the client's own time limits (its 2 s to connect, its 10 s per request)" (Minor 3).
- New test `a_host_that_never_accepts_the_connection_is_unreachable_not_a_timeout` (`host_request_timeout.rs`): `request_within(..., Some(5000))` against the silent listener, expects `Unreachable` in < 4 s.
- RED (pre-fix, `/tmp/claude/t2/fix-red.txt`): that test FAILED, `left: Err(Request(Timeout))`, `right: Err(Request(Unreachable))`; the other 4 passed.
- GREEN: `host_request_timeout` 5 passed (2.01 s; the 300 ms silent-host test still `Timeout`, the 5000 ms one `Unreachable`), `ipc` 13 passed, `--lib` 48 passed. fmt clean, check 0 warnings, `git diff --check` clean.
- Mutant (drop `&& !error.is_connect()`): the new test failed (`Timeout` vs `Unreachable`), other 4 passed (`/tmp/claude/t2/fix-mut.txt`). Restore proof: `cmp` against the copy silent, sha256 before/after equal.
- Minor 2: ipc.rs comment now says the call would end at the client's own 2 s connect limit as `unreachable`.
- Minor 1 (non-integer / non-finite `timeoutMs` in `client.ts`) NOT done: it is a production webview change (new `invalid_request` throw before the shell call) and the NaN/Infinity half is unverified; left for the controller's decision.
- Note: the commit message of 6c6be1836 says "Docs of Unreachable and Timeout"; only the Unreachable doc was edited (the Timeout doc already reads correctly).
