//! The organization's print logo (plan А4): `GET /v1/office/org/logo` (every
//! role), `PUT` and `DELETE` (administrators). The office sends the logo
//! already monochrome; the host checks its bits (`validate::mono_logo`) and
//! keeps one row or none. A change takes no revision: the logo is not in the
//! station feed, a shift freezes it in its snapshot when a station opens it.
//! The logo's bits are never written to the audit trail or the log.
//!
//! The host never parses a picture: a PNG, a JPEG or an SVG is decoded in the
//! office's webview and arrives as bits, so there is no image format, no
//! script and no external reference for the host to accept. The request body
//! is bounded by the router's default JSON limit (2 MiB), far above the
//! largest logo (87 384 characters of base64, `validate::MAX_LOGO_BASE64`
//! allows 90 000), so no route-specific limit is needed.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgLogo, OrgLogoPut, OrgLogoState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

/// The logo, or `None`; the shift snapshot (plan А4) reads it too.
pub async fn read_logo(conn: &mut SqliteConnection) -> Result<Option<OrgLogo>, ApiError> {
    let row: Option<(u32, u32, String, String)> = sqlx::query_as(
        "SELECT width, height, pixels_base64, updated_at FROM org_logo WHERE id = 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(
        row.map(|(width, height, pixels_base64, updated_at)| OrgLogo {
            width,
            height,
            pixels_base64,
            updated_at,
        }),
    )
}

pub async fn get_logo(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OrgLogoState>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState {
        logo: read_logo(&mut conn).await?,
    }))
}

pub async fn put_logo(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(put): ApiJson<OrgLogoPut>,
) -> Result<Json<OrgLogoState>, ApiError> {
    context.require_admin()?;
    validate::mono_logo("", put.width, put.height, &put.pixels_base64)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    sqlx::query(
        "INSERT INTO org_logo (id, width, height, pixels_base64, updated_at) \
         VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET width = excluded.width, \
         height = excluded.height, pixels_base64 = excluded.pixels_base64, \
         updated_at = excluded.updated_at",
    )
    .bind(put.width)
    .bind(put.height)
    .bind(&put.pixels_base64)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::ORG_LOGO_SET,
            target_type: Some("org_profile"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({ "width": put.width, "height": put.height }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState {
        logo: Some(OrgLogo {
            width: put.width,
            height: put.height,
            pixels_base64: put.pixels_base64,
            updated_at: at,
        }),
    }))
}

/// Clears the logo; clearing none writes nothing and answers the same.
pub async fn delete_logo(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<OrgLogoState>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let removed = sqlx::query("DELETE FROM org_logo WHERE id = 1")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    if removed > 0 {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::ORG_LOGO_CLEAR,
                target_type: Some("org_profile"),
                target_id: Some("1"),
                outcome: Outcome::Ok,
                details: json!({}),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(OrgLogoState { logo: None }))
}
