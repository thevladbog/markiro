//! `box_closed` facts: a station closed a box with an SSCC of a block the
//! host issued to it. The host checks the SSCC by its form and its block,
//! never its check digit (a marking rule, the domain's); it raises the
//! block's `consumed_through` and compares the station's digest of the box's
//! members with its own items, keeping the result for the shift's card
//! (stage 4). In a shift with pallets the box joins the pallet it names
//! (plan ПЛ-Х), which its first box opens on the host; the pallet's state
//! never refuses a box, since the station put the box on it.

use markiro_proto::{receipt_codes, BoxClosedFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{blocks, boxes, pallets, registry_touch, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The fields of a closed box have the shape the station gives them.
fn check(closed: &BoxClosedFact) -> Result<(), Reject> {
    for (field, id) in [
        ("data.boxId", &closed.box_id),
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
    if closed.item_count == 0 {
        return Err(Reject::field("data.itemCount"));
    }
    if !rules::is_code_hash(&closed.membership_digest) {
        return Err(Reject::field("data.membershipDigest"));
    }
    if let Some(pallet_id) = &closed.pallet_id {
        if validate::client_uuid("data.palletId", pallet_id).is_err() {
            return Err(Reject::field("data.palletId"));
        }
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let closed: BoxClosedFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&closed)?;
    let serial = i64::try_from(closed.serial).map_err(|_| Reject::field("data.serial"))?;
    if closed.pallet_id.is_some() {
        pallets::require(context)?;
    }
    let found = boxes::find(&mut *conn, context, &closed.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if let Some(sscc) = &found.sscc {
        // The same close sent again under another id changes nothing; on
        // another pallet it is another close.
        return if *sscc == closed.sscc && found.pallet_id == closed.pallet_id {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::BOX_ALREADY_CLOSED).into())
        };
    }
    if !rules::names_serial(&closed.sscc, 0, &context.shift.issuer_prefix, closed.serial)
        || !blocks::issued(&mut *conn, context, &closed.block_id, 0, serial).await?
    {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    // One serial of a block is one label: another box with this SSCC, or on
    // this serial of this block under any check digit, holds it.
    let taken: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM boxes WHERE sscc = ? OR (block_id = ? AND serial = ?)")
            .bind(&closed.sscc)
            .bind(&closed.block_id)
            .bind(serial)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if taken.is_some() || crate::cloud_history::reserved_sscc(&mut *conn, &closed.sscc).await? {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    // The pallet is this device's in this shift (`pallet_unknown`
    // otherwise), or new.
    let new_pallet = match &closed.pallet_id {
        Some(pallet_id) => pallets::find(&mut *conn, context, pallet_id)
            .await?
            .is_none()
            .then_some(pallet_id),
        None => None,
    };
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT code_hash FROM box_items \
         WHERE box_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
    )
    .bind(&closed.box_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let matches = rules::box_membership_digest(&members) == closed.membership_digest;
    if let Some(pallet_id) = new_pallet {
        pallets::open(&mut *conn, context, pallet_id, &closed.closed_at).await?;
    }
    sqlx::query(
        "UPDATE boxes SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
         item_count_reported = ?, membership_digest = ?, digest_matches = ?, operator_id = ?, \
         pallet_id = ? WHERE id = ?",
    )
    .bind(&closed.opened_at)
    .bind(&closed.closed_at)
    .bind(&closed.sscc)
    .bind(&closed.block_id)
    .bind(serial)
    .bind(closed.item_count)
    .bind(&closed.membership_digest)
    .bind(matches)
    .bind(context.operator_id)
    .bind(&closed.pallet_id)
    .bind(&closed.box_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    registry_touch::box_by_id(&mut *conn, &closed.box_id, context.received_at).await?;
    blocks::consume(&mut *conn, &closed.block_id, serial).await?;
    Ok(Applied::accepted())
}
