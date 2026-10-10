//! `markiro-host restore` (plan РК): the copy back in place, every SSCC
//! counter and shift number above both databases, a new restore epoch, one
//! audit row; and every refusal leaves the data folder as it was.

mod support;

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use markiro_host::backup::copy::{make_copy, manifest_path, sha256_file, Manifest};
use markiro_host::config::HostPaths;
use markiro_host::restore::{
    restore, restore_crashing, summary, verify_copy, Carried, CrashPoint, Current, Interrupted,
    SHIFT_NUMBER_MARGIN, UNREADABLE_CURRENT_MARGIN,
};
use markiro_host::StartOptions;
use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use sqlx::{ConnectOptions, Connection, SqlitePool};
use support::app::{
    add_operator, admin, json as json_request, login, pair_device, plan_shift, request,
    seed_office_user, shift_body, shift_setup, with_device, Admin, TestApp,
};
use support::backup::{at, latest_migration, names, worker_conn};

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

/// Stop using the app's database as a service that stopped cleanly has:
/// every connection closed and the WAL folded into the file (a WAL left
/// behind is `the_commits_a_crashed_host_left_in_its_wal_count_too`). A
/// pool's `close` can return while a connection is still on its way out,
/// so one more connection folds the WAL in and closes, until no WAL is
/// left. The data folder gets what a host's has: `host.json`, the folders
/// and the lock file, released.
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
            if !wal.exists() {
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

fn restore_dirs(dir: &Path) -> Vec<String> {
    names(dir)
        .into_iter()
        .filter(|name| name.starts_with("restore-"))
        .collect()
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
            "sessionsEnded": 1,
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
        std::fs::copy(admin.app.dir().join(&name), crashed.path().join(&name)).unwrap();
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
    assert_eq!((report.carried, report.sessions_ended), (None, 1));
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
        std::fs::copy(paths.data_dir.join(&name), sources.path().join(&name)).unwrap();
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
        std::fs::copy(admin.app.dir().join(&name), crashed.path().join(&name)).unwrap();
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
