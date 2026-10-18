//! A database of the first beta (beta 2, commit `0aac2b1af`) meets this build.
//!
//! Beta 2 shipped host migrations `0001`–`0012`, `0015`–`0019`, `0023` and `0031`: the numbers
//! in between were taken by plans that merged later (`0020`–`0022` validation and
//! conflict review, `0024`–`0025` disaggregation and the pallet list, `0030` the
//! license). sqlx applies every migration the database lacks, lowest first, even
//! when a higher one is already recorded, so a beta-2 database must reach the same
//! schema a new one has: `0020` before `0022` (the rebuilt `code_conflicts` keeps
//! `kind` and `reviewed_by`), every table, index and trigger, the seed rows, and
//! every row it already held. This pins that, and that the host's own upgrade
//! path (`upgrade::pending`, then `MIGRATOR.run`) accepts the gap.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use markiro_host::upgrade;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use tempfile::TempDir;

/// The versions beta 2 had applied.
fn beta2(version: i64) -> bool {
    (1..=12).contains(&version) || (15..=19).contains(&version) || version == 23 || version == 31
}

fn beta2_migrator() -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| beta2(migration.version))
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

async fn pool(path: &Path) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(path).create_if_missing(true))
        .await
        .unwrap()
}

async fn execute(pool: &SqlitePool, statements: &[&str]) {
    for statement in statements {
        sqlx::query(statement)
            .execute(pool)
            .await
            .unwrap_or_else(|error| panic!("{statement}: {error}"));
    }
}

fn scan(id: &str, n: i64, at: &str) -> String {
    "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
     code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
     VALUES ('{id}', 'record-{id}', 'device-1', 'shift-a', 'ok', 'km', 38, printf('%064x', {n}), \
     '04600682000013', printf('B%07d', {n}), 'canonical-{id}', 'box-1', '{at}', \
     '2026-10-09T10:05:00Z')"
        .replace("{id}", id)
        .replace("{n}", &n.to_string())
        .replace("{at}", at)
}

fn receipt(id: &str, outcome: &str) -> String {
    format!(
        "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
         received_at) VALUES ('device-1', 'record-{id}', 'scan', 'shift-a', printf('%064x', 5), \
         '{outcome}', '2026-10-09T10:05:00Z')"
    )
}

/// A beta-2 database with a site's data: a line, a station, a product with the
/// `0023` columns, a shift, a box, scans and two conflicts.
async fn beta2_database() -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    beta2_migrator().run(&pool).await.unwrap();
    execute(
        &pool,
        &[
            "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
            "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, \
             paired_at) VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), \
             '0.1.0', 3, '2026-10-01T08:00:00Z')",
            "INSERT INTO products (id, gtin14, name, rev) \
             VALUES ('product-1', '04600682000013', 'Сок яблочный', 1)",
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
             VALUES ('shift-a', 'OCT26', 1, 'office', 'office_user', 'user-1', 'active', \
             'aggregation', 'product-1', 'line-1', '2026-10-09', 12, 'template-1', 'device-1', \
             '{}', '2026-10-09T08:00:00Z', '2026-10-08T17:00:00Z', 1)",
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
             VALUES ('box-1', 'shift-a', 'device-1', '2026-10-09T10:00:00.000Z', \
             '2026-10-09T10:00:01Z')",
        ],
    )
    .await;
    execute(
        &pool,
        &[
            &scan("1", 1, "2026-10-09T10:00:00.000Z"),
            &scan("4", 1, "2026-10-09T10:00:09.000Z"),
            &scan("7", 2, "2026-10-09T10:00:20.000Z"),
            &scan("8", 2, "2026-10-09T10:00:10.000Z"),
            &receipt("1", "accepted"),
            &receipt("4", "conflict"),
            &receipt("7", "accepted"),
            &receipt("8", "accepted"),
            "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
             VALUES (printf('%064x', 1), '1', 'shift-a', 'device-1', 'box-1', \
             '2026-10-09T10:00:00.000Z')",
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
             detected_at) VALUES ('conflict-late', printf('%064x', 1), '1', '4', \
             '2026-10-09T10:05:00Z')",
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
             detected_at) VALUES ('conflict-displaced', printf('%064x', 2), '8', '7', \
             '2026-10-09T10:05:01Z')",
        ],
    )
    .await;
    (dir, pool)
}

/// Every index and trigger of the schema, by type, name and table.
async fn indexes_and_triggers(pool: &SqlitePool) -> BTreeSet<(String, String, String)> {
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT type, name, tbl_name FROM sqlite_master \
         WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .collect()
}

/// Every column of every table: (table, name, type, not null, default, pk).
async fn columns(
    pool: &SqlitePool,
) -> BTreeSet<(String, String, String, i64, Option<String>, i64)> {
    sqlx::query_as(
        "SELECT m.name, c.name, c.type, c.\"notnull\", c.dflt_value, c.pk \
         FROM sqlite_master m, pragma_table_info(m.name) c \
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name != '_sqlx_migrations'",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .collect()
}

#[tokio::test]
async fn a_beta2_database_reaches_the_schema_a_new_one_has() {
    let (_dir, pool) = beta2_database().await;

    // The gap is real: the database lacks the middle versions, the host's own
    // check names them, and it does not refuse the gap.
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        applied,
        (1..=12)
            .chain(15..=19)
            .chain([23, 31])
            .collect::<Vec<i64>>(),
        "the beta-2 fixture is not what beta 2 shipped"
    );
    let mut connection = pool.acquire().await.unwrap();
    let pending = upgrade::pending(&mut connection, &MIGRATOR)
        .await
        .unwrap()
        .expect("a beta-2 database has pending migrations");
    drop(connection);
    let lacking: Vec<i64> = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| !beta2(*version))
        .collect();
    assert_eq!(pending.migrations, lacking.len());
    for expected in [20, 21, 22, 24, 25, 30] {
        assert!(lacking.contains(&expected), "{expected} is not pending");
    }

    let conflicts_before: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, code_hash, winner_scan_id, loser_scan_id FROM code_conflicts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(conflicts_before.len(), 2);

    MIGRATOR.run(&pool).await.unwrap();

    // Every version of this build is applied, none failed, and a second run is a no-op.
    let all: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let rows: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.iter().map(|row| row.0).collect::<Vec<_>>(), all);
    assert!(rows.iter().all(|row| row.1));
    MIGRATOR.run(&pool).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert!(upgrade::pending(&mut connection, &MIGRATOR)
        .await
        .unwrap()
        .is_none());
    drop(connection);

    // `0020` ran before `0022`: the rebuilt table has `0022`'s columns, every row
    // survived and its kind came from the loser's receipt.
    let after: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, code_hash, winner_scan_id, loser_scan_id FROM code_conflicts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(after, conflicts_before);
    let kinds: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, kind, reviewed_by FROM code_conflicts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        kinds,
        [
            (
                "conflict-displaced".to_owned(),
                "displaced".to_owned(),
                None
            ),
            ("conflict-late".to_owned(), "late".to_owned(), None),
        ]
    );
    let scans: i64 = sqlx::query_scalar("SELECT count(*) FROM scans")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(scans, 4);
    // The rows of `0023` and `0031` (columns the beta added) are untouched.
    let device_version: String =
        sqlx::query_scalar("SELECT app_version FROM devices WHERE id = 'device-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(device_version, "0.1.0");

    // The same tables, columns, indexes and triggers as a database made new.
    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = self::pool(&fresh_dir.path().join("fresh.db")).await;
    MIGRATOR.run(&fresh).await.unwrap();
    assert_eq!(columns(&pool).await, columns(&fresh).await);
    let upgraded_objects = indexes_and_triggers(&pool).await;
    assert_eq!(upgraded_objects, indexes_and_triggers(&fresh).await);
    for expected in [
        "scans_ok_box",
        "scans_ok_gtin",
        "scans_ok_scanned",
        "scans_record",
        "scans_shift",
        "scans_code_hash",
        "box_items_live",
        "code_owners_shift_unboxed",
        "code_conflicts_code",
        "code_conflicts_loser",
        "code_conflicts_detected",
        "fact_receipts_rejected",
        "box_exceptions_shift",
        "pallet_exceptions_shift",
        "scans_ok_box_by_mode",
        "scans_ok_box_by_mode_update",
        "shifts_validation_print_insert",
        "shifts_validation_print_update",
        "shifts_mode_frozen",
        "shifts_pallets_insert",
        "shifts_pallet_sheet_insert",
    ] {
        assert!(
            upgraded_objects.iter().any(|(_, name, _)| name == expected),
            "no {expected}"
        );
    }
    // The seed rows of the migrations that were missing.
    for table in [
        "disaggregation_reasons",
        "disaggregation_doc_counters",
        "license_clock",
    ] {
        let query = format!("SELECT count(*) FROM {table}");
        let upgraded: i64 = sqlx::query_scalar(&query).fetch_one(&pool).await.unwrap();
        let new: i64 = sqlx::query_scalar(&query).fetch_one(&fresh).await.unwrap();
        assert!(new > 0, "{table} has no seed in a new database");
        assert_eq!(upgraded, new, "{table}");
    }

    let violations: i64 = sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(integrity, ["ok"]);
}
