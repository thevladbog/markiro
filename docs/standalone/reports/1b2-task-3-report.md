# Plan 1b2, Task 3 report: клиент хоста с закреплённым отпечатком и команды устройства

## Status: DONE

## What was implemented

- `apps/standalone/src-tauri/src/tls.rs` (new): `FingerprintPolicy` (`Observe(Arc<Mutex<Option<String>>>)` / `Pin { expected, mismatch: Arc<AtomicBool> }`) and `client_config(FingerprintPolicy) -> Result<rustls::ClientConfig, rustls::Error>`, with the `aws-lc-rs` provider selected explicitly and a single `FingerprintVerifier` implementing `ServerCertVerifier`.
- `apps/standalone/src-tauri/src/host_client.rs` (new): `HostResponse { status, body }`, `RequestError` (`Unreachable`, `CertificateMismatch`, `InvalidResponse`, `InvalidRequest`) with `.code()`, `Credentials<'a> { device_key, office_token }`, and `PinnedClient::{new(address, fingerprint), send(method, path, body, credentials)}`. Rejects methods other than `GET/POST/PUT/DELETE` and paths outside `/v1/…` (no `..`, no `//`, ≤512 chars, restricted charset) before ever touching the network. Distinguishes `CertificateMismatch` from generic `Unreachable` via the `mismatch` flag the verifier sets.
- `apps/standalone/src-tauri/src/device.rs` (new): `DeviceStatus` (camelCase JSON), `DeviceError` with `.code()`, and `DeviceState::{load, status, local_pair, request, forget}`. The device key is held in memory only inside `PairedDevice` and is never exposed to the webview; `device.json` I/O goes through `device_config`, key protection through `secret_store`, discovery through `host_probe`, and authenticated calls through `host_client`.
- `apps/standalone/src-tauri/src/host_probe.rs` (modified): doc comment updated to point at `host_client` for authenticated calls; the local `ObservingVerifier` + its `ServerCertVerifier` impl and the now-unused `rustls::client::danger`/`rustls::crypto`/`rustls::pki_types`/`rustls::{DigitallySignedStruct, SignatureScheme}` imports were removed; `observe_hello` now builds its config via `tls::client_config(FingerprintPolicy::Observe(seen.clone()))`. `classify_hello` and its tests are unchanged.
- `apps/standalone/src-tauri/src/lib.rs` (rewritten): registers `device`, `host_client`, `tls` modules; adds Tauri commands `device_status`, `host_local_pair(name)`, `host_request(method, path, body, officeToken)`, `device_forget` alongside the existing `host_hello`; `run()` now builds and manages a `DeviceState` from the app's local data directory.
- `apps/standalone/src-tauri/src/device_config.rs` (modified per amendment A2, see below).
- `apps/standalone/src-tauri/src/Cargo.toml`: added `tokio = { version = "=1.53.1", features = ["sync"] }` to `[dependencies]`; the `[dev-dependencies]` `tokio` entry is untouched. `Cargo.lock` did not change (no new crates were pulled in by the `sync` feature).
- `apps/standalone/src-tauri/tests/device.rs` (new): 9 integration tests against a real in-process `markiro-host`, as specified in the brief, with amendment A3's `.await` applied to the two `forget()` calls.

## TDD evidence

**RED** — before any implementation file existed, only `tests/device.rs` + the `Cargo.toml` dependency were in place:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device
error[E0432]: unresolved import `markiro_standalone_lib::device`
 --> src-tauri/tests/device.rs:5:29
  |
5 | use markiro_standalone_lib::device::{DeviceError, DeviceState};
  |                             ^^^^^^ could not find `device` in `markiro_standalone_lib`

error[E0432]: unresolved import `markiro_standalone_lib::host_client`
 --> src-tauri/tests/device.rs:6:29
  |
6 | use markiro_standalone_lib::host_client::{Credentials, PinnedClient, RequestError};
  |                             ^^^^^^^^^^^ could not find `host_client` in `markiro_standalone_lib`

... (13 more cascading E0282 "type annotations needed" errors from `state`/`client` typing as {error})
cargo test: 15 errors, 0 warnings (1 crates)
```

This matches the brief's expected step-3 failure exactly (missing `device` and `host_client` modules).

**GREEN** — after implementing `tls.rs`, `host_client.rs`, `device.rs`, the `host_probe.rs`/`lib.rs` edits, and the `device_config.rs` amendment:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib
cargo test: 18 passed (1 suite, 0.09s)          # exit 0

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device   # sandbox disabled (binds 127.0.0.1)
cargo test: 9 passed (1 suite, 0.18s)           # exit 0 — matches the brief's "9 тестов"

$ cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   # sandbox disabled, run once
cargo test: 110 passed (20 suites, 2.55s)       # exit 0
```

(Test-runner output above is condensed by this environment's `rtk` proxy; RED output was shown verbatim because it was a compiler error, not a test-run summary. Exit codes were captured explicitly and were `0` for every GREEN run.)

18 lib tests = 7 in `device_config` (incl. the new A2 test) + 3 in `secret_store` (non-Windows) + 6 in `host_probe` + 2 in `host_client`.

Post-implementation checks:

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` then `--all -- --check`: clean (fmt reformatted two multi-line `return Err(...)` statements in `device_config.rs` to fit the line-length rule; re-ran the lib tests afterward, still 18 passed).
- `cargo clippy --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --all-targets`: "No issues found".
- `git diff --check`: clean, no whitespace errors.
- `git status --short` before commit showed only the 8 intended files (4 modified, 4 new); nothing unrelated staged.

## Amendments applied

- **A1 (local data directory)**: `run()` in `lib.rs` now calls `app.path().app_local_data_dir()?` instead of `app_config_dir()`, with a comment explaining that the device identity must stay on this computer and not follow a roaming/redirected Windows profile. `DeviceState`'s field and `load`'s parameter are named `dir` (not `config_dir`); the doc comment on `load` reads "the app's local data directory".
- **A2 (device_config cleanup)**:
  - `save`: the `write_owner_only(&temporary, &data)` call is now wrapped in an `if let Err(source) = …` that removes the temporary file before returning, mirroring the existing rename-failure branch (previously only the rename failure cleaned up).
  - `clear`: now removes both `device.json` and a leftover `.device.json.tmp` (each tolerating `NotFound`), and fsyncs the directory if either was actually removed. Doc comment added noting the Unix plaintext-key concern.
  - Added the required unit test `clear_removes_a_stray_temporary_file_too`: saves a config, writes a stray `.device.json.tmp` next to it, calls `clear`, and asserts both files are gone.
  - Not separately tested: the "save removes the temp file when _writing_ it fails" branch (as opposed to the already-tested rename-failure branch). Forcing `write_owner_only` to fail _after_ `create_new` succeeds (so a temp file exists to clean up) needs an OS-specific trick (e.g. filling the disk, or a permissions race) that isn't practical as a portable unit test; the brief's amendment text only mandated the `clear` regression test, so I left this path covered by code review rather than a dedicated test. Flagging this as a known gap rather than silently skipping it.
- **A3 (forget serialised with pairing)**: `DeviceState::forget` is `pub async fn forget(&self) -> Result<(), DeviceError>` and takes `self.pairing.lock().await` before touching `device_config`/`current`, so it cannot interleave with an in-flight `local_pair`. The `device_forget` Tauri command is now `async` and awaits it. `tests/device.rs` calls `state.forget().await.unwrap()` in both `forgetting_allows_pairing_again` and `an_unreadable_config_is_reported_until_forgotten`.
- **A4 (Secret in PairedDevice)**: `PairedDevice.key` is `markiro_proto::Secret`, not `String`. Built via `Secret::from(key)` in `PairedDevice::open` (wrapping the plaintext `String` from `secret_store::unprotect`) and via `pair.device_key.clone()` in `local_pair` (already a `Secret` from `PairResponse`). `.expose()` is called exactly once, at the point the request is actually sent: `Credentials { device_key: Some(device.key.expose()), office_token }` in `DeviceState::request`.

## Deviations from the brief's literal code

None beyond what the four amendments explicitly required. `tls.rs` and `host_client.rs` were used verbatim from the brief. `device.rs`, `lib.rs`, `host_probe.rs`, and `tests/device.rs` match the brief text except for the A1/A3/A4 changes described above. The code compiled and passed as specified without any additional fixes.

## Files changed

- `apps/standalone/src-tauri/Cargo.toml` (modified)
- `apps/standalone/src-tauri/src/tls.rs` (new)
- `apps/standalone/src-tauri/src/host_client.rs` (new)
- `apps/standalone/src-tauri/src/device.rs` (new)
- `apps/standalone/src-tauri/src/host_probe.rs` (modified)
- `apps/standalone/src-tauri/src/device_config.rs` (modified — amendment A2)
- `apps/standalone/src-tauri/src/lib.rs` (rewritten)
- `apps/standalone/src-tauri/tests/device.rs` (new)
- `apps/standalone/Cargo.lock` unchanged (checked; nothing to stage)

Commit: `4beeebc37081da23ec07406e4aafc5ab213e0ed7` — "feat(standalone): клиент хоста с закреплённым отпечатком и команды устройства", trailer verified with `git log -1 --format=%B` to end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Concerns

- The one untested `save` cleanup branch noted under A2 above (write failure after temp-file creation, before rename). Low risk: the branch is a straightforward mirror of the already-tested rename-failure cleanup, and `clippy`/`fmt`/the full workspace suite all stay green.
- This task is Rust-only (`src-tauri`), per the brief's file list; the JS/TS side (`src/host/*`, wizard, office UI) is explicitly out of scope here (later tasks in plan 1b2). No `pnpm --filter @markiro/standalone` checks were run because nothing under `apps/standalone/src` changed.
- DPAPI (`secret_store::dpapi`, Windows-only, `cfg(windows)`) is unchanged and still uncompiled/unexercised on this macOS host, consistent with `apps/standalone/AGENTS.md` ("a host run on macOS proves none of it").
- `apps/standalone/dist` already existed from Task 2's runs, so no `pnpm turbo build` was needed to compile `markiro-standalone`.
- Full-workspace and `--test device` runs required `dangerouslyDisableSandbox: true` because they bind real listeners on `127.0.0.1`, per the task's environment rules; `--lib` and the initial RED compile check ran inside the normal sandbox.

## Fix round 1 (review response)

Commit: `e4d882d24` — "fix(standalone): исключить pairing-маршруты из host_request, скрыть секреты в Credentials::Debug, точнее классифицировать отпечаток сертификата", on top of `4beeebc37` (one unrelated docs commit, `ea239c8c0`, landed on the shared branch in between; not touched). Trailer verified with `git log -1 --format=%B` to end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Files touched: `apps/standalone/src-tauri/src/device.rs`, `device_config.rs`, `host_client.rs`, `tls.rs`, `tests/device.rs`. No other files changed (`git status --short` showed exactly these five before staging).

### F1 — pairing routes excluded from `host_request`

Added `device.rs::webview_may_reach(path)` (with the doc comment specified in the review) and call it as the very first check in `DeviceState::request`, before the pairing-state match, returning `Err(DeviceError::Request(RequestError::InvalidRequest))` when it fails. Allowed: `/v1/device`, `/v1/device/...`, `/v1/bootstrap`, `/v1/office/...` (checked against the path with its query string stripped). `PinnedClient`/`host_client` stay generic; `local_pair` still calls `PinnedClient` directly and is unaffected.

Tests:

- Unit (`device.rs`): `webview_reachable_routes_exclude_pairing` — table-driven, allowed list plus rejected list including `/v1/local-pair`, `/v1/pairing/claim`, `/v1/hello`, and the near-miss prefixes `/v1/devices` and `/v1/bootstrap-status` (to prove the match isn't over-broad).
- Integration (`tests/device.rs`): `pairing_routes_are_not_reachable_through_host_request` — on a paired device, `POST /v1/local-pair` (with `kind: "office"` in the body, as the review's exploit describes) and `POST /v1/pairing/claim` both return `Err(DeviceError::Request(RequestError::InvalidRequest))`, as does `GET /v1/hello`.
- Regression: `pairs_locally_and_remembers_the_pinned_host` (`/v1/device`) and `requests_carry_the_device_key_and_the_office_token` (`/v1/office/me`, `/v1/bootstrap`, `/v1/office/logout`) still pass unchanged, proving the allow-list doesn't block legitimate routes.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device` (sandbox disabled) → 13 passed.

### F2 — `Credentials` no longer leaks through `Debug`

`Credentials::device_key` is now `Option<&'a Secret>` (was `Option<&'a str>`); `.expose()` is called exactly once, at `request.bearer_auth(key.expose())`. The call site in `device.rs::request` now passes `Some(&device.key)`. Replaced the derived `Debug` with a manual impl that prints `Credentials { device_key: Some(***)|None, office_token: Some(***)|None }` — no field value, redacted or not, is interpolated from the actual secret.

Test: `host_client::tests::credentials_debug_output_hides_the_key_and_the_token` — builds a `Credentials` with a real key/token, asserts the formatted string doesn't contain either literal value and equals the exact redacted form; also checks `Credentials::default()` formats as `Credentials { device_key: None, office_token: None }`.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib` → 21 passed (includes this test).

### F3 — certificate-mismatch classification no longer uses a shared flag

This item needed empirical verification before implementation, per the review's own instruction ("Do not guess"). I temporarily instrumented `PinnedClient::send`'s error arm with `eprintln!` calls that printed `Debug`/`Display` of every node reachable via `.source()`, plus `io::Error::get_ref()` at each `io::Error`, and ran `a_different_certificate_is_refused` with `--nocapture` (sandbox disabled). Observed chain (host is `hyper-rustls`/`tokio-rustls`/`hyper-util`, matching this workspace's locked `reqwest = "=0.13.4"`):

```
reqwest::Error { kind: Request, source: hyper_util::client::legacy::Error(Connect, <io::Error A>) }
  .source() -> hyper_util::client::legacy::Error(...)          [carries io::Error A]
  .source() -> io::Error A  { kind: Other,  .get_ref() = io::Error B }
    io::Error A.source() -> None   // io::Error::source() delegates to the WRAPPED
                                    // error's source(), not the wrapped error itself,
                                    // so the chain stops here even though io::Error B
                                    // and the rustls::Error are still "underneath"
    io::Error A.get_ref() -> io::Error B { kind: InvalidData, .get_ref() = rustls::Error }
      io::Error B.get_ref() -> rustls::Error::General("host certificate fingerprint mismatch")
```

This confirmed the review's hint exactly: the `rustls::Error` is two `get_ref()` calls deep from the one node that `.source()` actually reaches, and is never itself visible through `.source()`. I reverted the instrumentation (`git checkout -- host_client.rs`) before writing the real fix, so no debug prints remain.

Implementation:

- `tls.rs`: added `pub struct FingerprintMismatch` (unit struct) with `Display`/`Error`. `FingerprintPolicy::Pin` dropped the `mismatch: Arc<AtomicBool>` field (now just `{ expected: String }`). On mismatch, the verifier returns `rustls::Error::InvalidCertificate(CertificateError::Other(OtherError(Arc::new(FingerprintMismatch))))` instead of `Error::General(string)`.
- `host_client.rs`: `PinnedClient` dropped its `mismatch` field entirely. Added `is_fingerprint_mismatch(&reqwest::Error) -> bool`, which walks the `.source()` chain, and `wraps_fingerprint_mismatch(&(dyn Error + 'static)) -> bool`, which at each chain node checks (a) does it downcast to `rustls::Error::InvalidCertificate(CertificateError::Other(other))` whose `other.0` downcasts to `FingerprintMismatch`, and (b) if it's an `io::Error`, recurses into `.get_ref()` (not `.source()`) — matching the observed chain shape.

Test (unchanged, now proves the new path): `a_different_certificate_is_refused` in `tests/device.rs` still asserts `Err(RequestError::CertificateMismatch)`.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device` (sandbox disabled) → `a_different_certificate_is_refused` passed alongside the other 12.

No new regression test was added for the race itself (two concurrent requests, one racing a legitimate connection while another hits a mismatched cert) — the fix is a structural change (classification is now per-error, not via shared mutable state), so the existing single-request test is the correctness proof; a concurrency-specific test would be timing-dependent and was not requested.

### F4 — percent-encoding closed in `validate_path`

Removed `%` from the allowed-byte set (`b"/_.~?=&%-"` → `b"/_.~?=&-"`). Any path containing `%` is now rejected outright, regardless of what follows it.

Test: extended `host_client::tests::only_host_api_paths_pass`'s rejected-cases list with `/v1/%2e%2e/x`, `/v1/.%2E/x`, `/v1/office%2Fx`.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib` → 21 passed (includes this test).

### F5 — `https_only(true)` on the pinned client

Added `.https_only(true)` to the `reqwest::Client::builder()` chain in `PinnedClient::new`. No dedicated test was requested for this item; it composes with F6's builder-error mapping (reqwest's own `execute_request` rejects a non-`https` URL via `Kind::Builder`, the same kind a malformed header produces — confirmed by reading `reqwest-0.13.4/src/async_impl/client.rs` and `error.rs`), so an `http://` address would surface as `invalid_request`, not silently succeed in plaintext.

### F6 — builder errors mapped to `invalid_request`

Added `Err(error) if error.is_builder() => return Err(RequestError::InvalidRequest)` as the first arm of the `send()` error match, before the fingerprint-mismatch check. Confirmed via `reqwest-0.13.4/src/async_impl/request.rs` (`header_sensitive`, on an invalid `HeaderValue`, sets `Kind::Builder` on the request before any I/O) and `async_impl/client.rs` (`https_only` and bad-scheme checks also use `Kind::Builder`).

Test: `tests/device.rs::a_malformed_office_token_is_invalid_before_any_io` — a `PinnedClient` pointed at a genuinely closed local port (via the existing `closed_address()` helper) with `office_token: Some("bad\ntoken")` returns `Err(RequestError::InvalidRequest)`; using a closed port (rather than a live host) is the proof that this doesn't depend on any I/O succeeding or failing.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device` (sandbox disabled) → passed.

### F7 — stale doc comment

`device_config.rs`'s module doc now reads "`device.json` in the app's local data directory (spec §5.2)" (was "config directory"), matching A1's `app_local_data_dir()` change from the original task. Comment-only change, no test.

### F8 — additional `local_pair`/`DeviceStatus` coverage

- `tests/device.rs::a_name_longer_than_the_hosts_limit_is_rejected` — a 101-character (Cyrillic, so it's exercising `chars().count()` not byte length) name against the host's own `name.chars().count() > 100` validation (`apps/standalone/host/src/routes/pairing.rs`) comes back as `Err(DeviceError::PairRejected)`, and `state.status()` is still `Ok(None)` afterward.
- `tests/device.rs::local_pair_on_an_unreadable_config_is_reported` — with a corrupt `device.json` on disk, `local_pair` (not just `status`/`request`) returns `Err(DeviceError::ConfigUnreadable)` without attempting to pair.
- `device.rs::tests::device_status_serializes_to_the_expected_camel_case_keys_only` — `serde_json::to_value(&DeviceStatus{..})` has exactly the keys `hostAddress, fingerprint, hostId, deviceId, kind, lineId`, sorted-compared against the expected set, and asserts no `key` field is present.

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device` (sandbox disabled) and `--lib` → both suites green, included above.

### Full verification for the fix round

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib          # 21 passed (sandbox disabled; F6's test binds a port)
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --test device   # 13 passed (sandbox disabled)
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline                           # 117 passed, 20 suites (sandbox disabled)
cargo fmt --manifest-path apps/standalone/Cargo.toml --all                                            # no further changes needed
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check                                 # clean
cargo clippy --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --all-targets # no warnings
git diff --check                                                                                      # clean
```

117 = the prior 110 + 7 new tests (3 lib: F1's route-table test, F2's Debug test, F8's `DeviceStatus` shape test; 4 integration: F1, F6, and F8's two `local_pair` tests).

### Fix-round concerns

- F3 has no dedicated concurrency regression test (see above) — the fix is structural (no shared mutable state to race), and the existing `a_different_certificate_is_refused` test proves the new classification path works against the real, version-locked reqwest/hyper-rustls/tokio-rustls stack.
- F5's `https_only(true)` has no dedicated test; it was verified by reading reqwest's source rather than by exercising an `http://` address end-to-end, since doing so would just re-exercise the same `is_builder()` path F6 already tests.
- All other fix-round concerns are the same as those already listed under "Concerns" above (Rust-only scope, DPAPI/Windows unexercised on macOS).
