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
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sign_in_failures",
            "floor_sscc_blocks",
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
            "sync_state"
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
    // This device's own records are the production tables of `0006`; the
    // sign-in lockouts stay with the copies (an open owner question).
    let device_data: Vec<&str> = TABLE_CLASSES
        .iter()
        .filter(|(_, class)| *class == TableClass::DeviceData)
        .map(|(table, _)| *table)
        .collect();
    assert_eq!(
        device_data,
        [
            "floor_block_requests",
            "floor_boxes",
            "floor_codes",
            "floor_exceptions",
            "floor_scans",
            "floor_shifts",
            "floor_sscc_blocks",
            "outbox"
        ]
    );
    assert_eq!(
        table_class("floor_sign_in_failures"),
        Some(TableClass::Disposable)
    );
}

/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: every table of this device's own records (`0006`) keeps its
/// row, and so does a workstation's table (here one plan 2a7 might add) and
/// sqlx's migration journal.
#[tokio::test]
async fn clearing_the_copies_empties_the_disposable_tables_and_nothing_else() {
    let (dir, db) = open().await;
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
    ])
    .await
    .unwrap();
    // One record in each table of this device's own (`0006`).
    db.transaction(device_records()).await.unwrap();
    // A table of the workstation's settings as plan 2a7 will add it; the
    // webview may not create tables, so a raw connection does.
    run_raw(
        dir.path(),
        &[
            "CREATE TABLE kept_workstation_settings (key TEXT PRIMARY KEY)",
            "INSERT INTO kept_workstation_settings (key) VALUES ('printers')",
        ],
    )
    .await;
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
        "floor_block_requests",
        "floor_boxes",
        "floor_codes",
        "floor_exceptions",
        "floor_scans",
        "floor_shifts",
        "floor_sscc_blocks",
        "outbox",
    ] {
        assert_eq!(count(&db, table).await, json!(1), "{table} keeps its row");
    }
    let kept = db
        .query(
            "SELECT count(*) AS n FROM kept_workstation_settings",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 1 }));
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

/// One row in each table of this device's own records (migration `0006`),
/// each of the pairing `(HOST, DEVICE)`, as the floor's writers will write
/// them through `local_transaction`.
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
        outbox_record("record-1", HOST, DEVICE, None),
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
    let reads: [(&str, &str); 15] = [
        (
            "SELECT id, kind, payload FROM outbox WHERE host_id = ? AND device_id = ? \
             AND acked_at IS NULL ORDER BY seq LIMIT ?",
            "outbox_unsent",
        ),
        (
            "SELECT count(*) FROM outbox WHERE host_id = ? AND device_id = ? AND acked_at IS NULL",
            "outbox_unsent",
        ),
        // The forget's count, as `src/local_db.rs` writes it.
        (
            "SELECT count(*) FROM outbox WHERE acked_at IS NULL AND host_id = ? AND device_id = ?",
            "outbox_unsent",
        ),
        (
            "SELECT count(*) FROM outbox WHERE host_id = ? AND device_id = ? \
             AND outcome = 'rejected'",
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (
            "SELECT count(*) FROM outbox WHERE host_id = ? AND device_id = ? \
             AND outcome = 'conflict'",
            "outbox_settled (host_id=? AND device_id=? AND outcome=?)",
        ),
        (
            "UPDATE outbox SET outcome = r.value ->> 'outcome', acked_at = ? \
             FROM json_each(?) AS r WHERE outbox.id = r.value ->> 'id' \
             AND outbox.host_id = ? AND outbox.device_id = ? AND outbox.acked_at IS NULL",
            "outbox_unsent",
        ),
        (
            "SELECT count(*) FROM floor_codes WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_codes_shift (host_id=? AND device_id=? AND shift_id=?)",
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
        (
            "SELECT id FROM floor_scans WHERE host_id = ? AND device_id = ? AND shift_id = ?",
            "floor_scans_shift",
        ),
        (
            "SELECT id FROM floor_shifts WHERE host_id = ? AND device_id = ? AND line_id = ?",
            "floor_shifts_line",
        ),
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
    }
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
    std::fs::rename(
        dir.path().join(FILE_NAME),
        dir.path()
            .join(format!("{FILE_NAME}.unreadable-1790000000000")),
    )
    .unwrap();
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
