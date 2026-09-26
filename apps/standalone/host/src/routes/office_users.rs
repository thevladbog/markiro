//! Office users, administrators only: list, create, update (with the
//! last-administrator guard) and set a password.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, OfficeRole, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, PasswordSet,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::secrets::hash_password;
use crate::server::AppState;
use crate::validate;

type UserRow = (String, String, String, String, i64, String, i64);

fn record(
    (id, login, name, role, active, created_at, rev): UserRow,
) -> Result<OfficeUserRecord, ApiError> {
    Ok(OfficeUserRecord {
        id,
        login,
        name,
        role: serde_json::from_value(serde_json::Value::String(role))
            .map_err(ApiError::internal)?,
        active: active == 1,
        created_at,
        rev,
    })
}

async fn read_user(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeUserRecord>, ApiError> {
    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, active, created_at, rev FROM office_users WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

async fn hash(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(ApiError::internal)
}

pub async fn list_users(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<OfficeUserRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, active, created_at, rev FROM office_users ORDER BY login COLLATE NOCASE",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn create_user(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<OfficeUserCreate>,
) -> Result<Json<OfficeUserRecord>, ApiError> {
    context.require_admin()?;
    let login = create.login.trim().to_owned();
    validate::office_login("login", &login)?;
    let name = validate::person_name("name", &create.name)?;
    validate::password("password", &create.password)?;
    let password_phc = hash(create.password).await?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let inserted = sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(&login)
    .bind(&name)
    .bind(create.role.as_str())
    .bind(&password_phc)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        return Err(match error.as_database_error() {
            Some(database) if database.is_unique_violation() => {
                ApiError::conflict("login", "this login is already taken")
            }
            _ => ApiError::internal(error),
        });
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.create",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "login": login, "role": create.role.as_str() }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read_user(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("user vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_user(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<OfficeUserUpdate>,
) -> Result<Json<OfficeUserRecord>, ApiError> {
    context.require_admin()?;
    let name = validate::person_name("name", &update.name)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let current = read_user(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such office user"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let loses_admin = current.active
        && current.role == OfficeRole::Admin
        && (update.role != OfficeRole::Admin || !update.active);
    if loses_admin {
        let other_admins: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM office_users WHERE role = 'admin' AND active = 1 AND id <> ?",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        if other_admins == 0 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                codes::LAST_ADMIN,
                "the last active administrator must stay",
            ));
        }
    }
    let mut changed = Vec::new();
    if current.name != name {
        changed.push("name");
    }
    if current.role != update.role {
        changed.push("role");
    }
    if current.active != update.active {
        changed.push("active");
    }
    if changed.is_empty() {
        // Nothing actually changed: report the record as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE office_users SET name = ?, role = ?, active = ?, rev = ? WHERE id = ?")
        .bind(&name)
        .bind(update.role.as_str())
        .bind(i64::from(update.active))
        .bind(rev)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if !update.active {
        sqlx::query("DELETE FROM office_sessions WHERE user_id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.update",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "changed": changed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_user(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("user vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

pub async fn set_password(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(body): ApiJson<PasswordSet>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    validate::password("password", &body.password)?;
    let password_phc = hash(body.password).await?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if read_user(&mut tx, &id).await?.is_none() {
        return Err(ApiError::not_found("no such office user"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE office_users SET password_phc = ?, rev = ? WHERE id = ?")
        .bind(&password_phc)
        .bind(rev)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // Every other session of that user ends; the caller's own session stays.
    sqlx::query("DELETE FROM office_sessions WHERE user_id = ? AND id <> ?")
        .bind(&id)
        .bind(&context.session_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office_user.password",
            target_type: Some("office_user"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({}),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
