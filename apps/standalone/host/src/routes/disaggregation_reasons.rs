//! The disaggregation reasons' dictionary (plan ДЗГ): `GET
//! /v1/office/disaggregation-reasons` (every office role, archived reasons
//! included), `POST` and `PUT …/{id}` (administrators and technologists, `PUT`
//! with `expectedRev`). A reason is archived instead of deleted, because a
//! document keeps naming it, and it is not in the station feed; a change
//! still takes a revision, like every record with a `rev`
//! (`routes/counterparties.rs`).

use axum::extract::State;
use axum::Json;
use markiro_proto::disaggregation::{
    DisaggregationReason, DisaggregationReasonCreate, DisaggregationReasonUpdate,
    MAX_REASON_NAME_CHARS,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

/// The bounds of `sortOrder`: a position, not a quantity.
const SORT_ORDER_RANGE: std::ops::RangeInclusive<i64> = -1_000_000..=1_000_000;

const SELECT: &str = "SELECT id, name, sort_order, archived, rev FROM disaggregation_reasons";

#[derive(sqlx::FromRow)]
struct ReasonRow {
    id: String,
    name: String,
    sort_order: i64,
    archived: bool,
    rev: i64,
}

impl From<ReasonRow> for DisaggregationReason {
    fn from(row: ReasonRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            sort_order: row.sort_order,
            archived: row.archived,
            rev: row.rev,
        }
    }
}

async fn read(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<DisaggregationReason>, ApiError> {
    let row: Option<ReasonRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(row.map(Into::into))
}

fn sort_order(value: i64) -> Result<i64, ApiError> {
    if SORT_ORDER_RANGE.contains(&value) {
        Ok(value)
    } else {
        Err(ApiError::validation(
            "sortOrder",
            "the sort order must be between -1000000 and 1000000",
        ))
    }
}

pub async fn list_reasons(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<DisaggregationReason>>, ApiError> {
    let rows: Vec<ReasonRow> =
        sqlx::query_as(&format!("{SELECT} ORDER BY archived, sort_order, name, id"))
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn create_reason(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<DisaggregationReasonCreate>,
) -> Result<Json<DisaggregationReason>, ApiError> {
    context.require_disaggregation()?;
    let name = validate::clean_text("name", &create.name, MAX_REASON_NAME_CHARS, "the name")?;
    let order = sort_order(create.sort_order)?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO disaggregation_reasons (id, name, sort_order, archived, created_at, rev) \
         VALUES (?, ?, ?, 0, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(order)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DISAGGREGATION_REASON_CREATE,
            target_type: Some("disaggregation_reason"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name, "sortOrder": order }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("reason vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_reason(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<DisaggregationReasonUpdate>,
) -> Result<Json<DisaggregationReason>, ApiError> {
    context.require_disaggregation()?;
    let name = validate::clean_text("name", &update.name, MAX_REASON_NAME_CHARS, "the name")?;
    let order = sort_order(update.sort_order)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such reason"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("sortOrder", json!(current.sort_order), json!(order)),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the reason as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE disaggregation_reasons SET name = ?, sort_order = ?, archived = ?, rev = ? \
         WHERE id = ?",
    )
    .bind(name)
    .bind(order)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DISAGGREGATION_REASON_UPDATE,
            target_type: Some("disaggregation_reason"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("reason vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
