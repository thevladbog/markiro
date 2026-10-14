//! Migration `0028` (beta 3 feedback): every shift a host already holds takes
//! its production date as its shift date, and a shift written without one
//! takes it too.

use markiro_host::db::{options, MIGRATOR};
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqlitePoolOptions;

#[tokio::test]
async fn the_shifts_already_there_take_their_production_date_as_the_shift_date() {
    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options(&dir.path().join("host.db")).create_if_missing(true))
        .await
        .unwrap();
    let before = Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version != 28)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    before.run(&pool).await.unwrap();
    for statement in [
        "INSERT INTO lines (id, name, name_key, rev) VALUES ('line-1', 'Линия 1', 'линия 1', 1)",
        "INSERT INTO products (id, gtin14, name, rev) \
         VALUES ('product-1', '04600682000013', 'Сок яблочный', 1)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, created_at, rev) \
         VALUES ('shift-a', 'OCT26', 1, 'office', 'office_user', 'user-1', 'planned', \
         'aggregation', 'product-1', 'line-1', '2026-10-09', 12, 'template-1', \
         '2026-10-08T17:00:00Z', 1)",
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, created_at, rev) \
         VALUES ('shift-b', 'NOV26', 1, 'office', 'office_user', 'user-1', 'planned', \
         'aggregation', 'product-1', 'line-1', '2026-11-02', 12, 'template-1', \
         '2026-10-08T17:00:00Z', 2)",
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }

    MIGRATOR.run(&pool).await.unwrap();

    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, planned_date FROM shifts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        [
            ("shift-a".to_owned(), Some("2026-10-09".to_owned())),
            ("shift-b".to_owned(), Some("2026-11-02".to_owned())),
        ]
    );
    // A shift written without a shift date takes its production date.
    sqlx::query(
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, status, mode, product_id, line_id, production_date, box_capacity, \
         box_template_id, created_at, rev) \
         VALUES ('shift-c', 'NOV26', 2, 'office', 'office_user', 'user-1', 'planned', \
         'aggregation', 'product-1', 'line-1', '2026-11-03', 12, 'template-1', \
         '2026-10-08T17:00:00Z', 3)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let late: String = sqlx::query_scalar("SELECT planned_date FROM shifts WHERE id = 'shift-c'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(late, "2026-11-03");
    // The column refuses what is not a civil date.
    let refused = sqlx::query("UPDATE shifts SET planned_date = 'tomorrow' WHERE id = 'shift-c'")
        .execute(&pool)
        .await;
    assert!(refused.is_err());
}
