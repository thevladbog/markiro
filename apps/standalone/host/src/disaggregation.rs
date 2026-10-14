//! Office disaggregation documents (plan ДЗГ, parity spec §5.1): the
//! number, the line rules and the apply, which `routes::disaggregation`
//! runs inside its write transaction. The cloud's
//! `apps/api/src/modules/disaggregation/{doc-number.ts,line-validation.ts,
//! disaggregation.service.ts}` is the reference. Only a closed box or
//! pallet of a closed shift is taken apart (owner decision ПР-1), so the
//! office never argues with a box a station still fills.

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
    fn the_first_rule_that_holds_wins() {
        assert_eq!(classify(false, false, true), LineStatus::NotClosed);
        assert_eq!(classify(true, false, true), LineStatus::ShiftOpen);
        assert_eq!(classify(true, true, true), LineStatus::AlreadyDisassembled);
        assert_eq!(classify(true, true, false), LineStatus::Ok);
    }
}
