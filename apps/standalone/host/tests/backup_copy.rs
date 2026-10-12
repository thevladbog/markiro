//! One copy and its folder (plan РК): `VACUUM INTO` while a writer holds the
//! lock, the check, the manifest, a folder that is not there, the listing,
//! what a broken copy leaves, and the second folder.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_host::backup::copy::sync_file;
use markiro_host::backup::copy::{
    classify_io, classify_sqlite, is_copy_file_name, make_copy, make_copy_tagged, manifest_path,
    read_manifest, sha256_file, verify_database,
};
use markiro_host::backup::copy::{make_copy_with_identity, Manifest};
use markiro_host::backup::folder::{clean, list, probe, replicate, replicate_guarded, rotate};
use markiro_host::backup::identity::{identity_path, HostIdentity, KeyFileGuard, OwnerOnly};
use markiro_host::config::HostPaths;
use markiro_proto::backup::{dir_problems, failure, BackupTrigger};
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use support::app::{admin, Admin};
use support::backup::{at, fake_copy, latest_migration, names, worker_conn, write_identity};

const CREATED: &str = "2026-10-09T14:00:00Z";

/// The organization's name in the database at `path`, read the way a
/// restore would read a copy.
async fn org_name(path: &Path) -> String {
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .unwrap();
    sqlx::query_scalar("SELECT name FROM org_profile WHERE id = 1")
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

async fn copy_of(admin: &Admin, dir: &Path) -> markiro_host::backup::copy::Manifest {
    let mut conn = worker_conn(&admin.app).await;
    copy_with(&mut conn, dir).await.unwrap()
}

async fn copy_with(
    conn: &mut SqliteConnection,
    dir: &Path,
) -> Result<markiro_host::backup::copy::Manifest, markiro_host::backup::copy::Failure> {
    make_copy(
        conn,
        dir,
        at(CREATED),
        BackupTrigger::Scheduled,
        "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    )
    .await
}

#[tokio::test]
async fn a_copy_is_taken_while_a_writer_holds_the_lock_and_holds_no_uncommitted_change() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE org_profile SET name = 'Не закоммичено' WHERE id = 1")
        .execute(&mut *holder)
        .await
        .unwrap();
    let mut conn = worker_conn(&admin.app).await;
    // The writer keeps its lock for the whole copy: a copy that waited for it
    // would never finish, and the timeout turns that into a failure.
    let manifest =
        tokio::time::timeout(Duration::from_secs(10), copy_with(&mut conn, folder.path()))
            .await
            .expect("a copy waits for no writer")
            .unwrap();
    holder.rollback().await.unwrap();
    let db = folder.path().join(&manifest.file);
    assert_eq!(org_name(&db).await, "ООО «Атолл»");
    assert_eq!(
        names(folder.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    assert!(manifest.file.starts_with("markiro-host-20261009T140000Z-"));
    assert!(manifest.file.ends_with(".db"));
    assert_eq!(
        manifest.file.len(),
        "markiro-host-20261009T140000Z-12345678.db".len()
    );
    assert_eq!(manifest.created_at, CREATED);
    assert_eq!(manifest.trigger, BackupTrigger::Scheduled);
    assert_eq!(manifest.host_id, "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f");
    assert_eq!(manifest.schema_version, latest_migration());
    assert_eq!(
        sha256_file(&db).unwrap(),
        (manifest.size_bytes, manifest.sha256.clone())
    );
    assert_eq!(read_manifest(&db).unwrap(), manifest);
}

#[tokio::test]
async fn the_manifest_is_plain_json_beside_its_copy() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let text = std::fs::read_to_string(manifest_path(&folder.path().join(&manifest.file))).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "format": 1,
            "file": manifest.file,
            "createdAt": CREATED,
            "trigger": "scheduled",
            "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            "schemaVersion": latest_migration(),
            "sizeBytes": manifest.size_bytes,
            "sha256": manifest.sha256,
        })
    );
}

#[tokio::test]
async fn the_check_refuses_a_damaged_file_and_anything_that_is_no_database() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let db = folder.path().join(&manifest.file);
    assert_eq!(verify_database(&db).await, Ok(latest_migration()));
    let mut bytes = std::fs::read(&db).unwrap();
    for byte in &mut bytes[4096 * 3..4096 * 3 + 200] {
        *byte = 0x5a;
    }
    let damaged = folder.path().join("damaged.db");
    std::fs::write(&damaged, &bytes).unwrap();
    assert_eq!(
        verify_database(&damaged).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
    let text = folder.path().join("text.db");
    std::fs::write(&text, "not a database at all, just some text").unwrap();
    assert_eq!(
        verify_database(&text).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
    let empty = folder.path().join("empty.db");
    sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&empty)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    // A database, but no host's: nothing was ever migrated in it.
    assert_eq!(
        verify_database(&empty).await.unwrap_err().code,
        failure::VERIFY_FAILED
    );
}

#[tokio::test]
async fn the_check_refuses_an_index_that_no_longer_matches_its_table() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    let db = folder.path().join(&manifest.file);
    {
        // A file SQLite still opens and reads, whose index of audit times
        // now claims to index actions: only `integrity_check` sees it.
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db)
            .connect()
            .await
            .unwrap();
        sqlx::query("PRAGMA writable_schema = ON")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE sqlite_master SET sql = 'CREATE INDEX audit_log_at ON audit_log (action)' \
             WHERE name = 'audit_log_at'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    let failed = verify_database(&db).await.unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert!(
        failed.detail.starts_with("integrity_check: "),
        "{}",
        failed.detail
    );
}

#[tokio::test]
async fn a_copy_into_a_folder_that_is_not_there_fails_and_leaves_nothing() {
    let admin = admin().await;
    let parent = tempfile::tempdir().unwrap();
    let missing = parent.path().join("unplugged");
    let mut conn = worker_conn(&admin.app).await;
    let failed = copy_with(&mut conn, &missing).await.unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
    assert!(names(parent.path()).is_empty());
    assert!(!missing.exists(), "nothing is created in its place");
}

#[cfg(unix)]
#[tokio::test]
async fn a_copy_into_a_folder_the_host_may_not_write_is_access_denied_and_leaves_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let mut conn = worker_conn(&admin.app).await;
    let failed = copy_with(&mut conn, folder.path()).await.unwrap_err();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(failed.code, failure::ACCESS_DENIED);
    assert!(names(folder.path()).is_empty());
}

#[tokio::test]
async fn the_listing_holds_only_verified_copies_newest_first() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let older = fake_copy(dir, "2026-10-09T12:00:00Z", "00000001");
    let newer = fake_copy(dir, "2026-10-09T13:00:00Z", "00000002");
    // A copy whose file is not the size its manifest says.
    let grown = fake_copy(dir, "2026-10-09T13:30:00Z", "00000003");
    std::fs::write(
        dir.join(&grown.file),
        "a longer file than the manifest says",
    )
    .unwrap();
    // A copy whose manifest names another file.
    let renamed = fake_copy(dir, "2026-10-09T13:40:00Z", "00000004");
    std::fs::rename(
        dir.join(&renamed.file),
        dir.join(renamed.file.replace("00000004", "00000005")),
    )
    .unwrap();
    std::fs::rename(
        manifest_path(&dir.join(&renamed.file)),
        manifest_path(&dir.join(renamed.file.replace("00000004", "00000005"))),
    )
    .unwrap();
    // A copy without its manifest, a half-written one, and files of others.
    std::fs::write(dir.join("markiro-host-20261009T135000Z-00000006.db"), "x").unwrap();
    std::fs::write(
        dir.join("markiro-host-20261009T135500Z-00000007.db.partial"),
        "x",
    )
    .unwrap();
    std::fs::write(dir.join("notes.txt"), "someone else's").unwrap();
    std::fs::write(dir.join("other.db"), "someone else's").unwrap();
    let files: Vec<String> = list(dir)
        .unwrap()
        .into_iter()
        .map(|copy| copy.file)
        .collect();
    assert_eq!(files, [newer.file.clone(), older.file.clone()]);
    assert_eq!(clean(dir).unwrap(), 2);
    let left = names(dir);
    assert!(!left.contains(&"markiro-host-20261009T135000Z-00000006.db".to_owned()));
    assert!(!left.contains(&"markiro-host-20261009T135500Z-00000007.db.partial".to_owned()));
    for kept in [
        "notes.txt",
        "other.db",
        &older.file,
        &newer.file,
        &grown.file,
    ] {
        assert!(left.contains(&kept.to_owned()), "{kept} stays");
    }
}

#[tokio::test]
async fn rotation_deletes_what_the_rule_does_not_keep_and_nothing_else() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    // 26 hourly copies of one day: the two oldest go.
    let copies: Vec<_> = (0..26)
        .map(|hour| {
            let created = format!("2026-10-{:02}T{:02}:00:00Z", 8 + hour / 24, hour % 24);
            fake_copy(dir, &created, &format!("{hour:08}"))
        })
        .collect();
    std::fs::write(dir.join("notes.txt"), "someone else's").unwrap();
    let staying = rotate(dir, None).unwrap();
    assert_eq!(staying.len(), 24);
    let staying: Vec<&str> = staying.iter().map(|copy| copy.file.as_str()).collect();
    for (index, copy) in copies.iter().enumerate() {
        let db = dir.join(&copy.file);
        let kept = index >= 2;
        assert_eq!(db.exists(), kept, "{}", copy.file);
        assert_eq!(manifest_path(&db).exists(), kept, "{}", copy.file);
        assert_eq!(staying.contains(&copy.file.as_str()), kept);
    }
    assert!(dir.join("notes.txt").exists());
}

#[tokio::test]
async fn rotation_never_takes_the_copy_it_was_asked_to_keep_even_with_newer_copies_from_a_clock_set_back(
) {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    // Thirty copies made before the host's clock went back, all later the
    // same day than the copy just made: by the rule alone the fresh copy is
    // neither one of the 24 newest nor the newest of its day or month.
    let later: Vec<_> = (0..30)
        .map(|step| {
            let created = format!("2026-10-09T{:02}:{:02}:00Z", 14 + step / 4, (step % 4) * 15);
            fake_copy(dir, &created, &format!("{step:08}"))
        })
        .collect();
    let fresh = fake_copy(dir, "2026-10-09T08:00:00Z", "0000ffff");
    let staying = rotate(dir, Some(&fresh.file)).unwrap();
    let staying: Vec<&str> = staying.iter().map(|copy| copy.file.as_str()).collect();
    assert!(staying.contains(&fresh.file.as_str()), "{staying:?}");
    let db = dir.join(&fresh.file);
    assert!(db.exists() && manifest_path(&db).exists());
    // The rest follows the rule: the 24 newest of the later copies.
    assert_eq!(staying.len(), 25);
    for (index, copy) in later.iter().enumerate() {
        assert_eq!(dir.join(&copy.file).exists(), index >= 6, "{}", copy.file);
    }
}

/// The flush before a copy's rename asks for write access: Windows'
/// `FlushFileBuffers` refuses a read-only handle, which Unix never shows.
/// Here a file the process may not write is refused, so a helper that
/// opened it read-only would pass this test and fail on Windows. The call
/// sites (`make_copy`, the restore) use this helper; only the smoke test on
/// Windows proves the copy itself.
#[cfg(unix)]
#[test]
fn a_copy_is_flushed_through_a_handle_opened_for_writing() {
    use std::os::unix::fs::PermissionsExt;
    let folder = tempfile::tempdir().unwrap();
    let file = folder.path().join("markiro-host-copy.db.partial");
    std::fs::write(&file, b"copy").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o444)).unwrap();
    let refused = sync_file(&file).unwrap_err();
    assert_eq!(refused.kind(), std::io::ErrorKind::PermissionDenied);
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    sync_file(&file).unwrap();
    assert_eq!(
        std::fs::read(&file).unwrap(),
        b"copy",
        "a flush changes nothing"
    );
}

#[tokio::test]
async fn the_second_folder_gets_the_same_bytes_and_manifest() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000a");
    replicate(source.path(), &copy, dest.path()).unwrap();
    let db = dest.path().join(&copy.file);
    assert_eq!(std::fs::read(&db).unwrap(), b"copy 0000000a");
    assert_eq!(read_manifest(&db).unwrap(), copy);
    assert_eq!(names(dest.path()).len(), 2);
}

#[tokio::test]
async fn a_second_folder_that_is_not_there_gets_nothing_and_is_not_created() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000b");
    let missing = parent.path().join("ADMIN-PC");
    let failed = replicate(source.path(), &copy, &missing).unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
    assert!(!missing.exists());
    let file = parent.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    let failed = replicate(source.path(), &copy, &file).unwrap_err();
    assert_eq!(failed.code, failure::DESTINATION_UNAVAILABLE);
}

#[tokio::test]
async fn a_copy_that_changed_on_the_way_is_refused_and_removed() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000c");
    std::fs::write(source.path().join(&copy.file), "copy 0000000X").unwrap();
    let failed = replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert!(names(dest.path()).is_empty());
}

#[tokio::test]
async fn a_folder_is_tried_before_it_is_saved() {
    let data = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    assert_eq!(probe(other.path(), data.path()), Ok(()));
    assert!(names(other.path()).is_empty(), "the probe file is removed");
    assert_eq!(
        probe(&other.path().join("missing"), data.path()),
        Err(dir_problems::MISSING)
    );
    let file = other.path().join("a-file");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(
        probe(&file, data.path()),
        Err(dir_problems::NOT_A_DIRECTORY)
    );
    let inside = data.path().join("backups-too");
    std::fs::create_dir(&inside).unwrap();
    assert_eq!(
        probe(&inside, data.path()),
        Err(dir_problems::INSIDE_DATA_DIR)
    );
    assert_eq!(
        probe(data.path(), data.path()),
        Err(dir_problems::INSIDE_DATA_DIR)
    );
}

#[cfg(unix)]
#[test]
fn a_folder_the_host_may_not_write_is_refused_as_such() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    let probed = probe(folder.path(), data.path());
    std::fs::set_permissions(folder.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probed, Err(dir_problems::ACCESS_DENIED));
}

#[test]
fn io_errors_are_sorted_by_what_a_person_can_do() {
    use std::io::{Error, ErrorKind};
    let cases = [
        (ErrorKind::NotFound, failure::DESTINATION_UNAVAILABLE),
        (ErrorKind::NotADirectory, failure::DESTINATION_UNAVAILABLE),
        (ErrorKind::PermissionDenied, failure::ACCESS_DENIED),
        (ErrorKind::ReadOnlyFilesystem, failure::ACCESS_DENIED),
        (ErrorKind::StorageFull, failure::DISK_FULL),
        (ErrorKind::QuotaExceeded, failure::DISK_FULL),
        (ErrorKind::Interrupted, failure::WRITE_FAILED),
        (ErrorKind::Other, failure::WRITE_FAILED),
    ];
    for (kind, code) in cases {
        assert_eq!(classify_io(&Error::from(kind)), code, "{kind:?}");
    }
}

#[tokio::test]
async fn sqlite_errors_are_sorted_by_what_a_person_can_do() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("small.db");
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (x BLOB)")
        .execute(&mut conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA max_page_count = 3")
        .execute(&mut conn)
        .await
        .unwrap();
    let full = sqlx::query("INSERT INTO t VALUES (zeroblob(100000))")
        .execute(&mut conn)
        .await
        .unwrap_err();
    assert_eq!(classify_sqlite(&full, folder.path()), failure::DISK_FULL);
    let wrong = sqlx::query("INSERT INTO nowhere VALUES (1)")
        .execute(&mut conn)
        .await
        .unwrap_err();
    assert_eq!(
        classify_sqlite(&wrong, folder.path()),
        failure::WRITE_FAILED
    );
    let mut read_only = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let refused = sqlx::query("INSERT INTO t VALUES (x'00')")
        .execute(&mut read_only)
        .await
        .unwrap_err();
    assert_eq!(
        classify_sqlite(&refused, folder.path()),
        failure::ACCESS_DENIED
    );
}

// ---- beyond the brief: what a disaster-recovery copy must also guarantee ----

#[tokio::test]
async fn a_copy_taken_while_the_host_keeps_writing_is_whole() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    sqlx::query("CREATE TABLE rk_pairs (id INTEGER PRIMARY KEY, pair INTEGER NOT NULL)")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let pool = admin.app.state.pool.clone();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop.clone();
    // A transaction inserts two rows of one pair, and nothing else does.
    let writer = tokio::spawn(async move {
        let mut pair = 0i64;
        while !stopped.load(std::sync::atomic::Ordering::Relaxed) {
            pair += 1;
            let mut tx = markiro_host::db::begin_write(&pool).await.unwrap();
            for _ in 0..2 {
                sqlx::query("INSERT INTO rk_pairs (pair) VALUES (?)")
                    .bind(pair)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            tx.commit().await.unwrap();
            tokio::task::yield_now().await;
        }
        pair
    });
    let mut conn = worker_conn(&admin.app).await;
    let mut seen = Vec::new();
    for round in 0..6 {
        let at = at(CREATED) + time::Duration::seconds(round);
        let manifest = make_copy(
            &mut conn,
            folder.path(),
            at,
            BackupTrigger::Manual,
            "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        )
        .await
        .unwrap();
        let db = folder.path().join(&manifest.file);
        assert_eq!(verify_database(&db).await, Ok(latest_migration()));
        let mut copy = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&db)
            .read_only(true)
            .immutable(true)
            .connect()
            .await
            .unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM rk_pairs")
            .fetch_one(&mut copy)
            .await
            .unwrap();
        let broken: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM (SELECT pair FROM rk_pairs GROUP BY pair HAVING count(*) <> 2)",
        )
        .fetch_one(&mut copy)
        .await
        .unwrap();
        assert_eq!(broken, 0, "a transaction is in a copy whole or not at all");
        assert_eq!(rows % 2, 0);
        seen.push(rows);
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let written = writer.await.unwrap();
    assert!(written > 0);
    assert!(
        seen.last() > seen.first(),
        "the writer was running during the copies: {seen:?}"
    );
}

#[tokio::test]
async fn a_copy_that_does_not_check_out_leaves_nothing() {
    // A database that was never migrated: it copies, and the check refuses it.
    let source = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(source.path().join("plain.db"))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (x)")
        .execute(&mut conn)
        .await
        .unwrap();
    let failed = copy_with(&mut conn, folder.path()).await.unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert!(
        names(folder.path()).is_empty(),
        "{:?}",
        names(folder.path())
    );
}

#[tokio::test]
async fn a_copy_that_fails_after_its_file_was_made_removes_the_file() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let mut conn = worker_conn(&admin.app).await;
    // `VACUUM` refuses to run inside a transaction: the statement fails after
    // the empty file it was to fill has been made.
    sqlx::query("BEGIN").execute(&mut conn).await.unwrap();
    let failed = copy_with(&mut conn, folder.path()).await.unwrap_err();
    assert_eq!(failed.code, failure::WRITE_FAILED, "{}", failed.detail);
    assert!(
        names(folder.path()).is_empty(),
        "{:?}",
        names(folder.path())
    );
}

#[tokio::test]
async fn a_copy_never_replaces_the_one_of_its_name() {
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let mut conn = worker_conn(&admin.app).await;
    let host = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    let first = make_copy_tagged(
        &mut conn,
        folder.path(),
        at(CREATED),
        BackupTrigger::Scheduled,
        host,
        "1a2b3c4d",
    )
    .await
    .unwrap();
    sqlx::query("UPDATE org_profile SET name = 'Другое имя' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = names(folder.path());
    let failed = make_copy_tagged(
        &mut conn,
        folder.path(),
        at(CREATED),
        BackupTrigger::Manual,
        host,
        "1a2b3c4d",
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code, failure::WRITE_FAILED);
    assert_eq!(
        names(folder.path()),
        before,
        "the failed attempt left nothing"
    );
    let db = folder.path().join(&first.file);
    assert_eq!(
        sha256_file(&db).unwrap(),
        (first.size_bytes, first.sha256.clone())
    );
    assert_eq!(read_manifest(&db).unwrap(), first);
    assert_eq!(org_name(&db).await, "ООО «Атолл»");
}

#[cfg(unix)]
#[tokio::test]
async fn copies_manifests_and_their_replicas_are_readable_by_the_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let admin = admin().await;
    let folder = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let manifest = copy_of(&admin, folder.path()).await;
    replicate(folder.path(), &manifest, second.path()).unwrap();
    for dir in [folder.path(), second.path()] {
        for name in [manifest.file.clone(), manifest.file.replace(".db", ".json")] {
            let mode = std::fs::metadata(dir.join(&name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{name} in {}", dir.display());
        }
    }
}

#[tokio::test]
async fn a_failed_replication_keeps_the_copy_that_was_already_there() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000d");
    replicate(source.path(), &copy, dest.path()).unwrap();
    let before = names(dest.path());
    // The source changes under its manifest: the second attempt is refused.
    std::fs::write(source.path().join(&copy.file), "copy 0000000Y").unwrap();
    let failed = replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_eq!(failed.code, failure::VERIFY_FAILED);
    assert_eq!(names(dest.path()), before);
    let db = dest.path().join(&copy.file);
    assert_eq!(std::fs::read(&db).unwrap(), b"copy 0000000d");
    assert_eq!(read_manifest(&db).unwrap(), copy);
}

#[tokio::test]
async fn a_replica_whose_manifest_cannot_be_written_is_removed_whole() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000e");
    // The manifest's place is taken by a folder: the file renames in, the
    // manifest cannot, and a copy without its manifest must not stay.
    let blocked = dest.path().join(copy.file.replace(".db", ".json"));
    std::fs::create_dir(&blocked).unwrap();
    let failed = replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_ne!(failed.code, failure::VERIFY_FAILED);
    assert_eq!(
        names(dest.path()),
        [blocked.file_name().unwrap().to_str().unwrap().to_owned()]
    );
}

#[tokio::test]
async fn a_replica_that_was_already_there_stays_when_its_manifest_cannot_be_rewritten() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "00000011");
    std::fs::write(dest.path().join(&copy.file), "copy 00000011").unwrap();
    std::fs::create_dir(dest.path().join(copy.file.replace(".db", ".json"))).unwrap();
    replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_eq!(
        std::fs::read(dest.path().join(&copy.file)).unwrap(),
        b"copy 00000011",
        "a copy that was there before this attempt is not this attempt's to remove"
    );
}

#[tokio::test]
async fn a_source_that_cannot_be_read_is_a_local_copy_failure_not_a_folder_problem() {
    let source = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let copy = fake_copy(source.path(), CREATED, "0000000f");
    std::fs::remove_file(source.path().join(&copy.file)).unwrap();
    let failed = replicate(source.path(), &copy, dest.path()).unwrap_err();
    assert_eq!(failed.code, failure::LOCAL_COPY_FAILED);
    assert!(names(dest.path()).is_empty());
}

#[tokio::test]
async fn a_manifest_that_names_a_path_is_never_followed() {
    let source = tempfile::tempdir().unwrap();
    let parent = tempfile::tempdir().unwrap();
    let dest = parent.path().join("second");
    std::fs::create_dir(&dest).unwrap();
    let copy = fake_copy(source.path(), CREATED, "00000010");
    for name in [
        "../markiro-host-evil.db",
        "markiro-host-../evil.db",
        "markiro-host-a/b.db",
        "markiro-host-a\\b.db",
        "/etc/markiro-host-x.db",
        "markiro-host-x.db:stream",
        "evil.db",
        "markiro-host-x.json",
        "",
    ] {
        let mut hostile = copy.clone();
        hostile.file = name.to_owned();
        let failed = replicate(source.path(), &hostile, &dest).unwrap_err();
        assert_eq!(failed.code, failure::INTERNAL, "{name:?}");
        assert!(!is_copy_file_name(name), "{name:?}");
    }
    assert!(names(&dest).is_empty());
    assert_eq!(names(parent.path()), ["second"]);
    assert!(is_copy_file_name(&copy.file));
}

#[tokio::test]
async fn sqlite_cannot_open_is_told_apart_by_the_folder() {
    // SQLITE_CANTOPEN is what SQLite says for a folder that is not there and
    // for one the host may not write: the folder decides which.
    let folder = tempfile::tempdir().unwrap();
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(folder.path().join("source.db"))
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    let nowhere = folder.path().join("unplugged").join("copy.db");
    let error = sqlx::query("VACUUM INTO ?")
        .bind(nowhere.to_str().unwrap())
        .execute(&mut conn)
        .await
        .unwrap_err();
    assert_eq!(
        classify_sqlite(&error, &folder.path().join("unplugged")),
        failure::DESTINATION_UNAVAILABLE
    );
    assert_eq!(
        classify_sqlite(&error, folder.path()),
        failure::ACCESS_DENIED
    );
}

const IDENTITY_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/// A folder that cannot be closed: a FAT32 flash drive, a share that
/// refuses ACLs.
struct Refusing;

impl KeyFileGuard for Refusing {
    fn protect(&self, _path: &Path) -> Result<(), String> {
        Err("icacls ended with code 5".to_owned())
    }
}

/// A copy of `admin`'s database in `dir` with the host identity of its data
/// folder beside it (plan I1).
async fn copy_with_identity(admin: &Admin, dir: &Path, guard: Arc<dyn KeyFileGuard>) -> Manifest {
    write_identity(admin.app.dir(), IDENTITY_HOST);
    let identity = HostIdentity::read(&HostPaths::new(admin.app.dir())).unwrap();
    let mut conn = worker_conn(&admin.app).await;
    make_copy_with_identity(
        &mut conn,
        dir,
        at(CREATED),
        BackupTrigger::Scheduled,
        IDENTITY_HOST,
        Some(Arc::new(identity)),
        guard,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_copy_carries_the_host_identity_beside_it_closed_to_others() {
    let admin = admin().await;
    let dir = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, dir.path(), Arc::new(OwnerOnly)).await;
    let db = dir.path().join(&manifest.file);
    assert_eq!(
        names(dir.path()),
        [
            manifest.file.clone(),
            manifest.file.replace(".db", ".identity"),
            manifest.file.replace(".db", ".json"),
        ]
    );
    let source = HostIdentity::read(&HostPaths::new(admin.app.dir())).unwrap();
    let reference = manifest.identity.clone().expect("the manifest names it");
    assert_eq!(reference.fingerprint, source.fingerprint());
    assert_eq!(read_manifest(&db).unwrap(), manifest);
    let beside =
        HostIdentity::from_file_bytes(&std::fs::read(identity_path(&db)).unwrap()).unwrap();
    assert!(beside.same_as(&source));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(identity_path(&db))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(list(dir.path()).unwrap()[0].copy().host_identity);
    // A copy whose identity file is gone is listed without it.
    std::fs::remove_file(identity_path(&db)).unwrap();
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn a_folder_that_cannot_be_closed_gets_the_copy_without_the_identity() {
    let admin = admin().await;
    let dir = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, dir.path(), Arc::new(Refusing)).await;
    assert_eq!(manifest.identity, None);
    assert_eq!(
        names(dir.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn the_second_folder_gets_the_identity_or_a_manifest_without_it() {
    let admin = admin().await;
    let local = tempfile::tempdir().unwrap();
    let closed = tempfile::tempdir().unwrap();
    let open = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, local.path(), Arc::new(OwnerOnly)).await;
    replicate_guarded(local.path(), &manifest, closed.path(), &OwnerOnly).unwrap();
    assert_eq!(names(closed.path()), names(local.path()));
    assert_eq!(
        read_manifest(&closed.path().join(&manifest.file)).unwrap(),
        manifest
    );
    replicate_guarded(local.path(), &manifest, open.path(), &Refusing).unwrap();
    assert_eq!(
        names(open.path()),
        [manifest.file.clone(), manifest.file.replace(".db", ".json")]
    );
    let there = read_manifest(&open.path().join(&manifest.file)).unwrap();
    assert_eq!(there.identity, None);
    assert_eq!(
        Manifest {
            identity: manifest.identity.clone(),
            ..there
        },
        manifest,
        "only the identity differs"
    );
}

#[test]
fn rotation_and_cleaning_take_the_identity_with_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    // 26 copies of one hour: the rule keeps the newest 24.
    let copies: Vec<_> = (0..26)
        .map(|minute| {
            let manifest = fake_copy(
                dir.path(),
                &format!("2026-10-09T10:{minute:02}:00Z"),
                &format!("{minute:08x}"),
            );
            std::fs::write(identity_path(&dir.path().join(&manifest.file)), b"identity").unwrap();
            manifest
        })
        .collect();
    let staying = rotate(dir.path(), None).unwrap();
    assert_eq!(staying.len(), 24);
    for gone in &copies[..2] {
        assert!(!identity_path(&dir.path().join(&gone.file)).exists());
    }
    for kept in &copies[2..] {
        assert!(identity_path(&dir.path().join(&kept.file)).exists());
    }
    // An identity whose copy lost its manifest is a leftover.
    let orphan = dir
        .path()
        .join("markiro-host-20261009T090000Z-deadbeef.identity");
    std::fs::write(&orphan, b"identity").unwrap();
    assert_eq!(clean(dir.path()).unwrap(), 1);
    assert!(!orphan.exists());
    assert!(identity_path(&dir.path().join(&copies[25].file)).exists());
}

/// A guard that closes the identity file and, as a side effect, makes the
/// copy's manifest unwritable: it puts a folder where the manifest's
/// `.partial` is to be created. The copy then fails after its identity was
/// put beside it.
struct BreaksTheManifest;

impl KeyFileGuard for BreaksTheManifest {
    fn protect(&self, path: &Path) -> Result<(), String> {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap();
        let stem = name.strip_suffix(".identity.partial").unwrap();
        std::fs::create_dir(path.with_file_name(format!("{stem}.json.partial")))
            .map_err(|error| error.to_string())?;
        OwnerOnly.protect(path)
    }
}

fn bytes_of(dir: &Path, manifest: &Manifest) -> [Vec<u8>; 3] {
    let db = dir.join(&manifest.file);
    [
        std::fs::read(&db).unwrap(),
        std::fs::read(manifest_path(&db)).unwrap(),
        std::fs::read(identity_path(&db)).unwrap(),
    ]
}

#[tokio::test]
async fn a_copy_that_fails_after_its_identity_leaves_nothing_of_it_and_none_of_the_others() {
    let admin = admin().await;
    let dir = tempfile::tempdir().unwrap();
    let good = copy_with_identity(&admin, dir.path(), Arc::new(OwnerOnly)).await;
    let before = bytes_of(dir.path(), &good);
    write_identity(admin.app.dir(), IDENTITY_HOST);
    let identity = HostIdentity::read(&HostPaths::new(admin.app.dir())).unwrap();
    let mut conn = worker_conn(&admin.app).await;
    let failed = make_copy_with_identity(
        &mut conn,
        dir.path(),
        at("2026-10-09T15:00:00Z"),
        BackupTrigger::Scheduled,
        IDENTITY_HOST,
        Some(Arc::new(identity)),
        Arc::new(BreaksTheManifest),
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code, failure::WRITE_FAILED);
    // Of the failed copy only the folder the guard made is left: no database,
    // no identity, no manifest, no partial file.
    let left = names(dir.path());
    assert_eq!(left.len(), 4, "{left:?}");
    for name in &left {
        let ours = name == &good.file
            || name == &good.file.replace(".db", ".json")
            || name == &good.file.replace(".db", ".identity");
        assert!(ours || name.ends_with(".json.partial"), "{name} is left");
        if name.ends_with(".json.partial") {
            assert!(dir.path().join(name).is_dir());
        }
    }
    // The copy that was there is as it was, and still carries its identity.
    assert_eq!(bytes_of(dir.path(), &good), before);
    assert!(list(dir.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn a_failed_replication_removes_the_identity_it_put_and_keeps_the_one_that_was_there() {
    let admin = admin().await;
    let local = tempfile::tempdir().unwrap();
    let manifest = copy_with_identity(&admin, local.path(), Arc::new(OwnerOnly)).await;

    // A folder the copy was not in: a failed replication leaves none of it.
    let fresh = tempfile::tempdir().unwrap();
    let failed =
        replicate_guarded(local.path(), &manifest, fresh.path(), &BreaksTheManifest).unwrap_err();
    assert_eq!(failed.code, failure::WRITE_FAILED);
    let left = names(fresh.path());
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left[0].ends_with(".json.partial"));

    // A folder that has the copy already: the failure leaves it as it was.
    let there = tempfile::tempdir().unwrap();
    replicate_guarded(local.path(), &manifest, there.path(), &OwnerOnly).unwrap();
    let before = bytes_of(there.path(), &manifest);
    replicate_guarded(local.path(), &manifest, there.path(), &BreaksTheManifest).unwrap_err();
    assert_eq!(bytes_of(there.path(), &manifest), before);
    assert!(list(there.path()).unwrap()[0].copy().host_identity);
}

#[tokio::test]
async fn the_identity_is_copied_only_when_the_manifest_names_it_and_stays_closed_there() {
    let admin = admin().await;
    let local = tempfile::tempdir().unwrap();
    let with = copy_with_identity(&admin, local.path(), Arc::new(OwnerOnly)).await;
    // The manifest of this copy names none, though a file lies beside it.
    let bare = fake_copy(local.path(), "2026-10-09T15:00:00Z", "0000000a");
    std::fs::write(identity_path(&local.path().join(&bare.file)), b"identity").unwrap();
    let dest = tempfile::tempdir().unwrap();
    replicate_guarded(local.path(), &with, dest.path(), &OwnerOnly).unwrap();
    replicate_guarded(local.path(), &bare, dest.path(), &OwnerOnly).unwrap();
    assert!(identity_path(&dest.path().join(&with.file)).exists());
    assert!(!identity_path(&dest.path().join(&bare.file)).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(identity_path(&dest.path().join(&with.file)))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn a_manifest_without_an_identity_is_the_manifest_of_an_older_build_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let bare = fake_copy(dir.path(), CREATED, "0000000b");
    let db = dir.path().join(&bare.file);
    let text = std::fs::read_to_string(manifest_path(&db)).unwrap();
    assert!(!text.contains("identity"), "{text}");
    // A manifest of an older build has no such member and reads as none.
    assert_eq!(read_manifest(&db).unwrap().identity, None);
    // One that names an identity writes it under `identity`.
    let named = Manifest {
        identity: Some(markiro_host::backup::identity::IdentityRef {
            fingerprint: "ab".repeat(32),
            size_bytes: 2048,
            sha256: "cd".repeat(32),
        }),
        ..bare
    };
    let json = serde_json::to_value(&named).unwrap();
    assert_eq!(json["identity"]["sizeBytes"], 2048);
    assert_eq!(
        serde_json::from_value::<Manifest>(json).unwrap().identity,
        named.identity
    );
}

#[test]
fn the_listing_trusts_an_identity_only_of_the_size_the_manifest_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = fake_copy(dir.path(), CREATED, "0000000c");
    let db = dir.path().join(&manifest.file);
    manifest.identity = Some(markiro_host::backup::identity::IdentityRef {
        fingerprint: "ab".repeat(32),
        size_bytes: 8,
        sha256: "cd".repeat(32),
    });
    std::fs::write(manifest_path(&db), serde_json::to_vec(&manifest).unwrap()).unwrap();
    std::fs::write(identity_path(&db), b"identity").unwrap();
    assert!(list(dir.path()).unwrap()[0].copy().host_identity);
    std::fs::write(identity_path(&db), b"identity, longer").unwrap();
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
    std::fs::write(identity_path(&db), b"short").unwrap();
    assert!(!list(dir.path()).unwrap()[0].copy().host_identity);
}

#[test]
fn rotation_keeps_the_identity_of_the_fresh_copy_and_copes_with_copies_that_have_none() {
    let dir = tempfile::tempdir().unwrap();
    // 26 copies of one hour; the rule keeps the newest 24. The oldest is the
    // copy a run has just made (the host's clock was set back): it stays.
    let copies: Vec<_> = (0..26)
        .map(|minute| {
            fake_copy(
                dir.path(),
                &format!("2026-10-09T10:{minute:02}:00Z"),
                &format!("{minute:08x}"),
            )
        })
        .collect();
    // Copies of an older build have no identity: only some do.
    for copy in copies.iter().filter(|copy| copy.file != copies[1].file) {
        std::fs::write(identity_path(&dir.path().join(&copy.file)), b"identity").unwrap();
    }
    let staying = rotate(dir.path(), Some(&copies[0].file)).unwrap();
    assert_eq!(staying.len(), 24 + 1);
    assert!(identity_path(&dir.path().join(&copies[0].file)).exists());
    assert!(dir.path().join(&copies[0].file).exists());
    // The other copy the rule drops had none, and went without a fuss.
    assert!(!dir.path().join(&copies[1].file).exists());
    assert!(!identity_path(&dir.path().join(&copies[1].file)).exists());
}

/// An identity that is no file cannot be removed with `remove_file`: it
/// stands for an `.identity` closed by icacls to another account than the
/// service's now (the service account changed, or a new PC writes to the same
/// share).
fn undeletable(path: &Path) {
    std::fs::create_dir(path).unwrap();
    std::fs::write(path.join("inside"), b"x").unwrap();
}

#[test]
fn rotation_goes_on_past_an_identity_it_cannot_remove() {
    let dir = tempfile::tempdir().unwrap();
    let copies: Vec<_> = (0..26)
        .map(|minute| {
            fake_copy(
                dir.path(),
                &format!("2026-10-09T10:{minute:02}:00Z"),
                &format!("{minute:08x}"),
            )
        })
        .collect();
    // Rotation goes newest first: the copy of 10:01 is dropped before the
    // copy of 10:00.
    let stuck = identity_path(&dir.path().join(&copies[1].file));
    undeletable(&stuck);
    let after = identity_path(&dir.path().join(&copies[0].file));
    std::fs::write(&after, b"identity").unwrap();
    let staying = rotate(dir.path(), None).unwrap();
    assert_eq!(staying.len(), 24);
    for gone in &copies[..2] {
        let db = dir.path().join(&gone.file);
        assert!(
            !db.exists() && !manifest_path(&db).exists(),
            "{}",
            gone.file
        );
    }
    assert!(stuck.is_dir(), "only the identity it cannot remove stays");
    assert!(!after.exists(), "the next copy's identity still goes");
    for kept in &copies[2..] {
        assert!(dir.path().join(&kept.file).exists());
        assert!(manifest_path(&dir.path().join(&kept.file)).exists());
    }
    // The next run is not stopped by it either.
    assert_eq!(rotate(dir.path(), None).unwrap().len(), 24);
    assert_eq!(clean(dir.path()).unwrap(), 0);
    assert!(stuck.is_dir());
}

#[test]
fn cleaning_goes_on_past_an_identity_it_cannot_remove_and_still_fails_on_anything_else() {
    let dir = tempfile::tempdir().unwrap();
    let kept = fake_copy(dir.path(), CREATED, "0000000e");
    let orphan = dir
        .path()
        .join("markiro-host-20261009T090000Z-deadbeef.identity");
    let partial = dir
        .path()
        .join("markiro-host-20261009T090000Z-deadbeef.identity.partial");
    undeletable(&orphan);
    undeletable(&partial);
    let half = dir
        .path()
        .join("markiro-host-20261009T090000Z-deadbeef.db.partial");
    std::fs::write(&half, b"half").unwrap();
    let bare = dir.path().join("markiro-host-20261009T080000Z-0badf00d.db");
    std::fs::write(&bare, b"no manifest").unwrap();
    assert_eq!(clean(dir.path()).unwrap(), 2, "the two it could remove");
    assert!(!half.exists() && !bare.exists());
    assert!(orphan.is_dir() && partial.is_dir());
    assert!(dir.path().join(&kept.file).exists());
    // A leftover of a copy's database it cannot remove still fails the call.
    undeletable(&half);
    assert!(clean(dir.path()).is_err());
}

#[test]
fn a_stale_partial_identity_is_cleaned_with_the_other_leftovers() {
    let dir = tempfile::tempdir().unwrap();
    let kept = fake_copy(dir.path(), CREATED, "0000000d");
    let partial = dir
        .path()
        .join("markiro-host-20261009T090000Z-deadbeef.identity.partial");
    std::fs::write(&partial, b"half").unwrap();
    let other = dir.path().join("notes.identity");
    std::fs::write(&other, b"not ours").unwrap();
    assert_eq!(clean(dir.path()).unwrap(), 1);
    assert!(!partial.exists());
    assert!(other.exists(), "only names of copies are ever touched");
    assert!(dir.path().join(&kept.file).exists());
}
