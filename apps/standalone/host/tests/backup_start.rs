//! The host starts its backup worker with itself (plan РК): a copy right
//! after the start, which the office reads, and the worker stops with the
//! host. Listens on 127.0.0.1, so it runs outside the sandbox.

mod support;

use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::{OFFICE_SESSION_HEADER, PROTOCOL_HEADER, PROTOCOL_VERSION};
use serde_json::{json, Value};

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

async fn start_host(paths: &HostPaths) -> RunningHost {
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    start(paths, options).await.unwrap()
}

#[tokio::test]
async fn a_started_host_copies_its_database_and_stops_its_worker() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
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

#[tokio::test]
async fn the_office_of_a_started_host_reads_its_copies() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
    let client = support::pinned_client(&host.fingerprint);
    let base = format!("https://{}", host.addr);
    let protocol = PROTOCOL_VERSION.to_string();
    let paired: Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(PROTOCOL_HEADER, &protocol)
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = paired["deviceKey"].as_str().unwrap().to_owned();
    let booted: Value = client
        .post(format!("{base}/v1/bootstrap"))
        .header(PROTOCOL_HEADER, &protocol)
        .bearer_auth(&key)
        .json(&support::app::bootstrap_body())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = booted["session"]["token"].as_str().unwrap().to_owned();
    let state = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state: Value = client
                .get(format!("{base}/v1/office/backups"))
                .header(PROTOCOL_HEADER, &protocol)
                .header(OFFICE_SESSION_HEADER, &token)
                .bearer_auth(&key)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(state.get("error").is_none(), "{state}");
            // The worker puts the copy into the folder before it records the
            // attempt, so a copy in the listing does not yet mean a
            // `lastAttempt`: wait for both.
            if state["local"]["copies"]
                .as_array()
                .is_some_and(|copies| !copies.is_empty())
                && !state["local"]["lastAttempt"].is_null()
            {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the worker made a copy at start and recorded the attempt");
    assert_eq!(
        state["local"]["dir"],
        json!(paths.backups_dir().display().to_string())
    );
    assert_eq!(state["local"]["lastAttempt"]["ok"], json!(true));
    drop(client);
    host.stop().await.unwrap();
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

/// A host started over a database of the previous build copies it before
/// its migrations (plan ОБН-1), then the worker makes its own first copy at
/// once, and the rule keeps both; one `host.upgrade` row names the copy.
#[tokio::test]
async fn a_started_host_copies_an_older_database_before_its_migrations_and_keeps_that_copy() {
    let dir = tempfile::tempdir().unwrap();
    support::backup::write_identity(dir.path(), "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f");
    support::backup::database_without(dir.path(), 31).await;
    let paths = HostPaths::new(dir.path());
    let host = start_host(&paths).await;
    let backups = paths.backups_dir();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manifests(&backups) < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the copy before the migrations and the worker's first copy");
    tokio::time::timeout(Duration::from_secs(15), host.stop())
        .await
        .expect("the host stops with its worker")
        .unwrap();
    let copies: Vec<String> = support::backup::names(&backups)
        .into_iter()
        .filter(|name| name.ends_with(".db"))
        .collect();
    assert_eq!(copies.len(), 2, "{copies:?}");
    let before: Vec<&String> = copies
        .iter()
        .filter(|name| markiro_host::upgrade::is_pre_upgrade(name))
        .collect();
    assert_eq!(before.len(), 1, "{copies:?}");
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT actor_kind, result, target_id FROM audit_log WHERE action = 'host.upgrade'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [(
            "system".to_owned(),
            "ok".to_owned(),
            Some(before[0].clone())
        )]
    );
    pool.close().await;
}
