//! `box_closed` facts: a station closed a box with an SSCC of a block the
//! host issued to it. The host checks the SSCC by its form and its block,
//! never its check digit (a marking rule, the domain's); it raises the
//! block's `consumed_through` and compares the station's digest of the box's
//! members with its own items, keeping the result for the shift's card
//! (stage 4).

use markiro_proto::{receipt_codes, BoxClosedFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, rules, Applied, Context, Failure, Reject};
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
    Ok(())
}

/// The SSCC is the box extension's, of the snapshot's prefix and of
/// `serial`, whatever its check digit: the first 17 digits are
/// `0`, the prefix and the serial padded to the prefix's serial width.
fn names_serial(sscc: &str, issuer_prefix: &str, serial: u64) -> bool {
    let width = 16 - issuer_prefix.len();
    serial < validate::serial_capacity(issuer_prefix)
        && sscc[..17] == format!("0{issuer_prefix}{serial:0width$}")
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
    let found = boxes::find(&mut *conn, context, &closed.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if let Some(sscc) = &found.sscc {
        // The same close sent again under another id changes nothing.
        return if *sscc == closed.sscc {
            Ok(Applied::accepted())
        } else {
            Err(Reject::new(receipt_codes::BOX_ALREADY_CLOSED).into())
        };
    }
    if !names_serial(&closed.sscc, &context.shift.issuer_prefix, closed.serial) {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    let issued: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE id = ? AND device_id = ? AND issuer_prefix = ? \
         AND extension = 0 AND from_serial <= ? AND to_serial >= ? AND revoked_at IS NULL",
    )
    .bind(&closed.block_id)
    .bind(context.device_id)
    .bind(&context.shift.issuer_prefix)
    .bind(serial)
    .bind(serial)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if issued.is_none() {
        return Err(Reject::new(receipt_codes::SSCC_NOT_ISSUED).into());
    }
    let taken: Option<i64> = sqlx::query_scalar("SELECT 1 FROM boxes WHERE sscc = ?")
        .bind(&closed.sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(Reject::new(receipt_codes::SSCC_TAKEN).into());
    }
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT code_hash FROM box_items \
         WHERE box_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
    )
    .bind(&closed.box_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let matches = rules::box_membership_digest(&members) == closed.membership_digest;
    sqlx::query(
        "UPDATE boxes SET opened_at = ?, closed_at = ?, sscc = ?, block_id = ?, serial = ?, \
         item_count_reported = ?, membership_digest = ?, digest_matches = ?, operator_id = ? \
         WHERE id = ?",
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
    .bind(&closed.box_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_blocks SET consumed_through = max(coalesce(consumed_through, ?1), ?1) \
         WHERE id = ?2",
    )
    .bind(serial)
    .bind(&closed.block_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
