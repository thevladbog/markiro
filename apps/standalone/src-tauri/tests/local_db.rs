//! The station's local database on a real file: migrations, the read-only
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{
    table_class, LocalDb, LocalDbError, LocalStatement, TableClass, FILE_NAME, TABLE_CLASSES,
};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};

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
            "floor_sign_in_failures",
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
    // Until plan 2a5 brings the first records of the device's own, every
    // table is a copy or this pairing's bookkeeping.
    assert!(TABLE_CLASSES
        .iter()
        .all(|(_, class)| *class == TableClass::Disposable));
}

/// Forgetting the device (`device_forget`) empties every disposable table and
/// nothing else: a table outside that class (here two a later migration might
/// add, one of this device's records and one of the workstation's settings)
/// keeps its rows, and so does sqlx's migration journal.
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
    // Tables as a later migration might add them; the webview may not create
    // tables, so a raw connection does.
    let mut raw = SqliteConnectOptions::new()
        .filename(dir.path().join(FILE_NAME))
        .connect()
        .await
        .unwrap();
    for sql in [
        "CREATE TABLE kept_device_records (id TEXT PRIMARY KEY)",
        "CREATE TABLE kept_workstation_settings (key TEXT PRIMARY KEY)",
        "INSERT INTO kept_device_records (id) VALUES ('scan-1')",
        "INSERT INTO kept_workstation_settings (key) VALUES ('printers')",
    ] {
        sqlx::query(sql).execute(&mut raw).await.unwrap();
    }
    raw.close().await.unwrap();
    let journal = "SELECT count(*) AS n FROM _sqlx_migrations";
    let migrations = db.query(journal, vec![]).await.unwrap();

    assert_eq!(db.clear_copies().await, Ok(()));

    for (table, _) in TABLE_CLASSES {
        let left = db
            .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
            .await
            .unwrap();
        assert_eq!(Value::Object(left[0].clone()), json!({ "n": 0 }), "{table}");
    }
    let kept = db
        .query(
            "SELECT (SELECT count(*) FROM kept_device_records) \
             + (SELECT count(*) FROM kept_workstation_settings) AS n",
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(Value::Object(kept[0].clone()), json!({ "n": 2 }));
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

    assert_eq!(db.clear_copies().await, Ok(()));

    for marker in [IN_FILE, IN_WAL] {
        assert!(!file_holds(&file, marker), "{marker} stayed in the file");
        assert!(!file_holds(&wal, marker), "{marker} stayed in the WAL");
    }
}
