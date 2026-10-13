//! `POST /v1/office/updates/started` (plan ОБН-2, spec §8.2, §10.4): the
//! office reports that it starts an installer on its PC, and the host writes
//! one `app.update.start` row. Administrators only. Like `shift.export`, the
//! row records what the office session reported, not what happened: the host
//! never sees the installer, Windows may still refuse the administrator
//! rights, and the device's next connection shows the version it really runs
//! (plan ОБН-1). The device is the session's own, never one the body names;
//! nothing else changes and no revision is taken.

use axum::extract::State;
use axum::http::StatusCode;
use markiro_proto::update::{AppVersion, UpdateStarted};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

fn version(field: &str, text: &str) -> Result<AppVersion, ApiError> {
    text.parse()
        .map_err(|_| ApiError::validation(field, "a version is MAJOR.MINOR.PATCH"))
}

/// `204`; `validation_failed` on `from`, `to` (not a version, or older than
/// `from`) or `installerSha256` (not 64 lower-case hex digits).
pub async fn record_started(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(record): ApiJson<UpdateStarted>,
) -> Result<StatusCode, ApiError> {
    context.require_admin()?;
    let from = version("from", &record.from)?;
    let to = version("to", &record.to)?;
    if to < from {
        return Err(ApiError::validation(
            "to",
            "an update never goes to an older version",
        ));
    }
    let hex = record.installer_sha256.len() == 64
        && record
            .installer_sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !hex {
        return Err(ApiError::validation(
            "installerSha256",
            "64 lower-case hex digits",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::APP_UPDATE_START,
            target_type: Some("device"),
            target_id: Some(&context.device_id),
            outcome: Outcome::Ok,
            details: json!({
                "from": record.from,
                "to": record.to,
                "installerSha256": record.installer_sha256,
                "source": record.source,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
