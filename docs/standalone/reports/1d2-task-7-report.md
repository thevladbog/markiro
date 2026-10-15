# Task 7 report: connection codes, `id`, `createdAt` and `replaces`

**Status:** DONE (with two low-severity notes under "Concerns").
**Commit:** `9779b0f4d feat(standalone): новый код подключения гасит прежний, ответ кода с id и createdAt`
(baseline `dc8355920`; message ends with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, checked with `git log -1 --format=%B`).
Working tree after the commit: clean. `apps/station` and `src-tauri` are untouched.

## What was implemented

- `host/src/error.rs`: `impl OptionalFromRequest<S> for ApiJson<T>`. No `Content-Type` header gives `None`; a JSON body is parsed strictly; every rejection (wrong content type, empty or invalid JSON, unknown field) becomes `validation_failed` through `ApiError::malformed`.
- `proto/src/lib.rs`: `PairingCode { id, code, created_at, expires_at, payload }` and the new `PairingCodeRequest { replaces: Option<String> }` (`deny_unknown_fields`, `skip_serializing_if = "Option::is_none"`).
- `host/src/routes/pairing.rs`, `create_code`: takes `Option<ApiJson<PairingCodeRequest>>`. Inside the write transaction (after `require_admin_in`) one `UPDATE pairing_codes SET expires_at = <now> WHERE id = ? AND created_by = <this office user> AND used_at IS NULL AND expires_at > <now> AND failed_attempts < 5` ends a live code of the same user. `rows_affected() == 1` decides `replaced`. The new code's `pairing_code.create` audit row carries `{ expiresAt, replaces }` only when a code was really ended, otherwise `{ expiresAt }`. The answer now carries `id` and `createdAt`.
- `host/src/pairing_code.rs`: new unit test `the_shared_pairing_code_fixture_matches_the_host` reads `proto/fixtures/pairing-code.json` and checks the host's payload builder and `CODE_LIFETIME` against it (the item deferred from plan 1c3).
- Fixtures: `pairing-code.json` rewritten (adds `id`, `createdAt`); new `pairing-code-request.json`.
- Webview: `pairingCodeSchema` in `src/host/protocol.ts` gains `id: z.uuid()` and `createdAt: z.iso.datetime()`; three `PairingCode` literals in `test/devices-page.test.tsx` gained `id`/`createdAt`. No screen code changed (plan 1d3).
- Docs: `apps/standalone/AGENTS.md` ("Local pairing trust") and spec `2026-09-26-standalone-01-foundation-design.md` §4.5 and §4.7.

All 18 edit anchors matched exactly once (my edit helper aborts if a fragment occurs 0 or 2+ times). No anchor mismatch, so no NEEDS_CONTEXT.

## TDD evidence

### RED (after Step 1, before any implementation)

`cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test pairing_codes --offline` -> exit 101, 2 passed / 4 failed (pairing codes and UUIDs redacted; they are throwaway values from a temp database):

```
running 6 tests
test an_administrator_gets_a_one_time_code_with_the_pairing_payload ... FAILED
test a_replaces_naming_no_live_code_of_this_administrator_is_ignored ... FAILED
test every_request_gets_a_new_code ... ok
test a_code_request_body_is_optional_but_strict ... FAILED
test a_new_code_replaces_the_administrators_previous_one ... FAILED
test only_administrators_create_codes ... ok
...
pairing_codes.rs:83:5:  left: (Null, Null)   right: (String("<uuid>"), String("2026-09-21T14:13:20Z"))
pairing_codes.rs:195:5: the answer names the code: {"code":"<redacted>","expiresAt":"2026-09-21T14:23:20Z","payload":"markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f=abab...ab&c=<redacted>"}   (x2)
pairing_codes.rs:317:5:  left: (200, Null)   right: (400, String("validation_failed"))
test result: FAILED. 2 passed; 4 failed
```

`... -p markiro-host --lib pairing_code --offline` -> exit 0, 3 passed (the new fixture test passes at once, as the brief predicts: it pins what the host already answers).

`... -p markiro-proto --test fixtures --offline` -> exit 101, does not compile:

```
error[E0432]: unresolved import `markiro_proto::PairingCodeRequest`
error[E0609]: no field `created_at` on type `PairingCode`
error[E0609]: no field `id` on type `PairingCode`
```

`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/devices-page.test.tsx test/pairing-code.test.ts` -> exit 1, `1 failed | 89 passed (90)`: `response fixture pairing-code.json > parses without losing a field`; the diff shows `createdAt` and `id` missing from the parsed value.

`pnpm ... --filter @markiro/standalone typecheck` -> exit 2:

```
test/devices-page.test.tsx(53,5):  error TS2353: ... 'id' does not exist in type '{ code: string; expiresAt: string; payload: string; }'.
test/devices-page.test.tsx(222,7): error TS2353: (same)
test/devices-page.test.tsx(384,7): error TS2353: (same)
test/devices-page.test.tsx(386,33): error TS2339: Property 'createdAt' does not exist on type ...
```

Every RED matches the brief's "Expected" text.

### GREEN (after Step 3)

- `cargo test ... -p markiro-host --test pairing_codes --test claim --offline` -> exit 0. `claim.rs`: 8 passed; `pairing_codes.rs`: 6 passed.
- `cargo test ... -p markiro-proto --test fixtures --offline` -> exit 0, 27 passed (includes `pairing_code_fixture_round_trips_without_leaking` and `a_pairing_code_request_is_optional_and_strict`).
- `vitest run test/protocol.test.ts test/devices-page.test.tsx test/pairing-code.test.ts` -> exit 0, `Test Files 3 passed (3)`, `Tests 90 passed (90)` (48 + 17 + 25).
- `pnpm ... typecheck` -> exit 0, no output beyond `tsc -p tsconfig.json --noEmit`.

## Verification commands (all run on the committed content)

| Command                                                                                                               | Result                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                               | exit 0, clean                                                                                                              |
| `node_modules/.bin/prettier --check` on the 2 fixtures, `protocol.ts`, `devices-page.test.tsx`, `AGENTS.md`, the spec | exit 0, "All matched files use Prettier code style"                                                                        |
| `git diff --check`; `git diff --cached --check` (the new file is untracked, so the second covers it)                  | exit 0, clean                                                                                                              |
| `cargo check ... -p markiro-host -p markiro-proto --all-targets --offline`                                            | exit 0, 0 warnings                                                                                                         |
| `pnpm ... --filter @markiro/standalone lint`                                                                          | exit 0, no output                                                                                                          |
| `pnpm ... --filter @markiro/standalone test`                                                                          | exit 0, 29 files, 531 tests (count unchanged, as predicted)                                                                |
| `vitest run --reporter=verbose` on the 3 touched files                                                                | exit 0, 90 passed; no stderr, no "warning", no "Error" lines                                                               |
| `cargo check ... --workspace --all-targets --offline`                                                                 | exit 0, 0 warnings (the shell crate `markiro-standalone` compiles against the changed `PairingCode`)                       |
| `cargo test ... --workspace --offline` (**outside the sandbox**, as instructed; the loopback-binding tests need it)   | exit 0; 35 result lines, 287 tests passed, 0 failed, 0 ignored, 0 compiler warnings; no pairing-code-like token in the log |
| `grep -n '\\u0'` over every edited file                                                                               | no matches (Cyrillic is real UTF-8)                                                                                        |

Not run: `pnpm ... build` (brief does not list it for this task; no build-relevant change beyond the Zod schema, which typecheck and Vitest cover). Nothing on Windows, no hardware, no live LAN/browser check; this task's surface is the host route, proto, one Zod schema and docs.

## Files changed (12; +292 / -13)

Modified: `apps/standalone/AGENTS.md`, `host/src/error.rs`, `host/src/pairing_code.rs`, `host/src/routes/pairing.rs`, `host/tests/pairing_codes.rs`, `proto/src/lib.rs`, `proto/tests/fixtures.rs`, `proto/fixtures/pairing-code.json`, `src/host/protocol.ts`, `test/devices-page.test.tsx`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`.
Created: `apps/standalone/proto/fixtures/pairing-code-request.json`.

## Deviations

None from the brief's code, SQL, wire shapes, tests or values (applied verbatim).

Process notes only:

- One zsh slip (`=====` separator) skipped the proto RED run in the first attempt; I re-ran it on its own. No effect on results.
- Everything ran inside the sandbox except `cargo test --workspace`, which ran outside it per the task's hard rule.

## Self-review findings

- Completeness: every item of Steps 1-6 done; no extra files; the staged set equalled the brief's `git add` list.
- I confirmed the claim the brief relies on: the plan 1c3 webview sends no body. `api.ts` passes `body ?? null`, `host_request` takes `Option<Value>`, and `host_client.rs` calls `.json()` (the only thing that sets `Content-Type`) only for `Some(body)`. So the webview reaches the host's `None` path and keeps working.
- Ran a throwaway test file (deleted, never staged or committed) for cases the brief's tests do not cover; all 3 passed:
  - an exhausted code (5 failed attempts) named in `replaces` is ignored and left untouched, and the audit row has no `replaces`;
  - a replaced code stops counting wrong guesses (its `failed_attempts` stays 0 while the new code's goes to 1), and its `expires_at` equals "now" exactly;
  - `{"replaces": null}` acts like no body; `Content-Type: text/plain` and an empty body with a JSON content type both answer 400 `validation_failed` and issue no code.
- A race of two "Новый код" requests naming the same `replaces` is safe: `BEGIN IMMEDIATE` serialises them, the second finds the code already ended, ignores `replaces` and issues another code. Same outcome as before this change (every request issues a code).
- No revision bump is needed (codes are not in the change feed), matching the existing `create_code`.
- Secrets: the audit `details` hold only the old code's UUID, never a code or hash.

## Concerns

1. **Coverage gap in the brief's tests (low).** The brief lists "exhausted" among the ignored `replaces` cases but its tests cover another user's, used, expired and unknown codes only; also no test pins the extractor's refusal paths (wrong content type, empty JSON body). Behaviour is correct (checked ad hoc, see above), but the committed suite would not catch a regression there. Adding the three scratch cases to `host/tests/pairing_codes.rs` is cheap if you want them; I did not, to keep the brief's tests verbatim.
2. **Version skew (low, plan-level, as specified).** `pairingCodeSchema` now requires `id` and `createdAt` and `PROTOCOL_VERSION` is not raised (the brief does not). A webview built from this commit against a host built before it would fail "Подключить устройство" with `invalid_response`. Older webviews against the new host are fine (Zod drops the extra keys). Host and app ship in one installer, so this only matters for a partly updated site.
3. **Note on test output.** The brief's failing-assertion messages print `{body}`, which contains a freshly generated code and payload; the RED run therefore showed throwaway codes from a temp database that no longer exists. I redacted them in this report and deleted the raw log. The same `{body}` pattern already exists in the older tests, so this is pre-existing style, not new.
