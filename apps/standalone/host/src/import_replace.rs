//! Explicit replacement of test business data. The copy is made while the
//! caller holds BEGIN IMMEDIATE, using an independent read connection.
use std::sync::Arc;

use markiro_proto::cloud_import::{CloudImportRequest, CloudReplacementSummary};
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection};

use crate::{
    backup::{copy, identity::HostIdentity},
    config::HostPaths,
    db,
    error::ApiError,
    server::AppState,
};

pub const BUSINESS_TABLES: &[&str] = &[
    "cloud_history_releases",
    "cloud_history_conflicts",
    "cloud_history_items",
    "cloud_history_owners",
    "cloud_history_codes",
    "cloud_history_boxes",
    "cloud_history_pallets",
    "cloud_history_shifts",
    "cloud_history_parts",
    "cloud_history_batches",
    "disaggregation_document_lines",
    "disaggregation_documents",
    "code_releases",
    "warehouse_reprints",
    "warehouse_pallet_boxes",
    "warehouse_pallets",
    "unit_label_events",
    "pallet_exceptions",
    "box_exceptions",
    "code_conflicts",
    "code_owners",
    "box_items",
    "scans",
    "boxes",
    "pallets",
    "shift_close_events",
    "shift_participants",
    "fact_receipts",
    "device_event_receipts",
    "demo_removed_shifts",
    "shifts",
    "sscc_blocks",
    "export_file_chunks",
    "export_files",
    "export_settings",
    "employees",
    "operator_badges",
    "operators",
    "product_photos",
    "products",
    "category_template_defaults",
    "category_pallet_sheet_defaults",
    "counterparties",
    "lines",
    "tombstones",
    "org_logo",
];

pub async fn epoch(conn: &mut SqliteConnection) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT dataset_epoch FROM site WHERE id=1")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)
}

pub async fn details(conn: &mut SqliteConnection, mut value: Value) -> Result<Value, ApiError> {
    if let Some(epoch) = epoch(conn).await? {
        value["datasetEpoch"] = json!(epoch);
    }
    Ok(value)
}

pub fn validate(request: &CloudImportRequest) -> Result<(), ApiError> {
    let Some(replacement) = &request.replacement else {
        return Ok(());
    };
    crate::cloud_history::validation::check_manifest(&replacement.history)?;
    if replacement.history.source.tenant_id != request.source.tenant_id
        || replacement.history.organization.gln != request.payload.organization.gln
        || replacement.history.organization.inn != request.payload.organization.inn
    {
        return Err(ApiError::conflict(
            "history_source",
            "catalog and history have different sources",
        ));
    }
    if !request.dry_run && replacement.expected_revision.is_none() {
        return Err(ApiError::validation(
            "replacement.expectedRevision",
            "check the replacement first",
        ));
    }
    Ok(())
}

/// No filesystem work in a dry run. The copy is independent of the pool:
/// none of its connections can be borrowed while a writer waits for this copy.
pub async fn backup(state: &AppState) -> Result<(String, String), ApiError> {
    let failed = || {
        ApiError::conflict(
            "replacement_backup_failed",
            "the pre-import backup could not be verified",
        )
    };
    let backups = state.backups.as_ref().ok_or_else(failed)?;
    let dir = backups.local_dir.join("pre-import");
    let create = dir.clone();
    tokio::task::spawn_blocking(move || std::fs::create_dir_all(create))
        .await
        .map_err(|_| failed())?
        .map_err(|_| failed())?;
    let paths = HostPaths::new(backups.data_dir.clone());
    let host_id = state.host_id.clone();
    let identity = tokio::task::spawn_blocking(move || {
        HostIdentity::read(&paths)
            .ok()
            .filter(|i| i.host_id() == host_id)
            .map(Arc::new)
    })
    .await
    .map_err(|_| failed())?;
    let mut conn = SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&backups.db_path)
            .read_only(true),
    )
    .await
    .map_err(|_| failed())?;
    let tag = format!("pre-import-{}", uuid::Uuid::new_v4().simple());
    let manifest = copy::make_copy_with_identity_tagged(
        &mut conn,
        &dir,
        state.now(),
        markiro_proto::backup::BackupTrigger::Manual,
        &state.host_id,
        &tag,
        identity,
        backups.guard.clone(),
    )
    .await
    .map_err(|_| failed())?;
    conn.close().await.map_err(|_| failed())?;
    Ok((
        format!("backups/pre-import/{}", manifest.file),
        manifest.sha256,
    ))
}

/// Read old device assignments before deleting lines; the caller reattaches
/// only names present in the imported catalog after writing it.
pub async fn clear(conn: &mut SqliteConnection) -> Result<Vec<(String, String)>, ApiError> {
    let assignments =
        sqlx::query_as("SELECT d.id,l.name_key FROM devices d JOIN lines l ON l.id=d.line_id")
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    // The wizard's demo data (spec 2026-10-21) goes with the products; its counters are no
    // organization's numbering, so they go too instead of being kept as floors.
    let demo = crate::demo::present(&mut *conn).await?;
    sqlx::query("PRAGMA defer_foreign_keys=ON")
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    // Allocation counters normally already include these floors; retain the
    // entire issued range, even when its device was revoked or disconnected.
    sqlx::query("UPDATE sscc_counters SET next_serial=MAX(next_serial,COALESCE((SELECT MAX(to_serial)+1 FROM sscc_blocks b WHERE b.issuer_prefix=sscc_counters.issuer_prefix AND b.extension=sscc_counters.extension),0))")
        .execute(&mut *conn).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO shift_number_counters(month_key,last_seq) SELECT number_month_key,MAX(number_seq) FROM shifts GROUP BY number_month_key ON CONFLICT(month_key) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq)")
        .execute(&mut *conn).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE devices SET line_id=NULL")
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("UPDATE org_profile SET default_box_template_id=NULL,default_pallet_template_id=NULL,default_duplicate_template_id=NULL,default_pallet_sheet_template_id=NULL")
        .execute(&mut *conn).await.map_err(ApiError::internal)?;
    for table in BUSINESS_TABLES {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    if demo {
        sqlx::query("DELETE FROM sscc_counters WHERE issuer_prefix = ?")
            .bind(crate::demo::DEMO_PREFIX)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        sqlx::query("DELETE FROM shift_number_counters WHERE month_key = ?")
            .bind(crate::demo::DEMO_NUMBER_KEY)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    }
    sqlx::query("DELETE FROM label_templates WHERE stock=0")
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM pallet_sheet_templates WHERE preset_key IS NULL")
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(assignments)
}

pub async fn stage(
    conn: &mut SqliteConnection,
    request: &CloudImportRequest,
    revision: i64,
    at: &str,
    assignments: Vec<(String, String)>,
    backup_file: Option<String>,
) -> Result<CloudReplacementSummary, ApiError> {
    let replacement = request
        .replacement
        .as_ref()
        .ok_or_else(|| ApiError::internal("replacement missing"))?;
    let dataset_epoch = uuid::Uuid::new_v4().to_string();
    sqlx::query("UPDATE site SET dataset_epoch=?,replacement_pending=1,replacement_backup_file=?,restore_epoch=NULL,facts_held_since=NULL WHERE id=1")
        .bind(&dataset_epoch).bind(&backup_file).execute(&mut *conn).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO cloud_history_batches(id,singleton,manifest,status,created_at) VALUES(?,1,?,'pending',?)")
        .bind(&replacement.history.checksum).bind(serde_json::to_string(&replacement.history).map_err(ApiError::internal)?)
        .bind(at).execute(&mut *conn).await.map_err(ApiError::internal)?;
    for (device, name) in assignments {
        sqlx::query("UPDATE devices SET line_id=(SELECT id FROM lines WHERE name_key=? AND archived=0) WHERE id=?")
            .bind(name).bind(device).execute(&mut *conn).await.map_err(ApiError::internal)?;
    }
    Ok(CloudReplacementSummary {
        expected_revision: revision,
        dataset_epoch: (!request.dry_run).then_some(dataset_epoch),
        backup_file,
    })
}

pub async fn require_revision(
    conn: &mut SqliteConnection,
    request: &CloudImportRequest,
) -> Result<i64, ApiError> {
    let rev = db::current_revision(conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some(replacement) = &request.replacement {
        if !request.dry_run && replacement.expected_revision != Some(rev) {
            return Err(ApiError::conflict(
                "replacement_changed",
                "the site changed since the replacement was checked",
            ));
        }
    }
    Ok(rev)
}
