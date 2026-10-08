//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST`, `PUT …/{id}` (with
//! `expectedRev`) and `DELETE …/{id}` (administrators and technologists,
//! `planShifts`). A shift is no feed record: every change still takes a host
//! revision, so open streams wake and stations read their shifts again
//! (`GET /v1/device/shifts`).

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{OfficeShift, ShiftCreate, ShiftMode, ShiftStatus, ShiftUpdate};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
use crate::validate;

const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, owner_device_id, opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev FROM shifts";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    mode: String,
    pallets_enabled: bool,
    product_id: String,
    line_id: String,
    counterparty_id: Option<String>,
    production_date: String,
    planned_qty: Option<u32>,
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
    close_reason_code: Option<String>,
    close_reason_text: Option<String>,
    late_data_at: Option<String>,
    created_at: String,
    rev: i64,
}

fn record(row: ShiftRow) -> Result<OfficeShift, ApiError> {
    let created_from = row.created_from.parse().map_err(ApiError::internal)?;
    Ok(OfficeShift {
        number: shifts::format_number(&row.number_month_key, row.number_seq, created_from),
        id: row.id,
        status: row.status.parse().map_err(ApiError::internal)?,
        mode: row.mode.parse().map_err(ApiError::internal)?,
        pallets_enabled: row.pallets_enabled,
        created_from,
        product_id: row.product_id,
        line_id: row.line_id,
        counterparty_id: row.counterparty_id,
        production_date: row.production_date,
        planned_qty: row.planned_qty,
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        close_reason_code: row.close_reason_code,
        close_reason_text: row.close_reason_text,
        late_data_at: row.late_data_at,
        created_at: row.created_at,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeShift>, ApiError> {
    let row: Option<ShiftRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// How far back the list without a period reaches for closed shifts, by
/// their production date on the host's clock (UTC).
const RECENT_DAYS: i64 = 31;

/// `GET /v1/office/shifts?from=&to=`: a period of production dates, both
/// ends included; either may be left out.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShiftListQuery {
    from: Option<String>,
    to: Option<String>,
}

/// `GET /v1/office/shifts`: without a period every planned and active shift
/// and the closed ones produced in the last 31 days; with one, every shift
/// produced in it. Newest production date first.
pub async fn list_shifts(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ShiftListQuery>,
) -> Result<Json<Vec<OfficeShift>>, ApiError> {
    let order = "ORDER BY production_date DESC, created_at DESC, number_month_key DESC, \
                 number_seq DESC, id";
    let rows: Vec<ShiftRow> = if query.from.is_none() && query.to.is_none() {
        let cutoff = state.now().date() - time::Duration::days(RECENT_DAYS);
        sqlx::query_as(&format!(
            "{SELECT} WHERE status <> 'closed' OR production_date >= ? {order}"
        ))
        .bind(shifts::civil_text(cutoff))
        .fetch_all(&state.pool)
        .await
    } else {
        let from = query
            .from
            .as_deref()
            .map(|from| validate::civil_date("from", from))
            .transpose()?;
        let to = query
            .to
            .as_deref()
            .map(|to| validate::civil_date("to", to))
            .transpose()?;
        if let (Some(from), Some(to)) = (from, to) {
            if from > to {
                return Err(ApiError::validation(
                    "to",
                    "the period ends before it starts",
                ));
            }
        }
        sqlx::query_as(&format!(
            "{SELECT} WHERE production_date >= ? AND production_date <= ? {order}"
        ))
        .bind(from.map_or_else(|| "0001-01-01".to_owned(), shifts::civil_text))
        .bind(to.map_or_else(|| "9999-12-31".to_owned(), shifts::civil_text))
        .fetch_all(&state.pool)
        .await
    }
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn get_shift(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShift>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read(&mut conn, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// Stage 2a takes only aggregation without pallets (spec decision 6): the
/// fields are there so stages 2b and 3 need no new shape.
pub fn check_mode(mode: ShiftMode, pallets_enabled: bool) -> Result<(), ApiError> {
    if mode != ShiftMode::Aggregation {
        return Err(ApiError::validation(
            "mode",
            "only aggregation shifts are taken for now",
        ));
    }
    if pallets_enabled {
        return Err(ApiError::validation(
            "palletsEnabled",
            "shifts with pallets are not taken for now",
        ));
    }
    Ok(())
}

/// `POST /v1/office/shifts`: a planned shift of an active product on an
/// active line, with a box template that fits the product.
pub async fn create_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<ShiftCreate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(create.mode, create.pallets_enabled)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
    validate::count(
        "boxCapacity",
        create.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    require_active_line(&mut tx, &create.line_id).await?;
    if let Some(counterparty_id) = &create.counterparty_id {
        shifts::check_counterparty(&mut tx, counterparty_id).await?;
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
        &mut tx,
        &NewShift {
            origin: markiro_proto::ShiftOrigin::Office,
            created_by: &context.user.id,
            request_id: None,
            product_id: &create.product_id,
            line_id: &create.line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
        },
        &at,
        rev,
    )
    .await?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_CREATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": created.number,
                "productId": created.product_id,
                "lineId": created.line_id,
                "productionDate": created.production_date,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

/// `PUT /v1/office/shifts/{id}`: a planned shift changes every field it
/// sends (its product never changes); an active one only its plan, which
/// neither its label nor its snapshot shows; a closed one nothing. A line or
/// a template that changes is checked as at planning; one that stays is
/// kept even if it was archived, disabled or narrowed since (the station's
/// open then refuses the template: `template_not_fit`).
pub async fn update_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<ShiftUpdate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode(
        update.mode.unwrap_or_default(),
        update.pallets_enabled.unwrap_or(false),
    )?;
    let production_date = update
        .production_date
        .as_deref()
        .map(|date| validate::civil_date("productionDate", date))
        .transpose()?;
    if let Some(planned_qty) = update.planned_qty {
        validate::count("plannedQty", planned_qty, validate::MAX_PLANNED_QTY)?;
    }
    validate::count(
        "boxCapacity",
        update.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let line_id = update
        .line_id
        .clone()
        .unwrap_or_else(|| current.line_id.clone());
    let production_date =
        production_date.map_or_else(|| current.production_date.clone(), shifts::civil_text);
    let box_template_id = update
        .box_template_id
        .clone()
        .unwrap_or_else(|| current.box_template_id.clone());
    let box_capacity = update.box_capacity.unwrap_or(current.box_capacity);
    let planned_qty = update.planned_qty.unwrap_or(current.planned_qty);
    let counterparty_id = update
        .counterparty_id
        .clone()
        .unwrap_or_else(|| current.counterparty_id.clone());
    let fixed_changed = line_id != current.line_id
        || production_date != current.production_date
        || box_template_id != current.box_template_id
        || box_capacity != current.box_capacity
        || counterparty_id != current.counterparty_id;
    match current.status {
        ShiftStatus::Planned => {
            if line_id != current.line_id {
                require_active_line(&mut tx, &line_id).await?;
            }
            if box_template_id != current.box_template_id {
                let product = shifts::shift_product(&mut tx, &current.product_id).await?;
                shifts::check_box_template(&mut tx, &box_template_id, product.group).await?;
            }
            if let Some(counterparty_id) = &counterparty_id {
                if current.counterparty_id.as_ref() != Some(counterparty_id) {
                    shifts::check_counterparty(&mut tx, counterparty_id).await?;
                }
            }
        }
        ShiftStatus::Active if !fixed_changed => {}
        status => return Err(shifts::status_conflict(status)),
    }
    let Some(details) = audit::update_details(&[
        ("lineId", json!(current.line_id), json!(line_id)),
        (
            "productionDate",
            json!(current.production_date),
            json!(production_date),
        ),
        (
            "boxTemplateId",
            json!(current.box_template_id),
            json!(box_template_id),
        ),
        (
            "boxCapacity",
            json!(current.box_capacity),
            json!(box_capacity),
        ),
        ("plannedQty", json!(current.planned_qty), json!(planned_qty)),
        (
            "counterpartyId",
            json!(current.counterparty_id),
            json!(counterparty_id),
        ),
    ]) else {
        // Nothing actually changed: report the shift as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET line_id = ?, production_date = ?, box_template_id = ?, \
         box_capacity = ?, planned_qty = ?, counterparty_id = ?, rev = ? WHERE id = ?",
    )
    .bind(&line_id)
    .bind(&production_date)
    .bind(&box_template_id)
    .bind(box_capacity)
    .bind(planned_qty)
    .bind(&counterparty_id)
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
            action: actions::SHIFT_UPDATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// `DELETE /v1/office/shifts/{id}` → 204: only a planned shift, which no
/// station has entered (entering opens it). It takes a revision with no row
/// left to stamp, so stations drop it from their lists; its number is not
/// drawn again. A delete repeated after a lost answer is `not_found`.
pub async fn delete_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_shift_planning()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.status != ShiftStatus::Planned {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM shifts WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_DELETE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "number": current.number }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
