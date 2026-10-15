//! A database of the third beta (commit `917f92ab4`) meets this build.
//!
//! Beta 3 shipped host migrations `0001`–`0012`, `0015`–`0025`, `0030` and `0031`.
//! `0035`–`0038` (plan ТСД-Х: warehouse pallets, device event receipts, the box registry's change
//! time, a pairing code's device) and `0045` (the address mark) come after `0034`; the last test
//! of this file upgrades a database that has everything up to `0034`.
//! Three later ones are new: `0027` (the audit trail's index by target), `0028` (the
//! shift's own date, with a trigger and an index) and `0032` (the product's
//! `photo_rev`). sqlx applies every migration the database lacks, lowest first, even
//! below an applied one. This pins that a beta-3 database reaches the schema a new one
//! has, keeps every row, backfills the new columns, and that no two migrations share a
//! version.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use markiro_host::upgrade;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

/// The versions beta 3 had applied.
fn beta3(version: i64) -> bool {
    (1..=12).contains(&version) || (15..=25).contains(&version) || version == 30 || version == 31
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

async fn objects(pool: &SqlitePool) -> BTreeSet<(String, String, String)> {
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
async fn a_beta3_database_keeps_its_data_and_reaches_the_schema_a_new_one_has() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| beta3(migration.version))
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
    .run(&pool)
    .await
    .unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        applied,
        (1..=12)
            .chain(15..=25)
            .chain([30, 31])
            .collect::<Vec<i64>>(),
        "the beta-3 fixture is not what beta 3 shipped"
    );

    execute(
        &pool,
        &[
            "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
            "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, \
             paired_at) VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), \
             '1.0.0-beta.3', 5, '2026-10-01T08:00:00Z')",
            "INSERT INTO products (id, gtin14, name, rev) \
             VALUES ('product-photo', '04600682000013', 'Сок яблочный', 7)",
            "INSERT INTO products (id, gtin14, name, rev) \
             VALUES ('product-plain', '04600682000020', 'Сок грушевый', 9)",
            "INSERT INTO product_photos (product_id, width, height, data, checksum, updated_at) \
             VALUES ('product-photo', 10, 10, x'ffd8ffd9', printf('%064x', 1), \
             '2026-10-09T08:00:00Z')",
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
             VALUES ('shift-a', 'OCT26', 1, 'office', 'office_user', 'user-1', 'active', \
             'aggregation', 'product-photo', 'line-1', '2026-10-09', 12, 'template-1', \
             'device-1', '{}', '2026-10-09T08:00:00Z', '2026-10-08T17:00:00Z', 1)",
            "INSERT INTO audit_log (at, actor_kind, action, target_type, target_id, result) \
             VALUES ('2026-10-09T08:00:00Z', 'office_user', 'shift.export', 'shift', 'shift-a', 'ok')",
        ],
    )
    .await;

    let mut connection = pool.acquire().await.unwrap();
    let pending = upgrade::pending(&mut connection, &MIGRATOR)
        .await
        .unwrap()
        .expect("a beta-3 database has pending migrations");
    drop(connection);
    let lacking: Vec<i64> = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| !beta3(*version))
        .collect();
    assert_eq!(pending.migrations, lacking.len());
    for expected in [27, 28, 32] {
        assert!(lacking.contains(&expected), "{expected} is not pending");
    }

    MIGRATOR.run(&pool).await.unwrap();

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

    // The rows are kept, and the new columns are backfilled.
    let planned: (String, Option<String>) =
        sqlx::query_as("SELECT production_date, planned_date FROM shifts WHERE id = 'shift-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        planned,
        ("2026-10-09".to_owned(), Some("2026-10-09".to_owned()))
    );
    let revs: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT id, rev, photo_rev FROM products ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        revs,
        [
            ("product-photo".to_owned(), 7, 7),
            ("product-plain".to_owned(), 9, 0)
        ],
        "a photo that exists is announced at the product's revision, a product without one stays at 0"
    );
    let photos: i64 = sqlx::query_scalar("SELECT count(*) FROM product_photos")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(photos, 1);
    let audit: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE target_id = 'shift-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(audit, 1);
    // A shift written after the upgrade without a date takes the production date.
    execute(
        &pool,
        &[
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
           created_by, status, mode, product_id, line_id, production_date, box_capacity, \
           box_template_id, created_at, rev) \
           VALUES ('shift-b', 'OCT26', 2, 'office', 'office_user', 'user-1', 'planned', \
           'aggregation', 'product-plain', 'line-1', '2026-10-12', 12, 'template-1', \
           '2026-10-08T17:00:00Z', 1)",
        ],
    )
    .await;
    let defaulted: Option<String> =
        sqlx::query_scalar("SELECT planned_date FROM shifts WHERE id = 'shift-b'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(defaulted.as_deref(), Some("2026-10-12"));

    // The same tables, columns, indexes and triggers as a database made new.
    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = self::pool(&fresh_dir.path().join("fresh.db")).await;
    MIGRATOR.run(&fresh).await.unwrap();
    assert_eq!(columns(&pool).await, columns(&fresh).await);
    let upgraded_objects = objects(&pool).await;
    assert_eq!(upgraded_objects, objects(&fresh).await);
    for expected in [
        "audit_log_target",
        "shifts_planned_date",
        "shifts_planned_date_default",
        "scans_ok_box",
        "code_conflicts_code",
        "shifts_mode_frozen",
    ] {
        assert!(
            upgraded_objects.iter().any(|(_, name, _)| name == expected),
            "no {expected}"
        );
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

/// No two host migrations share a version: in the compiled list and in the files.
#[test]
fn host_migration_versions_are_unique() {
    let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let mut sorted = versions.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted, versions, "versions repeat or are out of order");
    let mut prefixes: Vec<String> =
        std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".sql"))
            .map(|name| name.split('_').next().unwrap().to_owned())
            .collect();
    let files = prefixes.len();
    prefixes.sort();
    prefixes.dedup();
    assert_eq!(prefixes.len(), files, "two files share a version number");
    assert_eq!(files, versions.len());
}

/// The versions beta 3.3 (commit `50f10e3d9`) had applied: `0001`–`0012`, `0015`–`0025`,
/// `0027`–`0032`.
fn beta33(version: i64) -> bool {
    (1..=12).contains(&version) || (15..=25).contains(&version) || (27..=32).contains(&version)
}

/// A database of beta 3.3 meets `0033` (the scan history's index) and `0034` (a photo's
/// media type): every row stays, a photo kept before is a JPEG, the index and the triggers
/// are there, and the schema is the one a new database has.
#[tokio::test]
async fn a_beta33_database_keeps_its_data_and_takes_0033_and_0034() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| beta33(migration.version))
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
    .run(&pool)
    .await
    .unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        applied,
        (1..=12).chain(15..=25).chain(27..=32).collect::<Vec<i64>>(),
        "the beta-3.3 fixture is not what beta 3.3 shipped"
    );

    execute(
        &pool,
        &[
            "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
            "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, \
             paired_at) VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), \
             '1.0.0-beta.3', 5, '2026-10-01T08:00:00Z')",
            "INSERT INTO products (id, gtin14, name, rev, photo_rev) \
             VALUES ('product-photo', '04600682000013', 'Сок яблочный', 7, 7)",
            "INSERT INTO product_photos (product_id, width, height, data, checksum, updated_at) \
             VALUES ('product-photo', 10, 10, x'ffd8ffd9', printf('%064x', 1), \
             '2026-10-09T08:00:00Z')",
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
             VALUES ('shift-a', 'OCT26', 1, 'office', 'office_user', 'user-1', 'active', \
             'aggregation', 'product-photo', 'line-1', '2026-10-09', 12, 'template-1', \
             'device-1', '{}', '2026-10-09T08:00:00Z', '2026-10-08T17:00:00Z', 1)",
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
             raw_length, scanned_at, received_at) VALUES ('scan-1', 'record-1', 'device-1', \
             'shift-a', 'invalid', 'unknown', 5, '2026-10-09T08:01:00Z', '2026-10-09T08:01:01Z')",
        ],
    )
    .await;
    let before = objects(&pool).await;
    assert!(!before.iter().any(|(_, name, _)| name == "scans_shift_time"));

    let mut connection = pool.acquire().await.unwrap();
    let pending = upgrade::pending(&mut connection, &MIGRATOR)
        .await
        .unwrap()
        .expect("a beta-3.3 database has pending migrations");
    drop(connection);
    let lacking: Vec<i64> = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| !beta33(*version))
        .collect();
    assert_eq!(pending.migrations, lacking.len());
    for expected in [33, 34] {
        assert!(lacking.contains(&expected), "{expected} is not pending");
    }

    MIGRATOR.run(&pool).await.unwrap();

    let all: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let rows: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.iter().map(|row| row.0).collect::<Vec<_>>(), all);
    assert!(rows.iter().all(|row| row.1));

    let photo: (String, i64, String) =
        sqlx::query_as("SELECT product_id, length(data), media_type FROM product_photos")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        photo,
        ("product-photo".to_owned(), 4, "image/jpeg".to_owned())
    );
    for (table, expected) in [
        ("scans", 1_i64),
        ("shifts", 1),
        ("products", 1),
        ("devices", 1),
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, expected, "{table} lost rows");
    }

    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = self::pool(&fresh_dir.path().join("fresh.db")).await;
    MIGRATOR.run(&fresh).await.unwrap();
    assert_eq!(columns(&pool).await, columns(&fresh).await);
    let upgraded_objects = objects(&pool).await;
    assert_eq!(upgraded_objects, objects(&fresh).await);
    for expected in [
        "scans_shift_time",
        "scans_shift",
        "scans_ok_box",
        "audit_log_target",
        "shifts_planned_date",
        "shifts_planned_date_default",
        "shifts_mode_frozen",
    ] {
        assert!(
            upgraded_objects.iter().any(|(_, name, _)| name == expected),
            "no {expected}"
        );
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

/// A database that has everything up to `0034` (the last host migration before the handheld's).
fn through_0034(version: i64) -> bool {
    version <= 34
}

/// A live database of a build before the handheld meets `0035`–`0038` and `0045`: every row
/// stays, a closed box gets its change time (an open one none), a pairing code names no device,
/// the warehouse tables are empty, and the schema is the one a new database has.
#[tokio::test]
async fn a_database_before_the_handheld_takes_0035_to_0038_and_0045_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| through_0034(migration.version))
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
    .run(&pool)
    .await
    .unwrap();

    execute(
        &pool,
        &[
            "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
            "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, \
             paired_at) VALUES ('device-1', 'station', 'Станция 1', 'line-1', printf('%064x', 7), \
             '1.0.0', 5, '2026-10-01T08:00:00Z')",
            "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
             VALUES ('user-1', 'admin', 'A', 'admin', 'x', 1, '2026-10-01T08:00:00Z', 1)",
            "INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at) \
             VALUES ('code-1', 'h', 'user-1', '2026-10-01T08:00:00Z', '2026-10-01T08:10:00Z')",
            "INSERT INTO products (id, gtin14, name, rev, photo_rev) \
             VALUES ('product-1', '04600682000013', 'Сок яблочный', 7, 0)",
            "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
             created_by, status, mode, product_id, line_id, production_date, box_capacity, \
             box_template_id, owner_device_id, snapshot, opened_at, created_at, rev) \
             VALUES ('shift-a', 'OCT26', 1, 'office', 'office_user', 'user-1', 'active', \
             'aggregation', 'product-1', 'line-1', '2026-10-09', 12, 'template-1', \
             'device-1', '{}', '2026-10-09T08:00:00Z', '2026-10-08T17:00:00Z', 1)",
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) \
             VALUES ('460068200', 0, 3500, 1)",
            "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
             from_serial, to_serial, issued_at) \
             VALUES ('block-1', '460068200', 0, 'device-1', 'r1', 1500, 3499, '2026-10-09T08:00:00Z')",
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
             VALUES ('box-open', 'shift-a', 'device-1', '2026-10-09T08:00:00.000Z', \
             '2026-10-09T08:00:00Z')",
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
             serial, item_count_reported, membership_digest, digest_matches, received_at) \
             VALUES ('box-closed', 'shift-a', 'device-1', '2026-10-09T08:00:00.000Z', \
             '2026-10-09T08:10:00.000Z', '046006820000015000', 'block-1', 1500, 1, 'x', 1, \
             '2026-10-09T08:11:00Z')",
        ],
    )
    .await;

    let mut connection = pool.acquire().await.unwrap();
    let pending = upgrade::pending(&mut connection, &MIGRATOR)
        .await
        .unwrap()
        .expect("a database before the handheld has pending migrations");
    drop(connection);
    let lacking: Vec<i64> = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| !through_0034(*version))
        .collect();
    assert_eq!(pending.migrations, lacking.len());
    for expected in [35, 36, 37, 38, 45] {
        assert!(lacking.contains(&expected), "{expected} is not pending");
    }

    MIGRATOR.run(&pool).await.unwrap();
    let all: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let rows: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.iter().map(|row| row.0).collect::<Vec<_>>(), all);
    assert!(rows.iter().all(|row| row.1));

    for (table, expected) in [
        ("devices", 1_i64),
        ("shifts", 1),
        ("boxes", 2),
        ("sscc_blocks", 1),
        ("pairing_codes", 1),
        ("warehouse_pallets", 0),
        ("warehouse_pallet_boxes", 0),
        ("device_event_receipts", 0),
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, expected, "{table}");
    }
    let changed: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, changed_at FROM boxes ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        changed,
        [
            (
                "box-closed".to_owned(),
                Some("2026-10-09T08:11:00Z".to_owned())
            ),
            ("box-open".to_owned(), None)
        ]
    );
    let device: Option<String> =
        sqlx::query_scalar("SELECT device_id FROM pairing_codes WHERE id = 'code-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(device, None);

    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = self::pool(&fresh_dir.path().join("fresh.db")).await;
    MIGRATOR.run(&fresh).await.unwrap();
    assert_eq!(columns(&pool).await, columns(&fresh).await);
    assert_eq!(objects(&pool).await, objects(&fresh).await);
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
