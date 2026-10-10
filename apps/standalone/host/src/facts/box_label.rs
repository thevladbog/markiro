//! `box_label` facts: the operator checked a closed box's printed label
//! (scanned its SSCC) or skipped the check. The host keeps when.

use markiro_proto::{receipt_codes, BoxLabelFact, LabelOutcome};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let label: BoxLabelFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    if validate::client_uuid("data.boxId", &label.box_id).is_err() {
        return Err(Reject::field("data.boxId").into());
    }
    if rules::device_instant(&label.at).is_none() {
        return Err(Reject::field("data.at").into());
    }
    let found = boxes::find(&mut *conn, context, &label.box_id)
        .await?
        .ok_or_else(|| Reject::new(receipt_codes::BOX_UNKNOWN))?;
    if found.closed_at.is_none() {
        return Err(Reject::new(receipt_codes::BOX_STATE).into());
    }
    let column = match label.outcome {
        LabelOutcome::Verified => "print_verified_at",
        LabelOutcome::Skipped => "print_skipped_at",
    };
    sqlx::query(&format!("UPDATE boxes SET {column} = ? WHERE id = ?"))
        .bind(&label.at)
        .bind(&label.box_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}
