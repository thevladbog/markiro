//! Request identities. Rights come only from these extractors, never from
//! identifiers the client sends.

use std::net::SocketAddr;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::StatusCode;
use markiro_proto::{codes, DeviceKind};

use crate::clock::format_timestamp;
use crate::error::ApiError;
use crate::secrets::key_hash;
use crate::server::AppState;

/// A paired, non-revoked device, identified by `Authorization: Bearer <key>`.
#[derive(Debug, Clone)]
pub struct AuthDevice {
    pub id: String,
    pub kind: DeviceKind,
}

impl FromRequestParts<AppState> for AuthDevice {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let key = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|key| !key.is_empty())
            .ok_or_else(|| ApiError::unauthorized("a device key is required"))?;
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT id, kind FROM devices WHERE key_hash = ? AND revoked_at IS NULL",
        )
        .bind(key_hash(key))
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        let (id, kind) =
            row.ok_or_else(|| ApiError::unauthorized("unknown or revoked device key"))?;
        let kind: DeviceKind =
            serde_json::from_value(serde_json::Value::String(kind)).map_err(ApiError::internal)?;
        // Record activity at most once a minute to keep writes rare.
        let now = state.now();
        sqlx::query(
            "UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
        )
        .bind(format_timestamp(now))
        .bind(&id)
        .bind(format_timestamp(now - time::Duration::minutes(1)))
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        Ok(Self { id, kind })
    }
}

/// Only peers on this computer (spec §2, decision 14).
pub fn require_loopback(peer: SocketAddr) -> Result<(), ApiError> {
    if peer.ip().to_canonical().is_loopback() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            codes::LOOPBACK_ONLY,
            "only accepted from this computer",
        ))
    }
}
