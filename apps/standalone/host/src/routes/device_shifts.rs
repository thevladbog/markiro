//! Shifts at a station (stage 2a spec §4.2, §4.7), with the device key, for
//! stations only: `GET /v1/device/shifts`, `POST /v1/device/shifts` and
//! `POST /v1/device/shifts/{id}/enter`. A
//! station reads its shifts at the moments it reads its device record
//! (after it subscribes to the link and after every revision event), since a
//! shift is no feed record: shifts are per line, and an open one carries a
//! layout of up to 256 KB.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    DeviceKind, DeviceShift, DeviceShiftCreate, DeviceShifts, ShiftOrigin, ShiftSnapshot,
    ShiftStatus,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::routes::devices::require_active_line;
use crate::server::AppState;
use crate::shifts::{self, NewShift};
use crate::validate;

/// The columns of a station's shift. The product and the counterparty are
/// the snapshot's once the shift is open, the records' before.
const SELECT: &str = "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, s.status, \
     s.mode, s.pallets_enabled, s.line_id, s.product_id, \
     COALESCE(json_extract(s.snapshot, '$.product.name'), p.name) AS product_name, \
     COALESCE(json_extract(s.snapshot, '$.product.gtin14'), p.gtin14) AS product_gtin14, \
     CASE WHEN s.snapshot IS NULL THEN c.name \
         ELSE json_extract(s.snapshot, '$.counterpartyName') END AS counterparty_name, \
     s.production_date, s.planned_qty, s.box_capacity, s.box_template_id, s.owner_device_id, \
     s.opened_at, s.closed_at \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     LEFT JOIN counterparties c ON c.id = s.counterparty_id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    mode: String,
    pallets_enabled: bool,
    line_id: String,
    product_id: String,
    product_name: String,
    product_gtin14: String,
    counterparty_name: Option<String>,
    production_date: String,
    planned_qty: Option<u32>,
    box_capacity: u32,
    box_template_id: String,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
}

fn record(row: ShiftRow) -> Result<DeviceShift, ApiError> {
    let created_from = row.created_from.parse().map_err(ApiError::internal)?;
    Ok(DeviceShift {
        number: shifts::format_number(&row.number_month_key, row.number_seq, created_from),
        id: row.id,
        status: row.status.parse().map_err(ApiError::internal)?,
        mode: row.mode.parse().map_err(ApiError::internal)?,
        pallets_enabled: row.pallets_enabled,
        created_from,
        line_id: row.line_id,
        product_id: row.product_id,
        product_name: row.product_name,
        product_gtin14: row.product_gtin14,
        counterparty_name: row.counterparty_name,
        production_date: row.production_date,
        planned_qty: row.planned_qty,
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        snapshot: None,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<DeviceShift>, ApiError> {
    let row: Option<ShiftRow> = sqlx::query_as(&format!("{SELECT} WHERE s.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

const STATION_ONLY: &str = "only a station works on shifts";

/// Shifts are a station's: another kind of device works on none. The write
/// routes read the device again inside their transaction
/// ([`AuthDevice::require_station_in`]).
fn require_station(device: &AuthDevice) -> Result<(), ApiError> {
    if device.kind == DeviceKind::Station {
        Ok(())
    } else {
        Err(ApiError::forbidden(STATION_ONLY))
    }
}

/// How long a station keeps seeing a closed shift it entered.
const CLOSED_DAYS: i64 = 30;

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
/// line, and the shifts it entered, active or closed within 30 days, by
/// production date. A station without a line sees only the latter.
pub async fn list_device_shifts(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceShifts>, ApiError> {
    require_station(&device)?;
    let cutoff = format_timestamp(state.now() - time::Duration::days(CLOSED_DAYS));
    // One read transaction: the station's line and its shifts come from one
    // WAL snapshot.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let rows: Vec<ShiftRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE (s.line_id = ?1 AND s.status IN ('planned', 'active')) \
         OR (EXISTS (SELECT 1 FROM shift_participants sp \
                     WHERE sp.shift_id = s.id AND sp.device_id = ?2) \
             AND (s.status = 'active' OR s.closed_at >= ?3)) \
         ORDER BY s.production_date, s.created_at, s.number_month_key, s.number_seq, s.id"
    ))
    .bind(&line_id)
    .bind(&device.id)
    .bind(&cutoff)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(DeviceShifts {
        shifts: rows.into_iter().map(record).collect::<Result<_, _>>()?,
    }))
}

/// `conflict` on `shift_line`: the shift is not on the station's line, or
/// the station works on no line.
pub fn line_conflict() -> ApiError {
    ApiError::conflict("shift_line", "the shift is not on this station's line")
}

/// `POST /v1/device/shifts`: a station creates a planned shift on its own
/// line, under the rules of the office's plan; its number ends in `/S`. The
/// same `requestId` again answers the shift it created, whatever the body
/// says now, so a create retried after a lost answer makes no second shift.
pub async fn create_device_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(create): ApiJson<DeviceShiftCreate>,
) -> Result<Json<DeviceShift>, ApiError> {
    require_station(&device)?;
    validate::client_uuid("requestId", &create.request_id)?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    validate::count("plannedQty", create.planned_qty, validate::MAX_PLANNED_QTY)?;
    validate::count(
        "boxCapacity",
        create.box_capacity,
        validate::MAX_BOX_CAPACITY,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device.require_station_in(&mut tx, STATION_ONLY).await?;
    let repeated: Option<String> =
        sqlx::query_scalar("SELECT id FROM shifts WHERE created_by = ? AND create_request_id = ?")
            .bind(&device.id)
            .bind(&create.request_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if let Some(id) = repeated {
        // Nothing to write: the transaction rolls back when dropped.
        return read(&mut tx, &id)
            .await?
            .map(Json)
            .ok_or_else(|| ApiError::internal("shift vanished"));
    }
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let line_id = line_id.ok_or_else(line_conflict)?;
    require_active_line(&mut tx, &line_id).await?;
    let product = shifts::shift_product(&mut tx, &create.product_id).await?;
    if let Some(counterparty_id) = &create.counterparty_id {
        shifts::check_counterparty(&mut tx, counterparty_id).await?;
    }
    shifts::check_box_template(&mut tx, &create.box_template_id, product.group).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = shifts::insert(
        &mut tx,
        &NewShift {
            origin: ShiftOrigin::Station,
            created_by: &device.id,
            request_id: Some(&create.request_id),
            product_id: &create.product_id,
            line_id: &line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets: None,
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
            actor: Actor::Device(&device.id),
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

/// A shift as an entry reads it.
#[derive(sqlx::FromRow)]
struct EntryRow {
    status: String,
    line_id: String,
    owner_device_id: Option<String>,
    product_id: String,
    box_template_id: String,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
}

/// `POST /v1/device/shifts/{id}/enter`: a station on the shift's line opens
/// a planned shift (the host freezes its snapshot and makes the station its
/// owner) or enters again the active shift it opened; the answer carries the
/// snapshot, so a station that lost its database gets it back. A closed
/// shift is `shift_status`, another line `shift_line`, a shift another
/// station opened `shift_busy`. Opening takes a revision, so the other
/// stations of the line see the shift busy; entering again takes none.
pub async fn enter_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DeviceShift>, ApiError> {
    require_station(&device)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device.require_station_in(&mut tx, STATION_ONLY).await?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT status, line_id, owner_device_id, product_id, box_template_id, counterparty_id, \
         snapshot, number_month_key, number_seq, created_from FROM shifts WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let shift = shift.ok_or_else(|| ApiError::not_found("no such shift"))?;
    let status: ShiftStatus = shift.status.parse().map_err(ApiError::internal)?;
    if status == ShiftStatus::Closed {
        return Err(shifts::status_conflict(status));
    }
    let line_id: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if line_id.as_deref() != Some(shift.line_id.as_str()) {
        return Err(line_conflict());
    }
    if shift
        .owner_device_id
        .as_deref()
        .is_some_and(|owner| owner != device.id)
    {
        return Err(shifts::busy());
    }
    let snapshot = match shift.snapshot {
        // The station that opened the shift enters it again.
        Some(text) => {
            sqlx::query(
                "UPDATE shift_participants SET last_entered_at = ? \
                 WHERE shift_id = ? AND device_id = ?",
            )
            .bind(&at)
            .bind(&id)
            .bind(&device.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            let snapshot: ShiftSnapshot =
                serde_json::from_str(&text).map_err(ApiError::internal)?;
            let mut entered = read(&mut tx, &id)
                .await?
                .ok_or_else(|| ApiError::internal("shift vanished"))?;
            tx.commit().await.map_err(ApiError::internal)?;
            entered.snapshot = Some(snapshot);
            return Ok(Json(entered));
        }
        None => {
            shifts::snapshot(
                &mut tx,
                &shift.product_id,
                &shift.box_template_id,
                shift.counterparty_id.as_deref(),
            )
            .await?
        }
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(serde_json::to_string(&snapshot).map_err(ApiError::internal)?)
    .bind(&at)
    .bind(&device.id)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&device.id)
    .bind(&at)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_OPEN,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "number": shifts::format_number(&shift.number_month_key, shift.number_seq, origin),
                "templateId": snapshot.box_template.id,
                "templateRev": snapshot.box_template.rev,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let mut opened = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    opened.snapshot = Some(snapshot);
    Ok(Json(opened))
}
