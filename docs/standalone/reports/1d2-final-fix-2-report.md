# Plan 1d2 — final-review fix wave 2 of 2: report

Scope: items A–W of `.superpowers/sdd/1d2-final-fix-2-brief.md` (the remaining tests and docs;
wave 1's production changes are in `e1190290e`). Item numbers refer to
`.superpowers/sdd/1d2-minors.md`. Worked in
`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

**Commit:** `146e8c55f` — `test(standalone): итоговое ревью 1d2 (2/2) — тесты отказов, тумбстоунов и потока, правки спеки и AGENTS`
16 files, +754/-100, explicit paths only. The subject equals the brief's byte for byte; the message ends
with exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line (checked with
`git log -1 --format=%B`). `apps/station`, `.superpowers/`, the plan documents and every route or validator
file are untouched. The only production-file edit is the `#[cfg(test)]` module of `host/src/pairing_code.rs`
(item L) and doc comments in `proto/src/lib.rs` (item Q).

**Status:** DONE_WITH_CONCERNS. Every item is implemented and pinned; every new or changed assertion has
a recorded scratch mutation that makes it fail. The concerns are two wording points (U, N) listed under
«Deviations and decisions».

Raw logs of every run are in `/tmp/claude-501/1d2fix2/*.log` (scratch, not committed; the mutation runs are
`mut-*.log`). No hash, PIN, key, token or pairing code is printed by any new test or quoted here (the
public fixture PIN hash that one pre-existing test prints on failure is left out of the excerpts).

## A. `feed::remove` moves an older tombstone up (item 1)

- **Test** `changes.rs::removing_a_key_again_moves_its_tombstone_up_to_the_new_revision`: `feed::remove` twice on
  one key, each in its own transaction (`remove_at_new_revision`), the second at a higher revision. It asserts the
  table holds exactly one tombstone for the key and that its `rev` moved to the second revision, and that a station
  at the first revision gets the tombstone again from `GET /v1/changes?since=<first>`. No `MAX` guard was added.
- **Mutation** (`ON CONFLICT (entity, id) DO UPDATE SET rev = excluded.rev` → `DO NOTHING`), `cargo test -p markiro-host --offline --test changes`:
  ```
  test removing_a_key_again_moves_its_tombstone_up_to_the_new_revision ... FAILED
  assertion `left == right` failed: one tombstone, moved up to the newer revision
    left: [("lines", "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21", 2)]
   right: [("lines", "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21", 3)]
  test result: FAILED. 14 passed; 1 failed
  ```
  Restored: `cmp` with the backup and with `git show HEAD:…/feed.rs` identical; green (15 passed).

## B. The tombstone test has teeth (item 3)

- **Test** `changes.rs::a_reactivated_operator_comes_back_without_its_tombstone` (changed): a second operator
  `0043` is deactivated first, so two tombstones exist (asserted, sorted by key) before the first operator is
  reactivated. After the reactivation the table must hold exactly the other operator's tombstone, and the feed from
  zero must be that tombstone plus the reactivated record. The old `COUNT(*) = 0` is gone; the shared
  `support::app::tombstones` reads the rows.
- **Extra mutation** (`restore` deleting every tombstone of its entity: `AND (id = ? OR 1)`): FAILED with
  `left: []` vs the other operator's tombstone; the old single-operator assertion would have passed it.
  Restored, identical to HEAD.

## C. The proto test finds the site item by entity (item 4)

- `proto/tests/fixtures.rs`: helper `site_item(&feed)` finds the item with `entity == "site"`; the people-feed test
  now `expect`s both the site's `badgeSalt` and the badge hash's 4th `$` part before comparing two `&str`s. The
  wave-1 leak test's two positional reads of the same fixture (`["items"][2]` and `feed.items[2]`) look the item up
  by entity too.
- **Mutations:** the site item moved to the front of `changes-response.json`: both tests still pass (position
  independent). The site's `badgeSalt` removed and the badge hash replaced by a string without a salt part: the new
  test FAILS with `the site record carries a badge salt`, while HEAD's old test on the same fixtures PASSES
  (two `None`s compared equal), which is the flaw. Fixtures restored, clean vs HEAD.

## D. `LineCreate` rejects unknown fields (item 12)

- `line_fixtures_round_trip_and_an_update_carries_only_what_changes`: `line-create.json` plus `archived: true`
  must not parse as `LineCreate` (a create's field set has no `archived`; it is an update's field).
- **Mutation** (`deny_unknown_fields` removed from `LineCreate`): FAILED at `serde_json::from_value::<LineCreate>(value).is_err()`. Restored.

## E. The operator fixture lists badges oldest first (item 19)

- `proto/fixtures/office-operator.json`: the revoked badge (created 2026-09-20) first, the live one second.
  `operator_fixtures_round_trip_without_leaking_the_pin_hash` reads `badges[0]`. Nothing else reads this
  fixture (Rust proto test only; the Vitest suite reads other named fixtures).
- **Mutation** (fixture back to newest first): FAILED, `left: None, right: Some("2026-09-27T08:00:00Z")`. Restored.

## F. Counterparties (item 7) — `host/tests/counterparties.rs`

- Stale and not-found writes leave the host revision and the audit rows unchanged: snapshots in
  `an_administrator_creates_lists_and_updates_counterparties` (stale) and
  `an_unknown_counterparty_is_not_found_once_its_body_is_valid` (the invalid-body 400 and the not-found 404). The row
  count is the shared `support::app::audit_rows` (every action).
- Unknown field: `counterparty_fields_follow_the_organization_rules` now asserts `details.field` is absent.
- New `an_update_without_an_inn_clears_it_just_like_a_null`: `inn: null` clears, a second PUT sets it, a PUT with `inn`
  left out clears it again; the three audit rows carry the exact `changed: ["inn"]` and `{from, to}`.
- New `an_archived_counterparty_can_be_brought_back`: archive, un-archive; record, list and both audit rows.
- New `an_update_records_a_changed_name_gln_and_prefixes_with_both_values`: one PUT changing all three (trimmed name,
  trimmed and de-duplicated prefixes); the exact `changed` list `["name","gln","gs1Prefixes"]` and each `{from, to}`.
- No list-order test.
- **Mutations** (all caught by the intended tests only): refusals take a revision → both refusal tests FAIL (`left: 2, right: 1`, `left: 4, right: 3`);
  refusals write an audit row → both FAIL (`left: 3, right: 2`, `left: 5, right: 4`); INN kept on PUT → the INN test FAILS
  (`left: (String("7812345678"), 3), right: (Null, 3)`); un-archive impossible → the un-archive test FAILS;
  `name` pair swapped, `gln` pair swapped, `gs1Prefixes` tuple dropped → the audit-values test FAILS each time;
  `ApiError::malformed` naming a field → the unknown-field assertions of `counterparty_fields_follow_the_organization_rules`
  and (item H) `operator_fields_are_checked` FAIL.

## G. Lines (items 12, 13) — `host/tests/lines.rs`

- Stale and not-found writes leave revision and audit rows unchanged: snapshots in
  `an_administrator_creates_renames_and_archives_lines` and `an_unknown_line_is_not_found_once_its_body_is_valid`.
- New `a_line_may_be_renamed_to_a_case_variant_of_its_own_name` («Линия 1» → «ЛИНИЯ 1»: 200, rev +1, exact audit row, feed record).
- New `an_archived_line_comes_back_when_its_name_is_free` (successful un-archive: record, list, both audit rows, feed).
- New `an_archived_line_may_take_the_name_of_an_active_one` (an archived line renamed to «линия 2», the active line's
  name: 200; two rows share the key, one active, one archived).
- The 100-character boundary is not repeated: wave 1's `validate::tests::a_line_name_is_at_most_100_characters_not_bytes` has it.
- **Mutations:** refusals take a revision / write an audit row → both refusal tests FAIL each time; a rename pre-check that
  forgets the row itself (`WHERE name_key = ? AND archived = 0`) → the case-variant test AND the archived-rename test
  FAIL (`left: 409, right: 200`); a pre-check that spares the row itself but ignores that an archived line is outside the
  index (`… AND id != ?`) → only the archived-rename test FAILS; un-archive made impossible → the un-archive test and
  `line_names_are_unique_among_active_lines_regardless_of_case` FAIL.

## H. Operators (items 16, 18) — `host/tests/operators.rs`

- New `deactivating_again_after_a_reactivation_leaves_one_tombstone_at_the_last_revision`: at every step the table and
  the feed are checked, so a reactivation that leaves a tombstone is caught before the second deactivation would hide it
  by moving it up. After the last step: one tombstone at revision 5, and the feed (from zero, and from revisions 3 and 4)
  carries only that tombstone, no record.
- New `activating_an_active_operator_writes_nothing`: `{ "active": true, "expectedRev": 2 }` on an active operator: same record,
  no revision, no audit row of any action, no tombstone, feed unchanged.
- Stale and not-found: snapshots in `an_update_names_the_changed_fields_and_never_the_pin_hash` and
  `an_unknown_operator_is_not_found_once_its_body_is_valid` (revision, audit rows; the latter also the tombstone table).
- `operator_fields_are_checked`: the unknown-field case asserts `details.field` is absent.
- **Mutation (required)** — `feed::restore` made a no-op (`let _ = (conn, entity, id); Ok(())`),
  `cargo test -p markiro-host --offline --test operators --no-fail-fast`:
  ```
  test deactivating_again_after_a_reactivation_leaves_one_tombstone_at_the_last_revision ... FAILED
  test deactivation_sends_a_tombstone_and_reactivation_the_record_again ... FAILED
  assertion `left == right` failed: the record is back
    left: [("operators", "<id>", 3)]
   right: []
  assertion `left == right` failed: the tombstone is gone
  test result: FAILED. 8 passed; 2 failed
  ```
  Restored, identical to HEAD.
- **Other mutations:** a no-op update that writes anyway (`update_details_hiding(..).unwrap_or_else(..)` instead of the early return)
  → `activating_an_active_operator_writes_nothing` and the existing no-op check FAIL; refusals take a revision / write an audit row →
  `an_update_names_…` and `an_unknown_operator_…` FAIL each time.

## I. The stream-open refusal (item 25) — `host/tests/changes_stream.rs`

- New `opening_a_stream_for_a_device_revoked_meanwhile_is_refused`: the device is revoked by SQL and
  `markiro_host::routes::changes::stream(State(app.state.clone()), AuthDevice { id, kind: DeviceKind::Station })` is called
  directly; `.err().expect(..).into_response()` is 401 with `code: unauthorized` and `details.credential: device`. It makes no
  claim about the order of the subscription and the check.
- **Mutation (required)** — the refusal branch (`if !device_active(..)? { return Err(unauthorized) }`) deleted:
  ```
  test opening_a_stream_for_a_device_revoked_meanwhile_is_refused ... FAILED
  panicked at host/tests/changes_stream.rs:413:6:
  a revoked device is not given a stream
  test result: FAILED. 0 passed; 1 failed
  ```
  Restored, identical to HEAD.

## J. Repeated revoke rewrites nothing (item 26)

- `devices.rs::revoking_a_device_refuses_its_key_and_ends_its_office_sessions`: the `ManualClock` advances 5 minutes before the
  second revoke; `revokedAt`, the whole record (response and list) and the audit count are unchanged.
- `badges.rs::revoking_a_badge_writes_a_tombstone_and_the_badge_never_comes_back`: the clock advances 5 minutes; the listed
  `revokedAt`, the host revision (4), the tombstone (`GET /v1/changes?since=3` still `[tombstone @4]`, `since=4` empty) and the
  audit count are unchanged.
- **Mutations:** second device revoke falls through (rewrites) → FAILED, `left: "2026-09-21T14:18:20Z", right: "2026-09-21T14:13:20Z"`;
  second badge revoke rewrites only `revoked_at` → FAILED on the same times; second badge revoke moves only the tombstone up
  (no revision bump) → FAILED on the feed (`rev` 5 instead of 4). All restored.

## K. Pairing codes (item 28) — `host/tests/pairing_codes.rs`

- New `an_exhausted_code_named_in_replaces_is_ignored`: `failed_attempts` set to `MAX_FAILED_ATTEMPTS` by SQL, the clock advanced
  a minute, then `{ replaces: <that id> }`: a new code is issued, its audit row has no `replaces`, and the exhausted code's
  `expires_at` is unchanged.
- New `a_code_request_body_that_cannot_be_read_is_validation_failed`: a wrong content type (`text/plain`), invalid JSON and
  `{"replaces":5}` each answer 400 `validation_failed`; no code row, no audit row.
- **Mutation (required)** — the `AND failed_attempts < ?` condition and its bind dropped from the `replaces` UPDATE:
  ```
  test an_exhausted_code_named_in_replaces_is_ignored ... FAILED
  assertion `left == right` failed: nothing was replaced, so the row names no `replaces`
    left: Object {"expiresAt": "2026-09-21T14:24:20Z", "replaces": "<id>"}
   right: Object {"expiresAt": "2026-09-21T14:24:20Z"}
  test result: FAILED. 7 passed; 1 failed
  ```
  Restored, identical to HEAD.
- **Extra mutation:** the optional extractor's rejection mapped to `ApiError::internal` → the new extractor test and the existing
  `a_code_request_body_is_optional_but_strict` FAIL (`left: (500, "internal"), right: (400, "validation_failed")`).

## L. The pairing fixture pins `createdAt` (item 29)

- `host/src/pairing_code.rs` unit `the_shared_pairing_code_fixture_matches_the_host`: `format_timestamp(created) == text("createdAt")`
  next to the `expiresAt` check (the doc comment says both timestamps).
- **Mutation** (`createdAt` written as `…:00.000Z`): FAILED, `left: "2026-09-26T09:15:00Z", right: "2026-09-26T09:15:00.000Z"`. Restored.

## M. One shared `host_revision` (item 35)

- `office_admin.rs`: the local `host_revision(&Admin)` is deleted; the 9 call sites use `host_revision(&admin.app)` from
  `support::app`. Every assertion is kept (11 lines added, 18 removed, all mechanical). Green in the full run.

## N, O, P. Spec (`docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`)

- **N (§4.3, item 8):** the `org_profile` entry now says its name, INN, GLN and prefixes are checked by the same `validate::company` as
  the counterparties (rules in their entry below), plus the time zone; the time-zone sentence and the rest are verbatim; 3 lines became 4.
- **O (§4.5, item 27):** the `GET /v1/changes/stream` row says «поток заканчивается при остановке хоста или при отзыве устройства».
  Prettier re-pads every row of that table because the row is the widest cell: the whitespace-insensitive diff
  (`git diff -w`) shows only the N, O and P edits and the separator dashes; the rest of the table's diff is whitespace.
- **P (§4.3, item 13):** «при создании, переименовании активной линии и возврате из архива» (one line grew from 73 to 88 characters,
  no reflow).

## Q. Proto doc comments (item 11) — `proto/src/lib.rs`

`LineUpdate`, `DeviceUpdate` (its `name`) and `OperatorUpdate` (its `name`, `active`, `pinPhc`) say that `null` in a plain
`Option<T>` field reads as «not sent» (`#[serde(default)]` maps it to absent) and that only the double-optional fields
(`Option<Option<T>>` with [`nullable`]: `DeviceUpdate.lineId`, `OperatorUpdate.role`) tell `null` from absent. `cargo doc` for the
crate has no warning (the intra-doc links resolve). Scratch check of the claim (not committed): `PUT /v1/office/lines/{id}` with
`{ "name": null, "archived": null, "expectedRev": 1 }` answers 200 with the record as it was, no revision, no audit row.

## R–U. `apps/standalone/AGENTS.md`

- **R (Audit, item 20):** an update row carries `{ from, to }` for each changed field, «except `pinPhc`: it is named in `changed`
  without a value (`audit::update_details_hiding`)».
- **S (pairing, item 30):** «A request without `Content-Type` has no body (axum treats it as none even if bytes are sent), so a
  `replaces` sent without the header is ignored, not refused.» Scratch check (not committed): a `POST /v1/office/pairing-codes` carrying
  `{ "replaces": <id> }` bytes but no `Content-Type` answered 200, issued a new code whose audit row has no `replaces`, and the first
  code still claimed successfully.
- **T («Writes», item 36):** «inside a handler, with `secrets::hash_password_blocking`. `change_password`'s verify-then-hash is one
  `spawn_blocking` closure of its own.» The never-hold-the-write-lock rule is kept.
- **U («Network and TLS», M-6):** «never let a listed prefix cover a route whose response carries a credential the webview must never
  hold (a device key, a password hash, another session's token)». See the deviation below.

## V. Wave 1's docs are consistent — no edit needed

Read «Writes», «Change feed», «Operators and badges» and «Device key and office session» after wave 1, the spec's §4.3–§4.7 and the route
and module doc comments of devices, lines and operators. `grep` for «no revision», «revision stays», «не берут», «не меняется» and
similar: every remaining statement matches the code (a rename, a repeat of the same line and a revocation take no revision; a line
change takes one; the station's own `PUT /v1/device/line` takes none; a claim raises none). Two sentences were examined and left:

- «revoking it again changes nothing» (AGENTS.md device bullet, spec §4.7, the `revoke_device` doc comment) is about the stored record,
  the audit trail and the revision, all of which J now pins; the wake-up an idempotent revoke still sends is stated in «Writes».
- «One `next_revision` per changing transaction, stamped on every row that transaction changes» already ignored rows without a `rev`
  (every audit row is one), so a device line change does not newly contradict it.
  If you want the first one reworded, it is a two-word edit in three places, one of them a route doc comment (item W forbids touching route code).

## W. Nothing else

No plan document, `.superpowers/`, route or validator code was touched; `git status` is clean after the commit.

## Verification (every command, result)

- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline --no-fail-fast`, **outside the sandbox** (inside it
  `open_streams_end_when_the_host_stops` fails with «cannot listen on 127.0.0.1:0: Operation not permitted»; evidenced in this session
  before the retry): exit 0, **333 passed, 0 failed, 0 warnings** in 36 test binaries (wave 1: 321; +12 new tests: changes 1, counterparties 3,
  lines 3, operators 2, changes_stream 1, pairing_codes 2). Log: `/tmp/claude-501/1d2fix2/full-test.log`.
- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: OK.
- `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`: OK, 0 warnings, 0 errors.
- `node_modules/.bin/prettier --check apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md apps/standalone/proto/fixtures/office-operator.json`: OK
  (the spec needed one `prettier --write`, for the table re-pad described under O).
- `git diff --check` and `git diff --cached --check`: OK. A grep for a literal `\u04` in the added lines: none.
- Webview parity (no TS and no webview-read fixture changed; `office-operator.json` is read only by the Rust proto test):
  `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`: 29 files / 531 tests passed; `typecheck`: OK; `lint`: OK.
- `cargo doc -p markiro-proto --offline --no-deps`: no warning.
- `graphify update .`: skipped, this worktree has no `graphify-out/`.
- Scratch runs: 31 (30 mutations and one run of HEAD's old test against a mutated fixture), each restored and compared (byte-identical to the pre-mutation content in memory, and `git diff --quiet` for the untouched
  production files); the tree after them was identical to the committed one.

## Deviations and decisions

1. **U: «a session credential» became «another session's token».** The brief's list says the webview must never hold «a session credential», but it
   holds the office session token by design (`host_request` takes `officeToken`; `POST /v1/office/login` is under `/v1/office/…` and returns it;
   AGENTS.md: «The office session token lives only in webview memory»). Taken literally, the paragraph would say the login route breaks its own rule.
   If you want the brief's exact words, it is one phrase.
2. **N keeps the spec's time-zone sentence verbatim** («часовой пояс — непустая строка. Проверка IANA-имени — в интерфейсе»). The host's real rule
   (`validate::org`) is 1–64 characters from `A-Za-z0-9/_+-`, so «непустая строка» understates it. Not changed (out of scope for N, and no new claims).
3. **Shared test helpers.** `audit_rows` (all audit rows) and `tombstones` (all tombstones) are added to `support/app.rs`, because AGENTS.md says to add a helper there
   before copying one into a second test file and four files needed the count; `badges.rs`'s local `audit_rows` was replaced by the shared one (2 call sites).
   `office_admin.rs` keeps its own `audit_count(action, target_id)`, a different helper.
4. **C also fixes the wave-1 leak test's positional reads** of `changes-response.json` (same fixture, same risk), not only the people test's assertion.
5. **Small extra assertions inside listed items:** the feed from zero after the reactivation in B (the other operator's tombstone), and the tombstone table after the
   not-found request in H.
6. **Trailer:** the brief and the plan pin `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as on every earlier commit of the branch; the session's default
   attribution names another model and was not used.

## Not verified / limits

- Automated checks only (in-process router tests and Vitest): no Windows service, LAN pairing, DPAPI, real station or webview-in-Tauri run; a macOS host run proves none of them.
- The stream-open refusal test calls the handler directly with a revoked device, so it pins the refusal and not the order of the subscription and the check (as the brief says).
- `open_streams_end_when_the_host_stops` (real socket) ran only in the outside-the-sandbox run.
