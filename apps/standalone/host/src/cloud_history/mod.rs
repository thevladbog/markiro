//! Durable staging and atomic visibility. No imported row is a fabricated local production fact.
pub mod operations;
pub mod read;
pub mod validation;
use crate::error::ApiError;
use markiro_proto::{cloud_history::*, Secret};
use sqlx::{Row, SqliteConnection};

pub fn conflict(reason: &'static str) -> ApiError {
    ApiError::conflict(reason, "cloud history import cannot proceed")
}
fn write_error(e: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(
        e,
        "history_duplicate",
        "duplicate cloud history identity",
    )
}
pub async fn require_ready(conn: &mut SqliteConnection) -> Result<(), ApiError> {
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM cloud_history_batches WHERE status='pending') OR EXISTS(SELECT 1 FROM site WHERE replacement_pending=1)",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if pending {
        return Err(conflict("cloud_history_pending"));
    }
    Ok(())
}
/// Completed identities remain reserved even after disaggregation. A client-chosen
/// native id must never make saved-file targets or pack navigation ambiguous.
pub async fn reserved_identity(conn: &mut SqliteConnection, id: &str) -> Result<bool, ApiError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_history_shifts x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.id=?1 UNION ALL SELECT 1 FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.id=?1 UNION ALL SELECT 1 FROM cloud_history_pallets x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.id=?1)")
        .bind(id).fetch_one(conn).await.map_err(ApiError::internal)
}
/// Counters protect future allocation; this protects delayed facts from old blocks.
pub async fn reserved_sscc(conn: &mut SqliteConnection, sscc: &str) -> Result<bool, ApiError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.sscc=?1 UNION ALL SELECT 1 FROM cloud_history_pallets x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.sscc=?1)")
        .bind(sscc).fetch_one(conn).await.map_err(ApiError::internal)
}
pub async fn manifest(
    conn: &mut SqliteConnection,
) -> Result<Option<CloudHistoryManifest>, ApiError> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT manifest FROM cloud_history_batches WHERE singleton=1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    row.map(|s| {
        serde_json::from_str(&s).map_err(|_| ApiError::internal("invalid stored history manifest"))
    })
    .transpose()
}
pub async fn state(
    conn: &mut SqliteConnection,
) -> Result<Option<CloudHistoryImportState>, ApiError> {
    let Some(m) = manifest(conn).await? else {
        return Ok(None);
    };
    let status: String = sqlx::query_scalar("SELECT status FROM cloud_history_batches WHERE id=?")
        .bind(&m.checksum)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let indices: Vec<i64> = sqlx::query_scalar(
        "SELECT part_index FROM cloud_history_parts WHERE batch_id=? ORDER BY part_index",
    )
    .bind(&m.checksum)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let mut counts = CloudHistoryCounts::default();
    for index in &indices {
        let c = &m.parts[*index as usize].counts;
        counts.shifts += c.shifts;
        counts.codes += c.codes;
        counts.boxes += c.boxes;
        counts.items += c.items;
        counts.pallets += c.pallets;
        counts.owners += c.owners;
    }
    Ok(Some(CloudHistoryImportState {
        replacement_backup_file: sqlx::query_scalar(
            "SELECT replacement_backup_file FROM site WHERE id=1",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?,
        batch_id: m.checksum,
        source: m.source,
        status: if status == "complete" {
            CloudHistoryStatus::Complete
        } else {
            CloudHistoryStatus::Pending
        },
        received_indices: indices.into_iter().map(|v| v as u32).collect(),
        total_parts: m.parts.len() as u32,
        counts,
    }))
}
pub async fn require_site(
    conn: &mut SqliteConnection,
    m: &CloudHistoryManifest,
) -> Result<(), ApiError> {
    // A replacement precreates its exact history batch atomically with the
    // catalog. Cancel removes that batch but keeps the production hold: a
    // different ordinary history upload must not be able to release it.
    let canceled_replacement: bool = sqlx::query_scalar(
        "SELECT replacement_pending=1 AND NOT EXISTS(SELECT 1 FROM cloud_history_batches WHERE id=? AND status IN ('pending','complete')) FROM site WHERE id=1",
    )
    .bind(&m.checksum)
    .fetch_one(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if canceled_replacement {
        return Err(conflict("replacement_history_canceled"));
    }
    let source:Option<String>=sqlx::query_scalar("SELECT json_extract(details,'$.sourceTenantId') FROM audit_log WHERE action='import.cloud' AND result='ok' AND json_extract(details,'$.datasetEpoch') IS (SELECT dataset_epoch FROM site WHERE id=1) ORDER BY id LIMIT 1").fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
    if source.as_deref() != Some(&m.source.tenant_id) {
        return Err(conflict("history_source"));
    }
    let gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id=1")
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if gln.as_deref() != Some(&m.organization.gln) {
        return Err(conflict("org_gln"));
    }
    let occupied:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM shifts) OR EXISTS(SELECT 1 FROM code_owners) OR EXISTS(SELECT 1 FROM sscc_blocks) OR EXISTS(SELECT 1 FROM boxes) OR EXISTS(SELECT 1 FROM pallets) OR EXISTS(SELECT 1 FROM warehouse_pallets)").fetch_one(&mut *conn).await.map_err(ApiError::internal)?;
    if occupied {
        return Err(conflict("history_site_not_empty"));
    }
    Ok(())
}
pub async fn stage(
    conn: &mut SqliteConnection,
    r: &CloudHistoryImportRequest,
    at: &str,
) -> Result<(), ApiError> {
    let batch = &r.manifest.checksum;
    sqlx::query("INSERT INTO cloud_history_batches(id,singleton,manifest,status,created_at) VALUES(?,1,?,'pending',?) ON CONFLICT(id) DO NOTHING")
        .bind(batch).bind(serde_json::to_string(&r.manifest).map_err(ApiError::internal)?).bind(at).execute(&mut *conn).await.map_err(write_error)?;
    for s in &r.part.payload.shifts {
        sqlx::query("INSERT INTO cloud_history_shifts(id,batch_id,number,mode,production_date,closed_at,product_id,gtin14,in_window,shelf_life_days,source_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&s.id).bind(batch).bind(&s.number).bind(&s.mode).bind(&s.production_date).bind(&s.closed_at).bind(&s.product_id).bind(&s.gtin14).bind(s.in_window).bind(s.shelf_life_days.map(|n|n as i64))
            .bind(serde_json::to_string(s).map_err(ApiError::internal)?).execute(&mut *conn).await.map_err(write_error)?;
    }
    for c in &r.part.payload.codes {
        sqlx::query("INSERT INTO cloud_history_codes(batch_id,shift_id,hash,canonical,scanned_at,gtin14,serial,flat_only) VALUES(?,?,?,?,?,?,?,?)")
            .bind(batch).bind(&c.shift_id).bind(c.hash.expose()).bind(c.canonical.expose()).bind(&c.scanned_at).bind(&c.gtin14).bind(c.serial.as_ref().map(Secret::expose)).bind(c.flat_only).execute(&mut *conn).await.map_err(write_error)?;
    }
    for b in &r.part.payload.boxes {
        sqlx::query("INSERT INTO cloud_history_boxes(id,batch_id,shift_id,sscc,opened_at,closed_at,disassembled_at,pallet_id) VALUES(?,?,?,?,?,?,?,?)")
            .bind(&b.id).bind(batch).bind(&b.shift_id).bind(&b.sscc).bind(&b.opened_at).bind(&b.closed_at).bind(&b.disassembled_at).bind(&b.pallet_id).execute(&mut *conn).await.map_err(write_error)?;
    }
    for i in &r.part.payload.items {
        sqlx::query(
            "INSERT INTO cloud_history_items(batch_id,box_id,hash,added_at) VALUES(?,?,?,?)",
        )
        .bind(batch)
        .bind(&i.box_id)
        .bind(i.hash.expose())
        .bind(&i.added_at)
        .execute(&mut *conn)
        .await
        .map_err(write_error)?;
    }
    for p in &r.part.payload.pallets {
        sqlx::query("INSERT INTO cloud_history_pallets(id,batch_id,shift_id,kind,product_id,product_name,gtin14,shelf_life_days,sscc,opened_at,closed_at,disassembled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&p.id).bind(batch).bind(&p.shift_id).bind(&p.kind).bind(&p.product_id).bind(&p.product_name).bind(&p.gtin14).bind(p.shelf_life_days.map(|v|v as i64)).bind(&p.sscc).bind(&p.opened_at).bind(&p.closed_at).bind(&p.disassembled_at).execute(&mut *conn).await.map_err(write_error)?;
    }
    for o in &r.part.payload.owners {
        sqlx::query("INSERT INTO cloud_history_owners(hash,batch_id,shift_id,number,scanned_at,box_id) VALUES(?,?,?,?,?,?)")
            .bind(o.hash.expose()).bind(batch).bind(&o.shift_id).bind(&o.number).bind(&o.scanned_at).bind(&o.box_id).execute(&mut *conn).await.map_err(write_error)?;
    }
    sqlx::query(
        "INSERT INTO cloud_history_parts(batch_id,part_index,checksum,counts) VALUES(?,?,?,?)",
    )
    .bind(batch)
    .bind(i64::from(r.part.index))
    .bind(&r.part.checksum)
    .bind(serde_json::to_string(&r.part.payload.counts()).map_err(ApiError::internal)?)
    .execute(&mut *conn)
    .await
    .map_err(write_error)?;
    Ok(())
}
/// Set-based cross-part validation: all joins are indexed; no code rows are loaded into memory.
pub async fn validate_graph(
    conn: &mut SqliteConnection,
    m: &CloudHistoryManifest,
) -> Result<(), ApiError> {
    for (table, expected) in [
        ("cloud_history_shifts", m.counts.shifts),
        ("cloud_history_codes", m.counts.codes),
        ("cloud_history_boxes", m.counts.boxes),
        ("cloud_history_items", m.counts.items),
        ("cloud_history_pallets", m.counts.pallets),
        ("cloud_history_owners", m.counts.owners),
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE batch_id=?"))
                .bind(&m.checksum)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        if count as u64 != expected {
            return Err(conflict("history_counts"));
        }
    }
    for query in [
        // Every code belongs to an exported shift; reprocessing is validation-only.
        "SELECT 1 FROM cloud_history_codes c LEFT JOIN cloud_history_shifts s ON s.id=c.shift_id WHERE s.id IS NULL OR (c.flat_only=1 AND s.mode!='validation') OR (c.gtin14 IS NOT NULL AND c.gtin14!=s.gtin14) LIMIT 1",
        // Authoritative codes and owners match exactly. Old owner-only shifts need no report row.
        "SELECT 1 FROM cloud_history_codes c LEFT JOIN cloud_history_owners o ON o.hash=c.hash WHERE c.flat_only=0 AND (o.hash IS NULL OR o.shift_id!=c.shift_id OR o.scanned_at!=c.scanned_at) LIMIT 1",
        "SELECT 1 FROM cloud_history_owners o JOIN cloud_history_shifts s ON s.id=o.shift_id LEFT JOIN cloud_history_codes c ON c.hash=o.hash AND c.shift_id=o.shift_id AND c.flat_only=0 WHERE c.hash IS NULL OR s.number!=o.number OR c.scanned_at!=o.scanned_at LIMIT 1",
        "SELECT 1 FROM cloud_history_codes c JOIN cloud_history_owners o ON o.hash=c.hash WHERE c.flat_only=1 AND c.shift_id=o.shift_id LIMIT 1",
        "SELECT 1 FROM cloud_history_boxes b LEFT JOIN cloud_history_shifts s ON s.id=b.shift_id WHERE s.id IS NULL OR s.mode!='aggregation' LIMIT 1",
        "SELECT 1 FROM cloud_history_pallets p LEFT JOIN cloud_history_shifts s ON s.id=p.shift_id WHERE p.kind='production' AND (s.id IS NULL OR s.mode!='aggregation' OR json_extract(s.source_json,'$.palletsEnabled')!=1 OR (p.product_id IS NOT NULL AND p.product_id!=s.product_id)) LIMIT 1",
        // Cloud retains pallet_id after either endpoint is disassembled. It is
        // source provenance, not proof of live membership; readers/operations
        // use each endpoint's disassembly state. Endpoint/shift/product checks
        // still apply to that historical association.
        "SELECT 1 FROM cloud_history_boxes b LEFT JOIN cloud_history_pallets p ON p.id=b.pallet_id JOIN cloud_history_shifts s ON s.id=b.shift_id WHERE b.pallet_id IS NOT NULL AND (p.id IS NULL OR b.closed_at IS NULL OR (p.kind='production' AND p.shift_id!=b.shift_id) OR (p.kind='warehouse' AND p.product_id!=s.product_id)) LIMIT 1",
        "SELECT 1 FROM cloud_history_items i LEFT JOIN cloud_history_boxes b ON b.id=i.box_id LEFT JOIN cloud_history_owners o ON o.hash=i.hash WHERE b.id IS NULL OR b.disassembled_at IS NOT NULL OR o.hash IS NULL OR o.shift_id!=b.shift_id OR o.box_id IS NULL OR o.box_id!=i.box_id LIMIT 1",
        // External owner-only boxes are provenance, not report packs. Either imported
        // endpoint still requires exact membership (and the item rule checks its shift).
        "SELECT 1 FROM cloud_history_owners o LEFT JOIN cloud_history_items i ON i.hash=o.hash AND i.box_id=o.box_id LEFT JOIN cloud_history_shifts s ON s.id=o.shift_id LEFT JOIN cloud_history_boxes b ON b.id=o.box_id WHERE o.box_id IS NOT NULL AND i.hash IS NULL AND (s.id IS NOT NULL OR b.id IS NOT NULL) LIMIT 1",
        "SELECT 1 FROM cloud_history_owners GROUP BY shift_id HAVING MIN(number)!=MAX(number) LIMIT 1",
        "SELECT 1 FROM cloud_history_owners GROUP BY number HAVING MIN(shift_id)!=MAX(shift_id) LIMIT 1",
        "SELECT 1 FROM cloud_history_owners o JOIN cloud_history_shifts s ON s.number=o.number WHERE s.id!=o.shift_id LIMIT 1",
        // UUID and SSCC namespaces cannot collide, including warehouse pallets.
        "SELECT 1 FROM cloud_history_boxes b JOIN cloud_history_pallets p ON p.sscc=b.sscc OR p.id=b.id LIMIT 1",
        "SELECT 1 FROM cloud_history_shifts s JOIN cloud_history_boxes b ON b.id=s.id LIMIT 1",
        "SELECT 1 FROM cloud_history_shifts s JOIN cloud_history_pallets p ON p.id=s.id LIMIT 1",
        "SELECT 1 FROM cloud_history_shifts c JOIN shifts s ON s.id=c.id OR (s.number_month_key=json_extract(c.source_json,'$.numberMonthKey') AND s.number_seq=json_extract(c.source_json,'$.numberSeq')) LIMIT 1",
        "SELECT 1 FROM cloud_history_boxes c JOIN boxes b ON b.id=c.id OR b.sscc=c.sscc LIMIT 1",
        "SELECT 1 FROM cloud_history_pallets c JOIN pallets p ON p.id=c.id OR p.sscc=c.sscc LIMIT 1",
        "SELECT 1 FROM cloud_history_pallets c JOIN warehouse_pallets p ON p.id=c.id OR p.sscc=c.sscc LIMIT 1"
    ] {
        let bad:Option<i64>=sqlx::query_scalar(query).fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
        if bad.is_some() { return Err(conflict("history_graph")); }
    }
    Ok(())
}
/// Original cloud owner visible to duplication checks only after activation.
/// Task 3 releases it by setting released_at; repeat parts never change that marker.
#[derive(Debug, Clone)]
pub struct CompletedOwner {
    pub shift_id: String,
    pub number: String,
    pub scanned_at: String,
    /// May name an external original box absent from the imported report closure.
    pub box_id: Option<String>,
}
pub async fn completed_owner(
    conn: &mut SqliteConnection,
    hash: &str,
) -> Result<Option<CompletedOwner>, ApiError> {
    let row=sqlx::query("SELECT o.shift_id,o.number,o.scanned_at,o.box_id FROM cloud_history_owners o JOIN cloud_history_batches b ON b.id=o.batch_id WHERE o.hash=? AND o.released_at IS NULL AND b.status='complete'").bind(hash).fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
    row.map(|r| {
        Ok(CompletedOwner {
            shift_id: r.try_get("shift_id").map_err(ApiError::internal)?,
            number: r.try_get("number").map_err(ApiError::internal)?,
            scanned_at: r.try_get("scanned_at").map_err(ApiError::internal)?,
            box_id: r.try_get("box_id").map_err(ApiError::internal)?,
        })
    })
    .transpose()
}
