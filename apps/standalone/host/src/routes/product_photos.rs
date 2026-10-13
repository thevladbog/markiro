//! A product's photo (plan ТОВ): `GET /v1/office/products/{id}/photo` (every
//! office role), `PUT` and `DELETE` (administrators and technologists, as
//! every catalog write). The office makes the photo a JPEG of at most
//! 640 × 640 and 300 000 bytes in its webview; the host checks the sides, the
//! length and the JPEG signature (`validate::product_photo`) and keeps one row
//! per product or none. It never parses the picture, as the organization's
//! logo (`org_logo.rs`).
//!
//! A change takes no revision: the photo is not in the station feed or a
//! shift's snapshot — only the office's «Бланк смены» prints it — and the
//! product's list names it by its checksum (`photoChecksum`). The audit row
//! names the size, never the bytes. The request body is bounded by the
//! router's default JSON limit (2 MiB), far above the largest photo (400 000
//! characters of base64), so no route-specific limit is needed.

use axum::extract::State;
use axum::Json;
use markiro_proto::{ProductPhoto, ProductPhotoPut, ProductPhotoState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
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
    let row: Option<(u32, u32, Vec<u8>, String, String)> = sqlx::query_as(
        "SELECT width, height, data, checksum, updated_at FROM product_photos \
         WHERE product_id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(
        row.map(|(width, height, data, checksum, updated_at)| ProductPhoto {
            width,
            height,
            data_base64: STANDARD.encode(data),
            checksum,
            updated_at,
        }),
    )
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
    let bytes = validate::product_photo(put.width, put.height, &put.data_base64)?;
    let checksum = crate::backup::identity::sha256_hex(&bytes);
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_product(&mut tx, &id).await?;
    sqlx::query(
        "INSERT INTO product_photos (product_id, width, height, data, checksum, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (product_id) DO UPDATE SET \
         width = excluded.width, height = excluded.height, data = excluded.data, \
         checksum = excluded.checksum, updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(put.width)
    .bind(put.height)
    .bind(&bytes)
    .bind(&checksum)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_PHOTO_SET,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "width": put.width, "height": put.height, "bytes": bytes.len() }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(ProductPhotoState {
        photo: Some(ProductPhoto {
            width: put.width,
            height: put.height,
            data_base64: put.data_base64,
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
    if removed > 0 {
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
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(ProductPhotoState { photo: None }))
}
