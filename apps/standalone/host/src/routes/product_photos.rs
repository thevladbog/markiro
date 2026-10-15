//! A product's photo (plan ТОВ): `GET /v1/office/products/{id}/photo` (every
//! office role), `PUT` and `DELETE` (administrators and technologists, as
//! every catalog write). The office makes the photo a JPEG of at most
//! 640 × 640 and 300 000 bytes in its webview (a JPEG, or a PNG / WebP when
//! the picture has transparency); the host checks the sides, the length and
//! the magic bytes (`validate::product_photo`), stores the true media type
//! (the answer carries it as `mediaType`; the picture goes as base64 inside
//! JSON, so no content-type or sniffing is involved) and keeps one row
//! per product or none. It never parses the picture, as the organization's
//! logo (`org_logo.rs`).
//!
//! The same photo sent again writes nothing. A change takes a revision (beta
//! 3: the station shows the photo on its shift cards) but not the product's
//! `rev`, which is the office's `expectedRev`: it stamps `products.photo_rev`,
//! and the feed re-sends the product with the photo's checksum
//! (`routes/changes.rs`). A shift's snapshot never holds it; the station
//! fetches the bytes with `GET /v1/device/products/{id}/photo` ([`device_photo`]).
//! The product's list names it by its checksum (`photoChecksum`). The audit row
//! names the size, never the bytes. The request body is bounded by the
//! router's default JSON limit (2 MiB), far above the largest photo (400 000
//! characters of base64), so no route-specific limit is needed.

use axum::extract::State;
use axum::Json;
use markiro_proto::{ProductPhoto, ProductPhotoPut, ProductPhotoState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::{AskingDevice, OfficeContext};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

/// `not_found` unless `id` names a product, archived ones included.
async fn check_product(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM products WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("no such product"))
}

/// The product's photo, or `None`.
pub async fn read_photo(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<ProductPhoto>, ApiError> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let row: Option<(u32, u32, Vec<u8>, String, String, String)> = sqlx::query_as(
        "SELECT width, height, data, checksum, updated_at, media_type FROM product_photos \
         WHERE product_id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.map(
        |(width, height, data, checksum, updated_at, media_type)| ProductPhoto {
            width,
            height,
            data_base64: STANDARD.encode(data),
            media_type,
            checksum,
            updated_at,
        },
    ))
}

pub async fn get_photo(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ProductPhotoState>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    check_product(&mut conn, &id).await?;
    Ok(Json(ProductPhotoState {
        photo: read_photo(&mut conn, &id).await?,
    }))
}

pub async fn put_photo(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(put): ApiJson<ProductPhotoPut>,
) -> Result<Json<ProductPhotoState>, ApiError> {
    context.require_catalog()?;
    let (bytes, media_type) = validate::product_photo(put.width, put.height, &put.data_base64)?;
    let checksum = crate::backup::identity::sha256_hex(&bytes);
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_product(&mut tx, &id).await?;
    // The same photo again changes nothing: no write, no audit row; the
    // answer is the stored photo, its time included.
    if let Some(stored) = read_photo(&mut tx, &id).await? {
        if (stored.width, stored.height, stored.checksum.as_str())
            == (put.width, put.height, checksum.as_str())
        {
            return Ok(Json(ProductPhotoState {
                photo: Some(stored),
            }));
        }
    }
    sqlx::query(
        "INSERT INTO product_photos \
         (product_id, width, height, data, checksum, updated_at, media_type) \
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (product_id) DO UPDATE SET \
         width = excluded.width, height = excluded.height, data = excluded.data, \
         checksum = excluded.checksum, updated_at = excluded.updated_at, \
         media_type = excluded.media_type",
    )
    .bind(&id)
    .bind(put.width)
    .bind(put.height)
    .bind(&bytes)
    .bind(&checksum)
    .bind(&at)
    .bind(media_type)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let rev = stamp_photo_rev(&mut tx, &id).await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_PHOTO_SET,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "width": put.width, "height": put.height, "bytes": bytes.len(), "mediaType": media_type }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ProductPhotoState {
        photo: Some(ProductPhoto {
            width: put.width,
            height: put.height,
            data_base64: put.data_base64,
            media_type: media_type.to_owned(),
            checksum,
            updated_at: at,
        }),
    }))
}

/// Clears the photo; clearing none writes nothing and answers the same.
pub async fn delete_photo(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ProductPhotoState>, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_product(&mut tx, &id).await?;
    let removed = sqlx::query("DELETE FROM product_photos WHERE product_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    let mut stamped = None;
    if removed > 0 {
        stamped = Some(stamp_photo_rev(&mut tx, &id).await?);
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::PRODUCT_PHOTO_CLEAR,
                target_type: Some("product"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details: json!({}),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    match stamped {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev)
            .await
            .map_err(ApiError::internal)?,
        None => tx.commit().await.map_err(ApiError::internal)?,
    }
    Ok(Json(ProductPhotoState { photo: None }))
}

/// A device's read of a product's photo (`GET /v1/device/products/{id}/photo`),
/// for the copy a station keeps; the answer is the office's, `photo: null`
/// without one. A read through `AskingDevice`, which waits for no writer.
pub async fn device_photo(
    State(state): State<AppState>,
    AskingDevice(_device): AskingDevice,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ProductPhotoState>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    check_product(&mut conn, &id).await?;
    Ok(Json(ProductPhotoState {
        photo: read_photo(&mut conn, &id).await?,
    }))
}

/// Takes the revision of a photo change and stamps it on the product
/// (`photo_rev`, not `rev`: that one is the office's `expectedRev`).
async fn stamp_photo_rev(conn: &mut SqliteConnection, id: &str) -> Result<i64, ApiError> {
    let rev = next_revision(conn).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE products SET photo_rev = ? WHERE id = ?")
        .bind(rev)
        .bind(id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(rev)
}
