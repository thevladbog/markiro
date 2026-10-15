# Plan 1d2 — final-review fix wave 1 of 2: report

Scope: items A–L of `.superpowers/sdd/1d2-final-fix-1-brief.md` (production code with
its tests; wave 2 carries the remaining tests and docs and was not touched). Constraints:
`.superpowers/sdd/1d2-constraints.md`; item numbers: `.superpowers/sdd/1d2-minors.md`.
Worked in `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

**Commit:** `e1190290e` — `fix(standalone): итоговое ревью 1d2 (1/2) — коммит и уведомление
неразделимы, управляющие символы, смена линии будит потоки, Debug ленты без хешей`
(subject compared byte for byte with the brief; the message ends with exactly one
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line, checked with `git log -1 --format=%B`).
20 files, +1353/-164; explicit paths only; `Cargo.lock`, `apps/station` and `src-tauri` untouched.

**Status:** DONE. Every item is implemented, pinned by a test, and (A–E) has a recorded red and mutation run.

Raw logs of every run below are in `/tmp/claude-501/1d2fix1/*.log` (scratch, not committed).
No hash, PIN, key, token or pairing code is printed by any new test, and none is quoted here
(the E red run printed the public fixture strings; they are left out of this report).

## A. Commit and notification are one uncancellable unit (I-2, item 23)

**Changed**

- `host/src/db.rs`: new `commit_and_notify(tx: Transaction<'static, Sqlite>, notify: impl FnOnce() + Send + 'static) -> Result<(), sqlx::Error>`.
  One `tokio::spawn`ed task runs `tx.commit().await?` and, only on success, `notify()`; the caller awaits the `JoinHandle`.
  A `JoinError` (panic, or cancellation at runtime shutdown) becomes `sqlx::Error::WorkerCrashed`, whose message is fixed text;
  only `error.is_panic()` is logged, never the payload.
- `commit_with_revision` is now a thin wrapper: its closure does the old `send_if_modified` on a clone of the sender.
  `tokio::sync::watch::Sender` is `Clone` in the pinned tokio 1.53.1, so no `Arc` was needed and the parameter stays `&watch::Sender<i64>`.
  Signature change (mechanical, said as asked): `tx` narrowed from `Transaction<'_, Sqlite>` to `Transaction<'static, Sqlite>`
  (a spawned task needs `'static`). Every caller holds a `begin_write` transaction, which is `'static`, so **no call site changed**.
- `host/src/routes/devices.rs::revoke_device`: commits through `commit_and_notify` with the `revocations.send_modify` closure, so commit and bump cannot be separated.
  In the already-revoked (idempotent) branch it now also bumps `revocations` (no await after the decision, so no window there either).
- No drop guard anywhere (reason recorded in the doc comment and in `AGENTS.md`).
- Docs: `apps/standalone/AGENTS.md`, «Writes»: commit and notification are one uncancellable unit (`commit_and_notify`, `commit_with_revision`);
  a writer must not `.await` between commit and notify and must not add a drop guard for revisions; revocations use the same helper and a retry wakes again.

**Tests**

- `host/tests/commit.rs::a_commit_abandoned_in_flight_still_lands_and_still_wakes_the_streams`: a real write transaction (`begin_write`, `next_revision`, INSERT),
  `commit_with_revision` polled **exactly once** (`std::future::poll_fn`) and dropped, as hyper drops a handler. It asserts the first poll is `Pending`
  (the caller really left mid-commit), then that the row lands (bounded wait), then that `revisions.changed()` fires within 5 s with the right revision.
  I did not use `timeout(Duration::ZERO, …)`: tokio rounds a timer up to the next millisecond tick, so a zero timeout is not «poll once then drop»
  (the inner future can be polled again before the timer fires); polling once by hand is exact.
- `host/tests/commit.rs::the_notification_follows_a_successful_commit_only`: after a successful commit the notification has run and the row is there;
  a COMMIT SQLite refuses (deferred foreign key, `PRAGMA defer_foreign_keys = ON`) returns an error, does not notify, and stores nothing.
- `host/tests/commit.rs::a_panic_after_the_commit_is_reported_without_its_message`: a panicking `notify` yields `WorkerCrashed`, the text holds no panic payload, the commit had landed.
- `host/tests/changes_stream.rs::retrying_a_revocation_whose_wake_up_was_lost_ends_the_stream`: the row is revoked by SQL (nobody announced it), the stream stays open
  (no frame in 300 ms), the administrator's `POST …/revoke` finds it revoked, writes no audit row, wakes the streams once more, and the stream ends within 5 s.

**Red (unfixed code, `cargo test -p markiro-host --offline --test commit`, 4 runs, all the same)**

```
test a_commit_abandoned_in_flight_still_lands_and_still_wakes_the_streams ... FAILED
panicked at host/tests/commit.rs:66:10:
the commit landed but its wake-up was lost with the caller: Elapsed(())
test result: FAILED. 0 passed; 1 failed; ... finished in 5.03s
```

The «the abandoned commit still committed the row» assertion passed first: the write landed, only the wake-up was lost. That is the stated bug.

**Mutation** (`commit_and_notify` body replaced by `tx.commit().await?; notify(); Ok(())`): the same failure, `Elapsed(())` after 5.03 s. Restored; green (8 repeated runs of the fixed binary before the mutation, 0.02 s each, and the final suite).
**Mutation for A.4** (the bump removed from the already-revoked branch): `retrying_a_revocation_…` FAILED (5.41 s); restored; green.

## B. One control-character rule for every free-text validator (I-3, item 5, 32, 33)

**Changed** (`host/src/validate.rs`)

- `is_plain(text, max)`: 1..=max **characters** (`chars()`, bounded: it looks at `max + 1` characters at most, and the control scan only runs on a text that fits) and no `char::is_control`.
- `clean_text(field, text, max, what)`: trim, then `is_plain`; error is `validation_failed` on the same `details.field` as before.
- Used by `person_name`, `optional_text` (`operator_role` 120, `badge_label` 100; blank stays «none»), the company name (org and counterparty, path-prefixed field kept), `line_name`,
  `device_name`, `device_registration` (name, `appVersion` 50). Numeric limits are exactly the old ones. The version and capability limits now count characters (they counted bytes).
- Capabilities (see Deviations): each must satisfy `is_plain(_, 64)` **as sent** and not be blank.
- Message texts now say «… characters without control characters».

**Tests**

- Unit (`validate.rs`): `every_free_text_field_refuses_a_control_character_wherever_it_stands` (8 trimming validators × NUL first / NUL inside / NUL last / tab / newline / DEL / NEL inside),
  `every_free_text_field_still_accepts_ordinary_text` (Cyrillic, hyphen and apostrophe, edge whitespace incl. `\t`, `\n`, NEL trimmed, NBSP inside kept),
  `a_capability_is_checked_as_sent_without_control_characters`,
  `a_line_name_is_at_most_100_characters_not_bytes` (100 accepted = 200 bytes, 101 refused, counted after trimming; item 32),
  `a_device_registration_counts_characters_and_pins_every_limit` (50-char version accepted / 51 refused, 32 capabilities accepted / 33 refused, 64-char capability accepted / 65 refused),
  `a_time_zone_is_an_iana_name_of_at_most_64_characters` (64 accepted, 65 refused, `Asia/Ust-Nera`, `America/Argentina/Buenos_Aires`, `Etc/GMT+3`),
  `a_person_name_is_measured_after_trimming_and_unicode_whitespace_is_trimmed`,
  `an_office_login_may_have_upper_case_letters` (pins today's behaviour: accepted).
- Routes: `counterparties.rs::a_counterparty_name_with_a_control_character_is_refused` (POST and PUT; NUL first, NUL inside, tab: 400 `validation_failed`, `field: name`, no row, no audit, no revision);
  `bootstrap.rs::wizard_text_with_a_control_character_names_the_field_instead_of_failing` (`org.name`, `admin.name`, `lines.0`, `lines.1`; the host stays uninitialized);
  `pairing.rs::device_text_with_a_control_character_is_refused_on_local_pair` (name, `appVersion`, capability; no device, no audit);
  `claim.rs::a_claim_with_a_control_character_in_the_device_name_creates_no_device` (code neither used nor counted against, still claims afterwards);
  `devices.rs::a_device_name_with_a_control_character_is_refused_on_update`.

**Red (unfixed code)**

- Routes: counterparties `left: (500, "internal", Null)` vs `right: (400, "validation_failed", "name")`; wizard, claim, local-pair `left: 500, right: 400`;
  device rename `left: (500, "internal", Null)`. (A NUL first reaches SQLite, whose `length()` stops at it, so the CHECK fails: 500.)
- Units: 4 FAILED, 21 passed: `a_device_registration_counts_characters_and_pins_every_limit` («assertion failed: version(&"в".repeat(50)).is_ok()»: 50 Cyrillic letters = 100 bytes were refused),
  `a_capability_is_checked_as_sent_…`, `every_free_text_field_refuses_…`, and the prefix test of item G. The tests that pin today's behaviour
  (line name 100/101, time zone, person name after trimming, uppercase login) are green on the old code by design: they close gaps 32/33, they do not change behaviour.

**Mutation** (`is_plain` without the control check): all five route tests FAILED with the red values above, and both control-character units FAILED. Restored; green.

## C. A station's line change wakes the streams (I-1, host part)

**Changed** (`host/src/routes/devices.rs::update_device`): when the stored `line_id` actually changes it takes one `next_revision` and commits through `commit_with_revision`;
a name-only change stays revision-free; a no-op returns before any write; no device item in the feed. Docs: `AGENTS.md` (device bullet, feed paragraph), spec §4.4 (new bullet), §4.5
(device forms bullet) and §4.7 (its last bullet said «ревизия хоста не меняется», which C makes false): a line change takes a revision without a feed item;
the station's adoption of an office-assigned line is plan 1d3, the interplay with a running shift is plan 2a.

**Tests**

- `devices.rs::a_line_change_takes_one_revision_and_wakes_the_streams_without_a_feed_item`: rename alone: revision and watch unchanged; assign: exactly +1 and `revisions.changed()` fires with it;
  `GET /v1/changes?since=<start>` is `{ rev: start+1, hasMore: false, items: [] }` (no device item); same line again: no revision, no wake, no audit row;
  another line and «rename + clear» take one revision each, the latter with a single audit row naming both fields.
- `changes_stream.rs::an_office_line_assignment_wakes_the_stations_stream`: an open stream gets the next `rev` event.
- `devices.rs::an_administrator_renames_a_device_and_sets_its_line`: its last assertion was «the host revision stays»; it now expects `revision + 2` (assign and clear), rename none.

**Red (unfixed code)**: `a_line_change_takes_one_revision_…` `devices.rs:199 left: 1, right: 2`; `an_administrator_renames_…` `left: 1, right: 3`;
the stream test panics at `changes_stream.rs:43` («an event within 5 s»). **Mutation** (`rev` forced to `None`): the same three tests FAILED. Restored; green.

## D. Re-sending a station's current line is «keep» (item 22)

**Changed**: `update_device` treats `Some(Some(id))` equal to the stored `line_id` as «keep», before the station and active-line checks. Documented with C (same sentence in AGENTS.md and spec §4.4/4.5/4.7).
**Test**: `devices.rs::re_sending_a_stations_current_line_keeps_it_even_when_the_line_is_archived`: assign, archive that line, `PUT { name: "Станция упаковки", lineId: <it> }` answers 200;
the audit row changes only `name`; the revision is unchanged; a lone re-send is a no-op (no row); another archived line is still refused with `lineId`.
**Red**: `devices.rs:294 left: 400, right: 200`. **Mutation** (the keep arm removed): FAILED, same. Restored; green.

## E. The feed envelope and the site record cannot leak in `Debug` (M-1, item 2)

**Changed** (`proto/src/lib.rs`): `ChangeItem` no longer derives `Debug`; a manual impl prints entity, id, rev and `deleted` (`finish_non_exhaustive`) and hides `data`,
so `ChangesResponse` prints safely through it. `SiteRecord.badge_salt` is `Secret` (transparent, same wire form); the one constructor (`host/src/routes/changes.rs`) and the one reader
(`proto/tests/fixtures.rs`, `.expose()`) were updated; `Secret`'s doc now names verifiers and the salt. No fixture changed, and all round-trip tests are green, so the wire is unchanged.
**Test**: `proto/tests/fixtures.rs::the_feed_envelope_and_the_site_record_print_without_hashes_or_the_salt`: `{:?}` of the people feed, of the site feed, and of a typed `SiteRecord`
contains none of the fixture's `pinPhc`, `badgePhc` or salt, no `pbkdf2`, and still prints every item's entity, id and revision. Failure messages name the leak, they never print it.
**Red**: FAILED at the first check («the PIN hash is printed»); the printed `Debug` showed `data: Some(Object {…})` for every feed item and `SiteRecord { badge_salt: "…", … }`.
**Mutation**: derive `Debug` on `ChangeItem` again → «the PIN hash is printed»; `badge_salt` back to `String` → «the badge salt is printed». Restored; green.

## F. Iteration constants are checked at compile time (M-2)

`host/src/secrets.rs`: two `const _: () = assert!(…)` for `PASSWORD_ITERATIONS` and `BADGE_ITERATIONS` within `MIN_ITERATIONS..=MAX_ITERATIONS`.
Pin: the compiler. Mutation: `PASSWORD_ITERATIONS = 1_000_001` → `error[E0080]: evaluation panicked: PASSWORD_ITERATIONS must lie within …`; `BADGE_ITERATIONS = 9_999` → the matching error. Restored.

## G. The prefix loop exits early (item 6)

`validate::company` returns «at most 10 GS1 prefixes» at the 11th distinct prefix (`MAX_GS1_PREFIXES`). Test `a_huge_prefix_list_is_refused_at_the_eleventh_distinct_prefix`:
50 000 distinct 7-digit prefixes → `gs1Prefixes`, message «at most 10 GS1 prefixes», in < 500 ms; 50 000 entries of 10 distinct values still pass.
Evidence: the validate unit run took **13.46 s** on the old (quadratic) code and fails on the timing assertion, **0.03 s** now.

## H. One helper for unique-violation → `conflict` (item 14)

`host/src/error.rs`: `ApiError::conflict_on_unique_violation(error, constraint, message)`: `conflict` only for `is_unique_violation`, otherwise `internal`. Used by `lines::name_taken`,
`operators::login_taken`, `operators::badge_taken` (kept as thin named wrappers) and inline in `office_users::create_user`. No behaviour change: lines, operators, badges and office_admin suites are green.
Also added `ApiError::message()` (the accessor tests of G, H and I use) and the unit test `only_a_unique_violation_is_the_clients_conflict` (a real SQLite unique violation → 409 `conflict` with the constraint;
a NOT NULL violation and `RowNotFound` → 500 `internal`, cause not in the body).

## I. Messages are built from the constants (item 17)

`pin_phc` builds «{MIN_ITERATIONS}-{MAX_ITERATIONS}» and `badge_phc` builds «{BADGE_ITERATIONS}» with `format!`; the rendered text is identical to the old literals.
Test `the_iteration_messages_are_built_from_the_constants` compares each message with the constants.

## J. The stream's device re-read logs its error (item 24)

`routes/changes.rs`: `.inspect_err(|error| tracing::warn!(%error, "change stream: device check failed"))` before `.unwrap_or(false)`; still fail closed. The value is a sqlx error (no key, no id).
Test `changes_stream.rs::a_failed_device_check_ends_the_stream_and_is_logged`: the pool is closed, a revocation bump wakes the stream, it ends within 5 s, the captured log has the line and no device key.
Mutation (the `inspect_err` removed): FAILED at the log assertion. Restored; green.

## K. `FromStr` cannot drift from the enums (item 34)

`proto/src/lib.rs`: both `FromStr` impls go through one `parse_variant`, which reads the name with serde's `IntoDeserializer` (so `rename_all` included): the variant set lives only in the derive.
The test builds its variant lists with a `match` without a wildcard arm, so `as_str` (still hand-written, and the name the tables store) is checked against serde and `FromStr` for every variant.
Negatives: `"Admin"`, `"ADMIN"`, `"Technologist"`, `"owner"`, `""`, padded names; `"Station"`, `"STATION"`, `"Office"`, `"tablet"`, `""`, padded names. No «corrupt stored role gives 500» test (the CHECK makes it unreachable), as asked.
Proof by adding a `Kiosk` variant to `DeviceKind` in a scratch edit: only the enum edited → `E0004` in `as_str` and in the test list; `as_str` and the list updated, **no parser edit** → all proto tests green. Restored.

## L. The parse error names the type (item 37)

`UnknownVariant` is `{ what: &'static str, value: String }`, `Display` = `unknown {what} {value:?}`: `unknown office role "owner"`, `unknown device kind "Station"`. The affected assertions were updated and the new test pins both strings.
The HTTP response stays the fixed `internal` body (`ApiError::internal` logs the message only).

## Verification (every command, result)

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: OK.
- `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`: OK, 0 warnings, 0 errors.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --no-fail-fast`, **outside the sandbox** (inside, `open_streams_end_when_the_host_stops` fails with
  «cannot listen on 127.0.0.1:0: Operation not permitted»; `sandbox.network.allowLocalBinding: true` would allow it in the sandbox): exit 0, **321 passed, 0 failed, 0 warnings**.
  host+proto: 202 before, 228 after (+26: validate +10, error +1, commit +3, changes_stream +3, devices +3, bootstrap/claim/counterparties/pairing +1 each, proto lib +1, proto fixtures +1);
  `src-tauri` suites unchanged (93 tests, all pass).
- `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`: 29 files / 531 tests passed (no fixture or TS type changed, run for parity); `typecheck`: OK; `lint`: OK.
- `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`: OK (no JSON changed).
- `git diff --check` and `git diff --cached --check`: OK. `grep` for a literal `\u04` in added lines: none.
- Extra, not required: `cargo clippy -p markiro-host -p markiro-proto --all-targets --offline`: one lint in my code (`type_complexity` in a test helper) fixed with a type alias;
  one pre-existing lint in `host/tests/support/app.rs` left alone. CI does not run clippy.
- `graphify update .`: skipped, this worktree has no `graphify-out/`.

## Deviations and decisions

1. **Capabilities are not trimmed** (B). The brief says every capability goes through the trimming helper. A capability is an identifier the host stores **as sent**; trimming it for validation but
   storing the raw text would let an edge control character (`"x\n"`, whose `\n` is whitespace and would be trimmed away by the check) into storage, and storing the trimmed text would have changed `device_registration`'s return type and both pairing routes.
   So each capability must satisfy the same predicate (`is_plain(_, 64)`) as sent, plus not be blank. Visible differences from the trimming reading: `"x\n"` is refused, a 64-char capability with a trailing space is refused (it was refused before, 65 bytes);
   a whitespace-only capability is now refused (before only the empty string was). If you want the trimming reading, it means changing what is stored.
2. **Extra doc edit**: spec §4.7 also said «ревизия хоста не меняется» for `PUT /v1/office/devices/{id}`; leaving it would contradict C, so it was updated together with §4.4 and §4.5.
3. **K uses the serde option, plus the exhaustive list.** The brief offered either; the serde derive removes the two hand-written matches (net −6 production lines) and makes drift in the parser impossible; the exhaustive-match list in the test
   was kept because `as_str` is still hand-written.
4. `UnknownVariant` changed shape (tuple struct → two fields); it is `pub` but only used inside `proto` and the host's `map_err(ApiError::internal)`.
5. `ApiError::message()` was added (small accessor next to `code()`/`details()`).
6. The «poll once and drop» in A's test uses `std::future::poll_fn`, not `timeout(Duration::ZERO, …)` (reason under A).
7. **Trailer**: the plan pins `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (`docs/superpowers/plans/2026-09-27-standalone-1d2-host-people-devices.md`, and the brief); I used it, as every earlier commit on the branch does.
   The session's own default attribution names a different model; the project rule was followed.

## Not verified / limits

- The abandonment in A is simulated by polling the commit future once and dropping it, not by a real HTTP disconnect. `revoke_device` uses the same helper, and its recovery path is tested end to end,
  but its own abandonment window is not driven at route level (there is no deterministic way to stop a handler between COMMIT dispatch and completion from outside).
- Automated checks only: no Windows service, LAN pairing, DPAPI, real station or webview-in-Tauri run (`apps/standalone/AGENTS.md` «Verification»); a macOS host run proves none of them.
- `pnpm build` of the webview was not re-run (no TS change).
- Not touched, wave 2 or later: items 1, 3, 4, 7–13, 15, 16, 18–21, 25–31, 35, 36; plan 1d3/1d4 items.
