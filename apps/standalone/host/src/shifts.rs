//! Shifts (stage 2a spec §4.2). The number is the host's: a counter per
//! month, `MONYY-NNN`, with `/S` for a shift created at a station — the
//! domain's `shiftMonthKey` and `formatShiftNumber`
//! (`packages/domain/src/shift-number.ts`) rewritten, so a number reads the
//! same as the cloud's. `proto/fixtures/shift-numbers.json` holds the cases
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{ProductStatus, ShiftMode, ShiftOrigin, ShiftStatus, TemplatePurpose};
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::templates;

/// The month names of a shift number: a fixed English table, never a
/// locale's, because the number is an identifier.
const MONTH_KEYS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// A civil date as `YYYY-MM-DD`: four, two and two ASCII digits naming a
/// real calendar day of the years 1–9999, as the cloud's `civilDateSchema`.
/// The domain's `shiftMonthKey` also takes the year 0000 (its `Date.UTC`
/// reads the years 0–99 as 1900–1999); no shift date can be that year here.
pub fn civil_date(text: &str) -> Option<time::Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |part: &[u8]| -> Option<u16> {
        part.iter().try_fold(0u16, |value, byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + u16::from(byte - b'0'))
        })
    };
    let year = number(&bytes[0..4])?;
    let month = number(&bytes[5..7])?;
    let day = number(&bytes[8..10])?;
    if year == 0 {
        return None;
    }
    let month = time::Month::try_from(u8::try_from(month).ok()?).ok()?;
    time::Date::from_calendar_date(i32::from(year), month, u8::try_from(day).ok()?).ok()
}

/// The month a shift number is drawn from, as `MONYY` (`OCT26`).
pub fn month_key(date: time::Date) -> String {
    let month = MONTH_KEYS[usize::from(u8::from(date.month())) - 1];
    format!("{month}{:02}", date.year() % 100)
}

/// [`month_key`] of a civil date's text, `None` when it is no civil date.
pub fn month_key_of(text: &str) -> Option<String> {
    civil_date(text).map(month_key)
}

/// The shift number as people read it: `OCT26-004`, `OCT26-004/S` for a
/// station's, and never cut short past 999 (`OCT26-1234`).
pub fn format_number(month_key: &str, seq: i64, origin: ShiftOrigin) -> String {
    let station = match origin {
        ShiftOrigin::Office => "",
        ShiftOrigin::Station => "/S",
    };
    format!("{month_key}-{seq:03}{station}")
}

/// What a new shift's product gives it: the product group its box template
/// must cover, and the box capacity a shift takes when it names none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftProduct {
    pub group: u32,
    pub box_capacity: u32,
}

/// `conflict` on `product_inactive`: the product is a draft or archived.
pub fn product_inactive() -> ApiError {
    ApiError::conflict(
        "product_inactive",
        "the product is a draft or archived: a shift needs a product in use",
    )
}

/// The product a new shift is made of: an active product (a group and both
/// capacities) that is not archived. No such product is `validation_failed`
/// on `productId`; a draft or an archived one is `product_inactive`.
pub async fn shift_product(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<ShiftProduct, ApiError> {
    let row: Option<(String, bool, Option<u32>, Option<u32>)> = sqlx::query_as(
        "SELECT status, archived, chz_group_code, box_capacity FROM products WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let (status, archived, group, box_capacity) =
        row.ok_or_else(|| ApiError::validation("productId", "no such product"))?;
    match (
        status.parse::<ProductStatus>(),
        archived,
        group,
        box_capacity,
    ) {
        (Ok(ProductStatus::Active), false, Some(group), Some(box_capacity)) => Ok(ShiftProduct {
            group,
            box_capacity,
        }),
        _ => Err(product_inactive()),
    }
}

/// `validation_failed` on `counterpartyId` unless `id` names a counterparty
/// that is not archived.
pub async fn check_counterparty(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let archived: Option<bool> =
        sqlx::query_scalar("SELECT archived FROM counterparties WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    if archived == Some(false) {
        Ok(())
    } else {
        Err(ApiError::validation(
            "counterpartyId",
            "no such counterparty in use",
        ))
    }
}

/// `validation_failed` on `boxTemplateId` unless `id` names a box template
/// that fits a product of `group` (`templates::fits`: enabled, of the box
/// purpose, covering the group).
pub async fn check_box_template(
    conn: &mut SqliteConnection,
    id: &str,
    group: u32,
) -> Result<(), ApiError> {
    templates::check_slot(conn, "boxTemplateId", id, TemplatePurpose::Box, Some(group)).await
}

/// A new shift after the request's own checks and the references' checks.
pub struct NewShift<'a> {
    pub origin: ShiftOrigin,
    /// The office user's id or the station's.
    pub created_by: &'a str,
    /// A station's request id; the office sends none.
    pub request_id: Option<&'a str>,
    pub product_id: &'a str,
    pub line_id: &'a str,
    pub counterparty_id: Option<&'a str>,
    pub production_date: time::Date,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: &'a str,
}

/// Insert a planned shift at `rev` and return its id. The number is the
/// next of its month's counter, drawn in the same transaction.
pub async fn insert(
    conn: &mut SqliteConnection,
    shift: &NewShift<'_>,
    at: &str,
    rev: i64,
) -> Result<String, ApiError> {
    let key = month_key(shift.production_date);
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?, 1) \
         ON CONFLICT (month_key) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq",
    )
    .bind(&key)
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_by_kind = match shift.origin {
        ShiftOrigin::Office => "office_user",
        ShiftOrigin::Station => "device",
    };
    sqlx::query(
        "INSERT INTO shifts (id, number_month_key, number_seq, created_from, created_by_kind, \
         created_by, create_request_id, status, mode, pallets_enabled, product_id, line_id, \
         counterparty_id, production_date, planned_qty, box_capacity, box_template_id, \
         created_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&key)
    .bind(seq)
    .bind(shift.origin.as_str())
    .bind(created_by_kind)
    .bind(shift.created_by)
    .bind(shift.request_id)
    .bind(ShiftStatus::Planned.as_str())
    .bind(ShiftMode::Aggregation.as_str())
    .bind(shift.product_id)
    .bind(shift.line_id)
    .bind(shift.counterparty_id)
    .bind(civil_text(shift.production_date))
    .bind(shift.planned_qty)
    .bind(shift.box_capacity)
    .bind(shift.box_template_id)
    .bind(at)
    .bind(rev)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(id)
}

/// A civil date as `YYYY-MM-DD`, the way the host stores it.
pub fn civil_text(date: time::Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}
