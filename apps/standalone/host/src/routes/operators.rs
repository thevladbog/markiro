//! Operators (spec §4.3), administrators only: `GET /v1/office/operators`,
//! `POST` and `PUT …/{id}` (`PUT` with `expectedRev`). The office computes
//! the PIN's PHC string with `@markiro/domain`; the host checks its format
//! and never returns a hash (`hasPin` instead). An operator is in the station
//! feed only while active: a deactivation writes a tombstone and a
//! reactivation drops it (`feed`).

use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::{entities, BadgeInfo, OfficeOperator, OperatorCreate, OperatorUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::feed;
use crate::server::AppState;
use crate::validate;

const OPERATORS: &str =
    "SELECT id, login, name, role, active, pin_phc IS NOT NULL AS has_pin, rev FROM operators";
const BADGES: &str = "SELECT id, operator_id, label, created_at, revoked_at FROM operator_badges";

#[derive(sqlx::FromRow)]
struct OperatorRow {
    id: String,
    login: String,
    name: String,
    role: Option<String>,
    active: bool,
    has_pin: bool,
    rev: i64,
}

#[derive(sqlx::FromRow)]
struct BadgeRow {
    id: String,
    operator_id: String,
    label: Option<String>,
    created_at: String,
    revoked_at: Option<String>,
}

fn operator(row: OperatorRow, badges: Vec<BadgeInfo>) -> OfficeOperator {
    OfficeOperator {
        id: row.id,
        login: row.login,
        name: row.name,
        role: row.role,
        active: row.active,
        has_pin: row.has_pin,
        badges,
        rev: row.rev,
    }
}

fn badge(row: BadgeRow) -> BadgeInfo {
    BadgeInfo {
        id: row.id,
        label: row.label,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
    }
}

/// One operator with its badges, oldest first.
async fn read_operator(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeOperator>, ApiError> {
    let row: Option<OperatorRow> = sqlx::query_as(&format!("{OPERATORS} WHERE id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let badges: Vec<BadgeRow> = sqlx::query_as(&format!(
        "{BADGES} WHERE operator_id = ? ORDER BY created_at, id"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Some(operator(row, badges.into_iter().map(badge).collect())))
}

/// A write that hit `operators.login UNIQUE`.
fn login_taken(error: sqlx::Error) -> ApiError {
    match error.as_database_error() {
        Some(database) if database.is_unique_violation() => {
            ApiError::conflict("login", "this personnel number is already taken")
        }
        _ => ApiError::internal(error),
    }
}

pub async fn list_operators(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<OfficeOperator>>, ApiError> {
    context.require_admin()?;
    // One read transaction: the operators and their badges come from one WAL
    // snapshot, so a badge added in between cannot miss its operator.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows: Vec<OperatorRow> = sqlx::query_as(&format!("{OPERATORS} ORDER BY login"))
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let badge_rows: Vec<BadgeRow> = sqlx::query_as(&format!("{BADGES} ORDER BY created_at, id"))
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let mut badges: HashMap<String, Vec<BadgeInfo>> = HashMap::new();
    for row in badge_rows {
        badges
            .entry(row.operator_id.clone())
            .or_default()
            .push(badge(row));
    }
    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let own = badges.remove(&row.id).unwrap_or_default();
                operator(row, own)
            })
            .collect(),
    ))
}

pub async fn create_operator(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<OperatorCreate>,
) -> Result<Json<OfficeOperator>, ApiError> {
    context.require_admin()?;
    let login = create.login.trim().to_owned();
    validate::operator_login("login", &login)?;
    let name = validate::person_name("name", &create.name)?;
    let role = validate::operator_role("role", create.role.as_deref())?;
    validate::pin_phc("pinPhc", create.pin_phc.expose())?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(&id)
    .bind(&login)
    .bind(&name)
    .bind(&role)
    .bind(create.pin_phc.expose())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(login_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_CREATE,
            target_type: Some("operator"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "login": login, "role": role }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_operator(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<OperatorUpdate>,
) -> Result<Json<OfficeOperator>, ApiError> {
    context.require_admin()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::person_name("name", name))
        .transpose()?;
    let role = update
        .role
        .as_ref()
        .map(|role| validate::operator_role("role", role.as_deref()))
        .transpose()?;
    if let Some(pin_phc) = &update.pin_phc {
        validate::pin_phc("pinPhc", pin_phc.expose())?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such operator"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let current_pin: String = sqlx::query_scalar("SELECT pin_phc FROM operators WHERE id = ?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let name = name.unwrap_or_else(|| current.name.clone());
    let role = role.unwrap_or_else(|| current.role.clone());
    let active = update.active.unwrap_or(current.active);
    let pin_phc = update
        .pin_phc
        .as_ref()
        .map_or(current_pin.as_str(), |pin_phc| pin_phc.expose());
    let Some(details) = audit::update_details_hiding(
        &[
            ("name", json!(current.name), json!(name)),
            ("role", json!(current.role), json!(role)),
            ("active", json!(current.active), json!(active)),
        ],
        &[("pinPhc", pin_phc != current_pin)],
    ) else {
        // Nothing actually changed: report the operator as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE operators SET name = ?, role = ?, active = ?, pin_phc = ?, rev = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(&role)
    .bind(active)
    .bind(pin_phc)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    // Access leaves the station feed as a tombstone and comes back as a record
    // (spec §4.4), never as a flag on the record.
    match (current.active, active) {
        (true, false) => feed::remove(&mut tx, entities::OPERATORS, &id, rev).await,
        (false, true) => feed::restore(&mut tx, entities::OPERATORS, &id).await,
        _ => Ok(()),
    }
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_UPDATE,
            target_type: Some("operator"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_operator(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("operator vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
