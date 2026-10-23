//! Helpers of the backup suites (plan РК).

use std::path::Path;

use markiro_host::backup::copy::{copy_name, manifest_path, sha256_file, Manifest};
use markiro_host::backup::identity::HostIdentity;
use markiro_host::config::HostPaths;
use markiro_proto::backup::BackupTrigger;
use sqlx::{ConnectOptions, Connection, SqliteConnection, SqlitePool};
use time::OffsetDateTime;

use super::app::TestApp;

/// A connection like the backup worker's: the app's database, no
/// migrations.
pub async fn worker_conn(app: &TestApp) -> SqliteConnection {
    markiro_host::db::options(&app.dir().join("host.db"))
        .connect()
        .await
        .unwrap()
}

/// The newest migration this build applies: what a copy's manifest names
/// as its `schemaVersion`.
pub fn latest_migration() -> i64 {
    markiro_host::db::MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap()
}

/// A UTC instant from RFC 3339 text.
pub fn at(text: &str) -> OffsetDateTime {
    markiro_host::clock::parse_timestamp(text).unwrap()
}

/// The file names in `dir`, sorted.
pub fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// A copy that is no database, with a manifest that fits it: enough for the
/// listing, the retention rule and the second folder, which never open a
/// copy.
pub fn fake_copy(dir: &Path, created: &str, tag: &str) -> Manifest {
    let name = copy_name(at(created), tag);
    let db = dir.join(&name);
    std::fs::write(&db, format!("copy {tag}")).unwrap();
    let (size_bytes, sha256) = sha256_file(&db).unwrap();
    let manifest = Manifest {
        format: 1,
        file: name,
        created_at: created.to_owned(),
        trigger: BackupTrigger::Scheduled,
        host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".to_owned(),
        schema_version: latest_migration(),
        size_bytes,
        sha256,
        identity: None,
    };
    std::fs::write(
        manifest_path(&db),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}

/// The host identity of the data folder `dir` as a host that started there
/// has it (plan I1): `host.json` (port 45710) and `tls/`.
pub fn write_identity(dir: &Path, host_id: &str) -> HostIdentity {
    let paths = HostPaths::new(dir);
    paths.ensure().unwrap();
    std::fs::write(
        paths.config_file(),
        serde_json::json!({ "hostId": host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), host_id).unwrap();
    HostIdentity::read(&paths).unwrap()
}

/// `host.db` of the data folder `dir` with every migration of this build but
/// `version` (plan ОБН-1): what a host of the previous build left behind.
pub async fn database_without(dir: &Path, version: i64) {
    let path = HostPaths::new(dir).database_file();
    let mut conn = markiro_host::db::options(&path)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != version)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..sqlx::migrate::Migrator::DEFAULT
    }
    .run(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
}

/// Close `pool` until no connection of it is open. sqlx 0.8's `Pool::close`
/// can return with one still open: a connection dropped just before the
/// close goes back by a task of its own (a ping, then the idle queue), and a
/// close that began during the ping waits for that connection's permit but
/// does not look in the idle queue again. The connection then stays open
/// for as long as the pool lives: harmless where an open file can be
/// renamed, but on Windows it holds `host.db` against a restore's rename
/// (ERROR_SHARING_VIOLATION). Another close closes it; `size` counts a
/// connection until its SQLite handle is closed.
pub async fn close_pool(pool: &SqlitePool) {
    loop {
        pool.close().await;
        if pool.size() == 0 {
            return;
        }
    }
}

/// Stop using the app's database as a service that stopped cleanly has:
/// every connection closed ([`close_pool`]) and the WAL folded into the
/// file (a WAL a crashed host left behind is `tests/restore.rs`'s
/// `the_commits_a_crashed_host_left_in_its_wal_count_too`). SQLite removes
/// the WAL when the last connection to the file closes, so the checkpoint's
/// own connection is tried again until the WAL is gone (a scanner may hold
/// it for a moment); a WAL that stays means a connection is still open, and
/// the timeout says so here instead of the restore failing on Windows. The
/// data folder gets what a host's has: `host.json`, the folders and the
/// lock file, released.
pub async fn stop(app: &TestApp) -> HostPaths {
    let db = app.dir().join("host.db");
    let wal = app.dir().join("host.db-wal");
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        close_pool(&app.state.pool).await;
        loop {
            let mut conn = markiro_host::db::options(&db).connect().await.unwrap();
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
                .execute(&mut conn)
                .await
                .unwrap();
            conn.close().await.unwrap();
            if !wal.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("every connection to the database closed");
    std::fs::write(
        app.dir().join("host.json"),
        serde_json::json!({ "hostId": app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    let paths = HostPaths::new(app.dir());
    paths.ensure().unwrap();
    drop(paths.lock().unwrap());
    paths
}
