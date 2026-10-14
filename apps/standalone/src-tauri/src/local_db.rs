//! The station's local SQLite (stage 1 spec §5.2–5.3): copies of the host's
//! reference records, kept by the webview's reference sync. The webview
//! reads with [`LocalDb::query`] (`local_query`) on read-only connections
//! and writes only with [`LocalDb::transaction`] (`local_transaction`): one
//! `BEGIN IMMEDIATE` transaction per call on the single writer connection.
//! DDL lives only in `src-tauri/migrations`.
//!
//! Statements carry literals as parameters: `;`, `--` and `/*` are refused,
//! and so are words that control transactions, connections or the schema.
//! A large reference page goes in as one JSON parameter per entity
//! (`json_each`), so the limits bound SQL, not rows.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{Map, Number, Value};
use sqlx::migrate::Migrator;
use sqlx::query::Query;
use sqlx::sqlite::{
    SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions,
    SqliteRow, SqliteSynchronous,
};
use sqlx::{Column, ConnectOptions, Connection, Row, Sqlite, TypeInfo, ValueRef};

pub const FILE_NAME: &str = "standalone-station.db";
/// The copy of the database before this build's pending migrations (plan
/// ОБН-1, spec §10.6): `standalone-station.pre-<app version>.db` beside it.
/// Only the newest is kept.
pub const PRE_UPGRADE_PREFIX: &str = "standalone-station.pre-";

/// `standalone-station.pre-<version>.db`.
pub fn pre_upgrade_file(version: &str) -> String {
    format!("{PRE_UPGRADE_PREFIX}{version}.db")
}
/// The files SQLite keeps beside [`FILE_NAME`]: the database itself, its WAL,
/// the WAL's shared-memory index and a rollback journal.
const FILE_SUFFIXES: [&str; 4] = ["", "-wal", "-shm", "-journal"];
/// `MAX_STATEMENTS`, `MAX_SQL_BYTES` and `MAX_VALUES` here, and
/// `FORBIDDEN_WORDS` below, are mirrored for tests in
/// `apps/standalone/test/support/local-db.ts`. A rule change here updates
/// that file too and adds a case to `src-tauri/tests/fixtures/local-sql.json`.
pub const MAX_STATEMENTS: usize = 32;
pub const MAX_SQL_BYTES: usize = 64 * 1024;
pub const MAX_VALUES: usize = 256;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a set-aside tries to move a file of the database, and the pause
/// between tries. On Windows a file SQLite or an antivirus scan still holds
/// open refuses to move for a moment: sqlx closes the handle of a connection
/// that failed to open on its own thread, after the open has returned. The
/// host's restore retries its renames the same way.
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(200);

/// What a forget (`device_forget`, [`LocalDb::clear_copies`]) does with a
/// table (stage 2a spec §5.2, decision 30).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TableClass {
    /// Copies of the host's data and this pairing's own bookkeeping: the
    /// forget empties them, PIN and badge hashes included.
    Disposable,
    /// What this device recorded itself — shifts, boxes, pallets, scans, the
    /// outbox (plans 2a5–2a8, ПЛ-Ц): the forget keeps them, each row tagged
    /// with the pairing that wrote it.
    DeviceData,
    /// This computer's workstation settings — printers, scanners, sound
    /// (plan 2a7): they belong to the PC, not to a pairing, and outlive it.
    Workstation,
}

/// Every table `src-tauri/migrations` creates, with its class, in the order
/// [`LocalDb::clear_copies`] empties the disposable ones. A migration that
/// adds a table adds it here in the same change: `tests/local_db.rs` fails on
/// a table without a class, and on a name here that no migration creates. No
/// table has a foreign key, and `tests/local_db.rs` fails on one: a plain key
/// makes the forget fail at the `DELETE` that breaks it, and `ON DELETE
/// CASCADE` or `SET NULL` from a table the forget keeps to one it empties
/// would delete or rewrite this device's own records without a word, so add
/// none. `floor_sign_in_failures` is disposable although this device wrote
/// it: a new pairing brings a new roster (`apps/standalone/AGENTS.md`, «Local
/// database»), and keeping the lockout counters across a forget is an open
/// owner question.
pub const TABLE_CLASSES: &[(&str, TableClass)] = &[
    ("floor_block_drops", TableClass::DeviceData),
    ("floor_block_requests", TableClass::DeviceData),
    ("floor_boxes", TableClass::DeviceData),
    ("floor_codes", TableClass::DeviceData),
    // What the host told this station of its displaced scans (plan КНФ, migration `0016`).
    ("floor_displacements", TableClass::DeviceData),
    ("floor_exceptions", TableClass::DeviceData),
    ("floor_pallet_exceptions", TableClass::DeviceData),
    ("floor_pallets", TableClass::DeviceData),
    ("floor_print_jobs", TableClass::DeviceData),
    ("floor_restore_epochs", TableClass::Disposable),
    ("floor_scans", TableClass::DeviceData),
    ("floor_shifts", TableClass::DeviceData),
    ("floor_sign_in_failures", TableClass::Disposable),
    ("floor_sscc_blocks", TableClass::DeviceData),
    // The unit label jobs (plan РЕЖ part B, migration `0015`): this device's records.
    ("floor_unit_labels", TableClass::DeviceData),
    ("outbox", TableClass::DeviceData),
    ("ref_lines", TableClass::Disposable),
    ("ref_operator_badges", TableClass::Disposable),
    ("ref_operators", TableClass::Disposable),
    ("ref_org", TableClass::Disposable),
    ("ref_products", TableClass::Disposable),
    ("ref_site", TableClass::Disposable),
    ("ref_template_defaults", TableClass::Disposable),
    ("ref_templates", TableClass::Disposable),
    ("sync_quarantine", TableClass::Disposable),
    ("sync_state", TableClass::Disposable),
    // The warehouse reprint (plan СКЛ, migration `0012`): this device's records.
    ("wh_jobs", TableClass::DeviceData),
    ("wh_outbox", TableClass::DeviceData),
    ("wh_sessions", TableClass::DeviceData),
    ("workstation_settings", TableClass::Workstation),
];

/// The class of `table`, `None` for a table [`TABLE_CLASSES`] does not name.
pub fn table_class(table: &str) -> Option<TableClass> {
    TABLE_CLASSES
        .iter()
        .find(|(name, _)| *name == table)
        .map(|(_, class)| *class)
}

/// `src-tauri/migrations`, embedded at compile time. Applied migrations are
/// never edited: sqlx refuses to open a database whose checksums changed.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Words a webview statement may not contain: the shell owns transactions,
/// connections and the schema.
const FORBIDDEN_WORDS: &[&str] = &[
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "ATTACH",
    "DETACH",
    "PRAGMA",
    "VACUUM",
    "CREATE",
    "DROP",
    "ALTER",
    "REINDEX",
    // Creates `sqlite_stat1`: a schema-level effect that belongs to migrations.
    "ANALYZE",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalDbError {
    /// The database could not be opened or migrated when the app started.
    Unavailable,
    /// The statement or the batch breaks the rules in the module comment.
    InvalidStatement,
    /// A parameter is not a scalar, an integer does not fit 64 bits, or a
    /// result column holds a BLOB.
    UnsupportedValue,
    /// SQLite refused or failed the statement; a batch rolled back whole. The
    /// one exception is the checkpoint that ends [`LocalDb::clear_copies`]:
    /// when it reports busy the call fails, but the delete stays committed and
    /// a retry repeats only the checkpoint.
    StatementFailed,
    /// A statement changed another number of rows than `expectedChanges`;
    /// the batch rolled back whole.
    ChangesMismatch,
    /// [`LocalDb::clear_copies`] found `count` outbox records without a
    /// receipt that its [`UnsentGuard`] protects, and cleared nothing.
    UnsentRecords { count: u64 },
}

impl LocalDbError {
    /// Stable codes the webview maps to text (`src/local/executor.ts`).
    pub fn code(self) -> &'static str {
        match self {
            LocalDbError::Unavailable => "local_db_unavailable",
            LocalDbError::InvalidStatement => "invalid_statement",
            LocalDbError::UnsupportedValue => "unsupported_value",
            LocalDbError::StatementFailed => "statement_failed",
            LocalDbError::ChangesMismatch => "changes_mismatch",
            LocalDbError::UnsentRecords { .. } => "unsent_facts",
        }
    }
}

/// Which outbox records without a receipt stop a forget (stage 2a spec §5.2,
/// question В7): a forget never waits for them, it refuses, so the station
/// sends them first or a person confirms the loss of the link to them. The
/// warehouse reprint's records (`wh_outbox`) count with the shift facts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsentGuard<'a> {
    /// This pairing's (host id, device id): records of an earlier pairing
    /// that was forgotten with a confirmation do not count.
    Pairing(&'a str, &'a str),
    /// Any pairing's: `device.json` is unreadable, so the current pairing is
    /// unknown.
    AnyPairing,
    /// None: a person confirmed the forget knowing the count, or there is no
    /// pairing to forget. The records stay on disk either way.
    Ignore,
}

/// Why [`LocalDb::open`] failed, as far as a forget needs to tell (stage 2a
/// spec §5.2, question В7): only a corrupt file may be set aside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFailure {
    /// SQLite called the file corrupt or not a database (`SQLITE_CORRUPT`,
    /// `SQLITE_NOTADB`): no app version will open it.
    Corrupt,
    /// Anything else — a migration this app version does not know (the app
    /// was rolled back), a changed checksum, a busy or unreadable file, a full
    /// disk. The file may be a sound database with unsent records and an app
    /// that can open it later: it stays where it is.
    Other,
}

/// The primary SQLite result codes `SQLITE_CORRUPT` and `SQLITE_NOTADB`.
const SQLITE_CORRUPT: i64 = 11;
const SQLITE_NOTADB: i64 = 26;

/// [`OpenFailure`] of an error from [`LocalDb::open`]: a database error with
/// a corruption code, also when it came out of a migration. SQLite's extended
/// result codes keep the primary code in their low byte.
fn open_failure_of(error: &sqlx::Error) -> OpenFailure {
    use sqlx::migrate::MigrateError;
    let corrupt = match error {
        sqlx::Error::Database(database) => database
            .code()
            .and_then(|code| code.parse::<i64>().ok())
            .is_some_and(|code| matches!(code & 0xff, SQLITE_CORRUPT | SQLITE_NOTADB)),
        sqlx::Error::Migrate(migrate) => match &**migrate {
            MigrateError::Execute(inner) | MigrateError::ExecuteMigration(inner, _) => {
                open_failure_of(inner) == OpenFailure::Corrupt
            }
            _ => false,
        },
        _ => false,
    };
    if corrupt {
        OpenFailure::Corrupt
    } else {
        OpenFailure::Other
    }
}

/// One statement of `local_transaction`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalStatement {
    pub sql: String,
    #[serde(default)]
    pub values: Vec<Value>,
    /// Roll the batch back unless the statement changes exactly this many
    /// rows. Meaningful only for `INSERT`, `UPDATE`, `DELETE` and `REPLACE`:
    /// SQLite does not reset its changed-row count for a non-writing
    /// statement, so pinning this on, say, a `SELECT` checks the previous
    /// write's count, not zero.
    #[serde(default)]
    pub expected_changes: Option<u64>,
}

pub struct LocalDb {
    writer: SqlitePool,
    readers: SqlitePool,
}

impl LocalDb {
    /// Open `standalone-station.db` in `dir`, creating the directory, the
    /// file and the schema as needed. Before this build's pending migrations
    /// the database is copied to `standalone-station.pre-<version>.db` (plan
    /// ОБН-1); a copy that fails runs no migration and fails the open as an
    /// I/O error ([`OpenFailure::Other`]: the file stays where it is).
    pub async fn open(dir: &Path) -> Result<Self, sqlx::Error> {
        Self::open_versioned(dir, env!("CARGO_PKG_VERSION")).await
    }

    /// [`Self::open`] as the app of `version`, for tests.
    #[doc(hidden)]
    pub async fn open_versioned(dir: &Path, version: &str) -> Result<Self, sqlx::Error> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let writer = SqlitePoolOptions::new()
            .max_connections(1)
            // sqlx tracks each connection's transaction depth itself. If a
            // `ROLLBACK` it issues on drop ever fails — SQLite already ended
            // the transaction on its own (`SQLITE_FULL`, `IOERR`, `NOMEM`) or
            // a migration used `RAISE(ROLLBACK)` — that depth is left stuck
            // above zero, and every later `begin_with("BEGIN IMMEDIATE")` on
            // this connection fails until the pool recycles it (`max_lifetime`,
            // 30 min by default). Refuse to hand out a connection whose depth
            // is not zero, so the pool closes it and opens a fresh one instead.
            .before_acquire(|conn, _| {
                Box::pin(async move {
                    Ok(<sqlx::sqlite::SqliteTransactionManager as sqlx::TransactionManager>::get_transaction_depth(conn) == 0)
                })
            })
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal)
                    .synchronous(SqliteSynchronous::Full)
                    .foreign_keys(true)
                    .busy_timeout(BUSY_TIMEOUT)
                    // A deleted row is zeroed where it stood, not merely
                    // unlinked: the copies hold PIN and badge hashes.
                    .pragma("secure_delete", "ON"),
            )
            .await?;
        // A failure to read the migrations goes back as it is: a corrupt
        // file stays `Corrupt` for the forget.
        match has_pending_migrations(&writer).await {
            Ok(false) => {}
            Ok(true) => {
                if let Err(error) = copy_before_migrations(&writer, dir, version).await {
                    // The kind only: a path names the Windows user.
                    match &error {
                        sqlx::Error::Io(io) => eprintln!(
                            "standalone: the copy of the local database before its migrations failed: {:?}",
                            io.kind()
                        ),
                        _ => eprintln!(
                            "standalone: the copy of the local database before its migrations met a damaged database"
                        ),
                    }
                    writer.close().await;
                    return Err(error);
                }
            }
            Err(error) => {
                writer.close().await;
                return Err(error);
            }
        }
        if let Err(error) = MIGRATOR.run(&writer).await {
            // Closed before the error goes back, not left to close on its
            // own: an open handle keeps the file from moving on Windows.
            writer.close().await;
            return Err(error.into());
        }
        // The migrations finished: the copy before them is no longer the one
        // to keep (plan ОБН-1). One that does not clear is cleared by the
        // next open; until then a later upgrade of the same version would
        // keep an older copy, so it is noted.
        if let Err(error) = finish_upgrade(&writer).await {
            eprintln!(
                "standalone: the local database's unfinished-upgrade mark did not clear: {}",
                error
                    .as_database_error()
                    .and_then(|database| database.code())
                    .unwrap_or_default()
            );
        }
        let readers = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .read_only(true)
                    .busy_timeout(BUSY_TIMEOUT),
            )
            .await?;
        Ok(Self { writer, readers })
    }

    /// Run one `SELECT` or `WITH` statement on a read-only connection. Each
    /// row becomes an object keyed by column name: alias duplicate names.
    pub async fn query(
        &self,
        sql: &str,
        params: Vec<Value>,
    ) -> Result<Vec<Map<String, Value>>, LocalDbError> {
        check_statement(sql, params.len())?;
        if !is_query(sql) {
            return Err(LocalDbError::InvalidStatement);
        }
        let rows = bind(sqlx::query(sql), params)?
            .fetch_all(&self.readers)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        rows.iter().map(row_object).collect()
    }

    /// Run `statements` in one `BEGIN IMMEDIATE` transaction on the writer
    /// connection and return the rows each changed. Any failure and any
    /// `expectedChanges` mismatch rolls back every statement. The changed-rows
    /// count is meaningful only for `INSERT`, `UPDATE`, `DELETE` and
    /// `REPLACE`: SQLite does not reset it for a non-writing statement, so a
    /// `SELECT` in a batch reports the connection's last real write count,
    /// not zero.
    pub async fn transaction(
        &self,
        statements: Vec<LocalStatement>,
    ) -> Result<Vec<u64>, LocalDbError> {
        if statements.is_empty() || statements.len() > MAX_STATEMENTS {
            return Err(LocalDbError::InvalidStatement);
        }
        for statement in &statements {
            check_statement(&statement.sql, statement.values.len())?;
        }
        let mut tx = self
            .writer
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let mut changes = Vec::with_capacity(statements.len());
        for LocalStatement {
            sql,
            values,
            expected_changes,
        } in statements
        {
            let changed = bind(sqlx::query(&sql), values)?
                .execute(&mut *tx)
                .await
                .map_err(|_| LocalDbError::StatementFailed)?
                .rows_affected();
            if expected_changes.is_some_and(|expected| expected != changed) {
                return Err(LocalDbError::ChangesMismatch);
            }
            changes.push(changed);
        }
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        Ok(changes)
    }

    /// Delete every row of the disposable tables ([`TableClass::Disposable`]
    /// in [`TABLE_CLASSES`]), in one writer transaction: forgetting the device
    /// must not leave another pairing's copies behind, PIN and badge hashes
    /// included. The tables of this device's own records and of the
    /// workstation's settings keep their rows (stage 2a spec §5.2, decision
    /// 30); `device_forget` decides first whether unsent records allow a
    /// forget at all. One exception, carried to the owner (plan ОБН-1, Д9):
    /// the copy before an upgrade (`standalone-station.pre-<version>.db`)
    /// keeps the PIN and badge hashes it held at that upgrade; the forget does
    /// not touch it, and only the next upgrade that brings migrations replaces
    /// it. The writer zeroes deleted rows (`secure_delete`), and a
    /// checkpoint that truncates the WAL follows the commit: it moves the
    /// zeroed pages into the file and empties the WAL, which still held the
    /// frames written before the delete. A reader holding an older snapshot
    /// keeps it from finishing within the busy timeout, and the call then
    /// fails; the delete stays committed and a retry repeats only the
    /// checkpoint. `VACUUM` is not needed for the rows deleted here: it would
    /// only shrink the file. It would do more for bytes a writer freed before
    /// it ran with `secure_delete`, which nothing here scrubs (see "Local
    /// database" in `apps/standalone/AGENTS.md`). The list is named, not read
    /// from `pragma_table_list`: a table a later migration adds is emptied
    /// only once that migration's plan classes it disposable. The unsent
    /// records `guard` protects are counted in this same transaction, before
    /// the first delete: with any, nothing is deleted and the call answers
    /// [`LocalDbError::UnsentRecords`].
    pub async fn clear_copies(&self, guard: UnsentGuard<'_>) -> Result<(), LocalDbError> {
        self.clear_classed(TABLE_CLASSES, guard).await
    }

    /// [`LocalDb::clear_copies`] over `classes`, so a unit test can give it
    /// tables of every class while [`TABLE_CLASSES`] holds only disposable ones.
    async fn clear_classed(
        &self,
        classes: &[(&str, TableClass)],
        guard: UnsentGuard<'_>,
    ) -> Result<(), LocalDbError> {
        let mut tx = self
            .writer
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let count = unsent_records(&mut tx, guard).await?;
        if count > 0 {
            return Err(LocalDbError::UnsentRecords { count });
        }
        let disposable = classes
            .iter()
            .filter(|(_, class)| *class == TableClass::Disposable);
        for (table, _) in disposable {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut *tx)
                .await
                .map_err(|_| LocalDbError::StatementFailed)?;
        }
        tx.commit()
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&self.writer)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        if busy == 0 {
            Ok(())
        } else {
            Err(LocalDbError::StatementFailed)
        }
    }
}

/// How many records without a receipt (`acked_at IS NULL`) `guard` protects,
/// in the shift facts' `outbox` and the warehouse reprint's `wh_outbox`
/// ([`UNSENT_TABLES`]), counted inside the forget's own transaction, so no
/// record can arrive between the count and the clear (both tables are in every
/// database that opened). An outbox that cannot be counted is an error, never 0.
async fn unsent_records(
    tx: &mut sqlx::SqliteConnection,
    guard: UnsentGuard<'_>,
) -> Result<u64, LocalDbError> {
    if guard == UnsentGuard::Ignore {
        return Ok(0);
    }
    count_unsent(tx, guard, false).await
}

/// The tables whose records without a receipt (`acked_at IS NULL`) stop a
/// forget: the shift facts' `outbox` (migration `0006`) and the warehouse
/// reprint's `wh_outbox` (migration `0012`, plan СКЛ). A reprint record not yet
/// sent is a trace the host should still get; the forget refuses for it as for
/// a fact.
const UNSENT_TABLES: [&str; 2] = ["outbox", "wh_outbox"];

async fn table_exists(
    connection: &mut sqlx::SqliteConnection,
    table: &str,
) -> Result<bool, LocalDbError> {
    let found: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pragma_table_list WHERE schema = 'main' AND name = ?",
    )
    .bind(table)
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| LocalDbError::StatementFailed)?;
    Ok(found != 0)
}

/// The count of [`unsent_records`], over every table of [`UNSENT_TABLES`].
/// With `skip_missing` ([`LocalDbState::unopened_unsent_records`]) a table that
/// is not there counts 0: a database that did not open may be one an older
/// build left, with no `outbox` or no `wh_outbox` at all. A table that exists
/// but cannot be counted is an error either way.
async fn count_unsent(
    connection: &mut sqlx::SqliteConnection,
    guard: UnsentGuard<'_>,
    skip_missing: bool,
) -> Result<u64, LocalDbError> {
    let failed = |_| LocalDbError::StatementFailed;
    let mut total: u64 = 0;
    for table in UNSENT_TABLES {
        if skip_missing && !matches!(table_exists(connection, table).await, Ok(true)) {
            continue;
        }
        let count: i64 = match guard {
            UnsentGuard::Pairing(host_id, device_id) => sqlx::query_scalar(&format!(
                "SELECT count(*) FROM {table} WHERE acked_at IS NULL AND host_id = ? \
                 AND device_id = ?"
            ))
            .bind(host_id)
            .bind(device_id)
            .fetch_one(&mut *connection)
            .await
            .map_err(failed)?,
            // `INDEXED BY`: since migration `0010` the planner prefers the covering
            // `outbox_shift`, which walks the settled records too (pinned in `tests/local_db.rs`).
            UnsentGuard::AnyPairing => sqlx::query_scalar(&format!(
                "SELECT count(*) FROM {table} INDEXED BY {table}_unsent WHERE acked_at IS NULL"
            ))
            .fetch_one(&mut *connection)
            .await
            .map_err(failed)?,
            UnsentGuard::Ignore => 0,
        };
        total += u64::try_from(count).unwrap_or(0);
    }
    Ok(total)
}

/// Tauri state: the local database, or none when it could not be opened.
/// The app still starts — the office works without it — and the local
/// commands answer `local_db_unavailable`.
pub struct LocalDbState {
    /// Set when the database opened at start, or later by
    /// [`Self::set_aside_unopened`], which opens a new one in its place.
    db: OnceLock<LocalDb>,
    /// Where `open` looked for the database; `None` for a shell with no
    /// local database at all (`unavailable`).
    dir: Option<PathBuf>,
    /// Serialises [`Self::set_aside_unopened`]: two forgets must not move
    /// the same files aside twice or open two databases.
    setting_aside: tokio::sync::Mutex<()>,
    /// Why the database is not open, while it is not.
    failure: std::sync::Mutex<Option<OpenFailure>>,
}

impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        let db = OnceLock::new();
        let mut failure = None;
        match LocalDb::open(dir).await {
            Ok(opened) => {
                let _ = db.set(opened);
            }
            Err(error) => failure = Some(open_failure_of(&error)),
        }
        Self {
            db,
            dir: Some(dir.to_path_buf()),
            setting_aside: tokio::sync::Mutex::new(()),
            failure: std::sync::Mutex::new(failure),
        }
    }

    /// A shell with no local database and no directory for one, as the IPC
    /// tests that need neither use.
    pub fn unavailable() -> Self {
        Self {
            db: OnceLock::new(),
            dir: None,
            setting_aside: tokio::sync::Mutex::new(()),
            failure: std::sync::Mutex::new(None),
        }
    }

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.db.get().ok_or(LocalDbError::Unavailable)
    }

    /// Why `open` failed, `None` while the database is open and for a shell
    /// that never tried to open one (`unavailable`).
    pub fn open_failure(&self) -> Option<OpenFailure> {
        *self
            .failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// How many records without a receipt `guard` protects in the database
    /// that did not open, read on a read-only connection without migrations
    /// and without changing the file. A file nothing can be read from (not a
    /// database, no file, no directory) holds none anyone could send: 0. An
    /// `outbox` that exists but cannot be counted is an error, never 0, as in
    /// [`LocalDb::clear_copies`].
    pub async fn unopened_unsent_records(
        &self,
        guard: UnsentGuard<'_>,
    ) -> Result<u64, LocalDbError> {
        let Some(dir) = &self.dir else {
            return Ok(0);
        };
        if guard == UnsentGuard::Ignore {
            return Ok(0);
        }
        let Ok(mut connection) = SqliteConnectOptions::new()
            .filename(dir.join(FILE_NAME))
            .read_only(true)
            .busy_timeout(BUSY_TIMEOUT)
            .connect()
            .await
        else {
            return Ok(0);
        };
        let counted = count_unsent(&mut connection, guard, true).await;
        let _ = connection.close().await;
        counted
    }

    /// Move the database `open` could not open out of the way, with its
    /// `-wal`, `-shm` and `-journal` files, and open a new one in its place
    /// (stage 2a spec §5.2, question В7). Nothing is deleted: the file may
    /// hold this device's unsent records, which support can still read (plan
    /// 5), and it may hold PIN and badge hashes — the accepted price of
    /// keeping those records. The files become
    /// `standalone-station.db.unreadable-<unix ms>` plus their suffix, so the
    /// set stays openable together. A file that cannot be moved puts back
    /// the ones already moved and fails the call; so does a name that is
    /// already taken (an earlier set-aside with the same stamp), which a
    /// rename would silently replace; so does a set that an earlier failed
    /// put-back left split (`set_is_split`), which another move would part for
    /// good. Each failure leaves a trace on stderr (the error kind and the
    /// part of the set, no path). Whether this database may be set aside at
    /// all is the caller's decision: `device_forget` calls it only for a
    /// corrupt one ([`OpenFailure::Corrupt`]), after the unsent-records
    /// guard. Answers where the database went, `None` when there was nothing
    /// to move, an open database or no directory; a new database that does
    /// not open either leaves the state without one, as at start.
    pub async fn set_aside_unopened(&self) -> std::io::Result<Option<PathBuf>> {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);
        self.set_aside_unopened_at(stamp).await
    }

    /// [`Self::set_aside_unopened`] with the time stamp given, for tests.
    pub async fn set_aside_unopened_at(&self, stamp: u128) -> std::io::Result<Option<PathBuf>> {
        let Some(dir) = &self.dir else {
            return Ok(None);
        };
        let _setting_aside = self.setting_aside.lock().await;
        if self.db.get().is_some() {
            return Ok(None);
        }
        if set_is_split(dir)? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "an earlier set-aside left the database files split",
            ));
        }
        let aside = format!("{FILE_NAME}.unreadable-{stamp}");
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut database = None;
        for suffix in FILE_SUFFIXES {
            let from = dir.join(format!("{FILE_NAME}{suffix}"));
            if from.symlink_metadata().is_err() {
                continue;
            }
            let to = dir.join(format!("{aside}{suffix}"));
            let moving = if to.symlink_metadata().is_ok() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("{} is already there", to.display()),
                ))
            } else {
                rename_retrying(RENAME_ATTEMPTS, RENAME_RETRY_DELAY, || {
                    std::fs::rename(&from, &to)
                })
                .await
            };
            if let Err(error) = moving {
                let part = if suffix.is_empty() {
                    "database"
                } else {
                    suffix
                };
                eprintln!(
                    "standalone: setting the local database aside failed at its {part} file: {:?}",
                    error.kind()
                );
                for (back, place) in moved.iter().rev() {
                    // Best effort: a file left aside is still kept, not lost.
                    let putting_back = rename_retrying(RENAME_ATTEMPTS, RENAME_RETRY_DELAY, || {
                        std::fs::rename(place, back)
                    })
                    .await;
                    if let Err(error) = putting_back {
                        eprintln!(
                            "standalone: a file of the local database could not be put back after a failed set-aside: {:?}",
                            error.kind()
                        );
                    }
                }
                return Err(error);
            }
            if suffix.is_empty() {
                database = Some(to.clone());
            }
            moved.push((from, to));
        }
        let failure = match LocalDb::open(dir).await {
            Ok(opened) => {
                let _ = self.db.set(opened);
                None
            }
            Err(error) => Some(open_failure_of(&error)),
        };
        *self
            .failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = failure;
        Ok(database)
    }
}

/// Whether this build brings migrations the database lacks, on top of at
/// least one it has. A new file, a failed migration and one this build does
/// not know answer `false`: nothing to protect, or sqlx refuses it anyway.
async fn has_pending_migrations(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await?;
    if tables == 0 {
        return Ok(false);
    }
    let applied: Vec<(i64, bool)> = sqlx::query_as("SELECT version, success FROM _sqlx_migrations")
        .fetch_all(pool)
        .await?;
    let known: Vec<i64> = MIGRATOR
        .iter()
        .filter(|migration| !migration.migration_type.is_down_migration())
        .map(|migration| migration.version)
        .collect();
    if applied.is_empty()
        || applied
            .iter()
            .any(|(version, success)| !success || !known.contains(version))
    {
        return Ok(false);
    }
    Ok(known
        .iter()
        .any(|version| !applied.iter().any(|(applied, _)| applied == version)))
}

/// `VACUUM INTO <copy>.partial`, `integrity_check` on it read-only, flushed,
/// renamed to `standalone-station.pre-<version>.db` (over one of that name),
/// then every older such copy goes, with its side files. A copy of that name
/// stays as it is only while the database carries [`UPGRADE_UNFINISHED`]
/// and the copy is sound and older than the database: an earlier open of
/// this version copied the database and did not finish its migrations (one
/// committed before a later one failed), so the copy holds the state before
/// all of them (plan ОБН-1). A copy left by an earlier upgrade that finished
/// (two builds can share one version) is replaced. A failure leaves the database as it was and no partial
/// file behind. Errors are I/O ([`OpenFailure::Other`]) except the damage the
/// copy met in the database itself, which stays SQLite's
/// ([`OpenFailure::Corrupt`], so a forget may set the file aside).
async fn copy_before_migrations(
    pool: &SqlitePool,
    dir: &Path,
    version: &str,
) -> Result<(), sqlx::Error> {
    let name = pre_upgrade_file(version);
    let target = dir.join(&name);
    let partial = dir.join(format!("{name}.partial"));
    let live: Option<i64> =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(pool)
            .await?;
    // Only an open that did not finish its migrations keeps its copy: the
    // name carries the app's version, and two builds can share one.
    let keep = upgrade_unfinished(pool).await? && older_sound_copy(&target, live).await;
    if !keep {
        match std::fs::remove_file(&partial) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(sqlx::Error::Io(error)),
        }
        if let Err(error) = write_pre_upgrade(pool, &partial).await {
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
        if let Err(error) = rename_retrying(RENAME_ATTEMPTS, RENAME_RETRY_DELAY, || {
            std::fs::rename(&partial, &target)
        })
        .await
        {
            // The partial file holds PIN and badge hashes: it does not stay.
            let _ = std::fs::remove_file(&partial);
            return Err(sqlx::Error::Io(error));
        }
    }
    // The copy is in place: until the migrations finish, a later open of
    // this version keeps it rather than copy a half-migrated database.
    sqlx::query(&format!("PRAGMA user_version = {UPGRADE_UNFINISHED}"))
        .execute(pool)
        .await?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Some(other) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let base = FILE_SUFFIXES[1..]
            .iter()
            .find_map(|suffix| other.strip_suffix(suffix))
            .unwrap_or(&other);
        let older = base != name
            && base.starts_with(PRE_UPGRADE_PREFIX)
            && (base.ends_with(".db") || base.ends_with(".db.partial"));
        if older {
            // The new copy is in place: an older one that does not go is
            // only noted.
            if let Err(error) = std::fs::remove_file(entry.path()) {
                eprintln!(
                    "standalone: an older copy of the local database could not be removed: {:?}",
                    error.kind()
                );
            }
        }
    }
    Ok(())
}

/// `PRAGMA user_version` of the database while an upgrade's copy is made and
/// its migrations have not finished (plan ОБН-1): «OBN1». Nothing else uses
/// `user_version`.
const UPGRADE_UNFINISHED: i64 = 0x4f42_4e31;

/// Whether the database carries [`UPGRADE_UNFINISHED`]: an earlier open
/// copied it and did not finish its migrations.
async fn upgrade_unfinished(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let mark: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    Ok(mark == UPGRADE_UNFINISHED)
}

/// Clears [`UPGRADE_UNFINISHED`] once the migrations ran.
async fn finish_upgrade(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    if upgrade_unfinished(pool).await? {
        sqlx::query("PRAGMA user_version = 0").execute(pool).await?;
    }
    Ok(())
}

/// Whether `target` is a sound copy whose newest migration is older than
/// `live`, the database's: the copy an earlier open of this version made
/// before its migrations. One as new as the database (a copy put back in
/// place, then an upgrade again) or one that does not check out is not.
async fn older_sound_copy(target: &Path, live: Option<i64>) -> bool {
    let Some(live) = live else {
        return false;
    };
    if !target.exists() {
        return false;
    }
    let Ok(mut check) = SqliteConnectOptions::new()
        .filename(target)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
    else {
        return false;
    };
    let sound = matches!(
        sqlx::query_scalar::<_, String>("PRAGMA quick_check")
            .fetch_all(&mut check)
            .await
            .as_deref(),
        Ok([ok]) if ok == "ok"
    );
    let newest: Result<Option<i64>, sqlx::Error> =
        sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&mut check)
            .await;
    let _ = check.close().await;
    sound && matches!(newest, Ok(Some(newest)) if newest < live)
}

async fn write_pre_upgrade(pool: &SqlitePool, partial: &Path) -> Result<(), sqlx::Error> {
    let target = partial.to_str().ok_or_else(|| {
        sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the copy's path is no UTF-8",
        ))
    })?;
    if let Err(error) = sqlx::query("VACUUM INTO ?")
        .bind(target)
        .execute(pool)
        .await
    {
        // Damage the copy met in the database is the database's; anything
        // else (a full disk, a locked folder) is the copy's own.
        return Err(if open_failure_of(&error) == OpenFailure::Corrupt {
            error
        } else {
            sqlx::Error::Io(std::io::Error::other(error))
        });
    }
    let io = |error: sqlx::Error| sqlx::Error::Io(std::io::Error::other(error));
    let mut check = SqliteConnectOptions::new()
        .filename(partial)
        .read_only(true)
        .immutable(true)
        .connect()
        .await
        .map_err(io)?;
    let rows: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut check)
        .await;
    let _ = check.close().await;
    if rows.map_err(io)? != ["ok"] {
        return Err(sqlx::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "the copy did not check out",
        )));
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open(partial)?
        .sync_all()?;
    Ok(())
}

/// `rename` tried up to `attempts` times, `delay` apart. A source that is not
/// there is final at once: nothing will bring it back.
async fn rename_retrying(
    attempts: u32,
    delay: Duration,
    mut rename: impl FnMut() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut attempt = 1;
    loop {
        match rename() {
            Err(error) if attempt < attempts && error.kind() != std::io::ErrorKind::NotFound => {
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
            other => return other,
        }
    }
}

/// Whether an earlier set-aside left the files of one database split: a side
/// file (`-wal`, `-shm`, `-journal`) under an `.unreadable-<stamp>` name with
/// no database file under that stamp, or side files at the original names
/// with no database file there. A failed put-back does this; moving what is
/// left under a new stamp would part the files for good.
fn set_is_split(dir: &Path) -> std::io::Result<bool> {
    let side_at_original = FILE_SUFFIXES[1..].iter().any(|suffix| {
        dir.join(format!("{FILE_NAME}{suffix}"))
            .symlink_metadata()
            .is_ok()
    });
    if side_at_original && dir.join(FILE_NAME).symlink_metadata().is_err() {
        return Ok(true);
    }
    let prefix = format!("{FILE_NAME}.unreadable-");
    let mut databases = std::collections::HashSet::new();
    let mut sides = std::collections::HashSet::new();
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name();
        let Some(rest) = name.to_str().and_then(|name| name.strip_prefix(&prefix)) else {
            continue;
        };
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        let (stamp, suffix) = rest.split_at(digits);
        if stamp.is_empty() {
            continue;
        }
        if suffix.is_empty() {
            databases.insert(stamp.to_owned());
        } else if FILE_SUFFIXES[1..].contains(&suffix) {
            sides.insert(stamp.to_owned());
        }
    }
    Ok(sides.iter().any(|stamp| !databases.contains(stamp)))
}

/// One statement within the size limits: no second statement, no comment,
/// no word that controls transactions, connections or the schema.
fn check_statement(sql: &str, values: usize) -> Result<(), LocalDbError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() || sql.len() > MAX_SQL_BYTES || values > MAX_VALUES {
        return Err(LocalDbError::InvalidStatement);
    }
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    if body.contains(';') || body.contains("--") || body.contains("/*") {
        return Err(LocalDbError::InvalidStatement);
    }
    let forbidden = words(body).any(|word| {
        FORBIDDEN_WORDS
            .iter()
            .any(|forbidden| word.eq_ignore_ascii_case(forbidden))
    });
    // SQLite treats a bare `END` (or `END TRANSACTION`) as `COMMIT`, so a
    // leading `END` is refused like the words above. It cannot join
    // `FORBIDDEN_WORDS`, because `CASE … END` needs the word mid-statement.
    let starts_with_end = first_word(body).is_some_and(|first| first.eq_ignore_ascii_case("END"));
    if forbidden || starts_with_end {
        Err(LocalDbError::InvalidStatement)
    } else {
        Ok(())
    }
}

fn is_query(sql: &str) -> bool {
    first_word(sql).is_some_and(|first| {
        first.eq_ignore_ascii_case("SELECT") || first.eq_ignore_ascii_case("WITH")
    })
}

/// The statement's first word (see `words`): `Some("")` before any letter,
/// digit or `_` (`str::split` always yields at least one item, so this is
/// never actually `None`).
fn first_word(sql: &str) -> Option<&str> {
    words(sql.trim_start()).next()
}

/// SQL split into words of letters, digits and `_`; `created_at` stays one word.
fn words(sql: &str) -> impl Iterator<Item = &str> {
    sql.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
}

fn bind<'q>(
    mut query: Query<'q, Sqlite, SqliteArguments<'q>>,
    values: Vec<Value>,
) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>, LocalDbError> {
    for value in values {
        query = match value {
            Value::Null => query.bind(None::<String>),
            Value::Bool(value) => query.bind(value),
            Value::String(value) => query.bind(value),
            Value::Number(number) => match number.as_i64() {
                Some(integer) => query.bind(integer),
                // Above i64::MAX: SQLite cannot hold it as an integer.
                None if number.is_u64() => return Err(LocalDbError::UnsupportedValue),
                None => query.bind(number.as_f64().ok_or(LocalDbError::UnsupportedValue)?),
            },
            Value::Array(_) | Value::Object(_) => return Err(LocalDbError::UnsupportedValue),
        };
    }
    Ok(query)
}

/// A row as a JSON object keyed by column name, typed by the value SQLite
/// actually holds (not the declared column type).
fn row_object(row: &SqliteRow) -> Result<Map<String, Value>, LocalDbError> {
    let mut object = Map::new();
    for column in row.columns() {
        let index = column.ordinal();
        let raw = row
            .try_get_raw(index)
            .map_err(|_| LocalDbError::StatementFailed)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            let type_info = raw.type_info();
            match type_info.name() {
                "INTEGER" => Value::from(decode::<i64>(row, index)?),
                "REAL" => Number::from_f64(decode::<f64>(row, index)?)
                    .map(Value::Number)
                    .ok_or(LocalDbError::UnsupportedValue)?,
                "TEXT" => Value::String(decode::<String>(row, index)?),
                _ => return Err(LocalDbError::UnsupportedValue),
            }
        };
        object.insert(column.name().to_owned(), value);
    }
    Ok(object)
}

fn decode<'r, T: sqlx::Decode<'r, Sqlite>>(
    row: &'r SqliteRow,
    index: usize,
) -> Result<T, LocalDbError> {
    row.try_get_unchecked(index)
        .map_err(|_| LocalDbError::StatementFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sqlx records the checksum of each migration file's bytes: a CRLF
    /// checkout (Windows with `core.autocrlf`) would build a shell whose
    /// checksums differ from every other build's, and a local database made
    /// by one build would not open in the other. `.gitattributes` pins the
    /// migrations to LF; on a checkout that lost the pin this fails.
    #[test]
    fn the_migrations_are_embedded_with_lf_line_endings() {
        assert!(MIGRATOR.iter().count() > 0);
        for migration in MIGRATOR.iter() {
            assert!(
                !migration.sql.contains('\r'),
                "migration {} has a carriage return",
                migration.version
            );
        }
    }

    /// A rename refused for a moment is tried again, up to its attempts; a
    /// source that is not there is not.
    #[tokio::test]
    async fn a_refused_rename_is_tried_again_unless_the_file_is_not_there() {
        use std::io::{Error, ErrorKind};
        let delay = Duration::from_millis(1);
        let mut calls = 0;
        let moved = rename_retrying(5, delay, || {
            calls += 1;
            if calls < 3 {
                Err(Error::from(ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .await;
        assert!(moved.is_ok());
        assert_eq!(calls, 3);

        let mut calls = 0;
        let refused = rename_retrying(5, delay, || {
            calls += 1;
            Err(Error::from(ErrorKind::PermissionDenied))
        })
        .await;
        assert_eq!(refused.unwrap_err().kind(), ErrorKind::PermissionDenied);
        assert_eq!(calls, 5);

        let mut calls = 0;
        let missing = rename_retrying(5, delay, || {
            calls += 1;
            Err(Error::from(ErrorKind::NotFound))
        })
        .await;
        assert_eq!(missing.unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(calls, 1);
    }

    #[test]
    fn single_statements_with_parameters_pass() {
        for sql in [
            "SELECT id, name FROM ref_lines WHERE archived = ?",
            "WITH live AS (SELECT * FROM ref_lines) SELECT count(*) FROM live;",
            "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_rev', ?)",
            "SELECT created_at, begin_date, dropped FROM events",
            // `END` mid-statement (`CASE … END`) is not a leading `END`.
            "SELECT CASE WHEN archived = 1 THEN 'a' END FROM ref_lines",
        ] {
            assert_eq!(check_statement(sql, 4), Ok(()), "{sql}");
        }
    }

    #[test]
    fn second_statements_comments_and_control_words_are_refused() {
        for sql in [
            "",
            "   ",
            "SELECT 1; SELECT 2",
            "SELECT 1 -- note",
            "SELECT /* note */ 1",
            "BEGIN",
            "commit",
            "ROLLBACK",
            "END",
            "end transaction",
            "END;",
            "SAVEPOINT a",
            "RELEASE a",
            "PRAGMA journal_mode",
            "ATTACH 'other.db' AS other",
            "DETACH other",
            "VACUUM",
            "CREATE TABLE extra (x)",
            "DROP TABLE ref_lines",
            "ALTER TABLE ref_lines ADD COLUMN x",
            "REINDEX",
        ] {
            assert_eq!(
                check_statement(sql, 0),
                Err(LocalDbError::InvalidStatement),
                "{sql:?}"
            );
        }
    }

    #[test]
    fn statement_size_and_value_count_are_bounded() {
        // `SELECT '` + padding + `'` must add up to exactly `MAX_SQL_BYTES`.
        let overhead = "SELECT ''".len();
        let padded =
            |extra: usize| format!("SELECT '{}'", "x".repeat(MAX_SQL_BYTES - overhead + extra));
        let exactly_max = padded(0);
        assert_eq!(exactly_max.len(), MAX_SQL_BYTES);
        assert_eq!(check_statement(&exactly_max, 0), Ok(()));
        let one_over = padded(1);
        assert_eq!(one_over.len(), MAX_SQL_BYTES + 1);
        assert_eq!(
            check_statement(&one_over, 0),
            Err(LocalDbError::InvalidStatement)
        );
        assert_eq!(check_statement("SELECT ?", MAX_VALUES), Ok(()));
        assert_eq!(
            check_statement("SELECT ?", MAX_VALUES + 1),
            Err(LocalDbError::InvalidStatement)
        );
    }

    #[test]
    fn only_select_and_with_are_queries() {
        assert!(is_query("select 1"));
        assert!(is_query("  WITH live AS (SELECT 1) SELECT * FROM live"));
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "REPLACE INTO t VALUES (1)",
            "VALUES (1)",
            "(SELECT 1)",
        ] {
            assert!(!is_query(sql), "{sql}");
        }
    }

    /// The class filter itself is pinned here too, on probe tables of all
    /// three classes, whatever `TABLE_CLASSES` holds.
    #[tokio::test]
    async fn a_forget_empties_the_disposable_tables_and_keeps_the_other_classes() {
        use sqlx::{ConnectOptions, Connection};
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::open(dir.path()).await.unwrap();
        let mut raw = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join(FILE_NAME))
            .connect()
            .await
            .unwrap();
        for table in ["probe_disposable", "probe_device", "probe_workstation"] {
            for sql in [
                format!("CREATE TABLE {table} (id TEXT PRIMARY KEY)"),
                format!("INSERT INTO {table} (id) VALUES ('row')"),
            ] {
                sqlx::query(&sql).execute(&mut raw).await.unwrap();
            }
        }
        raw.close().await.unwrap();

        let classes = [
            ("probe_device", TableClass::DeviceData),
            ("probe_disposable", TableClass::Disposable),
            ("probe_workstation", TableClass::Workstation),
        ];
        assert_eq!(
            db.clear_classed(&classes, UnsentGuard::Ignore).await,
            Ok(())
        );

        for (table, left) in [
            ("probe_disposable", 0),
            ("probe_device", 1),
            ("probe_workstation", 1),
        ] {
            let rows = db
                .query(&format!("SELECT count(*) AS n FROM {table}"), vec![])
                .await
                .unwrap();
            assert_eq!(rows[0]["n"], serde_json::json!(left), "{table}");
        }
    }

    #[test]
    fn error_codes_are_stable() {
        let codes: Vec<&str> = [
            LocalDbError::Unavailable,
            LocalDbError::InvalidStatement,
            LocalDbError::UnsupportedValue,
            LocalDbError::StatementFailed,
            LocalDbError::ChangesMismatch,
            LocalDbError::UnsentRecords { count: 3 },
        ]
        .into_iter()
        .map(LocalDbError::code)
        .collect();
        assert_eq!(
            codes,
            [
                "local_db_unavailable",
                "invalid_statement",
                "unsupported_value",
                "statement_failed",
                "changes_mismatch",
                "unsent_facts"
            ]
        );
    }

    /// `check_statement`/`is_query` against the fixture plans 1c3–1e also run
    /// their TypeScript port (`test/support/local-db.ts`) against, so a
    /// statement the shell refuses fails in webview tests too.
    #[test]
    fn the_shared_sql_fixture_matches_the_rules() {
        #[derive(Deserialize)]
        struct Cases {
            accepted: Vec<String>,
            refused: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Fixture {
            statements: Cases,
            queries: Cases,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("../tests/fixtures/local-sql.json")).unwrap();
        for sql in &fixture.statements.accepted {
            assert_eq!(check_statement(sql, 0), Ok(()), "{sql:?}");
        }
        for sql in &fixture.statements.refused {
            assert_eq!(
                check_statement(sql, 0),
                Err(LocalDbError::InvalidStatement),
                "{sql:?}"
            );
        }
        for sql in &fixture.queries.accepted {
            assert!(is_query(sql), "{sql:?}");
        }
        for sql in &fixture.queries.refused {
            assert!(!is_query(sql), "{sql:?}");
        }
    }

    /// A connection sqlx left with a stuck non-zero transaction depth (its own
    /// background `ROLLBACK` failed because SQLite had already ended the
    /// transaction) must never be handed back out: every later
    /// `begin_with("BEGIN IMMEDIATE")` on it would fail forever.
    #[tokio::test]
    async fn a_writer_connection_with_a_stuck_transaction_is_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        let db = LocalDb::open(dir.path()).await.unwrap();

        // Commit with a raw statement instead of `tx.commit()`: sqlx's own
        // depth bookkeeping never learns about it, so when `tx` drops without
        // an explicit commit or rollback, its background `ROLLBACK` finds no
        // transaction to roll back, fails, and leaves the connection's depth
        // stuck at 1.
        let mut tx = db.writer.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("COMMIT").execute(&mut *tx).await.unwrap();
        drop(tx);

        let probe = vec![LocalStatement {
            sql: "INSERT INTO sync_state (key, value) VALUES ('probe', '1')".to_owned(),
            values: Vec::new(),
            expected_changes: None,
        }];
        assert_eq!(db.transaction(probe).await, Ok(vec![1]));
    }

    /// A database error SQLite reports with the given extended result code.
    #[derive(Debug)]
    struct Coded(&'static str);

    impl std::fmt::Display for Coded {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(formatter, "result code {}", self.0)
        }
    }

    impl std::error::Error for Coded {}

    impl sqlx::error::DatabaseError for Coded {
        fn message(&self) -> &str {
            "coded"
        }

        fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
            Some(self.0.into())
        }

        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
    }

    fn database_error(code: &'static str) -> sqlx::Error {
        sqlx::Error::Database(Box::new(Coded(code)))
    }

    /// Corruption is the primary code `SQLITE_CORRUPT` (11) or `SQLITE_NOTADB`
    /// (26), also in its extended forms (`CORRUPT_VTAB` 267, `CORRUPT_INDEX`
    /// 779: the primary code is the low byte), and also when it surfaces from a
    /// migration. Busy (5), cannot-open (14), full disk (13), I/O (10, 522)
    /// and a code that is no number are not.
    #[test]
    fn only_corruption_codes_make_an_open_failure_corrupt() {
        use sqlx::migrate::MigrateError;
        for code in ["11", "26", "267", "779"] {
            assert_eq!(
                open_failure_of(&database_error(code)),
                OpenFailure::Corrupt,
                "{code}"
            );
            let in_a_migration =
                sqlx::Error::Migrate(Box::new(MigrateError::Execute(database_error(code))));
            assert_eq!(open_failure_of(&in_a_migration), OpenFailure::Corrupt);
            let in_one_migration = sqlx::Error::Migrate(Box::new(MigrateError::ExecuteMigration(
                database_error(code),
                3,
            )));
            assert_eq!(open_failure_of(&in_one_migration), OpenFailure::Corrupt);
        }
        for code in ["5", "13", "14", "10", "522", "1", "", "corrupt"] {
            assert_eq!(
                open_failure_of(&database_error(code)),
                OpenFailure::Other,
                "{code:?}"
            );
        }
        let missing = sqlx::Error::Migrate(Box::new(MigrateError::VersionMissing(9999)));
        assert_eq!(open_failure_of(&missing), OpenFailure::Other);
        let io = sqlx::Error::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(open_failure_of(&io), OpenFailure::Other);
    }
}
