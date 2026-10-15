# Plan 1c2, Task 3 — report

Line selection by the station (`DeviceState::select_line`, command
`device_select_line`) and the updated `host_request` route list, in
`apps/standalone/src-tauri`.

Commit: `fb88b17d5` — `feat(standalone): выбор линии станцией и лента в
маршрутах вебвью`

## What was implemented

1. **`DeviceState::select_line(&self, line_id: &str) -> Result<DeviceStatus,
DeviceError>`** (`src-tauri/src/device.rs`). Serialised on the same
   `pairing` mutex as `local_pair`/`claim`/`forget`. Requires a paired device
   (via the new `paired()` helper), sends `PUT /v1/device/line` with the
   device's key, maps the host's answer to `DeviceStatus`, and — on success —
   writes the host-confirmed `lineId` into `device.json` before updating the
   in-memory `Current::Paired` state. A 400 becomes `LineRejected`, a 401
   becomes `KeyRejected`, anything else `RequestFailed`.
2. **`fn paired(&self) -> Result<Arc<PairedDevice>, DeviceError>`**, factored
   out of the inline match that used to live in `request`; `request` now
   calls it too, so both methods share one "must be paired" check.
3. **Three new `DeviceError` variants** — `LineRejected` (`line_rejected`),
   `KeyRejected` (`key_rejected`), `RequestFailed` (`request_failed`) — wired
   into `code()`.
4. **`webview_may_reach`** rewritten: still excludes every pairing route, now
   also excludes `/v1/device/line` specifically (via the new `LINE_ROUTE`
   constant) while admitting the rest of `/v1/device/…`, and admits exactly
   `/v1/changes` (query string included) without opening `/v1/changes/stream`
   or `/v1/changes/` (trailing slash) or `/v1/changesx`.
5. **`device_select_line` Tauri command** (`src-tauri/src/lib.rs`), registered
   in `invoke_handler()` right after `host_request`. Tauri exposes the Rust
   `line_id` argument to the webview as `lineId`, matching the brief and the
   `officeToken`/`host_request` precedent.
6. **Docs**: `apps/standalone/AGENTS.md` §"Network and TLS" (route list now
   names the `/v1/device/line` exception, `/v1/changes`, and `device_select_line`'s
   role in keeping `device.json` current) and the spec's §5.2 "Клиент хоста"
   bullet (added `device_select_line(lineId)` to the command list, updated the
   `host_request` route-list sentence the same way).
7. **Task 2 review leftovers** (comments/docs only, no behaviour or test-
   assertion changes):
   - `AGENTS.md` "Local pairing trust": the false claim "a typo never burns
     the host's live codes" is now "so a code of the wrong length or with a
     symbol outside the alphabet never reaches the host"; the whole paragraph
     is rewrapped to the file's ~76–79-column style (it had a 108-column line
     and two ragged short lines).
   - `device.rs`, comment above `pairing::normalize` in `claim`: reworded to
     say `normalize` only stops a code of the wrong length/alphabet, not a
     typo that keeps the code's shape.
   - `device.rs` module doc: now mentions pairing by code and line selection,
     not just local pairing.
   - `DeviceError::AlreadyPaired` doc: "Pairing was asked…" (any pairing, not
     just local).
   - `DeviceError::CodeInvalid` doc: now covers both the shell's own
     malformed-code rejection and the host's refusal.
   - `tests/claim.rs`: "The shell sends the canonical form" → "The typed form
     pairs" (the host normalizes too, so the test can't attribute it to one
     side); dropped "(or counted it)" from the doc comment on
     `another_fingerprint_keeps_the_code_on_the_device` (a counted failure
     would still let the code pair later, so it doesn't support the claim).

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --offline
```

Run before any `device.rs`/`lib.rs` changes, with `tests/line.rs` created and
the `a_station_selects_its_line_through_the_ipc_shapes` test appended to
`tests/ipc.rs`. Output (excerpt, 7 errors total):

```
error[E0599]: no method named `select_line` found for struct `DeviceState` in the current scope
  --> src-tauri/tests/line.rs:75:26
error[E0282]: type annotations needed
  --> src-tauri/tests/line.rs:75:18
error[E0599]: no method named `select_line` found for struct `DeviceState` in the current scope
  --> src-tauri/tests/line.rs:95:17
error[E0599]: no variant or associated item named `LineRejected` found for enum `DeviceError` in the current scope
  --> src-tauri/tests/line.rs:96:26
error[E0599]: no method named `select_line` found for struct `DeviceState` in the current scope
  --> src-tauri/tests/line.rs:123:17
error[E0599]: no variant or associated item named `KeyRejected` found for enum `DeviceError` in the current scope
  --> src-tauri/tests/line.rs:124:26
error[E0599]: no method named `select_line` found for struct `DeviceState` in the current scope
  --> src-tauri/tests/line.rs:134:17
cargo test: 7 errors, 1 warnings (1 crates)
```

Matches the brief's expected RED exactly (missing `select_line`,
`LineRejected`, `KeyRejected`).

### GREEN

Same command, after implementing Step 2 (`device.rs`) and Step 3 (`lib.rs`):

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --offline
```

```
Running tests/ipc.rs
running 6 tests
test without_a_local_database_the_local_commands_say_so ... ok
test an_unpaired_device_reports_null_and_refuses_host_requests ... ok
test the_local_database_answers_through_the_ipc_shapes ... ok
test a_paired_device_reaches_the_host_through_the_ipc_shapes ... ok
test a_station_selects_its_line_through_the_ipc_shapes ... ok
test a_device_claims_a_code_through_the_ipc_shapes ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

Running tests/line.rs
running 5 tests
test line_selection_needs_a_pairing ... ok
test a_key_the_host_does_not_know_is_rejected ... ok
test the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route ... ok
test an_unknown_line_is_rejected_and_nothing_is_saved ... ok
test a_station_chooses_its_line_and_keeps_it_across_restarts ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

11 passed (5 + 6), as the brief expects. Run outside the sandbox
(`dangerouslyDisableSandbox: true`) because `tests/line.rs` and `tests/ipc.rs`
start real `markiro-host` instances bound to `127.0.0.1`.

## Verification commands and results

All run from the worktree root
(`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`).

| Command                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --test ipc --offline` (outside sandbox)    | 11 passed (2 suites)                                                                                                                                                                                                                                                                                                                                        |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline` (outside sandbox)                           | **69 passed** (10 suites), exit code 0. Baseline before this task was 62 (per brief); net +7 = 5 new in `line.rs` + 1 new in `ipc.rs` (`a_station_selects_its_line_through_the_ipc_shapes`) + 1 new in `device.rs` unit tests (`line_and_key_error_codes_are_stable`). `webview_reachable_routes_exclude_pairing` was renamed/extended in place, not added. |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                             | Clean, exit code 0                                                                                                                                                                                                                                                                                                                                          |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                        | Clean build, **no warnings**, exit code 0                                                                                                                                                                                                                                                                                                                   |
| `node_modules/.bin/prettier --write apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` | Both reported `unchanged`                                                                                                                                                                                                                                                                                                                                   |
| `node_modules/.bin/prettier --check` (same two files)                                                                               | `All matched files use Prettier code style!`, exit code 0                                                                                                                                                                                                                                                                                                   |
| `git diff --check`                                                                                                                  | No output, exit code 0                                                                                                                                                                                                                                                                                                                                      |
| `git status --short` after staging                                                                                                  | Exactly the 7 intended files (`AM`/`M`), nothing else                                                                                                                                                                                                                                                                                                       |

Not run / out of scope for this task: any `apps/standalone/host` test (host is
out of scope per the task and untouched), any `apps/station` check (not
touched), TypeScript/webview tests (Task 5 wires the TS bindings; none of
`src/`, `test/` were touched here), and any browser/hardware/Windows
verification (this task has no such surface).

## Files changed

- `apps/standalone/src-tauri/src/device.rs` — `select_line`, `paired`,
  `LINE_ROUTE`, three new `DeviceError` variants, `webview_may_reach`
  rewrite, updated tests, plus the doc/comment review fixes.
- `apps/standalone/src-tauri/src/lib.rs` — `device_select_line` command and
  its registration in `invoke_handler()`.
- `apps/standalone/src-tauri/tests/line.rs` (new) — 5 tests against a real
  `markiro-host`.
- `apps/standalone/src-tauri/tests/ipc.rs` — 1 new IPC-contract test.
- `apps/standalone/src-tauri/tests/claim.rs` — 2 comment-only review fixes
  (no assertion changes).
- `apps/standalone/AGENTS.md` — "Network and TLS" route-list update; "Local
  pairing trust" paragraph correction and rewrap.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` —
  §5.2 "Клиент хоста" bullet: added `device_select_line`, updated the route
  list.

## Deviations

None. Every brief-supplied code block (the two test files, the `device.rs`
additions, the `webview_may_reach` rewrite, the test-module replacements, and
the `lib.rs` command) compiled and passed exactly as given, so nothing needed
a fix-up under TDD Resolution rule 1. The four "review leftover" wording
fixes were open-ended by design (the brief gave the diagnosis, not verbatim
text, except for the one AGENTS.md sentence and the general shape of the
`device.rs` comment fix) — the exact replacement wording for the `device.rs`
`claim` comment, the module doc, `AlreadyPaired`, `CodeInvalid`, and both
`claim.rs` comments is my own phrasing, chosen to state only what the tests
and code actually establish, per the review notes. No test assertions were
weakened or changed anywhere.

## Self-review

- `select_line` takes the same `pairing` mutex as `local_pair`/`claim`/
  `forget`, so a concurrent forget or re-pairing can't interleave with a line
  change (matches the "serialised with pairing and forgetting" requirement
  and the brief's code verbatim).
- `paired()` is used by both `request` and `select_line`, removing the
  duplicated inline match — the only functional change to `request` is that
  its error path is now identical to `select_line`'s (`NotPaired` /
  `ConfigUnreadable`), which the existing `ipc.rs`/`device.rs` tests already
  pin.
- `webview_may_reach` correctly special-cases `/v1/device/line` inside the
  broader `/v1/device/` prefix (rather than excluding all of `/v1/device/…`),
  so `GET /v1/device`, `GET /v1/device/foo`, etc. still pass, but the exact
  route the host uses for `PUT` line selection does not — verified by the
  extended unit test table, including the query-string variant
  `/v1/device/line?lineId=1` and near-miss paths `/v1/changes/`,
  `/v1/changesx` for the new `/v1/changes` allowance.
- `select_line` reads `line_id` from the host's `DeviceInfo` response body
  (not the input parameter) before saving to `device.json`, so the local
  state can never drift from what the host actually confirmed, matching the
  brief's "device.json always holds the line the host confirmed" invariant —
  exercised by `a_station_chooses_its_line_and_keeps_it_across_restarts`,
  which reloads `DeviceState` from disk and re-asks the host via
  `GET /v1/device`.
- `an_unknown_line_is_rejected_and_nothing_is_saved` and
  `a_key_the_host_does_not_know_is_rejected` both confirm the negative case:
  a rejected `select_line` leaves `device.json`/in-memory state untouched
  (no partial write before the host's status is known — the `device_config::
save` call only happens after the `match response.status` guard).
- I did not touch `apps/standalone/host` or `apps/station`, did not add any
  dependency, and `Cargo.lock` has no diff (confirmed via `git status
--short`, which lists only the 7 files touched by source edits, no lock
  file).
- Commit trailer verified verbatim via `git log -1 --format=%B`: exactly
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` on its own line.
- One residual style note (not a defect): the spec file's §5.2 bullet already
  mixed short wrapped lines with one very long unwrapped line
  (`host_claim(address, fingerprint, code, name)…`) before this task; I
  wrapped my addition to a similar width instead of reflowing the whole
  bullet, since prettier's `proseWrap: preserve` (repo default, no override
  in `.prettierrc.json`) does not enforce a prose width and the brief did not
  ask for a full reflow of that file the way it did for `AGENTS.md`.

## Fix round 1

Commit: `0b92e9046` — `fix(standalone): ревью задачи 3 плана 1c2 — точечные
сегменты пути`

The reviewer confirmed the Task 3 implementation and the Task 2 wording fixes,
then found one real security hole plus a wording nit.

### The hole: a `.` segment bypasses the `/v1/device/line` exclusion

`webview_may_reach` and `PinnedClient::send`'s `validate_path` both operate on
the literal path string. `host_request("PUT", "/v1/device/./line", …)` passes
both: `webview_may_reach` sees a route under `/v1/device/` that is literally
not equal to `LINE_ROUTE` ("/v1/device/./line" != "/v1/device/line"), and the
old `validate_path` only rejected `..`, `//` and disallowed characters — a
lone `.` segment was untouched. `reqwest`'s underlying `url` crate then
normalizes the request URL, collapsing `/v1/device/./line` to
`/v1/device/line` before it reaches the host, so the host receives a real
`PUT /v1/device/line` and would change the line while `device.json` keeps the
stale value — exactly the invariant Task 3 exists to protect.

**Fix** (`apps/standalone/src-tauri/src/host_client.rs::validate_path`): added
`!route.split('/').any(|segment| segment == ".")`, where `route` is the path
with any query string stripped (`path.split('?').next().unwrap_or(path)`), so
a dot in a query value (e.g. `?x=1.5`) is unaffected — only a `.` **segment**
of the route itself is refused. This is the shared validator `PinnedClient::
send` calls for every host request, so it protects `select_line`, `local_pair`,
`claim` and `host_request` alike, not just the webview's path. Updated the
function's doc comment to explain the `.`-segment rule alongside the existing
`%` rule, for the same reason: the `url` crate would silently normalize it
past a route check upstream (`webview_may_reach`'s `LINE_ROUTE` exclusion).

Per the reviewer's guidance, `device::tests::
webview_reachable_routes_exclude_pairing_the_line_and_the_stream` was **left
unchanged**: `webview_may_reach` is a coarse, string-level allow-list used
only by `host_request`; the actual security boundary against URL-normalization
tricks is `validate_path`, which every caller goes through regardless of
route-list logic. Adding the dotted case there would test the wrong layer.

### Red run (temporary revert, then restored)

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --test line --offline -- the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route
```

With the new check temporarily removed from `validate_path` (the `!route.
split('/').any(|segment| segment == ".")` line deleted, `route` computation
kept but unused via `let _ = route;` to avoid an unrelated warning), the test
failed with concrete proof the request reaches the host and is processed as a
real line change:

```
thread 'the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route' panicked at src-tauri/tests/line.rs:160:9:
assertion `left == right` failed: PUT /v1/device/./line
  left: Ok(HostResponse { status: 400, body: Some(Object {"error": Object {"code": String("validation_failed"), "details": Object {"field": String("lineId")}, "message": String("no such active line")}}) })
 right: Err(Request(InvalidRequest))
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.13s
```

The `status: 400 validation_failed / "no such active line"` body is the
host's own `select_line` handler answering a real `PUT /v1/device/line` — not
a client-side rejection — which confirms the dotted path reached and was
processed by the line-selection route exactly as the reviewer described (with
a line id that exists, this would have been a 200 and an actual line change).
The dot-segment check was then restored (`git diff` before commit shows the
final, kept version — see below), and the same command passed:

```
running 5 tests
test line_selection_needs_a_pairing ... ok
test a_key_the_host_does_not_know_is_rejected ... ok
test an_unknown_line_is_rejected_and_nothing_is_saved ... ok
test a_station_chooses_its_line_and_keeps_it_across_restarts ... ok
test the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.14s
```

### Tests added

- `host_client.rs::tests::only_host_api_paths_pass`: refused
  `"/v1/device/./line"`, `"/v1/office/./users"`, `"/v1/device/line/."`;
  allowed `"/v1/device?x=1.5"` (a dot inside a query value, never seen by the
  segment check since it is stripped with the query string before
  `route.split('/')` runs). No route in `apps/standalone/host/src/server.rs`
  has a literal `.` inside a path segment (checked via `grep -n '\.route\('`),
  so — per the reviewer's fallback instruction — no contrived "dotted
  non-segment route" was invented; the query-value case covers that
  distinction instead.
- `tests/line.rs::the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route`:
  added `("PUT", "/v1/device/./line")` to the refused-routes loop, still
  asserting `Err(DeviceError::Request(RequestError::InvalidRequest))`.
- `device.rs::tests::webview_reachable_routes_exclude_pairing_the_line_and_the_stream`:
  intentionally unchanged (see above).

No existing assertion was weakened, removed, or changed in behaviour; only
new cases were appended to existing test tables.

### Wording nit

`apps/standalone/AGENTS.md` line 162 (now line 162, unchanged position):
"the webview's only way to reach the host" → "the webview's generic way to
reach the host" — `host_local_pair` and `host_claim` are also ways to reach
the host, and the very next sentences describe `device_select_line` as a
separate path, so "only" was already contradicted before this fix round.

### Verification (fix round 1)

All commands run from the worktree root; test/check commands run outside the
sandbox (`dangerouslyDisableSandbox: true`) because `tests/line.rs` starts a
real `markiro-host` on `127.0.0.1`.

| Command                                                                                      | Result                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`      | **69 passed** (10 suites), exit code 0 — same total as before, since this round only added assertions to existing tests, no new `#[test]` functions |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                      | Clean, exit code 0                                                                                                                                  |
| `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline` | Clean, **no warnings**, exit code 0                                                                                                                 |
| `node_modules/.bin/prettier --check apps/standalone/AGENTS.md`                               | `All matched files use Prettier code style!`, exit code 0                                                                                           |
| `git diff --check`                                                                           | No output, exit code 0                                                                                                                              |

### Files changed (fix round 1)

- `apps/standalone/src-tauri/src/host_client.rs` — `validate_path` dot-segment
  check plus doc comment, and the two test-table additions.
- `apps/standalone/src-tauri/tests/line.rs` — one new refused case in the
  route-list behavioural test.
- `apps/standalone/AGENTS.md` — one-word-level wording fix.

Note: `docs/superpowers/plans/2026-09-27-standalone-1c2-app-shell-sync.md` was
modified in the shared worktree by unrelated concurrent work (a TypeScript
`ConnectionHandlers`/`ConnectionApi` interface edit inside the plan document,
not touched by this task) at the time of this fix round. It was left
untouched and excluded from staging and from this commit, per the rule to
preserve changes that belong to other work.

### Self-review (fix round 1)

- The fix lives in the lowest shared layer (`validate_path`, called from
  `PinnedClient::send`), so it protects every caller — `select_line`,
  `local_pair`, `claim`, and `host_request` — not just the webview's route
  list, closing the hole regardless of which higher-level check (if any) a
  future route addition gets wrong.
- The query-string carve-out (`route = path.split('?').next()...`) is
  deliberate and tested: a `.` is a normal, needed character in query values
  (already in the byte allow-list) and the vulnerability is specifically
  about **path segments** the `url` crate collapses, not query data, which
  `url` does not reinterpret as path structure.
- The red run reproduced the actual reported failure mode end-to-end (a real
  host receiving and processing `PUT /v1/device/line`), not just a unit-level
  assertion mismatch, which is stronger evidence than the compile-error-style
  RED from Task 3's initial TDD step.
- Confirmed no other `/v1/device/…`-shaped exclusion in the codebase relies on
  literal string inequality the way `webview_may_reach`'s `LINE_ROUTE` check
  did before this fix (that check itself is unchanged and still relies on
  `validate_path` as backstop, which is the reviewer-endorsed design).
