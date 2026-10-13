//! Shifts in the office (stage 2a spec §4.2, §4.7): `GET /v1/office/shifts`
//! and `GET …/{id}` (every role); `POST`, `PUT …/{id}` (with
//! `expectedRev`), `DELETE …/{id}` and `POST …/{id}/close` (administrators
//! and technologists, `planShifts`). A shift is no feed record: every change
//! still takes a host revision, so open streams wake and stations read their
//! shifts again (`GET /v1/device/shifts`). Every answer carries the shift's
//! totals, which its facts give (plan 2a2): they are read, never stored.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    OfficeShift, ShiftClose, ShiftCreate, ShiftMode, ShiftStatus, ShiftTotals, ShiftUpdate,
};
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

/// The columns of an office shift, its totals (plan 2a2, pallets plan ПЛ-Х)
/// included: each a subquery over the shift's facts, served by the indexes
/// of `0010` and `0012`. A validation shift (plan РЕЖ, Р11) accepts its
/// units without boxes: they are the codes it owns, each without a box
/// (`code_owners_shift_unboxed` of `0020`); it has no boxes and no pallets.
const SELECT: &str = "SELECT id, number_month_key, number_seq, created_from, status, mode, \
     pallets_enabled, product_id, line_id, counterparty_id, production_date, planned_qty, \
     box_capacity, box_template_id, pallet_box_capacity, pallet_template_id, \
     pallet_sheet_template_id, owner_device_id, \
     opened_at, closed_at, close_reason_code, \
     close_reason_text, late_data_at, created_at, rev, \
     CASE mode WHEN 'validation' \
      THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = shifts.id \
            AND o.box_id IS NULL) \
      ELSE (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
            WHERE b.shift_id = shifts.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      END AS accepted_units, \
     (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
      WHERE b.shift_id = shifts.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units_in_closed_boxes, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = shifts.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS closed_boxes, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = shifts.id AND b.closed_at IS NULL \
      AND EXISTS (SELECT 1 FROM box_items i WHERE i.box_id = b.id \
                  AND i.removed_at IS NULL AND i.displaced_at IS NULL)) AS open_boxes, \
     (SELECT MAX(r.received_at) FROM fact_receipts r WHERE r.shift_id = shifts.id) \
      AS last_fact_at, \
     (SELECT json_group_array(p.device_id ORDER BY p.first_entered_at, p.device_id) \
      FROM shift_participants p WHERE p.shift_id = shifts.id) AS device_ids, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id \
      AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL) AS closed_pallets, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = shifts.id AND p.closed_at IS NULL \
      AND EXISTS (SELECT 1 FROM boxes b WHERE b.pallet_id = p.id \
                  AND b.disassembled_at IS NULL)) AS open_pallets \
     FROM shifts";

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
    pallet_box_capacity: Option<u32>,
    pallet_template_id: Option<String>,
    pallet_sheet_template_id: Option<String>,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
    close_reason_code: Option<String>,
    close_reason_text: Option<String>,
    late_data_at: Option<String>,
    created_at: String,
    rev: i64,
    accepted_units: i64,
    units_in_closed_boxes: i64,
    closed_boxes: i64,
    open_boxes: i64,
    last_fact_at: Option<String>,
    /// A JSON array of ids.
    device_ids: String,
    closed_pallets: i64,
    open_pallets: i64,
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
        pallet_box_capacity: row.pallet_box_capacity,
        pallet_template_id: row.pallet_template_id,
        pallet_sheet_template_id: row.pallet_sheet_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        close_reason_code: row.close_reason_code,
        close_reason_text: row.close_reason_text,
        late_data_at: row.late_data_at,
        created_at: row.created_at,
        rev: row.rev,
        totals: ShiftTotals {
            accepted_units: u64::try_from(row.accepted_units).map_err(ApiError::internal)?,
            units_in_closed_boxes: u64::try_from(row.units_in_closed_boxes)
                .map_err(ApiError::internal)?,
            closed_boxes: u32::try_from(row.closed_boxes).map_err(ApiError::internal)?,
            open_boxes: u32::try_from(row.open_boxes).map_err(ApiError::internal)?,
            last_fact_at: row.last_fact_at,
            device_ids: serde_json::from_str(&row.device_ids).map_err(ApiError::internal)?,
            closed_pallets: u32::try_from(row.closed_pallets).map_err(ApiError::internal)?,
            open_pallets: u32::try_from(row.open_pallets).map_err(ApiError::internal)?,
        },
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

/// The rules of a shift's mode (plan РЕЖ, Р1): aggregation, with or without
/// pallets (plan ПЛ-Х), or validation, which puts codes in no box and so in
/// no pallet: a validation shift with pallets is `validation_failed` on
/// `palletsEnabled`. Without pallets a shift has neither pallet field nor an
/// A4 sheet (`shifts::pallet_request`, `shifts::pallets`), so a validation
/// shift never takes the default sheet either. Its box template and box
/// capacity stay (Р4): the shift's columns need them, and a validation shift
/// prints no box label.
pub fn check_mode_rules(mode: ShiftMode, pallets_enabled: bool) -> Result<(), ApiError> {
    if mode == ShiftMode::Validation && pallets_enabled {
        return Err(ApiError::validation(
            "palletsEnabled",
            "a validation shift has no pallets",
        ));
    }
    Ok(())
}

/// `POST /v1/office/shifts`: a planned shift of an active product on an
/// active line, with a box template that fits the product, and with pallets
/// a pallet template that fits it too (`shifts::pallet_request`).
pub async fn create_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<ShiftCreate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    check_mode_rules(create.mode, create.pallets_enabled)?;
    let pallet_request = shifts::pallet_request(
        create.pallets_enabled,
        create.pallet_box_capacity,
        create.pallet_template_id.as_deref(),
    )?;
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
    let pallets = shifts::pallets(
        &mut tx,
        pallet_request,
        &create.product_id,
        &product,
        create.pallet_sheet_template_id.as_deref(),
    )
    .await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
        &mut tx,
        &NewShift {
            origin: markiro_proto::ShiftOrigin::Office,
            mode: create.mode,
            created_by: &context.user.id,
            request_id: None,
            product_id: &create.product_id,
            line_id: &create.line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets,
        },
        &at,
        rev,
    )
    .await?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    let mut details = json!({
        "number": created.number,
        "productId": created.product_id,
        "lineId": created.line_id,
        "productionDate": created.production_date,
    });
    // Named only by a shift that has a sheet, so the rows of shifts without
    // one keep their shape.
    if let Some(sheet_id) = &created.pallet_sheet_template_id {
        details["palletSheetTemplateId"] = json!(sheet_id);
    }
    // Named only by a validation shift (plan РЕЖ), for the same reason: a row
    // without a mode is an aggregation shift's.
    if created.mode != ShiftMode::Aggregation {
        details["mode"] = json!(created.mode);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_CREATE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
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
/// neither its label nor its snapshot shows; a closed one nothing. A line, a
/// template or a counterparty that changes is checked as at planning; one that
/// stays is kept even if it was archived, disabled or narrowed since (the
/// station's open then refuses the template: `template_not_fit`). Pallets
/// turned on need a pallet template and take the product's capacity unless
/// the edit names one; turned off, the shift keeps neither. The A4 sheet
/// `null` goes back to the default for the shift's product as it is at this
/// edit (plan А4; the product's, its category's or the organization's sheet,
/// `default_sheet_for_product`): a later change of a default does not reach
/// the shift.
///
/// The mode (plan РЕЖ, Р1) changes only while the shift is planned, and a
/// validation shift has no pallets (`check_mode_rules`: `validation_failed`
/// on `palletsEnabled`, before either pallet field is checked). An active
/// shift that sends another mode, or pallets its mode cannot have, is
/// `conflict` on `shift_status` like any other fixed field. The pallet
/// fields' own shape (`shifts::pallet_request`, e.g. pallets turned on with
/// no template: `palletTemplateId`) is checked before the status, for any
/// shift, as it was before the mode existed.
pub async fn update_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<ShiftUpdate>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    validate::count(
        "palletBoxCapacity",
        update.pallet_box_capacity,
        validate::MAX_PALLET_BOX_CAPACITY,
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
    // Pallets that stay on keep what the edit does not send; turned off, the
    // edit sends neither field.
    let pallets_enabled = update.pallets_enabled.unwrap_or(current.pallets_enabled);
    // The mode the shift would have and its pallets, checked together before
    // either pallet field is, so the refusal names the flag (plan РЕЖ). Only
    // a planned shift changes them: an active or closed one that sends a
    // change is refused on its status below, not on the rules of a mode it
    // cannot take (and one that sends none already keeps them).
    let mode = update.mode.unwrap_or(current.mode);
    if current.status == ShiftStatus::Planned {
        check_mode_rules(mode, pallets_enabled)?;
    }
    let pallet_request = if pallets_enabled {
        shifts::pallet_request(
            true,
            update.pallet_box_capacity.or(current.pallet_box_capacity),
            update
                .pallet_template_id
                .as_deref()
                .or(current.pallet_template_id.as_deref()),
        )?
    } else {
        shifts::pallet_request(
            false,
            update.pallet_box_capacity,
            update.pallet_template_id.as_deref(),
        )?
    };
    let (mut pallet_box_capacity, pallet_template_id) = match pallet_request {
        shifts::PalletRequest::Off => (None, None),
        shifts::PalletRequest::On {
            box_capacity,
            template_id,
        } => (box_capacity, Some(template_id.to_owned())),
    };
    // The A4 sheet (plan А4): the request's when it names one; `null` is
    // the default for the product as it is now, in this transaction (none
    // without one; the opening then freezes whatever the shift holds); left
    // out, kept while pallets stay on and the main one when they just turned
    // on. Without pallets there is none: a named sheet is refused, `null`
    // asks for nothing and passes.
    let pallet_sheet_template_id = if pallets_enabled {
        match &update.pallet_sheet_template_id {
            Some(Some(id)) => Some(id.clone()),
            None if current.pallets_enabled => current.pallet_sheet_template_id.clone(),
            Some(None) | None => {
                crate::routes::pallet_sheets::default_sheet_for_product(
                    &mut tx,
                    &current.product_id,
                )
                .await?
            }
        }
    } else {
        if let Some(Some(_)) = update.pallet_sheet_template_id {
            return Err(ApiError::validation(
                "palletSheetTemplateId",
                "only a shift with pallets has an A4 sheet",
            ));
        }
        None
    };
    let fixed_changed = mode != current.mode
        || line_id != current.line_id
        || production_date != current.production_date
        || box_template_id != current.box_template_id
        || box_capacity != current.box_capacity
        || counterparty_id != current.counterparty_id
        || pallets_enabled != current.pallets_enabled
        || pallet_box_capacity != current.pallet_box_capacity
        || pallet_template_id != current.pallet_template_id
        || pallet_sheet_template_id != current.pallet_sheet_template_id;
    match current.status {
        ShiftStatus::Planned => {
            // A changed pallet template is checked; pallets just turned on
            // (the only way to have a template and no capacity yet) take the
            // product's capacity.
            if let Some(template_id) = &pallet_template_id {
                if pallet_template_id != current.pallet_template_id {
                    let product = shifts::shift_product(&mut tx, &current.product_id).await?;
                    shifts::check_pallet_template(&mut tx, template_id, product.group).await?;
                    pallet_box_capacity.get_or_insert(product.pallet_box_capacity);
                }
            }
            // A named sheet that changes is checked; the default (`null`) is
            // enabled by construction (`default_sheet_for_product`).
            if let Some(Some(sheet_id)) = &update.pallet_sheet_template_id {
                if current.pallet_sheet_template_id.as_ref() != Some(sheet_id) {
                    crate::routes::pallet_sheets::check_sheet(
                        &mut tx,
                        "palletSheetTemplateId",
                        sheet_id,
                    )
                    .await?;
                }
            }
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
        ("mode", json!(current.mode), json!(mode)),
        (
            "palletsEnabled",
            json!(current.pallets_enabled),
            json!(pallets_enabled),
        ),
        (
            "palletBoxCapacity",
            json!(current.pallet_box_capacity),
            json!(pallet_box_capacity),
        ),
        (
            "palletTemplateId",
            json!(current.pallet_template_id),
            json!(pallet_template_id),
        ),
        (
            "palletSheetTemplateId",
            json!(current.pallet_sheet_template_id),
            json!(pallet_sheet_template_id),
        ),
    ]) else {
        // Nothing actually changed: report the shift as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET line_id = ?, production_date = ?, box_template_id = ?, \
         box_capacity = ?, planned_qty = ?, counterparty_id = ?, mode = ?, pallets_enabled = ?, \
         pallet_box_capacity = ?, pallet_template_id = ?, pallet_sheet_template_id = ?, rev = ? \
         WHERE id = ?",
    )
    .bind(&line_id)
    .bind(&production_date)
    .bind(&box_template_id)
    .bind(box_capacity)
    .bind(planned_qty)
    .bind(&counterparty_id)
    .bind(mode.as_str())
    .bind(pallets_enabled)
    .bind(pallet_box_capacity)
    .bind(&pallet_template_id)
    .bind(&pallet_sheet_template_id)
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

/// `POST /v1/office/shifts/{id}/close`: the office closes an active shift
/// with its reason in words, over `expectedRev`; a planned or a closed one
/// is `shift_status`. Facts a station sends for the shift afterwards are
/// taken and marked late (plan 2a2).
pub async fn close_shift(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(close): ApiJson<ShiftClose>,
) -> Result<Json<OfficeShift>, ApiError> {
    context.require_shift_planning()?;
    let reason = validate::close_reason("reason", &close.reason)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such shift"))?;
    if current.rev != close.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    if current.status != ShiftStatus::Active {
        return Err(shifts::status_conflict(current.status));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'office_user', \
         closed_by = ?, close_reason_text = ?, rev = ? WHERE id = ?",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&reason)
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
            action: actions::SHIFT_CLOSE,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "reason": reason }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let closed = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(closed))
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::SELECT;

    /// The plan SQLite makes of the office's shift query, one line a step.
    async fn plan(filter: &str) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        sqlx::query(&format!("EXPLAIN QUERY PLAN {SELECT} {filter}"))
            .bind("00000000-0000-4000-8000-000000000000")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect()
    }

    /// The pallet totals read through the indexes of `0012`, for one shift
    /// and for the list alike (it runs them once per shift listed): the
    /// pallets of the shift through `pallets_shift`, the boxes of a pallet
    /// through the partial `boxes_pallet`, and no scan of either table.
    #[tokio::test]
    async fn the_pallet_totals_run_on_the_indexes_of_0012() {
        for filter in [
            "WHERE id = ?",
            "WHERE status <> 'closed' OR production_date >= ?",
        ] {
            let plan = plan(filter).await;
            let count = |detail: &str| plan.iter().filter(|line| line.as_str() == detail).count();
            assert_eq!(
                count("SEARCH p USING INDEX pallets_shift (shift_id=?)"),
                2,
                "{filter}: {plan:#?}"
            );
            assert_eq!(
                count("SEARCH b USING INDEX boxes_pallet (pallet_id=?)"),
                1,
                "{filter}: {plan:#?}"
            );
            // Only the outer read of the shifts may scan: the subqueries
            // run once per shift listed.
            let scans: Vec<&String> = plan
                .iter()
                .filter(|line| line.starts_with("SCAN") && !line.starts_with("SCAN shifts"))
                .collect();
            assert!(scans.is_empty(), "{filter}: {scans:?}");
        }
    }

    /// A validation shift's units (plan РЕЖ, Р11) are the codes it owns
    /// without a box, read through the partial `code_owners_shift_unboxed`
    /// of `0020`, for one shift and for the list alike.
    #[tokio::test]
    async fn the_units_of_a_validation_shift_run_on_the_index_of_0020() {
        for filter in [
            "WHERE id = ?",
            "WHERE status <> 'closed' OR production_date >= ?",
        ] {
            let plan = plan(filter).await;
            let found = plan
                .iter()
                .filter(|line| line.contains("code_owners"))
                .collect::<Vec<_>>();
            assert_eq!(
                found,
                ["SEARCH o USING INDEX code_owners_shift_unboxed (shift_id=?)"],
                "{filter}: {plan:#?}"
            );
        }
    }
}
