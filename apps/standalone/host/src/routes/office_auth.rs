//! Office sign-in: `POST /v1/office/login`, `POST /v1/office/logout`,
//! `GET /v1/office/me`, `PUT /v1/office/me/password`.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    credentials, OfficeLoginRequest, OfficeRole, OfficeSession, OfficeUser, PasswordChange,
};
use serde_json::json;

use crate::audit::{self, actions, reasons, Actor, Entry, Outcome};
use crate::auth::{end_session, open_session, AuthDevice, OfficeContext};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision};
use crate::error::{ApiError, ApiJson};
use crate::routes::office_users::replace_password;
use crate::secrets::{dummy_password_phc, hash_password, verify_password};
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
                action: actions::OFFICE_LOGIN,
                target_type: Some("office_user"),
                target_id: None,
                outcome: Outcome::Denied,
                details: json!({ "reason": reasons::INVALID_LOGIN }),
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
        verify_password(phc, password.expose())
    })
    .await
    .map_err(ApiError::internal)?;

    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    // Re-read the user inside the write transaction: a password change or
    // deactivation committed while PBKDF2 was running (outside any
    // transaction) must not let this request open a session on a value that
    // no longer holds.
    let current: Option<(String, i64)> = match row.as_ref() {
        Some((id, ..)) if password_ok => {
            sqlx::query_as("SELECT password_phc, active FROM office_users WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?
        }
        _ => None,
    };
    // Why the sign-in is refused, if it is. The typed login is never recorded:
    // it could be a password typed into the wrong field.
    let refusal = match (row.as_ref(), stored_phc.as_ref(), current.as_ref()) {
        (None, ..) => Some(reasons::UNKNOWN_LOGIN),
        (Some(_), ..) if !password_ok => Some(reasons::WRONG_PASSWORD),
        (Some(_), _, Some((_, active))) if *active == 0 => Some(reasons::INACTIVE),
        (Some(_), Some(verified_phc), Some((current_phc, _))) if current_phc == verified_phc => {
            None
        }
        (Some(_), ..) => Some(reasons::CHANGED),
    };
    match (row, refusal) {
        (Some((id, login, name, role, _, _)), None) => {
            let role: OfficeRole = role.parse().map_err(ApiError::internal)?;
            let (token, expires) = open_session(&mut tx, &id, &device.id, now)
                .await
                .map_err(ApiError::internal)?;
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: actions::OFFICE_LOGIN,
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
                token: token.into(),
                user: OfficeUser {
                    id,
                    login,
                    name,
                    role,
                },
                expires_at: format_timestamp(expires),
            }))
        }
        (row, refusal) => {
            // `(None, None)` cannot happen: no row always refuses.
            let reason = refusal.unwrap_or(reasons::UNKNOWN_LOGIN);
            let target = row.as_ref().map(|row| row.0.as_str());
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: actions::OFFICE_LOGIN,
                    target_type: Some("office_user"),
                    target_id: target,
                    outcome: Outcome::Denied,
                    details: json!({ "reason": reason }),
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
            action: actions::OFFICE_LOGOUT,
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

/// `PUT /v1/office/me/password`: any signed-in office user changes their own
/// password with the current one. Their other sessions end; this one stays.
pub async fn change_password(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiJson(body): ApiJson<PasswordChange>,
) -> Result<StatusCode, ApiError> {
    // A stolen session must not be a way to guess the current password.
    state.login_limiter.check(peer.ip())?;
    validate::password("newPassword", body.new_password.expose())?;
    let stored: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&context.user.id)
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    let PasswordChange {
        current_password,
        new_password,
    } = body;
    let verified = stored.clone();
    // PBKDF2 before the write lock, off the async threads; the new hash only
    // when the current password is right.
    let new_phc = tokio::task::spawn_blocking(move || {
        verify_password(&verified, current_password.expose())
            .then(|| hash_password(new_password.expose()))
    })
    .await
    .map_err(ApiError::internal)?;

    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    // The password may have changed while PBKDF2 ran; accept only the one verified.
    let current: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&context.user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let new_phc = match new_phc {
        Some(phc) if current == stored => phc,
        verified => {
            // A right current password against a hash an administrator
            // replaced meanwhile is "changed", not "wrong".
            let reason = if verified.is_some() {
                reasons::CHANGED
            } else {
                reasons::WRONG_CURRENT_PASSWORD
            };
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: context.actor(),
                    action: actions::OFFICE_USER_PASSWORD,
                    target_type: Some("office_user"),
                    target_id: Some(&context.user.id),
                    outcome: Outcome::Denied,
                    details: json!({ "reason": reason }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            return Err(ApiError::unauthorized(
                credentials::PASSWORD,
                "the current password is wrong",
            ));
        }
    };
    // Other sessions of this user end; the one making this request stays.
    let rev = replace_password(
        &mut tx,
        &at,
        context.actor(),
        &context.user.id,
        &context.session_id,
        &new_phc,
    )
    .await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
