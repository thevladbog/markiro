//! Organization profile: `GET /v1/office/org` (every role) and
//! `PUT /v1/office/org` (administrators, with `expectedRev`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgProfile, OrgProfileInput, OrgProfileUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

type OrgRow = (String, Option<String>, String, String, String, i64);

async fn read_org(conn: &mut SqliteConnection) -> Result<OrgProfile, ApiError> {
    let row: Option<OrgRow> = sqlx::query_as(
        "SELECT name, inn, gln, gs1_prefixes, time_zone, rev FROM org_profile WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let (name, inn, gln, gs1_prefixes, time_zone, rev) =
        row.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    Ok(OrgProfile {
        name,
        inn,
        gln,
        gs1_prefixes: serde_json::from_str(&gs1_prefixes).map_err(ApiError::internal)?,
        time_zone,
        rev,
    })
}

pub async fn get_org(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OrgProfile>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read_org(&mut conn).await.map(Json)
}

pub async fn put_org(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<OrgProfileUpdate>,
) -> Result<Json<OrgProfile>, ApiError> {
    context.require_admin()?;
    let org = validate::org(
        "",
        &OrgProfileInput {
            name: update.name,
            inn: update.inn,
            gln: update.gln,
            gs1_prefixes: update.gs1_prefixes,
            time_zone: update.time_zone,
        },
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let current = read_org(&mut tx).await?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let mut changed = Vec::new();
    if current.name != org.name {
        changed.push("name");
    }
    if current.inn != org.inn {
        changed.push("inn");
    }
    if current.gln != org.gln {
        changed.push("gln");
    }
    if current.gs1_prefixes != org.gs1_prefixes {
        changed.push("gs1Prefixes");
    }
    if current.time_zone != org.time_zone {
        changed.push("timeZone");
    }
    if changed.is_empty() {
        // Nothing actually changed: report the profile as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE org_profile SET name = ?, inn = ?, gln = ?, gs1_prefixes = ?, time_zone = ?, rev = ? WHERE id = 1",
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
    // A new GLN means a new issuer prefix: give it counters at the first
    // serials. Existing counters, including the old prefix's, stay as they are.
    let prefix = validate::issuer_prefix(&org.gln).to_owned();
    for extension in [0_u8, 1] {
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?) \
             ON CONFLICT (issuer_prefix, extension) DO NOTHING",
        )
        .bind(&prefix)
        .bind(i64::from(extension))
        .bind(i64::try_from(validate::first_serial(extension)).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "org.update",
            target_type: Some("org_profile"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "changed": changed }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_org(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}
