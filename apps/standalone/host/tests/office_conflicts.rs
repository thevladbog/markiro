mod support;

use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};

/// Every migration before `0022`: a host of the integration branch before plan КНФ.
fn before_0022() -> Migrator {
    Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 22)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// Migration `0022` over a host that kept two conflicts of 2a: the loser of
/// one had been accepted (its item was displaced), the other's receipt said
/// `conflict`. Each takes its kind from the loser's receipt; nobody reviewed
/// either, and the new columns and indexes are there.
#[tokio::test]
async fn migration_0022_gives_old_conflicts_their_kind_and_adds_the_review() {
    let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before_0022().run(&mut db).await.unwrap();
    // The rows a conflict joins, without the rest of a host: the foreign keys
    // of `scans` are not what this test is about.
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut db)
        .await
        .unwrap();
    for (scan, record) in [
        ("s-winner", "r-w"),
        ("s-displaced", "r-d"),
        ("s-late", "r-l"),
    ] {
        sqlx::query(
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
             raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
             VALUES (?, ?, 'device-1', 'shift-1', 'ok', 'km', 38, ?, '04600682000013', 'S1', \
             'c', 'box-1', '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:01Z')",
        )
        .bind(scan)
        .bind(record)
        .bind(format!("{:064x}", 7))
        .execute(&mut db)
        .await
        .unwrap();
    }
    for (record, outcome) in [
        ("r-w", "accepted"),
        ("r-d", "accepted"),
        ("r-l", "conflict"),
    ] {
        sqlx::query(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             received_at) VALUES ('device-1', ?, 'scan', 'shift-1', ?, ?, '2026-10-08T06:00:01Z')",
        )
        .bind(record)
        .bind("0".repeat(64))
        .bind(outcome)
        .execute(&mut db)
        .await
        .unwrap();
    }
    for (id, loser) in [("c-displaced", "s-displaced"), ("c-late", "s-late")] {
        sqlx::query(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
             detected_at) VALUES (?, ?, 's-winner', ?, '2026-10-08T06:00:01Z')",
        )
        .bind(id)
        .bind(format!("{:064x}", 7))
        .bind(loser)
        .execute(&mut db)
        .await
        .unwrap();
    }
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut db)
        .await
        .unwrap();

    markiro_host::db::MIGRATOR.run(&mut db).await.unwrap();

    let rows: Vec<(String, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, kind, reviewed_at, reviewed_by FROM code_conflicts ORDER BY id")
            .fetch_all(&mut db)
            .await
            .unwrap();
    assert_eq!(
        rows,
        vec![
            ("c-displaced".into(), "displaced".into(), None, None),
            ("c-late".into(), "late".into(), None, None),
        ]
    );
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN \
         ('code_conflicts_loser', 'code_conflicts_detected', 'fact_receipts_rejected', \
          'box_exceptions_shift', 'pallet_exceptions_shift') ORDER BY name",
    )
    .fetch_all(&mut db)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 5, "{indexes:?}");
    // A review names its reviewer, and a reviewer names a review.
    let half = sqlx::query(
        "UPDATE code_conflicts SET reviewed_at = '2026-10-08T07:00:00Z' WHERE id = 'c-late'",
    )
    .execute(&mut db)
    .await;
    assert!(half.is_err(), "reviewed_at without reviewed_by must fail");
    let kind = sqlx::query("UPDATE code_conflicts SET kind = 'twice' WHERE id = 'c-late'")
        .execute(&mut db)
        .await;
    assert!(kind.is_err());
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
}
