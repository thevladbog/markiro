//! The host's database read from outside, read-only. Two sets of checks:
//! the structural ones hold for any copy of the database at any moment (a
//! serial is never in two SSCCs, a code is never live twice, the file passes
//! SQLite's own check) and the reconciling ones hold for the live database
//! once the devices have stopped, against what the host acknowledged.

use std::collections::BTreeMap;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::checks::Check;
use crate::ledger::Snapshot;

pub type Res<T> = Result<T, String>;

/// A read-only pool on `path`. A copy is opened `immutable`: nothing writes
/// to it and it has no log to read.
pub async fn open_read_only(path: &Path, immutable: bool) -> Res<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(immutable);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("open {}: {error}", path.display()))
}

async fn count(pool: &SqlitePool, sql: &str) -> Res<i64> {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))
}

async fn count_bind(pool: &SqlitePool, sql: &str, bind: &str) -> Res<i64> {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))
}

/// Holds for any copy of the database, a backup mid-run included.
pub async fn structural(pool: &SqlitePool) -> Res<Vec<Check>> {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("integrity_check: {error}"))?;
    let foreign: i64 = count(pool, "SELECT COUNT(*) FROM pragma_foreign_key_check").await?;
    let zero = |name: &str, found: i64| {
        Check::new(name, found == 0, format!("{found} found, none allowed"))
    };
    Ok(vec![
        Check::new(
            "db_integrity",
            integrity == "ok",
            format!("integrity_check said {integrity}"),
        ),
        zero("db_foreign_keys", foreign),
        zero(
            "sscc_unique",
            count(
                pool,
                "SELECT COUNT(*) FROM (SELECT substr(sscc, 1, 17) AS k FROM \
                 (SELECT sscc FROM boxes WHERE sscc IS NOT NULL \
                  UNION ALL SELECT sscc FROM pallets WHERE sscc IS NOT NULL) \
                 GROUP BY k HAVING COUNT(*) > 1)",
            )
            .await?,
        ),
        zero(
            "sscc_blocks_disjoint",
            count(
                pool,
                "SELECT COUNT(*) FROM sscc_blocks a JOIN sscc_blocks b ON a.id < b.id \
                 AND a.issuer_prefix = b.issuer_prefix AND a.extension = b.extension \
                 AND a.from_serial <= b.to_serial AND b.from_serial <= a.to_serial",
            )
            .await?,
        ),
        zero(
            "sscc_serials_from_own_blocks",
            count(
                pool,
                "SELECT COUNT(*) FROM boxes b JOIN sscc_blocks k ON k.id = b.block_id \
                 WHERE b.serial NOT BETWEEN k.from_serial AND k.to_serial \
                 OR b.device_id <> k.device_id",
            )
            .await?,
        ),
        zero(
            "code_never_live_twice",
            count(
                pool,
                "SELECT COUNT(*) FROM (SELECT code_hash FROM box_items \
                 WHERE removed_at IS NULL AND displaced_at IS NULL \
                 GROUP BY code_hash HAVING COUNT(*) > 1)",
            )
            .await?,
        ),
    ])
}

async fn per_device(pool: &SqlitePool, sql: &str, shift: &str) -> Res<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(sql)
        .bind(shift)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("{sql}: {error}"))?;
    Ok(rows.into_iter().collect())
}

/// Every device's row in `shift_participants` is in `expected_state` (`active`
/// while the devices work, `closed` after their closes, as the ledger of the
/// run says), and no row is for a device the harness did not make.
pub async fn participants(
    pool: &SqlitePool,
    shift: &str,
    devices: &[(u32, String)],
    expected_state: &str,
) -> Res<Vec<Check>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT device_id, state FROM shift_participants WHERE shift_id = ?")
            .bind(shift)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("shift_participants: {error}"))?;
    let states: BTreeMap<String, String> = rows.into_iter().collect();
    let mut checks: Vec<Check> = devices
        .iter()
        .map(|(index, id)| {
            Check::same(
                &format!("participant_state_device_{index}"),
                Some(expected_state.to_owned()),
                states.get(id).cloned(),
            )
        })
        .collect();
    let foreign = states
        .keys()
        .filter(|id| !devices.iter().any(|(_, mine)| mine == *id))
        .count();
    checks.push(Check::same("participants_only_the_devices", 0, foreign));
    Ok(checks)
}

/// The state of every participant of `shift`, by the host's device id.
pub async fn participant_states(pool: &SqlitePool, shift: &str) -> Res<BTreeMap<String, String>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT device_id, state FROM shift_participants WHERE shift_id = ?")
            .bind(shift)
            .fetch_all(pool)
            .await
            .map_err(|error| format!("shift_participants: {error}"))?;
    Ok(rows.into_iter().collect())
}

/// Each named device (`(index, host id, state)`) is in the state given, and no other device took
/// part in the shift.
pub async fn participants_in(
    pool: &SqlitePool,
    shift: &str,
    expected: &[(u32, String, &str)],
) -> Res<Vec<Check>> {
    let states = participant_states(pool, shift).await?;
    let mut checks: Vec<Check> = expected
        .iter()
        .map(|(index, id, state)| {
            Check::same(
                &format!("participant_state_device_{index}"),
                Some((*state).to_owned()),
                states.get(id).cloned(),
            )
        })
        .collect();
    let foreign = states
        .keys()
        .filter(|id| !expected.iter().any(|(_, mine, _)| mine == *id))
        .count();
    checks.push(Check::same("participants_only_the_devices", 0, foreign));
    Ok(checks)
}

/// What holds for a shift in any copy of the database, in the middle of its closes too, beyond
/// the CHECKs of migration `0052`: a closed shift has no open part and an active one has one; a
/// shift its devices closed closes at the latest of their parts' moments (`facts::close_part`);
/// its close is audited once (`shift.close` or `shift.force_closed`); every accepted close event
/// is a part its device closed. A shift id the database does not have fails `shift_exists`.
pub async fn participant_invariants(pool: &SqlitePool, shift: &str) -> Res<Vec<Check>> {
    let zero = |name: &str, found: i64| {
        Check::new(name, found == 0, format!("{found} found, none allowed"))
    };
    let closed_with_open_parts = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s JOIN shift_participants p ON p.shift_id = s.id \
         WHERE s.id = ? AND s.status = 'closed' AND p.state IN ('active', 'left')",
        shift,
    )
    .await?;
    let active_without_open_part = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s WHERE s.id = ? AND s.status = 'active' \
         AND NOT EXISTS (SELECT 1 FROM shift_participants p \
                         WHERE p.shift_id = s.id AND p.state IN ('active', 'left'))",
        shift,
    )
    .await?;
    let wrong_moment = count_bind(
        pool,
        "SELECT COUNT(*) FROM shifts s WHERE s.id = ? AND s.status = 'closed' \
         AND s.closed_by_kind = 'device' AND s.closed_at IS NOT \
         (SELECT MAX(p.closed_at) FROM shift_participants p \
          WHERE p.shift_id = s.id AND p.closed_by_kind = 'device')",
        shift,
    )
    .await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("shifts: {error}"))?;
    let closes = count_bind(
        pool,
        "SELECT COUNT(*) FROM audit_log WHERE target_type = 'shift' AND target_id = ? \
         AND action IN ('shift.close', 'shift.force_closed')",
        shift,
    )
    .await?;
    let accepted_events = count_bind(
        pool,
        "SELECT COUNT(*) FROM shift_close_events WHERE shift_id = ? AND outcome = 'accepted'",
        shift,
    )
    .await?;
    let device_closed_parts = count_bind(
        pool,
        "SELECT COUNT(*) FROM shift_participants WHERE shift_id = ? AND closed_by_kind = 'device'",
        shift,
    )
    .await?;
    Ok(vec![
        // An unknown id makes every count below 0: they would all hold.
        Check::new(
            "shift_exists",
            status.is_some(),
            format!("shift {shift}: status {status:?}"),
        ),
        zero("closed_shift_has_no_open_part", closed_with_open_parts),
        zero("active_shift_has_an_open_part", active_without_open_part),
        zero(
            "device_closed_shift_closes_at_its_latest_part",
            wrong_moment,
        ),
        Check::same(
            "shift_closed_once",
            i64::from(status.as_deref() == Some("closed")),
            closes,
        ),
        Check::same(
            "close_events_match_device_closed_parts",
            device_closed_parts,
            accepted_events,
        ),
    ])
}

/// Holds for the live database of a quiet shift: every figure is the
/// ledger's. `devices` maps the harness's device index to the host's id.
pub async fn reconcile(
    pool: &SqlitePool,
    shift: &str,
    devices: &[(u32, String)],
    ledger: &Snapshot,
) -> Res<Vec<Check>> {
    let expected = &ledger.expected;
    let mut checks = Vec::new();
    let scans = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM scans WHERE shift_id = ? GROUP BY device_id",
        shift,
    )
    .await?;
    let receipts = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM fact_receipts WHERE shift_id = ? GROUP BY device_id",
        shift,
    )
    .await?;
    let boxes = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM boxes WHERE shift_id = ? AND sscc IS NOT NULL GROUP BY device_id",
        shift,
    )
    .await?;
    let pallets = per_device(
        pool,
        "SELECT device_id, COUNT(*) FROM pallets WHERE shift_id = ? AND sscc IS NOT NULL GROUP BY device_id",
        shift,
    )
    .await?;
    for (index, id) in devices {
        let of = |map: &BTreeMap<String, i64>| map.get(id).copied().unwrap_or(0) as u64;
        let ledger_of = |map: &BTreeMap<u32, u64>| map.get(index).copied().unwrap_or(0);
        checks.push(Check::same(
            &format!("db_scans_device_{index}"),
            ledger_of(&ledger.scan_rows),
            of(&scans),
        ));
        checks.push(Check::same(
            &format!("db_receipts_device_{index}"),
            ledger_of(&ledger.records),
            of(&receipts),
        ));
        checks.push(Check::same(
            &format!("db_boxes_device_{index}"),
            ledger_of(&ledger.boxes_closed),
            of(&boxes),
        ));
        checks.push(Check::same(
            &format!("db_pallets_device_{index}"),
            ledger_of(&ledger.pallets_closed),
            of(&pallets),
        ));
    }
    checks.push(Check::same(
        "db_code_owners",
        expected.distinct_accepted_codes as i64,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM code_owners WHERE shift_id = ?",
            shift,
        )
        .await?,
    ));
    checks.push(Check::same(
        "db_live_items",
        expected.distinct_accepted_codes as i64,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
             WHERE b.shift_id = ? AND i.removed_at IS NULL AND i.displaced_at IS NULL",
            shift,
        )
        .await?,
    ));
    let conflicts = |kind: &'static str| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM code_conflicts c JOIN scans s ON s.id = c.loser_scan_id \
             WHERE c.kind = ? AND s.shift_id = ?",
        )
        .bind(kind)
        .bind(shift)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("code_conflicts {kind}: {error}"))
    };
    checks.push(Check::same(
        "db_conflicts_late",
        expected.conflict_receipts as i64,
        conflicts("late").await?,
    ));
    checks.push(Check::same(
        "db_conflicts_displaced",
        expected.displacements as i64,
        conflicts("displaced").await?,
    ));
    checks.push(Check::same(
        "db_rejected_receipts",
        0,
        count_bind(
            pool,
            "SELECT COUNT(*) FROM fact_receipts WHERE shift_id = ? AND outcome = 'rejected'",
            shift,
        )
        .await?,
    ));
    Ok(checks)
}

/// The row counts of the tables a restore must bring back whole.
pub const RESTORED_TABLES: [&str; 9] = [
    "scans",
    "boxes",
    "box_items",
    "code_owners",
    "code_conflicts",
    "pallets",
    "fact_receipts",
    "shift_participants",
    "sscc_blocks",
];

pub async fn table_counts(pool: &SqlitePool) -> Res<BTreeMap<String, i64>> {
    let mut counts = BTreeMap::new();
    for table in RESTORED_TABLES {
        counts.insert(
            table.to_owned(),
            count(pool, &format!("SELECT COUNT(*) FROM {table}")).await?,
        );
    }
    Ok(counts)
}

pub async fn scan_count(pool: &SqlitePool) -> Res<i64> {
    count(pool, "SELECT COUNT(*) FROM scans").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, SqliteConnection};
    use std::collections::BTreeSet;

    #[tokio::test]
    async fn a_new_database_passes_every_structural_check_and_every_table_counts_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        let pool = open_read_only(&path, false).await.unwrap();
        let checks = structural(&pool).await.unwrap();
        assert_eq!(checks.len(), 6);
        assert!(checks.iter().all(|check| check.ok), "{checks:?}");
        let counts = table_counts(&pool).await.unwrap();
        assert_eq!(counts.len(), RESTORED_TABLES.len());
        assert!(counts.values().all(|count| *count == 0));
        let checks = reconcile(&pool, "none", &[(0, "d0".to_owned())], &Snapshot::default())
            .await
            .unwrap();
        assert!(checks.iter().all(|check| check.ok), "{checks:?}");
    }

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    /// A populated database of one shift and two devices that every check
    /// holds for: 6 scans (3 and 3), 6 receipts, 2 closed boxes, 4 distinct
    /// codes (A, B, C, D), one late conflict (A seen again on d1) and one
    /// displacement (D scanned first on d0, later on d1).
    async fn seed(path: &Path) {
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        let mut sql = String::from(
            "INSERT INTO lines (id, name, name_key, rev) VALUES ('l1', 'Line', 'line', 1);
             INSERT INTO products (id, gtin14, name, rev) VALUES ('p1', '04600000000017', 'Product', 1);
             INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, paired_at)
               VALUES ('d0', 'station', 'S0', 'l1', 'k0', '1', 1, 't'),
                      ('d1', 'station', 'S1', 'l1', 'k1', '1', 1, 't');
             INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES ('4600000', 0, 100, 1);
             INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, from_serial, to_serial, issued_at)
               VALUES ('b0', '4600000', 0, 'd0', 'r0', 0, 9, 't'),
                      ('b1', '4600000', 0, 'd1', 'r1', 10, 19, 't');
             INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, created_by,
               status, mode, product_id, line_id, production_date, box_capacity, box_template_id,
               owner_device_id, snapshot, opened_at, created_at, rev)
               VALUES ('s1', '2026-10', 1, 'office', 'office_user', 'u', 'active', 'aggregation', 'p1', 'l1',
               '2026-10-22', 10, 't1', 'd0', '{}', 't', 't', 1);
             INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at)
               VALUES ('s1', 'd0', 't', 't'), ('s1', 'd1', 't', 't');
             INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, serial,
               item_count_reported, digest_matches, received_at) VALUES
               ('x1', 's1', 'd0', 't', 't', '046000000000000000' || '1', 'b0', 0, 3, 1, 't'),
               ('x2', 's1', 'd1', 't', 't', '046000000000000010' || '2', 'b1', 10, 2, 1, 't');",
        );
        // (scan, device, verdict, code hash, box); duplicates keep no box
        let scans = [
            ("c1", "d0", "ok", HASH_A, Some("x1")),
            ("c2", "d0", "ok", HASH_B, Some("x1")),
            ("c6", "d0", "ok", HASH_D, Some("x1")),
            ("c3", "d1", "ok", HASH_C, Some("x2")),
            ("c4", "d1", "duplicate", HASH_A, None),
            ("c5", "d1", "ok", HASH_D, Some("x2")),
        ];
        for (id, device, verdict, hash, box_id) in scans {
            let source = if verdict == "duplicate" {
                "'host'"
            } else {
                "NULL"
            };
            let box_sql = box_id.map_or("NULL".to_owned(), |b| format!("'{b}'"));
            sql.push_str(&format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, raw_kind,
                   raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at)
                 VALUES ('{id}', 'r-{id}', '{device}', 's1', '{verdict}', {source}, 'km', 30, '{hash}',
                   '04600000000017', '{id}', 'canon-{id}', {box_sql}, 't', 't');
                 INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, received_at)
                 VALUES ('{device}', 'r-{id}', 'scan', 's1', '{}', 'accepted', 't');",
                "0".repeat(64)
            ));
        }
        sql.push_str(&format!(
            "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, displaced_at) VALUES
               ('c1', 'x1', '{HASH_A}', 't', NULL), ('c2', 'x1', '{HASH_B}', 't', NULL),
               ('c6', 'x1', '{HASH_D}', 't', NULL), ('c3', 'x2', '{HASH_C}', 't', NULL),
               ('c5', 'x2', '{HASH_D}', 't', 't');
             INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) VALUES
               ('{HASH_A}', 'c1', 's1', 'd0', 'x1', 't'), ('{HASH_B}', 'c2', 's1', 'd0', 'x1', 't'),
               ('{HASH_D}', 'c6', 's1', 'd0', 'x1', 't'), ('{HASH_C}', 'c3', 's1', 'd1', 'x2', 't');
             INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at, kind) VALUES
               ('f1', '{HASH_A}', 'c1', 'c4', 't', 'late'), ('f2', '{HASH_D}', 'c6', 'c5', 't', 'displaced');"
        ));
        sqlx::raw_sql(&sql).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
    }

    fn snapshot() -> Snapshot {
        let pair = |a: u64, b: u64| BTreeMap::from([(0u32, a), (1u32, b)]);
        Snapshot {
            expected: crate::ledger::Expected {
                records: 6,
                scan_rows: 6,
                distinct_accepted_codes: 4,
                conflict_receipts: 1,
                displacements: 1,
                boxes_closed: 2,
                pallets_closed: 0,
                rejected: 0,
            },
            records: pair(3, 3),
            scan_rows: pair(3, 3),
            boxes_closed: pair(1, 1),
            pallets_closed: BTreeMap::new(),
        }
    }

    fn devices() -> Vec<(u32, String)> {
        vec![(0, "d0".to_owned()), (1, "d1".to_owned())]
    }

    /// Every check of both sets, by name, that does not hold.
    async fn failed(path: &Path) -> BTreeSet<String> {
        let pool = open_read_only(path, true).await.unwrap();
        let mut all = structural(&pool).await.unwrap();
        all.extend(
            reconcile(&pool, "s1", &devices(), &snapshot())
                .await
                .unwrap(),
        );
        pool.close().await;
        all.into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect()
    }

    /// A temp copy of the seeded database, corrupted by `sql` (foreign keys
    /// off, so a row can be left dangling on purpose), checked afterwards.
    async fn mutated(sql: &str) -> BTreeSet<String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql("PRAGMA foreign_keys = OFF; PRAGMA recursive_triggers = OFF;")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        failed(&path).await
    }

    fn names(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    #[tokio::test]
    async fn the_populated_fixture_passes_every_check_and_counts_what_it_holds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        assert_eq!(failed(&path).await, names(&[]));
        let pool = open_read_only(&path, true).await.unwrap();
        let counts = table_counts(&pool).await.unwrap();
        assert_eq!(counts["scans"], 6);
        assert_eq!(counts["boxes"], 2);
        assert_eq!(counts["box_items"], 5);
        assert_eq!(counts["code_owners"], 4);
        assert_eq!(counts["code_conflicts"], 2);
        assert_eq!(counts["pallets"], 0);
        assert_eq!(counts["fact_receipts"], 6);
        assert_eq!(counts["shift_participants"], 2);
        assert_eq!(counts["sscc_blocks"], 2);
        assert_eq!(scan_count(&pool).await.unwrap(), 6);
    }

    #[tokio::test]
    async fn a_read_only_pool_refuses_to_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        for immutable in [false, true] {
            let pool = open_read_only(&path, immutable).await.unwrap();
            let write = sqlx::query("DELETE FROM scans").execute(&pool).await;
            assert!(write.is_err(), "immutable={immutable}");
            assert_eq!(scan_count(&pool).await.unwrap(), 6);
        }
    }

    #[tokio::test]
    async fn a_missing_receipt_is_reported() {
        let got = mutated("DELETE FROM fact_receipts WHERE record_id = 'r-c1'").await;
        assert_eq!(got, names(&["db_receipts_device_0"]));
    }

    #[tokio::test]
    async fn a_scan_row_on_the_wrong_device_is_reported() {
        let got = mutated("UPDATE scans SET device_id = 'd0' WHERE id = 'c4'").await;
        assert_eq!(got, names(&["db_scans_device_0", "db_scans_device_1"]));
    }

    #[tokio::test]
    async fn a_lost_code_owner_is_reported() {
        let got = mutated(&format!(
            "DELETE FROM code_owners WHERE code_hash = '{HASH_D}'"
        ))
        .await;
        assert_eq!(got, names(&["db_code_owners"]));
    }

    #[tokio::test]
    async fn a_code_live_in_two_boxes_is_reported() {
        let got = mutated("UPDATE box_items SET displaced_at = NULL WHERE scan_id = 'c5'").await;
        assert_eq!(got, names(&["code_never_live_twice", "db_live_items"]));
    }

    #[tokio::test]
    async fn a_missing_conflict_row_is_reported() {
        let late = mutated("DELETE FROM code_conflicts WHERE id = 'f1'").await;
        assert_eq!(late, names(&["db_conflicts_late"]));
        let displaced = mutated("DELETE FROM code_conflicts WHERE id = 'f2'").await;
        assert_eq!(displaced, names(&["db_conflicts_displaced"]));
    }

    #[tokio::test]
    async fn a_rejected_receipt_is_reported() {
        let got = mutated(
            "UPDATE fact_receipts SET outcome = 'rejected', code = 'x' WHERE record_id = 'r-c2'",
        )
        .await;
        assert_eq!(got, names(&["db_rejected_receipts"]));
    }

    #[tokio::test]
    async fn a_closed_box_missing_from_the_database_is_reported() {
        let got = mutated("UPDATE boxes SET closed_at = NULL, sscc = NULL, block_id = NULL, serial = NULL, digest_matches = NULL WHERE id = 'x2'").await;
        assert_eq!(got, names(&["db_boxes_device_1"]));
    }

    #[tokio::test]
    async fn an_sscc_body_twice_is_reported_whatever_its_check_digit() {
        let got =
            mutated("UPDATE boxes SET sscc = '046000000000000000' || '9' WHERE id = 'x2'").await;
        assert_eq!(got, names(&["sscc_unique"]));
    }

    #[tokio::test]
    async fn overlapping_blocks_are_reported() {
        let got = mutated("UPDATE sscc_blocks SET from_serial = 5 WHERE id = 'b1'").await;
        assert_eq!(got, names(&["sscc_blocks_disjoint"]));
    }

    #[tokio::test]
    async fn a_serial_outside_its_own_block_is_reported() {
        let got = mutated("UPDATE boxes SET block_id = 'b0' WHERE id = 'x2'").await;
        assert_eq!(got, names(&["sscc_serials_from_own_blocks"]));
    }

    #[tokio::test]
    async fn a_dangling_reference_is_reported() {
        let got = mutated("DELETE FROM sscc_blocks WHERE id = 'b1'").await;
        assert_eq!(got, names(&["db_foreign_keys"]));
    }

    #[tokio::test]
    async fn a_damaged_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        // an index that no longer matches its table
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(
            "PRAGMA writable_schema = ON;
             UPDATE sqlite_schema SET sql = replace(sql, 'WHERE removed_at IS NULL AND displaced_at IS NULL', 'WHERE removed_at IS NULL')
               WHERE name = 'box_items_live';",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let checks = structural(&pool).await.unwrap();
        let integrity = checks.iter().find(|c| c.name == "db_integrity").unwrap();
        assert!(!integrity.ok, "{integrity:?}");
    }

    /// The participants' states of the seeded shift, judged after `sql`.
    async fn participants_after(sql: &str, expected: &str) -> BTreeSet<String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let checks = participants(&pool, "s1", &devices(), expected)
            .await
            .unwrap();
        pool.close().await;
        checks
            .into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect()
    }

    #[tokio::test]
    async fn participants_match_the_ledger_state_they_are_expected_in() {
        assert_eq!(participants_after("SELECT 1", "active").await, names(&[]));
        // every part closed, as after the closes of a run
        let closed = "UPDATE shift_participants SET state = 'closed', closed_at = 't', closed_by_kind = 'device'";
        assert_eq!(participants_after(closed, "closed").await, names(&[]));
    }

    #[tokio::test]
    async fn a_participant_in_the_wrong_state_is_reported_by_device() {
        // one device still active after the closes
        let one = "UPDATE shift_participants SET state = 'closed', closed_at = 't', closed_by_kind = 'device' WHERE device_id = 'd0'";
        assert_eq!(
            participants_after(one, "closed").await,
            names(&["participant_state_device_1"])
        );
        // a part closed before the run said so
        assert_eq!(
            participants_after(one, "active").await,
            names(&["participant_state_device_0"])
        );
    }

    #[tokio::test]
    async fn a_missing_or_extra_participant_row_is_reported() {
        let got = participants_after(
            "DELETE FROM shift_participants WHERE device_id = 'd1'",
            "active",
        )
        .await;
        assert_eq!(got, names(&["participant_state_device_1"]));
        let extra = "INSERT INTO devices (id, kind, name, line_id, key_hash, app_version, protocol, paired_at)
               VALUES ('d2', 'station', 'S2', 'l1', 'k2', '1', 1, 't');
             INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at)
               VALUES ('s1', 'd2', 't', 't')";
        assert_eq!(
            participants_after(extra, "active").await,
            names(&["participants_only_the_devices"])
        );
    }

    /// The participant invariants of the seeded shift, judged after `sql`.
    async fn invariants_after(sql: &str) -> BTreeSet<String> {
        invariants_of_after("s1", sql).await
    }

    /// The participant invariants of `shift`, judged after `sql`.
    async fn invariants_of_after(shift: &str, sql: &str) -> BTreeSet<String> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let checks = participant_invariants(&pool, shift).await.unwrap();
        pool.close().await;
        assert_eq!(checks.len(), 6);
        checks
            .into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect()
    }

    /// Both parts closed by their devices (d1 the later), with their close events.
    const PARTS_CLOSED_BY_DEVICES: &str = "UPDATE shift_participants SET state = 'closed', \
         closed_by_kind = 'device', closed_at = CASE device_id WHEN 'd0' \
         THEN '2026-10-22T10:00:00Z' ELSE '2026-10-22T10:00:05Z' END;
         INSERT INTO shift_close_events (id, record_id, shift_id, device_id, actual_qty, \
         closed_box_count, closed_at, outcome, received_at) VALUES \
         ('e0', 'r-e0', 's1', 'd0', 3, 1, 't', 'accepted', 't'), \
         ('e1', 'r-e1', 's1', 'd1', 3, 1, 't', 'accepted', 't');";

    /// The shift closed by its last device at `at`, audited once.
    fn shift_closed_by_d1(at: &str) -> String {
        format!(
            "UPDATE shifts SET status = 'closed', closed_at = '{at}', closed_by_kind = 'device', \
             closed_by = 'd1' WHERE id = 's1';
             INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, \
             result, details) VALUES ('t', 'device', 'd1', 'shift.close', 'shift', 's1', 'ok', '{{}}');"
        )
    }

    #[tokio::test]
    async fn the_participant_invariants_hold_for_an_open_and_a_cleanly_closed_shift() {
        assert_eq!(invariants_after("SELECT 1").await, names(&[]));
        let closed = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}",
            shift_closed_by_d1("2026-10-22T10:00:05Z")
        );
        assert_eq!(invariants_after(&closed).await, names(&[]));
        // The office's force close: parts closed by the office, audited as `shift.force_closed`.
        let forced = "UPDATE shift_participants SET state = 'closed', \
             closed_by_kind = 'office_user', closed_at = '2026-10-22T10:00:00Z';
             UPDATE shifts SET status = 'closed', closed_at = '2026-10-22T10:00:00Z', \
             closed_by_kind = 'office_user', closed_by = 'u' WHERE id = 's1';
             INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, \
             result, details) VALUES ('t', 'office_user', 'u', 'shift.force_closed', 'shift', \
             's1', 'ok', '{}');";
        assert_eq!(invariants_after(forced).await, names(&[]));
    }

    #[tokio::test]
    async fn the_participant_invariants_of_a_shift_that_does_not_exist_fail() {
        // Every count is 0 for an unknown id: without the existence check they would all hold.
        assert_eq!(
            invariants_of_after("no-such-shift", "SELECT 1").await,
            names(&["shift_exists"])
        );
    }

    #[tokio::test]
    async fn each_broken_participant_invariant_is_named() {
        // The shift closed while its parts are open, and its close was never audited.
        let open_parts =
            "UPDATE shifts SET status = 'closed', closed_at = '2026-10-22T10:00:00Z', \
             closed_by_kind = 'office_user', closed_by = 'u' WHERE id = 's1';";
        assert_eq!(
            invariants_after(open_parts).await,
            names(&["closed_shift_has_no_open_part", "shift_closed_once"])
        );
        // Every part closed, the shift still active, and no close event behind the parts.
        let no_close = "UPDATE shift_participants SET state = 'closed', \
             closed_by_kind = 'device', closed_at = '2026-10-22T10:00:00Z';";
        assert_eq!(
            invariants_after(no_close).await,
            names(&[
                "active_shift_has_an_open_part",
                "close_events_match_device_closed_parts"
            ])
        );
        // Closed at the earlier part's moment, not the later one.
        let early = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}",
            shift_closed_by_d1("2026-10-22T10:00:00Z")
        );
        assert_eq!(
            invariants_after(&early).await,
            names(&["device_closed_shift_closes_at_its_latest_part"])
        );
        // The close audited twice.
        let twice = format!(
            "{PARTS_CLOSED_BY_DEVICES}{}INSERT INTO audit_log (at, actor_kind, actor_id, action, \
             target_type, target_id, result, details) VALUES ('t', 'device', 'd1', 'shift.close', \
             'shift', 's1', 'ok', '{{}}');",
            shift_closed_by_d1("2026-10-22T10:00:05Z")
        );
        assert_eq!(
            invariants_after(&twice).await,
            names(&["shift_closed_once"])
        );
    }

    #[tokio::test]
    async fn participants_in_names_each_device_its_own_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.db");
        markiro_host::db::open(&path).await.unwrap().close().await;
        seed(&path).await;
        let mut db = SqliteConnection::connect(&format!("sqlite://{}", path.display()))
            .await
            .unwrap();
        sqlx::raw_sql(
            "UPDATE shift_participants SET state = 'left', left_at = 't' WHERE device_id = 'd1'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        db.close().await.unwrap();
        let pool = open_read_only(&path, true).await.unwrap();
        let states = participant_states(&pool, "s1").await.unwrap();
        assert_eq!(states.get("d1").map(String::as_str), Some("left"));
        let good = participants_in(
            &pool,
            "s1",
            &[(0, "d0".to_owned(), "active"), (1, "d1".to_owned(), "left")],
        )
        .await
        .unwrap();
        assert!(good.iter().all(|check| check.ok), "{good:?}");
        let bad = participants_in(&pool, "s1", &[(0, "d0".to_owned(), "left")])
            .await
            .unwrap();
        let failed: BTreeSet<String> = bad
            .into_iter()
            .filter(|check| !check.ok)
            .map(|check| check.name)
            .collect();
        assert_eq!(
            failed,
            names(&[
                "participant_state_device_0",
                "participants_only_the_devices"
            ])
        );
        pool.close().await;
    }
}
