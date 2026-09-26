//! Device pairing: the local device (`POST /v1/local-pair`) and device
//! self-information (`GET /v1/device`). Code pairing arrives in plan 1c.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, LocalPairRequest, PairResponse, PROTOCOL_HEADER};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{require_loopback, AuthDevice};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::secrets::{key_hash, random_key};
use crate::server::AppState;

pub async fn local_pair(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<LocalPairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    require_loopback(peer)?;
    if request.kind == DeviceKind::Handheld {
        return Err(ApiError::validation(
            "kind",
            "a handheld pairs with a code, not locally",
        ));
    }
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::validation(
            "name",
            "the name must be 1-100 characters",
        ));
    }
    let app_version = request.app_version.trim();
    if app_version.is_empty() || app_version.len() > 50 {
        return Err(ApiError::validation(
            "appVersion",
            "the app version must be 1-50 characters",
        ));
    }
    if request.capabilities.len() > 32
        || request
            .capabilities
            .iter()
            .any(|capability| capability.is_empty() || capability.len() > 64)
    {
        return Err(ApiError::validation(
            "capabilities",
            "at most 32 capabilities of 1-64 characters",
        ));
    }
    // The guard already checked the header; record the version this device speaks.
    let protocol: i64 = headers
        .get(PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .unwrap_or(i64::from(markiro_proto::PROTOCOL_VERSION));

    let id = uuid::Uuid::new_v4().to_string();
    let key = random_key();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, capabilities, paired_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(request.kind.as_str())
    .bind(name)
    .bind(key_hash(&key))
    .bind(app_version)
    .bind(protocol)
    .bind(serde_json::to_string(&request.capabilities).map_err(ApiError::internal)?)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &now,
        Entry {
            actor: Actor::Device(&id),
            action: "device.local_pair",
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "kind": request.kind.as_str(), "name": name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(PairResponse {
        device_id: id,
        device_key: key.into(),
        host_id: state.host_id.clone(),
    }))
}

pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let (name, line_id, paired_at): (String, Option<String>, String) =
        sqlx::query_as("SELECT name, line_id, paired_at FROM devices WHERE id = ?")
            .bind(&device.id)
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(DeviceInfo {
        id: device.id,
        kind: device.kind,
        name,
        line_id,
        paired_at,
    }))
}
