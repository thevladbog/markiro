//! Boxes as the facts tell them: a box belongs to one device in one shift,
//! and its id is the device's own. A record that names another device's or
//! another shift's box is answered as if no such box existed
//! (`box_unknown`), so a device learns nothing of the others.

use markiro_proto::receipt_codes;
use sqlx::SqliteConnection;

use super::{Context, Failure, Reject};
use crate::error::ApiError;

/// A box of this device and this shift.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnBox {
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    pub disassembled_at: Option<String>,
    /// The pallet the box joined as it closed (plan ПЛ-Х).
    pub pallet_id: Option<String>,
}

/// The box `id` when it is this device's in this shift, `None` when no box
/// has the id, and `box_unknown` when another device's or another shift's
/// box has it.
pub async fn find(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    id: &str,
) -> Result<Option<OwnBox>, Failure> {
    if crate::cloud_history::reserved_identity(&mut *conn, id).await? {
        return Err(Reject::new(receipt_codes::BOX_UNKNOWN).into());
    }
    type BoxRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<BoxRow> = sqlx::query_as(
        "SELECT shift_id, device_id, closed_at, sscc, disassembled_at, pallet_id FROM boxes \
         WHERE id = ?",
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
            Err(Reject::new(receipt_codes::BOX_UNKNOWN).into())
        }
        Some((_, _, closed_at, sscc, disassembled_at, pallet_id)) => Ok(Some(OwnBox {
            closed_at,
            sscc,
            disassembled_at,
            pallet_id,
        })),
    }
}
