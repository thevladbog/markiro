//! `markiro-host restore <copy>` and `markiro-host verify-copy <copy>` (plan
//! РК): putting a verified copy back while the service is stopped. A
//! support procedure, not an office screen
//! (`docs/runbooks/standalone-backup-restore.md`).
//!
//! The copy is older than the data it replaces, and stations may have
//! printed SSCCs from blocks the copy never saw, taken shift numbers the
//! copy never issued and seen revisions the copy never reached. So the
//! restore:
//!
//! 1. checks the copy (its manifest's size and SHA-256 unless
//!    `--without-manifest`, `PRAGMA integrity_check`, migrations this
//!    build knows with the same checksums, a host that finished its
//!    wizard) before it touches the data folder at all; a copy with a WAL
//!    beside it (the database set aside by an earlier restore, of a host
//!    that had crashed) is read with that WAL folded in, in a private
//!    folder, never in place;
//! 2. takes the data folder's lock (the service holds it while it runs),
//!    finishes a restore that was cut off (below), and reads what the
//!    current database knew, if it still opens: each SSCC counter (and the
//!    end of each block and the serial of each box and pallet), each month's
//!    shift number, the audit sequence, and every device, operator, badge
//!    and office user that was revoked or turned off. The databases earlier
//!    restores set aside in `restore-*/` count for the numbers too;
//! 3. builds the new database BESIDE the current one (`host.db.partial`):
//!    the copy, checked again after it was copied, migrated forward by this
//!    build's migrations (a copy of an older version works), and in one
//!    transaction
//!    * every SSCC counter raised above both databases by two block sizes of
//!      its extension (never past the prefix's last serial); when the current
//!      database was not read, at least [`UNREAD_SSCC_MARGIN`] above the
//!      copy's highest number, rounded up to [`UNREAD_SSCC_ROUNDING`],
//!    * every month's shift number raised by 10 above both, from the copy's
//!      month to the current one,
//!    * the revision set to the copy's next one, BELOW what the current
//!      database reached: a station whose cursor passed it sees the host go
//!      back (`rev < since`) and starts its copies again from zero
//!      (`src/local/reference-sync.ts`). This is best effort until the
//!      stations read the epoch: a station whose cursor is at or below the
//!      copy's next revision does not notice;
//!    * the audit sequence raised above both (an audit id names one event in
//!      either database, and is never issued twice),
//!    * the revocations of the current database carried over (a device, a
//!      badge stays revoked, an operator, an office user stays turned off;
//!      nothing the copy lacks comes back), every office session ended,
//!    * a new `site.restore_epoch`, which `hello` reports, the stations'
//!      facts held (`site.facts_held_since`) until an administrator resumes
//!      them, and one `host.restore` audit row;
//!
//!    then checked once more (`integrity_check`, the epoch and the revision);
//! 4. writes the intent marker (`host.restore-intent`, synced), swaps — the
//!    current database's files go into `restore-<time>/` in the data folder
//!    (never deleted), the new database is renamed into place, each rename
//!    synced — and removes the marker. A rename that fails puts the current
//!    files back.
//!
//! Nothing is written to the current database or its folder before step 4,
//! so a failure anywhere before it leaves the data folder as it was.
//!
//! A restore cut off during step 4 (the power went) leaves the marker. The
//! host does not start while it is there, and the next `restore` finishes
//! the cut-off one first:
//!
//! | `host.db.partial` | `host.db`                    | the next restore                                            |
//! | ----------------- | ---------------------------- | ----------------------------------------------------------- |
//! | there             | any                          | puts the aside folder's files back where they are missing, removes the marker and the new database (rolled back) |
//! | gone              | holds the marker's epoch     | removes the marker (it had finished)                         |
//! | gone              | missing or another epoch     | refuses: support moves the files by hand                     |
//!
//! Then it restores as usual, over what it found.
//!
//! No clock decides a number: every floor comes from the data. The time
//! only names the aside folder and the audit row, and bounds the months for
//! which a shift number counter is made (from the copy's manifest or, without
//! one, from the copy's newest audit row).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use markiro_proto::entities;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::{Month, OffsetDateTime};

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::backup::copy::{
    create_private, partial_path, read_manifest, sha256_file, utc_stamp, verify_database, Manifest,
};
use crate::clock::{format_timestamp, parse_timestamp};
use crate::config::{ConfigError, HostConfig, HostPaths};
use crate::{db, feed, BoxError};

/// How far a restore lifts each SSCC counter: this many blocks of its
/// extension's size above the highest serial either database knew.
pub const SSCC_MARGIN_BLOCKS: i64 = 2;
/// How far a restore lifts each month's shift number.
pub const SHIFT_NUMBER_MARGIN: i64 = 10;
/// How far every SSCC counter rises above the copy's highest number at
/// least when the current database was not read (unreadable, or none): the
/// serials stations printed after the copy are unknown. A serial of a
/// 9-digit prefix has 7 digits (10 000 000 serials per extension), so each
/// such restore uses up about 1 % of them, per prefix and extension.
pub const UNREAD_SSCC_MARGIN: i64 = 100_000;
/// ... rounded up to a multiple of this.
pub const UNREAD_SSCC_ROUNDING: i64 = 10_000;
/// How far the audit sequence rises above the copy's when the current
/// database could not be read (or there was none): an audit id is never
/// issued twice, and a million is far more than a day of events.
pub const UNREADABLE_CURRENT_MARGIN: i64 = 1_000_000;
/// How often a rename that fails is tried again (a virus scanner on
/// Windows may hold a file for a moment).
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(300);
/// How often the current database is read before it counts as unreadable
/// (a moment's I/O error or lock is not a dead disk).
const READ_ATTEMPTS: u32 = 4;
const READ_RETRY_DELAY: Duration = Duration::from_millis(250);
const INTENT_FORMAT: u32 = 1;

/// What is put in place: the copy itself, or the copy with the WAL beside it
/// folded in, in a private folder that goes with the last reference.
#[derive(Debug)]
struct Source {
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
    _folder: Option<PrivateFolder>,
}

/// A folder of this process only, removed when dropped.
#[derive(Debug)]
struct PrivateFolder(PathBuf);

impl PrivateFolder {
    fn new() -> std::io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("markiro-host-restore-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(path))
    }
}

impl Drop for PrivateFolder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A copy that checked out.
#[derive(Debug, Clone)]
pub struct VerifiedCopy {
    pub path: PathBuf,
    /// Of the file at `path`.
    pub size_bytes: u64,
    /// Of the file at `path`.
    pub sha256: String,
    /// `None` with `--without-manifest`.
    pub manifest: Option<Manifest>,
    pub schema_version: i64,
    /// A WAL with frames lay beside the copy (`--without-manifest` only): its
    /// commits were folded into a private copy, which is what is put in place.
    pub wal_folded: bool,
    staged: Arc<Source>,
}

/// An SSCC counter after a restore: `from` is the copy's (`None` when only
/// the current database had the counter).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterRaise {
    pub issuer_prefix: String,
    pub extension: i64,
    pub from: Option<i64>,
    pub to: i64,
}

/// A month's shift number after a restore.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShiftNumberRaise {
    pub month_key: String,
    pub from: Option<i64>,
    pub to: i64,
}

/// What the current database was when the restore began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Current {
    /// It opened and was read: its counters and revocations count too.
    Read,
    /// It was there but could not be read: the margins alone protect.
    Unreadable,
    /// There was none (a new computer).
    Absent,
}

impl Current {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Unreadable => "unreadable",
            Self::Absent => "absent",
        }
    }
}

/// How many revocations of the current database the restored one got.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Carried {
    pub devices: u64,
    pub operators: u64,
    pub badges: u64,
    pub office_users: u64,
}

/// A restore that was cut off, found by the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interrupted {
    /// Its new database never took the place: the previous one was put back.
    RolledBack,
    /// Its new database had taken the place: only its marker was left.
    Finished,
}

#[derive(Debug, Clone)]
pub struct RestoreReport {
    pub copy: VerifiedCopy,
    /// The data folder, as an absolute path.
    pub data_dir: PathBuf,
    pub current: Current,
    /// Where the current database went; `None` when there was none.
    pub saved_as: Option<PathBuf>,
    pub epoch: String,
    pub counters: Vec<CounterRaise>,
    pub shift_numbers: Vec<ShiftNumberRaise>,
    /// The copy was made by another host than the one of this data folder
    /// (a new computer): the stations pair with this host again.
    pub other_host: bool,
    /// The data folder had no `host.json`: this restore created one.
    pub new_identity: bool,
    /// The host's revision after the restore: the copy's next one.
    pub revision: i64,
    /// The current database was read, its wizard was done and it is of this
    /// copy's host: what it issued after the copy is known. Otherwise (none,
    /// unreadable, a new host whose wizard never ran, another host's) the
    /// margins of an unread database apply.
    pub history_known: bool,
    /// `None` when the current database was not read or is not this copy's
    /// history.
    pub carried: Option<Carried>,
    pub sessions_ended: u64,
    pub interrupted: Option<Interrupted>,
    /// When the copy was made: its manifest's time or, without one, its
    /// newest audit row's.
    pub copy_made: String,
}

/// A read-only connection. A database another program holds is waited for
/// half a second per try, not sqlx's 5 s: the current database is tried
/// [`READ_ATTEMPTS`] times anyway.
fn open_read_only(path: &Path, immutable: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(immutable)
        .busy_timeout(Duration::from_millis(500))
}

/// The WAL beside `path` holds frames.
fn has_wal_frames(path: &Path) -> bool {
    let [_, wal, _] = database_files(path);
    fs::metadata(wal).is_ok_and(|meta| meta.len() > 0)
}

/// Check `path` as `markiro-host verify-copy` and `restore` do.
pub async fn verify_copy(path: &Path, without_manifest: bool) -> Result<VerifiedCopy, BoxError> {
    if !path.is_file() {
        return Err(format!("{} is not a file", path.display()).into());
    }
    let manifest = if without_manifest {
        None
    } else {
        Some(read_manifest(path).map_err(|error| {
            format!(
                "{error}; without its manifest the copy is checked only with --without-manifest"
            )
        })?)
    };
    let hashed = path.to_path_buf();
    let (size_bytes, sha256) = tokio::task::spawn_blocking(move || sha256_file(&hashed)).await??;
    if let Some(manifest) = &manifest {
        if manifest.size_bytes != size_bytes || manifest.sha256 != sha256 {
            return Err(format!(
                "{} does not match its manifest (size or SHA-256): the copy is damaged",
                path.display()
            )
            .into());
        }
    }
    let source = if has_wal_frames(path) {
        if manifest.is_some() {
            return Err(format!(
                "{} has a WAL beside it: the copy was changed after it was made, and its manifest describes the file alone; check it with --without-manifest, which folds the WAL in",
                path.display()
            )
            .into());
        }
        fold_wal(path).await?
    } else {
        Source {
            path: path.to_path_buf(),
            size_bytes,
            sha256: sha256.clone(),
            _folder: None,
        }
    };
    let mut conn = open_read_only(&source.path, true).connect().await?;
    let checked = check_copy(&mut conn).await;
    let _ = conn.close().await;
    let schema_version = checked?;
    Ok(VerifiedCopy {
        path: path.to_path_buf(),
        size_bytes,
        sha256,
        manifest,
        schema_version,
        wal_folded: source._folder.is_some(),
        staged: Arc::new(source),
    })
}

/// Copy `from` into a new owner-only file `to`.
fn copy_private(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut source = fs::File::open(from)?;
    let mut target = create_private(to, true)?;
    std::io::copy(&mut source, &mut target)?;
    Ok(())
}

/// The copy at `path` with the WAL beside it folded in: both are copied into
/// a private folder, opened there for writing so SQLite replays the WAL, and
/// written out whole (`VACUUM INTO`). The copy and its WAL are only read.
async fn fold_wal(path: &Path) -> Result<Source, BoxError> {
    let folder = PrivateFolder::new()?;
    let db = folder.0.join("copy.db");
    let [_, wal, _] = database_files(path);
    let [_, db_wal, _] = database_files(&db);
    copy_private(path, &db)?;
    copy_private(&wal, &db_wal)?;
    let folded = folder.0.join("folded.db");
    let target = folded
        .to_str()
        .ok_or("the temporary folder is no UTF-8 path")?
        .to_owned();
    let mut conn = db::options(&db).connect().await?;
    let vacuumed = sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(&mut conn)
        .await;
    let closed = conn.close().await;
    vacuumed?;
    closed?;
    let (size_bytes, sha256) = sha256_file(&folded)?;
    Ok(Source {
        path: folded,
        size_bytes,
        sha256,
        _folder: Some(folder),
    })
}

async fn check_copy(conn: &mut SqliteConnection) -> Result<i64, BoxError> {
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *conn)
        .await?;
    if rows != ["ok"] {
        return Err(format!("the copy is damaged: {}", rows.join("; ")).into());
    }
    let applied: Vec<(i64, bool, Vec<u8>)> =
        sqlx::query_as("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut *conn)
            .await
            .map_err(|_| "the copy is no markiro-host database")?;
    let known: BTreeMap<i64, &[u8]> = db::MIGRATOR
        .iter()
        .map(|migration| (migration.version, migration.checksum.as_ref()))
        .collect();
    for (version, success, checksum) in &applied {
        if !success || known.get(version) != Some(&checksum.as_slice()) {
            return Err(format!(
                "migration {version} of the copy is unknown to this markiro-host {}: restore it with the version that made it",
                env!("CARGO_PKG_VERSION")
            )
            .into());
        }
    }
    // The newest applied: migration 11 can be applied after 12 on a database
    // that was made before 11 existed, so the last row is not the newest.
    let Some(schema_version) = applied.iter().map(|(version, _, _)| *version).max() else {
        return Err("the copy is no markiro-host database".into());
    };
    let initialized: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    if initialized.is_none() {
        return Err("the copy is of a host whose wizard never finished".into());
    }
    Ok(schema_version)
}

/// What a database knew: per `(prefix, extension)` the first serial that no
/// counter, block, box or pallet reached, per month the last shift number
/// (the counter's or the highest number a shift holds), and its audit
/// sequence.
#[derive(Debug, Default, Clone)]
struct Floors {
    counters: BTreeMap<(String, i64), i64>,
    shift_numbers: BTreeMap<String, i64>,
    audit_sequence: Option<i64>,
}

impl Floors {
    /// Every number either knew.
    fn merge(&mut self, other: Floors) {
        for (key, value) in other.counters {
            raise_to(&mut self.counters, key, value);
        }
        for (key, value) in other.shift_numbers {
            raise_to(&mut self.shift_numbers, key, value);
        }
        self.audit_sequence = self.audit_sequence.max(other.audit_sequence);
    }
}

/// What the current database revoked or turned off.
#[derive(Debug, Default, Clone)]
struct Revoked {
    /// `(id, revoked_at)`.
    devices: Vec<(String, String)>,
    operators: Vec<String>,
    /// `(id, revoked_at)`.
    badges: Vec<(String, String)>,
    office_users: Vec<String>,
}

fn raise_to<K: Ord>(map: &mut BTreeMap<K, i64>, key: K, value: i64) {
    let slot = map.entry(key).or_insert(value);
    *slot = (*slot).max(value);
}

/// The SQL that gives, per prefix and extension, the first serial a table
/// reached. A table this schema does not have is left out: the database may
/// be older than this build.
fn counter_sources(tables: &BTreeSet<String>) -> Vec<&'static str> {
    let mut sources = Vec::new();
    if tables.contains("sscc_counters") {
        sources.push(
            "SELECT issuer_prefix, extension, max(next_serial) FROM sscc_counters GROUP BY 1, 2",
        );
    }
    if tables.contains("sscc_blocks") {
        sources.push(
            "SELECT issuer_prefix, extension, max(to_serial) + 1 FROM sscc_blocks GROUP BY 1, 2",
        );
        if tables.contains("boxes") {
            sources.push(
                "SELECT b.issuer_prefix, b.extension, max(x.serial) + 1 FROM boxes x \
                 JOIN sscc_blocks b ON b.id = x.block_id WHERE x.serial IS NOT NULL GROUP BY 1, 2",
            );
        }
        if tables.contains("pallets") {
            sources.push(
                "SELECT b.issuer_prefix, b.extension, max(x.serial) + 1 FROM pallets x \
                 JOIN sscc_blocks b ON b.id = x.block_id WHERE x.serial IS NOT NULL GROUP BY 1, 2",
            );
        }
    }
    sources
}

async fn table_names(conn: &mut SqliteConnection) -> Result<BTreeSet<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect(),
    )
}

async fn read_floors(conn: &mut SqliteConnection) -> Result<Floors, sqlx::Error> {
    let tables = table_names(&mut *conn).await?;
    let mut floors = Floors::default();
    for source in counter_sources(&tables) {
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(source).fetch_all(&mut *conn).await?;
        for (prefix, extension, floor) in rows {
            raise_to(&mut floors.counters, (prefix, extension), floor);
        }
    }
    if tables.contains("shift_number_counters") {
        let rows: Vec<(String, i64)> =
            sqlx::query_as("SELECT month_key, last_seq FROM shift_number_counters")
                .fetch_all(&mut *conn)
                .await?;
        for (month, last) in rows {
            raise_to(&mut floors.shift_numbers, month, last);
        }
    }
    if tables.contains("shifts") {
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT number_month_key, max(number_seq) FROM shifts GROUP BY number_month_key",
        )
        .fetch_all(&mut *conn)
        .await?;
        for (month, last) in rows {
            raise_to(&mut floors.shift_numbers, month, last);
        }
    }
    if tables.contains("audit_log") {
        let newest: Option<i64> = sqlx::query_scalar("SELECT max(id) FROM audit_log")
            .fetch_one(&mut *conn)
            .await?;
        let issued: Option<i64> = if tables.contains("sqlite_sequence") {
            sqlx::query_scalar("SELECT max(seq) FROM sqlite_sequence WHERE name = 'audit_log'")
                .fetch_one(&mut *conn)
                .await?
        } else {
            None
        };
        floors.audit_sequence = newest.max(issued);
    }
    Ok(floors)
}

async fn read_revoked(conn: &mut SqliteConnection) -> Result<Revoked, sqlx::Error> {
    let tables = table_names(&mut *conn).await?;
    let mut revoked = Revoked::default();
    if tables.contains("devices") {
        revoked.devices = sqlx::query_as(
            "SELECT id, revoked_at FROM devices WHERE revoked_at IS NOT NULL ORDER BY id",
        )
        .fetch_all(&mut *conn)
        .await?;
    }
    if tables.contains("operators") {
        revoked.operators =
            sqlx::query_scalar("SELECT id FROM operators WHERE active = 0 ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
    }
    if tables.contains("operator_badges") {
        revoked.badges = sqlx::query_as(
            "SELECT id, revoked_at FROM operator_badges WHERE revoked_at IS NOT NULL ORDER BY id",
        )
        .fetch_all(&mut *conn)
        .await?;
    }
    if tables.contains("office_users") {
        revoked.office_users =
            sqlx::query_scalar("SELECT id FROM office_users WHERE active = 0 ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
    }
    Ok(revoked)
}

/// A look at a database by a read-only connection that is not immutable: a
/// stopped host may leave its WAL behind, with the last commits in it, and
/// such a connection reads them. The `-wal` and `-shm` files the connection
/// creates where there were none are removed again by [`Visit::end`], so the
/// folder is left as it was found.
struct Visit {
    wal: PathBuf,
    shm: PathBuf,
    had_wal: bool,
    had_shm: bool,
}

impl Visit {
    fn begin(path: &Path) -> Self {
        let [_, wal, shm] = database_files(path);
        Self {
            had_wal: wal.exists(),
            had_shm: shm.exists(),
            wal,
            shm,
        }
    }

    fn end(self) {
        if !self.had_wal {
            let _ = fs::remove_file(&self.wal);
        }
        if !self.had_shm {
            let _ = fs::remove_file(&self.shm);
        }
    }
}

/// What a live database told: its numbers, its revocations and whether its
/// wizard was done (one whose wizard never ran issued nothing).
struct Live {
    floors: Floors,
    revoked: Revoked,
    initialized: bool,
}

/// Whether the wizard of the database on `conn` was done.
async fn read_initialized(conn: &mut SqliteConnection) -> Result<bool, sqlx::Error> {
    if !table_names(&mut *conn).await?.contains("site") {
        return Ok(false);
    }
    let initialized: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?
            .flatten();
    Ok(initialized.is_some())
}

/// The numbers, the revocations and the wizard's state of the database at
/// `path`, read once.
async fn read_live(path: &Path) -> Result<Live, sqlx::Error> {
    let visit = Visit::begin(path);
    let read = async {
        let mut conn = open_read_only(path, false).connect().await?;
        let read = async {
            let floors = read_floors(&mut conn).await?;
            let revoked = read_revoked(&mut conn).await?;
            let initialized = read_initialized(&mut conn).await?;
            Ok::<_, sqlx::Error>(Live {
                floors,
                revoked,
                initialized,
            })
        }
        .await;
        let _ = conn.close().await;
        read
    }
    .await;
    visit.end();
    read
}

/// `read`, tried up to `attempts` times with `delay` between.
async fn with_retries<T, F, Fut>(
    attempts: u32,
    delay: Duration,
    mut read: F,
) -> Result<T, sqlx::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, sqlx::Error>>,
{
    let mut attempt = 1;
    loop {
        match read().await {
            Err(_) if attempt < attempts => {
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
            other => return other,
        }
    }
}

/// SQLITE_BUSY or SQLITE_LOCKED, extended codes included: another program
/// holds the database.
fn is_busy(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|database| database.code())
        .and_then(|code| code.parse::<i64>().ok())
        .is_some_and(|code| matches!(code & 0xff, 5 | 6))
}

/// What the current database at `db` is, its numbers, its revocations and
/// whether its wizard was done (when read). A file that is there but does
/// not read is read again a few times before it counts as unreadable; one
/// another program keeps busy all that time is a refusal, not an unreadable
/// database.
async fn current_state(db: &Path) -> Result<(Current, Floors, Option<Revoked>, bool), BoxError> {
    match fs::metadata(db) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Current::Absent, Floors::default(), None, false));
        }
        // Any other answer: the file is there, or may be; reading it says.
        _ => {}
    }
    match with_retries(READ_ATTEMPTS, READ_RETRY_DELAY, || read_live(db)).await {
        Ok(live) => Ok((
            Current::Read,
            live.floors,
            Some(live.revoked),
            live.initialized,
        )),
        Err(error) if is_busy(&error) => Err(format!(
            "the current database {} is held by another program ({error}): close every program that has it open and run the command again",
            db.display()
        )
        .into()),
        Err(error) => {
            tracing::warn!(%error, "the current database could not be read");
            Ok((Current::Unreadable, Floors::default(), None, false))
        }
    }
}

/// The numbers of every database earlier restores set aside in
/// `restore-*/host.db` (with its WAL when it lies beside): any number any
/// earlier database of this folder issued is a floor. One that does not read
/// adds nothing.
async fn aside_floors(data_dir: &Path) -> Floors {
    let mut floors = Floors::default();
    let Ok(entries) = fs::read_dir(data_dir) else {
        return floors;
    };
    let mut asides: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("restore-"))
        .map(|entry| entry.path().join("host.db"))
        .filter(|db| db.is_file())
        .collect();
    asides.sort();
    for db in asides {
        match read_live(&db).await {
            Ok(found) => floors.merge(found.floors),
            Err(error) => {
                tracing::warn!(%error, path = %db.display(), "a database set aside could not be read");
            }
        }
    }
    floors
}

/// The month keys (`MONYY`) from `from`'s month to `to`'s, both included.
fn months_between(from: time::Date, to: time::Date) -> Vec<String> {
    let mut keys = Vec::new();
    let (mut year, mut month) = (from.year(), from.month());
    while (year, u8::from(month)) <= (to.year(), u8::from(to.month())) {
        let first = time::Date::from_calendar_date(year, month, 1).expect("the first of a month");
        keys.push(crate::shifts::month_key(first));
        if month == Month::December {
            year += 1;
        }
        month = month.next();
    }
    keys
}

/// The files of the database at `db`: itself, its WAL and its shared memory.
fn database_files(db: &Path) -> [PathBuf; 3] {
    let with = |suffix: &str| {
        let mut name = db.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [db.to_path_buf(), with("-wal"), with("-shm")]
}

fn journal_of(db: &Path) -> PathBuf {
    let mut journal = db.as_os_str().to_owned();
    journal.push("-journal");
    PathBuf::from(journal)
}

/// Everything a half-built new database can leave beside `host.db`.
fn remove_staging(staging: &Path) {
    for file in database_files(staging) {
        let _ = fs::remove_file(&file);
    }
    let _ = fs::remove_file(journal_of(staging));
}

/// The aside folder of this restore: `restore-<UTC time>`, with `-2`, `-3`
/// when a restore of the same second (or an earlier folder) is there.
fn aside_dir(paths: &HostPaths, now: OffsetDateTime) -> PathBuf {
    let base = format!("restore-{}", utc_stamp(now));
    let mut candidate = paths.data_dir.join(&base);
    let mut number = 2;
    while candidate.exists() {
        candidate = paths.data_dir.join(format!("{base}-{number}"));
        number += 1;
    }
    candidate
}

/// `operation`, tried up to `attempts` times with `delay` between, unless the
/// error says the file is not there.
fn retrying<T>(
    attempts: u32,
    delay: Duration,
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let mut attempt = 1;
    loop {
        match operation() {
            Err(error) if attempt < attempts && error.kind() != std::io::ErrorKind::NotFound => {
                attempt += 1;
                std::thread::sleep(delay);
            }
            other => return other,
        }
    }
}

fn rename_retrying(from: &Path, to: &Path, delay: Duration) -> std::io::Result<()> {
    retrying(RENAME_ATTEMPTS, delay, || fs::rename(from, to))
}

/// Flush `path` to the disk. Opened for writing: on Windows a flush needs
/// write access, and a read-only handle is refused.
fn sync_file(path: &Path) -> std::io::Result<()> {
    fs::OpenOptions::new().write(true).open(path)?.sync_all()
}

/// Make the renames in `dir` durable, where the system allows it: `fsync`
/// of the folder on Unix, `FlushFileBuffers` of a folder handle on Windows
/// (opened for writing with backup semantics, the only way to open a folder
/// there). A system that refuses is not an error: the renames were done.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        /// `FILE_FLAG_BACKUP_SEMANTICS`: `CreateFileW` opens a folder only
        /// with it.
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        if let Ok(handle) = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(dir)
        {
            let _ = handle.sync_all();
        }
    }
    #[cfg(not(any(unix, windows)))]
    let _ = dir;
}

/// Put `source` at `staging`: copied, synced, read back and compared with the
/// verified copy. (Owner-only on Unix, the folder's ACL on Windows.)
fn place(source: &VerifiedCopy, staging: &Path) -> Result<(), BoxError> {
    let staged = &source.staged;
    // Streamed into a file of its own, not `fs::copy`: a copy would carry the
    // source's attributes (a read-only flag from a flash drive) onto a file
    // the host must write to.
    let mut from = fs::File::open(&staged.path)?;
    let mut to = create_private(staging, false)?;
    std::io::copy(&mut from, &mut to)?;
    to.sync_all()?;
    drop(to);
    let (size, sha256) = sha256_file(staging)?;
    if size != staged.size_bytes || sha256 != staged.sha256 {
        return Err("the copy changed while it was put in place".into());
    }
    Ok(())
}

/// The order the current database's files leave the folder in: the WAL and
/// the shared memory first, the database last. A WAL must never lie beside
/// a database it does not belong to.
fn leaving_order(db: &Path) -> [PathBuf; 3] {
    let [file, wal, shm] = database_files(db);
    [wal, shm, file]
}

/// Where a test cuts a restore off as a power cut would: after the WAL
/// left, after the database file left, or after the new database took its
/// place. Nothing is undone and the marker stays.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashPoint {
    WalAside,
    DatabaseAside,
    NewDatabaseInPlace,
}

/// A swap that failed: why, and which files of the current database could not
/// be put back (none when it was undone). `crashed`: cut off on purpose by a
/// test, nothing undone.
struct SwapFailure {
    cause: String,
    stranded: Vec<String>,
    crashed: bool,
}

enum Stop {
    Io(std::io::Error),
    Crashed,
}

impl From<std::io::Error> for Stop {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// Move the current database's files into `aside` and put `staging` in the
/// place of `db`, syncing both folders after each rename. The WAL and shared
/// memory go first, then the database. A rename that fails moves everything
/// back. A cut-off swap is finished by the next restore (the marker).
fn swap(
    db: &Path,
    staging: &Path,
    aside: Option<&Path>,
    delay: Duration,
    crash: Option<CrashPoint>,
) -> Result<(), SwapFailure> {
    let data_dir = db.parent().unwrap_or(Path::new("."));
    let [file, wal, _] = database_files(db);
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut created = false;
    let result = (|| -> Result<(), Stop> {
        if let Some(aside) = aside {
            fs::create_dir(aside)?;
            created = true;
            sync_dir(data_dir);
            for leaving in leaving_order(db) {
                if !leaving.exists() {
                    continue;
                }
                let target = aside.join(leaving.file_name().expect("a database file has a name"));
                rename_retrying(&leaving, &target, delay)?;
                sync_dir(aside);
                sync_dir(data_dir);
                moved.push((leaving.clone(), target));
                if (crash == Some(CrashPoint::WalAside) && leaving == wal)
                    || (crash == Some(CrashPoint::DatabaseAside) && leaving == file)
                {
                    return Err(Stop::Crashed);
                }
            }
        }
        rename_retrying(staging, db, delay)?;
        sync_dir(data_dir);
        if crash == Some(CrashPoint::NewDatabaseInPlace) {
            return Err(Stop::Crashed);
        }
        Ok(())
    })();
    let error = match result {
        Ok(()) => return Ok(()),
        Err(Stop::Crashed) => {
            return Err(SwapFailure {
                cause: "cut off".to_owned(),
                stranded: Vec::new(),
                crashed: true,
            })
        }
        Err(Stop::Io(error)) => error,
    };
    let mut stranded = Vec::new();
    for (original, target) in moved.iter().rev() {
        match rename_retrying(target, original, delay) {
            Ok(()) => sync_dir(data_dir),
            Err(back) => stranded.push(format!("{}: {back}", target.display())),
        }
    }
    if stranded.is_empty() && created {
        if let Some(aside) = aside {
            let _ = fs::remove_dir(aside);
            sync_dir(data_dir);
        }
    }
    Err(SwapFailure {
        cause: error.to_string(),
        stranded,
        crashed: false,
    })
}

/// A test's cut-off restore ([`restore_crashing`]).
#[derive(Debug)]
struct Crashed;

impl std::fmt::Display for Crashed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("the restore was cut off")
    }
}

impl std::error::Error for Crashed {}

/// The intent marker: written and synced before the first file moves,
/// removed after the last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    format: u32,
    /// Always `swap`: the files of the database are being moved.
    step: String,
    /// The aside folder (a name in the data folder); `None` when there was
    /// nothing to move.
    aside: Option<String>,
    /// The new database (a name in the data folder).
    staging: String,
    /// The new database's `site.restore_epoch`.
    epoch: String,
    started_at: String,
}

/// The aside folder `name` of a marker, in the data folder of `paths`: a
/// plain `restore-…` name, nothing else.
fn aside_named(paths: &HostPaths, name: &str) -> Result<PathBuf, BoxError> {
    let plain = Path::new(name)
        .file_name()
        .is_some_and(|file| file == std::ffi::OsStr::new(name));
    if !plain || !name.starts_with("restore-") {
        return Err(format!(
            "{} names no aside folder of this data folder ({name}): call support",
            paths.restore_intent_file().display()
        )
        .into());
    }
    Ok(paths.data_dir.join(name))
}

/// Write the marker whole or not at all: a `.partial` file, synced, renamed,
/// and the folder synced.
fn write_intent(paths: &HostPaths, intent: &Intent) -> Result<(), BoxError> {
    let path = paths.restore_intent_file();
    let partial = partial_path(&path);
    let written = (|| -> Result<(), BoxError> {
        let mut file = create_private(&partial, false)?;
        file.write_all(&serde_json::to_vec_pretty(intent)?)?;
        file.sync_all()?;
        drop(file);
        rename_retrying(&partial, &path, RENAME_RETRY_DELAY)?;
        sync_dir(&paths.data_dir);
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

fn remove_intent(paths: &HostPaths) -> std::io::Result<()> {
    fs::remove_file(paths.restore_intent_file())?;
    sync_dir(&paths.data_dir);
    Ok(())
}

/// The refusal of `crate::start` while a restore of `paths` is unfinished.
pub fn refuse_unfinished(paths: &HostPaths) -> Result<(), BoxError> {
    let marker = paths.restore_intent_file();
    match fs::symlink_metadata(&marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(format!(
            "a restore of {} was interrupted ({} is there): run the same markiro-host restore command again to finish it; the host does not start until then",
            paths.data_dir.display(),
            marker.display()
        )
        .into()),
    }
}

/// The `site.restore_epoch` of the database at `db`, if it reads.
async fn read_epoch(db: &Path) -> Option<String> {
    if !db.is_file() {
        return None;
    }
    let visit = Visit::begin(db);
    let epoch = async {
        let mut conn = open_read_only(db, false).connect().await.ok()?;
        let epoch: Option<Option<String>> =
            sqlx::query_scalar("SELECT restore_epoch FROM site WHERE id = 1")
                .fetch_optional(&mut conn)
                .await
                .ok()?;
        let _ = conn.close().await;
        epoch.flatten()
    }
    .await;
    visit.end();
    epoch
}

/// Put the files of the database at `db` back from `aside` where the data
/// folder lacks them, and remove `aside` once it is empty. The host does not
/// start while the marker is there, so the order cannot pair a WAL with the
/// wrong file; a shared-memory file is derived and the data folder's wins.
fn put_back(db: &Path, aside: &Path) -> Result<(), BoxError> {
    let data_dir = db.parent().unwrap_or(Path::new("."));
    let [_, _, shm] = database_files(db);
    for file in database_files(db) {
        let kept = aside.join(file.file_name().expect("a database file has a name"));
        if !kept.exists() {
            continue;
        }
        if file.exists() {
            if file == shm {
                fs::remove_file(&kept)?;
                continue;
            }
            return Err(format!(
                "both {} and {} are there: call support; the host does not start until then",
                file.display(),
                kept.display()
            )
            .into());
        }
        rename_retrying(&kept, &file, RENAME_RETRY_DELAY).map_err(|error| {
            format!(
                "{} could not be put back ({error}): run the same markiro-host restore command again, or call support",
                kept.display()
            )
        })?;
        sync_dir(aside);
        sync_dir(data_dir);
    }
    if fs::remove_dir(aside).is_ok() {
        sync_dir(data_dir);
    }
    Ok(())
}

/// Finish a restore of `paths` that was cut off (see the module's table).
async fn finish_interrupted(
    paths: &HostPaths,
    db: &Path,
    staging: &Path,
) -> Result<Option<Interrupted>, BoxError> {
    let marker = paths.restore_intent_file();
    let text = match fs::read(&marker) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", marker.display()).into()),
    };
    let intent: Intent = serde_json::from_slice(&text).map_err(|error| {
        format!(
            "{} is unreadable ({error}): call support; the host does not start while it is there",
            marker.display()
        )
    })?;
    let aside = intent
        .aside
        .as_deref()
        .map(|name| aside_named(paths, name))
        .transpose()?;
    if staging.exists() {
        // The new database never took the place: the previous one goes back.
        if let Some(aside) = &aside {
            put_back(db, aside)?;
        }
        // The marker before the new database: a cut here leaves a stale
        // `host.db.partial`, which the next restore removes, never a marker
        // with neither database.
        remove_intent(paths)?;
        remove_staging(staging);
        return Ok(Some(Interrupted::RolledBack));
    }
    if read_epoch(db).await.as_deref() == Some(intent.epoch.as_str()) {
        remove_intent(paths)?;
        return Ok(Some(Interrupted::Finished));
    }
    Err(format!(
        "a restore of {} was interrupted, and neither its new database ({}) nor a database with its epoch is there{}: call support. Nothing was changed; the host does not start while {} is there",
        paths.data_dir.display(),
        staging.display(),
        aside.map_or_else(String::new, |aside| format!(
            "; the previous database's files are in {}",
            aside.display()
        )),
        marker.display()
    )
    .into())
}

/// The copy made by another host than `config`'s (a new computer)?
fn other_host(copy: &VerifiedCopy, config: &HostConfig) -> bool {
    copy.manifest
        .as_ref()
        .is_some_and(|manifest| manifest.host_id != config.host_id)
}

/// The failure text of a restore that changed nothing.
fn untouched(error: impl std::fmt::Display) -> BoxError {
    format!("{error}. Nothing was changed: the data folder is as it was.").into()
}

/// What a restore made before it failed, for an honest failure text.
#[derive(Debug, Default)]
struct Made {
    folder: bool,
    lock_file: bool,
    identity: bool,
    interrupted: Option<Interrupted>,
}

impl Made {
    /// The failure text of a restore that did not touch the database.
    fn unchanged(&self, paths: &HostPaths, error: impl std::fmt::Display) -> BoxError {
        let mut made = Vec::new();
        if self.folder {
            made.push(format!("the data folder {}", paths.data_dir.display()));
        } else if self.lock_file {
            made.push(format!("the lock file {}", paths.lock_file().display()));
        }
        if self.identity {
            made.push(format!(
                "a new host identity ({})",
                paths.config_file().display()
            ));
        }
        let earlier = match self.interrupted {
            None => "",
            Some(Interrupted::RolledBack) => {
                " The interrupted restore found first was rolled back: the database it had replaced is in place again."
            }
            Some(Interrupted::Finished) => {
                " The interrupted restore found first had finished: only its marker was removed."
            }
        };
        if made.is_empty() && earlier.is_empty() {
            return untouched(error);
        }
        if made.is_empty() {
            return format!("{error}. The database was not changed by this run.{earlier}").into();
        }
        format!(
            "{error}. The database was not changed: this run only created {}.{earlier}",
            made.join(" and ")
        )
        .into()
    }
}

/// Whether `copy` is one of the database files of `paths` itself, or of the
/// new database an interrupted restore left (which a restore removes before
/// it reads anything).
fn is_own_database(copy: &Path, paths: &HostPaths) -> bool {
    let Ok(copy) = fs::canonicalize(copy) else {
        return false;
    };
    let db = paths.database_file();
    let staging = partial_path(&db);
    database_files(&db)
        .into_iter()
        .chain(database_files(&staging))
        .chain([journal_of(&staging)])
        .filter_map(|file| fs::canonicalize(file).ok())
        .any(|own| own == copy)
}

/// Restore `source` into the host at `paths` (the service must be stopped:
/// the data folder's lock says so). `now` is the restore's time.
pub async fn restore(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
) -> Result<RestoreReport, BoxError> {
    restore_until(paths, source, without_manifest, now, None).await
}

/// [`restore`], cut off at `crash` as a power cut would cut it off: nothing
/// is undone and the marker stays. For tests of the next restore.
#[doc(hidden)]
pub async fn restore_crashing(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
    crash: CrashPoint,
) -> Result<(), BoxError> {
    match restore_until(paths, source, without_manifest, now, Some(crash)).await {
        Err(error) if error.is::<Crashed>() => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err("the restore ended before it was cut off".into()),
    }
}

async fn restore_until(
    paths: &HostPaths,
    source: &Path,
    without_manifest: bool,
    now: OffsetDateTime,
    crash: Option<CrashPoint>,
) -> Result<RestoreReport, BoxError> {
    if is_own_database(source, paths) {
        return Err(untouched(format!(
            "{} is the host's own database (or the new database of an interrupted restore), not a copy",
            source.display()
        )));
    }
    // The copy is checked before the data folder is touched at all.
    let copy = verify_copy(source, without_manifest)
        .await
        .map_err(untouched)?;
    let mut made = Made {
        folder: !paths.data_dir.is_dir(),
        ..Made::default()
    };
    fs::create_dir_all(&paths.data_dir)
        .map_err(|error| untouched(format!("{}: {error}", paths.data_dir.display())))?;
    made.lock_file = !paths.lock_file().exists();
    let lock = paths.lock().map_err(|error| match error {
        ConfigError::Locked { .. } => made.unchanged(
            paths,
            format!(
                "the host is running: {error}. Stop the service (sc stop MarkiroHost) and run the command again"
            ),
        ),
        other => made.unchanged(paths, other),
    })?;
    // A data folder without host.json gets a new identity, on purpose (the
    // restore of a new computer: the runbook says devices pair again), but
    // only once the new database is ready.
    let existing = match HostConfig::load(paths) {
        Ok(config) => Some(config),
        Err(ConfigError::Missing { .. }) if !HostConfig::would_orphan_host_data(paths) => None,
        Err(ConfigError::Missing { .. }) => {
            return Err(made.unchanged(
                paths,
                format!(
                    "{} is missing but host data is there: put it back from where it was kept before restoring, instead of starting a new host identity",
                    paths.config_file().display()
                ),
            ));
        }
        Err(other) => return Err(made.unchanged(paths, other)),
    };
    let db = paths.database_file();
    let staging = partial_path(&db);
    made.interrupted = finish_interrupted(paths, &db, &staging).await?;
    // What an earlier restore that was interrupted before its marker left.
    remove_staging(&staging);
    let (current, mut known, revoked, initialized) = current_state(&db)
        .await
        .map_err(|error| made.unchanged(paths, error))?;
    // What the current database issued after the copy is known only when it
    // is the copy's own host's, past its wizard. A new computer's installer
    // starts the host once and leaves a database whose wizard never ran; a
    // copy of another host says nothing of what this one issued (a folder
    // without `host.json` gets a new identity: another host too). Its
    // numbers still count as floors.
    let foreign = existing
        .as_ref()
        .is_none_or(|config| other_host(&copy, config));
    let history_known = current == Current::Read && initialized && !foreign;
    let revoked = revoked.filter(|_| history_known);
    known.merge(aside_floors(&paths.data_dir).await);
    // A WAL beside no database would be read by the restored one: it goes
    // aside too.
    let leftovers = database_files(&db).iter().any(|file| file.exists());
    let aside = leftovers.then(|| aside_dir(paths, now));
    let staged = stage(
        &copy,
        &staging,
        Before {
            current,
            history_known,
            known: &known,
            revoked: revoked.as_ref(),
        },
        aside.as_deref(),
        now,
    )
    .await;
    let raised = match staged {
        Ok(raised) => raised,
        Err(error) => {
            remove_staging(&staging);
            return Err(made.unchanged(paths, error));
        }
    };
    let (config, new_identity) = match existing {
        Some(config) => (config, false),
        None => match HostConfig::load_or_create(paths, None) {
            Ok(config) => {
                made.identity = true;
                (config, true)
            }
            Err(error) => {
                remove_staging(&staging);
                return Err(made.unchanged(paths, error));
            }
        },
    };
    let intent = Intent {
        format: INTENT_FORMAT,
        step: "swap".to_owned(),
        aside: aside
            .as_deref()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned()),
        staging: staging
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        epoch: raised.epoch.clone(),
        started_at: format_timestamp(now),
    };
    if let Err(error) = write_intent(paths, &intent) {
        remove_staging(&staging);
        return Err(made.unchanged(
            paths,
            format!("the restore marker could not be written: {error}"),
        ));
    }
    if let Err(failure) = swap(&db, &staging, aside.as_deref(), RENAME_RETRY_DELAY, crash) {
        if failure.crashed {
            drop(lock);
            return Err(Box::new(Crashed));
        }
        if failure.stranded.is_empty() {
            // Everything is back: the marker goes, then the new database (a
            // cut between leaves a stale `host.db.partial`, nothing worse).
            let marker = remove_intent(paths);
            remove_staging(&staging);
            let cause = format!(
                "the new database could not be put in place: {}. The previous database was put back",
                failure.cause
            );
            return Err(match marker {
                Ok(()) => made.unchanged(paths, cause),
                Err(error) => format!(
                    "{cause}, but {} could not be removed ({error}): delete it before the service is started",
                    paths.restore_intent_file().display()
                )
                .into(),
            });
        }
        // The marker and the new database stay: the next restore puts the
        // previous files back first.
        return Err(format!(
            "the new database could not be put in place: {}. THE PREVIOUS DATABASE COULD NOT BE PUT BACK ({}): its files are in {}. Run the same markiro-host restore command again: it puts them back first (the host does not start until then); if that fails too, call support",
            failure.cause,
            failure.stranded.join("; "),
            aside.as_deref().map_or_else(String::new, |dir| dir.display().to_string()),
        )
        .into());
    }
    if let Err(error) = remove_intent(paths) {
        return Err(format!(
            "the copy is in place, but {} could not be removed ({error}): run the same markiro-host restore command again, or delete that file, before the service is started",
            paths.restore_intent_file().display()
        )
        .into());
    }
    drop(lock);
    Ok(RestoreReport {
        other_host: other_host(&copy, &config),
        copy,
        data_dir: std::path::absolute(&paths.data_dir).unwrap_or_else(|_| paths.data_dir.clone()),
        current,
        history_known,
        saved_as: aside,
        epoch: raised.epoch,
        counters: raised.counters,
        shift_numbers: raised.shift_numbers,
        new_identity,
        revision: raised.revision,
        carried: raised.carried,
        sessions_ended: raised.sessions_ended,
        interrupted: made.interrupted,
        copy_made: raised.copy_made,
    })
}

/// What the restore knew of the data before the copy: what the current
/// database was, every number it and the databases set aside knew, and its
/// revocations (when read).
#[derive(Clone, Copy)]
struct Before<'a> {
    current: Current,
    /// See [`RestoreReport::history_known`].
    history_known: bool,
    known: &'a Floors,
    revoked: Option<&'a Revoked>,
}

/// The new database at `staging`: the copy, migrated, raised and checked.
async fn stage(
    copy: &VerifiedCopy,
    staging: &Path,
    before: Before<'_>,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    place(copy, staging)?;
    // One connection, closed before this goes on: a pool can still be
    // closing a connection when its `close` returns, and that connection
    // would leave a WAL beside the file.
    let mut conn = db::options(staging).connect().await?;
    let raised = async {
        db::MIGRATOR.run(&mut conn).await?;
        raise(&mut conn, copy, before, aside, now).await
    }
    .await;
    let closed = conn.close().await;
    let raised = raised?;
    closed?;
    settle(staging).await?;
    sync_file(staging)?;
    check_staged(staging, &raised).await?;
    Ok(raised)
}

/// No `-wal` or `-shm` may stay beside the new database: they belong to its
/// file name, so they could not follow it into `host.db`.
async fn settle(staging: &Path) -> Result<(), BoxError> {
    let [_, wal, shm] = database_files(staging);
    for _ in 0..5 {
        if !wal.exists() && !shm.exists() {
            return Ok(());
        }
        let mut conn = db::options(staging).connect().await?;
        let _ = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&mut conn)
            .await;
        conn.close().await?;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if wal.exists() || shm.exists() {
        return Err("the new database did not close cleanly".into());
    }
    Ok(())
}

/// The new database is whole and holds what the restore wrote.
async fn check_staged(staging: &Path, raised: &Raised) -> Result<(), BoxError> {
    verify_database(staging)
        .await
        .map_err(|failure| format!("the new database does not check out: {}", failure.detail))?;
    let mut conn = open_read_only(staging, true).connect().await?;
    let found: Result<(Option<String>, i64), sqlx::Error> = sqlx::query_as(
        "SELECT (SELECT restore_epoch FROM site WHERE id = 1), (SELECT rev FROM host_revision WHERE id = 1)",
    )
    .fetch_one(&mut conn)
    .await;
    let _ = conn.close().await;
    let (epoch, revision) = found?;
    if epoch.as_deref() != Some(raised.epoch.as_str()) || revision != raised.revision {
        return Err("the new database does not hold what the restore wrote".into());
    }
    Ok(())
}

struct Raised {
    epoch: String,
    revision: i64,
    counters: Vec<CounterRaise>,
    shift_numbers: Vec<ShiftNumberRaise>,
    carried: Option<Carried>,
    sessions_ended: u64,
    copy_made: String,
}

/// Lift the counters, carry the revocations, set the epoch and write the
/// audit row in one write transaction on `conn`, rolled back on any failure.
/// No change stream listens to a restore, so it commits without one.
async fn raise(
    conn: &mut SqliteConnection,
    copy: &VerifiedCopy,
    before: Before<'_>,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    match raise_in(&mut tx, copy, before, aside, now).await {
        Ok(raised) => {
            tx.commit().await?;
            Ok(raised)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}

/// The audit sequence after a restore: above every id either database
/// issued, and far above the copy's when the current one is not the copy's
/// known history.
fn audit_floor(history_known: bool, copy: Option<i64>, known: Option<i64>) -> i64 {
    let copy = copy.unwrap_or(0);
    let known = copy.max(known.unwrap_or(0));
    if history_known {
        known
    } else {
        known.max(copy + UNREADABLE_CURRENT_MARGIN)
    }
}

/// The lowest counter of a prefix and extension after a restore that did
/// not read the current database: [`UNREAD_SSCC_MARGIN`] above the copy's
/// highest number, rounded up to [`UNREAD_SSCC_ROUNDING`].
fn unread_sscc_floor(copy_floor: i64) -> i64 {
    let raised = copy_floor + UNREAD_SSCC_MARGIN;
    (raised + UNREAD_SSCC_ROUNDING - 1) / UNREAD_SSCC_ROUNDING * UNREAD_SSCC_ROUNDING
}

/// Carry the current database's revocations into the restored one, at
/// `rev`: only toward revoked, and only for records the copy has.
async fn carry_revocations(
    tx: &mut SqliteConnection,
    revoked: &Revoked,
    rev: i64,
) -> Result<Carried, sqlx::Error> {
    let mut carried = Carried::default();
    for (id, at) in &revoked.devices {
        carried.devices +=
            sqlx::query("UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
                .bind(at)
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
    }
    for id in &revoked.operators {
        let turned_off =
            sqlx::query("UPDATE operators SET active = 0, rev = ?1 WHERE id = ?2 AND active = 1")
                .bind(rev)
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        if turned_off > 0 {
            // Access leaves the feed as a tombstone, never as a flag.
            feed::remove(&mut *tx, entities::OPERATORS, id, rev).await?;
            carried.operators += turned_off;
        }
    }
    for (id, at) in &revoked.badges {
        let revoked_now = sqlx::query(
            "UPDATE operator_badges SET revoked_at = ?1, rev = ?2 WHERE id = ?3 AND revoked_at IS NULL",
        )
        .bind(at)
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if revoked_now > 0 {
            feed::remove(&mut *tx, entities::OPERATOR_BADGES, id, rev).await?;
            carried.badges += revoked_now;
        }
    }
    for id in &revoked.office_users {
        carried.office_users += sqlx::query(
            "UPDATE office_users SET active = 0, rev = ?1 WHERE id = ?2 AND active = 1",
        )
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    Ok(carried)
}

async fn raise_in(
    tx: &mut SqliteConnection,
    copy: &VerifiedCopy,
    before: Before<'_>,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    let Before {
        current,
        history_known,
        known,
        revoked,
    } = before;
    let at = format_timestamp(now);
    let copy_floors = read_floors(&mut *tx).await?;
    let copy_counters: BTreeMap<(String, i64), i64> = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT issuer_prefix, extension, next_serial FROM sscc_counters",
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(prefix, extension, next)| ((prefix, extension), next))
    .collect();
    let copy_shift_numbers: BTreeMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>("SELECT month_key, last_seq FROM shift_number_counters")
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let (box_size, pallet_size): (i64, i64) =
        sqlx::query_as("SELECT box_block_size, pallet_block_size FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await?;
    // When the copy was made: its manifest says, or (without one) its own
    // newest audit row, read before the restore's row is written. Data, not
    // the clock.
    let newest: Option<String> = sqlx::query_scalar("SELECT max(at) FROM audit_log")
        .fetch_one(&mut *tx)
        .await?;
    let copy_made = copy
        .manifest
        .as_ref()
        .and_then(|manifest| parse_timestamp(&manifest.created_at).ok())
        .or_else(|| newest.as_deref().and_then(|at| parse_timestamp(at).ok()))
        .unwrap_or(now);
    // The copy's next revision, below what the current database reached: a
    // station that saw a later one sees the host go back (`rev < since`) and
    // starts its copies again from zero.
    let revision = db::next_revision(&mut *tx).await?;
    // The audit row's own id is the next one: above every id either database
    // issued.
    let audit_sequence = audit_floor(
        history_known,
        copy_floors.audit_sequence,
        known.audit_sequence,
    );
    let moved = sqlx::query("UPDATE sqlite_sequence SET seq = ?1 WHERE name = 'audit_log'")
        .bind(audit_sequence)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if moved == 0 {
        sqlx::query("INSERT INTO sqlite_sequence (name, seq) VALUES ('audit_log', ?1)")
            .bind(audit_sequence)
            .execute(&mut *tx)
            .await?;
    }
    let keys: BTreeSet<&(String, i64)> = copy_floors
        .counters
        .keys()
        .chain(known.counters.keys())
        .collect();
    let mut counters = Vec::new();
    for key in keys {
        let (prefix, extension) = key;
        let copy_floor = copy_floors.counters.get(key).copied();
        let floor = copy_floor
            .max(known.counters.get(key).copied())
            .unwrap_or(0);
        let size = if *extension == 0 {
            box_size
        } else {
            pallet_size
        };
        let capacity = i64::try_from(crate::validate::serial_capacity(prefix))?;
        let mut to = floor + SSCC_MARGIN_BLOCKS * size;
        if !history_known {
            to = to.max(unread_sscc_floor(copy_floor.unwrap_or(0)));
        }
        let to = to.min(capacity);
        let from = copy_counters.get(key).copied();
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT (issuer_prefix, extension) DO UPDATE SET next_serial = ?3, rev = ?4",
        )
        .bind(prefix)
        .bind(extension)
        .bind(to)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
        counters.push(CounterRaise {
            issuer_prefix: prefix.clone(),
            extension: *extension,
            from,
            to,
        });
    }
    let mut months: BTreeSet<String> = copy_floors
        .shift_numbers
        .keys()
        .chain(known.shift_numbers.keys())
        .cloned()
        .collect();
    // A shift numbered after the copy may be of the copy's month or any
    // later one; a day either side keeps a time zone off UTC covered. The
    // later end is the later of the copy's time and the restore's, so a
    // clock that is set back cannot leave months out.
    let first = copy_made
        .checked_sub(time::Duration::days(1))
        .unwrap_or(copy_made);
    let last = copy_made.max(now);
    let last = last.checked_add(time::Duration::days(1)).unwrap_or(last);
    months.extend(months_between(first.date(), last.date()));
    let mut shift_numbers = Vec::new();
    for month_key in months {
        let from = copy_shift_numbers.get(&month_key).copied();
        let base = copy_floors
            .shift_numbers
            .get(&month_key)
            .copied()
            .max(known.shift_numbers.get(&month_key).copied())
            .unwrap_or(0);
        let to = base + SHIFT_NUMBER_MARGIN;
        sqlx::query(
            "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?1, ?2) \
             ON CONFLICT (month_key) DO UPDATE SET last_seq = ?2",
        )
        .bind(&month_key)
        .bind(to)
        .execute(&mut *tx)
        .await?;
        shift_numbers.push(ShiftNumberRaise {
            month_key,
            from,
            to,
        });
    }
    let carried = match revoked {
        Some(revoked) => Some(carry_revocations(&mut *tx, revoked, revision).await?),
        None => None,
    };
    // A session logged out after the copy would be valid again: everyone
    // signs in again.
    let sessions_ended = sqlx::query("DELETE FROM office_sessions")
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let epoch = uuid::Uuid::new_v4().to_string();
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = ? WHERE id = 1")
        .bind(&epoch)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    let file = copy
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    audit::record(
        &mut *tx,
        &at,
        Entry {
            actor: Actor::System,
            action: actions::HOST_RESTORE,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "file": file,
                "sha256": copy.sha256,
                "copyCreatedAt": copy.manifest.as_ref().map(|manifest| manifest.created_at.clone()),
                "current": current.as_str(),
                "savedAs": aside.and_then(Path::file_name).map(|name| name.to_string_lossy().into_owned()),
                "epoch": epoch,
                "counters": counters.iter().map(|raise| json!({
                    "issuerPrefix": raise.issuer_prefix,
                    "extension": raise.extension,
                    "from": raise.from,
                    "to": raise.to,
                })).collect::<Vec<_>>(),
                "shiftNumbers": shift_numbers.iter().map(|raise| json!({
                    "monthKey": raise.month_key,
                    "from": raise.from,
                    "to": raise.to,
                })).collect::<Vec<_>>(),
                "carried": carried.map(|carried| json!({
                    "devices": carried.devices,
                    "operators": carried.operators,
                    "badges": carried.badges,
                    "officeUsers": carried.office_users,
                })),
                "sessionsEnded": sessions_ended,
            }),
        },
    )
    .await?;
    Ok(Raised {
        epoch,
        revision,
        counters,
        shift_numbers,
        carried,
        sessions_ended,
        copy_made: format_timestamp(copy_made),
    })
}

/// The lines `markiro-host restore` prints.
pub fn summary(report: &RestoreReport) -> Vec<String> {
    let made = report
        .copy
        .manifest
        .as_ref()
        .map_or("unknown", |manifest| manifest.created_at.as_str());
    let folded = if report.copy.wal_folded {
        ", its WAL folded in"
    } else {
        ""
    };
    let mut lines = vec![
        format!(
            "restored {} (sha256 {}, made {made}{folded})",
            report.copy.path.display(),
            report.copy.sha256
        ),
        format!("data folder: {}", report.data_dir.display()),
    ];
    if report.new_identity {
        lines.push(format!(
            "a new host identity was created in {}: every device pairs with this host again",
            report.data_dir.join("host.json").display()
        ));
    }
    match report.interrupted {
        Some(Interrupted::RolledBack) => lines.push(
            "an interrupted restore was found: the previous database was put back first".to_owned(),
        ),
        Some(Interrupted::Finished) => {
            lines.push("an interrupted restore was found: it had finished".to_owned());
        }
        None => {}
    }
    lines.push(match &report.saved_as {
        Some(dir) => format!("the previous database is in {}", dir.display()),
        None => "there was no previous database".to_owned(),
    });
    if report.current == Current::Unreadable {
        lines.push(format!(
            "the previous database could not be read: every SSCC counter is at least {UNREAD_SSCC_MARGIN} above the copy's highest number"
        ));
    }
    if report.current == Current::Read && !report.history_known {
        lines.push(format!(
            "the current database is not this copy's history (a new host, one whose wizard never finished, or another host's): every SSCC counter is at least {UNREAD_SSCC_MARGIN} above the copy's highest number"
        ));
    }
    lines.push(match report.carried {
        Some(carried) => format!(
            "revocations carried over from the previous database: {} devices, {} operators, {} badges, {} office users",
            carried.devices, carried.operators, carried.badges, carried.office_users
        ),
        None => format!(
            "the previous database was not read: devices, operators, badges and office users revoked after {} are active again: check them in the office",
            report.copy_made
        ),
    });
    lines.push("every office session was ended: everyone signs in to the office again".to_owned());
    let or_dash = |value: Option<i64>| value.map_or("-".to_owned(), |value| value.to_string());
    for raise in &report.counters {
        lines.push(format!(
            "SSCC {}/{}: {} -> {}",
            raise.issuer_prefix,
            raise.extension,
            or_dash(raise.from),
            raise.to
        ));
    }
    for raise in &report.shift_numbers {
        lines.push(format!(
            "shift numbers {}: {} -> {}",
            raise.month_key,
            or_dash(raise.from),
            raise.to
        ));
    }
    if report.other_host {
        lines.push(
            "the copy was made by another host: the stations pair with this one again".to_owned(),
        );
    }
    lines.push(format!(
        "restore epoch {}: the stations do not register their SSCC blocks again yet; follow the runbook before they print new boxes",
        report.epoch
    ));
    lines.push(
        "the stations' facts wait: resume them in the office (Резервные копии) once the runbook's checks are done"
            .to_owned(),
    );
    lines.push("start the host again: sc start MarkiroHost".to_owned());
    lines
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    async fn memory() -> SqliteConnection {
        SqliteConnection::connect("sqlite::memory:").await.unwrap()
    }

    async fn run(conn: &mut SqliteConnection, statements: &[&str]) {
        for statement in statements {
            sqlx::query(statement).execute(&mut *conn).await.unwrap();
        }
    }

    /// The tables the floors read, without their constraints.
    const SCHEMA: [&str; 8] = [
        "CREATE TABLE sscc_counters (issuer_prefix TEXT, extension INTEGER, next_serial INTEGER)",
        "CREATE TABLE sscc_blocks (id TEXT, issuer_prefix TEXT, extension INTEGER, to_serial INTEGER)",
        "CREATE TABLE boxes (block_id TEXT, serial INTEGER)",
        "CREATE TABLE pallets (block_id TEXT, serial INTEGER)",
        "CREATE TABLE shift_number_counters (month_key TEXT, last_seq INTEGER)",
        "CREATE TABLE shifts (number_month_key TEXT, number_seq INTEGER)",
        "CREATE TABLE host_revision (id INTEGER, rev INTEGER)",
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT)",
    ];

    fn key(prefix: &str, extension: i64) -> (String, i64) {
        (prefix.to_owned(), extension)
    }

    #[tokio::test]
    async fn every_number_a_database_issued_is_a_floor_whatever_the_counter_says() {
        let mut conn = memory().await;
        run(&mut conn, &SCHEMA).await;
        run(
            &mut conn,
            &[
                // The counters lag: the block ends, a box and a pallet are
                // further on.
                "INSERT INTO sscc_counters VALUES ('4600682', 0, 10), ('4600682', 1, 5), ('1234567', 0, 7), ('1234567', 1, 3)",
                "INSERT INTO sscc_blocks VALUES ('a', '4600682', 0, 99), ('b', '4600682', 0, 499), ('c', '1234567', 1, 1049), ('d', '1234567', 0, 20)",
                "INSERT INTO boxes VALUES ('a', 700), ('a', 650), ('d', 9), ('a', NULL)",
                "INSERT INTO pallets VALUES ('c', 2999), ('c', 12)",
                "INSERT INTO shift_number_counters VALUES ('OCT26', 3)",
                "INSERT INTO shifts VALUES ('OCT26', 8), ('OCT26', 5), ('NOV26', 2)",
                "INSERT INTO host_revision VALUES (1, 4242)",
                "INSERT INTO audit_log (at) VALUES ('a'), ('b'), ('c'), ('d')",
                // Rows deleted, the sequence stays: 4 was issued.
                "DELETE FROM audit_log WHERE id > 2",
            ],
        )
        .await;

        let floors = read_floors(&mut conn).await.unwrap();

        assert_eq!(
            floors.counters,
            BTreeMap::from([
                (key("4600682", 0), 701),
                (key("4600682", 1), 5),
                (key("1234567", 0), 21),
                (key("1234567", 1), 3000),
            ])
        );
        assert_eq!(
            floors.shift_numbers,
            BTreeMap::from([("NOV26".to_owned(), 2), ("OCT26".to_owned(), 8)])
        );
        assert_eq!(floors.audit_sequence, Some(4));
    }

    #[tokio::test]
    async fn the_audit_ids_still_there_count_when_the_sequence_is_not() {
        let mut conn = memory().await;
        run(&mut conn, &SCHEMA).await;
        run(
            &mut conn,
            &[
                "INSERT INTO audit_log (id, at) VALUES (31, 'a')",
                "DELETE FROM sqlite_sequence WHERE name = 'audit_log'",
            ],
        )
        .await;
        let floors = read_floors(&mut conn).await.unwrap();
        assert_eq!(floors.audit_sequence, Some(31));
    }

    #[tokio::test]
    async fn a_database_older_than_this_build_is_read_for_what_it_has() {
        let mut conn = memory().await;
        run(
            &mut conn,
            &[
                "CREATE TABLE sscc_counters (issuer_prefix TEXT, extension INTEGER, next_serial INTEGER)",
                "INSERT INTO sscc_counters VALUES ('4600682', 0, 10)",
                "CREATE TABLE devices (id TEXT, revoked_at TEXT)",
                "INSERT INTO devices VALUES ('d1', NULL), ('d2', '2026-10-01T00:00:00Z')",
            ],
        )
        .await;
        let floors = read_floors(&mut conn).await.unwrap();
        assert_eq!(floors.counters, BTreeMap::from([(key("4600682", 0), 10)]));
        assert_eq!(floors.audit_sequence, None);
        assert!(floors.shift_numbers.is_empty());
        let revoked = read_revoked(&mut conn).await.unwrap();
        assert_eq!(
            revoked.devices,
            [("d2".to_owned(), "2026-10-01T00:00:00Z".to_owned())]
        );
        assert!(revoked.operators.is_empty() && revoked.badges.is_empty());
        assert!(revoked.office_users.is_empty());
    }

    #[test]
    fn the_numbers_of_two_databases_merge_to_the_higher_of_each() {
        let mut floors = Floors {
            counters: BTreeMap::from([(key("4600682", 0), 10), (key("4600682", 1), 50)]),
            shift_numbers: BTreeMap::from([("OCT26".to_owned(), 4)]),
            audit_sequence: Some(9),
        };
        floors.merge(Floors {
            counters: BTreeMap::from([(key("4600682", 0), 30), (key("4600682", 1), 5)]),
            shift_numbers: BTreeMap::from([("OCT26".to_owned(), 2), ("NOV26".to_owned(), 1)]),
            audit_sequence: Some(12),
        });
        assert_eq!(
            floors.counters,
            BTreeMap::from([(key("4600682", 0), 30), (key("4600682", 1), 50)])
        );
        assert_eq!(
            floors.shift_numbers,
            BTreeMap::from([("NOV26".to_owned(), 1), ("OCT26".to_owned(), 4)])
        );
        assert_eq!(floors.audit_sequence, Some(12));
        floors.merge(Floors::default());
        assert_eq!(floors.audit_sequence, Some(12));
    }

    #[test]
    fn months_run_from_the_first_to_the_last_both_included() {
        let date = |text: &str| {
            time::Date::parse(text, &time::format_description::well_known::Iso8601::DATE).unwrap()
        };
        assert_eq!(
            months_between(date("2026-11-30"), date("2027-02-01")),
            ["NOV26", "DEC26", "JAN27", "FEB27"]
        );
        assert_eq!(
            months_between(date("2026-09-30"), date("2026-09-30")),
            ["SEP26"]
        );
        assert!(months_between(date("2026-10-01"), date("2026-09-30")).is_empty());
    }

    #[test]
    fn an_audit_id_is_above_both_databases_or_far_above_the_copy_when_the_other_is_unknown() {
        assert_eq!(audit_floor(true, Some(10), Some(25)), 25);
        assert_eq!(audit_floor(true, Some(40), Some(25)), 40);
        assert_eq!(audit_floor(true, None, None), 0);
        assert_eq!(
            audit_floor(false, Some(40), None),
            40 + UNREADABLE_CURRENT_MARGIN
        );
        assert_eq!(
            audit_floor(false, Some(40), Some(2_000_000)),
            2_000_000,
            "a database set aside that issued more counts"
        );
    }

    #[test]
    fn a_counter_the_current_database_did_not_tell_is_far_above_the_copy_in_round_numbers() {
        assert_eq!(unread_sscc_floor(0), 100_000);
        assert_eq!(unread_sscc_floor(1), 110_000);
        assert_eq!(unread_sscc_floor(1500), 110_000);
        assert_eq!(unread_sscc_floor(10_000), 110_000);
        assert_eq!(unread_sscc_floor(10_001), 120_000);
    }

    #[tokio::test]
    async fn a_read_that_fails_for_a_moment_is_tried_again_before_it_counts() {
        let calls = Cell::new(0);
        let flaky = with_retries(4, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            let call = calls.get();
            async move {
                if call < 3 {
                    Err(sqlx::Error::PoolTimedOut)
                } else {
                    Ok(call)
                }
            }
        })
        .await;
        assert_eq!(flaky.unwrap(), 3);

        calls.set(0);
        let hopeless: Result<(), sqlx::Error> = with_retries(4, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            async { Err(sqlx::Error::PoolTimedOut) }
        })
        .await;
        assert!(hopeless.is_err());
        assert_eq!(calls.get(), 4, "tried the given number of times");
        assert_eq!(READ_ATTEMPTS, 4);
    }

    #[test]
    fn a_rename_is_tried_again_unless_the_file_is_not_there() {
        let calls = Cell::new(0);
        let flaky = retrying(5, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            if calls.get() < 3 {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                Ok(calls.get())
            }
        });
        assert_eq!(flaky.unwrap(), 3);

        calls.set(0);
        let hopeless: std::io::Result<()> = retrying(4, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        assert_eq!(
            hopeless.unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert_eq!(calls.get(), 4, "tried the given number of times");

        calls.set(0);
        let missing: std::io::Result<()> = retrying(4, Duration::ZERO, || {
            calls.set(calls.get() + 1);
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        });
        assert!(missing.is_err());
        assert_eq!(calls.get(), 1, "a file that is not there is not waited for");
    }

    /// A data folder with a database, its WAL and shared memory.
    fn folder_with_a_database() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("host.db");
        for (suffix, bytes) in [
            ("", "the database"),
            ("-wal", "its wal"),
            ("-shm", "its shm"),
        ] {
            fs::write(dir.path().join(format!("host.db{suffix}")), bytes).unwrap();
        }
        (dir, db)
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_new_database_takes_the_place_and_the_old_files_are_kept_aside() {
        let (dir, db) = folder_with_a_database();
        let staging = partial_path(&db);
        fs::write(&staging, "the new database").unwrap();
        let aside = dir.path().join("restore-1");

        swap(&db, &staging, Some(&aside), Duration::ZERO, None)
            .unwrap_or_else(|f| panic!("{}", f.cause));

        assert_eq!(read(&db), "the new database");
        assert!(!staging.exists());
        assert!(!dir.path().join("host.db-wal").exists());
        assert!(!dir.path().join("host.db-shm").exists());
        assert_eq!(read(&aside.join("host.db")), "the database");
        assert_eq!(read(&aside.join("host.db-wal")), "its wal");
        assert_eq!(read(&aside.join("host.db-shm")), "its shm");
    }

    #[test]
    fn a_swap_that_fails_puts_every_file_of_the_old_database_back() {
        let (dir, db) = folder_with_a_database();
        // The new database is missing: the last rename fails, after the three
        // files of the old one were moved.
        let staging = partial_path(&db);
        let aside = dir.path().join("restore-1");

        let Err(failure) = swap(&db, &staging, Some(&aside), Duration::ZERO, None) else {
            panic!("the swap fails");
        };

        assert!(failure.stranded.is_empty() && !failure.crashed);
        assert_eq!(read(&db), "the database");
        assert_eq!(read(&dir.path().join("host.db-wal")), "its wal");
        assert_eq!(read(&dir.path().join("host.db-shm")), "its shm");
        assert!(!aside.exists(), "the empty aside folder is removed");
    }

    #[test]
    fn a_swap_cut_off_leaves_the_files_where_they_were_when_the_power_went() {
        let (dir, db) = folder_with_a_database();
        let staging = partial_path(&db);
        fs::write(&staging, "the new database").unwrap();
        let aside = dir.path().join("restore-1");

        let Err(failure) = swap(
            &db,
            &staging,
            Some(&aside),
            Duration::ZERO,
            Some(CrashPoint::WalAside),
        ) else {
            panic!("cut off");
        };

        assert!(failure.crashed);
        assert_eq!(read(&aside.join("host.db-wal")), "its wal");
        assert_eq!(read(&db), "the database", "nothing was undone");
        assert!(dir.path().join("host.db-shm").exists());
        assert!(staging.exists());
    }

    #[test]
    fn a_swap_beside_a_folder_that_is_there_fails_before_it_moves_anything() {
        let (dir, db) = folder_with_a_database();
        let staging = partial_path(&db);
        fs::write(&staging, "the new database").unwrap();
        let aside = dir.path().join("restore-1");
        fs::create_dir(&aside).unwrap();

        assert!(swap(&db, &staging, Some(&aside), Duration::ZERO, None).is_err());

        assert_eq!(read(&db), "the database");
        assert_eq!(read(&staging), "the new database");
        assert!(
            aside.exists(),
            "a folder that was there is not ours to remove"
        );
    }

    #[test]
    fn a_swap_with_nothing_to_keep_is_a_rename() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("host.db");
        let staging = partial_path(&db);
        fs::write(&staging, "the new database").unwrap();
        swap(&db, &staging, None, Duration::ZERO, None).unwrap_or_else(|f| panic!("{}", f.cause));
        assert_eq!(read(&db), "the new database");
    }

    #[test]
    fn put_back_returns_what_is_missing_and_refuses_two_databases() {
        let (dir, db) = folder_with_a_database();
        let aside = dir.path().join("restore-1");
        fs::create_dir(&aside).unwrap();
        fs::rename(dir.path().join("host.db-wal"), aside.join("host.db-wal")).unwrap();
        fs::write(aside.join("host.db-shm"), "an older shm").unwrap();

        put_back(&db, &aside).unwrap();

        assert_eq!(read(&dir.path().join("host.db-wal")), "its wal");
        assert_eq!(
            read(&dir.path().join("host.db-shm")),
            "its shm",
            "the data folder's shm stays"
        );
        assert!(!aside.exists(), "the emptied folder is removed");

        fs::create_dir(&aside).unwrap();
        fs::write(aside.join("host.db"), "another database").unwrap();
        let error = put_back(&db, &aside).unwrap_err().to_string();
        assert!(error.contains("call support"), "{error}");
        assert_eq!(read(&db), "the database");
        assert_eq!(read(&aside.join("host.db")), "another database");
    }

    #[test]
    fn a_marker_names_an_aside_folder_of_the_data_folder_and_nothing_else() {
        let paths = HostPaths::new("/data");
        assert_eq!(
            aside_named(&paths, "restore-20261009T150000Z").unwrap(),
            PathBuf::from("/data/restore-20261009T150000Z")
        );
        for name in [
            "../restore-1",
            "restore-1/../../etc",
            "backups",
            "/restore-1",
            "",
        ] {
            assert!(aside_named(&paths, name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_marker_is_written_whole_and_the_host_refuses_to_start_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = HostPaths::new(dir.path());
        refuse_unfinished(&paths).unwrap();
        let intent = Intent {
            format: INTENT_FORMAT,
            step: "swap".to_owned(),
            aside: Some("restore-1".to_owned()),
            staging: "host.db.partial".to_owned(),
            epoch: "e".to_owned(),
            started_at: "2026-10-09T15:00:00Z".to_owned(),
        };

        write_intent(&paths, &intent).unwrap();

        let written: Intent =
            serde_json::from_slice(&fs::read(paths.restore_intent_file()).unwrap()).unwrap();
        assert_eq!(written, intent);
        assert!(!partial_path(&paths.restore_intent_file()).exists());
        let error = refuse_unfinished(&paths).unwrap_err().to_string();
        assert!(error.contains("markiro-host restore"), "{error}");
        remove_intent(&paths).unwrap();
        refuse_unfinished(&paths).unwrap();
    }

    fn verified(path: &Path) -> VerifiedCopy {
        let (size_bytes, sha256) = sha256_file(path).unwrap();
        VerifiedCopy {
            path: path.to_path_buf(),
            size_bytes,
            sha256: sha256.clone(),
            manifest: None,
            schema_version: 1,
            wal_folded: false,
            staged: Arc::new(Source {
                path: path.to_path_buf(),
                size_bytes,
                sha256,
                _folder: None,
            }),
        }
    }

    #[test]
    fn a_copy_that_changed_after_it_was_checked_is_not_put_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("copy.db");
        fs::write(&source, "a copy of 17 bytes").unwrap();
        let checked = verified(&source);
        let staging = dir.path().join("host.db.partial");
        place(&checked, &staging).unwrap();
        assert_eq!(read(&staging), "a copy of 17 bytes");

        // Same size, other bytes: only the SHA-256 notices.
        fs::write(&source, "a copy of 71 bytes").unwrap();
        let error = place(&checked, &staging).unwrap_err().to_string();
        assert!(error.contains("changed while"), "{error}");
        fs::write(&source, "shorter").unwrap();
        assert!(place(&checked, &staging).is_err());
    }

    #[test]
    fn the_wal_leaves_before_the_database_it_belongs_to() {
        assert_eq!(
            leaving_order(Path::new("/data/host.db")),
            [
                PathBuf::from("/data/host.db-wal"),
                PathBuf::from("/data/host.db-shm"),
                PathBuf::from("/data/host.db"),
            ]
        );
    }

    #[test]
    fn the_margins_are_the_documented_ones() {
        assert_eq!(SSCC_MARGIN_BLOCKS, 2);
        assert_eq!(SHIFT_NUMBER_MARGIN, 10);
        assert_eq!(UNREAD_SSCC_MARGIN, 100_000);
        assert_eq!(UNREAD_SSCC_ROUNDING, 10_000);
        assert_eq!(UNREADABLE_CURRENT_MARGIN, 1_000_000);
    }

    #[tokio::test]
    async fn the_new_database_is_checked_for_what_the_restore_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("host.db.partial");
        let pool = db::open(&staging).await.unwrap();
        sqlx::query("UPDATE site SET restore_epoch = 'epoch-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE host_revision SET rev = 77")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let wanted = |epoch: &str, revision: i64| Raised {
            epoch: epoch.to_owned(),
            revision,
            counters: Vec::new(),
            shift_numbers: Vec::new(),
            carried: None,
            sessions_ended: 0,
            copy_made: String::new(),
        };
        // The pool's close may leave a WAL behind: settle as a restore does.
        settle(&staging).await.unwrap();

        check_staged(&staging, &wanted("epoch-1", 77))
            .await
            .unwrap();
        let wrong_epoch = check_staged(&staging, &wanted("epoch-2", 77)).await;
        assert!(wrong_epoch.is_err());
        let wrong_revision = check_staged(&staging, &wanted("epoch-1", 78)).await;
        assert!(wrong_revision.is_err());
        fs::write(&staging, b"not a database").unwrap();
        assert!(check_staged(&staging, &wanted("epoch-1", 77))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn the_new_database_is_settled_when_a_wal_stays_beside_it() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("host.db.partial");
        // A connection kept open keeps the WAL: settle cannot remove it, and
        // says so rather than let the file be renamed away from its WAL.
        let mut held = db::options(&staging)
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (a)")
            .execute(&mut held)
            .await
            .unwrap();
        let [_, wal, _] = database_files(&staging);
        assert!(wal.exists());
        assert!(settle(&staging).await.is_err());
        held.close().await.unwrap();
        settle(&staging).await.unwrap();
        assert!(!wal.exists());
    }
}
