//! Migration `0021` (plan РЕЖ, part B): the print policy of a validation
//! shift (the Data Matrix duplicate of each accepted unit) and the host's
//! trace of its unit labels. `shifts` takes three columns by `ALTER TABLE`,
//! the cloud's policy CHECK across them is held by two triggers, a third
//! freezes a shift's mode and policy once it is open or has scans, and
//! `unit_label_events` keeps one row per event of a station's label job. The
//! database is built at `0020` and migrated by the host's own `MIGRATOR` on
//! a pool of `db::options` (foreign keys on), so these tests prove what sqlx
//! does.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use tempfile::TempDir;

/// Every migration before `0021`.
fn through_0020() -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version < 21)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// One connection, so what a test reads follows what it wrote.
async fn pool(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(path).create_if_missing(true))
        .await
        .unwrap()
}

/// A database at `0020`.
async fn at_0020() -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    let old = through_0020();
    assert_eq!(
        old.iter().map(|migration| migration.version).max(),
        Some(20)
    );
    old.run(&pool).await.unwrap();
    (dir, pool)
}

/// A database with every migration.
async fn migrated() -> (TempDir, SqlitePool) {
    let (dir, pool) = at_0020().await;
    seed(&pool).await;
    MIGRATOR.run(&pool).await.unwrap();
    (dir, pool)
}

async fn execute(pool: &SqlitePool, statements: &[&str]) {
    for statement in statements {
        sqlx::query(statement)
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("{statement}: {error}"));
    }
}

/// The parents every row below needs: a line, a station, a product.
const PARENTS: [&str; 3] = [
    "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
    "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, paired_at) \
     VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), '0.1.0', 4, \
     '2026-10-01T08:00:00Z')",
    "INSERT INTO products (id, gtin14, name, rev) \
     VALUES ('product-1', '04600682000013', 'Сок яблочный', 1)",
];

/// A shift as `0020` holds it (no policy columns yet): open when `active`.
fn shift_0020(id: &str, seq: i64, status: &str, mode: &str) -> String {
    let (owner, snapshot, opened) = if status == "planned" {
        ("NULL", "NULL", "NULL")
    } else {
        ("'device-1'", "'{}'", "'2026-10-09T08:00:00Z'")
    };
    format!(
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
         VALUES ('{id}', 'OCT26', {seq}, 'office', 'office_user', 'user-1', '{status}', '{mode}', \
         'product-1', 'line-1', '2026-10-09', 12, 'template-1', {owner}, {snapshot}, {opened}, \
         '2026-10-08T17:00:00Z', 1)"
    )
}

/// What `0020` holds: an open aggregation shift with a box, an accepted scan
/// in it that owns its code; an open validation shift with an accepted scan
/// without a box that owns its code, and a duplicate; one planned shift of
/// each mode. The canonical text keeps its GS1 group separator.
async fn seed(pool: &SqlitePool) {
    execute(pool, &PARENTS).await;
    let shifts = [
        shift_0020("shift-a", 1, "active", "aggregation"),
        shift_0020("shift-v", 2, "active", "validation"),
        shift_0020("shift-pa", 3, "planned", "aggregation"),
        shift_0020("shift-pv", 4, "planned", "validation"),
    ];
    execute(pool, &shifts.iter().map(String::as_str).collect::<Vec<_>>()).await;
    execute(
        pool,
        &[
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
             VALUES ('box-1', 'shift-a', 'device-1', '2026-10-09T10:00:00.000Z', \
             '2026-10-09T10:00:01Z')",
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
             scanned_at, received_at) \
             VALUES ('scan-1', 'record-1', 'device-1', 'shift-a', 'ok', NULL, 'km', 38, \
             printf('%064x', 1), '04600682000013', 'B0000001', \
             '010460068200001321B0000001' || char(29) || '93Zz', 'box-1', 'operator-1', \
             '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:01Z')",
            "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
             VALUES ('scan-1', 'box-1', printf('%064x', 1), '2026-10-09T10:00:00.000Z')",
            "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
             VALUES (printf('%064x', 1), 'scan-1', 'shift-a', 'device-1', 'box-1', \
             '2026-10-09T10:00:00.000Z')",
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
             scanned_at, received_at) \
             VALUES ('scan-2', 'record-2', 'device-1', 'shift-v', 'ok', NULL, 'km', 38, \
             printf('%064x', 2), '04600682000013', 'B0000002', \
             '010460068200001321B0000002' || char(29) || '93Zz', NULL, 'operator-1', \
             '2026-10-09T11:00:00.000Z', '2026-10-09T11:00:01Z')",
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
             scanned_at, received_at) \
             VALUES ('scan-3', 'record-3', 'device-1', 'shift-v', 'duplicate', 'local', 'km', 38, \
             printf('%064x', 2), '04600682000013', 'B0000002', \
             '010460068200001321B0000002' || char(29) || '93Zz', NULL, 'operator-1', \
             '2026-10-09T11:00:05.000Z', '2026-10-09T11:00:06Z')",
            "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
             VALUES (printf('%064x', 2), 'scan-2', 'shift-v', 'device-1', NULL, \
             '2026-10-09T11:00:00.000Z')",
        ],
    )
    .await;
}

/// The columns of `table`, in order.
async fn columns(pool: &SqlitePool, table: &str) -> Vec<String> {
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
            .bind(table)
            .fetch_all(pool)
            .await
            .unwrap();
    assert!(!columns.is_empty(), "{table}");
    columns
}

/// Every row of `table` by `key`, as `columns` and its rowid, each value as
/// SQLite quotes it (so a text, an integer and a blob never read alike).
async fn rows(pool: &SqlitePool, table: &str, columns: &[String], key: &str) -> Vec<String> {
    let quoted = columns
        .iter()
        .map(|column| format!("quote({column})"))
        .collect::<Vec<_>>()
        .join(" || '|' || ");
    sqlx::query_scalar(&format!(
        "SELECT quote(rowid) || '|' || {quoted} FROM {table} ORDER BY {key}"
    ))
    .fetch_all(pool)
    .await
    .unwrap()
}

type SchemaRow = (String, String, String, Option<String>);

/// The whole schema: every object, with its text.
async fn schema(pool: &SqlitePool) -> BTreeSet<SchemaRow> {
    sqlx::query_as("SELECT type, name, tbl_name, sql FROM sqlite_master")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

fn object<'a>(schema: &'a BTreeSet<SchemaRow>, kind: &str, name: &str) -> &'a SchemaRow {
    schema
        .iter()
        .find(|row| row.0 == kind && row.1 == name)
        .unwrap_or_else(|| panic!("no {kind} {name}"))
}

async fn checks_clean(pool: &SqlitePool) {
    let violations: Vec<(String, i64, String, i64)> =
        sqlx::query_as("SELECT \"table\", rowid, parent, fkid FROM pragma_foreign_key_check")
            .fetch_all(pool)
            .await
            .unwrap();
    assert!(violations.is_empty(), "{violations:?}");
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(integrity, ["ok"]);
}

fn refused(result: Result<(), sqlx::Error>, expected: &str, what: &str) {
    let error = result.expect_err(&format!("{what}: the write was taken"));
    assert!(error.to_string().contains(expected), "{what}: {error}");
}

async fn run(pool: &SqlitePool, statement: &str) -> Result<(), sqlx::Error> {
    sqlx::query(statement).execute(pool).await.map(|_| ())
}

async fn applied(pool: &SqlitePool) -> Vec<i64> {
    sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
        .fetch_all(pool)
        .await
        .unwrap()
}

const POLICY: &str = "shift validation print: duplicate_dm only in a validation shift";
const FROZEN: &str = "shift mode and print policy: frozen once open or scanned";

/// A planned shift `id` of `mode` with the policy given as SQL literals.
async fn planned(
    pool: &SqlitePool,
    id: &str,
    seq: i64,
    mode: &str,
    policy: (&str, &str, &str),
) -> Result<(), sqlx::Error> {
    let (print_mode, verification, template) = policy;
    run(
        pool,
        &format!(
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, \
             created_by_kind, created_by, status, mode, product_id, line_id, production_date, \
             box_capacity, box_template_id, validation_print_mode, \
             validation_print_verification, validation_print_template_id, created_at, rev) \
             VALUES ('{id}', 'NOV26', {seq}, 'office', 'office_user', 'user-1', 'planned', \
             '{mode}', 'product-1', 'line-1', '2026-11-02', 12, 'template-1', {print_mode}, \
             {verification}, {template}, '2026-11-01T17:00:00Z', 1)"
        ),
    )
    .await
}

async fn policy_of(
    pool: &SqlitePool,
    id: &str,
) -> (String, String, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT mode, validation_print_mode, validation_print_verification, \
         validation_print_template_id FROM shifts WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn the_migration_adds_the_policy_and_the_events_and_keeps_every_row() {
    assert!(
        MIGRATOR.iter().any(|migration| migration.version == 21),
        "no migration 0021"
    );
    let (_dir, pool) = at_0020().await;
    seed(&pool).await;
    let tables = [
        ("shifts", "id"),
        ("scans", "id"),
        ("box_items", "scan_id"),
        ("code_owners", "code_hash"),
        ("boxes", "id"),
    ];
    let mut before = Vec::new();
    for (table, key) in tables {
        let columns = columns(&pool, table).await;
        let rows = rows(&pool, table, &columns, key).await;
        before.push((columns, rows));
    }
    assert_eq!(
        before
            .iter()
            .map(|(_, rows)| rows.len())
            .collect::<Vec<_>>(),
        [4, 3, 1, 2, 1]
    );
    let schema_before = schema(&pool).await;

    MIGRATOR.run(&pool).await.unwrap();

    assert!(applied(&pool).await.contains(&21));
    // Every row as it was, in the columns it had, its rowid with it.
    for ((table, key), (columns_before, rows_before)) in tables.into_iter().zip(&before) {
        assert_eq!(
            &rows(&pool, table, columns_before, key).await,
            rows_before,
            "{table}"
        );
    }
    // Only `shifts` took columns, last; every shift has no policy.
    let shift_columns = columns(&pool, "shifts").await;
    let mut expected = before[0].0.clone();
    expected.extend(
        [
            "validation_print_mode",
            "validation_print_verification",
            "validation_print_template_id",
        ]
        .map(str::to_owned),
    );
    assert_eq!(shift_columns, expected);
    for (index, (table, _)) in tables.into_iter().enumerate().skip(1) {
        assert_eq!(columns(&pool, table).await, before[index].0, "{table}");
    }
    let policies: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, validation_print_mode, validation_print_verification, \
         validation_print_template_id FROM shifts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        policies,
        ["shift-a", "shift-pa", "shift-pv", "shift-v"].map(|id| (
            id.to_owned(),
            "none".to_owned(),
            None,
            None
        ))
    );
    checks_clean(&pool).await;

    let schema_after = schema(&pool).await;
    let gone: BTreeSet<&SchemaRow> = schema_before.difference(&schema_after).collect();
    let new: BTreeSet<&SchemaRow> = schema_after.difference(&schema_before).collect();
    // Gone: only the old text of `shifts`.
    let old_shifts = object(&schema_before, "table", "shifts");
    assert_eq!(gone, BTreeSet::from([old_shifts]));
    // New: its new text, the three triggers, the index of planned duplicate
    // templates, the events table with its key's index and its two indexes.
    let names = [
        ("table", "shifts"),
        ("trigger", "shifts_validation_print_insert"),
        ("trigger", "shifts_validation_print_update"),
        ("trigger", "shifts_mode_frozen"),
        ("index", "shifts_planned_duplicate_template"),
        ("table", "unit_label_events"),
        ("index", "sqlite_autoindex_unit_label_events_1"),
        ("index", "unit_label_events_record"),
        ("index", "unit_label_events_shift"),
    ];
    assert_eq!(
        new,
        names
            .iter()
            .map(|(kind, name)| object(&schema_after, kind, name))
            .collect::<BTreeSet<_>>()
    );
    // `shifts`: the text it had, the three column definitions appended as
    // `ALTER TABLE` appends them.
    // (after its last column, `0016`'s, before its table constraints).
    let old_sql = old_shifts.3.as_deref().unwrap();
    let last = "rev INTEGER NOT NULL, pallet_sheet_template_id TEXT,\n";
    assert_eq!(old_sql.matches(last).count(), 1);
    assert_eq!(
        object(&schema_after, "table", "shifts")
            .3
            .as_deref()
            .unwrap(),
        old_sql.replace(
            last,
            "rev INTEGER NOT NULL, pallet_sheet_template_id TEXT, \
             validation_print_mode TEXT NOT NULL DEFAULT 'none'\n  \
             CHECK (validation_print_mode IN ('none', 'duplicate_dm')), \
             validation_print_verification TEXT\n  \
             CHECK (validation_print_verification IS NULL\n    \
             OR validation_print_verification IN ('none', 'required')), \
             validation_print_template_id TEXT,\n"
        )
    );
    for (name, event) in [
        ("shifts_validation_print_insert", "BEFORE INSERT ON shifts"),
        (
            "shifts_validation_print_update",
            "BEFORE UPDATE OF mode, validation_print_mode, validation_print_verification,\n  \
             validation_print_template_id ON shifts",
        ),
        (
            "shifts_mode_frozen",
            "BEFORE UPDATE OF mode, validation_print_mode, validation_print_verification,\n  \
             validation_print_template_id ON shifts",
        ),
    ] {
        let row = object(&schema_after, "trigger", name);
        assert_eq!(row.2, "shifts");
        let sql = row.3.as_deref().unwrap();
        assert!(sql.contains(event), "{sql}");
    }
    let index_sql = |name: &str| object(&schema_after, "index", name).3.clone();
    assert_eq!(
        index_sql("shifts_planned_duplicate_template").as_deref(),
        Some(
            "CREATE INDEX shifts_planned_duplicate_template ON shifts \
             (validation_print_template_id)\n  \
             WHERE status = 'planned' AND validation_print_template_id IS NOT NULL"
        )
    );
    assert_eq!(
        index_sql("unit_label_events_record").as_deref(),
        Some("CREATE UNIQUE INDEX unit_label_events_record ON unit_label_events (device_id, record_id)")
    );
    assert_eq!(
        index_sql("unit_label_events_shift").as_deref(),
        Some("CREATE INDEX unit_label_events_shift ON unit_label_events (shift_id, job_id)")
    );
    assert_eq!(
        columns(&pool, "unit_label_events").await,
        [
            "id",
            "record_id",
            "device_id",
            "shift_id",
            "operator_id",
            "job_id",
            "code_hash",
            "attempt_no",
            "event",
            "reason",
            "error_code",
            "payload_digest",
            "bytes_digest",
            "at",
            "received_at",
        ]
    );
    let keys: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT \"from\", \"table\", \"to\" FROM pragma_foreign_key_list('unit_label_events') \
         ORDER BY \"from\"",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        keys,
        [("device_id", "devices", "id"), ("shift_id", "shifts", "id")].map(|(from, table, to)| (
            from.to_owned(),
            table.to_owned(),
            to.to_owned()
        ))
    );
    let temp: Vec<String> = sqlx::query_scalar("SELECT name FROM temp.sqlite_master")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(temp.is_empty(), "{temp:?}");
}

/// The cloud's `shifts_validation_print_policy_check`: no policy (no
/// verification, no template), or a duplicate in a validation shift with
/// both. The column CHECKs keep the two words to their lists.
#[tokio::test]
async fn an_insert_takes_only_a_consistent_policy() {
    let (_dir, pool) = migrated().await;
    let refused_cases = [
        ("aggregation", ("'duplicate_dm'", "'none'", "'template-d'")),
        (
            "aggregation",
            ("'duplicate_dm'", "'required'", "'template-d'"),
        ),
        ("validation", ("'duplicate_dm'", "NULL", "'template-d'")),
        ("validation", ("'duplicate_dm'", "'required'", "NULL")),
        ("validation", ("'duplicate_dm'", "NULL", "NULL")),
        ("validation", ("'none'", "'required'", "NULL")),
        ("validation", ("'none'", "'none'", "NULL")),
        ("validation", ("'none'", "NULL", "'template-d'")),
        ("aggregation", ("'none'", "'none'", "NULL")),
        ("aggregation", ("'none'", "NULL", "'template-d'")),
    ];
    for (seq, (mode, policy)) in (10..).zip(refused_cases) {
        refused(
            planned(&pool, "shift-x", seq, mode, policy).await,
            POLICY,
            &format!("{mode} {policy:?}"),
        );
    }
    for (seq, (mode, policy, constraint)) in (30..).zip([
        ("validation", ("'printed'", "NULL", "NULL"), "CHECK"),
        (
            "validation",
            ("'duplicate_dm'", "'maybe'", "'template-d'"),
            "CHECK",
        ),
        ("validation", ("NULL", "NULL", "NULL"), "NOT NULL"),
    ]) {
        refused(
            planned(&pool, "shift-x", seq, mode, policy).await,
            constraint,
            &format!("{mode} {policy:?}"),
        );
    }
    let taken = [
        ("shift-1", "aggregation", ("'none'", "NULL", "NULL")),
        ("shift-2", "validation", ("'none'", "NULL", "NULL")),
        (
            "shift-3",
            "validation",
            ("'duplicate_dm'", "'none'", "'template-d'"),
        ),
        (
            "shift-4",
            "validation",
            ("'duplicate_dm'", "'required'", "'template-d'"),
        ),
    ];
    for (seq, (id, mode, policy)) in (50..).zip(taken) {
        planned(&pool, id, seq, mode, policy)
            .await
            .unwrap_or_else(|error| panic!("{mode} {policy:?}: {error}"));
    }
    // A write that names no policy takes the default, which is none.
    execute(
        &pool,
        &[&shift_0020("shift-5", 60, "planned", "validation")],
    )
    .await;
    assert_eq!(
        policy_of(&pool, "shift-5").await,
        ("validation".to_owned(), "none".to_owned(), None, None)
    );
    checks_clean(&pool).await;
}

/// The same rule on every update of one of its four columns: each column
/// alone cannot break it, and all of them together change it whole.
#[tokio::test]
async fn an_update_keeps_the_policy_consistent() {
    let (_dir, pool) = migrated().await;
    planned(
        &pool,
        "shift-d",
        10,
        "validation",
        ("'duplicate_dm'", "'required'", "'template-d'"),
    )
    .await
    .unwrap();
    for statement in [
        "UPDATE shifts SET mode = 'aggregation' WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_mode = 'none' WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_verification = NULL WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_template_id = NULL WHERE id = 'shift-d'",
    ] {
        refused(run(&pool, statement).await, POLICY, statement);
    }
    // A shift with no policy takes no half of one.
    for statement in [
        "UPDATE shifts SET validation_print_mode = 'duplicate_dm' WHERE id = 'shift-pv'",
        "UPDATE shifts SET validation_print_verification = 'none' WHERE id = 'shift-pv'",
        "UPDATE shifts SET validation_print_template_id = 'template-d' WHERE id = 'shift-pv'",
    ] {
        refused(run(&pool, statement).await, POLICY, statement);
    }
    assert_eq!(
        policy_of(&pool, "shift-d").await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("required".to_owned()),
            Some("template-d".to_owned())
        )
    );
    // Whole: a planned shift drops its policy and becomes an aggregation
    // shift, and takes it back.
    execute(
        &pool,
        &[
            "UPDATE shifts SET validation_print_mode = 'none', \
             validation_print_verification = NULL, validation_print_template_id = NULL \
             WHERE id = 'shift-d'",
            "UPDATE shifts SET mode = 'aggregation' WHERE id = 'shift-d'",
            "UPDATE shifts SET mode = 'validation', validation_print_mode = 'duplicate_dm', \
             validation_print_verification = 'none', validation_print_template_id = 'template-e' \
             WHERE id = 'shift-d'",
            "UPDATE shifts SET validation_print_verification = 'required' WHERE id = 'shift-d'",
            "UPDATE shifts SET validation_print_template_id = 'template-f' WHERE id = 'shift-d'",
        ],
    )
    .await;
    assert_eq!(
        policy_of(&pool, "shift-d").await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("required".to_owned()),
            Some("template-f".to_owned())
        )
    );
    checks_clean(&pool).await;
}

/// The mode and the policy of a shift change only while it is planned and
/// has no scan: an open shift's snapshot holds them, and the box rule of
/// `0020` reads the mode of a shift whose scans it already took. A write of
/// the same value (the office's edit writes every field) is no change.
#[tokio::test]
async fn an_open_or_scanned_shift_keeps_its_mode_and_policy() {
    let (_dir, pool) = migrated().await;
    // An open validation shift with a policy, and one without a scan.
    execute(
        &pool,
        &[
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, validation_print_mode, \
             validation_print_verification, validation_print_template_id, created_at, rev) \
             VALUES ('shift-d', 'OCT26', 10, 'office', 'office_user', 'user-1', 'active', \
             'validation', 'product-1', 'line-1', '2026-10-09', 12, 'template-1', 'device-1', \
             '{}', '2026-10-09T08:00:00Z', 'duplicate_dm', 'none', 'template-d', \
             '2026-10-08T17:00:00Z', 1)",
            &shift_0020("shift-e", 11, "active", "aggregation"),
        ],
    )
    .await;
    // Open (with scans or without), closed, or planned with a scan: frozen.
    run(
        &pool,
        "UPDATE shifts SET status = 'closed', closed_at = '2026-10-09T18:00:00Z', \
         closed_by_kind = 'office_user', closed_by = 'user-1' WHERE id = 'shift-a'",
    )
    .await
    .unwrap();
    run(
        &pool,
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
         scanned_at, received_at) VALUES ('scan-9', 'record-9', 'device-1', 'shift-pa', \
         'invalid', 'unknown', 5, '2026-10-09T12:00:00.000Z', '2026-10-09T12:00:01Z')",
    )
    .await
    .unwrap();
    for statement in [
        "UPDATE shifts SET mode = 'validation' WHERE id = 'shift-e'",
        "UPDATE shifts SET mode = 'aggregation' WHERE id = 'shift-v'",
        "UPDATE shifts SET mode = 'validation' WHERE id = 'shift-a'",
        "UPDATE shifts SET mode = 'validation' WHERE id = 'shift-pa'",
        "UPDATE shifts SET validation_print_mode = 'none', validation_print_verification = NULL, \
         validation_print_template_id = NULL WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_verification = 'required' WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_template_id = 'template-e' WHERE id = 'shift-d'",
        "UPDATE shifts SET validation_print_mode = 'duplicate_dm', \
         validation_print_verification = 'none', validation_print_template_id = 'template-d' \
         WHERE id = 'shift-v'",
    ] {
        refused(run(&pool, statement).await, FROZEN, statement);
    }
    // The same values, written again, and every other column: taken.
    execute(
        &pool,
        &[
            "UPDATE shifts SET mode = mode, validation_print_mode = validation_print_mode, \
             validation_print_verification = validation_print_verification, \
             validation_print_template_id = validation_print_template_id, rev = 2",
            "UPDATE shifts SET planned_qty = 100, rev = 3 WHERE id = 'shift-d'",
        ],
    )
    .await;
    // A planned shift without a scan changes its mode.
    execute(
        &pool,
        &["UPDATE shifts SET mode = 'aggregation' WHERE id = 'shift-pv'"],
    )
    .await;
    assert_eq!(policy_of(&pool, "shift-pv").await.0, "aggregation");
    assert_eq!(policy_of(&pool, "shift-e").await.0, "aggregation");
    checks_clean(&pool).await;
}

/// A missing print mode cannot skip the rule: with `OR REPLACE` SQLite puts
/// the column's default (`none`) in place of a NULL after the triggers ran,
/// so a trigger that compared with `=` saw NULL, skipped, and the row kept a
/// verification or a template without a policy.
#[tokio::test]
async fn a_missing_print_mode_does_not_slip_past_the_rule() {
    let (_dir, pool) = migrated().await;
    for (seq, policy) in (10..).zip([
        ("NULL", "'required'", "NULL"),
        ("NULL", "'none'", "NULL"),
        ("NULL", "NULL", "'template-d'"),
        ("NULL", "'required'", "'template-d'"),
    ]) {
        let (print_mode, verification, template) = policy;
        refused(
            run(
                &pool,
                &format!(
                    "INSERT OR REPLACE INTO shifts (id, number_month_key, number_seq, \
                     created_from, created_by_kind, created_by, status, mode, product_id, \
                     line_id, production_date, box_capacity, box_template_id, \
                     validation_print_mode, validation_print_verification, \
                     validation_print_template_id, created_at, rev) \
                     VALUES ('shift-x', 'NOV26', {seq}, 'office', 'office_user', 'user-1', \
                     'planned', 'validation', 'product-1', 'line-1', '2026-11-02', 12, \
                     'template-1', {print_mode}, {verification}, {template}, \
                     '2026-11-01T17:00:00Z', 1)"
                ),
            )
            .await,
            POLICY,
            &format!("insert or replace {policy:?}"),
        );
    }
    planned(
        &pool,
        "shift-d",
        20,
        "validation",
        ("'duplicate_dm'", "'required'", "'template-d'"),
    )
    .await
    .unwrap();
    refused(
        run(
            &pool,
            "UPDATE OR REPLACE shifts SET validation_print_mode = NULL WHERE id = 'shift-d'",
        )
        .await,
        POLICY,
        "update or replace to a missing print mode",
    );
    // Without a policy, a missing print mode is none, as it always was.
    run(
        &pool,
        "INSERT OR REPLACE INTO shifts (id, number_month_key, number_seq, created_from, \
         created_by_kind, created_by, status, mode, product_id, line_id, production_date, \
         box_capacity, box_template_id, validation_print_mode, \
         validation_print_verification, validation_print_template_id, created_at, rev) \
         VALUES ('shift-n', 'NOV26', 30, 'office', 'office_user', 'user-1', 'planned', \
         'validation', 'product-1', 'line-1', '2026-11-02', 12, 'template-1', NULL, NULL, \
         NULL, '2026-11-01T17:00:00Z', 1)",
    )
    .await
    .unwrap();
    assert_eq!(
        policy_of(&pool, "shift-n").await,
        ("validation".to_owned(), "none".to_owned(), None, None)
    );
    assert_eq!(
        policy_of(&pool, "shift-d").await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("required".to_owned()),
            Some("template-d".to_owned())
        )
    );
    checks_clean(&pool).await;
}

/// The statement that opens a shift cannot change its mode or policy on the
/// way: a planned shift is judged by what it becomes as well. The host's
/// entry (`device_shifts`) names none of them, and is taken; a planned
/// shift with a scan keeps its policy as it keeps its mode.
#[tokio::test]
async fn the_opening_statement_and_a_scanned_planned_shift_keep_the_policy() {
    let (_dir, pool) = migrated().await;
    planned(
        &pool,
        "shift-d",
        10,
        "validation",
        ("'duplicate_dm'", "'none'", "'template-d'"),
    )
    .await
    .unwrap();
    for statement in [
        "UPDATE shifts SET status = 'active', owner_device_id = 'device-1', snapshot = '{}', \
         opened_at = '2026-11-02T08:00:00Z', validation_print_verification = 'required' \
         WHERE id = 'shift-d'",
        "UPDATE shifts SET status = 'active', owner_device_id = 'device-1', snapshot = '{}', \
         opened_at = '2026-11-02T08:00:00Z', mode = 'aggregation', \
         validation_print_mode = 'none', validation_print_verification = NULL, \
         validation_print_template_id = NULL WHERE id = 'shift-d'",
        "UPDATE shifts SET status = 'active', owner_device_id = 'device-1', snapshot = '{}', \
         opened_at = '2026-11-02T08:00:00Z', mode = 'validation' WHERE id = 'shift-pa'",
    ] {
        refused(run(&pool, statement).await, FROZEN, statement);
    }
    // A planned shift with a policy and a scan: its policy, not only its mode.
    planned(
        &pool,
        "shift-s",
        11,
        "validation",
        ("'duplicate_dm'", "'none'", "'template-d'"),
    )
    .await
    .unwrap();
    run(
        &pool,
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
         scanned_at, received_at) VALUES ('scan-9', 'record-9', 'device-1', 'shift-s', \
         'invalid', 'unknown', 5, '2026-11-02T12:00:00.000Z', '2026-11-02T12:00:01Z')",
    )
    .await
    .unwrap();
    for statement in [
        "UPDATE shifts SET validation_print_verification = 'required' WHERE id = 'shift-s'",
        "UPDATE shifts SET validation_print_template_id = 'template-e' WHERE id = 'shift-s'",
        "UPDATE shifts SET validation_print_mode = 'none', validation_print_verification = NULL, \
         validation_print_template_id = NULL WHERE id = 'shift-s'",
    ] {
        refused(run(&pool, statement).await, FROZEN, statement);
    }
    // The entry's own statement, as `device_shifts` writes it.
    run(
        &pool,
        "UPDATE shifts SET status = 'active', snapshot = '{}', \
         opened_at = '2026-11-02T08:00:00Z', owner_device_id = 'device-1', rev = 2 \
         WHERE id = 'shift-d'",
    )
    .await
    .unwrap();
    assert_eq!(
        policy_of(&pool, "shift-d").await,
        (
            "validation".to_owned(),
            "duplicate_dm".to_owned(),
            Some("none".to_owned()),
            Some("template-d".to_owned())
        )
    );
    assert_eq!(policy_of(&pool, "shift-pa").await.0, "aggregation");
    checks_clean(&pool).await;
}

/// One event of a label job, every value a SQL literal; the defaults make a
/// valid `sent` of attempt 1.
struct Event<'a> {
    record: &'a str,
    device: &'a str,
    shift: &'a str,
    code_hash: &'a str,
    attempt: &'a str,
    event: &'a str,
    reason: &'a str,
    error_code: &'a str,
    payload_digest: &'a str,
    bytes_digest: &'a str,
}

const SENT: Event<'static> = Event {
    record: "'record-1'",
    device: "'device-1'",
    shift: "'shift-v'",
    code_hash: "printf('%064x', 2)",
    attempt: "1",
    event: "'sent'",
    reason: "NULL",
    error_code: "NULL",
    payload_digest: "printf('%064x', 3)",
    bytes_digest: "printf('%064x', 4)",
};

async fn event(pool: &SqlitePool, id: &str, event: &Event<'_>) -> Result<(), sqlx::Error> {
    let Event {
        record,
        device,
        shift,
        code_hash,
        attempt,
        event,
        reason,
        error_code,
        payload_digest,
        bytes_digest,
    } = event;
    run(
        pool,
        &format!(
            "INSERT INTO unit_label_events (id, record_id, device_id, shift_id, operator_id, \
             job_id, code_hash, attempt_no, event, reason, error_code, payload_digest, \
             bytes_digest, at, received_at) \
             VALUES ('{id}', {record}, {device}, {shift}, 'operator-1', \
             'aaaaaaaa-0000-4000-8000-000000000001', {code_hash}, {attempt}, {event}, {reason}, \
             {error_code}, {payload_digest}, {bytes_digest}, '2026-10-09T11:00:02.000Z', \
             '2026-10-09T11:00:03Z')"
        ),
    )
    .await
}

/// What no event row may break: hashes of 64 lowercase hex digits, an
/// attempt from 1, the domain's events, a reprint's reason exactly on the
/// `prepared` event of a later attempt, an error code exactly on the events
/// that have one and from that event's list, a known station and shift, and
/// one row per record of a station.
#[tokio::test]
async fn an_event_row_holds_the_rules_of_the_fact() {
    let (_dir, pool) = migrated().await;
    let upper = "upper(printf('%064x', 171))";
    let short = "printf('%063x', 3)";
    let long = "printf('%065x', 3)";
    let not_hex = "printf('%063x', 3) || 'g'";
    let mut n = 0;
    let mut id = || {
        n += 1;
        format!("event-{n}")
    };
    // Taken: each event without anything, each error event with each code
    // of its list, each reason on a reprint's `prepared`.
    let mut taken = vec![
        Event { ..SENT },
        Event {
            event: "'prepared'",
            ..SENT
        },
        Event {
            event: "'sending'",
            ..SENT
        },
        Event {
            event: "'verified'",
            ..SENT
        },
        Event {
            event: "'verification_skipped'",
            ..SENT
        },
    ];
    for (name, codes) in [
        (
            "'failed_before_send'",
            &["'printer_unconfigured'", "'printer_changed'"][..],
        ),
        (
            "'delivery_unknown'",
            &[
                "'transport_failed'",
                "'persistence_failed'",
                "'interrupted'",
            ][..],
        ),
        ("'verification_rejected'", &["'invalid'", "'mismatch'"][..]),
    ] {
        for code in codes {
            taken.push(Event {
                event: name,
                error_code: code,
                ..SENT
            });
        }
    }
    for reason in ["'not_printed'", "'damaged'", "'lost'"] {
        taken.push(Event {
            attempt: "2",
            event: "'prepared'",
            reason,
            ..SENT
        });
    }
    taken.push(Event {
        attempt: "2",
        ..SENT
    });
    for (index, row) in taken.iter().enumerate() {
        let record = format!("'record-taken-{index}'");
        event(
            &pool,
            &id(),
            &Event {
                record: &record,
                ..*row
            },
        )
        .await
        .unwrap_or_else(|error| panic!("{index}: {error}"));
    }
    // Refused by a CHECK.
    let refused_rows = [
        (
            "code hash in capitals",
            Event {
                code_hash: upper,
                ..SENT
            },
        ),
        (
            "short code hash",
            Event {
                code_hash: short,
                ..SENT
            },
        ),
        (
            "long code hash",
            Event {
                code_hash: long,
                ..SENT
            },
        ),
        (
            "code hash not hex",
            Event {
                code_hash: not_hex,
                ..SENT
            },
        ),
        (
            "payload digest in capitals",
            Event {
                payload_digest: upper,
                ..SENT
            },
        ),
        (
            "short payload digest",
            Event {
                payload_digest: short,
                ..SENT
            },
        ),
        (
            "long payload digest",
            Event {
                payload_digest: long,
                ..SENT
            },
        ),
        (
            "payload digest not hex",
            Event {
                payload_digest: not_hex,
                ..SENT
            },
        ),
        (
            "bytes digest in capitals",
            Event {
                bytes_digest: upper,
                ..SENT
            },
        ),
        (
            "short bytes digest",
            Event {
                bytes_digest: short,
                ..SENT
            },
        ),
        (
            "long bytes digest",
            Event {
                bytes_digest: long,
                ..SENT
            },
        ),
        (
            "bytes digest not hex",
            Event {
                bytes_digest: not_hex,
                ..SENT
            },
        ),
        (
            "attempt 0",
            Event {
                attempt: "0",
                ..SENT
            },
        ),
        (
            "unknown event",
            Event {
                event: "'printed'",
                ..SENT
            },
        ),
        (
            "reason on the first prepared",
            Event {
                event: "'prepared'",
                reason: "'lost'",
                ..SENT
            },
        ),
        (
            "reason on a reprint's sent",
            Event {
                attempt: "2",
                reason: "'lost'",
                ..SENT
            },
        ),
        (
            "reprint without a reason",
            Event {
                attempt: "2",
                event: "'prepared'",
                ..SENT
            },
        ),
        (
            "unknown reason",
            Event {
                attempt: "2",
                event: "'prepared'",
                reason: "'torn'",
                ..SENT
            },
        ),
        (
            "error code on sent",
            Event {
                error_code: "'interrupted'",
                ..SENT
            },
        ),
        (
            "error code on verified",
            Event {
                event: "'verified'",
                error_code: "'mismatch'",
                ..SENT
            },
        ),
        (
            "failed without a code",
            Event {
                event: "'failed_before_send'",
                ..SENT
            },
        ),
        (
            "unknown without a code",
            Event {
                event: "'delivery_unknown'",
                ..SENT
            },
        ),
        (
            "rejected without a code",
            Event {
                event: "'verification_rejected'",
                ..SENT
            },
        ),
        (
            "failed with another event's code",
            Event {
                event: "'failed_before_send'",
                error_code: "'interrupted'",
                ..SENT
            },
        ),
        (
            "unknown with another event's code",
            Event {
                event: "'delivery_unknown'",
                error_code: "'mismatch'",
                ..SENT
            },
        ),
        (
            "rejected with another event's code",
            Event {
                event: "'verification_rejected'",
                error_code: "'printer_changed'",
                ..SENT
            },
        ),
        (
            "failed with an unknown code",
            Event {
                event: "'failed_before_send'",
                error_code: "'paper_out'",
                ..SENT
            },
        ),
        (
            "unknown with an unknown code",
            Event {
                event: "'delivery_unknown'",
                error_code: "'paper_out'",
                ..SENT
            },
        ),
        (
            "rejected with an unknown code",
            Event {
                event: "'verification_rejected'",
                error_code: "'paper_out'",
                ..SENT
            },
        ),
        (
            "unknown code on sent",
            Event {
                error_code: "'paper_out'",
                ..SENT
            },
        ),
    ];
    for (what, row) in &refused_rows {
        refused(
            event(&pool, &id(), row).await,
            "CHECK constraint failed",
            what,
        );
    }
    // A record of a station once; the same record of another station is its own.
    event(&pool, &id(), &SENT).await.unwrap();
    refused(
        event(&pool, &id(), &SENT).await,
        "UNIQUE constraint failed",
        "the same record",
    );
    // Keys: a known station and shift.
    for (what, row) in [
        (
            "unknown station",
            Event {
                record: "'record-x'",
                device: "'device-x'",
                ..SENT
            },
        ),
        (
            "unknown shift",
            Event {
                record: "'record-y'",
                shift: "'shift-x'",
                ..SENT
            },
        ),
    ] {
        refused(
            event(&pool, &id(), &row).await,
            "FOREIGN KEY constraint failed",
            what,
        );
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM unit_label_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, i64::try_from(taken.len()).unwrap() + 1);
    checks_clean(&pool).await;
}

/// The statements part B runs on `shifts` and `unit_label_events` search by
/// an index: the planned shifts that print their duplicates with a template
/// (`shifts_planned_duplicate_template`); the delete and switch-off guard of
/// a template (`template_in_use`) with the duplicate's template beside the
/// box and pallet ones, which SQLite answers from the planned shifts by
/// status as it does today; a shift's events by job, and a station's record.
#[tokio::test]
async fn the_planned_template_and_the_events_of_a_shift_search_by_an_index() {
    let (_dir, pool) = migrated().await;
    for (name, sql, index) in [
        (
            "duplicate template",
            "SELECT id FROM shifts WHERE validation_print_template_id = ?1 \
             AND status = 'planned' ORDER BY id",
            Some("shifts_planned_duplicate_template"),
        ),
        (
            "any template",
            "SELECT id FROM shifts WHERE (box_template_id = ?1 OR pallet_template_id = ?1 \
             OR validation_print_template_id = ?1) AND status = 'planned' ORDER BY id",
            None,
        ),
        (
            "events of a shift",
            "SELECT job_id, event FROM unit_label_events WHERE shift_id = ?1 ORDER BY job_id",
            Some("unit_label_events_shift"),
        ),
        (
            "events of a job",
            "SELECT event FROM unit_label_events WHERE shift_id = ?1 AND job_id = ?1",
            Some("unit_label_events_shift"),
        ),
        (
            "a station's record",
            "SELECT id FROM unit_label_events WHERE device_id = ?1 AND record_id = ?1",
            Some("unit_label_events_record"),
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("x")
                .fetch_all(&pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        if let Some(index) = index {
            assert!(
                steps.iter().any(|step| step.contains(index)),
                "{name} does not use {index}: {steps:?}"
            );
        }
    }
}

/// A copy made at `0020` (or a host that never ran `0021`) takes it on the
/// next start through `db::open`, data and all.
#[tokio::test]
async fn a_host_at_0020_takes_0021_on_its_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.db");
    {
        let pool = pool(&path).await;
        through_0020().run(&pool).await.unwrap();
        seed(&pool).await;
        pool.close().await;
    }
    let pool = markiro_host::db::open(&path).await.unwrap();
    assert_eq!(applied(&pool).await.len(), MIGRATOR.iter().count());
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM shifts WHERE validation_print_mode = 'none'), \
         (SELECT COUNT(*) FROM scans), (SELECT COUNT(*) FROM unit_label_events)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (4, 3, 0));
    checks_clean(&pool).await;
}
