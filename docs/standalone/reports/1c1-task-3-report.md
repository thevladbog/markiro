# 1c1 Task 3 report — connect by code (`POST /v1/pairing/claim`)

Commit: `b6dee46ce` on `claude/autonomous-desktop-station-9e6f13`
(`feat(standalone): подключение устройства по коду — POST /v1/pairing/claim`)

## What changed

- **`apps/standalone/proto/src/lib.rs`**: `codes` gained
  `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED` and the `ALL: &[&str]` parity
  array (all 16 codes, in declaration order). Added `ClaimRequest { code:
Secret, kind: DeviceKind, name: String, app_version: String, capabilities:
Vec<String> }` (`deny_unknown_fields`) after `LocalPairRequest`. Reworded
  `PairResponse`'s doc comment from "Response of `local-pair` (and, from plan
  1c, `pairing/claim`)." to "Response of `local-pair` and `pairing/claim`."
- **`apps/standalone/proto/fixtures/claim-request.json`** (new),
  **`error-codes.json`** (new): the two fixtures the brief specifies verbatim;
  `error-codes.json` is the parity list both Rust and the webview check
  against `codes::ALL` / `API_ERROR_CODES`.
- **`apps/standalone/proto/tests/fixtures.rs`**: imports `ClaimRequest`; two
  new tests — `claim_request_round_trips_rejects_unknown_fields_and_hides_the_code`
  and `the_error_code_fixture_lists_every_code`.
- **`apps/standalone/host/src/server.rs`**: new `pub struct
ClientProtocol(pub u32)` (a `Copy` request extension); `protocol_guard` now
  takes `mut request` and inserts `ClientProtocol(version)` into the request
  extensions on the accepted-version branch, so downstream handlers stop
  re-parsing the protocol header. `AppState` gained `claim_limiter:
Arc<RateLimiter>` (10/minute, its own instance, constructed the same way as
  `login_limiter`, with `clock` still moved into the struct last).
  `protected_routes()` now routes `POST /v1/pairing/claim` to
  `routes::pairing::claim`.
- **`apps/standalone/host/src/rate_limit.rs`**: reworded the module doc
  comment to describe both existing sharers (login and password change) and
  the new standalone claim limiter.
- **`apps/standalone/host/src/validate.rs`**: added `device_registration(name,
app_version, capabilities) -> Result<(&str, &str), ApiError>`, the
  name/app-version/capabilities checks lifted verbatim out of the old
  `local_pair` body so `local_pair` and `claim` share one rule.
- **`apps/standalone/host/src/audit.rs`**: `actions::DEVICE_CLAIM =
"device.claim"`; `reasons::{UNKNOWN_CODE, CODE_USED, TOO_MANY_ATTEMPTS,
CODE_EXPIRED}`.
- **`apps/standalone/host/src/routes/pairing.rs`**: rewritten per the brief.
  `local_pair` now takes `Extension(ClientProtocol(protocol))` instead of
  `HeaderMap`/`PROTOCOL_HEADER`, and delegates validation to
  `validate::device_registration` and insertion to a new private
  `insert_device`/`NewDevice` pair (both `local_pair` and `claim` build a
  `NewDevice` and call it, so the `INSERT INTO devices` SQL exists once).
  Added a private `StoredCode` row type and the `claim` handler: checks
  `state.claim_limiter` first, then validates the device fields, then looks
  up the normalized code's hash, decides the refusal in priority order
  (unknown → used → too-many-attempts → expired → live), bumps
  `failed_attempts` on every live, unused, unexpired code only when the
  reason is `unknown_code` (a syntactically wrong or unrecognized code — a
  case caught early enough that no code was correctly identified, so the
  penalty is shared by every candidate), writes a `denied` audit row on
  refusal, or marks the code used, inserts the device, and writes an `ok`
  audit row on success. Returns `PairResponse` like `local_pair`.
- **`apps/standalone/host/tests/claim.rs`** (new): the seven brief tests
  verbatim (with the unused `login` import dropped — see Deviations).
- **`apps/standalone/host/tests/no_secrets_in_logs.rs`**: added the
  `STANDARD_NO_PAD`/`URL_SAFE_NO_PAD` import; a new block claims a pairing
  code and captures `pairing_code`, `pairing_payload`, `claimed_key`; reads
  `key.der` after the badge-salt query; extended the `secrets` vector with
  those three values plus `format!("{salt:?}")`, `STANDARD_NO_PAD`/
  `URL_SAFE_NO_PAD`-encoded salt, and `STANDARD`-encoded/hex-encoded
  `key.der` (the TLS private key, in the two additional forms the brief asks
  for besides the existing hex/standard-base64 salt checks).
- **`apps/standalone/src/host/errors.ts`**: `API_ERROR_CODES` gained
  `"pairing_code_invalid"`, `"pairing_code_expired"`.
- **`apps/standalone/src/i18n/ru.json`**: `errors.api` gained the two
  matching Russian messages, verbatim from the brief.
- **`apps/standalone/test/errors.test.ts`**: added `readFileSync` and `zod`
  imports, a module-level `testModuleUrl` (bound before use, mirroring
  `test/protocol.test.ts`'s comment about the jsdom `import.meta.url`
  rewrite), and a new test asserting `API_ERROR_CODES` matches
  `proto/fixtures/error-codes.json` exactly (sorted comparison).
- **`apps/standalone/AGENTS.md`** ("Local pairing trust"): replaced the
  one-line forward reference to plan 1c with the paragraph describing the
  code's lifetime, one-time use, 5-failed-attempt death (shared across live
  codes), the 10/minute/address limit, and the claiming device's fingerprint
  pinning — verbatim from the brief.
- **`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`**
  (§4.7, third bullet): extended to name the two error codes and the
  every-live-code-penalized rule — verbatim from the brief.

Minor deviation beyond the brief's literal text (see Deviations): the
`routes/pairing.rs` module doc comment (top of file) was extended to also
name `POST /v1/pairing/claim`, matching its existing style of listing every
route the file serves; the brief's Step 4 does not mention this comment.

## TDD evidence

Red — `claim.rs` created, no route yet (`cargo test -p markiro-host --test claim --offline`):

```
running 7 tests
test a_code_expires_after_ten_minutes ... FAILED
test five_wrong_codes_kill_every_live_code ... FAILED
test a_claim_is_checked_before_the_code ... FAILED
test a_device_in_the_network_pairs_with_a_code_typed_in_any_case ... FAILED
test claims_are_limited_per_address_separately_from_logins ... FAILED
test a_code_is_claimed_once ... FAILED
test a_handheld_pairs_with_a_code ... FAILED

---- five_wrong_codes_kill_every_live_code stdout ----
thread 'five_wrong_codes_kill_every_live_code' panicked:
assertion `left == right` failed: {"error":{"code":"not_found","message":"no route for POST /v1/pairing/claim"}}
  left: 404
 right: 400

test result: FAILED. 0 passed; 7 failed; 0 ignored; 0 measured; 0 filtered out
```

(Also surfaced the anticipated unused-`login`-import warning at this point;
removed per the brief's own note and the task's resolution-of-ambiguity #4.)

Green — after Steps 3-4 (`ClientProtocol`, `claim_limiter`,
`device_registration`, the `claim` handler and route) (`cargo test -p
markiro-host --test claim --test pairing --test pairing_codes --offline`):

```
running 7 tests
test a_handheld_pairs_with_a_code ... ok
test a_code_expires_after_ten_minutes ... ok
test a_code_is_claimed_once ... ok
test a_device_in_the_network_pairs_with_a_code_typed_in_any_case ... ok
test a_claim_is_checked_before_the_code ... ok
test five_wrong_codes_kill_every_live_code ... ok
test claims_are_limited_per_address_separately_from_logins ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

tests/pairing.rs: test result: ok. 6 passed; 0 failed  (unchanged local_pair tests, still green)
tests/pairing_codes.rs: test result: ok. 3 passed; 0 failed
```

## Verification commands and results

| Command                                                                                                                                                                                         | Result                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` (Step 1)                                                                                     | PASS — 17/17                                                                                                    |
| `cargo test -p markiro-host --test claim --offline` (Step 2, pre-implementation)                                                                                                                | FAIL — 0/7 (404, expected red)                                                                                  |
| `cargo test -p markiro-host --test claim --test pairing --test pairing_codes --offline` (Step 4)                                                                                                | PASS — 7+6+3 = 16/16                                                                                            |
| `cargo test -p markiro-host --lib --test bootstrap --test claim --test foundation --test office_admin --test office_auth --test pairing --test pairing_codes --offline` (in-process, sandboxed) | PASS — 16+6+7+12+8+16+6+3 = 74/74                                                                               |
| `cargo test -p markiro-host --test no_secrets_in_logs --offline` (outside sandbox; binds 127.0.0.1:0)                                                                                           | PASS — 1/1                                                                                                      |
| `cargo test -p markiro-host --test hello --test platform --test no_secrets_in_logs --offline` (outside sandbox)                                                                                 | PASS — 5+1+7 = 13/13                                                                                            |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` then `-- --check`                                                                                                                  | Reformatted 5 files (line-wrap only, re-verified green after), then check PASS                                  |
| `cargo test -p markiro-host -p markiro-proto --offline` (outside sandbox, full combined run, final)                                                                                             | PASS — 97 (host: lib 16 + main 3 + 8 integration binaries) + 17 (proto) = 114 tests, **zero compiler warnings** |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/errors.test.ts` (Step 6)                                                                             | PASS — 4/4                                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (full suite)                                                                                                        | PASS — 234/234 across 19 files                                                                                  |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                                | PASS, no errors                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                     | PASS, no errors                                                                                                 |
| `node_modules/.bin/prettier --check` on the 7 changed JSON/TS/MD files                                                                                                                          | PASS — "All matched files use Prettier code style!"                                                             |
| `git diff --check` / `git diff --cached --check`                                                                                                                                                | PASS, no whitespace errors                                                                                      |

Not run: `apps/station` — untouched, out of scope (constraint). Windows/Tauri/
handheld/browser checks — not applicable to this task (pure host+proto+webview
change, no `src-tauri` or platform-specific code touched).

## Deviations from the brief

1. **`login` import removed from `host/tests/claim.rs`.** The brief's own
   text anticipated this ("уберите, если компилятор предупредит") — the
   compiler did warn, so it was removed, matching the task's resolution of
   ambiguity #4.
2. **`no_secrets_in_logs.rs` variable names.** The task's resolution of
   ambiguity #2 asked me to check whether the file's real variable names
   matched the brief's fallback list (`token`, `key`, `paths`, `protocol`,
   `client`, `base`). They matched exactly, so the brief's snippet was used
   unchanged — no renaming needed.
3. **`routes/pairing.rs` top-of-file doc comment.** Reworded to list `POST
/v1/pairing/claim` alongside the other two routes the file serves
   (previously it only named `/v1/local-pair` and `/v1/office/pairing-codes`).
   The brief's Step 4 does not mention this line; I extended it to keep the
   module doc accurate, consistent with its own existing style of naming every
   route in one place. No behavioral effect.
4. **`PairResponse` doc-comment line wrap.** The brief shows the replacement
   text without specifying wrap width; I wrapped it as "Response of
   `local-pair` and `pairing/claim`. The device key is shown\n/// exactly
   once." — same words, cosmetic line break only.
5. **`cargo fmt` reformatting.** After writing the brief's snippets verbatim,
   `cargo fmt --all` reflowed five files (mostly wrapping `insert_device`'s
   signature and the `claim` handler's `match` arms, and the new
   `no_secrets_in_logs.rs` hex-encoding closure, onto more lines than the
   brief's inline listing). Purely cosmetic; all tests re-verified green
   after formatting and `-- --check` is clean.

No test assertions were weakened, no brief-side bugs were found (the seven
`claim.rs` tests, the `no_secrets_in_logs.rs` additions and the `errors.test.ts`
addition all passed against the brief's code as given, once the route existed).

## Concerns

None. All in-scope automated gates are green with zero compiler/lint/type
warnings; the working tree is clean after the commit
(`git status --short` empty).

Not independently verified (outside this task's scope and this environment):
browser/manual confirmation of the office pairing-codes screen or a real
network device claiming a code; Windows-specific behavior. These are
unaffected by this change (server-side route plus two webview constants) but
are called out per the reporting requirement that unverified surfaces be
named explicitly.

## Fix round 1 — review feedback (tests only)

Commit: `41bab6e7e` on `claude/autonomous-desktop-station-9e6f13`
(`test(standalone): review fix round 1 — claim validation order, every live code, secrets scan`)

The reviewer found the `claim` endpoint itself correct and secure; all four
items were test-only gaps. **No production code changes were made** —
`apps/standalone/host/src/routes/pairing.rs` is byte-identical to the Task 3
commit (`git diff` against it is empty); every temporary regression used for
red verification below was fully reverted before the real test run and before
committing.

### Item 1 — `a_claim_is_checked_before_the_code` couldn't catch its own regression

The old test sent both invalid bodies with the **real, live** code. Whether
`validate::device_registration` ran before or after the code lookup, a live
code never reaches the failed-attempts counting branch, so `failed_attempts
== 0` and an empty audit log held either way — the test could not
distinguish correct code from a regression.

Fix: both invalid bodies now carry the wrong code `"0000000000"` instead of
the live one; the test still asserts both `validation_failed` responses
(field `name`, then the unknown-`extra`-field case) and the unchanged
`failed_attempts == 0` / empty-audit assertions, and finishes by claiming the
real code successfully (`200`) to prove it was never touched.

**Red** — temporarily moved the `validate::device_registration(...)?` call
from before the code lookup to immediately after the `let code = match
(found, refusal) { ... };` block (necessarily also switching the denial
branch's audit `"name"` field from the now out-of-scope `name` binding to
`request.name.trim()`, since that branch runs before the relocated
validation call). Ran `cargo test -p markiro-host --test claim
a_claim_is_checked_before_the_code --offline`:

```
thread 'a_claim_is_checked_before_the_code' panicked at host/tests/claim.rs:321:5:
assertion `left == right` failed
  left: String("pairing_code_invalid")
 right: "validation_failed"
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out
```

The wrong code was looked up, found unknown, and refused with
`pairing_code_invalid` before validation ever ran — exactly the regression
the test is meant to catch.

**Green** — reverted `routes/pairing.rs` to the exact committed text
(confirmed via `git diff`, empty) and re-ran the same test:

```
test a_claim_is_checked_before_the_code ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out
```

### Item 2 — no test for "a wrong code counts against every live code, and only live codes"

Added `a_wrong_code_counts_against_every_live_code_only`. Timeline: codes A,
B, C created at T0; C is claimed (used) at T0; code D created at T0 (so A, B,
D all share expiry T0+10m); clock advances exactly 10 minutes, expiring A, B
and D (C is excluded from expiry checks entirely because it's used); codes E
and F are created after the advance (live, expiring at T0+20m); one wrong
claim (`"0000000000"`) is sent. Asserts `failed_attempts`: A=0 (expired),
B=0 (expired), C=0 (used), D=0 (expired), E=1 (live), F=1 (live) — every live
code is penalized once, and only live codes.

**Red** — temporarily narrowed the bulk `UPDATE`'s `WHERE` clause by adding
`AND id = (SELECT id FROM pairing_codes ORDER BY created_at DESC LIMIT 1)`.
Ran `cargo test -p markiro-host --test claim
a_wrong_code_counts_against_every_live_code_only --offline`:

```
thread 'a_wrong_code_counts_against_every_live_code_only' panicked at host/tests/claim.rs:260:5:
assertion `left == right` failed: F is live
  left: 0
 right: 1
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out
```

(E and F share the same `created_at` timestamp, created back-to-back with no
clock movement between them; SQLite's tie-break on the `ORDER BY created_at
DESC LIMIT 1` subquery happened to pick E, so only E was left incremented and
F's assertion failed. Either code failing is an equally valid red signal —
the point, that the narrowed query no longer penalizes every live code, is
proven regardless of which one the tie-break favored.)

**Green** — reverted `routes/pairing.rs` to the exact committed text
(`git diff` empty) and re-ran the full `claim.rs` suite:

```
running 8 tests
test a_code_expires_after_ten_minutes ... ok
test a_code_is_claimed_once ... ok
test a_device_in_the_network_pairs_with_a_code_typed_in_any_case ... ok
test a_claim_is_checked_before_the_code ... ok
test a_handheld_pairs_with_a_code ... ok
test five_wrong_codes_kill_every_live_code ... ok
test a_wrong_code_counts_against_every_live_code_only ... ok
test claims_are_limited_per_address_separately_from_logins ... ok
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### Item 3 — secrets scan additions (`no_secrets_in_logs.rs`)

- Module doc comment now names pairing codes and the TLS private key
  alongside the credentials it already listed.
- Added one refused claim (wrong code, `400`) right after the successful
  claim, so the `denied` audit path is exercised by this log scan too.
- Read `key_hash` from every row of `devices` and `code_hash` from every row
  of `pairing_codes` (before `pool.close()`, alongside the existing
  `password_phc` read) and added them all to the `secrets` vector.
- Added `format!("{key_der:?}")` (Rust's `Debug` dump of the raw key bytes)
  and the first 64 characters of `STANDARD.encode(&key_der)` as a separate
  needle from the full base64 string already checked — a PEM dump wraps at
  64 columns, so a line-wrapped leak could dodge a whole-string
  `log.contains` check while still surfacing as a contiguous 64-character
  match.

No red/green verification was requested for this item (it only adds
detection surface to an already-passing scan); ran it directly outside the
sandbox: `cargo test -p markiro-host --test no_secrets_in_logs --offline` →
`test secrets_never_reach_the_process_log ... ok` (1/1).

### Item 4 — row-count assertions

- `a_code_is_claimed_once`: now asserts `claim_audit(&app).await.len() == 2`
  before indexing `[1]` (previously indexed directly).
- `five_wrong_codes_kill_every_live_code`: now asserts rows `[1]` through
  `[4]` are each `denied("unknown_code", None)` too, in addition to the
  existing `[0]` and `[5]` checks (all five wrong-code attempts use
  `"0000000000"` or the too-short-when-normalized `"hello"`, neither of
  which ever matches the real code, so all five are `unknown_code`).

Plain additions verified by the full suite runs above; no separate red/green
needed since they only add assertions to already-deterministic outcomes.

### Verification commands and results (fix round 1)

| Command                                                                                                                            | Result                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cargo test -p markiro-host --test claim --offline` (after item 4 + item 1 rewrite + item 2 addition, before red checks)           | PASS — 8/8                                                             |
| `cargo test -p markiro-host --test claim a_claim_is_checked_before_the_code --offline` (item 1, regression injected)               | FAIL — red, as shown above                                             |
| `cargo test -p markiro-host --test claim a_claim_is_checked_before_the_code --offline` (item 1, reverted)                          | PASS                                                                   |
| `cargo test -p markiro-host --test claim a_wrong_code_counts_against_every_live_code_only --offline` (item 2, regression injected) | FAIL — red, as shown above                                             |
| `cargo test -p markiro-host --test claim --offline` (item 2, reverted, full file)                                                  | PASS — 8/8                                                             |
| `cargo test -p markiro-host --test no_secrets_in_logs --offline` (outside sandbox)                                                 | PASS — 1/1                                                             |
| `cargo test -p markiro-host --offline` (full crate, outside sandbox)                                                               | PASS — 91/91 (lib 16 + main 3 + 9 integration binaries), zero warnings |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` then `-- --check`                                                     | No further reformatting needed; check PASS                             |
| `git diff --check` / `git diff --cached --check`                                                                                   | PASS, no whitespace errors                                             |

`apps/standalone/host/src/routes/pairing.rs`: confirmed via `git diff`
(empty) to be byte-identical to the Task 3 commit both after item 1's revert
and after item 2's revert, and again after the final commit.

### Deviations

None beyond what the coordinator's message itself specified as resolution
paths (e.g., which exact `WHERE`-narrowing trick to use for item 2's red
check — the "add an `id =` subquery" option was used rather than deleting
the `WHERE` clause outright, since deleting it would leave a dangling
`.bind(&at)` with no `?` placeholder and fail at the SQL-binding level rather
than demonstrating the intended scoping bug).

### Concerns

None. No production bug was found — the endpoint's behavior was already
correct; the four items were genuine test-coverage gaps, all closed. Working
tree is clean after the commit.

## Follow-up — second review pass (tests only)

Commit: `500994d71` on `claude/autonomous-desktop-station-9e6f13`
(`test(standalone): review follow-up — used code in the counter test, refused claim with a real code`)

The re-review found the round-1 fixes correct but flagged two remaining
test-only gaps. **No production code changes were made** — `routes/pairing.rs`
is byte-identical to before (confirmed via `git diff`, empty, both after the
item 1 revert and after the final commit).

### Item 1 — `a_wrong_code_counts_against_every_live_code_only` never exercised "used but not expired" on its own

C was created at T0 and claimed at T0; by the time the wrong claim runs at
T0+10m, C is _both_ used and expired, so the bulk counter query's
`used_at IS NULL` condition was never the sole reason anything was excluded —
`expires_at > ?` alone would have excluded C too. Confirmed exactly as the
coordinator described: deleting `used_at IS NULL` from the counter `UPDATE`
left all 8 `claim.rs` tests green before this fix.

Fix: added code G, created right after the clock advance and claimed
successfully in the same instant — so G is used but its expiry (set at
creation, one code-lifetime past the advance) is still far in the future.
Added `assert_eq!(failed_attempts(&app, &g_id).await, 0, "G is used");`.
Corrected the stale comment at the clock-advance site, which previously
implied `used_at` bypasses expiry ("excluded from expiry entirely because it
is already used") — it now says C is excluded by both conditions at once,
and explains G's role in isolating `used_at IS NULL`. C's own assertion and
message ("C is used") were left unchanged, as requested.

Claim-count check for the rate limiter (10/minute from one address, per the
coordinator's instruction to count them): this test now calls `claim()`
exactly 3 times — claiming C, claiming G, and the final wrong claim — all
from `LAN`, well under the limit. (Creating pairing codes via
`POST /v1/office/pairing-codes` does not touch `claim_limiter` at all.)

**Red** — temporarily changed the bulk `UPDATE`'s `WHERE` clause from
`"WHERE used_at IS NULL AND expires_at > ?"` to `"WHERE expires_at > ?"`.
Ran `cargo test -p markiro-host --test claim
a_wrong_code_counts_against_every_live_code_only --offline`:

```
thread 'a_wrong_code_counts_against_every_live_code_only' panicked at host/tests/claim.rs:265:5:
assertion `left == right` failed: G is used
  left: 1
 right: 0
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 7 filtered out
```

G — used but not expired — was the only code the narrowed query still
touched; every other assertion (A, B, C, D, E, F) still held under this
regression, confirming the coordinator's diagnosis that only G's assertion
closes this specific gap.

**Green** — reverted `routes/pairing.rs` to the exact committed text
(`git diff` empty) and re-ran the full `claim.rs` suite:

```
running 8 tests
test a_handheld_pairs_with_a_code ... ok
test a_code_expires_after_ten_minutes ... ok
test a_claim_is_checked_before_the_code ... ok
test a_device_in_the_network_pairs_with_a_code_typed_in_any_case ... ok
test five_wrong_codes_kill_every_live_code ... ok
test a_code_is_claimed_once ... ok
test a_wrong_code_counts_against_every_live_code_only ... ok
test claims_are_limited_per_address_separately_from_logins ... ok
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### Item 2 — the refused claim in `no_secrets_in_logs.rs` used an untracked value

The refused claim sent `"0000000000"`, which is never added to the
`secrets` vector and has no corresponding stored `code_hash` — so a leak of
that specific typed value on the denial path would have gone undetected by
this scan.

Fix: the refused claim now reuses the real `pairing_code` (already claimed
successfully a few lines above), which produces a `code_used` refusal
instead of an `unknown_code` one. `pairing_code` was already a `secrets`
needle (added in fix round 1); `serde_json::json!`'s leaf rule only borrows
its argument (`to_value(&$other)`), so reusing the `String` here a second
time — after its first use in the successful-claim request and before its
final move into the `secrets` vector — does not conflict with either. Also
added an assertion on the parsed response body, `refused_claim["error"]["code"]
== "pairing_code_invalid"`, to pin down that this specific refusal path
(code-used) is the one actually exercised, not some other rejection. Did not
additionally keep `"0000000000"` as a second refused attempt — the
coordinator offered this as optional, and the minimal fix already closes the
detection gap without adding an extra needle/hash pair for a value that maps
to no code the host would ever recognize.

No red run was requested for this item (it's a detection-only strengthening
of an already-passing scan, not a regression that has an obvious "narrow
this rule" counter-edit). Ran directly outside the sandbox:

```
cargo test -p markiro-host --test no_secrets_in_logs --offline
test secrets_never_reach_the_process_log ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

### Verification commands and results (follow-up)

| Command                                                                                                                       | Result                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `cargo test -p markiro-host --test claim a_wrong_code_counts_against_every_live_code_only --offline` (baseline, before red)   | PASS                                       |
| same, with `used_at IS NULL` removed from the counter `UPDATE`                                                                | FAIL — red, as shown above                 |
| same, reverted                                                                                                                | PASS                                       |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test claim --offline`                                | PASS — 8/8                                 |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test no_secrets_in_logs --offline` (outside sandbox) | PASS — 1/1                                 |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --offline` (full crate, outside sandbox)               | PASS — 91/91, zero warnings                |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all` then `-- --check`                                                | No further reformatting needed; check PASS |
| `git diff --check` / `git diff --cached --check`                                                                              | PASS, no whitespace errors                 |

### Deviations

None. Both fixes match the coordinator's description exactly; the only
judgment call was leaving out the optional "also keep the wrong code and its
hash" extension in item 2, as explicitly offered as a preference rather than
a requirement.

### Concerns

None. No production bug was found in this pass either — both items were
test-coverage gaps in the round-1 additions themselves. Working tree is
clean after the commit.
