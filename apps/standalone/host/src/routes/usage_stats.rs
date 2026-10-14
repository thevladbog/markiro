//! Usage statistics for the support bundle (beta 3 feedback): `GET
//! /v1/office/usage-stats`, administrators only, read-only.
//!
//! One answer of counts by calendar month for the last [`USAGE_MONTHS`]
//! months (`markiro_proto::usage_stats`): shifts by mode and origin, scans by
//! verdict, boxes, pallets, exceptions, conflicts, reprints, applied
//! disaggregation documents, refused records and the paired devices by kind.
//! Nothing but counts and month keys is read out of a row, so no code, name,
//! SSCC, PIN, badge or hash can reach the answer; the types forbid a field
//! beyond the allowlist and `tests/usage_stats.rs` checks it on seeded rows.
//!
//! Every query is a grouped aggregate bounded to the window and driven by an
//! index (`QUERIES`; `tests/usage_stats.rs` reads the plan of each): the
//! shifts of the window by `shifts_planned_date`, then their rows by the
//! per-shift indexes (`scans_shift`, `boxes_shift`, `pallets_shift`,
//! `box_exceptions_shift`, `pallet_exceptions_shift`,
//! `unit_label_events_shift`, `fact_receipts_rejected`), the conflicts by
//! `code_conflicts_detected`. The tables with no index on time
//! (`warehouse_reprints`, `disaggregation_documents`) are read whole: both
//! hold a handful of rows beside the facts. A shift's rows belong to the
//! month of its own date (`planned_date`), the host's instants to the UTC
//! month of the instant.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::usage_stats::{UsageDevices, UsageMonth, UsageStats, USAGE_MONTHS};
use sqlx::SqliteConnection;
use time::OffsetDateTime;

use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// Shifts of the window by month, mode, origin, print policy and pallets.
/// Parameters: the first and the last day of the window.
pub const SHIFTS: &str = "SELECT substr(planned_date, 1, 7), mode, created_from, \
     validation_print_mode, pallets_enabled, COUNT(*) FROM shifts \
     WHERE planned_date >= ?1 AND planned_date <= ?2 GROUP BY 1, 2, 3, 4, 5";

/// Scans of those shifts by verdict.
pub const SCANS: &str = "SELECT substr(s.planned_date, 1, 7), sc.verdict, COUNT(*) \
     FROM shifts s JOIN scans sc ON sc.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 GROUP BY 1, 2";

/// Boxes closed in those shifts, those taken apart since, the codes reported.
pub const BOXES: &str = "SELECT substr(s.planned_date, 1, 7), COUNT(*), \
     COUNT(b.disassembled_at), COALESCE(SUM(b.item_count_reported), 0) \
     FROM shifts s JOIN boxes b ON b.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 AND b.closed_at IS NOT NULL \
     GROUP BY 1";

/// Pallets closed in those shifts and those taken apart since.
pub const PALLETS: &str = "SELECT substr(s.planned_date, 1, 7), COUNT(*), \
     COUNT(p.disassembled_at) \
     FROM shifts s JOIN pallets p ON p.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 AND p.closed_at IS NOT NULL \
     GROUP BY 1";

/// Box exceptions of those shifts by kind.
pub const BOX_EXCEPTIONS: &str = "SELECT substr(s.planned_date, 1, 7), e.kind, COUNT(*) \
     FROM shifts s JOIN box_exceptions e ON e.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 GROUP BY 1, 2";

/// Pallet exceptions of those shifts by kind.
pub const PALLET_EXCEPTIONS: &str = "SELECT substr(s.planned_date, 1, 7), e.kind, COUNT(*) \
     FROM shifts s JOIN pallet_exceptions e ON e.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 GROUP BY 1, 2";

/// Reprints of a validation shift's duplicate labels in those shifts.
pub const UNIT_LABEL_REPRINTS: &str = "SELECT substr(s.planned_date, 1, 7), COUNT(*) \
     FROM shifts s JOIN unit_label_events u ON u.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 \
     AND u.event = 'prepared' AND u.attempt_no > 1 GROUP BY 1";

/// Records of those shifts the host refused.
pub const REFUSED_RECORDS: &str = "SELECT substr(s.planned_date, 1, 7), COUNT(*) \
     FROM shifts s JOIN fact_receipts r ON r.shift_id = s.id \
     WHERE s.planned_date >= ?1 AND s.planned_date <= ?2 AND r.outcome = 'rejected' GROUP BY 1";

/// Conflicts detected since the window opened, by kind and review. Parameter:
/// the first instant of the window.
pub const CONFLICTS: &str = "SELECT substr(detected_at, 1, 7), kind, \
     reviewed_at IS NOT NULL, COUNT(*) FROM code_conflicts \
     WHERE detected_at >= ?1 GROUP BY 1, 2, 3";

/// Disaggregation documents applied since the window opened. Parameter: the
/// first instant of the window.
pub const DISAGGREGATION: &str = "SELECT substr(applied_at, 1, 7), COUNT(*) \
     FROM disaggregation_documents WHERE status = 'applied' AND applied_at >= ?1 GROUP BY 1";

/// Warehouse reprints since the window opened. Parameter: the first instant.
pub const WAREHOUSE_REPRINTS: &str = "SELECT substr(received_at, 1, 7), COUNT(*) \
     FROM warehouse_reprints WHERE received_at >= ?1 GROUP BY 1";

/// Paired devices that are not revoked, by kind.
pub const DEVICES: &str =
    "SELECT kind, COUNT(*) FROM devices WHERE revoked_at IS NULL GROUP BY kind";

/// The queries over a window of dates (`?1`, `?2`), the queries over a window
/// of instants (`?1`) and the one with none: what the plan test reads.
pub const DATE_QUERIES: &[&str] = &[
    SHIFTS,
    SCANS,
    BOXES,
    PALLETS,
    BOX_EXCEPTIONS,
    PALLET_EXCEPTIONS,
    UNIT_LABEL_REPRINTS,
    REFUSED_RECORDS,
];
pub const INSTANT_QUERIES: &[&str] = &[CONFLICTS, DISAGGREGATION, WAREHOUSE_REPRINTS];

/// The window: the `YYYY-MM` keys of the last [`USAGE_MONTHS`] months ending
/// with the month of `now`, the oldest first.
pub fn window(now: OffsetDateTime) -> Vec<String> {
    let last = i64::from(now.year()) * 12 + i64::from(u8::from(now.month())) - 1;
    (0..USAGE_MONTHS as i64)
        .map(|back| {
            let index = last - (USAGE_MONTHS as i64 - 1) + back;
            format!(
                "{:04}-{:02}",
                index.div_euclid(12),
                index.rem_euclid(12) + 1
            )
        })
        .collect()
}

fn count(value: i64) -> Result<u64, ApiError> {
    u64::try_from(value).map_err(ApiError::internal)
}

/// The months of the answer by key, so a row folds into its month.
struct Months(BTreeMap<String, UsageMonth>);

impl Months {
    fn at(&mut self, key: &str) -> Option<&mut UsageMonth> {
        self.0.get_mut(key)
    }
}

/// `GET /v1/office/usage-stats`: administrators only (the session is read
/// again on the connection that reads the counts).
pub async fn usage_stats(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<UsageStats>, ApiError> {
    context.require_admin()?;
    let keys = window(state.now());
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut conn).await?;
    read(&mut conn, &keys).await.map(Json)
}

/// The statistics of the months `keys` (ascending `YYYY-MM`).
pub async fn read(conn: &mut SqliteConnection, keys: &[String]) -> Result<UsageStats, ApiError> {
    let first = keys
        .first()
        .ok_or_else(|| ApiError::internal("no months"))?;
    let last = keys.last().ok_or_else(|| ApiError::internal("no months"))?;
    let from_day = format!("{first}-01");
    let to_day = format!("{last}-31");
    let from_instant = format!("{first}-01T00:00:00Z");
    let mut months = Months(
        keys.iter()
            .map(|key| (key.clone(), UsageMonth::empty(key.clone())))
            .collect(),
    );

    let rows: Vec<(String, String, String, String, bool, i64)> = sqlx::query_as(SHIFTS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, mode, origin, print, pallets, n) in rows {
        let (Some(month), n) = (months.at(&key), count(n)?) else {
            continue;
        };
        match mode.as_str() {
            "validation" => {
                month.shifts.validation += n;
                if print == "duplicate_dm" {
                    month.shifts.validation_print += n;
                }
            }
            _ => {
                month.shifts.aggregation += n;
                if pallets {
                    month.shifts.with_pallets += n;
                }
            }
        }
        match origin.as_str() {
            "station" => month.shifts.from_station += n,
            _ => month.shifts.from_office += n,
        }
    }

    let rows: Vec<(String, String, i64)> = sqlx::query_as(SCANS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, verdict, n) in rows {
        let (Some(month), n) = (months.at(&key), count(n)?) else {
            continue;
        };
        match verdict.as_str() {
            "ok" => month.scans.accepted += n,
            "duplicate" => month.scans.duplicates += n,
            _ => month.scans.rejected += n,
        }
    }

    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(BOXES)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, closed, disassembled, codes) in rows {
        if let Some(month) = months.at(&key) {
            month.boxes.closed += count(closed)?;
            month.boxes.disassembled += count(disassembled)?;
            month.boxes.codes += count(codes)?;
        }
    }

    let rows: Vec<(String, i64, i64)> = sqlx::query_as(PALLETS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, closed, disassembled) in rows {
        if let Some(month) = months.at(&key) {
            month.pallets.closed += count(closed)?;
            month.pallets.disassembled += count(disassembled)?;
        }
    }

    let rows: Vec<(String, String, i64)> = sqlx::query_as(BOX_EXCEPTIONS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, kind, n) in rows {
        let (Some(month), n) = (months.at(&key), count(n)?) else {
            continue;
        };
        match kind.as_str() {
            "undo" => month.exceptions.box_undo += n,
            "clear" => month.exceptions.box_clear += n,
            "reprint" => month.exceptions.box_reprint += n,
            "disassemble" => month.exceptions.box_disassemble += n,
            _ => {}
        }
    }

    let rows: Vec<(String, String, i64)> = sqlx::query_as(PALLET_EXCEPTIONS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, kind, n) in rows {
        let (Some(month), n) = (months.at(&key), count(n)?) else {
            continue;
        };
        match kind.as_str() {
            "reprint" => month.exceptions.pallet_reprint += n,
            "disassemble" => month.exceptions.pallet_disassemble += n,
            _ => {}
        }
    }

    let rows: Vec<(String, i64)> = sqlx::query_as(UNIT_LABEL_REPRINTS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, n) in rows {
        if let Some(month) = months.at(&key) {
            month.reprints.unit_label += count(n)?;
        }
    }

    let rows: Vec<(String, i64)> = sqlx::query_as(REFUSED_RECORDS)
        .bind(&from_day)
        .bind(&to_day)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, n) in rows {
        if let Some(month) = months.at(&key) {
            month.sync_rejected += count(n)?;
        }
    }

    let rows: Vec<(String, String, bool, i64)> = sqlx::query_as(CONFLICTS)
        .bind(&from_instant)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, kind, reviewed, n) in rows {
        let (Some(month), n) = (months.at(&key), count(n)?) else {
            continue;
        };
        match kind.as_str() {
            "displaced" => month.conflicts.displaced += n,
            _ => month.conflicts.late += n,
        }
        if reviewed {
            month.conflicts.reviewed += n;
        }
    }

    let rows: Vec<(String, i64)> = sqlx::query_as(DISAGGREGATION)
        .bind(&from_instant)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, n) in rows {
        if let Some(month) = months.at(&key) {
            month.disaggregation_applied += count(n)?;
        }
    }

    let rows: Vec<(String, i64)> = sqlx::query_as(WAREHOUSE_REPRINTS)
        .bind(&from_instant)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (key, n) in rows {
        if let Some(month) = months.at(&key) {
            month.reprints.warehouse += count(n)?;
        }
    }

    let mut devices = UsageDevices::default();
    let rows: Vec<(String, i64)> = sqlx::query_as(DEVICES)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    for (kind, n) in rows {
        let n = count(n)?;
        match kind.as_str() {
            "station" => devices.station = n,
            "office" => devices.office = n,
            "handheld" => devices.handheld = n,
            _ => {}
        }
    }

    Ok(UsageStats {
        months: months.0.into_values().collect(),
        devices,
    })
}
