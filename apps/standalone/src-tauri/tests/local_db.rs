//! The station's local database on a real file: migrations, the read-only
//! query path and the one-transaction batch path (stage 1 spec §5.2).

use markiro_standalone_lib::local_db::{LocalDb, LocalDbError, LocalStatement, FILE_NAME};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};

const INSERT_LINE: &str = "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)";
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
    assert_eq!(names, ["ref_lines", "ref_org", "ref_site", "sync_state"]);

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
    let too_many: Vec<LocalStatement> = (0..33).map(|_| statement("SELECT 1", json!([]))).collect();
    assert_eq!(
        db.transaction(too_many).await,
        Err(LocalDbError::InvalidStatement)
    );
    for sql in [
        "CREATE TABLE extra (x)",
        "PRAGMA foreign_keys = OFF",
        "BEGIN",
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
