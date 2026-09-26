//! The first-run wizard: `POST /v1/bootstrap` (loopback, paired device, host
//! not initialized). One transaction creates the administrator, the badge
//! salt, the organization, the SSCC counters and the first lines and signs
//! the admin in. Stock label templates join in plan 1e.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, BootstrapRequest, BootstrapResponse, OfficeRole, OfficeSession, OfficeUser,
};
use serde_json::json;

use crate::audit::{self, Actor, Entry, Outcome};
use crate::auth::{open_session, require_loopback, AuthDevice};
use crate::clock::format_timestamp;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::secrets::hash_password;
use crate::server::AppState;
use crate::validate;

pub async fn bootstrap(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    device: AuthDevice,
    ApiJson(request): ApiJson<BootstrapRequest>,
) -> Result<Json<BootstrapResponse>, ApiError> {
    require_loopback(peer)?;
    let login = request.admin.login.trim().to_owned();
    validate::office_login("admin.login", &login)?;
    let name = validate::person_name("admin.name", &request.admin.name)?;
    validate::password("admin.password", request.admin.password.expose())?;
    let org = validate::org("org", &request.org)?;
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
    validate::sscc_serial(
        "sscc.boxNextSerial",
        0,
        &prefix,
        request.sscc.box_next_serial,
    )?;
    validate::sscc_serial(
        "sscc.palletNextSerial",
        1,
        &prefix,
        request.sscc.pallet_next_serial,
    )?;
    if request.lines.is_empty() || request.lines.len() > 20 {
        return Err(ApiError::validation("lines", "1-20 lines are required"));
    }
    let mut lines: Vec<(String, String)> = Vec::with_capacity(request.lines.len());
    for (index, line) in request.lines.iter().enumerate() {
        let field = format!("lines.{index}");
        let (line_name, name_key) = validate::line_name(&field, line)?;
        if lines.iter().any(|(_, known)| *known == name_key) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push((line_name, name_key));
    }

    // Hash before taking the write lock: PBKDF2 takes a noticeable fraction
    // of a second.
    let password = request.admin.password.clone();
    let password_phc = tokio::task::spawn_blocking(move || hash_password(password.expose()))
        .await
        .map_err(ApiError::internal)?;

    let now = state.now();
    let at = format_timestamp(now);
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let initialized_at: Option<String> =
        sqlx::query_scalar("SELECT initialized_at FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if initialized_at.is_some() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::ALREADY_INITIALIZED,
            "the host is already initialized",
        ));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let admin_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, 'admin', ?, 1, ?, ?)",
    )
    .bind(&admin_id)
    .bind(&login)
    .bind(&name)
    .bind(&password_phc)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;

    let mut badge_salt = [0u8; 16];
    aws_lc_rs::rand::fill(&mut badge_salt)
        .map_err(|_| ApiError::internal("no system randomness"))?;
    sqlx::query("UPDATE site SET badge_salt = ?, initialized_at = ?, rev = ? WHERE id = 1")
        .bind(badge_salt.as_slice())
        .bind(&at)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

    sqlx::query(
        "INSERT INTO org_profile (id, name, inn, gln, gs1_prefixes, time_zone, rev) VALUES (1, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;

    for (extension, next_serial) in [
        (0_i64, request.sscc.box_next_serial),
        (1_i64, request.sscc.pallet_next_serial),
    ] {
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?)",
        )
        .bind(&prefix)
        .bind(extension)
        .bind(i64::try_from(next_serial).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }

    for (line_name, name_key) in &lines {
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(line_name)
            .bind(name_key)
            .bind(rev)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }

    let (token, expires) = open_session(&mut tx, &admin_id, &device.id, now)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: "host.bootstrap",
            target_type: Some("office_user"),
            target_id: Some(&admin_id),
            outcome: Outcome::Ok,
            details: json!({
                "adminLogin": login,
                "orgName": org.name,
                "issuerPrefix": prefix,
                "lineCount": lines.len(),
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;

    Ok(Json(BootstrapResponse {
        session: OfficeSession {
            token: token.into(),
            user: OfficeUser {
                id: admin_id,
                login,
                name,
                role: OfficeRole::Admin,
            },
            expires_at: format_timestamp(expires),
        },
    }))
}
