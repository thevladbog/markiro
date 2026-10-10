//! The host starts its backup worker with itself (plan РК): a copy right
//! after the start, and the worker stops with the host. Listens on
//! 127.0.0.1, so it runs outside the sandbox.

use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};

fn manifests(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            let name = name.to_string_lossy();
            name.starts_with("markiro-host-") && name.ends_with(".json")
        })
        .count()
}

#[tokio::test]
async fn a_started_host_copies_its_database_and_stops_its_worker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&paths, options).await.unwrap();
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the worker made a copy at start");
    tokio::time::timeout(Duration::from_secs(15), host.stop())
        .await
        .expect("the host stops with its worker")
        .unwrap();
    assert_eq!(manifests(&backups), 1);
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT actor_kind, result FROM audit_log WHERE action = 'backup.create'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows, [("system".to_owned(), "ok".to_owned())]);
    pool.close().await;
}

fn names_ending(dir: &std::path::Path, suffix: &str) -> usize {
    std::fs::read_dir(dir)
        .unwrap()
        .filter(|entry| {
            let name = entry.as_ref().unwrap().file_name();
            let name = name.to_string_lossy();
            name.starts_with("markiro-host-") && name.ends_with(suffix)
        })
        .count()
}

#[tokio::test]
async fn a_host_that_stops_while_a_copy_is_made_lets_it_finish() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    // A first run gives the data folder its identity and its first copy.
    let first = start(&paths, options).await.unwrap();
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the first copy");
    first.stop().await.unwrap();
    // Then a database big enough for the next copy to take a while.
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    sqlx::query("CREATE TABLE ballast (data BLOB NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    for _ in 0..32 {
        sqlx::query("INSERT INTO ballast VALUES (zeroblob(1048576))")
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
    let host = start(&paths, options).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), async {
        while names_ending(&backups, ".partial") == 0 {
            assert_eq!(manifests(&backups), 1, "the copy was over before the stop");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("the copy began");
    tokio::time::timeout(Duration::from_secs(15), host.stop())
        .await
        .expect("the host stops with its worker")
        .unwrap();
    assert_eq!(names_ending(&backups, ".partial"), 0);
    assert_eq!(manifests(&backups), 2, "the copy in progress was finished");
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT actor_kind, result FROM audit_log WHERE action = 'backup.create'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows,
        [
            ("system".to_owned(), "ok".to_owned()),
            ("system".to_owned(), "ok".to_owned())
        ]
    );
    pool.close().await;
}
