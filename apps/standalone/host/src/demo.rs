//! Demo data (spec `2026-10-21-standalone-wizard-demo-data-design`): the wizard's demo product,
//! the SSCC counters of the demo prefix and a planned demo shift on the first line, made in the
//! wizard's own transaction and revision. A shift is a demo shift when its product is
//! (`products.demo`); its number comes from the `DEMO` counter and its SSCCs from the demo
//! prefix, so nothing of the organization's numbering is spent.

use markiro_proto::{ShiftMode, ShiftOrigin, ValidationPrint};
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::shifts::{self, NewShift, Pallets};

/// A GS1 restricted-circulation GTIN (prefix 2): it belongs to no real product.
pub const DEMO_GTIN: &str = "02900000000018";
pub const DEMO_NAME: &str = "Демо: вода питьевая 0,5 л";
/// ЧЗ group 13, «Упакованная вода».
pub const DEMO_GROUP: u32 = 13;
pub const DEMO_BOX_CAPACITY: u32 = 5;
pub const DEMO_PALLET_BOX_CAPACITY: u32 = 2;
pub const DEMO_SHELF_LIFE_DAYS: u32 = 365;
pub const DEMO_PLANNED_QTY: u32 = 20;
/// The SSCC issuer prefix of demo boxes and pallets (decision О4, option В): a
/// restricted-circulation number, no company's prefix.
pub const DEMO_PREFIX: &str = "290000000";
/// The shift-number key of demo shifts: `DEMO-001` (decision Д3).
pub const DEMO_NUMBER_KEY: &str = "DEMO";
/// The demo product's photo, drawn in code (`demo-product.png`).
pub const DEMO_PHOTO: &[u8] = include_bytes!("../assets/demo-product.png");
pub const DEMO_PHOTO_WIDTH: u32 = 480;
pub const DEMO_PHOTO_HEIGHT: u32 = 480;

/// What the wizard's transaction already made that the demo set needs.
pub struct Wizard<'a> {
    pub admin_id: &'a str,
    pub first_line_id: &'a str,
    pub box_template_id: &'a str,
    pub pallet_template_id: &'a str,
    pub production_date: time::Date,
    pub at: &'a str,
    pub rev: i64,
}

/// Whether the product is the demo product; an unknown id is no demo.
pub async fn is_demo_product(conn: &mut SqliteConnection, id: &str) -> Result<bool, ApiError> {
    let demo: Option<bool> = sqlx::query_scalar("SELECT demo FROM products WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(demo.unwrap_or(false))
}

/// Whether the demo data is there: the demo product exists.
pub async fn present(conn: &mut SqliteConnection) -> Result<bool, ApiError> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM products WHERE demo = 1)")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)
}

/// Whether the shift's product is the demo product; an unknown shift is no demo.
pub async fn is_demo_shift(conn: &mut SqliteConnection, id: &str) -> Result<bool, ApiError> {
    let demo: Option<bool> = sqlx::query_scalar(
        "SELECT p.demo FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(demo.unwrap_or(false))
}

/// `conflict` on `demo_product`: the demo product is read-only (an edit could give it a real
/// GTIN and hide real production from the exports).
pub fn demo_product() -> ApiError {
    ApiError::conflict(
        "demo_product",
        "the demo product is read-only; «Удалить демо-данные» removes it",
    )
}

/// `conflict` on `demo_shift`: a demo shift goes into no document for ГИС МТ.
pub fn demo_shift() -> ApiError {
    ApiError::conflict(
        "demo_shift",
        "a demo shift goes into no document for ГИС МТ",
    )
}

/// The demo set: the product with its photo, the demo prefix's counters and the planned shift;
/// returns the product's id.
pub async fn create(conn: &mut SqliteConnection, wizard: &Wizard<'_>) -> Result<String, ApiError> {
    let product_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
         pallet_box_capacity, shelf_life_days, archived, demo, photo_rev, rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)",
    )
    .bind(&product_id)
    .bind(DEMO_GTIN)
    .bind(DEMO_NAME)
    .bind(DEMO_NAME)
    .bind(DEMO_GROUP)
    .bind(DEMO_BOX_CAPACITY)
    .bind(DEMO_PALLET_BOX_CAPACITY)
    .bind(DEMO_SHELF_LIFE_DAYS)
    .bind(wizard.rev)
    .bind(wizard.rev)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO product_photos (product_id, width, height, data, checksum, updated_at, media_type) \
         VALUES (?, ?, ?, ?, ?, ?, 'image/png')",
    )
    .bind(&product_id)
    .bind(DEMO_PHOTO_WIDTH)
    .bind(DEMO_PHOTO_HEIGHT)
    .bind(DEMO_PHOTO)
    .bind(crate::backup::identity::sha256_hex(DEMO_PHOTO))
    .bind(wizard.at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    for extension in [0_i64, 1] {
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?)",
        )
        .bind(DEMO_PREFIX)
        .bind(extension)
        // The first serial of each extension, as the wizard's defaults (`validate::sscc_serial`).
        .bind(if extension == 0 { 1_i64 } else { 0 })
        .bind(wizard.rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    shifts::insert(
        conn,
        &NewShift {
            origin: ShiftOrigin::Office,
            mode: ShiftMode::Aggregation,
            created_by: wizard.admin_id,
            request_id: None,
            product_id: &product_id,
            line_id: wizard.first_line_id,
            counterparty_id: None,
            production_date: wizard.production_date,
            planned_date: wizard.production_date,
            planned_qty: Some(DEMO_PLANNED_QTY),
            box_capacity: DEMO_BOX_CAPACITY,
            box_template_id: wizard.box_template_id,
            pallets: Some(Pallets {
                box_capacity: DEMO_PALLET_BOX_CAPACITY,
                template_id: wizard.pallet_template_id.to_owned(),
                sheet_id: None,
            }),
            validation_print: &ValidationPrint::None {},
        },
        wizard.at,
        wizard.rev,
    )
    .await?;
    Ok(product_id)
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::*;

    #[test]
    fn the_demo_photo_is_one_the_office_could_upload() {
        let base64 = base64::engine::general_purpose::STANDARD.encode(DEMO_PHOTO);
        let (bytes, media_type) =
            crate::validate::product_photo(DEMO_PHOTO_WIDTH, DEMO_PHOTO_HEIGHT, &base64).unwrap();
        assert_eq!((bytes.len(), media_type), (DEMO_PHOTO.len(), "image/png"));
        // The PNG's own header says 480 × 480.
        assert_eq!(&DEMO_PHOTO[16..24], &[0, 0, 1, 224, 0, 0, 1, 224]);
    }

    #[test]
    fn the_demo_gtin_and_prefix_are_of_restricted_circulation() {
        assert!(crate::validate::gtin14("gtin14", DEMO_GTIN).is_ok());
        assert!(DEMO_GTIN.starts_with("02"));
        assert!(DEMO_PREFIX.starts_with('2') && DEMO_PREFIX.len() == 9);
    }
}
