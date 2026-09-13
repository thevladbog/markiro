use serde::Deserialize;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Executor, SqliteConnection};
use tauri::Manager;

const DATABASE_NAME: &str = "station-mirror.db";
const MAX_STATEMENTS: usize = 32;
const MAX_SQL_BYTES: usize = 64 * 1024;
const MAX_VALUES: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct AtomicStatement {
    sql: String,
    values: Vec<Value>,
    #[serde(default)]
    expected_changes: Option<u64>,
}

fn validate(statements: &[AtomicStatement]) -> Result<(), String> {
    if statements.is_empty() || statements.len() > MAX_STATEMENTS {
        return Err("invalid offline grant transaction size".into());
    }
    for statement in statements {
        if statement.sql.is_empty()
            || statement.sql.len() > MAX_SQL_BYTES
            || statement.values.len() > MAX_VALUES
        {
            return Err("invalid offline grant transaction statement".into());
        }
        let trimmed = statement.sql.trim();
        let without_terminal = trimmed.strip_suffix(';').unwrap_or(trimmed);
        if without_terminal.contains(';')
            || without_terminal.contains("--")
            || without_terminal.contains("/*")
        {
            return Err("each transaction element must contain one statement".into());
        }
        let normalized = without_terminal.to_ascii_uppercase();
        let forbidden = normalized
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|token| {
                matches!(
                    token,
                    "BEGIN"
                        | "COMMIT"
                        | "ROLLBACK"
                        | "SAVEPOINT"
                        | "RELEASE"
                        | "ATTACH"
                        | "DETACH"
                        | "PRAGMA"
                )
            });
        if forbidden {
            return Err("transaction control is owned by the native command".into());
        }
    }
    Ok(())
}

async fn execute(
    connection: &mut SqliteConnection,
    statements: Vec<AtomicStatement>,
) -> Result<Vec<u64>, String> {
    let mut transaction = connection
        .begin()
        .await
        .map_err(|_| "station transaction unavailable".to_string())?;
    let mut affected = Vec::with_capacity(statements.len());
    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.values {
            query = match value {
                Value::Null => query.bind(Option::<String>::None),
                Value::Bool(value) => query.bind(value),
                Value::String(value) => query.bind(value),
                Value::Number(value) if value.is_i64() => query.bind(value.as_i64().unwrap_or(0)),
                Value::Number(value) if value.is_u64() => {
                    let value = i64::try_from(value.as_u64().unwrap_or(u64::MAX))
                        .map_err(|_| "station transaction integer overflow".to_string())?;
                    query.bind(value)
                }
                Value::Number(value) => query.bind(
                    value
                        .as_f64()
                        .ok_or_else(|| "station transaction number unavailable".to_string())?,
                ),
                Value::Array(_) | Value::Object(_) => {
                    return Err("station transaction values must be scalar".into())
                }
            };
        }
        let result = transaction
            .execute(query)
            .await
            .map_err(|error| format!("station transaction failed: {error}"))?;
        if statement
            .expected_changes
            .is_some_and(|expected| expected != result.rows_affected())
        {
            return Err("station transaction owner conflict".into());
        }
        affected.push(result.rows_affected());
    }
    transaction
        .commit()
        .await
        .map_err(|_| "station transaction commit failed".to_string())?;
    Ok(affected)
}

#[tauri::command]
pub async fn grant_atomic_execute(
    app: tauri::AppHandle,
    statements: Vec<AtomicStatement>,
) -> Result<Vec<u64>, String> {
    validate(&statements)?;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "station database directory unavailable".to_string())?
        .join(DATABASE_NAME);
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|_| "station database unavailable".to_string())?;
    execute(&mut connection, statements).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nested_transaction_and_unbounded_batches() {
        assert!(validate(&[]).is_err());
        assert!(validate(&[AtomicStatement {
            sql: "BEGIN".into(),
            values: vec![],
            expected_changes: None,
        }])
        .is_err());
        assert!(validate(&[AtomicStatement {
            sql: "INSERT INTO t(value) VALUES(?)".into(),
            values: vec![Value::String("ok".into())],
            expected_changes: None,
        }])
        .is_ok());
        assert!(validate(&[AtomicStatement {
            sql: "SELECT 1; COMMIT".into(),
            values: vec![],
            expected_changes: None
        }])
        .is_err());
        assert!(validate(&[AtomicStatement {
            sql: "-- harmless\nCOMMIT".into(),
            values: vec![],
            expected_changes: None
        }])
        .is_err());
    }

    #[test]
    fn rolls_back_the_first_statement_when_a_later_statement_fails() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            connection
                .execute("CREATE TABLE facts(value TEXT NOT NULL)")
                .await
                .unwrap();
            let result = execute(
                &mut connection,
                vec![
                    AtomicStatement {
                        sql: "INSERT INTO facts(value) VALUES(?)".into(),
                        values: vec![Value::String("kept?".into())],
                        expected_changes: None,
                    },
                    AtomicStatement {
                        sql: "INSERT INTO missing(value) VALUES(?)".into(),
                        values: vec![Value::String("fail".into())],
                        expected_changes: None,
                    },
                ],
            )
            .await;
            assert!(result.is_err());
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM facts")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn rolls_back_when_an_owner_cas_changes_no_rows() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            connection
                .execute("CREATE TABLE facts(id INTEGER PRIMARY KEY,value TEXT NOT NULL)")
                .await
                .unwrap();
            connection
                .execute("INSERT INTO facts(id,value) VALUES(1,'before')")
                .await
                .unwrap();
            let result = execute(
                &mut connection,
                vec![
                    AtomicStatement {
                        sql: "UPDATE facts SET value='changed' WHERE id=1".into(),
                        values: vec![],
                        expected_changes: Some(1),
                    },
                    AtomicStatement {
                        sql: "UPDATE facts SET value='lost' WHERE id=2".into(),
                        values: vec![],
                        expected_changes: Some(1),
                    },
                ],
            )
            .await;
            assert!(result.is_err());
            let value: String = sqlx::query_scalar("SELECT value FROM facts WHERE id=1")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(value, "before");
        });
    }
}
