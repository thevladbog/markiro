# Multi-station shift: host implementation plan (milestone 2b, part 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several stations and handhelds work one shift of one line at the same time on the
host of «Markiro Автоном»: entry by the line's capacity, each participant closing its own part,
the shift closing itself when every participant closed, a forced close from the office, the plan
and its reason judged by the shift-wide total, and shift-wide totals served to every device.

**Architecture:** One new host migration adds `lines.max_stations` and a per-participant state
machine to `shift_participants` (columns only, no rebuild). Two focused modules hold the rules:
`host/src/shift_participants.rs` (pure decisions plus the only writers of the participant state)
and `host/src/shift_totals.rs` (totals read from the facts, never stored). The existing entry,
facts, office-close and line routes call them; one new device route (`leave`) and one office
route (`close-reason`) are added. Wire changes are additive, gated by the capability
`multi-station-v1`, and the protocol goes to 7 so that a station that closes "its part" can never
talk to a host that would close the whole shift on the same fact.

**Tech Stack:** Rust (axum, sqlx 0.8 on bundled SQLite 3.46 via `libsqlite3-sys` 0.30.1, serde),
`markiro-proto` wire types and JSON fixtures, Zod mirror in `apps/standalone/src/host/protocol.ts`,
Vitest, `node --test` release contracts.

**Spec:** `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` (owner
decisions of 2026-10-20). Sibling plans written against the contract at the end of this file:
station, office, handheld, load/soak.

**Commands.** `$WT` is the absolute path of the executor's worktree (`/tmp/claude/wt/<NAME>`,
`docs/standalone/ledger/exec-rules.md`). Never `cd`. Cargo runs as
`cargo --offline --locked … --manifest-path "$WT/apps/standalone/Cargo.toml"`; pnpm as
`pnpm --dir "$WT" --config.verifyDepsBeforeRun=false …`. Host integration tests run in-process
(`TestApp::send`); if one needs a loopback socket, run it with the sandbox disabled.

## Global Constraints

From the spec (owner decisions, §1, §4, §8):

- Several stations and handhelds work one shift in parallel, one product, each device with its own boxes.
- Each device has its own pallets; a pallet holds only boxes of its own device. No shared pallet in this milestone.
- Each participant closes its own part; the shift closes when every participant closed; the office may close the whole shift.
- Counter and plan: «Моя станция: N · Всего в смене: K из M»; the plan is reached by the shift-wide total.
- Free entry; the line has a limit of devices per shift, `lines.max_stations INTEGER NOT NULL DEFAULT 1 CHECK (max_stations BETWEEN 1 AND 16)`.
- A handheld is a full participant, equal to a station.
- Stay on SQLite (WAL, `synchronous=FULL`, `busy_timeout` 5 s, pool 4, hot writes in `BEGIN IMMEDIATE`, `host/src/db.rs`).
- `left` does not occupy a slot; a participant that took part before enters again whenever the shift is not closed and a slot is free.
- `shifts.owner_device_id` stays "who opened it", with no special rights; the lifecycle CHECKs of `0009` are not touched.
- No counter columns: totals are queries over the registry, boxes and pallets, as `routes/office_shifts.rs:34-90`.
- Forced close from the office: every `active`/`left` participant becomes `closed` "by the office"; the reason is mandatory; late data stays late and never reopens the shift.
- The reason is asked from the last closer only (or the office); the others close their part without one.
- Totals to devices: `totals { accepted, boxesClosed, pallets, asOf }` and `byDevice[]` in `GET /v1/device/shifts`.
- New audit actions: `shift.join`, `shift.leave`, `shift.part_closed`, `shift.force_closed`, `line.max_stations_changed`.
- Code registry, SSCC blocks, receipts and license seats are unchanged.
- With `max_stations = 1` clients see no change; older clients keep seeing «занято».
- Release order: host first, then station, office, handheld; each step released separately.

From `apps/standalone/AGENTS.md` and the root `AGENTS.md`:

- Single site, no tenants: there is no `tenant_id`; tenant-isolation rules do not apply.
- DDL lives only in `host/migrations`; an applied migration is never edited (sqlx checks checksums). The new migration takes the next free number: `0052` today (highest is `0051_warehouse_reprint_imported.sql`); re-check before Task 1.
- A table rebuild copies every row with its rowid and checks `sqlite_master` for triggers naming the table; this plan rebuilds nothing.
- Every office change, pairing and initialization writes one `audit_log` row; action names come only from `audit::actions`; a refused request writes no row; a repeated request (a re-entry, a repeated leave) writes no row and takes no revision.
- Tests assert the exact actor, action, target, result and parsed details of every audit row.
- A shift is no feed record, but every change of one takes a host revision stamped on its `rev`, with no feed item.
- Device routes re-read the device inside the write transaction (`AuthDevice::require_kinds_in`); every `/v1/device/*` route has a row in `host/src/device_kinds.rs` or it is `forbidden`.
- Facts: a record is checked whole before its first write; a refusal leaves only its receipt; a database error fails the batch; the same record id with the same digest gets the same receipt (`fact_receipts` PK `(device_id, record_id)`).
- Device sequence semantics: a device's instants are kept as the device wrote them (`YYYY-MM-DDTHH:MM:SS.sssZ`); the host's own instants use its format (whole seconds, `Z`).
- Never recalculate persisted history: frozen snapshots stay frozen; stored close events and receipts are not rewritten; live totals are read, never stored.
- Wire changes: `proto`, the Zod schemas and the fixtures change together; response types tolerate unknown fields, request types use `deny_unknown_fields` / `z.strictObject`; Rust and Vitest parse every fixture.
- Raise `PROTOCOL_VERSION` for an incompatible change, a new fact kind, a new `data` field or a new meaning of a fact; the host keeps accepting older protocols (`MIN_PROTOCOL_VERSION` stays 1); a release keeps `MIN_PROTOCOL_VERSION` at or below the previous release's `PROTOCOL_VERSION` (`tools/standalone-release/releases.mjs`).
- No new fact receipt code (the handheld pins the list at 23 codes, `HostFixturesTest.kt`).
- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no broad casts, no `any`.
- Rust gates for a host change: `cargo fmt --all -- --check`, `cargo test -p markiro-host`, `cargo test -p markiro-proto`, and the whole workspace before completion (`cargo test --workspace`). Host-only Cargo runs prove nothing about Windows.
- TDD: a failing test first, then the code; never weaken an existing assertion; a pre-existing test changed because a product decision changed is named in the report.
- Commits are scoped, stage explicit paths, and end with exactly one trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (executor rules).

---

## Decisions taken by this plan (with reasons)

- **D1. Migration `0052_multi_station_shifts.sql`, columns only.** SQLite allows `ALTER TABLE … ADD COLUMN`
  with a `CHECK` and (for `NOT NULL`) a constant default; since 3.37 it tests the new column's `CHECK` against
  every existing row, so every added column is nullable or defaults to a value its `CHECK` accepts, and the
  backfill runs after the columns exist. A column `CHECK` may name other columns (as `0012`'s `boxes.pallet_id`
  does). No rebuild: no rowid moves, no trigger (`shifts_mode_frozen`, the pallet and planned-date triggers) is
  touched, and the foreign keys to `shift_participants`/`shifts` stay. Limits accepted: `joined_at` stays nullable
  (a `NOT NULL` column needs a constant default, which would be a wrong instant); readers use
  `COALESCE(joined_at, first_entered_at)` and every writer sets it.
- **D2. Participant states.** `active` holds a slot; `left` frees it (spec §4.2 «Выход»); `closed` is final.
  A `closed` participant that enters again reads the shift back (snapshot, `myState: "closed"`), nothing is
  written and no slot is taken; this recovers a station that lost its database without reopening its part.
- **D3. Slots.** A slot is an `active` participant whose device is not revoked
  (`devices.revoked_at IS NULL`, spec §12.5): revoking a device frees its slot at once, with no write in
  `revoke_device`. A revoked participant still blocks the automatic close until the office closes the shift.
- **D4. Compatibility of entry.** A device that never entered an open shift joins only if its entry names the
  new capability `multi-station-v1` (`ShiftEnter.supports`). Without it the answer is stage 2a's
  `409 conflict` `shift_busy`, which every older station and handheld already shows as «занято». With it,
  a full line is `409 conflict` `shift_line_full` with `details { constraint, maxStations, active }`.
  `shift_busy` is therefore kept (not retired) for clients that do not name the capability.
- **D5. Leave is a route, not a fact.** `POST /v1/device/shifts/{id}/leave` (stations and handhelds),
  state-idempotent: `active → left` once; `left`, `closed` or a closed shift answer the shift as it is with no
  write. It is online-only: an offline station keeps its slot until it reaches the host (the station plan drops
  a pending leave when it enters again, so a late leave can never undo a re-entry).
- **D6. Part close and automatic close.** The existing `shift_closed` fact closes the sender's part. When no
  other participant is `active` or `left`, the same record closes the shift: `closed_by_kind = 'device'`,
  `closed_by` = the last closer, `closed_at` = its instant. The spec's `closed_by_kind = 'devices'` cannot be
  stored (the `0009` CHECK allows only `office_user`/`device` and changing it needs a rebuild); `device` plus the
  last closer is what the table can hold. A part that leaves the shift open writes `shift.part_closed`; the
  close that closes the shift writes `shift.close` as in stage 2a (one row per event; the participant's own
  close of the shift is visible in `participants[].closedAt`).
- **D7. Reason rule** (`shift_participants::reason_need`, pinned by `proto/fixtures/shift-close-reason-shared.json`):
  a part that leaves the shift open never needs a reason; the close of a shift that only ever had one
  participant keeps stage 2a's rule exactly (`plannedQtySnapshot` vs `actualQty` of the fact; a missing reason is
  refused, `invalid_record` on `data.reasonCode`); the close of a shared shift needs a reason when the host's
  `shifts.planned_qty` is set and differs from the shift-wide accepted total, and a close without it is NOT
  refused (a station's close is its point of no return, and an offline station cannot know it is last, spec
  §12.9): the shift closes with `shifts.close_reason_missing = 1` and the receipt says `reasonMissing`; the office
  supplies the code through `PUT /v1/office/shifts/{id}/close-reason` (audit `shift.close_reason`, an action the
  spec did not list but its §12.9 needs).
- **D8. Receipts of `shift_closed`** (no new receipt code): part closed, shift open → `accepted`
  `{ "partClosed": true }`; a second close of a closed part → `accepted` `{ "partClosed": true }` and the event is
  kept as `already_closed`; shift closed by this record → `accepted` with no details, or `{ "reasonMissing": true }`;
  shift closed before → `accepted` `{ "alreadyClosed": true }` (unchanged).
- **D9. Late data.** A fact of a `closed` participant is accepted (as every late fact is) and stamps
  `shift_participants.late_data_at` once (one revision); a fact for a closed shift still stamps
  `shifts.late_data_at` as before. Nothing reopens a part or a shift.
- **D10. Forced close.** The office's existing `POST /v1/office/shifts/{id}/close` (`{ reason, expectedRev }`,
  reason already mandatory) now also closes every `active`/`left` participant with `closed_by_kind =
'office_user'` and writes `shift.force_closed` `{ reason, notClosed: [{ deviceId, state }] }` instead of
  `shift.close`. The "Не закрыли: …" preview is `OfficeShift.participants` filtered by `state != "closed"`; the
  `expectedRev` guard makes it exact, because every participant change stamps the shift's `rev`.
- **D11. Totals.** Read per request from the facts with the office's rules; `totals.accepted` is the shift-wide
  count (the office's `acceptedUnits`), `boxesClosed` closed boxes not taken apart, `pallets` closed pallets not
  taken apart, `asOf` the host's time of the read; `byDevice[]` lists every participant (zeros included), by
  `boxes.device_id`, `pallets.device_id` and, for validation shifts, `code_owners.device_id`. No new index:
  `boxes_shift`, `box_items_live`, `pallets_shift`, `code_owners_shift_unboxed` serve every read (pinned by a
  query-plan test). A scan takes no revision, so devices refresh totals by reading `GET /v1/device/shifts`
  (`asOf` marks the age); a revision per scan would wake every stream tens of times a second.
- **D12. Protocol 7 and app version 1.1.0.** The meaning of `shift_closed` changes (it closes a part), so a
  station that sends it must never meet a host that would close the whole shift: protocol 7, `MIN_PROTOCOL_VERSION`
  stays 1 (devices of 1–6 keep working, older handhelds included). `releases.json` records 1.0.0 with protocol 6,
  and `releases.test.mjs` refuses a 1.0.0 build at protocol 7, so the build moves to 1.1.0 in the same commit
  (versions contract: `package.json`, `tauri.conf.json`, three crates, `Cargo.lock`). `releases.json` itself is
  untouched: the owner adds 1.1.0 when releasing. Fixtures: `hello*.json` → 7, `hello-future.json` → 8,
  `compatibility.json` gains client-7 cases.
- **D13. Line limit.** `maxStations` on `OfficeLine` and as an optional field of `LineUpdate`; administrators
  only (as every line write, spec §12.8); 1–16; lowering it below the busiest active shift's live slots is
  `409 conflict` `line_stations_in_use` `{ active }`; a change writes `line.max_stations_changed { from, to }`
  (and `line.update` only for name/archived). The feed's `lines` record is unchanged (devices read the limit as
  `maxStations` of an open shift and in `shift_line_full`).
- **D14. Device shift item.** For an open or closed shift: `maxStations`, `participants[]`, `myState` (absent when
  the caller never entered), `totals`, `byDevice[]`. A planned shift carries none of them, and an older host none
  at all (all optional), so existing fixtures stay valid as "a host before protocol 7".
- **D15. Office shift.** `participants[]`, `byDevice[]` (left out when empty: planned shifts) and
  `closeReasonMissing` (left out when false) in every answer of a shift, list included.
- **D16. Export instant.** `stationClosedAt` of the export source (ЧЗ `operation_date_time`) becomes the close
  of the device that closed the shift (`closed_by`), not the first accepted close: in a shared shift the first
  accepted close is an early part. An office-closed shift has none, as before.
- **D17. Joining is not opening.** Joining an open shift passes no license gate (`require_new_shifts` guards the
  opening only, spec «ЛЦ-2 §3.3»); license seats are unchanged.
- **D18. Out of scope here:** a timeout for `left` participants (§12.6, left open: the office closes), the cloud
  rule of §12.1, the station/office/handheld UIs, the print form text, the load harness (hooks listed below).

## File structure

| File                                                                                       | Responsibility                            | Tasks           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------- |
| `apps/standalone/host/migrations/0052_multi_station_shifts.sql` (new)                      | columns, backfill                         | 1               |
| `apps/standalone/host/tests/migration_multi_station.rs` (new)                              | migration test                            | 1               |
| `apps/standalone/proto/src/lib.rs`                                                         | wire types, capability, protocol constant | 2, 11, 14       |
| `apps/standalone/proto/fixtures/*.json` (new and changed)                                  | shared fixtures                           | 2, 3, 11, 14    |
| `apps/standalone/proto/tests/fixtures.rs`                                                  | Rust fixture parity                       | 2, 11, 14       |
| `apps/standalone/src/host/protocol.ts`, `apps/standalone/test/protocol.test.ts`            | Zod mirror and parity                     | 2, 11, 14       |
| `apps/standalone/host/src/shift_participants.rs` (new)                                     | participant rules and writers             | 3, 4            |
| `apps/standalone/host/src/shift_totals.rs` (new)                                           | totals queries                            | 4               |
| `apps/standalone/host/src/lib.rs`                                                          | module list                               | 3, 4            |
| `apps/standalone/host/src/routes/device_shifts.rs`                                         | list, enter, leave                        | 2, 5, 6, 7      |
| `apps/standalone/host/src/shifts.rs`                                                       | `line_full`, `stamp_revision`             | 6               |
| `apps/standalone/host/src/facts/mod.rs`, `facts/shift_closed.rs`                           | part close, auto close, late marks        | 8               |
| `apps/standalone/host/src/routes/office_shifts.rs`                                         | office shape, forced close, close reason  | 2, 9, 10        |
| `apps/standalone/host/src/routes/lines.rs`, `validate.rs`                                  | line limit                                | 11              |
| `apps/standalone/host/src/routes/office_exports.rs`                                        | export instant                            | 12              |
| `apps/standalone/host/src/audit.rs`                                                        | action names                              | 6, 7, 8, 10, 11 |
| `apps/standalone/host/src/device_kinds.rs`, `server.rs`                                    | route matrix, routes                      | 7, 10           |
| `apps/standalone/host/tests/support/multi.rs` (new), `tests/support/mod.rs`                | test helpers                              | 6               |
| `apps/standalone/host/tests/multi_station_*.rs`, `tests/shift_participants_store.rs` (new) | integration tests                         | 4–13            |
| version manifests, `apps/standalone/CHANGELOG.md`                                          | 1.1.0                                     | 14              |
| `apps/standalone/AGENTS.md`                                                                | docs                                      | 15              |

---

### Task 1: Migration `0052` and its schema test

**Files:**

- Create: `apps/standalone/host/migrations/0052_multi_station_shifts.sql`
- Test: `apps/standalone/host/tests/migration_multi_station.rs`
- Read for style (unchanged): `apps/standalone/host/migrations/0009_shifts_sscc_blocks.sql:20-80`, `0012_pallets.sql:40-46`, `0028_shift_planned_date.sql`, `apps/standalone/host/tests/migration_planned_date.rs`

**Interfaces:**

- Consumes: nothing.
- Produces (schema): `lines.max_stations INTEGER NOT NULL DEFAULT 1` (1–16); `shift_participants.state TEXT NOT NULL DEFAULT 'active'` (`active|left|closed`), `joined_at TEXT`, `left_at TEXT` (set exactly when `left`), `closed_at TEXT` (set exactly when `closed`), `closed_by_kind TEXT` (`device|office_user`, set exactly when `closed`), `closed_actual_qty INTEGER` (only with `device`), `closed_reason TEXT` (only with `device`), `late_data_at TEXT` (only when `closed`); `shifts.close_reason_missing INTEGER NOT NULL DEFAULT 0` (1 only for a closed shift without `close_reason_code`).

- [ ] **Step 1: Re-check the number.** Run `ls "$WT/apps/standalone/host/migrations" | tail -3`. Expected: the highest is `0051_warehouse_reprint_imported.sql`. If a higher one exists, use the next free number everywhere this plan says `0052`/`52`.

- [ ] **Step 2: Write the failing test** `apps/standalone/host/tests/migration_multi_station.rs`:

```rust
//! Migration `0052` (plan 2b): a line takes a limit of devices per shift (1 for every line already
//! there), a participant takes its own state (`active` in an open shift; `closed` with a closed
//! shift, by whoever closed it, with the figures of its own accepted close), and a shift takes a flag
//! for a reason its devices did not give. Columns only: every row stays.

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

const VERSION: i64 = 52;

type Participant = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
);

async fn migrated_from_51() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(&dir.path().join("host.db")).create_if_missing(true))
        .await
        .unwrap();
    let before = Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version < VERSION)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    for statement in [
        "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
        "INSERT INTO products (id, gtin14, name, rev) \
         VALUES ('product-1', '04600682000013', 'Молоко', 1)",
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('station-a', 'station', 'Станция А', 'hash-a', '1.0.0', 6, '2026-10-01T08:00:00Z')",
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('station-b', 'station', 'Станция Б', 'hash-b', '1.0.0', 6, '2026-10-01T08:00:00Z')",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, created_at, rev) VALUES ('shift-planned', 'OCT26', 1, 'office', \
         'office_user', 'user-1', 'planned', 'aggregation', 'product-1', 'line-1', '2026-10-08', \
         12, 'template-1', '2026-10-07T17:00:00Z', 1)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, created_at, rev) \
         VALUES ('shift-open', 'OCT26', 2, 'office', 'office_user', 'user-1', 'active', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-a', '2026-10-07T17:00:00Z', 2)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, closed_at, closed_by_kind, \
         closed_by, close_reason_code, created_at, rev) \
         VALUES ('shift-device', 'OCT26', 3, 'office', 'office_user', 'user-1', 'closed', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-a', '2026-10-08T14:00:00Z', 'device', 'station-a', \
         'equipment_stop', '2026-10-07T17:00:00Z', 3)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, closed_at, closed_by_kind, \
         closed_by, close_reason_text, created_at, rev) \
         VALUES ('shift-office', 'OCT26', 4, 'office', 'office_user', 'user-1', 'closed', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-b', '2026-10-08T16:00:00Z', 'office_user', 'user-1', \
         'Сбой', '2026-10-07T17:00:00Z', 4)",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-open', 'station-a', '2026-10-08T06:00:00Z', '2026-10-08T07:00:00Z')",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-device', 'station-a', '2026-10-08T06:00:00Z', '2026-10-08T06:00:00Z')",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-office', 'station-b', '2026-10-08T06:10:00Z', '2026-10-08T06:10:00Z')",
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES ('event-1', 'record-1', 'shift-device', 'station-a', NULL, 250, 249, \
         20, 'equipment_stop', '2026-10-08T14:00:00.000Z', 'accepted', '2026-10-08T14:00:05Z')",
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES ('event-2', 'record-2', 'shift-office', 'station-b', NULL, NULL, 10, \
         1, NULL, '2026-10-08T16:30:00.000Z', 'already_closed', '2026-10-08T16:30:05Z')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    MIGRATOR.run(&pool).await.unwrap();
    (dir, pool)
}

fn refused(result: Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error>) {
    let error = result.expect_err("the write was taken");
    assert!(error.to_string().contains("CHECK constraint failed"), "{error}");
}

#[tokio::test]
async fn existing_participants_take_the_state_of_their_shift() {
    let (_dir, pool) = migrated_from_51().await;
    let rows: Vec<Participant> = sqlx::query_as(
        "SELECT shift_id, device_id, state, joined_at, left_at, closed_at, closed_by_kind, \
         closed_actual_qty, closed_reason, late_data_at FROM shift_participants ORDER BY shift_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let at = |text: &str| Some(text.to_owned());
    assert_eq!(
        rows,
        vec![
            (
                "shift-device".to_owned(),
                "station-a".to_owned(),
                "closed".to_owned(),
                at("2026-10-08T06:00:00Z"),
                None,
                at("2026-10-08T14:00:00Z"),
                at("device"),
                Some(249),
                at("equipment_stop"),
                None,
            ),
            (
                "shift-office".to_owned(),
                "station-b".to_owned(),
                "closed".to_owned(),
                at("2026-10-08T06:10:00Z"),
                None,
                at("2026-10-08T16:00:00Z"),
                at("office_user"),
                None,
                None,
                None,
            ),
            (
                "shift-open".to_owned(),
                "station-a".to_owned(),
                "active".to_owned(),
                at("2026-10-08T06:00:00Z"),
                None,
                None,
                None,
                None,
                None,
                None,
            ),
        ]
    );
    let limits: Vec<i64> = sqlx::query_scalar("SELECT max_stations FROM lines")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(limits, [1]);
    let missing: Vec<i64> =
        sqlx::query_scalar("SELECT close_reason_missing FROM shifts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(missing, [0, 0, 0, 0]);
}

#[tokio::test]
async fn the_new_columns_refuse_what_no_row_may_hold() {
    let (_dir, pool) = migrated_from_51().await;
    let run = |sql: &'static str| sqlx::query(sql).execute(&pool);
    refused(run("UPDATE lines SET max_stations = 0").await);
    refused(run("UPDATE lines SET max_stations = 17").await);
    run("UPDATE lines SET max_stations = 16").await.unwrap();
    refused(run("UPDATE shift_participants SET state = 'paused' WHERE shift_id = 'shift-open'").await);
    refused(run("UPDATE shift_participants SET state = 'left' WHERE shift_id = 'shift-open'").await);
    run(
        "UPDATE shift_participants SET state = 'left', left_at = '2026-10-08T08:00:00Z' \
         WHERE shift_id = 'shift-open'",
    )
    .await
    .unwrap();
    refused(
        run("UPDATE shift_participants SET late_data_at = '2026-10-08T08:05:00Z' \
             WHERE shift_id = 'shift-open'")
        .await,
    );
    refused(
        run("UPDATE shift_participants SET closed_actual_qty = 5 WHERE shift_id = 'shift-office'")
            .await,
    );
    refused(run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-open'").await);
    refused(run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-device'").await);
    run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-office'")
        .await
        .unwrap();
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM shifts), (SELECT COUNT(*) FROM shift_participants)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (4, 3));
}
```

- [ ] **Step 3: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test migration_multi_station`
      Expected: FAIL, both tests panic with `no such column: state` (or `max_stations`).

- [ ] **Step 4: Write the migration** `apps/standalone/host/migrations/0052_multi_station_shifts.sql` (LF line endings; `.gitattributes` pins them):

```sql
-- Several devices in one shift of one line (plan 2b, spec
-- 2026-10-20-standalone-multi-station-shift-design.md §4.1). Columns only: no
-- table is rebuilt, so no rowid moves, no trigger is touched and the foreign
-- keys stay. SQLite tests the CHECK of an added column against every row
-- already there, so each column below is nullable or defaults to a value its
-- CHECK accepts, and the backfill runs after every column exists.

-- How many devices (stations and handhelds alike) may work one shift of the
-- line at a time. 1 keeps stage 2a's one device per shift.
ALTER TABLE lines ADD COLUMN max_stations INTEGER NOT NULL DEFAULT 1
  CHECK (max_stations BETWEEN 1 AND 16);

-- A participant's own part: `active` holds one of the line's slots, `left`
-- paused and freed it (it may come back), `closed` closed it for good.
ALTER TABLE shift_participants ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'left', 'closed'));
-- When the device last took a slot: its first entry, or its return from
-- `left`. Nullable only because an added NOT NULL column needs a constant
-- default; every writer sets it and readers fall back on first_entered_at.
ALTER TABLE shift_participants ADD COLUMN joined_at TEXT;
ALTER TABLE shift_participants ADD COLUMN left_at TEXT
  CHECK ((left_at IS NOT NULL) = (state = 'left'));
ALTER TABLE shift_participants ADD COLUMN closed_at TEXT
  CHECK ((closed_at IS NOT NULL) = (state = 'closed'));
-- Who closed the part: the device itself (its `shift_closed` fact) or the
-- office (its close of the whole shift).
ALTER TABLE shift_participants ADD COLUMN closed_by_kind TEXT
  CHECK ((closed_by_kind IS NULL AND state <> 'closed')
    OR (closed_by_kind IN ('device', 'office_user') AND state = 'closed'));
-- The device's own figures of its close, kept as evidence; the office closes
-- with none.
ALTER TABLE shift_participants ADD COLUMN closed_actual_qty INTEGER
  CHECK (closed_actual_qty IS NULL
    OR (closed_actual_qty >= 0 AND closed_by_kind = 'device'));
ALTER TABLE shift_participants ADD COLUMN closed_reason TEXT
  CHECK (closed_reason IS NULL OR closed_by_kind = 'device');
-- When the first fact of the device arrived after its part closed.
ALTER TABLE shift_participants ADD COLUMN late_data_at TEXT
  CHECK (late_data_at IS NULL OR state = 'closed');

-- A shared shift its last device closed without the reason the shift-wide
-- total needed (spec §12.9): it closes anyway, and the office gives the code.
ALTER TABLE shifts ADD COLUMN close_reason_missing INTEGER NOT NULL DEFAULT 0
  CHECK (close_reason_missing IN (0, 1))
  CHECK (close_reason_missing = 0 OR (status = 'closed' AND close_reason_code IS NULL));

-- The rows already there: one device per shift (stage 2a). Every participant
-- took its slot at its first entry. One of an open shift stays `active`; one
-- of a closed shift closed with it, by whoever closed the shift, with the
-- figures of its own accepted close when it sent one.
UPDATE shift_participants SET joined_at = first_entered_at;

UPDATE shift_participants SET
  state = 'closed',
  closed_at = (SELECT s.closed_at FROM shifts s WHERE s.id = shift_participants.shift_id),
  closed_by_kind = (SELECT CASE s.closed_by_kind WHEN 'device' THEN 'device' ELSE 'office_user' END
    FROM shifts s WHERE s.id = shift_participants.shift_id),
  closed_actual_qty = (SELECT e.actual_qty FROM shift_close_events e
    JOIN shifts s ON s.id = e.shift_id AND s.closed_by_kind = 'device'
    WHERE e.shift_id = shift_participants.shift_id
      AND e.device_id = shift_participants.device_id AND e.outcome = 'accepted'
    ORDER BY e.received_at, e.id LIMIT 1),
  closed_reason = (SELECT e.reason_code FROM shift_close_events e
    JOIN shifts s ON s.id = e.shift_id AND s.closed_by_kind = 'device'
    WHERE e.shift_id = shift_participants.shift_id
      AND e.device_id = shift_participants.device_id AND e.outcome = 'accepted'
    ORDER BY e.received_at, e.id LIMIT 1)
WHERE shift_id IN (SELECT id FROM shifts WHERE status = 'closed');
```

- [ ] **Step 5: Run the test to verify it passes.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test migration_multi_station`
      Expected: PASS (2 tests). Then run `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test foundation --test upgrade --test migration_conflict_review_order --test migration_validation_scans`. Expected: PASS (they read the migrator's list, never a fixed count).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/migrations/0052_multi_station_shifts.sql apps/standalone/host/tests/migration_multi_station.rs
git -C "$WT" commit -m "feat(standalone): host migration 0052 — line limit and participant state for multi-station shifts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire types of shared shifts (proto, Zod, fixtures)

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs:1897-1907` (`shift_supports`), insert after `:1966` (after `ShiftEnter`), `:1973-2023` (`OfficeShift`), insert after `:2168` (after `ShiftClose`), `:2176-2224` (`DeviceShift`)
- Modify: `apps/standalone/host/src/routes/device_shifts.rs:74-106` (`record`), `apps/standalone/host/src/routes/office_shifts.rs:154-198` (`record`) — compile only, fields empty
- Create fixtures: `apps/standalone/proto/fixtures/device-shifts-participants.json`, `office-shift-participants.json`, `error-shift-line-full.json`, `shift-enter-multi.json`, `shift-enter-handheld-multi.json`, `shift-close-reason-set.json`, `facts-response-part-close.json`
- Modify: `apps/standalone/proto/tests/fixtures.rs` (imports at `:1-30`, new tests at the end)
- Modify: `apps/standalone/src/host/protocol.ts:690-700` (before `officeLineSchema`), after `:1070` (after `shiftTotalsSchema`), `:1077-1106` (`officeShiftObject`), `:1391-1428` (`deviceShiftObject`), `:1471-1475` (`SHIFT_SUPPORTS`), after `:2083` (after `shiftCloseSchema`)
- Modify: `apps/standalone/test/protocol.test.ts:316-380` (`RESPONSES`), `:383-450` (`REQUESTS`), `:556-563` (supports), new `describe` at the end

**Interfaces:**

- Consumes: nothing.
- Produces (Rust, `markiro_proto`):
  - `pub mod shift_supports { pub const MULTI_STATION: &str = "multi-station-v1"; }`
  - `pub enum ParticipantState { Active, Left, Closed }` (snake_case; `as_str`, `FromStr`)
  - `pub enum ParticipantClosedBy { Device, OfficeUser }` (snake_case; `as_str`, `FromStr`)
  - `pub struct ShiftParticipant { device_id: String, device_kind: DeviceKind, device_name: String, state: ParticipantState, first_entered_at: String, joined_at: String, left_at: Option<String>, closed_at: Option<String>, closed_by: Option<ParticipantClosedBy>, closed_actual_qty: Option<u32>, closed_reason_code: Option<String>, late_data_at: Option<String>, last_seen_at: Option<String> }`
  - `pub struct DeviceTotals { device_id: String, accepted: u64, boxes_closed: u32, pallets: u32 }`
  - `pub struct DeviceShiftTotals { accepted: u64, boxes_closed: u32, pallets: u32, as_of: String }`
  - `DeviceShift` gains `max_stations: Option<u32>`, `participants: Option<Vec<ShiftParticipant>>`, `my_state: Option<ParticipantState>`, `totals: Option<DeviceShiftTotals>`, `by_device: Option<Vec<DeviceTotals>>` (all `skip_serializing_if = "Option::is_none"`)
  - `OfficeShift` gains `participants: Vec<ShiftParticipant>`, `by_device: Vec<DeviceTotals>` (skip when empty), `close_reason_missing: bool` (skip when false)
  - `pub struct ShiftCloseReasonSet { reason_code: String, expected_rev: i64 }` (`deny_unknown_fields`)
- Produces (TS): `participantStateSchema`, `shiftParticipantSchema`, `deviceTotalsSchema`, `deviceShiftTotalsSchema`, `MAX_STATIONS = 16`, `maxStationsSchema`, `shiftCloseReasonSetSchema`, `SHIFT_SUPPORTS.multiStation`.

- [ ] **Step 1: Write the fixtures.**

`apps/standalone/proto/fixtures/device-shifts-participants.json`:

```json
{
  "shifts": [
    {
      "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
      "number": "OCT26-004",
      "status": "active",
      "mode": "aggregation",
      "palletsEnabled": false,
      "createdFrom": "office",
      "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
      "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
      "productName": "Молоко 3,2% 0,9 л",
      "productGtin14": "04600682000013",
      "counterpartyName": "ООО «Северный берег»",
      "productionDate": "2026-10-08",
      "plannedDate": "2026-10-08",
      "plannedQty": 1200,
      "boxCapacity": 12,
      "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
      "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "openedAt": "2026-10-08T06:02:00Z",
      "closedAt": null,
      "maxStations": 2,
      "participants": [
        {
          "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          "deviceKind": "station",
          "deviceName": "Станция линии 1",
          "state": "active",
          "firstEnteredAt": "2026-10-08T06:02:00Z",
          "joinedAt": "2026-10-08T06:02:00Z",
          "leftAt": null,
          "closedAt": null,
          "closedBy": null,
          "closedActualQty": null,
          "closedReasonCode": null,
          "lateDataAt": null,
          "lastSeenAt": "2026-10-08T09:41:00Z"
        },
        {
          "deviceId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
          "deviceKind": "handheld",
          "deviceName": "ТСД 1",
          "state": "closed",
          "firstEnteredAt": "2026-10-08T06:30:00Z",
          "joinedAt": "2026-10-08T07:10:00Z",
          "leftAt": null,
          "closedAt": "2026-10-08T09:00:00Z",
          "closedBy": "device",
          "closedActualQty": 120,
          "closedReasonCode": null,
          "lateDataAt": "2026-10-08T09:05:00Z",
          "lastSeenAt": "2026-10-08T09:05:00Z"
        }
      ],
      "myState": "active",
      "totals": {
        "accepted": 547,
        "boxesClosed": 45,
        "pallets": 0,
        "asOf": "2026-10-08T09:41:07Z"
      },
      "byDevice": [
        {
          "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
          "accepted": 427,
          "boxesClosed": 35,
          "pallets": 0
        },
        {
          "deviceId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
          "accepted": 120,
          "boxesClosed": 10,
          "pallets": 0
        }
      ]
    }
  ]
}
```

`apps/standalone/proto/fixtures/office-shift-participants.json` (a shared shift its last device closed without the needed reason):

```json
{
  "id": "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
  "number": "OCT26-004",
  "status": "closed",
  "mode": "aggregation",
  "palletsEnabled": false,
  "createdFrom": "office",
  "productId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "lineId": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "counterpartyId": "d2b7c9e1-4f3a-4b6c-8d5e-9f0a1b2c3d4e",
  "productionDate": "2026-10-08",
  "plannedDate": "2026-10-08",
  "plannedQty": 1200,
  "boxCapacity": 12,
  "boxTemplateId": "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d",
  "palletBoxCapacity": null,
  "palletTemplateId": null,
  "palletSheetTemplateId": null,
  "ownerDeviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "openedAt": "2026-10-08T06:02:00Z",
  "closedAt": "2026-10-08T14:10:00Z",
  "closeReasonCode": null,
  "closeReasonText": null,
  "lateDataAt": null,
  "createdAt": "2026-10-07T15:30:00Z",
  "rev": 88,
  "totals": {
    "acceptedUnits": 547,
    "unitsInClosedBoxes": 540,
    "closedBoxes": 45,
    "openBoxes": 0,
    "lastFactAt": "2026-10-08T14:10:02Z",
    "deviceIds": ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"],
    "closedPallets": 0,
    "openPallets": 0
  },
  "participants": [
    {
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "deviceKind": "station",
      "deviceName": "Станция линии 1",
      "state": "closed",
      "firstEnteredAt": "2026-10-08T06:02:00Z",
      "joinedAt": "2026-10-08T06:02:00Z",
      "leftAt": null,
      "closedAt": "2026-10-08T14:10:00Z",
      "closedBy": "device",
      "closedActualQty": 427,
      "closedReasonCode": null,
      "lateDataAt": null,
      "lastSeenAt": "2026-10-08T14:10:02Z"
    },
    {
      "deviceId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
      "deviceKind": "handheld",
      "deviceName": "ТСД 1",
      "state": "closed",
      "firstEnteredAt": "2026-10-08T06:30:00Z",
      "joinedAt": "2026-10-08T06:30:00Z",
      "leftAt": null,
      "closedAt": "2026-10-08T13:00:00Z",
      "closedBy": "device",
      "closedActualQty": 120,
      "closedReasonCode": null,
      "lateDataAt": null,
      "lastSeenAt": "2026-10-08T13:00:01Z"
    }
  ],
  "byDevice": [
    {
      "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "accepted": 427,
      "boxesClosed": 35,
      "pallets": 0
    },
    {
      "deviceId": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
      "accepted": 120,
      "boxesClosed": 10,
      "pallets": 0
    }
  ],
  "closeReasonMissing": true
}
```

`apps/standalone/proto/fixtures/error-shift-line-full.json`:

```json
{
  "error": {
    "code": "conflict",
    "message": "every slot of this line is taken in this shift",
    "details": { "constraint": "shift_line_full", "maxStations": 2, "active": 2 }
  }
}
```

`apps/standalone/proto/fixtures/shift-enter-multi.json`:

```json
{ "supports": ["validation-v1", "validation-dm-duplicate-v1", "multi-station-v1"] }
```

`apps/standalone/proto/fixtures/shift-enter-handheld-multi.json`:

```json
{ "supports": ["handheld-host-v1", "multi-station-v1"] }
```

`apps/standalone/proto/fixtures/shift-close-reason-set.json`:

```json
{ "reasonCode": "equipment_stop", "expectedRev": 88 }
```

`apps/standalone/proto/fixtures/facts-response-part-close.json`:

```json
{
  "receipts": [
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "outcome": "accepted",
      "details": { "partClosed": true }
    },
    {
      "id": "00000000-0000-4000-8000-000000000003",
      "outcome": "accepted",
      "details": { "reasonMissing": true }
    }
  ]
}
```

- [ ] **Step 2: Write the failing Rust fixture tests.** Add to the `use markiro_proto::{…}` list of `apps/standalone/proto/tests/fixtures.rs` the names `DeviceShiftTotals, DeviceTotals, FactReceipts, ParticipantClosedBy, ParticipantState, ShiftCloseReasonSet, ShiftParticipant` (keep alphabetical order of the existing list; `codes`, `shift_close_reasons`, `shift_supports`, `DeviceKind`, `DeviceShifts`, `ErrorBody`, `OfficeShift`, `ShiftEnter` are imported already — add any that is not), then append:

```rust
#[test]
fn a_shared_shifts_participants_and_totals_round_trip_and_add_up() {
    let list: DeviceShifts = round_trip("device-shifts-participants.json");
    let shift = &list.shifts[0];
    let participants: &Vec<ShiftParticipant> =
        shift.participants.as_ref().expect("an open shift names its participants");
    let by_device: &Vec<DeviceTotals> = shift.by_device.as_ref().expect("and each device's part");
    let totals: &DeviceShiftTotals = shift.totals.as_ref().expect("and its totals");
    assert_eq!(
        by_device.iter().map(|part| part.accepted).sum::<u64>(),
        totals.accepted
    );
    assert_eq!(
        participants.iter().map(|p| &p.device_id).collect::<Vec<_>>(),
        by_device.iter().map(|part| &part.device_id).collect::<Vec<_>>()
    );
    assert_eq!(
        (shift.max_stations, shift.my_state),
        (Some(2), Some(ParticipantState::Active))
    );
    assert_eq!(
        (
            participants[1].device_kind,
            participants[1].state,
            participants[1].closed_by
        ),
        (
            DeviceKind::Handheld,
            ParticipantState::Closed,
            Some(ParticipantClosedBy::Device)
        )
    );
    // A host before protocol 7 names none of them.
    let old: DeviceShifts = serde_json::from_value(fixture("device-shifts.json")).unwrap();
    assert!(old.shifts.iter().all(|shift| shift.participants.is_none()
        && shift.totals.is_none()
        && shift.by_device.is_none()
        && shift.my_state.is_none()
        && shift.max_stations.is_none()));
    let office: OfficeShift = round_trip("office-shift-participants.json");
    assert!(office.close_reason_missing);
    assert_eq!(office.participants.len(), 2);
    assert_eq!(
        office.by_device.iter().map(|part| part.accepted).sum::<u64>(),
        office.totals.accepted_units
    );
    let legacy: OfficeShift = serde_json::from_value(fixture("office-shift.json")).unwrap();
    assert!(legacy.participants.is_empty() && legacy.by_device.is_empty());
    assert!(!legacy.close_reason_missing);
}

#[test]
fn the_multi_station_requests_refusals_and_receipts_round_trip() {
    let enter: ShiftEnter = round_trip("shift-enter-multi.json");
    assert!(enter
        .supports
        .iter()
        .any(|name| name == shift_supports::MULTI_STATION));
    let handheld: ShiftEnter = round_trip("shift-enter-handheld-multi.json");
    assert_eq!(
        handheld.supports,
        [shift_supports::HANDHELD_HOST, shift_supports::MULTI_STATION]
    );
    let set: ShiftCloseReasonSet = round_trip("shift-close-reason-set.json");
    assert!(shift_close_reasons::ALL.contains(&set.reason_code.as_str()));
    let mut extra = fixture("shift-close-reason-set.json");
    extra["reason"] = serde_json::json!("words");
    assert!(serde_json::from_value::<ShiftCloseReasonSet>(extra).is_err());
    let full: ErrorBody = round_trip("error-shift-line-full.json");
    let details = full.error.details.clone().expect("details");
    assert_eq!(
        (
            full.error.code.as_str(),
            details["constraint"].as_str(),
            details["maxStations"].as_u64(),
            details["active"].as_u64()
        ),
        (codes::CONFLICT, Some("shift_line_full"), Some(2), Some(2))
    );
    let receipts: FactReceipts = round_trip("facts-response-part-close.json");
    assert_eq!(receipts.receipts.len(), 2);
    for (name, state) in [
        ("active", ParticipantState::Active),
        ("left", ParticipantState::Left),
        ("closed", ParticipantState::Closed),
    ] {
        assert_eq!(name.parse::<ParticipantState>().unwrap(), state);
        assert_eq!(state.as_str(), name);
    }
    assert!("paused".parse::<ParticipantState>().is_err());
    assert_eq!(ParticipantClosedBy::OfficeUser.as_str(), "office_user");
}
```

- [ ] **Step 3: Run them to verify they fail.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures multi_station shared_shift`
      Expected: FAIL to compile: `unresolved imports markiro_proto::ParticipantState …`.

- [ ] **Step 4: Add the Rust types.** In `apps/standalone/proto/src/lib.rs`, inside `pub mod shift_supports` (after `HANDHELD_HOST`, `:1906`):

```rust
    /// Several devices in one shift (plan 2b, protocol 7): a device that names it joins an open
    /// shift another device works while its line has a free slot; one that does not still finds
    /// such a shift `shift_busy`, as every build before plan 2b expects.
    pub const MULTI_STATION: &str = "multi-station-v1";
```

After `pub struct ShiftEnter { … }` (`:1966`):

```rust
/// A device's part in a shift (plan 2b, protocol 7, host migration `0052`): `active` holds one of
/// its line's `maxStations` slots, `left` paused and freed it (it may enter again while a slot is
/// free), `closed` closed its part for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantState {
    Active,
    Left,
    Closed,
}

impl ParticipantState {
    pub fn as_str(self) -> &'static str {
        match self {
            ParticipantState::Active => "active",
            ParticipantState::Left => "left",
            ParticipantState::Closed => "closed",
        }
    }
}

impl std::str::FromStr for ParticipantState {
    type Err = UnknownVariant;

    /// The name [`ParticipantState::as_str`] gives, as `shift_participants.state` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("participant state", text)
    }
}

/// Who closed a participant's part: the device itself (its `shift_closed` fact) or the office
/// (its close of the whole shift).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParticipantClosedBy {
    Device,
    OfficeUser,
}

impl ParticipantClosedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            ParticipantClosedBy::Device => "device",
            ParticipantClosedBy::OfficeUser => "office_user",
        }
    }
}

impl std::str::FromStr for ParticipantClosedBy {
    type Err = UnknownVariant;

    /// The name [`ParticipantClosedBy::as_str`] gives, as `shift_participants.closed_by_kind`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("participant closed by", text)
    }
}

/// A device that entered a shift (plan 2b), as the shift's answers list it, first entry first:
/// its kind and name, its state, when it first entered and last took a slot, when it left or closed
/// and who closed it, the figures of its own close, when its first fact after that close arrived,
/// and when the host last heard from it (the office's «молчит» check).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftParticipant {
    pub device_id: String,
    pub device_kind: DeviceKind,
    pub device_name: String,
    pub state: ParticipantState,
    pub first_entered_at: String,
    pub joined_at: String,
    pub left_at: Option<String>,
    pub closed_at: Option<String>,
    pub closed_by: Option<ParticipantClosedBy>,
    pub closed_actual_qty: Option<u32>,
    pub closed_reason_code: Option<String>,
    pub late_data_at: Option<String>,
    pub last_seen_at: Option<String>,
}

/// One device's part of a shift's totals (plan 2b): units it accepted, its boxes closed and not
/// taken apart, its pallets closed and not taken apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTotals {
    pub device_id: String,
    pub accepted: u64,
    pub boxes_closed: u32,
    pub pallets: u32,
}

/// A shift's totals as a device reads them (plan 2b): the whole shift's accepted units, closed
/// boxes and closed pallets (none taken apart), read from the facts at `asOf`, the host's time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShiftTotals {
    pub accepted: u64,
    pub boxes_closed: u32,
    pub pallets: u32,
    pub as_of: String,
}
```

In `pub struct OfficeShift` after `pub totals: ShiftTotals,` (`:2022`):

```rust
    /// The devices that entered the shift, first entry first (plan 2b, protocol 7); left out for
    /// a planned shift and by a host before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub participants: Vec<ShiftParticipant>,
    /// Each participant's part of `totals` (plan 2b), in the order of `participants`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub by_device: Vec<DeviceTotals>,
    /// Its last device closed the shift without the reason the shift-wide total needed (plan 2b,
    /// spec §12.9); the office gives it (`PUT …/close-reason`). Left out when false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub close_reason_missing: bool,
```

After `pub struct ShiftClose { … }` (`:2168`):

```rust
/// `PUT /v1/office/shifts/{id}/close-reason` (plan 2b): the office gives one of the six reason
/// codes ([`shift_close_reasons`]) to a shift its devices closed without it, over `expectedRev`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftCloseReasonSet {
    pub reason_code: String,
    pub expected_rev: i64,
}
```

In `pub struct DeviceShift` between `pub closed_at: Option<String>,` and the `snapshot` field (`:2217-2219`):

```rust
    /// The line's limit of devices in one shift (plan 2b, protocol 7): only for an open or a
    /// closed shift; left out for a planned one and by a host before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_stations: Option<u32>,
    /// The devices that entered the shift, first entry first (plan 2b): open and closed shifts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub participants: Option<Vec<ShiftParticipant>>,
    /// The asking device's own state in the shift; left out when it never entered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub my_state: Option<ParticipantState>,
    /// The whole shift's totals as of the read (plan 2b): open and closed shifts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totals: Option<DeviceShiftTotals>,
    /// Each participant's part of `totals`, in the order of `participants`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_device: Option<Vec<DeviceTotals>>,
```

Also replace the doc of `owner_device_id` in `DeviceShift` (`:2212-2213`) with:

```rust
    /// The device that opened the shift (plan 2b: no special right; who works it is
    /// `participants`). A host before protocol 7 meant «busy» by another device's id here.
```

- [ ] **Step 5: Keep the host compiling.** In `apps/standalone/host/src/routes/device_shifts.rs` `record` (`:74-106`), after `snapshot: None,` add:

```rust
        max_stations: None,
        participants: None,
        my_state: None,
        totals: None,
        by_device: None,
```

In `apps/standalone/host/src/routes/office_shifts.rs` `record` (`:154-198`), after the `totals: ShiftTotals { … },` field add:

```rust
        participants: Vec::new(),
        by_device: Vec::new(),
        close_reason_missing: false,
```

- [ ] **Step 6: Run the Rust tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures`
      Expected: PASS (every fixture test, the two new ones included). Then `cargo --offline --locked build --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --tests`. Expected: builds.

- [ ] **Step 7: Write the failing Vitest parity.** In `apps/standalone/test/protocol.test.ts`, add to the import list from `../src/host/protocol.js` the names `MAX_STATIONS`, `shiftCloseReasonSetSchema` (others used below are imported already: `deviceShiftsSchema`, `officeShiftSchema`, `errorBodySchema`, `shiftEnterSchema`, `factReceiptsSchema`, `SHIFT_SUPPORTS`). Add to `RESPONSES` after `["device-shifts.json", deviceShiftsSchema],`:

```ts
  ["device-shifts-participants.json", deviceShiftsSchema],
  ["office-shift-participants.json", officeShiftSchema],
  ["error-shift-line-full.json", errorBodySchema],
  ["facts-response-part-close.json", factReceiptsSchema],
```

Add to `REQUESTS` after `["shift-enter-empty.json", shiftEnterSchema],`:

```ts
  ["shift-enter-multi.json", shiftEnterSchema],
  ["shift-enter-handheld-multi.json", shiftEnterSchema],
  ["shift-close-reason-set.json", shiftCloseReasonSetSchema],
```

Replace the expectation at `:559-563`:

```ts
expect(SHIFT_SUPPORTS).toStrictEqual({
  validation: "validation-v1",
  validationDmDuplicate: "validation-dm-duplicate-v1",
  handheldHost: "handheld-host-v1",
  multiStation: "multi-station-v1",
});
```

Append at the end of the file:

```ts
describe("several devices in one shift (plan 2b)", () => {
  it("reads a shared shift whose devices add up to its totals", () => {
    const [shift] = deviceShiftsSchema.parse(fixture("device-shifts-participants.json")).shifts;
    expect(shift).toBeDefined();
    const byDevice = shift?.byDevice ?? [];
    expect(byDevice.reduce((sum, part) => sum + part.accepted, 0)).toBe(shift?.totals?.accepted);
    expect(shift?.participants?.map((participant) => participant.deviceId)).toStrictEqual(
      byDevice.map((part) => part.deviceId),
    );
    expect(shift?.myState).toBe("active");
    expect(shift?.maxStations).toBe(2);
  });

  it("reads a shift of a host before protocol 7 without them", () => {
    const [old] = deviceShiftsSchema.parse(fixture("device-shifts.json")).shifts;
    expect(old?.participants).toBeUndefined();
    expect(old?.totals).toBeUndefined();
    expect(old?.byDevice).toBeUndefined();
    expect(
      officeShiftSchema.parse(fixture("office-shift.json")).closeReasonMissing,
    ).toBeUndefined();
  });

  it("bounds the line's limit and the participant's state like the host", () => {
    expect(MAX_STATIONS).toBe(16);
    const shift = fixture("device-shifts-participants.json") as {
      shifts: Record<string, unknown>[];
    };
    const first = shift.shifts[0] as Record<string, unknown>;
    for (const maxStations of [0, 17]) {
      expect(deviceShiftsSchema.safeParse({ shifts: [{ ...first, maxStations }] }).success).toBe(
        false,
      );
    }
    expect(
      deviceShiftsSchema.safeParse({ shifts: [{ ...first, myState: "paused" }] }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 8: Run it to verify it fails.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
      Expected: FAIL (`MAX_STATIONS` / `shiftCloseReasonSetSchema` are not exported; fixtures lose fields).

- [ ] **Step 9: Add the Zod mirror.** In `apps/standalone/src/host/protocol.ts`, immediately before the doc comment of `officeLineSchema` (`:693`):

```ts
/** The most devices one shift of a line takes at a time (plan 2b): the host's `0052` CHECK. */
export const MAX_STATIONS = 16;
/** A line's limit of devices in one shift, 1–`MAX_STATIONS`. */
export const maxStationsSchema = z.number().int().min(1).max(MAX_STATIONS);
```

After `export type ShiftTotals = …;` (`:1070`):

```ts
/**
 * A device's part in a shift (`markiro_proto::ParticipantState`, plan 2b, protocol 7): `active`
 * holds one of the line's slots, `left` paused and freed it, `closed` closed its part for good.
 */
export const participantStateSchema = z.enum(["active", "left", "closed"]);
export type ParticipantState = z.infer<typeof participantStateSchema>;

/** `markiro_proto::ShiftParticipant`: a device that entered the shift, first entry first. */
export const shiftParticipantSchema = z.object({
  deviceId: z.uuid(),
  deviceKind: deviceKindSchema,
  deviceName: z.string(),
  state: participantStateSchema,
  firstEnteredAt: z.iso.datetime(),
  joinedAt: z.iso.datetime(),
  leftAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedBy: z.enum(["device", "office_user"]).nullable(),
  closedActualQty: z.number().int().nonnegative().nullable(),
  closedReasonCode: z.string().nullable(),
  lateDataAt: z.iso.datetime().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type ShiftParticipant = z.infer<typeof shiftParticipantSchema>;

/** `markiro_proto::DeviceTotals`: one device's part of a shift's totals. */
export const deviceTotalsSchema = z.object({
  deviceId: z.uuid(),
  accepted: z.number().int().nonnegative(),
  boxesClosed: z.number().int().nonnegative(),
  pallets: z.number().int().nonnegative(),
});
export type DeviceTotals = z.infer<typeof deviceTotalsSchema>;

/** `markiro_proto::DeviceShiftTotals`: the whole shift's totals as of `asOf`, the host's time. */
export const deviceShiftTotalsSchema = z.object({
  accepted: z.number().int().nonnegative(),
  boxesClosed: z.number().int().nonnegative(),
  pallets: z.number().int().nonnegative(),
  asOf: z.iso.datetime(),
});
export type DeviceShiftTotals = z.infer<typeof deviceShiftTotalsSchema>;
```

In `officeShiftObject` after `totals: shiftTotalsSchema,` (`:1105`):

```ts
  /** The devices that entered the shift (plan 2b, protocol 7); left out for a planned shift and by an older host. */
  participants: z.array(shiftParticipantSchema).optional(),
  /** Each participant's part of `totals`, in the order of `participants`. */
  byDevice: z.array(deviceTotalsSchema).optional(),
  /** Its last device closed it without the reason the shared total needed; the office gives it. */
  closeReasonMissing: z.boolean().optional(),
```

In `deviceShiftObject` after `closedAt: z.iso.datetime().nullable(),` (`:1428`):

```ts
  /** The line's limit of devices in one shift (plan 2b, protocol 7): open and closed shifts only. */
  maxStations: maxStationsSchema.optional(),
  participants: z.array(shiftParticipantSchema).optional(),
  /** This device's own state; left out when it never entered. */
  myState: participantStateSchema.optional(),
  totals: deviceShiftTotalsSchema.optional(),
  byDevice: z.array(deviceTotalsSchema).optional(),
```

In `SHIFT_SUPPORTS` (`:1471-1475`) add the entry `multiStation: "multi-station-v1",` and extend its doc comment with: «`multiStation` (plan 2b, protocol 7): the device joins a shift another device works while the line has a free slot.»

After `export type ShiftClose = …;` (`:2083`):

```ts
/** `PUT /v1/office/shifts/{id}/close-reason` (plan 2b): one of the six codes, over the loaded revision. */
export const shiftCloseReasonSetSchema = z
  .object({ reasonCode: z.string(), expectedRev: z.number().int() })
  .strict();
export type ShiftCloseReasonSet = z.infer<typeof shiftCloseReasonSetSchema>;
```

- [ ] **Step 10: Run the Vitest parity and typecheck to verify they pass.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
      Expected: PASS. Then `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck` and `… lint`. Expected: no errors.

- [ ] **Step 11: Format and commit.**
      Run: `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check` and `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts apps/standalone/proto/fixtures/device-shifts-participants.json apps/standalone/proto/fixtures/office-shift-participants.json`. Expected: clean (run `prettier --write` on the listed files if not).

```bash
git -C "$WT" add apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs \
  apps/standalone/proto/fixtures/device-shifts-participants.json apps/standalone/proto/fixtures/office-shift-participants.json \
  apps/standalone/proto/fixtures/error-shift-line-full.json apps/standalone/proto/fixtures/shift-enter-multi.json \
  apps/standalone/proto/fixtures/shift-enter-handheld-multi.json apps/standalone/proto/fixtures/shift-close-reason-set.json \
  apps/standalone/proto/fixtures/facts-response-part-close.json \
  apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/routes/office_shifts.rs \
  apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts
git -C "$WT" commit -m "feat(standalone): wire types of shared shifts — participants, totals, multi-station-v1

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Participant rules (pure) and the shared reason fixture

**Files:**

- Create: `apps/standalone/host/src/shift_participants.rs` (rules part)
- Create: `apps/standalone/proto/fixtures/shift-close-reason-shared.json`
- Modify: `apps/standalone/host/src/lib.rs:36` (module list, before `pub mod shifts;`)

**Interfaces:**

- Consumes: `markiro_proto::ParticipantState` (Task 2); `crate::facts::rules::close_reason_required(planned_qty: Option<u32>, actual_qty: u32) -> bool` (`facts/rules.rs:109-111`).
- Produces:
  - `pub enum EntryDecision { Reenter, ReadClosed, Rejoin, Join, Busy, LineFull { max_stations: u32, active: u32 } }`
  - `pub fn decide_entry(current: Option<ParticipantState>, active_others: u32, max_stations: u32, multi_capable: bool) -> EntryDecision`
  - `pub enum CloseDecision { ClosePart { closes_shift: bool }, AlreadyClosed }`
  - `pub fn decide_close(current: ParticipantState, open_others: u32) -> CloseDecision`
  - `pub fn leaves(current: ParticipantState) -> bool`
  - `pub enum ReasonNeed { None, Required, Shared }`
  - `pub fn reason_need(closes_shift: bool, participants_ever: u32, fact_planned: Option<u32>, own_actual: u32, host_planned: Option<u32>, shift_accepted: u64) -> ReasonNeed`
  - fixture `shift-close-reason-shared.json`: `{ "cases": [{ closesShift, participantsEver, factPlanned, actualQty, hostPlanned, shiftAccepted, need: "none"|"required"|"shared" }] }`

- [ ] **Step 1: Write the fixture** `apps/standalone/proto/fixtures/shift-close-reason-shared.json`:

```json
{
  "cases": [
    {
      "closesShift": false,
      "participantsEver": 2,
      "factPlanned": 100,
      "actualQty": 40,
      "hostPlanned": 100,
      "shiftAccepted": 40,
      "need": "none"
    },
    {
      "closesShift": true,
      "participantsEver": 1,
      "factPlanned": 100,
      "actualQty": 99,
      "hostPlanned": 100,
      "shiftAccepted": 99,
      "need": "required"
    },
    {
      "closesShift": true,
      "participantsEver": 1,
      "factPlanned": 100,
      "actualQty": 100,
      "hostPlanned": 120,
      "shiftAccepted": 100,
      "need": "none"
    },
    {
      "closesShift": true,
      "participantsEver": 1,
      "factPlanned": null,
      "actualQty": 5,
      "hostPlanned": null,
      "shiftAccepted": 5,
      "need": "none"
    },
    {
      "closesShift": true,
      "participantsEver": 2,
      "factPlanned": 100,
      "actualQty": 40,
      "hostPlanned": 100,
      "shiftAccepted": 100,
      "need": "none"
    },
    {
      "closesShift": true,
      "participantsEver": 2,
      "factPlanned": 100,
      "actualQty": 40,
      "hostPlanned": 100,
      "shiftAccepted": 99,
      "need": "shared"
    },
    {
      "closesShift": true,
      "participantsEver": 3,
      "factPlanned": 100,
      "actualQty": 0,
      "hostPlanned": 120,
      "shiftAccepted": 100,
      "need": "shared"
    },
    {
      "closesShift": true,
      "participantsEver": 2,
      "factPlanned": null,
      "actualQty": 40,
      "hostPlanned": null,
      "shiftAccepted": 77,
      "need": "none"
    }
  ]
}
```

(The third case pins that a one-device shift judges by the plan the station saw, as stage 2a does, even after the office raised the plan.)

- [ ] **Step 2: Write the module with its failing tests.** Create `apps/standalone/host/src/shift_participants.rs` with the rules stubbed (`todo!()` bodies) and the tests:

```rust
//! A device's part in a shift (plan 2b; spec
//! `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §4.2; host
//! migration `0052`). The decisions are pure functions, pinned by the tests below and by
//! `proto/fixtures/shift-close-reason-shared.json`, which the station and the handheld read too.

use markiro_proto::ParticipantState;

use crate::facts::rules::close_reason_required;

/// What an entry into an OPEN shift does for a device (a planned shift's first entry opens it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryDecision {
    /// An active participant enters again: nothing changes but `last_entered_at`.
    Reenter,
    /// A participant that closed its part reads the shift back; nothing is written.
    ReadClosed,
    /// A participant that left takes a slot again.
    Rejoin,
    /// A new participant takes a slot.
    Join,
    /// A device that did not name `multi-station-v1` meets a shift another device works: stage
    /// 2a's `shift_busy`, which every older build shows as «занято».
    Busy,
    /// Every slot of the line's limit is held by another device (`shift_line_full`).
    LineFull { max_stations: u32, active: u32 },
}

/// The entry of a device whose state in the shift is `current` (`None`: it never entered), while
/// `active_others` other live devices hold a slot of a line that allows `max_stations`.
pub fn decide_entry(
    current: Option<ParticipantState>,
    active_others: u32,
    max_stations: u32,
    multi_capable: bool,
) -> EntryDecision {
    todo!()
}

/// What a participant's `shift_closed` does to an active shift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// The part closes, and the shift with it when `closes_shift`.
    ClosePart { closes_shift: bool },
    /// The part closed before: nothing more changes.
    AlreadyClosed,
}

/// The close of a participant in `current` state while `open_others` other participants are
/// active or left.
pub fn decide_close(current: ParticipantState, open_others: u32) -> CloseDecision {
    todo!()
}

/// Whether a leave changes anything: only an active participant leaves.
pub fn leaves(current: ParticipantState) -> bool {
    todo!()
}

/// Whether a participant's close needs a reason code (spec §4.2 «План и причина», §12.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasonNeed {
    /// No reason is needed; one sent is kept with the part.
    None,
    /// Stage 2a's rule, for a shift that only ever had this device: a close without the reason
    /// is refused (`invalid_record` on `data.reasonCode`), as the station decided it itself.
    Required,
    /// A shared shift's total missed the host's plan: a close without a reason still closes the
    /// shift, marked `close_reason_missing`, and the office gives the code.
    Shared,
}

/// The reason a close needs. `closes_shift`: no other participant stays active or left;
/// `participants_ever`: every participant the shift had, this one included; `fact_planned` and
/// `own_actual`: the plan the device saw and its own count; `host_planned`: the shift's plan on
/// the host now; `shift_accepted`: the whole shift's accepted units.
pub fn reason_need(
    closes_shift: bool,
    participants_ever: u32,
    fact_planned: Option<u32>,
    own_actual: u32,
    host_planned: Option<u32>,
    shift_accepted: u64,
) -> ReasonNeed {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use markiro_proto::ParticipantState::{Active, Closed, Left};

    #[test]
    fn an_entry_follows_the_state_the_slots_and_the_capability() {
        let cases = [
            ((None, 0, 1, true), EntryDecision::Join),
            ((None, 1, 2, true), EntryDecision::Join),
            (
                (None, 1, 1, true),
                EntryDecision::LineFull {
                    max_stations: 1,
                    active: 1,
                },
            ),
            ((None, 0, 1, false), EntryDecision::Busy),
            ((None, 0, 4, false), EntryDecision::Busy),
            ((Some(Active), 9, 1, false), EntryDecision::Reenter),
            ((Some(Closed), 0, 1, false), EntryDecision::ReadClosed),
            ((Some(Left), 0, 1, false), EntryDecision::Rejoin),
            (
                (Some(Left), 1, 1, true),
                EntryDecision::LineFull {
                    max_stations: 1,
                    active: 1,
                },
            ),
        ];
        for ((current, others, max, multi), expected) in cases {
            assert_eq!(
                decide_entry(current, others, max, multi),
                expected,
                "{current:?} {others} {max} {multi}"
            );
        }
    }

    #[test]
    fn a_close_closes_the_part_and_the_shift_only_with_nobody_else_open() {
        assert_eq!(
            decide_close(Active, 0),
            CloseDecision::ClosePart { closes_shift: true }
        );
        assert_eq!(
            decide_close(Active, 2),
            CloseDecision::ClosePart {
                closes_shift: false
            }
        );
        assert_eq!(
            decide_close(Left, 1),
            CloseDecision::ClosePart {
                closes_shift: false
            }
        );
        assert_eq!(decide_close(Closed, 0), CloseDecision::AlreadyClosed);
    }

    #[test]
    fn only_an_active_participant_leaves() {
        assert!(leaves(Active));
        assert!(!leaves(Left));
        assert!(!leaves(Closed));
    }

    #[test]
    fn the_reason_rule_is_the_shared_fixtures() {
        let file: serde_json::Value = serde_json::from_str(include_str!(
            "../../proto/fixtures/shift-close-reason-shared.json"
        ))
        .unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert!(cases.len() >= 8);
        let number = |value: &serde_json::Value| value.as_u64().map(|n| u32::try_from(n).unwrap());
        for case in cases {
            let expected = match case["need"].as_str().unwrap() {
                "none" => ReasonNeed::None,
                "required" => ReasonNeed::Required,
                "shared" => ReasonNeed::Shared,
                other => panic!("unknown need {other}"),
            };
            assert_eq!(
                reason_need(
                    case["closesShift"].as_bool().unwrap(),
                    number(&case["participantsEver"]).unwrap(),
                    number(&case["factPlanned"]),
                    number(&case["actualQty"]).unwrap(),
                    number(&case["hostPlanned"]),
                    case["shiftAccepted"].as_u64().unwrap(),
                ),
                expected,
                "{case}"
            );
        }
    }
}
```

In `apps/standalone/host/src/lib.rs`, before `pub mod shifts;` (`:36`), add `pub mod shift_participants;`.

- [ ] **Step 3: Run the tests to verify they fail.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --lib shift_participants`
      Expected: FAIL, four tests panic with `not yet implemented`.

- [ ] **Step 4: Implement the rules** (replace the four `todo!()` bodies):

```rust
pub fn decide_entry(
    current: Option<ParticipantState>,
    active_others: u32,
    max_stations: u32,
    multi_capable: bool,
) -> EntryDecision {
    match current {
        Some(ParticipantState::Active) => EntryDecision::Reenter,
        Some(ParticipantState::Closed) => EntryDecision::ReadClosed,
        None if !multi_capable => EntryDecision::Busy,
        Some(ParticipantState::Left) | None if active_others >= max_stations => {
            EntryDecision::LineFull {
                max_stations,
                active: active_others,
            }
        }
        Some(ParticipantState::Left) => EntryDecision::Rejoin,
        None => EntryDecision::Join,
    }
}

pub fn decide_close(current: ParticipantState, open_others: u32) -> CloseDecision {
    match current {
        ParticipantState::Closed => CloseDecision::AlreadyClosed,
        ParticipantState::Active | ParticipantState::Left => CloseDecision::ClosePart {
            closes_shift: open_others == 0,
        },
    }
}

pub fn leaves(current: ParticipantState) -> bool {
    current == ParticipantState::Active
}

pub fn reason_need(
    closes_shift: bool,
    participants_ever: u32,
    fact_planned: Option<u32>,
    own_actual: u32,
    host_planned: Option<u32>,
    shift_accepted: u64,
) -> ReasonNeed {
    if !closes_shift {
        return ReasonNeed::None;
    }
    if participants_ever <= 1 {
        return if close_reason_required(fact_planned, own_actual) {
            ReasonNeed::Required
        } else {
            ReasonNeed::None
        };
    }
    match host_planned {
        Some(planned) if u64::from(planned) != shift_accepted => ReasonNeed::Shared,
        _ => ReasonNeed::None,
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --lib shift_participants`
      Expected: PASS (4 tests). Run `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check`; expected clean.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/shift_participants.rs apps/standalone/host/src/lib.rs apps/standalone/proto/fixtures/shift-close-reason-shared.json
git -C "$WT" commit -m "feat(standalone): host rules of a device's part in a shift and the shared reason fixture

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Participant store and shift totals

**Files:**

- Modify: `apps/standalone/host/src/shift_participants.rs` (append the store functions above `#[cfg(test)]`)
- Create: `apps/standalone/host/src/shift_totals.rs`
- Modify: `apps/standalone/host/src/lib.rs` (add `pub mod shift_totals;` after `pub mod shift_participants;`)
- Test: `apps/standalone/host/tests/shift_participants_store.rs` (new)

**Interfaces:**

- Consumes: Task 1 schema; Task 2 `ShiftParticipant`, `DeviceTotals`, `DeviceShiftTotals`, `ParticipantClosedBy`; Task 3 module.
- Produces (all `pub async fn …(conn: &mut SqliteConnection, …) -> Result<_, ApiError>`):
  - `state_of(conn, shift_id: &str, device_id: &str) -> Option<ParticipantState>`
  - `active_others(conn, shift_id, device_id) -> u32` (active, device not revoked, other than `device_id`)
  - `open_others(conn, shift_id, device_id) -> u32` (active or left, other than `device_id`)
  - `count_all(conn, shift_id) -> u32`
  - `join(conn, shift_id, device_id, at: &str) -> ()`, `rejoin(…, at) -> ()`, `touch(…, at) -> ()`, `leave(…, at) -> ()`
  - `close_by_device(conn, shift_id, device_id, closed_at: &str, actual_qty: u32, reason_code: Option<&str>) -> ()`
  - `close_open_by_office(conn, shift_id, at) -> Vec<(String, ParticipantState)>` (the parts it closed, first entry first)
  - `mark_late(conn, shift_id, device_id, at) -> bool`
  - `line_slots_in_use(conn, line_id) -> u32`
  - `list(conn, shift_id) -> Vec<ShiftParticipant>`
  - `shift_totals::totals(conn, shift_id, as_of: &str) -> DeviceShiftTotals`, `shift_totals::shift_accepted(conn, shift_id) -> u64`, `shift_totals::by_device(conn, shift_id) -> Vec<DeviceTotals>`; consts `SHIFT_TOTALS`, `BY_DEVICE`

- [ ] **Step 1: Write the failing integration test** `apps/standalone/host/tests/shift_participants_store.rs`:

```rust
//! The participant store and the shift totals (plan 2b): states move only along their rules, a
//! revoked device holds no slot, the office closes whatever is open, and the totals are the facts'.

mod support;

use markiro_host::{shift_participants as participants, shift_totals};
use markiro_proto::{DeviceKind, ParticipantClosedBy, ParticipantState};
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, open_floor, pair_device, receipts,
    record_id, shift_setup,
};

#[tokio::test]
async fn a_participants_state_moves_along_its_rules() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let opened = admin.app.state.timestamp();
    let (other, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let shift = floor.shift.as_str();
    assert_eq!(
        participants::state_of(&mut conn, shift, &floor.station).await.unwrap(),
        Some(ParticipantState::Active)
    );
    assert_eq!(participants::state_of(&mut conn, shift, &other).await.unwrap(), None);
    assert_eq!(participants::active_others(&mut conn, shift, &other).await.unwrap(), 1);
    participants::join(&mut conn, shift, &other, "2026-10-08T07:00:00Z").await.unwrap();
    assert_eq!(participants::count_all(&mut conn, shift).await.unwrap(), 2);
    assert_eq!(
        participants::active_others(&mut conn, shift, &floor.station).await.unwrap(),
        1
    );
    participants::leave(&mut conn, shift, &other, "2026-10-08T07:30:00Z").await.unwrap();
    assert_eq!(
        participants::active_others(&mut conn, shift, &floor.station).await.unwrap(),
        0
    );
    assert_eq!(
        participants::open_others(&mut conn, shift, &floor.station).await.unwrap(),
        1
    );
    // A second leave finds no active part: the writer refuses rather than invent one.
    assert!(participants::leave(&mut conn, shift, &other, "2026-10-08T07:31:00Z")
        .await
        .is_err());
    participants::rejoin(&mut conn, shift, &other, "2026-10-08T08:00:00Z").await.unwrap();
    participants::close_by_device(
        &mut conn,
        shift,
        &other,
        "2026-10-08T09:00:00Z",
        12,
        Some("equipment_stop"),
    )
    .await
    .unwrap();
    assert!(participants::mark_late(&mut conn, shift, &other, "2026-10-08T09:05:00Z")
        .await
        .unwrap());
    assert!(!participants::mark_late(&mut conn, shift, &other, "2026-10-08T09:06:00Z")
        .await
        .unwrap());
    assert!(
        !participants::mark_late(&mut conn, shift, &floor.station, "2026-10-08T09:06:00Z")
            .await
            .unwrap()
    );
    let list = participants::list(&mut conn, shift).await.unwrap();
    assert_eq!(list.len(), 2);
    let (first, second) = (&list[0], &list[1]);
    assert_eq!(
        (
            first.device_id.as_str(),
            first.device_kind,
            first.state,
            first.first_entered_at.as_str(),
            first.joined_at.as_str()
        ),
        (
            floor.station.as_str(),
            DeviceKind::Station,
            ParticipantState::Active,
            opened.as_str(),
            opened.as_str()
        )
    );
    assert_eq!(
        (
            second.device_id.as_str(),
            second.device_name.as_str(),
            second.state,
            second.first_entered_at.as_str(),
            second.joined_at.as_str(),
            second.left_at.as_deref(),
            second.closed_at.as_deref(),
            second.closed_by,
            second.closed_actual_qty,
            second.closed_reason_code.as_deref(),
            second.late_data_at.as_deref()
        ),
        (
            other.as_str(),
            "Тестовое устройство",
            ParticipantState::Closed,
            "2026-10-08T07:00:00Z",
            "2026-10-08T08:00:00Z",
            None,
            Some("2026-10-08T09:00:00Z"),
            Some(ParticipantClosedBy::Device),
            Some(12),
            Some("equipment_stop"),
            Some("2026-10-08T09:05:00Z")
        )
    );
    assert_eq!(
        participants::line_slots_in_use(&mut conn, &setup.line).await.unwrap(),
        1
    );
    let closed = participants::close_open_by_office(&mut conn, shift, "2026-10-08T10:00:00Z")
        .await
        .unwrap();
    assert_eq!(closed, vec![(floor.station.clone(), ParticipantState::Active)]);
    let list = participants::list(&mut conn, shift).await.unwrap();
    assert_eq!(
        (list[0].state, list[0].closed_by, list[0].closed_actual_qty),
        (
            ParticipantState::Closed,
            Some(ParticipantClosedBy::OfficeUser),
            None
        )
    );
    assert!(participants::close_open_by_office(&mut conn, shift, "2026-10-08T10:01:00Z")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn a_revoked_device_holds_no_slot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, _) = pair_device(&admin.app, "station").await;
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    participants::join(&mut conn, &floor.shift, &other, "2026-10-08T07:00:00Z").await.unwrap();
    sqlx::query("UPDATE devices SET revoked_at = '2026-10-08T07:10:00Z' WHERE id = ?")
        .bind(&other)
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        participants::active_others(&mut conn, &floor.shift, &floor.station).await.unwrap(),
        0
    );
    // Its part is still open: only the office closes it.
    assert_eq!(
        participants::open_others(&mut conn, &floor.shift, &floor.station).await.unwrap(),
        1
    );
}

#[tokio::test]
async fn the_totals_are_the_facts_of_the_whole_shift_and_of_each_device() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (other, other_key) = pair_device(&admin.app, "station").await;
    {
        let mut conn = admin.app.state.pool.acquire().await.unwrap();
        participants::join(&mut conn, &floor.shift, &other, "2026-10-08T07:00:00Z")
            .await
            .unwrap();
    }
    let scan = |n: u32, record: u32, box_n: u32| {
        fact(
            &record_id(record),
            "scan",
            &floor.shift,
            ok_scan(n, &box_id(box_n), &instant(n, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(1, 1, 1), scan(2, 2, 1)]).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(
        receipts(&admin.app, &other_key, &[scan(3, 1, 2)]).await,
        vec![accepted(&record_id(1))]
    );
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let totals = shift_totals::totals(&mut conn, &floor.shift, "2026-10-08T07:30:00Z")
        .await
        .unwrap();
    assert_eq!(
        (totals.accepted, totals.boxes_closed, totals.pallets, totals.as_of.as_str()),
        (3, 0, 0, "2026-10-08T07:30:00Z")
    );
    assert_eq!(
        shift_totals::shift_accepted(&mut conn, &floor.shift).await.unwrap(),
        3
    );
    let parts: Vec<(String, u64, u32, u32)> = shift_totals::by_device(&mut conn, &floor.shift)
        .await
        .unwrap()
        .into_iter()
        .map(|part| (part.device_id, part.accepted, part.boxes_closed, part.pallets))
        .collect();
    assert_eq!(
        parts,
        vec![(floor.station.clone(), 2, 0, 0), (other.clone(), 1, 0, 0)]
    );
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test shift_participants_store`
      Expected: FAIL to compile (`cannot find function state_of in module participants`, `unresolved import shift_totals`).

- [ ] **Step 3: Append the store** to `apps/standalone/host/src/shift_participants.rs` (above `#[cfg(test)]`; extend the header doc with "The functions after the rules are the only writers of `shift_participants`' state columns; every caller runs inside its own write transaction and stamps the shift's `rev` with its revision."), and change the imports at the top to:

```rust
use markiro_proto::{DeviceKind, ParticipantClosedBy, ParticipantState, ShiftParticipant};
use sqlx::sqlite::SqliteQueryResult;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::facts::rules::close_reason_required;
```

```rust
/// The state of `device_id` in `shift_id`; `None` when it never entered.
pub async fn state_of(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<Option<ParticipantState>, ApiError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state FROM shift_participants WHERE shift_id = ? AND device_id = ?",
    )
    .bind(shift_id)
    .bind(device_id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    state
        .map(|state| state.parse().map_err(ApiError::internal))
        .transpose()
}

async fn count(
    conn: &mut SqliteConnection,
    sql: &str,
    first: &str,
    second: Option<&str>,
) -> Result<u32, ApiError> {
    let mut query = sqlx::query_scalar::<_, i64>(sql).bind(first);
    if let Some(second) = second {
        query = query.bind(second);
    }
    let count = query.fetch_one(conn).await.map_err(ApiError::internal)?;
    u32::try_from(count).map_err(ApiError::internal)
}

/// How many devices other than `device_id` hold a slot of the shift: active participants whose
/// device is not revoked (a revoked device's slot is free, spec §12.5).
pub async fn active_others(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants p JOIN devices d ON d.id = p.device_id \
         WHERE p.shift_id = ? AND p.device_id <> ? AND p.state = 'active' \
         AND d.revoked_at IS NULL",
        shift_id,
        Some(device_id),
    )
    .await
}

/// How many participants other than `device_id` have not closed their part (active or left,
/// revoked or not: a revoked device's part closes only with the office's close).
pub async fn open_others(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants \
         WHERE shift_id = ? AND device_id <> ? AND state IN ('active', 'left')",
        shift_id,
        Some(device_id),
    )
    .await
}

/// Every participant the shift ever had.
pub async fn count_all(conn: &mut SqliteConnection, shift_id: &str) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?",
        shift_id,
        None,
    )
    .await
}

/// The busiest active shift of `line_id`: its slots held by live devices (a lower limit must
/// leave room for them, `routes/lines.rs`).
pub async fn line_slots_in_use(
    conn: &mut SqliteConnection,
    line_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM shifts s \
         JOIN shift_participants p ON p.shift_id = s.id JOIN devices d ON d.id = p.device_id \
         WHERE s.line_id = ? AND s.status = 'active' AND p.state = 'active' \
         AND d.revoked_at IS NULL GROUP BY s.id)",
        line_id,
        None,
    )
    .await
}

/// A writer that must change exactly one participant: anything else means the state moved
/// under it inside its own transaction, which no request can cause.
fn one_row(result: SqliteQueryResult, what: &str) -> Result<(), ApiError> {
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ApiError::internal(format!(
            "{what}: no participant in the expected state"
        )))
    }
}

/// A new participant takes a slot at `at`.
pub async fn join(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, \
         last_entered_at, state, joined_at) VALUES (?, ?, ?, ?, 'active', ?)",
    )
    .bind(shift_id)
    .bind(device_id)
    .bind(at)
    .bind(at)
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "join")
}

/// A participant that left takes a slot again.
pub async fn rejoin(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'active', left_at = NULL, joined_at = ?, \
         last_entered_at = ? WHERE shift_id = ? AND device_id = ? AND state = 'left'",
    )
    .bind(at)
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "rejoin")
}

/// An active participant enters again.
pub async fn touch(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET last_entered_at = ? \
         WHERE shift_id = ? AND device_id = ? AND state = 'active'",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "touch")
}

/// An active participant pauses and frees its slot.
pub async fn leave(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'left', left_at = ? \
         WHERE shift_id = ? AND device_id = ? AND state = 'active'",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "leave")
}

/// A participant's own close of its part (its `shift_closed` fact), with its count and reason.
pub async fn close_by_device(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    closed_at: &str,
    actual_qty: u32,
    reason_code: Option<&str>,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'closed', left_at = NULL, closed_at = ?, \
         closed_by_kind = 'device', closed_actual_qty = ?, closed_reason = ? \
         WHERE shift_id = ? AND device_id = ? AND state IN ('active', 'left')",
    )
    .bind(closed_at)
    .bind(actual_qty)
    .bind(reason_code)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "close_by_device")
}

/// The office's close of the whole shift closes every part still open; returns those parts as
/// they were, first entry first (the `notClosed` of `shift.force_closed`).
pub async fn close_open_by_office(
    conn: &mut SqliteConnection,
    shift_id: &str,
    at: &str,
) -> Result<Vec<(String, ParticipantState)>, ApiError> {
    let open: Vec<(String, String)> = sqlx::query_as(
        "SELECT device_id, state FROM shift_participants \
         WHERE shift_id = ? AND state IN ('active', 'left') ORDER BY first_entered_at, device_id",
    )
    .bind(shift_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shift_participants SET state = 'closed', left_at = NULL, closed_at = ?, \
         closed_by_kind = 'office_user' WHERE shift_id = ? AND state IN ('active', 'left')",
    )
    .bind(at)
    .bind(shift_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    open.into_iter()
        .map(|(device_id, state)| Ok((device_id, state.parse().map_err(ApiError::internal)?)))
        .collect()
}

/// The first fact of a closed part marks it late, once; whether this call marked it.
pub async fn mark_late(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET late_data_at = ? WHERE shift_id = ? AND device_id = ? \
         AND state = 'closed' AND late_data_at IS NULL",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(result.rows_affected() == 1)
}

#[derive(sqlx::FromRow)]
struct ParticipantRow {
    device_id: String,
    kind: String,
    name: String,
    state: String,
    first_entered_at: String,
    joined_at: String,
    left_at: Option<String>,
    closed_at: Option<String>,
    closed_by_kind: Option<String>,
    closed_actual_qty: Option<u32>,
    closed_reason: Option<String>,
    late_data_at: Option<String>,
    last_seen_at: Option<String>,
}

/// The shift's participants, first entry first (ties by device id).
pub async fn list(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<ShiftParticipant>, ApiError> {
    let rows: Vec<ParticipantRow> = sqlx::query_as(
        "SELECT p.device_id, d.kind, d.name, p.state, p.first_entered_at, \
         COALESCE(p.joined_at, p.first_entered_at) AS joined_at, p.left_at, p.closed_at, \
         p.closed_by_kind, p.closed_actual_qty, p.closed_reason, p.late_data_at, d.last_seen_at \
         FROM shift_participants p JOIN devices d ON d.id = p.device_id \
         WHERE p.shift_id = ? ORDER BY p.first_entered_at, p.device_id",
    )
    .bind(shift_id)
    .fetch_all(conn)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|row| {
            let device_kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
            let closed_by: Option<ParticipantClosedBy> = row
                .closed_by_kind
                .map(|kind| kind.parse().map_err(ApiError::internal))
                .transpose()?;
            Ok(ShiftParticipant {
                device_id: row.device_id,
                device_kind,
                device_name: row.name,
                state: row.state.parse().map_err(ApiError::internal)?,
                first_entered_at: row.first_entered_at,
                joined_at: row.joined_at,
                left_at: row.left_at,
                closed_at: row.closed_at,
                closed_by,
                closed_actual_qty: row.closed_actual_qty,
                closed_reason_code: row.closed_reason,
                late_data_at: row.late_data_at,
                last_seen_at: row.last_seen_at,
            })
        })
        .collect()
}
```

- [ ] **Step 4: Create** `apps/standalone/host/src/shift_totals.rs`:

```rust
//! What a shift and each of its devices add up to (plan 2b, spec §4.1 «Не добавляем
//! столбцов-счётчиков», §4.2 «Итоги станциям»): read from the facts at every answer, never stored.
//! The rules are the office's (`routes/office_shifts.rs`, `SELECT`): a unit accepted is a live item
//! of one of the shift's boxes (a validation shift: a code it owns without a box), a box closed is
//! closed and not taken apart, a pallet likewise. A box or a pallet is its device's
//! (`boxes.device_id`, `pallets.device_id`), a validation unit its owning scan's
//! (`code_owners.device_id`). Every read searches `boxes_shift`, `box_items_live`, `pallets_shift`
//! or `code_owners_shift_unboxed` (the test below pins the plan); no index is added.

use markiro_proto::{DeviceShiftTotals, DeviceTotals};
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// The whole shift's accepted units, closed boxes and closed pallets.
pub const SHIFT_TOTALS: &str = "SELECT \
     CASE s.mode WHEN 'validation' \
      THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = s.id AND o.box_id IS NULL) \
      ELSE (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
            WHERE b.shift_id = s.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      END AS accepted, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = s.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes_closed, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = s.id \
      AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL) AS pallets \
     FROM shifts s WHERE s.id = ?";

/// The same per participant, first entry first; a participant with nothing counts zeros.
pub const BY_DEVICE: &str = "SELECT p.device_id, \
     CASE s.mode WHEN 'validation' \
      THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = p.shift_id \
            AND o.box_id IS NULL AND o.device_id = p.device_id) \
      ELSE (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
            WHERE b.shift_id = p.shift_id AND b.device_id = p.device_id \
            AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      END AS accepted, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = p.shift_id AND b.device_id = p.device_id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes_closed, \
     (SELECT COUNT(*) FROM pallets q WHERE q.shift_id = p.shift_id \
      AND q.device_id = p.device_id \
      AND q.closed_at IS NOT NULL AND q.disassembled_at IS NULL) AS pallets \
     FROM shift_participants p JOIN shifts s ON s.id = p.shift_id \
     WHERE p.shift_id = ? ORDER BY p.first_entered_at, p.device_id";

fn count<T: TryFrom<i64>>(value: i64) -> Result<T, ApiError>
where
    T::Error: std::fmt::Display,
{
    T::try_from(value).map_err(ApiError::internal)
}

async fn counts(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<(u64, u32, u32), ApiError> {
    let (accepted, boxes_closed, pallets): (i64, i64, i64) = sqlx::query_as(SHIFT_TOTALS)
        .bind(shift_id)
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok((count(accepted)?, count(boxes_closed)?, count(pallets)?))
}

/// The whole shift's totals as of `as_of` (the host's time of the read).
pub async fn totals(
    conn: &mut SqliteConnection,
    shift_id: &str,
    as_of: &str,
) -> Result<DeviceShiftTotals, ApiError> {
    let (accepted, boxes_closed, pallets) = counts(conn, shift_id).await?;
    Ok(DeviceShiftTotals {
        accepted,
        boxes_closed,
        pallets,
        as_of: as_of.to_owned(),
    })
}

/// The whole shift's accepted units: what a shared shift's plan is judged by.
pub async fn shift_accepted(conn: &mut SqliteConnection, shift_id: &str) -> Result<u64, ApiError> {
    Ok(counts(conn, shift_id).await?.0)
}

/// Each participant's part, first entry first.
pub async fn by_device(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<DeviceTotals>, ApiError> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(BY_DEVICE)
        .bind(shift_id)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|(device_id, accepted, boxes_closed, pallets)| {
            Ok(DeviceTotals {
                device_id,
                accepted: count(accepted)?,
                boxes_closed: count(boxes_closed)?,
                pallets: count(pallets)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    /// The plan SQLite makes of `sql`, one line a step.
    async fn plan(sql: &str) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
            .bind("00000000-0000-4000-8000-000000000000")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect()
    }

    /// Every total searches the shift's indexes and scans no table: the reads run on every
    /// device's list and on every close of a shared shift.
    #[tokio::test]
    async fn the_totals_search_the_shifts_indexes_and_scan_nothing() {
        for sql in [super::SHIFT_TOTALS, super::BY_DEVICE] {
            let plan = plan(sql).await;
            let scans: Vec<&String> = plan.iter().filter(|line| line.starts_with("SCAN")).collect();
            assert!(scans.is_empty(), "{scans:?} in {plan:#?}");
            for index in [
                "boxes_shift",
                "box_items_live",
                "pallets_shift",
                "code_owners_shift_unboxed",
            ] {
                assert!(
                    plan.iter().any(|line| line.contains(index)),
                    "{index} not used: {plan:#?}"
                );
            }
        }
    }
}
```

Add `pub mod shift_totals;` to `apps/standalone/host/src/lib.rs` after `pub mod shift_participants;`.

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test shift_participants_store` and `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --lib shift_totals shift_participants`
      Expected: PASS. If the query-plan test reports another index or a `SCAN`, do not add an index silently: record the actual plan lines in the report and ask the controller (an extra index changes the office's pinned plans in `routes/office_shifts.rs:933-1015`).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/shift_participants.rs apps/standalone/host/src/shift_totals.rs apps/standalone/host/src/lib.rs apps/standalone/host/tests/shift_participants_store.rs
git -C "$WT" commit -m "feat(standalone): host participant store and shift totals read from the facts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Device shift answers carry participation and totals

**Files:**

- Modify: `apps/standalone/host/src/routes/device_shifts.rs:10-27` (imports), `:31-43` (`SELECT`), `:45-72` (`ShiftRow`), `:74-106` (`record`), `:137-167` (`list_device_shifts`), `:495-497` and `:584-586` (the two reads of `enter_shift`)
- Test: `apps/standalone/host/tests/multi_station_lists.rs` (new)

**Interfaces:**

- Consumes: Task 4 `shift_participants::list`, `shift_totals::{totals, by_device}`.
- Produces: `async fn with_participation(conn: &mut SqliteConnection, shift: DeviceShift, device_id: &str, as_of: &str) -> Result<DeviceShift, ApiError>`; `async fn read_for(conn: &mut SqliteConnection, id: &str, device_id: &str, as_of: &str) -> Result<DeviceShift, ApiError>` (both private to `device_shifts.rs`, used by Tasks 6–7). Wire: an open or closed shift in `GET /v1/device/shifts` and in the answer of `POST …/enter` carries `maxStations`, `participants`, `myState` (when the caller entered), `totals`, `byDevice`; a planned one none.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_lists.rs`:

```rust
//! A device's shift answers (plan 2b, spec §4.2 «Итоги станциям»): an open shift names the line's
//! limit, its participants, the asking device's state, the whole shift's totals as of the read and
//! each device's part; a planned shift names none of them.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_id, empty, fact, instant, json as json_request, ok_scan, open_floor,
    plan_shift, receipts, record_id, request, shift_body, shift_setup, with_device,
};

#[tokio::test]
async fn an_open_shift_lists_its_participants_and_totals_and_a_planned_one_none() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(1, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let (status, list) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device/shifts"), &floor.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let shifts = list["shifts"].as_array().unwrap();
    let open = shifts
        .iter()
        .find(|shift| shift["id"] == json!(floor.shift))
        .unwrap();
    assert_eq!(open["maxStations"], json!(1));
    assert_eq!(open["myState"], json!("active"));
    assert_eq!(
        open["totals"],
        json!({ "accepted": 1, "boxesClosed": 0, "pallets": 0, "asOf": at })
    );
    assert_eq!(
        open["byDevice"],
        json!([{ "deviceId": floor.station, "accepted": 1, "boxesClosed": 0, "pallets": 0 }])
    );
    let participants = open["participants"].as_array().unwrap();
    assert_eq!(participants.len(), 1);
    let me = &participants[0];
    assert_eq!(
        [
            "deviceId", "deviceKind", "deviceName", "state", "firstEnteredAt", "joinedAt",
            "leftAt", "closedAt", "closedBy", "closedActualQty", "closedReasonCode", "lateDataAt",
            "lastSeenAt"
        ]
        .map(|key| me[key].clone()),
        [
            json!(floor.station),
            json!("station"),
            json!("Тестовое устройство"),
            json!("active"),
            json!(at),
            json!(at),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            json!(at)
        ]
    );
    let plan = shifts
        .iter()
        .find(|shift| shift["id"] == planned["id"])
        .unwrap();
    for key in ["maxStations", "participants", "myState", "totals", "byDevice"] {
        assert!(plan.get(key).is_none(), "{key}: {plan}");
    }
    // The owner's entry again answers the same participation, with the snapshot.
    let (status, entered) = admin
        .app
        .send(json_request(
            with_device(
                request("POST", &format!("/v1/device/shifts/{}/enter", floor.shift)),
                &floor.key,
            ),
            json!({}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered["snapshot"].is_object());
    for key in ["maxStations", "participants", "myState", "totals", "byDevice"] {
        assert_eq!(entered[key], open[key], "{key}");
    }
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_lists`
      Expected: FAIL: `assertion left == right failed` on `open["maxStations"]` (`null` vs `1`).

- [ ] **Step 3: Implement.** In `device_shifts.rs` imports add:

```rust
use crate::shift_participants;
use crate::shift_totals;
```

Change the end of `SELECT` (`:41-43`) to read the line's limit:

```rust
     s.validation_print_verification, s.validation_print_template_id, s.owner_device_id, \
     s.opened_at, s.closed_at, l.max_stations \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     JOIN lines l ON l.id = s.line_id \
     LEFT JOIN counterparties c ON c.id = s.counterparty_id";
```

Add to `ShiftRow` after `closed_at: Option<String>,`:

```rust
    /// The line's limit of devices in one shift (plan 2b).
    max_stations: u32,
```

In `record`, parse the status once and set the limit for an open or closed shift — replace `status: row.status.parse().map_err(ApiError::internal)?,` with `status,`, add `let status: ShiftStatus = row.status.parse().map_err(ApiError::internal)?;` after the `created_from` line, and replace `max_stations: None,` (Task 2) with:

```rust
        // Plan 2b: an open or closed shift names its line's limit; `with_participation` adds the
        // rest.
        max_stations: (status != ShiftStatus::Planned).then_some(row.max_stations),
```

Add below `read` (`:115`):

```rust
/// An open or closed shift as `device_id` sees it (plan 2b): its participants, the device's own
/// state, the whole shift's totals as of `as_of` and each device's part. A planned shift has none.
async fn with_participation(
    conn: &mut SqliteConnection,
    mut shift: DeviceShift,
    device_id: &str,
    as_of: &str,
) -> Result<DeviceShift, ApiError> {
    if shift.status == ShiftStatus::Planned {
        return Ok(shift);
    }
    let participants = shift_participants::list(&mut *conn, &shift.id).await?;
    shift.my_state = participants
        .iter()
        .find(|participant| participant.device_id == device_id)
        .map(|participant| participant.state);
    shift.totals = Some(shift_totals::totals(&mut *conn, &shift.id, as_of).await?);
    shift.by_device = Some(shift_totals::by_device(&mut *conn, &shift.id).await?);
    shift.participants = Some(participants);
    Ok(shift)
}

/// [`read`] of a shift that must exist, as `device_id` sees it.
async fn read_for(
    conn: &mut SqliteConnection,
    id: &str,
    device_id: &str,
    as_of: &str,
) -> Result<DeviceShift, ApiError> {
    let shift = read(&mut *conn, id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    with_participation(conn, shift, device_id, as_of).await
}
```

In `list_device_shifts` replace the tail (`:163-166`) with:

```rust
    let as_of = state.timestamp();
    let mut shifts = Vec::with_capacity(rows.len());
    for row in rows {
        shifts.push(with_participation(&mut tx, record(row)?, &device.id, &as_of).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(DeviceShifts { shifts }))
```

In `enter_shift` replace both

```rust
            let mut entered = read(&mut tx, &id)
                .await?
                .ok_or_else(|| ApiError::internal("shift vanished"))?;
```

(`:495-497`) and

```rust
    let mut opened = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
```

(`:584-586`) with `let mut entered = read_for(&mut tx, &id, &device.id, &at).await?;` and `let mut opened = read_for(&mut tx, &id, &device.id, &at).await?;`. Update the module doc (`:1-8`) with: «Since plan 2b an open or closed shift also carries its line's limit, its participants, the asking device's state, the whole shift's totals as of the read and each device's part; a scan takes no revision, so a device reads this list again to refresh its totals.»

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_lists --test device_shifts --test handheld_floor --test validation_shifts`
      Expected: PASS (the existing suites compare selected fields and planned items, which are unchanged).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/tests/multi_station_lists.rs
git -C "$WT" commit -m "feat(standalone): device shift answers carry participants, totals and each device's part

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Entry by the line's capacity (`shift.join`, `shift_line_full`, legacy `shift_busy`)

**Files:**

- Modify: `apps/standalone/host/src/routes/device_shifts.rs:371-592` (`EntryRow`, `enter_shift`)
- Modify: `apps/standalone/host/src/shifts.rs:481-485` (`busy` doc) and add `line_full`, `stamp_revision`
- Modify: `apps/standalone/host/src/audit.rs:91` (add `SHIFT_JOIN` after `SHIFT_OPEN`)
- Create: `apps/standalone/host/tests/support/multi.rs`; Modify: `apps/standalone/host/tests/support/mod.rs:6-14`
- Test: `apps/standalone/host/tests/multi_station_entry.rs` (new)

**Interfaces:**

- Consumes: Task 3 `decide_entry`/`EntryDecision`; Task 4 `state_of`, `active_others`, `join`, `rejoin`, `touch`; Task 5 `read_for`; `markiro_proto::shift_supports::MULTI_STATION`.
- Produces: `pub fn shifts::line_full(max_stations: u32, active: u32) -> ApiError` (409 `conflict`, `details { constraint: "shift_line_full", maxStations, active }`); `pub async fn shifts::stamp_revision(conn: &mut SqliteConnection, shift_id: &str, rev: i64) -> Result<(), ApiError>`; audit `actions::SHIFT_JOIN = "shift.join"` with details `{ number, rejoined }`; test helpers in `tests/support/multi.rs`: `MULTI`, `HANDHELD`, `struct Device { id, key }`, `call`, `station_on`, `admin_station_on`, `handheld_on`, `allow`, `enter`, `leave`, `open_shared`, `shared`, `constraint`, `participant`, `status_of`.

- [ ] **Step 1: Write the test helpers** `apps/standalone/host/tests/support/multi.rs` and add `pub mod multi;` to `tests/support/mod.rs` (alphabetical, after `pub mod license;`):

```rust
//! Several devices in one shift (plan 2b): stations and a handheld on one line, entering with
//! `multi-station-v1`; the line's limit is set straight in its table (its office route is task 11).

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::app::{
    empty, json as json_request, pair_device, pair_handheld, plan_shift, request, shift_body,
    with_device, Admin, ShiftSetup,
};

pub const MULTI: &str = "multi-station-v1";
pub const HANDHELD: &str = "handheld-host-v1";

/// A device of the line: its id and key.
pub struct Device {
    pub id: String,
    pub key: String,
}

pub async fn call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

async fn on_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = call(admin, key, "PUT", "/v1/device/line", Some(json!({ "lineId": line })))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A new station put on `line`.
pub async fn station_on(admin: &Admin, line: &str) -> Device {
    let (id, key) = pair_device(&admin.app, "station").await;
    on_line(admin, &key, line).await;
    Device { id, key }
}

/// The administrator's own station put on `line`.
pub async fn admin_station_on(admin: &Admin, line: &str) -> Device {
    let (status, info) = call(admin, &admin.key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    on_line(admin, &admin.key, line).await;
    Device {
        id: info["id"].as_str().unwrap().to_owned(),
        key: admin.key.clone(),
    }
}

/// A handheld the office put on `line`.
pub async fn handheld_on(admin: &Admin, line: &str) -> Device {
    let key = pair_handheld(admin).await;
    let (status, info) = call(admin, &key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    Device { id, key }
}

/// Set the line's limit straight in its table.
pub async fn allow(admin: &Admin, line: &str, max_stations: u32) {
    sqlx::query("UPDATE lines SET max_stations = ? WHERE id = ?")
        .bind(max_stations)
        .bind(line)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

/// `POST /v1/device/shifts/{shift}/enter` naming `supports`.
pub async fn enter(
    admin: &Admin,
    device: &Device,
    shift: &str,
    supports: &[&str],
) -> (StatusCode, Value) {
    call(
        admin,
        &device.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        Some(json!({ "supports": supports })),
    )
    .await
}

/// `POST /v1/device/shifts/{shift}/leave` (task 7).
pub async fn leave(admin: &Admin, device: &Device, shift: &str) -> (StatusCode, Value) {
    call(
        admin,
        &device.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/leave"),
        None,
    )
    .await
}

/// Plan a shift of `body` and open it from `opener` naming `multi-station-v1`; its id and number.
pub async fn open_shared(admin: &Admin, body: Value, opener: &Device) -> (String, String) {
    let shift = plan_shift(admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, entered) = enter(admin, opener, &id, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    (id, shift["number"].as_str().unwrap().to_owned())
}

/// Two stations in one shift of `setup`'s first line (limit 2): the administrator's station opens
/// it with the plan `planned`, a minute later a new station joins. The two, the shift and its number.
pub async fn shared(
    admin: &Admin,
    setup: &ShiftSetup,
    planned: Option<u32>,
) -> (Device, Device, String, String) {
    let a = admin_station_on(admin, &setup.line).await;
    let b = station_on(admin, &setup.line).await;
    allow(admin, &setup.line, 2).await;
    let mut body = shift_body(setup);
    if let Some(planned) = planned {
        body["plannedQty"] = json!(planned);
    }
    let (shift, number) = open_shared(admin, body, &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let (status, joined) = enter(admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    (a, b, shift, number)
}

pub fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

/// A participant's row: state, left_at, closed_by_kind, closed_actual_qty, late_data_at.
pub type ParticipantRow = (
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

pub async fn participant(admin: &Admin, shift: &str, device: &str) -> ParticipantRow {
    sqlx::query_as(
        "SELECT state, left_at, closed_by_kind, closed_actual_qty, late_data_at \
         FROM shift_participants WHERE shift_id = ? AND device_id = ?",
    )
    .bind(shift)
    .bind(device)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

pub async fn status_of(admin: &Admin, shift: &str) -> String {
    sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}
```

- [ ] **Step 2: Write the failing test** `apps/standalone/host/tests/multi_station_entry.rs`:

```rust
//! Entry by the line's capacity (plan 2b, spec §4.2 «Вход»): a device that names
//! `multi-station-v1` joins an open shift while the line has a free slot; a full line is
//! `shift_line_full`; a device that names nothing still finds the shift `shift_busy`; a revoked
//! device's slot is free.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_body, shift_setup};
use support::multi::{
    admin_station_on, allow, constraint, enter, open_shared, station_on, MULTI,
};

#[tokio::test]
async fn a_second_station_joins_while_the_line_has_a_free_slot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, number) = open_shared(&admin, shift_body(&setup), &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let revision = host_revision(&admin.app).await;
    let (status, joined) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(
        (
            joined["myState"].clone(),
            joined["ownerDeviceId"].clone(),
            joined["snapshot"].is_object()
        ),
        (json!("active"), json!(a.id), true)
    );
    assert_eq!(
        joined["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| participant["deviceId"].clone())
            .collect::<Vec<_>>(),
        vec![json!(a.id), json!(b.id)]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        audit_trail(&admin.app, "shift.join").await,
        vec![(
            "device".to_owned(),
            Some(b.id.clone()),
            "shift.join".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number, "rejoined": false })
        )]
    );
    // The joined station enters again: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_full_line_is_shift_line_full_and_writes_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        (refused["error"]["code"].clone(), refused["error"]["details"].clone()),
        (
            json!("conflict"),
            json!({ "constraint": "shift_line_full", "maxStations": 1, "active": 1 })
        )
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    let participants: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(participants, 1);
}

#[tokio::test]
async fn a_device_that_names_no_multi_station_still_finds_the_shift_busy() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    for supports in [&[][..], &["validation-v1"][..]] {
        let (status, refused) = enter(&admin, &b, &shift, supports).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(constraint(&refused), json!("shift_busy"), "{supports:?}");
    }
}

#[tokio::test]
async fn a_revoked_device_leaves_its_slot_free() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let b = station_on(&admin, &setup.line).await;
    let c = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &b).await;
    let (status, refused) = enter(&admin, &c, &shift, &[MULTI]).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_line_full"))
    );
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{}/revoke", b.id), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, joined) = enter(&admin, &c, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["myState"], json!("active"));
}
```

- [ ] **Step 3: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_entry`
      Expected: FAIL: the joining test gets `409` `shift_busy`; the full-line test gets `shift_busy` instead of `shift_line_full`.

- [ ] **Step 4: Implement.** In `apps/standalone/host/src/audit.rs` after `SHIFT_OPEN` (`:91`):

```rust
    /// A device became a participant of an open shift it did not open, or came back to it after
    /// it left (plan 2b): `{ number, rejoined }`; the device is the actor. An active
    /// participant's entry again writes none.
    pub const SHIFT_JOIN: &str = "shift.join";
```

In `apps/standalone/host/src/shifts.rs` replace `busy` (`:481-485`) and add after it:

```rust
/// `conflict` on `shift_busy`: another device works the shift and this one did not name
/// `multi-station-v1` (plan 2b), so it works it as a build of stage 2a would: alone. Every build
/// shows it as «занято».
pub fn busy() -> ApiError {
    ApiError::conflict("shift_busy", "another station works on this shift")
}

/// `conflict` on `shift_line_full` (plan 2b): every slot of the line's limit is held by another
/// live device working the shift; `details` name the limit and the slots held.
pub fn line_full(max_stations: u32, active: u32) -> ApiError {
    ApiError::conflict(
        "shift_line_full",
        "every slot of this line is taken in this shift",
    )
    .with_details(json!({
        "constraint": "shift_line_full",
        "maxStations": max_stations,
        "active": active,
    }))
}

/// Stamp `rev` on the shift's row: a change of its participants is a change of the shift, so
/// open streams wake and the office's `expectedRev` sees it.
pub async fn stamp_revision(
    conn: &mut SqliteConnection,
    shift_id: &str,
    rev: i64,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE shifts SET rev = ? WHERE id = ?")
        .bind(rev)
        .bind(shift_id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}
```

(`shifts.rs` already imports `serde_json::json` and `sqlx::SqliteConnection`; add whichever is missing.)

In `apps/standalone/host/src/routes/device_shifts.rs` add to the imports `use crate::shift_participants::EntryDecision;`, replace `EntryRow` (`:371-390`) with:

```rust
/// A shift as an entry reads it, with its line's limit (plan 2b).
#[derive(sqlx::FromRow)]
struct EntryRow {
    status: String,
    mode: String,
    line_id: String,
    product_id: String,
    box_template_id: String,
    pallet_template_id: Option<String>,
    pallet_sheet_template_id: Option<String>,
    validation_print_mode: String,
    validation_print_verification: Option<String>,
    validation_print_template_id: Option<String>,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    max_stations: u32,
}
```

and replace the whole `enter_shift` (`:392-592`, doc comment included) with:

```rust
/// `POST /v1/device/shifts/{id}/enter`: a station or a handheld on the shift's line opens a
/// planned shift (the host freezes its snapshot, the device becomes its opener and first
/// participant) or enters an open one; the answer carries the snapshot, so a device that lost its
/// database gets it back, and (plan 2b) the participants and totals.
///
/// An open shift (plan 2b, spec §4.2 «Вход», `shift_participants::decide_entry`): an active
/// participant enters again (no revision, no audit row); one that closed its part reads the shift
/// back and nothing is written; one that left takes a slot again and a new device takes one, while
/// fewer than the line's `max_stations` other live devices hold a slot — a revision stamped on the
/// shift and `shift.join` (`{ number, rejoined }`). A device that never entered and did not name
/// `multi-station-v1` is `shift_busy` as in stage 2a; one that named it meets a full line as
/// `shift_line_full`. A closed shift is `shift_status`, another line `shift_line`.
///
/// The body (`ShiftEnter`, protocol 4) names what the device works; a station of protocol 3 sends
/// none. A validation shift needs `validation-v1` (and `validation-dm-duplicate-v1` when it prints
/// a duplicate), a handheld always `handheld-host-v1`: otherwise `station_update`, after the
/// shift's own refusals and before anything is frozen or written. Opening checks the license
/// (`require_new_shifts`) and freezes the snapshot (`snapshot_too_large`, the template refusals);
/// joining an open shift checks neither (plan 2b: joining is no new shift).
pub async fn enter_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(id): ApiPath<String>,
    enter: Option<ApiJson<ShiftEnter>>,
) -> Result<Json<DeviceShift>, ApiError> {
    if !matches!(device.kind, DeviceKind::Station | DeviceKind::Handheld) {
        return Err(ApiError::forbidden(WORKS_SHIFTS));
    }
    let enter = enter.map(|ApiJson(enter)| enter).unwrap_or_default();
    validate::shift_supports(&enter.supports)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let kind = device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            WORKS_SHIFTS,
        )
        .await?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT s.status, s.mode, s.line_id, s.product_id, s.box_template_id, \
         s.pallet_template_id, s.pallet_sheet_template_id, s.validation_print_mode, \
         s.validation_print_verification, s.validation_print_template_id, s.counterparty_id, \
         s.snapshot, s.number_month_key, s.number_seq, s.created_from, l.max_stations \
         FROM shifts s JOIN lines l ON l.id = s.line_id WHERE s.id = ?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let shift = shift.ok_or_else(|| ApiError::not_found("no such shift"))?;
    let status: ShiftStatus = shift.status.parse().map_err(ApiError::internal)?;
    if status == ShiftStatus::Closed {
        return Err(shifts::status_conflict(status));
    }
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if line_id.as_deref() != Some(shift.line_id.as_str()) {
        return Err(line_conflict());
    }
    // Plan 2b: who may work an open shift is its participants' and its line's business.
    let decision = if status == ShiftStatus::Planned {
        None
    } else {
        let current = shift_participants::state_of(&mut tx, &id, &device.id).await?;
        let active_others = shift_participants::active_others(&mut tx, &id, &device.id).await?;
        let multi = enter
            .supports
            .iter()
            .any(|name| name == shift_supports::MULTI_STATION);
        match shift_participants::decide_entry(current, active_others, shift.max_stations, multi)
        {
            EntryDecision::Busy => return Err(shifts::busy()),
            EntryDecision::LineFull {
                max_stations,
                active,
            } => return Err(shifts::line_full(max_stations, active)),
            decision => Some(decision),
        }
    };
    let validation_print = shifts::stored_print(
        &shift.validation_print_mode,
        shift.validation_print_verification.as_deref(),
        shift.validation_print_template_id.as_deref(),
    )?;
    let duplicate = match &validation_print {
        Some(ValidationPrint::DuplicateDm {
            verification,
            template_id,
        }) => Some((*verification, template_id.as_str())),
        Some(ValidationPrint::None {}) | None => None,
    };
    require_supports(
        kind,
        shift.mode.parse().map_err(ApiError::internal)?,
        duplicate.is_some(),
        &enter,
    )?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    let number = shifts::format_number(&shift.number_month_key, shift.number_seq, origin);
    let snapshot = match shift.snapshot {
        Some(text) => {
            let snapshot: ShiftSnapshot =
                serde_json::from_str(&text).map_err(ApiError::internal)?;
            let mut entered = match decision {
                Some(EntryDecision::Reenter) => {
                    shift_participants::touch(&mut tx, &id, &device.id, &at).await?;
                    let entered = read_for(&mut tx, &id, &device.id, &at).await?;
                    tx.commit().await.map_err(ApiError::internal)?;
                    entered
                }
                // Nothing to write: the transaction rolls back when dropped.
                Some(EntryDecision::ReadClosed) => {
                    read_for(&mut tx, &id, &device.id, &at).await?
                }
                Some(joining @ (EntryDecision::Join | EntryDecision::Rejoin)) => {
                    let rejoined = joining == EntryDecision::Rejoin;
                    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
                    if rejoined {
                        shift_participants::rejoin(&mut tx, &id, &device.id, &at).await?;
                    } else {
                        shift_participants::join(&mut tx, &id, &device.id, &at).await?;
                    }
                    shifts::stamp_revision(&mut tx, &id, rev).await?;
                    audit::record(
                        &mut tx,
                        &at,
                        Entry {
                            actor: Actor::Device(&device.id),
                            action: actions::SHIFT_JOIN,
                            target_type: Some("shift"),
                            target_id: Some(&id),
                            outcome: Outcome::Ok,
                            details: json!({ "number": number, "rejoined": rejoined }),
                        },
                    )
                    .await
                    .map_err(ApiError::internal)?;
                    let entered = read_for(&mut tx, &id, &device.id, &at).await?;
                    commit_with_revision(tx, &state.revisions, rev)
                        .await
                        .map_err(ApiError::internal)?;
                    entered
                }
                _ => return Err(ApiError::internal("an open shift's entry was not decided")),
            };
            entered.snapshot = Some(snapshot);
            return Ok(Json(entered));
        }
        None => {
            // Opening is the one move a license that ran out closes (plan ЛЦ-2, spec §3.3).
            crate::license::gate::require_new_shifts(&state, &mut tx).await?;
            let own_logo = crate::license::gate::custom_branding(&state, &mut tx).await?;
            let snapshot = shifts::snapshot(
                &mut tx,
                &shift.product_id,
                &shift.box_template_id,
                shift.pallet_template_id.as_deref(),
                shift.counterparty_id.as_deref(),
                shift.pallet_sheet_template_id.as_deref(),
                duplicate,
            )
            .await?;
            // Custom branding is a license feature: without it the shift freezes no logo, and
            // every print of it falls back to the bundled Markiro one.
            if own_logo {
                snapshot
            } else {
                shifts::without_logo(snapshot)
            }
        }
    };
    // After the templates, so a template that no longer fits is named first.
    let text = shifts::snapshot_text(&snapshot)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(text)
    .bind(&at)
    .bind(&device.id)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    shift_participants::join(&mut tx, &id, &device.id, &at).await?;
    let mut details = json!({
        "number": number,
        "templateId": snapshot.box_template.id,
        "templateRev": snapshot.box_template.rev,
    });
    if let Some(pallet_template) = &snapshot.pallet_template {
        details["palletTemplateId"] = json!(pallet_template.id);
        details["palletTemplateRev"] = json!(pallet_template.rev);
    }
    if let Some(sheet) = &snapshot.pallet_sheet {
        details["palletSheetTemplateId"] = json!(sheet.id);
        details["palletSheetRevision"] = json!(sheet.revision);
    }
    if let Some(print) = &snapshot.validation_print {
        details["validationPrintTemplateId"] = json!(print.template.id);
        details["validationPrintTemplateRev"] = json!(print.template.rev);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_OPEN,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let mut opened = read_for(&mut tx, &id, &device.id, &at).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    opened.snapshot = Some(snapshot);
    Ok(Json(opened))
}
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_entry --test device_shifts --test handheld_floor --test validation_shifts --test validation_print --test license_gate`
      Expected: PASS. (`device_shifts.rs` and `handheld_floor.rs` keep expecting `shift_busy` for a second device that names nothing: D4.)

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/shifts.rs apps/standalone/host/src/audit.rs \
  apps/standalone/host/tests/support/multi.rs apps/standalone/host/tests/support/mod.rs apps/standalone/host/tests/multi_station_entry.rs
git -C "$WT" commit -m "feat(standalone): host entry by the line's capacity — shift.join, shift_line_full, shift_busy kept for older builds

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Leave route (`POST /v1/device/shifts/{id}/leave`)

**Files:**

- Modify: `apps/standalone/host/src/routes/device_shifts.rs` (append `leave_shift` and `not_entered` after `enter_shift`; extend the module doc `:1-8`)
- Modify: `apps/standalone/host/src/server.rs:296-299` (route after `…/enter`)
- Modify: `apps/standalone/host/src/device_kinds.rs:23` (row after `…/enter`)
- Modify: `apps/standalone/host/src/audit.rs` (add `SHIFT_LEAVE` after `SHIFT_JOIN`)
- Test: `apps/standalone/host/tests/multi_station_leave.rs` (new)

**Interfaces:**

- Consumes: Task 3 `leaves`; Task 4 `state_of`, `leave`; Task 5 `read_for`; Task 6 `stamp_revision`, test helpers.
- Produces: route `POST /v1/device/shifts/{id}/leave` (no body) → `200 DeviceShift` (no snapshot); errors: `404 not_found`, `409 conflict` `shift_not_entered`, `403 forbidden` for an office PC, `401` revoked; audit `actions::SHIFT_LEAVE = "shift.leave"` `{ number }`.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_leave.rs`:

```rust
//! A participant's leave (plan 2b, spec §4.2 «Выход»): it frees its slot and may come back while a
//! slot is free; a leave repeated changes nothing; a device that never entered cannot leave.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_body, shift_setup};
use support::multi::{
    admin_station_on, constraint, enter, leave, open_shared, station_on, MULTI,
};

#[tokio::test]
async fn a_station_that_leaves_frees_its_slot_and_comes_back_when_one_is_free() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, number) = open_shared(&admin, shift_body(&setup), &a).await;
    let revision = host_revision(&admin.app).await;
    let (status, left) = leave(&admin, &a, &shift).await;
    assert_eq!(status, StatusCode::OK, "{left}");
    assert_eq!(
        (left["myState"].clone(), left.get("snapshot").is_none()),
        (json!("left"), true)
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let leave_row = |device: &str| {
        (
            "device".to_owned(),
            Some(device.to_owned()),
            "shift.leave".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number }),
        )
    };
    assert_eq!(audit_trail(&admin.app, "shift.leave").await, vec![leave_row(&a.id)]);
    // A leave repeated changes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = leave(&admin, &a, &shift).await;
    assert_eq!((status, again["myState"].clone()), (StatusCode::OK, json!("left")));
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // The slot is free: B joins, and A's return finds the line full.
    admin.app.clock.advance(time::Duration::minutes(1));
    let (status, joined) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    let (status, refused) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "shift_line_full", "maxStations": 1, "active": 1 })
        )
    );
    // B leaves, A comes back.
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK);
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!((status, back["myState"].clone()), (StatusCode::OK, json!("active")));
    let join_row = |device: &str, rejoined: bool| {
        (
            "device".to_owned(),
            Some(device.to_owned()),
            "shift.join".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number, "rejoined": rejoined }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "shift.join").await,
        vec![join_row(&b.id, false), join_row(&a.id, true)]
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.leave").await,
        vec![leave_row(&a.id), leave_row(&b.id)]
    );
}

#[tokio::test]
async fn a_device_that_never_entered_cannot_leave() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = leave(&admin, &b, &shift).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_not_entered"))
    );
    let (status, missing) = leave(&admin, &b, "00000000-0000-4000-8000-000000000099").await;
    assert_eq!((status, missing["error"]["code"].clone()), (StatusCode::NOT_FOUND, json!("not_found")));
    assert_eq!(audit_rows(&admin.app).await, rows);
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_leave --test device_kind_routes`
      Expected: FAIL: `leave` answers `404`/`405` (no route); `device_kind_routes` passes until the route is added.

- [ ] **Step 3: Implement.** In `audit.rs` after `SHIFT_JOIN`:

```rust
    /// A participant paused its part and freed its slot (plan 2b): `{ number }`; the device is
    /// the actor. A leave repeated writes none.
    pub const SHIFT_LEAVE: &str = "shift.leave";
```

In `device_kinds.rs` after the `…/enter` row (`:23`):

```rust
    ("POST", "/v1/device/shifts/{id}/leave", &[Station, Handheld]),
```

In `server.rs` after the `…/enter` route (`:296-299`):

```rust
        .route(
            "/v1/device/shifts/{id}/leave",
            post(crate::routes::device_shifts::leave_shift),
        )
```

Append to `device_shifts.rs`:

```rust
/// `conflict` on `shift_not_entered`: the device never entered the shift (plan 2b).
pub fn not_entered() -> ApiError {
    ApiError::conflict("shift_not_entered", "this device never entered the shift")
}

/// `POST /v1/device/shifts/{id}/leave` (plan 2b, spec §4.2 «Выход»): an active participant pauses
/// its part and frees its slot of the line (`left`), with a revision stamped on the shift and
/// `shift.leave`; it may enter again while a slot is free. A participant that left or closed
/// already (a closed shift's participants all have) answers the shift as it is and writes nothing,
/// so a leave retried after a lost answer is harmless. A device that never entered is `conflict` on
/// `shift_not_entered`, an unknown shift `not_found`. The answer is the shift as the device sees it,
/// without the snapshot.
pub async fn leave_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DeviceShift>, ApiError> {
    if !matches!(device.kind, DeviceKind::Station | DeviceKind::Handheld) {
        return Err(ApiError::forbidden(WORKS_SHIFTS));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            WORKS_SHIFTS,
        )
        .await?;
    let number: Option<(String, i64, String)> = sqlx::query_as(
        "SELECT number_month_key, number_seq, created_from FROM shifts WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (month_key, seq, created_from) =
        number.ok_or_else(|| ApiError::not_found("no such shift"))?;
    let current = shift_participants::state_of(&mut tx, &id, &device.id)
        .await?
        .ok_or_else(not_entered)?;
    if !shift_participants::leaves(current) {
        // Nothing to write: the transaction rolls back when dropped.
        return Ok(Json(read_for(&mut tx, &id, &device.id, &at).await?));
    }
    let origin = created_from.parse().map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    shift_participants::leave(&mut tx, &id, &device.id, &at).await?;
    shifts::stamp_revision(&mut tx, &id, rev).await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_LEAVE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "number": shifts::format_number(&month_key, seq, origin) }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let left = read_for(&mut tx, &id, &device.id, &at).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(left))
}
```

Extend the module doc (`:1-3`) to name `POST /v1/device/shifts/{id}/leave`.

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_leave --test device_kind_routes --test multi_station_entry`
      Expected: PASS (`device_kind_routes` finds the new row and route, and refuses an office PC before the body).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/device_shifts.rs apps/standalone/host/src/server.rs apps/standalone/host/src/device_kinds.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/multi_station_leave.rs
git -C "$WT" commit -m "feat(standalone): host leave route — a participant frees its slot and may come back

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Closing a part, the automatic close, the shared reason and late parts

**Files:**

- Modify: `apps/standalone/host/src/facts/mod.rs:30-41` (imports), `:110-118` (`CloseShift`), `:120-137` (`FactShift`), `:364-379` (the outcome match in `apply`), `:406-468` (`entered_shift`), `:486-521` (`close_shift` → `close_part`), add `mark_part_late` after `mark_late` (`:547`)
- Modify (rewrite): `apps/standalone/host/src/facts/shift_closed.rs:1-85`
- Modify: `apps/standalone/host/src/audit.rs:92-94` (`SHIFT_CLOSE` doc) and add `SHIFT_PART_CLOSED`
- Test: `apps/standalone/host/tests/multi_station_close.rs` (new)

**Interfaces:**

- Consumes: Task 3 `decide_close`, `reason_need`, `CloseDecision`, `ReasonNeed`; Task 4 `count_all`, `open_others`, `close_by_device`, `mark_late`, `shift_totals::shift_accepted`; Task 6 `stamp_revision`.
- Produces: `FactShift { …, my_state: ParticipantState, planned_qty: Option<u32> }`; `CloseShift { closed_at, reason_code, actual_qty: u32, closes_shift: bool, reason_missing: bool, part_audit: Value, audit: Value }`; receipts per D8; audit `shift.part_closed` `{ number, actualQty, closedBoxCount, reasonCode }` and, for a shared shift, `shift.close` gains `participants`, `acceptedTotal`, `reasonMissing`; `shifts.close_reason_missing = 1` when a shared shift closes without its needed reason; `shift_participants.late_data_at` per D9.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_close.rs`:

```rust
//! Each participant closes its own part (plan 2b, spec §4.2 «Закрытие своей части», «План и
//! причина», §12.9): the shift closes with its last part; only a shared shift's last close may need
//! a reason, judged by the whole shift against the host's plan, and a close without it still closes
//! the shift, marked for the office; a closed part's later facts are late.

mod support;

use serde_json::json;
use support::app::{
    accepted, admin, audit_trail, box_id, fact, host_revision, instant, ok_scan, receipts,
    record_id, shift_closed, shift_setup,
};
use support::multi::{enter, leave, participant, shared, status_of, MULTI};

fn device_row(device: &str, action: &str, shift: &str, details: serde_json::Value) -> support::app::AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        action.to_owned(),
        Some("shift".to_owned()),
        Some(shift.to_owned()),
        "ok".to_owned(),
        details,
    )
}

#[tokio::test]
async fn the_first_closer_closes_its_part_and_the_last_one_closes_the_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, number) = shared(&admin, &setup, Some(10)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(1, 0)))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let revision = host_revision(&admin.app).await;
    // A closes its part without a reason although its 1 is not the plan of 10: nobody refuses it.
    let close_a = fact(
        &record_id(2),
        "shift_closed",
        &shift,
        shift_closed(Some(10), 1, 0, None, &instant(60, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &a.key, &[close_a]).await,
        vec![json!({ "id": record_id(2), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(status_of(&admin, &shift).await, "active");
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        ("closed".to_owned(), None, Some("device".to_owned()), Some(1), None)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.part_closed").await,
        vec![device_row(
            &a.id,
            "shift.part_closed",
            &shift,
            json!({ "number": number, "actualQty": 1, "closedBoxCount": 0, "reasonCode": null })
        )]
    );
    assert!(audit_trail(&admin.app, "shift.close").await.is_empty());
    // B closes last without a reason; the whole shift's 1 misses the plan of 10.
    let close_b = fact(
        &record_id(1),
        "shift_closed",
        &shift,
        shift_closed(Some(10), 0, 0, None, &instant(120, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[close_b]).await,
        vec![json!({ "id": record_id(1), "outcome": "accepted", "details": { "reasonMissing": true } })]
    );
    let row: (String, String, String, String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, closed_at, closed_by_kind, closed_by, close_reason_code, \
         close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "closed".to_owned(),
            "2026-10-08T06:02:00Z".to_owned(),
            "device".to_owned(),
            b.id.clone(),
            None,
            true
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![device_row(
            &b.id,
            "shift.close",
            &shift,
            json!({
                "actualQty": 0, "plannedQty": 10, "closedBoxCount": 0, "reasonCode": null,
                "participants": 2, "acceptedTotal": 1, "reasonMissing": true
            })
        )]
    );
    assert_eq!(audit_trail(&admin.app, "shift.part_closed").await.len(), 1);
}

#[tokio::test]
async fn the_last_closer_needs_no_reason_when_the_whole_shift_meets_the_plan() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(2)).await;
    let scan = |n: u32, box_n: u32| {
        fact(&record_id(n), "scan", &shift, ok_scan(n, &box_id(box_n), &instant(n, 0)))
    };
    assert_eq!(receipts(&admin.app, &a.key, &[scan(1, 1)]).await, vec![accepted(&record_id(1))]);
    assert_eq!(receipts(&admin.app, &b.key, &[scan(2, 2)]).await, vec![accepted(&record_id(2))]);
    let close = |n: u32| {
        fact(&record_id(n), "shift_closed", &shift, shift_closed(Some(2), 1, 0, None, &instant(90, 0)))
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3)]).await,
        vec![json!({ "id": record_id(3), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(receipts(&admin.app, &b.key, &[close(3)]).await, vec![accepted(&record_id(3))]);
    let missing: bool =
        sqlx::query_scalar("SELECT close_reason_missing FROM shifts WHERE id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((status_of(&admin, &shift).await.as_str(), missing), ("closed", false));
}

#[tokio::test]
async fn a_participant_that_left_keeps_the_shift_open_until_it_closes_too() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let close = |n: u32| {
        fact(&record_id(n), "shift_closed", &shift, shift_closed(None, 0, 0, None, &instant(30, 0)))
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(1)]).await,
        vec![json!({ "id": record_id(1), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(status_of(&admin, &shift).await, "active");
    assert_eq!(receipts(&admin.app, &b.key, &[close(1)]).await, vec![accepted(&record_id(1))]);
    assert_eq!(status_of(&admin, &shift).await, "closed");
    assert_eq!(
        participant(&admin, &shift, &b.id).await,
        ("closed".to_owned(), None, Some("device".to_owned()), Some(0), None)
    );
}

#[tokio::test]
async fn a_closed_part_reads_the_shift_back_takes_late_facts_and_closes_only_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, _b, shift, _) = shared(&admin, &setup, None).await;
    let close = |n: u32| {
        fact(&record_id(n), "shift_closed", &shift, shift_closed(None, 0, 0, None, &instant(30, 0)))
    };
    receipts(&admin.app, &a.key, &[close(1)]).await;
    let revision = host_revision(&admin.app).await;
    // Its entry reads the shift back: nothing is written.
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(
        (status, back["myState"].clone(), back["snapshot"].is_object()),
        (axum::http::StatusCode::OK, json!("closed"), true)
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    // A later scan is taken and marks the part late once; the shift is not late.
    admin.app.clock.advance(time::Duration::minutes(3));
    let late_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(&record_id(2), "scan", &shift, ok_scan(5, &box_id(5), &instant(40, 0)))]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        ("closed".to_owned(), None, Some("device".to_owned()), Some(0), Some(late_at))
    );
    let shift_late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM shifts WHERE id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(shift_late, None);
    // A second close of the closed part changes nothing and is kept as already closed.
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3)]).await,
        vec![json!({ "id": record_id(3), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let outcomes: Vec<String> = sqlx::query_scalar(
        "SELECT outcome FROM shift_close_events WHERE shift_id = ? AND device_id = ? \
         ORDER BY received_at, record_id",
    )
    .bind(&shift)
    .bind(&a.id)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(outcomes, ["accepted", "already_closed"]);
}
```

Note: the expected `closed_at` `"2026-10-08T06:02:00Z"` is `format_timestamp` of B's device instant `instant(120, 0)` (`2026-10-08T06:02:00.000Z`).

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_close`
      Expected: FAIL: A's close is rejected `invalid_record` `data.reasonCode` (stage 2a rule) in the first test, and in the others the first close closes the whole shift (`status` `closed`).

- [ ] **Step 3: Implement `facts/mod.rs`.** Add `ParticipantState` to the `markiro_proto` import. Replace `CloseShift` (`:110-118`):

```rust
/// A participant's close of its part of an active shift (plan 2b).
#[derive(Debug, Clone, PartialEq)]
pub struct CloseShift {
    /// The device's instant in the host's format (whole seconds).
    pub closed_at: String,
    pub reason_code: Option<String>,
    /// The device's own count, kept on its part.
    pub actual_qty: u32,
    /// No other participant stays active or left: the shift closes with this part.
    pub closes_shift: bool,
    /// The shared shift closes without the reason its total needed (spec §12.9).
    pub reason_missing: bool,
    /// The details of the `shift.part_closed` row (a part that leaves the shift open).
    pub part_audit: Value,
    /// The details of the `shift.close` row (the close of the shift).
    pub audit: Value,
}
```

Add to `FactShift` after `prints_duplicate`:

```rust
    /// The sending device's part in the shift (plan 2b).
    pub my_state: ParticipantState,
    /// The shift's plan on the host now: a shared shift's reason is judged by it.
    pub planned_qty: Option<u32>,
```

Replace the outcome match in `apply` (`:364-379`):

```rust
    let answer = match answer {
        Ok(applied) => {
            match &applied.close {
                Some(close) => close_part(conn, &context, close, revision).await?,
                None if record.kind != FactKind::ShiftClosed => {
                    if shift.status == ShiftStatus::Closed {
                        mark_late(conn, &context, revision).await?;
                    }
                    if shift.my_state == ParticipantState::Closed {
                        mark_part_late(conn, &context, revision).await?;
                    }
                }
                None => {}
            }
            Ok(applied)
        }
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
```

In `entered_shift` (`:406-468`) replace the row type, the query and the destructuring:

```rust
    type ShiftRow = (
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
        bool,
        Option<u32>,
        Option<String>,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.mode, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         s.pallets_enabled, s.validation_print_mode = 'duplicate_dm', s.planned_qty, \
         (SELECT p.state FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((
        status,
        mode,
        month_key,
        seq,
        created_from,
        gtin14,
        issuer_prefix,
        pallets_enabled,
        prints_duplicate,
        planned_qty,
        participant,
    )) = row
    else {
        return Ok(None);
    };
    let Some(participant) = participant else {
        return Ok(Some(None));
    };
```

and in the `FactShift { … }` literal add `my_state: participant.parse().map_err(ApiError::internal)?,` and `planned_qty,`.

Replace `close_shift` (`:486-521`) with:

```rust
/// A participant's close of its part (plan 2b): the part closes with the device's instant, count
/// and reason, and a revision is stamped on the shift. A part that leaves the shift open writes
/// `shift.part_closed`; when nobody else is active or left the shift closes too, as a station's close
/// did in stage 2a — the device as closer, its reason, or the mark that the reason is missing
/// (spec §12.9) — and writes `shift.close`.
async fn close_part(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    close: &CloseShift,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    let rev = batch_revision(&mut *conn, revision).await?;
    crate::shift_participants::close_by_device(
        &mut *conn,
        &context.shift.id,
        context.device_id,
        &close.closed_at,
        close.actual_qty,
        close.reason_code.as_deref(),
    )
    .await?;
    if !close.closes_shift {
        crate::shifts::stamp_revision(&mut *conn, &context.shift.id, rev).await?;
        return audit::record(
            conn,
            context.received_at,
            Entry {
                actor: Actor::Device(context.device_id),
                action: actions::SHIFT_PART_CLOSED,
                target_type: Some("shift"),
                target_id: Some(&context.shift.id),
                outcome: Outcome::Ok,
                details: close.part_audit.clone(),
            },
        )
        .await
        .map_err(ApiError::internal);
    }
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ?, close_reason_code = ?, close_reason_missing = ?, rev = ? WHERE id = ?",
    )
    .bind(&close.closed_at)
    .bind(context.device_id)
    .bind(&close.reason_code)
    .bind(close.reason_missing)
    .bind(rev)
    .bind(&context.shift.id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        conn,
        context.received_at,
        Entry {
            actor: Actor::Device(context.device_id),
            action: actions::SHIFT_CLOSE,
            target_type: Some("shift"),
            target_id: Some(&context.shift.id),
            outcome: Outcome::Ok,
            details: close.audit.clone(),
        },
    )
    .await
    .map_err(ApiError::internal)
}
```

Add after `mark_late`:

```rust
/// The first fact of a closed part marks the part late, once (plan 2b), with a revision stamped on
/// the shift; nothing reopens the part.
async fn mark_part_late(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    if crate::shift_participants::mark_late(
        &mut *conn,
        &context.shift.id,
        context.device_id,
        context.received_at,
    )
    .await?
    {
        let rev = batch_revision(&mut *conn, revision).await?;
        crate::shifts::stamp_revision(conn, &context.shift.id, rev).await?;
    }
    Ok(())
}
```

Update the module doc of `facts/mod.rs` (`:1-12`) and of `receive` (`:173-176`): «A record that closes a part or its shift, a closed shift's first late fact and a closed part's first late fact change the shift's row: the batch takes one revision for all of them.»

- [ ] **Step 4: Rewrite `facts/shift_closed.rs`:**

```rust
//! `shift_closed` facts (stage 2a spec, decision 17; plan 2b): a device closed its part of its
//! shift; its local close is the point of no return, so the host takes it whenever it arrives.
//! The part closes, and the shift with it when no other participant is active or left (the batch
//! writes both, `facts::close_part`). A shift closed before (by the office, or by its last device)
//! answers `accepted` with `alreadyClosed`; a part closed before, `partClosed`; a part that leaves
//! the shift open, `partClosed`; a shared shift closed without its needed reason, `reasonMissing`.
//! Every close is kept in `shift_close_events`. A validation shift has no boxes (plan РЕЖ, Р7).
//!
//! The reason (`shift_participants::reason_need`): a shift that only ever had this device keeps
//! stage 2a's rule, and a close without the needed reason is refused; in a shared shift only the
//! close that closes the shift may need one, by the whole shift's accepted units against the host's
//! plan, and a close without it still closes the shift (spec §12.9).

use markiro_proto::{shift_close_reasons, ShiftClosedFact, ShiftMode, ShiftStatus};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use super::{rules, Applied, CloseShift, Context, Failure, Reject};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::shift_participants::{self, CloseDecision, ReasonNeed};
use crate::shift_totals;
use crate::validate;

/// What the close meets.
#[derive(Clone, Copy)]
enum Closing {
    /// The shift is closed already.
    ShiftClosed,
    /// This part closed before.
    PartClosedBefore,
    /// The part closes, and the shift with it when `closes_shift`.
    Part { closes_shift: bool },
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: ShiftClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let closed_at =
        rules::device_instant(&closed.closed_at).ok_or_else(|| Reject::field("data.closedAt"))?;
    if closed
        .planned_qty_snapshot
        .is_some_and(|planned| !(1..=validate::MAX_PLANNED_QTY).contains(&planned))
    {
        return Err(Reject::field("data.plannedQtySnapshot").into());
    }
    if context.shift.mode == ShiftMode::Validation && closed.closed_box_count != 0 {
        return Err(Reject::field("data.closedBoxCount").into());
    }
    if let Some(code) = closed.reason_code.as_deref() {
        if !shift_close_reasons::ALL.contains(&code) {
            return Err(Reject::field("data.reasonCode").into());
        }
    }
    let shift_id = context.shift.id.as_str();
    let ever = shift_participants::count_all(&mut *conn, shift_id).await?;
    let closing = if context.shift.status != ShiftStatus::Active {
        Closing::ShiftClosed
    } else {
        let open_others =
            shift_participants::open_others(&mut *conn, shift_id, context.device_id).await?;
        match shift_participants::decide_close(context.shift.my_state, open_others) {
            CloseDecision::AlreadyClosed => Closing::PartClosedBefore,
            CloseDecision::ClosePart { closes_shift } => Closing::Part { closes_shift },
        }
    };
    let (need, accepted) = match closing {
        Closing::Part { closes_shift } => {
            let accepted = if closes_shift && ever > 1 {
                shift_totals::shift_accepted(&mut *conn, shift_id).await?
            } else {
                0
            };
            let need = shift_participants::reason_need(
                closes_shift,
                ever,
                closed.planned_qty_snapshot,
                closed.actual_qty,
                context.shift.planned_qty,
                accepted,
            );
            (need, accepted)
        }
        // A close the shift no longer takes: a one-device shift keeps stage 2a's rule, a shared
        // one needs nothing.
        Closing::ShiftClosed | Closing::PartClosedBefore => (
            shift_participants::reason_need(
                true,
                ever,
                closed.planned_qty_snapshot,
                closed.actual_qty,
                None,
                0,
            ),
            0,
        ),
    };
    if need == ReasonNeed::Required && closed.reason_code.is_none() {
        return Err(Reject::field("data.reasonCode").into());
    }
    let outcome = match closing {
        Closing::Part { .. } => "accepted",
        Closing::ShiftClosed | Closing::PartClosedBefore => "already_closed",
    };
    sqlx::query(
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(shift_id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(closed.planned_qty_snapshot)
    .bind(closed.actual_qty)
    .bind(closed.closed_box_count)
    .bind(&closed.reason_code)
    .bind(&closed.closed_at)
    .bind(outcome)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let closes_shift = match closing {
        Closing::ShiftClosed => {
            return Ok(Applied {
                details: Some(json!({ "alreadyClosed": true })),
                ..Applied::accepted()
            });
        }
        Closing::PartClosedBefore => {
            return Ok(Applied {
                details: Some(json!({ "partClosed": true })),
                ..Applied::accepted()
            });
        }
        Closing::Part { closes_shift } => closes_shift,
    };
    let reason_missing = need == ReasonNeed::Shared && closed.reason_code.is_none();
    let mut audit = json!({
        "actualQty": closed.actual_qty,
        "plannedQty": closed.planned_qty_snapshot,
        "closedBoxCount": closed.closed_box_count,
        "reasonCode": closed.reason_code,
    });
    // A one-device shift's close keeps stage 2a's row exactly.
    if ever > 1 {
        audit["participants"] = json!(ever);
        audit["acceptedTotal"] = json!(accepted);
        audit["reasonMissing"] = json!(reason_missing);
    }
    let details = if !closes_shift {
        Some(json!({ "partClosed": true }))
    } else if reason_missing {
        Some(json!({ "reasonMissing": true }))
    } else {
        None
    };
    // The shift's and the part's columns keep the host's format: whole seconds, UTC.
    Ok(Applied {
        details,
        close: Some(CloseShift {
            closed_at: format_timestamp(closed_at),
            reason_code: closed.reason_code.clone(),
            actual_qty: closed.actual_qty,
            closes_shift,
            reason_missing,
            part_audit: json!({
                "number": context.shift.number,
                "actualQty": closed.actual_qty,
                "closedBoxCount": closed.closed_box_count,
                "reasonCode": closed.reason_code,
            }),
            audit,
        }),
        ..Applied::accepted()
    })
}
```

In `audit.rs` replace the `SHIFT_CLOSE` doc (`:92-93`) with «A shift closed by the close of its last participant (a station's or a handheld's close is a fact, plan 2a2; plan 2b: a shared shift's row adds `participants`, `acceptedTotal`, `reasonMissing`). The office's close writes `shift.force_closed` since plan 2b.» and add after it:

```rust
    /// A participant closed its part while another still works the shift (plan 2b): `{ number,
    /// actualQty, closedBoxCount, reasonCode }`; the device is the actor. The close of the last
    /// part writes `shift.close` instead.
    pub const SHIFT_PART_CLOSED: &str = "shift.part_closed";
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_close --test facts --test pallet_facts --test validation_shifts --test unit_labels --test handheld_floor --test handheld_floor_scenario --test floor_scenario --test office_cards`
      Expected: PASS. A one-device shift closes as before (same receipt, same `shift.close` details, the stage 2a reason refusals of `tests/facts.rs:2659-2760`); a close after the office's close is `alreadyClosed`; late facts after the office's close take the same single revision (the part's late mark shares the batch revision).

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/facts/mod.rs apps/standalone/host/src/facts/shift_closed.rs apps/standalone/host/src/audit.rs apps/standalone/host/tests/multi_station_close.rs
git -C "$WT" commit -m "feat(standalone): host closes a participant's part, the shift with its last part, and judges a shared plan by the whole shift

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The office's shift carries participants, each device's part and the missing-reason mark

**Files:**

- Modify: `apps/standalone/host/src/routes/office_shifts.rs:20-27` (imports), `:34-41` (`SELECT`), `:92-137` (`ShiftRow`), `:139-199` (`record`), `:201-208` (`read`), `:229-292` (`list_shifts`)
- Test: `apps/standalone/host/tests/multi_station_office.rs` (new)

**Interfaces:**

- Consumes: Task 4 `shift_participants::list`, `shift_totals::by_device`; Task 6 helpers.
- Produces: every `OfficeShift` answer (list, detail, every write) carries `participants`, `byDevice` (left out for a planned shift) and `closeReasonMissing` (left out when false); `async fn with_participants(conn: &mut SqliteConnection, shift: OfficeShift) -> Result<OfficeShift, ApiError>`.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_office.rs`:

```rust
//! The office's shift (plan 2b, spec §7 «Смена»): the participants, each device's part of the
//! totals and the mark of a reason its devices did not give; a planned shift names none of them.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, plan_shift, receipts, record_id,
    shift_body, shift_setup,
};
use support::multi::shared;

#[tokio::test]
async fn the_office_reads_a_shared_shifts_participants_and_each_devices_part() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(1, 0)))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let (status, detail) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        detail["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| (participant["deviceId"].clone(), participant["state"].clone()))
            .collect::<Vec<_>>(),
        vec![(json!(a.id), json!("active")), (json!(b.id), json!("active"))]
    );
    assert_eq!(
        detail["byDevice"],
        json!([
            { "deviceId": a.id, "accepted": 1, "boxesClosed": 0, "pallets": 0 },
            { "deviceId": b.id, "accepted": 0, "boxesClosed": 0, "pallets": 0 }
        ])
    );
    assert!(detail.get("closeReasonMissing").is_none());
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(shift))
        .unwrap();
    assert_eq!(
        (listed["participants"].clone(), listed["byDevice"].clone()),
        (detail["participants"].clone(), detail["byDevice"].clone())
    );
    let plan = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == planned["id"])
        .unwrap();
    assert!(plan.get("participants").is_none() && plan.get("byDevice").is_none());
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_office`
      Expected: FAIL: `detail["participants"]` is `null` (`called Option::unwrap() on a None value`).

- [ ] **Step 3: Implement.** Imports: add `use crate::shift_participants;` and `use crate::shift_totals;`. In `SELECT` (`:40-41`) change `close_reason_text, late_data_at, created_at, rev, \` to `close_reason_text, late_data_at, close_reason_missing, created_at, rev, \`. In `ShiftRow` add `close_reason_missing: bool,` after `late_data_at`. In `record` replace `close_reason_missing: false,` (Task 2) with `close_reason_missing: row.close_reason_missing,`. Replace `read` (`:201-208`) with:

```rust
/// A shift's participants and each device's part (plan 2b), in every answer of a shift that
/// opened; a planned shift has none.
async fn with_participants(
    conn: &mut SqliteConnection,
    mut shift: OfficeShift,
) -> Result<OfficeShift, ApiError> {
    if shift.status != ShiftStatus::Planned {
        shift.participants = shift_participants::list(&mut *conn, &shift.id).await?;
        shift.by_device = shift_totals::by_device(&mut *conn, &shift.id).await?;
    }
    Ok(shift)
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeShift>, ApiError> {
    let row: Option<ShiftRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    match row {
        Some(row) => Ok(Some(with_participants(conn, record(row)?).await?)),
        None => Ok(None),
    }
}
```

In `list_shifts` read inside one transaction: before `let rows: Vec<ShiftRow> = …` add `let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;`, replace both `.fetch_all(&state.pool)` with `.fetch_all(&mut *tx)`, and replace the tail (`:288-291`) with:

```rust
    let mut shifts = Vec::with_capacity(rows.len());
    for row in rows {
        shifts.push(with_participants(&mut tx, record(row)?).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(shifts))
```

Extend the module doc (`:1-7`): «Since plan 2b every answer of an opened shift also lists its participants and each device's part of the totals, and names a reason its devices did not give (`closeReasonMissing`).»

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_office --test office_shifts --test office_boxes --test usage_stats` and `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --lib office_shifts`
      Expected: PASS (`office_shifts.rs` compares selected fields; its open-directly shifts have no participant rows, so their answers gain nothing; the pinned query plans of the `SELECT` are unchanged).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/tests/multi_station_office.rs
git -C "$WT" commit -m "feat(standalone): office shifts list their participants and each device's part

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The office's forced close and the missing reason

**Files:**

- Modify: `apps/standalone/host/src/routes/office_shifts.rs:12-15` (imports), `:853-911` (`close_shift`), add `set_close_reason` after it
- Modify: `apps/standalone/host/src/server.rs:600-603` (route after `…/close`)
- Modify: `apps/standalone/host/src/audit.rs` (add `SHIFT_FORCE_CLOSED`, `SHIFT_CLOSE_REASON` after `SHIFT_PART_CLOSED`)
- Modify (existing tests, product decision D10): `apps/standalone/host/tests/office_shifts.rs:1543-1549`, `:1917-1922`, `:2062-2069`; `apps/standalone/host/tests/facts.rs:2872-2875`
- Test: `apps/standalone/host/tests/multi_station_force_close.rs` (new)

**Interfaces:**

- Consumes: Task 4 `close_open_by_office`; Task 8 (a shared shift closed with `close_reason_missing`); Task 9 (`read` carries `close_reason_missing`); `markiro_proto::ShiftCloseReasonSet` (Task 2).
- Produces: `POST /v1/office/shifts/{id}/close` (unchanged body) closes every open part as the office's and writes `shift.force_closed` `{ reason, notClosed: [{ deviceId, state }] }`; `PUT /v1/office/shifts/{id}/close-reason` `{ reasonCode, expectedRev }` → `200 OfficeShift`; errors `400 validation_failed` `reasonCode`, `404`, `409 stale_revision`, `409 conflict` `close_reason_not_missing`; audit `shift.close_reason` `{ reasonCode }`.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_force_close.rs`:

```rust
//! The office closes a shared shift whole (plan 2b, spec §4.2 «Принудительное закрытие»): every
//! part still open closes as the office's, the row names who had not closed, late data stays late;
//! and the office gives the reason a shift its devices closed without (§12.9).

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    accepted, admin, audit_trail, close_from_office, fact, instant, ok_scan, box_id, receipts,
    record_id, shift_closed, shift_setup,
};
use support::multi::{leave, participant, shared};

#[tokio::test]
async fn the_office_closes_every_open_part_and_names_who_had_not_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK);
    let closed = close_from_office(&admin, &shift, "Станция Б сломалась").await;
    assert_eq!(closed["status"], json!("closed"));
    assert_eq!(
        closed["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| (participant["state"].clone(), participant["closedBy"].clone()))
            .collect::<Vec<_>>(),
        vec![
            (json!("closed"), json!("office_user")),
            (json!("closed"), json!("office_user"))
        ]
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.force_closed").await,
        vec![admin.row(
            "shift.force_closed",
            "shift",
            &shift,
            json!({
                "reason": "Станция Б сломалась",
                "notClosed": [
                    { "deviceId": a.id, "state": "active" },
                    { "deviceId": b.id, "state": "left" }
                ]
            })
        )]
    );
    assert!(audit_trail(&admin.app, "shift.close").await.is_empty());
    // A's later scan is taken and late; its close is already closed.
    let late_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[
                fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(1, 0))),
                fact(&record_id(2), "shift_closed", &shift, shift_closed(None, 1, 0, None, &instant(9, 0)))
            ]
        )
        .await,
        vec![
            accepted(&record_id(1)),
            json!({ "id": record_id(2), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(
        participant(&admin, &shift, &a.id).await,
        ("closed".to_owned(), None, Some("office_user".to_owned()), None, Some(late_at.clone()))
    );
    let shift_late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM shifts WHERE id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(shift_late, Some(late_at));
}

#[tokio::test]
async fn the_office_gives_the_reason_a_shared_shift_closed_without() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(5)).await;
    let close = |n: u32| {
        fact(&record_id(n), "shift_closed", &shift, shift_closed(Some(5), 0, 0, None, &instant(30, 0)))
    };
    receipts(&admin.app, &a.key, &[close(1)]).await;
    receipts(&admin.app, &b.key, &[close(1)]).await;
    let path = format!("/v1/office/shifts/{shift}");
    let (_, current) = admin.call("GET", &path, None).await;
    assert_eq!(current["closeReasonMissing"], json!(true));
    let reason_path = format!("{path}/close-reason");
    let (status, refused) = admin
        .call("PUT", &reason_path, Some(json!({ "reasonCode": "broken", "expectedRev": current["rev"] })))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("reasonCode"))
    );
    let (status, stale) = admin
        .call("PUT", &reason_path, Some(json!({ "reasonCode": "equipment_stop", "expectedRev": 1 })))
        .await;
    assert_eq!((status, stale["error"]["code"].clone()), (StatusCode::CONFLICT, json!("stale_revision")));
    let (status, set) = admin
        .call(
            "PUT",
            &reason_path,
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(
        (set["closeReasonCode"].clone(), set.get("closeReasonMissing").is_none()),
        (json!("equipment_stop"), true)
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close_reason").await,
        vec![admin.row("shift.close_reason", "shift", &shift, json!({ "reasonCode": "equipment_stop" }))]
    );
    let (status, again) = admin
        .call("PUT", &reason_path, Some(json!({ "reasonCode": "equipment_stop", "expectedRev": set["rev"] })))
        .await;
    assert_eq!(
        (status, again["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("close_reason_not_missing"))
    );
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_force_close`
      Expected: FAIL: the participants stay `active`/`left` after the office's close, `shift.force_closed` is empty, and `PUT …/close-reason` answers `405`.

- [ ] **Step 3: Implement.** In `audit.rs` after `SHIFT_PART_CLOSED`:

```rust
    /// The office closed an active shift whole (plan 2b; `shift.close` before it): every part
    /// still open closed as the office's; `{ reason, notClosed: [{ deviceId, state }] }`.
    pub const SHIFT_FORCE_CLOSED: &str = "shift.force_closed";
    /// The office gave the reason a shift its devices closed without lacked (plan 2b, spec
    /// §12.9): `{ reasonCode }`.
    pub const SHIFT_CLOSE_REASON: &str = "shift.close_reason";
```

In `office_shifts.rs` add `ShiftCloseReasonSet` and `shift_close_reasons` to the `markiro_proto` import. Replace `close_shift` (`:853-911`, doc included) with:

```rust
/// `POST /v1/office/shifts/{id}/close`: the office closes an active shift whole (plan 2b, spec
/// §4.2 «Принудительное закрытие») with its reason in words, over `expectedRev`; a planned or a
/// closed one is `shift_status`. Every part still active or left closes as the office's, and
/// `shift.force_closed` names them (`notClosed`, first entry first): what the office's warning
/// «Не закрыли: …» showed, exact because every change of a part stamps the shift's `rev`. Facts a
/// device sends for the shift afterwards are taken and marked late (plan 2a2); nothing reopens it.
pub async fn close_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(close): ApiJson<ShiftClose>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    let reason = validate::close_reason("reason", &close.reason)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != close.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    if current.status != ShiftStatus::Active {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let not_closed = shift_participants::close_open_by_office(&mut tx, &id, &at).await?;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'office_user', \
         closed_by = ?, close_reason_text = ?, rev = ? WHERE id = ?",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&reason)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let not_closed: Vec<serde_json::Value> = not_closed
        .iter()
        .map(|(device_id, state)| json!({ "deviceId": device_id, "state": state.as_str() }))
        .collect();
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_FORCE_CLOSED,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "reason": reason, "notClosed": not_closed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let closed = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(closed))
}

/// `PUT /v1/office/shifts/{id}/close-reason` (plan 2b, spec §12.9): the office gives one of the six
/// reason codes to a shift its last device closed without the reason the shift-wide total needed
/// (`closeReasonMissing`), over `expectedRev`; administrators and technologists (`planShifts`).
/// The refusals in order: a code that is none of the six (`validation_failed` on `reasonCode`, even
/// for an unknown id), the lookup (404), a stale revision, a shift that lacks no reason (`conflict`
/// on `close_reason_not_missing`). It writes `shift.close_reason` `{ reasonCode }`.
pub async fn set_close_reason(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(set): ApiJson<ShiftCloseReasonSet>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    if !shift_close_reasons::ALL.contains(&set.reason_code.as_str()) {
        return Err(ApiError::validation(
            "reasonCode",
            "one of the six close reason codes",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != set.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    if !current.close_reason_missing {
        return Err(ApiError::conflict(
            "close_reason_not_missing",
            "the shift lacks no close reason",
        ));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET close_reason_code = ?, close_reason_missing = 0, rev = ? WHERE id = ?",
    )
    .bind(&set.reason_code)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_CLOSE_REASON,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "reasonCode": set.reason_code }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

In `server.rs` after the `…/close` route (`:600-603`):

```rust
        .route(
            "/v1/office/shifts/{id}/close-reason",
            put(crate::routes::office_shifts::set_close_reason),
        )
```

Update the module doc of `office_shifts.rs` (`:1-4`) to list `PUT …/{id}/close-reason`.

- [ ] **Step 4: Update the existing tests that pinned the old office audit row** (product decision D10; name these in the report):
  - `apps/standalone/host/tests/office_shifts.rs:1543-1549`: `audit_trail(&admin.app, "shift.force_closed")`, row action `"shift.force_closed"`, details `json!({ "reason": "Станция линии 1 вышла из строя", "notClosed": [] })` (that test opens the shift straight in its table, with no participant row).
  - `:1917-1922`: `audit_trail(&admin.app, "shift.force_closed")` and `Some(json!({ "reason": stored, "notClosed": [] }))`.
  - `:2062-2069`: `audit_trail(&admin.app, "shift.force_closed")`, row action `"shift.force_closed"`, details `json!({ "reason": "Сбой", "notClosed": [] })`.
  - `apps/standalone/host/tests/facts.rs:2872-2875`: replace with

```rust
    let forced = audit_trail(&admin.app, "shift.force_closed").await;
    assert_eq!(forced.len(), 1);
    assert!(forced.iter().all(|row| row.0 == "office_user"));
    assert!(audit_trail(&admin.app, "shift.close").await.is_empty());
```

- [ ] **Step 5: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_force_close --test office_shifts --test facts --test office_exports --test office_cards`
      Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/office_shifts.rs apps/standalone/host/src/server.rs apps/standalone/host/src/audit.rs \
  apps/standalone/host/tests/multi_station_force_close.rs apps/standalone/host/tests/office_shifts.rs apps/standalone/host/tests/facts.rs
git -C "$WT" commit -m "feat(standalone): office closes a shared shift whole (shift.force_closed) and gives a missing close reason

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The line's limit (`maxStations`)

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs:1443-1471` (`OfficeLine`, `LineUpdate`)
- Modify fixture: `apps/standalone/proto/fixtures/office-line.json`; create `line-update-max-stations.json`, `error-line-stations-in-use.json`
- Modify: `apps/standalone/proto/tests/fixtures.rs` (new test at the end)
- Modify: `apps/standalone/src/host/protocol.ts:694-700` (`officeLineSchema`), `:1862-1869` (`lineUpdateSchema`); `apps/standalone/test/protocol.test.ts` (`RESPONSES`, `REQUESTS`, a new `it`)
- Modify: `apps/standalone/host/src/routes/lines.rs:20-47`, `:55-65`, `:113-185`; `apps/standalone/host/src/validate.rs` (after `:544`); `apps/standalone/host/src/audit.rs:58-59`
- Modify (existing tests): `apps/standalone/host/tests/lines.rs:48`, `:71`, `:83`, `:230`, `:272`, `:323`
- Test: `apps/standalone/host/tests/multi_station_lines.rs` (new)

**Interfaces:**

- Consumes: Task 4 `shift_participants::line_slots_in_use`; Task 2 `maxStationsSchema`, `MAX_STATIONS`.
- Produces: `OfficeLine.max_stations: u32` (`#[serde(default = "default_max_stations")]`, 1 for an older host); `LineUpdate.max_stations: Option<u32>`; `pub const validate::MAX_STATIONS: u32 = 16`; `pub fn validate::max_stations(field: &str, value: u32) -> Result<u32, ApiError>`; `PUT /v1/office/lines/{id}` takes `maxStations` (administrators); errors `400 validation_failed` `maxStations`, `409 conflict` `line_stations_in_use` `{ active }`; audit `actions::LINE_MAX_STATIONS_CHANGED = "line.max_stations_changed"` `{ from, to }`.

- [ ] **Step 1: Write the fixtures.** Replace `apps/standalone/proto/fixtures/office-line.json` with:

```json
{
  "id": "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61",
  "name": "Линия 2",
  "archived": false,
  "maxStations": 2,
  "rev": 40
}
```

`apps/standalone/proto/fixtures/line-update-max-stations.json`:

```json
{ "maxStations": 3, "expectedRev": 40 }
```

`apps/standalone/proto/fixtures/error-line-stations-in-use.json`:

```json
{
  "error": {
    "code": "conflict",
    "message": "more devices work a shift of this line than the new limit",
    "details": { "constraint": "line_stations_in_use", "active": 3 }
  }
}
```

- [ ] **Step 2: Write the failing tests.** Append to `apps/standalone/proto/tests/fixtures.rs` (import `LineUpdate` and `OfficeLine` if not imported):

```rust
#[test]
fn a_lines_limit_round_trips_and_an_older_host_means_one() {
    let line: OfficeLine = round_trip("office-line.json");
    assert_eq!(line.max_stations, 2);
    let mut older = fixture("office-line.json");
    older.as_object_mut().unwrap().remove("maxStations");
    let older: OfficeLine = serde_json::from_value(older).unwrap();
    assert_eq!(older.max_stations, 1);
    let update: LineUpdate = round_trip("line-update-max-stations.json");
    assert_eq!(update.max_stations, Some(3));
    let plain: LineUpdate = round_trip("line-update.json");
    assert_eq!(plain.max_stations, None);
    let in_use: ErrorBody = round_trip("error-line-stations-in-use.json");
    let details = in_use.error.details.expect("details");
    assert_eq!(
        (details["constraint"].as_str(), details["active"].as_u64()),
        (Some("line_stations_in_use"), Some(3))
    );
}
```

In `apps/standalone/test/protocol.test.ts` add `["error-line-stations-in-use.json", errorBodySchema],` to `RESPONSES` and `["line-update-max-stations.json", lineUpdateSchema],` to `REQUESTS`, and inside the `describe("several devices in one shift (plan 2b)", …)` block:

```ts
it("reads a line's limit and bounds it in an update", () => {
  expect(officeLineSchema.parse(fixture("office-line.json")).maxStations).toBe(2);
  expect(lineUpdateSchema.safeParse({ maxStations: 16, expectedRev: 1 }).success).toBe(true);
  for (const maxStations of [0, 17, 1.5]) {
    expect(lineUpdateSchema.safeParse({ maxStations, expectedRev: 1 }).success).toBe(false);
  }
});
```

Create `apps/standalone/host/tests/multi_station_lines.rs`:

```rust
//! A line's limit of devices in one shift (plan 2b, spec §7 «Линия», §12.8): administrators set
//! 1–16, never below the devices working an active shift of the line; a change writes
//! `line.max_stations_changed`, and the stations' feed record of the line is unchanged.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_setup};
use support::multi::shared;

#[tokio::test]
async fn an_administrator_sets_the_limit_never_below_the_devices_at_work() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // Two devices work an active shift of the line (its limit is 2).
    let (_a, _b, _shift, _) = shared(&admin, &setup, None).await;
    let path = format!("/v1/office/lines/{}", setup.line);
    let current = |lines: &serde_json::Value| {
        lines
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["id"] == json!(setup.line))
            .unwrap()
            .clone()
    };
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let line = current(&lines);
    assert_eq!(line["maxStations"], json!(2));
    // Signed in before the counts: a sign-in writes its own audit row.
    let tech = admin.technologist().await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = admin
        .call("PUT", &path, Some(json!({ "maxStations": 1, "expectedRev": line["rev"] })))
        .await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "line_stations_in_use", "active": 2 })
        )
    );
    for bad in [0, 17] {
        let (status, refused) = admin
            .call("PUT", &path, Some(json!({ "maxStations": bad, "expectedRev": line["rev"] })))
            .await;
        assert_eq!(
            (status, refused["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("maxStations"))
        );
    }
    let (status, _) = admin
        .call_as(&tech, "PUT", &path, Some(json!({ "maxStations": 3, "expectedRev": line["rev"] })))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!((host_revision(&admin.app).await, audit_rows(&admin.app).await), (revision, rows));
    let (status, raised) = admin
        .call("PUT", &path, Some(json!({ "maxStations": 3, "expectedRev": line["rev"] })))
        .await;
    assert_eq!(status, StatusCode::OK, "{raised}");
    assert_eq!(
        (raised["maxStations"].clone(), raised["rev"].clone()),
        (json!(3), json!(revision + 1))
    );
    assert_eq!(
        audit_trail(&admin.app, "line.max_stations_changed").await,
        vec![admin.row(
            "line.max_stations_changed",
            "line",
            &setup.line,
            json!({ "from": 2, "to": 3 })
        )]
    );
    assert!(audit_trail(&admin.app, "line.update").await.is_empty());
    // The same limit again changes nothing.
    let (status, same) = admin
        .call("PUT", &path, Some(json!({ "maxStations": 3, "expectedRev": raised["rev"] })))
        .await;
    assert_eq!((status, same["rev"].clone()), (StatusCode::OK, raised["rev"].clone()));
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    // The stations' feed record of the line is the name and the flag, as before.
    let feed = admin.feed(revision).await;
    assert_eq!(
        feed,
        json!([{ "entity": "lines", "id": setup.line, "rev": revision + 1, "deleted": false,
                 "data": { "name": "Линия 1", "archived": false } }])
    );
}
```

- [ ] **Step 3: Run them to verify they fail.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures a_lines_limit` and `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_lines`
      Expected: FAIL: `office-line.json changed on round trip` / no field `max_stations`; the host test finds `line["maxStations"]` `null`.

- [ ] **Step 4: Implement.** `proto/src/lib.rs` `OfficeLine` (`:1446-1451`) gains, after `archived`:

```rust
    /// How many devices one shift of the line takes at a time (plan 2b, protocol 7); a host
    /// before it sends none, which reads as stage 2a's one.
    #[serde(default = "default_max_stations")]
    pub max_stations: u32,
```

with, below the struct:

```rust
fn default_max_stations() -> u32 {
    1
}
```

`LineUpdate` (`:1467-1471`) gains before `expected_rev`:

```rust
    /// The line's new limit of devices in one shift, 1–16 (plan 2b); administrators only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_stations: Option<u32>,
```

`protocol.ts`: `officeLineSchema` gains `maxStations: maxStationsSchema.optional(),` after `archived`; `lineUpdateSchema` gains `maxStations: maxStationsSchema.optional(),` after `archived`.

`validate.rs` after `MAX_PLANNED_QTY` (`:544`):

```rust
/// The most devices one shift of a line takes at a time (plan 2b): the CHECK of `0052`.
pub const MAX_STATIONS: u32 = 16;

/// A line's limit of devices in one shift: 1-[`MAX_STATIONS`].
pub fn max_stations(field: &str, value: u32) -> Result<u32, ApiError> {
    if (1..=MAX_STATIONS).contains(&value) {
        Ok(value)
    } else {
        Err(ApiError::validation(field, format!("1-{MAX_STATIONS}")))
    }
}
```

`audit.rs` after `LINE_UPDATE` (`:59`):

```rust
    /// An administrator changed a line's limit of devices in one shift (plan 2b): `{ from, to }`.
    /// A name or archive change in the same request writes its own `line.update`.
    pub const LINE_MAX_STATIONS_CHANGED: &str = "line.max_stations_changed";
```

`routes/lines.rs`: add `use crate::shift_participants;`; `LineRow` gains `max_stations: u32`; `From<LineRow>` sets `max_stations: row.max_stations`; both `SELECT`s become `SELECT id, name, archived, max_stations, rev FROM lines …`. Add:

```rust
/// `conflict` on `line_stations_in_use`: an active shift of the line has more devices at work than
/// the new limit (plan 2b); `details.active` is the busiest shift's count.
fn stations_in_use(active: u32) -> ApiError {
    ApiError::conflict(
        "line_stations_in_use",
        "more devices work a shift of this line than the new limit",
    )
    .with_details(json!({ "constraint": "line_stations_in_use", "active": active }))
}
```

Replace `update_line` (`:113-185`) with:

```rust
/// `PUT /v1/office/lines/{id}` (administrators, `expectedRev`): its name, its archive flag and
/// (plan 2b) its limit of devices in one shift, 1–16 (`validation_failed` on `maxStations`), never
/// below the live devices working an active shift of the line (`conflict` on
/// `line_stations_in_use`). A name or flag change writes `line.update`, a limit change
/// `line.max_stations_changed`; nothing changed writes nothing and takes no revision.
pub async fn update_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<LineUpdate>,
) -> Result<Json<OfficeLine>, ApiError> {
    context.require_admin()?;
    let renamed = update
        .name
        .as_deref()
        .map(|name| validate::line_name("name", name))
        .transpose()?;
    let limit = update
        .max_stations
        .map(|value| validate::max_stations("maxStations", value))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such line"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let name = renamed
        .as_ref()
        .map_or(current.name.as_str(), |(name, _)| name.as_str());
    let archived = update.archived.unwrap_or(current.archived);
    let max_stations = limit.unwrap_or(current.max_stations);
    // A line back from the archive takes a seat of the license (plan ЛЦ-2).
    if current.archived && !archived {
        crate::license::seats::require_seat(&state, &mut tx, crate::license::seats::Quota::Lines)
            .await?;
    }
    if max_stations < current.max_stations {
        let in_use = shift_participants::line_slots_in_use(&mut tx, &id).await?;
        if max_stations < in_use {
            return Err(stations_in_use(in_use));
        }
    }
    let details = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("archived", json!(current.archived), json!(archived)),
    ]);
    let limit_changed = max_stations != current.max_stations;
    if details.is_none() && !limit_changed {
        // Nothing actually changed: report the line as-is without bumping the revision, writing
        // a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE lines SET name = COALESCE(?, name), name_key = COALESCE(?, name_key), \
         archived = ?, max_stations = ?, rev = ? WHERE id = ?",
    )
    .bind(renamed.as_ref().map(|(name, _)| name))
    .bind(renamed.as_ref().map(|(_, name_key)| name_key))
    .bind(archived)
    .bind(max_stations)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(name_taken)?;
    if let Some(details) = details {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::LINE_UPDATE,
                target_type: Some("line"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details,
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    if limit_changed {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::LINE_MAX_STATIONS_CHANGED,
                target_type: Some("line"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details: json!({ "from": current.max_stations, "to": max_stations }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("line vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
```

Update the module doc (`:1-5`) with: «Since plan 2b a line also has its limit of devices in one shift (`maxStations`).»

- [ ] **Step 5: Update the existing exact line answers** in `apps/standalone/host/tests/lines.rs` (the answer gained a field; no behaviour changed): at `:48`, `:71`, `:83`, `:230`, `:272`, `:323` insert `"maxStations": 1, ` before `"rev"` in each `json!({ "id": …, "name": …, "archived": …, "rev": … })`. The feed assertions (`:57`, `:105`, `:244`, `:290`) stay as they are.

- [ ] **Step 6: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures`, `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_lines --test lines --test devices --test cloud_import --test changes`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`, `… typecheck`, `… lint`
      Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/proto/src/lib.rs apps/standalone/proto/tests/fixtures.rs apps/standalone/proto/fixtures/office-line.json \
  apps/standalone/proto/fixtures/line-update-max-stations.json apps/standalone/proto/fixtures/error-line-stations-in-use.json \
  apps/standalone/src/host/protocol.ts apps/standalone/test/protocol.test.ts \
  apps/standalone/host/src/routes/lines.rs apps/standalone/host/src/validate.rs apps/standalone/host/src/audit.rs \
  apps/standalone/host/tests/lines.rs apps/standalone/host/tests/multi_station_lines.rs
git -C "$WT" commit -m "feat(standalone): a line's limit of devices in one shift (maxStations, line.max_stations_changed)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The export's operation instant of a shared shift

**Files:**

- Modify: `apps/standalone/host/src/routes/office_exports.rs:56-64` (`SHIFT_SQL` and its doc)
- Test: `apps/standalone/host/tests/multi_station_exports.rs` (new)

**Interfaces:**

- Consumes: Task 8 (part closes are `accepted` events), Task 10 (forced close).
- Produces: `ShiftExportRows.shift.stationClosedAt` = the device instant of the close that closed the shift (`shifts.closed_by` when `closed_by_kind = 'device'`), `null` for an office-closed shift.

- [ ] **Step 1: Write the failing test** `apps/standalone/host/tests/multi_station_exports.rs`:

```rust
//! The ЧЗ document of a shared shift (plan 2b, spec §7 «Экспорты»): its operation instant is the
//! close of the device that closed the shift, not an earlier part's; an office-closed shift has
//! none.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, close_from_office, fact, instant, receipts, record_id, shift_closed, shift_setup, Admin};
use support::multi::shared;

async fn station_closed_at(admin: &Admin, shift: &str) -> Value {
    let (status, source) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/export-source"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{source}");
    source["shift"]["stationClosedAt"].clone()
}

#[tokio::test]
async fn a_shared_shifts_document_takes_the_instant_of_its_last_closer() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let close = |at: String| fact(&record_id(1), "shift_closed", &shift, shift_closed(None, 0, 0, None, &at));
    receipts(&admin.app, &a.key, &[close(instant(60, 0))]).await;
    receipts(&admin.app, &b.key, &[close(instant(120, 250))]).await;
    assert_eq!(station_closed_at(&admin, &shift).await, json!(instant(120, 250)));
}

#[tokio::test]
async fn a_shift_the_office_closed_after_a_part_takes_no_station_instant() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, _b, shift, _) = shared(&admin, &setup, None).await;
    receipts(
        &admin.app,
        &a.key,
        &[fact(&record_id(1), "shift_closed", &shift, shift_closed(None, 0, 0, None, &instant(60, 0)))],
    )
    .await;
    close_from_office(&admin, &shift, "Сбой станции").await;
    assert_eq!(station_closed_at(&admin, &shift).await, Value::Null);
}
```

- [ ] **Step 2: Run it to verify it fails.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_exports`
      Expected: FAIL: the first test gets A's `instant(60, 0)`, the second `instant(60, 0)` instead of `null`.

- [ ] **Step 3: Implement.** Replace `SHIFT_SQL` and its doc (`:56-64`):

```rust
/// The shift, its product's name now and the device instant of the close that closed it: the
/// accepted close of `closed_by` when a device closed the shift (plan 2b: in a shared shift every
/// part's close is accepted, and the shift's own is its last closer's); an office-closed shift has
/// none.
pub const SHIFT_SQL: &str = "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, \
     s.status, s.production_date, p.name AS product_name, s.pallets_enabled, s.closed_at, \
     (SELECT e.closed_at FROM shift_close_events e WHERE e.shift_id = s.id \
      AND e.outcome = 'accepted' AND s.closed_by_kind = 'device' AND e.device_id = s.closed_by \
      ORDER BY e.received_at DESC, e.id DESC LIMIT 1) AS station_closed_at, \
     s.late_data_at \
     FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?";
```

- [ ] **Step 4: Run the tests to verify they pass.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_exports --test office_exports --test office_export_files --test office_reports`
      Expected: PASS (a one-device shift's single accepted close is its closer's, as before).

- [ ] **Step 5: Commit.**

```bash
git -C "$WT" add apps/standalone/host/src/routes/office_exports.rs apps/standalone/host/tests/multi_station_exports.rs
git -C "$WT" commit -m "fix(standalone): a shared shift's export takes the instant of the device that closed it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Two stations and a handheld in one shift (integration scenario)

**Files:**

- Test: `apps/standalone/host/tests/multi_station_scenario.rs` (new)

**Interfaces:**

- Consumes: everything above; helpers of `tests/support/multi.rs` and `tests/support/app.rs`.
- Produces: the acceptance scenario of spec §9 step 1 on the host (§11 «Дубль скана на двух станциях»).

- [ ] **Step 1: Write the scenario** `apps/standalone/host/tests/multi_station_scenario.rs`:

```rust
//! Several devices in one shift end to end on the host (plan 2b, spec §9.1, §11): two stations
//! scanning the same code meet the registry's conflict and share one total; a validation shift
//! counts its units per device; a handheld is a full participant and closes the shift last; an
//! offline last closer closes it without a reason the office then gives; a full line and an older
//! build are refused as each expects.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_id, code, fact, instant, ok_scan, plan_shift, receipts, record_id,
    shift_body, shift_closed, shift_setup, Admin,
};
use support::multi::{
    admin_station_on, allow, call, constraint, enter, handheld_on, open_shared, shared,
    station_on, status_of, Device, HANDHELD, MULTI,
};

async fn device_view(admin: &Admin, device: &Device, shift: &str) -> Value {
    let (status, list) = call(admin, &device.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!(shift))
        .cloned()
        .unwrap()
}

fn parts(view: &Value) -> Vec<(Value, Value)> {
    view["byDevice"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| (part["deviceId"].clone(), part["accepted"].clone()))
        .collect()
}

#[tokio::test]
async fn two_stations_scanning_one_code_meet_the_conflict_and_share_one_total() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, number) = shared(&admin, &setup, Some(3)).await;
    assert_eq!(
        receipts(&admin.app, &a.key, &[fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(10, 0)))]).await,
        vec![accepted(&record_id(1))]
    );
    // B scanned the same code later: the earliest scan keeps it.
    let late = receipts(
        &admin.app,
        &b.key,
        &[fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(2), &instant(20, 0)))],
    )
    .await;
    assert_eq!(
        (
            late[0]["outcome"].clone(),
            late[0]["details"]["winner"]["deviceId"].clone(),
            late[0]["details"]["winner"]["shiftNumber"].clone(),
            late[0]["details"]["winner"]["sameDevice"].clone()
        ),
        (json!("conflict"), json!(a.id), json!(number), json!(false))
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[fact(&record_id(2), "scan", &shift, ok_scan(2, &box_id(2), &instant(21, 0)))]).await,
        vec![accepted(&record_id(2))]
    );
    for device in [&a, &b] {
        let view = device_view(&admin, device, &shift).await;
        assert_eq!(view["totals"]["accepted"], json!(2));
        assert_eq!(parts(&view), vec![(json!(a.id), json!(1)), (json!(b.id), json!(1))]);
    }
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM code_conflicts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(conflicts, 1);
    // A closes first, B last: the shift-wide 2 misses the plan of 3, B gives the reason.
    let close = |planned: u32, actual: u32, reason: Option<&str>, at: u32| {
        fact(&record_id(9), "shift_closed", &shift, shift_closed(Some(planned), actual, 0, reason, &instant(at, 0)))
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3, 1, None, 100)]).await,
        vec![json!({ "id": record_id(9), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(
        receipts(&admin.app, &b.key, &[close(3, 1, Some("material_shortage"), 110)]).await,
        vec![accepted(&record_id(9))]
    );
    let row: (String, String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, closed_by, close_reason_code, close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(row, ("closed".to_owned(), b.id.clone(), Some("material_shortage".to_owned()), false));
    let view = device_view(&admin, &a, &shift).await;
    assert_eq!((view["myState"].clone(), view["status"].clone()), (json!("closed"), json!("closed")));
}

#[tokio::test]
async fn a_validation_shift_counts_each_devices_units_from_the_registry() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let mut body = shift_body(&setup);
    body["mode"] = json!("validation");
    let shift = plan_shift(&admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    for device in [&a, &b] {
        let (status, entered) = enter(&admin, device, &id, &["validation-v1", MULTI]).await;
        assert_eq!(status, StatusCode::OK, "{entered}");
    }
    let unit = |n: u32, at: u32| {
        json!({
            "scannedAt": instant(at, 0), "verdict": "ok", "duplicateSource": null,
            "rawKind": "km", "rawLength": 38, "code": code(n), "boxId": null
        })
    };
    assert_eq!(receipts(&admin.app, &a.key, &[fact(&record_id(1), "scan", &id, unit(1, 1))]).await, vec![accepted(&record_id(1))]);
    assert_eq!(receipts(&admin.app, &b.key, &[fact(&record_id(1), "scan", &id, unit(2, 2))]).await, vec![accepted(&record_id(1))]);
    let view = device_view(&admin, &b, &id).await;
    assert_eq!(
        (view["totals"]["accepted"].clone(), view["totals"]["boxesClosed"].clone()),
        (json!(2), json!(0))
    );
    assert_eq!(parts(&view), vec![(json!(a.id), json!(1)), (json!(b.id), json!(1))]);
}

#[tokio::test]
async fn a_handheld_works_the_shift_as_a_full_participant_and_closes_it_last() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let h = handheld_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    // A handheld without the capability finds it busy, as every handheld build before plan 2b.
    let (status, busy) = enter(&admin, &h, &shift, &[HANDHELD]).await;
    assert_eq!((status, constraint(&busy)), (StatusCode::CONFLICT, json!("shift_busy")));
    let (status, joined) = enter(&admin, &h, &shift, &[HANDHELD, MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["participants"][1]["deviceKind"], json!("handheld"));
    assert_eq!(
        receipts(&admin.app, &h.key, &[fact(&record_id(1), "scan", &shift, ok_scan(7, &box_id(7), &instant(30, 0)))]).await,
        vec![accepted(&record_id(1))]
    );
    let close = |at: u32| fact(&record_id(5), "shift_closed", &shift, shift_closed(None, 0, 0, None, &instant(at, 0)));
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(100)]).await,
        vec![json!({ "id": record_id(5), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    assert_eq!(receipts(&admin.app, &h.key, &[close(110)]).await, vec![accepted(&record_id(5))]);
    let closer: String = sqlx::query_scalar("SELECT closed_by FROM shifts WHERE id = ?")
        .bind(&shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!((status_of(&admin, &shift).await, closer), ("closed".to_owned(), h.id.clone()));
}

#[tokio::test]
async fn an_offline_last_closer_closes_without_a_reason_and_the_office_gives_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(10)).await;
    assert_eq!(
        receipts(&admin.app, &a.key, &[fact(&record_id(1), "shift_closed", &shift, shift_closed(Some(10), 0, 0, None, &instant(50, 0)))]).await,
        vec![json!({ "id": record_id(1), "outcome": "accepted", "details": { "partClosed": true } })]
    );
    // B worked without the link and sends its queue at once: two scans and its close.
    let queue = [
        fact(&record_id(1), "scan", &shift, ok_scan(1, &box_id(1), &instant(10, 0))),
        fact(&record_id(2), "scan", &shift, ok_scan(2, &box_id(1), &instant(11, 0))),
        fact(&record_id(3), "shift_closed", &shift, shift_closed(Some(10), 2, 0, None, &instant(60, 0))),
    ];
    assert_eq!(
        receipts(&admin.app, &b.key, &queue).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "reasonMissing": true } })
        ]
    );
    let path = format!("/v1/office/shifts/{shift}");
    let (_, office) = admin.call("GET", &path, None).await;
    assert_eq!(
        (office["status"].clone(), office["closeReasonMissing"].clone(), office["totals"]["acceptedUnits"].clone()),
        (json!("closed"), json!(true), json!(2))
    );
    let (status, set) = admin
        .call(
            "PUT",
            &format!("{path}/close-reason"),
            Some(json!({ "reasonCode": "production_order_changed", "expectedRev": office["rev"] })),
        )
        .await;
    assert_eq!((status, set["closeReasonCode"].clone()), (StatusCode::OK, json!("production_order_changed")));
}

#[tokio::test]
async fn the_line_limit_and_older_builds_are_refused_as_each_expects() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    // Limit 1: a new build sees the line full, an older build sees the shift busy.
    let (status, full) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!((status, constraint(&full)), (StatusCode::CONFLICT, json!("shift_line_full")));
    let (status, busy) = call(&admin, &b.key, "POST", &format!("/v1/device/shifts/{shift}/enter"), None).await;
    assert_eq!((status, constraint(&busy)), (StatusCode::CONFLICT, json!("shift_busy")));
}
```

- [ ] **Step 2: Run it.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test multi_station_scenario`
      Expected: PASS (5 tests) — all behaviour exists after Tasks 1–12. If any fails, the failing expectation is a defect of an earlier task: fix it there (with a focused failing test in that task's file), never by loosening this scenario.

- [ ] **Step 3: Run the whole host and proto suites** (no other heavy suite at the same time):
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host -p markiro-proto --no-fail-fast`
      Expected: PASS. Then `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check`: clean.

- [ ] **Step 4: Commit.**

```bash
git -C "$WT" add apps/standalone/host/tests/multi_station_scenario.rs
git -C "$WT" commit -m "test(standalone): host scenario — two stations and a handheld in one shift

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Protocol 7 and app version 1.1.0

**Files:**

- Modify: `apps/standalone/proto/src/lib.rs:17-30` (doc and `PROTOCOL_VERSION`)
- Modify: `apps/standalone/src/host/protocol.ts:7-13`
- Modify fixtures: `apps/standalone/proto/fixtures/hello.json`, `hello-restored.json`, `hello-replaced.json` (`"protocol": 7`), `hello-future.json` (`"protocol": 8`), `compatibility.json`
- Modify tests: `apps/standalone/proto/tests/fixtures.rs:88-112`, `:1970-1978`; `apps/standalone/test/protocol.test.ts:556-558`, `:3485-3486`, `:3883-3886`
- Modify versions: `apps/standalone/package.json:3`, `apps/standalone/src-tauri/tauri.conf.json:4`, `apps/standalone/host/Cargo.toml:3`, `apps/standalone/proto/Cargo.toml:3`, `apps/standalone/src-tauri/Cargo.toml:3`, `apps/standalone/Cargo.lock` (via cargo), `apps/standalone/CHANGELOG.md`

**Interfaces:**

- Consumes: Tasks 2–13 (the new meaning of `shift_closed`, the capability, the new fields).
- Produces: `markiro_proto::PROTOCOL_VERSION == 7`, `MIN_PROTOCOL_VERSION == 1`, TS `PROTOCOL_VERSION === 7`, build version `1.1.0`. `tools/standalone-release/releases.json` is NOT changed (the owner records 1.1.0 when releasing).

- [ ] **Step 1: Re-check the release window.** Run `cat "$WT/tools/standalone-release/releases.json"` and `grep -n '"version"' "$WT/apps/standalone/package.json"`. Expected: the last recorded release is the build's version (`1.0.0`, protocol 6). If the build's version is already newer and unrecorded, skip the version edits of Step 5 and record that in the report.

- [ ] **Step 2: Write the failing expectations.** In `apps/standalone/proto/tests/fixtures.rs` rename `this_build_speaks_protocol_six_and_the_current_hello_fixtures_say_so` to `this_build_speaks_protocol_seven_and_the_current_hello_fixtures_say_so` and change `assert_eq!(PROTOCOL_VERSION, 6);` to `assert_eq!(PROTOCOL_VERSION, 7);`. In `hello_ignores_fields_added_by_newer_hosts` change `assert_eq!(hello.protocol, 7);` to `assert_eq!(hello.protocol, 8);`, and in `envelope_decides_compatibility_before_the_rest` replace the five `compatibility_for` lines (`:104-108`) with:

```rust
    assert_eq!(compatibility_for(2, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(3, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(6, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(7, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(8, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(9, &future), Compatibility::HostTooOld);
```

In `apps/standalone/test/protocol.test.ts` change `expect(PROTOCOL_VERSION).toBe(6);` to `toBe(7)` at `:558`, `:3486` and `:3886`, and the comment at `:557` to «Protocol 4 brought the modes, 5 the duplicate print, 6 the handheld on the host, 7 several devices in one shift.»

- [ ] **Step 3: Run them to verify they fail.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures protocol` and `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts`
      Expected: FAIL (`left: 6, right: 7`).

- [ ] **Step 4: Raise the protocol.** `apps/standalone/proto/src/lib.rs`: insert at the start of the doc block that ends in `pub const PROTOCOL_VERSION` (`:17`) the sentence «7 came with plan 2b (several devices in one shift): a `shift_closed` fact closes the sender's part and the shift only with its last part, the capability `multi-station-v1`, `POST /v1/device/shifts/{id}/leave`, a shift's `participants`, `totals` and `byDevice`, and a line's `maxStations`; a station of protocol 7 against a host of 6 is `host_too_old`, so it never sends a part's close to a host that would close the whole shift.» and set `pub const PROTOCOL_VERSION: u32 = 7;`. `apps/standalone/src/host/protocol.ts`: extend the doc (`:7-12`) with «, 7 since plan 2b (several devices in one shift)» and set `export const PROTOCOL_VERSION = 7;`. Fixtures: in `hello.json`, `hello-restored.json`, `hello-replaced.json` set `"protocol": 7`; in `hello-future.json` set `"protocol": 8` (keep `"minProtocol": 3`). Replace `compatibility.json` with:

```json
{
  "cases": [
    { "client": 7, "host": { "protocol": 7, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 7, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 7, "host": { "protocol": 6, "minProtocol": 1 }, "expected": "host_too_old" },
    { "client": 6, "host": { "protocol": 6, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 7, "minProtocol": 3 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 6, "minProtocol": 6 }, "expected": "compatible" },
    { "client": 1, "host": { "protocol": 7, "minProtocol": 1 }, "expected": "compatible" },
    { "client": 6, "host": { "protocol": 5, "minProtocol": 1 }, "expected": "host_too_old" },
    { "client": 6, "host": { "protocol": 4, "minProtocol": 4 }, "expected": "host_too_old" },
    { "client": 2, "host": { "protocol": 7, "minProtocol": 3 }, "expected": "app_too_old" },
    { "client": 6, "host": { "protocol": 8, "minProtocol": 7 }, "expected": "app_too_old" }
  ]
}
```

(The handheld's `HostFixturesTest.theHelloEnvelopeDecidesWhoMustUpdate` evaluates every case with its pure `decide` and still pins its own `PROTOCOL = 6`; no Kotlin change.)

- [ ] **Step 5: Move the build to 1.1.0.** Set `"version": "1.1.0"` in `apps/standalone/package.json` and `apps/standalone/src-tauri/tauri.conf.json`; `version = "1.1.0"` in `apps/standalone/host/Cargo.toml`, `apps/standalone/proto/Cargo.toml`, `apps/standalone/src-tauri/Cargo.toml`; refresh the lock's workspace entries with `cargo update --offline --workspace --manifest-path "$WT/apps/standalone/Cargo.toml"` (only `markiro-host`, `markiro-proto`, `markiro-standalone` change: check `git -C "$WT" diff --stat apps/standalone/Cargo.lock` shows 3 lines changed each way). Add at the top of `apps/standalone/CHANGELOG.md`, below the title:

```markdown
## 1.1.0

- Несколько станций и ТСД могут работать в одной смене на одной линии. Сколько
  устройств одновременно допускает линия, задаётся у линии (по умолчанию одно).
  Каждое устройство закрывает свою часть; смена закрывается, когда закрыли все,
  или целиком из офиса.

Сначала обновляется хост, затем станции, офис и ТСД.
```

- [ ] **Step 6: Run everything that pins the protocol or the version.**
      Run: `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-proto --test fixtures`, `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" -p markiro-host --test hello --test foundation`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/protocol.test.ts test/probe.test.ts`, `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:standalone-release:contract`
      Expected: PASS (`releases.test.mjs`: 1.1.0 at 1..7 after 1.0.0 at 1..6 keeps the window; `versions.test.mjs`: one version in five manifests and the lock). If a Vitest mock (for example `test/floor-update-entry.test.tsx:28`, `test/harness/cloud-history/main.tsx:374`) fails only because it pins protocol 6 as "this build's", set it to `PROTOCOL_VERSION`; leave update-manifest data that is not this build's protocol alone.

- [ ] **Step 7: Commit.**

```bash
git -C "$WT" add apps/standalone/proto/src/lib.rs apps/standalone/src/host/protocol.ts \
  apps/standalone/proto/fixtures/hello.json apps/standalone/proto/fixtures/hello-restored.json apps/standalone/proto/fixtures/hello-replaced.json \
  apps/standalone/proto/fixtures/hello-future.json apps/standalone/proto/fixtures/compatibility.json \
  apps/standalone/proto/tests/fixtures.rs apps/standalone/test/protocol.test.ts \
  apps/standalone/package.json apps/standalone/src-tauri/tauri.conf.json apps/standalone/host/Cargo.toml \
  apps/standalone/proto/Cargo.toml apps/standalone/src-tauri/Cargo.toml apps/standalone/Cargo.lock apps/standalone/CHANGELOG.md
git -C "$WT" commit -m "feat(standalone): protocol 7 (several devices in one shift) and build 1.1.0

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Documentation in `apps/standalone/AGENTS.md`

**Files:**

- Modify: `apps/standalone/AGENTS.md` — «## Audit» (`:103-176`), «## Protocol» (`:1696-1795`), a new subsection after «### Handhelds on the host» (`:1797-1809`), «## Shifts» (`:3673-3880`)

**Interfaces:**

- Consumes: Decisions D1–D18 and Tasks 1–14.
- Produces: the scoped guide that the station, office and handheld plans read.

- [ ] **Step 1: Edit «## Shifts».** Replace the sentence «a shift another station opened `shift_busy`: stage 2a puts one device on a shift.» with «a device that never entered an open shift and names no `multi-station-v1` `shift_busy` (stage 2a's answer, kept for older builds), and one that names it `shift_line_full` while every slot of the line's `maxStations` is held (plan 2b, below).». Replace «The opening writes `shift.open`; a second device's first entry (`shift.enter`) comes with plan 2b, since in stage 2a a station's first entry is the opening.» with «The opening writes `shift.open`; a later device's first entry, or its return after it left, writes `shift.join` (`{ number, rejoined }`, plan 2b; the name `shift.enter` foreseen here was not used).». In the office-close paragraph replace «The close writes the audit row `shift.close` with the details `{ reason }` (the trimmed text).» with «The close also closes every part still open as the office's and writes `shift.force_closed` with `{ reason, notClosed: [{ deviceId, state }] }` (plan 2b; before it the office wrote `shift.close` `{ reason }`, which old rows keep).». In «The audit rows of this part are six» replace the `shift.close` item with «`shift.close` (the device whose close closed the shift; plan 2b adds `participants`, `acceptedTotal`, `reasonMissing` for a shared shift), `shift.force_closed` (an office user; `{ reason, notClosed }`)».

- [ ] **Step 2: Add the subsection** after «### Handhelds on the host»:

```markdown
### Several devices in one shift (plan 2b)

Protocol 7; host migration `0052_multi_station_shifts.sql` (columns only). A line has
`max_stations` (1–16, default 1; `OfficeLine.maxStations`, `PUT /v1/office/lines/{id}` with
`maxStations`, administrators, never below the live devices of an active shift: `conflict`
`line_stations_in_use` `{ active }`; `line.max_stations_changed` `{ from, to }`). A participant
(`shift_participants`) is `active` (holds a slot), `left` (`POST /v1/device/shifts/{id}/leave`,
frees the slot; repeating changes nothing; `shift.leave` `{ number }`; never entered:
`shift_not_entered`) or `closed`. A slot is an active participant whose device is not revoked.
Entry into an open shift (`host/src/shift_participants.rs` `decide_entry`): an active participant
enters again with no write; a closed one reads the shift back with no write; a left or new device
takes a slot while fewer than `max_stations` others hold one (`shift.join`); a new device that does
not name `multi-station-v1` is `shift_busy`. A `shift_closed` fact closes the sender's part; with no
other participant active or left it closes the shift (`closed_by_kind = 'device'`, `closed_by` the
last closer). Receipts: `partClosed`, `reasonMissing`, `alreadyClosed`. The reason
(`reason_need`, fixture `shift-close-reason-shared.json`): a one-device shift keeps stage 2a's
refusal; in a shared shift only the closing close may need one, by the whole shift's accepted
units against `shifts.planned_qty`, and a close without it closes the shift with
`close_reason_missing`, which the office clears with `PUT /v1/office/shifts/{id}/close-reason`
(`shift.close_reason`). A closed part's later facts are accepted and stamp its `late_data_at`.
Every participant change stamps the shift's `rev` with a revision. `GET /v1/device/shifts` and the
entry's answer carry, for an open or closed shift, `maxStations`, `participants`, `myState`,
`totals { accepted, boxesClosed, pallets, asOf }` and `byDevice` (`host/src/shift_totals.rs`, read
from the facts through `boxes_shift`, `box_items_live`, `pallets_shift`, `code_owners_shift_unboxed`;
a scan takes no revision, so devices read the list again to refresh totals); `OfficeShift` carries
`participants`, `byDevice` and `closeReasonMissing`. The export's `stationClosedAt` is the closing
device's instant.
```

- [ ] **Step 3: Edit «## Protocol».** After «It is 5 since part B of plan РЕЖ (…)» add «, 6 since plan ТСД (the handheld on the host) and 7 since plan 2b (several devices in one shift: a `shift_closed` fact closes a part; app build 1.1.0)», and change «`hello-future.json` stays one protocol ahead, now 6» to «`hello-future.json` stays one protocol ahead, now 8».

- [ ] **Step 4: Edit «## Audit».** After the sentence on `conflict.review`, add: «Plan 2b adds `shift.join` and `shift.leave` (the device; `{ number, rejoined }` and `{ number }`), `shift.part_closed` (the device; `{ number, actualQty, closedBoxCount, reasonCode }`), `shift.force_closed` (the office user; `{ reason, notClosed }`), `shift.close_reason` (the office user; `{ reasonCode }`) and `line.max_stations_changed` (the administrator; `{ from, to }`). A repeated entry or leave writes none.»

- [ ] **Step 5: Check and commit.**
      Run: `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false exec prettier --check apps/standalone/AGENTS.md` and `git -C "$WT" diff --check`. Expected: clean.

```bash
git -C "$WT" add apps/standalone/AGENTS.md
git -C "$WT" commit -m "docs(standalone): several devices in one shift on the host (plan 2b)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Final gates** (record each result in the report):
      `cargo fmt --manifest-path "$WT/apps/standalone/Cargo.toml" --all -- --check`;
      `cargo --offline --locked test --manifest-path "$WT/apps/standalone/Cargo.toml" --workspace --no-fail-fast` (the shell's tests need `apps/standalone/dist`; build it first with `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false turbo build --filter '@markiro/standalone...'`);
      `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`, `… typecheck`, `… lint`;
      `pnpm --dir "$WT" --config.verifyDepsBeforeRun=false test:standalone-release:contract`;
      `git -C "$WT" diff --check`; `graphify update .` if `graphify-out/graph.json` exists in the worktree.
      Not verifiable here (state it): Windows service, real stations and handhelds on a LAN, the load/soak acceptance of spec §8 (separate plan), the Kotlin suite (no Kotlin change; the shared fixtures it reads still parse).

---

## Host-side hooks the load/soak plan needs (not implemented here)

The load and long-run acceptance (spec §8, §9.2) is a separate plan. It can rely on these host
facts, all delivered by this plan:

- Routes and bodies: `POST /v1/device/shifts/{id}/enter` with `{ "supports": ["multi-station-v1"] }`
  (handhelds add `handheld-host-v1`), `POST /v1/device/facts` (1–100 records, idempotent by
  `(device_id, record_id)` and digest), `POST /v1/device/shifts/{id}/leave`, `GET /v1/device/shifts`
  (the totals poll), `POST /v1/office/shifts/{id}/close`, `GET /v1/office/shifts/{id}`.
- Write paths to measure (p99): the facts batch (`BEGIN IMMEDIATE`, one revision per batch only when a
  part/shift closes or a late mark is set), the entry/leave (one revision each when they change
  state). Read paths: `GET /v1/device/shifts` runs `shift_totals::SHIFT_TOTALS` and `BY_DEVICE` per open
  shift (pinned to indexes by `the_totals_search_the_shifts_indexes_and_scan_nothing`).
- In-process harness: `markiro_host` exposes `shift_participants`, `shift_totals` and the test
  `TestApp` (`host/tests/support/app.rs`, manual clock) plus `tests/support/multi.rs` helpers
  (`station_on`, `handheld_on`, `allow`, `shared`, `enter`, `leave`); a real-socket harness starts
  `RunningHost` as the existing loopback tests do.
- Pool and journal settings to observe: pool of 4, WAL, `synchronous=FULL`, 5 s busy timeout
  (`host/src/db.rs`); WAL checkpoints and a backup under load go through `routes/backups.rs`
  (`POST /v1/office/backups`).
- Device limits: the license seat pool (stations and handhelds together, `license/seats.rs`) bounds
  how many simulated devices can pair; the soak plan loads a license file with enough seats.
- Not provided (the soak plan adds what it needs): server-side latency metrics; a revision per scan
  (deliberately absent, D11).

---

## Self-Review

**1. Spec coverage**

| Spec item                                                                                                        | Where                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.1 `lines.max_stations` 1–16 default 1                                                                         | Task 1 (column), Task 11 (route, validation, audit)                                                                                                                               |
| §4.1 `shift_participants` state/joined/left/closed/qty/reason, backfill                                          | Task 1                                                                                                                                                                            |
| §4.1 `owner_device_id` stays without rights; lifecycle CHECKs untouched                                          | Task 6 (join never writes it), D6                                                                                                                                                 |
| §4.1 no counter columns                                                                                          | Task 4 (`shift_totals`), D11                                                                                                                                                      |
| §4.2 Вход: re-entry, `left → active` with a free slot, new device by limit, `shift_line_full`, planned opens     | Tasks 3, 6, 7                                                                                                                                                                     |
| §4.2 Выход → `left`, frees the slot                                                                              | Task 7                                                                                                                                                                            |
| §4.2 Закрытие своей части, auto-close, late facts of a closed part                                               | Task 8                                                                                                                                                                            |
| §4.2 Принудительное закрытие: all parts closed by office, mandatory reason, warning list, audit, late stays late | Task 10, Task 9 (participants for the warning)                                                                                                                                    |
| §4.2 План и причина by shift-wide total, only last closer                                                        | Tasks 3, 8; fixture `shift-close-reason-shared.json`                                                                                                                              |
| §4.2 Итоги станциям `totals`, `byDevice`, `asOf`                                                                 | Tasks 4, 5                                                                                                                                                                        |
| §4.2 Аудит: join, leave, part_closed, force_closed, max_stations_changed (exact assertions)                      | Tasks 6, 7, 8, 10, 11                                                                                                                                                             |
| §4.2 registry, SSCC blocks, receipts, seats unchanged                                                            | no change; Task 13 conflict test; D17                                                                                                                                             |
| §4.3 protocol and compatibility, fixtures together, host first, old clients keep «занято»                        | Tasks 2, 11, 14; D4, D12                                                                                                                                                          |
| §7 office line/shift/«Обзор» data needs (participants, lastSeenAt, closeReasonMissing)                           | Tasks 9, 10, 11 (UI is the office plan)                                                                                                                                           |
| §7 exports keyed by shift with several devices                                                                   | Task 12                                                                                                                                                                           |
| §8 SQLite stays; acceptance by load/soak                                                                         | no engine change; hooks section (separate plan)                                                                                                                                   |
| §11 duplicate scan on two stations                                                                               | Task 13                                                                                                                                                                           |
| §12.1 cloud rule in `apps/api`                                                                                   | not host scope (D18); office/print-form plans                                                                                                                                     |
| §12.2 single-device assumptions                                                                                  | host: only `owner_device_id` readers changed (Task 6); exports fixed (Task 12); A4 sheet/disaggregation routes have no per-device assumption; station/office tools in their plans |
| §12.3 validation scans with two stations                                                                         | Task 4 (`code_owners.device_id`), Task 13 validation test                                                                                                                         |
| §12.4 `shift.enter` audit                                                                                        | named `shift.join` (Task 6, Task 15 docs)                                                                                                                                         |
| §12.5 revoking the opener                                                                                        | D3, Task 6 test                                                                                                                                                                   |
| §12.6 timeout of `left`                                                                                          | open, D18 (office force close covers it)                                                                                                                                          |
| §12.7 handheld as participant                                                                                    | Task 13 handheld test; capability rule D4                                                                                                                                         |
| §12.8 limit 16, who changes it                                                                                   | Task 11 (administrators), D13                                                                                                                                                     |
| §12.9 offline last closer, reason missing, office attention                                                      | Tasks 8, 10, 13                                                                                                                                                                   |

**2. Placeholder scan.** Searched for "TBD", "TODO", "similar to", "add appropriate", "handle edge cases", "fill in": none. The `todo!()` bodies in Task 3 Step 2 are the deliberate failing stubs of a TDD step and are replaced in Step 4. Existing-test edits name exact lines and exact replacement values.

**3. Type consistency.** `ParticipantState`/`ParticipantClosedBy` (Task 2) are used with the same names in Tasks 3, 4, 8, 10; `EntryDecision::{Reenter, ReadClosed, Rejoin, Join, Busy, LineFull { max_stations, active }}` (Task 3) matches Task 6; `CloseDecision::{ClosePart { closes_shift }, AlreadyClosed}` and `ReasonNeed::{None, Required, Shared}` (Task 3) match Task 8; store functions (Task 4) `state_of`, `active_others`, `open_others`, `count_all`, `join`, `rejoin`, `touch`, `leave`, `close_by_device`, `close_open_by_office`, `mark_late`, `line_slots_in_use`, `list` match their callers in Tasks 6, 7, 8, 9, 10, 11; `shift_totals::{totals, shift_accepted, by_device}` match Tasks 5, 8, 9; `shifts::{line_full, stamp_revision}` (Task 6) match Tasks 7, 8; `read_for`/`with_participation` (Task 5) match Tasks 6, 7; `CloseShift` fields (Task 8) are built in `shift_closed.rs` and read in `close_part`; audit constants `SHIFT_JOIN`, `SHIFT_LEAVE`, `SHIFT_PART_CLOSED`, `SHIFT_FORCE_CLOSED`, `SHIFT_CLOSE_REASON`, `LINE_MAX_STATIONS_CHANGED` match their writers; JSON names (`maxStations`, `myState`, `byDevice`, `boxesClosed`, `asOf`, `closeReasonMissing`, `partClosed`, `reasonMissing`, `notClosed`) are identical in Rust serde, Zod, fixtures, tests and the contract below.

**Spec gaps found (for the owner):** (1) `closed_by_kind = 'devices'` cannot be stored without rebuilding `shifts` — the plan uses `device` + the last closer (D6). (2) Re-entry of a `closed` participant was undefined — read-only (D2). (3) No leave mechanism was specified — an online, state-idempotent route (D5). (4) Old-client compatibility needs a capability, otherwise an old station could join and close "the shift" — `multi-station-v1` (D4). (5) Raising the protocol forces build 1.1.0 because 1.0.0 is recorded with protocol 6 (D12) — owner confirms the number. (6) The office close's audit action changes to `shift.force_closed` (D10) — the audit screen translates both. (7) The office needs a write to supply a missing reason — `PUT …/close-reason`, action `shift.close_reason` not in the spec's list (D7). (8) The export's operation instant took the first accepted close (D16). (9) Totals have no push: devices poll (D11). (10) A shared plan is judged by the host's current plan, not the station's snapshot (D7).

---

## Host contract for the other plans

Protocol **7** (`MIN_PROTOCOL_VERSION` 1); build **1.1.0**. Host is released first.

**Capability.** `ShiftEnter.supports` names `"multi-station-v1"` (`markiro_proto::shift_supports::MULTI_STATION`, TS `SHIFT_SUPPORTS.multiStation`). Stations send `["validation-v1","validation-dm-duplicate-v1","multi-station-v1"]` (fixture `shift-enter-multi.json`); handhelds `["handheld-host-v1","multi-station-v1"]` (`shift-enter-handheld-multi.json`).

**Routes.**

| Method and path                           | Kinds                     | Body                                                                                | Answer                      | Errors                                                                                                                                           |
| ----------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/device/shifts/{id}/enter`       | station, handheld         | `ShiftEnter`                                                                        | `DeviceShift` + `snapshot`  | `409 shift_busy` (no capability), `409 shift_line_full {maxStations, active}`, `409 shift_status`, `409 shift_line`, `409 station_update`, `404` |
| `POST /v1/device/shifts/{id}/leave`       | station, handheld         | none                                                                                | `DeviceShift` (no snapshot) | `409 shift_not_entered`, `404`                                                                                                                   |
| `GET /v1/device/shifts`                   | station, handheld         | —                                                                                   | `{ shifts: DeviceShift[] }` | —                                                                                                                                                |
| `POST /v1/device/facts` (`shift_closed`)  | station, handheld         | unchanged `ShiftClosedFact`                                                         | receipts below              | unchanged codes                                                                                                                                  |
| `POST /v1/office/shifts/{id}/close`       | office rule               | `{ reason, expectedRev }` (reason 3–500 chars)                                      | `OfficeShift`               | `400 reason`, `404`, `409 stale_revision`, `409 shift_status`                                                                                    |
| `PUT /v1/office/shifts/{id}/close-reason` | office rule, `planShifts` | `{ reasonCode, expectedRev }` (`shift-close-reason-set.json`)                       | `OfficeShift`               | `400 reasonCode`, `404`, `409 stale_revision`, `409 close_reason_not_missing`                                                                    |
| `PUT /v1/office/lines/{id}`               | office rule, admin        | `{ name?, archived?, maxStations?, expectedRev }` (`line-update-max-stations.json`) | `OfficeLine`                | `400 maxStations`, `409 line_stations_in_use {active}`, `409 stale_revision`, `409 line_name`                                                    |

All refusals are `{ "error": { "code": "conflict", "message", "details": { "constraint", … } } }` (fixtures `error-shift-line-full.json`, `error-line-stations-in-use.json`, `error-shift-busy.json`).

**`DeviceShift` additions** (open or closed shift only; all absent for planned shifts and older hosts; fixture `device-shifts-participants.json`):

```json
{
  "maxStations": 2,
  "participants": [
    {
      "deviceId": "uuid",
      "deviceKind": "station|handheld",
      "deviceName": "text",
      "state": "active|left|closed",
      "firstEnteredAt": "host instant",
      "joinedAt": "host instant",
      "leftAt": null,
      "closedAt": null,
      "closedBy": "device|office_user|null",
      "closedActualQty": null,
      "closedReasonCode": null,
      "lateDataAt": null,
      "lastSeenAt": "host instant|null"
    }
  ],
  "myState": "active|left|closed (absent if the caller never entered)",
  "totals": { "accepted": 547, "boxesClosed": 45, "pallets": 0, "asOf": "host instant" },
  "byDevice": [{ "deviceId": "uuid", "accepted": 427, "boxesClosed": 35, "pallets": 0 }]
}
```

`ownerDeviceId` means "opened by" only. `byDevice` lists every participant in `participants` order; the sum of `accepted` equals `totals.accepted`. Totals are not pushed per scan: re-read `GET /v1/device/shifts` (streams wake only on participant or shift changes); show `asOf` when offline.

**`OfficeShift` additions** (fixture `office-shift-participants.json`): `participants` (same shape), `byDevice` (same shape), `closeReasonMissing: true` (absent when false). The force-close warning «Не закрыли: …» = `participants.filter(state != "closed")`; send the loaded `rev`.

**`OfficeLine`**: `maxStations` (1–16; absent from an older host = 1). The feed's `lines` record is unchanged.

**`shift_closed` receipts** (fixture `facts-response-part-close.json`): `accepted {partClosed: true}` (part closed, shift still open — also for a repeated close of a closed part); `accepted` with no details (shift closed by this record); `accepted {reasonMissing: true}` (shared shift closed without its needed reason); `accepted {alreadyClosed: true}` (shift closed before). A missing reason is refused (`invalid_record`, `data.reasonCode`) only in a shift that ever had one participant, by stage 2a's rule. Clients ask for a reason only when, online, they are the last non-closed participant and `plannedQty` differs from `totals.accepted` (rule fixture `shift-close-reason-shared.json`, cases `{ closesShift, participantsEver, factPlanned, actualQty, hostPlanned, shiftAccepted, need }`); offline they close without one.

**Audit actions** (office audit screen translates): `shift.join {number, rejoined}`, `shift.leave {number}`, `shift.part_closed {number, actualQty, closedBoxCount, reasonCode}`, `shift.close` (device; shared adds `participants, acceptedTotal, reasonMissing`), `shift.force_closed {reason, notClosed: [{deviceId, state}]}` (replaces the office's `shift.close`), `shift.close_reason {reasonCode}`, `line.max_stations_changed {from, to}`.

**Fixture names** (all in `apps/standalone/proto/fixtures/`): `device-shifts-participants.json`, `office-shift-participants.json`, `error-shift-line-full.json`, `error-line-stations-in-use.json`, `shift-enter-multi.json`, `shift-enter-handheld-multi.json`, `shift-close-reason-set.json`, `facts-response-part-close.json`, `shift-close-reason-shared.json`, `line-update-max-stations.json`, `office-line.json` (now with `maxStations`), `hello*.json` (protocol 7), `hello-future.json` (8), `compatibility.json` (client-7 cases).
