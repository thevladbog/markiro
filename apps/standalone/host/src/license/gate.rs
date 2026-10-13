//! The gate of new shifts (spec §3.3): the one move a license that ran out
//! closes is a planned shift's first entry, and a station's new shift.
//! Everything that runs goes on: the owner's entry again, a create retried
//! with its `requestId`, facts, numbers, closes, exports, backups, the
//! office and every paired device (soft enforcement).

use markiro_proto::license::constraints;
use serde_json::json;
use sqlx::SqliteConnection;

use super::ms_text;
use crate::error::ApiError;
use crate::server::AppState;

/// New shifts open (the state, or an emergency extension that runs); else
/// `conflict` on `license_restricted` with the state and since when. Called
/// on the writer transaction of the shift's opening or creation, so the
/// state it reads is the one the write commits under (no window between the
/// check and the write). A refusal writes no row, like every refused write
/// of a station.
pub async fn require_new_shifts(
    app: &AppState,
    conn: &mut SqliteConnection,
) -> Result<(), ApiError> {
    let snapshot = app
        .license
        .snapshot(app, conn)
        .await
        .map_err(ApiError::internal)?;
    let evaluation = &snapshot.evaluation;
    if evaluation.opens_new_shifts {
        return Ok(());
    }
    Err(ApiError::conflict(
        constraints::LICENSE_RESTRICTED,
        "new shifts do not open under the site's license",
    )
    .with_details(json!({
        "constraint": constraints::LICENSE_RESTRICTED,
        "state": evaluation.phase.as_str(),
        "since": ms_text(evaluation.since),
    })))
}
