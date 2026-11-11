//! Bounded office metadata search. Exact identifiers drive indexes; text scans only
//! metadata, never scan/code payloads or saved file chunks. No writes or audit rows.
use axum::{extract::State, Json};
use markiro_proto::office_search::{
    DocumentTargetType, OfficeSearchItem, OfficeSearchRequest, OfficeSearchResponse,
    OfficeSearchTarget as Target, SearchSource as Source, MAX_TEXT_CHARS, SEARCH_LIMIT,
};
use sqlx::{Row, SqliteConnection};

use crate::{
    auth::OfficeContext,
    error::{ApiError, ApiJson},
    server::AppState,
};

const COMPLETE: &str = "EXISTS (SELECT 1 FROM cloud_history_batches batch WHERE batch.id=t.batch_id AND batch.status='complete')";
const SHIFT_LABEL: &str = "t.number_month_key || '-' || printf('%03d',t.number_seq) || CASE t.number_origin WHEN 'station' THEN '/S' WHEN 'handheld' THEN '/M' ELSE '' END";

/// Shared with query-plan regression tests: no full code/scan hydration.
pub const LOCAL_CODE_SQL: &str = "SELECT code_hash AS id,substr(code_hash,1,12) AS label,NULL AS detail FROM scans WHERE code_hash=?1 GROUP BY code_hash";
pub const LOCAL_GTIN_CODES_SQL: &str = "SELECT DISTINCT code_hash AS id,substr(code_hash,1,12) AS label,NULL AS detail FROM scans WHERE gtin14=?1 AND verdict='ok' AND code_hash IS NOT NULL";
pub const GTIN_PRODUCTS_SQL: &str =
    "SELECT id,name AS label,gtin14 AS detail FROM products WHERE gtin14=?1 ORDER BY id";
pub fn pack_match_sql(table: &str, cloud: bool) -> String {
    let complete = if cloud {
        format!(" AND {COMPLETE}")
    } else {
        String::new()
    };
    format!("SELECT t.id,t.sscc AS label,NULL AS detail FROM {table} t WHERE t.sscc=?1{complete} ORDER BY t.id")
}
pub fn cloud_codes_sql(gtin: bool) -> String {
    if gtin {
        format!("SELECT DISTINCT t.hash AS id,substr(t.hash,1,12) AS label,NULL AS detail FROM cloud_history_codes t WHERE COALESCE(t.gtin14,substr(t.canonical,3,14))=?1 AND {COMPLETE}")
    } else {
        format!("SELECT ?1 AS id,substr(?1,1,12) AS label,NULL AS detail WHERE EXISTS(SELECT 1 FROM cloud_history_codes t WHERE t.hash=?1 AND {COMPLETE}) OR EXISTS(SELECT 1 FROM cloud_history_owners t WHERE t.hash=?1 AND {COMPLETE})")
    }
}

// SQLite's lower() folds ASCII only. Explicit Russian folding keeps Cyrillic names
// searchable on every supported SQLite build without extensions or lossy prefilters.
fn folded(column: &str) -> String {
    let mut expression = format!("lower({column})");
    for (upper, lower) in "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
        .chars()
        .zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя".chars())
    {
        expression = format!("replace({expression},'{upper}','{lower}')");
    }
    expression
}
fn text_condition(column: &str) -> String {
    format!("{} LIKE ?1 ESCAPE '\\'", folded(column))
}
fn pattern(text: &str) -> String {
    format!(
        "%{}%",
        text.to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn validate(query: &OfficeSearchRequest) -> Result<(), ApiError> {
    match query {
        OfficeSearchRequest::Code { code_hash }
            if !crate::facts::rules::is_code_hash(code_hash) =>
        {
            Err(ApiError::validation(
                "codeHash",
                "64 lower-case hex digits are required",
            ))
        }
        OfficeSearchRequest::Sscc { sscc }
            if sscc.len() != 18 || !sscc.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Err(ApiError::validation("sscc", "18 digits are required"))
        }
        OfficeSearchRequest::Gtin { gtin14 }
            if gtin14.len() != 14 || !gtin14.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Err(ApiError::validation("gtin14", "14 digits are required"))
        }
        OfficeSearchRequest::Shift { id } => crate::validate::client_uuid("id", id),
        OfficeSearchRequest::Text { text }
            if !(2..=MAX_TEXT_CHARS).contains(&text.chars().count())
                || text.trim() != text
                || text.chars().any(char::is_control) =>
        {
            Err(ApiError::validation(
                "text",
                "2 to 120 printable characters are required",
            ))
        }
        _ => Ok(()),
    }
}

// Compact projections only. LIMIT applies after matching, so a match is never
// lost through an arbitrary preliminary cap. All values are bound parameters.
async fn metadata(
    conn: &mut SqliteConnection,
    items: &mut Vec<OfficeSearchItem>,
    sql: &str,
    value: &str,
    kind: &str,
    source: Source,
) -> Result<(), ApiError> {
    let remaining = SEARCH_LIMIT + 1 - items.len();
    if remaining == 0 {
        return Ok(());
    }
    let sql = format!("{sql} LIMIT ?2");
    let rows = sqlx::query(&sql)
        .bind(value)
        .bind(remaining as i64)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    for row in rows {
        let id: String = row.try_get("id").map_err(ApiError::internal)?;
        let label: String = row.try_get("label").map_err(ApiError::internal)?;
        let detail: Option<String> = row.try_get("detail").map_err(ApiError::internal)?;
        let target = match kind {
            "product" => Target::Product { id: id.clone() },
            "shift" => Target::Shift {
                id: id.clone(),
                source,
            },
            "box" => Target::Box {
                id: id.clone(),
                source,
            },
            "pallet" => Target::Pallet {
                id: id.clone(),
                source,
            },
            "warehouse_pallet" => Target::WarehousePallet { id: id.clone() },
            "code" => Target::Code {
                code_hash: id.clone(),
                source,
            },
            "disaggregation" => Target::Disaggregation { id: id.clone() },
            _ => return Err(ApiError::internal("unknown search projection")),
        };
        let prefix = if source == Source::Local {
            "local"
        } else {
            "cloud"
        };
        items.push(OfficeSearchItem {
            id: format!("{prefix}:{kind}:{id}"),
            label,
            detail,
            target,
        });
    }
    Ok(())
}

async fn documents(
    conn: &mut SqliteConnection,
    items: &mut Vec<OfficeSearchItem>,
    value: &str,
    condition: &str,
) -> Result<(), ApiError> {
    let remaining = SEARCH_LIMIT + 1 - items.len();
    if remaining == 0 {
        return Ok(());
    }
    // Resolve an actual owner before LIMIT. Cloud IDs are independent of local IDs;
    // a file may belong to either. Dangling or ambiguous owners never make a link.
    let owner = "CASE \
      WHEN f.target_type='shift' AND EXISTS(SELECT 1 FROM shifts WHERE id=f.target_id) AND EXISTS(SELECT 1 FROM cloud_history_shifts t WHERE t.id=f.target_id AND {complete}) THEN NULL \
      WHEN f.target_type='box' AND EXISTS(SELECT 1 FROM boxes WHERE id=f.target_id) AND EXISTS(SELECT 1 FROM cloud_history_boxes t WHERE t.id=f.target_id AND {complete}) THEN NULL \
      WHEN f.target_type='pallet' AND EXISTS(SELECT 1 FROM pallets WHERE id=f.target_id) AND EXISTS(SELECT 1 FROM cloud_history_pallets t WHERE t.id=f.target_id AND {complete}) THEN NULL \
      WHEN f.target_type='shift' AND EXISTS(SELECT 1 FROM shifts WHERE id=f.target_id) THEN 'local' \
      WHEN f.target_type='box' AND EXISTS(SELECT 1 FROM boxes WHERE id=f.target_id) THEN 'local' \
      WHEN f.target_type='pallet' AND EXISTS(SELECT 1 FROM pallets WHERE id=f.target_id) THEN 'local' \
      WHEN f.target_type='warehouse_pallet' AND EXISTS(SELECT 1 FROM warehouse_pallets WHERE id=f.target_id) THEN 'local' \
      WHEN f.target_type='disaggregation_document' AND EXISTS(SELECT 1 FROM disaggregation_documents WHERE id=f.target_id) THEN 'local' \
      WHEN f.target_type='shift' AND EXISTS(SELECT 1 FROM cloud_history_shifts t WHERE t.id=f.target_id AND {complete}) THEN 'cloud' \
      WHEN f.target_type='box' AND EXISTS(SELECT 1 FROM cloud_history_boxes t WHERE t.id=f.target_id AND {complete}) THEN 'cloud' \
      WHEN f.target_type='pallet' AND EXISTS(SELECT 1 FROM cloud_history_pallets t WHERE t.id=f.target_id AND {complete}) THEN 'cloud' END".replace("{complete}", COMPLETE);
    let sql = format!("WITH matched AS (SELECT f.id,f.file_name,f.kind,f.target_type,f.target_id,{owner} AS source FROM export_files f WHERE f.state='ready' AND {condition}) SELECT * FROM matched WHERE source IS NOT NULL ORDER BY id LIMIT ?2");
    for row in sqlx::query(&sql)
        .bind(value)
        .bind(remaining as i64)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?
    {
        let id: String = row.try_get("id").map_err(ApiError::internal)?;
        let target_type: String = row.try_get("target_type").map_err(ApiError::internal)?;
        let target_type = match target_type.as_str() {
            "shift" => DocumentTargetType::Shift,
            "box" => DocumentTargetType::Box,
            "pallet" => DocumentTargetType::Pallet,
            "warehouse_pallet" => DocumentTargetType::WarehousePallet,
            _ => DocumentTargetType::DisaggregationDocument,
        };
        let source_text: String = row.try_get("source").map_err(ApiError::internal)?;
        let source = if source_text == "cloud" {
            Source::Cloud
        } else {
            Source::Local
        };
        items.push(OfficeSearchItem {
            id: format!("{source_text}:document:{id}"),
            label: row.try_get("file_name").map_err(ApiError::internal)?,
            detail: None,
            target: Target::Document {
                id,
                target_type,
                target_id: row.try_get("target_id").map_err(ApiError::internal)?,
                source,
            },
        });
    }
    Ok(())
}

pub async fn search(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiJson(query): ApiJson<OfficeSearchRequest>,
) -> Result<Json<OfficeSearchResponse>, ApiError> {
    validate(&query)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let mut items = Vec::new();
    match query {
        OfficeSearchRequest::Code { code_hash } => {
            metadata(
                &mut tx,
                &mut items,
                LOCAL_CODE_SQL,
                &code_hash,
                "code",
                Source::Local,
            )
            .await?;
            metadata(
                &mut tx,
                &mut items,
                &cloud_codes_sql(false),
                &code_hash,
                "code",
                Source::Cloud,
            )
            .await?;
        }
        OfficeSearchRequest::Sscc { sscc } => {
            for (table, kind, source) in [
                ("boxes", "box", Source::Local),
                ("pallets", "pallet", Source::Local),
                ("warehouse_pallets", "warehouse_pallet", Source::Local),
                ("cloud_history_boxes", "box", Source::Cloud),
                ("cloud_history_pallets", "pallet", Source::Cloud),
            ] {
                metadata(
                    &mut tx,
                    &mut items,
                    &pack_match_sql(table, source == Source::Cloud),
                    &sscc,
                    kind,
                    source,
                )
                .await?;
            }
        }
        OfficeSearchRequest::Shift { id } => {
            metadata(&mut tx,&mut items,&format!("SELECT t.id,{SHIFT_LABEL} AS label,p.name AS detail FROM shifts t JOIN products p ON p.id=t.product_id WHERE t.id=?1"),&id,"shift",Source::Local).await?;
            metadata(&mut tx,&mut items,&format!("SELECT t.id,t.number AS label,json_extract(t.source_json,'$.productName') AS detail FROM cloud_history_shifts t WHERE t.id=?1 AND {COMPLETE}"),&id,"shift",Source::Cloud).await?;
            documents(&mut tx, &mut items, &id, "f.shift_id=?1").await?;
        }
        OfficeSearchRequest::Gtin { gtin14 } => {
            metadata(
                &mut tx,
                &mut items,
                GTIN_PRODUCTS_SQL,
                &gtin14,
                "product",
                Source::Local,
            )
            .await?;
            metadata(&mut tx,&mut items,&format!("SELECT t.id,{SHIFT_LABEL} AS label,p.name AS detail FROM products p JOIN shifts t ON t.product_id=p.id WHERE p.gtin14=?1 ORDER BY t.id"),&gtin14,"shift",Source::Local).await?;
            metadata(&mut tx,&mut items,&format!("SELECT t.id,t.number AS label,json_extract(t.source_json,'$.productName') AS detail FROM cloud_history_shifts t WHERE t.gtin14=?1 AND {COMPLETE} ORDER BY t.id"),&gtin14,"shift",Source::Cloud).await?;
            metadata(
                &mut tx,
                &mut items,
                LOCAL_GTIN_CODES_SQL,
                &gtin14,
                "code",
                Source::Local,
            )
            .await?;
            metadata(
                &mut tx,
                &mut items,
                &cloud_codes_sql(true),
                &gtin14,
                "code",
                Source::Cloud,
            )
            .await?;
        }
        OfficeSearchRequest::Text { text } => {
            let value = pattern(&text);
            metadata(&mut tx,&mut items,&format!("SELECT id,name AS label,gtin14 AS detail FROM products WHERE {} OR {} ORDER BY id",text_condition("name"),text_condition("print_name")),&value,"product",Source::Local).await?;
            metadata(&mut tx,&mut items,&format!("SELECT t.id,{SHIFT_LABEL} AS label,p.name AS detail FROM shifts t JOIN products p ON p.id=t.product_id WHERE {} OR {} ORDER BY t.id",text_condition(SHIFT_LABEL),text_condition("p.name")),&value,"shift",Source::Local).await?;
            metadata(&mut tx,&mut items,&format!("SELECT t.id,t.number AS label,json_extract(t.source_json,'$.productName') AS detail FROM cloud_history_shifts t WHERE ({}) AND {COMPLETE} ORDER BY t.id",text_condition("t.number || ' ' || COALESCE(json_extract(t.source_json,'$.productName'),'')")),&value,"shift",Source::Cloud).await?;
            metadata(&mut tx,&mut items,&format!("SELECT id,doc_no AS label,NULL AS detail FROM disaggregation_documents WHERE {} ORDER BY id",text_condition("doc_no")),&value,"disaggregation",Source::Local).await?;
            documents(&mut tx, &mut items, &value, &text_condition("f.file_name")).await?;
        }
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    let truncated = items.len() > SEARCH_LIMIT;
    items.truncate(SEARCH_LIMIT);
    Ok(Json(OfficeSearchResponse { items, truncated }))
}
