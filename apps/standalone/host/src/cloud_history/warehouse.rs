//! Warehouse label reprint of what the cloud history import brought (plan
//! СКЛ on plan ИМП). The lookup of `routes/warehouse.rs` answers a unit, a
//! box or a pallet from the native tables first and, when it has none, from
//! the completed history batch, in the same [`WarehouseSource`] shape: the
//! station renders and prints it as it prints a native one.
//!
//! What an imported label is made of, and what it refuses:
//!
//! - the record's own facts as the export carried them: the shift's number
//!   and production date, the counterparty's name, the GTIN and shelf life,
//!   the SSCC, the counts (a box's units, a pallet's boxes and units, not
//!   taken apart now), the instant (a unit's scan, a box's or a pallet's
//!   close) and a unit's full canonical code. None of them is recalculated;
//! - the product's print name, ЧЗ group and EGAIS code, which the export does
//!   not carry, from the catalog as it is now (the product by the export's
//!   id, else the active product of the same GTIN). The print name is kept
//!   only while the catalog still names the product as the export did;
//! - no operator and no station: `operator_name` is empty and `device_id` is
//!   the nil UUID, `imported` is set.
//!
//! A record without a fact a label cannot be printed without is refused with
//! a reason, never printed with a guess: no shift in the export
//! (`imported_no_shift`: an owner-only code, or a warehouse pallet, which has
//! no shift), no production date (`imported_no_production_date`), no product
//! with a ЧЗ group in the catalog (`imported_product_unknown`). A released
//! code and a taken-apart box or pallet are as unavailable as a native one.
//! Only a completed batch is read; a pending one is not found. Nothing here
//! writes.

use markiro_proto::{
    ShiftSnapshotProduct, WarehouseLookupResult, WarehouseSource, WarehouseSubjectKind,
    WarehouseUnavailable,
};
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// What an imported record has instead of a station.
pub const NIL_DEVICE_ID: &str = "00000000-0000-0000-0000-000000000000";

/// An imported unit by the hash of its code: its owner (`released_at` set once
/// an exception or a disaggregation freed it), the code the owner's shift
/// holds in full, and the shift's facts.
pub const UNIT_SQL: &str = "SELECT o.shift_id, o.scanned_at, o.released_at, c.canonical, \
     s.id FROM cloud_history_owners o \
     JOIN cloud_history_batches b ON b.id = o.batch_id AND b.status = 'complete' \
     LEFT JOIN cloud_history_codes c ON c.hash = o.hash AND c.shift_id = o.shift_id \
     AND c.flat_only = 0 LEFT JOIN cloud_history_shifts s ON s.id = o.shift_id \
     WHERE o.hash = ?";

/// An imported box by its SSCC, with the units it holds now.
pub const BOX_SQL: &str = "SELECT x.id, x.shift_id, x.closed_at, x.disassembled_at, \
     (SELECT COUNT(*) FROM cloud_history_items i WHERE i.box_id = x.id AND i.removed_at IS NULL) \
     FROM cloud_history_boxes x \
     JOIN cloud_history_batches b ON b.id = x.batch_id AND b.status = 'complete' \
     WHERE x.sscc = ?";

/// An imported pallet by its SSCC: the boxes it holds (closed, not taken
/// apart) and their units.
pub const PALLET_SQL: &str = "SELECT p.id, p.shift_id, p.closed_at, p.disassembled_at, \
     (SELECT COUNT(*) FROM cloud_history_boxes x WHERE x.pallet_id = p.id \
     AND x.closed_at IS NOT NULL AND x.disassembled_at IS NULL), \
     (SELECT COUNT(*) FROM cloud_history_boxes x JOIN cloud_history_items i ON i.box_id = x.id \
     AND i.removed_at IS NULL WHERE x.pallet_id = p.id AND x.closed_at IS NOT NULL \
     AND x.disassembled_at IS NULL) \
     FROM cloud_history_pallets p \
     JOIN cloud_history_batches b ON b.id = p.batch_id AND b.status = 'complete' \
     WHERE p.sscc = ?";

/// The imported shift a label's facts come from.
pub const SHIFT_SQL: &str = "SELECT number, production_date, product_id, gtin14, shelf_life_days, \
     json_extract(source_json, '$.productName'), json_extract(source_json, '$.counterpartyName') \
     FROM cloud_history_shifts WHERE id = ?";

/// The catalog's product of an imported one: by id, else the active one of
/// the same GTIN.
pub const PRODUCT_BY_ID_SQL: &str =
    "SELECT id, name, print_name, chz_group_code, egais_code FROM products WHERE id = ?";
pub const PRODUCT_BY_GTIN_SQL: &str = "SELECT id, name, print_name, chz_group_code, egais_code \
     FROM products WHERE gtin14 = ? AND archived = 0";

/// An imported unit (by its owner), box or pallet record a reprint names, by
/// id and identity together; a unit's id is the hash of its code.
pub const UNIT_EXISTS_SQL: &str = "SELECT 1 FROM cloud_history_owners o \
     JOIN cloud_history_batches b ON b.id = o.batch_id AND b.status = 'complete' \
     WHERE o.hash = ? AND o.hash = ?";
pub const BOX_EXISTS_SQL: &str = "SELECT 1 FROM cloud_history_boxes x \
     JOIN cloud_history_batches b ON b.id = x.batch_id AND b.status = 'complete' \
     WHERE x.id = ? AND x.sscc = ?";
pub const PALLET_EXISTS_SQL: &str = "SELECT 1 FROM cloud_history_pallets x \
     JOIN cloud_history_batches b ON b.id = x.batch_id AND b.status = 'complete' \
     WHERE x.id = ? AND x.sscc = ?";

fn unavailable(reason: WarehouseUnavailable) -> WarehouseLookupResult {
    WarehouseLookupResult::Unavailable { reason }
}

/// What a shift of the export gives every label of it.
struct ImportedShift {
    number: String,
    production_date: String,
    product: ShiftSnapshotProduct,
    counterparty_name: Option<String>,
}

/// The shift's facts, or the reason it cannot make a label.
async fn shift_part(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Result<ImportedShift, WarehouseUnavailable>, ApiError> {
    type ShiftRow = (
        String,
        Option<String>,
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
    );
    let row: Option<ShiftRow> = sqlx::query_as(SHIFT_SQL)
        .bind(shift_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((number, production_date, product_id, gtin14, shelf_life, name, counterparty)) = row
    else {
        return Ok(Err(WarehouseUnavailable::ImportedNoShift));
    };
    let Some(production_date) = production_date else {
        return Ok(Err(WarehouseUnavailable::ImportedNoProductionDate));
    };
    type ProductRow = (String, String, Option<String>, Option<u32>, Option<String>);
    let by_id: Option<ProductRow> = sqlx::query_as(PRODUCT_BY_ID_SQL)
        .bind(&product_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let local = match by_id {
        Some(local) => Some(local),
        None => sqlx::query_as(PRODUCT_BY_GTIN_SQL)
            .bind(&gtin14)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?,
    };
    let Some((local_id, local_name, local_print_name, Some(group), egais_code)) = local else {
        return Ok(Err(WarehouseUnavailable::ImportedProductUnknown));
    };
    let name = name.filter(|name| !name.trim().is_empty());
    // The export's name is the one the shift was printed with; the catalog's
    // print name goes with it only while the catalog still has that name.
    let print_name = match &name {
        Some(name) if *name != local_name => None,
        _ => local_print_name,
    };
    Ok(Ok(ImportedShift {
        number,
        production_date,
        product: ShiftSnapshotProduct {
            id: local_id,
            gtin14,
            name: name.unwrap_or(local_name),
            print_name,
            chz_product_group_code: group,
            shelf_life_days: shelf_life
                .map(u32::try_from)
                .transpose()
                .map_err(ApiError::internal)?,
            egais_code,
        },
        counterparty_name: counterparty,
    }))
}

#[allow(clippy::too_many_arguments)]
fn source(
    kind: WarehouseSubjectKind,
    subject_id: String,
    identity: &str,
    canonical: Option<String>,
    shift_id: String,
    shift: ImportedShift,
    at: String,
    item_count: u32,
    box_count: Option<u32>,
) -> WarehouseLookupResult {
    let sscc = match kind {
        WarehouseSubjectKind::Unit => None,
        WarehouseSubjectKind::Box | WarehouseSubjectKind::Pallet => Some(identity.to_owned()),
    };
    WarehouseLookupResult::Found {
        source: WarehouseSource {
            kind,
            subject_id,
            identity: identity.to_owned(),
            canonical,
            sscc,
            product: shift.product,
            counterparty_name: shift.counterparty_name,
            shift_id,
            shift_number: shift.number,
            production_date: shift.production_date,
            at,
            item_count,
            box_count,
            operator_name: None,
            device_id: NIL_DEVICE_ID.to_owned(),
            imported: true,
        },
    }
}

/// The imported unit of a code hash, `None` when the history has none.
pub async fn find_unit(
    conn: &mut SqliteConnection,
    code_hash: &str,
) -> Result<Option<WarehouseLookupResult>, ApiError> {
    type UnitRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<UnitRow> = sqlx::query_as(UNIT_SQL)
        .bind(code_hash)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((shift_id, scanned_at, released_at, canonical, shift_row)) = row else {
        return Ok(None);
    };
    if released_at.is_some() {
        return Ok(Some(unavailable(WarehouseUnavailable::Released)));
    }
    // An owner whose shift or code the export did not carry (an owner-only
    // row) has nothing to print.
    let (Some(canonical), Some(_)) = (canonical, shift_row) else {
        return Ok(Some(unavailable(WarehouseUnavailable::ImportedNoShift)));
    };
    Ok(Some(match shift_part(conn, &shift_id).await? {
        Ok(shift) => source(
            WarehouseSubjectKind::Unit,
            code_hash.to_owned(),
            code_hash,
            Some(canonical),
            shift_id,
            shift,
            scanned_at,
            1,
            None,
        ),
        Err(reason) => unavailable(reason),
    }))
}

/// The imported box or pallet of an SSCC, `None` when the history has none
/// (or has an SSCC that was never closed, which printed no label).
pub async fn find_sscc(
    conn: &mut SqliteConnection,
    sscc: &str,
) -> Result<Option<WarehouseLookupResult>, ApiError> {
    type BoxRow = (String, String, Option<String>, Option<String>, i64);
    let found: Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((id, shift_id, closed_at, disassembled_at, items)) = found {
        if disassembled_at.is_some() {
            return Ok(Some(unavailable(WarehouseUnavailable::Disassembled)));
        }
        let Some(at) = closed_at else {
            return Ok(None);
        };
        return Ok(Some(match shift_part(conn, &shift_id).await? {
            Ok(shift) => source(
                WarehouseSubjectKind::Box,
                id,
                sscc,
                None,
                shift_id,
                shift,
                at,
                u32::try_from(items).map_err(ApiError::internal)?,
                None,
            ),
            Err(reason) => unavailable(reason),
        }));
    }
    type PalletRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
    );
    let found: Option<PalletRow> = sqlx::query_as(PALLET_SQL)
        .bind(sscc)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some((id, shift_id, closed_at, disassembled_at, boxes, items)) = found else {
        return Ok(None);
    };
    if disassembled_at.is_some() {
        return Ok(Some(unavailable(WarehouseUnavailable::Disassembled)));
    }
    let Some(at) = closed_at else {
        return Ok(None);
    };
    // A warehouse pallet belongs to no shift: no date, number or operator.
    let Some(shift_id) = shift_id else {
        return Ok(Some(unavailable(WarehouseUnavailable::ImportedNoShift)));
    };
    Ok(Some(match shift_part(conn, &shift_id).await? {
        Ok(shift) => source(
            WarehouseSubjectKind::Pallet,
            id,
            sscc,
            None,
            shift_id,
            shift,
            at,
            u32::try_from(items).map_err(ApiError::internal)?,
            Some(u32::try_from(boxes).map_err(ApiError::internal)?),
        ),
        Err(reason) => unavailable(reason),
    }))
}
