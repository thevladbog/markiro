//! Compact indexed union first, bounded hydration second. Legacy readers stay local-only.
use super::*;
use markiro_proto::code_registry::{
    CloudCodeItem, CloudCodeState, CodeRegistryCard, CodeRegistryItem, CodeRegistryPage,
    CodeRegistrySource,
};
use sqlx::Row;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeRegistryQuery {
    code_hash: Option<String>,
    gtin: Option<String>,
    sscc: Option<String>,
    shift: Option<String>,
    from_ms: Option<String>,
    to_ms: Option<String>,
    page: Option<String>,
    source: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardQuery {
    source: Option<String>,
}
fn source(value: Option<&str>) -> Result<CodeRegistrySource, ApiError> {
    match value.unwrap_or("all") {
        "all" => Ok(CodeRegistrySource::All),
        "local" => Ok(CodeRegistrySource::Local),
        "cloud" => Ok(CodeRegistrySource::Cloud),
        _ => Err(ApiError::validation(
            "source",
            "all, local or cloud is required",
        )),
    }
}

/// Cloud match queries are public for plan regression tests. They return only keys and instants.
pub fn cloud_match_sql(owner: bool, driver: &str) -> String {
    let (alias, table, key, extra) = if owner {
        ("o", "cloud_history_owners", "'owner:' || o.hash", " AND ?2 IS NULL AND NOT EXISTS (SELECT 1 FROM cloud_history_codes c WHERE c.hash=o.hash)")
    } else {
        (
            "c",
            "cloud_history_codes",
            "'code:' || c.shift_id || ':' || c.hash",
            "",
        )
    };
    let (index, condition) = match (owner, driver) {
        (_, "code") => (if owner { "sqlite_autoindex_cloud_history_owners_1" } else { "cloud_history_codes_hash" }, format!("{alias}.hash=?1")),
        (false, "gtin") => ("cloud_history_codes_gtin_time", "COALESCE(c.gtin14,substr(c.canonical,3,14))=?2".to_owned()),
        (false, "shift") => ("cloud_history_codes_page", "c.shift_id IN (SELECT id FROM cloud_history_shifts WHERE number=?10 OR number=?10 || '/S')".to_owned()),
        (true, "shift") => ("cloud_history_owners_number", "(o.number=?10 OR o.number=?10 || '/S')".to_owned()),
        (_, "sscc") => (if owner { "sqlite_autoindex_cloud_history_owners_1" } else { "cloud_history_codes_hash" }, format!("{alias}.hash IN (SELECT i.hash FROM cloud_history_items i JOIN cloud_history_boxes b ON b.id=i.box_id WHERE b.id IN (SELECT id FROM cloud_history_boxes WHERE sscc=?11) OR b.pallet_id IN (SELECT id FROM cloud_history_pallets WHERE sscc=?11))")),
        _ => (if owner { "cloud_history_owners_time" } else { "cloud_history_codes_time" }, format!("julianday({alias}.scanned_at)>=COALESCE(julianday(?6),-1e20) AND julianday({alias}.scanned_at)<COALESCE(julianday(?7),1e20)")),
    };
    let identity = if owner {
        ""
    } else {
        " AND (?2 IS NULL OR COALESCE(c.gtin14,substr(c.canonical,3,14))=?2)"
    };
    let shift = if owner {
        "(?10 IS NULL OR o.number=?10 OR o.number=?10 || '/S')"
    } else {
        "(?10 IS NULL OR c.shift_id IN (SELECT id FROM cloud_history_shifts WHERE number=?10 OR number=?10 || '/S'))"
    };
    let sscc = if owner {
        "(?11 IS NULL OR o.box_id IN (SELECT id FROM cloud_history_boxes WHERE sscc=?11 OR pallet_id IN (SELECT id FROM cloud_history_pallets WHERE sscc=?11)))"
    } else {
        "(?11 IS NULL OR (c.flat_only=0 AND c.hash IN (SELECT i.hash FROM cloud_history_items i JOIN cloud_history_boxes b ON b.id=i.box_id WHERE b.shift_id=c.shift_id AND (b.sscc=?11 OR b.pallet_id IN (SELECT id FROM cloud_history_pallets WHERE sscc=?11)))))"
    };
    format!("SELECT 'cloud' AS source, {key} AS key, julianday({alias}.scanned_at) AS at FROM {table} {alias} INDEXED BY {index} WHERE {condition} AND EXISTS (SELECT 1 FROM cloud_history_batches batch WHERE batch.id={alias}.batch_id AND batch.status='complete') AND (?1 IS NULL OR {alias}.hash=?1){identity} AND {shift} AND {sscc} AND julianday({alias}.scanned_at)>=COALESCE(julianday(?6),-1e20) AND julianday({alias}.scanned_at)<COALESCE(julianday(?7),1e20){extra}")
}

#[derive(sqlx::FromRow)]
struct Match {
    source: String,
    key: String,
}
// Reserve the legacy driver's parameter positions even when that source resolves
// no matches. Positions 8/9 are unused legacy limit/offset slots, 10/11 cloud criteria.
const PARAMETERS: &str =
    "WITH parameters AS (SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11), matches AS (";

fn bind<'q>(
    sql: &'q str,
    c: &'q Criteria,
    resolved: &'q Resolved,
    shift: Option<&'q str>,
    sscc: Option<&'q str>,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    sqlx::query(sql)
        .bind(c.code_hash.as_deref())
        .bind(c.gtin.as_deref())
        .bind(resolved.shift_id.as_deref())
        .bind(resolved.box_id.as_deref())
        .bind(resolved.pallet_id.as_deref())
        .bind(c.from.as_deref().unwrap_or(EARLIEST))
        .bind(c.to.as_deref().unwrap_or(LATEST))
        .bind(0i64)
        .bind(0i64)
        .bind(shift)
        .bind(sscc)
}

async fn local_items(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<Vec<OfficeCodeItem>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<ItemRow> = sqlx::query_as(REGISTRY_HYDRATE_SQL)
        .bind(serde_json::to_string(ids).map_err(ApiError::internal)?)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter().map(ItemRow::into_wire).collect()
}

fn cloud_hydration_sql(owner: bool) -> String {
    let (key, table, alias, joins, fields, state) = if owner {
        ("'owner:' || o.hash", "cloud_history_owners", "o",
         "LEFT JOIN cloud_history_shifts sh ON sh.id=o.shift_id LEFT JOIN cloud_history_boxes b ON b.id=o.box_id LEFT JOIN cloud_history_pallets p ON p.id=b.pallet_id",
         "NULL AS canonical, NULL AS gtin14, NULL AS serial, o.number AS shift_number, o.box_id AS box_id",
         "CASE WHEN o.released_at IS NULL THEN 'owned' ELSE 'released' END")
    } else {
        ("'code:' || c.shift_id || ':' || c.hash", "cloud_history_codes", "c",
         "LEFT JOIN cloud_history_shifts sh ON sh.id=c.shift_id LEFT JOIN cloud_history_items i ON i.hash=c.hash AND c.flat_only=0 LEFT JOIN cloud_history_boxes b ON b.id=i.box_id AND b.shift_id=c.shift_id LEFT JOIN cloud_history_pallets p ON p.id=b.pallet_id LEFT JOIN cloud_history_owners o ON o.hash=c.hash AND o.shift_id=c.shift_id AND c.flat_only=0",
         "c.canonical, c.gtin14, c.serial, sh.number AS shift_number, b.id AS box_id",
         "CASE WHEN o.hash IS NULL THEN 'historical' WHEN o.released_at IS NOT NULL THEN 'released' ELSE 'owned' END")
    };
    // Import validates shift IDs as UUIDs. The stable key splits into that
    // fixed-width primary key and a hash; hydration never scans by concatenation.
    let selected = if owner {
        "o.hash IN (SELECT substr(value,7) FROM json_each(?1) WHERE value LIKE 'owner:%')"
    } else {
        "(c.shift_id,c.hash) IN (SELECT substr(value,6,36),substr(value,43) FROM json_each(?1) WHERE value LIKE 'code:%')"
    };
    format!("SELECT {key} AS id, {alias}.hash AS code_hash, {fields}, {alias}.scanned_at, json_extract(batch.manifest,'$.organization.timeZone') AS source_time_zone, {state} AS state, o.released_at, {alias}.shift_id, sh.id IS NOT NULL AS shift_available, sh.production_date, json_extract(sh.source_json,'$.productName') AS product_name, json_extract(sh.source_json,'$.lineName') AS line_name, b.sscc AS box_sscc, b.closed_at AS box_closed_at, b.disassembled_at AS box_disassembled_at, b.id IS NOT NULL AS box_available, b.pallet_id, p.sscc AS pallet_sscc, p.disassembled_at AS pallet_disassembled_at, p.id IS NOT NULL AS pallet_available FROM {table} {alias} JOIN cloud_history_batches batch ON batch.id={alias}.batch_id AND batch.status='complete' {joins} WHERE {selected}")
}
async fn cloud_items(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<Vec<CloudCodeItem>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{} UNION ALL {}",
        cloud_hydration_sql(false),
        cloud_hydration_sql(true)
    );
    let rows = sqlx::query(&sql)
        .bind(serde_json::to_string(ids).map_err(ApiError::internal)?)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|r| {
            let state: String = r.try_get("state").map_err(ApiError::internal)?;
            let state = match state.as_str() {
                "owned" => CloudCodeState::Owned,
                "released" => CloudCodeState::Released,
                _ => CloudCodeState::Historical,
            };
            macro_rules! get {
                ($name:literal) => {
                    r.try_get($name).map_err(ApiError::internal)?
                };
            }
            Ok(CloudCodeItem {
                id: get!("id"),
                code_hash: get!("code_hash"),
                canonical: get!("canonical"),
                gtin14: get!("gtin14"),
                serial: get!("serial"),
                scanned_at: get!("scanned_at"),
                source_time_zone: get!("source_time_zone"),
                state,
                released_at: get!("released_at"),
                shift_id: get!("shift_id"),
                shift_number: get!("shift_number"),
                shift_available: get!("shift_available"),
                production_date: get!("production_date"),
                product_name: get!("product_name"),
                line_name: get!("line_name"),
                box_id: get!("box_id"),
                box_sscc: get!("box_sscc"),
                box_closed_at: get!("box_closed_at"),
                box_disassembled_at: get!("box_disassembled_at"),
                box_available: get!("box_available"),
                pallet_id: get!("pallet_id"),
                pallet_sscc: get!("pallet_sscc"),
                pallet_disassembled_at: get!("pallet_disassembled_at"),
                pallet_available: get!("pallet_available"),
            })
        })
        .collect()
}

pub async fn search_codes(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(q): ApiQuery<CodeRegistryQuery>,
) -> Result<Json<CodeRegistryPage>, ApiError> {
    let src = source(q.source.as_deref())?;
    let sscc = q.sscc.clone();
    let c = criteria(CodeSearchQuery {
        code_hash: q.code_hash,
        gtin: q.gtin,
        sscc: q.sscc,
        shift: q.shift,
        from_ms: q.from_ms,
        to_ms: q.to_ms,
        page: q.page,
    })?;
    let shift = c.shift.as_ref().map(|n| {
        format!(
            "{}-{:03}{}",
            n.month_key,
            n.seq,
            if n.station { "/S" } else { "" }
        )
    });
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let resolved = resolve(&mut tx, &c).await?;
    let empty = Resolved {
        shift_id: None,
        box_id: None,
        pallet_id: None,
    };
    let mut queries = Vec::new();
    if src != CodeRegistrySource::Cloud {
        if let Some(r) = &resolved {
            let driver = if c.code_hash.is_some() {
                Driver::Code
            } else if r.box_id.is_some() {
                Driver::Box
            } else if r.pallet_id.is_some() {
                Driver::Pallet
            } else if r.shift_id.is_some() {
                Driver::Shift
            } else if c.gtin.is_some() {
                Driver::Gtin
            } else {
                Driver::Period
            };
            queries.push(REGISTRY_KEYS_SQL[driver as usize].1.to_owned());
        }
    }
    if src != CodeRegistrySource::Local {
        let driver = if c.code_hash.is_some() {
            "code"
        } else if sscc.is_some() {
            "sscc"
        } else if shift.is_some() {
            "shift"
        } else if c.gtin.is_some() {
            "gtin"
        } else {
            "period"
        };
        queries.push(cloud_match_sql(false, driver));
        if c.gtin.is_none() {
            queries.push(cloud_match_sql(true, driver));
        }
    }
    if queries.is_empty() {
        return Ok(Json(CodeRegistryPage {
            items: Vec::new(),
            page: c.page,
            page_count: 1,
            total: 0,
            capped: false,
        }));
    }
    let union = queries.join(" UNION ALL ");
    let sql = format!(
        "{PARAMETERS}{union}) SELECT COUNT(*) AS n FROM (SELECT 1 FROM matches LIMIT 10001)"
    );
    let r = resolved.as_ref().unwrap_or(&empty);
    let counted: i64 = bind(&sql, &c, r, shift.as_deref(), sscc.as_deref())
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .try_get("n")
        .map_err(ApiError::internal)?;
    let total =
        u32::try_from(counted.min(i64::from(CODE_SEARCH_CAP))).map_err(ApiError::internal)?;
    let offset = i64::from(c.page - 1) * i64::from(CODE_PAGE_SIZE);
    let sql=format!("{PARAMETERS}{union}) SELECT source,key FROM matches ORDER BY at DESC,source DESC,key DESC LIMIT {} OFFSET {offset}",if offset<i64::from(total){50}else{0});
    let keys: Vec<Match> = bind(&sql, &c, r, shift.as_deref(), sscc.as_deref())
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .into_iter()
        .map(|row| {
            Ok(Match {
                source: row.try_get("source").map_err(ApiError::internal)?,
                key: row.try_get("key").map_err(ApiError::internal)?,
            })
        })
        .collect::<Result<_, ApiError>>()?;
    let local_ids = keys
        .iter()
        .filter(|k| k.source == "local")
        .map(|k| k.key.clone())
        .collect::<Vec<_>>();
    let cloud_ids = keys
        .iter()
        .filter(|k| k.source == "cloud")
        .map(|k| k.key.clone())
        .collect::<Vec<_>>();
    let mut local = local_items(&mut tx, &local_ids)
        .await?
        .into_iter()
        .map(|i| (i.scan_id.clone(), i))
        .collect::<HashMap<_, _>>();
    let mut cloud = cloud_items(&mut tx, &cloud_ids)
        .await?
        .into_iter()
        .map(|i| (i.id.clone(), i))
        .collect::<HashMap<_, _>>();
    let items = keys
        .into_iter()
        .map(|k| {
            if k.source == "local" {
                local.remove(&k.key).map(CodeRegistryItem::Local)
            } else {
                cloud.remove(&k.key).map(CodeRegistryItem::Cloud)
            }
            .ok_or_else(|| ApiError::internal("registry hydration lost a match"))
        })
        .collect::<Result<_, _>>()?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(CodeRegistryPage {
        items,
        page: c.page,
        page_count: total.div_ceil(CODE_PAGE_SIZE).max(1),
        total,
        capped: counted > i64::from(CODE_SEARCH_CAP),
    }))
}

pub async fn code_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(hash): ApiPath<String>,
    ApiQuery(q): ApiQuery<CardQuery>,
) -> Result<Json<CodeRegistryCard>, ApiError> {
    let display_source = source(q.source.as_deref())?;
    if !rules::is_code_hash(&hash) {
        return Err(ApiError::validation(
            "codeHash",
            "64 lower-case hex digits are required",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scans WHERE code_hash=?)")
        .bind(&hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let local = if exists {
        Some(super::card(&mut tx, &hash).await?)
    } else {
        None
    };
    let sql="SELECT key FROM (SELECT 'code:' || c.shift_id || ':' || c.hash AS key,julianday(c.scanned_at) AS at FROM cloud_history_codes c JOIN cloud_history_batches b ON b.id=c.batch_id AND b.status='complete' WHERE c.hash=?1 UNION ALL SELECT 'owner:' || o.hash,julianday(o.scanned_at) FROM cloud_history_owners o JOIN cloud_history_batches b ON b.id=o.batch_id AND b.status='complete' WHERE o.hash=?1 AND NOT EXISTS(SELECT 1 FROM cloud_history_codes c WHERE c.hash=o.hash)) ORDER BY at DESC,key DESC LIMIT 1001";
    let mut ids: Vec<String> = sqlx::query_scalar(sql)
        .bind(&hash)
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let cloud_capped = ids.len() > 1000;
    ids.truncate(1000);
    let mut hydrated = cloud_items(&mut tx, &ids)
        .await?
        .into_iter()
        .map(|i| (i.id.clone(), i))
        .collect::<HashMap<_, _>>();
    let cloud = ids
        .into_iter()
        .map(|id| {
            hydrated
                .remove(&id)
                .ok_or_else(|| ApiError::internal("registry card hydration lost a match"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Resolve the current owner separately from the capped occurrence window and source filter.
    let cloud_owner:Option<(String,String)>=sqlx::query_as("SELECT o.shift_id,CASE WHEN EXISTS(SELECT 1 FROM cloud_history_codes c WHERE c.hash=o.hash AND c.shift_id=o.shift_id AND c.flat_only=0) THEN 'code:' || o.shift_id || ':' || o.hash ELSE 'owner:' || o.hash END FROM cloud_history_owners o JOIN cloud_history_batches b ON b.id=o.batch_id AND b.status='complete' WHERE o.hash=? AND o.released_at IS NULL").bind(&hash).fetch_optional(&mut *tx).await.map_err(ApiError::internal)?;
    let current_owner = if let Some((_, id)) = cloud_owner {
        cloud_items(&mut tx, &[id])
            .await?
            .into_iter()
            .next()
            .map(CodeRegistryItem::Cloud)
    } else {
        let id: Option<String> = sqlx::query_scalar(CARD_OWNER_SQL)
            .bind(&hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        if let Some(id) = id {
            local_items(&mut tx, &[id])
                .await?
                .into_iter()
                .next()
                .map(CodeRegistryItem::Local)
        } else {
            None
        }
    };
    if local.is_none() && cloud.is_empty() {
        return Err(ApiError::not_found("no occurrence of this code"));
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    let local = if display_source == CodeRegistrySource::Cloud {
        None
    } else {
        local
    };
    let cloud = if display_source == CodeRegistrySource::Local {
        Vec::new()
    } else {
        cloud
    };
    Ok(Json(CodeRegistryCard {
        code_hash: hash,
        local,
        cloud,
        cloud_capped: cloud_capped && display_source != CodeRegistrySource::Local,
        current_owner,
    }))
}

#[cfg(test)]
mod query_plans {
    use super::*;

    #[tokio::test]
    async fn final_page_hydration_searches_selected_primary_keys() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("host.db")).await.unwrap();
        for sql in [
            REGISTRY_HYDRATE_SQL.to_owned(),
            cloud_hydration_sql(false),
            cloud_hydration_sql(true),
        ] {
            let plan: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                    .bind("[]")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let steps: Vec<_> = plan.into_iter().map(|(_, _, _, s)| s).collect();
            for alias in ["s", "c", "o", "i", "b"] {
                assert!(
                    !steps.iter().any(|s| s == &format!("SCAN {alias}")
                        || s.starts_with(&format!("SCAN {alias} "))),
                    "{steps:?}"
                );
            }
        }
    }
}
