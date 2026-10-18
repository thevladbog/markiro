//! Operators (spec §4.3), administrators only: `GET /v1/office/operators`,
//! `POST` and `PUT …/{id}` (`PUT` with `expectedRev`), their badges (`POST
//! …/{id}/badges`, `DELETE …/{id}/badges/{badge_id}`) and the site's badge
//! salt (`GET /v1/office/badge-salt`). The office computes PIN and badge PHC
//! strings with `@markiro/domain`; the host checks their format and never
//! returns a hash (`hasPin` and badge metadata instead). An operator is in
//! the station feed only while active and a badge only while not revoked:
//! leaving it writes a tombstone (`feed`).

use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{
    codes, entities, BadgeCreate, BadgeInfo, BadgeSalt, OfficeOperator, OperatorCreate,
    OperatorUpdate, Secret,
};
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
    ApiError::conflict_on_unique_violation(error, "login", "this personnel number is already taken")
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
    // A number that differs from another only by leading zeros (`042` next
    // to `0042`) is taken too (owner question В13): on a keypad the two are
    // one slip apart. The unique index stays the guard of the exact number.
    // Pairs that already exist stay as they are; when several numbers stand
    // in the way, the same number comes first, then the lowest, so the answer
    // does not depend on row order.
    let similar: Option<String> = sqlx::query_scalar(
        "SELECT login FROM operators WHERE ltrim(login, '0') = ltrim(?, '0') \
         ORDER BY login = ? DESC, login LIMIT 1",
    )
    .bind(&login)
    .bind(&login)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some(similar) = similar {
        return Err(
            ApiError::conflict("login", "this personnel number is already taken")
                .with_details(json!({ "constraint": "login", "similarLogin": similar })),
        );
    }
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

/// Turns the operator `id` off inside a write that already took `rev`, as
/// «Выключить» does through `update_operator`: the record takes `rev`, its
/// access leaves the station feed as a tombstone, and an `operator.update`
/// row names `active`. An operator already off, or gone, is left alone and
/// `false` is returned. Archiving a linked employee calls it (owner decision
/// В1, as the cloud drops an archived employee from the roster).
pub(crate) async fn turn_off_in(
    tx: &mut SqliteConnection,
    actor: audit::Actor<'_>,
    at: &str,
    id: &str,
    rev: i64,
) -> Result<bool, ApiError> {
    let active: Option<bool> = sqlx::query_scalar("SELECT active FROM operators WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if active != Some(true) {
        return Ok(false);
    }
    sqlx::query("UPDATE operators SET active = 0, rev = ? WHERE id = ?")
        .bind(rev)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    feed::remove(&mut *tx, entities::OPERATORS, id, rev)
        .await
        .map_err(ApiError::internal)?;
    let details = audit::update_details(&[("active", json!(true), json!(false))])
        .ok_or_else(|| ApiError::internal("a turn-off changed nothing"))?;
    audit::record(
        &mut *tx,
        at,
        Entry {
            actor,
            action: actions::OPERATOR_UPDATE,
            target_type: Some("operator"),
            target_id: Some(id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(true)
}

/// The site's badge salt; `not_found` before the wizard created it.
async fn site_salt(conn: &mut SqliteConnection) -> Result<Vec<u8>, ApiError> {
    let salt: Option<Vec<u8>> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)?;
    salt.ok_or_else(|| ApiError::not_found("the host is not initialized"))
}

/// A write that hit `operator_badges_active_phc`: the badge is already an
/// active badge of some operator, whom `details.operatorId` names when the
/// holder is found, read in the same transaction. If it is not (only the new
/// badge's random id colliding with an existing one gets there), the conflict
/// is answered plain, without `operatorId`. Only administrators reach this
/// route, and they see every operator anyway. Any other failure is `internal`.
async fn badge_taken(conn: &mut SqliteConnection, error: sqlx::Error, badge_phc: &str) -> ApiError {
    let conflict = ApiError::conflict_on_unique_violation(
        error,
        "badge",
        "this badge already belongs to an operator",
    );
    if conflict.code() != codes::CONFLICT {
        return conflict;
    }
    let owner: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "SELECT operator_id FROM operator_badges WHERE badge_phc = ? AND revoked_at IS NULL",
    )
    .bind(badge_phc)
    .fetch_optional(&mut *conn)
    .await;
    match owner {
        Ok(Some(operator_id)) => {
            conflict.with_details(json!({ "constraint": "badge", "operatorId": operator_id }))
        }
        Ok(None) => conflict,
        Err(error) => ApiError::internal(error),
    }
}

/// `GET /v1/office/badge-salt` (administrators): the salt the office hashes
/// badge codes with, as stations and the cloud do.
pub async fn badge_salt(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<BadgeSalt>, ApiError> {
    context.require_admin()?;
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let salt = site_salt(&mut conn).await?;
    Ok(Json(BadgeSalt {
        badge_salt: Secret::new(STANDARD.encode(salt)),
    }))
}

/// `POST /v1/office/operators/{id}/badges` (administrators): a badge hashed
/// with the site's salt. A badge code belongs to one operator at a time.
pub async fn create_badge(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(operator_id): ApiPath<String>,
    ApiJson(create): ApiJson<BadgeCreate>,
) -> Result<Json<BadgeInfo>, ApiError> {
    context.require_admin()?;
    let label = validate::badge_label("label", create.label.as_deref())?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let salt = site_salt(&mut tx).await?;
    validate::badge_phc("badgePhc", create.badge_phc.expose(), &salt)?;
    let operator: Option<i64> = sqlx::query_scalar("SELECT 1 FROM operators WHERE id = ?")
        .bind(&operator_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if operator.is_none() {
        return Err(ApiError::not_found("no such operator"));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let inserted = sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&operator_id)
    .bind(create.badge_phc.expose())
    .bind(&label)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        return Err(badge_taken(&mut tx, error, create.badge_phc.expose()).await);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_BADGE_CREATE,
            target_type: Some("operator_badge"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "operatorId": operator_id, "label": label }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(BadgeInfo {
        id,
        label,
        created_at: at,
        revoked_at: None,
    }))
}

/// `DELETE /v1/office/operators/{id}/badges/{badge_id}` (administrators):
/// revoke the badge. It leaves the station feed as a tombstone and never
/// comes back; revoking a revoked badge changes nothing.
pub async fn revoke_badge(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath((operator_id, badge_id)): ApiPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let revoked_at: Option<Option<String>> = sqlx::query_scalar(
        "SELECT revoked_at FROM operator_badges WHERE id = ? AND operator_id = ?",
    )
    .bind(&badge_id)
    .bind(&operator_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    match revoked_at {
        None => return Err(ApiError::not_found("no such badge of this operator")),
        // Already revoked: no revision, no row write, no audit row.
        Some(Some(_)) => return Ok(StatusCode::NO_CONTENT),
        Some(None) => {}
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE operator_badges SET revoked_at = ?, rev = ? WHERE id = ?")
        .bind(&at)
        .bind(rev)
        .bind(&badge_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    feed::remove(&mut tx, entities::OPERATOR_BADGES, &badge_id, rev)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::OPERATOR_BADGE_REVOKE,
            target_type: Some("operator_badge"),
            target_id: Some(&badge_id),
            outcome: Outcome::Ok,
            details: json!({ "operatorId": operator_id }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
