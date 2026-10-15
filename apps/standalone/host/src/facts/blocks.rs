//! The SSCC blocks a closed box's or pallet's serial comes from (stage 2a
//! spec §4.3, plan ПЛ-Х): the serial lies in a live block of the record's
//! extension (a box 0, a pallet 1) and of the shift's issuer prefix, issued
//! to this device; a close raises the block's `consumed_through` to the
//! highest serial closed, in whatever order the closes arrive.

use sqlx::SqliteConnection;

use super::Context;
use crate::error::ApiError;

/// Whether `serial` lies in the block `block_id` that the host issued to
/// this device, of `extension` and the shift's issuer prefix, and did not
/// revoke.
pub async fn issued(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    block_id: &str,
    extension: u8,
    serial: i64,
) -> Result<bool, ApiError> {
    issued_to(
        conn,
        context.device_id,
        &context.shift.issuer_prefix,
        block_id,
        extension,
        serial,
    )
    .await
}

/// [`issued`] for a record outside a shift: the device and the issuer prefix are named, not read
/// from the shift's context (a warehouse pallet has no shift).
pub async fn issued_to(
    conn: &mut SqliteConnection,
    device_id: &str,
    issuer_prefix: &str,
    block_id: &str,
    extension: u8,
    serial: i64,
) -> Result<bool, ApiError> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
         AND extension = ? AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
    )
    .bind(block_id)
    .bind(device_id)
    .bind(issuer_prefix)
    .bind(i64::from(extension))
    .bind(serial)
    .bind(serial)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(found.is_some())
}

/// Raise the block's `consumed_through` to `serial`, never lower it
/// (SQLite's `max(NULL, x)` is NULL, hence the `coalesce`).
pub async fn consume(
    conn: &mut SqliteConnection,
    block_id: &str,
    serial: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE sscc_blocks SET consumed_through = max(coalesce(consumed_through, ?1), ?1) \
         WHERE id = ?2",
    )
    .bind(serial)
    .bind(block_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
