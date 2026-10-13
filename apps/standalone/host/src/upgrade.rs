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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use markiro_proto::backup::BackupTrigger;
use serde_json::{json, Value};
use sqlx::migrate::Migrator;
use sqlx::{SqliteConnection, SqlitePool};
use time::OffsetDateTime;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::backup::copy::{self, Failure, COPY_PREFIX};
use crate::backup::identity::{platform_guard, HostIdentity, KeyFileGuard};
use crate::clock::format_timestamp;
use crate::config::HostPaths;

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

/// `details.code` of a `host.upgrade` row whose copy was made and whose
/// migrations then failed (a failed copy's codes are
/// `markiro_proto::backup::failure`).
pub const MIGRATION_FAILED: &str = "migration_failed";

/// Where and as whom [`prepare`] copies the database.
pub struct PreUpgrade {
    /// The data folder: its host identity goes beside the copy (plan I1).
    pub data_dir: PathBuf,
    /// The local folder of copies (`<data dir>/backups`).
    pub backups_dir: PathBuf,
    pub host_id: String,
    /// Closes the host identity beside the copy.
    pub guard: Arc<dyn KeyFileGuard>,
    /// The copy's time and the audit row's.
    pub at: OffsetDateTime,
}

impl PreUpgrade {
    /// The host's own folders and guard, at `at`.
    pub fn for_paths(paths: &HostPaths, host_id: impl Into<String>, at: OffsetDateTime) -> Self {
        Self {
            data_dir: paths.data_dir.clone(),
            backups_dir: paths.backups_dir(),
            host_id: host_id.into(),
            guard: platform_guard(),
            at,
        }
    }
}

/// Why `db::open_upgrading` gave no pool.
#[derive(Debug)]
pub enum OpenError {
    /// SQLite or a migration failed, as `db::open` reports it.
    Database(sqlx::Error),
    /// The copy before the migrations failed: none of them ran.
    Copy { pending: Pending, failure: Failure },
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(formatter, "{error}"),
            Self::Copy { pending, failure } => write!(
                formatter,
                "the copy of the database before migrations {} to {} failed ({}): no migration \
                 ran and the host does not start; free space or restore access in the folder \
                 of copies, then start the service again",
                pending.from, pending.to, failure.code
            ),
        }
    }
}

impl std::error::Error for OpenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Copy { .. } => None,
        }
    }
}

impl From<sqlx::Error> for OpenError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// The copy that protects the pending migrations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prepared {
    pub pending: Pending,
    /// The copy's file name in the local folder.
    pub file: String,
    /// The copy of an earlier start whose migrations failed, used again.
    pub reused: bool,
}

/// The newest audit row, when it is a failed `host.upgrade` of the same
/// migrations: nothing has written to the database since (the host did not
/// start in between).
struct LastFailure {
    file: Option<String>,
    code: String,
}

/// Before the migrations: `None` when nothing is pending, otherwise the copy
/// that protects them — the earlier start's (when its migrations failed and
/// nothing wrote since, so a service restarting every minute does not fill
/// the disk), or a new verified copy. A copy that fails is
/// [`OpenError::Copy`] with one `host.upgrade` `failed` row, which a repeat
/// of the same failure does not write again.
pub async fn prepare(
    pool: &SqlitePool,
    migrator: &Migrator,
    pre: &PreUpgrade,
) -> Result<Option<Prepared>, OpenError> {
    let mut conn = pool.acquire().await?;
    let Some(pending) = pending(&mut conn, migrator).await? else {
        return Ok(None);
    };
    let last = last_failure(&mut conn, &pending).await?;
    if let Some(file) = last.as_ref().and_then(|last| last.file.clone()) {
        if reusable(&pre.backups_dir, &file).await {
            tracing::info!(
                %file,
                from = pending.from,
                to = pending.to,
                "the copy of the earlier start protects the migrations again"
            );
            return Ok(Some(Prepared {
                pending,
                file,
                reused: true,
            }));
        }
    }
    let identity = read_identity(pre).await;
    let made = copy::make_copy_with_identity_tagged(
        &mut conn,
        &pre.backups_dir,
        pre.at,
        BackupTrigger::Scheduled,
        &pre.host_id,
        &pending.tag(),
        identity,
        pre.guard.clone(),
    )
    .await;
    match made {
        Ok(manifest) => {
            tracing::info!(
                file = %manifest.file,
                size = manifest.size_bytes,
                from = pending.from,
                to = pending.to,
                "the database was copied before its migrations"
            );
            Ok(Some(Prepared {
                pending,
                file: manifest.file,
                reused: false,
            }))
        }
        Err(failure) => {
            tracing::error!(
                code = failure.code,
                detail = %failure.detail,
                from = pending.from,
                to = pending.to,
                "the copy before the migrations failed: no migration runs and the host does not start"
            );
            let repeated = last
                .as_ref()
                .is_some_and(|last| last.file.is_none() && last.code == failure.code);
            if !repeated {
                record(
                    &mut conn,
                    pre,
                    &pending,
                    None,
                    false,
                    Some(failure.code),
                    Outcome::Failed,
                )
                .await;
            }
            Err(OpenError::Copy { pending, failure })
        }
    }
}

/// The migrations ran: the `ok` row.
pub async fn record_done(pool: &SqlitePool, prepared: &Prepared, pre: &PreUpgrade) {
    match pool.acquire().await {
        Ok(mut conn) => {
            record(
                &mut conn,
                pre,
                &prepared.pending,
                Some(&prepared.file),
                prepared.reused,
                None,
                Outcome::Ok,
            )
            .await;
        }
        Err(error) => tracing::error!(%error, "the host.upgrade audit row was not written"),
    }
}

/// The migrations failed after a good copy: one `failed` row naming it. A
/// reused copy's start writes none: the earlier row says the same.
pub async fn record_failed_migration(pool: &SqlitePool, prepared: &Prepared, pre: &PreUpgrade) {
    if prepared.reused {
        return;
    }
    match pool.acquire().await {
        Ok(mut conn) => {
            record(
                &mut conn,
                pre,
                &prepared.pending,
                Some(&prepared.file),
                false,
                Some(MIGRATION_FAILED),
                Outcome::Failed,
            )
            .await;
        }
        Err(error) => tracing::error!(%error, "the host.upgrade audit row was not written"),
    }
}

async fn last_failure(
    conn: &mut SqliteConnection,
    pending: &Pending,
) -> Result<Option<LastFailure>, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'",
    )
    .fetch_one(&mut *conn)
    .await?;
    if tables == 0 {
        return Ok(None);
    }
    let newest: Option<(String, String, String)> =
        sqlx::query_as("SELECT action, result, details FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(&mut *conn)
            .await?;
    let Some((action, result, details)) = newest else {
        return Ok(None);
    };
    if action != actions::HOST_UPGRADE || result != "failed" {
        return Ok(None);
    }
    let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
    if details["from"] != json!(pending.from) || details["to"] != json!(pending.to) {
        return Ok(None);
    }
    Ok(Some(LastFailure {
        file: details["file"].as_str().map(str::to_owned),
        code: details["code"].as_str().unwrap_or_default().to_owned(),
    }))
}

/// Whether `file`, which an earlier start named, is still a verified copy in
/// `dir`: a copy's name, its manifest reads and names it, and the file has
/// the manifest's size.
async fn reusable(dir: &Path, file: &str) -> bool {
    if !copy::is_copy_file_name(file) {
        return false;
    }
    let db = dir.join(file);
    tokio::task::spawn_blocking(move || {
        copy::read_manifest(&db).is_ok_and(|manifest| {
            std::fs::metadata(&db).is_ok_and(|metadata| metadata.len() == manifest.size_bytes)
        })
    })
    .await
    .unwrap_or(false)
}

/// The data folder's identity when it reads and names this host, as the
/// backup worker reads it before each copy; otherwise the copy goes without.
async fn read_identity(pre: &PreUpgrade) -> Option<Arc<HostIdentity>> {
    let paths = HostPaths::new(pre.data_dir.clone());
    match tokio::task::spawn_blocking(move || HostIdentity::read(&paths)).await {
        Ok(Ok(identity)) if identity.host_id() == pre.host_id => Some(Arc::new(identity)),
        Ok(Ok(_)) => {
            tracing::warn!("the host identity names another host: the copy before the migrations goes without it");
            None
        }
        Ok(Err(error)) => {
            tracing::warn!(%error, "the host identity did not read: the copy before the migrations goes without it");
            None
        }
        Err(_) => None,
    }
}

/// One `host.upgrade` row: the host as the actor, the copy as the target.
/// Only numbers, the copy's name and a code: never an error's text.
async fn record(
    conn: &mut SqliteConnection,
    pre: &PreUpgrade,
    pending: &Pending,
    file: Option<&str>,
    reused: bool,
    code: Option<&str>,
    outcome: Outcome,
) {
    let details = json!({
        "from": pending.from,
        "to": pending.to,
        "migrations": pending.migrations,
        "file": file,
        "reused": reused,
        "code": code,
        "appVersion": env!("CARGO_PKG_VERSION"),
    });
    let entry = Entry {
        actor: Actor::System,
        action: actions::HOST_UPGRADE,
        target_type: Some("backup"),
        target_id: file,
        outcome,
        details,
    };
    if let Err(error) = audit::record(conn, &format_timestamp(pre.at), entry).await {
        tracing::error!(%error, "the host.upgrade audit row was not written");
    }
}
