//! The copy of the master database before this build's pending migrations
//! (plan ОБН-1, spec §10.6): `upgrade::pending` reads what a database lacks,
//! and a copy before an upgrade is known by its name. No socket: runs in the
//! sandbox.

mod support;

use std::borrow::Cow;

use markiro_host::backup::copy::{copy_name, is_copy_file_name};
use markiro_host::db::MIGRATOR;
use markiro_host::upgrade::{self, Pending};
use sqlx::migrate::Migrator;
use sqlx::{Connection, SqliteConnection};
use support::backup::at;

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
}
