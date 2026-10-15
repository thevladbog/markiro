//! The events of a device outside a shift (plan ТСД-Х, spec 6.4): a handheld's warehouse pallets.
//! One record, one receipt, as `facts::receive` does it: a record whose id has a kept receipt
//! answers that receipt when its digest is the same and `payload_mismatch` (kept nowhere) when it
//! is not; a record that cannot be read or breaks a rule is a `rejected` receipt and writes
//! nothing but the receipt; a database error is no receipt, it fails the batch and the device
//! sends it again.

use axum::http::StatusCode;
use markiro_proto::{
    receipt_codes, FactOutcome, FactReceipt, PalletBoxAddedData, PalletBoxRemovedData,
    PalletEventKind, PalletEventRecord, WarehousePalletClosedData, WarehousePalletLabelData,
    WarehousePalletOpenedData,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::db::next_revision;
use crate::error::ApiError;
use crate::facts::{blocks, registry_touch, rules, Applied, Failure, Reject};
use crate::license::seats::{require_feature, Feature};
use crate::server::AppState;
use crate::validate;

/// The largest record (spec 6.4.1).
pub const MAX_RECORD_BYTES: usize = 16 * 1024;

struct Context<'a> {
    device_id: &'a str,
    record_id: &'a str,
    operator_id: Option<&'a str>,
    received_at: &'a str,
}

fn object(details: Option<Value>) -> Option<serde_json::Map<String, Value>> {
    match details {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn rejected(id: Option<String>, reject: Reject) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(reject.code.to_owned()),
        details: object(reject.details),
    }
}

/// Receive one record of a batch inside the batch's write transaction; `revision` is taken on the
/// first record that changes what the office shows (a pallet's close).
pub async fn receive(
    app: &AppState,
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<FactReceipt, ApiError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| validate::client_uuid("id", id).is_ok())
        .map(str::to_owned);
    let digest = rules::record_digest(value);
    if let Some(id) = &id {
        if let Some((stored_digest, receipt)) = stored(conn, device_id, id).await? {
            if stored_digest == digest {
                return Ok(receipt);
            }
            tracing::warn!(device = %device_id, record = %id, "a pallet event was rejected: payload_mismatch");
            return Ok(rejected(
                Some(id.clone()),
                Reject::new(receipt_codes::PAYLOAD_MISMATCH),
            ));
        }
    }
    let (kind, answer) = apply(app, conn, device_id, value, received_at, revision).await?;
    let receipt = match answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
            outcome: applied.outcome,
            code: None,
            details: object(applied.details),
        },
        Err(reject) => {
            tracing::warn!(device = %device_id, record = ?id, code = reject.code, "a pallet event was rejected");
            rejected(id.clone(), reject)
        }
    };
    if let Some(id) = &id {
        sqlx::query(
            "INSERT INTO device_event_receipts (device_id, record_id, kind, digest, outcome, code, \
             details, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(id)
        .bind(kind.map(PalletEventKind::as_str))
        .bind(&digest)
        .bind(receipt.outcome.as_str())
        .bind(&receipt.code)
        .bind(receipt.details.as_ref().map(|d| Value::Object(d.clone()).to_string()))
        .bind(received_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(receipt)
}

async fn stored(
    conn: &mut SqliteConnection,
    device_id: &str,
    id: &str,
) -> Result<Option<(String, FactReceipt)>, ApiError> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT digest, outcome, code, details FROM device_event_receipts \
         WHERE device_id = ? AND record_id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(|(digest, outcome, code, details)| {
        Ok((
            digest,
            FactReceipt {
                id: Some(id.to_owned()),
                outcome: outcome.parse().map_err(ApiError::internal)?,
                code,
                details: details
                    .map(|details| serde_json::from_str(&details))
                    .transpose()
                    .map_err(ApiError::internal)?,
            },
        ))
    })
    .transpose()
}

type Answer = Result<Applied, Reject>;

async fn apply(
    app: &AppState,
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
    revision: &mut Option<i64>,
) -> Result<(Option<PalletEventKind>, Answer), ApiError> {
    if value.to_string().len() > MAX_RECORD_BYTES {
        return Ok((None, Err(Reject::field("record"))));
    }
    let Ok(record) = serde_json::from_value::<PalletEventRecord>(value.clone()) else {
        return Ok((None, Err(Reject::new(receipt_codes::INVALID_RECORD))));
    };
    let kind = Some(record.kind);
    if let Some(operator) = &record.operator_id {
        if validate::client_uuid("operatorId", operator).is_err() {
            return Ok((kind, Err(Reject::field("operatorId"))));
        }
    }
    let context = Context {
        device_id,
        record_id: &record.id,
        operator_id: record.operator_id.as_deref(),
        received_at,
    };
    let answer = match record.kind {
        PalletEventKind::WarehousePalletOpened => opened(app, conn, &context, &record.data).await,
        PalletEventKind::PalletBoxAdded => box_added(conn, &context, &record.data).await,
        PalletEventKind::PalletBoxRemoved => box_removed(conn, &context, &record.data).await,
        PalletEventKind::WarehousePalletClosed => {
            closed(conn, &context, &record.data, revision).await
        }
        PalletEventKind::WarehousePalletLabel => label(conn, &context, &record.data).await,
    };
    match answer {
        Ok(applied) => Ok((kind, Ok(applied))),
        Err(Failure::Reject(reject)) => Ok((kind, Err(reject))),
        Err(Failure::Internal(error)) => Err(error),
    }
}

fn uuid_field(field: &str, id: &str) -> Result<(), Reject> {
    validate::client_uuid(field, id).map_err(|_| Reject::field(field))
}

fn instant_field(field: &str, at: &str) -> Result<(), Reject> {
    rules::device_instant(at)
        .map(|_| ())
        .ok_or_else(|| Reject::field(field))
}

/// A pallet of this device: `(closed_at, product_id)`; `pallet_unknown` when no pallet of this
/// device has the id (another device's pallet is as unknown as none).
async fn own_pallet(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<(Option<String>, String), Failure> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT closed_at, product_id FROM warehouse_pallets WHERE id = ? AND device_id = ?",
    )
    .bind(id)
    .bind(context.device_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    row.ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN).into())
}

async fn opened(
    app: &AppState,
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: WarehousePalletOpenedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    uuid_field("data.productId", &data.product_id)?;
    instant_field("data.openedAt", &data.opened_at)?;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT device_id, product_id FROM warehouse_pallets WHERE id = ?")
            .bind(&data.pallet_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    match existing {
        // Another device's pallet has this id: an id made up twice is the device's fault.
        Some((device, _)) if device != context.device_id => {
            return Err(Reject::field("data.palletId").into())
        }
        Some((_, product)) if product != data.product_id => {
            return Err(Reject::field("data.productId").into())
        }
        // Sent again under another record id: nothing to write.
        Some(_) => return Ok(Applied::accepted()),
        None => {}
    }
    let gtin14: Option<String> =
        sqlx::query_scalar("SELECT gtin14 FROM products WHERE id = ? AND archived = 0")
            .bind(&data.product_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let Some(gtin14) = gtin14 else {
        return Err(Reject::field("data.productId").into());
    };
    // The one move the license closes here: a NEW pallet. Boxes added to an open one never ask.
    match require_feature(app, conn, Feature::Pallets).await {
        Ok(()) => {}
        Err(error) if error.status() == StatusCode::CONFLICT => {
            return Err(Reject::new(receipt_codes::FEATURE_DISABLED).into())
        }
        Err(error) => return Err(error.into()),
    }
    // A handheld works one open pallet. An empty one it left (a draft the operator threw away
    // after the host heard `opened`) goes; one with boxes on it is a state the device must fix.
    let open: Option<String> = sqlx::query_scalar(
        "SELECT id FROM warehouse_pallets WHERE device_id = ? AND closed_at IS NULL",
    )
    .bind(context.device_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if let Some(open) = open {
        let live: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL",
        )
        .bind(&open)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        if live > 0 {
            return Err(Reject::new(receipt_codes::PALLET_STATE).into());
        }
        sqlx::query("DELETE FROM warehouse_pallet_boxes WHERE pallet_id = ?")
            .bind(&open)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("DELETE FROM warehouse_pallets WHERE id = ?")
            .bind(&open)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query(
        "INSERT INTO warehouse_pallets (id, device_id, product_id, gtin14, opened_at, operator_id, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&data.pallet_id)
    .bind(context.device_id)
    .bind(&data.product_id)
    .bind(gtin14)
    .bind(&data.opened_at)
    .bind(context.operator_id)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

fn on_pallet(sscc: Option<String>, pallet_id: &str) -> Failure {
    Reject {
        code: receipt_codes::BOX_ON_PALLET,
        details: Some(json!({ "palletSscc": sscc, "palletId": pallet_id })),
    }
    .into()
}

async fn box_added(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: PalletBoxAddedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.addedAt", &data.added_at)?;
    if data.box_sscc.len() != 18 || !data.box_sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.boxSscc").into());
    }
    let (closed_at, pallet_product) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_NOT_OPEN).into());
    }
    type BoxRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let found: Option<BoxRow> = sqlx::query_as(
        "SELECT b.id, b.disassembled_at, sh.product_id, p.id, p.sscc, p.disassembled_at \
         FROM boxes b JOIN shifts sh ON sh.id = b.shift_id LEFT JOIN pallets p ON p.id = b.pallet_id \
         WHERE b.sscc = ?",
    )
    .bind(&data.box_sscc)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((_, disassembled_at, product, production_pallet, production_sscc, production_off)) =
        found
    else {
        return Err(Reject::new(receipt_codes::BOX_NOT_FOUND).into());
    };
    if disassembled_at.is_some() {
        return Err(Reject::new(receipt_codes::BOX_NOT_CLOSED).into());
    }
    if product != pallet_product {
        return Err(Reject::new(receipt_codes::PRODUCT_MISMATCH).into());
    }
    // On a production pallet that stands (a taken-apart pallet frees its boxes).
    if let (Some(pallet), None) = (production_pallet, production_off) {
        return Err(on_pallet(production_sscc, &pallet));
    }
    let live: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT wp.id, wp.sscc FROM warehouse_pallet_boxes wb \
         JOIN warehouse_pallets wp ON wp.id = wb.pallet_id \
         WHERE wb.box_sscc = ? AND wb.removed_at IS NULL",
    )
    .bind(&data.box_sscc)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match live {
        // Scanned twice onto the same pallet (under another record id): nothing to write.
        Some((pallet, _)) if pallet == data.pallet_id => return Ok(Applied::accepted()),
        Some((pallet, sscc)) => return Err(on_pallet(sscc, &pallet)),
        None => {}
    }
    sqlx::query(
        "INSERT INTO warehouse_pallet_boxes (pallet_id, box_sscc, added_at, operator_id, record_id, \
         device_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&data.pallet_id)
    .bind(&data.box_sscc)
    .bind(&data.added_at)
    .bind(context.operator_id)
    .bind(context.record_id)
    .bind(context.device_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    registry_touch::box_by_sscc(&mut *conn, &data.box_sscc, context.received_at).await?;
    Ok(Applied::accepted())
}

async fn box_removed(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: PalletBoxRemovedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.removedAt", &data.removed_at)?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_NOT_OPEN).into());
    }
    // A box that is not on the pallet is already where the handheld wants it: accepted.
    sqlx::query(
        "UPDATE warehouse_pallet_boxes SET removed_at = ? \
         WHERE pallet_id = ? AND box_sscc = ? AND removed_at IS NULL",
    )
    .bind(&data.removed_at)
    .bind(&data.pallet_id)
    .bind(&data.box_sscc)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    registry_touch::box_by_sscc(&mut *conn, &data.box_sscc, context.received_at).await?;
    Ok(Applied::accepted())
}

async fn closed(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
    revision: &mut Option<i64>,
) -> Result<Applied, Failure> {
    let data: WarehousePalletClosedData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    uuid_field("data.blockId", &data.block_id)?;
    instant_field("data.openedAt", &data.opened_at)?;
    instant_field("data.closedAt", &data.closed_at)?;
    if data.sscc.len() != 18 || !data.sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.sscc").into());
    }
    if data.box_count == 0 {
        return Err(Reject::field("data.boxCount").into());
    }
    let serial = i64::try_from(data.serial).map_err(|_| Reject::field("data.serial"))?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    if closed_at.is_some() {
        let stored: Option<String> =
            sqlx::query_scalar("SELECT sscc FROM warehouse_pallets WHERE id = ?")
                .bind(&data.pallet_id)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        // The same close sent again under another id changes nothing.
        return if stored.as_deref() == Some(data.sscc.as_str()) {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::PALLET_ALREADY_CLOSED).into())
        };
    }
    let gln: String = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let prefix = validate::issuer_prefix(&gln);
    if !rules::names_serial(&data.sscc, 1, prefix, data.serial)
        || !blocks::issued_to(
            &mut *conn,
            context.device_id,
            prefix,
            &data.block_id,
            1,
            serial,
        )
        .await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    // One serial of a pallet block is one label, on whichever kind of pallet it is printed.
    let taken: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM pallets WHERE sscc = ?1 OR (block_id = ?2 AND serial = ?3) \
         UNION ALL SELECT 1 FROM warehouse_pallets \
         WHERE id != ?4 AND (sscc = ?1 OR (block_id = ?2 AND serial = ?3))",
    )
    .bind(&data.sscc)
    .bind(&data.block_id)
    .bind(serial)
    .bind(&data.pallet_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    let counted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL",
    )
    .bind(&data.pallet_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if counted != i64::from(data.box_count) {
        return Err(Reject {
            code: receipt_codes::PALLET_COUNT_MISMATCH,
            details: Some(json!({ "counted": counted })),
        }
        .into());
    }
    sqlx::query(
        "UPDATE warehouse_pallets SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, \
         serial = ?, box_count_reported = ?, operator_id = ? WHERE id = ?",
    )
    .bind(&data.opened_at)
    .bind(&data.closed_at)
    .bind(&data.sscc)
    .bind(&data.block_id)
    .bind(serial)
    .bind(data.box_count)
    .bind(context.operator_id)
    .bind(&data.pallet_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    registry_touch::warehouse_pallet_boxes(&mut *conn, &data.pallet_id, context.received_at)
        .await?;
    blocks::consume(&mut *conn, &data.block_id, serial).await?;
    // A pallet's close is an event for the office, as a shift's close is.
    if revision.is_none() {
        *revision = Some(
            next_revision(&mut *conn)
                .await
                .map_err(ApiError::internal)?,
        );
    }
    Ok(Applied::accepted())
}

async fn label(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let data: WarehousePalletLabelData =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    uuid_field("data.palletId", &data.pallet_id)?;
    instant_field("data.at", &data.at)?;
    let (closed_at, _) = own_pallet(conn, context, &data.pallet_id).await?;
    // The label of a pallet that was never closed is a state the device must fix.
    if closed_at.is_none() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    Ok(Applied::accepted())
}
