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

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Number, Value};
use sqlx::migrate::Migrator;
use sqlx::query::Query;
use sqlx::sqlite::{
    SqliteArguments, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions,
    SqliteRow, SqliteSynchronous,
};
use sqlx::{Column, Row, Sqlite, TypeInfo, ValueRef};

pub const FILE_NAME: &str = "standalone-station.db";
/// `MAX_STATEMENTS`, `MAX_SQL_BYTES` and `MAX_VALUES` here, and
/// `FORBIDDEN_WORDS` below, are mirrored for tests in
/// `apps/standalone/test/support/local-db.ts`. A rule change here updates
/// that file too and adds a case to `src-tauri/tests/fixtures/local-sql.json`.
pub const MAX_STATEMENTS: usize = 32;
pub const MAX_SQL_BYTES: usize = 64 * 1024;
pub const MAX_VALUES: usize = 256;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// SQLite refused or failed the statement; a batch rolled back whole.
    StatementFailed,
    /// A statement changed another number of rows than `expectedChanges`;
    /// the batch rolled back whole.
    ChangesMismatch,
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
        }
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
    /// file and the schema as needed.
    pub async fn open(dir: &Path) -> Result<Self, sqlx::Error> {
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
                    .busy_timeout(BUSY_TIMEOUT),
            )
            .await?;
        MIGRATOR.run(&writer).await?;
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

    /// Delete every row of every table but sqlx's migration journal, in one
    /// writer transaction: forgetting the device must not leave another
    /// pairing's copies behind (from plan 1d3 on, PIN and badge hashes).
    /// Every table here is treated as a disposable copy of the host's data;
    /// the first plan that adds data this device owns instead of a copy —
    /// the scan journal, boxes, the outbox (the station design's §6.2,
    /// "Логическая модель") — must exclude those tables from this list and
    /// block or confirm a forget while unsynced records exist, not extend
    /// this silently.
    /// The tables come from `pragma_table_list`, so one a later migration
    /// adds is covered without a change here; `type IN ('table', 'virtual')`
    /// excludes a virtual table's own shadow tables (FTS5, RTree), which
    /// `sqlite_master` lists as ordinary tables but a bare `DELETE` would
    /// corrupt instead of clearing through the virtual table itself. Foreign
    /// keys are checked at the commit, when every table is empty, so the
    /// order of the deletes does not matter.
    pub async fn clear_copies(&self) -> Result<(), LocalDbError> {
        let mut tx = self
            .writer
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *tx)
            .await
            .map_err(|_| LocalDbError::StatementFailed)?;
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' \
             AND type IN ('table', 'virtual') AND name <> '_sqlx_migrations' \
             AND name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(|_| LocalDbError::StatementFailed)?;
        for table in tables {
            let delete = format!("DELETE FROM \"{}\"", table.replace('"', "\"\""));
            sqlx::query(&delete)
                .execute(&mut *tx)
                .await
                .map_err(|_| LocalDbError::StatementFailed)?;
        }
        tx.commit().await.map_err(|_| LocalDbError::StatementFailed)
    }
}

/// Tauri state: the local database, or `None` when it could not be opened.
/// The app still starts — the office works without it — and the local
/// commands answer `local_db_unavailable`.
pub struct LocalDbState(Option<LocalDb>);

impl LocalDbState {
    pub async fn open(dir: &Path) -> Self {
        Self(LocalDb::open(dir).await.ok())
    }

    pub fn unavailable() -> Self {
        Self(None)
    }

    pub fn get(&self) -> Result<&LocalDb, LocalDbError> {
        self.0.as_ref().ok_or(LocalDbError::Unavailable)
    }
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

    #[test]
    fn error_codes_are_stable() {
        let codes: Vec<&str> = [
            LocalDbError::Unavailable,
            LocalDbError::InvalidStatement,
            LocalDbError::UnsupportedValue,
            LocalDbError::StatementFailed,
            LocalDbError::ChangesMismatch,
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
                "changes_mismatch"
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
}
