//! The change feed (spec §4.4) and its live stream (spec §4.5). `GET
//! /v1/changes` returns reference records changed after a device's revision,
//! in pages that never split a revision and stop at about
//! [`MAX_PAGE_BYTES`]; `GET /v1/changes/stream` follows up
//! with server-sent events so a device does not have to poll for the next
//! one, until the host stops or the device is revoked. Adding an entity
//! means a branch in `FEED_KEYS` and in `record`, its
//! proto record type, Zod schema and fixture, and a tombstone wherever it is
//! deleted or stops granting access (`feed`).

use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::stream::unfold;
use markiro_proto::{
    credentials, entities, CategoryTemplateDefault, ChangeItem, ChangesResponse,
    LabelTemplateRecord, LineRecord, OperatorBadgeRecord, OperatorRecord, OrgRecord, ProductRecord,
    Secret, SiteRecord,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqliteExecutor, SqlitePool};
use tokio::sync::watch;

use crate::auth::AuthDevice;
use crate::db;
use crate::error::{ApiError, ApiQuery};
use crate::server::AppState;

pub const DEFAULT_LIMIT: u32 = 500;
pub const MAX_LIMIT: u32 = 1000;

/// About how much item JSON one page carries. A template's `spec` may be
/// 256 KB, so a page cut by count alone could reach a hundred megabytes; a
/// page also ends before the revision that would take its items past this.
/// A revision larger than the budget still comes whole when it starts the
/// page, so the feed always moves on.
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Every feed record changed after `?1`: live rows of each entity, then
/// tombstones. `site` joins only once the wizard has initialized the host;
/// an operator only while active and a badge only while not revoked, since
/// their tombstones say they left. Archived products and disabled templates
/// stay, with their flags. A category default's id is `<code>:<purpose>`,
/// as `markiro_proto::category_default_id` builds it. A code release (plan
/// ДЗГ) is one row per box an applied document took apart, keyed by the box;
/// it is never deleted and has no tombstone.
const FEED_KEYS: &str = "\
    SELECT 'org_profile' AS entity, '1' AS id, rev, 0 AS deleted FROM org_profile WHERE rev > ?1 \
    UNION ALL SELECT 'site', '1', rev, 0 FROM site WHERE rev > ?1 AND initialized_at IS NOT NULL \
    UNION ALL SELECT 'lines', id, rev, 0 FROM lines WHERE rev > ?1 \
    UNION ALL SELECT 'operators', id, rev, 0 FROM operators WHERE rev > ?1 AND active = 1 \
    UNION ALL SELECT 'operator_badges', id, rev, 0 FROM operator_badges WHERE rev > ?1 AND revoked_at IS NULL \
    UNION ALL SELECT 'products', id, rev, 0 FROM products WHERE rev > ?1 \
    UNION ALL SELECT 'products', id, photo_rev, 0 FROM products \
        WHERE photo_rev > ?1 AND photo_rev <> rev \
    UNION ALL SELECT 'label_templates', id, rev, 0 FROM label_templates WHERE rev > ?1 \
    UNION ALL SELECT 'category_template_defaults', chz_group_code || ':' || purpose, rev, 0 \
        FROM category_template_defaults WHERE rev > ?1 \
    UNION ALL SELECT 'code_releases', box_id, rev, 0 FROM code_releases WHERE rev > ?1 \
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

#[derive(sqlx::FromRow)]
struct OrgFeedRow {
    name: String,
    inn: Option<String>,
    gln: String,
    gs1_prefixes: String,
    time_zone: String,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    default_duplicate_template_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ProductFeedRow {
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    archived: bool,
    status: String,
    photo_checksum: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TemplateFeedRow {
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    spec: String,
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
    let current = db::current_revision(&mut tx)
        .await
        .map_err(ApiError::internal)?;
    let page = page(&mut tx, since, limit).await?;
    let (items, more_after) = within_budget(&mut tx, page).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(ChangesResponse {
        host_id: state.host_id.clone(),
        rev: more_after.unwrap_or(current),
        // `more_after` can equal `current` when the last page happens to end
        // exactly on the host's newest revision: that is not "more to fetch".
        has_more: more_after.is_some_and(|rev| rev < current),
        items,
    }))
}

/// The page's records, ending before the first revision that would take
/// them past [`MAX_PAGE_BYTES`] of JSON; the first revision comes whole,
/// however large. Returns them with the last revision they hold completely
/// when more follow, or `None` when nothing does.
async fn within_budget(
    conn: &mut SqliteConnection,
    page: Page,
) -> Result<(Vec<ChangeItem>, Option<i64>), ApiError> {
    let mut items: Vec<ChangeItem> = Vec::with_capacity(page.keys.len());
    let mut bytes = 0;
    let mut keys = page.keys.iter().peekable();
    while let Some(rev) = keys.peek().map(|key| key.rev) {
        let mut revision = Vec::new();
        let mut revision_bytes = 0;
        while let Some(key) = keys.next_if(|key| key.rev == rev) {
            let item = item(conn, key).await?;
            revision_bytes += serde_json::to_vec(&item).map_err(ApiError::internal)?.len();
            revision.push(item);
        }
        if !items.is_empty() && bytes + revision_bytes > MAX_PAGE_BYTES {
            let last = items.last().map(|item| item.rev);
            return Ok((items, last));
        }
        bytes += revision_bytes;
        items.append(&mut revision);
    }
    Ok((items, page.more_after))
}

/// Up to `limit` keys after `since`, cut only between revisions. When one
/// revision alone is larger than a page, it comes whole.
async fn page(conn: &mut SqliteConnection, since: i64, limit: u32) -> Result<Page, ApiError> {
    let limit = usize::try_from(limit).map_err(ApiError::internal)?;
    let fetched: Vec<Key> = sqlx::query_as(&format!(
        "{FEED_KEYS} ORDER BY rev, entity, id, deleted DESC LIMIT ?2"
    ))
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
        "SELECT entity, id, rev, deleted FROM ({FEED_KEYS}) WHERE rev = ?2 \
         ORDER BY entity, id, deleted DESC"
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
            let row: OrgFeedRow = sqlx::query_as(
                "SELECT name, inn, gln, gs1_prefixes, time_zone, default_box_template_id, \
                 default_pallet_template_id, default_duplicate_template_id \
                 FROM org_profile WHERE id = 1",
            )
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OrgRecord {
                name: row.name,
                inn: row.inn,
                gln: row.gln,
                gs1_prefixes: serde_json::from_str(&row.gs1_prefixes)
                    .map_err(ApiError::internal)?,
                time_zone: row.time_zone,
                default_box_template_id: row.default_box_template_id,
                default_pallet_template_id: row.default_pallet_template_id,
                default_duplicate_template_id: row.default_duplicate_template_id,
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
                badge_salt: Secret::new(STANDARD.encode(badge_salt)),
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
        entities::OPERATORS => {
            let (login, name, role, pin_phc): (String, String, Option<String>, String) =
                sqlx::query_as("SELECT login, name, role, pin_phc FROM operators WHERE id = ?")
                    .bind(&key.id)
                    .fetch_one(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
            serde_json::to_value(OperatorRecord {
                login,
                name,
                role,
                pin_phc: Secret::new(pin_phc),
            })
        }
        entities::OPERATOR_BADGES => {
            let (operator_id, badge_phc, label): (String, String, Option<String>) = sqlx::query_as(
                "SELECT operator_id, badge_phc, label FROM operator_badges WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(OperatorBadgeRecord {
                operator_id,
                badge_phc: Secret::new(badge_phc),
                label,
            })
        }
        entities::PRODUCTS => {
            let row: ProductFeedRow = sqlx::query_as(
                "SELECT gtin14, name, print_name, chz_group_code, box_capacity, \
                 pallet_box_capacity, shelf_life_days, default_box_template_id, \
                 default_pallet_template_id, archived, status, \
                 (SELECT ph.checksum FROM product_photos ph WHERE ph.product_id = products.id) \
                 AS photo_checksum FROM products WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(ProductRecord {
                gtin14: row.gtin14,
                name: row.name,
                print_name: row.print_name,
                chz_product_group_code: row.chz_group_code,
                box_capacity: row.box_capacity,
                pallet_box_capacity: row.pallet_box_capacity,
                shelf_life_days: row.shelf_life_days,
                default_box_template_id: row.default_box_template_id,
                default_pallet_template_id: row.default_pallet_template_id,
                archived: row.archived,
                status: row.status.parse().map_err(ApiError::internal)?,
                photo_checksum: row.photo_checksum,
            })
        }
        entities::LABEL_TEMPLATES => {
            let row: TemplateFeedRow = sqlx::query_as(
                "SELECT name, purpose, enabled, category_codes, stock, spec \
                 FROM label_templates WHERE id = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(LabelTemplateRecord {
                name: row.name,
                purpose: row.purpose.parse().map_err(ApiError::internal)?,
                enabled: row.enabled,
                chz_product_group_codes: row
                    .category_codes
                    .map(|codes| serde_json::from_str(&codes))
                    .transpose()
                    .map_err(ApiError::internal)?,
                stock: row.stock,
                spec: serde_json::from_str(&row.spec).map_err(ApiError::internal)?,
            })
        }
        entities::CATEGORY_TEMPLATE_DEFAULTS => {
            let (code, purpose, template_id): (u32, String, String) = sqlx::query_as(
                "SELECT chz_group_code, purpose, template_id FROM category_template_defaults \
                 WHERE chz_group_code || ':' || purpose = ?",
            )
            .bind(&key.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            serde_json::to_value(CategoryTemplateDefault {
                chz_product_group_code: code,
                purpose: purpose.parse().map_err(ApiError::internal)?,
                template_id,
            })
        }
        entities::CODE_RELEASES => {
            let (shift_id, document_id, released_at, code_count): (String, String, String, u32) =
                sqlx::query_as(
                    "SELECT shift_id, document_id, released_at, code_count FROM code_releases \
                     WHERE box_id = ?",
                )
                .bind(&key.id)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            serde_json::to_value(markiro_proto::disaggregation::CodeReleaseRecord {
                shift_id,
                document_id,
                released_at,
                code_count,
            })
        }
        other => {
            return Err(ApiError::internal(format!(
                "no feed record type for {other}"
            )))
        }
    };
    value.map_err(ApiError::internal)
}

/// `GET /v1/changes/stream`: server-sent events. The first `rev` event
/// carries the current revision; after that, an event whenever the revision
/// grew. Events are strictly increasing, so a burst of commits collapses
/// into one, and an event means "fetch since your revision", not "a commit
/// happened". A comment line every heartbeat keeps the connection alive; the
/// stream ends when the host stops or its device is revoked.
pub async fn stream(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<impl IntoResponse, ApiError> {
    // Subscribe before reading the current revision: a commit in between
    // then shows up as one more event instead of being missed. Revocations
    // likewise: one committed after `AuthDevice` read the key but before
    // this subscription is caught by the check below instead.
    let revisions = state.revisions.subscribe();
    let revocations = state.revocations.subscribe();
    let stopping = state.stopping.subscribe();
    let current = {
        let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
        if !device_active(&mut *conn, &device.id)
            .await
            .map_err(ApiError::internal)?
        {
            return Err(ApiError::unauthorized(
                credentials::DEVICE,
                "unknown or revoked device key",
            ));
        }
        db::current_revision(&mut conn)
            .await
            .map_err(ApiError::internal)?
    };
    let follow = Follow {
        first: Some(current),
        last: current,
        revisions,
        revocations,
        stopping,
        pool: state.pool.clone(),
        device_id: device.id,
    };
    let events = unfold(follow, |mut follow| async move {
        if let Some(rev) = follow.first.take() {
            follow.last = rev;
            return Some((Ok::<_, Infallible>(rev_event(rev)), follow));
        }
        loop {
            if *follow.stopping.borrow() {
                return None;
            }
            // `wait_for` resolves to a `watch::Ref` that borrows `stopping`
            // until the whole `select!` ends, so the arms only say what woke
            // the stream; `follow` moves into the next state afterwards.
            let wake = tokio::select! {
                changed = follow.revisions.changed() => match changed {
                    Ok(()) => Wake::Revision(*follow.revisions.borrow_and_update()),
                    Err(_) => Wake::Stop,
                },
                changed = follow.revocations.changed() => match changed {
                    Ok(()) => Wake::Revocation,
                    Err(_) => Wake::Stop,
                },
                _ = follow.stopping.wait_for(|stopping| *stopping) => Wake::Stop,
            };
            match wake {
                Wake::Stop => return None,
                // Some device was revoked: end this stream if it was this
                // one. A failed check ends it too (fail closed); the device
                // reconnects, and `AuthDevice` checks its key again. The
                // failure is logged: the cause would otherwise be lost, and
                // it is a database error, which names no key or id.
                Wake::Revocation => {
                    let active = device_active(&follow.pool, &follow.device_id)
                        .await
                        .inspect_err(
                            |error| tracing::warn!(%error, "change stream: device check failed"),
                        )
                        .unwrap_or(false);
                    if !active {
                        return None;
                    }
                }
                // A watch change is not always news: a burst of commits can
                // coalesce into one wakeup, and a value at or below `last`
                // (nothing yet on the host, or a lower value written
                // directly, as in tests) is not forward progress. Keep
                // waiting for a revision the device has not already been
                // told about instead of sending a non-increasing event.
                Wake::Revision(rev) if rev > follow.last => {
                    follow.last = rev;
                    return Some((Ok(rev_event(rev)), follow));
                }
                Wake::Revision(_) => {}
            }
        }
    });
    Ok(Sse::new(events).keep_alive(KeepAlive::new().interval(state.stream_heartbeat)))
}

/// What a change stream carries from one event to the next.
struct Follow {
    /// The current revision, sent as the first event.
    first: Option<i64>,
    /// The last revision sent.
    last: i64,
    revisions: watch::Receiver<i64>,
    revocations: watch::Receiver<u64>,
    stopping: watch::Receiver<bool>,
    pool: SqlitePool,
    device_id: String,
}

/// What woke a change stream.
enum Wake {
    Revision(i64),
    Revocation,
    Stop,
}

/// The device is paired and not revoked.
async fn device_active<'c>(
    executor: impl SqliteExecutor<'c>,
    id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL")
            .bind(id)
            .fetch_optional(executor)
            .await?;
    Ok(found.is_some())
}

fn rev_event(rev: i64) -> Event {
    Event::default()
        .event("rev")
        .data(json!({ "rev": rev }).to_string())
}
