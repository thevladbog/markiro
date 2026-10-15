//! The gate of new shifts (spec §3.3): the one move a license that ran out
//! closes is a planned shift's first entry, and a station's new shift.
//! Everything that runs goes on: the owner's entry again, a create retried
//! with its `requestId`, facts, numbers, closes, exports, backups, the
//! office and every paired device (soft enforcement). And the tables of
//! every host route: closed by the license's state ([`GATED`]) or never
//! ([`NEVER`]); apart from them, the routes that ask a seat or a feature for
//! an addition beyond the file in any state ([`LIMITED`]).

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

/// Every route the license's state closes (spec §3.3: `restricted`,
/// `trial_expired`, `inn_mismatch`), with what it closes. A new route goes
/// into this table or into [`NEVER`]: `tests/license_routes.rs` compares both
/// with the router.
pub const GATED: &[(&str, &str, &str)] = &[
    (
        "POST",
        "/v1/device/shifts",
        "new shifts: a station's new shift",
    ),
    (
        "POST",
        "/v1/device/shifts/{id}/enter",
        "new shifts: the first entry only",
    ),
];

/// Every route the license's state never closes: what runs, pairing, the
/// client's data, its copies, the office and the license itself (spec
/// §3.3). Some of them refuse an addition beyond the file ([`LIMITED`]).
pub const NEVER: &[(&str, &str)] = &[
    ("GET", "/v1/hello"),
    ("POST", "/v1/local-pair"),
    ("POST", "/v1/pairing/claim"),
    ("GET", "/v1/device"),
    ("PUT", "/v1/device/line"),
    ("GET", "/v1/device/shifts"),
    ("GET", "/v1/device/products/{id}/photo"),
    ("POST", "/v1/device/sscc/blocks"),
    ("POST", "/v1/device/sscc/blocks/known"),
    ("POST", "/v1/device/facts"),
    ("GET", "/v1/device/codes/{code_hash}"),
    ("GET", "/v1/device/pallet-sheets"),
    ("POST", "/v1/device/warehouse/lookup"),
    ("POST", "/v1/device/warehouse/reprints"),
    ("GET", "/v1/changes"),
    ("GET", "/v1/changes/stream"),
    ("GET", "/v1/office/devices"),
    ("GET", "/v1/office/usage-stats"),
    ("PUT", "/v1/office/devices/{id}"),
    ("POST", "/v1/office/devices/{id}/revoke"),
    ("POST", "/v1/office/login"),
    ("POST", "/v1/office/logout"),
    ("GET", "/v1/office/me"),
    ("PUT", "/v1/office/me/password"),
    ("POST", "/v1/bootstrap"),
    ("GET", "/v1/office/org"),
    ("PUT", "/v1/office/org"),
    ("GET", "/v1/office/org/logo"),
    ("PUT", "/v1/office/org/logo"),
    ("DELETE", "/v1/office/org/logo"),
    ("GET", "/v1/office/sscc"),
    ("PUT", "/v1/office/sscc/counters/{prefix}/{extension}"),
    ("PUT", "/v1/office/sscc/block-sizes"),
    ("GET", "/v1/office/counterparties"),
    ("POST", "/v1/office/counterparties"),
    ("PUT", "/v1/office/counterparties/{id}"),
    ("GET", "/v1/office/lines"),
    ("POST", "/v1/office/lines"),
    ("PUT", "/v1/office/lines/{id}"),
    ("GET", "/v1/device/displacements"),
    ("POST", "/v1/device/conflicts/status"),
    ("GET", "/v1/office/conflicts"),
    ("POST", "/v1/office/conflicts/{id}/review"),
    ("GET", "/v1/office/shifts/{id}/exceptions"),
    ("GET", "/v1/office/shifts/{id}/rejections"),
    ("GET", "/v1/office/shifts/{id}/exports"),
    ("GET", "/v1/office/employees"),
    ("POST", "/v1/office/employees"),
    ("PUT", "/v1/office/employees/{id}"),
    ("GET", "/v1/office/operators"),
    ("POST", "/v1/office/operators"),
    ("PUT", "/v1/office/operators/{id}"),
    ("POST", "/v1/office/operators/{id}/badges"),
    ("DELETE", "/v1/office/operators/{id}/badges/{badge_id}"),
    ("GET", "/v1/office/badge-salt"),
    ("GET", "/v1/office/product-groups"),
    ("GET", "/v1/office/products"),
    ("POST", "/v1/office/products"),
    ("PUT", "/v1/office/products/{id}"),
    ("GET", "/v1/office/products/{id}/photo"),
    ("PUT", "/v1/office/products/{id}/photo"),
    ("DELETE", "/v1/office/products/{id}/photo"),
    ("GET", "/v1/office/templates"),
    ("POST", "/v1/office/templates"),
    ("GET", "/v1/office/templates/{id}"),
    ("PUT", "/v1/office/templates/{id}"),
    ("DELETE", "/v1/office/templates/{id}"),
    ("GET", "/v1/office/template-defaults"),
    ("PUT", "/v1/office/template-defaults"),
    ("GET", "/v1/office/pallet-sheets"),
    ("POST", "/v1/office/pallet-sheets"),
    ("PUT", "/v1/office/pallet-sheets/{id}"),
    ("DELETE", "/v1/office/pallet-sheets/{id}"),
    ("PUT", "/v1/office/pallet-sheet-default"),
    ("GET", "/v1/office/shifts"),
    ("POST", "/v1/office/shifts"),
    ("GET", "/v1/office/shifts/{id}"),
    ("PUT", "/v1/office/shifts/{id}"),
    ("DELETE", "/v1/office/shifts/{id}"),
    ("POST", "/v1/office/shifts/{id}/close"),
    ("GET", "/v1/office/shifts/{id}/boxes"),
    ("GET", "/v1/office/shifts/{id}/pallets"),
    ("GET", "/v1/office/shifts/{id}/export-source"),
    ("POST", "/v1/office/shifts/{id}/exports"),
    ("GET", "/v1/office/export-files"),
    ("POST", "/v1/office/export-files"),
    ("GET", "/v1/office/export-files/settings"),
    ("PUT", "/v1/office/export-files/settings"),
    ("GET", "/v1/office/export-files/{id}/chunks/{seq}"),
    ("PUT", "/v1/office/export-files/{id}/chunks/{seq}"),
    ("POST", "/v1/office/export-files/{id}/complete"),
    ("POST", "/v1/office/export-files/{id}/download"),
    ("GET", "/v1/office/shifts/{id}/pallet-report-data"),
    ("GET", "/v1/office/boxes/{id}/report-data"),
    ("GET", "/v1/office/disaggregation"),
    ("POST", "/v1/office/disaggregation"),
    ("GET", "/v1/office/disaggregation/{id}"),
    ("PUT", "/v1/office/disaggregation/{id}"),
    ("POST", "/v1/office/disaggregation/{id}/lines"),
    ("DELETE", "/v1/office/disaggregation/{id}/lines/{line_id}"),
    ("POST", "/v1/office/disaggregation/{id}/apply"),
    ("POST", "/v1/office/disaggregation/{id}/cancel"),
    ("GET", "/v1/office/disaggregation/{id}/report-data"),
    ("POST", "/v1/office/disaggregation/{id}/exports"),
    ("GET", "/v1/office/disaggregation-reasons"),
    ("POST", "/v1/office/disaggregation-reasons"),
    ("PUT", "/v1/office/disaggregation-reasons/{id}"),
    ("GET", "/v1/office/boxes/{id}"),
    ("GET", "/v1/office/pallets"),
    ("GET", "/v1/office/pallets/{id}"),
    ("GET", "/v1/office/codes"),
    ("GET", "/v1/office/codes/{code_hash}"),
    ("GET", "/v1/office/backups"),
    ("POST", "/v1/office/backups"),
    ("PUT", "/v1/office/backups/settings"),
    ("POST", "/v1/office/backups/resume"),
    ("POST", "/v1/office/updates/started"),
    ("POST", "/v1/office/import"),
    ("GET", "/v1/office/users"),
    ("POST", "/v1/office/users"),
    ("PUT", "/v1/office/users/{id}"),
    ("PUT", "/v1/office/users/{id}/password"),
    ("POST", "/v1/office/pairing-codes"),
    ("GET", "/v1/office/license"),
    ("PUT", "/v1/office/license"),
    ("POST", "/v1/office/license/preview"),
    ("GET", "/v1/office/license/activation-request"),
    ("POST", "/v1/office/license/emergency"),
];

/// The routes that refuse an addition beyond the file in any state (spec
/// §4.7, `license/seats.rs`), with the seat or the feature they ask. They
/// never disconnect what runs, and each is in [`GATED`] or [`NEVER`] too.
pub const LIMITED: &[(&str, &str, &str)] = &[
    ("POST", "/v1/local-pair", "a seat of stations"),
    (
        "POST",
        "/v1/pairing/claim",
        "a seat of stations (a station or a handheld); handheld",
    ),
    ("POST", "/v1/device/shifts", "pallets"),
    ("POST", "/v1/office/users", "a seat of office users"),
    (
        "PUT",
        "/v1/office/users/{id}",
        "a seat of office users: turned on again",
    ),
    ("POST", "/v1/office/lines", "a seat of lines"),
    (
        "PUT",
        "/v1/office/lines/{id}",
        "a seat of lines: back from the archive",
    ),
    (
        "POST",
        "/v1/office/import",
        "a seat of lines: the lines it adds",
    ),
    ("POST", "/v1/office/shifts", "pallets"),
    (
        "PUT",
        "/v1/office/shifts/{id}",
        "pallets: turned on in a plan",
    ),
    ("POST", "/v1/office/templates", "the label editor"),
    (
        "PUT",
        "/v1/office/templates/{id}",
        "the label editor: a name or a layout",
    ),
];
