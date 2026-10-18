//! `GET` and `PUT /v1/office/host-network`: the host's addresses with how each was got, and the
//! administrator's mark that they stay (plan ТСД-П, task П4). The system is asked for every read
//! (a lease can change); on a PC that is not Windows every mode is `unknown`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{HostNetwork, HostNetworkConfirm};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

async fn read(state: &AppState) -> Result<HostNetwork, ApiError> {
    let details = state.endpoint.details.clone();
    let addresses = tokio::task::spawn_blocking(move || details())
        .await
        .map_err(ApiError::internal)?;
    let confirmed_at: Option<String> =
        sqlx::query_scalar("SELECT address_confirmed_at FROM site WHERE id = 1")
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(HostNetwork {
        addresses,
        port: state.endpoint.port,
        confirmed_at,
    })
}

pub async fn get_network(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<HostNetwork>, ApiError> {
    Ok(Json(read(&state).await?))
}

pub async fn put_network(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(request): ApiJson<HostNetworkConfirm>,
) -> Result<Json<HostNetwork>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query("UPDATE site SET address_confirmed_at = ? WHERE id = 1")
        .bind(request.confirmed.then_some(&at))
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::HOST_NETWORK_CONFIRM,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "confirmed": request.confirmed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(read(&state).await?))
}
