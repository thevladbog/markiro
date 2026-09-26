//! Master database: SQLite in WAL mode, every transaction synced to disk.

use std::path::Path;
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

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
