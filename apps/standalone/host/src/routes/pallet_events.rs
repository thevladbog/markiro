//! `POST /v1/device/pallet-events`: a station or handheld's warehouse pallets outside any shift.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceKind, FactReceipts};
use serde::Deserialize;
use serde_json::Value;

use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision};
use crate::error::{ApiError, ApiJson};
use crate::pallet_events;
use crate::routes::facts::MAX_RECORDS;
use crate::server::AppState;

/// The body as the host reads it: each record a JSON value of its own, so a record it cannot read
/// is answered `rejected` and the others are applied.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncomingEvents {
    records: Vec<Value>,
}

pub async fn receive_events(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(batch): ApiJson<IncomingEvents>,
) -> Result<Json<FactReceipts>, ApiError> {
    if !(1..=MAX_RECORDS).contains(&batch.records.len()) {
        return Err(ApiError::validation(
            "records",
            format!("1-{MAX_RECORDS} records"),
        ));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A device revoked while the batch waited for the lock sends nothing.
    let kind = device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            "only floor devices send pallet events",
        )
        .await?;
    let received_at = state.timestamp();
    let mut receipts = Vec::with_capacity(batch.records.len());
    let mut revision = None;
    for (position, record) in batch.records.iter().enumerate() {
        match pallet_events::receive(
            &state,
            &mut tx,
            &device.id,
            kind,
            record,
            &received_at,
            &mut revision,
        )
        .await
        {
            Ok(receipt) => receipts.push(receipt),
            Err(error) => {
                // The device sends the same batch again; support learns which record failed.
                if error.status().is_server_error() {
                    tracing::error!(device = %device.id, position, "a pallet event batch failed");
                }
                return Err(error);
            }
        }
    }
    match revision {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
        None => tx.commit().await,
    }
    .map_err(ApiError::internal)?;
    Ok(Json(FactReceipts { receipts }))
}
