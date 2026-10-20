//! Shifts at a station (stage 2a spec §4.2, §4.7), with the device key, for
//! stations only: `GET /v1/device/shifts`, `POST /v1/device/shifts` and
//! `POST /v1/device/shifts/{id}/enter`. A
//! station reads its shifts at the moments it reads its device record
//! (after it subscribes to the link and after every revision event), since a
//! shift is no feed record: shifts are per line, and an open one carries up
//! to two layouts (a box's and, with pallets, a pallet's), its snapshot at
//! most 320 KB. Since plan 2b an open or closed shift also carries its line's limit, its
//! participants, the asking device's state, the whole shift's totals as of the read and each
//! device's part; a scan takes no revision, so a device reads this list again to refresh its
//! totals.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    shift_supports, DeviceKind, DeviceShift, DeviceShiftCreate, DeviceShifts, ShiftEnter,
    ShiftMode, ShiftOrigin, ShiftSnapshot, ShiftStatus, ValidationPrint,
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
use crate::shift_participants::{self, EntryDecision};
use crate::shift_totals;
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
     s.production_date, COALESCE(s.planned_date, s.production_date) AS planned_date, \
     s.planned_qty, s.box_capacity, s.box_template_id, \
     s.pallet_box_capacity, s.pallet_template_id, s.validation_print_mode, \
     s.validation_print_verification, s.validation_print_template_id, s.owner_device_id, \
     s.opened_at, s.closed_at, l.max_stations \
     FROM shifts s JOIN products p ON p.id = s.product_id \
     JOIN lines l ON l.id = s.line_id \
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
    planned_date: String,
    planned_qty: Option<u32>,
    box_capacity: u32,
    box_template_id: String,
    pallet_box_capacity: Option<u32>,
    pallet_template_id: Option<String>,
    validation_print_mode: String,
    validation_print_verification: Option<String>,
    validation_print_template_id: Option<String>,
    owner_device_id: Option<String>,
    opened_at: Option<String>,
    closed_at: Option<String>,
    /// The line's limit of devices in one shift (plan 2b).
    max_stations: u32,
}

fn record(row: ShiftRow) -> Result<DeviceShift, ApiError> {
    let created_from = row.created_from.parse().map_err(ApiError::internal)?;
    let status: ShiftStatus = row.status.parse().map_err(ApiError::internal)?;
    Ok(DeviceShift {
        number: shifts::format_number(&row.number_month_key, row.number_seq, created_from),
        id: row.id,
        status,
        mode: row.mode.parse().map_err(ApiError::internal)?,
        pallets_enabled: row.pallets_enabled,
        created_from,
        line_id: row.line_id,
        product_id: row.product_id,
        product_name: row.product_name,
        product_gtin14: row.product_gtin14,
        counterparty_name: row.counterparty_name,
        production_date: row.production_date,
        planned_date: Some(row.planned_date),
        planned_qty: row.planned_qty,
        box_capacity: row.box_capacity,
        box_template_id: row.box_template_id,
        pallet_box_capacity: row.pallet_box_capacity,
        pallet_template_id: row.pallet_template_id,
        // Left out when it is `none` (plan РЕЖ, part B).
        validation_print: shifts::stored_print(
            &row.validation_print_mode,
            row.validation_print_verification.as_deref(),
            row.validation_print_template_id.as_deref(),
        )?,
        owner_device_id: row.owner_device_id,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        snapshot: None,
        // Plan 2b: an open or closed shift names its line's limit; `with_participation` adds the
        // rest.
        max_stations: (status != ShiftStatus::Planned).then_some(row.max_stations),
        participants: None,
        my_state: None,
        totals: None,
        by_device: None,
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

/// An open or closed shift as `device_id` sees it (plan 2b): its participants, the device's own
/// state, the whole shift's totals as of `as_of` and each device's part. A planned shift has none.
async fn with_participation(
    conn: &mut SqliteConnection,
    mut shift: DeviceShift,
    device_id: &str,
    as_of: &str,
) -> Result<DeviceShift, ApiError> {
    if shift.status == ShiftStatus::Planned {
        return Ok(shift);
    }
    let participants = shift_participants::list(&mut *conn, &shift.id).await?;
    shift.my_state = participants
        .iter()
        .find(|participant| participant.device_id == device_id)
        .map(|participant| participant.state);
    shift.totals = Some(shift_totals::totals(&mut *conn, &shift.id, as_of).await?);
    shift.by_device = Some(shift_totals::by_device(&mut *conn, &shift.id).await?);
    shift.participants = Some(participants);
    Ok(shift)
}

/// [`read`] of a shift that must exist, as `device_id` sees it.
async fn read_for(
    conn: &mut SqliteConnection,
    id: &str,
    device_id: &str,
    as_of: &str,
) -> Result<DeviceShift, ApiError> {
    let shift = read(&mut *conn, id)
        .await?
        .ok_or_else(|| ApiError::internal("shift vanished"))?;
    with_participation(conn, shift, device_id, as_of).await
}

const STATION_ONLY: &str = "only a station works on shifts";
const WORKS_SHIFTS: &str = "only a station or a handheld works on shifts";

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
    let as_of = state.timestamp();
    let mut shifts = Vec::with_capacity(rows.len());
    for row in rows {
        shifts.push(with_participation(&mut tx, record(row)?, &device.id, &as_of).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(DeviceShifts { shifts }))
}

/// `conflict` on `shift_line`: the shift is not on the station's line, or
/// the station works on no line.
pub fn line_conflict() -> ApiError {
    ApiError::conflict("shift_line", "the shift is not on this station's line")
}

/// `POST /v1/device/shifts`: a station creates a planned shift on its own
/// line, under the rules of the office's plan, pallets included; its number
/// ends in `/S`. The same `requestId` again answers the shift it created,
/// whatever the body says now, so a create retried after a lost answer makes
/// no second shift.
pub async fn create_device_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(create): ApiJson<DeviceShiftCreate>,
) -> Result<Json<DeviceShift>, ApiError> {
    require_station(&device)?;
    validate::client_uuid("requestId", &create.request_id)?;
    // The mode and print policy follow the office's rules (plan РЕЖ); a
    // station before beta 3.2 names neither: an aggregation shift that prints
    // nothing.
    let mode = create.mode.unwrap_or(ShiftMode::Aggregation);
    let validation_print = create
        .validation_print
        .clone()
        .unwrap_or(ValidationPrint::None {});
    crate::routes::office_shifts::check_mode_rules(mode, create.pallets_enabled)?;
    shifts::check_print_mode(mode, &validation_print)?;
    let pallet_request = shifts::pallet_request(
        create.pallets_enabled,
        create.pallet_box_capacity,
        create.pallet_template_id.as_deref(),
    )?;
    let production_date = validate::civil_date("productionDate", &create.production_date)?;
    // A station before beta 3 sends no shift date: it is the production date.
    let planned_date = create
        .planned_date
        .as_deref()
        .map(|date| validate::civil_date("plannedDate", date))
        .transpose()?
        .unwrap_or(production_date);
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
    // A new shift the station could not open (plan ЛЦ-2, spec §3.3): a
    // retried create above still answers the shift it made.
    crate::license::gate::require_new_shifts(&state, &mut tx).await?;
    // Pallets are a feature of the license (plan ЛЦ-2 Д8): a new shift with
    // them asks; a planned one with them opens (`enter_shift`) unasked.
    if create.pallets_enabled {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Pallets,
        )
        .await?;
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
    if let ValidationPrint::DuplicateDm { template_id, .. } = &validation_print {
        shifts::check_duplicate_template(&mut tx, template_id, product.group).await?;
    }
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
            origin: ShiftOrigin::Station,
            mode,
            created_by: &device.id,
            request_id: Some(&create.request_id),
            product_id: &create.product_id,
            line_id: &line_id,
            counterparty_id: create.counterparty_id.as_deref(),
            production_date,
            planned_date,
            planned_qty: create.planned_qty,
            box_capacity: create.box_capacity.unwrap_or(product.box_capacity),
            box_template_id: &create.box_template_id,
            pallets,
            validation_print: &validation_print,
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
    // Named only by a validation shift, as the office's row does.
    if created.mode != ShiftMode::Aggregation {
        details["mode"] = json!(created.mode);
    }
    if let Some(policy) = &created.validation_print {
        details["validationPrint"] = json!(policy);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
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

/// `conflict` on `station_update`: the shift's mode needs what the entering
/// station did not name (plan РЕЖ, Р5), so it would work the shift as an
/// older build does; the station asks to be updated.
pub fn station_update() -> ApiError {
    ApiError::conflict(
        "station_update",
        "this station's app does not work this shift's mode: update it",
    )
}

/// What a station must name to enter a shift of `mode`: nothing for
/// aggregation, [`shift_supports::VALIDATION`] for validation, and with it
/// [`shift_supports::VALIDATION_DM_DUPLICATE`] when the shift prints a
/// duplicate (`prints`, part B).
fn require_supports(
    kind: DeviceKind,
    mode: ShiftMode,
    prints: bool,
    enter: &ShiftEnter,
) -> Result<(), ApiError> {
    let mut needed: Vec<&str> = match (mode, prints) {
        (ShiftMode::Aggregation, _) => Vec::new(),
        (ShiftMode::Validation, false) => vec![shift_supports::VALIDATION],
        (ShiftMode::Validation, true) => vec![
            shift_supports::VALIDATION,
            shift_supports::VALIDATION_DM_DUPLICATE,
        ],
    };
    // A handheld names the capability on every entry, whatever the mode: a build that does not
    // know the host's protocol must not work the shift (spec 6.3).
    if kind == DeviceKind::Handheld {
        needed.push(shift_supports::HANDHELD_HOST);
    }
    if needed
        .iter()
        .all(|needed| enter.supports.iter().any(|name| name == needed))
    {
        Ok(())
    } else {
        Err(station_update())
    }
}

/// A shift as an entry reads it, with its line's limit (plan 2b).
#[derive(sqlx::FromRow)]
struct EntryRow {
    status: String,
    mode: String,
    line_id: String,
    product_id: String,
    box_template_id: String,
    pallet_template_id: Option<String>,
    pallet_sheet_template_id: Option<String>,
    validation_print_mode: String,
    validation_print_verification: Option<String>,
    validation_print_template_id: Option<String>,
    counterparty_id: Option<String>,
    snapshot: Option<String>,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    max_stations: u32,
}

/// `POST /v1/device/shifts/{id}/enter`: a station or a handheld on the shift's line opens a
/// planned shift (the host freezes its snapshot, the device becomes its opener and first
/// participant) or enters an open one; the answer carries the snapshot, so a device that lost its
/// database gets it back, and (plan 2b) the participants and totals.
///
/// An open shift (plan 2b, spec §4.2 «Вход», `shift_participants::decide_entry`): an active
/// participant enters again (no revision, no audit row); one that closed its part reads the shift
/// back and nothing is written; one that left takes a slot again and a new device takes one, while
/// fewer than the line's `max_stations` other live devices hold a slot — a revision stamped on the
/// shift and `shift.join` (`{ number, rejoined }`). A device that never entered and did not name
/// `multi-station-v1` is `shift_busy` as in stage 2a; one that named it meets a full line as
/// `shift_line_full`. A closed shift is `shift_status`, another line `shift_line`.
///
/// The body (`ShiftEnter`, protocol 4) names what the device works; a station of protocol 3 sends
/// none. A validation shift needs `validation-v1` (and `validation-dm-duplicate-v1` when it prints
/// a duplicate), a handheld always `handheld-host-v1`: otherwise `station_update`, after the
/// shift's own refusals and before anything is frozen or written. Opening checks the license
/// (`require_new_shifts`) and freezes the snapshot (`snapshot_too_large`, the template refusals);
/// joining an open shift checks neither (plan 2b: joining is no new shift).
pub async fn enter_shift(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiPath(id): ApiPath<String>,
    enter: Option<ApiJson<ShiftEnter>>,
) -> Result<Json<DeviceShift>, ApiError> {
    if !matches!(device.kind, DeviceKind::Station | DeviceKind::Handheld) {
        return Err(ApiError::forbidden(WORKS_SHIFTS));
    }
    let enter = enter.map(|ApiJson(enter)| enter).unwrap_or_default();
    validate::shift_supports(&enter.supports)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let kind = device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            WORKS_SHIFTS,
        )
        .await?;
    let shift: Option<EntryRow> = sqlx::query_as(
        "SELECT s.status, s.mode, s.line_id, s.product_id, s.box_template_id, \
         s.pallet_template_id, s.pallet_sheet_template_id, s.validation_print_mode, \
         s.validation_print_verification, s.validation_print_template_id, s.counterparty_id, \
         s.snapshot, s.number_month_key, s.number_seq, s.created_from, l.max_stations \
         FROM shifts s JOIN lines l ON l.id = s.line_id WHERE s.id = ?",
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
    // Plan 2b: who may work an open shift is its participants' and its line's business.
    let decision = if status == ShiftStatus::Planned {
        None
    } else {
        let current = shift_participants::state_of(&mut tx, &id, &device.id).await?;
        let active_others = shift_participants::active_others(&mut tx, &id, &device.id).await?;
        let multi = enter
            .supports
            .iter()
            .any(|name| name == shift_supports::MULTI_STATION);
        match shift_participants::decide_entry(current, active_others, shift.max_stations, multi) {
            EntryDecision::Busy => return Err(shifts::busy()),
            EntryDecision::LineFull {
                max_stations,
                active,
            } => return Err(shifts::line_full(max_stations, active)),
            decision => Some(decision),
        }
    };
    let validation_print = shifts::stored_print(
        &shift.validation_print_mode,
        shift.validation_print_verification.as_deref(),
        shift.validation_print_template_id.as_deref(),
    )?;
    let duplicate = match &validation_print {
        Some(ValidationPrint::DuplicateDm {
            verification,
            template_id,
        }) => Some((*verification, template_id.as_str())),
        Some(ValidationPrint::None {}) | None => None,
    };
    require_supports(
        kind,
        shift.mode.parse().map_err(ApiError::internal)?,
        duplicate.is_some(),
        &enter,
    )?;
    let origin = shift.created_from.parse().map_err(ApiError::internal)?;
    let number = shifts::format_number(&shift.number_month_key, shift.number_seq, origin);
    let snapshot = match shift.snapshot {
        Some(text) => {
            let snapshot: ShiftSnapshot =
                serde_json::from_str(&text).map_err(ApiError::internal)?;
            let mut entered = match decision {
                Some(EntryDecision::Reenter) => {
                    shift_participants::touch(&mut tx, &id, &device.id, &at).await?;
                    let entered = read_for(&mut tx, &id, &device.id, &at).await?;
                    tx.commit().await.map_err(ApiError::internal)?;
                    entered
                }
                // Nothing to write: the transaction rolls back when dropped.
                Some(EntryDecision::ReadClosed) => read_for(&mut tx, &id, &device.id, &at).await?,
                Some(joining @ (EntryDecision::Join | EntryDecision::Rejoin)) => {
                    let rejoined = joining == EntryDecision::Rejoin;
                    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
                    if rejoined {
                        shift_participants::rejoin(&mut tx, &id, &device.id, &at).await?;
                    } else {
                        shift_participants::join(&mut tx, &id, &device.id, &at).await?;
                    }
                    shifts::stamp_revision(&mut tx, &id, rev).await?;
                    audit::record(
                        &mut tx,
                        &at,
                        Entry {
                            actor: Actor::Device(&device.id),
                            action: actions::SHIFT_JOIN,
                            target_type: Some("shift"),
                            target_id: Some(&id),
                            outcome: Outcome::Ok,
                            details: json!({ "number": number, "rejoined": rejoined }),
                        },
                    )
                    .await
                    .map_err(ApiError::internal)?;
                    let entered = read_for(&mut tx, &id, &device.id, &at).await?;
                    commit_with_revision(tx, &state.revisions, rev)
                        .await
                        .map_err(ApiError::internal)?;
                    entered
                }
                _ => return Err(ApiError::internal("an open shift's entry was not decided")),
            };
            entered.snapshot = Some(snapshot);
            return Ok(Json(entered));
        }
        None => {
            // Opening is the one move a license that ran out closes (plan ЛЦ-2, spec §3.3).
            crate::license::gate::require_new_shifts(&state, &mut tx).await?;
            let own_logo = crate::license::gate::custom_branding(&state, &mut tx).await?;
            let snapshot = shifts::snapshot(
                &mut tx,
                &shift.product_id,
                &shift.box_template_id,
                shift.pallet_template_id.as_deref(),
                shift.counterparty_id.as_deref(),
                shift.pallet_sheet_template_id.as_deref(),
                duplicate,
            )
            .await?;
            // Custom branding is a license feature: without it the shift freezes no logo, and
            // every print of it falls back to the bundled Markiro one.
            if own_logo {
                snapshot
            } else {
                shifts::without_logo(snapshot)
            }
        }
    };
    // After the templates, so a template that no longer fits is named first.
    let text = shifts::snapshot_text(&snapshot)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET status = 'active', snapshot = ?, opened_at = ?, owner_device_id = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(text)
    .bind(&at)
    .bind(&device.id)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    shift_participants::join(&mut tx, &id, &device.id, &at).await?;
    let mut details = json!({
        "number": number,
        "templateId": snapshot.box_template.id,
        "templateRev": snapshot.box_template.rev,
    });
    if let Some(pallet_template) = &snapshot.pallet_template {
        details["palletTemplateId"] = json!(pallet_template.id);
        details["palletTemplateRev"] = json!(pallet_template.rev);
    }
    if let Some(sheet) = &snapshot.pallet_sheet {
        details["palletSheetTemplateId"] = json!(sheet.id);
        details["palletSheetRevision"] = json!(sheet.revision);
    }
    if let Some(print) = &snapshot.validation_print {
        details["validationPrintTemplateId"] = json!(print.template.id);
        details["validationPrintTemplateRev"] = json!(print.template.rev);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SHIFT_OPEN,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let mut opened = read_for(&mut tx, &id, &device.id, &at).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    opened.snapshot = Some(snapshot);
    Ok(Json(opened))
}
