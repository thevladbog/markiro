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

pub mod blocks;
pub mod box_closed;
pub mod box_label;
pub mod boxes;
pub mod exception;
pub mod pallet_closed;
pub mod pallet_exception;
pub mod pallet_label;
pub mod pallets;
pub mod registry;
pub mod registry_touch;
pub mod rules;
pub mod scan;
pub mod shift_closed;
pub mod unit_label;

use markiro_proto::{
    receipt_codes, FactKind, FactOutcome, FactReceipt, FactRecord, ParticipantState, ShiftMode,
    ShiftOrigin, ShiftStatus,
};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::db::next_revision;
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
/// details; and the close of its shift, when the record is a station's
/// close of an active shift (the batch writes it, with the batch's
/// revision).
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub outcome: FactOutcome,
    pub details: Option<Value>,
    pub close: Option<CloseShift>,
}

impl Applied {
    pub fn accepted() -> Self {
        Self {
            outcome: FactOutcome::Accepted,
            details: None,
            close: None,
        }
    }
}

/// A participant's close of its part of an active shift (plan 2b).
#[derive(Debug, Clone, PartialEq)]
pub struct CloseShift {
    /// The device's instant in the host's format (whole seconds).
    pub closed_at: String,
    pub reason_code: Option<String>,
    /// The device's own count, kept on its part.
    pub actual_qty: u32,
    /// No other participant stays active or left: the shift closes with this part.
    pub closes_shift: bool,
    /// The shared shift closes without the reason its total needed (spec §12.9).
    pub reason_missing: bool,
    /// The details of the `shift.part_closed` row (a part that leaves the shift open).
    pub part_audit: Value,
    /// The details of the `shift.close` row (the close of the shift).
    pub audit: Value,
}

/// The shift a record names, as the device entered it.
#[derive(Debug, Clone)]
pub struct FactShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    /// Aggregation or validation (plan РЕЖ); fixed once open.
    pub mode: ShiftMode,
    /// The GTIN the shift's snapshot froze.
    pub gtin14: String,
    /// The SSCC issuer prefix the shift's snapshot froze.
    pub issuer_prefix: String,
    /// Whether the shift works with pallets (plan ПЛ-Х); fixed once open.
    pub pallets_enabled: bool,
    /// Whether a validation shift prints a Data Matrix duplicate of each
    /// accepted code (plan РЕЖ, part B); fixed once open.
    pub prints_duplicate: bool,
    /// The sending device's part in the shift (plan 2b).
    pub my_state: ParticipantState,
    /// The shift's plan on the host now: a shared shift's reason is judged by it.
    pub planned_qty: Option<u32>,
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
///
/// A record that closes a part or its shift, a closed shift's first late fact and a closed
/// part's first late fact change the shift's row: the batch takes one revision for all of them
/// (`revision`, taken on first need) and stamps it on the row, so the caller commits with it.
pub async fn receive(
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
    let applying = apply(conn, device_id, value, received_at, revision).await?;
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
    revision: &mut Option<i64>,
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
    if !admits(shift.mode, record.kind) {
        return Ok(Applying {
            kind,
            shift_id: Some(shift.id.clone()),
            answer: Err(Reject::field("shift_mode")),
        });
    }
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
        FactKind::ShiftClosed => shift_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletClosed => pallet_closed::apply(conn, &context, &record.data).await,
        FactKind::PalletLabel => pallet_label::apply(conn, &context, &record.data).await,
        FactKind::PalletException => pallet_exception::apply(conn, &context, &record.data).await,
        FactKind::UnitLabel => unit_label::apply(conn, &context, &record.data).await,
    };
    let answer = match answer {
        Ok(applied) => {
            match &applied.close {
                Some(close) => close_part(conn, &context, close, revision).await?,
                None if record.kind != FactKind::ShiftClosed => {
                    if shift.status == ShiftStatus::Closed {
                        mark_late(conn, &context, revision).await?;
                    }
                    if shift.my_state == ParticipantState::Closed {
                        mark_part_late(conn, &context, revision).await?;
                    }
                }
                None => {}
            }
            Ok(applied)
        }
        Err(Failure::Reject(reject)) => Err(reject),
        Err(Failure::Internal(error)) => return Err(error),
    };
    Ok(Applying {
        kind,
        shift_id: Some(shift.id.clone()),
        answer,
    })
}

/// Whether a shift of `mode` takes facts of `kind`: a validation shift
/// (plan РЕЖ, Р7) has no boxes and no pallets, so a box or pallet fact of it
/// is `invalid_record` on `shift_mode` whatever its content, before anything
/// of it is read; its scans and its close are its own (`scan.rs`,
/// `shift_closed.rs`), and so are its unit labels (part B; `unit_label.rs`
/// refuses them in a validation shift that prints nothing).
fn admits(mode: ShiftMode, kind: FactKind) -> bool {
    match kind {
        FactKind::Scan | FactKind::ShiftClosed => true,
        FactKind::BoxClosed
        | FactKind::BoxLabel
        | FactKind::BoxException
        | FactKind::PalletClosed
        | FactKind::PalletLabel
        | FactKind::PalletException => mode == ShiftMode::Aggregation,
        FactKind::UnitLabel => mode == ShiftMode::Validation,
    }
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
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        bool,
        bool,
        Option<u32>,
        Option<String>,
    );
    let row: Option<ShiftRow> = sqlx::query_as(
        "SELECT s.status, s.mode, s.number_month_key, s.number_seq, s.created_from, \
         json_extract(s.snapshot, '$.product.gtin14'), json_extract(s.snapshot, '$.issuerPrefix'), \
         s.pallets_enabled, s.validation_print_mode = 'duplicate_dm', s.planned_qty, \
         (SELECT p.state FROM shift_participants p WHERE p.shift_id = s.id AND p.device_id = ?) \
         FROM shifts s WHERE s.id = ?",
    )
    .bind(device_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((
        status,
        mode,
        month_key,
        seq,
        created_from,
        gtin14,
        issuer_prefix,
        pallets_enabled,
        prints_duplicate,
        planned_qty,
        participant,
    )) = row
    else {
        return Ok(None);
    };
    let Some(participant) = participant else {
        return Ok(Some(None));
    };
    // An entered shift was opened, so it has its snapshot.
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    let snapshot = || ApiError::internal("an entered shift has no snapshot");
    Ok(Some(Some(FactShift {
        id: id.to_owned(),
        number: shifts::format_number(&month_key, seq, origin),
        status: status.parse().map_err(ApiError::internal)?,
        mode: mode.parse().map_err(ApiError::internal)?,
        gtin14: gtin14.ok_or_else(snapshot)?,
        issuer_prefix: issuer_prefix.ok_or_else(snapshot)?,
        pallets_enabled,
        prints_duplicate,
        my_state: participant.parse().map_err(ApiError::internal)?,
        planned_qty,
    })))
}

/// The batch's revision, taken on first need: one revision for every shift
/// row the batch changes.
async fn batch_revision(
    conn: &mut SqliteConnection,
    revision: &mut Option<i64>,
) -> Result<i64, ApiError> {
    match revision {
        Some(rev) => Ok(*rev),
        None => {
            let rev = next_revision(conn).await.map_err(ApiError::internal)?;
            *revision = Some(rev);
            Ok(rev)
        }
    }
}

/// A participant's close of its part (plan 2b): the part closes with the device's instant, count
/// and reason, and a revision is stamped on the shift. A part that leaves the shift open writes
/// `shift.part_closed`; when nobody else is active or left the shift closes too, as a station's close
/// did in stage 2a — the device as closer, its reason, or the mark that the reason is missing
/// (spec §12.9) — and writes `shift.close`.
async fn close_part(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    close: &CloseShift,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    let rev = batch_revision(&mut *conn, revision).await?;
    crate::shift_participants::close_by_device(
        &mut *conn,
        &context.shift.id,
        context.device_id,
        &close.closed_at,
        close.actual_qty,
        close.reason_code.as_deref(),
    )
    .await?;
    if !close.closes_shift {
        crate::shifts::stamp_revision(&mut *conn, &context.shift.id, rev).await?;
        return audit::record(
            conn,
            context.received_at,
            Entry {
                actor: Actor::Device(context.device_id),
                action: actions::SHIFT_PART_CLOSED,
                target_type: Some("shift"),
                target_id: Some(&context.shift.id),
                outcome: Outcome::Ok,
                details: close.part_audit.clone(),
            },
        )
        .await
        .map_err(ApiError::internal);
    }
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'device', \
         closed_by = ?, close_reason_code = ?, close_reason_missing = ?, rev = ? WHERE id = ?",
    )
    .bind(&close.closed_at)
    .bind(context.device_id)
    .bind(&close.reason_code)
    .bind(close.reason_missing)
    .bind(rev)
    .bind(&context.shift.id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        conn,
        context.received_at,
        Entry {
            actor: Actor::Device(context.device_id),
            action: actions::SHIFT_CLOSE,
            target_type: Some("shift"),
            target_id: Some(&context.shift.id),
            outcome: Outcome::Ok,
            details: close.audit.clone(),
        },
    )
    .await
    .map_err(ApiError::internal)
}

/// The first fact accepted for a closed shift marks it late, once.
async fn mark_late(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    let unmarked: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ? AND late_data_at IS NULL")
            .bind(&context.shift.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if unmarked.is_none() {
        return Ok(());
    }
    let rev = batch_revision(&mut *conn, revision).await?;
    sqlx::query("UPDATE shifts SET late_data_at = ?, rev = ? WHERE id = ?")
        .bind(context.received_at)
        .bind(rev)
        .bind(&context.shift.id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// The first fact of a closed part marks the part late, once (plan 2b), with a revision stamped on
/// the shift; nothing reopens the part.
async fn mark_part_late(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    revision: &mut Option<i64>,
) -> Result<(), ApiError> {
    if crate::shift_participants::mark_late(
        &mut *conn,
        &context.shift.id,
        context.device_id,
        context.received_at,
    )
    .await?
    {
        let rev = batch_revision(&mut *conn, revision).await?;
        crate::shifts::stamp_revision(conn, &context.shift.id, rev).await?;
    }
    Ok(())
}
