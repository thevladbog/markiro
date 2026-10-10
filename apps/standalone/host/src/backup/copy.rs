//! One copy of the master database: `VACUUM INTO` a `.partial` file while
//! the host runs, `PRAGMA integrity_check` on that file, its size and
//! SHA-256, then the database file and its manifest under their final
//! names. A reader of the database: it waits for no writer and a writer
//! waits for it neither (WAL), and a transaction still open when the copy
//! starts is not in it.
//!
//! A copy holds everything the database holds, the operators' PIN and badge
//! hashes and the pairing keys among it: it is as sensitive as `host.db`.
//! On Unix every file written here is owner-only (`0600`); on Windows a file
//! inherits the ACL of its folder, which the installer hardens for the data
//! folder and the administrator chooses for the second one.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aws_lc_rs::digest::{Context, SHA256};
use markiro_proto::backup::{failure, BackupCopy, BackupTrigger};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::OffsetDateTime;

use crate::clock::format_timestamp;

/// Every file of a copy starts with this.
pub const COPY_PREFIX: &str = "markiro-host-";
/// The manifest format this build writes and reads.
pub const MANIFEST_FORMAT: u32 = 1;

/// Why a copy failed: `code` is one of `markiro_proto::backup::failure` (the
/// office's text), `detail` is for the process log only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub code: &'static str,
    pub detail: String,
}

impl Failure {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// The manifest beside a copy (`<name>.json` for `<name>.db`): what the
/// listing, the second folder and `markiro-host restore` check a copy by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub file: String,
    pub created_at: String,
    pub trigger: BackupTrigger,
    pub host_id: String,
    /// The newest migration applied in the copy.
    pub schema_version: i64,
    pub size_bytes: u64,
    pub sha256: String,
}

impl Manifest {
    pub fn copy(&self) -> BackupCopy {
        BackupCopy {
            file: self.file.clone(),
            created_at: self.created_at.clone(),
            trigger: self.trigger,
            size_bytes: self.size_bytes,
            sha256: self.sha256.clone(),
        }
    }
}

/// `20261009T140000Z`: a UTC time in a file name.
pub fn utc_stamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// `markiro-host-20261009T140000Z-1a2b3c4d.db`: the UTC time first, so names
/// sort by time; `tag` (8 hex digits) keeps two copies of one second apart.
pub fn copy_name(at: OffsetDateTime, tag: &str) -> String {
    format!("{COPY_PREFIX}{}-{tag}.db", utc_stamp(at))
}

/// `<name>.json` beside `<name>.db`.
pub fn manifest_path(db: &Path) -> PathBuf {
    db.with_extension("json")
}

/// `<file>.partial`: where a copy is written before it checks out.
pub fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".partial");
    PathBuf::from(name)
}

/// The size and lower-case hex SHA-256 of a file. Blocking.
pub fn sha256_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        context.update(&buffer[..read]);
    }
    let digest = context.finish();
    let hex = digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((size, hex))
}

/// Create `path` for writing, owner-only on Unix (on Windows the file
/// inherits its folder's ACL). `exclusive` refuses a file that exists;
/// otherwise an existing file (a stale `.partial`) is emptied. Blocking.
pub fn create_private(path: &Path, exclusive: bool) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Whether `name` is the name of a copy's database file as this build writes
/// it, and nothing else: no separator, no stream or drive syntax. A
/// manifest read from a folder names a file to open in another folder, so
/// the name is checked before it is joined to a path.
pub fn is_copy_file_name(name: &str) -> bool {
    name.starts_with(COPY_PREFIX)
        && name.ends_with(".db")
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
}

/// Write `bytes` to `path` through `<path>.partial`, synced before the
/// rename, so a crash never leaves a half-written file under the final
/// name. Owner-only on Unix. Blocking.
pub fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let partial = partial_path(path);
    {
        let mut file = create_private(&partial, false)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&partial, path)
}

/// Read and check the manifest of `db`: format 1 and naming `db` itself.
/// Blocking.
pub fn read_manifest(db: &Path) -> Result<Manifest, String> {
    let path = manifest_path(db);
    let text = fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(format!(
            "{}: manifest format {} is not {MANIFEST_FORMAT}",
            path.display(),
            manifest.format
        ));
    }
    let name = db.file_name().and_then(|name| name.to_str());
    if name != Some(manifest.file.as_str()) {
        return Err(format!(
            "{}: the manifest names {}",
            path.display(),
            manifest.file
        ));
    }
    Ok(manifest)
}

/// Open `path` read-only and immutable (no `-wal`, `-shm` or lock beside
/// it), run `PRAGMA integrity_check` and return the newest migration
/// applied in it. Anything else than one row `ok` is `verify_failed`.
pub async fn verify_database(path: &Path) -> Result<i64, Failure> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    let checked = check(&mut conn).await;
    let _ = conn.close().await;
    checked
}

async fn check(conn: &mut SqliteConnection) -> Result<i64, Failure> {
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *conn)
        .await
        .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    if rows != ["ok"] {
        return Err(Failure::new(
            failure::VERIFY_FAILED,
            format!("integrity_check: {}", rows.join("; ")),
        ));
    }
    let version: Option<i64> =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(|error| Failure::new(failure::VERIFY_FAILED, error.to_string()))?;
    version.ok_or_else(|| Failure::new(failure::VERIFY_FAILED, "no migration applied"))
}

/// The failure code of an I/O error. A share that is gone, an unplugged
/// drive and a path through a file are all a folder that is not there.
pub fn classify_io(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    #[cfg(windows)]
    {
        // ERROR_BAD_NETPATH, ERROR_NETNAME_DELETED, ERROR_BAD_NET_NAME,
        // ERROR_NOT_READY (a drive letter without its USB drive),
        // ERROR_DEV_NOT_EXIST: a folder that is not there, whatever kind
        // the standard library gives them.
        if let Some(53 | 64 | 67 | 21 | 55) = error.raw_os_error() {
            return failure::DESTINATION_UNAVAILABLE;
        }
    }
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => failure::DESTINATION_UNAVAILABLE,
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => failure::ACCESS_DENIED,
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => failure::DISK_FULL,
        _ => failure::WRITE_FAILED,
    }
}

/// The failure code of `VACUUM INTO` a file in `dir`: SQLITE_FULL (13) is a
/// full disk; SQLITE_CANTOPEN (14) is a folder that is not there, or one the
/// host may not write when the folder is there (SQLite says the same for
/// both); SQLITE_PERM (3) and SQLITE_READONLY (8) a folder the host may not
/// write; anything else, a failed write.
pub fn classify_sqlite(error: &sqlx::Error, dir: &Path) -> &'static str {
    let code = error
        .as_database_error()
        .and_then(|database| database.code());
    match code.as_deref() {
        Some("13") => failure::DISK_FULL,
        Some("14") if dir.is_dir() => failure::ACCESS_DENIED,
        Some("14") => failure::DESTINATION_UNAVAILABLE,
        Some("3" | "8") => failure::ACCESS_DENIED,
        _ => failure::WRITE_FAILED,
    }
}

/// Make one verified copy of the database `conn` is open on in `dir`, named
/// for `at`: `VACUUM INTO` `<name>.partial`, check it, hash it, rename it,
/// then write the manifest. On any failure nothing of this copy stays in
/// `dir`.
pub async fn make_copy(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
) -> Result<Manifest, Failure> {
    let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    make_copy_tagged(conn, dir, at, trigger, host_id, &tag).await
}

/// [`make_copy`] with the name's `tag` given. A copy of that name that is
/// already in `dir` is never replaced, nor touched by the cleanup of this
/// attempt: a verified copy stays until the rule rotates it away.
pub async fn make_copy_tagged(
    conn: &mut SqliteConnection,
    dir: &Path,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
    tag: &str,
) -> Result<Manifest, Failure> {
    let name = copy_name(at, tag);
    let db = dir.join(&name);
    let partial = partial_path(&db);
    if db.exists() || manifest_path(&db).exists() {
        return Err(Failure::new(
            failure::WRITE_FAILED,
            format!("{} is already there", db.display()),
        ));
    }
    let made = write_copy(conn, &db, &partial, &name, at, trigger, host_id).await;
    if made.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&db);
        let _ = fs::remove_file(partial_path(&manifest_path(&db)));
    }
    made
}

async fn write_copy(
    conn: &mut SqliteConnection,
    db: &Path,
    partial: &Path,
    name: &str,
    at: OffsetDateTime,
    trigger: BackupTrigger,
    host_id: &str,
) -> Result<Manifest, Failure> {
    let target = partial.to_str().ok_or_else(|| {
        Failure::new(
            failure::WRITE_FAILED,
            format!("{} is no UTF-8 path", partial.display()),
        )
    })?;
    // SQLite writes into an empty file it did not create: the file is made
    // here, owner-only, so the copy is never readable by others, not even
    // for the moment before a later chmod.
    create_private(partial, true)
        .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(&mut *conn)
        .await
        .map_err(|error| {
            let dir = db.parent().unwrap_or(Path::new("."));
            Failure::new(classify_sqlite(&error, dir), error.to_string())
        })?;
    let schema_version = verify_database(partial).await?;
    let hashed = partial.to_path_buf();
    let (size_bytes, sha256) = tokio::task::spawn_blocking(move || sha256_file(&hashed))
        .await
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
        .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    let manifest = Manifest {
        format: MANIFEST_FORMAT,
        file: name.to_owned(),
        created_at: format_timestamp(at),
        trigger,
        host_id: host_id.to_owned(),
        schema_version,
        size_bytes,
        sha256,
    };
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?;
    let (partial, db) = (partial.to_path_buf(), db.to_path_buf());
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        fs::File::open(&partial)?.sync_all()?;
        fs::rename(&partial, &db)?;
        write_synced(&manifest_path(&db), &bytes)
    })
    .await
    .map_err(|error| Failure::new(failure::INTERNAL, error.to_string()))?
    .map_err(|error| Failure::new(classify_io(&error), error.to_string()))?;
    Ok(manifest)
}
