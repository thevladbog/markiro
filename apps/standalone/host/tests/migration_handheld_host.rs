//! Migrations 0035-0037 of plan ТСД-Х on a database that has the earlier ones (spec 6.4): a host
//! with live shifts, boxes and pallets upgrades without losing a row and gets the new tables.

use std::collections::BTreeSet;
use std::path::Path;

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

/// The migrations up to and including `last`.
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

async fn tables(pool: &SqlitePool) -> BTreeSet<String> {
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

#[tokio::test]
async fn the_warehouse_tables_arrive_beside_a_live_database_and_enforce_their_rules() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(34).run(&pool).await.unwrap();
    assert!(!tables(&pool).await.contains("warehouse_pallets"));
    MIGRATOR.run(&pool).await.unwrap();
    let tables = tables(&pool).await;
    for table in [
        "warehouse_pallets",
        "warehouse_pallet_boxes",
        "device_event_receipts",
    ] {
        assert!(tables.contains(table), "{table}");
    }
    // The versions are unique and the new ones are the next free numbers.
    let versions: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    assert_eq!(
        versions.len(),
        versions.iter().collect::<BTreeSet<_>>().len()
    );
    for version in [35, 36] {
        assert!(versions.contains(&version), "{version}");
    }
    // A closed pallet holds its SSCC, block, serial and count together, and starts with 1.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    let refused = |sql: &str| {
        let sql = sql.to_owned();
        let pool = pool.clone();
        async move { sqlx::query(&sql).execute(&pool).await.is_err() }
    };
    let head =
        "INSERT INTO warehouse_pallets (id, device_id, product_id, gtin14, opened_at, received_at";
    assert!(
        refused(&format!(
            "{head}, closed_at) VALUES ('p1','d','pr','04600682000013','t','t','t')"
        ))
        .await
    );
    assert!(
        refused(&format!(
            "{head}, closed_at, sscc, block_id, serial, box_count_reported) \
             VALUES ('p2','d','pr','04600682000013','t','t','t','046006820000015000','b',1,1)"
        ))
        .await,
        "a pallet SSCC starts with 1"
    );
    assert!(
        !refused(&format!(
            "{head}) VALUES ('p3','d','pr','04600682000013','t','t')"
        ))
        .await
    );
    // A box stands on one live pallet only; a removed row frees it.
    let add = "INSERT INTO warehouse_pallet_boxes (pallet_id, box_sscc, added_at, record_id, device_id, removed_at) VALUES";
    assert!(
        !refused(&format!(
            "{add} ('p3','046006820000015000','t','r1','d',NULL)"
        ))
        .await
    );
    assert!(
        refused(&format!(
            "{add} ('p3','046006820000015000','t','r2','d',NULL)"
        ))
        .await
    );
    assert!(
        !refused(&format!(
            "{add} ('p3','046006820000015000','t','r3','d','t2')"
        ))
        .await
    );
}

#[tokio::test]
async fn a_closed_box_of_a_live_database_gets_its_change_time_and_an_open_one_gets_none() {
    let dir = tempfile::tempdir().unwrap();
    let pool = pool(&dir.path().join("host.db")).await;
    through(36).run(&pool).await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    for sql in [
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
         VALUES ('open', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:00Z')",
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         item_count_reported, membership_digest, digest_matches, received_at) \
         VALUES ('closed', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:10:00.000Z', \
         '046006820000015000', 'b', 1500, 1, 'x', 1, '2026-10-08T06:11:00Z')",
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         item_count_reported, membership_digest, digest_matches, disassembled_at, received_at) \
         VALUES ('apart', 's', 'd', '2026-10-08T06:00:00.000Z', '2026-10-08T06:10:00.000Z', \
         '046006820000015010', 'b', 1501, 1, 'x', 1, '2026-10-09T08:00:00.000Z', '2026-10-08T06:11:00Z')",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    MIGRATOR.run(&pool).await.unwrap();
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, changed_at FROM boxes ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    // The host's own time of receipt for a closed box; a taken-apart box keeps the later of the two.
    assert_eq!(
        rows,
        vec![
            (
                "apart".to_owned(),
                Some("2026-10-09T08:00:00.000Z".to_owned())
            ),
            ("closed".to_owned(), Some("2026-10-08T06:11:00Z".to_owned())),
            ("open".to_owned(), None),
        ]
    );
}
