//! The update package is no data of the site (plan ОБН-3, spec §10.11.2):
//! a copy of the database never holds it, and `markiro-host restore` leaves
//! `updates\` as it was, on the same computer and on a new one.

mod support;

use std::path::{Path, PathBuf};

use markiro_host::backup::copy::make_copy;
use markiro_host::config::HostPaths;
use markiro_host::restore::restore;
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::{ConnectOptions, Connection};
use support::app::{admin, TestApp};
use support::backup::{at, names, worker_conn};
use support::update::{installer_name, write_package};

const NOW: &str = "2026-11-03T06:00:00Z";

async fn copy(app: &TestApp) -> PathBuf {
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
    folder.join(&manifest.file)
}

/// The data folder as a stopped host leaves it (`restore.rs`'s own `stop`).
async fn stop(app: &TestApp) -> HostPaths {
    app.state.pool.close().await;
    let db = app.dir().join("host.db");
    let wal = app.dir().join("host.db-wal");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let mut conn = markiro_host::db::options(&db).connect().await.unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&mut conn)
                .await
                .unwrap();
            conn.close().await.unwrap();
            if std::fs::metadata(&wal).map_or(true, |meta| meta.len() == 0) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the database closed");
    std::fs::write(
        app.dir().join("host.json"),
        json!({ "hostId": app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    let paths = HostPaths::new(app.dir());
    paths.ensure().unwrap();
    drop(paths.lock().unwrap());
    paths
}

/// Every file under `dir` with its bytes, in order.
fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    for folder in names(dir) {
        for name in names(&dir.join(&folder)) {
            found.push((
                format!("{folder}/{name}"),
                std::fs::read(dir.join(&folder).join(&name)).unwrap(),
            ));
        }
    }
    found
}

#[tokio::test]
async fn a_copy_of_the_database_holds_no_package() {
    let mut admin = admin().await;
    write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    copy(&admin.app).await;
    let copies = names(&admin.app.dir().join("backups"));
    assert!(!copies.is_empty());
    assert!(
        copies
            .iter()
            .all(|name| name.ends_with(".db") || name.ends_with(".json")),
        "{copies:?}"
    );
}

#[tokio::test]
async fn a_restore_on_the_same_computer_leaves_the_packages_as_they_were() {
    let mut admin = admin().await;
    let updates = admin.app.dir().join("updates");
    write_package(&updates, "current", "0.3.0");
    write_package(&updates, "staged", "0.4.0");
    admin.app.keep_updates("0.3.0");
    let before = files(&updates);
    let copy_path = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(files(&updates), before);
    assert!(updates
        .join("current")
        .join(installer_name("0.3.0"))
        .exists());
}

#[tokio::test]
async fn a_restore_on_a_new_computer_brings_no_package() {
    let admin = admin().await;
    let copy_path = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let updates = paths.updates_dir();
    assert!(!updates.exists() || names(&updates).is_empty());
}
