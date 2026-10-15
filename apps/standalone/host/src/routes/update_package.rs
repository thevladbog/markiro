//! Upload of an update package by an administrator (plan ОБН-3, spec
//! §10.11.2). `POST /v1/office/update-package/manifest` checks the signed
//! manifest (the release keys built in, the product, a version newer than
//! the running host, an installer within the limit) and opens the one
//! upload. `PUT /v1/office/update-package/{uploadId}/installer` takes the
//! installer as a stream of exactly the manifest's size (`Content-Length`
//! required and equal), hashes it on the fly, cuts it at the first byte
//! beyond, and makes the package `staged\` with one `update.package.stage`
//! row. The installer never passes the webview: the shell's `update_stage`
//! sends it from the disk. A refused upload changes nothing and writes no
//! row; a refused signature is logged by its code.

use std::io::Write;
use std::sync::Arc;

use aws_lc_rs::digest::{Context, SHA256};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::CONTENT_LENGTH;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use futures_util::StreamExt;
use markiro_proto::codes;
use markiro_proto::update::distribution::{
    constraints, reasons, UpdatePackageManifestRequest, UpdatePackageStaged, UpdatePackageUpload,
    MAX_MANIFEST_BYTES,
};
use serde_json::json;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::backup::copy::{classify_io, create_private};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::updates::{ManifestRefusal, UpdateStore, Upload, UploadError};

/// The manifest route's own body limit: a manifest of 64 KiB in its JSON
/// envelope.
pub const MANIFEST_BODY_LIMIT: usize = MAX_MANIFEST_BYTES + 4 * 1024;

/// The host's packages, or `not_found` on a host that keeps none.
pub fn store(state: &AppState) -> Result<&Arc<UpdateStore>, ApiError> {
    state
        .updates
        .as_ref()
        .ok_or_else(|| ApiError::not_found("this host keeps no update packages"))
}

fn refused(field: &str, reason: &str) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        codes::VALIDATION_FAILED,
        format!("{field}: {reason}"),
    )
    .with_details(json!({ "field": field, "reason": reason }))
}

fn manifest_refused(refusal: ManifestRefusal) -> ApiError {
    let reason = match refusal {
        ManifestRefusal::Malformed => reasons::MANIFEST_MALFORMED,
        ManifestRefusal::UnknownKey => reasons::MANIFEST_UNKNOWN_KEY,
        ManifestRefusal::Signature => reasons::MANIFEST_SIGNATURE,
        ManifestRefusal::WrongProduct => reasons::WRONG_PRODUCT,
        ManifestRefusal::TooLarge => reasons::TOO_LARGE,
    };
    tracing::warn!(reason, "an update manifest was refused");
    refused("manifest", reason)
}

fn io_refused(error: &std::io::Error) -> ApiError {
    if classify_io(error) == markiro_proto::backup::failure::DISK_FULL {
        ApiError::conflict(constraints::DISK_FULL, "the host's disk is full")
    } else {
        ApiError::internal(error)
    }
}

fn upload_refused(error: UploadError, host_version: &str) -> ApiError {
    match error {
        UploadError::NotNewer => ApiError::conflict(
            constraints::PACKAGE_NOT_NEWER,
            "the package is not newer than the running host",
        )
        .with_details(json!({
            "constraint": constraints::PACKAGE_NOT_NEWER,
            "hostVersion": host_version,
        })),
        UploadError::Unknown => {
            ApiError::conflict(constraints::UPLOAD_UNKNOWN, "no upload of this id waits")
        }
        UploadError::Io(error) => io_refused(&error),
    }
}

async fn abandon(store: &Arc<UpdateStore>, id: &str) {
    let store = store.clone();
    let id = id.to_owned();
    let _ = tokio::task::spawn_blocking(move || store.abandon_upload_blocking(&id)).await;
}

pub async fn post_manifest(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(request): ApiJson<UpdatePackageManifestRequest>,
) -> Result<Json<UpdatePackageUpload>, ApiError> {
    context.require_admin()?;
    let store = store(&state)?.clone();
    let checked = store
        .check_manifest(&request.manifest)
        .map_err(manifest_refused)?;
    let opening = store.clone();
    let upload = tokio::task::spawn_blocking(move || opening.begin_upload_blocking(checked))
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| upload_refused(error, store.host_version()))?;
    Ok(Json(UpdatePackageUpload {
        upload_id: upload.id,
        version: upload.manifest.version.to_string(),
        size_bytes: upload.manifest.size_bytes,
        sha256: upload.manifest.sha256,
    }))
}

pub async fn put_installer(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(upload_id): ApiPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<UpdatePackageStaged>, ApiError> {
    context.require_admin()?;
    let store = store(&state)?.clone();
    let upload = store
        .upload(&upload_id)
        .ok_or_else(|| upload_refused(UploadError::Unknown, store.host_version()))?;
    let declared = headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared != Some(upload.manifest.size_bytes) {
        abandon(&store, &upload_id).await;
        return Err(refused("installer", reasons::SIZE_MISMATCH));
    }
    if let Err(error) = receive(&upload, body).await {
        abandon(&store, &upload_id).await;
        return Err(error);
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if let Err(error) = context.require_admin_in(&mut tx).await {
        abandon(&store, &upload_id).await;
        return Err(error);
    }
    let version = upload.manifest.version.to_string();
    audit::record(
        &mut tx,
        &state.timestamp(),
        Entry {
            actor: context.actor(),
            action: actions::UPDATE_PACKAGE_STAGE,
            target_type: Some("update_package"),
            target_id: Some(&version),
            outcome: Outcome::Ok,
            details: json!({
                "version": version,
                "sha256": upload.manifest.sha256,
                "sizeBytes": upload.manifest.size_bytes,
                "kid": upload.manifest.kid,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // The row and the files go together: a failed rename rolls the row back.
    let finishing = store.clone();
    let id = upload_id.clone();
    tokio::task::spawn_blocking(move || finishing.finish_upload_blocking(&id))
        .await
        .map_err(ApiError::internal)?
        .map_err(|error| upload_refused(error, store.host_version()))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(UpdatePackageStaged {
        version,
        size_bytes: upload.manifest.size_bytes,
        sha256: upload.manifest.sha256,
    }))
}

enum Written {
    TooLong,
    Io(std::io::Error),
}

/// The body into the upload's partial file, hashed on the fly: exactly the
/// manifest's size, the manifest's SHA-256. The writing runs on a blocking
/// thread fed by a small channel, so a slow disk slows the client, not the
/// host.
async fn receive(upload: &Upload, body: Body) -> Result<(), ApiError> {
    let size = upload.manifest.size_bytes;
    let path = upload.partial();
    let (chunks, mut queue) = tokio::sync::mpsc::channel::<Bytes>(8);
    let writer = tokio::task::spawn_blocking(move || -> Result<(u64, String), Written> {
        let mut file = create_private(&path, true).map_err(Written::Io)?;
        let mut hash = Context::new(&SHA256);
        let mut written = 0u64;
        while let Some(chunk) = queue.blocking_recv() {
            written += chunk.len() as u64;
            if written > size {
                return Err(Written::TooLong);
            }
            file.write_all(&chunk).map_err(Written::Io)?;
            hash.update(&chunk);
        }
        file.sync_all().map_err(Written::Io)?;
        let hex = hash
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok((written, hex))
    });
    let mut stream = body.into_data_stream();
    let mut cut = false;
    while let Some(frame) = stream.next().await {
        match frame {
            Ok(bytes) => {
                if chunks.send(bytes).await.is_err() {
                    break; // the writer stopped: too long, or the disk
                }
            }
            Err(_) => {
                cut = true;
                break;
            }
        }
    }
    drop(chunks);
    let written = writer.await.map_err(ApiError::internal)?;
    match written {
        Err(Written::TooLong) => Err(refused("installer", reasons::TOO_LONG)),
        Err(Written::Io(error)) => Err(io_refused(&error)),
        Ok(_) if cut => Err(refused("installer", reasons::SIZE_MISMATCH)),
        Ok((written, _)) if written != size => Err(refused("installer", reasons::SIZE_MISMATCH)),
        Ok((_, sha256)) if sha256 != upload.manifest.sha256 => {
            Err(refused("installer", reasons::HASH_MISMATCH))
        }
        Ok(_) => Ok(()),
    }
}
