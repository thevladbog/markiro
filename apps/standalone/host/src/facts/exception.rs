//! `box_exception` facts (stage 2a spec, decision 36): take the last code
//! out of an open box (`undo`) or every code (`clear`), print a closed box's
//! label again (`reprint`), take a closed box apart (`disassemble`). An
//! item taken out leaves its box (`removed_at`, the station's instant) and
//! its code is free again; a box taken apart keeps its SSCC. Reasons are
//! codes, with words only for `other`.

use markiro_proto::{exception_reasons, receipt_codes, BoxExceptionFact, ExceptionKind};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, registry, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of an exception agree with its kind; returns the reason's
/// words trimmed.
fn check(exception: &BoxExceptionFact) -> Result<Option<String>, Reject> {
    if validate::client_uuid("data.boxId", &exception.box_id).is_err() {
        return Err(Reject::field("data.boxId"));
    }
    if rules::device_instant(&exception.occurred_at).is_none() {
        return Err(Reject::field("data.occurredAt"));
    }
    let undo = exception.exception == ExceptionKind::Undo;
    match &exception.code_hash {
        Some(code_hash) if undo && rules::is_code_hash(code_hash) => {}
        None if !undo => {}
        _ => return Err(Reject::field("data.codeHash")),
    }
    match &exception.target_scanned_at {
        Some(at) if undo && rules::device_instant(at).is_some() => {}
        None if !undo => {}
        _ => return Err(Reject::field("data.targetScannedAt")),
    }
    let reasons = match exception.exception {
        ExceptionKind::Undo | ExceptionKind::Clear => None,
        ExceptionKind::Reprint => Some(exception_reasons::REPRINT),
        ExceptionKind::Disassemble => Some(exception_reasons::DISASSEMBLE),
    };
    match (reasons, exception.reason_code.as_deref()) {
        (None, None) => {}
        (Some(reasons), Some(code)) if reasons.contains(&code) => {}
        _ => return Err(Reject::field("data.reasonCode")),
    }
    match (exception.reason_code.as_deref(), &exception.reason_text) {
        (_, None) => Ok(None),
        (Some(exception_reasons::OTHER), Some(text)) => {
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
    let exception: BoxExceptionFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let reason_text = check(&exception)?;
    let found = boxes::find(&mut *conn, context, &exception.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    let open = found.closed_at.is_none();
    let fits = match exception.exception {
        ExceptionKind::Undo | ExceptionKind::Clear => open,
        ExceptionKind::Reprint | ExceptionKind::Disassemble => {
            !open && found.disassembled_at.is_none()
        }
    };
    if !fits {
        return Err(Reject::new(receipt_codes::BOX_STATE).into());
    }
    // The live items the exception takes out, as the cloud takes them: an
    // undo the item of its code added at the very instant of the scan it
    // names (none when that scan lost the code, or the code was scanned
    // again since), a clear every item added up to its own instant (never
    // one scanned after it), a disassembly every item (a closed box takes
    // no scans). So an exception sent again late never takes out a code
    // scanned after it.
    let live = "SELECT scan_id FROM box_items WHERE box_id = ? \
                AND removed_at IS NULL AND displaced_at IS NULL";
    let taken_out: Vec<String> = match exception.exception {
        ExceptionKind::Reprint => Vec::new(),
        ExceptionKind::Undo => {
            sqlx::query_scalar(&format!("{live} AND code_hash = ? AND added_at = ?"))
                .bind(&exception.box_id)
                .bind(&exception.code_hash)
                .bind(&exception.target_scanned_at)
                .fetch_all(&mut *conn)
                .await
                .map_err(ApiError::internal)?
        }
        ExceptionKind::Clear => sqlx::query_scalar(&format!("{live} AND added_at <= ?"))
            .bind(&exception.box_id)
            .bind(&exception.occurred_at)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?,
        ExceptionKind::Disassemble => sqlx::query_scalar(live)
            .bind(&exception.box_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?,
    };
    for scan_id in &taken_out {
        sqlx::query("UPDATE box_items SET removed_at = ? WHERE scan_id = ?")
            .bind(&exception.occurred_at)
            .bind(scan_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        registry::release(&mut *conn, scan_id).await?;
    }
    if exception.exception == ExceptionKind::Disassemble {
        sqlx::query("UPDATE boxes SET disassembled_at = ? WHERE id = ?")
            .bind(&exception.occurred_at)
            .bind(&exception.box_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query(
        "INSERT INTO box_exceptions (id, record_id, kind, box_id, code_hash, target_scanned_at, \
         reason_code, reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(exception.exception.as_str())
    .bind(&exception.box_id)
    .bind(&exception.code_hash)
    .bind(&exception.target_scanned_at)
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
