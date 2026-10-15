//! `pallet_exception` facts (plan ПЛ-Х): print a closed pallet's label
//! again (`reprint`) or take a closed pallet apart (`disassemble`), as the
//! cloud station does. A pallet taken apart keeps its SSCC, which no other
//! pallet takes; its boxes stay as they are (each keeps its `pallet_id`),
//! and the pallet no longer counts. Reasons are the box exceptions' codes,
//! with words only for `other`.

use markiro_proto::{exception_reasons, receipt_codes, PalletExceptionFact, PalletExceptionKind};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{pallets, registry_touch, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a pallet exception agree with its kind; returns the
/// reason's words trimmed.
fn check(exception: &PalletExceptionFact) -> Result<Option<String>, Reject> {
    if validate::client_uuid("data.palletId", &exception.pallet_id).is_err() {
        return Err(Reject::field("data.palletId"));
    }
    if rules::device_instant(&exception.occurred_at).is_none() {
        return Err(Reject::field("data.occurredAt"));
    }
    let reasons = match exception.exception {
        PalletExceptionKind::Reprint => exception_reasons::REPRINT,
        PalletExceptionKind::Disassemble => exception_reasons::DISASSEMBLE,
    };
    if !reasons.contains(&exception.reason_code.as_str()) {
        return Err(Reject::field("data.reasonCode"));
    }
    match (exception.reason_code.as_str(), &exception.reason_text) {
        (_, None) => Ok(None),
        (exception_reasons::OTHER, Some(text)) => {
            validate::exception_reason_text("data.reasonText", text)
                .map(Some)
                .map_err(|_| Reject::field("data.reasonText"))
        }
        _ => Err(Reject::field("data.reasonText")),
    }
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let exception: PalletExceptionFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let reason_text = check(&exception)?;
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &exception.pallet_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN))?;
    if found.closed_at.is_none() || found.disassembled_at.is_some() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    if exception.exception == PalletExceptionKind::Disassemble {
        sqlx::query("UPDATE pallets SET disassembled_at = ? WHERE id = ?")
            .bind(&exception.occurred_at)
            .bind(&exception.pallet_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        registry_touch::pallet_boxes(&mut *conn, &exception.pallet_id, context.received_at).await?;
    }
    sqlx::query(
        "INSERT INTO pallet_exceptions (id, record_id, kind, pallet_id, reason_code, \
         reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(exception.exception.as_str())
    .bind(&exception.pallet_id)
    .bind(&exception.reason_code)
    .bind(&reason_text)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(&exception.occurred_at)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
