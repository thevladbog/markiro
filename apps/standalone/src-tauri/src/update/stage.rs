//! `update_stage` (plan ОБН-3, spec §10.11.2): a package found on this
//! computer (`update_scan`, plan ОБН-2) goes to the host, which keeps it as
//! `staged\` and serves it to the other devices once it runs that version.
//! The manifest is checked here first, so a wrong file stops before the
//! network; then it goes with the office session, and the installer follows
//! as a stream of the file with its exact size — never through the webview.
//! The host checks the signature, the size and the SHA-256 again.

use std::path::Path;

use markiro_proto::trust;
use markiro_proto::update::distribution::{UpdatePackageUpload, MAX_MANIFEST_BYTES};
use serde::Serialize;
use serde_json::json;

use super::fetch::read_manifest;
use crate::device::HostLink;
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError, TransferClient};

pub const MANIFEST_PATH: &str = "/v1/office/update-package/manifest";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageError {
    NotPaired,
    InvalidRequest,
    /// The manifest or the installer beside it is not on the disk.
    NotFound,
    Unreachable,
    CertificateMismatch,
    /// The office session ended: sign in again.
    SessionEnded,
    Forbidden,
    NotNewer,
    ManifestRefused,
    InstallerRefused,
    DiskFull,
    Storage,
    Refused,
}

impl StageError {
    pub fn code(self) -> &'static str {
        match self {
            StageError::NotPaired => "not_paired",
            StageError::InvalidRequest => "invalid_request",
            StageError::NotFound => "not_found",
            StageError::Unreachable => "unreachable",
            StageError::CertificateMismatch => "certificate_mismatch",
            StageError::SessionEnded => "session_ended",
            StageError::Forbidden => "forbidden",
            StageError::NotNewer => "package_not_newer",
            StageError::ManifestRefused => "manifest_refused",
            StageError::InstallerRefused => "installer_refused",
            StageError::DiskFull => "disk_full",
            StageError::Storage => "storage",
            StageError::Refused => "refused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub version: String,
    pub size_bytes: u64,
}

fn transport(error: RequestError) -> StageError {
    match error {
        RequestError::CertificateMismatch => StageError::CertificateMismatch,
        RequestError::InvalidRequest => StageError::InvalidRequest,
        _ => StageError::Unreachable,
    }
}

fn refusal(answer: &HostResponse) -> StageError {
    let error = answer.body.as_ref().map(|body| &body["error"]);
    let detail = |name: &str| error.and_then(|error| error["details"][name].as_str());
    match answer.status {
        401 => StageError::SessionEnded,
        403 => StageError::Forbidden,
        409 => match detail("constraint") {
            Some("package_not_newer") => StageError::NotNewer,
            Some("disk_full") => StageError::DiskFull,
            _ => StageError::Refused,
        },
        400 => match detail("field") {
            Some("installer") => StageError::InstallerRefused,
            _ => StageError::ManifestRefused,
        },
        _ => StageError::Refused,
    }
}

/// The manifest's text, at most one byte more than a manifest may have is
/// ever read: a file of any size (or a device that never ends) stops here.
async fn read_manifest_text(path: &Path) -> Result<String, StageError> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StageError::NotFound)?;
    let mut text = String::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)
        .await
        .map_err(|_| StageError::NotFound)?;
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(StageError::ManifestRefused);
    }
    Ok(text)
}

/// The package of `manifest_path` (its installer beside it, by the
/// manifest's name) to the host of `link`, with `office_token`'s session.
pub async fn stage(
    link: &HostLink,
    office_token: &str,
    manifest_path: &Path,
) -> Result<Staged, StageError> {
    let text = read_manifest_text(manifest_path).await?;
    let manifest =
        read_manifest(&text, &trust::update_keyset()).map_err(|_| StageError::ManifestRefused)?;
    let folder = manifest_path.parent().ok_or(StageError::InvalidRequest)?;
    let file = tokio::fs::File::open(folder.join(&manifest.installer.name))
        .await
        .map_err(|_| StageError::NotFound)?;
    let length = file
        .metadata()
        .await
        .map_err(|_| StageError::Storage)?
        .len();
    if length != manifest.installer.size_bytes {
        return Err(StageError::InstallerRefused);
    }
    let credentials = Credentials {
        device_key: Some(link.key()),
        office_token: Some(office_token),
    };
    let pinned = PinnedClient::new(&link.address, &link.fingerprint).map_err(transport)?;
    let answer = pinned
        .send(
            "POST",
            MANIFEST_PATH,
            Some(&json!({ "manifest": text.trim() })),
            credentials,
        )
        .await
        .map_err(transport)?;
    if answer.status != 200 {
        return Err(refusal(&answer));
    }
    let upload: UpdatePackageUpload = answer
        .body
        .and_then(|body| serde_json::from_value(body).ok())
        .ok_or(StageError::Refused)?;
    let client = TransferClient::new(&link.address, &link.fingerprint).map_err(transport)?;
    let answer = client
        .upload(
            &format!("/v1/office/update-package/{}/installer", upload.upload_id),
            credentials,
            file,
            length,
        )
        .await
        .map_err(transport)?;
    if answer.status != 200 {
        return Err(refusal(&answer));
    }
    Ok(Staged {
        version: upload.version,
        size_bytes: upload.size_bytes,
    })
}

/// `update_stage`: a manifest `update_scan` found (another path is
/// `invalid_request`) and its installer go to the host with the office
/// session; a refusal is a bare code ([`StageError::code`]).
#[tauri::command]
pub async fn update_stage(
    device: tauri::State<'_, crate::device::DeviceState>,
    updates: tauri::State<'_, super::UpdateState>,
    manifest_path: String,
    office_token: String,
) -> Result<Staged, String> {
    let path = updates
        .found_path(&manifest_path)
        .map_err(|error| error.code().to_owned())?;
    let link = {
        let current = device.watch_link().borrow().clone();
        current.ok_or_else(|| StageError::NotPaired.code().to_owned())?
    };
    stage(&link, &office_token, &path)
        .await
        .map_err(|error| error.code().to_owned())
}
