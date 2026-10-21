//! `shift_closed` facts (stage 2a spec, decision 17; plan 2b): a device closed its part of its
//! shift; its local close is the point of no return, so the host takes it whenever it arrives.
//! The part closes, and the shift with it when no other participant is active or left (the batch
//! writes both, `facts::close_part`). A shift closed before (by the office, or by its last device)
//! answers `accepted` with `alreadyClosed`; a part closed before, `partClosed`; a part that leaves
//! the shift open, `partClosed`; a shared shift closed without its needed reason, `reasonMissing`.
//! Every close is kept in `shift_close_events`. A validation shift has no boxes (plan РЕЖ, Р7).
//!
//! The reason (`shift_participants::reason_need`): a shift that only ever had this device keeps
//! stage 2a's rule, and a close without the needed reason is refused; in a shared shift only the
//! close that closes the shift may need one, by the whole shift's accepted units against the host's
//! plan, and a close without it still closes the shift (spec §12.9).

use markiro_proto::{shift_close_reasons, ShiftClosedFact, ShiftMode, ShiftStatus};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use super::{rules, Applied, CloseShift, Context, Failure, Reject};
use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::shift_participants::{self, CloseDecision, ReasonNeed};
use crate::shift_totals;
use crate::validate;

/// What the close meets.
#[derive(Clone, Copy)]
enum Closing {
    /// The shift is closed already.
    ShiftClosed,
    /// This part closed before.
    PartClosedBefore,
    /// The part closes, and the shift with it when `closes_shift`.
    Part { closes_shift: bool },
}

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
    if context.shift.mode == ShiftMode::Validation && closed.closed_box_count != 0 {
        return Err(Reject::field("data.closedBoxCount").into());
    }
    if let Some(code) = closed.reason_code.as_deref() {
        if !shift_close_reasons::ALL.contains(&code) {
            return Err(Reject::field("data.reasonCode").into());
        }
    }
    let shift_id = context.shift.id.as_str();
    let ever = shift_participants::count_all(&mut *conn, shift_id).await?;
    let closing = if context.shift.status != ShiftStatus::Active {
        Closing::ShiftClosed
    } else {
        let open_others =
            shift_participants::open_others(&mut *conn, shift_id, context.device_id).await?;
        match shift_participants::decide_close(context.shift.my_state, open_others) {
            CloseDecision::AlreadyClosed => Closing::PartClosedBefore,
            CloseDecision::ClosePart { closes_shift } => Closing::Part { closes_shift },
        }
    };
    let (need, accepted) = match closing {
        Closing::Part { closes_shift } => {
            let accepted = if closes_shift && ever > 1 {
                shift_totals::shift_accepted(&mut *conn, shift_id).await?
            } else {
                0
            };
            let need = shift_participants::reason_need(
                closes_shift,
                ever,
                closed.planned_qty_snapshot,
                closed.actual_qty,
                context.shift.planned_qty,
                accepted,
            );
            (need, accepted)
        }
        // A close the shift no longer takes: a one-device shift keeps stage 2a's rule, a shared
        // one needs nothing.
        Closing::ShiftClosed | Closing::PartClosedBefore => (
            shift_participants::reason_need(
                true,
                ever,
                closed.planned_qty_snapshot,
                closed.actual_qty,
                None,
                0,
            ),
            0,
        ),
    };
    if need == ReasonNeed::Required && closed.reason_code.is_none() {
        return Err(Reject::field("data.reasonCode").into());
    }
    let outcome = match closing {
        Closing::Part { .. } => "accepted",
        Closing::ShiftClosed | Closing::PartClosedBefore => "already_closed",
    };
    sqlx::query(
        "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
         planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(shift_id)
    .bind(context.device_id)
    .bind(context.operator_id)
    .bind(closed.planned_qty_snapshot)
    .bind(closed.actual_qty)
    .bind(closed.closed_box_count)
    .bind(&closed.reason_code)
    .bind(&closed.closed_at)
    .bind(outcome)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let closes_shift = match closing {
        Closing::ShiftClosed => {
            return Ok(Applied {
                details: Some(json!({ "alreadyClosed": true })),
                ..Applied::accepted()
            });
        }
        Closing::PartClosedBefore => {
            return Ok(Applied {
                details: Some(json!({ "partClosed": true })),
                ..Applied::accepted()
            });
        }
        Closing::Part { closes_shift } => closes_shift,
    };
    let reason_missing = need == ReasonNeed::Shared && closed.reason_code.is_none();
    let mut audit = json!({
        "actualQty": closed.actual_qty,
        "plannedQty": closed.planned_qty_snapshot,
        "closedBoxCount": closed.closed_box_count,
        "reasonCode": closed.reason_code,
    });
    // A one-device shift's close keeps stage 2a's row exactly.
    if ever > 1 {
        audit["participants"] = json!(ever);
        audit["acceptedTotal"] = json!(accepted);
        audit["reasonMissing"] = json!(reason_missing);
    }
    let details = if !closes_shift {
        Some(json!({ "partClosed": true }))
    } else if reason_missing {
        Some(json!({ "reasonMissing": true }))
    } else {
        None
    };
    // The shift's and the part's columns keep the host's format: whole seconds, UTC.
    Ok(Applied {
        details,
        close: Some(CloseShift {
            closed_at: format_timestamp(closed_at),
            reason_code: closed.reason_code.clone(),
            actual_qty: closed.actual_qty,
            closes_shift,
            reason_missing,
            part_audit: json!({
                "number": context.shift.number,
                "actualQty": closed.actual_qty,
                "closedBoxCount": closed.closed_box_count,
                "reasonCode": closed.reason_code,
            }),
            audit,
        }),
        ..Applied::accepted()
    })
}
