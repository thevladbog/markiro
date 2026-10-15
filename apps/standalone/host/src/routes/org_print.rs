//! `GET /v1/device/org/print`: what a device prints about the organization when no shift is open
//! (plan ТСД-Х, task Х5): the name, INN, SSCC issuer prefix and the print logo. A shift's snapshot
//! freezes the same for a running shift; a handheld's warehouse pallet has none. The logo is the
//! license's feature `customLogo`: without it `null`, and a device prints the bundled Markiro one.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OrgPrint, ShiftSnapshotLogo};

use crate::auth::AskingDevice;
use crate::error::ApiError;
use crate::server::AppState;

pub async fn org_print(
    State(state): State<AppState>,
    _device: AskingDevice,
) -> Result<Json<OrgPrint>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let profile: Option<(String, Option<String>, String)> =
        sqlx::query_as("SELECT name, inn, gln FROM org_profile WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let (name, inn, gln) =
        profile.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let own_logo = crate::license::gate::custom_branding(&state, &mut conn).await?;
    let logo = if own_logo {
        crate::routes::org_logo::read_logo(&mut conn)
            .await?
            .map(|logo| ShiftSnapshotLogo {
                width: logo.width,
                height: logo.height,
                pixels_base64: logo.pixels_base64,
            })
    } else {
        None
    };
    Ok(Json(OrgPrint {
        name,
        inn,
        issuer_prefix: crate::validate::issuer_prefix(&gln).to_owned(),
        logo,
    }))
}
