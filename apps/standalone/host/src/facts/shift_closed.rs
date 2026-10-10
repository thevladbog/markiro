//! `shift_closed` facts (stage 2a spec, decision 17): a station closed its
//! shift; its local close is the point of no return, so the host takes it
//! whenever it arrives. An active shift closes (the batch writes the close,
//! `facts::receive`); a shift the office closed first answers `accepted`
//! with `alreadyClosed`. Every close is kept in `shift_close_events`.

use markiro_proto::{shift_close_reasons, ShiftClosedFact, ShiftStatus};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use super::{rules, Applied, CloseShift, Context, Failure, Reject};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: ShiftClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let closed_at =
        rules::device_instant(&closed.closed_at).ok_or_else(|| Reject::field("data.closedAt"))?;
    if closed
        .planned_qty_snapshot
        .is_some_and(|planned| !(1..=validate::MAX_PLANNED_QTY).contains(&planned))
    {
        return Err(Reject::field("data.plannedQtySnapshot").into());
    }
    match closed.reason_code.as_deref() {
        Some(code) if !shift_close_reasons::ALL.contains(&code) => {
            return Err(Reject::field("data.reasonCode").into());
        }
        None if rules::close_reason_required(closed.planned_qty_snapshot, closed.actual_qty) => {
            return Err(Reject::field("data.reasonCode").into());
        }
        _ => {}
    }
    let closes = context.shift.status == ShiftStatus::Active;
    sqlx::query(
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(closed.planned_qty_snapshot)
    .bind(closed.actual_qty)
    .bind(closed.closed_box_count)
    .bind(&closed.reason_code)
    .bind(&closed.closed_at)
    .bind(if closes { "accepted" } else { "already_closed" })
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if !closes {
        return Ok(Applied {
            details: Some(json!({ "alreadyClosed": true })),
            ..Applied::accepted()
        });
    }
    // The shift's column keeps the host's format: whole seconds, UTC.
    Ok(Applied {
        close: Some(CloseShift {
            closed_at: format_timestamp(closed_at),
            reason_code: closed.reason_code.clone(),
            audit: json!({
                "actualQty": closed.actual_qty,
                "plannedQty": closed.planned_qty_snapshot,
                "closedBoxCount": closed.closed_box_count,
                "reasonCode": closed.reason_code,
            }),
        }),
        ..Applied::accepted()
    })
}
