//! Shifts (stage 2a spec §4.2). The number is the host's: a counter per
//! month, `MONYY-NNN`, with `/S` for a shift created at a station — the
//! domain's `shiftMonthKey` and `formatShiftNumber`
//! (`packages/domain/src/shift-number.ts`) rewritten, so a number reads the
//! same as the cloud's. `proto/fixtures/shift-numbers.json` holds the cases
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::{
    ProductStatus, ShiftMode, ShiftOrigin, ShiftSnapshot, ShiftSnapshotLogo,
    ShiftSnapshotOrganization, ShiftSnapshotProduct, ShiftSnapshotSheet, ShiftSnapshotTemplate,
    ShiftStatus, TemplatePurpose,
};
use serde_json::json;
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

/// What a new shift's product gives it: the product group its templates
/// must cover, and the capacities a shift takes when it names none (an
/// active product has both).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShiftProduct {
    pub group: u32,
    pub box_capacity: u32,
    pub pallet_box_capacity: u32,
}

/// `conflict` on `product_inactive`: the product is a draft or archived.
pub fn product_inactive() -> ApiError {
    ApiError::conflict(
        "product_inactive",
        "the product is a draft or archived: a shift needs a product in use",
    )
}

/// `conflict` on `shift_status`, with the shift's status in `details`: the
/// request does not suit a shift in that status (an edit of a closed one, a
/// delete of an open one).
pub fn status_conflict(status: ShiftStatus) -> ApiError {
    ApiError::conflict("shift_status", "the shift's status does not allow this")
        .with_details(json!({ "constraint": "shift_status", "status": status.as_str() }))
}

/// The product a new shift is made of: an active product (a group and both
/// capacities) that is not archived. No such product is `validation_failed`
/// on `productId`; a draft or an archived one is `product_inactive`.
pub async fn shift_product(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<ShiftProduct, ApiError> {
    type ProductRow = (String, bool, Option<u32>, Option<u32>, Option<u32>);
    let row: Option<ProductRow> = sqlx::query_as(
        "SELECT status, archived, chz_group_code, box_capacity, pallet_box_capacity \
         FROM products WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let (status, archived, group, box_capacity, pallet_box_capacity) =
        row.ok_or_else(|| ApiError::validation("productId", "no such product"))?;
    match (
        status.parse::<ProductStatus>(),
        archived,
        group,
        box_capacity,
        pallet_box_capacity,
    ) {
        (
            Ok(ProductStatus::Active),
            false,
            Some(group),
            Some(box_capacity),
            Some(pallet_box_capacity),
        ) => Ok(ShiftProduct {
            group,
            box_capacity,
            pallet_box_capacity,
        }),
        _ => Err(product_inactive()),
    }
}

/// `validation_failed` on `counterpartyId` unless `id` names a counterparty
/// that is not archived.
pub async fn check_counterparty(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    if counterparty_in_use(conn, id).await? {
        Ok(())
    } else {
        Err(ApiError::validation(
            "counterpartyId",
            "no such counterparty in use",
        ))
    }
}

/// Whether `id` names a counterparty that exists and is not archived; a
/// failed read is an internal error, never a refusal. A shift's counterparty
/// and a product's default one (plan ТОВ) follow this rule.
pub async fn counterparty_in_use(conn: &mut SqliteConnection, id: &str) -> Result<bool, ApiError> {
    let archived: Option<bool> =
        sqlx::query_scalar("SELECT archived FROM counterparties WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(archived == Some(false))
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

/// `validation_failed` on `palletTemplateId` unless `id` names a pallet
/// template that fits a product of `group` (`templates::fits`: enabled, of
/// the pallet purpose, covering the group).
pub async fn check_pallet_template(
    conn: &mut SqliteConnection,
    id: &str,
    group: u32,
) -> Result<(), ApiError> {
    templates::check_slot(
        conn,
        "palletTemplateId",
        id,
        TemplatePurpose::Pallet,
        Some(group),
    )
    .await
}

/// A shift's pallets: how many boxes a pallet holds and the pallet label
/// template. A shift without pallets has none of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pallets {
    pub box_capacity: u32,
    pub template_id: String,
    /// The A4 sheet (plan А4): the request's, else the product's default
    /// (`default_sheet_for_product`), else none.
    pub sheet_id: Option<String>,
}

/// What a request to plan or create a shift asks of pallets, after its own
/// checks: nothing, or pallets with a template and perhaps a capacity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PalletRequest<'a> {
    Off,
    On {
        box_capacity: Option<u32>,
        template_id: &'a str,
    },
}

/// The pallet fields of a new shift on their own: a shift without pallets
/// sends neither (`validation_failed` on the one it sends), a shift with
/// pallets needs its template (`validation_failed` on `palletTemplateId`),
/// and a capacity is 1 to `MAX_PALLET_BOX_CAPACITY`.
pub fn pallet_request<'a>(
    enabled: bool,
    box_capacity: Option<u32>,
    template_id: Option<&'a str>,
) -> Result<PalletRequest<'a>, ApiError> {
    crate::validate::count(
        "palletBoxCapacity",
        box_capacity,
        crate::validate::MAX_PALLET_BOX_CAPACITY,
    )?;
    match (enabled, box_capacity, template_id) {
        (false, Some(_), _) => Err(ApiError::validation(
            "palletBoxCapacity",
            "only a shift with pallets has a pallet capacity",
        )),
        (false, None, Some(_)) => Err(ApiError::validation(
            "palletTemplateId",
            "only a shift with pallets has a pallet template",
        )),
        (false, None, None) => Ok(PalletRequest::Off),
        (true, _, None) => Err(ApiError::validation(
            "palletTemplateId",
            "a shift with pallets needs a pallet template",
        )),
        (true, box_capacity, Some(template_id)) => Ok(PalletRequest::On {
            box_capacity,
            template_id,
        }),
    }
}

/// The pallets a new shift of `product` gets: its pallet template fits the
/// product's group, its capacity is the product's when the request names
/// none, and its A4 sheet (plan А4) is the request's enabled sheet, else the
/// default for the product (`default_sheet_for_product`: the product's
/// preferred sheet, its category's, the organization's, the first enabled),
/// else none. A sheet without pallets is `validation_failed` on
/// `palletSheetTemplateId`.
pub async fn pallets(
    conn: &mut SqliteConnection,
    request: PalletRequest<'_>,
    product_id: &str,
    product: &ShiftProduct,
    sheet_id: Option<&str>,
) -> Result<Option<Pallets>, ApiError> {
    match request {
        PalletRequest::Off => match sheet_id {
            Some(_) => Err(ApiError::validation(
                "palletSheetTemplateId",
                "only a shift with pallets has an A4 sheet",
            )),
            None => Ok(None),
        },
        PalletRequest::On {
            box_capacity,
            template_id,
        } => {
            check_pallet_template(conn, template_id, product.group).await?;
            let sheet_id = match sheet_id {
                Some(id) => {
                    crate::routes::pallet_sheets::check_sheet(conn, "palletSheetTemplateId", id)
                        .await?;
                    Some(id.to_owned())
                }
                None => {
                    crate::routes::pallet_sheets::default_sheet_for_product(conn, product_id)
                        .await?
                }
            };
            Ok(Some(Pallets {
                box_capacity: box_capacity.unwrap_or(product.pallet_box_capacity),
                template_id: template_id.to_owned(),
                sheet_id,
            }))
        }
    }
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
    pub pallets: Option<Pallets>,
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
         pallet_box_capacity, pallet_template_id, pallet_sheet_template_id, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(shift.pallets.is_some())
    .bind(shift.product_id)
    .bind(shift.line_id)
    .bind(shift.counterparty_id)
    .bind(civil_text(shift.production_date))
    .bind(shift.planned_qty)
    .bind(shift.box_capacity)
    .bind(shift.box_template_id)
    .bind(shift.pallets.as_ref().map(|pallets| pallets.box_capacity))
    .bind(
        shift
            .pallets
            .as_ref()
            .map(|pallets| pallets.template_id.as_str()),
    )
    .bind(
        shift
            .pallets
            .as_ref()
            .and_then(|pallets| pallets.sheet_id.as_deref()),
    )
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

/// `conflict` on `shift_busy`: another station entered the shift (stage 2a
/// puts one device on a shift).
pub fn busy() -> ApiError {
    ApiError::conflict("shift_busy", "another station works on this shift")
}

/// `conflict` on `template_not_fit`: the planned shift's box template is
/// disabled now, or no longer covers the product's group.
pub fn template_not_fit() -> ApiError {
    ApiError::conflict(
        "template_not_fit",
        "the shift's box template no longer fits its product",
    )
}

/// `conflict` on `pallet_template_not_fit`: the planned shift's pallet
/// template is disabled now, or no longer covers the product's group.
pub fn pallet_template_not_fit() -> ApiError {
    ApiError::conflict(
        "pallet_template_not_fit",
        "the shift's pallet template no longer fits its product",
    )
}

/// The most bytes of snapshot text a shift keeps: the `CHECK` of `shifts` in
/// migration `0009` (`length(CAST(snapshot AS BLOB)) <= 327680`). Each layout
/// may be up to `validate::MAX_SPEC_BYTES` (256 KB), so a box layout and a
/// pallet layout together can exceed it; the entry answers
/// [`snapshot_too_large`] instead of failing the `CHECK` (a unit test ties
/// the two numbers).
pub const MAX_SNAPSHOT_BYTES: usize = 327_680;

/// `conflict` on `snapshot_too_large`: the shift's box and pallet layouts
/// together are more than a shift's snapshot keeps. The office can point the
/// planned shift at smaller templates.
pub fn snapshot_too_large() -> ApiError {
    ApiError::conflict(
        "snapshot_too_large",
        "the shift's label layouts together are too large to open it",
    )
}

/// Refuse a snapshot text of `len` bytes that the `CHECK` would not keep.
fn check_snapshot_len(len: usize) -> Result<(), ApiError> {
    if len > MAX_SNAPSHOT_BYTES {
        return Err(snapshot_too_large());
    }
    Ok(())
}

/// The text a shift stores as its snapshot, or [`snapshot_too_large`]. The
/// byte length of the `String` is what the `CHECK` measures of the text bound
/// to the column.
pub fn snapshot_text(snapshot: &ShiftSnapshot) -> Result<String, ApiError> {
    let text = serde_json::to_string(snapshot).map_err(ApiError::internal)?;
    check_snapshot_len(text.len())?;
    Ok(text)
}

/// A template as a shift freezes it: its name, revision and whole layout.
async fn frozen_template(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<ShiftSnapshotTemplate, ApiError> {
    let (name, spec, rev): (String, String, i64) =
        sqlx::query_as("SELECT name, spec, rev FROM label_templates WHERE id = ?")
            .bind(id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(ShiftSnapshotTemplate {
        id: id.to_owned(),
        name,
        rev,
        spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
    })
}

/// The snapshot a planned shift freezes when a station opens it: its product
/// (still active and not archived, or `product_inactive`), its box template
/// (still enabled and covering the product's group, or `template_not_fit`)
/// with the whole layout, with pallets its pallet template the same way
/// (`pallet_template_not_fit`), the issuer prefix of the organization's
/// current GLN, the counterparty's name, and (plan А4) the A4 sheet the shift
/// names and the organization's name, INN and print logo.
///
/// The sheet is frozen as it is now, enabled or not (turning a sheet off only
/// stops new shifts from choosing it). A sheet that is not there (the API
/// never deletes one a planned shift names) is frozen as none rather than
/// refusing the entry: the shift still prints its thermal pallet labels.
pub async fn snapshot(
    conn: &mut SqliteConnection,
    product_id: &str,
    template_id: &str,
    pallet_template_id: Option<&str>,
    counterparty_id: Option<&str>,
    pallet_sheet_id: Option<&str>,
) -> Result<ShiftSnapshot, ApiError> {
    type ProductRow = (
        String,
        String,
        Option<String>,
        Option<u32>,
        Option<u32>,
        String,
        bool,
    );
    let product: Option<ProductRow> = sqlx::query_as(
        "SELECT gtin14, name, print_name, chz_group_code, shelf_life_days, status, archived \
         FROM products WHERE id = ?",
    )
    .bind(product_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let (gtin14, name, print_name, group, shelf_life_days, status, archived) =
        product.ok_or_else(|| ApiError::internal("the shift's product vanished"))?;
    let group = match (status.parse::<ProductStatus>(), archived, group) {
        (Ok(ProductStatus::Active), false, Some(group)) => group,
        _ => return Err(product_inactive()),
    };
    match templates::scope(conn, template_id).await? {
        Some(scope) if templates::fits(&scope, TemplatePurpose::Box, Some(group)) => {}
        _ => return Err(template_not_fit()),
    }
    if let Some(pallet_template_id) = pallet_template_id {
        match templates::scope(conn, pallet_template_id).await? {
            Some(scope) if templates::fits(&scope, TemplatePurpose::Pallet, Some(group)) => {}
            _ => return Err(pallet_template_not_fit()),
        }
    }
    let box_template = frozen_template(&mut *conn, template_id).await?;
    let pallet_template = match pallet_template_id {
        Some(id) => Some(frozen_template(&mut *conn, id).await?),
        None => None,
    };
    let gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let gln = gln.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let counterparty_name = match counterparty_id {
        Some(id) => Some(
            sqlx::query_scalar("SELECT name FROM counterparties WHERE id = ?")
                .bind(id)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?,
        ),
        None => None,
    };
    let pallet_sheet = match pallet_sheet_id {
        Some(id) => {
            let row: Option<(String, String, i64)> = sqlx::query_as(
                "SELECT name, spec, revision FROM pallet_sheet_templates WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            match row {
                Some((name, spec, revision)) => Some(ShiftSnapshotSheet {
                    id: id.to_owned(),
                    name,
                    revision,
                    spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
                }),
                None => None,
            }
        }
        None => None,
    };
    let (org_name, org_inn): (String, Option<String>) =
        sqlx::query_as("SELECT name, inn FROM org_profile WHERE id = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let logo = crate::routes::org_logo::read_logo(&mut *conn)
        .await?
        .map(|logo| ShiftSnapshotLogo {
            width: logo.width,
            height: logo.height,
            pixels_base64: logo.pixels_base64,
        });
    Ok(ShiftSnapshot {
        product: ShiftSnapshotProduct {
            id: product_id.to_owned(),
            gtin14,
            name,
            print_name,
            chz_product_group_code: group,
            shelf_life_days,
            egais_code: None,
        },
        box_template,
        issuer_prefix: crate::validate::issuer_prefix(&gln).to_owned(),
        counterparty_name,
        pallet_template,
        pallet_sheet,
        organization: Some(ShiftSnapshotOrganization {
            name: org_name,
            inn: org_inn,
            logo,
        }),
    })
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::{check_snapshot_len, snapshot_text, MAX_SNAPSHOT_BYTES};
    use markiro_proto::{
        ShiftSnapshot, ShiftSnapshotLogo, ShiftSnapshotOrganization, ShiftSnapshotProduct,
        ShiftSnapshotSheet, ShiftSnapshotTemplate,
    };

    fn snapshot(filler: usize) -> ShiftSnapshot {
        ShiftSnapshot {
            product: ShiftSnapshotProduct {
                id: "p".to_owned(),
                gtin14: "04600682000013".to_owned(),
                name: "Молоко".to_owned(),
                print_name: None,
                chz_product_group_code: 8,
                shelf_life_days: None,
                egais_code: None,
            },
            box_template: ShiftSnapshotTemplate {
                id: "t".to_owned(),
                name: "Короб".to_owned(),
                rev: 2,
                spec: serde_json::json!({ "f": "x".repeat(filler) }),
            },
            issuer_prefix: "460068200".to_owned(),
            counterparty_name: None,
            pallet_template: None,
            pallet_sheet: None,
            organization: None,
        }
    }

    /// The table's `CHECK` and the host's bound are one number.
    #[test]
    fn the_bound_is_the_check_of_the_shifts_table() {
        let migration = include_str!("../migrations/0009_shifts_sscc_blocks.sql");
        assert!(
            migration.contains(&format!(
                "length(CAST(snapshot AS BLOB)) <= {MAX_SNAPSHOT_BYTES}"
            )),
            "0009 does not keep {MAX_SNAPSHOT_BYTES} bytes of snapshot"
        );
    }

    #[test]
    fn a_snapshot_of_exactly_the_bound_is_kept_and_one_byte_more_is_not() {
        assert!(check_snapshot_len(MAX_SNAPSHOT_BYTES).is_ok());
        let refused = check_snapshot_len(MAX_SNAPSHOT_BYTES + 1).unwrap_err();
        assert_eq!(
            (
                refused.status(),
                refused.code(),
                refused.details().unwrap()["constraint"].as_str()
            ),
            (StatusCode::CONFLICT, "conflict", Some("snapshot_too_large"))
        );
    }

    /// The sheet and the organization's logo count against the bound like a
    /// layout does (plan А4): the whole snapshot text is measured.
    #[test]
    fn the_sheet_and_the_logo_are_measured_with_the_rest() {
        let mut full = snapshot(0);
        full.pallet_sheet = Some(ShiftSnapshotSheet {
            id: "s".to_owned(),
            name: "Лист".to_owned(),
            revision: 1,
            spec: serde_json::json!({ "f": "" }),
        });
        full.organization = Some(ShiftSnapshotOrganization {
            name: "ООО".to_owned(),
            inn: None,
            logo: Some(ShiftSnapshotLogo {
                width: 8,
                height: 1,
                pixels_base64: String::new(),
            }),
        });
        let base = snapshot_text(&full).unwrap().len();
        let room = MAX_SNAPSHOT_BYTES - base;
        // The filler goes in the sheet, then in the logo's bits: each is
        // kept up to the bound and refused one byte past it.
        let mut in_sheet = full.clone();
        in_sheet.pallet_sheet.as_mut().unwrap().spec = serde_json::json!({ "f": "x".repeat(room) });
        assert_eq!(snapshot_text(&in_sheet).unwrap().len(), MAX_SNAPSHOT_BYTES);
        in_sheet.pallet_sheet.as_mut().unwrap().spec =
            serde_json::json!({ "f": "x".repeat(room + 1) });
        assert_eq!(snapshot_text(&in_sheet).unwrap_err().code(), "conflict");
        let mut in_logo = full.clone();
        in_logo
            .organization
            .as_mut()
            .unwrap()
            .logo
            .as_mut()
            .unwrap()
            .pixels_base64 = "A".repeat(room);
        assert_eq!(snapshot_text(&in_logo).unwrap().len(), MAX_SNAPSHOT_BYTES);
        in_logo
            .organization
            .as_mut()
            .unwrap()
            .logo
            .as_mut()
            .unwrap()
            .pixels_base64 = "A".repeat(room + 1);
        assert_eq!(snapshot_text(&in_logo).unwrap_err().code(), "conflict");
    }

    /// The text is measured in bytes, as the `CHECK` does: a layout of
    /// two-byte letters is counted twice.
    #[test]
    fn the_snapshot_text_is_measured_in_bytes_of_the_text_it_returns() {
        let base = snapshot_text(&snapshot(0)).unwrap().len();
        let room = MAX_SNAPSHOT_BYTES - base;
        let exact = snapshot_text(&snapshot(room)).unwrap();
        assert_eq!(exact.len(), MAX_SNAPSHOT_BYTES);
        let refused = snapshot_text(&snapshot(room + 1)).unwrap_err();
        assert_eq!(refused.code(), "conflict");
        // Fewer characters than the room, more bytes.
        let mut wide = snapshot(0);
        wide.box_template.spec = serde_json::json!({ "f": "я".repeat(room / 2 + 1) });
        let wide = snapshot_text(&wide).unwrap_err();
        assert_eq!(wide.code(), "conflict");
    }
}
