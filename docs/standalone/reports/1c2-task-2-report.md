# Task 2 report — plan 1c2: pairing by code (`host_claim`)

Status: DONE
Commit: `6a9e4b29d` — "feat(standalone): подключение устройства по коду — host_claim"

## What was implemented

A second `apps/standalone` installation can now pair with the LAN host over
the network using a one-time office code, instead of only over loopback.

- `DeviceState::claim(&self, address, fingerprint, code, name, app_version) -> Result<DeviceStatus, DeviceError>`
  (`apps/standalone/src-tauri/src/device.rs`):
  1. Rejects a malformed `fingerprint` (not exactly 64 lower-case hex
     characters) with `DeviceError::Request(RequestError::InvalidRequest)`
     before any I/O.
  2. Normalizes `code` with `markiro_proto::pairing::normalize`; a value that
     cannot be a code is refused as `DeviceError::CodeInvalid` before any I/O,
     so a typo never spends one of the host's shared "wrong code" attempts.
  3. Serializes with `local_pair` via the existing `pairing` mutex, then
     checks `ensure_unpaired()`.
  4. Calls `host_probe::observe_hello(address)` and requires the observed
     fingerprint to equal the caller-confirmed `fingerprint`; otherwise
     `DeviceError::Request(RequestError::CertificateMismatch)` and the code is
     never sent.
  5. Builds a `PinnedClient` pinned to that fingerprint and sends
     `ClaimRequest` (with the _normalized_ code) to `POST /v1/pairing/claim`.
  6. On a non-200 response, maps the host's error body to
     `DeviceError::{CodeInvalid, CodeExpired, RateLimited, PairRejected}` via
     the new `claim_refusal` helper.
  7. On success, hands off to the new shared `remember` helper (see below).
- `DeviceState::local_pair` was refactored to use two new private helpers
  extracted from its body, so both pairing paths save and adopt a pairing
  identically:
  - `ensure_unpaired(&self) -> Result<(), DeviceError>` — the
    unpaired/already-paired/unreadable check, previously inlined.
  - `remember(&self, address, observation, client, body) -> Result<DeviceStatus, DeviceError>`
    — parses `PairResponse`, checks `pair.host_id == observation.hello.host_id`
    (else `HostChanged`), builds `DeviceConfig`, protects the device key,
    persists it, and makes the pairing current.
- New free functions in `device.rs`:
  - `is_fingerprint(value: &str) -> bool` — exactly 64 lower-case hex chars.
  - `claim_refusal(body: Option<&Value>) -> DeviceError` — maps the host's
    `ErrorBody.error.code` to `CodeInvalid` / `CodeExpired` / `RateLimited`,
    defaulting to `PairRejected` for anything else (including an unparsable
    or absent body).
- New `DeviceError` variants `CodeInvalid`, `CodeExpired`, `RateLimited`,
  wired into `DeviceError::code()` as `codes::PAIRING_CODE_INVALID`,
  `codes::PAIRING_CODE_EXPIRED`, `codes::RATE_LIMITED`.
- New Tauri command `host_claim(address, fingerprint, code, name)` in
  `apps/standalone/src-tauri/src/lib.rs`, registered in `invoke_handler()`
  right after `host_local_pair`. It always pairs as `DeviceKind::Station`,
  same as `host_local_pair`.
- Docs updated to describe the finished behaviour:
  - `apps/standalone/AGENTS.md` §"Local pairing trust": describes exactly
    what `host_claim` refuses before I/O and how a host refusal maps to a
    code.
  - `apps/standalone/AGENTS.md` §"Network and TLS": drops the "later" before
    `host_claim` now that it exists.
  - `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
    §5.2: `host_claim` signature corrected from `(address, fingerprint, code,
device)` to `(address, fingerprint, code, name)`, with a note that the
    device always pairs as `station`.

No changes were made to `apps/standalone/host` or `apps/station`, per scope.

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test claim --test ipc --offline
```

Run outside the sandbox (these tests start a real host on 127.0.0.1). Output
(tail; full log had 17 errors, all in the newly created `tests/claim.rs`,
compiled before `DeviceState::claim` and the new `DeviceError` variants
existed):

```
error[E0599]: no method named `claim` found for reference `&DeviceState` in the current scope
   --> src-tauri/tests/claim.rs:139:...
error[E0599]: no variant or associated item named `CodeInvalid` found for enum `DeviceError` in the current scope
   --> src-tauri/tests/claim.rs:165:...
error[E0599]: no variant or associated item named `RateLimited` found for enum `DeviceError` in the current scope
   --> src-tauri/tests/claim.rs:185:...
...
error: could not compile `markiro-standalone` (test "claim") due to 17 previous errors
```

This matches the brief's expected RED: "ошибка компиляции — нет
`DeviceState::claim` и вариантов `CodeInvalid`, `RateLimited`." `tests/ipc.rs`
produced no errors of its own in this run (its new test only refers to
`host_claim` as a string through the mock IPC dispatcher, not as a Rust
symbol, so it doesn't fail to _compile_ on a missing command — it would have
failed at _runtime_, but the build never got that far because the `claim`
test binary in the same `cargo test` invocation failed first).

### GREEN

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline
```

Run outside the sandbox. Final summary (condensed by the local `rtk` wrapper):

```
cargo test: 62 passed (9 suites, 0.80s)
```

Full per-suite output via `rtk proxy cargo test ...` (unfiltered), confirming
the exact counts the brief predicted — 54 previously existing tests + 3 new
unit tests in `device.rs` + 4 new tests in `claim.rs` + 1 new test in
`ipc.rs` = 62:

```
running 29 tests   (src/lib.rs unit tests — was 26, +3: claim_error_codes_match_the_hosts,
                     fingerprints_are_64_lower_case_hex_characters,
                     claim_refusals_keep_the_reason_the_webview_explains)
test result: ok. 29 passed; 0 failed; ...

running 4 tests    (tests/claim.rs — new file)
test a_malformed_fingerprint_or_code_is_refused_before_any_io ... ok
test another_fingerprint_keeps_the_code_on_the_device ... ok
test a_second_device_pairs_with_a_code_and_the_confirmed_fingerprint ... ok
test refused_codes_come_back_as_their_own_errors ... ok
test result: ok. 4 passed; 0 failed; ...

running 13 tests   (tests/device.rs — unchanged)
test result: ok. 13 passed; 0 failed; ...

running 2 tests    (tests/host_probe.rs — unchanged)
test result: ok. 2 passed; 0 failed; ...

running 1 test     (tests/host_probe_proxy.rs — unchanged)
test result: ok. 1 passed; 0 failed; ...

running 5 tests    (tests/ipc.rs — was 4, +1: a_device_claims_a_code_through_the_ipc_shapes)
test result: ok. 5 passed; 0 failed; ...

running 8 tests    (tests/local_db.rs — unchanged)
test result: ok. 8 passed; 0 failed; ...
```

Re-run once more after `cargo fmt` reformatted the new code (see Deviations)
and again after the commit, both still green at 62/62.

## Verification commands and results

All run from the worktree root
`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

| Command                                                                                                                                       | Result                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test claim --test ipc --offline` (before implementation)       | FAIL to compile, 17 errors — expected RED                                                                                                |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (after implementation)                                | 62 passed, 0 failed (9 suites)                                                                                                           |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` (first attempt, brief's literal code)                                 | FAIL — 8 formatting diffs (see Deviations)                                                                                               |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` (apply) then `-- --check`                                                        | PASS, clean                                                                                                                              |
| `cargo test ...` (re-run after `cargo fmt`)                                                                                                   | 62 passed, 0 failed — unchanged                                                                                                          |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                                  | PASS, 0 warnings                                                                                                                         |
| `node_modules/.bin/prettier --write apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`           | both "(unchanged)" — already prettier-clean                                                                                              |
| `node_modules/.bin/prettier --check` on the same two files                                                                                    | "All matched files use Prettier code style!"                                                                                             |
| `git diff --check` (before commit, and again after)                                                                                           | clean, no whitespace errors                                                                                                              |
| `git diff apps/standalone/Cargo.lock` / `Cargo.toml`                                                                                          | empty — no dependency changes, as expected (this task adds no new crate)                                                                 |
| Post-commit re-run of all of the above (`cargo fmt --check`, `cargo check --workspace --all-targets`, `prettier --check`, `git diff --check`) | all PASS again on the committed tree                                                                                                     |
| `git log -1 --format=%B`                                                                                                                      | `feat(standalone): подключение устройства по коду — host_claim` + blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` |

Not run / out of scope for this task: any `pnpm` command (not touched, no JS
changed), Windows-only checks, any `apps/station` or `apps/standalone/host`
checks (out of scope; host was read-only reference for this task).

## Files changed

- `apps/standalone/src-tauri/src/device.rs` — modified: `claim`, `remember`,
  `ensure_unpaired`, `is_fingerprint`, `claim_refusal`, new `DeviceError`
  variants, 3 new unit tests.
- `apps/standalone/src-tauri/src/lib.rs` — modified: `host_claim` command,
  registered in `invoke_handler()`.
- `apps/standalone/src-tauri/tests/claim.rs` — created: 4 integration tests
  against a real host on 127.0.0.1.
- `apps/standalone/src-tauri/tests/ipc.rs` — modified: 1 new IPC contract
  test (`a_device_claims_a_code_through_the_ipc_shapes`).
- `apps/standalone/AGENTS.md` — modified: "Local pairing trust" and "Network
  and TLS" sections.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` —
  modified: §5.2 `host_claim` signature.

Commit `6a9e4b29d` touches exactly these six paths (`git show --stat`
confirms no unrelated files); `apps/standalone/Cargo.lock`,
`apps/standalone/src-tauri/Cargo.toml`, `apps/standalone/host/**` and
`apps/station/**` are untouched.

## Deviations

1. **Formatting only, from the brief's literal code samples.** The brief's
   Step 2/3 code blocks, copied verbatim, did not satisfy
   `cargo fmt --check`: 8 spots where a call or list the brief wrote on one
   (or few) line(s) exceeds rustfmt's wrap width (e.g.
   `client.send("POST", "/v1/local-pair", Some(&body), Credentials::default())`,
   the `is_fingerprint` boolean expression, several `assert_eq!` calls in
   `claim.rs` and the array literal in `fingerprints_are_64_lower_case_hex_characters`).
   Per the task's ambiguity-resolution rule ("make the smallest fix that
   keeps its intent and assertions"), I ran `cargo fmt --manifest-path
apps/standalone/Cargo.toml --all` once, which reflowed exactly those 8
   spots and nothing else (confirmed by re-reading the resulting diff — pure
   line-wrapping, no logic, string, or assertion changed). Re-ran the full
   test suite afterward to confirm nothing broke; it didn't. This was
   necessary because the task's own final gate requires a clean
   `cargo fmt --check`.
2. Everything else — test bodies, assertions, production code, doc text —
   was implemented exactly as specified in the brief and the constraints
   file; no behavioral, semantic, or scope deviations.

## Self-review

- **Order of checks in `claim`**: fingerprint shape → code shape/normalize →
  serialize with the pairing mutex → `ensure_unpaired` → `hello` → fingerprint
  match → send. This matches the brief's numbered guarantee (§"Where this
  fits" and the constraints file): a malformed fingerprint or code never
  reaches the network, and the code is only sent after the observed
  certificate is confirmed to match, through a client pinned to that same
  fingerprint. Verified directly by
  `a_malformed_fingerprint_or_code_is_refused_before_any_io` (uses
  `closed_address()` — a port nothing listens on — for the well-formed-network
  case, and confirms the malformed cases never even attempt to connect there)
  and `another_fingerprint_keeps_the_code_on_the_device` (a wrong fingerprint
  never lets the code reach the real host; confirmed by the _same_ code
  succeeding immediately afterward against the right fingerprint).
- **Rate limiting semantics**: I read `apps/standalone/host/src/routes/pairing.rs`
  and `rate_limit.rs` directly rather than trusting the brief's description.
  Confirmed `state.claim_limiter.check(peer.ip())?` is the literal first line
  of the `claim` handler (`RateLimiter::new(10, 1 minute, ...)`), and that
  `check` counts an attempt (pushes to the deque) whenever it does _not_
  refuse, i.e. every attempt up to and including the 10th is counted and
  allowed, and the 11th sees `seen.len() >= 10` and is refused with
  `429 rate_limited` — before it counts itself. This matches
  `refused_codes_come_back_as_their_own_errors`'s arithmetic (3 spent before
  the loop, then indices 0..6 of the 8-iteration loop are attempts 4–10 and
  still `CodeInvalid`, index 7 is attempt 11 and is `RateLimited`), which
  passed unmodified.
- **`remember` shared by both pairing paths**: `local_pair` and `claim` now
  call the same private `remember`, so a claimed pairing is persisted and
  read back identically to a local one — checked by
  `a_second_device_pairs_with_a_code_and_the_confirmed_fingerprint`, which
  reloads `DeviceState` from disk after `claim` and re-asserts `status()` and
  a live `GET /v1/device` round-trip, not just the in-memory return value.
- **Secrets**: the pairing `code` argument and the device key never appear in
  a `Debug` or log call anywhere in the new code — `code` is only ever passed
  into `pairing::normalize`, `Secret::new`, and used to build the JSON body
  via `serde_json::to_value`, none of which log it; `ClaimRequest`'s `Debug`
  impl exists (derived) but nothing in the new code prints a `ClaimRequest`.
  `pair.device_key` flows into `remember` exactly as it already did for
  `local_pair` (protect, persist, move into `PairedDevice`), unchanged.
- **Test coverage read against the brief's intent, not just line-matched**:
  all 4 `claim.rs` tests and the 1 new `ipc.rs` test are exactly the brief's
  text (only line-wrapping changed by `cargo fmt`); I did not weaken, skip,
  or alter any assertion. The 3 new unit tests in `device.rs` are likewise
  verbatim aside from formatting.
- **Scope discipline**: confirmed via `git status`/`git diff --stat` both
  before and after the commit that `apps/standalone/host/**`,
  `apps/station/**`, `apps/standalone/Cargo.lock`, and
  `apps/standalone/src-tauri/Cargo.toml` are untouched, matching the "out of
  scope" instruction and the constraints file's dependency rule (no new
  crates needed for this task).
- **Known limitation**: this task only proves the Rust shell's pairing logic
  and its IPC contract against a real host started in-process on
  `127.0.0.1`. It says nothing about the webview/TypeScript side (later task
  per the plan), nor about any Windows-specific behavior — none of that was
  in scope here and none of it was touched.
