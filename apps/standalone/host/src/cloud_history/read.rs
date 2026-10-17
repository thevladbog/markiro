//! Completed history only. Callers hold one read transaction for the whole source.
use crate::error::ApiError;
use markiro_proto::cloud_history::{CloudHistoryManifest, CloudHistoryShift, CloudShiftCard};
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRows, ShiftStatus,
};
use sqlx::SqliteConnection;

/// A card read always has exactly one scope, so SQLite can seek its lookup index.
#[derive(Debug, Clone, Copy)]
pub enum BoxCardScope<'a> {
    Box(&'a str),
    Shift(&'a str),
    Pallet(&'a str),
}
impl<'a> BoxCardScope<'a> {
    /// The production statement, also used by query-plan regression tests.
    pub fn sql(self) -> String {
        let predicate = match self {
            Self::Box(_) => "x.id=?",
            Self::Shift(_) => "x.shift_id=?",
            Self::Pallet(_) => "x.pallet_id=?",
        };
        format!("{BOX_CARDS_SELECT} WHERE {predicate} ORDER BY x.closed_at,x.id")
    }
    pub fn id(self) -> &'a str {
        match self {
            Self::Box(id) | Self::Shift(id) | Self::Pallet(id) => id,
        }
    }
}

const BOX_CARDS_SELECT: &str = "SELECT x.id,x.shift_id,x.sscc,x.opened_at,x.closed_at,x.disassembled_at,x.pallet_id,s.number,json_extract(s.source_json,'$.productName') AS product_name,s.production_date,json_extract(b.manifest,'$.organization.timeZone') AS source_time_zone,(SELECT COUNT(*) FROM cloud_history_items i WHERE i.box_id=x.id AND i.removed_at IS NULL) AS units FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' JOIN cloud_history_shifts s ON s.id=x.shift_id";

pub async fn box_cards(
    conn: &mut SqliteConnection,
    scope: BoxCardScope<'_>,
) -> Result<Vec<markiro_proto::cloud_history::CloudBoxCard>, ApiError> {
    use markiro_proto::cloud_history::{CloudBoxCard, CloudHistoryBox};
    #[derive(sqlx::FromRow)]
    struct Row {
        id: String,
        shift_id: String,
        sscc: Option<String>,
        opened_at: String,
        closed_at: Option<String>,
        disassembled_at: Option<String>,
        pallet_id: Option<String>,
        number: String,
        product_name: Option<String>,
        production_date: Option<String>,
        units: i64,
        source_time_zone: String,
    }
    let rows: Vec<Row> = sqlx::query_as(&scope.sql())
        .bind(scope.id())
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(rows
        .into_iter()
        .map(|x| CloudBoxCard {
            pack: CloudHistoryBox {
                id: x.id,
                shift_id: x.shift_id,
                sscc: x.sscc,
                opened_at: x.opened_at,
                closed_at: x.closed_at,
                disassembled_at: x.disassembled_at,
                pallet_id: x.pallet_id,
            },
            shift_number: x.number,
            product_name: x.product_name,
            production_date: x.production_date,
            units: x.units as u64,
            source_time_zone: x.source_time_zone,
        })
        .collect())
}

pub async fn pallet_rows(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<markiro_proto::cloud_history::CloudPalletRows>, ApiError> {
    use markiro_proto::cloud_history::{CloudHistoryPallet, CloudPalletRows};
    // SQLite JSON preserves the nullable frozen product fields, without a current catalog join.
    let raw:Option<String>=sqlx::query_scalar("SELECT json_object('id',p.id,'shiftId',p.shift_id,'kind',p.kind,'productId',p.product_id,'productName',p.product_name,'gtin14',p.gtin14,'shelfLifeDays',p.shelf_life_days,'sscc',p.sscc,'openedAt',p.opened_at,'closedAt',p.closed_at,'disassembledAt',p.disassembled_at) FROM cloud_history_pallets p JOIN cloud_history_batches b ON b.id=p.batch_id AND b.status='complete' WHERE p.id=?")
        .bind(id).fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
    let Some(raw) = raw else { return Ok(None) };
    let pallet: CloudHistoryPallet = serde_json::from_str(&raw).map_err(ApiError::internal)?;
    Ok(Some(CloudPalletRows {
        pallet,
        organization: organization(&mut *conn).await?,
        boxes: box_cards(conn, BoxCardScope::Pallet(id)).await?,
    }))
}

pub async fn box_report(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<markiro_proto::BoxReportRows>, ApiError> {
    use markiro_proto::{BoxReportItem, BoxReportRows};
    let Some(card) = box_cards(&mut *conn, BoxCardScope::Box(id)).await?.pop() else {
        return Ok(None);
    };
    let local: Option<String> =
        sqlx::query_scalar("SELECT locally_disassembled_at FROM cloud_history_boxes WHERE id=?")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if card.pack.disassembled_at.is_some() && local.is_none() {
        return Err(ApiError::conflict(
            "history_composition_unavailable",
            "the original disassembled composition was not included in the source",
        ));
    }
    let items:Vec<(String,String,String)>=sqlx::query_as("SELECT c.gtin14,c.serial,c.canonical FROM cloud_history_items i JOIN cloud_history_boxes x ON x.id=i.box_id JOIN cloud_history_codes c ON c.shift_id=x.shift_id AND c.hash=i.hash JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.id=? AND (i.removed_at IS NULL OR i.removed_at=x.locally_disassembled_at) ORDER BY c.gtin14,c.serial")
        .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    Ok(Some(BoxReportRows {
        id: card.pack.id,
        shift_id: card.pack.shift_id,
        sscc: card.pack.sscc,
        opened_at: card.pack.opened_at,
        closed_at: card.pack.closed_at,
        disassembled_at: card.pack.disassembled_at,
        product_name: card.product_name,
        organization: organization(conn).await?,
        items: items
            .into_iter()
            .map(|(gtin14, serial, canonical)| BoxReportItem {
                gtin14,
                serial,
                canonical,
            })
            .collect(),
    }))
}

pub async fn shift(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<CloudHistoryShift>, ApiError> {
    let raw: Option<String> = sqlx::query_scalar("SELECT s.source_json FROM cloud_history_shifts s JOIN cloud_history_batches b ON b.id=s.batch_id AND b.status='complete' WHERE s.id=?")
        .bind(id).fetch_optional(conn).await.map_err(ApiError::internal)?;
    raw.map(|text| serde_json::from_str(&text).map_err(ApiError::internal))
        .transpose()
}

pub async fn organization(conn: &mut SqliteConnection) -> Result<ExportOrganization, ApiError> {
    let raw: String =
        sqlx::query_scalar("SELECT manifest FROM cloud_history_batches WHERE status='complete'")
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    let manifest: CloudHistoryManifest = serde_json::from_str(&raw).map_err(ApiError::internal)?;
    Ok(ExportOrganization {
        name: manifest.organization.name,
        inn: manifest.organization.inn,
        time_zone: Some(manifest.organization.time_zone),
    })
}

pub async fn card(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<CloudShiftCard>, ApiError> {
    let Some(shift) = shift(&mut *conn, id).await? else {
        return Ok(None);
    };
    let (codes,boxes,pallets,late): (i64,i64,i64,Option<String>) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM cloud_history_owners o WHERE o.shift_id=s.id AND o.released_at IS NULL),(SELECT COUNT(*) FROM cloud_history_boxes x WHERE x.shift_id=s.id),(SELECT COUNT(*) FROM cloud_history_pallets p WHERE p.shift_id=s.id),s.late_data_at FROM cloud_history_shifts s WHERE s.id=?")
        .bind(id).fetch_one(&mut *conn).await.map_err(ApiError::internal)?;
    let source_time_zone: String = sqlx::query_scalar("SELECT json_extract(manifest,'$.organization.timeZone') FROM cloud_history_batches WHERE status='complete'")
        .fetch_one(conn).await.map_err(ApiError::internal)?;
    Ok(Some(CloudShiftCard {
        source_time_zone,
        shift,
        code_count: codes as u64,
        box_count: boxes as u64,
        pallet_count: pallets as u64,
        late_data_at: late,
    }))
}

pub async fn export_rows(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<ShiftExportRows>, ApiError> {
    let Some(shift) = shift(&mut *conn, id).await? else {
        return Ok(None);
    };
    let date = shift
        .production_date
        .or(shift.planned_date)
        .ok_or_else(|| {
            ApiError::conflict(
                "SHIFT_DATE_MISSING",
                "cloud shift has no production or planned date",
            )
        })?;
    let organization = organization(&mut *conn).await?;
    let effective_operation_date_time = match &shift.closed_at {
        Some(closed_at) => closed_at.clone(),
        None => sqlx::query_scalar::<_, String>("SELECT json_extract(manifest,'$.exportedAt') FROM cloud_history_batches WHERE status='complete'")
            .fetch_one(&mut *conn).await.map_err(ApiError::internal)?,
    };
    let codes:Vec<(String,String,String,bool)> = sqlx::query_as("SELECT c.hash,c.scanned_at,c.canonical,c.flat_only FROM cloud_history_codes c JOIN cloud_history_batches b ON b.id=c.batch_id AND b.status='complete' LEFT JOIN cloud_history_owners o ON o.hash=c.hash AND o.shift_id=c.shift_id AND o.released_at IS NULL WHERE c.shift_id=? AND (c.flat_only=1 OR o.hash IS NOT NULL) ORDER BY c.scanned_at,c.hash")
        .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    type BoxRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let boxes:Vec<BoxRow>=sqlx::query_as("SELECT x.id,x.sscc,x.opened_at,x.closed_at,x.disassembled_at,x.pallet_id FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.shift_id=? ORDER BY x.opened_at,x.id")
        .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    let items:Vec<(String,String)>=sqlx::query_as("SELECT i.box_id,i.hash FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' JOIN cloud_history_items i ON i.box_id=x.id WHERE x.shift_id=? AND i.removed_at IS NULL ORDER BY i.box_id,i.hash")
        .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    type PalletRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let pallets:Vec<PalletRow>=sqlx::query_as("SELECT p.id,p.sscc,p.opened_at,p.closed_at,p.disassembled_at FROM cloud_history_pallets p JOIN cloud_history_batches b ON b.id=p.batch_id AND b.status='complete' WHERE p.shift_id=? ORDER BY p.opened_at,p.id")
        .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    let late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM cloud_history_shifts WHERE id=?")
            .bind(id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(Some(ShiftExportRows {
        shift: ExportShift {
            id: shift.id,
            number: shift.number,
            status: ShiftStatus::Closed,
            production_date: date,
            product_name: shift.product_name.unwrap_or_else(|| "Продукция".to_owned()),
            pallets_enabled: shift.pallets_enabled,
            closed_at: shift.closed_at,
            station_closed_at: None,
            effective_operation_date_time: Some(effective_operation_date_time),
            late_data_at: late,
        },
        organization,
        codes: codes
            .into_iter()
            .map(|(code_hash, scanned_at, canonical, flat_only)| ExportCode {
                code_hash,
                scanned_at,
                canonical,
                flat_only,
            })
            .collect(),
        boxes: boxes
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at, pallet_id)| ExportBox {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                    pallet_id,
                },
            )
            .collect(),
        items: items
            .into_iter()
            .map(|(box_id, code_hash)| ExportItem { box_id, code_hash })
            .collect(),
        pallets: pallets
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at)| ExportPallet {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                },
            )
            .collect(),
    }))
}
