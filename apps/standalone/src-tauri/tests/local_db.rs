//! The station's local database on a real file: migrations, the read-only
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalDbState, LocalStatement, OpenFailure, TableClass,
    UnsentGuard, FILE_NAME, MIGRATOR, TABLE_CLASSES,
};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row};

const INSERT_LINE: &str = "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)";
// A genuine no-op write: SQLite's `sqlite3_changes()` (`rows_affected()`)
// only updates for a completed INSERT/UPDATE/DELETE, so an executed `SELECT`
// does not reset it to 0 — it keeps reporting whatever the connection's last
// real write changed. `NOOP_UPDATE` is a real `UPDATE` that reliably touches
// no row, so batches built from it have a predictable, deterministic count.
const NOOP_UPDATE: &str = "UPDATE ref_lines SET rev = rev WHERE 1 = 0";
const LINE_1: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
const LINE_2: &str = "0b7e7dcb-3f56-4c43-9a4b-1f0b3b3f8a21";

fn statement(sql: &str, values: Value) -> LocalStatement {
    serde_json::from_value(json!({ "sql": sql, "values": values })).unwrap()
}

fn expecting(sql: &str, values: Value, changes: u64) -> LocalStatement {
    serde_json::from_value(json!({ "sql": sql, "values": values, "expectedChanges": changes }))
        .unwrap()
}

async fn open() -> (tempfile::TempDir, LocalDb) {
    let dir = tempfile::tempdir().unwrap();
    let db = LocalDb::open(dir.path()).await.unwrap();
    (dir, db)
}

/// Every line, ordered by name, as the webview receives them.
async fn lines(db: &LocalDb) -> Value {
    let rows = db
        .query(
            "SELECT id, name, archived, rev FROM ref_lines ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    Value::Array(rows.into_iter().map(Value::Object).collect())
}

/// Pins today's user tables. What a forget does with each is
/// `TABLE_CLASSES`'s business (`every_table_has_a_forget_class` below); this
/// list changes with every migration that adds a table.
#[tokio::test]
async fn opening_creates_the_reference_tables_in_wal_mode_and_keeps_data() {
    let (dir, db) = open().await;
    let tables = db
        .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '_sqlx_migrations' ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    let names: Vec<&str> = tables
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "floor_block_drops",
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_pallet_exceptions",
            "floor_pallets",
            "floor_print_jobs",
            "floor_restore_epochs",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
            "floor_sscc_blocks",
            "floor_unit_labels",
            "outbox",
            "ref_lines",
            "ref_operator_badges",
            "ref_operators",
            "ref_org",
            "ref_products",
            "ref_site",
            "ref_template_defaults",
            "ref_templates",
            "sync_quarantine",
            "sync_state",
            "wh_jobs",
            "wh_outbox",
            "wh_sessions",
            "workstation_settings"
        ]
    );
    // The sign-in lockouts' columns (plan 1f): `last_failure_at` is what the
    // station's rolling count runs from, and is required.
    let columns = db
        .query(
            "SELECT name, \"notnull\" AS required FROM pragma_table_info('floor_sign_in_failures')",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(columns.into_iter().map(Value::Object).collect()),
        json!([
            { "name": "key", "required": 0 },
            { "name": "failures", "required": 1 },
            { "name": "locked_at", "required": 0 },
            { "name": "last_failure_at", "required": 1 }
        ])
    );

    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    raw.close().await.unwrap();

    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    drop(db);
    let reopened = LocalDb::open(dir.path()).await.unwrap();
    assert_eq!(
        lines(&reopened).await,
        json!([{ "id": LINE_1, "name": "Линия 1", "archived": 0, "rev": 3 }])
    );
}

/// Migration `0008` over a station's database of `0007` that holds a shift, a
/// closed box and an outbox record: the shell's own SQLite adds the pallet
/// columns to the populated tables, every row stays as it was and the new
/// columns read `NULL` (plan ПЛ-Ц, additive).
#[tokio::test]
async fn migration_0008_keeps_the_rows_of_a_database_of_0007() {
    let dir = tempfile::tempdir().unwrap();
    let until_0007: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version <= 7)
        .cloned()
        .collect();
    assert_eq!(until_0007.len(), 7, "migrations 0001 to 0007 exist");
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(until_0007),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, \
         pallets_enabled, created_from, line_id, product_id, product_name, product_gtin14, \
         production_date, box_capacity, box_template_id, seen_at, entered_at, snapshot, \
         local_state) VALUES ('host', 'device', 'shift-1', 'OCT26-004', 'active', \
         'aggregation', 0, 'office', 'line', 'product-1', 'Milk', '04600682000013', \
         '2026-10-09', 12, 'template-1', 1790000000000, '2026-10-09T07:00:00.000Z', '{}', \
         'closing')",
        "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, closed_at, \
         sscc, block_id, serial, item_count) VALUES ('box-1', 'host', 'device', 'shift-1', \
         '2026-10-09T08:00:00.000Z', '2026-10-09T08:01:00.000Z', '046006820000000017', \
         'block-1', 1, 12)",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
         VALUES ('record-1', 'host', 'device', 'box_closed', 'shift-1', '{}', \
         '2026-10-09T08:01:00.000Z')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    let at_0007: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE name IN ('floor_pallets', 'floor_pallet_exceptions')",
    )
    .fetch_optional(&mut raw)
    .await
    .unwrap();
    assert_eq!(at_0007, None, "no pallet table before 0008");
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let shifts = db
        .query(
            "SELECT id, status, local_state, pallets_enabled, box_capacity, pallet_box_capacity, \
             pallet_template_id FROM floor_shifts",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(shifts.into_iter().map(Value::Object).collect()),
        json!([{
            "id": "shift-1", "status": "active", "local_state": "closing",
            "pallets_enabled": 0, "box_capacity": 12,
            "pallet_box_capacity": null, "pallet_template_id": null
        }])
    );
    let boxes = db
        .query(
            "SELECT id, sscc, item_count, pallet_id FROM floor_boxes",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(boxes.into_iter().map(Value::Object).collect()),
        json!([{
            "id": "box-1", "sscc": "046006820000000017", "item_count": 12, "pallet_id": null
        }])
    );
    assert_eq!(count(&db, "outbox").await, json!(1));
    assert_eq!(count(&db, "floor_pallets").await, json!(0));
    assert_eq!(count(&db, "floor_pallet_exceptions").await, json!(0));
    // The old box joins a pallet afterwards.
    assert_eq!(
        db.transaction(vec![expecting(
            "UPDATE floor_boxes SET pallet_id = 'pallet-1' WHERE id = 'box-1'",
            json!([]),
            1,
        )])
        .await
        .unwrap(),
        [1]
    );
}

/// Migration `0009` over a station's database of `0008` that holds an SSCC block, a waiting and
/// an acknowledged outbox record and a sync state: the shell's own SQLite adds the table of the
/// restore obligation, every row stays as it was, a station that has seen no epoch owes the host
/// nothing, and a first epoch starts with no refused block (plan РК-С, additive).
#[tokio::test]
async fn migration_0009_keeps_the_rows_of_a_database_of_0008() {
    let dir = tempfile::tempdir().unwrap();
    let until_0008: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version <= 8)
        .cloned()
        .collect();
    assert_eq!(until_0008.len(), 8, "migrations 0001 to 0008 exist");
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(until_0008),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, extension, \
         from_serial, to_serial, next_serial, received_at) VALUES ('block-1', 'host', 'device', \
         '460068200', 0, 3500, 5499, 3600, '2026-10-08T06:00:00.000Z')",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('record-1', 'host', 'device', 'scan', 'shift-1', '{}', \
         '2026-10-09T08:00:00.000Z', 'accepted', '2026-10-09T08:00:05.000Z')",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
         VALUES ('record-2', 'host', 'device', 'scan', 'shift-1', '{}', '2026-10-09T08:01:00.000Z')",
        "INSERT INTO sync_state (key, value) VALUES ('last_rev', '20')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    let at_0008: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE name = 'floor_restore_epochs'")
            .fetch_optional(&mut raw)
            .await
            .unwrap();
    assert_eq!(at_0008, None, "no restore table before 0009");
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let blocks = db
        .query(
            "SELECT block_id, from_serial, to_serial, next_serial FROM floor_sscc_blocks",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(blocks.into_iter().map(Value::Object).collect()),
        json!([{
            "block_id": "block-1", "from_serial": 3500, "to_serial": 5499, "next_serial": 3600
        }])
    );
    let records = db
        .query(
            "SELECT id, outcome, acked_at FROM outbox ORDER BY seq",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(records.into_iter().map(Value::Object).collect()),
        json!([
            { "id": "record-1", "outcome": "accepted", "acked_at": "2026-10-09T08:00:05.000Z" },
            { "id": "record-2", "outcome": null, "acked_at": null }
        ])
    );
    let state = db
        .query("SELECT key, value FROM sync_state", vec![])
        .await
        .unwrap();
    assert_eq!(
        Value::Array(state.into_iter().map(Value::Object).collect()),
        json!([{ "key": "last_rev", "value": "20" }])
    );
    // No epoch seen yet: nothing is owed, and the table takes the first one.
    assert_eq!(count(&db, "floor_restore_epochs").await, json!(0));
    assert_eq!(
        db.transaction(vec![expecting(
            "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at) \
             VALUES ('host', 'device', '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e', \
             '2026-10-11T08:00:00.000Z')",
            json!([]),
            1,
        )])
        .await
        .unwrap(),
        [1]
    );
    let obligation = db
        .query(
            "SELECT refused, refused_blocks FROM floor_restore_epochs",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(obligation.into_iter().map(Value::Object).collect()),
        json!([{ "refused": 0, "refused_blocks": "[]" }])
    );
    // The refused blocks are a JSON list, never anything else.
    assert!(db
        .transaction(vec![statement(
            "UPDATE floor_restore_epochs SET refused_blocks = '['",
            json!([]),
        )])
        .await
        .is_err());
    let journal = db
        .query(
            "SELECT version, success FROM _sqlx_migrations ORDER BY version",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(journal.into_iter().map(Value::Object).collect()),
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version, "success": 1 }))
                .collect()
        ),
        // Parallel plans take numbers out of order (plan СКЛ takes `0012` and plan ОЧ `0013`
        // while `0011` is absent): the journal is the migrator's own list, gaps are legal.
        "every migration is journaled once, in order (the numbers may have gaps)"
    );
    assert!(MIGRATOR.iter().any(|migration| migration.version == 9));
    assert!(MIGRATOR.iter().any(|migration| migration.version == 12));
}

/// Migration `0010` over a station's database of `0009` (plan ХП): the shell's own SQLite adds
/// the three indexes by shift the retention's deletes search, and every row stays as it was.
#[tokio::test]
async fn migration_0010_adds_the_shift_indexes_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let until_0009: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version <= 9)
        .cloned()
        .collect();
    assert_eq!(until_0009.len(), 9, "migrations 0001 to 0009 exist");
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(until_0009),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('record-1', 'host', 'device', 'shift_closed', 'shift-1', \
         '{}', '2026-10-09T08:00:00.000Z', 'accepted', '2026-10-09T08:00:05.000Z')",
        "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, \
         occurred_at) VALUES ('exception-1', 'host', 'device', 'shift-1', 'clear', 'box-1', \
         '2026-10-09T08:00:00.000Z')",
        "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, pallet_id, \
         reason_code, occurred_at) VALUES ('pallet-exception-1', 'host', 'device', 'shift-1', \
         'reprint', 'pallet-1', 'damaged_label', '2026-10-09T08:00:00.000Z')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let indexes = db
        .query(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name IN \
             ('outbox_shift', 'floor_exceptions_shift', 'floor_pallet_exceptions_shift') \
             ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(indexes.into_iter().map(Value::Object).collect()),
        json!([
            { "name": "floor_exceptions_shift", "tbl_name": "floor_exceptions" },
            { "name": "floor_pallet_exceptions_shift", "tbl_name": "floor_pallet_exceptions" },
            { "name": "outbox_shift", "tbl_name": "outbox" }
        ])
    );
    for table in ["outbox", "floor_exceptions", "floor_pallet_exceptions"] {
        assert_eq!(count(&db, table).await, json!(1), "{table} keeps its row");
    }
    assert!(MIGRATOR.iter().any(|migration| migration.version == 10));
}

/// Migration `0013` over a station's database of the migrations before it that holds a refused
/// record: the record stays as it was with no resolution, a resolution takes only `resent` or
/// `dismissed`, and the table of the blocks the station did not take exists and is the device's
/// own data (plan ОЧ, additive). Migrations `0011` and `0012` belong to other plans: the numbers
/// may have gaps, and the journal lists the migrations there are.
#[tokio::test]
async fn migration_0013_keeps_the_outbox_and_adds_its_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < 13)
        .cloned()
        .collect();
    assert!(before.iter().any(|migration| migration.version == 9));
    assert!(before.iter().any(|migration| migration.version == 10));
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(before),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    for sql in [
        // A waiting, an accepted, a refused and a conflicting record: the CHECK on the new
        // column must take every row that exists.
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
         VALUES ('record-0', 'host', 'device', 'scan', 'shift-1', '{}', \
         '2026-10-09T07:59:00.000Z')",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('record-2', 'host', 'device', 'scan', 'shift-1', '{}', \
         '2026-10-09T08:00:30.000Z', 'accepted', '2026-10-09T08:00:35.000Z')",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, outcome_code, acked_at) VALUES ('record-1', 'host', 'device', 'scan', \
         'shift-1', '{}', '2026-10-09T08:00:00.000Z', 'rejected', 'not_entered', \
         '2026-10-09T08:00:05.000Z')",
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, outcome_code, outcome_details, acked_at) VALUES ('record-3', 'host', \
         'device', 'scan', 'shift-1', '{}', '2026-10-09T08:01:00.000Z', 'conflict', \
         'duplicate', '{}', '2026-10-09T08:01:05.000Z')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();

    let db = LocalDb::open(dir.path()).await.unwrap();
    let records = db
        .query(
            "SELECT id, outcome, outcome_code, resolution, resent_as, resolved_at, resolved_by \
             FROM outbox ORDER BY seq",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(records.into_iter().map(Value::Object).collect()),
        json!([
            {
                "id": "record-0", "outcome": null, "outcome_code": null,
                "resolution": null, "resent_as": null, "resolved_at": null, "resolved_by": null
            },
            {
                "id": "record-2", "outcome": "accepted", "outcome_code": null,
                "resolution": null, "resent_as": null, "resolved_at": null, "resolved_by": null
            },
            {
                "id": "record-1", "outcome": "rejected", "outcome_code": "not_entered",
                "resolution": null, "resent_as": null, "resolved_at": null, "resolved_by": null
            },
            {
                "id": "record-3", "outcome": "conflict", "outcome_code": "duplicate",
                "resolution": null, "resent_as": null, "resolved_at": null, "resolved_by": null
            }
        ])
    );
    for word in ["later", "forgotten", "", "Resent"] {
        assert!(
            db.transaction(vec![expecting(
                "UPDATE outbox SET resolution = ? WHERE id = 'record-1'",
                json!([word]),
                1,
            )])
            .await
            .is_err(),
            "{word:?} is no resolution"
        );
    }
    for resolution in ["resent", "dismissed"] {
        db.transaction(vec![expecting(
            "UPDATE outbox SET resolution = ?, resolved_at = '2026-10-11T08:00:00.000Z', \
             resolved_by = 'op-1' WHERE id = 'record-1'",
            json!([resolution]),
            1,
        )])
        .await
        .unwrap();
    }
    assert_eq!(count(&db, "floor_block_drops").await, json!(0));
    assert_eq!(
        table_class("floor_block_drops"),
        Some(TableClass::DeviceData)
    );
    // One row per block and pairing; the reason is `overlap` or `mismatch`; an inverted range
    // is what such a row may hold.
    let drop = |block: &str, device: &str, reason: &str| {
        expecting(
            "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, \
             issuer_prefix, extension, from_serial, to_serial, reason, dropped_at) \
             VALUES ('host', ?, ?, 'request-1', '460068200', 0, 5499, 3500, ?, \
             '2026-10-11T08:00:00.000Z')",
            json!([device, block, reason]),
            1,
        )
    };
    db.transaction(vec![drop("block-1", "device", "mismatch")])
        .await
        .unwrap();
    db.transaction(vec![drop("block-1", "other", "overlap")])
        .await
        .unwrap();
    db.transaction(vec![drop("block-2", "device", "overlap")])
        .await
        .unwrap();
    assert!(db
        .transaction(vec![statement(
            "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, \
             issuer_prefix, extension, from_serial, to_serial, reason, dropped_at) \
             VALUES ('host', 'device', 'block-5', NULL, '460068200', 0, 1, 2, 'overlap', \
             '2026-10-11T08:00:00.000Z')",
            json!([]),
        )])
        .await
        .is_err());
    assert!(db
        .transaction(vec![drop("block-1", "device", "overlap")])
        .await
        .is_err());
    assert!(db
        .transaction(vec![drop("block-6", "device", "lost")])
        .await
        .is_err());
    let journal = db
        .query(
            "SELECT version, success FROM _sqlx_migrations ORDER BY version",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(journal.into_iter().map(Value::Object).collect()),
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version, "success": 1 }))
                .collect()
        ),
        "every migration there is is journaled once"
    );
    assert!(MIGRATOR.iter().any(|migration| migration.version == 13));
}

/// The upgrade paths of the merged branch (plans ХП, СКЛ and ОЧ take `0010`, `0012` and `0013`;
/// `0011` is absent): a station of `0009` goes through `0010` and then, in one start, takes
/// `0012` and `0013` together; a station that was already at `0010` takes the two the same way.
/// Each path keeps the rows that exist and journals exactly the migrator's own list.
#[tokio::test]
async fn a_station_of_0009_or_0010_takes_0012_and_0013_in_one_start() {
    for until in [9_i64, 10] {
        let dir = tempfile::tempdir().unwrap();
        let before: Vec<_> = MIGRATOR
            .iter()
            .filter(|migration| migration.version <= until)
            .cloned()
            .collect();
        assert!(
            before
                .iter()
                .all(|migration| migration.version != 12 && migration.version != 13),
            "the starting database has neither 0012 nor 0013"
        );
        let mut raw = SqliteConnectOptions::new()
            .filename(dir.path().join(FILE_NAME))
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(before),
            ..sqlx::migrate::Migrator::DEFAULT
        }
        .run(&mut raw)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
             outcome, outcome_code, acked_at) VALUES ('record-1', 'host', 'device', 'scan', \
             'shift-1', '{}', '2026-10-09T08:00:00.000Z', 'rejected', 'not_entered', \
             '2026-10-09T08:00:05.000Z')",
        )
        .execute(&mut raw)
        .await
        .unwrap();
        raw.close().await.unwrap();

        let db = LocalDb::open(dir.path()).await.unwrap();
        let journal = db
            .query(
                "SELECT version, success FROM _sqlx_migrations ORDER BY version",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(
            Value::Array(journal.into_iter().map(Value::Object).collect()),
            Value::Array(
                MIGRATOR
                    .iter()
                    .map(|migration| json!({ "version": migration.version, "success": 1 }))
                    .collect()
            ),
            "from {until}: every migration is journaled once"
        );
        assert_eq!(count(&db, "outbox").await, json!(1), "from {until}");
        assert_eq!(
            count(&db, "wh_sessions").await,
            json!(0),
            "0012 from {until}"
        );
        assert_eq!(
            count(&db, "floor_block_drops").await,
            json!(0),
            "0013 from {until}"
        );
        let kept = db
            .query("SELECT resolution, resolved_at FROM outbox", vec![])
            .await
            .unwrap();
        assert_eq!(
            Value::Array(kept.into_iter().map(Value::Object).collect()),
            json!([{ "resolution": null, "resolved_at": null }]),
            "the refusal stays unresolved (from {until})"
        );
        let indexes = db
            .query(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
                 ('outbox_shift', 'wh_outbox_accepted') ORDER BY name",
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(
            indexes.len(),
            2,
            "from {until}: the indexes of 0010 and 0012 exist"
        );
    }
}

/// And the other way round: a database that already holds `0012` and `0013` (a station of the
/// two plans without `0010`) takes `0010` late and keeps what is there.
#[tokio::test]
async fn a_database_with_0012_and_0013_takes_0010_late() {
    let dir = tempfile::tempdir().unwrap();
    let without_0010: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version != 10)
        .cloned()
        .collect();
    assert_eq!(without_0010.len() + 1, MIGRATOR.iter().count());
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(without_0010),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, outcome_code, acked_at, resolution, resolved_at, resolved_by) VALUES \
         ('record-1', 'host', 'device', 'scan', 'shift-1', '{}', '2026-10-09T08:00:00.000Z', \
         'rejected', 'not_entered', '2026-10-09T08:00:05.000Z', 'dismissed', \
         '2026-10-11T08:00:00.000Z', 'op-1')",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();

    let db = LocalDb::open(dir.path()).await.unwrap();
    let journal = db
        .query(
            "SELECT version FROM _sqlx_migrations ORDER BY version",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(journal.into_iter().map(Value::Object).collect()),
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version }))
                .collect()
        ),
    );
    let index = db
        .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'outbox_shift'",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(index.len(), 1, "0010 ran late");
    let kept = db
        .query("SELECT resolution, resolved_by FROM outbox", vec![])
        .await
        .unwrap();
    assert_eq!(
        Value::Array(kept.into_iter().map(Value::Object).collect()),
        json!([{ "resolution": "dismissed", "resolved_by": "op-1" }]),
        "a resolved record stays resolved"
    );
}

/// The shell's migrator takes a migration with lower numbers missing and applies a lower one
/// that arrives later (plan ОЧ takes `0013` while `0011` and `0012` belong to other streams): a
/// database that holds `0013` but not `0009` is opened by the full list, which applies `0009`
/// and leaves what is there as it is.
#[tokio::test]
async fn a_lower_migration_that_arrives_after_a_higher_one_is_applied() {
    let dir = tempfile::tempdir().unwrap();
    let without_0009: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version != 9)
        .cloned()
        .collect();
    assert!(without_0009.iter().any(|migration| migration.version == 13));
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(without_0009),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, outcome_code, acked_at) VALUES ('record-1', 'host', 'device', 'scan', \
         'shift-1', '{}', '2026-10-09T08:00:00.000Z', 'rejected', 'not_entered', \
         '2026-10-09T08:00:05.000Z')",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    let missing: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE name = 'floor_restore_epochs'")
            .fetch_optional(&mut raw)
            .await
            .unwrap();
    assert_eq!(missing, None, "0009 has not been applied");
    raw.close().await.unwrap();

    let db = LocalDb::open(dir.path()).await.unwrap();
    assert_eq!(count(&db, "floor_restore_epochs").await, json!(0));
    assert_eq!(count(&db, "outbox").await, json!(1));
    let journal = db
        .query(
            "SELECT version FROM _sqlx_migrations ORDER BY version",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(journal.into_iter().map(Value::Object).collect()),
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version }))
                .collect()
        ),
    );
}

/// `sqlite_master`'s rows of `tables` (`IN`) or of every other table (`NOT IN`), in order.
async fn master_rows(raw: &mut sqlx::SqliteConnection, tables: &str) -> Vec<Value> {
    sqlx::query(&format!(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name {tables} \
         ('floor_codes', 'floor_scans') ORDER BY type, name"
    ))
    .fetch_all(raw)
    .await
    .unwrap()
    .iter()
    .map(|row| {
        json!({
            "type": row.get::<String, _>("type"),
            "name": row.get::<String, _>("name"),
            "tbl_name": row.get::<String, _>("tbl_name"),
            "sql": row.get::<Option<String>, _>("sql"),
        })
    })
    .collect()
}

/// The plan of each statement of `0014`'s list, as the shell's SQLite gives it.
async fn plans_of(raw: &mut sqlx::SqliteConnection, statements: &[&str]) -> Vec<Vec<String>> {
    let mut plans = Vec::new();
    for sql in statements {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..sql.matches('?').count() {
            explain = explain.bind("x");
        }
        plans.push(
            explain
                .fetch_all(&mut *raw)
                .await
                .unwrap()
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect(),
        );
    }
    plans
}

/// Migration `0014` (plan РЕЖ, part A) over a station's database of the migrations before it,
/// on the shell's own SQLite: `floor_codes` and `floor_scans` are rebuilt so that a code and an
/// accepted scan of a validation shift have no box. Every row and column stays; the table texts
/// change only by the box's NOT NULL, the accepted scan's CHECK and the quoted name of a renamed
/// table; every index, every other table and the plans of the reads that search these tables
/// stay as they were; a box-less code and accepted scan are taken, and any other verdict still
/// names no box. `test/floor-schema.test.ts` pins the same on Node's SQLite.
#[tokio::test]
async fn migration_0014_lets_a_code_and_an_accepted_scan_have_no_box() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < 14)
        .cloned()
        .collect();
    assert!(before.iter().any(|migration| migration.version == 13));
    assert!(MIGRATOR.iter().any(|migration| migration.version == 14));
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(before),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    let km = "'km', 31, '04600682000013', 'abc', '0104600682000013215abc'";
    for sql in [
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
         scanned_at) VALUES ('host', 'device', 'hash-1', 'shift-1', 'box-1', 'scan-ok', \
         '2026-10-09T08:00:00.000Z')"
            .to_owned(),
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
         scanned_at) VALUES ('host', 'device', 'hash-2', 'shift-1', 'box-2', 'scan-2', \
         '2026-10-09T08:00:01.000Z')"
            .to_owned(),
        format!(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, \
             raw_kind, raw_length, gtin14, serial, canonical, code_hash, scanned_at) VALUES \
             ('scan-ok', 'host', 'device', 'shift-1', 'box-1', 'ok', {km}, 'hash-1', \
             '2026-10-09T08:00:00.000Z')"
        ),
        format!(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, verdict, \
             duplicate_source, raw_kind, raw_length, gtin14, serial, canonical, code_hash, \
             scanned_at, operator_id, conflict) VALUES ('scan-duplicate', 'host', 'device', \
             'shift-1', 'duplicate', 'host', {km}, 'hash-3', '2026-10-09T08:00:02.000Z', 'op-1', 1)"
        ),
        format!(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, verdict, raw_kind, \
             raw_length, gtin14, serial, canonical, code_hash, scanned_at) VALUES \
             ('scan-wrong', 'host', 'device', 'shift-1', 'wrong_gtin', {km}, 'hash-4', \
             '2026-10-09T08:00:04.000Z')"
        ),
        "INSERT INTO floor_scans (id, host_id, device_id, shift_id, verdict, raw_kind, \
         raw_length, scanned_at) VALUES ('scan-invalid', 'host', 'device', 'shift-1', \
         'invalid', 'unknown', 7, '2026-10-09T08:00:03.000Z')"
            .to_owned(),
    ] {
        sqlx::query(&sql).execute(&mut raw).await.unwrap();
    }
    // The reads and writes that search the two tables' indexes (each pinned in
    // `the_floors_repeating_reads_search_an_index`).
    let statements = [
        SHIFT_CODES,
        CLOSE_SUMMARY,
        "SELECT code_hash FROM floor_codes WHERE host_id = ? AND device_id = ? \
         AND box_id = ? ORDER BY code_hash",
        "SELECT scanned_at FROM floor_codes WHERE host_id = ? AND device_id = ? \
         AND code_hash = ?",
        "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND box_id = ?",
        "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
        "DELETE FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
        "SELECT id FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
        // A box's other scans by its shift, as the receipt's statement searches them (its own
        // text is pinned twice above and `test/floor-schema.test.ts` counts the copies).
        "SELECT 1 FROM floor_scans c WHERE c.host_id = ? AND c.device_id = ? AND c.shift_id = ? \
         AND c.box_id = ? AND c.conflict = 1",
    ];
    let rebuilt = master_rows(&mut raw, "IN").await;
    let others = master_rows(&mut raw, "NOT IN").await;
    let plans = plans_of(&mut raw, &statements).await;
    let read_rows = |table: &str| format!("SELECT * FROM {table} ORDER BY 1, 2, 3");
    let mut rows = Vec::new();
    for table in ["floor_codes", "floor_scans"] {
        rows.push(
            sqlx::query(&read_rows(table))
                .fetch_all(&mut raw)
                .await
                .unwrap()
                .len(),
        );
    }
    assert_eq!(rows, [2, 4]);
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let codes = db
        .query("SELECT * FROM floor_codes ORDER BY code_hash", vec![])
        .await
        .unwrap();
    assert_eq!(
        Value::Array(codes.into_iter().map(Value::Object).collect()),
        json!([
            {
                "host_id": "host", "device_id": "device", "code_hash": "hash-1",
                "shift_id": "shift-1", "box_id": "box-1", "scan_id": "scan-ok",
                "scanned_at": "2026-10-09T08:00:00.000Z"
            },
            {
                "host_id": "host", "device_id": "device", "code_hash": "hash-2",
                "shift_id": "shift-1", "box_id": "box-2", "scan_id": "scan-2",
                "scanned_at": "2026-10-09T08:00:01.000Z"
            }
        ])
    );
    let scans = db
        .query("SELECT * FROM floor_scans ORDER BY id", vec![])
        .await
        .unwrap();
    let km_columns = |hash: &str| {
        json!({
            "raw_kind": "km", "raw_length": 31, "gtin14": "04600682000013", "serial": "abc",
            "canonical": "0104600682000013215abc", "code_hash": hash
        })
    };
    let merge = |base: Value, more: Value| {
        let mut base = base;
        for (key, value) in more.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    };
    assert_eq!(
        Value::Array(scans.into_iter().map(Value::Object).collect()),
        json!([
            merge(
                json!({
                    "id": "scan-duplicate", "host_id": "host", "device_id": "device",
                    "shift_id": "shift-1", "box_id": null, "verdict": "duplicate",
                    "duplicate_source": "host", "scanned_at": "2026-10-09T08:00:02.000Z",
                    "operator_id": "op-1", "conflict": 1
                }),
                km_columns("hash-3")
            ),
            {
                "id": "scan-invalid", "host_id": "host", "device_id": "device",
                "shift_id": "shift-1", "box_id": null, "verdict": "invalid",
                "duplicate_source": null, "raw_kind": "unknown", "raw_length": 7,
                "code_hash": null, "gtin14": null, "serial": null, "canonical": null,
                "scanned_at": "2026-10-09T08:00:03.000Z", "operator_id": null, "conflict": 0
            },
            merge(
                json!({
                    "id": "scan-ok", "host_id": "host", "device_id": "device",
                    "shift_id": "shift-1", "box_id": "box-1", "verdict": "ok",
                    "duplicate_source": null, "scanned_at": "2026-10-09T08:00:00.000Z",
                    "operator_id": null, "conflict": 0
                }),
                km_columns("hash-1")
            ),
            merge(
                json!({
                    "id": "scan-wrong", "host_id": "host", "device_id": "device",
                    "shift_id": "shift-1", "box_id": null, "verdict": "wrong_gtin",
                    "duplicate_source": null, "scanned_at": "2026-10-09T08:00:04.000Z",
                    "operator_id": null, "conflict": 0
                }),
                km_columns("hash-4")
            )
        ])
    );

    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .read_only(true)
        .connect()
        .await
        .unwrap();
    // Only the intended changes of the two tables' texts; the renamed table's name is quoted.
    let intended: Vec<Value> = rebuilt
        .iter()
        .map(|row| {
            let mut row = row.clone();
            if row["type"] == "table" {
                let name = row["name"].as_str().unwrap().to_owned();
                let (from, to) = match name.as_str() {
                    "floor_codes" => ("box_id TEXT NOT NULL,", "box_id TEXT,"),
                    "floor_scans" => (
                        "CHECK ((verdict = 'ok') = (box_id IS NOT NULL)),",
                        "CHECK (box_id IS NULL OR verdict = 'ok'),",
                    ),
                    other => panic!("unexpected table {other}"),
                };
                let sql = row["sql"].as_str().unwrap();
                assert_eq!(sql.matches(from).count(), 1, "{name}: {sql}");
                row["sql"] = json!(sql
                    .replace(
                        &format!("CREATE TABLE {name} ("),
                        &format!("CREATE TABLE \"{name}\" (")
                    )
                    .replace(from, to));
            }
            row
        })
        .collect();
    assert_eq!(master_rows(&mut raw, "IN").await, intended);
    assert_eq!(
        intended
            .iter()
            .map(|row| row["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "floor_codes_box",
            "floor_codes_shift",
            "floor_scans_shift",
            "sqlite_autoindex_floor_codes_1",
            "sqlite_autoindex_floor_scans_1",
            "floor_codes",
            "floor_scans"
        ],
        "the two tables and their indexes, no trigger"
    );
    // A later migration's table (`0015`, plan РЕЖ part B) comes with this start too, beside;
    // every object that was there stays as it was.
    let later: Vec<Value> = master_rows(&mut raw, "NOT IN")
        .await
        .into_iter()
        .filter(|row| row["tbl_name"] != "floor_unit_labels")
        .collect();
    assert_eq!(later, others);
    let after = plans_of(&mut raw, &statements).await;
    assert_eq!(after, plans, "the plans stay");
    assert!(after[0]
        .iter()
        .any(|step| step.contains("floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)")));
    raw.close().await.unwrap();

    // A code and an accepted scan of a validation shift have no box; any other verdict still
    // names none, and a code is still held once per pairing.
    let code = |hash: &str, box_id: Value| {
        expecting(
            "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
             scanned_at) VALUES ('host', 'device', ?, 'shift-1', ?, ?, '2026-10-09T08:01:00.000Z')",
            json!([hash, box_id, format!("scan-{hash}")]),
            1,
        )
    };
    db.transaction(vec![code("validated", Value::Null)])
        .await
        .unwrap();
    assert!(db
        .transaction(vec![code("validated", Value::Null)])
        .await
        .is_err());
    let scan = |id: &str, verdict: &str, source: Value, box_id: Value| {
        expecting(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, \
             duplicate_source, raw_kind, raw_length, gtin14, serial, canonical, code_hash, \
             scanned_at) VALUES (?, 'host', 'device', 'shift-1', ?, ?, ?, 'km', 31, \
             '04600682000013', 'abc', '0104600682000013215abc', ?, '2026-10-09T08:01:00.000Z')",
            json!([id, box_id, verdict, source, format!("hash-{id}")]),
            1,
        )
    };
    db.transaction(vec![scan("ok-without-box", "ok", Value::Null, Value::Null)])
        .await
        .unwrap();
    db.transaction(vec![scan("ok-in-box", "ok", Value::Null, json!("box-1"))])
        .await
        .unwrap();
    for (id, verdict, source) in [
        ("duplicate-in-box", "duplicate", json!("local")),
        ("wrong-in-box", "wrong_gtin", Value::Null),
    ] {
        assert_eq!(
            db.transaction(vec![scan(id, verdict, source, json!("box-1"))])
                .await,
            Err(LocalDbError::StatementFailed),
            "{id}"
        );
    }
    // The work screen's count reads the box-less code with the boxed ones.
    let count = db
        .query(
            SHIFT_CODES,
            vec![json!("host"), json!("device"), json!("shift-1")],
        )
        .await
        .unwrap();
    assert_eq!(count[0]["n"], json!(3));
}

/// `(rowid, key)` rows of a table in rowid order.
type Rowids = Vec<(i64, String)>;
/// The rowids of `floor_codes` and `floor_scans` and the last code of the open box.
type RowidsAndLastCode = (Rowids, Rowids, (String, String, String));

/// `(rowid, key)` of every row of `floor_codes` and `floor_scans`, in rowid order, and the
/// open box's last code as «Снять последний код» reads it (`LAST_CODE_SQL`).
async fn rowids_and_last_code(raw: &mut sqlx::SqliteConnection) -> RowidsAndLastCode {
    let codes = sqlx::query_as("SELECT rowid, code_hash FROM floor_codes ORDER BY rowid")
        .fetch_all(&mut *raw)
        .await
        .unwrap();
    let scans = sqlx::query_as("SELECT rowid, id FROM floor_scans ORDER BY rowid")
        .fetch_all(&mut *raw)
        .await
        .unwrap();
    let last = sqlx::query_as(
        "SELECT code_hash, scan_id, scanned_at FROM floor_codes \
         WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .bind("host")
    .bind("device")
    .bind("box-1")
    .fetch_one(&mut *raw)
    .await
    .unwrap();
    (codes, scans, last)
}

/// Migration `0014` keeps each row's rowid: «Снять последний код» takes a box's newest code
/// by it, and a copy without it renumbers the rows past every deleted one (or reorders them).
/// An open box whose codes came out of hash order, with an undone code between them, keeps
/// the same rowids and the same last code. `test/floor-schema.test.ts` pins the same on
/// Node's SQLite.
#[tokio::test]
async fn migration_0014_keeps_each_rows_rowid() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < 14)
        .cloned()
        .collect();
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(before),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    let code = |hash: &str| {
        format!(
            "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
             scanned_at) VALUES ('host', 'device', '{hash}', 'shift-1', 'box-1', 'scan-{hash}', \
             '2026-10-09T08:00:00.000Z')"
        )
    };
    let scan = |hash: &str, verdict: &str, box_id: &str| {
        format!(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, \
             raw_kind, raw_length, gtin14, serial, canonical, code_hash, scanned_at) VALUES \
             ('scan-{hash}', 'host', 'device', 'shift-1', {box_id}, '{verdict}', 'km', 31, \
             '04600682000013', 'abc', '0104600682000013215abc', '{hash}', \
             '2026-10-09T08:00:00.000Z')"
        )
    };
    for sql in [
        code("hash-c"),
        code("hash-a"),
        code("hash-d"),
        "DELETE FROM floor_codes WHERE code_hash = 'hash-a'".to_owned(),
        code("hash-b"),
        scan("hash-c", "ok", "'box-1'"),
        scan("hash-a", "ok", "'box-1'"),
        scan("hash-d", "ok", "'box-1'"),
        "DELETE FROM floor_scans WHERE id = 'scan-hash-a'".to_owned(),
        scan("hash-b", "ok", "'box-1'"),
        scan("hash-e", "wrong_gtin", "NULL"),
    ] {
        sqlx::query(&sql).execute(&mut raw).await.unwrap();
    }
    let seeded = rowids_and_last_code(&mut raw).await;
    assert_eq!(
        seeded.0,
        [(1, "hash-c"), (3, "hash-d"), (4, "hash-b")].map(|(n, key)| (n, key.to_owned()))
    );
    assert_eq!(
        seeded.1,
        [
            (1, "scan-hash-c"),
            (3, "scan-hash-d"),
            (4, "scan-hash-b"),
            (5, "scan-hash-e")
        ]
        .map(|(n, key)| (n, key.to_owned()))
    );
    assert_eq!(seeded.2 .0, "hash-b");
    raw.close().await.unwrap();

    let _db = LocalDb::open(dir.path()).await.unwrap();
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let version: (i64,) = sqlx::query_as("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    assert!(version.0 >= 14, "0014 is applied");
    assert_eq!(rowids_and_last_code(&mut raw).await, seeded);
    raw.close().await.unwrap();
}

/// Migration `0015` (plan РЕЖ part B) over a station's database of `0014`, on the shell's own
/// SQLite and through the application's start: it adds `floor_unit_labels` with its key, its
/// four indexes and its trigger, and every object and row that was there stays as it was.
/// `test/unit-label-schema.test.ts` pins the same on Node's SQLite.
#[tokio::test]
async fn migration_0015_adds_the_unit_labels_and_keeps_every_object() {
    let dir = tempfile::tempdir().unwrap();
    let before: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version < 15)
        .cloned()
        .collect();
    assert!(before.iter().any(|migration| migration.version == 14));
    assert!(MIGRATOR.iter().any(|migration| migration.version == 15));
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(before),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
         scanned_at) VALUES ('host', 'device', 'hash-1', 'shift-1', NULL, 'scan-1', \
         '2026-10-13T08:00:00.000Z')",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    let mut old = master_rows(&mut raw, "IN").await;
    old.extend(master_rows(&mut raw, "NOT IN").await);
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    assert_eq!(count(&db, "floor_codes").await, json!(1));
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let mut new = master_rows(&mut raw, "IN").await;
    new.extend(master_rows(&mut raw, "NOT IN").await);
    raw.close().await.unwrap();
    let added: Vec<&Value> = new.iter().filter(|row| !old.contains(row)).collect();
    assert_eq!(
        new.iter().filter(|row| old.contains(row)).count(),
        old.len(),
        "every object that was there stays as it was"
    );
    assert_eq!(
        added
            .iter()
            .map(|row| (
                row["type"].as_str().unwrap(),
                row["name"].as_str().unwrap(),
                row["tbl_name"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("index", "floor_unit_labels_scan", "floor_unit_labels"),
            ("index", "floor_unit_labels_sending", "floor_unit_labels"),
            ("index", "floor_unit_labels_shift", "floor_unit_labels"),
            ("index", "floor_unit_labels_unresolved", "floor_unit_labels"),
            (
                "index",
                "sqlite_autoindex_floor_unit_labels_1",
                "floor_unit_labels"
            ),
            ("table", "floor_unit_labels", "floor_unit_labels"),
            ("trigger", "floor_unit_labels_fixed", "floor_unit_labels"),
        ]
    );
}

#[tokio::test]
async fn a_batch_commits_together_and_values_come_back_typed() {
    let (_dir, db) = open().await;
    let changes = db
        .transaction(vec![
            statement(INSERT_LINE, json!([LINE_1, "Линия 1", false, 1])),
            statement(INSERT_LINE, json!([LINE_2, "Линия 2", true, 2])),
            statement(
                "INSERT INTO sync_state (key, value) VALUES ('last_rev', ?)",
                json!(["2"]),
            ),
        ])
        .await
        .unwrap();
    assert_eq!(changes, [1, 1, 1]);
    assert_eq!(
        lines(&db).await,
        json!([
            { "id": LINE_1, "name": "Линия 1", "archived": 0, "rev": 1 },
            { "id": LINE_2, "name": "Линия 2", "archived": 1, "rev": 2 }
        ])
    );
    let values = db
        .query(
            // `nothing` is quoted: SQLite's parser reserves the bare word for
            // `ON CONFLICT ... DO NOTHING` and refuses it as a column alias.
            "SELECT 1.5 AS fraction, NULL AS \"nothing\", ? AS word, count(*) AS lines FROM ref_lines",
            vec![json!("да")],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(values[0].clone()),
        json!({ "fraction": 1.5, "nothing": null, "word": "да", "lines": 2 })
    );
}

#[tokio::test]
async fn a_failing_statement_rolls_back_the_whole_batch() {
    let (_dir, db) = open().await;
    let result = db
        .transaction(vec![
            statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 1])),
            statement(INSERT_LINE, json!([LINE_1, "Та же линия", 0, 1])),
        ])
        .await;
    assert_eq!(result, Err(LocalDbError::StatementFailed));
    assert_eq!(lines(&db).await, json!([]));
}

#[tokio::test]
async fn expected_changes_guard_the_batch() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 1]),
    )])
    .await
    .unwrap();
    let rename = "UPDATE ref_lines SET name = ? WHERE id = ?";
    let result = db
        .transaction(vec![
            expecting(rename, json!(["Первая", LINE_1]), 1),
            expecting(rename, json!(["Вторая", LINE_2]), 1),
        ])
        .await;
    assert_eq!(result, Err(LocalDbError::ChangesMismatch));
    assert_eq!(
        lines(&db).await[0]["name"],
        "Линия 1",
        "the first update rolled back"
    );
    assert_eq!(
        db.transaction(vec![expecting(rename, json!(["Первая", LINE_1]), 1)])
            .await,
        Ok(vec![1])
    );
}

#[tokio::test]
async fn queries_are_read_only_and_writes_are_not_queries() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 1]),
    )])
    .await
    .unwrap();
    // `WITH` passes the syntax check; the read-only connection refuses the write.
    assert_eq!(
        db.query(
            "WITH doomed AS (SELECT id FROM ref_lines) DELETE FROM ref_lines WHERE id IN (SELECT id FROM doomed)",
            vec![],
        )
        .await,
        Err(LocalDbError::StatementFailed)
    );
    for sql in [
        "DELETE FROM ref_lines",
        "INSERT INTO sync_state (key, value) VALUES ('last_rev', '9')",
        "UPDATE ref_lines SET rev = 9",
    ] {
        assert_eq!(
            db.query(sql, vec![]).await,
            Err(LocalDbError::InvalidStatement),
            "{sql}"
        );
    }
    assert_eq!(lines(&db).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn batches_and_values_outside_the_rules_are_refused() {
    let (_dir, db) = open().await;
    assert_eq!(
        db.transaction(vec![]).await,
        Err(LocalDbError::InvalidStatement)
    );
    let exactly_max: Vec<LocalStatement> =
        (0..32).map(|_| statement(NOOP_UPDATE, json!([]))).collect();
    assert_eq!(db.transaction(exactly_max).await, Ok(vec![0; 32]));
    let too_many: Vec<LocalStatement> = (0..33).map(|_| statement("SELECT 1", json!([]))).collect();
    assert_eq!(
        db.transaction(too_many).await,
        Err(LocalDbError::InvalidStatement)
    );
    for sql in [
        "CREATE TABLE extra (x)",
        "PRAGMA foreign_keys = OFF",
        "BEGIN",
        "END",
        "DROP TABLE ref_lines",
    ] {
        assert_eq!(
            db.transaction(vec![statement(sql, json!([]))]).await,
            Err(LocalDbError::InvalidStatement),
            "{sql}"
        );
    }
    assert_eq!(
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, ["nested"], 0, 1])
        )])
        .await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, "Линия", 0, u64::MAX])
        )])
        .await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.query("SELECT x'00' AS bytes", vec![]).await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(
        db.query("SELECT ? AS nested", vec![json!({ "a": 1 })])
            .await,
        Err(LocalDbError::UnsupportedValue)
    );
    assert_eq!(lines(&db).await, json!([]));
}

/// SQLite treats a bare `END` as `COMMIT`. If it slipped past `check_statement`,
/// a batch with `END` in the middle would commit early right there, so the
/// duplicate `INSERT` after it would fail against already-committed data
/// instead of rolling back, and the writer's transaction depth would stay
/// wrong for later batches. `END` must be refused before any statement in
/// the batch runs.
#[tokio::test]
async fn a_bare_end_inside_a_batch_is_refused_before_any_write() {
    let (_dir, db) = open().await;
    let result = db
        .transaction(vec![
            statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 1])),
            statement("END", json!([])),
            statement(INSERT_LINE, json!([LINE_1, "Линия 1 опять", 0, 1])),
        ])
        .await;
    assert_eq!(result, Err(LocalDbError::InvalidStatement));
    assert_eq!(lines(&db).await, json!([]));
    assert_eq!(
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, "Линия 1", 0, 1])
        )])
        .await,
        Ok(vec![1])
    );
}

/// The reference sync (plan 1c3) applies a feed page as one statement per
/// entity with a JSON parameter: a thousand rows stay one statement, and the
/// same page applied again changes nothing.
#[tokio::test]
async fn one_statement_upserts_a_whole_page_through_json_each() {
    const UPSERT: &str = "INSERT INTO ref_lines (id, name, archived, rev) \
        SELECT value ->> 'id', value ->> 'name', value ->> 'archived', value ->> 'rev' \
        FROM json_each(?) WHERE true \
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, archived = excluded.archived, rev = excluded.rev \
        WHERE excluded.rev > ref_lines.rev";
    let (_dir, db) = open().await;
    let page = Value::Array(
        (0..1000)
            .map(|n| json!({ "id": format!("line-{n:04}"), "name": format!("Линия {n}"), "archived": 0, "rev": 7 }))
            .collect(),
    )
    .to_string();
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![1000])
    );
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![0])
    );
    let summary = db
        .query(
            "SELECT count(*) AS lines, min(rev) AS rev FROM ref_lines",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(summary[0].clone()),
        json!({ "lines": 1000, "rev": 7 })
    );
}

/// The limits bound SQL text (64 KB) and the number of values (256), never
/// the size of one value: a feed revision is never split, so one larger than a
/// page's 1 MiB (the wizard's templates, a template delete that clears
/// thousands of products) reaches the shell as one JSON parameter per entity,
/// several MiB long, and must pass whole (plan 1e2).
#[tokio::test]
async fn one_value_of_a_few_mebibytes_passes_the_limits() {
    const UPSERT: &str = "INSERT INTO ref_templates (id, name, purpose, enabled, category_codes, \
        stock, spec, rev) \
        SELECT value ->> 'id', value ->> 'name', value ->> 'purpose', value ->> 'enabled', \
        value ->> 'chzProductGroupCodes', value ->> 'stock', value ->> 'spec', value ->> 'rev' \
        FROM json_each(?) WHERE true";
    let (_dir, db) = open().await;
    // Twelve layouts of the host's largest size, 256 KB each.
    let spec = json!({ "widthMm": 58, "filler": "x".repeat(256 * 1024 - 32) });
    let spec_length = spec.to_string().len();
    let page = Value::Array(
        (0..12)
            .map(|n| {
                json!({
                    "id": format!("template-{n:02}"),
                    "name": format!("Шаблон {n}"),
                    "purpose": "box",
                    "enabled": true,
                    "chzProductGroupCodes": null,
                    "stock": false,
                    "spec": spec,
                    "rev": 7
                })
            })
            .collect(),
    )
    .to_string();
    assert!(page.len() > 3 * 1024 * 1024, "{} bytes", page.len());
    assert_eq!(
        db.transaction(vec![statement(UPSERT, json!([page]))]).await,
        Ok(vec![12])
    );
    let stored = db
        .query(
            "SELECT count(*) AS templates, min(length(spec)) AS shortest, \
             max(length(spec)) AS longest FROM ref_templates",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Object(stored[0].clone()),
        json!({ "templates": 12, "shortest": spec_length, "longest": spec_length })
    );
}

/// Every table the migrations create has exactly one forget class
/// (stage 2a spec §5.2, decision 30), and the class list names nothing else:
/// a plan that adds a table must say whether a forget empties it, keeps it as
/// this device's own record, or keeps it as the workstation's setting.
#[tokio::test]
async fn every_table_has_a_forget_class() {
    let (_dir, db) = open().await;
    let rows = db
        .query(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' \
             AND type IN ('table', 'virtual') AND name <> '_sqlx_migrations' \
             AND name NOT GLOB 'sqlite_*' ORDER BY name",
            vec![],
        )
        .await
        .unwrap();
    let tables: Vec<&str> = rows
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    let unclassified: Vec<&str> = tables
        .iter()
        .copied()
        .filter(|table| table_class(table).is_none())
        .collect();
    assert!(
        unclassified.is_empty(),
        "tables without a forget class: {unclassified:?}; add each to TABLE_CLASSES in local_db.rs"
    );
    let mut listed: Vec<&str> = TABLE_CLASSES.iter().map(|(table, _)| *table).collect();
    listed.sort_unstable();
    assert_eq!(
        listed, tables,
        "TABLE_CLASSES names each table of the migrations once, and nothing else"
    );
    // This device's own records are the production tables of `0006`, the
    // print jobs of `0007`, the pallets of `0008`, the dropped blocks of `0013` and the unit
    // label jobs of `0015`; the sign-in lockouts
    // stay with the copies (an open owner question); the workstation's
    // settings belong to the PC.
    let device_data: Vec<&str> = TABLE_CLASSES
        .iter()
        .filter(|(_, class)| *class == TableClass::DeviceData)
        .map(|(table, _)| *table)
        .collect();
    assert_eq!(
        device_data,
        [
            "floor_block_drops",
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_pallet_exceptions",
            "floor_pallets",
            "floor_print_jobs",
            "floor_scans",
            "floor_shifts",
            "floor_sscc_blocks",
            "floor_unit_labels",
            "outbox",
            "wh_jobs",
            "wh_outbox",
            "wh_sessions"
        ]
    );
    assert_eq!(
        table_class("floor_sign_in_failures"),
        Some(TableClass::Disposable)
    );
    assert_eq!(
        table_class("workstation_settings"),
        Some(TableClass::Workstation)
    );
}

/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: every table outside that class (this device's records and
/// the workstation's settings) keeps its row, and so does sqlx's migration
/// journal.
#[tokio::test]
async fn clearing_the_copies_empties_the_disposable_tables_and_nothing_else() {
    let (_dir, db) = open().await;
    db.transaction(vec![
        statement(
            "INSERT INTO ref_org (id, name, inn, gln, gs1_prefixes, time_zone, rev) \
             VALUES ('org-1', 'Завод', NULL, '4600682000006', '[]', 'Europe/Moscow', 1)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_site (id, badge_salt, box_block_size, pallet_block_size, rev) \
             VALUES ('site-1', 'c2FsdA==', 100, 10, 2)",
            json!([]),
        ),
        statement(INSERT_LINE, json!([LINE_1, "Линия 1", 0, 3])),
        statement(
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '3')",
            json!([]),
        ),
        statement(
            "INSERT INTO sync_quarantine (entity, id, rev, reason, seen_at) \
             VALUES ('lines', ?, 4, 'archived: invalid_type', 1790000000000)",
            json!([LINE_2]),
        ),
        statement(
            "INSERT INTO ref_products (id, gtin14, name, archived, status, rev) \
             VALUES ('product-1', '04600682000013', 'Молоко', 0, 'draft', 5)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_templates (id, name, purpose, enabled, stock, spec, rev) \
             VALUES ('template-1', 'Коробка', 'box', 1, 0, '{}', 6)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_template_defaults (id, chz_group_code, purpose, template_id, rev) \
             VALUES ('8:box', 8, 'box', 'template-1', 7)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_operators (id, login, name, pin_phc, rev) \
             VALUES ('operator-1', '0001', 'Анна', 'pbkdf2$pin', 8)",
            json!([]),
        ),
        statement(
            "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) \
             VALUES ('badge-1', 'operator-1', 'pbkdf2$badge', NULL, 9)",
            json!([]),
        ),
        // This device's own failed sign-ins (plan 1f): cleared with the copies.
        statement(
            "INSERT INTO floor_sign_in_failures (key, failures, locked_at, last_failure_at) \
             VALUES ('station', 3, 1790000000000, 1790000000000)",
            json!([]),
        ),
        // What this pairing owes a restored host (plan РК-С, `0009`): the old pairing's
        // obligation is not the new one's, so a forget empties it with the copies.
        statement(
            "INSERT INTO floor_restore_epochs (host_id, device_id, epoch, seen_at, refused) \
             VALUES (?, ?, '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e', '2026-10-11T08:00:00.000Z', 2)",
            json!([HOST, DEVICE]),
        ),
    ])
    .await
    .unwrap();
    // One record in each table of this device's own (`0006`–`0008`, `0012`) and
    // one setting of the workstation (`0007`).
    db.transaction(device_records()).await.unwrap();
    db.transaction(vec![statement(
        "INSERT INTO workstation_settings (key, value) VALUES ('printers', '{}')",
        json!([]),
    )])
    .await
    .unwrap();
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
    let migrations = db.query(journal, vec![]).await.unwrap();

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for (table, class) in TABLE_CLASSES {
        let left = db
            .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
            .await
            .unwrap();
        let expected = if *class == TableClass::Disposable {
            0
        } else {
            1
        };
        assert_eq!(
            Value::Object(left[0].clone()),
            json!({ "n": expected }),
            "{table}"
        );
    }
    // The rows of this device's own stay whatever `TABLE_CLASSES` says, named
    // here once more so the check does not follow the list it checks.
    for table in [
        "floor_block_drops",
        "floor_block_requests",
        "floor_boxes",
        "floor_codes",
        "floor_exceptions",
        "floor_pallet_exceptions",
        "floor_pallets",
        "floor_print_jobs",
        "floor_scans",
        "floor_shifts",
        "floor_sscc_blocks",
        "floor_unit_labels",
        "outbox",
        "wh_jobs",
        "wh_outbox",
        "wh_sessions",
    ] {
        assert_eq!(count(&db, table).await, json!(1), "{table} keeps its row");
    }
    assert_eq!(db.query(journal, vec![]).await.unwrap(), migrations);
    // The database takes writes afterwards as before.
    assert_eq!(
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, "Линия 1", 0, 5])
        )])
        .await,
        Ok(vec![1])
    );
}

const HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER_HOST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_DEVICE: &str = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

/// Runs `statements` on a raw connection, as a later migration would: the
/// webview may not create tables.
async fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    for sql in statements {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
}

/// The SQL of an outbox record of the pairing `(host, device)`, acknowledged
/// at `acked` (an `accepted` receipt) or not yet, for a raw connection.
fn outbox_sql(id: &str, host: &str, device: &str, acked: Option<&str>) -> String {
    let (outcome, acked_at) = match acked {
        Some(at) => ("'accepted'".to_string(), format!("'{at}'")),
        None => ("NULL".to_string(), "NULL".to_string()),
    };
    format!(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('{id}', '{host}', '{device}', 'scan', 'shift-1', '{{}}', \
         '2026-10-09T08:00:00.000Z', {outcome}, {acked_at})"
    )
}

/// An outbox record of the pairing `(host, device)`, acknowledged at `acked`
/// (an `accepted` receipt) or not yet.
fn outbox_record(id: &str, host: &str, device: &str, acked: Option<&str>) -> LocalStatement {
    statement(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', '{}', \
         '2026-10-09T08:00:00.000Z', ?, ?)",
        json!([id, host, device, acked.map(|_| "accepted"), acked]),
    )
}

/// One row in each table of this device's own records (migrations
/// `0006`–`0008`, `0012`, `0013` and `0015`), each of the pairing `(HOST, DEVICE)`, as the floor's
/// writers will write them through `local_transaction`.
fn device_records() -> Vec<LocalStatement> {
    vec![
        statement(
            "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, \
             pallets_enabled, created_from, line_id, product_id, product_name, product_gtin14, \
             production_date, box_capacity, box_template_id, owner_device_id, opened_at, \
             snapshot, entered_at, seen_at) VALUES (?, ?, 'shift-1', 'OCT26-004', 'active', \
             'aggregation', 0, 'office', ?, 'product-1', 'Молоко', '04600682000013', \
             '2026-10-08', 12, 'template-1', ?, '2026-10-08T06:02:00Z', '{}', \
             '2026-10-08T06:02:01.000Z', 1790000000000)",
            json!([HOST, DEVICE, LINE_1, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_sscc_blocks (block_id, host_id, device_id, issuer_prefix, \
             extension, from_serial, to_serial, next_serial, received_at) \
             VALUES ('block-1', ?, ?, '460068200', 0, 1, 2000, 1, '2026-10-08T06:02:02.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_block_requests (request_id, host_id, device_id, issuer_prefix, \
             extension, requested_at) VALUES ('request-1', ?, ?, '460068200', 0, \
             '2026-10-08T06:02:02.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_block_drops (host_id, device_id, block_id, request_id, \
             issuer_prefix, extension, from_serial, to_serial, reason, dropped_at) \
             VALUES (?, ?, 'block-2', 'request-0', '460068200', 0, 1500, 2000, 'overlap', \
             '2026-10-08T06:02:03.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_boxes (id, host_id, device_id, shift_id, opened_at, item_count) \
             VALUES ('box-1', ?, ?, 'shift-1', '2026-10-08T06:03:00.000Z', 1)",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, \
             scanned_at) VALUES (?, ?, 'hash-1', 'shift-1', 'box-1', 'scan-1', \
             '2026-10-08T06:03:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at) \
             VALUES ('scan-1', ?, ?, 'shift-1', 'box-1', 'ok', 'km', 31, 'hash-1', \
             '04600682000013', 'abc', 'code', '2026-10-08T06:03:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, \
             occurred_at) VALUES ('exception-1', ?, ?, 'shift-1', 'clear', 'box-1', \
             '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_print_jobs (id, host_id, device_id, shift_id, purpose, \
             subject_id, sscc, state, verify, template_id, template_rev, fields, operator_id, \
             created_at, updated_at) VALUES ('job-1', ?, ?, 'shift-1', 'box', 'box-1', \
             '046006820000000017', 'skipped', 0, 'template-1', 3, '{}', 'operator-1', \
             '2026-10-08T06:04:00.000Z', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_pallets (id, host_id, device_id, shift_id, opened_at) \
             VALUES ('pallet-1', ?, ?, 'shift-1', '2026-10-08T06:04:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, \
             pallet_id, reason_code, occurred_at) VALUES ('pallet-exception-1', ?, ?, \
             'shift-1', 'reprint', 'pallet-1', 'printer_jam', '2026-10-08T06:05:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        outbox_record("record-1", HOST, DEVICE, None),
        // A unit label job (plan РЕЖ part B, `0015`), completed.
        statement(
            "INSERT INTO floor_unit_labels (id, host_id, device_id, shift_id, code_hash, scan_id, \
             attempt_no, attempt_state, verification_policy, verification, print_mode, \
             language, dpi, bytes_base64, bytes_digest, payload_digest, template_id, \
             template_rev, fields, operator_id, created_at, updated_at) VALUES ('label-1', ?, \
             ?, 'shift-1', printf('%064x', 1), 'scan-1', 1, 'sent', 'none', 'not_required', \
             'raw', 'zpl', 203, 'XlhB', printf('%064x', 2), printf('%064x', 3), 'template-1', \
             3, '{}', 'operator-1', '2026-10-08T06:03:01.000Z', '2026-10-08T06:03:02.000Z')",
            json!([HOST, DEVICE]),
        ),
        // The warehouse reprint's own (plan СКЛ, `0012`): a session, a job and a record.
        statement(
            "INSERT INTO wh_sessions (id, host_id, device_id, reason, started_by, started_at, \
             updated_at) VALUES ('wh-session-1', ?, ?, 'damaged', 'operator-1', \
             '2026-10-08T07:00:00.000Z', '2026-10-08T07:00:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO wh_jobs (id, host_id, device_id, session_id, kind, subject_id, identity, \
             reason, state, template_id, template_rev, template_spec, fields, operator_id, \
             created_at, updated_at) VALUES ('wh-job-1', ?, ?, 'wh-session-1', 'box', 'box-1', \
             '046006820000000017', 'damaged', 'cancelled', 'template-1', 3, '{}', '{}', \
             'operator-1', '2026-10-08T07:01:00.000Z', '2026-10-08T07:01:00.000Z')",
            json!([HOST, DEVICE]),
        ),
        statement(
            "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at) \
             VALUES ('wh-record-1', ?, ?, 'wh-session-1', '{}', '2026-10-08T07:01:00.000Z')",
            json!([HOST, DEVICE]),
        ),
    ]
}

async fn count(db: &LocalDb, table: &str) -> Value {
    let rows = db
        .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
        .await
        .unwrap();
    rows[0]["n"].clone()
}

/// A forget refuses while records without a receipt remain (stage 2a spec
/// §5.2, question В7): this pairing's with `Pairing`, anyone's with
/// `AnyPairing`; it clears nothing then. `Ignore` — the person confirmed —
/// clears the copies and keeps every outbox record. The records of another
/// device and of another host, each with the same other id, are told apart
/// from this pairing's.
#[tokio::test]
async fn a_forget_refuses_while_unsent_records_remain() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    db.transaction(vec![
        outbox_record("a", HOST, DEVICE, None),
        outbox_record("b", HOST, OTHER_DEVICE, None),
        outbox_record("c", OTHER_HOST, DEVICE, None),
    ])
    .await
    .unwrap();

    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Err(LocalDbError::UnsentRecords { count: 1 })
    );
    assert_eq!(
        db.clear_copies(UnsentGuard::AnyPairing).await,
        Err(LocalDbError::UnsentRecords { count: 3 })
    );
    assert_eq!(
        count(&db, "ref_lines").await,
        json!(1),
        "nothing was cleared"
    );

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));
    assert_eq!(count(&db, "ref_lines").await, json!(0));
    assert_eq!(count(&db, "outbox").await, json!(3), "the records stay");
}

/// Records with a receipt, and another pairing's, do not stop this
/// pairing's forget; nor does an empty outbox. Once every record has a
/// receipt, no pairing's forget is stopped, `AnyPairing` included.
#[tokio::test]
async fn sent_records_and_other_pairings_do_not_stop_a_forget() {
    let (_dir, db) = open().await;
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Ok(())
    );
    assert_eq!(db.clear_copies(UnsentGuard::AnyPairing).await, Ok(()));

    db.transaction(vec![
        outbox_record("a", HOST, DEVICE, Some("2026-10-09T08:00:00.000Z")),
        outbox_record("b", HOST, OTHER_DEVICE, None),
    ])
    .await
    .unwrap();
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Ok(())
    );
    assert_eq!(
        db.clear_copies(UnsentGuard::AnyPairing).await,
        Err(LocalDbError::UnsentRecords { count: 1 })
    );
    assert_eq!(count(&db, "outbox").await, json!(2));

    db.transaction(vec![statement(
        "UPDATE outbox SET outcome = 'accepted', acked_at = '2026-10-09T08:01:00.000Z' \
         WHERE id = 'b'",
        json!([]),
    )])
    .await
    .unwrap();
    assert_eq!(db.clear_copies(UnsentGuard::AnyPairing).await, Ok(()));
}

/// A reprint record of the warehouse (`wh_outbox`, migration `0012`) of the
/// pairing `(host, device)`, with the host's receipt (`accepted` or `rejected`)
/// or without one.
fn wh_record(id: &str, host: &str, device: &str, receipt: Option<&str>) -> LocalStatement {
    statement(
        "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at, \
         outcome, acked_at) VALUES (?, ?, ?, 'wh-session-1', '{}', \
         '2026-10-09T08:00:00.000Z', ?, ?)",
        json!([
            id,
            host,
            device,
            receipt,
            receipt.map(|_| "2026-10-09T08:00:01.000Z")
        ]),
    )
}

/// The warehouse reprint's records without the host's receipt stop a forget as
/// the shift facts do (plan СКЛ task 6): this pairing's with `Pairing`, anyone's
/// with `AnyPairing`, counted together with the facts. A record with a receipt
/// (`accepted` or `rejected`: the host has answered it) and another pairing's
/// do not stop this pairing's. Nothing is cleared while one stops it.
#[tokio::test]
async fn a_forget_refuses_while_unsent_warehouse_records_remain() {
    let (_dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    db.transaction(vec![
        wh_record("a", HOST, DEVICE, Some("accepted")),
        wh_record("b", HOST, DEVICE, Some("rejected")),
        wh_record("c", HOST, OTHER_DEVICE, None),
        wh_record("d", OTHER_HOST, DEVICE, None),
    ])
    .await
    .unwrap();
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Ok(()),
        "a record with the host's receipt, and other pairings', do not stop it"
    );
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();

    db.transaction(vec![wh_record("e", HOST, DEVICE, None)])
        .await
        .unwrap();
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Err(LocalDbError::UnsentRecords { count: 1 })
    );
    assert_eq!(
        db.clear_copies(UnsentGuard::AnyPairing).await,
        Err(LocalDbError::UnsentRecords { count: 3 })
    );
    // The facts and the reprint records are told together.
    db.transaction(vec![outbox_record("f", HOST, DEVICE, None)])
        .await
        .unwrap();
    assert_eq!(
        db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await,
        Err(LocalDbError::UnsentRecords { count: 2 })
    );
    assert_eq!(
        count(&db, "ref_lines").await,
        json!(1),
        "nothing was cleared"
    );

    // Confirmed: the copies go, every record stays.
    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));
    assert_eq!(count(&db, "ref_lines").await, json!(0));
    assert_eq!(count(&db, "wh_outbox").await, json!(5));
    assert_eq!(count(&db, "outbox").await, json!(1));
}

/// A `wh_outbox` the forget cannot read fails the forget and clears nothing,
/// as an unreadable `outbox` does.
#[tokio::test]
async fn a_warehouse_outbox_that_cannot_be_counted_stops_a_forget() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    run_raw(
        dir.path(),
        &[
            "DROP TABLE wh_outbox",
            "CREATE TABLE wh_outbox (id TEXT PRIMARY KEY)",
        ],
    )
    .await;
    for guard in [UnsentGuard::Pairing(HOST, DEVICE), UnsentGuard::AnyPairing] {
        assert_eq!(
            db.clear_copies(guard).await,
            Err(LocalDbError::StatementFailed)
        );
    }
    assert_eq!(count(&db, "ref_lines").await, json!(1), "nothing cleared");
}

/// In a database that opened, a `wh_outbox` that is gone is not "no records": the
/// forget cannot count it and clears nothing (only a database that did not open
/// may lack the table, see `an_unopened_database_counts_its_warehouse_records_too`).
#[tokio::test]
async fn a_missing_warehouse_outbox_in_an_open_database_stops_a_forget() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    run_raw(dir.path(), &["DROP TABLE wh_outbox"]).await;
    for guard in [UnsentGuard::Pairing(HOST, DEVICE), UnsentGuard::AnyPairing] {
        assert_eq!(
            db.clear_copies(guard).await,
            Err(LocalDbError::StatementFailed)
        );
    }
    assert_eq!(count(&db, "ref_lines").await, json!(1), "nothing cleared");
}

/// An outbox the forget cannot read fails the forget and clears nothing,
/// instead of counting it as empty: a misread must never wipe copies while
/// records may be waiting.
#[tokio::test]
async fn an_outbox_that_cannot_be_counted_stops_a_forget() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    // An outbox without the columns a forget reads: a damaged or foreign
    // table (no build of this app ever made one), so it cannot be counted.
    run_raw(
        dir.path(),
        &[
            "DROP TABLE outbox",
            "CREATE TABLE outbox (id TEXT PRIMARY KEY)",
        ],
    )
    .await;

    for guard in [UnsentGuard::Pairing(HOST, DEVICE), UnsentGuard::AnyPairing] {
        assert_eq!(
            db.clear_copies(guard).await,
            Err(LocalDbError::StatementFailed)
        );
    }
    assert_eq!(count(&db, "ref_lines").await, json!(1), "nothing cleared");
    // A confirmed forget does not read the outbox at all.
    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));
}

/// The statements of the retention pass (`src/local/retention.ts`, plan 2a8): which shifts are
/// done with (driven from the accepted closes, so the pairing's accepted records are walked once,
/// not once per shift) and the delete of the first one's copy. `test/floor-schema.test.ts` plans
/// the same texts on the Node runtime's SQLite and checks that they appear here word for word.
const DUE_SHIFTS: &str =
    "SELECT DISTINCT o.shift_id AS id FROM outbox o WHERE o.host_id = ? AND o.device_id = ? \
     AND o.outcome = 'accepted' AND o.kind = 'shift_closed' AND o.acked_at <= ? AND EXISTS \
     (SELECT 1 FROM floor_shifts s WHERE s.host_id = o.host_id AND s.device_id = o.device_id \
     AND s.id = o.shift_id) AND NOT EXISTS (SELECT 1 FROM outbox u WHERE u.host_id = \
     o.host_id AND u.device_id = o.device_id AND u.shift_id = o.shift_id AND u.acked_at IS \
     NULL) AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = o.host_id AND \
     r.device_id = o.device_id AND r.shift_id = o.shift_id AND r.outcome IN ('rejected', \
     'conflict') AND r.resolved_at IS NULL) AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j \
     WHERE j.host_id = o.host_id AND j.device_id = o.device_id AND j.shift_id = o.shift_id \
     AND (state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = 'sent' AND \
     verify = 1))) AND NOT EXISTS (SELECT 1 FROM floor_unit_labels l INDEXED BY \
     floor_unit_labels_unresolved WHERE l.host_id = o.host_id AND l.device_id = o.device_id \
     AND l.shift_id = o.shift_id AND (verification = 'pending' OR (verification = \
     'not_required' AND attempt_state <> 'sent')))";
const PURGE_COPY: &str =
    "DELETE FROM floor_shifts AS s WHERE s.id = ? AND s.host_id = ? AND s.device_id = ? \
     AND EXISTS (SELECT 1 FROM outbox o WHERE o.host_id = s.host_id AND o.device_id = \
     s.device_id AND o.shift_id = s.id AND o.kind = 'shift_closed' AND o.outcome = \
     'accepted' AND o.acked_at <= ?) AND NOT EXISTS (SELECT 1 FROM outbox o WHERE \
     o.host_id = s.host_id AND o.device_id = s.device_id AND o.shift_id = s.id AND \
     o.acked_at IS NULL) AND NOT EXISTS (SELECT 1 FROM outbox r WHERE r.host_id = \
     s.host_id AND r.device_id = s.device_id AND r.shift_id = s.id AND r.outcome IN \
     ('rejected', 'conflict') AND r.resolved_at IS NULL) AND NOT EXISTS (SELECT 1 FROM \
     floor_print_jobs j WHERE j.host_id = s.host_id AND j.device_id = s.device_id AND \
     j.shift_id = s.id AND (state IN ('prepared', 'sending', 'failed', 'unknown') OR \
     (state = 'sent' AND verify = 1))) AND NOT EXISTS (SELECT 1 FROM floor_unit_labels l \
     INDEXED BY floor_unit_labels_unresolved WHERE l.host_id = s.host_id AND l.device_id = \
     s.device_id AND l.shift_id = s.id AND (verification = 'pending' OR (verification = \
     'not_required' AND attempt_state <> 'sent')))";

/// The shift list's read of the refused closes (`readRefusedCloses` in `src/floor/close/shift-close.ts`,
/// plan 2a8): it runs again on every bump of the outbox while the list is shown, a reconnect's every
/// batch included. `test/floor-schema.test.ts` plans the same text on the Node runtime's SQLite and
/// checks that it appears here word for word.
const REFUSED_CLOSES: &str =
    "SELECT shift_id, outcome_code AS code FROM outbox WHERE host_id = ? AND device_id = ? \
     AND kind = 'shift_closed' AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";

/// What a station owes a host restored from a copy (`src/local/restore-reconcile.ts`, plan РК-С):
/// the obligation, read on every bump of the status bar, the blocks the station sends back, the
/// refused ones retired, the records sent again and the settling of the epoch.
/// `test/floor-schema.test.ts` plans the same texts on the Node runtime's SQLite and checks that
/// they appear here word for word.
const RESTORE_DUE: &str =
    "SELECT epoch FROM floor_restore_epochs WHERE host_id = ? AND device_id = ? \
     AND reconciled_at IS NULL";
const RESTORE_STATUS: &str =
    "SELECT reconciled_at IS NULL AS due, refused, refused_blocks FROM floor_restore_epochs \
     WHERE host_id = ? AND device_id = ?";
const RESTORE_BLOCKS: &str =
    "SELECT block_id, issuer_prefix, extension, from_serial, to_serial FROM floor_sscc_blocks \
     WHERE host_id = ? AND device_id = ? ORDER BY received_at, block_id";
const RESTORE_RETIRE: &str =
    "UPDATE floor_sscc_blocks SET next_serial = to_serial + 1 WHERE host_id = ? AND device_id = ? \
     AND block_id IN (SELECT value FROM json_each(?))";
const RESTORE_REOPEN: &str =
    "UPDATE outbox SET outcome = NULL, outcome_code = NULL, outcome_details = NULL, acked_at = \
     NULL WHERE host_id = ? AND device_id = ? AND outcome IS NOT NULL AND acked_at >= ? \
     AND resolved_at IS NULL";
/// The warehouse reprint's records the host accepted in the window (plan СКЛ), sent again in the
/// same transaction.
const RESTORE_REOPEN_WAREHOUSE: &str =
    "UPDATE wh_outbox SET outcome = NULL, outcome_code = NULL, acked_at = NULL WHERE host_id = ? \
     AND device_id = ? AND outcome = 'accepted' AND acked_at >= ?";
/// The stuck line's clamp after a restore (`src/floor/outbox-status.ts`): when the pairing last
/// settled one, read with every status of a failing delivery.
const RESTORE_RECONCILED_AT: &str =
    "SELECT reconciled_at FROM floor_restore_epochs WHERE host_id = ? AND device_id = ?";
const RESTORE_SETTLE: &str =
    "UPDATE floor_restore_epochs SET reconciled_at = ?, refused = ?, refused_blocks = ? WHERE \
     host_id = ? AND device_id = ? AND epoch = ? AND reconciled_at IS NULL";

/// The queue screen (plan ОЧ; `src/floor/queue/outbox-recovery.ts`): read on opening, written on a
/// person's press. `test/floor-schema.test.ts` plans the same texts on the Node runtime's SQLite
/// and checks that they appear here word for word.
const QUEUE_UNSENT: &str =
    "SELECT kind, count(*) AS n, min(created_at) AS oldest FROM outbox WHERE host_id = ? \
     AND device_id = ? AND acked_at IS NULL GROUP BY kind";
/// The bounded list (the final review's I-1): at most the bound of each shift's refused and of its
/// conflicting records, numbered in one sort; only those are looked up and joined.
const QUEUE_SETTLED: &str =
    "SELECT o.id, o.seq, o.kind, o.shift_id, s.number AS shift_number, o.created_at, o.outcome, \
     o.outcome_code AS code, coalesce(o.payload ->> '$.data.sscc', b.sscc, p.sscc) AS sscc \
     FROM (SELECT seq, row_number() OVER (PARTITION BY shift_id, outcome ORDER BY seq) AS place \
     FROM outbox WHERE host_id = ? AND device_id = ? AND outcome IN ('rejected', 'conflict') \
     AND resolved_at IS NULL) AS f JOIN outbox o ON o.seq = f.seq \
     LEFT JOIN floor_shifts s ON s.host_id = o.host_id \
     AND s.device_id = o.device_id AND s.id = o.shift_id \
     LEFT JOIN floor_boxes b ON b.id = (o.payload ->> '$.data.boxId') \
     LEFT JOIN floor_pallets p ON p.id = (o.payload ->> '$.data.palletId') \
     WHERE f.place <= ?";
/// Every unresolved refused and conflicting record counted by shift, outcome and kind.
const QUEUE_TALLY: &str =
    "SELECT shift_id, outcome, kind, count(*) AS n FROM outbox WHERE host_id = ? \
     AND device_id = ? AND outcome IN ('rejected', 'conflict') AND resolved_at IS NULL \
     GROUP BY shift_id, outcome, kind";
/// Every refused record of one shift taken off at once, never its close.
const QUEUE_DISMISS_SHIFT: &str =
    "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? \
     WHERE host_id = ? AND device_id = ? AND shift_id = ? AND outcome = 'rejected' \
     AND kind <> 'shift_closed' AND resolved_at IS NULL";
const QUEUE_RESEND_READ: &str =
    "SELECT id, payload FROM outbox WHERE host_id = ? AND device_id = ? AND shift_id = ? \
     AND outcome = 'rejected' AND resolved_at IS NULL ORDER BY seq";
const QUEUE_RESEND_INSERT: &str =
    "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
     SELECT r.value ->> 'newId', o.host_id, o.device_id, o.kind, o.shift_id, \
     r.value ->> 'payload', ? FROM json_each(?) AS r JOIN outbox AS o ON o.id = r.value ->> 'oldId' \
     WHERE +o.host_id = ? AND +o.device_id = ? AND +o.outcome = 'rejected' \
     AND o.resolved_at IS NULL ORDER BY o.seq";
const QUEUE_RESEND_MARK: &str =
    "UPDATE outbox SET resolution = 'resent', resent_as = r.value ->> 'newId', resolved_at = ?, \
     resolved_by = ? FROM json_each(?) AS r WHERE outbox.id = r.value ->> 'oldId' \
     AND +outbox.host_id = ? AND +outbox.device_id = ? AND +outbox.outcome = 'rejected' \
     AND outbox.resolved_at IS NULL";
const QUEUE_DISMISS: &str =
    "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, resolved_by = ? \
     WHERE host_id = ? AND device_id = ? AND id = ? AND outcome IN ('rejected', 'conflict') \
     AND kind <> 'shift_closed' AND resolved_at IS NULL";
/// The one walk of the queue screen: the unsent records of every pairing, in their partial index.
const QUEUE_STRANDED: &str =
    "SELECT count(*) AS n FROM outbox INDEXED BY outbox_unsent WHERE acked_at IS NULL \
     AND NOT (host_id = ? AND device_id = ?)";

/// The pallets' statements (plan ПЛ-Ц; `src/floor/pallets/pallets.ts`, `src/floor/close/shift-close.ts`,
/// `src/floor/print/print-jobs.ts`; `test/floor-schema.test.ts` checks the texts agree): the open
/// pallet and its counts, a pallet's close, a box joining it, the shift close's check and
/// summary, and the label queue's read.
const OPEN_PALLET: &str =
    "SELECT p.id, p.opened_at, (SELECT count(*) FROM floor_boxes b WHERE b.host_id = \
     p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at \
     IS NULL) AS boxes, (SELECT coalesce(sum(b.item_count), 0) FROM floor_boxes b WHERE \
     b.host_id = p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id AND \
     b.disassembled_at IS NULL) AS items FROM floor_pallets p WHERE p.host_id = ? AND \
     p.device_id = ? AND p.shift_id = ? AND p.closed_at IS NULL";
const CLOSE_PALLET: &str =
    "UPDATE floor_pallets AS p SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
     closed_by = ? WHERE p.id = ? AND p.host_id = ? AND p.device_id = ? AND p.closed_at IS \
     NULL AND (SELECT count(*) FROM floor_boxes b WHERE b.host_id = p.host_id AND \
     b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at IS NULL) = ?";
const JOIN_PALLET: &str =
    "UPDATE floor_pallets SET id = id WHERE id = ? AND host_id = ? AND device_id = ? AND \
     closed_at IS NULL";
const BOX_ONTO_PALLET: &str =
    "UPDATE floor_boxes SET pallet_id = ? WHERE id = ? AND host_id = ? AND device_id = ? \
     AND closed_at IS NOT NULL AND pallet_id IS NULL";
const PALLET_SSCC_HELD: &str = "SELECT 1 AS n FROM floor_pallets WHERE sscc = ? LIMIT 1";
/// The exceptions of a pallet (plan ПЛ-Ц, `src/floor/exceptions/pallet-exceptions.ts` and
/// `src/floor/pallets/pallets.ts`; `test/floor-schema.test.ts` checks the texts agree): the
/// closed pallets of a shift with their boxes, a pallet by its key with its boxes, its
/// disassembly and the reprint's comparison that it is still closed and whole, the pallet's
/// newest job and the comparison that no newer job came.
const CLOSED_PALLETS: &str =
    "SELECT p.id, p.sscc, p.closed_at, (SELECT count(*) FROM floor_boxes b WHERE b.host_id = \
     p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at \
     IS NULL) AS boxes FROM floor_pallets p WHERE p.host_id = ? AND p.device_id = ? AND \
     p.shift_id = ? AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL ORDER BY \
     p.closed_at DESC, p.serial DESC";
const PALLET_STATE: &str =
    "SELECT p.closed_at, p.disassembled_at, (SELECT count(*) FROM floor_boxes b WHERE \
     b.host_id = p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id AND \
     b.disassembled_at IS NULL) AS boxes FROM floor_pallets p WHERE p.id = ? AND p.host_id \
     = ? AND p.device_id = ? AND p.shift_id = ?";
const DISASSEMBLE_PALLET: &str =
    "UPDATE floor_pallets SET disassembled_at = ? WHERE id = ? AND host_id = ? AND \
     device_id = ? AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL";
const PALLET_LIVE_GUARD: &str =
    "UPDATE floor_pallets SET disassembled_at = disassembled_at WHERE id = ? AND host_id = \
     ? AND device_id = ? AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS \
     NULL";
const PALLET_LABEL_CLOSED_GUARD: &str =
    "UPDATE floor_pallets SET disassembled_at = disassembled_at WHERE id = ? AND host_id = ? \
     AND device_id = ? AND shift_id = ? AND NOT EXISTS (SELECT 1 FROM floor_print_jobs j WHERE \
     j.host_id = floor_pallets.host_id AND j.device_id = floor_pallets.device_id AND \
     j.purpose = 'pallet' AND j.subject_id = floor_pallets.id AND (state IN ('prepared', \
     'sending', 'failed', 'unknown') OR (state = 'sent' AND verify = 1)))";
const LAST_PALLET_JOB: &str =
    "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND shift_id = ? \
     AND purpose = 'pallet' AND subject_id = ? ORDER BY rowid DESC LIMIT 1";
const NEWEST_PALLET_JOB_GUARD: &str =
    "UPDATE floor_print_jobs SET state = state WHERE host_id = ? AND device_id = ? AND id = \
     ? AND NOT EXISTS (SELECT 1 FROM floor_print_jobs newer WHERE newer.host_id = ? AND \
     newer.device_id = ? AND newer.shift_id = ? AND newer.purpose = 'pallet' AND \
     newer.subject_id = ? AND newer.rowid > (SELECT rowid FROM floor_print_jobs WHERE id = ?))";
const OPEN_PALLET_GUARD: &str =
    "UPDATE floor_shifts AS s SET local_state = local_state WHERE s.host_id = ? AND \
     s.device_id = ? AND s.id = ? AND NOT EXISTS (SELECT 1 FROM floor_pallets p WHERE \
     p.host_id = s.host_id AND p.device_id = s.device_id AND p.shift_id = s.id AND \
     p.closed_at IS NULL AND EXISTS (SELECT 1 FROM floor_boxes b WHERE b.host_id = \
     p.host_id AND b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at \
     IS NULL))";
const CLOSE_SUMMARY: &str =
    "SELECT s.local_state, (SELECT count(*) FROM floor_codes c WHERE c.host_id = s.host_id \
     AND c.device_id = s.device_id AND c.shift_id = s.id) AS actual, (SELECT count(*) FROM \
     floor_boxes b WHERE b.host_id = s.host_id AND b.device_id = s.device_id AND b.shift_id \
     = s.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed, (SELECT \
     coalesce(sum(b.item_count), 0) FROM floor_boxes b WHERE b.host_id = s.host_id AND \
     b.device_id = s.device_id AND b.shift_id = s.id AND b.closed_at IS NULL) AS \
     open_items, (SELECT count(*) FROM floor_print_jobs j WHERE j.host_id = s.host_id AND \
     j.device_id = s.device_id AND j.shift_id = s.id AND (state IN ('prepared', 'sending', \
     'failed', 'unknown') OR (state = 'sent' AND verify = 1))) AS waiting, (SELECT \
     coalesce(sum((SELECT count(*) FROM floor_boxes b WHERE b.host_id = p.host_id AND \
     b.device_id = p.device_id AND b.pallet_id = p.id AND b.disassembled_at IS NULL)), 0) \
     FROM floor_pallets p WHERE p.host_id = s.host_id AND p.device_id = s.device_id AND \
     p.shift_id = s.id AND p.closed_at IS NULL) AS pallet_boxes FROM floor_shifts s WHERE \
     s.host_id = ? AND s.device_id = ? AND s.id = ?";
const OPEN_JOB_READ: &str =
    "SELECT id, shift_id, purpose, subject_id, sscc, state, verify, template_id, \
     template_rev, fields, printer, bytes_base64, error_code, attempts, operator_id, \
     created_at, updated_at FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND \
     shift_id = ? AND (state IN ('prepared', 'sending', 'failed', 'unknown') OR (state = \
     'sent' AND verify = 1)) ORDER BY created_at, purpose, id LIMIT 1";

/// The work screen's count of a shift's codes (`SHIFT_CODES_SQL`, `src/floor/work/work-reads.ts`),
/// of a validation shift too, whose codes have no box (plan РЕЖ, migration `0014`).
const SHIFT_CODES: &str =
    "SELECT count(*) AS n FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?";

/// A validation shift's refused scans by kind (`VALIDATION_COUNTS_SQL`,
/// `src/floor/work/work-reads.ts`, plan РЕЖ): the work screen reads it after every scan.
const VALIDATION_COUNTS: &str = "SELECT coalesce(sum(verdict = 'duplicate'), 0) AS duplicates, \
     coalesce(sum(verdict IN ('wrong_gtin', 'invalid')), 0) AS errors FROM floor_scans \
     WHERE host_id = ? AND device_id = ? AND shift_id = ?";

/// The reads the floor repeats on every scan and box close search an index
/// instead of reading every row of the pairing (migration `0006`). The plans
/// are those of the SQLite the shell bundles; `test/floor-schema.test.ts`
/// pins the same reads on the Node runtime's SQLite, which is newer.
#[tokio::test]
async fn the_floors_repeating_reads_search_an_index() {
    let (dir, db) = open().await;
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    // (the read, the index its plan must name)
    let reads: [(&str, &str); 105] = [
        (
            "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL ORDER BY seq LIMIT ?",
            "outbox_unsent",
        ),
        // The status bar's three counts (`src/floor/outbox-status.ts`; `test/floor-schema.test.ts`
        // checks the texts agree) and the oldest record not delivered, read while a send fails.
        (
            "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL",
            "outbox_unsent",
        ),
        (
            "SELECT attempts, sent_at, created_at FROM outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL ORDER BY seq LIMIT 1",
            "outbox_unsent (host_id=? AND device_id=?)",
        ),
        // The forget's count, as `src/local_db.rs` writes it.
        (
            "SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",
            "outbox_unsent",
        ),
        (
            "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? \
             AND outcome = 'rejected' AND resolved_at IS NULL",
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (
            "SELECT count(*) AS n FROM outbox WHERE host_id = ? AND device_id = ? \
             AND outcome = 'conflict' AND resolved_at IS NULL",
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        // What the sender writes, in the exact text it runs (`src/local/facts-sender.ts`;
        // `test/floor-schema.test.ts` checks the two texts agree): each statement
        // looks its few records up by their own key. The planner would rather walk
        // the `(host_id, device_id, ...)` prefix of `outbox_unsent`,
        // `floor_scans_shift` or `floor_boxes_shift`, which reads every unsent
        // record, scan and box of the pairing for each batch.
        (
            "UPDATE outbox SET attempts = attempts + 1, sent_at = ? \
             WHERE host_id = ? AND device_id = ? AND id IN (SELECT value FROM json_each(?))",
            "sqlite_autoindex_outbox_1 (id=?)",
        ),
        (
            "UPDATE outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> 'code', \
             outcome_details = r.value -> 'details', acked_at = ? FROM json_each(?) AS r \
             WHERE outbox.id = r.value ->> 'id' AND +outbox.host_id = ? AND +outbox.device_id = ? \
             AND +outbox.acked_at IS NULL",
            "sqlite_autoindex_outbox_1 (id=?)",
        ),
        (
            "UPDATE floor_scans SET conflict = 1 WHERE +host_id = ? AND +device_id = ? AND id IN \
             (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict')",
            "sqlite_autoindex_floor_scans_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 1 WHERE +host_id = ? AND +device_id = ? AND id IN \
             (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict'))",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 1 WHERE +host_id = ? AND +device_id = ? AND id IN \
             (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'conflict'))",
            "sqlite_autoindex_floor_scans_1 (id=?)",
        ),
        // Plan ОЧ: an accepted scan takes its conflict off, and its box's mark once no scan of it
        // is in conflict; each by the records' own key, the box's other scans by its shift.
        (
            "UPDATE floor_scans SET conflict = 0 WHERE +host_id = ? AND +device_id = ? AND conflict = 1 \
             AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')",
            "sqlite_autoindex_floor_scans_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 \
             AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) \
             AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id \
             AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id \
             AND c.box_id = floor_boxes.id AND c.conflict = 1)",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        (
            "UPDATE floor_boxes SET needs_fix = 0 WHERE +host_id = ? AND +device_id = ? AND needs_fix = 1 \
             AND id IN (SELECT box_id FROM floor_scans WHERE +host_id = ? AND +device_id = ? \
             AND box_id IS NOT NULL AND id IN (SELECT value ->> 'id' FROM json_each(?) \
             WHERE value ->> 'kind' = 'scan' AND value ->> 'outcome' = 'accepted')) \
             AND NOT EXISTS (SELECT 1 FROM floor_scans c WHERE c.host_id = floor_boxes.host_id \
             AND c.device_id = floor_boxes.device_id AND c.shift_id = floor_boxes.shift_id \
             AND c.box_id = floor_boxes.id AND c.conflict = 1)",
            "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        // The close a receipt gives its shift (plan 2a8): by the records' own key, not through
        // `outbox_settled`, which holds every settled record of the pairing.
        (
            "UPDATE floor_shifts SET local_state = 'closed' WHERE host_id = ? AND device_id = ? \
             AND local_state = 'closing' AND id IN (SELECT shift_id FROM outbox \
             WHERE +host_id = ? AND +device_id = ? AND kind = 'shift_closed' AND +outcome = 'accepted' \
             AND id IN (SELECT value ->> 'id' FROM json_each(?)))",
            "sqlite_autoindex_outbox_1 (id=?)",
        ),
        (
            "SELECT count(*) FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            SHIFT_CODES,
            "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            VALIDATION_COUNTS,
            "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            "SELECT count(*) FROM floor_boxes WHERE host_id = ? AND device_id = ? \
             AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL",
            "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "SELECT sscc FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ? \
             AND closed_at IS NOT NULL ORDER BY closed_at DESC, serial DESC LIMIT 1",
            "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "SELECT code_hash FROM floor_codes WHERE host_id = ? AND device_id = ? \
             AND box_id = ? ORDER BY code_hash",
            "floor_codes_box (host_id=? AND device_id=? AND box_id=?)",
        ),
        // A box closed whose answer was lost, read back by its own key (`readClosedBox`).
        (
            "SELECT shift_id, sscc, block_id, serial, opened_at, closed_at, item_count, closed_by \
             FROM floor_boxes WHERE id = ? AND host_id = ? AND device_id = ? \
             AND closed_at IS NOT NULL",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        // The scan pipeline's own reads and its one UPDATE, on every scan: the
        // station's registry of a code, the open box of a shift, and the open
        // box's count by the box's own key.
        (
            "SELECT scanned_at FROM floor_codes WHERE host_id = ? AND device_id = ? \
             AND code_hash = ?",
            "sqlite_autoindex_floor_codes_1 (host_id=? AND device_id=? AND code_hash=?)",
        ),
        (
            "SELECT id, opened_at, item_count FROM floor_boxes WHERE host_id = ? \
             AND device_id = ? AND shift_id = ? AND closed_at IS NULL",
            "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "UPDATE floor_boxes SET item_count = item_count + 1 \
             WHERE id = ? AND host_id = ? AND device_id = ? AND closed_at IS NULL",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        // The close of a box: the next serial of the earliest block with room, whether
        // a box already holds the SSCC, the cursor's compare-and-set by the block's key
        // and the box's own close by its key.
        (
            "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? \
             AND device_id = ? AND issuer_prefix = ? AND extension = ? \
             AND next_serial <= to_serial ORDER BY from_serial, block_id LIMIT 1",
            "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
        ),
        (
            "SELECT 1 AS n FROM floor_boxes WHERE sscc = ? LIMIT 1",
            "floor_boxes_sscc (sscc=?)",
        ),
        (
            "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 \
             WHERE block_id = ? AND next_serial = ?",
            "sqlite_autoindex_floor_sscc_blocks_1 (block_id=?)",
        ),
        (
            "UPDATE floor_boxes SET closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
             closed_by = ? WHERE id = ? AND host_id = ? AND device_id = ? \
             AND closed_at IS NULL AND item_count = ?",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        // The supply of SSCC blocks: the newest block of the prefix (the half rule), the
        // serials the pairing has left (the status bar), whether a block shares serials
        // with one kept, and a request's removal by its key.
        (
            "SELECT from_serial, to_serial, next_serial FROM floor_sscc_blocks WHERE host_id = ? \
             AND device_id = ? AND issuer_prefix = ? AND extension = ? \
             ORDER BY from_serial DESC LIMIT 1",
            "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
        ),
        (
            "SELECT next_serial, to_serial FROM floor_sscc_blocks \
             WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? \
             AND next_serial <= to_serial",
            "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
        ),
        (
            "SELECT snapshot ->> 'issuerPrefix' AS prefix, pallets_enabled, mode FROM floor_shifts \
             WHERE host_id = ? AND device_id = ? AND id = ?",
            "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
        ),
        (
            "SELECT 1 AS n FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? \
             AND issuer_prefix = ? AND extension = ? AND block_id <> ? \
             AND from_serial <= ? AND to_serial >= ? LIMIT 1",
            "floor_sscc_blocks_prefix (host_id=? AND device_id=? AND issuer_prefix=? AND extension=?)",
        ),
        (
            "DELETE FROM floor_block_requests WHERE request_id = ?",
            "sqlite_autoindex_floor_block_requests_1 (request_id=?)",
        ),
        // The blocks the station did not take (migration `0013`, plan ОЧ): a pairing's rows by
        // the table's key (`test/floor-schema.test.ts` pins the same text).
        (
            "SELECT count(*) AS n FROM floor_block_drops WHERE host_id = ? AND device_id = ?",
            "sqlite_autoindex_floor_block_drops_1 (host_id=? AND device_id=?)",
        ),
        // The box exceptions (`src/floor/exceptions/box-exceptions.ts`; `test/floor-schema.test.ts`
        // checks the texts agree): the last code of the open box and the newest scan
        // among its codes search the box's own codes, the closed boxes of a shift the
        // shift's index, a box is read by its key and its newest print job through the
        // shift's jobs.
        (
            "SELECT code_hash, scan_id, scanned_at FROM floor_codes \
             WHERE host_id = ? AND device_id = ? AND box_id = ? ORDER BY rowid DESC LIMIT 1",
            "floor_codes_box (host_id=? AND device_id=? AND box_id=?)",
        ),
        (
            "SELECT max(scanned_at) AS scanned_at FROM floor_codes \
             WHERE host_id = ? AND device_id = ? AND box_id = ?",
            "floor_codes_box (host_id=? AND device_id=? AND box_id=?)",
        ),
        (
            "SELECT id, sscc, item_count, closed_at FROM floor_boxes WHERE host_id = ? AND device_id = ? \
             AND shift_id = ? AND closed_at IS NOT NULL AND disassembled_at IS NULL \
             ORDER BY closed_at DESC, serial DESC",
            "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "SELECT closed_at, disassembled_at, (SELECT count(*) FROM floor_codes c \
             WHERE c.host_id = b.host_id AND c.device_id = b.device_id AND c.box_id = b.id) AS codes \
             FROM floor_boxes b WHERE b.id = ? AND b.host_id = ? AND b.device_id = ? AND b.shift_id = ?",
            "sqlite_autoindex_floor_boxes_1 (id=?)",
        ),
        (
            "SELECT id FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND shift_id = ? \
             AND purpose = 'box' AND subject_id = ? ORDER BY rowid DESC LIMIT 1",
            "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            "SELECT id FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_scans_shift",
        ),
        (
            "SELECT id FROM floor_shifts WHERE host_id = ? AND device_id = ? AND line_id = ?",
            "floor_shifts_line",
        ),
        // The guard every outbox write carries (`outboxStatement`, `src/floor/facts.ts`; plan
        // 2a8): has this pairing closed the shift? The subquery of `INSERT INTO outbox …
        // SELECT … WHERE NOT EXISTS (…)` runs on every scan; `test/floor-schema.test.ts`
        // plans the statement itself.
        (
            "SELECT 1 FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ? \
             AND local_state IS NOT NULL",
            "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
        ),
        // The retention pass (plan 2a8), once an hour: the due select walks the settled records
        // once (pinned after the loop) and searches each close's shift — its unsent records
        // through `outbox_shift` (migration `0010`, plan ХП), its jobs, its copy by its key; the
        // delete of a copy searches the one shift's close and unsent records through
        // `outbox_shift`. Every delete of a shift's rows searches an index by shift.
        (DUE_SHIFTS, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (
            DUE_SHIFTS,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
        ),
        // The shift's unresolved refusals (plan ОЧ): its own records through `outbox_shift`.
        (DUE_SHIFTS, "SEARCH r USING INDEX outbox_shift (shift_id=? AND host_id=? AND device_id=?)"),
        (DUE_SHIFTS, "outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        (DUE_SHIFTS, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
        // An unresolved unit label keeps its shift (plan РЕЖ part B): the pairing's one, through
        // the unique partial index (`INDEXED BY`).
        (
            DUE_SHIFTS,
            "floor_unit_labels_unresolved (host_id=? AND device_id=?)",
        ),
        (PURGE_COPY, "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)"),
        (
            PURGE_COPY,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at<?)",
        ),
        (
            PURGE_COPY,
            "outbox_shift (shift_id=? AND host_id=? AND device_id=? AND acked_at=?)",
        ),
        (
            PURGE_COPY,
            "SEARCH r USING INDEX outbox_shift (shift_id=? AND host_id=? AND device_id=?)",
        ),
        (PURGE_COPY, "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)"),
        (
            PURGE_COPY,
            "floor_unit_labels_unresolved (host_id=? AND device_id=?)",
        ),
        (REFUSED_CLOSES, "outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        (
            "DELETE FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_scans_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM floor_print_jobs WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM floor_boxes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_boxes_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM floor_pallets WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        (
            "DELETE FROM outbox WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "outbox_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
        (
            "DELETE FROM floor_exceptions WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
        (
            "DELETE FROM floor_pallet_exceptions WHERE host_id = ? AND device_id = ? \
             AND shift_id = ?",
            "floor_pallet_exceptions_shift (shift_id=? AND host_id=? AND device_id=?",
        ),
        (
            "DELETE FROM floor_unit_labels WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_unit_labels_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        // The pallets (plan ПЛ-Ц): the open pallet and its two counts on every box close and render,
        // a pallet's close and a box joining it by their keys, the shift close's check and summary,
        // and the label queue's read through the shift's jobs.
        (
            OPEN_PALLET,
            "floor_pallets_open (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (OPEN_PALLET, "floor_boxes_pallet (pallet_id=?)"),
        (CLOSE_PALLET, "sqlite_autoindex_floor_pallets_1 (id=?)"),
        (CLOSE_PALLET, "floor_boxes_pallet (pallet_id=?)"),
        (JOIN_PALLET, "sqlite_autoindex_floor_pallets_1 (id=?)"),
        (BOX_ONTO_PALLET, "sqlite_autoindex_floor_boxes_1 (id=?)"),
        (PALLET_SSCC_HELD, "floor_pallets_sscc (sscc=?)"),
        (
            OPEN_PALLET_GUARD,
            "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
        ),
        (
            OPEN_PALLET_GUARD,
            "floor_pallets_open (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (OPEN_PALLET_GUARD, "floor_boxes_pallet (pallet_id=?)"),
        (
            CLOSE_SUMMARY,
            "sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?)",
        ),
        (
            CLOSE_SUMMARY,
            "floor_pallets_open (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (CLOSE_SUMMARY, "floor_boxes_pallet (pallet_id=?)"),
        (
            OPEN_JOB_READ,
            "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            CLOSED_PALLETS,
            "floor_pallets_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (CLOSED_PALLETS, "floor_boxes_pallet (pallet_id=?)"),
        (PALLET_STATE, "sqlite_autoindex_floor_pallets_1 (id=?)"),
        (PALLET_STATE, "floor_boxes_pallet (pallet_id=?)"),
        (DISASSEMBLE_PALLET, "sqlite_autoindex_floor_pallets_1 (id=?)"),
        (PALLET_LIVE_GUARD, "sqlite_autoindex_floor_pallets_1 (id=?)"),
        (
            PALLET_LABEL_CLOSED_GUARD,
            "sqlite_autoindex_floor_pallets_1 (id=?)",
        ),
        (
            PALLET_LABEL_CLOSED_GUARD,
            "floor_print_jobs_open (host_id=? AND device_id=? AND purpose=? AND subject_id=?)",
        ),
        (
            LAST_PALLET_JOB,
            "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            NEWEST_PALLET_JOB_GUARD,
            "sqlite_autoindex_floor_print_jobs_1 (id=?)",
        ),
        (
            NEWEST_PALLET_JOB_GUARD,
            "floor_print_jobs_shift (host_id=? AND device_id=? AND shift_id=?",
        ),
        // What a station owes a restored host (plan РК-С): the obligation and its status by the
        // pairing's own key, the blocks and the retired ones through the pairing's blocks, the
        // records to send again through the settled ones (not the whole outbox).
        (
            RESTORE_DUE,
            "sqlite_autoindex_floor_restore_epochs_1 (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_STATUS,
            "sqlite_autoindex_floor_restore_epochs_1 (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_SETTLE,
            "sqlite_autoindex_floor_restore_epochs_1 (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_RECONCILED_AT,
            "sqlite_autoindex_floor_restore_epochs_1 (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_BLOCKS,
            "floor_sscc_blocks_prefix (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_RETIRE,
            "floor_sscc_blocks_prefix (host_id=? AND device_id=?)",
        ),
        (
            RESTORE_REOPEN,
            "outbox_settled (host_id=? AND device_id=? AND outcome>?)",
        ),
        (
            RESTORE_REOPEN_WAREHOUSE,
            "wh_outbox_accepted (host_id=? AND device_id=? AND acked_at>?)",
        ),
        // The queue screen (plan ОЧ): read on opening, written on a person's press;
        // `test/floor-schema.test.ts` checks the texts agree.
        (
            QUEUE_UNSENT,
            "outbox_unsent (host_id=? AND device_id=?)",
        ),
        (
            QUEUE_TALLY,
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (
            QUEUE_DISMISS_SHIFT,
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (
            QUEUE_RESEND_READ,
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (QUEUE_RESEND_INSERT, "sqlite_autoindex_outbox_1 (id=?)"),
        (QUEUE_RESEND_MARK, "sqlite_autoindex_outbox_1 (id=?)"),
        (QUEUE_DISMISS, "sqlite_autoindex_outbox_1 (id=?)"),
    ];
    for (sql, index) in reads {
        let placeholders = sql.matches('?').count();
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..placeholders {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert!(
            plan.iter().any(|step| step.contains(index)),
            "{sql}\n  should search {index}, its plan is {plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN ")
                && !step.contains("json_each")
                && !step.starts_with("SCAN r ")),
            "{sql}\n  scans a table: {plan:?}"
        );
        // The retention asks the pairing's one unresolved unit label, never a walk of the
        // shift's jobs.
        if sql == DUE_SHIFTS || sql == PURGE_COPY {
            assert!(
                !plan
                    .iter()
                    .any(|step| step.contains("floor_unit_labels_shift")),
                "{sql}\n  walks the shift's unit labels: {plan:?}"
            );
        }
    }
    // The hourly due select starts from the accepted closes: it walks `outbox_settled` once, as
    // its first step, and everything else is a search per close it found (the unsent records,
    // the shift's jobs, the shift's copy). Asking per copy instead walked the pairing's
    // accepted records once for every shift (6.5 s at 600 000 rows, 70 shifts); the only
    // temporary structure allowed is the one for its `DISTINCT`.
    let text = format!("EXPLAIN QUERY PLAN {DUE_SHIFTS}");
    let mut explain = sqlx::query(&text);
    for _ in 0..DUE_SHIFTS.matches('?').count() {
        explain = explain.bind("x");
    }
    let plan: Vec<String> = explain
        .fetch_all(&mut raw)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
    assert_eq!(
        plan.first().map(String::as_str),
        Some("SEARCH o USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        "the due select should start from the settled records, its plan is {plan:?}"
    );
    assert_eq!(
        plan.iter()
            .filter(|step| step.contains("outbox_settled"))
            .count(),
        1,
        "the due select should walk the settled records once, its plan is {plan:?}"
    );
    let temporary: Vec<&String> = plan.iter().filter(|step| step.contains("TEMP")).collect();
    assert_eq!(
        temporary,
        ["USE TEMP B-TREE FOR DISTINCT"],
        "its plan is {plan:?}"
    );
    // The refused closes are read through `outbox_settled` in `seq` order with no sort of their own.
    let text = format!("EXPLAIN QUERY PLAN {REFUSED_CLOSES}");
    let mut explain = sqlx::query(&text);
    for _ in 0..REFUSED_CLOSES.matches('?').count() {
        explain = explain.bind("x");
    }
    let plan: Vec<String> = explain
        .fetch_all(&mut raw)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
    assert_eq!(
        plan.first().map(String::as_str),
        Some("SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)"),
        "the refused closes should be read from the settled records, its plan is {plan:?}"
    );
    assert!(
        !plan.iter().any(|step| step.contains("TEMP")),
        "the refused closes should need no sort, its plan is {plan:?}"
    );
    // The queue screen's count of the records older pairings left: the only walk of the screen,
    // over the unsent records of every pairing in their partial index, never the whole outbox.
    let text = format!("EXPLAIN QUERY PLAN {QUEUE_STRANDED}");
    let mut explain = sqlx::query(&text);
    for _ in 0..QUEUE_STRANDED.matches('?').count() {
        explain = explain.bind("x");
    }
    let plan: Vec<String> = explain
        .fetch_all(&mut raw)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
    assert_eq!(
        plan,
        ["SCAN outbox USING INDEX outbox_unsent"],
        "the stranded count should walk the unsent records only, its plan is {plan:?}"
    );
    // The queue screen's bounded list (the final review's I-1): the pairing's unresolved refused
    // and conflicting records from their partial index, numbered per shift and outcome in one
    // sort; its only walks are over the numbered rows, and only the rows within the bound are
    // looked up by `seq` and joined.
    let text = format!("EXPLAIN QUERY PLAN {QUEUE_SETTLED}");
    let mut explain = sqlx::query(&text);
    for _ in 0..QUEUE_SETTLED.matches('?').count() {
        explain = explain.bind("x");
    }
    let plan: Vec<String> = explain
        .fetch_all(&mut raw)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
    assert_eq!(
        plan,
        [
            "CO-ROUTINE f",
            "CO-ROUTINE (subquery-3)",
            "SEARCH outbox USING INDEX outbox_settled (host_id=? AND device_id=? AND outcome=?)",
            "USE TEMP B-TREE FOR ORDER BY",
            "SCAN (subquery-3)",
            "SCAN f",
            "SEARCH o USING INTEGER PRIMARY KEY (rowid=?)",
            "SEARCH s USING INDEX sqlite_autoindex_floor_shifts_1 (host_id=? AND device_id=? AND id=?) LEFT-JOIN",
            "SEARCH b USING INDEX sqlite_autoindex_floor_boxes_1 (id=?) LEFT-JOIN",
            "SEARCH p USING INDEX sqlite_autoindex_floor_pallets_1 (id=?) LEFT-JOIN",
        ],
        "the bounded list should number the settled records only, its plan is {plan:?}"
    );
    // The one read of the floor that names no index: a pairing's waiting block
    // requests. The table holds at most one row per pairing and issuer prefix
    // (a request is kept only when none waits, and goes with its block), so the
    // read takes the whole table, and no other.
    let waiting = "SELECT request_id, issuer_prefix, extension FROM floor_block_requests \
                   WHERE host_id = ? AND device_id = ? AND issuer_prefix = ? AND extension = ? \
                   ORDER BY requested_at, request_id LIMIT 1";
    let text = format!("EXPLAIN QUERY PLAN {waiting}");
    let mut explain = sqlx::query(&text);
    for _ in 0..waiting.matches('?').count() {
        explain = explain.bind("x");
    }
    let plan: Vec<String> = explain
        .fetch_all(&mut raw)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect();
    let scans: Vec<&String> = plan
        .iter()
        .filter(|step| step.starts_with("SCAN "))
        .collect();
    assert_eq!(
        scans,
        ["SCAN floor_block_requests"],
        "{waiting}\n  should scan only the waiting requests, its plan is {plan:?}"
    );
    raw.close().await.unwrap();
}

/// The count and the clear are one transaction: a record that arrives while
/// the forget waits for the write lock is counted, not wiped. The test holds
/// the write lock on a second connection, lets the forget start waiting for
/// it, commits an unsent record, and the forget must then see the record.
///
/// SQLite reports no "waiting on the lock" event, so the test waits a fixed
/// second (the busy timeout is 5 s) for the forget to reach the lock: it is a
/// detector of a count made outside the transaction only under that margin.
/// If the spawned forget needed longer than a second to start, a wrong
/// implementation would pass vacuously; correct code can never fail here.
/// The multi-thread runtime keeps the forget's task from being starved by
/// this one while it sleeps.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_arriving_while_a_forget_waits_is_counted_not_wiped() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut raw)
        .await
        .unwrap();

    let db = std::sync::Arc::new(db);
    let forget = tokio::spawn({
        let db = std::sync::Arc::clone(&db);
        async move { db.clear_copies(UnsentGuard::Pairing(HOST, DEVICE)).await }
    });
    // The forget is blocked on the write lock for as long as this holds it
    // (the busy timeout is 5 s).
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    assert!(!forget.is_finished(), "the forget waits for the write lock");
    sqlx::query(&outbox_sql("late", HOST, DEVICE, None))
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("COMMIT").execute(&mut raw).await.unwrap();
    raw.close().await.unwrap();

    let result = tokio::time::timeout(std::time::Duration::from_secs(10), forget)
        .await
        .expect("the forget ends once the lock is free")
        .unwrap();
    assert_eq!(result, Err(LocalDbError::UnsentRecords { count: 1 }));
    assert_eq!(count(&db, "ref_lines").await, json!(1), "nothing cleared");
    assert_eq!(count(&db, "outbox").await, json!(1));
}

/// The checkpoint that ends a forget must finish, or the forget fails: a
/// reader holding an older snapshot keeps the pre-delete frames, with their
/// PIN and badge hashes, in the WAL. The delete is committed by then, and a
/// retry once the reader is gone succeeds. Costs one busy timeout (5 s).
#[tokio::test]
async fn a_forget_fails_while_a_reader_keeps_the_wal_and_succeeds_after() {
    let (dir, db) = open().await;
    db.transaction(vec![statement(
        INSERT_LINE,
        json!([LINE_1, "Линия 1", 0, 3]),
    )])
    .await
    .unwrap();
    let mut reader = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    sqlx::query("BEGIN").execute(&mut reader).await.unwrap();
    sqlx::query("SELECT count(*) FROM ref_lines")
        .fetch_one(&mut reader)
        .await
        .unwrap();

    let first = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        db.clear_copies(UnsentGuard::Ignore),
    )
    .await
    .expect("the checkpoint gives up after the busy timeout");
    assert_eq!(first, Err(LocalDbError::StatementFailed));
    assert_eq!(count(&db, "ref_lines").await, json!(0), "the delete stays");

    sqlx::query("COMMIT").execute(&mut reader).await.unwrap();
    reader.close().await.unwrap();
    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));
}

/// No table of the migrations has a foreign key. The writer enforces them
/// (`foreign_keys(true)`), and a forget deletes table by table: a plain key
/// between tables fails the `DELETE` that breaks it, and `ON DELETE CASCADE`
/// or `SET NULL` from a table the forget keeps to one it empties would delete
/// or rewrite this device's own records without a word. The rule is read from
/// the real, migrated schema, so a migration that adds a key fails here.
#[tokio::test]
async fn no_table_has_a_foreign_key() {
    let (_dir, db) = open().await;
    let keys = db
        .query(
            "SELECT t.name AS child, fk.\"table\" AS parent, fk.on_delete AS on_delete \
             FROM pragma_table_list t, pragma_foreign_key_list(t.name) fk \
             WHERE t.schema = 'main' AND t.type = 'table' ORDER BY t.name, fk.id",
            vec![],
        )
        .await
        .unwrap();
    let described: Vec<String> = keys
        .iter()
        .map(|key| {
            format!(
                "{} -> {} (ON DELETE {})",
                key["child"], key["parent"], key["on_delete"]
            )
        })
        .collect();
    assert!(
        described.is_empty(),
        "foreign keys are not allowed between local tables: {described:?}; see TABLE_CLASSES in local_db.rs"
    );
}

/// The files of a database that did not open: a file of garbage where the
/// database belongs, and the given side files written after the failed open
/// (see `unopened_database` in `tests/ipc.rs` for why after).
async fn unopened(dir: &std::path::Path, beside: &[&str]) -> LocalDbState {
    std::fs::write(dir.join(FILE_NAME), "not a database").unwrap();
    let local = LocalDbState::open(dir).await;
    assert!(local.get().is_err(), "a file of garbage does not open");
    for suffix in beside {
        std::fs::write(dir.join(format!("{FILE_NAME}{suffix}")), "not a database").unwrap();
    }
    local
}

/// `std::fs::rename`, tried for up to 5 s: on Windows sqlx closes the handle
/// of a failed open on its own thread after the open returned, and a file
/// SQLite holds does not move until then.
fn rename_once_released(from: &std::path::Path, to: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => panic!("{} does not move: {error}", from.display()),
        }
    }
}

/// On Windows a database file held the way SQLite holds it (read and write
/// shared, delete not) cannot move until the handle closes: the set-aside
/// waits for it instead of failing at once.
#[cfg(windows)]
#[tokio::test]
async fn a_set_aside_waits_for_a_handle_that_still_holds_the_database() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    let held = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(dir.path().join(FILE_NAME))
        .unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        drop(held);
    });

    let aside = local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .unwrap();
    release.join().unwrap();

    assert_eq!(
        aside,
        Some(
            dir.path()
                .join(format!("{FILE_NAME}.unreadable-1790000000000"))
        )
    );
    assert!(local.get().is_ok(), "a new database opened in its place");
}

/// A move the system refuses for a moment is tried again: here a folder that
/// cannot be written to until a thread makes it writable again, 300 ms on.
#[cfg(unix)]
#[tokio::test]
async fn a_set_aside_tries_a_refused_move_again() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let folder = dir.path().to_path_buf();
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    });

    let aside = local.set_aside_unopened_at(1_790_000_000_000).await;
    release.join().unwrap();

    assert_eq!(
        aside.unwrap(),
        Some(
            dir.path()
                .join(format!("{FILE_NAME}.unreadable-1790000000000"))
        )
    );
    assert!(local.get().is_ok(), "a new database opened in its place");
}

/// A database that did not open is moved aside with its side files, nothing
/// deleted, and a new one opens in its place (stage 2a spec §5.2, question
/// В7).
#[tokio::test]
async fn an_unopened_database_is_set_aside_and_a_new_one_opens() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &["-wal", "-shm"]).await;

    let aside = local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .unwrap();

    let aside_name = format!("{FILE_NAME}.unreadable-1790000000000");
    assert_eq!(aside, Some(dir.path().join(&aside_name)));
    for suffix in ["", "-wal", "-shm"] {
        let kept = dir.path().join(format!("{aside_name}{suffix}"));
        assert_eq!(std::fs::read_to_string(&kept).unwrap(), "not a database");
    }
    assert!(!dir.path().join(format!("{aside_name}-journal")).exists());
    let db = local.get().expect("a new database opened in its place");
    assert_eq!(count(db, "ref_lines").await, json!(0));
    // Once open, there is nothing more to move aside.
    assert_eq!(
        local
            .set_aside_unopened_at(1_790_000_000_001)
            .await
            .unwrap(),
        None
    );
}

/// A file that cannot be moved aside puts back the ones already moved: the
/// database never loses its WAL to a half-done move, and no new database
/// opens over it. A non-empty directory already standing at the WAL's new
/// name stops that one move.
#[tokio::test]
async fn a_file_that_cannot_be_set_aside_puts_the_others_back() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &["-wal"]).await;
    let blocked = dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000000-wal"));
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(blocked.join("kept"), "kept").unwrap();

    assert!(local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .is_err());

    for suffix in ["", "-wal"] {
        let file = dir.path().join(format!("{FILE_NAME}{suffix}"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a database");
    }
    assert!(!dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000000"))
        .exists());
    assert_eq!(
        std::fs::read_to_string(blocked.join("kept")).unwrap(),
        "kept"
    );
    assert!(local.get().is_err(), "no new database over the old files");
}

/// What an earlier set-aside kept is never replaced by a later one that
/// happens to carry the same time stamp: `std::fs::rename` replaces an
/// existing file on Unix and on Windows alike.
#[tokio::test]
async fn an_earlier_set_aside_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    let earlier = dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000000"));
    std::fs::write(&earlier, "the earlier one").unwrap();

    assert!(local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .is_err());

    assert_eq!(
        std::fs::read_to_string(&earlier).unwrap(),
        "the earlier one"
    );
    let file = dir.path().join(FILE_NAME);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a database");
}

/// Whether the file at `path` holds `marker` anywhere; a missing file holds nothing.
fn file_holds(path: &std::path::Path, marker: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| {
        bytes
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    })
}

/// Forgetting a device leaves none of its PIN and badge hashes on disk:
/// `secure_delete` zeroes a deleted row where it stood, and the checkpoint
/// after `clear_copies` moves those pages into the file and empties the WAL,
/// which still held the frames written before the delete. One marker is
/// checkpointed into the file before the clear, the other is only in the WAL.
#[tokio::test]
async fn clearing_the_copies_leaves_no_deleted_hash_in_the_file_or_its_wal() {
    const IN_FILE: &str = "pbkdf2$sha256$100000$marker-in-the-database-file";
    const IN_WAL: &str = "pbkdf2$sha256$100000$marker-only-in-the-wal";
    const BADGE: &str = "INSERT INTO ref_operator_badges (id, operator_id, badge_phc, label, rev) \
        VALUES (?, 'operator-1', ?, NULL, 1)";
    let (dir, db) = open().await;
    let file = dir.path().join(FILE_NAME);
    let wal = dir.path().join(format!("{FILE_NAME}-wal"));
    db.transaction(vec![statement(BADGE, json!(["badge-1", IN_FILE]))])
        .await
        .unwrap();
    let mut raw = SqliteConnectOptions::new()
        .filename(&file)
        .connect()
        .await
        .unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
    db.transaction(vec![statement(BADGE, json!(["badge-2", IN_WAL]))])
        .await
        .unwrap();
    assert!(
        file_holds(&file, IN_FILE),
        "the first marker is in the file"
    );
    assert!(file_holds(&wal, IN_WAL), "the second marker is in the WAL");

    assert_eq!(db.clear_copies(UnsentGuard::Ignore).await, Ok(()));

    for marker in [IN_FILE, IN_WAL] {
        assert!(!file_holds(&file, marker), "{marker} stayed in the file");
        assert!(!file_holds(&wal, marker), "{marker} stayed in the WAL");
    }
}

/// A migrated database file built on a plain connection (rollback journal, so
/// the file stands alone), with `statements` run on it afterwards.
async fn database_file(dir: &std::path::Path, statements: &[&str]) {
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    MIGRATOR.run(&mut raw).await.unwrap();
    for sql in statements {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
}

/// Overwrites the page of `_sqlx_migrations` with bytes no b-tree page has:
/// the database still lists its tables and still reads `outbox`, but opening
/// it (the migrations read that table) fails with `SQLITE_CORRUPT`.
async fn corrupt_the_migrations_table(dir: &std::path::Path) {
    let path = dir.join(FILE_NAME);
    let mut raw = SqliteConnectOptions::new()
        .filename(&path)
        .connect()
        .await
        .unwrap();
    let (root, size): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rootpage FROM sqlite_master WHERE name = '_sqlx_migrations'), \
                (SELECT page_size FROM pragma_page_size)",
    )
    .fetch_one(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    let start = usize::try_from((root - 1) * size).unwrap();
    bytes[start..start + usize::try_from(size).unwrap()].fill(0xff);
    std::fs::write(&path, bytes).unwrap();
}

/// Why a database did not open decides what a forget may do with it: only a
/// corrupt file may be set aside (stage 2a spec §5.2, question В7). Every
/// other failure — a newer app version's migration, a changed checksum, a
/// directory that is a file — leaves a database that may be perfectly fine
/// and must stay where it is.
#[tokio::test]
async fn only_a_corrupt_file_is_recorded_as_corrupt() {
    let opened = tempfile::tempdir().unwrap();
    let local = LocalDbState::open(opened.path()).await;
    assert!(local.get().is_ok());
    assert_eq!(local.open_failure(), None);
    assert_eq!(LocalDbState::unavailable().open_failure(), None);

    let garbage = tempfile::tempdir().unwrap();
    let local = unopened(garbage.path(), &[]).await;
    assert_eq!(local.open_failure(), Some(OpenFailure::Corrupt));

    let broken = tempfile::tempdir().unwrap();
    database_file(broken.path(), &[]).await;
    corrupt_the_migrations_table(broken.path()).await;
    let local = LocalDbState::open(broken.path()).await;
    assert!(local.get().is_err());
    assert_eq!(local.open_failure(), Some(OpenFailure::Corrupt));

    let newer = tempfile::tempdir().unwrap();
    database_file(
        newer.path(),
        &[
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, \
           execution_time) VALUES (9999, 'newer', 1, x'00', 0)",
        ],
    )
    .await;
    let local = LocalDbState::open(newer.path()).await;
    assert!(local.get().is_err());
    assert_eq!(local.open_failure(), Some(OpenFailure::Other));

    let changed = tempfile::tempdir().unwrap();
    database_file(
        changed.path(),
        &["UPDATE _sqlx_migrations SET checksum = x'00' WHERE version = 1"],
    )
    .await;
    let local = LocalDbState::open(changed.path()).await;
    assert!(local.get().is_err());
    assert_eq!(local.open_failure(), Some(OpenFailure::Other));

    // A "directory" that is a file: the open fails on the file system.
    let parent = tempfile::tempdir().unwrap();
    let not_a_directory = parent.path().join("file");
    std::fs::write(&not_a_directory, "").unwrap();
    let local = LocalDbState::open(&not_a_directory).await;
    assert!(local.get().is_err());
    assert_eq!(local.open_failure(), Some(OpenFailure::Other));
}

/// A database set aside leaves a new one in its place; the failure recorded
/// for the old file is gone with it.
#[tokio::test]
async fn setting_a_corrupt_database_aside_clears_its_recorded_failure() {
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    assert_eq!(local.open_failure(), Some(OpenFailure::Corrupt));
    local
        .set_aside_unopened_at(1_790_000_000_000)
        .await
        .unwrap();
    assert!(local.get().is_ok());
    assert_eq!(local.open_failure(), None);
}

/// A corrupt database that can still be read is counted on a read-only
/// connection, without migrations and without changing the file: the same
/// records as `UnsentGuard` protects in an open one. A file nothing can be
/// read from has none to protect; an outbox that exists but cannot be counted
/// is an error, never 0.
#[tokio::test]
async fn a_database_that_did_not_open_is_counted_without_being_changed() {
    let dir = tempfile::tempdir().unwrap();
    let mine = outbox_sql("a", HOST, DEVICE, None);
    let other_device = outbox_sql("b", HOST, OTHER_DEVICE, None);
    let sent = outbox_sql("c", HOST, DEVICE, Some("2026-10-09T08:00:00.000Z"));
    database_file(dir.path(), &[&mine, &other_device, &sent]).await;
    corrupt_the_migrations_table(dir.path()).await;
    let local = LocalDbState::open(dir.path()).await;
    assert_eq!(local.open_failure(), Some(OpenFailure::Corrupt));
    let before = std::fs::read(dir.path().join(FILE_NAME)).unwrap();

    assert_eq!(
        local
            .unopened_unsent_records(UnsentGuard::Pairing(HOST, DEVICE))
            .await,
        Ok(1)
    );
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::AnyPairing).await,
        Ok(2)
    );
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::Ignore).await,
        Ok(0)
    );
    assert_eq!(
        std::fs::read(dir.path().join(FILE_NAME)).unwrap(),
        before,
        "the file is read, not written"
    );

    // Nothing can be read from a file of garbage, from no file and from no
    // directory: there is no record anyone could send.
    let garbage = tempfile::tempdir().unwrap();
    let local = unopened(garbage.path(), &[]).await;
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::AnyPairing).await,
        Ok(0)
    );
    assert_eq!(
        LocalDbState::unavailable()
            .unopened_unsent_records(UnsentGuard::AnyPairing)
            .await,
        Ok(0)
    );

    // Readable, but with no outbox (a database an older build left): nothing
    // to protect.
    let bare = tempfile::tempdir().unwrap();
    database_file(bare.path(), &["DROP TABLE outbox"]).await;
    corrupt_the_migrations_table(bare.path()).await;
    let local = LocalDbState::open(bare.path()).await;
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::AnyPairing).await,
        Ok(0)
    );

    // An outbox without the columns a forget reads cannot be counted.
    let unreadable = tempfile::tempdir().unwrap();
    database_file(
        unreadable.path(),
        &[
            "DROP TABLE outbox",
            "CREATE TABLE outbox (id TEXT PRIMARY KEY)",
        ],
    )
    .await;
    corrupt_the_migrations_table(unreadable.path()).await;
    let local = LocalDbState::open(unreadable.path()).await;
    for guard in [UnsentGuard::Pairing(HOST, DEVICE), UnsentGuard::AnyPairing] {
        assert_eq!(
            local.unopened_unsent_records(guard).await,
            Err(LocalDbError::StatementFailed)
        );
    }
}

/// The warehouse reprint's unsent records of a database that did not open are
/// counted with the facts (plan СКЛ task 6), on a read-only connection: a
/// database an older build left, without `wh_outbox`, counts its `outbox` only;
/// a `wh_outbox` that exists and cannot be counted is an error, never 0.
#[tokio::test]
async fn an_unopened_database_counts_its_warehouse_records_too() {
    let dir = tempfile::tempdir().unwrap();
    database_file(
        dir.path(),
        &[
            &outbox_sql("a", HOST, DEVICE, None),
            "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at) \
             VALUES ('w1', 'h', 'd', 's', '{}', '2026-10-09T08:00:00.000Z')",
            &format!(
                "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at) \
                 VALUES ('w2', '{HOST}', '{DEVICE}', 's', '{{}}', '2026-10-09T08:00:00.000Z')"
            ),
            &format!(
                "INSERT INTO wh_outbox (id, host_id, device_id, session_id, payload, created_at, \
                 outcome, acked_at) VALUES ('w3', '{HOST}', '{DEVICE}', 's', '{{}}', \
                 '2026-10-09T08:00:00.000Z', 'rejected', '2026-10-09T08:00:01.000Z')"
            ),
        ],
    )
    .await;
    corrupt_the_migrations_table(dir.path()).await;
    let local = LocalDbState::open(dir.path()).await;
    assert_eq!(local.open_failure(), Some(OpenFailure::Corrupt));
    assert_eq!(
        local
            .unopened_unsent_records(UnsentGuard::Pairing(HOST, DEVICE))
            .await,
        Ok(2),
        "one fact and one unsent reprint record; the answered one and the other pairing's do not"
    );
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::AnyPairing).await,
        Ok(3)
    );
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::Ignore).await,
        Ok(0)
    );

    let older = tempfile::tempdir().unwrap();
    database_file(
        older.path(),
        &[&outbox_sql("a", HOST, DEVICE, None), "DROP TABLE wh_outbox"],
    )
    .await;
    corrupt_the_migrations_table(older.path()).await;
    let local = LocalDbState::open(older.path()).await;
    assert_eq!(
        local.unopened_unsent_records(UnsentGuard::AnyPairing).await,
        Ok(1),
        "no wh_outbox: the outbox alone"
    );

    let unreadable = tempfile::tempdir().unwrap();
    database_file(
        unreadable.path(),
        &[
            "DROP TABLE wh_outbox",
            "CREATE TABLE wh_outbox (id TEXT PRIMARY KEY)",
        ],
    )
    .await;
    corrupt_the_migrations_table(unreadable.path()).await;
    let local = LocalDbState::open(unreadable.path()).await;
    for guard in [UnsentGuard::Pairing(HOST, DEVICE), UnsentGuard::AnyPairing] {
        assert_eq!(
            local.unopened_unsent_records(guard).await,
            Err(LocalDbError::StatementFailed)
        );
    }
}

/// Two forgets at once move the files once. The lock in
/// `set_aside_unopened_at` is what makes the second one see the new database;
/// without it the second races the first between its checks and its renames
/// (`NotFound`), or moves the new database aside while the state keeps
/// writing to the old inode. Many rounds, on threads of their own.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_set_asides_at_once_move_the_files_once() {
    for round in 0..20 {
        let dir = tempfile::tempdir().unwrap();
        let local = std::sync::Arc::new(unopened(dir.path(), &["-wal"]).await);
        let first = tokio::spawn({
            let local = std::sync::Arc::clone(&local);
            async move { local.set_aside_unopened_at(1_790_000_000_001).await }
        });
        let second = tokio::spawn({
            let local = std::sync::Arc::clone(&local);
            async move { local.set_aside_unopened_at(1_790_000_000_002).await }
        });
        let results = [first.await.unwrap(), second.await.unwrap()];

        let moved: Vec<_> = results
            .iter()
            .map(|result| {
                result
                    .as_ref()
                    .unwrap_or_else(|error| panic!("round {round}: {error}"))
            })
            .filter(|moved| moved.is_some())
            .collect();
        assert_eq!(moved.len(), 1, "round {round}: {results:?}");
        let kept: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.contains(".unreadable-"))
            .collect();
        assert_eq!(
            kept.len(),
            2,
            "round {round}: one database and its -wal: {kept:?}"
        );

        // The state writes into the file that stands at the database's name.
        let db = local.get().unwrap();
        db.transaction(vec![statement(
            INSERT_LINE,
            json!([LINE_1, "Линия 1", 0, 3]),
        )])
        .await
        .unwrap();
        let mut raw = SqliteConnectOptions::new()
            .filename(dir.path().join(FILE_NAME))
            .connect()
            .await
            .unwrap();
        let (lines,): (i64,) = sqlx::query_as("SELECT count(*) FROM ref_lines")
            .fetch_one(&mut raw)
            .await
            .unwrap();
        raw.close().await.unwrap();
        assert_eq!(
            lines, 1,
            "round {round}: the new database is the one in use"
        );
    }
}

/// A set-aside whose put-back failed leaves its files split: the database
/// under an `.unreadable-` name and its `-wal` under the original one, or the
/// reverse. Moving what is left under a new stamp would part them for good,
/// so a later set-aside refuses until support has put them together.
#[tokio::test]
async fn a_split_set_aside_is_not_added_to() {
    // The database is aside; its WAL is still at the original name.
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &["-wal"]).await;
    rename_once_released(
        &dir.path().join(FILE_NAME),
        &dir.path()
            .join(format!("{FILE_NAME}.unreadable-1790000000000")),
    );
    assert!(local
        .set_aside_unopened_at(1_790_000_000_005)
        .await
        .is_err());
    assert!(dir.path().join(format!("{FILE_NAME}-wal")).exists());
    assert!(local.get().is_err(), "no new database over a split set");

    // The WAL is aside; the database is still at the original name.
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    std::fs::write(
        dir.path()
            .join(format!("{FILE_NAME}.unreadable-1790000000000-wal")),
        "its wal",
    )
    .unwrap();
    assert!(local
        .set_aside_unopened_at(1_790_000_000_005)
        .await
        .is_err());
    assert!(dir.path().join(FILE_NAME).exists());
    assert!(!dir
        .path()
        .join(format!("{FILE_NAME}.unreadable-1790000000005"))
        .exists());

    // A complete earlier set-aside, or one that kept only the database, is
    // not a split.
    let dir = tempfile::tempdir().unwrap();
    let local = unopened(dir.path(), &[]).await;
    std::fs::write(
        dir.path()
            .join(format!("{FILE_NAME}.unreadable-1790000000000")),
        "the earlier one",
    )
    .unwrap();
    std::fs::write(
        dir.path()
            .join(format!("{FILE_NAME}.unreadable-1790000000000-wal")),
        "its wal",
    )
    .unwrap();
    assert!(local.set_aside_unopened_at(1_790_000_000_005).await.is_ok());
    assert!(local.get().is_ok());
}

/// Plan СКЛ takes shell migration `0012` while `0010` and `0011` belong to other plans that
/// may land later (and `0010`/`0011` do not exist on this branch). sqlx runs every migration
/// the journal lacks, in version order, and refuses only one that was applied and is gone
/// (`VersionMissing`) or edited (`VersionMismatch`): a database that holds `0012` but lacks a
/// lower number takes it late, keeps its data (the warehouse rows included) and its journal
/// of `0012`. `0009` stands in for the lower number that is absent.
#[tokio::test]
async fn a_database_that_already_has_0012_takes_a_lower_migration_late() {
    let dir = tempfile::tempdir().unwrap();
    let without_0009: Vec<_> = MIGRATOR
        .iter()
        .filter(|migration| migration.version != 9)
        .cloned()
        .collect();
    assert_eq!(
        without_0009.len() + 1,
        MIGRATOR.iter().count(),
        "0009 exists and is the one left out"
    );
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: std::borrow::Cow::Owned(without_0009),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut raw)
    .await
    .unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut raw)
            .await
            .unwrap();
    assert!(
        versions.contains(&12) && !versions.contains(&9),
        "0012 applied while 0009 is absent: {versions:?}"
    );
    for sql in [
        "INSERT INTO wh_sessions (id, host_id, device_id, reason, started_by, started_at, \
         updated_at) VALUES ('wh-session-1', 'host', 'device', 'lost', 'operator-1', \
         '2026-10-12T07:00:00.000Z', '2026-10-12T07:00:00.000Z')",
        "INSERT INTO ref_lines (id, name, archived, rev) VALUES ('line-1', 'Линия 1', 0, 3)",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    let at_gap: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE name = 'floor_restore_epochs'")
            .fetch_optional(&mut raw)
            .await
            .unwrap();
    assert_eq!(at_gap, None, "the lower migration has not run yet");
    raw.close().await.unwrap();

    // The application opens the file as it starts: it applies what is pending.
    let db = LocalDb::open(dir.path()).await.unwrap();
    let journal = db
        .query(
            "SELECT version, success FROM _sqlx_migrations ORDER BY version",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(
        Value::Array(journal.into_iter().map(Value::Object).collect()),
        Value::Array(
            MIGRATOR
                .iter()
                .map(|migration| json!({ "version": migration.version, "success": 1 }))
                .collect()
        ),
        "the late migration is journaled beside 0012"
    );
    assert_eq!(count(&db, "floor_restore_epochs").await, json!(0));
    assert_eq!(
        count(&db, "wh_sessions").await,
        json!(1),
        "0012's row stays"
    );
    assert_eq!(count(&db, "ref_lines").await, json!(1));
}

/// The warehouse reprint's reads and writes (plan СКЛ, `src/floor/warehouse/warehouse-store.ts`
/// and `src/local/warehouse-sender.ts`; `test/floor-schema.test.ts` checks the texts agree)
/// search an index, never a whole table: jobs and records grow with every label printed again
/// and stay 30 days after their session finished.
#[tokio::test]
async fn the_warehouse_reads_search_an_index() {
    let (dir, db) = open().await;
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    let jobs = "SELECT id, session_id, kind, subject_id, identity, repair, reason, state, \
                template_id, template_rev, template_spec, fields, printer, bytes_base64, \
                error_code, attempts, operator_id, created_at, updated_at FROM wh_jobs";
    let open_job = format!(
        "{jobs} WHERE host_id = ? AND device_id = ? AND session_id = ? \
         AND state IN ('prepared', 'sending', 'failed', 'unknown')"
    );
    let by_identity = format!(
        "{jobs} WHERE host_id = ? AND device_id = ? AND session_id = ? AND identity = ? \
         AND state <> 'cancelled' ORDER BY rowid DESC LIMIT 1"
    );
    let by_id = format!("{jobs} WHERE host_id = ? AND device_id = ? AND id = ?");
    // (the statement, what its plan must name)
    let reads: Vec<(String, &str)> = vec![
        (
            "SELECT id, reason, unit_template_id, box_template_id, pallet_template_id, \
             started_by, started_at FROM wh_sessions WHERE host_id = ? AND device_id = ? \
             AND finished_at IS NULL"
                .to_owned(),
            "wh_sessions_open",
        ),
        (open_job, "(host_id=? AND device_id=? AND session_id=?)"),
        (
            by_identity,
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=? AND identity=?)",
        ),
        (by_id, "sqlite_autoindex_wh_jobs_1 (id=?)"),
        (
            "SELECT count(*) AS n FROM wh_jobs WHERE host_id = ? AND device_id = ? \
             AND session_id = ? AND state IN ('sent', 'verified')"
                .to_owned(),
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)",
        ),
        (
            "SELECT count(*) AS n FROM wh_outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL"
                .to_owned(),
            "wh_outbox_unsent",
        ),
        (
            "UPDATE wh_jobs SET state = ?, error_code = ?, attempts = ?, reason = ?, \
             printer = ?, bytes_base64 = ?, updated_at = ? WHERE host_id = ? AND device_id = ? \
             AND id = ? AND state = ? AND attempts = ?"
                .to_owned(),
            "sqlite_autoindex_wh_jobs_1 (id=?)",
        ),
        (
            "UPDATE wh_sessions SET reason = ?, unit_template_id = ?, box_template_id = ?, \
             pallet_template_id = ?, updated_at = ? WHERE host_id = ? AND device_id = ? \
             AND id = ? AND finished_at IS NULL"
                .to_owned(),
            // By its key or by the pairing's one open session: either is one row.
            "SEARCH wh_sessions USING",
        ),
        (
            "UPDATE wh_sessions SET finished_at = ?, finished_by = ?, updated_at = ? \
             WHERE host_id = ? AND device_id = ? AND id = ? AND finished_at IS NULL \
             AND NOT EXISTS (SELECT 1 FROM wh_jobs j WHERE j.host_id = wh_sessions.host_id \
             AND j.device_id = wh_sessions.device_id AND j.session_id = wh_sessions.id \
             AND j.state IN ('prepared', 'sending', 'failed', 'unknown'))"
                .to_owned(),
            "SEARCH wh_sessions USING",
        ),
        (
            "SELECT s.id FROM wh_sessions s WHERE s.host_id = ? AND s.device_id = ? \
             AND s.finished_at IS NOT NULL AND s.finished_at <= ? AND NOT EXISTS (SELECT 1 \
             FROM wh_outbox o WHERE o.host_id = s.host_id AND o.device_id = s.device_id \
             AND o.session_id = s.id AND o.outcome IS NOT 'accepted')"
                .to_owned(),
            "wh_sessions_finished (host_id=? AND device_id=? AND finished_at",
        ),
        (
            "DELETE FROM wh_sessions WHERE host_id = ? AND device_id = ? AND id = ? \
             AND finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wh_outbox o \
             WHERE o.host_id = wh_sessions.host_id AND o.device_id = wh_sessions.device_id \
             AND o.session_id = wh_sessions.id AND o.outcome IS NOT 'accepted')"
                .to_owned(),
            "SEARCH wh_sessions USING",
        ),
        (
            "DELETE FROM wh_jobs WHERE host_id = ? AND device_id = ? AND session_id = ?".to_owned(),
            "wh_jobs_session (host_id=? AND device_id=? AND session_id=?)",
        ),
        (
            "DELETE FROM wh_outbox WHERE host_id = ? AND device_id = ? AND session_id = ?"
                .to_owned(),
            "wh_outbox_session (session_id=? AND host_id=? AND device_id=?)",
        ),
        (
            "SELECT id, payload FROM wh_outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL ORDER BY seq LIMIT ?"
                .to_owned(),
            "wh_outbox_unsent",
        ),
        (
            "UPDATE wh_outbox SET attempts = attempts + 1, sent_at = ? WHERE +host_id = ? \
             AND +device_id = ? AND id IN (SELECT value FROM json_each(?))"
                .to_owned(),
            "sqlite_autoindex_wh_outbox_1 (id=?)",
        ),
        (
            "UPDATE wh_outbox SET outcome = r.value ->> 'outcome', outcome_code = r.value ->> \
             'code', acked_at = ? FROM json_each(?) AS r WHERE wh_outbox.id = r.value ->> 'id' \
             AND +wh_outbox.host_id = ? AND +wh_outbox.device_id = ? AND +wh_outbox.acked_at \
             IS NULL"
                .to_owned(),
            "sqlite_autoindex_wh_outbox_1 (id=?)",
        ),
        // The organization logo a reprint prints (plan СКЛ × А4,
        // `src/floor/warehouse/warehouse-logo.ts`): the pairing's shifts through an index on
        // (host_id, device_id, …) — the planner takes `floor_shifts_line` or the key.
        (
            "SELECT snapshot -> '$.organization' AS organization FROM floor_shifts \
             WHERE host_id = ? AND device_id = ? AND snapshot -> '$.organization' IS NOT NULL \
             ORDER BY opened_at DESC, id DESC LIMIT 1"
                .to_owned(),
            "(host_id=? AND device_id=?)",
        ),
    ];
    for (sql, index) in &reads {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..sql.matches('?').count() {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert!(
            plan.iter().any(|step| step.contains(index)),
            "{sql}\n  should use {index}, its plan is {plan:?}"
        );
        // `json_each` (alias `r` in the receipt's `UPDATE … FROM`) is the batch's own list.
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN ")
                && !step.contains("json_each")
                && !step.starts_with("SCAN r ")),
            "{sql}\n  scans a table: {plan:?}"
        );
    }
    raw.close().await.unwrap();
}

/// The unit label jobs (plan РЕЖ part B, migration `0015`,
/// `src/floor/unit-labels/unit-label-store.ts`): the pairing's one unresolved job through the
/// unique partial index (its predicate named word for word), whole and by its light gate, a
/// job by its key, «История
/// этикеток» through the shift's index in its rowid order, the recovery's sending jobs of the
/// pairing through their partial index and a job's step by its key. No statement scans a table or sorts on
/// its own. `test/floor-schema.test.ts` plans the same texts on the Node runtime's SQLite and
/// checks that they appear here word for word.
#[tokio::test]
async fn the_unit_label_reads_search_an_index() {
    let (dir, db) = open().await;
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    // (the statement, what its plan must name)
    let reads: [(&str, &str); 7] = [
        (
            "SELECT id, shift_id, code_hash, scan_id, attempt_no, attempt_state, \
             verification_policy, verification, reason, error_code, print_mode, language, dpi, \
             bytes_digest, payload_digest, template_id, template_rev, fields, operator_id, \
             created_at, updated_at, bytes_base64 FROM floor_unit_labels WHERE host_id = ? AND device_id = ? \
             AND (verification = 'pending' OR (verification = 'not_required' \
             AND attempt_state <> 'sent'))",
            "floor_unit_labels_unresolved (host_id=? AND device_id=?)",
        ),
        // Its light gate (review of B5): every scan of a printing shift and every reprint ask it,
        // without the job's fields or bytes.
        (
            "SELECT id, shift_id, attempt_no, attempt_state, verification_policy, verification \
             FROM floor_unit_labels WHERE host_id = ? AND device_id = ? \
             AND (verification = 'pending' OR (verification = 'not_required' \
             AND attempt_state <> 'sent'))",
            "floor_unit_labels_unresolved (host_id=? AND device_id=?)",
        ),
        (
            "SELECT id, shift_id, code_hash, scan_id, attempt_no, attempt_state, \
             verification_policy, verification, reason, error_code, print_mode, language, dpi, \
             bytes_digest, payload_digest, template_id, template_rev, fields, operator_id, \
             created_at, updated_at, bytes_base64 FROM floor_unit_labels WHERE host_id = ? AND device_id = ? \
             AND id = ?",
            "sqlite_autoindex_floor_unit_labels_1 (id=?)",
        ),
        (
            "SELECT id, shift_id, code_hash, scan_id, attempt_no, attempt_state, \
             verification_policy, verification, reason, error_code, print_mode, language, dpi, \
             bytes_digest, payload_digest, template_id, template_rev, fields, operator_id, \
             created_at, updated_at FROM floor_unit_labels WHERE host_id = ? AND device_id = ? \
             AND shift_id = ? ORDER BY rowid DESC LIMIT ?",
            "floor_unit_labels_shift (host_id=? AND device_id=? AND shift_id=?)",
        ),
        (
            "SELECT id, shift_id, code_hash, scan_id, attempt_no, attempt_state, \
             verification_policy, verification, reason, error_code, print_mode, language, dpi, \
             bytes_digest, payload_digest, template_id, template_rev, fields, operator_id, \
             created_at, updated_at, bytes_base64 FROM floor_unit_labels WHERE host_id = ? AND device_id = ? \
             AND attempt_state = 'sending'",
            "floor_unit_labels_sending (host_id=? AND device_id=?)",
        ),
        (
            "UPDATE floor_unit_labels SET attempt_no = ?, attempt_state = ?, verification = ?, \
             reason = ?, error_code = ?, updated_at = ? WHERE host_id = ? \
             AND device_id = ? AND id = ? AND attempt_no = ? AND attempt_state = ? \
             AND verification = ?",
            "sqlite_autoindex_floor_unit_labels_1 (id=?)",
        ),
        // The close's summary (plan РЕЖ, B6): the shift's unresolved label, through the
        // pairing's one unresolved job (`INDEXED BY`), never the shift's every job.
        (
            "SELECT count(*) AS n FROM floor_unit_labels INDEXED BY floor_unit_labels_unresolved \
             WHERE host_id = ? AND device_id = ? AND shift_id = ? AND (verification = 'pending' \
             OR (verification = 'not_required' AND attempt_state <> 'sent'))",
            "floor_unit_labels_unresolved (host_id=? AND device_id=?)",
        ),
    ];
    for (sql, index) in reads {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..sql.matches('?').count() {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert!(
            plan.iter().any(|step| step.contains(index)),
            "{sql}\n  should use {index}, its plan is {plan:?}"
        );
        assert!(
            !plan
                .iter()
                .any(|step| step.starts_with("SCAN ") || step.contains("TEMP")),
            "{sql}\n  scans a table or sorts: {plan:?}"
        );
    }
    raw.close().await.unwrap();
}

/// The counts of records without a receipt that stop a forget (final review of plan СКЛ, m5):
/// the webview's `countUnsentRecords` (`src/local/outbox.ts`, `FORGET_UNSENT_*_SQL`: the outbox
/// and `wh_outbox` in one statement) and this shell's own `count_unsent` over `wh_outbox` (its
/// `format!` with `{table}`, pinned by text in `test/floor-schema.test.ts`), each for one pairing
/// and for every pairing. Each reads the partial `*_unsent` indexes only: the every-pairing form
/// walks those indexes whole, which hold only the records still waiting.
/// `test/floor-schema.test.ts` plans the same texts on the Node runtime's SQLite.
#[tokio::test]
async fn the_forget_counts_read_only_the_unsent_indexes() {
    let (dir, db) = open().await;
    drop(db);
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    let counts: [(&str, &[&str]); 5] = [
        (
            "SELECT (SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? \
             AND device_id = ?) + (SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL \
             AND host_id = ? AND device_id = ?) AS n",
            &[
                "SCAN CONSTANT ROW",
                "SCALAR SUBQUERY 1",
                "SEARCH outbox USING INDEX outbox_unsent (host_id=? AND device_id=?)",
                "SCALAR SUBQUERY 2",
                "SEARCH wh_outbox USING INDEX wh_outbox_unsent (host_id=? AND device_id=?)",
            ],
        ),
        (
            "SELECT (SELECT count(*) FROM outbox INDEXED BY outbox_unsent WHERE acked_at IS NULL) + \
             (SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL) AS n",
            &[
                "SCAN CONSTANT ROW",
                "SCALAR SUBQUERY 1",
                "SCAN outbox USING INDEX outbox_unsent",
                "SCALAR SUBQUERY 2",
                "SCAN wh_outbox USING INDEX wh_outbox_unsent",
            ],
        ),
        (
            "SELECT count(*) FROM wh_outbox WHERE acked_at IS NULL AND host_id = ? \
             AND device_id = ?",
            &["SEARCH wh_outbox USING INDEX wh_outbox_unsent (host_id=? AND device_id=?)"],
        ),
        (
            "SELECT count(*) FROM wh_outbox INDEXED BY wh_outbox_unsent WHERE acked_at IS NULL",
            &["SCAN wh_outbox USING INDEX wh_outbox_unsent"],
        ),
        (
            "SELECT count(*) FROM outbox INDEXED BY outbox_unsent WHERE acked_at IS NULL",
            &["SCAN outbox USING INDEX outbox_unsent"],
        ),
    ];
    for (sql, expected) in counts {
        let text = format!("EXPLAIN QUERY PLAN {sql}");
        let mut explain = sqlx::query(&text);
        for _ in 0..sql.matches('?').count() {
            explain = explain.bind("x");
        }
        let plan: Vec<String> = explain
            .fetch_all(&mut raw)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert_eq!(plan, expected, "{sql}");
    }
    raw.close().await.unwrap();
}
