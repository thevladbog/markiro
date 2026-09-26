//! Master database: SQLite in WAL mode, every transaction synced to disk.

use std::path::Path;
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Sqlite, SqliteConnection, Transaction};

/// `host/migrations`, embedded at compile time. Applied migrations are never
/// edited: sqlx refuses to start when a checksum changes.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

/// The first-run wizard has completed (`site.initialized_at` is set).
pub async fn is_initialized(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let initialized_at: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_one(pool)
            .await?;
    Ok(initialized_at.is_some())
}

/// Start a write transaction that takes SQLite's write lock up front
/// (`BEGIN IMMEDIATE`). With a deferred `BEGIN`, a read followed by a write on
/// a stale WAL snapshot fails with SQLITE_BUSY at once and `busy_timeout`
/// cannot help; the revision bump below is exactly that pattern.
pub async fn begin_write(pool: &SqlitePool) -> Result<Transaction<'static, Sqlite>, sqlx::Error> {
    pool.begin_with("BEGIN IMMEDIATE").await
}

/// Increase the global revision by one inside the current transaction and
/// return the new value (spec §4.4: one revision per changing transaction).
pub async fn next_revision(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("UPDATE host_revision SET rev = rev + 1 WHERE id = 1 RETURNING rev")
        .fetch_one(conn)
        .await
}
