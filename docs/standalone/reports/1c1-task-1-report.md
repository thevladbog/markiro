# 1c1 Task 1 report — единый словарь журнала действий хоста

Status: **DONE**

Commit: `e25a2fbc1` — `refactor(standalone): единый словарь журнала действий хоста`
(parent `b27f92f72`, branch `claude/autonomous-desktop-station-9e6f13`)

## What changed

### `host/src/audit.rs`

- Added `pub mod actions` with the ten action-name constants named in the
  brief: `HOST_BOOTSTRAP`, `DEVICE_LOCAL_PAIR`, `OFFICE_LOGIN`, `OFFICE_LOGOUT`,
  `OFFICE_USER_CREATE`, `OFFICE_USER_UPDATE`, `OFFICE_USER_PASSWORD`,
  `ORG_UPDATE`, `SSCC_COUNTER_UPDATE`, `SSCC_BLOCK_SIZES_UPDATE`.
- Added `pub mod reasons` with `INVALID_LOGIN`, `UNKNOWN_LOGIN`,
  `WRONG_PASSWORD`, `INACTIVE`, `CHANGED`, `WRONG_CURRENT_PASSWORD`.
- Added `pub fn update_details(fields: &[(&str, Value, Value)]) -> Option<Value>`:
  builds `{ "changed": [...], "<field>": { "from", "to" }, ... }`, or `None`
  when nothing in `fields` differs.
- Added the two unit tests from the brief in `#[cfg(test)] mod tests`.

### `host/src/lib.rs`

- In `start`, right after `let pool = db::open(&paths.database_file()).await?;`,
  added a fire-and-forget `tokio::task::spawn_blocking(|| { secrets::dummy_password_phc(); });`
  (its `JoinHandle` is dropped, never awaited) so the PBKDF2-backed dummy
  verifier is built once at host start-up rather than on the first unknown
  login.

### `host/src/routes/bootstrap.rs`

- `action: "host.bootstrap"` → `action: actions::HOST_BOOTSTRAP`.
- The wizard's `host.bootstrap` audit row now also carries
  `"boxNextSerial": request.sscc.box_next_serial` and
  `"palletNextSerial": request.sscc.pallet_next_serial`.

### `host/src/routes/pairing.rs`

- `action: "device.local_pair"` → `action: actions::DEVICE_LOCAL_PAIR`. No
  behavior change (the "refused pairing writes no audit row" behavior already
  existed; task 1 only adds a regression test for it, see below).

### `host/src/routes/office_auth.rs`

- `login`: the malformed-login branch now uses `actions::OFFICE_LOGIN` and
  `reasons::INVALID_LOGIN`.
- `login`'s post-hash tail was replaced with the brief's exact refusal-reason
  logic: it re-reads `(password_phc, active)` inside the write transaction
  only when `password_ok`, then computes one `refusal: Option<&str>` via a
  single match: no row → `UNKNOWN_LOGIN`; wrong password → `WRONG_PASSWORD`;
  row inactive → `INACTIVE`; the re-read hash still matches the one PBKDF2
  verified → accepted (`None`); otherwise (hash changed mid-verification) →
  `CHANGED`. The success branch audits `actions::OFFICE_LOGIN` /
  `Outcome::Ok` with `{ "login": login }` unchanged; every denial branch now
  audits `{ "reason": reason }` instead of the previous `{ "login": ... }`,
  and the typed login is no longer recorded on a denial.
- `logout`: `action: "office.logout"` → `actions::OFFICE_LOGOUT`.
- `change_password`: the current-password check was rewritten from
  `let Some(new_phc) = new_phc.filter(...) else { ... }` to a `match` that
  distinguishes "current password never verified" (`WRONG_CURRENT_PASSWORD`)
  from "it verified, but the stored hash changed underneath it"
  (`reasons::CHANGED`) — both still return the same `401 password` error to
  the caller, but the two audit reasons differ. Uses
  `actions::OFFICE_USER_PASSWORD`.

### `host/src/routes/office_users.rs`

- `replace_password`: `action: "office_user.password"` →
  `actions::OFFICE_USER_PASSWORD`.
- `create_user`: `action: "office_user.create"` → `actions::OFFICE_USER_CREATE`.
- `update_user`: the three-field manual diff (`let mut changed = Vec::new(); ...`)
  was replaced with one `audit::update_details(&[("name", ...), ("role", ...),
("active", ...)])` call; the early-return-on-no-op branch is now the `else`
  arm of a `let Some(details) = ... else { return Ok(Json(current)); };`. The
  audit row uses `actions::OFFICE_USER_UPDATE` and the new `details` value
  directly (`role` compared as `.as_str()` strings, `active` as booleans, per
  the brief).

### `host/src/routes/org.rs`

- Same shape of change as `office_users.rs::update_user`: the five-field
  manual diff for `name`, `inn`, `gln`, `gs1Prefixes`, `timeZone` was replaced
  by one `audit::update_details(&[...])` call in that field order, and the
  audit row uses `actions::ORG_UPDATE` with the returned `details`.

### `host/src/routes/sscc.rs`

- `put_counter`: `action: "sscc.counter.update"` →
  `actions::SSCC_COUNTER_UPDATE`; `details` is now
  `json!({ "changed": ["nextSerial"], "nextSerial": { "from": current, "to": update.next_serial } })`
  (a literal, not `update_details`, since the no-op case already returns
  earlier — exactly one field can ever be changed here).
- `put_block_sizes`: `action: "sscc.block_sizes.update"` →
  `actions::SSCC_BLOCK_SIZES_UPDATE`; `details` now comes from
  `audit::update_details(&[("boxBlockSize", ...), ("palletBlockSize", ...)])
.unwrap_or_else(|| json!({ "changed": [] }))` — the `unwrap_or_else` arm is
  unreachable (the no-op case returns before this point) but avoids an
  `expect`/panic, as the brief specifies.

### `apps/standalone/AGENTS.md`

- Replaced the "Audit" section with the brief's text: action names only from
  `audit::actions`; every `denied` row's `details.reason` from
  `audit::reasons`; update rows carry `details.changed` plus `{ from, to }`
  per field; details never hold pairing codes/keys/tokens/passwords/salts/
  hashes; a refused login never records the typed login; a rate-limiter
  refusal writes no row; `office_user.password` covers both an admin's reset
  and a self-change (`actor_id == target_id`).

### Test files

- `host/tests/office_auth.rs`:
  - `wrong_password_unknown_login_and_inactive_user_are_denied_and_audited`:
    first `last_audit` now expects `{ "reason": "wrong_password" }`, second
    expects `{ "reason": "unknown_login" }` (and its `Some(device_id)` became
    `Some(device_id.clone())` since `device_id` is used again below), and a
    new `assert_eq!` after the inactive-user check verifies the `"inactive"`
    audit row (`Some(device_id.clone())`, `Some(user_id.clone())`,
    `"denied"`, `{ "reason": "inactive" }`).
  - Added `a_session_ends_exactly_30_idle_minutes_after_its_last_activity`
    verbatim from the brief.
- `host/tests/pairing.rs`: added
  `refused_local_pairing_writes_no_audit_row` verbatim from the brief
  (LAN peer → 403 `loopback_only`; loopback but `kind: "handheld"` → 400
  validation error; `audit_rows` is empty after both).
- `host/tests/bootstrap.rs`:
  - `the_wizard_initializes_the_host_and_signs_the_admin_in`'s `host.bootstrap`
    details now also expect `"boxNextSerial": 1500, "palletNextSerial": 40`.
  - `the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions`'s
    `org.update` details now also expect the five `{ from, to }` pairs given
    in the brief.
- `host/tests/office_admin.rs`: the three `assert_audit` conversions listed
  below.

## Converted test assertions (Step 3 item 5 / resolution of ambiguity)

`grep -n '"office_user.update"' apps/standalone/host/tests/office_admin.rs`
before editing showed exactly **one** `assert_audit(..., "office_user.update",
...)` call in the file (the technologist-promotion case named explicitly by
the brief) plus two unrelated `audit_count(&admin, "office_user.update", ...)`
row-count checks that don't assert `details` and so need no conversion. No
other `office_user.update` expectation existed to convert.

The three conversions applied, all in `host/tests/office_admin.rs`:

1. `sscc.counter.update` (SSCC counter moved 1500 → 2000):
   `json!({ "from": 1500, "to": 2000 })` →
   `json!({ "changed": ["nextSerial"], "nextSerial": { "from": 1500, "to": 2000 } })`
2. `sscc.block_sizes.update` (box 2000 → 5000, pallet 200 → 500):
   `json!({ "boxBlockSize": 5000, "palletBlockSize": 500 })` →
   `json!({ "changed": ["boxBlockSize", "palletBlockSize"], "boxBlockSize": { "from": 2000, "to": 5000 }, "palletBlockSize": { "from": 200, "to": 500 } })`
3. `office_user.update` (technologist promoted to admin, name/active
   unchanged):
   `json!({ "changed": ["role"] })` →
   `json!({ "changed": ["role"], "role": { "from": "technologist", "to": "admin" } })`

## TDD evidence

### Step 1 — RED (test added, `update_details` does not exist yet)

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib audit --offline`
Exit: `101`

```
error[E0432]: unresolved import `super::update_details`
  --> host/src/audit.rs:66:9
   |
66 |     use super::update_details;
   |         ^^^^^^^^^^^^^^^^^^^^^ no `update_details` in `audit`

error: could not compile `markiro-host` (lib test) due to 1 previous error
```

### Step 2 — GREEN (`actions`, `reasons`, `update_details` added)

Same command. Exit: `0`

```
running 2 tests
test audit::tests::update_details_is_none_when_nothing_changed ... ok
test audit::tests::update_details_lists_changed_fields_with_their_values ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s
```

### Step 3 — RED (test files updated to the new vocabulary; writers not yet updated)

Command: `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test office_auth --test pairing --test bootstrap --test office_admin --offline --no-fail-fast`
Exit: `101`

Per-binary results (exactly matching the brief's prediction — the refused-pairing
test and the idle-boundary test pass immediately because they pin already-existing
behavior; everything that depends on the new `reason`/`{from,to}`/starting-serials
vocabulary fails):

```
Running tests/bootstrap.rs
test the_wizard_initializes_the_host_and_signs_the_admin_in ... FAILED
test the_org_profile_is_read_by_all_and_changed_by_admins_with_revisions ... FAILED
test result: FAILED. 4 passed; 2 failed

Running tests/office_admin.rs
test block_sizes_are_validated_and_versioned ... FAILED
test sscc_counters_move_only_forward_within_capacity ... FAILED
test users_are_created_updated_and_the_last_admin_is_protected ... FAILED
test result: FAILED. 5 passed; 3 failed

Running tests/office_auth.rs
test wrong_password_unknown_login_and_inactive_user_are_denied_and_audited ... FAILED
test result: FAILED. 15 passed; 1 failed
(a_session_ends_exactly_30_idle_minutes_after_its_last_activity is among the 15 passed)

Running tests/pairing.rs
test result: ok. 6 passed; 0 failed
(refused_local_pairing_writes_no_audit_row is among the 6 passed)
```

### Step 4 — GREEN (writers switched to `audit::actions` / `audit::reasons` / `audit::update_details`)

Command (run outside the sandbox — several suites bind `127.0.0.1`):
`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline`
Exit: `0`

```
lib          ... ok. 12 passed
main         ... ok. 3 passed
bootstrap    ... ok. 6 passed
foundation   ... ok. 12 passed
hello        ... ok. 5 passed
no_secrets_in_logs ... ok. 1 passed
office_admin ... ok. 8 passed
office_auth  ... ok. 16 passed
pairing      ... ok. 6 passed
platform     ... ok. 7 passed
doctests     ... ok. 0 passed
```

`grep -rn 'action: "' apps/standalone/host/src` → no matches (exit 1): every
action name now comes from `audit::actions`.

## Verification commands run (before committing)

| Command                                                                                                                             | Result                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo build --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline --tests` (in sandbox, sanity compile)             | OK, 0 warnings                                                                                                                                                                      |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (first attempt, **inside** sandbox)               | Exit 101 — `hello.rs` etc. fail with `PermissionDenied ... cannot listen on 127.0.0.1:0`, i.e. the documented sandbox port-binding restriction, not a code defect                   |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (outside sandbox)                                 | Exit 0, all suites green (breakdown above)                                                                                                                                          |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all`                                                                        | Applied; rustfmt rewrapped long argument lists in `audit.rs`, `office_auth.rs`, `office_users.rs`, `org.rs`, `sscc.rs` (cosmetic only — confirmed via `git diff`, no logic changes) |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                             | Exit 0, no output                                                                                                                                                                   |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`                                                                      | "All matched files use Prettier code style!"                                                                                                                                        |
| `git diff --check` (pre-commit, working tree vs. already-staged index)                                                              | No output (clean)                                                                                                                                                                   |
| `git diff b27f92f72 HEAD --check` (post-commit, full committed diff vs. parent)                                                     | Exit 0, no output (clean)                                                                                                                                                           |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (final re-run after `cargo fmt`, outside sandbox) | Exit 0, all suites green, identical breakdown to Step 4's run                                                                                                                       |
| `git log -1 --format=%B`                                                                                                            | `refactor(standalone): единый словарь журнала действий хоста` + blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`                                              |

`git status --short` after staging the 13 explicit paths and committing: clean
(nothing left unstaged or untracked in this area).

## Deviations from the brief

None in the applied code: every quoted snippet in the brief was matched
verbatim against the file's current content before editing (the Edit tool
requires an exact match), so no "brief text differs from actual code"
situations arose. The only post-edit change was `cargo fmt`'s own line
wrapping of a few multi-argument tuples/calls, which is required by the
"before committing" step and does not change behavior.

One tooling note unrelated to the code: my first attempt to inspect the
"outside-sandbox" full-crate-test log accidentally read a stale copy, because
`$TMPDIR` resolves to a different directory for sandboxed vs.
`dangerouslyDisableSandbox: true` bash calls. Re-running with an explicit
fixed path (`/tmp/t1-*.log`) for the unsandboxed calls fixed this; it did not
affect any code or test outcome, only which log I was reading.

## Concerns

None outstanding. All tests the brief predicted would go red went red for the
predicted reason, and all tests it predicted would pass immediately (the
refused-pairing audit test and the idle-30:00-boundary test) passed on first
try. After Step 4's writer changes, the full host crate (76 tests across 8
integration binaries plus the lib/main unit tests and doctests) is green with
zero warnings, and no assertion was weakened to get there.

## Not run / out of scope for this task

- `apps/standalone` webview/Tauri/`proto` checks (`pnpm --filter
@markiro/standalone ...`, `cargo test` for `src-tauri`/`proto`): task 1 does
  not touch those crates or packages, so plan 1c1's global gates for them are
  deferred to the tasks that do (Task 2 onward per `1c1-constraints.md`'s file
  ownership table).
- Windows/DPAPI/hardware/browser verification: not applicable — this task is
  pure host-side Rust logic with no OS- or network-facing surface beyond what
  the existing test harness already exercises in-process.
