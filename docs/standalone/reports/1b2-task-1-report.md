# Task 1 Report: Секреты протокола не печатаются в `Debug`

## Summary

Implemented `markiro_proto::Secret`, a `#[serde(transparent)]` newtype over
`String` whose `Debug` impl always prints `Secret(***)`. Switched the six
secret-bearing proto fields (`PairResponse::device_key`,
`OfficeLoginRequest::password`, `OfficeSession::token`,
`NewOfficeUser::password`, `OfficeUserCreate::password`,
`PasswordSet::password`) to it, and updated the four host routes that read
those fields to call `.expose()` at the point of use (password
verification/hashing) and `.into()` when producing a fresh `Secret` from a
freshly generated key/token. JSON shapes and fixtures are unchanged (verified
by the existing round-trip tests, which still pass unmodified). Followed the
brief's exact code and file list; no deviations were needed.

## TDD Evidence

### RED

Added `secrets_never_appear_in_debug_output` to
`apps/standalone/proto/tests/fixtures.rs` (import list already had all six
names the brief calls for — `BootstrapRequest`, `OfficeLoginRequest`,
`OfficeSession`, `OfficeUserCreate`, `PairResponse`, `PasswordSet` — so no
import edit was needed there).

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures`

```
error[E0599]: no method named `expose` found for struct `std::string::String` in the current scope
   --> proto/tests/fixtures.rs:159:25
    |
159 |         pair.device_key.expose(),
    |                         ^^^^^^ method not found in `std::string::String`
(...5 more identical errors, one per secret field...)
cargo test: 6 errors, 0 warnings (1 crates)
```

Confirms the test fails for the expected reason (fields are still plain
`String`, no `Secret` type exists yet), not a typo or unrelated break.

### GREEN

After adding `Secret` to `apps/standalone/proto/src/lib.rs` and retyping the
six fields, then adjusting the four host route files:

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures`

```
cargo test: 13 passed (1 suite, 0.00s)
```

(12 pre-existing fixture tests + the new one, all passing; fixtures still
round-trip byte-for-byte since `Secret` is `#[serde(transparent)]`.)

Full workspace, run outside the sandbox because `hello.rs`, `platform.rs` and
`no_secrets_in_logs.rs` bind `127.0.0.1`:

Command: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`

```
cargo test: 89 passed (19 suites, 2.05s)
```

Re-ran both the focused test and the full workspace suite a second time after
`cargo fmt` and after the commit, to confirm formatting made no behavioral
difference and the committed tree is exactly what was tested. Same results
both times.

Also ran, as a cheap intermediate safety check before the sandbox-disabled
run: `cargo build --manifest-path apps/standalone/Cargo.toml --workspace --offline`
(clean) and `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --no-run`
(exit 0) — both confirm every crate, including `src-tauri`, still compiles
with the new `Secret` type before spending the sandbox-disabled run.

## Files Changed

- `apps/standalone/proto/src/lib.rs`: added `Secret` (new/expose/From<String>/Debug)
  right after `impl ErrorBody { … }`; retyped `PairResponse::device_key`,
  `OfficeLoginRequest::password`, `OfficeSession::token`,
  `NewOfficeUser::password`, `OfficeUserCreate::password`,
  `PasswordSet::password` from `String` to `Secret`.
- `apps/standalone/proto/tests/fixtures.rs`: added
  `secrets_never_appear_in_debug_output`.
- `apps/standalone/host/src/routes/pairing.rs`: `device_key: key,` →
  `device_key: key.into(),`.
- `apps/standalone/host/src/routes/office_auth.rs`:
  `verify_password(phc, &password)` → `verify_password(phc, password.expose())`;
  `token,` → `token: token.into(),` when building `OfficeSession`.
- `apps/standalone/host/src/routes/bootstrap.rs`:
  `validate::password("admin.password", &request.admin.password)?;` →
  `...request.admin.password.expose())?;`; `hash_password(&password)` →
  `hash_password(password.expose())`; `token,` → `token: token.into(),`.
- `apps/standalone/host/src/routes/office_users.rs`: added
  `use markiro_proto::Secret;`; both `validate::password(...)` calls now pass
  `.expose()`; `hash(password: String)` → `hash(password: Secret)` with
  `hash_password(password.expose())` inside; call sites
  (`hash(create.password)`, `hash(body.password)`) unchanged since the
  argument type now matches.

## Commands Run (in order)

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures   # RED
cargo build --manifest-path apps/standalone/Cargo.toml --workspace --offline                        # sandboxed sanity build
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --no-run                # sandboxed test-binary compile check
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline                          # GREEN, outside sandbox
cargo fmt --manifest-path apps/standalone/Cargo.toml --all
cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
git diff --check
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline --test fixtures    # re-verify after fmt/commit
cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline                          # re-verify after fmt/commit, outside sandbox
```

All exit 0 except the intentional RED run.

## Deviations

None. The brief's code compiled and passed exactly as written; no fixes were
needed.

## Concerns

None. `git status --short` was clean before starting and shows the six
intended files only; `git diff --check` is clean; the commit trailer matches
exactly (`git log -1 --format=%B` confirmed). `apps/station` was not touched.
No new dependencies were added.

## Commit

```
6af0e507 fix(standalone): секреты протокола не печатаются в Debug

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

`git status --short` after commit: clean.
