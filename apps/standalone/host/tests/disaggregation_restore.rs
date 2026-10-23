//! A restore lifts the disaggregation document numbers (plan ДЗГ, task 7):
//! the counter of `DSG-YY-NNNN` ends above both databases by the shift
//! numbers' margin, so a number printed on an act after the copy is never
//! issued twice.

mod support;

use std::path::PathBuf;

use axum::http::StatusCode;
use markiro_host::backup::copy::{make_copy, Manifest};
use markiro_host::config::HostPaths;
use markiro_host::restore::{restore, SHIFT_NUMBER_MARGIN};
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::{Connection, SqlitePool};
use support::app::{admin, Admin, TestApp};
use support::backup::{at, stop, worker_conn};

const NOW: &str = "2026-10-09T15:00:00Z";

/// A verified copy of `app`'s database in `<data dir>/backups`.
async fn copy(app: &TestApp) -> (PathBuf, Manifest) {
    let folder = app.dir().join("backups");
    std::fs::create_dir_all(&folder).unwrap();
    let mut conn = worker_conn(app).await;
    let manifest = make_copy(
        &mut conn,
        &folder,
        app.state.now(),
        BackupTrigger::Scheduled,
        &app.state.host_id,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    (folder.join(&manifest.file), manifest)
}

async fn reopen(paths: &HostPaths) -> SqlitePool {
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
}

async fn document(admin: &Admin) {
    let (status, body) = admin
        .call("POST", "/v1/office/disaggregation", Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn counter(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT last_seq FROM disaggregation_doc_counters")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_restore_lifts_the_disaggregation_numbers_above_both_databases() {
    let admin = admin().await;
    for _ in 0..2 {
        document(&admin).await;
    }
    let (copy_path, _) = copy(&admin.app).await;
    // After the copy: three documents it never saw (one printed on an act, say).
    for _ in 0..3 {
        document(&admin).await;
    }
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let pool = reopen(&paths).await;
    // The current database reached 5; ten above it.
    assert_eq!(counter(&pool).await, 5 + SHIFT_NUMBER_MARGIN);
}

#[tokio::test]
async fn an_unreadable_current_database_leaves_the_margin_over_the_copy() {
    let admin = admin().await;
    for _ in 0..2 {
        document(&admin).await;
    }
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    std::fs::write(paths.database_file(), b"what is left of a dead disk").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let pool = reopen(&paths).await;
    assert_eq!(counter(&pool).await, 2 + SHIFT_NUMBER_MARGIN);
}

#[tokio::test]
async fn without_documents_in_either_database_the_counter_stays_at_zero() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let pool = reopen(&paths).await;
    assert_eq!(counter(&pool).await, 0);
}

#[tokio::test]
async fn the_next_document_after_a_restore_is_numbered_above_the_lost_ones() {
    let admin = admin().await;
    document(&admin).await;
    let (copy_path, _) = copy(&admin.app).await;
    // DSG-26-0002 and DSG-26-0003 are the numbers the copy never saw.
    document(&admin).await;
    document(&admin).await;
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let pool = reopen(&paths).await;
    // The current database reached 3; the next number is above it by the margin.
    assert_eq!(counter(&pool).await, 3 + SHIFT_NUMBER_MARGIN);
    let next = markiro_host::disaggregation::next_seq(&mut pool.acquire().await.unwrap())
        .await
        .unwrap();
    assert_eq!(next, 3 + SHIFT_NUMBER_MARGIN + 1);
    assert_eq!(
        markiro_host::disaggregation::format_doc_no(next, 2026),
        "DSG-26-0014"
    );
}
