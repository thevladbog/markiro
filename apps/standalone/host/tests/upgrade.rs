//! The copy of the master database before this build's pending migrations
//! (plan ОБН-1, spec §10.6): `upgrade::pending` reads what a database lacks,
//! and a copy before an upgrade is known by its name. No socket: runs in the
//! sandbox.

mod support;

use std::borrow::Cow;

use std::sync::Arc;

use markiro_host::backup::copy::{copy_name, is_copy_file_name, read_manifest, verify_database};
use markiro_host::backup::identity::OwnerOnly;
use markiro_host::config::HostPaths;
use markiro_host::db::{self, MIGRATOR};
use markiro_host::upgrade::{self, OpenError, Pending, PreUpgrade};
use markiro_proto::backup::BackupTrigger;
use serde_json::json;
use sqlx::migrate::Migrator;
use sqlx::{ConnectOptions, Connection, SqliteConnection, SqlitePool};
use support::app::{audit_trail_in, AuditRow};
use support::backup::{at, database_without, names, write_identity};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";

const AT: &str = "2026-10-13T09:00:00Z";
/// The migration this plan adds: the databases below lack it.
const ADDED: i64 = 31;

fn without(version: i64) -> Migrator {
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version != version)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
}

/// The newest migration of a database without `ADDED`, and of this build.
fn versions() -> (i64, i64) {
    let all = || MIGRATOR.iter().map(|migration| migration.version);
    (
        all().filter(|version| *version != ADDED).max().unwrap(),
        all().max().unwrap(),
    )
}

async fn memory() -> SqliteConnection {
    SqliteConnection::connect("sqlite::memory:").await.unwrap()
}

#[tokio::test]
async fn pending_names_what_a_database_lacks_and_nothing_for_a_new_or_a_foreign_one() {
    assert!(MIGRATOR.iter().any(|migration| migration.version == ADDED));
    let (from, to) = versions();
    // A new file: no migrations table.
    let mut fresh = memory().await;
    assert_eq!(upgrade::pending(&mut fresh, &MIGRATOR).await.unwrap(), None);
    // The table without a row: a first start that stopped before its first
    // migration has nothing to protect.
    Migrator {
        migrations: Cow::Owned(vec![]),
        ..Migrator::DEFAULT
    }
    .run(&mut fresh)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut fresh, &MIGRATOR).await.unwrap(), None);

    let mut old = memory().await;
    without(ADDED).run(&mut old).await.unwrap();
    assert_eq!(
        upgrade::pending(&mut old, &MIGRATOR).await.unwrap(),
        Some(Pending {
            from,
            to,
            migrations: 1
        })
    );
    // A lower migration that arrives late is pending too: sqlx applies it.
    let mut gap = memory().await;
    without(11).run(&mut gap).await.unwrap();
    assert_eq!(
        upgrade::pending(&mut gap, &MIGRATOR).await.unwrap(),
        Some(Pending {
            from: to,
            to,
            migrations: 1
        })
    );
    // Up to date: nothing.
    MIGRATOR.run(&mut old).await.unwrap();
    assert_eq!(upgrade::pending(&mut old, &MIGRATOR).await.unwrap(), None);
    // A migration this build does not know: sqlx refuses the database as
    // before, and there is nothing to copy for.
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'newer', 1, x'00', 0)",
    )
    .execute(&mut old)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut old, &MIGRATOR).await.unwrap(), None);
    // The same with a migration of this build still missing: a newer
    // build's database is refused by sqlx, not copied as an upgrade.
    let mut foreign = memory().await;
    without(ADDED).run(&mut foreign).await.unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (9999, 'newer', 1, x'00', 0)",
    )
    .execute(&mut foreign)
    .await
    .unwrap();
    assert_eq!(
        upgrade::pending(&mut foreign, &MIGRATOR).await.unwrap(),
        None
    );
    // A migration recorded as failed: sqlx refuses it as dirty.
    let mut dirty = memory().await;
    without(ADDED).run(&mut dirty).await.unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?, 'device versions', 0, x'00', 0)",
    )
    .bind(ADDED)
    .execute(&mut dirty)
    .await
    .unwrap();
    assert_eq!(upgrade::pending(&mut dirty, &MIGRATOR).await.unwrap(), None);
}

#[test]
fn a_copy_before_an_upgrade_is_known_by_its_name() {
    let pending = Pending {
        from: 16,
        to: 31,
        migrations: 2,
    };
    assert_eq!(pending.tag(), "pre-upgrade-16-31");
    let name = copy_name(at(AT), &pending.tag());
    assert_eq!(name, "markiro-host-20261013T090000Z-pre-upgrade-16-31.db");
    // Every build since plan РК takes it as a copy's name: the rollback's
    // `restore` of the previous version reads it.
    assert!(is_copy_file_name(&name));
    assert!(upgrade::is_pre_upgrade(&name));
    assert!(!upgrade::is_pre_upgrade(&copy_name(at(AT), "1a2b3c4d")));
    assert!(!upgrade::is_pre_upgrade(
        "markiro-host-pre-upgrade-16-31.db"
    ));
    assert!(!upgrade::is_pre_upgrade(
        "other-20261013T090000Z-pre-upgrade-16-31.db"
    ));
    // The time must be a copy's UTC time, followed by `-`.
    assert!(!upgrade::is_pre_upgrade(
        "markiro-host-20261013T090000Zxpre-upgrade-16-31.db"
    ));
    assert!(!upgrade::is_pre_upgrade(
        "markiro-host-abcdefghijklmnop-pre-upgrade-16-31.db"
    ));
}

/// A data folder whose `host.db` has every migration but `ADDED`, one line,
/// and the host identity of a host that ran there.
async fn old_host(dir: &std::path::Path) -> HostPaths {
    write_identity(dir, HOST_ID);
    database_without(dir, ADDED).await;
    let paths = HostPaths::new(dir);
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query(
        "INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, 'Линия 1', 'линия 1', 0, 1)",
    )
    .bind(LINE)
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    paths
}

fn pre(paths: &HostPaths, when: &str) -> PreUpgrade {
    PreUpgrade {
        data_dir: paths.data_dir.clone(),
        backups_dir: paths.backups_dir(),
        host_id: HOST_ID.to_owned(),
        guard: Arc::new(OwnerOnly),
        at: at(when),
    }
}

/// The applied migrations of the folder's database, read without migrating.
async fn applied(paths: &HostPaths) -> Vec<i64> {
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    let versions = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
    )
    .fetch_all(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    versions
}

/// A pool on the folder's database without migrations: what a test reads
/// the audit from after a start that gave no pool.
async fn raw_pool(paths: &HostPaths) -> SqlitePool {
    SqlitePool::connect_with(db::options(&paths.database_file()))
        .await
        .unwrap()
}

fn upgrade_row(file: Option<&str>, result: &str, details: serde_json::Value) -> AuditRow {
    (
        "system".to_owned(),
        None,
        "host.upgrade".to_owned(),
        Some("backup".to_owned()),
        file.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

/// A database of the previous build is copied before its migrations: a
/// verified copy with the host identity in the local folder, named for the
/// migrations, holding the data as it was; then every migration runs, and
/// one `host.upgrade` row says so. The next start has nothing pending.
#[tokio::test]
async fn a_database_with_pending_migrations_is_copied_before_they_run() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();

    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .unwrap();

    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));
    let stem = file.trim_end_matches(".db");
    assert_eq!(
        names(&paths.backups_dir()),
        [
            file.clone(),
            format!("{stem}.identity"),
            format!("{stem}.json")
        ]
    );
    let copy = paths.backups_dir().join(&file);
    let manifest = read_manifest(&copy).unwrap();
    assert_eq!(
        (
            manifest.trigger,
            manifest.host_id.as_str(),
            manifest.schema_version
        ),
        (BackupTrigger::Scheduled, HOST_ID, from)
    );
    assert!(
        manifest.identity.is_some(),
        "the copy carries the host identity (plan I1)"
    );
    assert_eq!(verify_database(&copy).await, Ok(from));
    let mut read = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&copy)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .unwrap();
    let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lines WHERE id = ?")
        .bind(LINE)
        .fetch_one(&mut read)
        .await
        .unwrap();
    assert_eq!(lines, 1);
    read.close().await.unwrap();
    let all: Vec<i64> = MIGRATOR.iter().map(|migration| migration.version).collect();
    let now: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(now, all);
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![upgrade_row(
            Some(&file),
            "ok",
            json!({
                "from": from, "to": to, "migrations": 1, "file": file, "reused": false,
                "code": null, "appVersion": env!("CARGO_PKG_VERSION"),
            }),
        )]
    );
    pool.close().await;

    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T10:00:00Z"))
        .await
        .unwrap();
    assert_eq!(
        names(&paths.backups_dir()).len(),
        3,
        "nothing pending: no copy"
    );
    assert_eq!(audit_trail_in(&pool, "host.upgrade").await.len(), 1);
    pool.close().await;
}

/// A new database (the installer's first start) has nothing to protect: no
/// copy, no row.
#[tokio::test]
async fn a_new_database_takes_its_migrations_without_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .unwrap();
    assert!(names(&paths.backups_dir()).is_empty());
    assert!(audit_trail_in(&pool, "host.upgrade").await.is_empty());
    pool.close().await;
}

/// A copy that fails runs no migration and says why: the database stays at
/// the previous build's schema, a file already there is never replaced, and
/// the `failed` row is written once while the same failure repeats.
#[tokio::test]
async fn a_copy_that_fails_runs_no_migration_and_says_so_once() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));
    std::fs::write(paths.backups_dir().join(&file), b"not ours").unwrap();

    for _ in 0..2 {
        match db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await {
            Err(error @ OpenError::Copy { .. }) => {
                assert!(error.to_string().contains("no migration ran"), "{error}");
                let OpenError::Copy { pending, failure } = error else {
                    unreachable!()
                };
                assert_eq!(
                    pending,
                    Pending {
                        from,
                        to,
                        migrations: 1
                    }
                );
                assert_eq!(failure.code, "write_failed");
            }
            other => panic!("{other:?}"),
        }
        let versions = applied(&paths).await;
        assert_eq!(versions.last(), Some(&from));
        assert!(!versions.contains(&ADDED), "{versions:?}");
    }
    assert_eq!(
        std::fs::read(paths.backups_dir().join(&file)).unwrap(),
        b"not ours"
    );
    let pool = raw_pool(&paths).await;
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![upgrade_row(
            None,
            "failed",
            json!({
                "from": from, "to": to, "migrations": 1, "file": null, "reused": false,
                "code": "write_failed", "appVersion": env!("CARGO_PKG_VERSION"),
            }),
        )]
    );
    pool.close().await;
}

/// A migration that fails after a good copy says which copy protects it; the
/// service's next starts (Windows retries every 60 s) use that copy again
/// rather than making another, and the start that succeeds names it too.
#[tokio::test]
async fn a_migration_that_fails_keeps_its_copy_and_the_next_start_uses_it_again() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    // `0031` adds a column the database already has: its ALTER fails.
    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query("ALTER TABLE devices ADD COLUMN version_seen_at TEXT")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));

    for _ in 0..2 {
        // The second try with the same time would meet the first copy's name
        // and fail as `write_failed` if it copied again.
        let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
        assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    }
    assert_eq!(
        names(&paths.backups_dir()).len(),
        3,
        "one copy for both tries"
    );

    let mut conn = db::options(&paths.database_file()).connect().await.unwrap();
    sqlx::query("ALTER TABLE devices DROP COLUMN version_seen_at")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:05:00Z"))
        .await
        .unwrap();
    assert_eq!(names(&paths.backups_dir()).len(), 3);
    let common = |reused: bool, code: Option<&str>| {
        json!({
            "from": from, "to": to, "migrations": 1, "file": file, "reused": reused,
            "code": code, "appVersion": env!("CARGO_PKG_VERSION"),
        })
    };
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![
            upgrade_row(
                Some(&file),
                "failed",
                common(false, Some("migration_failed"))
            ),
            upgrade_row(Some(&file), "ok", common(true, None)),
        ]
    );
    pool.close().await;
}

/// `crate::start` over a database of the previous build whose copy cannot be
/// written (the folder of copies is closed to the host) does not start and
/// runs no migration (spec §10.6: `install` then answers 4). It fails before
/// binding any socket.
#[cfg(unix)]
#[tokio::test]
async fn a_host_whose_copy_fails_does_not_start_and_runs_no_migration() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, _) = versions();
    let backups = paths.backups_dir();
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o500)).unwrap();
    let started = markiro_host::start(
        &paths,
        markiro_host::StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await;
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o700)).unwrap();
    let error = match started {
        Ok(_) => panic!("the host started over a database it could not copy"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("no migration ran"), "{error}");
    assert!(error.contains("access_denied"), "{error}");
    let versions = applied(&paths).await;
    assert_eq!(versions.last(), Some(&from));
    assert!(!versions.contains(&ADDED), "{versions:?}");
    assert!(names(&backups).is_empty(), "nothing of the copy stays");
}

/// Opens the folder's database for a test's own writes, without migrating.
async fn raw_conn(paths: &HostPaths) -> SqliteConnection {
    db::options(&paths.database_file()).connect().await.unwrap()
}

/// `0031` made to fail: the database already has its column.
async fn break_added(paths: &HostPaths) {
    let mut conn = raw_conn(paths).await;
    sqlx::query("ALTER TABLE devices ADD COLUMN version_seen_at TEXT")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
}

async fn mend_added(paths: &HostPaths) {
    let mut conn = raw_conn(paths).await;
    sqlx::query("ALTER TABLE devices DROP COLUMN version_seen_at")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
}

/// Two migrations pending, the first commits and the second fails: the next
/// start still takes the copy made before both (the database changed only by
/// this build's own migrations), and the row of the start that succeeds
/// describes that copy — the migrations it protects, from its own `from`.
#[tokio::test]
async fn a_partial_upgrade_keeps_the_copy_made_before_all_its_migrations() {
    let dir = tempfile::tempdir().unwrap();
    let (_, to) = versions();
    let second = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| *version < ADDED)
        .max()
        .unwrap();
    let without_both: Vec<i64> = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .filter(|version| *version != ADDED && *version != second)
        .collect();
    let from = *without_both.iter().max().unwrap();
    // A database of a build that lacked both `second` and `ADDED`.
    write_identity(dir.path(), HOST_ID);
    let paths = HostPaths::new(dir.path());
    let mut conn = db::options(&paths.database_file())
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| without_both.contains(&migration.version))
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
    .run(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    break_added(&paths).await;
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));

    let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    // `second` committed before `ADDED` failed.
    assert!(applied(&paths).await.contains(&second));
    let opened =
        db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:01:00Z")).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    assert_eq!(
        names(&paths.backups_dir()).len(),
        3,
        "one copy for both tries"
    );

    mend_added(&paths).await;
    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:02:00Z"))
        .await
        .unwrap();
    let common = |reused: bool, code: Option<&str>| {
        json!({
            "from": from, "to": to, "migrations": 2, "file": file, "reused": reused,
            "code": code, "appVersion": env!("CARGO_PKG_VERSION"),
        })
    };
    assert_eq!(
        audit_trail_in(&pool, "host.upgrade").await,
        vec![
            upgrade_row(
                Some(&file),
                "failed",
                common(false, Some("migration_failed"))
            ),
            upgrade_row(Some(&file), "ok", common(true, None)),
        ]
    );
    pool.close().await;
}

/// The earlier copy is used again only while the failed `host.upgrade` row
/// is the newest of the log (nothing wrote since) and the copy is still
/// whole: a row written after it, or a copy without its manifest, takes a
/// new copy.
#[tokio::test]
async fn the_earlier_copy_is_not_used_again_after_a_write_or_without_its_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    break_added(&paths).await;
    let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    let first = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));

    // A row after the failed one: something wrote in between.
    let mut conn = raw_conn(&paths).await;
    sqlx::query(
        "INSERT INTO audit_log (at, actor_kind, action, result, details) \
         VALUES ('2026-10-13T09:00:30Z', 'system', 'backup.create', 'ok', '{}')",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    let opened =
        db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:01:00Z")).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    let second = copy_name(
        at("2026-10-13T09:01:00Z"),
        &format!("pre-upgrade-{from}-{to}"),
    );
    assert!(paths.backups_dir().join(&second).exists());

    // The newest copy loses its manifest: the next start makes another.
    std::fs::remove_file(paths.backups_dir().join(second.replace(".db", ".json"))).unwrap();
    let opened =
        db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:02:00Z")).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    let third = copy_name(
        at("2026-10-13T09:02:00Z"),
        &format!("pre-upgrade-{from}-{to}"),
    );
    assert!(paths.backups_dir().join(&third).exists());
    assert!(paths.backups_dir().join(&first).exists());

    // A failed row towards another newest migration (another build's) is no
    // proof for this one.
    let mut conn = raw_conn(&paths).await;
    sqlx::query(
        "UPDATE audit_log SET details = json_set(details, '$.to', 9999) \
         WHERE id = (SELECT max(id) FROM audit_log)",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    let opened =
        db::open_upgrading(&paths.database_file(), &pre(&paths, "2026-10-13T09:03:00Z")).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    let fourth = copy_name(
        at("2026-10-13T09:03:00Z"),
        &format!("pre-upgrade-{from}-{to}"),
    );
    assert!(paths.backups_dir().join(&fourth).exists());
}

/// Two different failures of the copy are two rows.
#[cfg(unix)]
#[tokio::test]
async fn a_different_copy_failure_is_written_again() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, to) = versions();
    let file = copy_name(at(AT), &format!("pre-upgrade-{from}-{to}"));
    let backups = paths.backups_dir();
    std::fs::write(backups.join(&file), b"not ours").unwrap();
    assert!(db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .is_err());
    std::fs::remove_file(backups.join(&file)).unwrap();
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o500)).unwrap();
    let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
    std::fs::set_permissions(&backups, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(opened, Err(OpenError::Copy { .. })), "{opened:?}");
    let pool = raw_pool(&paths).await;
    let codes: Vec<serde_json::Value> = audit_trail_in(&pool, "host.upgrade")
        .await
        .into_iter()
        .map(|row| row.6["code"].clone())
        .collect();
    assert_eq!(codes, [json!("write_failed"), json!("access_denied")]);
    pool.close().await;
}

/// A database of the very first migration (no audit log yet) is copied too,
/// and a data folder whose identity names another host gives a copy without
/// it rather than none.
#[tokio::test]
async fn a_database_without_an_audit_log_and_a_foreign_identity_still_get_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    write_identity(dir.path(), "0e0e0e0e-0000-4000-8000-000000000000");
    let paths = HostPaths::new(dir.path());
    let mut conn = db::options(&paths.database_file())
        .create_if_missing(true)
        .connect()
        .await
        .unwrap();
    let first = MIGRATOR
        .iter()
        .map(|migration| migration.version)
        .min()
        .unwrap();
    Migrator {
        migrations: MIGRATOR
            .iter()
            .filter(|migration| migration.version == first)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    }
    .run(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();

    let pool = db::open_upgrading(&paths.database_file(), &pre(&paths, AT))
        .await
        .unwrap();
    let copies: Vec<String> = names(&paths.backups_dir())
        .into_iter()
        .filter(|name| name.ends_with(".db"))
        .collect();
    assert_eq!(copies.len(), 1, "{copies:?}");
    let manifest = read_manifest(&paths.backups_dir().join(&copies[0])).unwrap();
    assert_eq!(manifest.schema_version, first);
    assert!(
        manifest.identity.is_none(),
        "another host's identity stays out"
    );
    assert_eq!(audit_trail_in(&pool, "host.upgrade").await.len(), 1);
    pool.close().await;
}

/// A migrations table whose rows the copy's question cannot read runs no
/// migration: sqlx itself would read past such a row and migrate a database
/// nobody copied.
#[tokio::test]
async fn a_migrations_table_the_copy_cannot_read_runs_no_migration() {
    let dir = tempfile::tempdir().unwrap();
    let paths = old_host(dir.path()).await;
    let (from, _) = versions();
    let mut conn = raw_conn(&paths).await;
    sqlx::query("UPDATE _sqlx_migrations SET success = 'yes' WHERE version = 1")
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    let opened = db::open_upgrading(&paths.database_file(), &pre(&paths, AT)).await;
    assert!(matches!(opened, Err(OpenError::Database(_))), "{opened:?}");
    let mut conn = raw_conn(&paths).await;
    let newest: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    assert_eq!(newest, from);
    assert!(names(&paths.backups_dir()).is_empty());
}

/// The message of a failed copy gives the advice its code calls for.
#[test]
fn a_failed_copy_says_what_to_do_for_its_code() {
    use markiro_host::backup::copy::Failure;

    let pending = Pending {
        from: 16,
        to: 31,
        migrations: 1,
    };
    let full = OpenError::Copy {
        pending,
        failure: Failure::new("disk_full", "no space"),
    }
    .to_string();
    assert!(full.contains("free space"), "{full}");
    let broken = OpenError::Copy {
        pending,
        failure: Failure::new("verify_failed", "malformed"),
    }
    .to_string();
    assert!(broken.contains("no migration ran"), "{broken}");
    assert!(!broken.contains("free space"), "{broken}");
    assert!(broken.contains("support"), "{broken}");
}
