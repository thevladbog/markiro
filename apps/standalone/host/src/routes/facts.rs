//! `POST /v1/device/facts` (stage 2a spec §4.4): a device's batch of 1–100
//! facts, applied in one write transaction, each record on its own
//! (`facts::receive`), answered with a receipt per record in their order.
//! A database error is no receipt: nothing of the batch stays, and the
//! device sends it again. Facts take no revision, but a station's close of
//! its shift and a closed shift's first late fact change the shift's row:
//! the batch then takes one revision for all of them.

use axum::extract::State;
use axum::Json;
use markiro_proto::FactReceipts;
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision};
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
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock sends nothing.
    device.require_live_in(&mut tx).await?;
    // What the batch writes is stamped with the moment it holds the lock,
    // not the moment it arrived: a batch that waited behind the office's
    // close of its shift must not mark the shift late before that close.
    let received_at = state.timestamp();
    let mut receipts = Vec::with_capacity(batch.records.len());
    let mut revision = None;
    for (position, record) in batch.records.iter().enumerate() {
        match facts::receive(&mut tx, &device.id, record, &received_at, &mut revision).await {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                // The station sends the same batch again, so support must
                // learn which record the host could not write: its place in
                // the batch, never the record (its id is device text).
                tracing::error!(device = %device.id, position, "a fact batch failed");
                return Err(error);
            }
        }
    }
    // A batch that closed a shift or marked one late took a revision, so
    // the streams wake and stations read their shifts again.
    match revision {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
        None => tx.commit().await,
    }
    .map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
