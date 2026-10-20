//! Migration `0052` (plan 2b): a line takes a limit of devices per shift (1 for every line already
//! there), a participant takes its own state (`active` in an open shift; `closed` with a closed
//! shift, by whoever closed it, with the figures of its own accepted close), and a shift takes a flag
//! for a reason its devices did not give. Columns only: every row stays.

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

const VERSION: i64 = 52;

type Participant = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
);

async fn migrated_from_51() -> (tempfile::TempDir, SqlitePool) {
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(&dir.path().join("host.db")).create_if_missing(true))
        .await
        .unwrap();
    let before = Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version < VERSION)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    for statement in [
        "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
        "INSERT INTO products (id, gtin14, name, rev) \
         VALUES ('product-1', '04600682000013', 'Молоко', 1)",
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('station-a', 'station', 'Станция А', 'hash-a', '1.0.0', 6, '2026-10-01T08:00:00Z')",
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('station-b', 'station', 'Станция Б', 'hash-b', '1.0.0', 6, '2026-10-01T08:00:00Z')",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, created_at, rev) VALUES ('shift-planned', 'OCT26', 1, 'office', \
         'office_user', 'user-1', 'planned', 'aggregation', 'product-1', 'line-1', '2026-10-08', \
         12, 'template-1', '2026-10-07T17:00:00Z', 1)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, created_at, rev) \
         VALUES ('shift-open', 'OCT26', 2, 'office', 'office_user', 'user-1', 'active', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-a', '2026-10-07T17:00:00Z', 2)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, closed_at, closed_by_kind, \
         closed_by, close_reason_code, created_at, rev) \
         VALUES ('shift-device', 'OCT26', 3, 'office', 'office_user', 'user-1', 'closed', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-a', '2026-10-08T14:00:00Z', 'device', 'station-a', \
         'equipment_stop', '2026-10-07T17:00:00Z', 3)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, snapshot, opened_at, owner_device_id, closed_at, closed_by_kind, \
         closed_by, close_reason_text, created_at, rev) \
         VALUES ('shift-office', 'OCT26', 4, 'office', 'office_user', 'user-1', 'closed', \
         'aggregation', 'product-1', 'line-1', '2026-10-08', 12, 'template-1', '{}', \
         '2026-10-08T06:00:00Z', 'station-b', '2026-10-08T16:00:00Z', 'office_user', 'user-1', \
         'Сбой', '2026-10-07T17:00:00Z', 4)",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-open', 'station-a', '2026-10-08T06:00:00Z', '2026-10-08T07:00:00Z')",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-device', 'station-a', '2026-10-08T06:00:00Z', '2026-10-08T06:00:00Z')",
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES ('shift-office', 'station-b', '2026-10-08T06:10:00Z', '2026-10-08T06:10:00Z')",
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES ('event-1', 'record-1', 'shift-device', 'station-a', NULL, 250, 249, \
         20, 'equipment_stop', '2026-10-08T14:00:00.000Z', 'accepted', '2026-10-08T14:00:05Z')",
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES ('event-2', 'record-2', 'shift-office', 'station-b', NULL, NULL, 10, \
         1, NULL, '2026-10-08T16:30:00.000Z', 'already_closed', '2026-10-08T16:30:05Z')",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    MIGRATOR.run(&pool).await.unwrap();
    (dir, pool)
}

fn refused(result: Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error>) {
    let error = result.expect_err("the write was taken");
    assert!(
        error.to_string().contains("CHECK constraint failed"),
        "{error}"
    );
}

#[tokio::test]
async fn existing_participants_take_the_state_of_their_shift() {
    let (_dir, pool) = migrated_from_51().await;
    let rows: Vec<Participant> = sqlx::query_as(
        "SELECT shift_id, device_id, state, joined_at, left_at, closed_at, closed_by_kind, \
         closed_actual_qty, closed_reason, late_data_at FROM shift_participants ORDER BY shift_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let at = |text: &str| Some(text.to_owned());
    assert_eq!(
        rows,
        vec![
            (
                "shift-device".to_owned(),
                "station-a".to_owned(),
                "closed".to_owned(),
                at("2026-10-08T06:00:00Z"),
                None,
                at("2026-10-08T14:00:00Z"),
                at("device"),
                Some(249),
                at("equipment_stop"),
                None,
            ),
            (
                "shift-office".to_owned(),
                "station-b".to_owned(),
                "closed".to_owned(),
                at("2026-10-08T06:10:00Z"),
                None,
                at("2026-10-08T16:00:00Z"),
                at("office_user"),
                None,
                None,
                None,
            ),
            (
                "shift-open".to_owned(),
                "station-a".to_owned(),
                "active".to_owned(),
                at("2026-10-08T06:00:00Z"),
                None,
                None,
                None,
                None,
                None,
                None,
            ),
        ]
    );
    let limits: Vec<i64> = sqlx::query_scalar("SELECT max_stations FROM lines")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(limits, [1]);
    let missing: Vec<i64> =
        sqlx::query_scalar("SELECT close_reason_missing FROM shifts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(missing, [0, 0, 0, 0]);
}

#[tokio::test]
async fn the_new_columns_refuse_what_no_row_may_hold() {
    let (_dir, pool) = migrated_from_51().await;
    let run = |sql: &'static str| sqlx::query(sql).execute(&pool);
    refused(run("UPDATE lines SET max_stations = 0").await);
    refused(run("UPDATE lines SET max_stations = 17").await);
    run("UPDATE lines SET max_stations = 16").await.unwrap();
    refused(
        run("UPDATE shift_participants SET state = 'paused' WHERE shift_id = 'shift-open'").await,
    );
    refused(
        run("UPDATE shift_participants SET state = 'left' WHERE shift_id = 'shift-open'").await,
    );
    run(
        "UPDATE shift_participants SET state = 'left', left_at = '2026-10-08T08:00:00Z' \
         WHERE shift_id = 'shift-open'",
    )
    .await
    .unwrap();
    refused(
        run(
            "UPDATE shift_participants SET late_data_at = '2026-10-08T08:05:00Z' \
             WHERE shift_id = 'shift-open'",
        )
        .await,
    );
    refused(
        run("UPDATE shift_participants SET closed_actual_qty = 5 WHERE shift_id = 'shift-office'")
            .await,
    );
    refused(run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-open'").await);
    refused(run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-device'").await);
    run("UPDATE shifts SET close_reason_missing = 1 WHERE id = 'shift-office'")
        .await
        .unwrap();
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM shifts), (SELECT COUNT(*) FROM shift_participants)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (4, 3));
}

#[tokio::test]
async fn existing_participants_take_their_shifts_revision_as_the_leave_token() {
    let (_dir, pool) = migrated_from_51().await;
    let rows: Vec<(String, Option<i64>, i64)> = sqlx::query_as(
        "SELECT p.shift_id, p.joined_rev, s.rev FROM shift_participants p \
         JOIN shifts s ON s.id = p.shift_id ORDER BY p.shift_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    for (shift, token, rev) in rows {
        assert_eq!(token, Some(rev), "{shift}");
    }
    refused(
        sqlx::query("UPDATE shift_participants SET joined_rev = -1")
            .execute(&pool)
            .await,
    );
}
