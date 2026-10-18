//! Migration `0011` (plan РК): the second folder setting and the restore
//! epoch that `hello` reports.

mod support;

use axum::http::StatusCode;
use support::app::{empty, request, TestApp};

#[tokio::test]
async fn a_new_host_has_no_second_folder_and_no_restore_epoch() {
    let app = TestApp::new().await;
    let settings: (Option<String>, i64) =
        sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(settings, (None, 0));
    let site: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT restore_epoch, facts_held_since FROM site WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(site, (None, None));
    let (device, _) = support::app::pair_device(&app, "station").await;
    let known: Option<String> =
        sqlx::query_scalar("SELECT known_blocks_epoch FROM devices WHERE id = ?")
            .bind(&device)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(known, None);
}

#[tokio::test]
async fn the_settings_table_holds_one_row_and_a_bounded_folder() {
    let app = TestApp::new().await;
    for statement in [
        "INSERT INTO backup_settings (id) VALUES (2)",
        "UPDATE backup_settings SET second_dir = '' WHERE id = 1",
    ] {
        let error = sqlx::query(statement)
            .execute(&app.state.pool)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("CHECK"), "{statement}: {error}");
    }
    let long = "x".repeat(261);
    let error = sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind(&long)
        .execute(&app.state.pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("CHECK"), "{error}");
    sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind("x".repeat(260))
        .execute(&app.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn hello_names_the_restore_epoch_only_once_there_is_one() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("restoreEpoch").is_none(), "{body}");
    assert_eq!(body["initialized"], false);
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    sqlx::query("UPDATE site SET restore_epoch = ?, initialized_at = '2026-10-09T15:00:00Z'")
        .bind(epoch)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, body) = app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restoreEpoch"], epoch);
    assert_eq!(body["initialized"], true);
}

#[test]
fn the_backups_folder_is_part_of_the_data_folder() {
    let dir = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(dir.path());
    assert_eq!(paths.backups_dir(), dir.path().join("backups"));
    paths.ensure().unwrap();
    assert!(paths.backups_dir().is_dir());
}

/// `0011` is numbered below `0012` (pallets), which an installation made from
/// the integration branch before РК already has applied. sqlx runs every
/// migration the table lacks, in version order, and refuses only a migration
/// that was applied and is gone (`VersionMissing`) or edited (`VersionMismatch`):
/// such a database takes `0011` late, keeps its data and its `0012`.
#[tokio::test]
async fn a_database_that_already_has_0012_takes_0011_late() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let without_backups = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != 11)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    assert_eq!(
        without_backups.iter().count() + 1,
        markiro_host::db::MIGRATOR.iter().count()
    );
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    without_backups.run(&mut old).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    assert!(
        versions.contains(&12) && !versions.contains(&11),
        "{versions:?}"
    );
    sqlx::query("UPDATE site SET initialized_at = '2026-10-09T15:00:00Z' WHERE id = 1")
        .execute(&mut old)
        .await
        .unwrap();

    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();

    let applied: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    assert!(
        applied.contains(&(11, true)) && applied.contains(&(12, true)),
        "{applied:?}"
    );
    assert_eq!(applied.len(), markiro_host::db::MIGRATOR.iter().count());
    let site: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT initialized_at, restore_epoch, facts_held_since FROM site WHERE id = 1",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!(site, (Some("2026-10-09T15:00:00Z".to_owned()), None, None));
    let settings: (Option<String>, i64) =
        sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
            .fetch_one(&mut old)
            .await
            .unwrap();
    assert_eq!(settings, (None, 0));
}
