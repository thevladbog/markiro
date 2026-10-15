# Task 10 report: Смена собственного пароля в офисе

Plan 1b2, Task 10. Worktree
`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`, branch
`claude/autonomous-desktop-station-9e6f13`.

## What was implemented

Any signed-in office user (administrator or technologist) can now change their
own password from the office header.

- **Proto** (`apps/standalone/proto/src/lib.rs`): `PasswordChange { current_password:
Secret, new_password: Secret }`, camelCase + `deny_unknown_fields`, plus the fixture
  `apps/standalone/proto/fixtures/password-change.json` and a round-trip/no-leak test in
  `proto/tests/fixtures.rs`.
- **Host** (`apps/standalone/host`):
  - `auth.rs`: extracted the query in `OfficeContext::require_admin_in` into a private
    `live_role_in` (re-checks the session is live and the user active inside a write
    transaction, returns the current role) and added a new public
    `require_session_in`, for writes any office user may make. `require_admin_in`
    keeps its doc comment and public signature; its body now calls `live_role_in`.
  - `routes/office_auth.rs`: new `change_password` handler for
    `PUT /v1/office/me/password`. Rate-limits by peer IP (same limiter as login),
    validates the new password's length, hashes/verifies off the async runtime
    (`spawn_blocking`, before the write lock), re-reads the stored hash inside the
    `begin_write` transaction to catch a password changed while PBKDF2 ran, re-checks
    the session is live inside the transaction, bumps the revision by exactly one on
    success, deletes every other session of that user (the caller's own session
    survives), and writes one `office_user.password` audit row either way (`denied`
    with `{"reason":"wrong_current_password"}`, or `ok` with `{}`), with the user as
    both actor and target.
  - `server.rs`: registered `PUT /v1/office/me/password` in `protected_routes`.
- **Webview** (`apps/standalone/src`):
  - `host/protocol.ts`: `passwordChangeSchema`/`PasswordChange` (strict request schema).
  - `host/api.ts`: `HostApi.officeChangePassword(token, request)`, calling
    `PUT /v1/office/me/password` with a `z.null()` response schema (204).
  - `office/office-session.tsx`: `OfficeSessionValue.changePassword`.
  - `office/ChangePasswordDialog.tsx` (new): a `@markiro/ui` `Modal` with current/new/
    confirm password fields (react-hook-form + zod), client-side length and
    confirm-match checks, and server-error mapping (`credential === "password"` →
    "Текущий пароль неверен." on the current-password field; `field === "newPassword"`
    → length message; anything else → a generic `Alert`).
  - `office/OfficeShell.tsx`: a "Сменить пароль" button in the header, an
    `Alert tone="ok"` success banner above the routed content, and the dialog itself.
  - `app/App.tsx`: `officeSession`'s `call` extracted into a local `const call` inside
    the `useMemo` (implementation unchanged — still `shellActionFor(error,
session.token)`, token-scoped), plus `changePassword: (request) =>
call((token) => hostApi.officeChangePassword(token, request))`.
  - `i18n/ru.json`: `office.password.*` keys (open/title/current/new/hint/confirm/
    submit/cancel/done/required/length/mismatch/wrongCurrent).
- **Spec** (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`):
  - §4.5 table: new row for `PUT /v1/office/me/password`.
  - §4.8 table: new "Свой пароль" row ("смена" for both roles).
  - §10: new bullet on the forgotten-administrator-password recovery command
    (`markiro-host reset-password --login <логин>`, plan 5).

## TDD evidence

### Host + proto (Rust)

RED — before any implementation (proto struct not yet added, host route not yet
registered):

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
error[E0432]: unresolved import `markiro_proto::PasswordChange`
 --> proto/tests/fixtures.rs:6:49

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --offline
test result: FAILED. 10 passed; 4 failed
  a_user_changes_their_own_password: left: 404 right: 204 (not_found: "no route for PUT /v1/office/me/password")
  a_wrong_current_password_changes_nothing: left: 404 right: 401
  the_new_password_is_validated: left: 404 right: 400
  changing_a_password_needs_an_office_session: left: 404 right: 401
```

GREEN — after implementing the proto type, the `auth.rs` refactor, the route handler
and its registration:

```
$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
cargo test: 14 passed (1 suite, 0.00s)

$ cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --offline
cargo test: 14 passed (1 suite, 0.69s)

$ cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline   # sandbox disabled
cargo test: 122 passed (20 suites, 2.40s)

$ cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check
(clean)
```

### Webview (Vitest)

RED — before implementing the schema, API method, session member, dialog and shell
wiring (test edits only: `protocol.test.ts`, `office.test.tsx`, `app.test.tsx`):

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
    test/protocol.test.ts test/office.test.tsx test/app.test.tsx
Test Files  3 failed (3)
     Tests  6 failed | 61 passed (67)
- protocol.test.ts > request fixture password-change.json (x2): TypeError, schema is undefined
- office.test.tsx > ChangePasswordDialog (x3): button "Сменить пароль" not found
- app.test.tsx > App > changes the office user's own password...: button "Сменить пароль" not found
```

GREEN — after implementing `protocol.ts`, `api.ts`, `office-session.tsx`,
`ChangePasswordDialog.tsx`, `OfficeShell.tsx`, `App.tsx`, and `ru.json`:

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run \
    test/protocol.test.ts test/office.test.tsx test/app.test.tsx
Test Files  3 passed (3)
     Tests  67 passed (67)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test
Test Files  12 passed (12)
     Tests  148 passed (148)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck   # clean
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint        # clean
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build       # succeeded, dist rebuilt
```

Note on sequencing: I deliberately wrote the proto fixture/test import (referencing
the not-yet-declared `PasswordChange`) before adding the struct to `lib.rs`, instead
of doing both in one step as the brief's Step 1 shows. This gets a genuine compile-time
RED for the proto crate too, not only for the host route.

## Final checks (Step 10)

All green:

- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (sandbox
  disabled) — 122 passed, 20 suites.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 148
  passed.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` —
  clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` — clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build` —
  succeeded.
- `node_modules/.bin/prettier --check apps/standalone/src apps/standalone/test
apps/standalone/proto/fixtures docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  — clean (also ran `--write` first; only the spec doc's table needed reflowing).
- `git diff --check` — clean.
- `node --test tools/ci/test/affected.test.mjs` — 20/20 passed (this task adds no new
  surface, so no change to `tools/ci/affected.mjs` was needed; the existing "Standalone
  native and web changes select their jobs" case already covers it).

## Files changed

Modified:

- `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`
- `apps/standalone/host/src/auth.rs`, `apps/standalone/host/src/routes/office_auth.rs`,
  `apps/standalone/host/src/server.rs`, `apps/standalone/host/tests/office_auth.rs`
- `apps/standalone/src/host/protocol.ts`, `apps/standalone/src/host/api.ts`
- `apps/standalone/src/office/office-session.tsx`,
  `apps/standalone/src/office/OfficeShell.tsx`
- `apps/standalone/src/app/App.tsx`
- `apps/standalone/src/i18n/ru.json`
- `apps/standalone/test/protocol.test.ts`, `apps/standalone/test/office.test.tsx`,
  `apps/standalone/test/app.test.tsx`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Created:

- `apps/standalone/proto/fixtures/password-change.json`
- `apps/standalone/src/office/ChangePasswordDialog.tsx`

## Deviations and corrections (all per the controller's brief corrections)

1. **`App.tsx`'s `call`.** Kept the current token-scoped implementation
   (`shellActionFor(error, session.token)`) byte-for-byte; only lifted it out of the
   returned object literal into a local `const call` inside the `useMemo`, then added
   `changePassword: (request) => call((token) => hostApi.officeChangePassword(token,
request))`. Reason: the brief's own snippet showed the pre-Task-8-fix-round `call`
   (`shellActionFor(error)`, untyped); the corrections said to keep the current one.
2. **`OfficeSessionValue.changePassword`.** Declared as
   `changePassword: (request: PasswordChange) => Promise<void>;` (a function-typed
   property), not the brief's method-shorthand `changePassword(request: PasswordChange):
Promise<void>;`. Reason: `@typescript-eslint/unbound-method` and the file's own
   documented convention — every other member (`call`, `leave`, `logout`) is already
   written this way.
3. **`ChangePasswordDialogProps`.** Declared `onClose: () => void; onChanged: () =>
void;` instead of the brief's method-shorthand `onClose(): void; onChanged(): void;`.
   Reason: same correction, applied for consistency even though neither callback is
   referenced unbound in this particular component.
4. **Host test imports.** No import changes were needed in
   `apps/standalone/host/tests/office_auth.rs`: `pair_device`, `seed_office_user`,
   `login`, `with_device`, `with_session`, `request`, `empty`, `json` (aliased
   `json_request`), `TestApp`, `Value` and the `json!` macro were already imported.
   Confirmed by reading the file before editing, as the brief anticipated.
5. **Sequencing for a genuine proto RED** (see TDD evidence above) — not a correction
   to the brief's code, just to my own execution order, so both host and proto show a
   real red-before-green cycle.

No brief code needed a compile-time fix beyond the three corrections above; everything
else (the host handler body, the dialog's form logic, the shell wiring, the i18n keys)
matched the brief verbatim and compiled/typechecked/linted clean on the first pass
after applying the corrections.

## Concerns

- **Audit action name is shared.** The self-service `change_password` handler and the
  existing admin-driven `office_users::set_password` both write action
  `office_user.password`. This matches the brief exactly (`Produces: ... строка
журнала office_user.password`), and the two are distinguishable by comparing
  `actor_id` to `target_id` (equal for self-service), but a future audit-log screen
  (plan 5) will need to make that distinction explicit if it wants to label them
  differently in the UI.
- **Cosmetic markdown wrap.** After `prettier --write`, the new §10 bullet's inline
  code span (`` `markiro-host reset-password --login <логин>` ``) is split across two
  source lines with the second line not indented under the list marker, unlike its
  sibling bullets. This is valid CommonMark (a lazy continuation line) and is
  prettier's own canonical output (`--check` passes), so I left it rather than fighting
  the formatter; it renders correctly but looks slightly inconsistent in the raw
  source.
- **No manual/visual check.** Per the environment notes, no interactive `tauri dev`
  window or browser was opened (no graphical session in this environment): the
  `ChangePasswordDialog` UI (modal layout, focus trap, field spacing) is verified only
  through jsdom + Testing Library assertions (element roles/text, form submission,
  error mapping), not visually. Task 10 touches no Windows-specific or DPAPI code, so
  no Windows-only check applies to it specifically.

## Commit

Single commit, explicit paths (`apps/standalone/proto apps/standalone/host
apps/standalone/src apps/standalone/test
docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`), trailer
verified with `git log -1 --format=%B`.

## Fix round 1

Review came back "Needs fixes" on commit `af7ab209e`. This section covers the fix
round, committed on top of it.

### 1. (Important) No test on the rate limiter — added

`apps/standalone/host/tests/office_auth.rs`: new test
`password_change_attempts_are_rate_limited_and_shared_with_login`, in the style of
`login_attempts_are_limited_per_address` (a callable `attempt` closure over
`send_from`, `LAN`/`LOOPBACK`, `clock.advance`). It sends 10 wrong-current-password
`PUT /v1/office/me/password` requests from `LAN` (each `401 unauthorized,
credential=password`, since the limiter only counts them), then an 11th that gets
`429 rate_limited`; then a `POST /v1/office/login` from the same `LAN` address, which
also gets `429 rate_limited` — proving `change_password` and `login` share
`state.login_limiter`; then a request from `LOOPBACK`, which is still accepted
(`401`, `credential=password`, not `429`) — proving the limit is per address; then,
after `app.clock.advance(time::Duration::seconds(61))`, `LAN` is accepted again
(`401`, not `429`).

The production code already had the `state.login_limiter.check(peer.ip())` call from
the original implementation, so this test passed immediately on being added (no RED
phase) — its purpose is coverage: deleting the limiter call now fails the suite,
which it did not before.

Verified: `cargo test -p markiro-host --test office_auth --offline
password_change_attempts_are_rate_limited_and_shared_with_login -- --exact` → 1
passed; the full `office_auth` file → 15 passed (was 14).

### 2. (Important) Extracted `replace_password`

`change_password`'s success tail (bump revision, update `password_phc`, delete the
user's other sessions, write the `ok` `office_user.password` audit row) repeated
`office_users::set_password`'s tail statement for statement. Extracted a
crate-internal helper in `apps/standalone/host/src/routes/office_users.rs`:

```rust
pub(crate) async fn replace_password(
    conn: &mut SqliteConnection,
    at: &str,
    actor: Actor<'_>,
    user_id: &str,
    keep_session_id: &str,
    password_phc: &str,
) -> Result<(), ApiError>
```

It does exactly that four-statement tail and nothing else — no rights check, no
current-password check, no new-password validation, no `commit`. Both routes keep
their own checks (self-service: `require_session_in` plus the verified-hash
re-read; admin: `require_admin`/`require_admin_in`) and their own `tx.commit()`
call; both now end with `replace_password(&mut tx, &at, context.actor(), <target
id>, &context.session_id, <new phc>).await?;`.

Placed in `office_users.rs` (per the coordinator's suggestion) since
`office_auth.rs` already depends on it being reachable as
`crate::routes::office_users::replace_password`; both modules are `pub mod` under
`routes/`, so this crosses no module-privacy boundary. `office_auth.rs` no longer
needs `crate::db::next_revision` (only used in the removed tail), so that import
was dropped; `office_users.rs` gained `Actor` to its `crate::audit` import for the
new function's parameter type.

No test assertions changed. Verified: `cargo test -p markiro-host --test
office_auth --offline` → 15 passed; `cargo test -p markiro-host --test office_admin
--offline` → 8 passed (this is the test file for `office_users.rs`, covering
`set_password` among others); full workspace → 123 passed (20 suites, up from 122
because of the new rate-limit test).

### 3. (Minor) `ChangePasswordDialog` close guard and its own close label

- `close()` now returns immediately when `isSubmitting`, before `reset()`,
  `setSubmitError(null)` or `onClose()`. Escape, the overlay click and the Modal's ×
  all call `close` (per `Modal`'s implementation), so all three are now blocked
  while a request is in flight, not just the footer's "Отмена" button (which was
  already `disabled={isSubmitting}`).
- Added `office.password.close = "Закрыть"` to `ru.json` and used it as the
  `Modal`'s `closeLabel` (the × button's `aria-label`); the footer button keeps
  `office.password.cancel` = "Отмена" unchanged, so the two controls now have
  distinct accessible names.

No dedicated test was added for this (not requested, and no existing test exercised
Escape/overlay/× on this dialog); typecheck and lint stayed clean and the full
Vitest suite stayed green.

### 4. (Minor) App test for the session-ended path through `changePassword`

`apps/standalone/test/app.test.tsx`: new test "routes a password change through the
token-scoped call, ending the session" — after `signIn()`, opens the dialog, fills
and submits valid values; `host.officeChangePassword` rejects once with `HostError({
kind: "api", code: "unauthorized", status: 401, details: { credential: "session" }
})`. `officeSession.changePassword` goes through the token-scoped `call`, which maps
that rejection via `shellActionFor` to `{ type: "session_ended", token }`, dispatches
it, and re-throws (the dialog's own `catch` falls through to the generic
`setSubmitError` branch, but by then `App` has already unmounted `<Office>` in favor
of `office_login`). The test asserts the resulting screen: `"Вход в офис"` (the
`OfficeLogin` card title) and `"Сессия офиса закончилась. Войдите снова."` (the
`notice === "session_ended"` alert).

Verified in isolation first (`vitest run test/app.test.tsx -t "routes a password
change through the token-scoped call"` → 1 passed, no console warnings/errors), then
as part of the full suite → 149 passed (was 148).

### 5. (Minor) Docs

- `host/src/routes/office_auth.rs` module doc now lists `PUT /v1/office/me/password`
  alongside login/logout/me.
- `apps/standalone/AGENTS.md` "Writes": extended the `require_admin_in` bullet with
  "Self-service writes any office user may make on their own record (their own
  password) re-check the same way with `OfficeContext::require_session_in` instead;
  admin writes keep using `require_admin_in`."
- Spec §10: reworded the forgotten-administrator-password bullet so
  `` `markiro-host reset-password --login <логин>` `` sits on one source line. After
  `prettier --write` the file was reported `unchanged`, confirming this phrasing is
  prettier's own canonical form (fix round 1's version of this bullet had split the
  inline code span across two lines, with the second line losing its list-item
  indentation — valid CommonMark, but visually inconsistent, per the coordinator's
  ask).

### Fix-round checks (all green)

- `cargo test -p markiro-host --test office_auth --offline` — 15 passed.
- `cargo test -p markiro-host --test office_admin --offline` — 8 passed.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline`
  (sandbox disabled) — 123 passed, 20 suites.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` — clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` — 149
  passed, 12 files.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` —
  clean.
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint` —
  clean.
- `node_modules/.bin/prettier --write` then `--check` on all files touched in this
  round — all reported `unchanged`/clean.
- `git diff --check` — clean.

### Files changed in this round

- `apps/standalone/host/src/routes/office_auth.rs`,
  `apps/standalone/host/src/routes/office_users.rs`,
  `apps/standalone/host/tests/office_auth.rs`
- `apps/standalone/src/i18n/ru.json`, `apps/standalone/src/office/ChangePasswordDialog.tsx`
- `apps/standalone/test/app.test.tsx`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

### Concerns carried over / new

- The two remaining concerns from the original report (shared `office_user.password`
  audit action name between self-service and admin-driven changes; no manual/visual
  check of the dialog) still apply unchanged.
- No new concerns from this round.
