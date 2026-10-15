//! `GET /v1/device/box-registry`: the closed boxes a handheld builds warehouse pallets of (plan
//! ТСД-Х, spec 6.5). A delta by the boxes' change time: `since` (the previous walk's `until`),
//! pages of `(changed_at, sscc)` after `cursor`, every page of one walk under the `until` the first
//! page named. No code of a unit leaves the host (unlike a station's warehouse lookup).

use axum::extract::State;
use axum::Json;
use markiro_proto::{BoxRegistryItem, BoxRegistryKind, BoxRegistryPage};
use serde::Deserialize;

use crate::auth::AskingDevice;
use crate::clock::parse_timestamp;
use crate::error::{ApiError, ApiQuery};
use crate::server::AppState;

const DEFAULT_LIMIT: u32 = 250;
const MAX_LIMIT: u32 = 500;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryQuery {
    since: Option<String>,
    until: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(sqlx::FromRow)]
struct Row {
    sscc: String,
    changed_at: String,
    id: String,
    product_id: String,
    item_count_reported: Option<i64>,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    production_date: String,
    prod_pallet: Option<String>,
    prod_sscc: Option<String>,
    prod_off: Option<String>,
    wh_pallet: Option<String>,
    wh_sscc: Option<String>,
}

fn timestamp(field: &str, text: &str) -> Result<(), ApiError> {
    parse_timestamp(text)
        .map(|_| ())
        .map_err(|_| ApiError::validation(field, "a time as the host writes it"))
}

pub async fn box_registry(
    State(state): State<AppState>,
    _device: AskingDevice,
    ApiQuery(query): ApiQuery<RegistryQuery>,
) -> Result<Json<BoxRegistryPage>, ApiError> {
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::validation("limit", format!("1-{MAX_LIMIT}")));
    }
    if let Some(since) = &query.since {
        timestamp("since", since)?;
    }
    // The first page names its window; the next ones repeat it (the cloud's rule).
    let (until, after) = match (&query.cursor, &query.until) {
        (None, Some(_)) => {
            return Err(ApiError::validation(
                "until",
                "not on the first page of a walk",
            ))
        }
        (Some(_), None) => {
            return Err(ApiError::validation(
                "until",
                "required after the first page",
            ))
        }
        (None, None) => (state.timestamp(), None),
        (Some(cursor), Some(until)) => {
            timestamp("until", until)?;
            let (changed_at, sscc) = cursor
                .split_once('|')
                .filter(|(at, sscc)| parse_timestamp(at).is_ok() && sscc.len() == 18)
                .ok_or_else(|| ApiError::validation("cursor", "a cursor of this registry"))?;
            (
                until.clone(),
                Some((changed_at.to_owned(), sscc.to_owned())),
            )
        }
    };
    let (after_at, after_sscc) = after.unwrap_or_default();
    // One snapshot: the window and its rows come from the same read.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT b.sscc AS sscc, b.changed_at AS changed_at, b.id AS id, sh.product_id AS product_id, \
         b.item_count_reported AS item_count_reported, b.closed_at AS closed_at, \
         b.disassembled_at AS disassembled_at, sh.production_date AS production_date, \
         p.id AS prod_pallet, p.sscc AS prod_sscc, p.disassembled_at AS prod_off, \
         wp.id AS wh_pallet, wp.sscc AS wh_sscc \
         FROM boxes b JOIN shifts sh ON sh.id = b.shift_id \
         LEFT JOIN pallets p ON p.id = b.pallet_id \
         LEFT JOIN warehouse_pallet_boxes wb ON wb.box_sscc = b.sscc AND wb.removed_at IS NULL \
         LEFT JOIN warehouse_pallets wp ON wp.id = wb.pallet_id \
         WHERE b.sscc IS NOT NULL AND b.changed_at >= ?1 AND b.changed_at <= ?2 \
         AND (?1 <> '' OR b.disassembled_at IS NULL) \
         AND (b.changed_at, b.sscc) > (?3, ?4) \
         ORDER BY b.changed_at, b.sscc LIMIT ?5",
    )
    .bind(query.since.as_deref().unwrap_or(""))
    .bind(&until)
    .bind(&after_at)
    .bind(&after_sscc)
    .bind(i64::from(limit) + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let restore_epoch: Option<String> =
        sqlx::query_scalar("SELECT restore_epoch FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let more = rows.len() > limit as usize;
    let rows = &rows[..rows.len().min(limit as usize)];
    let next_cursor = more
        .then(|| {
            rows.last()
                .map(|row| format!("{}|{}", row.changed_at, row.sscc))
        })
        .flatten();
    let items = rows.iter().map(item).collect();
    Ok(Json(BoxRegistryPage {
        until,
        items,
        next_cursor,
        restore_epoch,
    }))
}

fn item(row: &Row) -> BoxRegistryItem {
    if row.disassembled_at.is_some() {
        return BoxRegistryItem::remove(row.sscc.clone(), row.changed_at.clone());
    }
    // A warehouse pallet outranks a taken-apart production one; a standing production pallet
    // holds its boxes from the box's close.
    let (pallet_id, pallet_sscc, active) = match (&row.wh_pallet, &row.prod_pallet, &row.prod_off) {
        (Some(pallet), _, _) => (Some(pallet.clone()), row.wh_sscc.clone(), true),
        (None, Some(pallet), None) => (Some(pallet.clone()), row.prod_sscc.clone(), true),
        _ => (None, None, false),
    };
    BoxRegistryItem {
        kind: BoxRegistryKind::Upsert,
        sscc: row.sscc.clone(),
        updated_at: row.changed_at.clone(),
        box_id: Some(row.id.clone()),
        product_id: Some(row.product_id.clone()),
        bottle_count: row
            .item_count_reported
            .and_then(|count| u32::try_from(count).ok()),
        pallet_id,
        pallet_sscc,
        pallet_active: Some(active),
        closed_at: row.closed_at.clone(),
        production_date: Some(row.production_date.clone()),
    }
}
