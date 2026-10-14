//! A shift's review in the office (plan КНФ, pilot spec §7): `GET
//! /v1/office/shifts/{id}/exceptions` — its box and pallet exceptions as the
//! stations sent them — and `…/rejections` — the records of the shift the host
//! refused, as their receipts keep them. Every office role reads them; each
//! answer lists at most `SHIFT_REVIEW_LIMIT` rows, newest first, with the
//! count of all, in one snapshot. A refusal the host could not tie to a shift
//! (`unknown_shift`, `not_entered`, an unreadable record) is in neither: its
//! receipt has no shift. A refused record the station sent again under a new
//! id stays here: the host does not link the two.

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_boxes::require_shift;
use crate::server::AppState;
use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ExceptionSource, ExceptionSubject, OfficeShiftException, OfficeShiftExceptions,
    OfficeShiftRejection, OfficeShiftRejections, SHIFT_REVIEW_LIMIT,
};
use markiro_proto::{ExceptionKind, FactKind};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// The shift's exceptions, newest first; ?1 the shift, ?2 the limit. An
/// undo's serial is its code's: every scan of one hash carries the same
/// serial, so any scan of it answers (`scans_code_hash` finds one), even when
/// the undo arrived before the scan it names. The last two arms are the
/// office's (plan ДЗГ-О): a box or a pallet of this shift that a document
/// the office applied took apart (`disaggregation_lines_box` / `_pallet`),
/// (`CROSS JOIN` fixes the order: the shift's rows first, never every applied
/// document) with the document, its applying user and its reason, at the instant the
/// document took it apart and received at its apply.
pub const EXCEPTIONS_SQL: &str = "SELECT * FROM ( \
     SELECT e.id, 'station' AS source, 'box' AS subject, e.kind, e.box_id AS subject_id, b.sscc, \
       (SELECT s.serial FROM scans s WHERE s.code_hash = e.code_hash LIMIT 1) AS serial, \
       e.reason_code, e.reason_text, e.device_id, d.name AS device_name, \
       o.name AS operator_name, NULL AS document_id, NULL AS document_no, \
       NULL AS office_user_name, e.occurred_at, e.received_at \
     FROM box_exceptions e JOIN boxes b ON b.id = e.box_id JOIN devices d ON d.id = e.device_id \
     LEFT JOIN operators o ON o.id = e.operator_id WHERE e.shift_id = ?1 \
     UNION ALL \
     SELECT e.id, 'station', 'pallet', e.kind, e.pallet_id, p.sscc, NULL, e.reason_code, \
       e.reason_text, e.device_id, d.name, o.name, NULL, NULL, NULL, e.occurred_at, e.received_at \
     FROM pallet_exceptions e JOIN pallets p ON p.id = e.pallet_id \
     JOIN devices d ON d.id = e.device_id LEFT JOIN operators o ON o.id = e.operator_id \
     WHERE e.shift_id = ?1 \
     UNION ALL \
     SELECT l.id, 'office', 'box', 'disassemble', l.box_id, b.sscc, NULL, NULL, r.name, NULL, \
       NULL, NULL, dc.id, dc.doc_no, u.name, b.disassembled_at, dc.applied_at \
     FROM boxes b CROSS JOIN disaggregation_document_lines l ON l.box_id = b.id AND l.status = 'ok' \
     CROSS JOIN disaggregation_documents dc ON dc.id = l.document_id AND dc.status = 'applied' \
     CROSS JOIN office_users u ON u.id = dc.applied_by \
     LEFT JOIN disaggregation_reasons r ON r.id = dc.reason_id \
     WHERE b.shift_id = ?1 AND b.disassembled_at IS NOT NULL \
     UNION ALL \
     SELECT l.id, 'office', 'pallet', 'disassemble', l.pallet_id, p.sscc, NULL, NULL, r.name, \
       NULL, NULL, NULL, dc.id, dc.doc_no, u.name, p.disassembled_at, dc.applied_at \
     FROM pallets p CROSS JOIN disaggregation_document_lines l ON l.pallet_id = p.id AND l.status = 'ok' \
     CROSS JOIN disaggregation_documents dc ON dc.id = l.document_id AND dc.status = 'applied' \
     CROSS JOIN office_users u ON u.id = dc.applied_by \
     LEFT JOIN disaggregation_reasons r ON r.id = dc.reason_id \
     WHERE p.shift_id = ?1 AND p.disassembled_at IS NOT NULL) \
     ORDER BY occurred_at DESC, id DESC LIMIT ?2";

pub const EXCEPTIONS_COUNT_SQL: &str = "SELECT \
     (SELECT COUNT(*) FROM box_exceptions WHERE shift_id = ?1) + \
     (SELECT COUNT(*) FROM pallet_exceptions WHERE shift_id = ?1) + \
     (SELECT COUNT(*) FROM boxes b CROSS JOIN disaggregation_document_lines l ON l.box_id = b.id \
        AND l.status = 'ok' CROSS JOIN disaggregation_documents dc ON dc.id = l.document_id \
        AND dc.status = 'applied' WHERE b.shift_id = ?1 AND b.disassembled_at IS NOT NULL) + \
     (SELECT COUNT(*) FROM pallets p CROSS JOIN disaggregation_document_lines l ON l.pallet_id = p.id \
        AND l.status = 'ok' CROSS JOIN disaggregation_documents dc ON dc.id = l.document_id \
        AND dc.status = 'applied' WHERE p.shift_id = ?1 AND p.disassembled_at IS NOT NULL)";

/// The shift's refused records, newest first; ?1 the shift, ?2 the limit.
pub const REJECTIONS_SQL: &str = "SELECT r.record_id, r.kind, r.code, r.details, r.device_id, \
     d.name AS device_name, r.received_at FROM fact_receipts r \
     JOIN devices d ON d.id = r.device_id \
     WHERE r.shift_id = ?1 AND r.outcome = 'rejected' \
     ORDER BY r.received_at DESC, r.record_id DESC LIMIT ?2";

pub const REJECTIONS_COUNT_SQL: &str =
    "SELECT COUNT(*) FROM fact_receipts WHERE shift_id = ?1 AND outcome = 'rejected'";

#[derive(sqlx::FromRow)]
struct ExceptionRow {
    id: String,
    source: String,
    subject: String,
    kind: String,
    subject_id: String,
    sscc: Option<String>,
    serial: Option<String>,
    reason_code: Option<String>,
    reason_text: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
    operator_name: Option<String>,
    document_id: Option<String>,
    document_no: Option<String>,
    office_user_name: Option<String>,
    occurred_at: String,
    received_at: String,
}

#[derive(sqlx::FromRow)]
struct RejectionRow {
    record_id: String,
    kind: Option<String>,
    code: Option<String>,
    details: Option<String>,
    device_id: String,
    device_name: String,
    received_at: String,
}

/// A stored enum's text as its proto type.
fn stored<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_value(Value::String(text.to_owned())).map_err(ApiError::internal)
}

pub async fn list_exceptions(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShiftExceptions>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        let total: i64 = sqlx::query_scalar(EXCEPTIONS_COUNT_SQL)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<ExceptionRow> = sqlx::query_as(EXCEPTIONS_SQL)
            .bind(&id)
            .bind(i64::from(SHIFT_REVIEW_LIMIT))
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(OfficeShiftException {
                source: stored::<ExceptionSource>(&row.source)?,
                subject: stored::<ExceptionSubject>(&row.subject)?,
                kind: stored::<ExceptionKind>(&row.kind)?,
                id: row.id,
                subject_id: row.subject_id,
                sscc: row.sscc,
                serial: row.serial,
                reason_code: row.reason_code,
                reason_text: row.reason_text,
                device_id: row.device_id,
                device_name: row.device_name,
                operator_name: row.operator_name,
                document_id: row.document_id,
                document_no: row.document_no,
                office_user_name: row.office_user_name,
                occurred_at: row.occurred_at,
                received_at: row.received_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeShiftExceptions {
        items,
        total: u32::try_from(total).map_err(ApiError::internal)?,
    }))
}

pub async fn list_rejections(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShiftRejections>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        let total: i64 = sqlx::query_scalar(REJECTIONS_COUNT_SQL)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<RejectionRow> = sqlx::query_as(REJECTIONS_SQL)
            .bind(&id)
            .bind(i64::from(SHIFT_REVIEW_LIMIT))
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(OfficeShiftRejection {
                kind: row.kind.as_deref().map(stored::<FactKind>).transpose()?,
                // `CHECK ((outcome = 'rejected') = (code IS NOT NULL))` (0010).
                code: row
                    .code
                    .ok_or_else(|| ApiError::internal("a refusal without a code"))?,
                details: row
                    .details
                    .map(|text| serde_json::from_str(&text))
                    .transpose()
                    .map_err(ApiError::internal)?,
                record_id: row.record_id,
                device_id: row.device_id,
                device_name: row.device_name,
                received_at: row.received_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeShiftRejections {
        items,
        total: u32::try_from(total).map_err(ApiError::internal)?,
    }))
}
