//! Pallets as the facts tell them (plan ПЛ-Х): a pallet belongs to one
//! device in one shift, and its id is the device's own. A record that names
//! another device's or another shift's pallet is answered as if no such
//! pallet existed (`pallet_unknown`). The first closed box that names a
//! pallet opens it on the host; its `pallet_closed` closes it.

use markiro_proto::receipt_codes;
use sqlx::SqliteConnection;

use super::{Context, Failure, Reject};
use crate::error::ApiError;

/// A pallet of this device and this shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnPallet {
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
}

/// `no_pallets` unless the record's shift works with pallets.
pub fn require(context: &Context<'_>) -> Result<(), Reject> {
    if context.shift.pallets_enabled {
        Ok(())
    } else {
        Err(Reject::new(receipt_codes::NO_PALLETS))
    }
}

/// The pallet `id` when it is this device's in this shift, `None` when no
/// pallet has the id, and `pallet_unknown` when another device's or another
/// shift's pallet has it.
pub async fn find(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<Option<OwnPallet>, Failure> {
    if crate::cloud_history::reserved_identity(&mut *conn, id).await? {
        return Err(Reject::new(receipt_codes::PALLET_UNKNOWN).into());
    }
    type PalletRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<PalletRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at FROM pallets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match row {
        None => Ok(None),
        Some((shift_id, device_id, ..))
            if shift_id != context.shift.id || device_id != context.device_id =>
        {
            Err(Reject::new(receipt_codes::PALLET_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at)) => Ok(Some(OwnPallet {
            closed_at,
            sscc,
            disassembled_at,
        })),
    }
}

/// Open the pallet `id` of this device and this shift, as its first closed
/// box tells it: `opened_at` is that box's close, which `pallet_closed`
/// replaces with the station's own.
pub async fn open(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
    opened_at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(opened_at)
    .bind(context.received_at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
