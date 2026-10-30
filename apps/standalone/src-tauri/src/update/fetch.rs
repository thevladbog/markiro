//! The host's update package on this device (plan ОБН-3, spec §10.11.4).
//! `update_fetch` reads the offer (`GET /v1/device/update`), checks the
//! manifest with the release keys built in — TLS proves only that our host
//! answered; the signature proves a release of Markiro —, refuses a
//! package not newer than this app, not of the host's version or above
//! this app's `minUpgradeFrom`, and downloads the installer over the pinned
//! connection into `<local data>\updates\<version>\`, resuming after a break
//! (`Range`, `If-Range`), never past the manifest's size, then checks the
//! whole file's SHA-256. One package is kept: another version's goes. The
//! launch is `update_install`'s (plan ОБН-2), which checks the pair again
//! through a handle nobody else may write. `update_check_manifest` checks a
//! manifest's signature for the webview, which shows notes only after it.

use std::path::{Path, PathBuf};

use markiro_proto::trust::{self, TrustError, UpdateChannel, UpdateManifestV1};
use markiro_proto::update::distribution::{DeviceUpdateOffer, PackageState, MAX_INSTALLER_BYTES};
use markiro_proto::update::{hash_exact, installer_name, AppVersion, PRODUCT};
use serde::Serialize;
use tauri::{Emitter, Runtime};
use tokio::io::AsyncWriteExt;

use crate::device::{DeviceState, HostLink};
use crate::host_client::{Credentials, HostResponse, PinnedClient, RequestError, TransferClient};

/// The folder of downloads under the app's local data folder.
pub const DOWNLOADS: &str = "updates";
pub const OFFER_PATH: &str = "/v1/device/update";
pub const INSTALLER_PATH: &str = "/v1/device/update/installer";
/// `{ received, total }` while the installer downloads.
pub const PROGRESS_EVENT: &str = "standalone://update-progress";

/// Where `update_fetch` keeps its package (Tauri state).
#[derive(Debug, Clone)]
pub struct DownloadsDir(pub PathBuf);

/// Why a fetch stopped; [`FetchError::code`] is what the webview reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    NotPaired,
    Unreachable,
    CertificateMismatch,
    KeyRejected,
    /// The host has no package to give (`missing`, `mismatch`, `invalid`).
    Unavailable,
    /// The host checks its package again: ask in a moment.
    Verifying,
    /// This device downloads already, or the host serves three others.
    Busy,
    ManifestMalformed,
    ManifestUnknownKey,
    ManifestSignature,
    /// Not newer than this app: no downgrade (spec §10.8).
    NotNewer,
    /// The package is not of the host's version (spec §10.11.4).
    HostMismatch,
    /// This app is older than the manifest's `minUpgradeFrom`.
    NeedsIntermediate,
    /// A byte beyond the manifest's size: the file was removed.
    TooLong,
    /// The whole file is not the manifest's SHA-256: it was removed.
    HashMismatch,
    /// The download broke off; the next fetch resumes it.
    Interrupted,
    /// The file could not be written on this computer.
    Storage,
    /// Any other answer of the host.
    Refused,
}

impl FetchError {
    pub fn code(self) -> &'static str {
        match self {
            FetchError::NotPaired => "not_paired",
            FetchError::Unreachable => "unreachable",
            FetchError::CertificateMismatch => "certificate_mismatch",
            FetchError::KeyRejected => "key_rejected",
            FetchError::Unavailable => "package_unavailable",
            FetchError::Verifying => "package_verifying",
            FetchError::Busy => "update_busy",
            FetchError::ManifestMalformed => "manifest_malformed",
            FetchError::ManifestUnknownKey => "manifest_unknown_key",
            FetchError::ManifestSignature => "manifest_signature",
            FetchError::NotNewer => "not_newer",
            FetchError::HostMismatch => "host_mismatch",
            FetchError::NeedsIntermediate => "needs_intermediate",
            FetchError::TooLong => "too_long",
            FetchError::HashMismatch => "hash_mismatch",
            FetchError::Interrupted => "interrupted",
            FetchError::Storage => "storage",
            FetchError::Refused => "refused",
        }
    }
}

fn request_error(error: RequestError) -> FetchError {
    match error {
        RequestError::CertificateMismatch => FetchError::CertificateMismatch,
        _ => FetchError::Unreachable,
    }
}

/// What a finished fetch gives the webview: the manifest beside the
/// installer, which `update_install` takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub version: String,
    pub manifest_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct FetchProgress {
    pub received: u64,
    pub total: u64,
}

/// A checked manifest as the webview shows it (notes as text, never markup).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    pub version: String,
    pub channel: String,
    pub released_at: String,
    pub notes: Vec<String>,
    pub min_upgrade_from: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub size_bytes: u64,
}

impl ManifestView {
    pub(crate) fn of(manifest: &UpdateManifestV1) -> Self {
        Self {
            version: manifest.version.clone(),
            channel: match manifest.channel {
                UpdateChannel::Beta => "beta",
                UpdateChannel::Stable => "stable",
            }
            .to_owned(),
            released_at: manifest.released_at.clone(),
            notes: manifest.notes.clone(),
            min_upgrade_from: manifest.min_upgrade_from.clone(),
            protocol: manifest.protocol,
            min_protocol: manifest.min_protocol,
            size_bytes: manifest.installer.size_bytes,
        }
    }
}

/// The manifest of `text`, checked with `keyset`: the signature, the
/// product, a version and an installer name that can be a file's.
pub fn read_manifest(text: &str, keyset: &trust::Keyset) -> Result<UpdateManifestV1, FetchError> {
    let (manifest, _kid) =
        trust::verify_update_manifest(text.trim(), keyset).map_err(|error| match error {
            TrustError::Malformed => FetchError::ManifestMalformed,
            TrustError::UnknownKey => FetchError::ManifestUnknownKey,
            TrustError::BadSignature => FetchError::ManifestSignature,
        })?;
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    // The release's own name for the version (plan ОБН-2): never a path.
    if manifest.product != PRODUCT || manifest.installer.name != installer_name(&version) {
        return Err(FetchError::ManifestMalformed);
    }
    Ok(manifest)
}

/// The rules of spec §10.11.4 before a byte is downloaded: newer than this
/// app, of the host's version, this app not below `minUpgradeFrom`, a size
/// within the limit.
pub fn check_offer(
    manifest: &UpdateManifestV1,
    host_version: &str,
    own_version: &str,
) -> Result<(), FetchError> {
    let package: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    let own: AppVersion = own_version.parse().map_err(|_| FetchError::Refused)?;
    if package <= own {
        return Err(FetchError::NotNewer);
    }
    if host_version.parse::<AppVersion>().ok() != Some(package) {
        return Err(FetchError::HostMismatch);
    }
    let floor: AppVersion = manifest
        .min_upgrade_from
        .parse()
        .map_err(|_| FetchError::ManifestMalformed)?;
    if own < floor {
        return Err(FetchError::NeedsIntermediate);
    }
    let size = manifest.installer.size_bytes;
    if size == 0 || size > MAX_INSTALLER_BYTES {
        return Err(FetchError::ManifestMalformed);
    }
    Ok(())
}

/// Whether `chunk` more bytes after `received` stay within `total`.
pub fn fits(received: u64, chunk: usize, total: u64) -> bool {
    received
        .checked_add(chunk as u64)
        .is_some_and(|sum| sum <= total)
}

/// How a fetch runs. `stop_after` ends an attempt after that many bytes, as
/// a dropped Wi-Fi would — for tests; the app passes `None`.
pub struct FetchOptions<'a> {
    pub own_version: &'a str,
    pub downloads: &'a Path,
    pub stop_after: Option<u64>,
}

fn offer_of(answer: &HostResponse) -> Result<DeviceUpdateOffer, FetchError> {
    match answer.status {
        200 => answer
            .body
            .clone()
            .and_then(|body| serde_json::from_value(body).ok())
            .ok_or(FetchError::Refused),
        401 => Err(FetchError::KeyRejected),
        429 => Err(FetchError::Busy),
        _ => Err(FetchError::Refused),
    }
}

fn refusal(answer: &HostResponse) -> FetchError {
    let code = answer
        .body
        .as_ref()
        .and_then(|body| body["error"]["code"].as_str());
    match (answer.status, code) {
        (401, _) => FetchError::KeyRejected,
        (409, _) => FetchError::Unavailable,
        (503, Some("package_verifying")) => FetchError::Verifying,
        (503, _) | (429, _) => FetchError::Busy,
        _ => FetchError::Refused,
    }
}

async fn remove_file(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

/// Everything under `downloads` but `version`'s folder goes; that folder is
/// made.
async fn prepare_dir(downloads: &Path, version: &str) -> Result<PathBuf, FetchError> {
    tokio::fs::create_dir_all(downloads)
        .await
        .map_err(|_| FetchError::Storage)?;
    let mut entries = tokio::fs::read_dir(downloads)
        .await
        .map_err(|_| FetchError::Storage)?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.file_name().to_str() == Some(version) {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };
    }
    let dir = downloads.join(version);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| FetchError::Storage)?;
    Ok(dir)
}

/// Whether the file at `path` is exactly `total` bytes of `sha256`
/// (`markiro_proto::update::hash_exact`, plan ОБН-2).
async fn matches_manifest(path: &Path, total: u64, sha256: &str) -> bool {
    let path = path.to_path_buf();
    let hashed = tauri::async_runtime::spawn_blocking(move || {
        std::fs::File::open(&path)
            .ok()
            .and_then(|file| hash_exact(file, total).ok())
    })
    .await;
    matches!(hashed, Ok(Some(hex)) if hex == sha256)
}

/// The package the host serves, into `options.downloads`.
pub async fn fetch(
    link: &HostLink,
    options: FetchOptions<'_>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Fetched, FetchError> {
    let pinned = PinnedClient::new(&link.address, &link.fingerprint).map_err(request_error)?;
    let credentials = Credentials {
        device_key: Some(link.key()),
        office_token: None,
        dataset_epoch: link.dataset_epoch.as_deref(),
    };
    let answer = pinned
        .send("GET", OFFER_PATH, None, credentials)
        .await
        .map_err(request_error)?;
    let offer = offer_of(&answer)?;
    let text = match (offer.package.state, offer.package.manifest) {
        (PackageState::Ok, Some(text)) => text,
        (PackageState::Verifying, _) => return Err(FetchError::Verifying),
        _ => return Err(FetchError::Unavailable),
    };
    let manifest = read_manifest(&text, &trust::update_keyset())?;
    check_offer(&manifest, &offer.host_version, options.own_version)?;
    let dir = prepare_dir(options.downloads, &manifest.version).await?;
    let manifest_path = dir.join(format!(
        "markiro-standalone-{}.update.jws",
        manifest.version
    ));
    let target = dir.join(&manifest.installer.name);
    let partial = dir.join(format!("{}.partial", manifest.installer.name));
    // A partial file of another package of the same version (the host's
    // package changed between attempts) is never resumed.
    let kept = tokio::fs::read_to_string(&manifest_path).await.ok();
    if kept.as_deref().map(str::trim) != Some(text.trim()) {
        remove_file(&partial).await;
        remove_file(&target).await;
    }
    tokio::fs::write(&manifest_path, text.trim().as_bytes())
        .await
        .map_err(|_| FetchError::Storage)?;
    let total = manifest.installer.size_bytes;
    let sha256 = manifest.installer.sha256.clone();
    if !matches_manifest(&target, total, &sha256).await {
        remove_file(&target).await;
        download(
            link,
            &partial,
            total,
            &format!("\"{sha256}\""),
            options.stop_after,
            progress,
        )
        .await?;
        if !matches_manifest(&partial, total, &sha256).await {
            remove_file(&partial).await;
            return Err(FetchError::HashMismatch);
        }
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|_| FetchError::Storage)?;
    }
    Ok(Fetched {
        version: manifest.version.clone(),
        manifest_path: manifest_path.display().to_string(),
        size_bytes: total,
    })
}

/// The installer into `partial`, resumed from what it holds.
async fn download(
    link: &HostLink,
    partial: &Path,
    total: u64,
    etag: &str,
    stop_after: Option<u64>,
    progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<(), FetchError> {
    let client = TransferClient::new(&link.address, &link.fingerprint).map_err(request_error)?;
    let mut received = tokio::fs::metadata(partial)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);
    if received > total {
        remove_file(partial).await;
        received = 0;
    }
    if received == total {
        return Ok(());
    }
    let resume = (received > 0).then_some((received, etag));
    let mut answer = client
        .download(INSTALLER_PATH, link.key(), resume)
        .await
        .map_err(request_error)?;
    let mut file = match answer.status() {
        200 => {
            received = 0;
            tokio::fs::File::create(partial)
                .await
                .map_err(|_| FetchError::Storage)?
        }
        206 if received > 0 && answer.range_start() == Some(received) => {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(partial)
                .await
                .map_err(|_| FetchError::Storage)?
        }
        206 | 416 => {
            remove_file(partial).await;
            return Err(FetchError::Interrupted);
        }
        _ => return Err(refusal(&answer.into_error().await)),
    };
    progress(received, total);
    let mut this_attempt = 0u64;
    loop {
        let chunk = match answer.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                let _ = file.flush().await;
                return Err(FetchError::Interrupted);
            }
        };
        if !fits(received, chunk.len(), total) {
            drop(file);
            remove_file(partial).await;
            return Err(FetchError::TooLong);
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| FetchError::Storage)?;
        received += chunk.len() as u64;
        this_attempt += chunk.len() as u64;
        progress(received, total);
        if stop_after.is_some_and(|limit| this_attempt >= limit) {
            file.flush().await.map_err(|_| FetchError::Storage)?;
            return Err(FetchError::Interrupted);
        }
    }
    file.flush().await.map_err(|_| FetchError::Storage)?;
    file.sync_all().await.map_err(|_| FetchError::Storage)?;
    if received == total {
        Ok(())
    } else {
        Err(FetchError::Interrupted)
    }
}

/// `update_fetch`: the host's package of its version for this app; progress
/// as [`PROGRESS_EVENT`]; a refusal is a bare code ([`FetchError::code`]).
#[tauri::command]
pub async fn update_fetch<R: Runtime>(
    app: tauri::AppHandle<R>,
    device: tauri::State<'_, DeviceState>,
    downloads: tauri::State<'_, DownloadsDir>,
) -> Result<Fetched, String> {
    let link = {
        let current = device.watch_link().borrow().clone();
        current.ok_or_else(|| FetchError::NotPaired.code().to_owned())?
    };
    // This build's version as `tauri.conf.json` has it, as plan ОБН-2's
    // `UpdateConfig.installed` and the webview's `getVersion()` read it.
    let own = app.package_info().version.to_string();
    let progress = move |received: u64, total: u64| {
        let _ = app.emit(PROGRESS_EVENT, FetchProgress { received, total });
    };
    fetch(
        &link,
        FetchOptions {
            own_version: &own,
            downloads: &downloads.0,
            stop_after: None,
        },
        &progress,
    )
    .await
    .map_err(|error| error.code().to_owned())
}

/// `update_check_manifest`: the signature and the view of a manifest the
/// webview read from the host; a refusal is a bare code.
#[tauri::command]
pub fn update_check_manifest(manifest: String) -> Result<ManifestView, String> {
    read_manifest(&manifest, &trust::update_keyset())
        .map(|manifest| ManifestView::of(&manifest))
        .map_err(|error| error.code().to_owned())
}

/// Whether `path` is the manifest of a package this app downloaded:
/// `<downloads>/<version>/markiro-standalone-<version>.update.jws` and
/// nothing else (`update_install` takes such a path besides the found ones).
pub fn downloaded_manifest(downloads: &Path, path: &Path) -> bool {
    let (Some(folder), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return false;
    };
    let Some(version) = folder.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    folder.parent() == Some(downloads)
        && version.parse::<AppVersion>().is_ok()
        && name == format!("markiro-standalone-{version}.update.jws")
}

#[cfg(test)]
mod tests {
    use markiro_proto::update::distribution::testing::sign_update_manifest;
    use serde_json::json;

    use super::*;

    fn manifest(version: &str, min_upgrade_from: &str) -> String {
        sign_update_manifest(&json!({
            "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
            "releasedAt": "2026-11-02T10:00:00Z",
            "sourceSha": "0123456789abcdef0123456789abcdef01234567",
            "installer": {
                "name": format!("markiro-standalone-{version}-windows-x86_64-setup.exe"),
                "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
                "sizeBytes": 22
            },
            "protocol": 3, "minProtocol": 1, "minUpgradeFrom": min_upgrade_from, "notes": ["Тест"]
        }))
    }

    fn read(text: &str) -> UpdateManifestV1 {
        read_manifest(text, &trust::update_keyset()).unwrap()
    }

    #[test]
    fn only_a_manifest_this_app_downloaded_counts_as_one() {
        let downloads = std::path::Path::new("/data/updates");
        assert!(downloaded_manifest(
            downloads,
            &downloads
                .join("0.3.0")
                .join("markiro-standalone-0.3.0.update.jws")
        ));
        for path in [
            downloads.join("markiro-standalone-0.3.0.update.jws"),
            downloads
                .join("0.3.0")
                .join("markiro-standalone-0.4.0.update.jws"),
            downloads.join("x").join("markiro-standalone-x.update.jws"),
            downloads
                .join("0.3.0")
                .join("..")
                .join("markiro-standalone-0.3.0.update.jws"),
            std::path::PathBuf::from("/elsewhere/0.3.0/markiro-standalone-0.3.0.update.jws"),
        ] {
            assert!(!downloaded_manifest(downloads, &path), "{}", path.display());
        }
    }

    #[test]
    fn the_rules_hold_before_a_byte_is_downloaded() {
        let package = read(&manifest("0.3.0", "0.2.0"));
        assert_eq!(check_offer(&package, "0.3.0", "0.2.1"), Ok(()));
        assert_eq!(
            check_offer(&package, "0.3.0", "0.3.0"),
            Err(FetchError::NotNewer)
        );
        assert_eq!(
            check_offer(&package, "0.3.0", "0.4.0"),
            Err(FetchError::NotNewer)
        );
        assert_eq!(
            check_offer(&package, "0.3.1", "0.2.1"),
            Err(FetchError::HostMismatch)
        );
        assert_eq!(
            check_offer(&package, "0.2.9", "0.2.1"),
            Err(FetchError::HostMismatch)
        );
        let later = read(&manifest("0.3.0", "0.2.5"));
        assert_eq!(
            check_offer(&later, "0.3.0", "0.2.1"),
            Err(FetchError::NeedsIntermediate)
        );
    }

    #[test]
    fn a_manifest_changed_after_signing_or_not_a_manifest_is_refused() {
        // A character inside the signature (the last one holds padding bits,
        // so changing it can make the base64 itself non-canonical).
        let mut tampered = manifest("0.3.0", "0.2.0");
        let at = tampered.rfind('.').unwrap() + 11;
        let changed = if tampered.as_bytes()[at] == b'A' {
            "B"
        } else {
            "A"
        };
        tampered.replace_range(at..=at, changed);
        assert_eq!(
            read_manifest(&tampered, &trust::update_keyset()).unwrap_err(),
            FetchError::ManifestSignature
        );
        assert_eq!(
            read_manifest("not.a.jws", &trust::update_keyset()).unwrap_err(),
            FetchError::ManifestMalformed
        );
    }

    #[test]
    fn a_byte_beyond_the_size_does_not_fit() {
        assert!(fits(0, 10, 10));
        assert!(fits(10, 0, 10));
        assert!(!fits(5, 6, 10));
        assert!(!fits(u64::MAX, 1, u64::MAX));
    }

    #[test]
    fn the_codes_the_webview_reads_are_stable() {
        assert_eq!(FetchError::Unavailable.code(), "package_unavailable");
        assert_eq!(FetchError::Verifying.code(), "package_verifying");
        assert_eq!(FetchError::Busy.code(), "update_busy");
        assert_eq!(FetchError::NeedsIntermediate.code(), "needs_intermediate");
    }
}
