//! The change feed (spec §4.4): `GET /v1/changes` returns reference records
//! changed after a device's revision, in pages that never split a revision.
//! Adding an entity means a branch in `FEED_KEYS` and in `record`, its proto
//! record type, Zod schema and fixture, and a tombstone wherever it is deleted.

use axum::extract::State;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::{entities, ChangeItem, ChangesResponse, LineRecord, OrgRecord, SiteRecord};
use serde::Deserialize;
use sqlx::SqliteConnection;

use crate::auth::AuthDevice;
use crate::error::{ApiError, ApiQuery};
use crate::server::AppState;

pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 1000;

/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT entity, id, rev, 1 FROM tombstones WHERE rev > ?1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangesQuery {
    since: Option<i64>,
    limit: Option<u32>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Key {
    entity: String,
    id: String,
    rev: i64,
    deleted: bool,
}

struct Page {
    keys: Vec<Key>,
    /// The last revision the page holds completely; `None` when nothing
    /// more follows, so the answer carries the host's current revision.
    more_after: Option<i64>,
}

pub async fn changes(
    State(state): State<AppState>,
    _device: AuthDevice,
    ApiQuery(query): ApiQuery<ChangesQuery>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let since = query.since.unwrap_or(0);
    if since < 0 {
        return Err(ApiError::validation(
            "since",
            "since is a revision: 0 or more",
        ));
    }
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(ApiError::validation("limit", "1-1000 items per page"));
    }
    // One read transaction: the records and the current revision come from
    // one WAL snapshot, so a concurrent write cannot slip between them.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let current: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let page = page(&mut tx, since, limit).await?;
    let mut items = Vec::with_capacity(page.keys.len());
    for key in &page.keys {
        items.push(item(&mut tx, key).await?);
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(ChangesResponse {
        host_id: state.host_id.clone(),
        rev: page.more_after.unwrap_or(current),
        has_more: page.more_after.is_some(),
        items,
    }))
}

/// Up to `limit` keys after `since`, cut only between revisions. When one
/// revision alone is larger than a page, it comes whole.
async fn page(conn: &mut SqliteConnection, since: i64, limit: u32) -> Result<Page, ApiError> {
    let limit = usize::try_from(limit).map_err(ApiError::internal)?;
    let fetched: Vec<Key> =
        sqlx::query_as(&format!("{FEED_KEYS} ORDER BY rev, entity, id LIMIT ?2"))
            .bind(since)
            .bind(i64::try_from(limit + 1).map_err(ApiError::internal)?)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if fetched.len() <= limit {
        return Ok(Page {
            keys: fetched,
            more_after: None,
        });
    }
    let last = fetched[limit - 1].rev;
    if fetched[limit].rev != last {
        let mut keys = fetched;
        keys.truncate(limit);
        return Ok(Page {
            keys,
            more_after: Some(last),
        });
    }
    // The limit falls inside revision `last`: stop before it...
    let whole: Vec<Key> = fetched
        .into_iter()
        .take(limit)
        .filter(|key| key.rev < last)
        .collect();
    if let Some(end) = whole.last().map(|key| key.rev) {
        return Ok(Page {
            keys: whole,
            more_after: Some(end),
        });
    }
    // ...unless that revision alone fills the page: send all of it.
    let keys: Vec<Key> = sqlx::query_as(&format!(
        "SELECT entity, id, rev, deleted FROM ({FEED_KEYS}) WHERE rev = ?2 ORDER BY entity, id"
    ))
    .bind(since)
    .bind(last)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Page {
        keys,
        more_after: Some(last),
    })
}

async fn item(conn: &mut SqliteConnection, key: &Key) -> Result<ChangeItem, ApiError> {
    let data = if key.deleted {
        None
    } else {
        Some(record(conn, key).await?)
    };
    Ok(ChangeItem {
        entity: key.entity.clone(),
        id: key.id.clone(),
        rev: key.rev,
        deleted: key.deleted,
        data,
    })
}

/// The live record behind a feed key, as its proto record type.
async fn record(conn: &mut SqliteConnection, key: &Key) -> Result<serde_json::Value, ApiError> {
    let value = match key.entity.as_str() {
        entities::ORG_PROFILE => {
            let (name, inn, gln, gs1_prefixes, time_zone): (
                String,
                Option<String>,
                String,
                String,
                String,
            ) = sqlx::query_as(
                "SELECT name, inn, gln, gs1_prefixes, time_zone FROM org_profile WHERE id = 1",
            )
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OrgRecord {
                name,
                inn,
                gln,
                gs1_prefixes: serde_json::from_str(&gs1_prefixes).map_err(ApiError::internal)?,
                time_zone,
            })
        }
        entities::SITE => {
            let (badge_salt, box_block_size, pallet_block_size): (Vec<u8>, i64, i64) =
                sqlx::query_as(
                    "SELECT badge_salt, box_block_size, pallet_block_size FROM site WHERE id = 1",
                )
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            serde_json::to_value(SiteRecord {
                badge_salt: STANDARD.encode(badge_salt),
                box_block_size: u32::try_from(box_block_size).map_err(ApiError::internal)?,
                pallet_block_size: u32::try_from(pallet_block_size).map_err(ApiError::internal)?,
            })
        }
        entities::LINES => {
            let (name, archived): (String, bool) =
                sqlx::query_as("SELECT name, archived FROM lines WHERE id = ?")
                    .bind(&key.id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
            serde_json::to_value(LineRecord { name, archived })
        }
        other => {
            return Err(ApiError::internal(format!(
                "no feed record type for {other}"
            )))
        }
    };
    value.map_err(ApiError::internal)
}
