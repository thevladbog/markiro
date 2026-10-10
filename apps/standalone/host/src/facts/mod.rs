//! Facts a device sends (stage 2a spec §4.4): scans, closed boxes, label
//! checks, box exceptions and a shift's close, in batches of
//! `POST /v1/device/facts`. The host reads each record on its own and
//! answers a receipt for each; the same record sent again gets the same
//! receipt. Marking rules stay in `@markiro/domain`: the device sends the
//! code's hash, GTIN, serial and canonical text, and the host checks their
//! shape and the shift's GTIN, never the code itself.
//!
//! A record is checked whole before its first write: a refusal (a receipt
//! `rejected`) leaves nothing of the record behind but its receipt. A
//! database error is no receipt: it fails the whole batch, and the device
//! sends it again.

pub mod box_closed;
pub mod box_label;
pub mod boxes;
pub mod exception;
pub mod registry;
pub mod rules;
pub mod scan;

use markiro_proto::{
    receipt_codes, FactKind, FactOutcome, FactReceipt, FactRecord, ShiftOrigin, ShiftStatus,
};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::shifts;
use crate::validate;

/// Why a record was not applied: a code of `receipt_codes` and its
/// details.
#[derive(Debug, Clone, PartialEq)]
pub struct Reject {
    pub code: &'static str,
    pub details: Option<Value>,
}

impl Reject {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            details: None,
        }
    }

    /// `invalid_record` on one field of a readable record, named by its JSON
    /// path (`data.boxId`).
    pub fn field(field: &str) -> Self {
        Self {
            code: receipt_codes::INVALID_RECORD,
            details: Some(serde_json::json!({ "field": field })),
        }
    }
}

/// Why applying a record stopped: the record's own fault (a receipt), or a
/// database error that fails the batch.
#[derive(Debug)]
pub enum Failure {
    Reject(Reject),
    Internal(ApiError),
}

impl From<Reject> for Failure {
    fn from(reject: Reject) -> Self {
        Self::Reject(reject)
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Internal(error)
    }
}

/// What an applied record answers: `accepted`, or `conflict` with its
/// details.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub outcome: FactOutcome,
    pub details: Option<Value>,
}

impl Applied {
    pub fn accepted() -> Self {
        Self {
            outcome: FactOutcome::Accepted,
            details: None,
        }
    }
}

/// The shift a record names, as the device entered it.
#[derive(Debug, Clone)]
pub struct FactShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    /// The GTIN the shift's snapshot froze.
    pub gtin14: String,
    /// The SSCC issuer prefix the shift's snapshot froze.
    pub issuer_prefix: String,
}

/// What every kind's handler knows of its record.
pub struct Context<'a> {
    pub device_id: &'a str,
    pub record_id: &'a str,
    pub operator_id: Option<&'a str>,
    pub shift: &'a FactShift,
    /// The host's clock when the batch arrived.
    pub received_at: &'a str,
}

/// The receipt of a refused record.
fn rejected(id: Option<String>, reject: Reject) -> FactReceipt {
    FactReceipt {
        id,
        outcome: FactOutcome::Rejected,
        code: Some(reject.code.to_owned()),
        details: object(reject.details),
    }
}

fn object(details: Option<Value>) -> Option<serde_json::Map<String, Value>> {
    match details {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Receive one record of a batch inside the batch's write transaction and
/// return its receipt. A record with a readable id whose receipt is kept
/// already gets that receipt back when its digest is the same, and
/// `payload_mismatch` (kept nowhere) when it is not; otherwise the record is
/// applied and its receipt kept. A record without a readable id is answered
/// `invalid_record` and nothing of it is kept.
pub async fn receive(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
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
            tracing::warn!(
                device = %device_id,
                record = %id,
                code = receipt_codes::PAYLOAD_MISMATCH,
                "a fact was rejected"
            );
            return Ok(rejected(
                Some(id.clone()),
                Reject::new(receipt_codes::PAYLOAD_MISMATCH),
            ));
        }
    }
    let applying = apply(conn, device_id, value, received_at).await?;
    let receipt = match applying.answer {
        Ok(applied) => FactReceipt {
            id: id.clone(),
            outcome: applied.outcome,
            code: None,
            details: object(applied.details),
        },
        Err(reject) => {
            tracing::warn!(
                device = %device_id,
                record = ?id,
                code = reject.code,
                "a fact was rejected"
            );
            rejected(id.clone(), reject)
        }
    };
    if let Some(id) = &id {
        sqlx::query(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             code, details, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(id)
        .bind(applying.kind.map(FactKind::as_str))
        .bind(&applying.shift_id)
        .bind(&digest)
        .bind(receipt.outcome.as_str())
        .bind(&receipt.code)
        .bind(
            receipt
                .details
                .as_ref()
                .map(|details| Value::Object(details.clone()).to_string()),
        )
        .bind(received_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(receipt)
}

/// The kept receipt of a record and the digest it was kept with.
async fn stored(
    conn: &mut SqliteConnection,
    device_id: &str,
    id: &str,
) -> Result<Option<(String, FactReceipt)>, ApiError> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT digest, outcome, code, details FROM fact_receipts \
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

/// What applying a record learned: its kind once the record was readable,
/// its shift once the device's entry in it was found, and the answer.
struct Applying {
    kind: Option<FactKind>,
    shift_id: Option<String>,
    answer: Result<Applied, Reject>,
}

impl Applying {
    fn refused(kind: Option<FactKind>, reject: Reject) -> Self {
        Self {
            kind,
            shift_id: None,
            answer: Err(reject),
        }
    }
}

/// The checks every record passes, then its kind's handler.
async fn apply(
    conn: &mut SqliteConnection,
    device_id: &str,
    value: &Value,
    received_at: &str,
) -> Result<Applying, ApiError> {
    let Ok(record) = serde_json::from_value::<FactRecord>(value.clone()) else {
        return Ok(Applying::refused(
            None,
            Reject::new(receipt_codes::INVALID_RECORD),
        ));
    };
    let kind = Some(record.kind);
    for (field, text) in [
        ("id", Some(record.id.as_str())),
        ("shiftId", Some(record.shift_id.as_str())),
        ("operatorId", record.operator_id.as_deref()),
    ] {
        if let Some(text) = text {
            if validate::client_uuid(field, text).is_err() {
                return Ok(Applying::refused(kind, Reject::field(field)));
            }
        }
    }
    let Some(shift) = entered_shift(conn, &record.shift_id, device_id).await? else {
        return Ok(Applying::refused(
            kind,
            Reject::new(receipt_codes::UNKNOWN_SHIFT),
        ));
    };
    let Some(shift) = shift else {
        return Ok(Applying::refused(
            kind,
            Reject::new(receipt_codes::NOT_ENTERED),
        ));
    };
    let context = Context {
        device_id,
        record_id: &record.id,
        operator_id: record.operator_id.as_deref(),
        shift: &shift,
        received_at,
    };
    let answer = match record.kind {
        FactKind::Scan => scan::apply(conn, &context, &record.data).await,
        FactKind::BoxClosed => box_closed::apply(conn, &context, &record.data).await,
        FactKind::BoxLabel => box_label::apply(conn, &context, &record.data).await,
        FactKind::BoxException => exception::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => Ok(applied),
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
    Ok(Applying {
        kind,
        shift_id: Some(shift.id.clone()),
        answer,
    })
}

/// The shift `id` as the device entered it: `None` when there is no such
/// shift, `Some(None)` when the device never entered it.
async fn entered_shift(
    conn: &mut SqliteConnection,
    id: &str,
    device_id: &str,
) -> Result<Option<Option<FactShift>>, ApiError> {
    type ShiftRow = (
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         EXISTS (SELECT 1 FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((status, month_key, seq, created_from, gtin14, issuer_prefix, entered)) = row else {
        return Ok(None);
    };
    if !entered {
        return Ok(Some(None));
    }
    // An entered shift was opened, so it has its snapshot.
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    let snapshot = || ApiError::internal("an entered shift has no snapshot");
    Ok(Some(Some(FactShift {
        id: id.to_owned(),
        number: shifts::format_number(&month_key, seq, origin),
        status: status.parse().map_err(ApiError::internal)?,
        gtin14: gtin14.ok_or_else(snapshot)?,
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
    })))
}
