//! Migration `0024` (plan ДЗГ): the disaggregation tables, the five default
//! reasons, the document counter and the feed's `code_releases`.

mod support;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqliteConnection};
use support::app::{admin, TestApp};
use support::disaggregation::{day, pallet_day};

#[tokio::test]
async fn the_migration_seeds_five_reasons_and_a_zero_counter() {
    let app = TestApp::new().await;
    let reasons: Vec<(String, String, i64, bool)> = sqlx::query_as(
        "SELECT id, name, sort_order, archived FROM disaggregation_reasons ORDER BY sort_order",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        reasons
            .iter()
            .map(|(_, name, order, _)| (name.as_str(), *order))
            .collect::<Vec<_>>(),
        [
            ("Не тот товар", 10),
            ("Неверное количество", 20),
            ("Повреждена упаковка", 30),
            ("Брак по качеству", 40),
            ("Другое", 90),
        ]
    );
    assert!(reasons
        .iter()
        .all(|(id, _, _, archived)| id.starts_with("d15a0000-") && !archived));
    let seq: i64 = sqlx::query_scalar("SELECT last_seq FROM disaggregation_doc_counters")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(seq, 0);
}

/// Run one statement and return the error text, which must exist.
async fn refused(app: &TestApp, statement: &str) -> String {
    sqlx::query(statement)
        .execute(&app.state.pool)
        .await
        .expect_err(statement)
        .to_string()
}

#[tokio::test]
async fn the_tables_refuse_what_no_row_may_hold() {
    let admin = admin().await;
    // A pallet with two boxes: the lines below name rows that exist, so only
    // a CHECK can refuse them.
    pallet_day(&admin, false).await;
    let app = &admin.app;
    let (real_box, real_pallet) = (support::app::box_id(1), support::app::pallet_id(1));
    let user: String = sqlx::query_scalar("SELECT id FROM office_users LIMIT 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    // A second counter row.
    let error = refused(
        app,
        "INSERT INTO disaggregation_doc_counters (id, last_seq) VALUES (2, 0)",
    )
    .await;
    assert!(error.contains("CHECK"), "{error}");
    // A reason of blanks, one of 121 characters.
    for name in [" ".to_owned(), "x".repeat(121)] {
        let error = refused(
            app,
            &format!(
                "INSERT INTO disaggregation_reasons (id, name, created_at, rev) \
                 VALUES ('r', '{name}', 'at', 1)"
            ),
        )
        .await;
        assert!(error.contains("CHECK"), "{error}");
    }
    // An applied document without a reason.
    let error = refused(
        app,
        &format!(
            "INSERT INTO disaggregation_documents (id, seq, doc_no, status, source, created_by, \
             created_at, applied_at, applied_by, updated_at, rev) VALUES ('d1', 1, 'DSG-26-0001', \
             'applied', 'manual', '{user}', 'at', 'at', '{user}', 'at', 1)"
        ),
    )
    .await;
    assert!(error.contains("CHECK"), "{error}");
    // A bad number.
    let error = refused(
        app,
        &format!(
            "INSERT INTO disaggregation_documents (id, seq, doc_no, status, source, created_by, \
             created_at, updated_at, rev) VALUES ('d2', 2, 'DSG-2-1', 'draft', 'manual', '{user}', \
             'at', 'at', 1)"
        ),
    )
    .await;
    assert!(error.contains("CHECK"), "{error}");
    // A draft with a header, then lines that break the rules.
    sqlx::query(&format!(
        "INSERT INTO disaggregation_documents (id, seq, doc_no, status, source, created_by, \
         created_at, updated_at, rev) VALUES ('d3', 3, 'DSG-26-0003', 'draft', 'manual', '{user}', \
         'at', 'at', 1)"
    ))
    .execute(&app.state.pool)
    .await
    .unwrap();
    let line = |id: &str, position: i64, sscc: &str, ids: &str, status: &str| {
        format!(
            "INSERT INTO disaggregation_document_lines (id, document_id, position, sscc_input, \
             sscc, {cols} status, validated_at, created_at) VALUES ('{id}', 'd3', {position}, \
             'in', {sscc}, {vals} '{status}', 'at', 'at')",
            cols = ids.split('|').next().unwrap(),
            vals = ids.split('|').nth(1).unwrap(),
        )
    };
    let digits = "'046006820000015000'";
    for (what, statement) in [
        (
            "a duplicate that names a box",
            line(
                "l1",
                1,
                "NULL",
                &format!("box_id,|'{real_box}',"),
                "duplicate",
            ),
        ),
        (
            "a box and a pallet at once",
            line(
                "l2",
                2,
                digits,
                &format!("box_id, pallet_id,|'{real_box}', '{real_pallet}',"),
                "ok",
            ),
        ),
        (
            "a read line without a target",
            line("l3", 3, digits, "|", "ok"),
        ),
        ("a short SSCC", line("l4", 4, "'1234'", "|", "not_found")),
        ("no SSCC on an ok line", line("l5", 5, "NULL", "|", "ok")),
        ("position zero", line("l6", 0, digits, "|", "not_found")),
    ] {
        let error = refused(app, &statement).await;
        assert!(error.contains("CHECK"), "{what}: {error}");
    }
    // The same SSCC twice in one document.
    sqlx::query(&line("l7", 7, digits, "|", "not_found"))
        .execute(&app.state.pool)
        .await
        .unwrap();
    let error = refused(app, &line("l8", 8, digits, "|", "not_found")).await;
    assert!(error.contains("UNIQUE"), "{error}");
}

async fn plan_of(app: &TestApp, sql: &str) -> String {
    let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
        .fetch_all(&app.state.pool)
        .await
        .unwrap();
    rows.into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn the_lookups_use_their_indexes() {
    let app = TestApp::new().await;
    let by_box = plan_of(
        &app,
        "SELECT id FROM disaggregation_document_lines WHERE box_id = 'b'",
    )
    .await;
    assert!(by_box.contains("disaggregation_lines_box"), "{by_box}");
    let by_pallet = plan_of(
        &app,
        "SELECT id FROM disaggregation_document_lines WHERE pallet_id = 'p'",
    )
    .await;
    assert!(
        by_pallet.contains("disaggregation_lines_pallet"),
        "{by_pallet}"
    );
    let in_order = plan_of(
        &app,
        "SELECT id FROM disaggregation_document_lines WHERE document_id = 'd' ORDER BY position",
    )
    .await;
    let unique: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' \
         AND tbl_name = 'disaggregation_document_lines' AND name LIKE 'sqlite_autoindex%'",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    assert!(
        unique.iter().any(|name| in_order.contains(name.as_str())),
        "{in_order} / {unique:?}"
    );
    assert!(!in_order.contains("USE TEMP B-TREE"), "{in_order}");
    let releases = plan_of(&app, "SELECT box_id FROM code_releases WHERE rev > 3").await;
    assert!(releases.contains("code_releases_rev"), "{releases}");
}

/// The host's database as a station's day left it, loaded into an empty one
/// at the schema before `0024`, then migrated: nothing is lost, and the
/// foreign keys hold.
#[tokio::test]
async fn the_migration_applies_to_a_database_with_shifts_in_it() {
    let admin = admin().await;
    day(&admin, true).await;
    let dir = tempfile::tempdir().unwrap();
    let snapshot = dir.path().join("snapshot.db");
    sqlx::query("VACUUM INTO ?")
        .bind(snapshot.to_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = dir.path().join("migrations");
    std::fs::create_dir(&before).unwrap();
    let applied = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    for entry in std::fs::read_dir(&applied).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name().to_str().unwrap() < "0024" {
            std::fs::copy(entry.path(), before.join(entry.file_name())).unwrap();
        }
    }
    let mut old: SqliteConnection = SqliteConnectOptions::new()
        .filename(dir.path().join("old.db"))
        .create_if_missing(true)
        .foreign_keys(false)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(before.as_path())
        .await
        .unwrap()
        .run(&mut old)
        .await
        .unwrap();
    let not_yet: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
         ('disaggregation_reasons', 'disaggregation_documents', 'code_releases')",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!(not_yet, 0);
    sqlx::query("ATTACH DATABASE ? AS source")
        .bind(snapshot.to_str().unwrap())
        .execute(&mut old)
        .await
        .unwrap();
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         AND name <> '_sqlx_migrations' ORDER BY name",
    )
    .fetch_all(&mut old)
    .await
    .unwrap();
    for table in &tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(table)
                .fetch_all(&mut old)
                .await
                .unwrap();
        let columns = columns.join(", ");
        sqlx::query(&format!(
            "INSERT OR REPLACE INTO main.{table} ({columns}) SELECT {columns} FROM source.{table}"
        ))
        .execute(&mut old)
        .await
        .unwrap();
    }
    sqlx::query("DETACH DATABASE source")
        .execute(&mut old)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut old)
        .await
        .unwrap();
    let before_counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM shifts), (SELECT COUNT(*) FROM boxes), \
         (SELECT COUNT(*) FROM scans)",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!(before_counts, (1, 3, 5));
    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();
    let after_counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM shifts), (SELECT COUNT(*) FROM boxes), \
         (SELECT COUNT(*) FROM scans)",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!(after_counts, before_counts);
    let broken: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
        .fetch_all(&mut old)
        .await
        .unwrap();
    assert!(broken.is_empty(), "{broken:?}");
    let reasons: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM disaggregation_reasons")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!(reasons, 5);
}
