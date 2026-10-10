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
//!    wizard) before it touches the data folder at all;
//! 2. takes the data folder's lock (the service holds it while it runs) and
//!    reads what the current database knew, if it still opens: each SSCC
//!    counter (and the end of each block and the serial of each box and
//!    pallet), each month's shift number, the revision and the audit
//!    sequence;
//! 3. builds the new database BESIDE the current one (`host.db.partial`):
//!    the copy, checked again after it was copied, migrated forward by this
//!    build's migrations (a copy of an older version works), and in one
//!    transaction
//!    * every SSCC counter raised above both databases by two block sizes of
//!      its extension (never past the prefix's last serial),
//!    * every month's shift number raised by 10 above both, from the copy's
//!      month to the current one,
//!    * the revision raised above both (a station keeps a record only if
//!      its revision is newer than the one it holds) and the audit
//!      sequence raised above both,
//!    * a new `site.restore_epoch`, which `hello` reports so stations
//!      register their blocks again, the stations' facts held
//!      (`site.facts_held_since`) until an administrator resumes them, and
//!      one `host.restore` audit row;
//!    then checked once more (`integrity_check`, the epoch and the revision);
//! 4. swaps: the current database's files go into `restore-<time>/` in the
//!    data folder (never deleted) and the new database is renamed into place.
//!    The folder never lacks a database for longer than those renames, and a
//!    rename that fails puts the current files back.
//!
//! Nothing is written to the current database or its folder before step 4,
//! so a failure anywhere before it leaves the data folder exactly as it was.
//! When the current database cannot be read the revision, the audit sequence
//! and the SSCC counters rise by a margin only
//! ([`UNREADABLE_CURRENT_MARGIN`], [`SSCC_MARGIN_BLOCKS`]); the stations'
//! own blocks, registered again, close the rest.
//!
//! No clock decides a number: every floor comes from the data. The time
//! only names the aside folder and the audit row, and bounds the months for
//! which a shift number counter is made.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

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
use crate::db;
use crate::BoxError;

/// How far a restore lifts each SSCC counter: this many blocks of its
/// extension's size above the highest serial either database knew.
pub const SSCC_MARGIN_BLOCKS: i64 = 2;
/// How far a restore lifts each month's shift number.
pub const SHIFT_NUMBER_MARGIN: i64 = 10;
/// How far the revision and the audit sequence rise above the copy's when
/// the current database could not be read (or there was none under an
/// identity the stations know): the copy is at most a day older than the
/// data it replaces and a revision is one per changing transaction, so a
/// million is far more than any station can have seen.
pub const UNREADABLE_CURRENT_MARGIN: i64 = 1_000_000;
/// How often a rename that fails is tried again (a virus scanner on
/// Windows may hold a file for a moment).
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(300);

/// A copy that checked out.
#[derive(Debug, Clone)]
pub struct VerifiedCopy {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    /// `None` with `--without-manifest`.
    pub manifest: Option<Manifest>,
    pub schema_version: i64,
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
    /// It opened and was read: its counters count too.
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

#[derive(Debug, Clone)]
pub struct RestoreReport {
    pub copy: VerifiedCopy,
    pub current: Current,
    /// Where the current database went; `None` when there was none.
    pub saved_as: Option<PathBuf>,
    pub epoch: String,
    pub counters: Vec<CounterRaise>,
    pub shift_numbers: Vec<ShiftNumberRaise>,
    /// The copy was made by another host than the one of this data folder
    /// (a new computer): the stations pair with this host again.
    pub other_host: bool,
    /// The host's revision after the restore.
    pub revision: i64,
}

fn open_read_only(path: &Path, immutable: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(immutable)
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
    let mut conn = open_read_only(path, true).connect().await?;
    let checked = check_copy(&mut conn).await;
    let _ = conn.close().await;
    let schema_version = checked?;
    Ok(VerifiedCopy {
        path: path.to_path_buf(),
        size_bytes,
        sha256,
        manifest,
        schema_version,
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
/// (the counter's or the highest number a shift holds), its revision and its
/// audit sequence.
#[derive(Debug, Default, Clone)]
struct Floors {
    counters: BTreeMap<(String, i64), i64>,
    shift_numbers: BTreeMap<String, i64>,
    revision: Option<i64>,
    audit_sequence: Option<i64>,
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

async fn read_floors(conn: &mut SqliteConnection) -> Result<Floors, sqlx::Error> {
    let tables: BTreeSet<String> =
        sqlx::query_scalar::<_, String>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
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
    if tables.contains("host_revision") {
        floors.revision = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?;
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

/// The current database's floors, if it opens read-only and reads. A
/// stopped host may leave its WAL behind, with the last commits in it: a
/// read-only connection that is not immutable reads them. The `-wal` and
/// `-shm` files that connection creates where there were none are removed
/// again, so the folder is left as it was found.
async fn current_floors(path: &Path) -> (Current, Floors) {
    if !path.exists() {
        return (Current::Absent, Floors::default());
    }
    let [_, wal, shm] = database_files(path);
    let (had_wal, had_shm) = (wal.exists(), shm.exists());
    let read = async {
        let mut conn = open_read_only(path, false).connect().await?;
        let floors = read_floors(&mut conn).await;
        let _ = conn.close().await;
        floors
    }
    .await;
    if !had_wal {
        let _ = fs::remove_file(&wal);
    }
    if !had_shm {
        let _ = fs::remove_file(&shm);
    }
    match read {
        Ok(floors) => (Current::Read, floors),
        Err(error) => {
            tracing::warn!(%error, "the current database could not be read");
            (Current::Unreadable, Floors::default())
        }
    }
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

/// Everything a half-built new database can leave beside `host.db`.
fn remove_staging(staging: &Path) {
    for file in database_files(staging) {
        let _ = fs::remove_file(&file);
    }
    let mut journal = staging.as_os_str().to_owned();
    journal.push("-journal");
    let _ = fs::remove_file(PathBuf::from(journal));
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

/// Make the renames of `dir` durable (Unix; Windows has no way to ask).
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Put `source` at `staging`: copied, synced, read back and compared with the
/// verified copy. (Owner-only on Unix, the folder's ACL on Windows.)
fn place(source: &VerifiedCopy, staging: &Path) -> Result<(), BoxError> {
    // Streamed into a file of its own, not `fs::copy`: a copy would carry the
    // source's attributes (a read-only flag from a flash drive) onto a file
    // the host must write to.
    let mut from = fs::File::open(&source.path)?;
    let mut to = create_private(staging, false)?;
    std::io::copy(&mut from, &mut to)?;
    to.sync_all()?;
    drop(to);
    let (size, sha256) = sha256_file(staging)?;
    if size != source.size_bytes || sha256 != source.sha256 {
        return Err("the copy changed while it was put in place".into());
    }
    Ok(())
}

/// The order the current database's files leave the folder in: the WAL and
/// the shared memory first, the database last. A WAL must never lie beside
/// a database it does not belong to, and a crash between two renames must
/// leave a database that can be opened (the old one, without its WAL) or none
/// at all (everything is in the aside folder), never a WAL without its
/// database in the place of the new one.
fn leaving_order(db: &Path) -> [PathBuf; 3] {
    let [file, wal, shm] = database_files(db);
    [wal, shm, file]
}

/// A swap that failed: why, and which files of the current database could not
/// be put back (none when it was undone).
struct SwapFailure {
    cause: String,
    stranded: Vec<String>,
}

/// Move the current database's files into `aside` and put `staging` in the
/// place of `db`. The WAL and shared memory go first, then the database:
/// a WAL must never lie beside a database it does not belong to, so the
/// database file is the last to leave and the new one the first to arrive,
/// and a crash between the renames leaves either the current database
/// without its WAL (usable, older) or no database and everything in `aside`.
/// A rename that fails moves everything back.
fn swap(
    db: &Path,
    staging: &Path,
    aside: Option<&Path>,
    delay: Duration,
) -> Result<(), SwapFailure> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut created = false;
    let result = (|| -> std::io::Result<()> {
        if let Some(aside) = aside {
            fs::create_dir(aside)?;
            created = true;
            for file in leaving_order(db) {
                if !file.exists() {
                    continue;
                }
                let target = aside.join(file.file_name().expect("a database file has a name"));
                rename_retrying(&file, &target, delay)?;
                moved.push((file, target));
            }
        }
        rename_retrying(staging, db, delay)
    })();
    let Err(error) = result else {
        return Ok(());
    };
    let mut stranded = Vec::new();
    for (original, target) in moved.iter().rev() {
        if let Err(back) = rename_retrying(target, original, delay) {
            stranded.push(format!("{}: {back}", target.display()));
        }
    }
    if stranded.is_empty() && created {
        if let Some(aside) = aside {
            let _ = fs::remove_dir(aside);
        }
    }
    Err(SwapFailure {
        cause: error.to_string(),
        stranded,
    })
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

/// Whether `copy` is one of the database files of `paths` itself.
fn is_own_database(copy: &Path, paths: &HostPaths) -> bool {
    let Ok(copy) = fs::canonicalize(copy) else {
        return false;
    };
    database_files(&paths.database_file())
        .iter()
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
    // The copy is checked before the data folder is touched at all.
    let copy = verify_copy(source, without_manifest)
        .await
        .map_err(untouched)?;
    paths.ensure().map_err(untouched)?;
    let lock = paths.lock().map_err(|error| match error {
        ConfigError::Locked { .. } => untouched(format!(
            "the host is running: {error}. Stop the service (sc stop MarkiroHost) and run the command again"
        )),
        other => untouched(other),
    })?;
    if is_own_database(&copy.path, paths) {
        return Err(untouched(format!(
            "{} is the host's own database, not a copy",
            copy.path.display()
        )));
    }
    // A data folder without host.json gets a new identity here, on purpose:
    // the restore of a new computer (the runbook says devices pair again).
    let config = HostConfig::load_or_create(paths, None).map_err(untouched)?;
    let db = paths.database_file();
    let staging = partial_path(&db);
    // What an earlier restore that was interrupted left.
    remove_staging(&staging);
    let (current, current_floors) = current_floors(&db).await;
    // A WAL beside no database would be read by the restored one: it goes
    // aside too.
    let leftovers = database_files(&db).iter().any(|file| file.exists());
    let aside = leftovers.then(|| aside_dir(paths, now));
    let staged = stage(
        &copy,
        &staging,
        current,
        &current_floors,
        aside.as_deref(),
        now,
    )
    .await;
    let raised = match staged {
        Ok(raised) => raised,
        Err(error) => {
            remove_staging(&staging);
            return Err(untouched(error));
        }
    };
    if let Err(failure) = swap(&db, &staging, aside.as_deref(), RENAME_RETRY_DELAY) {
        remove_staging(&staging);
        return Err(if failure.stranded.is_empty() {
            untouched(format!(
                "the new database could not be put in place: {}. The previous database was put back",
                failure.cause
            ))
        } else {
            format!(
                "the new database could not be put in place: {}. THE PREVIOUS DATABASE COULD NOT BE PUT BACK ({}): its files are in {}; move host.db (and host.db-wal, host.db-shm if there) from there back into {} before the service is started, or call support",
                failure.cause,
                failure.stranded.join("; "),
                aside.as_deref().map_or_else(String::new, |dir| dir.display().to_string()),
                paths.data_dir.display()
            )
            .into()
        });
    }
    sync_dir(&paths.data_dir);
    drop(lock);
    Ok(RestoreReport {
        other_host: other_host(&copy, &config),
        copy,
        current,
        saved_as: aside,
        epoch: raised.epoch,
        counters: raised.counters,
        shift_numbers: raised.shift_numbers,
        revision: raised.revision,
    })
}

/// The new database at `staging`: the copy, migrated, raised and checked.
async fn stage(
    copy: &VerifiedCopy,
    staging: &Path,
    current: Current,
    current_floors: &Floors,
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
        raise(&mut conn, copy, current, current_floors, aside, now).await
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
}

/// Lift the counters, set the epoch and write the audit row in one write
/// transaction on `conn`, rolled back on any failure. No change stream
/// listens to a restore, so it commits without one.
async fn raise(
    conn: &mut SqliteConnection,
    copy: &VerifiedCopy,
    current: Current,
    current_floors: &Floors,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    match raise_in(&mut tx, copy, current, current_floors, aside, now).await {
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

/// A value above both databases' `floor`s; above the copy's by the margin
/// only when the current database was not read.
fn above(current: Current, copy_floor: i64, current_floor: Option<i64>, step: i64) -> i64 {
    match current {
        Current::Read => copy_floor.max(current_floor.unwrap_or(0)) + step,
        Current::Unreadable | Current::Absent => copy_floor + UNREADABLE_CURRENT_MARGIN,
    }
}

async fn raise_in(
    tx: &mut SqliteConnection,
    copy: &VerifiedCopy,
    current: Current,
    current_floors: &Floors,
    aside: Option<&Path>,
    now: OffsetDateTime,
) -> Result<Raised, BoxError> {
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
    // Every revision a station can hold stays below the new one, or the
    // station would keep what it has instead of what the host says.
    let revision = above(
        current,
        copy_floors.revision.unwrap_or(0),
        current_floors.revision,
        1,
    );
    sqlx::query("UPDATE host_revision SET rev = ?1 WHERE id = 1")
        .bind(revision)
        .execute(&mut *tx)
        .await?;
    // The audit row's own id is the next one: above every id either database
    // issued.
    let audit_sequence = above(
        current,
        copy_floors.audit_sequence.unwrap_or(0),
        current_floors.audit_sequence,
        0,
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
        .chain(current_floors.counters.keys())
        .collect();
    let mut counters = Vec::new();
    for key in keys {
        let (prefix, extension) = key;
        let floor = copy_floors
            .counters
            .get(key)
            .copied()
            .max(current_floors.counters.get(key).copied())
            .unwrap_or(0);
        let size = if *extension == 0 {
            box_size
        } else {
            pallet_size
        };
        let capacity = i64::try_from(crate::validate::serial_capacity(prefix))?;
        let to = (floor + SSCC_MARGIN_BLOCKS * size).min(capacity);
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
    let copy_made = copy
        .manifest
        .as_ref()
        .and_then(|manifest| parse_timestamp(&manifest.created_at).ok())
        .unwrap_or(now);
    let mut months: BTreeSet<String> = copy_floors
        .shift_numbers
        .keys()
        .chain(current_floors.shift_numbers.keys())
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
            .max(current_floors.shift_numbers.get(&month_key).copied())
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
            }),
        },
    )
    .await?;
    Ok(Raised {
        epoch,
        revision,
        counters,
        shift_numbers,
    })
}

/// The lines `markiro-host restore` prints.
pub fn summary(report: &RestoreReport) -> Vec<String> {
    let made = report
        .copy
        .manifest
        .as_ref()
        .map_or("unknown", |manifest| manifest.created_at.as_str());
    let mut lines = vec![format!(
        "restored {} (sha256 {}, made {made})",
        report.copy.path.display(),
        report.copy.sha256
    )];
    lines.push(match &report.saved_as {
        Some(dir) => format!("the previous database is in {}", dir.display()),
        None => "there was no previous database".to_owned(),
    });
    if report.current == Current::Unreadable {
        lines.push(
            "the previous database could not be read: SSCC counters rose by the margin only"
                .to_owned(),
        );
    }
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
        "restore epoch {}: stations register their SSCC blocks again when they connect",
        report.epoch
    ));
    lines.push(
        "the stations' facts wait: resume them in the office (Резервные копии) once every station gave its blocks back"
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
        assert_eq!(floors.revision, Some(4242));
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
                "CREATE TABLE host_revision (id INTEGER, rev INTEGER)",
                "INSERT INTO host_revision VALUES (1, 9)",
            ],
        )
        .await;
        let floors = read_floors(&mut conn).await.unwrap();
        assert_eq!(floors.counters, BTreeMap::from([(key("4600682", 0), 10)]));
        assert_eq!(floors.revision, Some(9));
        assert_eq!(floors.audit_sequence, None);
        assert!(floors.shift_numbers.is_empty());
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
    fn a_number_is_above_both_databases_or_far_above_the_copy_when_the_other_is_unknown() {
        assert_eq!(above(Current::Read, 10, Some(25), 1), 26);
        assert_eq!(above(Current::Read, 40, Some(25), 1), 41);
        assert_eq!(above(Current::Read, 40, None, 0), 40);
        assert_eq!(
            above(Current::Unreadable, 40, None, 1),
            40 + UNREADABLE_CURRENT_MARGIN
        );
        assert_eq!(
            above(Current::Absent, 40, None, 0),
            40 + UNREADABLE_CURRENT_MARGIN
        );
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

        swap(&db, &staging, Some(&aside), Duration::ZERO).unwrap_or_else(|f| panic!("{}", f.cause));

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

        let failure = swap(&db, &staging, Some(&aside), Duration::ZERO)
            .err()
            .expect("the swap fails");

        assert!(failure.stranded.is_empty());
        assert_eq!(read(&db), "the database");
        assert_eq!(read(&dir.path().join("host.db-wal")), "its wal");
        assert_eq!(read(&dir.path().join("host.db-shm")), "its shm");
        assert!(!aside.exists(), "the empty aside folder is removed");
    }

    #[test]
    fn a_swap_beside_a_folder_that_is_there_fails_before_it_moves_anything() {
        let (dir, db) = folder_with_a_database();
        let staging = partial_path(&db);
        fs::write(&staging, "the new database").unwrap();
        let aside = dir.path().join("restore-1");
        fs::create_dir(&aside).unwrap();

        assert!(swap(&db, &staging, Some(&aside), Duration::ZERO).is_err());

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
        swap(&db, &staging, None, Duration::ZERO).unwrap_or_else(|f| panic!("{}", f.cause));
        assert_eq!(read(&db), "the new database");
    }

    #[test]
    fn a_copy_that_changed_after_it_was_checked_is_not_put_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("copy.db");
        fs::write(&source, "a copy of 17 bytes").unwrap();
        let (size_bytes, sha256) = sha256_file(&source).unwrap();
        let checked = VerifiedCopy {
            path: source.clone(),
            size_bytes,
            sha256,
            manifest: None,
            schema_version: 1,
        };
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
