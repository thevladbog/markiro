//! Employees (migration `0018`), administrators only: `GET
//! /v1/office/employees`, `POST` and `PUT …/{id}` (the whole record with
//! `expectedRev`). The site's register of people, as the cloud's
//! `employees`; an employee may be linked to one operator and an operator to
//! one employee (`operatorId`). Office data: never in the station feed and
//! never a credential, so the link grants nothing — the operator keeps its
//! own personnel number, PIN and badges, and the station's copies do not
//! change. An archived employee is linked to no operator, and archiving one
//! that was linked turns that operator off in the same write
//! (`operators::turn_off_in`, owner decision В1), which the stations get as
//! the tombstone of any turn-off.

use axum::extract::State;
use axum::Json;
use markiro_proto::{EmployeeCreate, EmployeeRecord, EmployeeUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

const SELECT: &str = "SELECT id, name, role, operator_id, archived, rev FROM employees";

#[derive(sqlx::FromRow)]
struct EmployeeRow {
    id: String,
    name: String,
    role: Option<String>,
    operator_id: Option<String>,
    archived: bool,
    rev: i64,
}

fn record(row: EmployeeRow) -> EmployeeRecord {
    EmployeeRecord {
        id: row.id,
        name: row.name,
        role: row.role,
        operator_id: row.operator_id,
        archived: row.archived,
        rev: row.rev,
    }
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<EmployeeRecord>, ApiError> {
    let row: Option<EmployeeRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(row.map(record))
}

/// The link `operator_id` for the employee `id` (`None` for a new one): the
/// operator must exist, the employee must not be archived, and no other
/// employee may hold it (`conflict` on `operator` naming that employee in
/// `details.employeeId`; only administrators reach the route).
async fn check_link(
    conn: &mut SqliteConnection,
    id: Option<&str>,
    operator_id: Option<&str>,
    archived: bool,
) -> Result<(), ApiError> {
    let Some(operator_id) = operator_id else {
        return Ok(());
    };
    if archived {
        return Err(ApiError::validation(
            "operatorId",
            "an archived employee is linked to no operator",
        ));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM operators WHERE id = ?")
        .bind(operator_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if exists.is_none() {
        return Err(ApiError::validation("operatorId", "no such operator"));
    }
    let holder: Option<String> = sqlx::query_scalar(
        "SELECT id FROM employees WHERE operator_id = ? AND id IS NOT ? LIMIT 1",
    )
    .bind(operator_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match holder {
        Some(holder) => Err(ApiError::conflict(
            "operator",
            "this operator is already linked to another employee",
        )
        .with_details(json!({ "constraint": "operator", "employeeId": holder }))),
        None => Ok(()),
    }
}

/// A write that hit `employees.operator_id UNIQUE` after `check_link` passed.
fn operator_taken(error: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(
        error,
        "operator",
        "this operator is already linked to another employee",
    )
}

pub async fn list_employees(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<EmployeeRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<EmployeeRow> = sqlx::query_as(&format!("{SELECT} ORDER BY archived, name, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(rows.into_iter().map(record).collect()))
}

pub async fn create_employee(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<EmployeeCreate>,
) -> Result<Json<EmployeeRecord>, ApiError> {
    context.require_admin()?;
    let name = validate::person_name("name", &create.name)?;
    let role = validate::operator_role("role", create.role.as_deref())?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    check_link(&mut tx, None, create.operator_id.as_deref(), false).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO employees (id, name, role, operator_id, archived, rev) \
         VALUES (?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&role)
    .bind(&create.operator_id)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(operator_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::EMPLOYEE_CREATE,
            target_type: Some("employee"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "role": role, "operatorId": create.operator_id }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("employee vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_employee(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<EmployeeUpdate>,
) -> Result<Json<EmployeeRecord>, ApiError> {
    context.require_admin()?;
    let name = validate::person_name("name", &update.name)?;
    let role = validate::operator_role("role", update.role.as_deref())?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such employee"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("role", json!(current.role), json!(role)),
        (
            "operatorId",
            json!(current.operator_id),
            json!(update.operator_id),
        ),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the record as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    check_link(
        &mut tx,
        Some(&id),
        update.operator_id.as_deref(),
        update.archived,
    )
    .await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE employees SET name = ?, role = ?, operator_id = ?, archived = ?, rev = ? \
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&role)
    .bind(&update.operator_id)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(operator_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::EMPLOYEE_UPDATE,
            target_type: Some("employee"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // Archiving turns the linked operator off in the same write (owner
    // decision В1): an archived employee no longer signs in on a station.
    if update.archived && !current.archived {
        if let Some(operator_id) = current.operator_id.as_deref() {
            crate::routes::operators::turn_off_in(&mut tx, context.actor(), &at, operator_id, rev)
                .await?;
        }
    }
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("employee vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
