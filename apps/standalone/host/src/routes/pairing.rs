//! Device pairing: the local device (`POST /v1/local-pair`), one-time codes
//! for devices in the network (`POST /v1/office/pairing-codes`) and device
//! self-information (`GET /v1/device`).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use markiro_proto::{
    DeviceInfo, DeviceKind, LocalPairRequest, PairResponse, PairingCode, Secret, PROTOCOL_HEADER,
};
use serde_json::json;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{require_loopback, AuthDevice, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::pairing_code;
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
            action: actions::DEVICE_LOCAL_PAIR,
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

/// `POST /v1/office/pairing-codes` (administrators): a one-time code for a
/// device in the local network. Only its hash is stored; the code and the
/// payload are returned once.
pub async fn create_code(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<PairingCode>, ApiError> {
    context.require_admin()?;
    let code = pairing_code::generate();
    let now = state.now();
    let at = format_timestamp(now);
    let expires = format_timestamp(now + pairing_code::CODE_LIFETIME);
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query(
        "INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(key_hash(&code))
    .bind(&context.user.id)
    .bind(&at)
    .bind(&expires)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PAIRING_CODE_CREATE,
            target_type: Some("pairing_code"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "expiresAt": expires }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    let addresses = (state.endpoint.addresses)();
    let payload = pairing_code::payload(
        &addresses,
        state.endpoint.port,
        &state.endpoint.fingerprint,
        &code,
    );
    Ok(Json(PairingCode {
        code: Secret::new(code),
        expires_at: expires,
        payload: Secret::new(payload),
    }))
}
