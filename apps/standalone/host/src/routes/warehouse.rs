//! Warehouse label reprint (plan СКЛ, pilot spec §30). A station finds a
//! unit's code, a box or a pallet of any station and any shift of the site
//! — closed ones too — and prints its label again on a template it chose,
//! without making a new code, box or SSCC.
//!
//! `POST /v1/device/warehouse/lookup` answers what a label is rendered from:
//! the product and the counterparty as the shift froze them, the shift's
//! number and production date, the instant the label dates from (a unit's
//! scan, a box's or a pallet's close), the counts it was printed with, the
//! operator's name and, for a unit, its full canonical code. It reads in one
//! snapshot outside any write transaction and writes nothing but the
//! device's `last_seen_at` (`AuthDevice`). The full code goes only into the
//! answer's body: nothing here logs it, and an error names no value.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    DeviceKind, ShiftOrigin, ShiftSnapshot, ShiftSnapshotProduct, WarehouseLookup,
    WarehouseLookupResult, WarehouseSource, WarehouseSubjectKind, WarehouseUnavailable,
};
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiJson};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;

/// The scan that owns a code now (`code_owners`), with its operator's name.
pub const UNIT_SQL: &str = "SELECT s.id, s.canonical, s.scanned_at, op.name, s.device_id, \
     s.shift_id FROM code_owners o JOIN scans s ON s.id = o.scan_id \
     LEFT JOIN operators op ON op.id = s.operator_id WHERE o.code_hash = ?";

/// Whether an accepted scan ever had the code: a code without an owner was
/// freed by an exception.
pub const UNIT_SEEN_SQL: &str =
    "SELECT 1 FROM scans WHERE code_hash = ? AND verdict = 'ok' LIMIT 1";

/// A closed box by its SSCC, with the count it was closed (and printed) with.
pub const BOX_SQL: &str = "SELECT b.id, b.closed_at, COALESCE(b.item_count_reported, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id AND i.removed_at IS NULL \
     AND i.displaced_at IS NULL)), b.disassembled_at, op.name, b.device_id, b.shift_id \
     FROM boxes b LEFT JOIN operators op ON op.id = b.operator_id WHERE b.sscc = ?";

/// A closed pallet by its SSCC: the boxes it was closed with, the units of
/// its boxes not taken apart now.
pub const PALLET_SQL: &str = "SELECT p.id, p.closed_at, p.box_count_reported, \
     (SELECT COALESCE(SUM(b.item_count_reported), 0) FROM boxes b WHERE b.pallet_id = p.id \
     AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL), p.disassembled_at, op.name, \
     p.device_id, p.shift_id FROM pallets p LEFT JOIN operators op ON op.id = p.operator_id \
     WHERE p.sscc = ?";

/// The shift a record belongs to: its frozen snapshot, date and number.
pub const SHIFT_SQL: &str = "SELECT snapshot, production_date, number_month_key, number_seq, \
     created_from FROM shifts WHERE id = ?";

/// What a shift gives every label of it.
struct ShiftPart {
    product: ShiftSnapshotProduct,
    counterparty_name: Option<String>,
    shift_number: String,
    production_date: String,
}

async fn shift_part(conn: &mut SqliteConnection, shift_id: &str) -> Result<ShiftPart, ApiError> {
    type ShiftRow = (Option<String>, String, String, i64, String);
    let (snapshot, production_date, month_key, seq, created_from): ShiftRow =
        sqlx::query_as(SHIFT_SQL)
            .bind(shift_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    // A shift a fact names was entered, and entering froze its snapshot.
    let text = snapshot.ok_or_else(|| ApiError::internal("a shift with facts has no snapshot"))?;
    let snapshot: ShiftSnapshot = serde_json::from_str(&text).map_err(ApiError::internal)?;
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    Ok(ShiftPart {
        product: snapshot.product,
        counterparty_name: snapshot.counterparty_name,
        shift_number: shifts::format_number(&month_key, seq, origin),
        production_date,
    })
}

/// 18 ASCII digits; the check digit is the station's business.
pub fn is_sscc(text: &str) -> bool {
    text.len() == 18 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// What a lookup asks, once its form is checked.
enum Asked<'a> {
    Code(&'a str),
    Sscc(&'a str),
}

const STATION_ONLY: &str = "only a station reprints warehouse labels";

/// `POST /v1/device/warehouse/lookup`: a station of the site (another kind of
/// device is `forbidden`: the answer carries a unit's full code); exactly one
/// of `codeHash` (64 lower-case hex digits) and `sscc` (18 digits),
/// `validation_failed` otherwise. An explicit `null` reads as an absent
/// field (it is an `Option`); the station's Zod schema is the stricter side.
pub async fn lookup(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(what): ApiJson<WarehouseLookup>,
) -> Result<Json<WarehouseLookupResult>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden(STATION_ONLY));
    }
    let asked = match (what.code_hash.as_deref(), what.sscc.as_deref()) {
        (Some(code_hash), None) if rules::is_code_hash(code_hash) => Asked::Code(code_hash),
        (Some(_), None) => {
            return Err(ApiError::validation(
                "codeHash",
                "64 lower-case hex digits are required",
            ))
        }
        (None, Some(sscc)) if is_sscc(sscc) => Asked::Sscc(sscc),
        (None, Some(_)) => return Err(ApiError::validation("sscc", "18 digits are required")),
        _ => {
            return Err(ApiError::validation(
                "codeHash",
                "exactly one of codeHash and sscc is required",
            ))
        }
    };
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let found = match asked {
        Asked::Code(code_hash) => find_unit(&mut tx, code_hash).await,
        Asked::Sscc(sscc) => find_sscc(&mut tx, sscc).await,
    };
    tx.rollback().await.map_err(ApiError::internal)?;
    found.map(Json)
}

async fn find_unit(
    conn: &mut SqliteConnection,
    code_hash: &str,
) -> Result<WarehouseLookupResult, ApiError> {
    type UnitRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        String,
        String,
    );
    let row: Option<UnitRow> = sqlx::query_as(UNIT_SQL)
        .bind(code_hash)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((scan_id, canonical, scanned_at, operator_name, device_id, shift_id)) = row else {
        let seen: Option<i64> = sqlx::query_scalar(UNIT_SEEN_SQL)
            .bind(code_hash)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        return Ok(match seen {
            Some(_) => WarehouseLookupResult::Unavailable {
                reason: WarehouseUnavailable::Released,
            },
            None => WarehouseLookupResult::NotFound,
        });
    };
    let shift = shift_part(conn, &shift_id).await?;
    Ok(WarehouseLookupResult::Found {
        source: WarehouseSource {
            kind: WarehouseSubjectKind::Unit,
            subject_id: scan_id,
            identity: code_hash.to_owned(),
            canonical,
            sscc: None,
            product: shift.product,
            counterparty_name: shift.counterparty_name,
            shift_id,
            shift_number: shift.shift_number,
            production_date: shift.production_date,
            at: scanned_at,
            item_count: 1,
            box_count: None,
            operator_name,
            device_id,
        },
    })
}

async fn find_sscc(
    conn: &mut SqliteConnection,
    sscc: &str,
) -> Result<WarehouseLookupResult, ApiError> {
    type BoxRow = (
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let found: Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((id, closed_at, items, disassembled_at, operator_name, device_id, shift_id)) = found
    {
        if disassembled_at.is_some() {
            return Ok(WarehouseLookupResult::Unavailable {
                reason: WarehouseUnavailable::Disassembled,
            });
        }
        let at = closed_at.ok_or_else(|| ApiError::internal("a box with an SSCC is not closed"))?;
        let shift = shift_part(conn, &shift_id).await?;
        return Ok(WarehouseLookupResult::Found {
            source: WarehouseSource {
                kind: WarehouseSubjectKind::Box,
                subject_id: id,
                identity: sscc.to_owned(),
                canonical: None,
                sscc: Some(sscc.to_owned()),
                product: shift.product,
                counterparty_name: shift.counterparty_name,
                shift_id,
                shift_number: shift.shift_number,
                production_date: shift.production_date,
                at,
                item_count: u32::try_from(items).map_err(ApiError::internal)?,
                box_count: None,
                operator_name,
                device_id,
            },
        });
    }
    type PalletRow = (
        String,
        Option<String>,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let found: Option<PalletRow> = sqlx::query_as(PALLET_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((id, closed_at, boxes, items, disassembled_at, operator_name, device_id, shift_id)) =
        found
    else {
        return Ok(WarehouseLookupResult::NotFound);
    };
    if disassembled_at.is_some() {
        return Ok(WarehouseLookupResult::Unavailable {
            reason: WarehouseUnavailable::Disassembled,
        });
    }
    let at = closed_at.ok_or_else(|| ApiError::internal("a pallet with an SSCC is not closed"))?;
    let shift = shift_part(conn, &shift_id).await?;
    Ok(WarehouseLookupResult::Found {
        source: WarehouseSource {
            kind: WarehouseSubjectKind::Pallet,
            subject_id: id,
            identity: sscc.to_owned(),
            canonical: None,
            sscc: Some(sscc.to_owned()),
            product: shift.product,
            counterparty_name: shift.counterparty_name,
            shift_id,
            shift_number: shift.shift_number,
            production_date: shift.production_date,
            at,
            item_count: u32::try_from(items).map_err(ApiError::internal)?,
            box_count: Some(u32::try_from(boxes.unwrap_or(0)).map_err(ApiError::internal)?),
            operator_name,
            device_id,
        },
    })
}
