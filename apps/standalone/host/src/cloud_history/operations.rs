//! Imported pack operations run under the native disaggregation writer lock.
use crate::{
    disaggregation::{classify, Applied, Target},
    error::ApiError,
};
use sqlx::SqliteConnection;

pub async fn resolve(conn: &mut SqliteConnection, sscc: &str) -> Result<Option<Target>, ApiError> {
    type Row = (
        String,
        bool,
        bool,
        bool,
        Option<String>,
        Option<String>,
        i64,
    );
    let row:Option<Row>=sqlx::query_as("SELECT x.id,x.closed_at IS NOT NULL,1,x.disassembled_at IS NOT NULL,s.product_id,json_extract(s.source_json,'$.productName'),(SELECT COUNT(*) FROM cloud_history_items i WHERE i.box_id=x.id AND i.removed_at IS NULL) FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' JOIN cloud_history_shifts s ON s.id=x.shift_id WHERE x.sscc=?")
        .bind(sscc).fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
    if let Some((id, closed, shift_closed, disassembled, product_id, product_name, code_count)) =
        row
    {
        return Ok(Some(Target {
            warehouse_pallet_id: None,
            box_id: Some(id),
            pallet_id: None,
            status: classify(closed, shift_closed, disassembled),
            product_id,
            product_name,
            code_count,
            cloud: true,
        }));
    }
    let row:Option<Row>=sqlx::query_as("SELECT p.id,p.closed_at IS NOT NULL,1,p.disassembled_at IS NOT NULL,p.product_id,p.product_name,(SELECT COUNT(*) FROM cloud_history_boxes x JOIN cloud_history_items i ON i.box_id=x.id AND i.removed_at IS NULL WHERE x.pallet_id=p.id) FROM cloud_history_pallets p JOIN cloud_history_batches b ON b.id=p.batch_id AND b.status='complete' LEFT JOIN cloud_history_shifts s ON s.id=p.shift_id WHERE p.sscc=?")
        .bind(sscc).fetch_optional(conn).await.map_err(ApiError::internal)?;
    Ok(row.map(
        |(id, closed, shift_closed, disassembled, product_id, product_name, code_count)| Target {
            warehouse_pallet_id: None,
            box_id: None,
            pallet_id: Some(id),
            status: classify(closed, shift_closed, disassembled),
            product_id,
            product_name,
            code_count,
            cloud: true,
        },
    ))
}

pub async fn apply_target(
    conn: &mut SqliteConnection,
    document_id: &str,
    target: &Target,
    instant: &str,
    at: &str,
    rev: i64,
) -> Result<Applied, ApiError> {
    let mut applied = Applied::default();
    if let Some(id) = &target.box_id {
        // Re-read each membership and its exact current owner under the writer lock.
        let mismatch:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_history_items i JOIN cloud_history_boxes x ON x.id=i.box_id LEFT JOIN cloud_history_owners o ON o.hash=i.hash AND o.box_id=x.id AND o.shift_id=x.shift_id AND o.batch_id=x.batch_id AND o.released_at IS NULL WHERE x.id=? AND i.removed_at IS NULL AND o.hash IS NULL)")
            .bind(id).fetch_one(&mut *conn).await.map_err(ApiError::internal)?;
        if mismatch {
            return Err(ApiError::conflict(
                "history_owner_mismatch",
                "imported ownership no longer matches this pack",
            ));
        }
        let shift:String=sqlx::query_scalar("UPDATE cloud_history_boxes SET disassembled_at=?1,locally_disassembled_at=?1 WHERE id=?2 AND disassembled_at IS NULL AND batch_id IN(SELECT id FROM cloud_history_batches WHERE status='complete') RETURNING shift_id")
            .bind(instant).bind(id).fetch_one(&mut *conn).await.map_err(ApiError::internal)?;
        let taken=sqlx::query("UPDATE cloud_history_owners SET released_at=?1 WHERE box_id=?2 AND shift_id=?3 AND released_at IS NULL AND hash IN(SELECT hash FROM cloud_history_items WHERE box_id=?2 AND removed_at IS NULL)")
            .bind(instant).bind(id).bind(&shift).execute(&mut *conn).await.map_err(ApiError::internal)?.rows_affected();
        sqlx::query(
            "UPDATE cloud_history_items SET removed_at=? WHERE box_id=? AND removed_at IS NULL",
        )
        .bind(instant)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        sqlx::query("INSERT INTO cloud_history_releases(box_id,shift_id,document_id,code_count,released_at,rev) VALUES(?,?,?,?,?,?)")
            .bind(id).bind(&shift).bind(document_id).bind(taken as i64).bind(instant).bind(rev).execute(&mut *conn).await.map_err(ApiError::internal)?;
        sqlx::query(
            "UPDATE cloud_history_shifts SET late_data_at=COALESCE(late_data_at,?) WHERE id=?",
        )
        .bind(at)
        .bind(&shift)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        applied.boxes = 1;
        applied.codes = taken as usize;
    } else if let Some(id) = &target.pallet_id {
        let updated=sqlx::query("UPDATE cloud_history_pallets SET disassembled_at=? WHERE id=? AND disassembled_at IS NULL AND batch_id IN(SELECT id FROM cloud_history_batches WHERE status='complete')")
            .bind(instant).bind(id).execute(&mut *conn).await.map_err(ApiError::internal)?;
        if updated.rows_affected() != 1 {
            return Err(super::conflict("history_pack_state"));
        }
        sqlx::query("UPDATE cloud_history_shifts SET late_data_at=COALESCE(late_data_at,?1) WHERE id IN(SELECT shift_id FROM cloud_history_boxes WHERE pallet_id=?2 UNION SELECT shift_id FROM cloud_history_pallets WHERE id=?2)")
            .bind(at).bind(id).execute(&mut *conn).await.map_err(ApiError::internal)?;
        applied.pallets = 1;
    }
    Ok(applied)
}
