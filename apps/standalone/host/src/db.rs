//! Master database: SQLite in WAL mode, every transaction synced to disk.

use std::path::Path;
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Sqlite, SqliteConnection, Transaction};
use tokio::sync::watch;

/// `host/migrations`, embedded at compile time. Applied migrations are never
/// edited: sqlx refuses to start when a checksum changes.
pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// The pragmas of every connection to the master database: WAL, every
/// transaction synced, foreign keys, a 5 s busy timeout. The pool and the
/// backup worker's own connection (plan РК) use them alike.
pub fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
}

pub async fn open(path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options(path).create_if_missing(true))
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

/// The host's current revision (spec §4.4): what `GET /v1/changes` reports as
/// `rev` once nothing more follows, and what the change stream's first event
/// carries.
pub async fn current_revision(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(conn)
        .await
}

/// Commit a write transaction and, only if the commit succeeded, run
/// `notify`, as ONE task that the caller's cancellation cannot split.
///
/// hyper drops a handler's future when the client hangs up (the shell's
/// client gives up after 10 s, most likely when a commit is slow). With
/// `commit().await` and the notification in the handler's own future, a drop
/// can land between them: SQLite has the COMMIT, so the write is there, but
/// nobody is woken. A station then keeps a deactivated operator or a revoked
/// badge until some later commit, and a revoked device's stream stays open.
/// Here both run in a spawned task that finishes whatever the caller does;
/// the caller only waits for the outcome. A task that panicked or was
/// cancelled with the runtime is reported as `WorkerCrashed`, whose message
/// holds nothing of the panic.
///
/// A writer awaits nothing between its commit and its notification, and adds
/// no drop guard that announces on the way out: a guard could announce a
/// revision that was rolled back, and `rev > latest` would then suppress the
/// real commit that reuses that number.
pub async fn commit_and_notify(
    tx: Transaction<'static, Sqlite>,
    notify: impl FnOnce() + Send + 'static,
) -> Result<(), sqlx::Error> {
    tokio::spawn(async move {
        tx.commit().await?;
        notify();
        Ok(())
    })
    .await
    .map_err(|error| {
        // Only whether it panicked: the payload could hold anything.
        tracing::error!(panicked = error.is_panic(), "commit task did not finish");
        sqlx::Error::WorkerCrashed
    })?
}

/// Commit a write transaction that moved the global revision to `rev`, then
/// wake change-stream subscribers ([`commit_and_notify`]: the two cannot be
/// separated by the caller going away). Notifying only after the commit means
/// a device that reacts at once already reads the new rows.
pub async fn commit_with_revision(
    tx: Transaction<'static, Sqlite>,
    revisions: &watch::Sender<i64>,
    rev: i64,
) -> Result<(), sqlx::Error> {
    let revisions = revisions.clone();
    commit_and_notify(tx, move || {
        revisions.send_if_modified(|latest| {
            if rev > *latest {
                *latest = rev;
                true
            } else {
                false
            }
        });
    })
    .await
}
