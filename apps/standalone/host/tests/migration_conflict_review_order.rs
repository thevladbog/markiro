//! Migrations `0020` (plan РЕЖ) and `0022` (plan КНФ) meet on `code_conflicts`.
//! `0020` rebuilds the table in the shape of `0010`; `0022` adds `kind` and
//! `reviewed_by` and five indexes. On every database `0020` runs first (a fresh
//! one applies them in order, a host older than both has neither), so `0022`'s
//! columns are added AFTER the rebuild. A database at `0019` with conflict rows,
//! migrated through the host's own `MIGRATOR`, must end with every row, each
//! row's kind derived from the loser's receipt, no reviewer, and the indexes of
//! both. (A host that applied `0022` before `0020` is not a state any build
//! ships: see `apps/standalone/AGENTS.md`, «Databases».)

use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use tempfile::TempDir;

fn through(last: i64) -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version <= last)
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

const SCAN: &str = "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
     raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
     VALUES ('{id}', 'record-{id}', 'device-1', 'shift-a', 'ok', 'km', 38, printf('%064x', {n}), \
     '04600682000013', printf('B%07d', {n}), 'canonical-{id}', 'box-1', '{at}', \
     '2026-10-09T10:05:00Z')";

fn scan(id: &str, n: i64, at: &str) -> String {
    SCAN.replace("{id}", id)
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

/// A database at `0019` holding two conflicts: `conflict-late` (scan-4 came
/// after scan-1, its receipt said `conflict`) and `conflict-displaced` (scan-7
/// owned code 2 and was accepted; scan-8, scanned earlier, arrived later and
/// took it).
async fn at_0019_with_conflicts() -> (TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(19).run(&pool).await.unwrap();
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

async fn indexes(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_database_at_0019_keeps_its_conflicts_through_0020_then_0022() {
    for version in [20, 22] {
        assert!(
            MIGRATOR
                .iter()
                .any(|migration| migration.version == version),
            "no migration {version}"
        );
    }
    let (_dir, pool) = at_0019_with_conflicts().await;
    let before: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, code_hash, winner_scan_id, loser_scan_id FROM code_conflicts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(before.len(), 2);

    MIGRATOR.run(&pool).await.unwrap();

    // Both ran, in order, and nothing was lost.
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    let position = |version: i64| applied.iter().position(|v| *v == version).unwrap();
    assert!(position(20) < position(22), "{applied:?}");
    let after: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, code_hash, winner_scan_id, loser_scan_id FROM code_conflicts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(after, before);
    let scans: i64 = sqlx::query_scalar("SELECT count(*) FROM scans")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(scans, 4);

    // `0022`'s columns exist after `0020`'s rebuild; the kind of an old row comes from the
    // loser's receipt (`accepted` means it was displaced, `conflict` that it came late); nobody
    // has reviewed anything.
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('code_conflicts') ORDER BY cid")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        columns,
        [
            "id",
            "code_hash",
            "winner_scan_id",
            "loser_scan_id",
            "detected_at",
            "reviewed_at",
            "kind",
            "reviewed_by"
        ]
    );
    let rows: Vec<(String, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, kind, reviewed_by, reviewed_at FROM code_conflicts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        [
            (
                "conflict-displaced".to_owned(),
                "displaced".to_owned(),
                None,
                None
            ),
            ("conflict-late".to_owned(), "late".to_owned(), None, None),
        ]
    );

    // The indexes of both: 0010's, 0020's (re-created by the rebuild) and 0022's.
    let names = indexes(&pool).await;
    for expected in [
        "code_conflicts_code",
        "code_conflicts_loser",
        "code_conflicts_detected",
        "fact_receipts_rejected",
        "box_exceptions_shift",
        "pallet_exceptions_shift",
        "code_owners_shift_unboxed",
        "scans_record",
        "scans_shift",
        "scans_code_hash",
        "scans_ok_box",
        "scans_ok_gtin",
        "scans_ok_scanned",
        "box_items_live",
    ] {
        assert!(names.iter().any(|name| name == expected), "no {expected}");
    }

    // The CHECKs of 0022 are in force on the rebuilt table.
    let bad_kind = sqlx::query(
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at, \
         kind) VALUES ('conflict-x', printf('%064x', 1), '1', '7', '2026-10-09T10:06:00Z', 'x')",
    )
    .execute(&pool)
    .await;
    assert!(bad_kind.is_err());
    let reviewer_alone = sqlx::query("UPDATE code_conflicts SET reviewed_by = 'user-1'")
        .execute(&pool)
        .await;
    assert!(reviewer_alone.is_err());

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
