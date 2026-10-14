//! Device pairing: the local device (`POST /v1/local-pair`) and one-time
//! codes for devices in the network (`POST /v1/office/pairing-codes`, `POST
//! /v1/pairing/claim`).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use markiro_proto::{
    codes, ClaimRequest, DeviceKind, LocalPairRequest, PairResponse, PairingCode,
    PairingCodeRequest, Secret,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, reasons, Actor, Entry, Outcome};
use crate::auth::{require_loopback, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::pairing_code;
use crate::secrets::{key_hash, random_key};
use crate::server::{AppState, ClientProtocol};
use crate::validate;

pub async fn local_pair(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(ClientProtocol(protocol)): Extension<ClientProtocol>,
    ApiJson(request): ApiJson<LocalPairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    require_loopback(peer)?;
    if request.kind == DeviceKind::Handheld {
        return Err(ApiError::validation(
            "kind",
            "a handheld pairs with a code, not locally",
        ));
    }
    let (name, app_version) =
        validate::device_registration(&request.name, &request.app_version, &request.capabilities)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // A seat of the license (plan ЛЦ-2, spec §4.7); an office PC takes none.
    // Only the quotas close pairing, never the state (soft enforcement).
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
        crate::license::seats::require_seat(&state, &mut tx, quota).await?;
    }
    let key = insert_device(
        &mut tx,
        &NewDevice {
            id: &id,
            kind: request.kind,
            name,
            app_version,
            protocol,
            capabilities: &request.capabilities,
            at: &now,
        },
    )
    .await?;
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

/// A device being paired, as `devices` stores it.
struct NewDevice<'a> {
    id: &'a str,
    kind: DeviceKind,
    name: &'a str,
    app_version: &'a str,
    protocol: u32,
    capabilities: &'a [String],
    at: &'a str,
}

/// Insert a new device; returns its key (shown once, stored only as a hash).
async fn insert_device(
    conn: &mut SqliteConnection,
    device: &NewDevice<'_>,
) -> Result<String, ApiError> {
    let key = random_key();
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, capabilities, paired_at, last_seen_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device.id)
    .bind(device.kind.as_str())
    .bind(device.name)
    .bind(key_hash(&key))
    .bind(device.app_version)
    .bind(i64::from(device.protocol))
    .bind(serde_json::to_string(device.capabilities).map_err(ApiError::internal)?)
    .bind(device.at)
    .bind(device.at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(key)
}

#[derive(sqlx::FromRow)]
struct StoredCode {
    id: String,
    expires_at: String,
    used_at: Option<String>,
    failed_attempts: i64,
}

/// `POST /v1/pairing/claim`: a device in the local network pairs with a
/// one-time code. No device key and no loopback check: the code is the
/// credential, bounded by its lifetime, one use, 5 failed attempts and the
/// per-address limit.
pub async fn claim(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Extension(ClientProtocol(protocol)): Extension<ClientProtocol>,
    ApiJson(request): ApiJson<ClaimRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    state.claim_limiter.check(peer.ip())?;
    let (name, app_version) =
        validate::device_registration(&request.name, &request.app_version, &request.capabilities)?;
    let address = peer.ip().to_canonical().to_string();
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let found: Option<StoredCode> = match pairing_code::normalize(request.code.expose()) {
        Some(code) => sqlx::query_as(
            "SELECT id, expires_at, used_at, failed_attempts FROM pairing_codes WHERE code_hash = ?",
        )
        .bind(key_hash(&code))
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?,
        None => None,
    };
    let refusal = match &found {
        None => Some((reasons::UNKNOWN_CODE, codes::PAIRING_CODE_INVALID)),
        Some(code) if code.used_at.is_some() => {
            Some((reasons::CODE_USED, codes::PAIRING_CODE_INVALID))
        }
        Some(code) if code.failed_attempts >= pairing_code::MAX_FAILED_ATTEMPTS => {
            Some((reasons::TOO_MANY_ATTEMPTS, codes::PAIRING_CODE_INVALID))
        }
        // Timestamps share one sortable format, so text order is time order.
        Some(code) if code.expires_at <= at => {
            Some((reasons::CODE_EXPIRED, codes::PAIRING_CODE_EXPIRED))
        }
        Some(_) => None,
    };
    let code = match (found, refusal) {
        (Some(code), None) => code,
        (found, refusal) => {
            // `(None, None)` cannot happen: no row always refuses.
            let (reason, error_code) =
                refusal.unwrap_or((reasons::UNKNOWN_CODE, codes::PAIRING_CODE_INVALID));
            if reason == reasons::UNKNOWN_CODE {
                // The hash cannot tell which code was meant, so a wrong code
                // counts against every live one: each survives at most
                // MAX_FAILED_ATTEMPTS wrong tries in total.
                sqlx::query(
                    "UPDATE pairing_codes SET failed_attempts = failed_attempts + 1 \
                     WHERE used_at IS NULL AND expires_at > ?",
                )
                .bind(&at)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            }
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::System,
                    action: actions::DEVICE_CLAIM,
                    target_type: Some("pairing_code"),
                    target_id: found.as_ref().map(|code| code.id.as_str()),
                    outcome: Outcome::Denied,
                    details: json!({
                        "reason": reason,
                        "kind": request.kind.as_str(),
                        "name": name,
                        "address": address,
                    }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            let message = if error_code == codes::PAIRING_CODE_EXPIRED {
                "the pairing code expired"
            } else {
                "the pairing code is not valid"
            };
            return Err(ApiError::new(StatusCode::BAD_REQUEST, error_code, message));
        }
    };
    // The license's feature and seat (plan ЛЦ-2 Д8, Д9, spec §4.7), after
    // the code is verified and before it is used up: a refused device keeps
    // the code for its next try, and the refusal writes no row.
    if request.kind == DeviceKind::Handheld {
        crate::license::seats::require_feature(
            &state,
            &mut tx,
            crate::license::seats::Feature::Handheld,
        )
        .await?;
    }
    if let Some(quota) = crate::license::seats::seat_of(request.kind) {
        crate::license::seats::require_seat(&state, &mut tx, quota).await?;
    }
    sqlx::query("UPDATE pairing_codes SET used_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&code.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let device_id = uuid::Uuid::new_v4().to_string();
    let key = insert_device(
        &mut tx,
        &NewDevice {
            id: &device_id,
            kind: request.kind,
            name,
            app_version,
            protocol,
            capabilities: &request.capabilities,
            at: &at,
        },
    )
    .await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device_id),
            action: actions::DEVICE_CLAIM,
            target_type: Some("device"),
            target_id: Some(&device_id),
            outcome: Outcome::Ok,
            details: json!({
                "kind": request.kind.as_str(),
                "name": name,
                "pairingCodeId": code.id,
                "address": address,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(PairResponse {
        device_id,
        device_key: key.into(),
        host_id: state.host_id.clone(),
    }))
}

/// `POST /v1/office/pairing-codes` (administrators): a one-time code for a
/// device in the local network. Only its hash is stored; the code and the
/// payload are returned once. «Новый код» sends `{ replaces: <id> }` (owner
/// decision 2026-09-27): a live code this same office user created expires
/// at once, so a claim with it answers `pairing_code_expired`. Anything else
/// in `replaces` — another user's code, an unknown, used, expired or
/// exhausted one — is ignored, and the new code is issued anyway.
pub async fn create_code(
    State(state): State<AppState>,
    context: OfficeContext,
    request: Option<ApiJson<PairingCodeRequest>>,
) -> Result<Json<PairingCode>, ApiError> {
    context.require_admin()?;
    let replaces = request.and_then(|ApiJson(request)| request.replaces);
    let code = pairing_code::generate();
    let now = state.now();
    let at = format_timestamp(now);
    let expires = format_timestamp(now + pairing_code::CODE_LIFETIME);
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // Expiring the replaced code now makes a claim refuse it as expired and
    // takes it out of the live codes a wrong guess counts against.
    let replaced = match replaces.as_deref() {
        Some(old) => {
            let expired = sqlx::query(
                "UPDATE pairing_codes SET expires_at = ? WHERE id = ? AND created_by = ? \
                 AND used_at IS NULL AND expires_at > ? AND failed_attempts < ?",
            )
            .bind(&at)
            .bind(old)
            .bind(&context.user.id)
            .bind(&at)
            .bind(pairing_code::MAX_FAILED_ATTEMPTS)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            (expired.rows_affected() == 1).then_some(old)
        }
        None => None,
    };
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
            details: match replaced {
                Some(old) => json!({ "expiresAt": expires, "replaces": old }),
                None => json!({ "expiresAt": expires }),
            },
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
        id,
        code: Secret::new(code),
        created_at: at,
        expires_at: expires,
        payload: Secret::new(payload),
    }))
}
