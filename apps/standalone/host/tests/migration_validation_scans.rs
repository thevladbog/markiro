//! Migration `0020` (plan РЕЖ, part A): an accepted scan of a validation
//! shift has no box. `scans` and `code_owners` are rebuilt, the children of
//! `scans` (`box_items`, `code_conflicts`) are re-created as they were, and
//! "an accepted scan of an aggregation shift names its box" moves from a
//! CHECK to triggers keyed by the shift's mode. The database is built at
//! `0019` and migrated by the host's own `MIGRATOR` on a pool of
//! `db::options` (foreign keys on), so these tests prove what sqlx does.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use tempfile::TempDir;

/// The tables the migration rebuilds or re-creates, each with its key.
const TABLES: [(&str, &str); 4] = [
    ("scans", "id"),
    ("box_items", "scan_id"),
    ("code_owners", "code_hash"),
    ("code_conflicts", "id"),
];

/// Every migration before `0020`.
fn through_0019() -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version < 20)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// One connection, so a `PRAGMA` a test sets holds for its next statement.
async fn pool(path: &Path, foreign_keys: bool) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            options(path)
                .create_if_missing(true)
                .foreign_keys(foreign_keys),
        )
        .await
        .unwrap()
}

/// A database at `0019`, foreign keys as asked.
async fn at_0019(foreign_keys: bool) -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db"), foreign_keys).await;
    let old = through_0019();
    assert_eq!(
        old.iter().map(|migration| migration.version).max(),
        Some(19)
    );
    old.run(&pool).await.unwrap();
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
     VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), '0.1.0', 3, \
     '2026-10-01T08:00:00Z')",
    "INSERT INTO products (id, gtin14, name, rev) \
     VALUES ('product-1', '04600682000013', 'Сок яблочный', 1)",
];

/// An open shift of `mode` with one box `box_id`.
fn shift(id: &str, seq: i64, mode: &str, box_id: &str) -> [String; 2] {
    [
        format!(
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
             VALUES ('{id}', 'OCT26', {seq}, 'office', 'office_user', 'user-1', 'active', '{mode}', \
             'product-1', 'line-1', '2026-10-09', 12, 'template-1', 'device-1', '{{}}', \
             '2026-10-09T08:00:00Z', '2026-10-08T17:00:00Z', 1)"
        ),
        format!(
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
             VALUES ('{box_id}', '{id}', 'device-1', '2026-10-09T10:00:00.000Z', \
             '2026-10-09T10:00:01Z')"
        ),
    ]
}

/// The facts of an aggregation shift as `0019` holds them: an accepted scan
/// in its box that owns its code, a duplicate, an invalid scan, and a later
/// accepted scan of the same code that lost it (displaced item, conflict).
/// The canonical text keeps its GS1 group separator.
const FACTS: [&str; 8] = [
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, \
     raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at) \
     VALUES ('scan-1', 'record-1', 'device-1', 'shift-a', 'ok', NULL, 'km', 38, printf('%064x', 1), \
     '04600682000013', 'B0000001', '010460068200001321B0000001' || char(29) || '93Zz', 'box-1', \
     'operator-1', '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:01Z')",
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, \
     raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at) \
     VALUES ('scan-2', 'record-2', 'device-1', 'shift-a', 'duplicate', 'local', 'km', 38, \
     printf('%064x', 1), '04600682000013', 'B0000001', \
     '010460068200001321B0000001' || char(29) || '93Zz', NULL, 'operator-1', \
     '2026-10-09T10:00:05.000Z', '2026-10-09T10:00:06Z')",
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, \
     raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at) \
     VALUES ('scan-3', 'record-3', 'device-1', 'shift-a', 'invalid', NULL, 'unknown', 12, NULL, \
     NULL, NULL, NULL, NULL, NULL, '2026-10-09T10:00:07.000Z', '2026-10-09T10:00:08Z')",
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, \
     raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at) \
     VALUES ('scan-4', 'record-4', 'device-1', 'shift-a', 'ok', NULL, 'km', 38, printf('%064x', 1), \
     '04600682000013', 'B0000001', '010460068200001321B0000001' || char(29) || '93Zz', 'box-1', \
     'operator-1', '2026-10-09T10:00:09.000Z', '2026-10-09T10:00:10Z')",
    "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at, displaced_at) \
     VALUES ('scan-1', 'box-1', printf('%064x', 1), '2026-10-09T10:00:00.000Z', NULL, NULL)",
    "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at, displaced_at) \
     VALUES ('scan-4', 'box-1', printf('%064x', 1), '2026-10-09T10:00:09.000Z', NULL, \
     '2026-10-09T10:00:10Z')",
    "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
     VALUES (printf('%064x', 1), 'scan-1', 'shift-a', 'device-1', 'box-1', \
     '2026-10-09T10:00:00.000Z')",
    "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at, \
     reviewed_at) VALUES ('conflict-1', printf('%064x', 1), 'scan-1', 'scan-4', \
     '2026-10-09T10:00:10Z', NULL)",
];

async fn seed(pool: &SqlitePool) {
    execute(pool, &PARENTS).await;
    let [shift_row, box_row] = shift("shift-a", 1, "aggregation", "box-1");
    execute(pool, &[&shift_row, &box_row]).await;
    execute(pool, &FACTS).await;
}

/// Rows of each of the four tables whose rowids leave a gap before a later
/// row (a row taken and deleted between two others), the later row first by
/// its key: a copy that dropped the rowid would renumber the later rows, and
/// one in key order would reorder them.
const GAPS: [&str; 15] = [
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
     scanned_at, received_at) VALUES ('scan-x', 'record-x', 'device-1', 'shift-a', 'invalid', \
     'unknown', 5, '2026-10-09T10:01:00.000Z', '2026-10-09T10:01:01Z')",
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
     scanned_at, received_at) VALUES ('scan-0', 'record-0', 'device-1', 'shift-a', 'invalid', \
     'unknown', 6, '2026-10-09T10:02:00.000Z', '2026-10-09T10:02:01Z')",
    "DELETE FROM scans WHERE id = 'scan-x'",
    "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at) VALUES ('scan-3', \
     'box-1', printf('%064x', 9), '2026-10-09T10:01:00.000Z', '2026-10-09T10:01:30.000Z')",
    "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at) VALUES ('scan-2', \
     'box-1', printf('%064x', 8), '2026-10-09T10:02:00.000Z', '2026-10-09T10:02:30.000Z')",
    "DELETE FROM box_items WHERE scan_id = 'scan-3'",
    "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
     VALUES (printf('%064x', 9), 'scan-3', 'shift-a', 'device-1', 'box-1', \
     '2026-10-09T10:01:00.000Z')",
    "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
     VALUES (printf('%064x', 0), 'scan-2', 'shift-a', 'device-1', 'box-1', \
     '2026-10-09T10:02:00.000Z')",
    "DELETE FROM code_owners WHERE scan_id = 'scan-3'",
    "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
     VALUES ('conflict-x', printf('%064x', 1), 'scan-1', 'scan-2', '2026-10-09T10:01:00Z')",
    "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
     VALUES ('conflict-0', printf('%064x', 1), 'scan-1', 'scan-3', '2026-10-09T10:02:00Z')",
    "DELETE FROM code_conflicts WHERE id = 'conflict-x'",
    // And one row more of each after the gap, so the gap is not the last.
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
     scanned_at, received_at) VALUES ('scan-5', 'record-5', 'device-1', 'shift-a', 'invalid', \
     'unknown', 7, '2026-10-09T10:03:00.000Z', '2026-10-09T10:03:01Z')",
    "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at) VALUES ('scan-5', \
     'box-1', printf('%064x', 7), '2026-10-09T10:03:00.000Z', '2026-10-09T10:03:30.000Z')",
    "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
     VALUES ('conflict-5', printf('%064x', 1), 'scan-1', 'scan-5', '2026-10-09T10:03:00Z')",
];

/// The rowids of `table`, in order.
async fn rowids(pool: &SqlitePool, table: &str) -> Vec<i64> {
    sqlx::query_scalar(&format!("SELECT rowid FROM {table} ORDER BY rowid"))
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Every row of `table` by its key, its rowid first, each value as SQLite
/// quotes it (so a text, an integer and a blob never read alike).
async fn rows(pool: &SqlitePool, table: &str, key: &str) -> Vec<String> {
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
            .bind(table)
            .fetch_all(pool)
            .await
            .unwrap();
    assert!(!columns.is_empty(), "{table}");
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

/// An accepted (or other) scan of code `n` at 11:00, into `box_id` or none.
async fn scan(
    pool: &SqlitePool,
    id: &str,
    shift: &str,
    verdict: &str,
    box_id: Option<&str>,
    n: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
         raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
         scanned_at, received_at) \
         VALUES (?1, ?1, 'device-1', ?2, ?3, CASE ?3 WHEN 'duplicate' THEN 'host' END, 'km', 38, \
         printf('%064x', ?5), '04600682000013', printf('B%07d', ?5), \
         printf('0104600682000013' || '21B%07d' || char(29) || '93Zz', ?5), ?4, NULL, \
         '2026-10-09T11:00:00.000Z', '2026-10-09T11:00:01Z')",
    )
    .bind(id)
    .bind(shift)
    .bind(verdict)
    .bind(box_id)
    .bind(n)
    .execute(pool)
    .await
    .map(|_| ())
}

fn refused(result: Result<(), sqlx::Error>, expected: &str) {
    let error = result.expect_err("the write was taken");
    assert!(error.to_string().contains(expected), "{error}");
}

async fn applied(pool: &SqlitePool) -> Vec<i64> {
    sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_rebuild_keeps_every_row_and_every_object_but_the_rule_it_moves() {
    assert!(
        MIGRATOR.iter().any(|migration| migration.version == 20),
        "no migration 0020"
    );
    let (_dir, pool) = at_0019(true).await;
    seed(&pool).await;
    execute(&pool, &GAPS).await;
    let mut before = Vec::new();
    let mut rowids_before = Vec::new();
    for (table, key) in TABLES {
        before.push(rows(&pool, table, key).await);
        rowids_before.push(rowids(&pool, table).await);
    }
    assert_eq!(
        before.iter().map(Vec::len).collect::<Vec<_>>(),
        [6, 4, 2, 3]
    );
    // Each table's rowids have a gap before a later row.
    assert_eq!(
        rowids_before,
        [
            vec![1, 2, 3, 4, 6, 7],
            vec![1, 2, 4, 5],
            vec![1, 3],
            vec![1, 3, 4]
        ]
    );
    let schema_before = schema(&pool).await;

    MIGRATOR.run(&pool).await.unwrap();

    assert!(applied(&pool).await.contains(&20));
    // Every row as it was, its rowid with it.
    for ((table, key), rows_before) in TABLES.into_iter().zip(&before) {
        assert_eq!(&rows(&pool, table, key).await, rows_before, "{table}");
    }
    checks_clean(&pool).await;

    let schema_after = schema(&pool).await;
    let gone: BTreeSet<&SchemaRow> = schema_before.difference(&schema_after).collect();
    let new: BTreeSet<&SchemaRow> = schema_after.difference(&schema_before).collect();
    // Gone: only the two rebuilt tables' old text.
    let old_scans = object(&schema_before, "table", "scans");
    let old_owners = object(&schema_before, "table", "code_owners");
    assert_eq!(gone, BTreeSet::from([old_scans, old_owners]));
    // New: their new text, the triggers, the index of owners without a box.
    let new_scans = object(&schema_after, "table", "scans");
    let new_owners = object(&schema_after, "table", "code_owners");
    let insert_rule = object(&schema_after, "trigger", "scans_ok_box_by_mode");
    let update_rule = object(&schema_after, "trigger", "scans_ok_box_by_mode_update");
    let unboxed = object(&schema_after, "index", "code_owners_shift_unboxed");
    assert_eq!(
        new,
        BTreeSet::from([new_scans, new_owners, insert_rule, update_rule, unboxed])
    );
    // `scans`: the same columns and CHECKs but the one that tied an accepted
    // scan to a box (the rename quotes the table's name).
    let old_sql = old_scans.3.as_deref().unwrap();
    let tied = "CHECK ((verdict = 'ok') = (box_id IS NOT NULL))";
    assert_eq!(old_sql.matches(tied).count(), 1);
    assert_eq!(
        new_scans.3.as_deref().unwrap(),
        old_sql
            .replace("CREATE TABLE scans (", "CREATE TABLE \"scans\" (")
            .replace(tied, "CHECK (box_id IS NULL OR verdict = 'ok')")
    );
    // `code_owners`: only `box_id` may be NULL now.
    let old_sql = old_owners.3.as_deref().unwrap();
    let required = "box_id TEXT NOT NULL REFERENCES boxes (id)";
    assert_eq!(old_sql.matches(required).count(), 1);
    assert_eq!(
        new_owners.3.as_deref().unwrap(),
        old_sql.replace(required, "box_id TEXT REFERENCES boxes (id)")
    );
    for (row, event) in [
        (insert_rule, "BEFORE INSERT ON scans"),
        (
            update_rule,
            "BEFORE UPDATE OF verdict, box_id, shift_id ON scans",
        ),
    ] {
        assert_eq!(row.2, "scans");
        let sql = row.3.as_deref().unwrap();
        assert!(sql.contains(event), "{sql}");
        assert!(sql.contains("IS NOT 'validation'"), "{sql}");
    }
    assert_eq!(
        unboxed,
        &(
            "index".to_owned(),
            "code_owners_shift_unboxed".to_owned(),
            "code_owners".to_owned(),
            Some(
                "CREATE INDEX code_owners_shift_unboxed ON code_owners (shift_id) \
                 WHERE box_id IS NULL"
                    .to_owned()
            )
        )
    );
    // Nothing the migration made outlives it in `temp`.
    let temp: Vec<String> = sqlx::query_scalar("SELECT name FROM temp.sqlite_master")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(temp.is_empty(), "{temp:?}");
}

#[tokio::test]
async fn an_accepted_scan_without_a_box_is_taken_only_in_a_validation_shift() {
    let (_dir, pool) = at_0019(true).await;
    seed(&pool).await;
    MIGRATOR.run(&pool).await.unwrap();
    let [shift_row, box_row] = shift("shift-v", 2, "validation", "box-2");
    execute(&pool, &[&shift_row, &box_row]).await;

    // Aggregation: an accepted scan names its box.
    refused(
        scan(&pool, "scan-5", "shift-a", "ok", None, 5).await,
        "scan_needs_box",
    );
    scan(&pool, "scan-7", "shift-a", "ok", Some("box-1"), 7)
        .await
        .unwrap();
    // Validation: without a box, and with one still.
    scan(&pool, "scan-6", "shift-v", "ok", None, 6)
        .await
        .unwrap();
    scan(&pool, "scan-8", "shift-v", "ok", Some("box-2"), 8)
        .await
        .unwrap();
    execute(
        &pool,
        &["INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
           VALUES (printf('%064x', 6), 'scan-6', 'shift-v', 'device-1', NULL, \
           '2026-10-09T11:00:00.000Z')"],
    )
    .await;
    // Only an accepted scan has a box, in either mode; the rule asks no box
    // of any other scan, in an aggregation shift too.
    for (id, shift) in [("scan-9", "shift-a"), ("scan-10", "shift-v")] {
        refused(
            scan(&pool, id, shift, "duplicate", Some("box-1"), 1).await,
            "CHECK constraint failed",
        );
    }
    scan(&pool, "scan-11", "shift-a", "duplicate", None, 1)
        .await
        .unwrap();
    scan(&pool, "scan-12", "shift-a", "wrong_gtin", None, 12)
        .await
        .unwrap();
    // An update cannot take the box of an aggregation shift's accepted scan,
    // nor move a box-less one into an aggregation shift, nor make a box-less
    // scan of an aggregation shift an accepted one.
    for statement in [
        "UPDATE scans SET box_id = NULL WHERE id = 'scan-7'",
        "UPDATE scans SET shift_id = 'shift-a' WHERE id = 'scan-6'",
        "UPDATE scans SET verdict = 'ok', duplicate_source = NULL WHERE id = 'scan-11'",
    ] {
        refused(
            sqlx::query(statement).execute(&pool).await.map(|_| ()),
            "scan_needs_box",
        );
    }
    let boxless: Vec<String> =
        sqlx::query_scalar("SELECT id FROM scans WHERE verdict = 'ok' AND box_id IS NULL")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(boxless, ["scan-6"]);
    checks_clean(&pool).await;
}

/// The rule reads the shift's mode: a scan whose shift is not there is no
/// scan of a validation shift. The trigger runs before the foreign key is
/// checked, and refuses it with the keys off as well.
#[tokio::test]
async fn a_scan_of_a_missing_shift_is_no_scan_of_a_validation_shift() {
    let (_dir, pool) = at_0019(true).await;
    seed(&pool).await;
    MIGRATOR.run(&pool).await.unwrap();
    refused(
        scan(&pool, "scan-5", "shift-missing", "ok", Some("box-1"), 5).await,
        "FOREIGN KEY constraint failed",
    );
    refused(
        scan(&pool, "scan-5", "shift-missing", "ok", None, 5).await,
        "scan_needs_box",
    );
    execute(&pool, &["PRAGMA foreign_keys = OFF"]).await;
    refused(
        scan(&pool, "scan-5", "shift-missing", "ok", None, 5).await,
        "scan_needs_box",
    );
    refused(
        sqlx::query(
            "UPDATE scans SET shift_id = 'shift-missing', box_id = NULL WHERE id = 'scan-1'",
        )
        .execute(&pool)
        .await
        .map(|_| ()),
        "scan_needs_box",
    );
}

#[tokio::test]
async fn the_foreign_keys_on_scans_still_hold_after_the_rebuild() {
    let (_dir, pool) = at_0019(true).await;
    seed(&pool).await;
    MIGRATOR.run(&pool).await.unwrap();
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);
    for statement in [
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         VALUES ('scan-unknown', 'box-1', printf('%064x', 9), '2026-10-09T11:00:00.000Z')",
        "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
         VALUES (printf('%064x', 9), 'scan-unknown', 'shift-a', 'device-1', NULL, \
         '2026-10-09T11:00:00.000Z')",
        "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
         VALUES (printf('%064x', 9), 'scan-3', 'shift-a', 'device-1', 'box-unknown', \
         '2026-10-09T11:00:00.000Z')",
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
         VALUES ('conflict-2', printf('%064x', 1), 'scan-1', 'scan-unknown', \
         '2026-10-09T11:00:00Z')",
        "DELETE FROM scans WHERE id = 'scan-1'",
    ] {
        refused(
            sqlx::query(statement).execute(&pool).await.map(|_| ()),
            "FOREIGN KEY constraint failed",
        );
    }
    refused(
        scan(&pool, "scan-5", "shift-a", "ok", Some("box-unknown"), 5).await,
        "FOREIGN KEY constraint failed",
    );
}

/// A row of the four tables whose parent is gone (only possible if foreign
/// keys were ever off): a box item of a scan gone, a scan of a box gone, an
/// owner of a box gone, a conflict whose loser is gone. Each one fails the
/// migration whole, whatever the connection's foreign keys: with them on,
/// copying the row is refused; with them off, the final guard refuses it.
/// The database stays at `0019`, its rows untouched, nothing left in `temp`.
#[tokio::test]
async fn an_orphan_row_fails_the_migration_whole() {
    let orphans = [
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         VALUES ('scan-gone', 'box-1', printf('%064x', 9), '2026-10-09T11:00:00.000Z')",
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
         raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
         scanned_at, received_at) VALUES ('scan-9', 'record-9', 'device-1', 'shift-a', 'ok', \
         NULL, 'km', 38, printf('%064x', 9), '04600682000013', 'B0000009', \
         '010460068200001321B0000009', 'box-gone', NULL, '2026-10-09T11:00:00.000Z', \
         '2026-10-09T11:00:01Z')",
        "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
         VALUES (printf('%064x', 9), 'scan-3', 'shift-a', 'device-1', 'box-gone', \
         '2026-10-09T11:00:00.000Z')",
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
         VALUES ('conflict-2', printf('%064x', 1), 'scan-1', 'scan-gone', \
         '2026-10-09T11:00:00Z')",
    ];
    for (orphan, foreign_keys) in orphans
        .iter()
        .flat_map(|orphan| [(orphan, true), (orphan, false)])
    {
        let (_dir, pool) = at_0019(foreign_keys).await;
        seed(&pool).await;
        execute(&pool, &["PRAGMA foreign_keys = OFF", orphan]).await;
        if foreign_keys {
            execute(&pool, &["PRAGMA foreign_keys = ON"]).await;
        }
        let schema_before = schema(&pool).await;
        let mut before = Vec::new();
        for (table, key) in TABLES {
            before.push(rows(&pool, table, key).await);
        }

        let error = MIGRATOR.run(&pool).await.unwrap_err();

        let expected = if foreign_keys {
            "FOREIGN KEY constraint failed"
        } else {
            "CHECK constraint failed"
        };
        assert!(
            error.to_string().contains(expected),
            "{orphan} {foreign_keys}: {error}"
        );
        assert!(!applied(&pool).await.contains(&20));
        assert_eq!(
            schema(&pool).await,
            schema_before,
            "{orphan} {foreign_keys}"
        );
        for ((table, key), rows_before) in TABLES.into_iter().zip(&before) {
            assert_eq!(&rows(&pool, table, key).await, rows_before, "{table}");
        }
        let temp: Vec<String> = sqlx::query_scalar("SELECT name FROM temp.sqlite_master")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(temp.is_empty(), "{orphan} {foreign_keys}: {temp:?}");
    }
}

/// A copy made before `0020` (or a host that never ran it) takes it on the
/// next start through `db::open`, data and all.
#[tokio::test]
async fn a_host_at_0019_takes_0020_on_its_next_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.db");
    {
        let pool = pool(&path, true).await;
        through_0019().run(&pool).await.unwrap();
        seed(&pool).await;
        pool.close().await;
    }
    let pool = markiro_host::db::open(&path).await.unwrap();
    assert_eq!(applied(&pool).await.len(), MIGRATOR.iter().count());
    let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM code_owners")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(owners, 1);
    checks_clean(&pool).await;
}

/// The migration runs when the host service starts: its time on a large
/// database. `cargo test -p markiro-host --test migration_validation_scans
/// -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "a million scans: run by hand"]
async fn the_rebuild_of_a_million_scans_takes() {
    const SCANS: i64 = 1_000_000;
    const BOXES: i64 = 10_000;
    let (_dir, pool) = at_0019(true).await;
    execute(&pool, &PARENTS).await;
    let [shift_row, _] = shift("shift-a", 1, "aggregation", "box-1");
    execute(&pool, &[&shift_row]).await;
    let fill = [
        format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {BOXES}) \
             INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
             SELECT printf('box-%05d', i), 'shift-a', 'device-1', '2026-10-09T10:00:00.000Z', \
             '2026-10-09T10:00:01Z' FROM n"
        ),
        // Every 20th scan a duplicate, every 20th (offset) invalid, the rest
        // accepted into box `i % BOXES`.
        format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < {SCANS}) \
             INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
             scanned_at, received_at) \
             SELECT printf('ffffff01-0000-4000-8000-%012d', i), printf('r-%d', i), 'device-1', \
             'shift-a', v, CASE v WHEN 'duplicate' THEN 'local' END, \
             CASE v WHEN 'invalid' THEN 'unknown' ELSE 'km' END, 38, \
             CASE v WHEN 'invalid' THEN NULL ELSE printf('%064x', i) END, \
             CASE v WHEN 'invalid' THEN NULL ELSE '04600682000013' END, \
             CASE v WHEN 'invalid' THEN NULL ELSE printf('B%07d', i) END, \
             CASE v WHEN 'invalid' THEN NULL \
               ELSE printf('0104600682000013' || '21B%07d' || char(29) || '93Zz', i) END, \
             CASE v WHEN 'ok' THEN printf('box-%05d', i % {BOXES}) END, 'operator-1', \
             printf('2026-10-09T%02d:%02d:%02d.000Z', i / 3600 % 24, i / 60 % 60, i % 60), \
             '2026-10-09T12:00:00Z' \
             FROM (SELECT i, CASE i % 20 WHEN 0 THEN 'duplicate' WHEN 1 THEN 'invalid' \
               ELSE 'ok' END AS v FROM n)"
        ),
        "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
         SELECT code_hash, id, shift_id, device_id, box_id, scanned_at FROM scans \
         WHERE verdict = 'ok'"
            .to_owned(),
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         SELECT id, box_id, code_hash, scanned_at FROM scans WHERE verdict = 'ok'"
            .to_owned(),
    ];
    for statement in &fill {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    let counts = |pool: SqlitePool| async move {
        let mut counts = Vec::new();
        for (table, _) in TABLES {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            counts.push(count);
        }
        counts
    };
    let before = counts(pool.clone()).await;

    let started = std::time::Instant::now();
    MIGRATOR.run(&pool).await.unwrap();
    let took = started.elapsed();

    eprintln!("0020 on {before:?} rows (scans, box_items, code_owners, code_conflicts): {took:?}");
    assert_eq!(counts(pool.clone()).await, before);
}
