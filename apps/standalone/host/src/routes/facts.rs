//! `POST /v1/device/facts` (stage 2a spec §4.4): a device's batch of 1–100
//! facts, applied in one write transaction, each record on its own
//! (`facts::receive`), answered with a receipt per record in their order.
//! A database error is no receipt: nothing of the batch stays, and the
//! device sends it again.

use axum::extract::State;
use axum::Json;
use markiro_proto::FactReceipts;
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::facts;
use crate::server::AppState;

/// The most records of one batch.
pub const MAX_RECORDS: usize = 100;

/// The body as the host reads it: each record a JSON value of its own, so a
/// record it cannot read is answered `rejected` and the others are applied.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingFacts {
    records: Vec<Value>,
}

pub async fn receive_facts(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingFacts>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation(
            "records",
            format!("1-{MAX_RECORDS} records"),
        ));
    }
    let received_at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
    let mut receipts = Vec::with_capacity(batch.records.len());
    for record in &batch.records {
        receipts.push(facts::receive(&mut tx, &device.id, record, &received_at).await?);
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
