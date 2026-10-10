//! `pallet_label` facts (plan ПЛ-Х): the operator checked a closed pallet's
//! printed label (scanned its SSCC) or skipped the check, as a box's
//! (`box_label.rs`). The host keeps when.

use markiro_proto::{receipt_codes, LabelOutcome, PalletLabelFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{pallets, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let label: PalletLabelFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    if validate::client_uuid("data.palletId", &label.pallet_id).is_err() {
        return Err(Reject::field("data.palletId").into());
    }
    if rules::device_instant(&label.at).is_none() {
        return Err(Reject::field("data.at").into());
    }
    pallets::require(context)?;
    let found = pallets::find(&mut *conn, context, &label.pallet_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::PALLET_UNKNOWN))?;
    if found.closed_at.is_none() {
        return Err(Reject::new(receipt_codes::PALLET_STATE).into());
    }
    let column = match label.outcome {
        LabelOutcome::Verified => "print_verified_at",
        LabelOutcome::Skipped => "print_skipped_at",
    };
    sqlx::query(&format!("UPDATE pallets SET {column} = ? WHERE id = ?"))
        .bind(&label.at)
        .bind(&label.pallet_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
