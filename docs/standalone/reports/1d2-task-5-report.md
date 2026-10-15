# Plan 1d2, Task 5 report: badges and the badge salt

**Status:** DONE (no deviations from the brief, no blockers)

**Commit:** `b40986e56` feat(standalone): бейджи операторов и соль бейджей на хосте
(one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer, verified with `git log -1 --format=%B`; branch `claude/autonomous-desktop-station-9e6f13`, parent 3e6688385, working tree clean afterwards)

## What was implemented

- `POST /v1/office/operators/{id}/badges` with `{ badgePhc, label? }` returns `BadgeInfo` (no hash). It requires the site's badge salt and exactly `BADGE_ITERATIONS` (100 000) iterations. The partial unique index violation answers `conflict` with `constraint: badge`. An unknown operator gives `not_found`, checked after the body. It takes one revision, writes an `operator_badge.create` audit row and does not touch the operator's `rev`.
- `DELETE /v1/office/operators/{id}/badges/{badge_id}` sets `revoked_at`, takes a new revision, writes the `operator_badges` tombstone through `feed::remove` and audits `operator_badge.revoke`. It answers 204. A second revoke is 204 with no revision, no row write and no audit row. A badge is looked up only under its own operator: another operator's or an unknown badge gives `not_found`.
- `GET /v1/office/badge-salt` returns `{ badgeSalt }` (the site's 16-byte salt, standard base64 with padding). It is administrators only, reads included.
- `secrets::BADGE_ITERATIONS = 100_000` and `Phc::salt()`; `validate::badge_label` (optional text, at most 100 characters) and `validate::badge_phc`; `actions::OPERATOR_BADGE_CREATE` and `OPERATOR_BADGE_REVOKE`; `proto::BadgeCreate` (`deny_unknown_fields`) and `proto::BadgeSalt`, both with `Secret` fields, so `Debug` never prints them; the three routes in `server.rs`.
- `no_secrets_in_logs.rs` now walks the operator and badge flow (create operator with PIN, read the salt, add a badge, fetch the feed that carries both hashes, revoke) and searches the process log for the PIN hash, its digest, the badge hash, the badge digest and (already present) the badge salt in all encodings.
- Fixtures `badge-create.json` and `badge-salt.json`, parsed by the `proto` test `badge_fixtures_round_trip_without_leaking`.
- Docs: new "Operators and badges" section in `apps/standalone/AGENTS.md`; spec §4.3 (badge hash rules, revoke) and §4.5 (badge fixtures).

## TDD evidence

RED (before any implementation; tests written first, exactly as in the brief):

| Command                                                                                         | Result                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test badges --offline` | `test result: FAILED. 0 passed; 7 failed`. Every test panics at `host/tests/badges.rs:16:5` with `{"error":{"code":"not_found","message":"no route for GET /v1/office/badge-salt"}}`, `left: 404`, `right: 200`. |
| `cargo test ... -p markiro-host --lib validate --offline`                                       | does not compile: `error[E0425]: cannot find function `badge_phc` in this scope` (x2) and `cannot find function `badge_label`` (x3), all in `host/src/validate.rs`.                                              |
| `cargo test ... -p markiro-host --test no_secrets_in_logs --offline` (outside sandbox)          | `FAILED`: ``called `Option::unwrap()` on a `None` value`` at `no_secrets_in_logs.rs:226:42`, the `badge_salt["badgeSalt"]` line.                                                                                 |
| `cargo test ... -p markiro-proto --test fixtures --offline`                                     | does not compile: `error[E0432]: unresolved imports `markiro_proto::BadgeCreate`, `markiro_proto::BadgeSalt``.                                                                                                   |

GREEN (after the Step 3 implementation):

| Command                                                                     | Result                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `... -p markiro-host --test badges --offline`                               | `ok. 7 passed; 0 failed`                                        |
| `... -p markiro-host --lib --offline`                                       | `ok. 25 passed; 0 failed` (23 plus the 2 new `validate::tests`) |
| `... -p markiro-host --test no_secrets_in_logs --offline` (outside sandbox) | `ok. 1 passed; 0 failed`                                        |
| `... -p markiro-proto --test fixtures --offline`                            | `ok. 25 passed; 0 failed`                                       |

These are the counts the brief expected (7, 25, 1, 25).

## Extra check: the no-secrets test can actually fail

A test that cannot fail proves nothing, so I temporarily injected a `tracing::info!` leak into `routes/operators.rs` (from a backup, one mutation at a time), ran `no_secrets_in_logs` outside the sandbox, then restored the file:

- badge hash logged in `create_badge`: test FAILED (`no_secrets_in_logs.rs:366:9`, "the process log contains a secret")
- badge salt (base64) logged in `badge_salt`: FAILED, same assertion
- PIN hash logged in `create_operator`: FAILED, same assertion

The file was restored byte-identical (`diff -q` against the backup), `grep -rn leak apps/standalone/host/src` finds nothing, and `badges` was re-run green afterwards. Nothing from the mutations was committed.

## Verification commands (all after the last code edit; nothing changed after them except the commit)

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: exit 0.
- `node_modules/.bin/prettier --check` on `badge-create.json`, `badge-salt.json`, `apps/standalone/AGENTS.md` and the spec: "All matched files use Prettier code style!"
- `git diff --check`: exit 0. `git diff --cached --check` (covers the new untracked files once staged): exit 0.
- `cargo check ... -p markiro-host -p markiro-proto --all-targets --offline`: exit 0, 0 warnings.
- `cargo check ... --workspace --all-targets --offline`: exit 0, 0 warnings.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox, `apps/standalone/dist` present): exit 0. Summed over every `test result:` line, 271 passed, 0 failed, 0 ignored; 0 compiler warnings in the output. This includes the Tauri crate's suites (`ipc`, `connection`, `claim`, `device`, `line`, `local_db`, ...), which I did not change.
- Mechanical transcription check: I extracted every "replace with" and "Create" code block from the brief and confirmed each is a verbatim substring of a changed file: 25 of 25 real blocks match. The checker also flagged the old import block of `fixtures.rs` as "missing", which is a false positive of my script: that block is the text that was replaced, so it is correctly gone.
- Unicode check: `grep -n '\\u0'` finds no literal `\uXXXX` in any file I touched (the only hits in the tree are intentional JSON escapes in the untouched `pairing-codes.json`); the Cyrillic in the docs and tests is real UTF-8 (`file` reports UTF-8).
- Claims the new docs repeat, checked in current source rather than taken from the brief: `hashBadgeWithSalt` in `apps/api/src/lib/badge-salt.ts` uses `PHC_ITERATIONS` (`packages/domain/src/crypto/phc.ts`: 100_000) with the salt; `verifyBadge` in `apps/station/src/lib/crypto.ts` verifies with the salt and iterations read from the hash itself.
- `cargo clippy` (aid only; CI does not run it): only pre-existing `type_complexity` warnings in `host/tests/support/app.rs:295` and `host/tests/device_line.rs:36`. None in code I touched. Left alone.

Not run: any Zod/Vitest suite (the Zod schemas for the new fixtures are plan 1d3 by the plan; no TS file changed), Windows-only checks, and any browser or hardware check. `graphify update .` was skipped because `graphify-out/graph.json` does not exist in this worktree.

## Files changed (13, all staged by explicit path)

Created:

- `apps/standalone/host/tests/badges.rs`
- `apps/standalone/proto/fixtures/badge-create.json`
- `apps/standalone/proto/fixtures/badge-salt.json`

Modified:

- `apps/standalone/host/src/secrets.rs`, `validate.rs`, `audit.rs`, `server.rs`
- `apps/standalone/host/src/routes/operators.rs`
- `apps/standalone/host/tests/no_secrets_in_logs.rs`
- `apps/standalone/proto/src/lib.rs`, `apps/standalone/proto/tests/fixtures.rs`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Nothing under `apps/station` or `apps/standalone/src-tauri` changed. Diffstat: 760 insertions, 20 deletions.

## Deviations

None. All 19 anchored edits (7 in Step 1 items 4-10, 9 in Step 3, 3 in Step 5) matched byte for byte, exactly once each, and the code, SQL, wire shapes, test cases and values are the brief's. Process note only: I applied the edits with a small anchor-exact script (fails unless the anchor occurs exactly once) instead of the Edit tool, so Cyrillic stays real UTF-8.

## Self-review findings

- Names and signatures match the brief's Interfaces list (`BADGE_ITERATIONS`, `Phc::salt`, `badge_label`, `badge_phc`, the two `actions`, `BadgeCreate`, `BadgeSalt`, the three routes).
- Against `apps/standalone/AGENTS.md` "Writes": both writers use `begin_write`, one `next_revision`, `commit_with_revision` and `require_admin_in`; the salt is read through the open transaction, and the pool is not touched while a write transaction is open; the no-op revoke returns before `next_revision`. `badge_salt` is a plain read and acquires a pooled connection with no transaction open.
- No hash, salt or code appears in a response (`BadgeInfo` only), in `audit.details` (`operatorId`, `label`) or in an error message (the `badgePhc` validation message does not echo the input).
- No overbuilding: no new crates, no extra helpers beyond the brief.
- Tests assert behaviour and exact values (full audit rows with actor, target and details, exact feed items and revisions, the tombstone, the 204 no-op leaving revision 4 and one audit row, technologist denial on all three routes).
- Output is pristine: 0 warnings in `cargo check` and in the workspace test build.

## Concerns

None blocking. Minor observations:

1. `create_badge` validates `badgePhc` after `begin_write`, because it needs the site salt; a request with a bad hash therefore takes the write lock for one trivial read before being refused. The brief prescribes this order and the cost is negligible; I kept it verbatim.
2. The `not_found` ("the host is not initialized") branch of `site_salt` is defensive and unreachable over HTTP: the wizard writes the first administrator and `site.badge_salt` in one transaction (`routes/bootstrap.rs`), so no office session can exist without a salt. It has no test for that reason.
3. The Tauri `host_request` allow-list already covers `/v1/office/…` with `DELETE`, so no shell change is needed for the new routes. The Zod schema for `badge-create.json` and `badge-salt.json` is left to plan 1d3.

---

# Fix round 1

**Status:** DONE. **Commit:** `b0ce2be75` (full `b0ce2be758a2d8f82bbc649ad4354827148bb473`), on top of `b40986e56`, a new commit (no amend, no stash): `fix(standalone): ревью задачи 5 плана 1d2 — один бейдж — одна каноническая строка, тесты отказов и журнала`. One `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, verified with `git log -1 --format=%B`. Six files, 163 insertions, 11 deletions; nothing under `apps/station`.

Files: `apps/standalone/host/src/secrets.rs`, `host/src/validate.rs`, `host/tests/badges.rs`, `host/tests/no_secrets_in_logs.rs`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`. `routes/operators.rs` is not changed: `validate::badge_phc` inherits the fix from `parse_phc`.

## Item 1: a zero-padded iteration count bypassed one-card-one-operator

**Confirmed before fixing.** `Number("0100000")` is `100000` in Node, and both the domain `parsePhc` (`packages/domain/src/crypto/phc.ts:55`) and the station's `verifySecret` (`apps/station/src/lib/crypto.ts:61`) use `Number(...)`, so a station accepts the padded copy of a badge while the unique index (whole text) treats it as another badge. No fixture anywhere has a leading zero in a count (`grep 'pbkdf2$sha256$0'` finds nothing), and the only PHC writer on the host is `hash_password_with_salt` (`format!("...{iterations}...")` on a `u32`), so no stored password hash changes.

**Fix (at the source).** `secrets::parse_phc` now refuses an iteration field that starts with `'0'` (`if iterations.starts_with('0') || !iterations.bytes().all(|byte| byte.is_ascii_digit())`). Its doc comment now reads: "…which must be plain ASCII digits without a leading zero, within `MIN_ITERATIONS..=MAX_ITERATIONS`: a padded `0100000` would be a second spelling of `100000`, which the unique index over a badge's text cannot see."

**Tests, red first.** Per-entry picture from a throwaway probe test (printed only the iteration field and the verdict, deleted before the commit; `git status` confirmed it is gone):

| iteration field              | before the fix         | after the fix      |
| ---------------------------- | ---------------------- | ------------------ |
| `100000` (control)           | accepted as 100000     | accepted as 100000 |
| `10000` (control)            | accepted as 10000      | accepted as 10000  |
| `0100000`                    | **accepted as 100000** | rejected           |
| `000000100000`               | **accepted as 100000** | rejected           |
| `4294967296` (overflows u32) | rejected               | rejected           |
| empty field                  | rejected               | rejected           |

The last two were already rejected (through `u32::parse` failing), so they are regression cover for the Task 4 review gap, not red tests. The other two are the real red.

RED, against the unfixed code:

- `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --lib malformed_verifiers_never_match --offline`: `FAILED`, panicked at `host/src/secrets.rs:256:13` with the message `pbkdf2$sha256$0100000$<salt>$<digest>` (the first padded entry parsed; hashes abbreviated here, they are repo test vectors). Line 256 is the `assert!(parse_phc(bad).is_none(), "{bad}")` line in the tree of the RED run, before the fix; in the committed file it is line 260, because the fix added four lines above it.
- `... -p markiro-host --lib a_zero_padded_iteration_count --offline`: `FAILED`, panicked at `host/src/validate.rs:335:28`: `a validation error: ()` (`expect_err` on `Ok(())`: the padded badge hash was accepted).
- `... -p markiro-host --test badges a_zero_padded --offline`: `FAILED`, panicked at `host/tests/badges.rs:252:5`: `left: (200, Null, Null)`, `right: (400, String("validation_failed"), String("badgePhc"))`. The response body was a created badge, i.e. a second badge for the same card was stored. (Whole `badges` binary on the unfixed code: 7 passed, 1 failed, the failing one being this new test.)

GREEN, after the fix: the same three commands pass (`ok. 1 passed` each), and the probe shows the "after" column above.

New tests: four fields in the `malformed_verifiers_never_match` table (`0100000`, `000000100000`, `4294967296`, the empty field); `validate::tests::a_zero_padded_iteration_count_is_a_second_spelling_and_is_refused` (the canonical string is accepted, and both `0100000` and `000000100000` with the same salt and digest are refused with `field = badgePhc`); route test `a_zero_padded_copy_of_an_active_badge_is_refused_not_stored_twice` (an ACTIVE badge exists, its copy with `$0100000$` answers 400 `validation_failed` with `details.field = badgePhc`, the host revision is unchanged, the operators list is identical before and after, the operator still has exactly the first badge, and there is one `operator_badge.create` audit row).

**Docs.** `apps/standalone/AGENTS.md` ("Operators and badges") and spec §4.3 each gained a clause saying the one-code-one-string guarantee is enforced by `parse_phc` refusing a leading zero (`0100000` is no second spelling of `100000`). Only the affected lines were re-wrapped; all new lines are at most 77 columns (AGENTS.md) or the existing width (spec).

## Item 2: refusal tests now prove that nothing changed (`tests/badges.rs`)

- After the four refused hashes and the over-long label: `host_revision` and the total `audit_log` row count (a new `audit_rows` helper counting every action, so a row of any action would show) are equal to their values before.
- After the cross-operator DELETE and the unknown-operator POST: `host_revision` is unchanged, the owner's badge list is still exactly the badge as created, and `revokedAt` is `null`.

The new assertions were red-tested by mutation, temporarily in `create_badge` and `revoke_badge` and restored afterwards (baseline `badges`: 8 passed):

| Mutation (a refusal that still changes something)                                           | Result                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m2_revision`: refused hash commits a revision bump                                         | 2 failed: `a_badge_hash_must_carry_...` at `badges.rs:164` (revision) and the zero-padded route test at `badges.rs:266` (revision)                             |
| `m2_audit`: refused hash writes a `denied` audit row under another action name, no revision | 1 failed: `a_badge_hash_must_carry_...` at `badges.rs:165` (total audit rows); the old per-action `audit_trail` check cannot see this row                      |
| `m2_revoke`: cross-operator DELETE revokes the badge but still answers 404                  | 1 failed: `a_badge_is_found_only_under_its_own_operator` at `badges.rs:374` (revision); the old 404 and empty revoke trail assertions pass under this mutation |

## Item 3: the no-secrets flow now covers refusals, a conflict and a PIN change (`tests/no_secrets_in_logs.rs`)

Three steps added to the same flow, between adding the badge and fetching the feed, each with its status and error shape asserted (so the mutation checks below cannot pass by hitting a different path): a badge with another salt (`400`, `validation_failed`, `field = badgePhc`); the same badge again (`409`, `conflict`, `constraint = badge`); `PUT /v1/office/operators/{id}` with a new `pinPhc` and the operator's current `rev` (`200`). New needles: the wrong-salt hash and its digest, the new PIN hash and its digest (the duplicate reuses `badge_phc`, which was already a needle).

On the unfixed code the extended flow passes (exit 0): the steps pin behaviour that already existed.

Mutation checks (`cargo test ... --test no_secrets_in_logs --offline -- --nocapture`, outside the sandbox; each mutation adds a `tracing::warn!` on that one path only, from a backup, then restores; the request's whole hash, and separately only its digest, because the generic `pbkdf2$` needle cannot see a digest-only leak):

| Path       | Mutation                                                     | Result                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline   | none                                                         | `ok. 1 passed`                                                                                                                                                                                                    |
| wrong salt | `refuse_full`: log the request's hash on refusal             | FAILED at `no_secrets_in_logs.rs:420:9`, "the process log contains a secret"                                                                                                                                      |
| wrong salt | `refuse_digest`: log only its digest                         | FAILED at the same assertion (caught by the new digest needle)                                                                                                                                                    |
| duplicate  | `dup_full`: log the request's hash in the `badge_taken` path | FAILED at the same assertion                                                                                                                                                                                      |
| duplicate  | `dup_digest`: log only the digest                            | FAILED at the same assertion                                                                                                                                                                                      |
| duplicate  | `dup_rawerr`: log the raw sqlx error                         | **passes**: the message is `error returned from database: (code: 2067) UNIQUE constraint failed: operator_badges.badge_phc`, it names the column and never the value, so SQLite's error text cannot leak the hash |
| PIN change | `pin_full`: log the new `pinPhc` in `update_operator`        | FAILED at the same assertion                                                                                                                                                                                      |
| PIN change | `pin_digest`: log only its digest                            | FAILED at the same assertion (caught by the new digest needle)                                                                                                                                                    |

Every failing run was a test failure, not a compile error (`could not compile` count 0 in each saved output; the only `error:` line is cargo's "test failed" footer). Line 420 is `assert!(!log.contains(&secret), "the process log contains a secret")`. After each batch `routes/operators.rs` was restored and `diff -q` against the backup printed nothing (byte-identical); `grep -rn leak apps/standalone/host/src` finds nothing.

## Checks (all on the final tree; the commit contains exactly this tree)

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: exit 0.
- `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`: exit 0, 0 warnings.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox): exit 0, 273 passed, 0 failed, 0 ignored, 0 warnings in the output (271 before this round plus the two new tests: host lib 25 to 26, `badges` 7 to 8; the extended `no_secrets_in_logs` still 1).
- `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: clean (no JSON changed this round).
- `git diff --check` and `git diff --cached --check`: exit 0. No literal `\uXXXX` in the touched files.
- After the commit: `git status --short` is empty.

## Deviations and notes

- No deviation from the coordinator's items. Additions that are evidence only and not in the commit: the per-entry probe, the item 2 mutations, the digest-only and raw-error mutations for item 3.
- "Audit-row count" is implemented as the total number of `audit_log` rows (any action), which subsumes the per-action check that was already there.
- The validate unit test includes a positive control (the canonical string with the same salt and digest passes), so the test shows padding is the only difference.

## Self-review

- After this fix the map from a badge code to its accepted string has no remaining freedom: the count must be the decimal `100000` (digits only, no leading zero, no sign); the salt must be the canonical base64 of exactly the site's 16 bytes; the digest the canonical base64 of 32 bytes; the two literals and the field count are fixed. So "one badge code always gives one string" is now true and enforced, where before this round it was not.
- The change also tightens PIN and office-password verifiers (they share `parse_phc`); the host writes only canonical counts and nothing in the repo carries a padded one, and the branch is unreleased, so no stored data or migration is affected.

## Concerns

None blocking. One thing to know: the TypeScript `parsePhc` in the domain and the station's `verifySecret` still read a padded count leniently (`Number(...)`); this round closes the hole at the host, the only writer of badge hashes into the feed, so a padded string cannot reach a station from this host. Making the TS readers strict as well would be a separate change in `packages/domain` and `apps/station`, which this round does not touch.
