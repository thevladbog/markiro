//! Demo data in the office (spec `2026-10-21-standalone-wizard-demo-data-design`):
//! `GET /v1/office/demo-data` (every office role) says whether the wizard's demo set is there
//! and what its shifts made; `DELETE` (administrators) removes all of it in one transaction and
//! one revision. A demo shift still open refuses the delete (`conflict` on `demo_shift_active`
//! with the shifts' numbers). The demo product leaves the station feed as a tombstone, and a
//! station's late fact of a removed shift is acknowledged and dropped (`demo_removed_shifts`).
//! The audit log keeps its rows: «без следа» is about the work data, the numbering and the
//! reports, never the journal.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::{entities, DemoDataSummary, ShiftOrigin};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::demo::DEMO_PREFIX;
use crate::error::ApiError;
use crate::server::AppState;

/// The demo shifts, as a subquery.
const DEMO_SHIFTS: &str = "SELECT s.id FROM shifts s JOIN products p ON p.id = s.product_id \
     WHERE p.demo = 1";

/// What the demo data holds now, read through `conn`.
pub async fn summary(conn: &mut SqliteConnection) -> Result<DemoDataSummary, ApiError> {
    let product_id: Option<String> = sqlx::query_scalar("SELECT id FROM products WHERE demo = 1")
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let mut counts = Vec::with_capacity(4);
    for sql in [
        format!("SELECT COUNT(*) FROM shifts WHERE id IN ({DEMO_SHIFTS})"),
        format!("SELECT COUNT(*) FROM boxes WHERE shift_id IN ({DEMO_SHIFTS})"),
        format!("SELECT COUNT(*) FROM pallets WHERE shift_id IN ({DEMO_SHIFTS})"),
        format!("SELECT COUNT(*) FROM scans WHERE verdict = 'ok' AND shift_id IN ({DEMO_SHIFTS})"),
    ] {
        let value: i64 = sqlx::query_scalar(&sql)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        counts.push(u32::try_from(value).map_err(ApiError::internal)?);
    }
    let active: Vec<(String, i64, String)> = sqlx::query_as(&format!(
        "SELECT number_month_key, number_seq, created_from FROM shifts \
         WHERE status = 'active' AND id IN ({DEMO_SHIFTS}) ORDER BY number_seq"
    ))
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let active_shifts = active
        .into_iter()
        .map(|(key, seq, origin)| {
            let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
            Ok(crate::shifts::format_number(&key, seq, origin))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(DemoDataSummary {
        present: product_id.is_some(),
        product_id,
        shifts: counts[0],
        boxes: counts[1],
        pallets: counts[2],
        codes: counts[3],
        active_shifts,
    })
}

/// `GET /v1/office/demo-data`.
pub async fn get_demo_data(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<DemoDataSummary>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let answer = summary(&mut tx).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    answer.map(Json)
}

/// A statement's one parameter.
#[derive(Clone, Copy)]
enum Arg {
    None,
    /// The demo SSCC prefix.
    Prefix,
    /// The removal's instant.
    At,
}

/// The statements that remove the demo data, children first, each with its parameter.
const REMOVE: &[(&str, Arg)] = &[
    // Facts of the demo shifts' codes, scans, boxes and pallets.
    ("CREATE TEMP TABLE demo_shift_ids AS SELECT s.id FROM shifts s \
     JOIN products p ON p.id = s.product_id WHERE p.demo = 1", Arg::None),
    ("CREATE TEMP TABLE demo_scan_ids AS SELECT id, code_hash FROM scans \
     WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("CREATE TEMP TABLE demo_ssccs AS SELECT sscc FROM boxes \
     WHERE shift_id IN (SELECT id FROM demo_shift_ids) AND sscc IS NOT NULL \
     UNION SELECT sscc FROM pallets WHERE shift_id IN (SELECT id FROM demo_shift_ids) \
     AND sscc IS NOT NULL \
     UNION SELECT sscc FROM warehouse_pallets WHERE product_id IN \
     (SELECT id FROM products WHERE demo = 1) AND sscc IS NOT NULL", Arg::None),
    ("DELETE FROM code_conflicts WHERE winner_scan_id IN (SELECT id FROM demo_scan_ids) \
     OR loser_scan_id IN (SELECT id FROM demo_scan_ids)", Arg::None),
    ("DELETE FROM cloud_history_conflicts WHERE loser_scan_id IN (SELECT id FROM demo_scan_ids)", Arg::None),
    ("DELETE FROM code_owners WHERE shift_id IN (SELECT id FROM demo_shift_ids) \
     OR scan_id IN (SELECT id FROM demo_scan_ids)", Arg::None),
    ("DELETE FROM code_releases WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM box_items WHERE box_id IN \
     (SELECT id FROM boxes WHERE shift_id IN (SELECT id FROM demo_shift_ids))", Arg::None),
    ("DELETE FROM box_exceptions WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM unit_label_events WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM scans WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM warehouse_reprints WHERE identity IN (SELECT sscc FROM demo_ssccs) \
     OR identity IN (SELECT code_hash FROM demo_scan_ids)", Arg::None),
    ("DELETE FROM warehouse_pallet_boxes WHERE box_sscc IN (SELECT sscc FROM demo_ssccs) \
     OR pallet_id IN (SELECT id FROM warehouse_pallets WHERE product_id IN \
     (SELECT id FROM products WHERE demo = 1))", Arg::None),
    ("DELETE FROM warehouse_pallets WHERE product_id IN (SELECT id FROM products WHERE demo = 1)", Arg::None),
    ("DELETE FROM pallet_exceptions WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM boxes WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM pallets WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM fact_receipts WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM shift_close_events WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM shift_participants WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    // The files the office stored of them (their chunks go with them).
    ("DELETE FROM export_files WHERE shift_id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    // A late fact of a removed shift is acknowledged and dropped.
    ("INSERT OR IGNORE INTO demo_removed_shifts (id, removed_at) \
     SELECT id, ? FROM demo_shift_ids", Arg::At),
    ("DELETE FROM shifts WHERE id IN (SELECT id FROM demo_shift_ids)", Arg::None),
    ("DELETE FROM shift_number_counters WHERE month_key = 'DEMO'", Arg::None),
    // The demo prefix's blocks and counters (decision О4, option В).
    ("DELETE FROM sscc_blocks WHERE issuer_prefix = ?", Arg::Prefix),
    ("DELETE FROM sscc_counters WHERE issuer_prefix = ?", Arg::Prefix),
    ("DELETE FROM product_photos WHERE product_id IN (SELECT id FROM products WHERE demo = 1)", Arg::None),
    ("DELETE FROM products WHERE demo = 1", Arg::None),
    ("DROP TABLE temp.demo_shift_ids", Arg::None),
    ("DROP TABLE temp.demo_scan_ids", Arg::None),
    ("DROP TABLE temp.demo_ssccs", Arg::None),
];

/// `DELETE /v1/office/demo-data`: `200` with what was removed, `204` when there is nothing.
pub async fn delete_demo_data(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Response, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let removed = summary(&mut tx).await?;
    let Some(product_id) = removed.product_id.clone() else {
        // Nothing to remove: no revision, no row.
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if !removed.active_shifts.is_empty() {
        return Err(ApiError::conflict(
            "demo_shift_active",
            "a demo shift is open: close it first",
        )
        .with_details(json!({
            "constraint": "demo_shift_active",
            "shifts": removed.active_shifts,
        })));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    for (sql, arg) in REMOVE {
        let query = sqlx::query(sql);
        let query = match arg {
            Arg::None => query,
            Arg::Prefix => query.bind(DEMO_PREFIX),
            Arg::At => query.bind(&at),
        };
        query.execute(&mut *tx).await.map_err(ApiError::internal)?;
    }
    crate::feed::remove(&mut tx, entities::PRODUCTS, &product_id, rev)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DEMO_DATA_DELETE,
            target_type: Some("product"),
            target_id: Some(&product_id),
            outcome: Outcome::Ok,
            details: json!({
                "shifts": removed.shifts,
                "boxes": removed.boxes,
                "pallets": removed.pallets,
                "codes": removed.codes,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(removed).into_response())
}
