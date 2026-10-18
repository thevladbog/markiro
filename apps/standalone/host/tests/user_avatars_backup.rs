//! A copy of the host carries the office users' photos (plan АВА): the
//! table is in the file, so the backup and the restore need no rule of
//! their own, and these tests hold that to account. A copy of a host before
//! migration `0046` is migrated forward on restore and holds no photo.

mod support;

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use markiro_host::backup::copy::make_copy;
use markiro_host::config::HostPaths;
use markiro_host::restore::restore;
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::{ConnectOptions, Connection, SqlitePool};
use support::app::{admin, TestApp};
use support::backup::{at, worker_conn};

const NOW: &str = "2026-10-16T12:00:00Z";

/// A PNG of 128 × 128 dots as the host reads it: signature, IHDR, IDAT, IEND.
fn png() -> Vec<u8> {
    let chunk = |kind: &[u8; 4], data: &[u8]| {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]);
        out
    };
    let mut ihdr = 128u32.to_be_bytes().to_vec();
    ihdr.extend(128u32.to_be_bytes());
    ihdr.extend([8, 2, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &[7u8; 300]));
    out.extend(chunk(b"IEND", &[]));
    out
}

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

/// Stop using the app's database as a service that stopped cleanly has (see
/// `tests/restore.rs`): connections closed, the WAL folded in.
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

async fn reopen(paths: &HostPaths) -> SqlitePool {
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
}

#[tokio::test]
async fn a_backup_and_a_restore_keep_every_photo_byte_for_byte() {
    let admin = admin().await;
    let bytes = png();
    let (status, put) = admin
        .call(
            "PUT",
            &format!("/v1/office/users/{}/avatar", admin.id),
            Some(json!({ "dataBase64": STANDARD.encode(&bytes) })),
        )
        .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{put}");
    let version = put["avatar"]["version"].as_i64().unwrap();
    let copy_path = copy(&admin.app).await;

    // After the copy the photo goes: the restore brings back the one the copy holds.
    let (status, _) = admin
        .call(
            "DELETE",
            &format!("/v1/office/users/{}/avatar", admin.id),
            None,
        )
        .await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let paths = stop(&admin.app).await;
    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let pool = reopen(&paths).await;
    let row: (String, i64, i64, Vec<u8>, String, i64) = sqlx::query_as(
        "SELECT media_type, width, height, data, checksum, version FROM user_avatars WHERE user_id = ?",
    )
    .bind(&admin.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "image/png".to_owned(),
            128,
            128,
            bytes.clone(),
            markiro_host::backup::identity::sha256_hex(&bytes),
            version
        )
    );
}

#[tokio::test]
async fn a_copy_of_a_host_before_the_photos_restores_with_none() {
    use sqlx::migrate::Migrator;
    let old = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version < 46)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    assert!(
        markiro_host::db::MIGRATOR
            .iter()
            .any(|migration| migration.version == 46),
        "the migration of the photos is 0046"
    );
    let work = tempfile::tempdir().unwrap();
    let db = work.path().join("old-host.db");
    let mut conn = markiro_host::db::options(&db)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    old.run(&mut conn).await.unwrap();
    sqlx::query("UPDATE site SET initialized_at = '2026-09-20T10:00:00Z' WHERE id = 1")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES ('11111111-1111-4111-8111-111111111111', 'old', 'Старый', 'admin', 'x', 1, \
                 '2026-09-20T10:00:00Z', 1)",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    let folder = work.path().join("old-copies");
    std::fs::create_dir_all(&folder).unwrap();
    let manifest = make_copy(
        &mut conn,
        &folder,
        at("2026-09-21T14:13:20Z"),
        BackupTrigger::Scheduled,
        "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    assert_eq!(manifest.schema_version, 45);

    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    restore(&paths, &folder.join(&manifest.file), false, at(NOW))
        .await
        .unwrap();
    let pool = reopen(&paths).await;
    let photos: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_avatars")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(photos, 0);
    // The user the copy held reads with no version, through the host's own listing query.
    let version: Option<i64> = sqlx::query_scalar(
        "SELECT (SELECT a.version FROM user_avatars a WHERE a.user_id = u.id) \
         FROM office_users u WHERE u.login = 'old'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(version, None);
}
