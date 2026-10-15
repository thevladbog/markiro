//! Office disaggregation documents (plan ДЗГ, parity spec §5.1): the
//! number, the line rules and the apply, which `routes::disaggregation`
//! runs inside its write transaction. The cloud's
//! `apps/api/src/modules/disaggregation/{doc-number.ts,line-validation.ts,
//! disaggregation.service.ts}` is the reference. Only a closed box or
//! pallet of a closed shift is taken apart (owner decision ПР-1), so the
//! office never argues with a box a station still fills.

use std::collections::BTreeSet;

use markiro_proto::disaggregation::DisaggregationLineStatus as LineStatus;
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// `DSG-YY-NNNN` (the cloud's `formatDocNo`): the year of creation in UTC,
/// the number padded to four digits and never cut.
pub fn format_doc_no(seq: i64, year: i32) -> String {
    format!("DSG-{:02}-{seq:04}", year.rem_euclid(100))
}

/// The site's next document number, inside the caller's write transaction.
pub async fn next_seq(conn: &mut SqliteConnection) -> Result<i64, ApiError> {
    sqlx::query_scalar(
        "UPDATE disaggregation_doc_counters SET last_seq = last_seq + 1 WHERE id = 1 \
         RETURNING last_seq",
    )
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)
}

/// What an SSCC names now and the line's status for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    pub status: LineStatus,
    pub product_id: String,
    pub code_count: i64,
}

/// The first rule that holds (the cloud's order): an open box or pallet,
/// then an open shift (ПР-1), then one taken apart already.
pub fn classify(closed: bool, shift_closed: bool, disassembled: bool) -> LineStatus {
    if !closed {
        LineStatus::NotClosed
    } else if !shift_closed {
        LineStatus::ShiftOpen
    } else if disassembled {
        LineStatus::AlreadyDisassembled
    } else {
        LineStatus::Ok
    }
}

/// What an apply took apart.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Applied {
    pub boxes: usize,
    pub pallets: usize,
    pub codes: usize,
}

/// Take apart the `ok` lines' boxes and pallets of document `document_id`
/// at `instant` (a device-form instant), inside the caller's write
/// transaction, and write each box's `code_releases` row with `rev`. Each
/// shift whose boxes or pallets changed is marked late at `at`, as a
/// station's late exception marks it (`facts::mark_late`): a file saved
/// before the apply no longer describes the shift.
///
/// A box costs a handful of statements however many codes it holds: a
/// document of 10 000 boxes holds the write lock, and every station's fact
/// batch waits behind it.
pub async fn apply_targets(
    conn: &mut SqliteConnection,
    document_id: &str,
    targets: &[Target],
    instant: &str,
    at: &str,
    rev: i64,
) -> Result<Applied, ApiError> {
    let mut applied = Applied::default();
    let mut shifts: BTreeSet<String> = BTreeSet::new();
    for target in targets {
        if let Some(box_id) = &target.box_id {
            // As a station's `disassemble` (facts/exception.rs): the code
            // every live item's scan owns is free (what
            // `facts::registry::release` does for one scan), and every live
            // item leaves at the one instant the box is taken apart.
            sqlx::query(
                "DELETE FROM code_owners WHERE scan_id IN (SELECT scan_id FROM box_items \
                 WHERE box_id = ? AND removed_at IS NULL AND displaced_at IS NULL)",
            )
            .bind(box_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            let taken = sqlx::query(
                "UPDATE box_items SET removed_at = ? WHERE box_id = ? \
                 AND removed_at IS NULL AND displaced_at IS NULL",
            )
            .bind(instant)
            .bind(box_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?
            .rows_affected();
            // A box taken apart already is an error here, not a skip: under
            // the lock the lines were checked a moment ago, and the whole
            // apply rolls back.
            let shift_id: String = sqlx::query_scalar(
                "UPDATE boxes SET disassembled_at = ? WHERE id = ? AND disassembled_at IS NULL \
                 RETURNING shift_id",
            )
            .bind(instant)
            .bind(box_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            crate::facts::registry_touch::box_by_id(&mut *conn, box_id, at).await?;
            sqlx::query(
                "INSERT INTO code_releases (box_id, shift_id, document_id, code_count, \
                 released_at, rev) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(box_id)
            .bind(&shift_id)
            .bind(document_id)
            .bind(i64::try_from(taken).map_err(ApiError::internal)?)
            .bind(instant)
            .bind(rev)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            shifts.insert(shift_id);
            applied.boxes += 1;
            applied.codes += usize::try_from(taken).map_err(ApiError::internal)?;
        } else if let Some(pallet_id) = &target.pallet_id {
            // As a station's pallet `disassemble`: its boxes stay as they are.
            let shift_id: Option<String> = sqlx::query_scalar(
                "UPDATE pallets SET disassembled_at = ? WHERE id = ? AND disassembled_at IS NULL \
                 RETURNING shift_id",
            )
            .bind(instant)
            .bind(pallet_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            let Some(shift_id) = shift_id else {
                return Err(ApiError::internal("a pallet taken apart twice"));
            };
            crate::facts::registry_touch::pallet_boxes(&mut *conn, pallet_id, at).await?;
            shifts.insert(shift_id);
            applied.pallets += 1;
        }
    }
    for shift_id in &shifts {
        sqlx::query(
            "UPDATE shifts SET late_data_at = ?, rev = ? WHERE id = ? AND late_data_at IS NULL",
        )
        .bind(at)
        .bind(rev)
        .bind(shift_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(applied)
}

/// A box by its SSCC (`boxes_sscc`) with its live codes.
const BOX_SQL: &str = "SELECT b.id, b.closed_at IS NOT NULL, s.status = 'closed', \
     b.disassembled_at IS NOT NULL, s.product_id, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
     FROM boxes b JOIN shifts s ON s.id = b.shift_id WHERE b.sscc = ?";

/// A pallet by its SSCC (`pallets_sscc`) with the live codes of its boxes:
/// a box taken apart has none, as in the cloud.
const PALLET_SQL: &str = "SELECT p.id, p.closed_at IS NOT NULL, s.status = 'closed', \
     p.disassembled_at IS NOT NULL, s.product_id, \
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      WHERE b.pallet_id = p.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) \
     FROM pallets p JOIN shifts s ON s.id = p.shift_id WHERE p.sscc = ?";

/// What `sscc` (18 digits) names: a box first, then a pallet (the cloud's
/// `resolveLineTargets`); `None` when neither — the line is `not_found`.
pub async fn resolve(conn: &mut SqliteConnection, sscc: &str) -> Result<Option<Target>, ApiError> {
    type Row = (String, bool, bool, bool, String, i64);
    let found: Option<Row> = sqlx::query_as(BOX_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((id, closed, shift_closed, disassembled, product_id, code_count)) = found {
        return Ok(Some(Target {
            box_id: Some(id),
            pallet_id: None,
            status: classify(closed, shift_closed, disassembled),
            product_id,
            code_count,
        }));
    }
    let found: Option<Row> = sqlx::query_as(PALLET_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(found.map(
        |(id, closed, shift_closed, disassembled, product_id, code_count)| Target {
            box_id: None,
            pallet_id: Some(id),
            status: classify(closed, shift_closed, disassembled),
            product_id,
            code_count,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_number_is_padded_to_four_digits_and_never_cut() {
        assert_eq!(format_doc_no(1, 2026), "DSG-26-0001");
        assert_eq!(format_doc_no(9999, 2026), "DSG-26-9999");
        assert_eq!(format_doc_no(12345, 2031), "DSG-31-12345");
        assert_eq!(format_doc_no(7, 2100), "DSG-00-0007");
    }

    #[test]
    fn an_office_instant_reads_as_a_devices() {
        let at =
            time::OffsetDateTime::from_unix_timestamp_nanos(1_790_000_000_123_456_789).unwrap();
        let text = crate::facts::rules::device_text(at);
        assert_eq!(text, "2026-09-21T14:13:20.123Z");
        assert_eq!(
            crate::facts::rules::device_instant(&text),
            Some(at.replace_nanosecond(123_000_000).unwrap())
        );
    }

    #[test]
    fn the_first_rule_that_holds_wins() {
        assert_eq!(classify(false, false, true), LineStatus::NotClosed);
        assert_eq!(classify(true, false, true), LineStatus::ShiftOpen);
        assert_eq!(classify(true, true, true), LineStatus::AlreadyDisassembled);
        assert_eq!(classify(true, true, false), LineStatus::Ok);
    }
}
