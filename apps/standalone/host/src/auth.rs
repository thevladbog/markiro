//! Request identities. Rights come only from these extractors, never from
//! identifiers the client sends.

use std::net::SocketAddr;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::StatusCode;
use markiro_proto::{
    codes, credentials, DeviceKind, OfficeRole, OfficeUser, OFFICE_SESSION_HEADER,
};
use sqlx::SqliteConnection;
use time::OffsetDateTime;

use crate::audit::Actor;
use crate::clock::{format_timestamp, parse_timestamp};
use crate::error::ApiError;
use crate::secrets::key_hash;
use crate::secrets::random_key;
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
            .ok_or_else(|| {
                ApiError::unauthorized(credentials::DEVICE, "a device key is required")
            })?;
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT id, kind FROM devices WHERE key_hash = ? AND revoked_at IS NULL",
        )
        .bind(key_hash(key))
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        let (id, kind) = row.ok_or_else(|| {
            ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
        })?;
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

/// Office sessions end after 30 idle minutes or 12 hours (spec §2, decision 7).
pub const SESSION_IDLE: time::Duration = time::Duration::minutes(30);
pub const SESSION_ABSOLUTE: time::Duration = time::Duration::hours(12);

/// A live office session on the requesting device. The user's role and
/// activity are read from the database on every request.
#[derive(Debug, Clone)]
pub struct OfficeContext {
    pub device_id: String,
    pub session_id: String,
    pub user: OfficeUser,
}

impl OfficeContext {
    pub fn actor(&self) -> Actor<'_> {
        Actor::OfficeUser(&self.user.id)
    }

    pub fn require_admin(&self) -> Result<(), ApiError> {
        if self.user.role == OfficeRole::Admin {
            Ok(())
        } else {
            Err(ApiError::forbidden("the administrator role is required"))
        }
    }

    /// Re-check inside the caller's write transaction that this session still
    /// exists and its user is active; returns the user's current role.
    async fn live_role_in(&self, conn: &mut SqliteConnection) -> Result<OfficeRole, ApiError> {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT u.active, u.role FROM office_sessions s \
             JOIN office_users u ON u.id = s.user_id \
             WHERE s.id = ?",
        )
        .bind(&self.session_id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
        let (active, role) = row
            .ok_or_else(|| ApiError::unauthorized(credentials::SESSION, "office session ended"))?;
        if active == 0 {
            return Err(ApiError::unauthorized(
                credentials::SESSION,
                "office session ended",
            ));
        }
        serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)
    }

    /// For writes any office user may make (their own password): the session
    /// must still be live inside the transaction.
    pub async fn require_session_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        self.live_role_in(conn).await.map(|_| ())
    }

    /// Re-check admin rights inside the caller's write transaction. The
    /// extractor's role and active flag were read before the request started
    /// hashing a password (0.3-1s of PBKDF2 outside any transaction); a
    /// demotion or deactivation committed in that window must still stop the
    /// write, so every admin write calls this again right after
    /// `begin_write`, in addition to the early `require_admin` rejection.
    pub async fn require_admin_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        if self.live_role_in(conn).await? == OfficeRole::Admin {
            Ok(())
        } else {
            Err(ApiError::forbidden("the administrator role is required"))
        }
    }
}

type SessionRow = (String, String, String, String, String, String, String, i64);

impl FromRequestParts<AppState> for OfficeContext {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let device = AuthDevice::from_request_parts(parts, state).await?;
        let token = parts
            .headers
            .get(OFFICE_SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                ApiError::unauthorized(credentials::SESSION, "an office session is required")
            })?;
        let row: Option<SessionRow> = sqlx::query_as(
            "SELECT s.id, s.last_seen_at, s.expires_at, u.id, u.login, u.name, u.role, u.active \
             FROM office_sessions s JOIN office_users u ON u.id = s.user_id \
             WHERE s.token_hash = ? AND s.device_id = ?",
        )
        .bind(key_hash(token))
        .bind(&device.id)
        .fetch_optional(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        let (session_id, last_seen_at, expires_at, user_id, login, name, role, active) = row
            .ok_or_else(|| {
                ApiError::unauthorized(credentials::SESSION, "unknown or ended office session")
            })?;
        let now = state.now();
        let last_seen = parse_timestamp(&last_seen_at).map_err(ApiError::internal)?;
        let expires = parse_timestamp(&expires_at).map_err(ApiError::internal)?;
        if now >= expires || now >= last_seen + SESSION_IDLE || active == 0 {
            let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
            end_session(&mut conn, &session_id)
                .await
                .map_err(ApiError::internal)?;
            return Err(ApiError::unauthorized(
                credentials::SESSION,
                "office session expired",
            ));
        }
        // Record activity at most once a minute, like the device's
        // `last_seen_at`: every office request otherwise fsyncs a write
        // (`synchronous=FULL`) that nobody reads at that resolution.
        sqlx::query(
            "UPDATE office_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at <= ?",
        )
        .bind(format_timestamp(now))
        .bind(&session_id)
        .bind(format_timestamp(now - time::Duration::minutes(1)))
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
        let role: OfficeRole =
            serde_json::from_value(serde_json::Value::String(role)).map_err(ApiError::internal)?;
        Ok(Self {
            device_id: device.id,
            session_id,
            user: OfficeUser {
                id: user_id,
                login,
                name,
                role,
            },
        })
    }
}

/// Open a session for `user_id` on `device_id`; returns the token (shown
/// once) and the absolute expiry.
pub async fn open_session(
    conn: &mut SqliteConnection,
    user_id: &str,
    device_id: &str,
    now: OffsetDateTime,
) -> Result<(String, OffsetDateTime), sqlx::Error> {
    // Sessions nobody ended (the app was simply closed) are cleared here.
    sqlx::query("DELETE FROM office_sessions WHERE expires_at <= ? OR last_seen_at <= ?")
        .bind(format_timestamp(now))
        .bind(format_timestamp(now - SESSION_IDLE))
        .execute(&mut *conn)
        .await?;
    let token = random_key();
    let expires = now + SESSION_ABSOLUTE;
    sqlx::query(
        "INSERT INTO office_sessions (id, token_hash, user_id, device_id, created_at, last_seen_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(key_hash(&token))
    .bind(user_id)
    .bind(device_id)
    .bind(format_timestamp(now))
    .bind(format_timestamp(now))
    .bind(format_timestamp(expires))
    .execute(conn)
    .await?;
    Ok((token, expires))
}

pub async fn end_session(conn: &mut SqliteConnection, session_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM office_sessions WHERE id = ?")
        .bind(session_id)
        .execute(conn)
        .await?;
    Ok(())
}
