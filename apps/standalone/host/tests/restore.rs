//! `markiro-host restore` (plan РК): the copy back in place, every SSCC
//! counter and shift number above both databases, a new restore epoch, one
//! audit row; and every refusal leaves the data folder as it was.

mod support;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use markiro_host::backup::copy::{
    make_copy, make_copy_tagged, make_copy_with_identity, manifest_path, sha256_file, Manifest,
};
use markiro_host::backup::identity::{identity_path, platform_guard, HostIdentity};
use markiro_host::clock::ManualClock;
use markiro_host::config::HostPaths;
use markiro_host::license::state::Phase;
use markiro_host::restore::{
    restore, restore_crashing, restore_with, summary, verify_copy, Carried, CopyIdentity,
    CrashPoint, Current, IdentityChoice, IdentityOutcome, Interrupted, RestoreOptions,
    RestoreReport, SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
use markiro_host::server::AppState;
use markiro_host::StartOptions;
use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use sqlx::{ConnectOptions, Connection, SqlitePool};
use support::app::{
    add_operator, admin, json as json_request, login, pair_device, plan_shift, request,
    seed_office_user, shift_body, shift_setup, with_device, Admin, TestApp,
};
use support::backup::{at, close_pool, latest_migration, names, stop, worker_conn, write_identity};

const PREFIX: &str = "460068200";
const NOW: &str = "2026-10-09T15:00:00Z";

async fn ask_block(admin: &Admin, request_id: &str) -> Value {
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({ "requestId": request_id, "issuerPrefix": PREFIX, "extension": 0 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    block
}

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

/// A verified copy of `app`'s database with its data folder's host identity
/// beside it (plan I1), and that identity.
async fn copy_with_identity(app: &TestApp) -> (PathBuf, Manifest, HostIdentity) {
    let identity = write_identity(app.dir(), &app.state.host_id);
    let folder = app.dir().join("backups");
    let mut conn = worker_conn(app).await;
    let manifest = make_copy_with_identity(
        &mut conn,
        &folder,
        app.state.now(),
        BackupTrigger::Scheduled,
        &app.state.host_id,
        Some(Arc::new(
            HostIdentity::read(&HostPaths::new(app.dir())).unwrap(),
        )),
        platform_guard(),
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    assert!(manifest.identity.is_some(), "the copy carries the identity");
    (folder.join(&manifest.file), manifest, identity)
}

async fn reopen(paths: &HostPaths) -> SqlitePool {
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
}

async fn counters(pool: &SqlitePool) -> Vec<(String, i64, i64)> {
    sqlx::query_as("SELECT issuer_prefix, extension, next_serial FROM sscc_counters ORDER BY 1, 2")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn shift_numbers(pool: &SqlitePool) -> Vec<(String, i64)> {
    sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters ORDER BY 1")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Copy a file a SQLite connection still holds open, byte for byte, as a
/// power cut leaves it. `std::fs::copy` is `CopyFileExW` on Windows, which
/// opens the source without sharing write access and so fails with a sharing
/// violation beside SQLite's read-write handle; `File::open` shares read,
/// write and delete on every platform.
fn copy_open_file(from: &Path, to: &Path) {
    let mut source = std::fs::File::open(from).unwrap();
    let mut target = std::fs::File::create(to).unwrap();
    std::io::copy(&mut source, &mut target).unwrap();
}

fn restore_dirs(dir: &Path) -> Vec<String> {
    names(dir)
        .into_iter()
        .filter(|name| name.starts_with("restore-"))
        .collect()
}

/// `close_pool` closes the connection `Pool::close` alone leaves open: one
/// dropped just before the close, whose way back to the pool (a ping, then
/// the idle queue) the close overtook. Left open, it held `host.db` for the
/// rest of a test, and on Windows the restore's rename then failed with
/// ERROR_SHARING_VIOLATION (os error 32) on every try.
#[tokio::test]
async fn close_pool_closes_a_connection_on_its_way_back_to_the_pool() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("host.db");
    let wal = dir.path().join("host.db-wal");
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(markiro_host::db::options(&db).create_if_missing(true))
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    // What dropping a pooled connection spawns, polled once here: the
    // pool is still open, so it pings the connection before it goes back.
    let mut back = std::pin::pin!(conn.return_to_pool());
    let returned =
        std::future::poll_fn(|cx| std::task::Poll::Ready(back.as_mut().poll(cx).is_ready())).await;
    assert!(!returned, "the ping is under way");
    drop(conn);

    tokio::join!(close_pool(&pool), back);

    assert_eq!(pool.size(), 0);
    // SQLite removes the WAL when the last connection to the file closes.
    let mut last = markiro_host::db::options(&db).connect().await.unwrap();
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut last)
        .await
        .unwrap();
    last.close().await.unwrap();
    assert!(!wal.exists(), "another connection holds {}", db.display());
}

#[tokio::test]
async fn a_restore_puts_the_copy_back_and_lifts_every_counter_above_both_databases() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    plan_shift(&admin, shift_body(&setup)).await;
    let (copy_path, manifest) = copy(&admin.app).await;
    let copy_rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    // After the copy: a block and a shift the copy never saw.
    let lost = ask_block(&admin, "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d").await;
    assert_eq!(
        (lost["fromSerial"].clone(), lost["toSerial"].clone()),
        (json!(3500), json!(5499))
    );
    plan_shift(&admin, shift_body(&setup)).await;
    let (live_rev, live_audit): (i64, i64) =
        sqlx::query_as("SELECT (SELECT rev FROM host_revision), (SELECT max(id) FROM audit_log)")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert!(live_rev > copy_rev + 1, "the live database went on");
    let paths = stop(&admin.app).await;
    let current = std::fs::read(paths.database_file()).unwrap();

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Read);
    let aside = paths.data_dir.join("restore-20261009T150000Z");
    assert_eq!(report.saved_as.as_deref(), Some(aside.as_path()));
    assert_eq!(std::fs::read(aside.join("host.db")).unwrap(), current);
    assert_eq!(report.copy.sha256, manifest.sha256);
    let pool = reopen(&paths).await;
    // Boxes: the current database had issued to 5499; two blocks of 2000
    // above it. Pallets: the wizard's 40, two blocks of 200 above it.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 9500), (PREFIX.to_owned(), 1, 440)]
    );
    assert_eq!(
        report
            .counters
            .iter()
            .map(|raise| (raise.extension, raise.from, raise.to))
            .collect::<Vec<_>>(),
        [(0, Some(3500), 9500), (1, Some(40), 440)]
    );
    // October had one shift in the copy and two in the current database;
    // September (the copy's month, a day before it) had none.
    assert_eq!(
        shift_numbers(&pool).await,
        [("OCT26".to_owned(), 12), ("SEP26".to_owned(), 10)]
    );
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sscc_blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks, 1,
        "the block the copy never saw is the station's to register"
    );
    let (epoch, held): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT restore_epoch, facts_held_since FROM site")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(epoch.as_deref(), Some(report.epoch.as_str()));
    assert_eq!(held.as_deref(), Some(NOW), "the facts wait for the office");
    assert!(uuid::Uuid::parse_str(&report.epoch).is_ok());
    let (rev, counter_revs): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rev FROM host_revision), (SELECT min(rev) FROM sscc_counters)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    // The revision goes back to the copy's next one, BELOW the live
    // database's: a station whose cursor passed it gets `rev < since` and
    // starts its copies again from zero (`src/local/reference-sync.ts`).
    assert_eq!((rev, counter_revs), (copy_rev + 1, copy_rev + 1));
    assert!(rev < live_rev, "the host went back: {rev} < {live_rev}");
    assert_eq!(report.revision, copy_rev + 1);
    let restore_row: i64 =
        sqlx::query_scalar("SELECT id FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        restore_row,
        live_audit + 1,
        "no audit id of the live database is issued again"
    );
    let row: (
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT at, actor_id, actor_kind, action, target_type, target_id, details \
         FROM audit_log WHERE action = 'host.restore'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (
            row.0.as_str(),
            row.1,
            row.2.as_str(),
            row.4.as_str(),
            row.5.as_str()
        ),
        (NOW, None, "system", "site", "1")
    );
    let details: Value = serde_json::from_str(&row.6).unwrap();
    assert_eq!(
        details,
        json!({
            "file": manifest.file,
            "sha256": manifest.sha256,
            "copyCreatedAt": "2026-09-21T14:13:20Z",
            "current": "read",
            "savedAs": "restore-20261009T150000Z",
            "epoch": report.epoch,
            "counters": [
                { "issuerPrefix": PREFIX, "extension": 0, "from": 3500, "to": 9500 },
                { "issuerPrefix": PREFIX, "extension": 1, "from": 40, "to": 440 },
            ],
            "shiftNumbers": [
                { "monthKey": "OCT26", "from": 1, "to": 12 },
                { "monthKey": "SEP26", "from": null, "to": 10 },
            ],
            "carried": { "devices": 0, "operators": 0, "badges": 0, "officeUsers": 0 },
            "licensesCarried": 0,
            "sessionsEnded": 1,
            "identity": "kept",
        })
    );
    assert_eq!(
        sha256_file(&copy_path).unwrap(),
        (manifest.size_bytes, manifest.sha256.clone()),
        "the copy itself is untouched"
    );
    assert!(!paths.data_dir.join("host.db.partial").exists());
    assert!(
        !paths.restore_intent_file().exists(),
        "the marker goes with the last rename"
    );
    assert_eq!(
        summary(&report),
        [
            format!(
                "restored {} (sha256 {}, made 2026-09-21T14:13:20Z)",
                copy_path.display(),
                manifest.sha256
            ),
            format!("data folder: {}", paths.data_dir.display()),
            format!("the previous database is in {}", aside.display()),
            "revocations carried over from the previous database: 0 devices, 0 operators, 0 badges, 0 office users".to_owned(),
            "license files carried over from the previous database: 0".to_owned(),
            "every office session was ended: everyone signs in to the office again".to_owned(),
            format!("SSCC {PREFIX}/0: 3500 -> 9500"),
            format!("SSCC {PREFIX}/1: 40 -> 440"),
            "shift numbers OCT26: 1 -> 12".to_owned(),
            "shift numbers SEP26: - -> 10".to_owned(),
            format!(
                "restore epoch {}: the stations do not register their SSCC blocks again yet; follow the runbook before they print new boxes",
                report.epoch
            ),
            "the stations' facts wait: resume them in the office (Резервные копии) once the runbook's checks are done".to_owned(),
            "start the host again: sc start MarkiroHost".to_owned(),
        ]
    );
    // The host answers the new epoch.
    let app = markiro_host::server::AppState::new(
        pool,
        admin.app.state.host_id.clone(),
        admin.app.clock.clone(),
    );
    let response = tower::ServiceExt::oneshot(
        markiro_host::server::router(app),
        support::app::empty(request("GET", "/v1/hello")),
    )
    .await
    .unwrap();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let hello: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(hello["restoreEpoch"], json!(report.epoch));
}

#[tokio::test]
async fn the_commits_a_crashed_host_left_in_its_wal_count_too() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    // The files as a host that lost its power leaves them: the block is in
    // the WAL only.
    let crashed = tempfile::tempdir().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        copy_open_file(&admin.app.dir().join(&name), &crashed.path().join(&name));
    }
    std::fs::write(
        crashed.path().join("host.json"),
        json!({ "hostId": admin.app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    let mut file_alone = ConnectOptions::connect(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(crashed.path().join("host.db"))
            .read_only(true)
            .immutable(true),
    )
    .await
    .unwrap();
    let tables: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sscc_counters'")
            .fetch_one(&mut file_alone)
            .await
            .unwrap();
    file_alone.close().await.unwrap();
    assert_eq!(tables, 0, "everything is still in the WAL");
    let paths = HostPaths::new(crashed.path());
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.current, Current::Read);
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    let saved = report.saved_as.unwrap();
    assert!(
        saved.join("host.db-wal").exists(),
        "the WAL is saved with it"
    );
}

#[tokio::test]
async fn an_unreadable_current_database_leaves_the_margins_over_the_copy() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let (copy_rev, copy_audit): (i64, i64) =
        sqlx::query_as("SELECT (SELECT rev FROM host_revision), (SELECT max(id) FROM audit_log)")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let paths = stop(&admin.app).await;
    std::fs::write(paths.database_file(), b"what is left of a dead disk").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.current, Current::Unreadable);
    let saved = report.saved_as.clone().unwrap();
    assert_eq!(
        std::fs::read(saved.join("host.db")).unwrap(),
        b"what is left of a dead disk"
    );
    let pool = reopen(&paths).await;
    // The copy's highest numbers are 1500 and 40: 100 000 above each, rounded
    // up to the next 10 000.
    assert_eq!(
        counters(&pool).await,
        [
            (PREFIX.to_owned(), 0, 110_000),
            (PREFIX.to_owned(), 1, 110_000)
        ]
    );
    let lines = summary(&report);
    assert!(lines.contains(
        &"the previous database could not be read: every SSCC counter is at least 100000 above the copy's highest number".to_owned()
    ), "{lines:#?}");
    assert!(lines.contains(
        &"the previous database was not read: devices, operators, badges and office users revoked after 2026-09-21T14:13:20Z are active again: check them in the office".to_owned()
    ), "{lines:#?}");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0, "no office session survives a restore");
    assert_eq!(
        (
            report.carried,
            report.licenses_carried,
            report.sessions_ended
        ),
        (None, None, 1)
    );
    assert!(lines.contains(&license_lost_line(&report)), "{lines:#?}");
    // The revision is the copy's next one; the audit ids, which are never
    // issued twice, jump far above the copy's (what the dead database
    // issued is unknown).
    let (rev, restore_row): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT rev FROM host_revision), (SELECT id FROM audit_log WHERE action = 'host.restore')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rev, copy_rev + 1);
    assert_eq!(restore_row, copy_audit + UNREADABLE_CURRENT_MARGIN + 1);
    assert_eq!(
        shift_numbers(&pool).await,
        [
            ("OCT26".to_owned(), SHIFT_NUMBER_MARGIN),
            ("SEP26".to_owned(), SHIFT_NUMBER_MARGIN)
        ]
    );
}

#[tokio::test]
async fn a_new_computer_gets_the_copy_and_a_new_identity() {
    let admin = admin().await;
    let copy_rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(
        (report.current, report.saved_as.clone()),
        (Current::Absent, None)
    );
    assert!(restore_dirs(fresh.path()).is_empty());
    let config = markiro_host::config::HostConfig::load(&paths).unwrap();
    assert_ne!(config.host_id, admin.app.state.host_id);
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [
            (PREFIX.to_owned(), 0, 110_000),
            (PREFIX.to_owned(), 1, 110_000)
        ]
    );
    assert!(summary(&report).contains(&"there was no previous database".to_owned()));
    assert!(report.new_identity);
    assert!(summary(&report).contains(&format!(
        "a new host identity was created in {}: every device pairs with this host again",
        paths.config_file().display()
    )));
    // The copy is of another host: the stations pair with this one again.
    assert!(report.other_host);
    assert!(summary(&report).contains(
        &"the copy was made by another host: the stations pair with this one again".to_owned()
    ));
    // No previous database: no line about files it would have had; the
    // copy's files are another host's.
    let licenses: Vec<String> = summary(&report)
        .into_iter()
        .filter(|line| line.contains("license file"))
        .collect();
    assert_eq!(licenses, [LICENSE_OF_ANOTHER_HOST]);
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rev, copy_rev + 1);
}

/// The data folder's names, and the bytes of the database and its WAL.
fn snapshot(paths: &HostPaths) -> (Vec<String>, Vec<u8>, Option<Vec<u8>>) {
    let wal = std::fs::read(format!("{}-wal", paths.database_file().display())).ok();
    (
        names(&paths.data_dir),
        std::fs::read(paths.database_file()).unwrap(),
        wal,
    )
}

/// Restore `copy_path` into `paths` and expect a refusal that left the data
/// folder exactly as it was.
async fn refused(paths: &HostPaths, copy_path: &Path, without_manifest: bool) -> String {
    let before = snapshot(paths);
    let error = restore(paths, copy_path, without_manifest, at(NOW))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        snapshot(paths) == before,
        "the data folder changed: {error}"
    );
    error
}

#[tokio::test]
async fn a_damaged_copy_is_refused_and_nothing_moves() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let mut bytes = std::fs::read(&copy_path).unwrap();
    bytes[5000] ^= 0xff;
    std::fs::write(&copy_path, &bytes).unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("does not match its manifest"), "{error}");
    std::fs::remove_file(manifest_path(&copy_path)).unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("--without-manifest"), "{error}");
}

#[tokio::test]
async fn a_copy_this_build_cannot_read_is_refused_and_nothing_moves() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let foreign = paths.data_dir.join("foreign.db");
    std::fs::copy(&copy_path, &foreign).unwrap();
    {
        let mut conn =
            ConnectOptions::connect(&sqlx::sqlite::SqliteConnectOptions::new().filename(&foreign))
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES (9999, 'from a newer host', 1, x'00', 0)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
    }
    let error = refused(&paths, &foreign, true).await;
    // Refused before anything moved, not by the migrator after the move.
    assert!(
        error.contains("migration 9999 of the copy is unknown to this markiro-host"),
        "{error}"
    );
    std::fs::remove_file(&foreign).unwrap();

    let blank = TestApp::new().await;
    let (blank_copy, _) = copy(&blank).await;
    let error = refused(&paths, &blank_copy, false).await;
    assert!(error.contains("wizard never finished"), "{error}");
    let text = paths.data_dir.join("text.db");
    std::fs::write(&text, "no database").unwrap();
    refused(&paths, &text, true).await;
    std::fs::remove_file(&text).unwrap();
}

#[tokio::test]
async fn a_running_host_keeps_its_data_folder() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let lock = paths.lock().unwrap();
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("locked"), "{error}");
    assert!(error.contains("sc stop MarkiroHost"), "{error}");
    assert!(error.contains("Nothing was changed"), "{error}");
    drop(lock);
}

#[tokio::test]
async fn a_failure_while_the_new_database_is_built_changes_nothing() {
    let admin = admin().await;
    // The copy carries a trigger that stops the restore's own transaction;
    // the current database has none.
    sqlx::query(
        "CREATE TRIGGER no_epoch BEFORE UPDATE OF restore_epoch ON site \
         BEGIN SELECT RAISE(ABORT, 'no epoch here'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    sqlx::query("DROP TRIGGER no_epoch")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;
    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("no epoch here"), "{error}");
    let pool = reopen(&paths).await;
    // The copy carries `no_epoch`, the current database does not (it has the
    // migrations' own triggers, which both do).
    let triggers: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'trigger'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        !triggers.iter().any(|name| name == "no_epoch"),
        "{triggers:?}"
    );
    assert!(!triggers.is_empty(), "the migrations' triggers are there");
}

#[tokio::test]
async fn verify_copy_reports_a_good_copy() {
    let admin = admin().await;
    let (copy_path, manifest) = copy(&admin.app).await;
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert_eq!(
        (
            verified.size_bytes,
            verified.sha256,
            verified.schema_version
        ),
        (
            manifest.size_bytes,
            manifest.sha256.clone(),
            latest_migration()
        )
    );
    assert_eq!(verified.manifest, Some(manifest));
    let unchecked = verify_copy(&copy_path, true).await.unwrap();
    assert_eq!(unchecked.manifest, None);
}

#[tokio::test]
async fn a_second_restore_of_the_same_copy_goes_above_the_first() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;

    let first = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    let second = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    // The same second: the second aside folder does not meet the first.
    assert_eq!(
        restore_dirs(&paths.data_dir),
        ["restore-20261009T150000Z", "restore-20261009T150000Z-2"]
    );
    assert_eq!(second.current, Current::Read);
    assert_ne!(first.epoch, second.epoch);
    assert_eq!(
        second.revision, first.revision,
        "each restore goes back to the copy's next revision"
    );
    let pool = reopen(&paths).await;
    // 3500 (the copy) -> 7500 -> 11500: the second restore sees the first.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 11500), (PREFIX.to_owned(), 1, 840)]
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        rows, 1,
        "the first restore's row was in the database set aside"
    );
    let epoch: String = sqlx::query_scalar("SELECT restore_epoch FROM site")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(epoch, second.epoch);
}

/// A copy of an older version: migrations 1-10 only.
async fn old_copy(dir: &Path) -> (PathBuf, Manifest) {
    use sqlx::migrate::Migrator;
    let old = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version <= 10)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    let db = dir.join("old-host.db");
    let mut conn = markiro_host::db::options(&db)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    old.run(&mut conn).await.unwrap();
    for statement in [
        "UPDATE site SET initialized_at = '2026-09-20T10:00:00Z' WHERE id = 1",
        "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES ('460068200', 0, 3500, 1), ('460068200', 1, 40, 1)",
        "INSERT INTO shift_number_counters (month_key, last_seq) VALUES ('SEP26', 4)",
    ] {
        sqlx::query(statement).execute(&mut conn).await.unwrap();
    }
    let folder = dir.join("old-copies");
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
    (folder.join(&manifest.file), manifest)
}

#[tokio::test]
async fn a_copy_of_an_older_schema_is_migrated_forward_before_the_counters_are_raised() {
    let work = tempfile::tempdir().unwrap();
    let (copy_path, manifest) = old_copy(work.path()).await;
    assert_eq!(manifest.schema_version, 10);
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert_eq!(verified.schema_version, 10);
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let pool = reopen(&paths).await;
    let versions: Vec<i64> = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // The copy has no audit row at all (no sequence to read): the restore's
    // own row comes far above what the dead database may have issued.
    let restore_row: i64 =
        sqlx::query_scalar("SELECT id FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(restore_row, UNREADABLE_CURRENT_MARGIN + 1);
    assert_eq!(*versions.last().unwrap(), latest_migration());
    assert!(
        versions.contains(&11) && versions.contains(&12),
        "{versions:?}"
    );
    // No current database: 100 000 above the copy's 3500 and 40, rounded up.
    assert_eq!(
        counters(&pool).await,
        [
            (PREFIX.to_owned(), 0, 110_000),
            (PREFIX.to_owned(), 1, 110_000)
        ]
    );
    assert_eq!(
        shift_numbers(&pool).await,
        [("OCT26".to_owned(), 10), ("SEP26".to_owned(), 14)]
    );
    let epoch: Option<String> = sqlx::query_scalar("SELECT restore_epoch FROM site")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(epoch.as_deref(), Some(report.epoch.as_str()));
}

#[tokio::test]
async fn a_clock_set_back_changes_no_number() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    plan_shift(&admin, shift_body(&setup)).await;
    let (copy_path, _) = copy(&admin.app).await;
    plan_shift(&admin, shift_body(&setup)).await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at("2020-01-01T00:00:00Z"))
        .await
        .unwrap();

    assert_eq!(
        report.saved_as.as_deref(),
        Some(paths.data_dir.join("restore-20200101T000000Z").as_path())
    );
    let pool = reopen(&paths).await;
    // As with the right clock: the live database's October and the copy's
    // September (the day before the copy's time).
    assert_eq!(
        shift_numbers(&pool).await,
        [("OCT26".to_owned(), 12), ("SEP26".to_owned(), 10)]
    );
}

#[tokio::test]
async fn a_wal_beside_no_database_goes_aside_and_is_not_read_by_the_new_one() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    std::fs::write(
        fresh.path().join("host.db-wal"),
        b"frames of a database that is gone",
    )
    .unwrap();

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Absent);
    let aside = report.saved_as.clone().expect("the stray WAL is kept");
    assert_eq!(
        std::fs::read(aside.join("host.db-wal")).unwrap(),
        b"frames of a database that is gone"
    );
    assert!(!fresh.path().join("host.db-wal").exists());
    assert_eq!(counters(&reopen(&paths).await).await.len(), 2);
}

#[tokio::test]
async fn what_an_interrupted_restore_left_beside_the_database_is_gone_after_the_next_one() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        std::fs::write(
            paths.data_dir.join(format!("host.db.partial{suffix}")),
            b"half of a database",
        )
        .unwrap();
    }

    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let left: Vec<String> = names(&paths.data_dir)
        .into_iter()
        .filter(|name| name.starts_with("host.db"))
        .collect();
    assert_eq!(left, ["host.db"]);
}

#[tokio::test]
async fn the_hosts_own_database_is_no_copy() {
    let admin = admin().await;
    let paths = stop(&admin.app).await;
    let own = paths.database_file();
    let error = refused(&paths, &own, true).await;
    assert!(error.contains("own database"), "{error}");
}

/// A copy from a flash drive or a read-only share carries its read-only flag;
/// the database put in its place must still be written to.
#[cfg(unix)]
#[tokio::test]
async fn a_copy_that_is_read_only_is_restored_into_a_database_that_is_not() {
    use std::os::unix::fs::PermissionsExt;
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    std::fs::set_permissions(&copy_path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());

    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let mode = std::fs::metadata(paths.database_file())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o200, 0o200, "the owner can write: {mode:o}");
    assert_eq!(mode & 0o077, 0, "nobody else can read it: {mode:o}");
    assert_eq!(counters(&reopen(&paths).await).await.len(), 2);
}

#[tokio::test]
async fn the_commits_an_interrupted_restore_left_in_a_wal_are_not_replayed_into_the_next() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    // The new database of a restore that was killed while its connection was
    // open: a WAL with committed frames beside `host.db.partial`.
    let staging = paths.data_dir.join("host.db.partial");
    let mut killed = markiro_host::db::options(&staging)
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE what_the_killed_restore_wrote (a TEXT)")
        .execute(&mut killed)
        .await
        .unwrap();
    for _ in 0..40 {
        sqlx::query("INSERT INTO what_the_killed_restore_wrote VALUES (hex(randomblob(900)))")
            .execute(&mut killed)
            .await
            .unwrap();
    }
    let sources = tempfile::tempdir().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db.partial{suffix}");
        copy_open_file(&paths.data_dir.join(&name), &sources.path().join(&name));
    }
    killed.close().await.unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db.partial{suffix}");
        std::fs::copy(sources.path().join(&name), paths.data_dir.join(&name)).unwrap();
    }
    assert!(
        paths
            .data_dir
            .join("host.db.partial-wal")
            .metadata()
            .unwrap()
            .len()
            > 0
    );

    restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    let pool = reopen(&paths).await;
    let junk: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = 'what_the_killed_restore_wrote'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(junk, 0);
    assert_eq!(counters(&pool).await.len(), 2);
}

/// The files of `admin`'s running host copied as a host that lost its power
/// leaves them (the latest commits are in the WAL only), with its
/// `host.json`, in a new folder.
fn crashed_folder(admin: &Admin) -> tempfile::TempDir {
    let crashed = tempfile::tempdir().unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        copy_open_file(&admin.app.dir().join(&name), &crashed.path().join(&name));
    }
    std::fs::write(
        crashed.path().join("host.json"),
        json!({ "hostId": admin.app.state.host_id, "port": 45710 }).to_string(),
    )
    .unwrap();
    crashed
}

/// `markiro_host::start` on `paths`: it must refuse while a restore is
/// unfinished (it refuses before it binds anything).
async fn start_refused(paths: &HostPaths) -> String {
    let started = markiro_host::start(
        paths,
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await;
    match started {
        Ok(host) => {
            host.stop().await.unwrap();
            panic!("the host started beside an unfinished restore");
        }
        Err(error) => error.to_string(),
    }
}

fn assert_waits_for_the_restore(error: &str) {
    assert!(
        error.contains("interrupted") && error.contains("markiro-host restore"),
        "{error}"
    );
}

#[tokio::test]
async fn a_restore_cut_off_after_the_wal_left_is_rolled_back_by_the_next_and_the_host_waits() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    // 1500..3499, in the WAL only.
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let crashed = crashed_folder(&admin);
    let paths = HostPaths::new(crashed.path());

    restore_crashing(&paths, &copy_path, false, at(NOW), CrashPoint::WalAside)
        .await
        .unwrap();

    // The power went: the database is there without its WAL.
    assert!(paths.restore_intent_file().exists());
    assert!(paths.database_file().exists());
    assert!(!crashed.path().join("host.db-wal").exists());
    assert_waits_for_the_restore(&start_refused(&paths).await);

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.interrupted, Some(Interrupted::RolledBack));
    assert_eq!(report.current, Current::Read);
    assert!(!paths.restore_intent_file().exists());
    let pool = reopen(&paths).await;
    // The WAL's block counts: 3500, two blocks of 2000 above it.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    let saved = report.saved_as.clone().unwrap();
    assert!(saved.join("host.db").exists() && saved.join("host.db-wal").exists());
    assert_eq!(
        restore_dirs(&paths.data_dir),
        ["restore-20261009T150000Z"],
        "the cut-off restore's folder was emptied and removed"
    );
    assert!(summary(&report).contains(
        &"an interrupted restore was found: the previous database was put back first".to_owned()
    ));
}

#[tokio::test]
async fn a_restore_cut_off_after_the_database_left_is_rolled_back_by_the_next() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let lost = ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    assert_eq!(lost["toSerial"], json!(3499));
    let paths = stop(&admin.app).await;

    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::DatabaseAside,
    )
    .await
    .unwrap();

    assert!(!paths.database_file().exists());
    assert_waits_for_the_restore(&start_refused(&paths).await);
    assert!(
        !paths.database_file().exists(),
        "start made no empty database in its place"
    );

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.interrupted, Some(Interrupted::RolledBack));
    assert_eq!(
        report.current,
        Current::Read,
        "the database set aside counts"
    );
    let pool = reopen(&paths).await;
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    assert!(!paths.restore_intent_file().exists());
}

#[tokio::test]
async fn a_restore_cut_off_after_the_new_database_took_its_place_is_finished_by_the_next() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let paths = stop(&admin.app).await;

    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::NewDatabaseInPlace,
    )
    .await
    .unwrap();

    assert!(paths.restore_intent_file().exists());
    assert!(!paths.data_dir.join("host.db.partial").exists());
    assert_waits_for_the_restore(&start_refused(&paths).await);

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.interrupted, Some(Interrupted::Finished));
    assert_eq!(report.current, Current::Read);
    assert!(!paths.restore_intent_file().exists());
    let pool = reopen(&paths).await;
    // 3500 (live) -> 7500 (the cut-off restore) -> 11500.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 11500), (PREFIX.to_owned(), 1, 840)]
    );
    assert_eq!(
        restore_dirs(&paths.data_dir),
        ["restore-20261009T150000Z", "restore-20261009T150000Z-2"]
    );
    assert!(
        summary(&report).contains(&"an interrupted restore was found: it had finished".to_owned())
    );
}

#[tokio::test]
async fn a_marker_beside_neither_database_is_refused_and_left_for_support() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::DatabaseAside,
    )
    .await
    .unwrap();
    std::fs::remove_file(paths.data_dir.join("host.db.partial")).unwrap();
    let before = names(&paths.data_dir);

    let error = restore(&paths, &copy_path, false, at(NOW))
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("restore-20261009T150000Z"), "{error}");
    assert!(error.contains("call support"), "{error}");
    assert_eq!(names(&paths.data_dir), before);
    assert!(paths
        .data_dir
        .join("restore-20261009T150000Z")
        .join("host.db")
        .exists());
}

#[tokio::test]
async fn a_database_left_aside_counts_even_without_a_marker() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    // 1500..3499, in the WAL only.
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let crashed = crashed_folder(&admin);
    // As an older build's cut-off restore left it: the crashed database and
    // its WAL in an aside folder, and in its place a database that knows
    // less (the copy itself).
    let aside = crashed.path().join("restore-20261001T000000Z");
    std::fs::create_dir(&aside).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        std::fs::rename(crashed.path().join(&name), aside.join(&name)).unwrap();
    }
    std::fs::copy(&copy_path, crashed.path().join("host.db")).unwrap();
    let paths = HostPaths::new(crashed.path());

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Read);
    // The aside database's WAL issued to 3499: two blocks above 3500.
    assert_eq!(
        counters(&reopen(&paths).await).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    assert_eq!(names(&aside), ["host.db", "host.db-shm", "host.db-wal"]);
}

/// A badge verifier with the site's salt (the host checks its shape only).
async fn badge_phc(admin: &Admin) -> String {
    use base64::Engine;
    let (status, body) = admin.call("GET", "/v1/office/badge-salt", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    format!(
        "pbkdf2$sha256$100000${}${}",
        body["badgeSalt"].as_str().unwrap(),
        base64::engine::general_purpose::STANDARD.encode([7u8; 32])
    )
}

#[tokio::test]
async fn revocations_made_after_the_copy_stay_revoked_and_no_office_session_survives() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let (office, _) = pair_device(&admin.app, "office").await;
    let (turned_off, turned_off_rev) = add_operator(&admin, "0042").await;
    let (kept, _) = add_operator(&admin, "0043").await;
    let (status, badge) = admin
        .call(
            "POST",
            &format!("/v1/office/operators/{kept}/badges"),
            Some(json!({ "badgePhc": badge_phc(&admin).await })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{badge}");
    let badge = badge["id"].as_str().unwrap().to_owned();
    let tech = seed_office_user(&admin.app, "tech", "technologist", "technologist password").await;
    login(&admin.app, &admin.key, "tech", "technologist password").await;
    // Revoked and turned off before the copy already: the copy's own
    // revocation stays as it was, and is not counted as carried.
    let (old_device, _) = pair_device(&admin.app, "office").await;
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{old_device}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (old_operator, old_operator_rev) = add_operator(&admin, "0045").await;
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{old_operator}"),
            Some(json!({ "active": false, "expectedRev": old_operator_rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (old_revoked_at, old_operator_rev): (String, i64) = sqlx::query_as(
        "SELECT (SELECT revoked_at FROM devices WHERE id = ?1), (SELECT rev FROM operators WHERE id = ?2)",
    )
    .bind(&old_device)
    .bind(&old_operator)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    // The revocations after the copy happen later: other times.
    admin.app.clock.advance(time::Duration::minutes(5));
    let copy_rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    // After the copy: a device revoked, an operator turned off, a badge
    // revoked, an office user turned off, and an operator the copy never had.
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{station}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/operators/{turned_off}"),
            Some(json!({ "active": false, "expectedRev": turned_off_rev })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = admin
        .call(
            "DELETE",
            &format!("/v1/office/operators/{kept}/badges/{badge}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&tech)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (newcomer, _) = add_operator(&admin, "0044").await;
    let (device_revoked_at, badge_revoked_at): (String, String) = sqlx::query_as(
        "SELECT (SELECT revoked_at FROM devices WHERE id = ?1), \
         (SELECT revoked_at FROM operator_badges WHERE id = ?2)",
    )
    .bind(&station)
    .bind(&badge)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(
        report.carried,
        Some(Carried {
            devices: 1,
            operators: 1,
            badges: 1,
            office_users: 1,
        })
    );
    assert_eq!(
        report.sessions_ended, 2,
        "the administrator's and the technologist's"
    );
    let pool = reopen(&paths).await;
    let revoked: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, revoked_at FROM devices WHERE id IN (?, ?) ORDER BY kind DESC")
            .bind(&station)
            .bind(&office)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        revoked,
        [
            (station.clone(), Some(device_revoked_at)),
            (office.clone(), None)
        ]
    );
    let old: (Option<String>, i64) = sqlx::query_as(
        "SELECT (SELECT revoked_at FROM devices WHERE id = ?1), (SELECT rev FROM operators WHERE id = ?2)",
    )
    .bind(&old_device)
    .bind(&old_operator)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(old, (Some(old_revoked_at), old_operator_rev));
    let operators: Vec<(String, bool, i64)> = sqlx::query_as(
        "SELECT id, active, rev FROM operators WHERE login <> '0045' ORDER BY login",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        operators.len(),
        2,
        "the operator the copy never had stays out"
    );
    assert!(!operators.iter().any(|(id, _, _)| *id == newcomer));
    assert_eq!(operators[0], (turned_off.clone(), false, copy_rev + 1));
    assert!(operators[1].1, "an operator nobody turned off stays on");
    let badge_now: (Option<String>, i64) =
        sqlx::query_as("SELECT revoked_at, rev FROM operator_badges WHERE id = ?")
            .bind(&badge)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(badge_now.0.as_deref(), Some(badge_revoked_at.as_str()));
    let rev = report.revision;
    assert_eq!(badge_now.1, rev);
    assert_eq!(operators[0].2, rev);
    let mut tombstones: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT entity, id, rev FROM tombstones")
            .fetch_all(&pool)
            .await
            .unwrap();
    tombstones.sort();
    let mut expected = vec![
        ("operator_badges".to_owned(), badge.clone(), rev),
        ("operators".to_owned(), turned_off.clone(), rev),
        (
            "operators".to_owned(),
            old_operator.clone(),
            old_operator_rev,
        ),
    ];
    expected.sort();
    assert_eq!(tombstones, expected);
    let users: Vec<(String, bool)> =
        sqlx::query_as("SELECT login, active FROM office_users ORDER BY login")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        users,
        [("admin".to_owned(), true), ("tech".to_owned(), false)]
    );
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
    assert!(summary(&report).contains(
        &"revocations carried over from the previous database: 1 devices, 1 operators, 1 badges, 1 office users".to_owned()
    ));
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(
        (details["carried"].clone(), details["sessionsEnded"].clone()),
        (
            json!({ "devices": 1, "operators": 1, "badges": 1, "officeUsers": 1 }),
            json!(2)
        )
    );
}

#[tokio::test]
async fn a_copy_with_its_wal_beside_it_is_restored_with_the_wal_folded_in() {
    let admin = admin().await;
    // 1500..3499, in the WAL only.
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    // The way back after a bad restore: `restore-<time>/host.db` of a host
    // that had crashed, its WAL beside it.
    let crashed = crashed_folder(&admin);
    let aside = crashed.path().join("restore-20261001T000000Z");
    std::fs::create_dir(&aside).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        std::fs::rename(crashed.path().join(&name), aside.join(&name)).unwrap();
    }
    let source = aside.join("host.db");
    let wal = aside.join("host.db-wal");
    // A manifest describes the file alone: with a WAL beside, it no longer
    // describes the copy.
    let (size_bytes, sha256) = sha256_file(&source).unwrap();
    let manifest = Manifest {
        format: 1,
        file: "host.db".to_owned(),
        created_at: NOW.to_owned(),
        trigger: BackupTrigger::Scheduled,
        host_id: admin.app.state.host_id.clone(),
        schema_version: latest_migration(),
        size_bytes,
        sha256,
        identity: None,
    };
    std::fs::write(
        manifest_path(&source),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let error = verify_copy(&source, false).await.unwrap_err().to_string();
    assert!(error.contains("WAL beside it"), "{error}");
    std::fs::remove_file(manifest_path(&source)).unwrap();
    let before = (
        names(&aside),
        std::fs::read(&source).unwrap(),
        std::fs::read(&wal).unwrap(),
    );
    assert!(!before.2.is_empty());

    let verified = verify_copy(&source, true).await.unwrap();
    assert!(verified.wal_folded);
    assert_eq!(verified.schema_version, latest_migration());
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let report = restore(&paths, &source, true, at(NOW)).await.unwrap();

    assert!(report.copy.wal_folded);
    let blocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sscc_blocks")
        .fetch_one(&reopen(&paths).await)
        .await
        .unwrap();
    assert_eq!(blocks, 1, "the block that was in the WAL only is there");
    assert!(summary(&report)[0].ends_with(", its WAL folded in)"));
    assert_eq!(
        (
            names(&aside),
            std::fs::read(&source).unwrap(),
            std::fs::read(&wal).unwrap()
        ),
        before,
        "the copy and its WAL are untouched"
    );
}

#[tokio::test]
async fn a_copy_damaged_inside_is_refused_even_without_its_manifest() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let (page_size, root): (i64, i64) = {
        let mut conn = ConnectOptions::connect(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&copy_path)
                .read_only(true)
                .immutable(true),
        )
        .await
        .unwrap();
        let found = sqlx::query_as(
            "SELECT (SELECT page_size FROM pragma_page_size), \
             (SELECT rootpage FROM sqlite_master WHERE name = 'audit_log_at')",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        conn.close().await.unwrap();
        found
    };
    // The last byte of the index's page: the row id of one of its entries.
    // The file still opens and reads; only the index no longer matches.
    let mut bytes = std::fs::read(&copy_path).unwrap();
    let last = usize::try_from(root * page_size).unwrap() - 1;
    bytes[last] ^= 0x01;
    std::fs::write(&copy_path, &bytes).unwrap();

    let error = verify_copy(&copy_path, true).await.unwrap_err().to_string();
    assert!(error.contains("the copy is damaged"), "{error}");
    let error = refused(&paths, &copy_path, true).await;
    assert!(error.contains("the copy is damaged"), "{error}");
}

#[tokio::test]
async fn a_current_database_another_program_holds_is_waited_for_then_refused() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let mut holder = markiro_host::db::options(&paths.database_file())
        .connect()
        .await
        .unwrap();
    for statement in [
        "PRAGMA locking_mode = EXCLUSIVE",
        "UPDATE host_revision SET rev = rev",
    ] {
        sqlx::query(statement).execute(&mut holder).await.unwrap();
    }

    let error = refused(&paths, &copy_path, false).await;

    assert!(error.contains("another program"), "{error}");
    assert!(error.contains("Nothing was changed"), "{error}");
    holder.close().await.unwrap();
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.current, Current::Read);
}

#[tokio::test]
async fn a_failure_in_a_new_folder_says_what_it_created_and_makes_no_identity() {
    let admin = admin().await;
    sqlx::query(
        "CREATE TRIGGER no_epoch BEFORE UPDATE OF restore_epoch ON site \
         BEGIN SELECT RAISE(ABORT, 'no epoch here'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let typo = fresh.path().join("Hots");
    let paths = HostPaths::new(&typo);

    let error = restore(&paths, &copy_path, false, at(NOW))
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("no epoch here"), "{error}");
    assert!(!error.contains("Nothing was changed"), "{error}");
    assert!(
        error.contains(&format!(
            "this run only created the data folder {}",
            typo.display()
        )),
        "{error}"
    );
    assert!(!paths.config_file().exists(), "no identity for no restore");
    assert!(!paths.database_file().exists());
}

#[tokio::test]
async fn without_a_manifest_the_months_run_from_the_copys_own_newest_time() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    plan_shift(&admin, shift_body(&setup)).await;
    let (copy_path, _) = copy(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());

    restore(&paths, &copy_path, true, at("2026-12-15T10:00:00Z"))
        .await
        .unwrap();

    // The copy's newest audit row is of 2026-09-21: every month from the day
    // before it to the restore's day after.
    assert_eq!(
        shift_numbers(&reopen(&paths).await).await,
        [
            ("DEC26".to_owned(), 10),
            ("NOV26".to_owned(), 10),
            ("OCT26".to_owned(), 11),
            ("SEP26".to_owned(), 10),
        ]
    );
}

#[tokio::test]
async fn the_new_database_of_an_interrupted_restore_is_no_copy() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let paths = stop(&admin.app).await;
    let staged = paths.data_dir.join("host.db.partial");
    std::fs::copy(&copy_path, &staged).unwrap();

    let error = refused(&paths, &staged, true).await;

    assert!(error.contains("own database"), "{error}");
    assert!(staged.exists());
}

#[tokio::test]
async fn a_rollback_stands_when_the_restore_after_it_fails() {
    let admin = admin().await;
    let (good_copy, _) = copy(&admin.app).await;
    sqlx::query(
        "CREATE TRIGGER no_epoch BEFORE UPDATE OF restore_epoch ON site \
         BEGIN SELECT RAISE(ABORT, 'no epoch here'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    admin.app.clock.advance(time::Duration::seconds(1));
    let (bad_copy, _) = copy(&admin.app).await;
    sqlx::query("DROP TRIGGER no_epoch")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;
    let current = std::fs::read(paths.database_file()).unwrap();
    restore_crashing(
        &paths,
        &good_copy,
        false,
        at(NOW),
        CrashPoint::DatabaseAside,
    )
    .await
    .unwrap();

    let error = restore(&paths, &bad_copy, false, at(NOW))
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("no epoch here"), "{error}");
    assert!(error.contains("was rolled back"), "{error}");
    assert!(!error.contains("Nothing was changed"), "{error}");
    assert_eq!(std::fs::read(paths.database_file()).unwrap(), current);
    assert!(
        !paths.restore_intent_file().exists(),
        "the host may start on the database put back"
    );
    assert!(restore_dirs(&paths.data_dir).is_empty());
}

/// The line `markiro-host restore` prints when the current database was read
/// but is not the copy's history.
const NOT_THE_HISTORY: &str = "the current database is not this copy's history (a new host, one whose wizard never finished, or another host's): every SSCC counter is at least 100000 above the copy's highest number";

/// The summary's license line when the current database was not read as the
/// copy's history but was this host's: files loaded after the copy are lost.
fn license_lost_line(report: &RestoreReport) -> String {
    format!(
        "license files loaded after {} are not in the restored database: load the newest license file again in the office (Информация → Лицензия)",
        report.copy_made
    )
}

/// The summary's license line when the copy was made by another host than
/// this one: its files are bound to that host (final review of plan ЛЦ-2).
const LICENSE_OF_ANOTHER_HOST: &str = "the copy's license files, if any, are bound to the host that made it: this host needs a license file of its own (Информация → Лицензия, the activation request)";

/// The summary's license line when there was no database of the copy's host
/// before (no database, or the copy's identity put in place on another
/// computer): the copy holds what it holds (final review of plan ЛЦ-2).
fn license_in_copy_line(report: &RestoreReport) -> String {
    format!(
        "the copy holds the license files loaded up to {}: a license file loaded later on the copy's host is loaded again in the office (Информация → Лицензия)",
        report.copy_made
    )
}

/// The highest audit id `app`'s database issued.
async fn newest_audit_id(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT max(id) FROM audit_log")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// What a restore whose current database says nothing of what the copy's
/// host issued after the copy must give: the margins of an unread database,
/// no revocations carried, and the lines that say so.
async fn assert_unread_margins(
    paths: &HostPaths,
    report: &RestoreReport,
    copy_audit: i64,
    license_line: &str,
) {
    assert_eq!(
        report.current,
        Current::Read,
        "the database was there and read"
    );
    let pool = reopen(paths).await;
    // The copy's highest numbers are 5500 and 40: 100 000 above each, rounded
    // up to the next 10 000, not two blocks (9500 and 440).
    assert_eq!(
        counters(&pool).await,
        [
            (PREFIX.to_owned(), 0, 110_000),
            (PREFIX.to_owned(), 1, 110_000)
        ]
    );
    assert_eq!((report.carried, report.licenses_carried), (None, None));
    let lines = summary(report);
    assert!(lines.contains(&license_line.to_owned()), "{lines:#?}");
    assert_eq!(
        lines
            .iter()
            .filter(|line| line.contains("license file"))
            .count(),
        1,
        "{lines:#?}"
    );
    assert!(lines.contains(&NOT_THE_HISTORY.to_owned()), "{lines:#?}");
    assert!(lines.contains(&format!(
        "the previous database was not read: devices, operators, badges and office users revoked after {} are active again: check them in the office",
        report.copy_made
    )), "{lines:#?}");
    assert!(
        !lines
            .iter()
            .any(|line| line.starts_with("revocations carried over")),
        "{lines:#?}"
    );
    let restore_row: i64 =
        sqlx::query_scalar("SELECT id FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(restore_row, copy_audit + UNREADABLE_CURRENT_MARGIN + 1);
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let details: Value = serde_json::from_str(&details).unwrap();
    assert_eq!(details["carried"], Value::Null);
    assert_eq!(details["licensesCarried"], Value::Null);
}

/// The runbook's new computer: the installer started the service once, so
/// the data folder holds a new identity and a migrated database whose wizard
/// never ran. That database reads, but it issued nothing of the copy's host.
#[tokio::test]
async fn a_restore_over_a_host_that_never_finished_its_wizard_takes_the_unread_margins() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&admin, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _) = copy(&admin.app).await;
    let copy_audit = newest_audit_id(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    paths.ensure().unwrap();
    markiro_host::config::HostConfig::load_or_create(&paths, None).unwrap();
    reopen(&paths).await.close().await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert!(report.saved_as.is_some(), "the empty database goes aside");
    assert_unread_margins(&paths, &report, copy_audit, LICENSE_OF_ANOTHER_HOST).await;
}

/// A copy of host A restored over host B, whose wizard was done: B's numbers
/// say nothing of what A issued after the copy.
#[tokio::test]
async fn a_copy_of_another_host_restored_over_an_initialized_host_takes_the_unread_margins() {
    let a = admin().await;
    ask_block(&a, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&a, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _) = copy(&a.app).await;
    let copy_audit = newest_audit_id(&a.app).await;
    let b = admin().await;
    let paths = stop(&b.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert!(report.other_host);
    assert_unread_margins(&paths, &report, copy_audit, LICENSE_OF_ANOTHER_HOST).await;
}

/// This host's own data folder, whose database was lost and made again by a
/// start (a migrated database whose wizard never ran, beside the same
/// `host.json`): it is of this host, but it issued nothing the copy's host
/// did after the copy.
#[tokio::test]
async fn a_restore_over_this_hosts_database_made_again_by_a_start_takes_the_unread_margins() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&admin, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _) = copy(&admin.app).await;
    let copy_audit = newest_audit_id(&admin.app).await;
    let paths = stop(&admin.app).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }
    reopen(&paths).await.close().await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert!(!report.other_host, "the copy is of this host");
    assert_unread_margins(&paths, &report, copy_audit, &license_lost_line(&report)).await;
}

/// Plan I1: `verify_copy` reads the identity the manifest names, says when it
/// is damaged, and reads none with `--without-manifest` or beside a copy
/// without one.
#[tokio::test]
async fn verify_copy_reads_the_identity_beside_a_copy_as_its_manifest_names_it() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert!(
        matches!(&verified.identity, CopyIdentity::Present(identity) if identity.same_as(&source))
    );
    assert!(matches!(
        verify_copy(&copy_path, true).await.unwrap().identity,
        CopyIdentity::Absent
    ));
    std::fs::remove_file(identity_path(&copy_path)).unwrap();
    assert!(matches!(
        verify_copy(&copy_path, false).await.unwrap().identity,
        CopyIdentity::Damaged(_)
    ));
    let (plain, _) = copy(&admin.app).await;
    assert!(matches!(
        verify_copy(&plain, false).await.unwrap().identity,
        CopyIdentity::Absent
    ));
}

/// Make the manifest of `copy_path` name exactly `bytes` as its identity
/// (size, SHA-256, and the fingerprint of `identity` when given), so that
/// only the content is what is wrong with it.
fn rename_identity_in_manifest(copy_path: &Path, bytes: &[u8], fingerprint: Option<&str>) {
    let path = manifest_path(copy_path);
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let reference = manifest.get_mut("identity").expect("the copy names one");
    reference["sizeBytes"] = json!(bytes.len());
    reference["sha256"] = json!(markiro_host::backup::identity::sha256_hex(bytes));
    if let Some(fingerprint) = fingerprint {
        reference["fingerprint"] = json!(fingerprint);
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

/// What `verify_copy` says of the identity beside `copy_path`: the code and
/// the text of a damaged one. The copy itself still verifies.
async fn damage_of(copy_path: &Path) -> (&'static str, String) {
    match verify_copy(copy_path, false)
        .await
        .expect("a damaged identity does not fail the copy itself")
        .identity
    {
        CopyIdentity::Damaged(damage) => (damage.code, damage.to_string()),
        CopyIdentity::Absent => panic!("a damaged identity read as none"),
        CopyIdentity::Present(_) => panic!("a damaged identity was trusted"),
    }
}

/// Plan I1: every way the file beside a copy can be wrong is `Damaged` with a
/// stable code, never `Present`, and nothing of the key is in the text.
#[tokio::test]
async fn a_damaged_identity_beside_a_copy_is_named_and_never_trusted() {
    let admin = admin().await;
    let (copy_path, manifest, source) = copy_with_identity(&admin.app).await;
    let file = identity_path(&copy_path);
    let good = std::fs::read(&file).unwrap();
    let parsed: Value = serde_json::from_slice(&good).unwrap();
    let key = parsed["privateKey"].as_str().unwrap().to_owned();
    let certificate = parsed["certificate"].as_str().unwrap().to_owned();
    let no_key = |text: &str| {
        assert!(!text.contains(&key[..24]), "the key is in: {text}");
        assert!(
            !text.contains(&certificate[..24]),
            "the certificate is in: {text}"
        );
    };

    // The file is gone: unreadable.
    std::fs::remove_file(&file).unwrap();
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_unreadable", "{text}");
    no_key(&text);

    // One byte changed, same size: the manifest's SHA-256 says so.
    let mut tampered = good.clone();
    let at = tampered.len() / 2;
    tampered[at] = if tampered[at] == b'A' { b'B' } else { b'A' };
    std::fs::write(&file, &tampered).unwrap();
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    assert!(text.contains("manifest"), "{text}");
    no_key(&text);

    // A change that leaves the host, the certificate and the key as they
    // were (the port) and the size: only the manifest's SHA-256 sees it.
    let text_of_file = String::from_utf8(good.clone()).unwrap();
    assert_eq!(text_of_file.matches("45710").count(), 1);
    std::fs::write(&file, text_of_file.replace("45710", "45711")).unwrap();
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    assert!(text.contains("SHA-256"), "{text}");

    // Cut short: the size differs.
    std::fs::write(&file, &good[..good.len() - 40]).unwrap();
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    no_key(&text);

    // A key cut short, the manifest made to agree with the cut file: the key
    // no longer matches the certificate.
    let mut cut = parsed.clone();
    cut["privateKey"] = json!(&key[..key.len() / 2]);
    let cut = serde_json::to_vec_pretty(&cut).unwrap();
    std::fs::write(&file, &cut).unwrap();
    rename_identity_in_manifest(&copy_path, &cut, None);
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    no_key(&text);

    // A file that is no identity at all, again agreeing with its manifest.
    let junk = b"not an identity";
    std::fs::write(&file, junk).unwrap();
    rename_identity_in_manifest(&copy_path, junk, None);
    assert_eq!(damage_of(&copy_path).await.0, "identity_invalid");

    // A whole, valid identity of ANOTHER host, the manifest made to agree
    // with it: still not this copy's host.
    let elsewhere = tempfile::tempdir().unwrap();
    let other = write_identity(elsewhere.path(), "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d");
    assert_ne!(other.host_id(), source.host_id());
    let other_bytes = other.to_file_bytes();
    std::fs::write(&file, &other_bytes).unwrap();
    rename_identity_in_manifest(&copy_path, &other_bytes, Some(other.fingerprint()));
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    assert!(text.contains("another host"), "{text}");

    // The right host's file, but the manifest names another certificate.
    std::fs::write(&file, &good).unwrap();
    rename_identity_in_manifest(&copy_path, &good, Some(&"0".repeat(64)));
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    assert!(text.contains("certificate"), "{text}");

    // Everything put back: trusted again, and only then.
    rename_identity_in_manifest(&copy_path, &good, Some(source.fingerprint()));
    let verified = verify_copy(&copy_path, false).await.unwrap();
    assert!(
        matches!(&verified.identity, CopyIdentity::Present(identity) if identity.same_as(&source))
    );
    assert_eq!(
        manifest.identity.as_ref().unwrap().fingerprint,
        source.fingerprint()
    );
}

/// Plan I1: a file beyond the bound beside a copy is refused without being
/// read whole, as a damaged identity, not as a failure of the copy.
#[tokio::test]
async fn a_huge_file_beside_a_copy_is_a_damaged_identity() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let huge = vec![b'x'; 1024 * 1024];
    std::fs::write(identity_path(&copy_path), &huge).unwrap();
    rename_identity_in_manifest(&copy_path, &huge, None);
    let (code, text) = damage_of(&copy_path).await;
    assert_eq!(code, "identity_invalid", "{text}");
    assert!(text.contains("too large"), "{text}");
}

/// `markiro-host verify-copy <copy> [--without-manifest]` through the real
/// binary: (exit code, stdout, stderr).
fn verify_copy_cli(copy_path: &Path, without_manifest: bool) -> (Option<i32>, String, String) {
    let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_markiro-host"));
    command.arg("verify-copy").arg(copy_path);
    if without_manifest {
        command.arg("--without-manifest");
    }
    let output = command.output().expect("the host binary runs");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Plan I1: `verify-copy` prints the identity beside a copy, says when there
/// is none, and fails on a damaged one, printing no key.
#[tokio::test]
async fn verify_copy_command_prints_the_identity_and_fails_on_a_damaged_one() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let key = {
        let file: Value =
            serde_json::from_slice(&std::fs::read(identity_path(&copy_path)).unwrap()).unwrap();
        file["privateKey"].as_str().unwrap().to_owned()
    };
    let (code, out, err) = verify_copy_cli(&copy_path, false);
    assert_eq!(code, Some(0), "{err}");
    assert!(
        out.contains(&format!(
            "host identity: host {} (certificate {})",
            source.host_id(),
            markiro_proto::display_fingerprint(source.fingerprint())
        )),
        "{out}"
    );
    assert!(!out.contains(&key[..24]) && !err.contains(&key[..24]));

    // `--without-manifest` reads none.
    let (code, out, err) = verify_copy_cli(&copy_path, true);
    assert_eq!(code, Some(0), "{err}");
    assert!(out.contains("host identity: none"), "{out}");

    // A copy without one.
    let (plain, _) = copy(&admin.app).await;
    let (code, out, err) = verify_copy_cli(&plain, false);
    assert_eq!(code, Some(0), "{err}");
    assert!(out.contains("host identity: none"), "{out}");

    // A damaged one: the command fails and names the way out.
    let bytes = std::fs::read(identity_path(&copy_path)).unwrap();
    let mut tampered = bytes.clone();
    let middle = tampered.len() / 2;
    tampered[middle] = if tampered[middle] == b'A' { b'B' } else { b'A' };
    std::fs::write(identity_path(&copy_path), &tampered).unwrap();
    let (code, out, err) = verify_copy_cli(&copy_path, false);
    assert_ne!(code, Some(0), "{out}");
    assert!(
        err.contains("DAMAGED")
            && err.contains("identity_invalid")
            && err.contains("--keep-identity"),
        "{err}"
    );
    assert!(!out.contains(&key[..24]) && !err.contains(&key[..24]));
}

/// A new computer's installer started the host once: `host.json`, a TLS
/// identity and a migrated database whose wizard never ran, as
/// `markiro_host::start` leaves them (without binding a port).
async fn installed(paths: &HostPaths) -> HostIdentity {
    paths.ensure().unwrap();
    // `start` takes the data folder's lock first: its file stays.
    drop(paths.lock().unwrap());
    let config = markiro_host::config::HostConfig::load_or_create(paths, None).unwrap();
    markiro_host::tls::TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id).unwrap();
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    close_pool(&pool).await;
    HostIdentity::read(paths).unwrap()
}

/// Restore with `--keep-identity` or `--take-identity`.
async fn restore_choosing(
    paths: &HostPaths,
    copy_path: &Path,
    identity: IdentityChoice,
) -> RestoreReport {
    restore_with(
        paths,
        copy_path,
        RestoreOptions {
            without_manifest: false,
            identity,
        },
        at(NOW),
    )
    .await
    .unwrap()
}

/// The runbook's new computer (plan I1): the installer started the host once,
/// and the copy carries its host's identity. The identity goes into place —
/// the devices keep their pairing — and the margins stay those of a
/// database that is not the copy's history: the installer's database knows
/// nothing the copy's host issued after the copy.
#[tokio::test]
async fn a_new_computer_takes_the_copys_identity_and_keeps_the_unread_margins() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&admin, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let copy_audit = newest_audit_id(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_unread_margins(&paths, &report, copy_audit, &license_in_copy_line(&report)).await;
    let aside = report
        .saved_as
        .clone()
        .expect("the installer's database went aside");
    assert_eq!(
        report.identity,
        IdentityOutcome::Restored {
            host_id: admin.app.state.host_id.clone(),
            fingerprint: source.fingerprint().to_owned(),
            port: 45710,
            replaced: Some(installer.host_id().to_owned()),
            saved_in: Some(aside.join("identity")),
            former_port: Some(45710),
        }
    );
    assert!(!report.other_host, "the devices keep their pairing");
    assert!(!report.new_identity);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    let saved: Value =
        serde_json::from_slice(&std::fs::read(aside.join("identity").join("host.json")).unwrap())
            .unwrap();
    assert_eq!(saved["hostId"], installer.host_id());
    assert_eq!(
        std::fs::read(aside.join("identity").join("key.der")).unwrap(),
        installer.key_der()
    );
    assert!(!fresh.path().join("identity.partial").exists());
    let lines = summary(&report);
    assert!(
        lines.iter().any(|line| line.starts_with(&format!(
            "the copy's host identity was put in place (host {}",
            admin.app.state.host_id
        ))),
        "{lines:#?}"
    );
    assert!(
        lines.contains(&format!(
            "the identity this data folder had (host {}) was replaced; its files are in {}",
            installer.host_id(),
            aside.join("identity").display()
        )),
        "{lines:#?}"
    );
    let pool = reopen(&paths).await;
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["identity"],
        "restored"
    );
}

/// A new computer's restore whose swap fails before it moved anything (a
/// link nobody can follow stands where the aside folder is to be made):
/// every file is back, and the copy's identity staged for it goes with the
/// marker instead of waiting in `identity.partial/` for the next restore.
#[cfg(unix)]
#[tokio::test]
async fn a_swap_undone_whole_leaves_no_staged_identity_behind() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;
    let database = std::fs::read(paths.database_file()).unwrap();
    std::os::unix::fs::symlink(
        fresh.path().join("nowhere"),
        fresh.path().join("restore-20261009T150000Z"),
    )
    .unwrap();

    let error = restore(&paths, &copy_path, false, at(NOW))
        .await
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("the new database could not be put in place")
            && error.contains("The previous database was put back"),
        "{error}"
    );
    assert!(!fresh.path().join("identity.partial").exists(), "{error}");
    assert!(!paths.restore_intent_file().exists());
    assert!(!fresh.path().join("host.db.partial").exists());
    assert_eq!(std::fs::read(paths.database_file()).unwrap(), database);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&installer));
}

/// A copy of host A over a working host B: the identity waits for the
/// engineer's `--take-identity`, B's identity is kept aside, and the margins
/// stay those of a database that is not the copy's history. (A `foreign`
/// decided after the identity moved would give two blocks: the mutant of
/// step 4.)
#[tokio::test]
async fn over_a_working_host_of_another_identity_the_copys_identity_waits_for_take_identity() {
    let a = admin().await;
    ask_block(&a, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&a, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _, source) = copy_with_identity(&a.app).await;
    let copy_audit = newest_audit_id(&a.app).await;
    let b = admin().await;
    let paths = stop(&b.app).await;
    let own = write_identity(b.app.dir(), &b.app.state.host_id);

    let error = refused(&paths, &copy_path, false).await;
    assert!(
        error.contains("--take-identity") && error.contains("--keep-identity"),
        "{error}"
    );
    assert!(HostIdentity::read(&paths).unwrap().same_as(&own));

    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Take).await;
    assert_unread_margins(&paths, &report, copy_audit, &license_in_copy_line(&report)).await;
    assert!(
        matches!(&report.identity, IdentityOutcome::Restored { replaced: Some(host_id), saved_in: Some(_), .. } if host_id == &b.app.state.host_id),
        "{:?}",
        report.identity
    );
    assert!(!report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
}

/// The same computer: the copy's identity is the folder's own; nothing of it
/// changes and the history is known as before.
#[tokio::test]
async fn on_the_same_computer_the_identity_is_the_folders_own() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let paths = stop(&admin.app).await;
    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();
    assert_eq!(report.identity, IdentityOutcome::Same);
    assert!(report.history_known);
    assert!(!report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    assert!(summary(&report)
        .contains(&"the host identity is the copy's: devices keep their pairing".to_owned()));
}

/// A damaged identity beside the copy is refused, and with `--keep-identity`
/// the data goes back without it: every device pairs again.
#[tokio::test]
async fn a_damaged_identity_is_refused_and_keep_identity_restores_without_it() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let file = identity_path(&copy_path);
    let mut bytes = std::fs::read(&file).unwrap();
    bytes[10] ^= 1;
    std::fs::write(&file, &bytes).unwrap();
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;

    let error = refused(&paths, &copy_path, false).await;
    assert!(
        error.contains("damaged") && error.contains("--keep-identity"),
        "{error}"
    );
    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Keep).await;
    assert_eq!(
        report.identity,
        IdentityOutcome::Kept { copy_had_one: true }
    );
    assert!(report.other_host);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&installer));
    assert!(summary(&report).contains(
        &"the copy's host identity was not used (--keep-identity): every device pairs with this host again"
            .to_owned()
    ));
}

/// A restore cut off after the new database took its place, or inside the
/// identity (the key renamed, not the certificate or `host.json`): the host
/// does not start, and the next restore finishes the identity first.
#[tokio::test]
async fn a_restore_cut_off_inside_the_identity_is_finished_by_the_next_one() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    for (crash, with_installer) in [
        (CrashPoint::NewDatabaseInPlace, true),
        (CrashPoint::IdentityPartly, true),
        (CrashPoint::IdentityPartly, false),
    ] {
        let fresh = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(fresh.path());
        if with_installer {
            installed(&paths).await;
        }
        restore_crashing(&paths, &copy_path, false, at(NOW), crash)
            .await
            .unwrap();
        assert_waits_for_the_restore(&start_refused(&paths).await);
        assert!(
            !HostIdentity::read(&paths).is_ok_and(|identity| identity.same_as(&source)),
            "{crash:?}: the identity is not whole yet"
        );

        let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

        assert_eq!(report.interrupted, Some(Interrupted::Finished), "{crash:?}");
        assert_eq!(report.identity, IdentityOutcome::Same, "{crash:?}");
        assert!(
            HostIdentity::read(&paths).unwrap().same_as(&source),
            "{crash:?}"
        );
        assert!(!fresh.path().join("identity.partial").exists());
        assert!(!paths.restore_intent_file().exists());
    }
}

/// The base64 private key of the identity file beside `copy_path`, to make
/// sure no line prints it.
fn identity_key_text(copy_path: &Path) -> String {
    let file: Value =
        serde_json::from_slice(&std::fs::read(identity_path(copy_path)).unwrap()).unwrap();
    file["privateKey"].as_str().unwrap().to_owned()
}

/// Every file under `dir` that holds a private key (`key.der`, its
/// `.partial`) is closed to everyone but its owner, and so is every folder
/// a restore made for an identity.
#[cfg(unix)]
fn assert_keys_closed(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).unwrap().flatten() {
            let path = entry.path();
            let mode = entry.metadata().unwrap().permissions().mode();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if name == "identity.partial" || name == "identity" {
                    assert_eq!(mode & 0o077, 0, "{} is {mode:o}", path.display());
                }
                pending.push(path);
            } else if name.starts_with("key.der") {
                assert_eq!(mode & 0o077, 0, "{} is {mode:o}", path.display());
            }
        }
    }
}

#[cfg(not(unix))]
fn assert_keys_closed(_dir: &Path) {}

/// The `identity/` folders of every aside folder of `dir`.
fn kept_identities(dir: &Path) -> Vec<PathBuf> {
    restore_dirs(dir)
        .into_iter()
        .map(|name| dir.join(name).join("identity"))
        .filter(|kept| kept.is_dir())
        .collect()
}

/// Plan I1: a restore that takes the copy's identity over a new computer's
/// installer, cut off at every step. While the marker is not there, the
/// installer's database and identity are in place, whole; while it is, the
/// host does not start. The next restore finishes (or rolls back) and puts
/// the copy's identity in place; the installer's is kept whole, no key file
/// is ever open to others, the margins of an unread database never shrink,
/// and the revision is the copy's next one.
#[tokio::test]
async fn every_cut_of_a_restore_that_takes_the_identity_is_finished_by_the_next_one() {
    let admin = admin().await;
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    ask_block(&admin, "4c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let copy_rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let key_text = identity_key_text(&copy_path);
    // (`WalAside` needs a WAL: the installer's database, closed, has none;
    // it rolls back as `DatabaseAside` does.)
    for crash in [
        CrashPoint::DatabaseAside,
        CrashPoint::IdentityStaged,
        CrashPoint::NewDatabaseInPlace,
        CrashPoint::IdentityKeySaving,
        CrashPoint::IdentityPartly,
        CrashPoint::IdentityCertificate,
        CrashPoint::IdentityInPlace,
    ] {
        let fresh = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(fresh.path());
        let installer = installed(&paths).await;
        let installer_db = std::fs::read(paths.database_file()).unwrap();

        restore_crashing(&paths, &copy_path, false, at(NOW), crash)
            .await
            .unwrap_or_else(|error| panic!("{crash:?}: {error}"));

        assert_keys_closed(fresh.path());
        if crash == CrashPoint::IdentityStaged {
            // Cut before the marker: the host may start, on what it had.
            assert!(!paths.restore_intent_file().exists(), "{crash:?}");
            markiro_host::restore::refuse_unfinished(&paths).unwrap();
            assert_eq!(std::fs::read(paths.database_file()).unwrap(), installer_db);
            assert!(HostIdentity::read(&paths).unwrap().same_as(&installer));
            assert!(fresh.path().join("identity.partial").is_dir());
        } else {
            assert!(paths.restore_intent_file().exists(), "{crash:?}");
            assert_waits_for_the_restore(&start_refused(&paths).await);
        }

        let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

        let (interrupted, identity_moved_now) = match crash {
            CrashPoint::DatabaseAside => (Some(Interrupted::RolledBack), true),
            CrashPoint::IdentityStaged => (None, true),
            _ => (Some(Interrupted::Finished), false),
        };
        assert_eq!(report.interrupted, interrupted, "{crash:?}");
        if identity_moved_now {
            assert!(
                matches!(&report.identity, IdentityOutcome::Restored { replaced: Some(host_id), .. } if host_id == installer.host_id()),
                "{crash:?}: {:?}",
                report.identity
            );
        } else {
            assert_eq!(report.identity, IdentityOutcome::Same, "{crash:?}");
        }
        assert!(
            HostIdentity::read(&paths).unwrap().same_as(&source),
            "{crash:?}"
        );
        assert!(!fresh.path().join("identity.partial").exists(), "{crash:?}");
        assert!(!paths.restore_intent_file().exists(), "{crash:?}");
        assert_keys_closed(fresh.path());
        // The installer's identity is kept, whole, once.
        let kept = kept_identities(fresh.path());
        assert_eq!(kept.len(), 1, "{crash:?}: {kept:?}");
        assert_eq!(
            std::fs::read(kept[0].join("key.der")).unwrap(),
            installer.key_der(),
            "{crash:?}"
        );
        assert_eq!(
            std::fs::read(kept[0].join("cert.der")).unwrap(),
            installer.cert_der(),
            "{crash:?}"
        );
        let saved: Value =
            serde_json::from_slice(&std::fs::read(kept[0].join("host.json")).unwrap()).unwrap();
        assert_eq!(saved["hostId"], installer.host_id(), "{crash:?}");
        assert_eq!(
            names(&kept[0]),
            ["cert.der", "host.json", "key.der"],
            "{crash:?}: nothing half-copied stays"
        );
        // The margins of a database that is not the copy's history: never
        // below 100 000 above the copy, cut or not.
        let pool = reopen(&paths).await;
        for (_, extension, next) in counters(&pool).await {
            assert!(
                next >= 110_000,
                "{crash:?}: extension {extension} at {next}"
            );
        }
        let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rev, copy_rev + 1, "{crash:?}");
        pool.close().await;
        assert!(
            summary(&report)
                .iter()
                .all(|line| !line.contains(&key_text[..24])),
            "{crash:?}"
        );
    }
}

/// Plan I1: a restore cut off inside the identity, and the next one cut off
/// inside it again: each finishes what the one before left, and the files
/// are where the order says (the key, the certificate, `host.json` last).
#[tokio::test]
async fn a_restore_cut_off_twice_inside_the_identity_is_finished_by_the_third_run() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    for with_installer in [true, false] {
        let fresh = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(fresh.path());
        let installer = if with_installer {
            Some(installed(&paths).await)
        } else {
            None
        };
        let tls = paths.tls_dir();
        let config = || std::fs::read(paths.config_file()).ok();
        let config_before = config();

        restore_crashing(
            &paths,
            &copy_path,
            false,
            at(NOW),
            CrashPoint::IdentityPartly,
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read(tls.join("key.der")).unwrap(),
            source.key_der()
        );
        assert_eq!(
            std::fs::read(tls.join("cert.der")).ok(),
            installer
                .as_ref()
                .map(|identity| identity.cert_der().to_vec()),
            "the certificate is not moved yet"
        );
        assert_eq!(config(), config_before, "host.json goes last");

        // The next run is cut off as well, after the certificate.
        restore_crashing(
            &paths,
            &copy_path,
            false,
            at(NOW),
            CrashPoint::IdentityCertificate,
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read(tls.join("key.der")).unwrap(),
            source.key_der()
        );
        assert_eq!(
            std::fs::read(tls.join("cert.der")).unwrap(),
            source.cert_der()
        );
        assert_eq!(config(), config_before, "host.json goes last");
        assert_waits_for_the_restore(&start_refused(&paths).await);
        assert_keys_closed(fresh.path());

        let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

        assert_eq!(report.interrupted, Some(Interrupted::Finished));
        assert_eq!(report.identity, IdentityOutcome::Same);
        assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
        assert!(!fresh.path().join("identity.partial").exists());
        if let Some(installer) = &installer {
            let kept = kept_identities(fresh.path());
            assert_eq!(kept.len(), 1, "{kept:?}");
            assert_eq!(
                std::fs::read(kept[0].join("key.der")).unwrap(),
                installer.key_der()
            );
        }
    }
}

/// Plan I1: an identity that would not read whole once in place (a staged
/// file lost: the key would be of another certificate) is never left for
/// the host: the marker stays and the host does not start.
#[tokio::test]
async fn an_identity_that_would_not_read_whole_keeps_the_marker() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    installed(&paths).await;
    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::NewDatabaseInPlace,
    )
    .await
    .unwrap();
    std::fs::remove_file(fresh.path().join("identity.partial").join("cert.der")).unwrap();

    let error = restore(&paths, &copy_path, false, at(NOW))
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("does not read whole"), "{error}");
    assert!(error.contains("markiro-host restore"), "{error}");
    assert!(paths.restore_intent_file().exists());
    assert_waits_for_the_restore(&start_refused(&paths).await);
    assert!(!error.contains(&identity_key_text(&copy_path)[..24]));
}

/// Plan I1: a restore cut off after its identity was whole and its staging
/// folder gone, the marker still there, is finished by the next one.
#[tokio::test]
async fn a_restore_cut_off_after_its_identity_was_in_place_is_finished_by_the_next_one() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    installed(&paths).await;
    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::IdentityInPlace,
    )
    .await
    .unwrap();
    // The cut came after the empty staging folder was removed.
    std::fs::remove_dir(fresh.path().join("identity.partial")).unwrap();
    assert_waits_for_the_restore(&start_refused(&paths).await);

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.interrupted, Some(Interrupted::Finished));
    assert_eq!(report.identity, IdentityOutcome::Same);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
}

/// Plan I1: what a restore cut off before its marker staged of an identity
/// goes with the next restore, whatever it does with the identity.
#[tokio::test]
async fn an_identity_staged_before_a_cut_goes_with_the_next_restore() {
    let admin = admin().await;
    let (copy_path, _, _) = copy_with_identity(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;
    restore_crashing(
        &paths,
        &copy_path,
        false,
        at(NOW),
        CrashPoint::IdentityStaged,
    )
    .await
    .unwrap();
    assert!(fresh.path().join("identity.partial").is_dir());

    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Keep).await;

    assert_eq!(
        report.identity,
        IdentityOutcome::Kept { copy_had_one: true }
    );
    assert!(!fresh.path().join("identity.partial").exists());
    assert!(HostIdentity::read(&paths).unwrap().same_as(&installer));
}

/// Plan I1: a data folder whose database does not read is a working host
/// (its disk may be dying): the copy's identity of another host waits for
/// `--take-identity`.
#[tokio::test]
async fn over_an_unreadable_database_of_another_identity_the_copys_identity_waits() {
    let a = admin().await;
    let (copy_path, _, source) = copy_with_identity(&a.app).await;
    let b = admin().await;
    let paths = stop(&b.app).await;
    let own = write_identity(b.app.dir(), &b.app.state.host_id);
    std::fs::write(paths.database_file(), b"what is left of a dead disk").unwrap();
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }

    let error = refused(&paths, &copy_path, false).await;
    assert!(error.contains("--take-identity"), "{error}");
    assert!(HostIdentity::read(&paths).unwrap().same_as(&own));

    let report = restore_choosing(&paths, &copy_path, IdentityChoice::Take).await;
    assert_eq!(report.current, Current::Unreadable);
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
}

/// Plan I1: a data folder that has an identity but no database (lost, or
/// removed by hand) gets the copy's, and its own is kept in an aside folder
/// made for it; there was no previous database all the same.
#[tokio::test]
async fn an_identity_without_a_database_is_kept_aside_when_the_copys_replaces_it() {
    let admin = admin().await;
    let (copy_path, _, source) = copy_with_identity(&admin.app).await;
    let fresh = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(fresh.path());
    let installer = installed(&paths).await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", paths.database_file().display()));
    }

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Absent);
    assert_eq!(report.saved_as, None);
    assert!(summary(&report).contains(&"there was no previous database".to_owned()));
    let kept = kept_identities(fresh.path());
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        std::fs::read(kept[0].join("key.der")).unwrap(),
        installer.key_der()
    );
    assert!(
        matches!(&report.identity, IdentityOutcome::Restored { saved_in: Some(dir), .. } if dir == &kept[0]),
        "{:?}",
        report.identity
    );
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    let pool = reopen(&paths).await;
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap()["savedAs"],
        Value::Null
    );
}

/// `markiro-host restore <copy> --data-dir <dir> [flags]`, the real binary.
fn restore_cli(copy_path: &Path, data_dir: &Path, flags: &[&str]) -> (Option<i32>, String, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_markiro-host"))
        .arg("restore")
        .arg(copy_path)
        .arg("--data-dir")
        .arg(data_dir)
        .args(flags)
        .output()
        .expect("the host binary runs");
    (
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// Plan I1: `markiro-host restore` refuses the copy's identity over a
/// working host of another one, and puts it in place with
/// `--take-identity`; neither run prints the key.
#[tokio::test]
async fn the_restore_command_takes_the_copys_identity_only_when_told() {
    let a = admin().await;
    let (copy_path, _, source) = copy_with_identity(&a.app).await;
    let key_text = identity_key_text(&copy_path);
    let b = admin().await;
    let paths = stop(&b.app).await;
    let own = write_identity(b.app.dir(), &b.app.state.host_id);
    let own_key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, own.key_der());

    let (code, out, err) = restore_cli(&copy_path, &paths.data_dir, &[]);
    assert_ne!(code, Some(0), "{out}");
    assert!(err.contains("--take-identity"), "{err}");
    assert!(HostIdentity::read(&paths).unwrap().same_as(&own));

    let (code, out, err) = restore_cli(&copy_path, &paths.data_dir, &["--take-identity"]);
    assert_eq!(code, Some(0), "{err}");
    assert!(
        out.contains(&format!(
            "the copy's host identity was put in place (host {}",
            a.app.state.host_id
        )),
        "{out}"
    );
    assert!(HostIdentity::read(&paths).unwrap().same_as(&source));
    for text in [&out, &err] {
        assert!(!text.contains(&key_text[..24]) && !text.contains(&own_key[..24]));
    }
}

/// `license_clock` as stored: `(max_seen_at, trial_started_at, trial_inn,
/// emergency_used_for, emergency_until, wrong_host_since)`.
type LicenseClockColumns = (
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
);

async fn license_clock(pool: &SqlitePool) -> LicenseClockColumns {
    sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until, \
         wrong_host_since FROM license_clock WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn restore_details(pool: &SqlitePool) -> Value {
    let details: String =
        sqlx::query_scalar("SELECT details FROM audit_log WHERE action = 'host.restore'")
            .fetch_one(pool)
            .await
            .unwrap();
    serde_json::from_str(&details).unwrap()
}

/// A license loaded after the copy (plan ЛЦ-2, spec §4.4) is carried into
/// the restored database with the license clock: the later mark, the trial
/// as it was. The summary and the audit row count it.
#[tokio::test]
async fn a_license_loaded_after_the_copy_is_carried_over_with_the_clock() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    admin.app.clock.advance(time::Duration::days(3));
    support::license::refresh(&admin.app).await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(1));
    assert!(summary(&report)
        .contains(&"license files carried over from the previous database: 1".to_owned()));
    let pool = reopen(&paths).await;
    let file: (String, i64, Option<String>) =
        sqlx::query_as("SELECT license_id, sequence, loaded_by FROM licenses")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        file,
        (support::license::license_id(1), 1, Some(admin.id.clone()))
    );
    assert_eq!(
        license_clock(&pool).await,
        (
            Some(support::license::START_MS + 3 * support::license::DAY_MS),
            Some(support::license::START_MS),
            Some(support::license::INN.to_owned()),
            None,
            None,
            None
        )
    );
    assert_eq!(restore_details(&pool).await["licensesCarried"], 1);
}

/// What the restored database holds decides the state when the host starts
/// (spec §4.6, §4.9): another organization's INN is `inn_mismatch`, and the
/// same files under another host identity are `wrong_host`.
#[tokio::test]
async fn a_restored_database_is_judged_by_its_own_inn_and_this_hosts_identity() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    support::license::set_org_inn(&admin, json!(support::license::OTHER_INN)).await;
    let (copy_path, _) = copy(&admin.app).await;
    support::license::set_org_inn(&admin, json!(support::license::INN)).await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    // The file was in the copy: nothing to carry.
    assert_eq!(report.licenses_carried, Some(0));
    let pool = reopen(&paths).await;
    let clock = Arc::new(ManualClock::new(
        time::OffsetDateTime::from_unix_timestamp(support::app::START).unwrap(),
    ));
    let mut conn = pool.acquire().await.unwrap();
    let state = AppState::new(pool.clone(), host, clock.clone());
    let snapshot = state.license.snapshot(&state, &mut conn).await.unwrap();
    assert_eq!(snapshot.evaluation.phase, Phase::InnMismatch);
    let other = AppState::new(
        pool.clone(),
        "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f".to_owned(),
        clock,
    );
    let snapshot = other.license.snapshot(&other, &mut conn).await.unwrap();
    assert_eq!(snapshot.evaluation.phase, Phase::WrongHost);
}

/// An emergency extension the current database took after the copy stays
/// taken (plan ЛЦ-2 Д12): a restore never gives a spent extension back.
#[tokio::test]
async fn an_emergency_taken_after_the_copy_stays_taken() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::expired_file(&host)).await;
    let (copy_path, _) = copy(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(0));
    let pool = reopen(&paths).await;
    let (_, _, _, used_for, until, _) = license_clock(&pool).await;
    assert_eq!(
        (used_for, until),
        (
            Some(support::license::license_id(1)),
            Some(support::license::START_MS + 72 * 3_600_000)
        )
    );
    let clock = Arc::new(ManualClock::new(
        time::OffsetDateTime::from_unix_timestamp(support::app::START).unwrap(),
    ));
    let state = AppState::new(pool.clone(), host, clock);
    let mut conn = pool.acquire().await.unwrap();
    let snapshot = state.license.snapshot(&state, &mut conn).await.unwrap();
    assert!(
        snapshot.evaluation.emergency_used && !snapshot.evaluation.emergency_available,
        "{:?}",
        snapshot.evaluation
    );
}

/// A copy made before the build with the license holds no trial: the
/// current database's start comes with its INN, or the next start of the
/// host would begin a fresh trial (plan ЛЦ-2 Д12).
#[tokio::test]
async fn a_copy_without_a_trial_gets_the_current_trial_and_its_inn() {
    let admin = admin().await;
    let pool = admin.app.state.pool.clone();
    sqlx::query(
        "UPDATE license_clock SET max_seen_at = NULL, trial_started_at = NULL, trial_inn = NULL",
    )
    .execute(&pool)
    .await
    .unwrap();
    let (copy_path, _) = copy(&admin.app).await;
    let started = support::license::START_MS - 5 * support::license::DAY_MS;
    sqlx::query("UPDATE license_clock SET trial_started_at = ?, trial_inn = ?")
        .bind(started)
        .bind(support::license::OTHER_INN)
        .execute(&pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(0));
    let pool = reopen(&paths).await;
    let (_, trial_started_at, trial_inn, _, _, _) = license_clock(&pool).await;
    assert_eq!(
        (trial_started_at, trial_inn),
        (Some(started), Some(support::license::OTHER_INN.to_owned()))
    );
}

/// The current database of another host says nothing of the copy's license
/// (plan ЛЦ-2 Д12, like the revocations): its files and its clock stay out.
#[tokio::test]
async fn another_hosts_license_is_not_carried() {
    let a = admin().await;
    let (copy_path, _) = copy(&a.app).await;
    let copied = license_clock(&a.app.state.pool).await;
    let b = admin().await;
    let host = b.app.state.host_id.clone();
    support::license::load_ok(&b, &support::license::file(&host, |_| {})).await;
    sqlx::query(
        "UPDATE license_clock SET max_seen_at = ?1 + 9 * 86400000, \
         trial_started_at = ?1 - 9 * 86400000, trial_inn = ?2, \
         emergency_used_for = 'trial', emergency_until = ?1, wrong_host_since = ?1",
    )
    .bind(support::license::START_MS)
    .bind(support::license::OTHER_INN)
    .execute(&b.app.state.pool)
    .await
    .unwrap();
    let paths = stop(&b.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert!(!report.history_known);
    assert_eq!(report.licenses_carried, None);
    let pool = reopen(&paths).await;
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(files, 0);
    assert_eq!(license_clock(&pool).await, copied);
    assert_eq!(restore_details(&pool).await["licensesCarried"], Value::Null);
}

/// The summary's line when the license files of the current database could
/// not be read although the database itself was (final review of plan ЛЦ-2).
fn license_unread_line(report: &RestoreReport) -> String {
    format!(
        "the previous database's license files could not be read: license files loaded after {} are not in the restored database: load the newest license file again in the office (Информация → Лицензия)",
        report.copy_made
    )
}

/// A current database whose license cannot be read (a value edited by hand:
/// text in an INTEGER column of `license_clock`) still counts with its
/// numbers and its revocations: only its license files and its license
/// clock stay out, and the summary says so (final review of plan ЛЦ-2).
#[tokio::test]
async fn a_license_the_current_database_cannot_read_leaves_its_revocations_and_numbers() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let (copy_path, _) = copy(&admin.app).await;
    let copied = license_clock(&admin.app.state.pool).await;
    let host = admin.app.state.host_id.clone();
    // After the copy: a block, a revoked station, a license file, and a
    // license clock edited by hand.
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let (status, body) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{station}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    sqlx::query("UPDATE license_clock SET max_seen_at = 'x'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Read);
    assert!(report.history_known, "the database was read");
    assert_eq!(
        (report.carried, report.licenses_carried),
        (
            Some(Carried {
                devices: 1,
                operators: 0,
                badges: 0,
                office_users: 0
            }),
            None
        )
    );
    let pool = reopen(&paths).await;
    // The current database issued to 3499: two blocks above it, not the
    // margins of an unread database.
    assert_eq!(
        counters(&pool).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
    let revoked: Option<String> = sqlx::query_scalar("SELECT revoked_at FROM devices WHERE id = ?")
        .bind(&station)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(revoked.is_some(), "the revocation is carried");
    let files: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(files, 0, "no license file is carried");
    assert_eq!(license_clock(&pool).await, copied, "nor the license clock");
    let details = restore_details(&pool).await;
    assert_eq!(
        (
            details["carried"]["devices"].clone(),
            details["licensesCarried"].clone()
        ),
        (json!(1), Value::Null)
    );
    let lines = summary(&report);
    assert!(lines.contains(&license_unread_line(&report)), "{lines:#?}");
    assert!(
        lines.contains(&"revocations carried over from the previous database: 1 devices, 0 operators, 0 badges, 0 office users".to_owned()),
        "{lines:#?}"
    );
}

/// A database an earlier restore set aside counts with its numbers even when
/// its license does not read: only the numbers are read there.
#[tokio::test]
async fn a_database_set_aside_counts_even_when_its_license_does_not_read() {
    let admin = admin().await;
    let (copy_path, _) = copy(&admin.app).await;
    // 1500..3499.
    ask_block(&admin, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    sqlx::query("UPDATE license_clock SET max_seen_at = 'x'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let paths = stop(&admin.app).await;
    let aside = paths.data_dir.join("restore-20261001T000000Z");
    std::fs::create_dir(&aside).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("host.db{suffix}");
        if paths.data_dir.join(&name).exists() {
            std::fs::rename(paths.data_dir.join(&name), aside.join(&name)).unwrap();
        }
    }
    std::fs::copy(&copy_path, paths.database_file()).unwrap();

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.current, Current::Read);
    // The aside database issued to 3499: two blocks above 3500, not two
    // above the copy's 1500.
    assert_eq!(
        counters(&reopen(&paths).await).await,
        [(PREFIX.to_owned(), 0, 7500), (PREFIX.to_owned(), 1, 440)]
    );
}

/// A renewal loaded after the copy (plan ЛЦ-2 spec §4.4): the copy holds file
/// 1, the current database files 1 and 2. File 2 is carried, both rows are
/// there, and file 2 is in force.
#[tokio::test]
async fn a_renewal_loaded_after_the_copy_is_carried_and_in_force() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    let (copy_path, _) = copy(&admin.app).await;
    support::license::load_ok(
        &admin,
        &support::license::file(&host, |terms| {
            terms["licenseId"] = json!(support::license::license_id(2));
            terms["sequence"] = json!(2);
            terms["quotas"]["stations"] = json!(5);
            terms["replaces"] = json!(support::license::license_id(1));
        }),
    )
    .await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(1));
    assert!(summary(&report)
        .contains(&"license files carried over from the previous database: 1".to_owned()));
    let pool = reopen(&paths).await;
    let files: Vec<(String, i64)> =
        sqlx::query_as("SELECT license_id, sequence FROM licenses ORDER BY sequence")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        files,
        [
            (support::license::license_id(1), 1),
            (support::license::license_id(2), 2)
        ]
    );
    assert_eq!(restore_details(&pool).await["licensesCarried"], 1);
    let clock = Arc::new(ManualClock::new(
        time::OffsetDateTime::from_unix_timestamp(support::app::START).unwrap(),
    ));
    let state = AppState::new(pool.clone(), host, clock);
    let mut conn = pool.acquire().await.unwrap();
    let snapshot = state.license.snapshot(&state, &mut conn).await.unwrap();
    assert_eq!(snapshot.evaluation.phase, Phase::Active);
    let in_force = snapshot.evaluation.license.expect("a file in force");
    assert_eq!(
        (in_force.license_id, in_force.sequence),
        (support::license::license_id(2), 2)
    );
    assert_eq!(snapshot.evaluation.quotas.stations, Some(5));
}

/// A copy before an upgrade (plan ОБН-1) is restored like any copy (spec
/// §4.4, Д12 of plan ЛЦ-2): the license loaded after it is carried with the
/// clock, and the summary and the audit row count it.
#[tokio::test]
async fn a_copy_before_an_upgrade_carries_the_license_loaded_after_it() {
    let admin = admin().await;
    let folder = admin.app.dir().join("backups");
    std::fs::create_dir_all(&folder).unwrap();
    let tag = markiro_host::upgrade::Pending {
        from: 30,
        to: 31,
        migrations: 1,
    }
    .tag();
    let mut conn = worker_conn(&admin.app).await;
    let manifest = make_copy_tagged(
        &mut conn,
        &folder,
        admin.app.state.now(),
        BackupTrigger::Scheduled,
        &admin.app.state.host_id,
        &tag,
    )
    .await
    .unwrap();
    conn.close().await.unwrap();
    assert!(markiro_host::upgrade::is_pre_upgrade(&manifest.file));
    let copy_path = folder.join(&manifest.file);
    let host = admin.app.state.host_id.clone();
    support::license::load_ok(&admin, &support::license::file(&host, |_| {})).await;
    let paths = stop(&admin.app).await;

    let report = restore(&paths, &copy_path, false, at(NOW)).await.unwrap();

    assert_eq!(report.licenses_carried, Some(1));
    assert!(summary(&report)
        .contains(&"license files carried over from the previous database: 1".to_owned()));
    let pool = reopen(&paths).await;
    let files: Vec<(String, i64)> = sqlx::query_as("SELECT license_id, sequence FROM licenses")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(files, [(support::license::license_id(1), 1)]);
    assert_eq!(restore_details(&pool).await["licensesCarried"], 1);
}
