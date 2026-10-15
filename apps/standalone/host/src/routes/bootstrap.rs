//! The first-run wizard: `POST /v1/bootstrap` (loopback, paired device, host
//! not initialized). One transaction creates the administrator, the badge
//! salt, the stock label templates the app built with `@markiro/domain`, the
//! organization with its defaults among them, the SSCC counters and the
//! first lines, and signs the admin in; a refusal creates nothing. The
//! templates are optional: a wizard from before plan 1e3 sends none.

use std::collections::BTreeMap;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    codes, BootstrapRequest, BootstrapResponse, OfficeRole, OfficeSession, OfficeUser,
    TemplatePurpose,
};
use serde_json::json;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{open_session, require_loopback, AuthDevice};
use crate::clock::format_timestamp;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::secrets::hash_password_blocking;
use crate::server::AppState;
use crate::validate;

/// The most stock templates a wizard sends: the domain builds 20 today, and
/// the bound leaves room to grow without letting a request ask for any
/// amount.
pub const MAX_STOCK_TEMPLATES: usize = 32;

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
    // A license is issued to the organization's INN (plan ЛЦ-2, spec §4.9,
    // ЛО24): the wizard takes only one whose check digit holds. The office's
    // profile keeps the plain 10-or-12-digit rule (ЛО27).
    let trial_inn = org
        .inn
        .as_deref()
        .and_then(crate::inn::normalize)
        .ok_or_else(|| {
            ApiError::validation("org.inn", "an INN whose check digit holds is required")
        })?;
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
    if request.templates.len() > MAX_STOCK_TEMPLATES {
        return Err(ApiError::validation(
            "templates",
            format!("at most {MAX_STOCK_TEMPLATES} stock templates"),
        ));
    }
    let mut templates: Vec<(String, TemplatePurpose, String)> =
        Vec::with_capacity(request.templates.len());
    // The index of the organization's default of each purpose.
    let mut defaults: BTreeMap<TemplatePurpose, usize> = BTreeMap::new();
    for (index, template) in request.templates.iter().enumerate() {
        let name = validate::template_name(&format!("templates.{index}.name"), &template.name)?;
        let spec = validate::template_spec(&format!("templates.{index}.spec"), &template.spec)?;
        if template.org_default && defaults.insert(template.purpose, index).is_some() {
            return Err(ApiError::validation(
                &format!("templates.{index}.orgDefault"),
                "one organization default per purpose",
            ));
        }
        templates.push((name, template.purpose, spec));
    }

    // Hash before taking the write lock: PBKDF2 takes a noticeable fraction
    // of a second.
    let password_phc = hash_password_blocking(request.admin.password.clone())
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
    if request.address_confirmed == Some(true) {
        sqlx::query("UPDATE site SET address_confirmed_at = ? WHERE id = 1")
            .bind(&at)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    // The built-in trial starts with the wizard (plan ЛЦ-2, spec §3.4),
    // once, with the INN the wizard took (it goes into the activation
    // request). Migration 0030 seeds the clock's one row: without it the
    // host would come up with no trial at all, so the wizard fails instead.
    let started_at = crate::license::to_ms(now);
    let trial = sqlx::query(
        "UPDATE license_clock SET trial_started_at = coalesce(trial_started_at, ?), \
         trial_inn = coalesce(trial_inn, ?) WHERE id = 1",
    )
    .bind(started_at)
    .bind(&trial_inn)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if trial.rows_affected() != 1 {
        return Err(ApiError::internal("the license clock row is missing"));
    }

    // The templates first: the organization's defaults refer to them.
    let mut template_ids: Vec<String> = Vec::with_capacity(templates.len());
    for (name, purpose, spec) in &templates {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, ?, 1, NULL, ?, 1, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(purpose.as_str())
        .bind(spec)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        template_ids.push(id);
    }
    let default_of = |purpose: TemplatePurpose| {
        defaults
            .get(&purpose)
            .and_then(|&index| template_ids.get(index).cloned())
    };
    sqlx::query(
        "INSERT INTO org_profile (id, name, inn, gln, gs1_prefixes, time_zone, \
         default_box_template_id, default_pallet_template_id, default_duplicate_template_id, rev) \
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&org.name)
    .bind(&org.inn)
    .bind(&org.gln)
    .bind(serde_json::to_string(&org.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(&org.time_zone)
    .bind(default_of(TemplatePurpose::Box))
    .bind(default_of(TemplatePurpose::Pallet))
    .bind(default_of(TemplatePurpose::ProductDuplicate))
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
    let mut details = json!({
        "adminLogin": login,
        "orgName": org.name,
        "issuerPrefix": prefix,
        "lineCount": lines.len(),
        "boxNextSerial": request.sscc.box_next_serial,
        "palletNextSerial": request.sscc.pallet_next_serial,
        "templateCount": templates.len(),
    });
    if request.address_confirmed == Some(true) {
        details["addressConfirmed"] = json!(true);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::HOST_BOOTSTRAP,
            target_type: Some("office_user"),
            target_id: Some(&admin_id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // The trial's mark outside the database (plan ЛЦ-2, spec §3.4), then
    // the license's first look: the state later looks compare with (Д7),
    // written without a row or a revision.
    state.license.after_bootstrap(&state).await;

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
