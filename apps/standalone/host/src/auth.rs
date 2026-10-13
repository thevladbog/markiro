//! Request identities. Rights come only from these extractors, never from
//! identifiers the client sends.

use std::net::SocketAddr;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::StatusCode;
use markiro_proto::{
    codes, credentials, DeviceKind, OfficeRole, OfficeUser, APP_VERSION_HEADER,
    OFFICE_SESSION_HEADER, PROTOCOL_HEADER,
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
        authenticate(parts, state, true).await
    }
}

/// A paired, non-revoked device that WRITES NOTHING when it is
/// authenticated: the same key, revocation and kind checks as
/// [`AuthDevice`], but `last_seen_at` is never touched, nor the version it
/// reports (plan ОБН-1). Only the code check
/// (`GET /v1/device/codes/{codeHash}`, answered by a station within 300 ms)
/// uses it, so that route never waits for a writer, even for the first
/// request after an idle minute. Every other device route takes
/// [`AuthDevice`].
#[derive(Debug, Clone)]
pub struct AskingDevice(pub AuthDevice);

impl FromRequestParts<AppState> for AskingDevice {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        authenticate(parts, state, false).await.map(Self)
    }
}

async fn authenticate(
    parts: &Parts,
    state: &AppState,
    touch: bool,
) -> Result<AuthDevice, ApiError> {
    let key = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|key| !key.is_empty())
        .ok_or_else(|| ApiError::unauthorized(credentials::DEVICE, "a device key is required"))?;
    let row: Option<DeviceAuthRow> = sqlx::query_as(
        "SELECT id, kind, last_seen_at, app_version, protocol, version_seen_at FROM devices \
         WHERE key_hash = ? AND revoked_at IS NULL",
    )
    .bind(key_hash(key))
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (id, kind, last_seen_at, app_version, protocol, version_seen_at) =
        row.ok_or_else(|| {
            ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
        })?;
    let kind: DeviceKind = kind.parse().map_err(ApiError::internal)?;
    // Record activity at most once a minute per device to keep writes rare.
    // Even an `UPDATE` that matches no row takes SQLite's write lock, so it
    // runs only when the stored time is due. The request that finds it due
    // (the first one after each full minute, a busy station's included) DOES
    // take the write lock and can wait behind a writer. Only the code check
    // is writer-free, because it does not touch (`touch` is false). The
    // `WHERE` stays as the guard against a request that touched the row
    // first.
    if touch {
        let now = state.now();
        // The version the app names on every request (plan ОБН-1): written
        // only when it, or the protocol, differs from what is stored, or
        // nothing was reported since pairing, so a working device takes the
        // write lock for it once per upgrade. No revision, no audit row: like
        // `last_seen_at`, this is no office change.
        if let Some((reported_version, reported_protocol)) = reported(parts) {
            let reported_protocol = i64::from(reported_protocol);
            if version_seen_at.is_none()
                || app_version != reported_version
                || protocol != reported_protocol
            {
                sqlx::query(
                    "UPDATE devices SET app_version = ?, protocol = ?, version_seen_at = ? \
                     WHERE id = ? AND (version_seen_at IS NULL OR app_version IS NOT ? \
                     OR protocol IS NOT ?)",
                )
                .bind(&reported_version)
                .bind(reported_protocol)
                .bind(format_timestamp(now))
                .bind(&id)
                .bind(&reported_version)
                .bind(reported_protocol)
                .execute(&state.pool)
                .await
                .map_err(ApiError::internal)?;
            }
        }
        let due = format_timestamp(now - time::Duration::minutes(1));
        if last_seen_at.is_none_or(|seen| seen <= due) {
            sqlx::query(
                "UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
            )
            .bind(format_timestamp(now))
            .bind(&id)
            .bind(due)
            .execute(&state.pool)
            .await
            .map_err(ApiError::internal)?;
        }
    }
    Ok(AuthDevice { id, kind })
}

/// `id, kind, last_seen_at, app_version, protocol, version_seen_at` of a
/// device found by its key.
type DeviceAuthRow = (String, String, Option<String>, String, i64, Option<String>);

/// The largest protocol read from the header outside `protocol_guard`.
const MAX_REPORTED_PROTOCOL: u32 = 1000;

/// The version and protocol a request reports (plan ОБН-1): the app's
/// header as plain text of 1-50 characters (the pairing's rule for
/// `appVersion`), with the protocol `protocol_guard` read, or, on a route
/// outside the guard, the protocol header's whole number 1-1000. `None`
/// when either is missing or malformed: nothing is recorded then.
pub fn reported(parts: &Parts) -> Option<(String, u32)> {
    let version = parts
        .headers
        .get(APP_VERSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            crate::validate::clean_text("appVersion", value, 50, "the app version").ok()
        })?
        .to_owned();
    let protocol = match parts.extensions.get::<crate::server::ClientProtocol>() {
        Some(protocol) => protocol.0,
        None => parts
            .headers
            .get(PROTOCOL_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|protocol| (1..=MAX_REPORTED_PROTOCOL).contains(protocol))?,
    };
    Some((version, protocol))
}

impl AuthDevice {
    /// The device is still paired and not revoked, read inside the write
    /// transaction, and its kind as stored: a revocation committed after the
    /// extractor read the key (the request waited for the write lock) must
    /// stop the write. A batch of facts calls it, whatever the device's kind.
    pub async fn require_live_in(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<DeviceKind, ApiError> {
        let kind: Option<String> =
            sqlx::query_scalar("SELECT kind FROM devices WHERE id = ? AND revoked_at IS NULL")
                .bind(&self.id)
                .fetch_optional(conn)
                .await
                .map_err(ApiError::internal)?;
        kind.ok_or_else(|| {
            ApiError::unauthorized(credentials::DEVICE, "unknown or revoked device key")
        })?
        .parse()
        .map_err(ApiError::internal)
    }

    /// The device is still a paired, unrevoked station, read inside the
    /// write transaction ([`Self::require_live_in`]): a revoked station
    /// neither creates a shift, nor enters one, nor gets serials. `forbidden`
    /// is the text for a device of another kind.
    pub async fn require_station_in(
        &self,
        conn: &mut SqliteConnection,
        forbidden: &str,
    ) -> Result<(), ApiError> {
        if self.require_live_in(conn).await? == DeviceKind::Station {
            Ok(())
        } else {
            Err(ApiError::forbidden(forbidden))
        }
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
        role.parse().map_err(ApiError::internal)
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

    /// The early check of a catalog write: products, label templates and
    /// their defaults (spec §4.8, `editCatalog`).
    pub fn require_catalog(&self) -> Result<(), ApiError> {
        if edits_catalog(self.user.role) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }

    /// Re-check catalog rights inside the caller's write transaction, as
    /// [`Self::require_admin_in`] does for administrator writes: a session that
    /// ended, a user turned off or a role taken away since the extractor
    /// read them stops the write.
    pub async fn require_catalog_in(&self, conn: &mut SqliteConnection) -> Result<(), ApiError> {
        if edits_catalog(self.live_role_in(conn).await?) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a catalog role is required"))
        }
    }

    /// The early check of a shift write: planning, editing, deleting and
    /// closing a shift (stage 2a spec §4.9, `planShifts`).
    pub fn require_shift_planning(&self) -> Result<(), ApiError> {
        if plans_shifts(self.user.role) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a shift planning role is required"))
        }
    }

    /// Re-check shift planning rights inside the caller's write
    /// transaction, as [`Self::require_catalog_in`] does for the catalog.
    pub async fn require_shift_planning_in(
        &self,
        conn: &mut SqliteConnection,
    ) -> Result<(), ApiError> {
        if plans_shifts(self.live_role_in(conn).await?) {
            Ok(())
        } else {
            Err(ApiError::forbidden("a shift planning role is required"))
        }
    }
}

/// Whether a role plans, edits, deletes and closes shifts (stage 2a spec
/// §4.9: administrators and technologists). No wildcard arm: a new role does
/// not compile until it is placed here.
pub fn plans_shifts(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
    }
}

/// Whether a role changes the catalog, label templates and their defaults
/// (spec §4.8: administrators and technologists). No wildcard arm: a new
/// role does not compile until it is placed here.
pub fn edits_catalog(role: OfficeRole) -> bool {
    match role {
        OfficeRole::Admin | OfficeRole::Technologist => true,
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
        let role: OfficeRole = role.parse().map_err(ApiError::internal)?;
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

#[cfg(test)]
mod tests {
    use axum::http::Request;

    use super::*;
    use crate::server::ClientProtocol;

    fn parts(version: Option<&str>, guard: Option<u32>, header: Option<&str>) -> Parts {
        let mut builder = Request::builder().uri("/v1/device");
        if let Some(version) = version {
            builder = builder.header(markiro_proto::APP_VERSION_HEADER, version);
        }
        if let Some(protocol) = header {
            builder = builder.header(markiro_proto::PROTOCOL_HEADER, protocol);
        }
        let (mut parts, ()) = builder.body(()).unwrap().into_parts();
        if let Some(protocol) = guard {
            parts.extensions.insert(ClientProtocol(protocol));
        }
        parts
    }

    /// A version is recorded only as plain text of 1-50 characters, with a
    /// protocol: the guard's, or outside the guard the header's (plan ОБН-3's
    /// routes), a whole number 1-1000.
    #[test]
    fn a_reported_version_is_plain_text_with_a_protocol() {
        assert_eq!(
            reported(&parts(Some(" 0.2.0 "), Some(3), None)),
            Some(("0.2.0".to_owned(), 3))
        );
        assert_eq!(
            reported(&parts(Some("0.2.0"), None, Some("1"))),
            Some(("0.2.0".to_owned(), 1))
        );
        // The guard's protocol wins over the header's.
        assert_eq!(
            reported(&parts(Some("0.2.0"), Some(3), Some("2"))),
            Some(("0.2.0".to_owned(), 3))
        );
        for (version, header) in [
            (Some("0.2.0"), Some("0")),
            (Some("0.2.0"), Some("1001")),
            (Some("0.2.0"), Some("3x")),
            (Some("0.2.0"), None),
            (None, Some("3")),
            (Some(""), Some("3")),
            (Some("   "), Some("3")),
        ] {
            assert_eq!(
                reported(&parts(version, None, header)),
                None,
                "{version:?} {header:?}"
            );
        }
        let long = "9".repeat(51);
        assert_eq!(reported(&parts(Some(&long), Some(3), None)), None);
    }
}
