//! SSCC blocks (stage 2a spec §4.3): `POST /v1/device/sscc/blocks`, for
//! stations only. A station asks for a block of boxes (extension 0) or of
//! pallets (extension 1, plan ПЛ-Х) when it has none for its shift's prefix
//! or its newest is half used; the host gives the next `site.box_block_size`
//! or `site.pallet_block_size` serials of the counter of that prefix and
//! extension (fewer at the end of the prefix's serials, then
//! `sscc_exhausted`) and moves the counter past them with a new revision in
//! the same transaction. A repeated `requestId` of the same station answers
//! the same block, even after others were issued; with another issuer prefix
//! or extension in the body it is `validation_failed` on `requestId`, since
//! the station would file the old block's serials under a prefix or for
//! labels they were not reserved for.
//! Revoking blocks and a screen of them per device are plan 2b's.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{codes, DeviceKind, SsccBlock, SsccBlockRequest};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

async fn read(
    conn: &mut SqliteConnection,
    device_id: &str,
    request_id: &str,
) -> Result<Option<SsccBlock>, ApiError> {
    let row: Option<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, issuer_prefix, extension, from_serial, to_serial FROM sscc_blocks \
         WHERE device_id = ? AND request_id = ?",
    )
    .bind(device_id)
    .bind(request_id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(|(id, issuer_prefix, extension, from_serial, to_serial)| {
        Ok(SsccBlock {
            id,
            issuer_prefix,
            extension: u8::try_from(extension).map_err(ApiError::internal)?,
            from_serial: u64::try_from(from_serial).map_err(ApiError::internal)?,
            to_serial: u64::try_from(to_serial).map_err(ApiError::internal)?,
        })
    })
    .transpose()
}

pub async fn issue_block(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<SsccBlockRequest>,
) -> Result<Json<SsccBlock>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden("only a station gets SSCC blocks"));
    }
    validate::client_uuid("requestId", &request.request_id)?;
    // Boxes take extension 0, pallets 1, each with its own counter and size.
    let size_column = match request.extension {
        0 => "box_block_size",
        1 => "pallet_block_size",
        _ => {
            return Err(ApiError::validation(
                "extension",
                "a block is of boxes (0) or of pallets (1)",
            ))
        }
    };
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device
        .require_station_in(&mut tx, "only a station gets SSCC blocks")
        .await?;
    if let Some(block) = read(&mut tx, &device.id, &request.request_id).await? {
        // A request id names one block of one prefix and extension (the
        // station keeps what it asked for beside the id and repeats the same
        // body). The same id for another prefix or extension is a station's
        // mistake, and answering the old block would hand it serials it
        // files under the wrong prefix, or prints on pallets that were
        // reserved for boxes.
        if block.issuer_prefix != request.issuer_prefix || block.extension != request.extension {
            return Err(ApiError::validation(
                "requestId",
                "this request id was used for another prefix or extension",
            ));
        }
        // Nothing to write: the transaction rolls back when dropped.
        return Ok(Json(block));
    }
    let next: Option<i64> = sqlx::query_scalar(
        "SELECT next_serial FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let next = next.ok_or_else(|| ApiError::validation("issuerPrefix", "no such SSCC counter"))?;
    let next = u64::try_from(next).map_err(ApiError::internal)?;
    let size: i64 = sqlx::query_scalar(&format!("SELECT {size_column} FROM site WHERE id = 1"))
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let size = u64::try_from(size).map_err(ApiError::internal)?;
    let capacity = validate::serial_capacity(&request.issuer_prefix);
    if next >= capacity {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::SSCC_EXHAUSTED,
            "no serial of this prefix is left",
        )
        .with_details(json!({
            "issuerPrefix": request.issuer_prefix,
            "extension": request.extension,
        })));
    }
    let to = (next + size - 1).min(capacity - 1);
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_counters SET next_serial = ?, rev = ? WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(i64::try_from(to + 1).map_err(ApiError::internal)?)
    .bind(rev)
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&request.issuer_prefix)
    .bind(i64::from(request.extension))
    .bind(&device.id)
    .bind(&request.request_id)
    .bind(i64::try_from(next).map_err(ApiError::internal)?)
    .bind(i64::try_from(to).map_err(ApiError::internal)?)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: Actor::Device(&device.id),
            action: actions::SSCC_BLOCK_ISSUE,
            target_type: Some("sscc_block"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "issuerPrefix": request.issuer_prefix,
                "extension": request.extension,
                "fromSerial": next,
                "toSerial": to,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(SsccBlock {
        id,
        issuer_prefix: request.issuer_prefix,
        extension: request.extension,
        from_serial: next,
        to_serial: to,
    }))
}
