//! The copy of the master database before this build's pending migrations
//! (plan ОБН-1, spec §10.6). `db::open_upgrading` opens the database without
//! migrating it, asks [`pending`] whether this build brings migrations the
//! database lacks and, when it does, makes a verified copy through the
//! backups' own code (`backup::copy`, plan РК: `VACUUM INTO`,
//! `integrity_check`, the manifest, the host identity of plan I1) into the
//! local folder of copies before a single migration runs. Its name carries
//! the tag `pre-upgrade-<from>-<to>` (migration numbers); the retention keeps
//! it for [`KEEP_DAYS`] days whatever its other rules say.
//!
//! The manifest of such a copy says `trigger: "scheduled"`: a new trigger
//! would make it unreadable to the build an administrator rolls back to
//! (`read_manifest` refuses an unknown variant, so that build's `restore`
//! would refuse the very copy the rollback needs), and the strict
//! `backupTriggerSchema` of an older office would fail its whole page of
//! copies. The name is the mark ([`is_pre_upgrade`]).

use sqlx::migrate::Migrator;
use sqlx::SqliteConnection;

use crate::backup::copy::COPY_PREFIX;

/// The tag of a copy made before pending migrations: `pre-upgrade-<from>-<to>`.
pub const TAG_PREFIX: &str = "pre-upgrade-";
/// How many days such a copy stays at least (spec §10.6).
pub const KEEP_DAYS: i64 = 14;

/// Migrations of this build that a database lacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pending {
    /// The newest migration the database has.
    pub from: i64,
    /// The newest migration of this build.
    pub to: i64,
    /// How many of this build's migrations the database lacks (a lower one
    /// that arrives late counts: sqlx applies it).
    pub migrations: usize,
}

impl Pending {
    /// `pre-upgrade-<from>-<to>`: the tag in the copy's name.
    pub fn tag(&self) -> String {
        format!("{TAG_PREFIX}{}-{}", self.from, self.to)
    }
}

/// Whether `file` is the name of a copy made before pending migrations:
/// `markiro-host-<UTC time, 16 characters>-pre-upgrade-…`.
pub fn is_pre_upgrade(file: &str) -> bool {
    file.strip_prefix(COPY_PREFIX)
        .and_then(|rest| rest.get(17..))
        .is_some_and(|tag| tag.starts_with(TAG_PREFIX))
}

/// What this build's `migrator` would add to the database on `conn`, on top
/// of at least one migration it has. `None` for a new file (no migrations
/// table, or no row in it), for a database that is up to date, and for one
/// with a failed migration or one this build does not know: sqlx refuses
/// those as before, and a copy would protect nothing new.
pub async fn pending(
    conn: &mut SqliteConnection,
    migrator: &Migrator,
) -> Result<Option<Pending>, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(&mut *conn)
    .await?;
    if tables == 0 {
        return Ok(None);
    }
    let applied: Vec<(i64, bool)> = sqlx::query_as("SELECT version, success FROM _sqlx_migrations")
        .fetch_all(&mut *conn)
        .await?;
    let known: Vec<i64> = migrator
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .collect();
    if applied
        .iter()
        .any(|(version, success)| !success || !known.contains(version))
    {
        return Ok(None);
    }
    let Some(from) = applied.iter().map(|(version, _)| *version).max() else {
        return Ok(None);
    };
    let Some(to) = known.iter().copied().max() else {
        return Ok(None);
    };
    let migrations = known
        .iter()
        .filter(|version| !applied.iter().any(|(applied, _)| applied == *version))
        .count();
    Ok((migrations > 0).then_some(Pending {
        from,
        to,
        migrations,
    }))
}
