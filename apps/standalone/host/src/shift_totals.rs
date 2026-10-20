//! What a shift and each of its devices add up to (plan 2b, spec §4.1 «Не добавляем
//! столбцов-счётчиков», §4.2 «Итоги станциям»): read from the facts at every answer, never stored.
//! The rules are the office's (`routes/office_shifts.rs`, `SELECT`): a unit accepted is a live item
//! of one of the shift's boxes (a validation shift: a code it owns without a box), a box closed is
//! closed and not taken apart, a pallet likewise. A box or a pallet is its device's
//! (`boxes.device_id`, `pallets.device_id`), a validation unit its owning scan's
//! (`code_owners.device_id`). Every read searches `boxes_shift`, `box_items_live`, `pallets_shift`
//! or `code_owners_shift_unboxed` (the test below pins the plan); no index is added.

use markiro_proto::{DeviceShiftTotals, DeviceTotals};
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// The whole shift's accepted units, closed boxes and closed pallets.
pub const SHIFT_TOTALS: &str = "SELECT \
     CASE s.mode WHEN 'validation' \
      THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = s.id AND o.box_id IS NULL) \
      ELSE (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
            WHERE b.shift_id = s.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      END AS accepted, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = s.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes_closed, \
     (SELECT COUNT(*) FROM pallets p WHERE p.shift_id = s.id \
      AND p.closed_at IS NOT NULL AND p.disassembled_at IS NULL) AS pallets \
     FROM shifts s WHERE s.id = ?";

/// The same per participant, first entry first; a participant with nothing counts zeros.
pub const BY_DEVICE: &str = "SELECT p.device_id, \
     CASE s.mode WHEN 'validation' \
      THEN (SELECT COUNT(*) FROM code_owners o WHERE o.shift_id = p.shift_id \
            AND o.box_id IS NULL AND o.device_id = p.device_id) \
      ELSE (SELECT COUNT(*) FROM box_items i JOIN boxes b ON b.id = i.box_id \
            WHERE b.shift_id = p.shift_id AND b.device_id = p.device_id \
            AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
      END AS accepted, \
     (SELECT COUNT(*) FROM boxes b WHERE b.shift_id = p.shift_id AND b.device_id = p.device_id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes_closed, \
     (SELECT COUNT(*) FROM pallets q WHERE q.shift_id = p.shift_id \
      AND q.device_id = p.device_id \
      AND q.closed_at IS NOT NULL AND q.disassembled_at IS NULL) AS pallets \
     FROM shift_participants p JOIN shifts s ON s.id = p.shift_id \
     WHERE p.shift_id = ? ORDER BY p.first_entered_at, p.device_id";

fn count<T: TryFrom<i64>>(value: i64) -> Result<T, ApiError>
where
    T::Error: std::fmt::Display,
{
    T::try_from(value).map_err(ApiError::internal)
}

async fn counts(conn: &mut SqliteConnection, shift_id: &str) -> Result<(u64, u32, u32), ApiError> {
    let (accepted, boxes_closed, pallets): (i64, i64, i64) = sqlx::query_as(SHIFT_TOTALS)
        .bind(shift_id)
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok((count(accepted)?, count(boxes_closed)?, count(pallets)?))
}

/// The whole shift's totals as of `as_of` (the host's time of the read).
pub async fn totals(
    conn: &mut SqliteConnection,
    shift_id: &str,
    as_of: &str,
) -> Result<DeviceShiftTotals, ApiError> {
    let (accepted, boxes_closed, pallets) = counts(conn, shift_id).await?;
    Ok(DeviceShiftTotals {
        accepted,
        boxes_closed,
        pallets,
        as_of: as_of.to_owned(),
    })
}

/// The whole shift's accepted units: what a shared shift's plan is judged by.
pub async fn shift_accepted(conn: &mut SqliteConnection, shift_id: &str) -> Result<u64, ApiError> {
    Ok(counts(conn, shift_id).await?.0)
}

/// Each participant's part, first entry first.
pub async fn by_device(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<DeviceTotals>, ApiError> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(BY_DEVICE)
        .bind(shift_id)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|(device_id, accepted, boxes_closed, pallets)| {
            Ok(DeviceTotals {
                device_id,
                accepted: count(accepted)?,
                boxes_closed: count(boxes_closed)?,
                pallets: count(pallets)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    /// The plan SQLite makes of `sql`, one line a step.
    async fn plan(sql: &str) -> Vec<String> {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
            .bind("00000000-0000-4000-8000-000000000000")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect()
    }

    /// Every total searches the shift's indexes and scans no table: the reads run on every
    /// device's list and on every close of a shared shift.
    #[tokio::test]
    async fn the_totals_search_the_shifts_indexes_and_scan_nothing() {
        for sql in [super::SHIFT_TOTALS, super::BY_DEVICE] {
            let plan = plan(sql).await;
            let scans: Vec<&String> = plan
                .iter()
                .filter(|line| line.starts_with("SCAN"))
                .collect();
            assert!(scans.is_empty(), "{scans:?} in {plan:#?}");
            for index in [
                "boxes_shift",
                "box_items_live",
                "pallets_shift",
                "code_owners_shift_unboxed",
            ] {
                assert!(
                    plan.iter().any(|line| line.contains(index)),
                    "{index} not used: {plan:#?}"
                );
            }
        }
    }
}
