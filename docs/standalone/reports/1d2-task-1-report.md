# Plan 1d2, Task 1 — report

Люди в модели хоста и в ленте: миграция 0007, `feed`, записи операторов и
бейджей.

## What was implemented

- `apps/standalone/host/migrations/0007_people.sql` (new): tables
  `counterparties`, `operators`, `operator_badges`, indexes `operators_rev`,
  `operator_badges_active_phc` (partial unique on `badge_phc` while
  `revoked_at IS NULL`), `operator_badges_operator`, `operator_badges_rev`.
- `apps/standalone/host/src/feed.rs` (new): `feed::remove` (upsert a
  tombstone, moving an older one forward on conflict) and `feed::restore`
  (delete a key's tombstone) — the shared helper writers will use starting
  with tasks 4/5.
- `apps/standalone/host/src/lib.rs`: registered `pub mod feed;`.
- `apps/standalone/host/src/routes/changes.rs`: `FEED_KEYS` gained
  `operators` (only `active = 1`) and `operator_badges` (only
  `revoked_at IS NULL`) branches; `record()` gained the two matching arms
  returning `OperatorRecord`/`OperatorBadgeRecord` with `Secret`-wrapped
  hashes; doc comments updated.
- `apps/standalone/proto/src/lib.rs`: `entities::OPERATORS`,
  `entities::OPERATOR_BADGES`; new types `OperatorRecord { login, name,
role: Option<String>, pin_phc: Secret }` and `OperatorBadgeRecord
{ operator_id, badge_phc: Secret, label: Option<String> }`
  (`#[serde(rename_all = "camelCase")]`); doc comments updated.
- `apps/standalone/proto/fixtures/changes-people.json` (new): the four-item
  fixture from the brief (an operator, its badge, a revoked-badge tombstone,
  a deactivated-operator tombstone).
- Tests: `apps/standalone/proto/tests/fixtures.rs` (import list plus
  `the_people_feed_fixture_round_trips_without_leaking_hashes`) and
  `apps/standalone/host/tests/changes.rs` (test helpers `add_operator`,
  `insert_badge`, `set_active`, `revoke_badge`, `operator_item`,
  `badge_item`, `tombstone`, and five new `#[tokio::test]`s) — all copied
  verbatim from the brief.
- Docs: `apps/standalone/AGENTS.md` ("Change feed" section) and
  `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`
  (§4.4) updated with the tombstone-not-flag rule, verbatim from the brief.

All fragments in the brief matched the pre-task files byte for byte before
editing (verified by reading every source file the brief quotes before
touching it); no improvisation was needed.

## TDD evidence

### RED

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline
```

Output (abridged, matches the brief's expected error exactly):

```
error[E0433]: failed to resolve: could not find `feed` in `markiro_host`
   --> host/tests/changes.rs:410:23
    |
410 |         markiro_host::feed::restore(&mut tx, "operators", id)
    |                       ^^^^ could not find `feed` in `markiro_host`
...
cargo test: 6 errors, 1 warnings (1 crates)
```

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline
```

Output (matches the brief's expected error exactly):

```
error[E0432]: unresolved imports `markiro_proto::OperatorBadgeRecord`, `markiro_proto::OperatorRecord`
 --> proto/tests/fixtures.rs:7:5
  |
7 |     OperatorBadgeRecord, OperatorRecord, OrgProfile, OrgProfileUpdate, OrgRecord, PairResponse,
  |     ^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^ no `OperatorRecord` in the root
  |     |
  |     no `OperatorBadgeRecord` in the root
```

### GREEN

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline
```

Output:

```
running 14 tests
test a_fresh_host_has_an_empty_feed ... ok
test the_feed_checks_its_query ... ok
test the_feed_needs_a_device_key_but_no_office_session ... ok
test a_key_deleted_and_recreated_in_one_transaction_ends_live ... ok
test archived_lines_stay_and_deleted_records_come_as_tombstones ... ok
test one_badge_is_active_for_one_operator_at_a_time ... ok
test after_the_wizard_the_feed_holds_the_organization_the_site_and_the_lines ... ok
test active_operators_and_their_badges_ride_the_feed ... ok
test a_revoked_badge_leaves_the_feed_as_a_tombstone ... ok
test a_deactivated_operator_leaves_the_feed_as_a_tombstone ... ok
test a_reactivated_operator_comes_back_without_its_tombstone ... ok
test a_page_never_splits_a_revision ... ok
test revisions_without_station_records_still_move_the_device_forward ... ok
test the_last_page_carries_the_current_revision_past_its_items ... ok

test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.23s
```

14 passed — 9 previous + 5 new, matching the brief exactly.

Command:

```
cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline
```

Output:

```
running 2 tests
test pairing::tests::normalize_strips_whitespace_and_unicode_dash_separators ... ok
test pairing::tests::a_typed_code_is_normalized_like_crockford_decoding ... ok
test result: ok. 2 passed; ...

running 21 tests
...
test the_people_feed_fixture_round_trips_without_leaking_hashes ... ok
...
test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

2 unit tests + 21 fixture tests = 23, matching the brief exactly.

## Every verification command and its result

| Command                                                                                                                                                                                                                         | Result                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline` (RED, before Step 3)                                                                                                           | Failed to compile: `could not find feed in markiro_host` — as expected                                                             |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --test fixtures --offline` (RED, before Step 3)                                                                                                         | Failed to compile: `unresolved imports OperatorBadgeRecord, OperatorRecord` — as expected                                          |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-proto --offline` (GREEN)                                                                                                                                      | 23 passed (2 unit + 21 fixtures), 0 failed                                                                                         |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-host --test changes --offline` (GREEN)                                                                                                                        | 14 passed, 0 failed                                                                                                                |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                                                                         | Clean, no output                                                                                                                   |
| `node_modules/.bin/prettier --check apps/standalone/proto/fixtures/changes-people.json apps/standalone/AGENTS.md docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`                                          | "All matched files use Prettier code style!"                                                                                       |
| `git diff --check`                                                                                                                                                                                                              | Clean, no output, exit 0                                                                                                           |
| `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-host -p markiro-proto --all-targets --offline` (forced recompile via `touch` on every edited `.rs` file, then run through `rtk proxy` for unfiltered output) | `Checking markiro-proto`, `Checking markiro-host`, `Finished` — 0 warnings                                                         |
| `grep -rn '\\u04' <every new/edited file>`                                                                                                                                                                                      | No matches (no literal `\uXXXX` escapes from the edit tool)                                                                        |
| Extra, beyond the brief's Step 6 but within the orchestrator's general hard rules — `cargo check --manifest-path apps/standalone/Cargo.toml --workspace --all-targets --offline`                                                | `Checking markiro-proto`, `markiro-host`, `markiro-standalone` (the `src-tauri` crate) — 0 warnings                                |
| Extra — `cargo test --manifest-path apps/standalone/Cargo.toml --workspace --offline` (outside the sandbox, since several host/`src-tauri` suites bind 127.0.0.1)                                                               | Every suite `test result: ok`, 0 failed, 0 warnings, across `markiro-host`, `markiro-proto` and `markiro-standalone` (`src-tauri`) |

## Files changed

Committed in `d8edc340b`:

- `apps/standalone/host/migrations/0007_people.sql` (new)
- `apps/standalone/host/src/feed.rs` (new)
- `apps/standalone/proto/fixtures/changes-people.json` (new)
- `apps/standalone/host/src/lib.rs`
- `apps/standalone/host/src/routes/changes.rs`
- `apps/standalone/host/tests/changes.rs`
- `apps/standalone/proto/src/lib.rs`
- `apps/standalone/proto/tests/fixtures.rs`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

10 files, 498 insertions(+), 17 deletions(-). No changes to `apps/station`,
`apps/standalone/src-tauri`, or `Cargo.lock` (no new dependencies).

## Deviations

None. Every fragment the brief quoted matched the pre-edit files exactly
(verified by reading each file before editing), so every step was applied
verbatim: migration SQL, `feed.rs`, the `lib.rs`/`routes/changes.rs`/
`proto/src/lib.rs` edits, the fixture JSON, and both `AGENTS.md`/spec-doc
paragraphs.

The only addition beyond the brief's own Step 6 is running the workspace-wide
`cargo check`/`cargo test` (including the `src-tauri` crate) as extra
diligence per the orchestrator's general hard rules; the brief's own scoped
commands (`-p markiro-host -p markiro-proto`) were run first and are the
primary evidence above.

## Self-review findings

- **Completeness against the brief**: every consumed/produced interface in
  the brief's "Interfaces" section is present with the exact signature:
  `feed::remove(conn, entity, id, rev) -> Result<(), sqlx::Error>`,
  `feed::restore(conn, entity, id) -> Result<(), sqlx::Error>`,
  `entities::OPERATORS`/`OPERATOR_BADGES`, `OperatorRecord`,
  `OperatorBadgeRecord`, the four new indexes, and the fixture.
- **Names**: match the brief and the rest of the codebase's conventions
  (`entities::LINES`-style constants, `*Record` proto types, `feed` module
  name mirroring `db`, `audit`, etc.).
- **No overbuilding**: no routes, no validation helpers, no audit wiring —
  those are explicitly tasks 4/5/2. `feed::remove`/`restore` are used only
  by the new tests in this task, exactly as the brief describes ("Сейчас
  надгробия пишут только тесты").
- **Tests verify behaviour, not just shape**: the five new host tests check
  the actual tombstone lifecycle (operator deactivate/reactivate, badge
  revoke, the partial-unique-index conflict and its release on revoke, and
  that a station syncing from zero never sees a deactivated operator's
  record) — not just that the endpoint returns 200.
  I additionally re-derived the badge-salt assertion in
  `the_people_feed_fixture_round_trips_without_leaking_hashes` (the 4th
  `$`-segment of `BADGE_PHC` against `changes-response.json`'s `badgeSalt`)
  to confirm it truly matches rather than trusting the brief blindly — it
  does.
- **Pristine output**: confirmed 0 warnings twice — once scoped
  (`-p markiro-host -p markiro-proto`, after forcing a clean recompile with
  `touch`) and once for the whole `apps/standalone` workspace including
  `src-tauri`.
- No stray `\uXXXX` literals from the edit tool in any new or modified
  Cyrillic text (migration comments, doc prose, test data).
- `git status` is clean after the commit; only the 10 intended files were
  staged and committed (explicit paths, no `git add -A`).

## Concerns

None. The task was self-contained, every brief fragment matched the
pre-existing files exactly, and all required and extra verification passed
with no warnings or failures.
