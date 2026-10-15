//! The update routes of devices (plan ОБН-3, spec §10.11.3), outside
//! `protocol_guard`: a device of any protocol version — one the host
//! already refuses as `app_too_old` included — learns of its update and
//! gets it, but only with a live device key (`AuthDevice`); an office
//! session alone opens neither, and the device key opens no office upload.
//! Their answers are frozen like `hello`'s: new fields only additive.
//! `AuthDevice` records the device's version too (plan ОБН-1), so every
//! read keeps «Устройства и версии» current.

use std::io::{Seek, SeekFrom};

use axum::extract::State;
use axum::http::header::{
    HeaderName, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_RANGE, RANGE,
    RETRY_AFTER,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use markiro_proto::codes;
use markiro_proto::update::distribution::{
    constraints, DeviceUpdateOffer, OfferedPackage, PackageState,
};
use serde_json::json;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::begin_write;
use crate::error::ApiError;
use crate::server::AppState;
use crate::updates::limits::{Busy, BUSY_RETRY_AFTER_SECS};
use crate::updates::stream::{file_body, requested_span, Span, Unsatisfiable};

/// How soon a device asks again while the host checks its package.
pub const VERIFYING_RETRY_AFTER_SECS: u64 = 5;

fn with_retry_after(error: ApiError, seconds: u64) -> Response {
    let mut response = error.into_response();
    response
        .headers_mut()
        .insert(RETRY_AFTER, HeaderValue::from(seconds));
    response
}

fn unavailable() -> ApiError {
    ApiError::conflict(
        constraints::PACKAGE_UNAVAILABLE,
        "the host has no update package to give",
    )
}

fn verifying() -> Response {
    with_retry_after(
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            codes::PACKAGE_VERIFYING,
            "the host checks its update package again",
        ),
        VERIFYING_RETRY_AFTER_SECS,
    )
}

/// `GET /v1/device/update`: the host's version and its current package;
/// the manifest only for `ok`, which the device checks itself.
pub async fn offer(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceUpdateOffer>, ApiError> {
    state.update_limits.check_rate(&device.id)?;
    let Some(store) = state.updates.as_ref() else {
        return Ok(Json(DeviceUpdateOffer {
            host_version: crate::HOST_VERSION.to_owned(),
            package: OfferedPackage::unavailable(PackageState::Missing),
        }));
    };
    let package = match crate::updates::serve(store).await {
        Ok(package) => OfferedPackage {
            state: PackageState::Ok,
            manifest: Some(package.manifest_text),
            version: Some(package.version),
            size_bytes: Some(package.size_bytes),
            sha256: Some(package.sha256),
        },
        Err(state) => OfferedPackage::unavailable(state),
    };
    Ok(Json(DeviceUpdateOffer {
        host_version: store.host_version().to_owned(),
        package,
    }))
}

/// `GET /v1/device/update/installer`: the current package's installer,
/// whole or one range of it (spec §10.11.3). A download from byte 0 writes
/// one `update.download` row; a resumed one writes none. A `HEAD` answers
/// the headers alone, taking no slot and writing no row.
pub async fn installer(
    State(state): State<AppState>,
    device: AuthDevice,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    state.update_limits.check_rate(&device.id)?;
    let store = state.updates.as_ref().ok_or_else(unavailable)?;
    let package = match crate::updates::serve(store).await {
        Ok(package) => package,
        Err(PackageState::Verifying) => return Ok(verifying()),
        Err(_) => return Err(unavailable()),
    };
    let etag = format!("\"{}\"", package.sha256);
    // A HEAD (`get` serves it too) asks for the headers: no slot, no row.
    if method == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_LENGTH, package.size_bytes)
            .header(ETAG, &etag)
            .header(ACCEPT_RANGES, "bytes")
            .body(axum::body::Body::empty())
            .map_err(ApiError::internal);
    }
    let header = |name: HeaderName| headers.get(name).and_then(|value| value.to_str().ok());
    let span = match requested_span(header(RANGE), header(IF_RANGE), &etag, package.size_bytes) {
        Ok(span) => span,
        Err(Unsatisfiable) => {
            let mut response = ApiError::new(
                StatusCode::RANGE_NOT_SATISFIABLE,
                codes::VALIDATION_FAILED,
                "the file has no such range",
            )
            .with_details(json!({ "field": "range" }))
            .into_response();
            response.headers_mut().insert(
                CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{}", package.size_bytes))
                    .map_err(ApiError::internal)?,
            );
            return Ok(response);
        }
    };
    let slot = match state.update_limits.acquire(&device.id) {
        Ok(slot) => slot,
        Err(Busy::Device) => {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                codes::RATE_LIMITED,
                "this device downloads the update already",
            ))
        }
        Err(Busy::Host) => {
            return Ok(with_retry_after(
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    codes::UPDATE_BUSY,
                    "three devices download the update already",
                ),
                BUSY_RETRY_AFTER_SECS,
            ))
        }
    };
    let (start, end) = match span {
        Span::Whole => (0, package.size_bytes - 1),
        Span::Part { start, end } => (start, end),
    };
    let path = package.installer.clone();
    let file = tokio::task::spawn_blocking(move || -> std::io::Result<std::fs::File> {
        let mut file = std::fs::File::open(&path)?;
        file.seek(SeekFrom::Start(start))?;
        Ok(file)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|_| unavailable())?;
    if start == 0 {
        let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
        device.require_live_in(&mut tx).await?;
        audit::record(
            &mut tx,
            &state.timestamp(),
            Entry {
                actor: Actor::Device(&device.id),
                action: actions::UPDATE_DOWNLOAD,
                target_type: Some("update_package"),
                target_id: Some(&package.version),
                outcome: Outcome::Ok,
                details: json!({
                    "version": package.version,
                    "sha256": package.sha256,
                    "sizeBytes": package.size_bytes,
                }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        tx.commit().await.map_err(ApiError::internal)?;
    }
    tracing::info!(device = %device.id, start, end, etag = %etag, "an update download began");
    let mut response = Response::builder()
        .status(if span == Span::Whole {
            StatusCode::OK
        } else {
            StatusCode::PARTIAL_CONTENT
        })
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(CONTENT_LENGTH, end - start + 1)
        .header(ETAG, &etag)
        .header(ACCEPT_RANGES, "bytes");
    if span != Span::Whole {
        response = response.header(
            CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", package.size_bytes),
        );
    }
    response
        .body(file_body(file, end - start + 1, state.download_stall, slot))
        .map_err(ApiError::internal)
}
