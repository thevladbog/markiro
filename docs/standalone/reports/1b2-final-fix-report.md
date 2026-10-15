# Plan 1b2 final review — fix report

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Base HEAD before this pass: `63f2c99f7` (docs(standalone): ключ устройства, сессия офиса и первый запуск приложения)

## A. `device_config.rs` — `sync_dir` doc comment

Replaced the doc comment above `sync_dir` (`apps/standalone/src-tauri/src/device_config.rs`)
with the exact text from the brief. Comment only; the two `sync_dir` implementations
(`#[cfg(unix)]` and `#[cfg(not(unix))]`) are unchanged.

## B. `host_client.rs` — `RequestError::InvalidRequest` doc comment

Verified all three cases against `reqwest` 0.13.4 (the version pinned in `Cargo.lock`,
vendored at `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/reqwest-0.13.4`) before
writing the comment, per the brief's instruction:

1. **Method/path not allowed** — `allowed_method`/`validate_path` in `host_client.rs` already
   return `RequestError::InvalidRequest` directly; covered by the existing
   `only_host_api_paths_pass`/`only_known_methods_pass` unit tests.
2. **Office token not a valid header value** — `request.header(OFFICE_SESSION_HEADER, token)`.
   `reqwest::RequestBuilder::header_sensitive` (`src/async_impl/request.rs:208-237`): if
   `HeaderValue::try_from(value)` fails, it stores `self.request = Err(crate::error::builder(e))`
   — a `Kind::Builder` error. `RequestBuilder::send` (`:517-522`) returns that stored `Err`
   directly from `.send()`, so `error.is_builder()` is `true` and the `send` method in
   `host_client.rs` maps it to `RequestError::InvalidRequest`.
3. **Host address not HTTPS** — `.https_only(true)` on the client builder.
   `Client::execute_request` (`src/async_impl/client.rs:2609-2611`): `if self.inner.https_only &&
url.scheme() != "https" { return Pending::new_err(error::url_bad_scheme(url)); }`, and
   `url_bad_scheme` (`src/error.rs:362-363`) constructs `Error::new(Kind::Builder,
Some(BadScheme))` — also a builder error, also mapped to `InvalidRequest`.

All three cases confirmed to map to `RequestError::InvalidRequest`; wrote the comment exactly as
given in the brief. Comment only; no code change.

## C. Wizard — stale submit error survives «Далее»/«Назад» (TDD)

`apps/standalone/src/wizard/BootstrapWizard.tsx`: `goNext` and `goBack` now call
`setSubmitError(null)` in addition to the existing `clearErrors()`.

Test added first in `apps/standalone/test/wizard.test.tsx`
(`"clears the submit error banner when going back to fix a step"`): fails the submit once via a
rejected `onSubmit`, waits for the banner, clicks «Назад», asserts the banner text is gone with
`screen.queryByText(...)).toBeNull()`.

Red run (before the `goNext`/`goBack` fix):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx
 ❯ test/wizard.test.tsx (6 tests | 1 failed)
     × clears the submit error banner when going back to fix a step
AssertionError: expected <div …(1)></div> to be null
+ Received:
<div style="font: var(--text-body); color: var(--fg-2);">
  Служба хоста на этом компьютере не отвечает.
</div>
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

Green run (after adding `setSubmitError(null)` to both `goNext` and `goBack`):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/wizard.test.tsx
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## D. «Повторить» on the pair-failed screen must also re-probe (TDD)

`apps/standalone/src/app/App.tsx`: the `pair_failed` screen's `onRetry` now dispatches
`pairing_retried` **and** calls `retryProbe()` (the same callback `HostMissingScreen`'s retry and
`repair()` already use), so a retry after a host swap does not pair against a stale probe
snapshot.

Test modified first (existing test, renamed for clarity):
`"retries a failed pairing by re-probing the host, not just the pairing"` in
`apps/standalone/test/app.test.tsx` — captures `probe.hello.mock.calls.length` before clicking
«Повторить», then asserts it grew by exactly one and that `device.pairLocally` was called twice
(once failed, once after the retry).

Red run (before the `onRetry` fix, `probe` hoisted to a named variable so its call count could be
inspected):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "retries a failed pairing"
 ❯ test/app.test.tsx (16 tests | 1 failed | 15 skipped)
     × retries a failed pairing by re-probing the host, not just the pairing
AssertionError: expected 1 to be 2 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 15 skipped (16)
```

(`probe.hello` was still called only once — the pre-fix `onRetry` re-ran the pairing without
re-probing.)

Green run (after adding `retryProbe()` to `onRetry`):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "retries a failed pairing"
 Test Files  1 passed (1)
      Tests  1 passed | 15 skipped (16)
```

## E. StrictMode App test (resolved per the brief — no code change)

Renamed the test to `"pairs this computer exactly once under StrictMode"` and added
`expect(device.pairLocally).toHaveBeenCalledTimes(1)`.

**Observed: the assertion passes as written — `pairLocally` is called exactly once.** No App
code was changed to make it pass; it already behaved this way.

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "pairs this computer exactly once under StrictMode"
 Test Files  1 passed (1)
      Tests  1 passed | 15 skipped (16)
```

Why: the two mount-time effects (`deviceApi.status()` and `hostProbe.hello(address)`) are the
ones StrictMode double-invokes at the initial commit (setup → cleanup → setup, all synchronous,
before either promise settles), but both use the standard `cancelled` guard, so only the
surviving instance's `.then()` actually dispatches. The `pairingDue` effect that calls
`pairLocally()` depends on the derived boolean `pairingDue`, which is still `false` at the
instant of that same initial double-invoke (the device/host state hasn't loaded yet); by the
time `pairingDue` flips to `true` (asynchronously, after the surviving probe/status promises
resolve), the component is no longer mounting — it's an ordinary update — so React does not
double-invoke that effect again. The adoption-of-a-concurrent-pairing test near the old
207-213 lines (now the same relative position) was left unchanged, as instructed.

## F. App-level tests for the paired-device probe (review item I1 of Task 8)

Added two tests to `apps/standalone/test/app.test.tsx`, validating existing `nextShellView`/
`App` behavior end-to-end (no `shell.ts` or `App.tsx` change was needed for this item):

1. `"recovers from a reinstalled host: rejects, reconnects, re-pairs and reaches the floor"` —
   device paired with `DEVICE_STATUS`; the probe (a one-off fake, not `probeAnswering`, since it
   must return a custom `HelloObservation`) answers with `observation(true)` mutated to a
   different `hello.hostId` and `fingerprint`, following the same in-place-mutation pattern
   `shell.test.ts` already uses. Asserts the «host changed» text shows
   (`shell.deviceRejected.hostChanged`), then clicks «Подключить заново», asserts the floor
   («Цех») is reached, and that `forget`/`pairLocally` were each called exactly once.
   `fakeDevice` gained an optional second parameter, `pairResult` (default `DEVICE_STATUS`,
   every existing call site unchanged): the status a fresh `pairLocally()` call returns. Here it
   is set to the _new_ host's identity (same `hostId`/`fingerprint` the mutated probe reports),
   which is exactly what stops the app from looping back to «host changed» after re-pairing.
2. `"shows the version screen, not the floor, for a paired device behind an incompatible host"` —
   device already paired with `DEVICE_STATUS`, probe rejects with
   `HostProbeError("app_too_old", ...)`. Asserts the version screen's title and body text show
   (same strings as the existing unpaired-device version-mismatch test) and that «Цех» never
   appears.

Both passed on the first run (they exercise already-correct `nextShellView` logic), together
with the rest of the suite:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

## G. `errors.device.storage` wording

Changed `apps/standalone/src/i18n/ru.json`'s `errors.device.storage` from «Не удалось
сохранить настройки подключения на этом компьютере.» to «Не удалось изменить настройки
подключения на этом компьютере.» (exact text from the brief).

Grepped the whole repo for the old string (`Не удалось сохранить настройки`) before and after:
only two occurrences existed — `ru.json` itself and `apps/standalone/test/app.test.tsx:305`
(the `"shows a repair failure on the config-error screen and keeps it visible"` test) — both
updated. Confirmed no residual occurrence remains in any tracked file.

## H. `ChangePasswordDialog` — per-instance form id

`apps/standalone/src/office/ChangePasswordDialog.tsx`: removed the module-level
`FORM_ID = "office-password-form"` constant, added `const formId = useId();` inside the
component, and used `formId` for both the `<form id>` and the submit button's `form` prop.
Grepped `test/` and `src/` for `FORM_ID`/`office-password-form` first — no test referenced the
literal id string, so this was safe. The existing `ChangePasswordDialog` tests in
`test/office.test.tsx` pass unchanged (see the full `test` run below).

## I. Process-log scan now covers the self password change

`apps/standalone/host/tests/no_secrets_in_logs.rs`: after the admin's reset of the
technologist's password (which ends the technologist's prior session), added:

1. The technologist logs back in with `tech_new_password`, keeping the new token
   (`tech_new_token`).
2. `PUT /v1/office/me/password` with `currentPassword: "wrong technologist current password"`
   (`wrong_current_password`) and `newPassword: "third long technologist password"`
   (`third_password`) — asserted `401`.
3. The same route again with `currentPassword: tech_new_password` and the same `third_password`
   — asserted `204`.
4. `tech_new_token`, `wrong_current_password` and `third_password` added to the `secrets` vector
   scanned against the process log.

Checked the rate limiter before adding these calls (`host/src/rate_limit.rs` /
`AppState::new` in `host/src/server.rs`): `login_limiter` allows 10 attempts per IP per minute
and is shared between `POST /v1/office/login` and `PUT /v1/office/me/password` only (the
admin's `PUT /v1/office/users/{id}/password` route is not rate-limited by it). The test now
makes 5 such calls total (1 wrong admin login + 1 tech login + 1 tech re-login + 1 wrong
self-change + 1 successful self-change), well under the limit.

## Files changed

```
 apps/standalone/host/tests/no_secrets_in_logs.rs   | 45 ++++++++++++++
 apps/standalone/src-tauri/src/device_config.rs     |  5 +-
 apps/standalone/src-tauri/src/host_client.rs       |  4 +-
 apps/standalone/src/app/App.tsx                    | 10 +++-
 apps/standalone/src/i18n/ru.json                   |  2 +-
 apps/standalone/src/office/ChangePasswordDialog.tsx |  9 ++-
 apps/standalone/src/wizard/BootstrapWizard.tsx     |  2 +
 apps/standalone/test/app.test.tsx                  | 68 +++++++++++++++++++---
 apps/standalone/test/wizard.test.tsx               | 10 ++++
 9 files changed, 138 insertions(+), 17 deletions(-)
```

`docs/superpowers/plans/2026-09-26-standalone-1b2-app-first-run-office.md` and `apps/station`
were left untouched, as instructed.

## Verification

Focused webview run (per the brief, iterating on C/D/F):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx test/wizard.test.tsx test/office.test.tsx
 Test Files  3 passed (3)
      Tests  37 passed (37)
```

Full package gates:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
 Test Files  12 passed (12)
      Tests  152 passed (152)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck
(exit 0, no output — tsc -p tsconfig.json --noEmit)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint
(exit 0, no output — eslint clean, no new warnings)
```

Rust:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline
(inside sandbox) FAILED — PermissionDenied: cannot listen on 127.0.0.1:0: Operation not
permitted (os error 1) — the sandbox refuses local binds, as flagged in the brief.

(re-run with dangerouslyDisableSandbox: true, since the test itself binds 127.0.0.1)
test secrets_never_reach_the_process_log ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline --lib
(inside sandbox, no bind needed)
running 21 tests
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

Formatting and whitespace:

```
$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all
(no diffs produced beyond the intended edits — confirmed with `git diff` on device_config.rs
and host_client.rs: only the new doc comments changed)

$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
(exit 0, no output)

$ node_modules/.bin/prettier --write apps/standalone/src/app/App.tsx apps/standalone/src/i18n/ru.json apps/standalone/src/office/ChangePasswordDialog.tsx apps/standalone/src/wizard/BootstrapWizard.tsx apps/standalone/test/app.test.tsx apps/standalone/test/wizard.test.tsx
(all 6 files: unchanged)

$ node_modules/.bin/prettier --check <same files>
All matched files use Prettier code style!

$ git diff --check
(exit 0, no output)
```

## Commands run outside the sandbox, and why

Only `cargo test ... --test no_secrets_in_logs --offline` (both the initial sandboxed attempt,
which failed, and the successful re-run) used `dangerouslyDisableSandbox: true`: the test starts
a real host bound to `127.0.0.1:0`, which this sandbox refuses with `EPERM` by default, exactly
as the brief predicted. Every other command (webview tests/typecheck/lint, the
`markiro-standalone --lib` cargo run, `cargo fmt`, `prettier`, `git diff --check`) ran inside the
normal sandbox.

## Concerns

- **Item E is DONE, not a gap**: the brief allowed for the possibility that `pairLocally` might
  be called more than once under StrictMode and asked me to stop and report rather than paper
  over it. It is called exactly once; no follow-up needed.
- **Item F's "different host" probe is a one-off fake, not `probeAnswering`**: `probeAnswering`
  in `app.test.tsx` only accepts `boolean | HostProbeError` answers (it always builds the
  observation from the shared `HOST_ID`/fingerprint in `test/support/fixtures.ts`). Rather than
  widen that shared helper's contract for one test, I built a small local
  `{ hello: vi.fn(...) }` object returning a mutated `observation(true)`, mirroring exactly how
  `shell.test.ts` already produces a "different host" observation (mutate the object `observation`
  returns, in place). This keeps the change scoped to the new test and leaves every existing
  `probeAnswering` call site untouched.
- No behavior other than D (`onRetry` on the pair-failed screen) changed; A, B, G, H are
  comment/text/id-plumbing only, and C only clears a stale banner. I did not touch `shell.ts`,
  matching the resolution guidance for F.
- Did not run the full `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
  (only the two commands the brief specified): the comment-only changes (A, B) cannot affect
  other test binaries, and `no_secrets_in_logs.rs` is its own isolated binary, so the two scoped
  runs above are conclusive for what changed. No other Rust source file changed.
- Manual/external checks not run (out of scope for this fix wave and not touched by any item):
  no Windows, no live Tauri shell, no browser. All nine changed files are Rust doc comments,
  TypeScript source/tests, or a JSON i18n string; none of this wave's items required
  Windows/hardware/browser confirmation.
