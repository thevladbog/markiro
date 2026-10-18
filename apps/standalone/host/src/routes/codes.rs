//! `GET /v1/device/codes/{codeHash}` (stage 2a spec §4.6): whether an
//! accepted scan owns a code, and which. Any device may ask. It reads the
//! registry outside any write transaction, and authenticates through
//! [`AskingDevice`], which does not even touch `last_seen_at`: it never
//! waits for a writer, whatever the device's last-seen time is. A station
//! asks within 300 ms. (The other device routes touch `last_seen_at` once a
//! minute and may wait.)

use axum::extract::State;
use axum::Json;
use markiro_proto::CodeCheck;

use crate::auth::AskingDevice;
use crate::error::{ApiError, ApiPath};
use crate::facts::{registry, rules};
use crate::server::AppState;

pub async fn check_code(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiPath(code_hash): ApiPath<String>,
) -> Result<Json<CodeCheck>, ApiError> {
    if !rules::is_code_hash(&code_hash) {
        return Err(ApiError::validation(
            "codeHash",
            "64 lower-case hex digits are required",
        ));
    }
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    Ok(Json(match registry::owner(&mut conn, &code_hash).await? {
        Some(owner) => CodeCheck::Taken {
            owner: owner.to_wire(&device.id),
        },
        None => CodeCheck::Free,
    }))
}
