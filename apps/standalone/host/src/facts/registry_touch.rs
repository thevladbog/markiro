//! The change time of a closed box (`boxes.changed_at`, migration `0037`): every write that changes
//! what `GET /v1/device/box-registry` shows about a box calls one of these in the same
//! transaction, with the host's clock in the stored timestamp format (`context.received_at`,
//! `AppState::timestamp()`). `tests/box_registry_touch.rs` knows every writer of `boxes`.

use sqlx::SqliteConnection;

use crate::error::ApiError;

/// The stamp a change gets: `at`, or the newest stamp committed so far when that is later. The
/// caller holds the write lock (`BEGIN IMMEDIATE`), so no other writer commits between this read
/// and the commit of the change: whatever a reader's snapshot closed its window at, this change
/// is stamped at or above it. A clock that went back therefore never puts a change into a window
/// that a device already walked (`routes::box_registry`).
async fn stamp(conn: &mut SqliteConnection, at: &str) -> Result<String, ApiError> {
    let newest: Option<String> =
        sqlx::query_scalar("SELECT MAX(changed_at) FROM boxes WHERE sscc IS NOT NULL")
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(newest.map_or_else(|| at.to_owned(), |newest| newest.max(at.to_owned())))
}

/// One closed box, by id (it closed, or was taken apart).
pub async fn box_by_id(
    conn: &mut SqliteConnection,
    box_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let at = stamp(&mut *conn, at).await?;
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE id = ? AND sscc IS NOT NULL")
        .bind(&at)
        .bind(box_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// One closed box, by its SSCC (a warehouse pallet took it or gave it back).
pub async fn box_by_sscc(
    conn: &mut SqliteConnection,
    sscc: &str,
    at: &str,
) -> Result<(), ApiError> {
    let at = stamp(&mut *conn, at).await?;
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE sscc = ?")
        .bind(&at)
        .bind(sscc)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// Every closed box of a production pallet (it closed, or was taken apart).
pub async fn pallet_boxes(
    conn: &mut SqliteConnection,
    pallet_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let at = stamp(&mut *conn, at).await?;
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE pallet_id = ? AND sscc IS NOT NULL")
        .bind(&at)
        .bind(pallet_id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// Every box now on a warehouse pallet (it closed, or is about to be taken apart).
pub async fn warehouse_pallet_boxes(
    conn: &mut SqliteConnection,
    pallet_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let at = stamp(&mut *conn, at).await?;
    sqlx::query(
        "UPDATE boxes SET changed_at = ? WHERE sscc IN \
         (SELECT box_sscc FROM warehouse_pallet_boxes WHERE pallet_id = ? AND removed_at IS NULL)",
    )
    .bind(&at)
    .bind(pallet_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}
