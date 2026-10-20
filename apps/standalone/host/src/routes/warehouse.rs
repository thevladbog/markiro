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
//!
//! `POST /v1/device/warehouse/reprints` keeps the station's records of what
//! it printed (migration `0015`): a batch of 1–100 records in one write
//! transaction, each read from its own JSON value, answered with a receipt
//! per record in their order, as the facts are. A record kept before with
//! the same digest gets `accepted` again and writes nothing; other content
//! under its id `payload_mismatch`; a record that breaks a field's rule
//! `invalid_record`; one whose unit, box or pallet the host does not have
//! (by id and identity together) `subject_unknown`. Refusals are not kept: a
//! batch sent again is answered by the same rules. A database error is no
//! receipt: the batch fails and the station sends it again. Only a station
//! records (`forbidden` for another kind), as only a station looks up.

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    warehouse_receipt_codes, DeviceKind, FactOutcome, FactReceipt, FactReceipts, ShiftOrigin,
    ShiftSnapshot, ShiftSnapshotProduct, WarehouseLookup, WarehouseLookupResult, WarehouseRecord,
    WarehouseSource, WarehouseSubjectKind, WarehouseUnavailable, WAREHOUSE_OUTCOMES,
    WAREHOUSE_REASONS,
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::cloud_history::warehouse as history;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// The most records of one batch, as for facts.
pub const MAX_RECORDS: usize = 100;
/// The longest id or code a record names, in characters.
const MAX_TEXT_CHARS: usize = 64;
/// More attempts than any operator makes on one label.
const MAX_ATTEMPT: u32 = 10_000;

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
        // Not a native owner: the cloud history import may own it.
        if let Some(imported) = history::find_unit(&mut *conn, code_hash).await? {
            return Ok(imported);
        }
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
            imported: false,
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
                imported: false,
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
        return Ok(match history::find_sscc(&mut *conn, sscc).await? {
            Some(imported) => imported,
            None => WarehouseLookupResult::NotFound,
        });
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
            imported: false,
        },
    })
}

/// The body as the host reads it: each record a JSON value of its own, so a
/// record it cannot read is answered `rejected` and the others are kept.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingRecords {
    records: Vec<Value>,
}

/// `POST /v1/device/warehouse/reprints`: a station of the site; 1–100 records.
pub async fn receive_records(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingRecords>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation(
            "records",
            format!("1-{MAX_RECORDS} records"),
        ));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock records nothing,
    // and a device of another kind never does.
    device.require_station_in(&mut tx, STATION_ONLY).await?;
    let received_at = state.timestamp();
    let mut receipts = Vec::with_capacity(batch.records.len());
    for (position, record) in batch.records.iter().enumerate() {
        match receive(&mut tx, &device.id, record, &received_at).await {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                // Its place in the batch, never the record.
                tracing::error!(device = %device.id, position, "a warehouse batch failed");
                return Err(error);
            }
        }
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}

fn accepted(id: String) -> FactReceipt {
    FactReceipt {
        id: Some(id),
        outcome: FactOutcome::Accepted,
        code: None,
        details: None,
    }
}

fn rejected(id: Option<String>, code: &str) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(code.to_owned()),
        details: None,
    }
}

fn is_uuid(text: &str) -> bool {
    validate::client_uuid("id", text).is_ok()
}

/// Trimmed text of 1–64 characters without a control character.
fn is_plain(text: &str) -> bool {
    (1..=MAX_TEXT_CHARS).contains(&text.chars().count())
        && text.trim() == text
        && !text.chars().any(char::is_control)
}

/// A code word as the station writes it: lower-case letters and `_`.
fn is_code_word(text: &str) -> bool {
    (1..=MAX_TEXT_CHARS).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
}

/// The keys a station always writes, `null` when it has nothing: the Zod
/// `warehouseRecordSchema` (`.nullable()`, not `.optional()`) refuses a
/// record without them, and so does the host. `Option` in serde reads a
/// missing key as `None`, so presence is checked on the JSON value.
const NULLABLE_KEYS: [&str; 3] = ["repair", "errorCode", "operatorId"];

fn has_nullable_keys(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|fields| NULLABLE_KEYS.iter().all(|key| fields.contains_key(*key)))
}

/// Every field of a record within its rule.
fn readable(record: &WarehouseRecord) -> bool {
    let identity = match record.subject_kind {
        WarehouseSubjectKind::Unit => rules::is_code_hash(&record.identity),
        WarehouseSubjectKind::Box | WarehouseSubjectKind::Pallet => is_sscc(&record.identity),
    };
    let repair = match record.repair.as_deref() {
        None => true,
        Some(repair) => {
            repair == "legacy_tspl_fnc1_literal"
                && record.subject_kind != WarehouseSubjectKind::Unit
        }
    };
    let unsettled = record.outcome == "failed" || record.outcome == "unknown";
    let error = match record.error_code.as_deref() {
        None => !unsettled,
        Some(code) => unsettled && is_code_word(code),
    };
    is_uuid(&record.id)
        && is_uuid(&record.session_id)
        && is_uuid(&record.job_id)
        && record.attempt <= MAX_ATTEMPT
        && is_plain(&record.subject_id)
        && identity
        && WAREHOUSE_REASONS.contains(&record.reason_code.as_str())
        && repair
        && is_plain(&record.template_id)
        && record.template_rev >= 0
        && WAREHOUSE_OUTCOMES.contains(&record.outcome.as_str())
        && error
        && record.operator_id.as_deref().map_or(true, is_uuid)
        && rules::device_instant(&record.occurred_at).is_some()
}

/// A record this device kept before: its digest.
pub const STORED_SQL: &str =
    "SELECT digest FROM warehouse_reprints WHERE device_id = ? AND record_id = ?";
/// The unit (its scan), box or pallet a record names, by id and identity.
pub const UNIT_EXISTS_SQL: &str = "SELECT 1 FROM scans WHERE id = ? AND code_hash = ?";
pub const BOX_EXISTS_SQL: &str = "SELECT 1 FROM boxes WHERE id = ? AND sscc = ?";
pub const PALLET_EXISTS_SQL: &str = "SELECT 1 FROM pallets WHERE id = ? AND sscc = ?";

/// Where the host has the unit (its scan), the box or the pallet a record
/// names, by its id and identity together: among the native ones (`Some(false)`),
/// else among the cloud history import's completed batch (`Some(true)`).
async fn subject_exists(
    conn: &mut SqliteConnection,
    record: &WarehouseRecord,
) -> Result<Option<bool>, ApiError> {
    let (native, imported) = match record.subject_kind {
        WarehouseSubjectKind::Unit => (UNIT_EXISTS_SQL, history::UNIT_EXISTS_SQL),
        WarehouseSubjectKind::Box => (BOX_EXISTS_SQL, history::BOX_EXISTS_SQL),
        WarehouseSubjectKind::Pallet => (PALLET_EXISTS_SQL, history::PALLET_EXISTS_SQL),
    };
    for (sql, marker) in [(native, false), (imported, true)] {
        let found: Option<i64> = sqlx::query_scalar(sql)
            .bind(&record.subject_id)
            .bind(&record.identity)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        if found.is_some() {
            return Ok(Some(marker));
        }
    }
    Ok(None)
}

async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<FactReceipt, ApiError> {
    let readable_id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .map(str::to_owned);
    let record = match serde_json::from_value::<WarehouseRecord>(value.clone()) {
        Ok(record) if has_nullable_keys(value) && readable(&record) => record,
        _ => {
            return Ok(rejected(
                readable_id,
                warehouse_receipt_codes::INVALID_RECORD,
            ))
        }
    };
    let digest = rules::record_digest(value);
    let stored: Option<String> = sqlx::query_scalar(STORED_SQL)
        .bind(device_id)
        .bind(&record.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some(stored) = stored {
        return Ok(if stored == digest {
            accepted(record.id)
        } else {
            rejected(Some(record.id), warehouse_receipt_codes::PAYLOAD_MISMATCH)
        });
    }
    let Some(imported) = subject_exists(&mut *conn, &record).await? else {
        return Ok(rejected(
            Some(record.id),
            warehouse_receipt_codes::SUBJECT_UNKNOWN,
        ));
    };
    sqlx::query(
        "INSERT INTO warehouse_reprints (device_id, record_id, digest, session_id, job_id, \
         attempt, subject_kind, subject_id, identity, reason_code, repair, template_id, \
         template_rev, outcome, error_code, operator_id, occurred_at, received_at, imported) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device_id)
    .bind(&record.id)
    .bind(&digest)
    .bind(&record.session_id)
    .bind(&record.job_id)
    .bind(record.attempt)
    .bind(record.subject_kind.as_str())
    .bind(&record.subject_id)
    .bind(&record.identity)
    .bind(&record.reason_code)
    .bind(&record.repair)
    .bind(&record.template_id)
    .bind(record.template_rev)
    .bind(&record.outcome)
    .bind(&record.error_code)
    .bind(&record.operator_id)
    .bind(&record.occurred_at)
    .bind(received_at)
    .bind(imported)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(accepted(record.id))
}
