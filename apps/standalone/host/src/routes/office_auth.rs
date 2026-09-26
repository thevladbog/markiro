//! Office sign-in: `POST /v1/office/login`, `POST /v1/office/logout`,
//! `GET /v1/office/me`.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{credentials, OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{end_session, open_session, AuthDevice, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::secrets::{dummy_password_phc, verify_password};
use crate::server::AppState;
use crate::validate;

type UserRow = (String, String, String, String, String, i64);

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<OfficeLoginRequest>,
) -> Result<Json<OfficeSession>, ApiError> {
    state.login_limiter.check(peer.ip())?;
    let now = state.now();
    let at = format_timestamp(now);

    let login_input = request.login.trim().to_owned();
    if validate::office_login("login", &login_input).is_err() {
        // A malformed login (oversized, non-ASCII, ...) never reaches the
        // database or a password hash, and never lands in the audit log
        // verbatim: it could be a password typed into the wrong field.
        let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: Actor::Device(&device.id),
                action: "office.login",
                target_type: Some("office_user"),
                target_id: None,
                outcome: Outcome::Denied,
                details: json!({ "reason": "invalid_login" }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        tx.commit().await.map_err(ApiError::internal)?;
        return Err(ApiError::unauthorized(
            credentials::PASSWORD,
            "wrong login or password",
        ));
    }

    let row: Option<UserRow> = sqlx::query_as(
        "SELECT id, login, name, role, password_phc, active FROM office_users WHERE login = ?",
    )
    .bind(&login_input)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    // Always run PBKDF2 so an unknown login costs the same as a wrong password;
    // the dummy verifier is built on first use, also off the async threads.
    let stored_phc = row.as_ref().map(|row| row.4.clone());
    let verify_phc = stored_phc.clone();
    let password = request.password.clone();
    let password_ok = tokio::task::spawn_blocking(move || {
        let phc = verify_phc
            .as_deref()
            .unwrap_or_else(|| dummy_password_phc());
        verify_password(phc, &password)
    })
    .await
    .map_err(ApiError::internal)?;

    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // Re-read the user inside the write transaction: a password change or
    // deactivation committed while PBKDF2 was running (outside any
    // transaction) must not let this request open a session on a value that
    // no longer holds.
    let accepted = match (row.as_ref(), stored_phc.as_ref()) {
        (Some((id, ..)), Some(verified_phc)) if password_ok => {
            let current: Option<(String, i64)> =
                sqlx::query_as("SELECT password_phc, active FROM office_users WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(ApiError::internal)?;
            matches!(
                current,
                Some((current_phc, active)) if &current_phc == verified_phc && active == 1
            )
        }
        _ => false,
    };
    match row {
        Some((id, login, name, role, _, _)) if accepted => {
            let role: OfficeRole = serde_json::from_value(serde_json::Value::String(role))
                .map_err(ApiError::internal)?;
            let (token, expires) = open_session(&mut tx, &id, &device.id, now)
                .await
                .map_err(ApiError::internal)?;
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: "office.login",
                    target_type: Some("office_user"),
                    target_id: Some(&id),
                    outcome: Outcome::Ok,
                    details: json!({ "login": login }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Ok(Json(OfficeSession {
                token,
                user: OfficeUser {
                    id,
                    login,
                    name,
                    role,
                },
                expires_at: format_timestamp(expires),
            }))
        }
        other => {
            let target = other.as_ref().map(|row| row.0.as_str());
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: "office.login",
                    target_type: Some("office_user"),
                    target_id: target,
                    outcome: Outcome::Denied,
                    details: json!({ "login": login_input }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            Err(ApiError::unauthorized(
                credentials::PASSWORD,
                "wrong login or password",
            ))
        }
    }
}

pub async fn logout(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<StatusCode, ApiError> {
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    end_session(&mut tx, &context.session_id)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "office.logout",
            target_type: Some("office_user"),
            target_id: Some(&context.user.id),
            outcome: Outcome::Ok,
            details: json!({}),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(context: OfficeContext) -> Json<OfficeUser> {
    Json(context.user)
}
