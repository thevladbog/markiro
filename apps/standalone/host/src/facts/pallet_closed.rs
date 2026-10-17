//! `pallet_closed` facts (plan ПЛ-Х): a station closed its pallet, when it
//! filled or early, with an SSCC of a pallet block (extension 1) the host
//! issued to it. The SSCC is checked as a box's (`box_closed.rs`): by its
//! form and its block, never its check digit; one serial of a block is one
//! label. A pallet none of whose boxes reached the host opens closed, so its
//! printed SSCC is never issued twice; boxes that name it later join it.

use markiro_proto::{receipt_codes, PalletClosedFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{blocks, pallets, registry_touch, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a closed pallet have the shape the station gives them.
fn check(closed: &PalletClosedFact) -> Result<(), Reject> {
    for (field, id) in [
        ("data.palletId", &closed.pallet_id),
        ("data.blockId", &closed.block_id),
    ] {
        if validate::client_uuid(field, id).is_err() {
            return Err(Reject::field(field));
        }
    }
    for (field, at) in [
        ("data.openedAt", &closed.opened_at),
        ("data.closedAt", &closed.closed_at),
    ] {
        if rules::device_instant(at).is_none() {
            return Err(Reject::field(field));
        }
    }
    if closed.sscc.len() != 18 || !closed.sscc.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Reject::field("data.sscc"));
    }
    if closed.box_count == 0 {
        return Err(Reject::field("data.boxCount"));
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: PalletClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&closed)?;
    let serial = i64::try_from(closed.serial).map_err(|_| Reject::field("data.serial"))?;
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &closed.pallet_id).await?;
    if let Some(sscc) = found.as_ref().and_then(|pallet| pallet.sscc.as_ref()) {
        // The same close sent again under another id changes nothing.
        return if *sscc == closed.sscc {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::PALLET_ALREADY_CLOSED).into())
        };
    }
    if !rules::names_serial(&closed.sscc, 1, &context.shift.issuer_prefix, closed.serial)
        || !blocks::issued(&mut *conn, context, &closed.block_id, 1, serial).await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    // One serial of a pallet block is one label, on whichever kind of pallet it is printed: another
    // pallet of either table with this SSCC, or on this serial of this block under any check
    // digit, holds it. A box's SSCC starts with 0 and comes from a box block, so no box can. The
    // check runs in the batch's `BEGIN IMMEDIATE` transaction, as the warehouse close's does, so
    // the two closes cannot both pass for one label.
    let taken: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM pallets WHERE sscc = ?1 OR (block_id = ?2 AND serial = ?3) \
         UNION ALL SELECT 1 FROM warehouse_pallets WHERE sscc = ?1 OR (block_id = ?2 AND serial = ?3)",
    )
    .bind(&closed.sscc)
    .bind(&closed.block_id)
    .bind(serial)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if taken.is_some() || crate::cloud_history::reserved_sscc(&mut *conn, &closed.sscc).await? {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
         serial, box_count_reported, operator_id, received_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (id) DO UPDATE SET opened_at = excluded.opened_at, \
         closed_at = excluded.closed_at, sscc = excluded.sscc, block_id = excluded.block_id, \
         serial = excluded.serial, box_count_reported = excluded.box_count_reported, \
         operator_id = excluded.operator_id",
    )
    .bind(&closed.pallet_id)
    .bind(&context.shift.id)
    .bind(context.device_id)
    .bind(&closed.opened_at)
    .bind(&closed.closed_at)
    .bind(&closed.sscc)
    .bind(&closed.block_id)
    .bind(serial)
    .bind(closed.box_count)
    .bind(context.operator_id)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    registry_touch::pallet_boxes(&mut *conn, &closed.pallet_id, context.received_at).await?;
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
    Ok(Applied::accepted())
}
