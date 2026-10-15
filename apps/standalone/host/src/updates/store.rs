//! The package folders and their checks. Every function here is blocking:
//! an async caller goes through `spawn_blocking`.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

use markiro_proto::trust::{self, Keyset, TrustError};
use markiro_proto::update::distribution::{
    HostPackage, PackageState, MAX_INSTALLER_BYTES, MAX_MANIFEST_BYTES,
};
use markiro_proto::update::{hash_exact, installer_name, AppVersion, PRODUCT};

use crate::backup::copy::write_synced;

/// The signed manifest of a package folder.
pub const MANIFEST_FILE: &str = "manifest.update.jws";
pub const STAGED: &str = "staged";
pub const CURRENT: &str = "current";
pub const PREVIOUS: &str = "previous";
const INCOMING_PREFIX: &str = "incoming-";
const PARTIAL: &str = ".partial";

/// A package whose manifest, size and SHA-256 checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Package {
    /// The manifest's text as uploaded (trimmed): what a device checks.
    pub manifest_text: String,
    pub version: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kid: String,
    pub installer: PathBuf,
}

/// Size, change time, creation time and, on Unix, the inode of a file: what
/// the host compares before each answer to a download (spec §10.11.2). A
/// file index is not in stable `std` on Windows, where another file renamed
/// into place has another creation time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    pub fn of(path: &Path) -> io::Result<Self> {
        let meta = fs::metadata(path)?;
        Ok(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
            #[cfg(unix)]
            inode: std::os::unix::fs::MetadataExt::ino(&meta),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamps {
    manifest: FileStamp,
    installer: FileStamp,
}

/// A manifest whose signature and fields checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedManifest {
    pub text: String,
    pub version: AppVersion,
    pub installer_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub kid: String,
}

/// Why a manifest was refused; the route names it as `details.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestRefusal {
    Malformed,
    UnknownKey,
    Signature,
    WrongProduct,
    TooLarge,
}

/// Check a manifest's text with `keyset`: the signature (of the update type,
/// `markiro_proto::trust`), the product, the version, an installer name a
/// folder can hold, a SHA-256 of 64 lower-case hex digits and a size within
/// `max_installer`.
pub fn check_manifest(
    text: &str,
    keyset: &Keyset,
    max_installer: u64,
) -> Result<CheckedManifest, ManifestRefusal> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestRefusal::TooLarge);
    }
    let text = text.trim();
    let (manifest, kid) =
        trust::verify_update_manifest(text, keyset).map_err(|error| match error {
            // `UpdateManifestV1::from_json` (plan ЛЦ-1) refuses a foreign product
            // as malformed. Only a SIGNED document of another product is named
            // so: the signature is checked before the payload is read.
            TrustError::Malformed if signed_for_another_product(text, keyset) => {
                ManifestRefusal::WrongProduct
            }
            TrustError::Malformed => ManifestRefusal::Malformed,
            TrustError::UnknownKey => ManifestRefusal::UnknownKey,
            TrustError::BadSignature => ManifestRefusal::Signature,
        })?;
    if manifest.product != PRODUCT {
        return Err(ManifestRefusal::WrongProduct);
    }
    let version: AppVersion = manifest
        .version
        .parse()
        .map_err(|_| ManifestRefusal::Malformed)?;
    let installer = &manifest.installer;
    let hex = installer.sha256.len() == 64
        && installer
            .sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    // The release's own name for the version (plan ОБН-2): never a path.
    if installer.name != installer_name(&version) || !hex || installer.size_bytes == 0 {
        return Err(ManifestRefusal::Malformed);
    }
    if installer.size_bytes > max_installer {
        return Err(ManifestRefusal::TooLarge);
    }
    Ok(CheckedManifest {
        text: text.to_owned(),
        version,
        installer_name: installer.name.clone(),
        sha256: installer.sha256.clone(),
        size_bytes: installer.size_bytes,
        kid,
    })
}

/// Whether `text` is signed by a trusted release key (the update type) and
/// names a product other than ours.
fn signed_for_another_product(text: &str, keyset: &Keyset) -> bool {
    let Ok(verified) = trust::verify_compact(text, trust::UPDATE_TYP, keyset) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&verified.payload)
        .ok()
        .and_then(|payload| payload.get("product")?.as_str().map(|p| p != PRODUCT))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    Missing,
    Invalid,
}

/// At most one byte more than a manifest may have, as text.
fn read_manifest_file(path: &Path) -> io::Result<String> {
    let mut text = String::new();
    fs::File::open(path)?
        .take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_string(&mut text)?;
    Ok(text)
}

/// Verify the package in `dir` whole: the manifest, then the installer's
/// size and SHA-256, the installer unchanged while it was hashed.
fn read_package(
    dir: &Path,
    keyset: &Keyset,
    max_installer: u64,
) -> Result<(Package, Stamps), Fault> {
    let manifest_path = dir.join(MANIFEST_FILE);
    let text = match read_manifest_file(&manifest_path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(Fault::Missing),
        Err(_) => return Err(Fault::Invalid),
    };
    let checked = check_manifest(&text, keyset, max_installer).map_err(|_| Fault::Invalid)?;
    let installer = dir.join(&checked.installer_name);
    let before = FileStamp::of(&installer).map_err(|_| Fault::Invalid)?;
    let file = fs::File::open(&installer).map_err(|_| Fault::Invalid)?;
    // Exactly the manifest's size, in 64 KiB pieces (`markiro_proto::update`, plan ОБН-2).
    let sha256 = hash_exact(file, checked.size_bytes).map_err(|_| Fault::Invalid)?;
    let after = FileStamp::of(&installer).map_err(|_| Fault::Invalid)?;
    if sha256 != checked.sha256 || after != before {
        return Err(Fault::Invalid);
    }
    let manifest = FileStamp::of(&manifest_path).map_err(|_| Fault::Invalid)?;
    Ok((
        Package {
            manifest_text: checked.text,
            version: checked.version.to_string(),
            sha256,
            size_bytes: checked.size_bytes,
            kid: checked.kid,
            installer,
        },
        Stamps {
            manifest,
            installer: before,
        },
    ))
}

/// The version of the package in `dir` when its manifest's signature checks
/// out; the installer is not read.
fn signed_version(dir: &Path, keyset: &Keyset) -> Option<String> {
    let text = read_manifest_file(&dir.join(MANIFEST_FILE)).ok()?;
    check_manifest(&text, keyset, MAX_INSTALLER_BYTES)
        .ok()
        .map(|checked| checked.version.to_string())
}

enum Current {
    Ready(Package, Stamps),
    Verifying,
    Missing,
    Mismatch(String),
    Invalid,
}

/// The one upload in progress (spec §10.11.2: «плюс одна загрузка»).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub id: String,
    pub dir: PathBuf,
    pub manifest: CheckedManifest,
}

impl Upload {
    /// Where the installer is written until it checks out.
    pub fn partial(&self) -> PathBuf {
        self.dir
            .join(format!("{}{PARTIAL}", self.manifest.installer_name))
    }
}

struct Inner {
    current: Current,
    upload: Option<Upload>,
    /// A PUT is writing the installer of `upload`.
    receiving: bool,
    /// The generation of the newest check whose result is in `current`.
    applied: u64,
}

/// The result of one full check of `current\`, not yet remembered: a check
/// that began before another one ended is dropped by
/// [`UpdateStore::apply_verification`].
pub struct Verification {
    generation: u64,
    result: Current,
}

/// What the start and each hourly pass did with `staged\` (spec §10.11.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Promotion {
    /// No `staged\`.
    None,
    /// Newer than the running host: it waits for the host's update.
    Waiting { version: String },
    /// Not newer than the running host: removed.
    Stale { version: String },
    Promoted {
        version: String,
        /// The version that moved to `previous\`, when there was a current.
        previous: Option<String>,
    },
    /// It did not check out: removed.
    Failed { version: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartReport {
    pub promotion: Promotion,
    pub current: PackageState,
    pub current_version: Option<String>,
}

/// What [`UpdateStore::serve_blocking`] answers.
#[derive(Debug)]
pub enum Serve {
    Ready(Package),
    /// A file changed since the last full check: the state is `verifying`
    /// until the caller's [`UpdateStore::reverify_blocking`] ends.
    Changed,
    Unavailable(PackageState),
}

#[derive(Debug)]
pub enum UploadError {
    NotNewer,
    Unknown,
    /// Another PUT of this upload is writing its installer.
    Receiving,
    Io(io::Error),
}

pub struct UpdateStore {
    dir: PathBuf,
    keyset: Keyset,
    host_version: String,
    max_installer: u64,
    inner: Mutex<Inner>,
    /// The number of the latest check begun.
    generation: AtomicU64,
    /// Held across a promotion and across the end of an upload — both
    /// replace folders of `updates\` — but never across the long hashing of
    /// a check, so the hourly pass never sees a half-replaced `staged\`.
    swap: Mutex<()>,
}

impl UpdateStore {
    /// The packages in `dir` of a host running `host_version`, trusting the
    /// release keys of `keyset`.
    pub fn new(dir: PathBuf, keyset: Keyset, host_version: impl Into<String>) -> Self {
        Self {
            dir,
            keyset,
            host_version: host_version.into(),
            max_installer: MAX_INSTALLER_BYTES,
            inner: Mutex::new(Inner {
                current: Current::Missing,
                upload: None,
                receiving: false,
                applied: 0,
            }),
            generation: AtomicU64::new(0),
            swap: Mutex::new(()),
        }
    }

    /// Another limit of the installer's size; tests use a small one.
    pub fn with_max_installer(mut self, bytes: u64) -> Self {
        self.max_installer = bytes;
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn host_version(&self) -> &str {
        &self.host_version
    }

    pub fn max_installer(&self) -> u64 {
        self.max_installer
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while the lock was held leaves plain data behind.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_swap(&self) -> MutexGuard<'_, ()> {
        self.swap
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The service starts (after the migrations): strays and a partial
    /// upload go, `staged\` of the running version becomes current, and
    /// `current\` is verified whole. Reads whole installers: the service
    /// uses [`UpdateStore::open_quick_blocking`] and does the rest in the
    /// background, so a slow disk never delays the start.
    pub fn open_blocking(&self) -> io::Result<StartReport> {
        self.open_quick_blocking()?;
        Ok(self.finish_start_blocking())
    }

    /// The part of the start that reads no installer: strays go, and the
    /// state is `verifying` when a package folder is there (`missing` when
    /// none), so no package is offered before [`UpdateStore::finish_start_blocking`]
    /// has checked it whole.
    pub fn open_quick_blocking(&self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        self.clean();
        let waiting = self.dir.join(CURRENT).is_dir() || self.dir.join(STAGED).is_dir();
        let mut inner = self.lock();
        if matches!(inner.current, Current::Missing) && waiting {
            inner.current = Current::Verifying;
        }
        Ok(())
    }

    /// The rest of the start, after [`UpdateStore::open_quick_blocking`]:
    /// the promotion and the whole check of `current\`.
    pub fn finish_start_blocking(&self) -> StartReport {
        let promotion = self.promote_blocking();
        self.reverify_blocking();
        let (current, current_version) = self.current_state();
        StartReport {
            promotion,
            current,
            current_version,
        }
    }

    /// Everything in `updates\` but the three package folders goes (spec
    /// §10.11.2, «Гигиена диска»).
    fn clean(&self) {
        {
            let mut inner = self.lock();
            inner.upload = None;
            inner.receiving = false;
        }
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let folder = entry.file_type().is_ok_and(|kind| kind.is_dir());
            let known = matches!(
                entry.file_name().to_str(),
                Some(STAGED | CURRENT | PREVIOUS)
            );
            if !(folder && known) {
                remove_any(&entry.path());
            }
        }
    }

    /// `staged\` of the running version becomes `current\`, the current one
    /// `previous\` (the previous one goes); an older or broken `staged\`
    /// goes; a newer one waits.
    pub fn promote_blocking(&self) -> Promotion {
        let _swap = self.lock_swap();
        let staged = self.dir.join(STAGED);
        if !staged.is_dir() {
            return Promotion::None;
        }
        let package = match read_package(&staged, &self.keyset, self.max_installer) {
            Ok((package, _)) => package,
            Err(_) => {
                let version = signed_version(&staged, &self.keyset);
                remove_any(&staged);
                return Promotion::Failed { version };
            }
        };
        let host = self.host_version.parse::<AppVersion>().ok();
        match (package.version.parse::<AppVersion>().ok(), host) {
            (Some(version), Some(host)) if version > host => Promotion::Waiting {
                version: package.version,
            },
            (Some(version), Some(host)) if version == host => {
                let current = self.dir.join(CURRENT);
                let previous = self.dir.join(PREVIOUS);
                let moved = signed_version(&current, &self.keyset);
                let promoted = (|| -> io::Result<()> {
                    remove_any_io(&previous)?;
                    if current.exists() {
                        fs::rename(&current, &previous)?;
                    }
                    fs::rename(&staged, &current)
                })();
                match promoted {
                    Ok(()) => Promotion::Promoted {
                        version: package.version,
                        previous: moved,
                    },
                    Err(error) => {
                        tracing::warn!(%error, "the staged update package did not become current; the next pass tries again");
                        Promotion::Waiting {
                            version: package.version,
                        }
                    }
                }
            }
            _ => {
                remove_any(&staged);
                Promotion::Stale {
                    version: package.version,
                }
            }
        }
    }

    /// Verify `current\` whole, without remembering the result yet.
    pub fn verify_current_blocking(&self) -> Verification {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let result = match read_package(&self.dir.join(CURRENT), &self.keyset, self.max_installer) {
            Ok((package, stamps)) => {
                let host = self.host_version.parse::<AppVersion>().ok();
                if host.is_some() && package.version.parse::<AppVersion>().ok() == host {
                    Current::Ready(package, stamps)
                } else {
                    Current::Mismatch(package.version)
                }
            }
            Err(Fault::Missing) => Current::Missing,
            Err(Fault::Invalid) => Current::Invalid,
        };
        Verification { generation, result }
    }

    /// Remember a check's result unless a newer check's is in already (an
    /// older run must not undo a newer one). Whether it was remembered.
    pub fn apply_verification(&self, verification: Verification) -> bool {
        let mut inner = self.lock();
        if verification.generation <= inner.applied {
            return false;
        }
        inner.applied = verification.generation;
        inner.current = verification.result;
        true
    }

    /// Verify `current\` whole and remember the result.
    pub fn reverify_blocking(&self) {
        self.apply_verification(self.verify_current_blocking());
    }

    /// Whether the state of `current\` is one a new look can change: a
    /// transient read failure (a file an antivirus holds) leaves `invalid`,
    /// and a check that never ended leaves `verifying`.
    pub fn needs_recheck(&self) -> bool {
        matches!(
            self.lock().current,
            Current::Invalid | Current::Mismatch(_) | Current::Verifying
        )
    }

    /// A check that began after a change failed to end (its task panicked):
    /// `verifying` becomes `invalid`, which the hourly pass checks again.
    pub fn fail_verifying(&self) {
        let mut inner = self.lock();
        if matches!(inner.current, Current::Verifying) {
            inner.current = Current::Invalid;
        }
    }

    fn current_state(&self) -> (PackageState, Option<String>) {
        match &self.lock().current {
            Current::Ready(package, _) => (PackageState::Ok, Some(package.version.clone())),
            Current::Verifying => (PackageState::Verifying, None),
            Current::Missing => (PackageState::Missing, None),
            Current::Mismatch(version) => (PackageState::Mismatch, Some(version.clone())),
            Current::Invalid => (PackageState::Invalid, None),
        }
    }

    /// The current package for one answer to a device, its files unchanged
    /// since the last full check. A change turns the state to `verifying`.
    pub fn serve_blocking(&self) -> Serve {
        let manifest_path = self.dir.join(CURRENT).join(MANIFEST_FILE);
        let mut inner = self.lock();
        let (package, stamps) = match &inner.current {
            Current::Ready(package, stamps) => (package.clone(), stamps.clone()),
            Current::Verifying => return Serve::Unavailable(PackageState::Verifying),
            Current::Missing => return Serve::Unavailable(PackageState::Missing),
            Current::Mismatch(_) => return Serve::Unavailable(PackageState::Mismatch),
            Current::Invalid => return Serve::Unavailable(PackageState::Invalid),
        };
        let same = FileStamp::of(&package.installer).ok().as_ref() == Some(&stamps.installer)
            && FileStamp::of(&manifest_path).ok().as_ref() == Some(&stamps.manifest);
        if same {
            Serve::Ready(package)
        } else {
            inner.current = Current::Verifying;
            Serve::Changed
        }
    }

    /// The packages as the office sees them.
    pub fn status_blocking(&self) -> HostPackage {
        let (state, version) = self.current_state();
        HostPackage {
            state,
            version,
            staged: signed_version(&self.dir.join(STAGED), &self.keyset),
            previous: signed_version(&self.dir.join(PREVIOUS), &self.keyset),
            disk_bytes: disk_bytes(&self.dir),
        }
    }

    /// [`check_manifest`] with this store's keys and limit.
    pub fn check_manifest(&self, text: &str) -> Result<CheckedManifest, ManifestRefusal> {
        check_manifest(text, &self.keyset, self.max_installer)
    }

    /// Open the upload of a package newer than the running host: its folder
    /// with the manifest. An upload in progress goes first.
    pub fn begin_upload_blocking(&self, manifest: CheckedManifest) -> Result<Upload, UploadError> {
        match self.host_version.parse::<AppVersion>().ok() {
            Some(host) if manifest.version > host => {}
            _ => return Err(UploadError::NotNewer),
        }
        let replaced = {
            let mut inner = self.lock();
            inner.receiving = false;
            inner.upload.take()
        };
        if let Some(replaced) = replaced {
            remove_any(&replaced.dir);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.dir.join(format!("{INCOMING_PREFIX}{id}{PARTIAL}"));
        fs::create_dir_all(&self.dir).map_err(UploadError::Io)?;
        fs::create_dir(&dir).map_err(UploadError::Io)?;
        if let Err(error) = write_synced(&dir.join(MANIFEST_FILE), manifest.text.as_bytes()) {
            remove_any(&dir);
            return Err(UploadError::Io(error));
        }
        let upload = Upload { id, dir, manifest };
        let mut inner = self.lock();
        inner.upload = Some(upload.clone());
        inner.receiving = false;
        Ok(upload)
    }

    /// The upload of `id`, while it waits for its installer.
    pub fn upload(&self, id: &str) -> Option<Upload> {
        self.lock().upload.clone().filter(|upload| upload.id == id)
    }

    /// The upload of `id` for the one PUT that writes its installer: a
    /// second PUT meanwhile is refused (`Receiving`) and touches nothing.
    pub fn begin_receive(&self, id: &str) -> Result<Upload, UploadError> {
        let mut inner = self.lock();
        let upload = inner
            .upload
            .clone()
            .filter(|upload| upload.id == id)
            .ok_or(UploadError::Unknown)?;
        if inner.receiving {
            return Err(UploadError::Receiving);
        }
        inner.receiving = true;
        Ok(upload)
    }

    fn take_upload(&self, id: &str) -> Option<Upload> {
        let mut inner = self.lock();
        match inner.upload.take() {
            Some(upload) if upload.id == id => {
                inner.receiving = false;
                Some(upload)
            }
            other => {
                inner.upload = other;
                None
            }
        }
    }

    /// The installer arrived whole and checked: it takes its name, and the
    /// upload's folder replaces `staged\`.
    pub fn finish_upload_blocking(&self, id: &str) -> Result<Upload, UploadError> {
        let _swap = self.lock_swap();
        let upload = self.take_upload(id).ok_or(UploadError::Unknown)?;
        let installed = (|| -> io::Result<()> {
            fs::rename(
                upload.partial(),
                upload.dir.join(&upload.manifest.installer_name),
            )?;
            let staged = self.dir.join(STAGED);
            remove_any_io(&staged)?;
            fs::rename(&upload.dir, &staged)
        })();
        match installed {
            Ok(()) => Ok(upload),
            Err(error) => {
                remove_any(&upload.dir);
                Err(UploadError::Io(error))
            }
        }
    }

    /// A refused or broken upload: its folder goes.
    pub fn abandon_upload_blocking(&self, id: &str) {
        if let Some(upload) = self.take_upload(id) {
            remove_any(&upload.dir);
        }
    }
}

fn remove_any_io(path: &Path) -> io::Result<()> {
    let removed = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match removed {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn remove_any(path: &Path) {
    if let Err(error) = remove_any_io(path) {
        tracing::warn!(%error, path = %path.display(), "a leftover in updates could not be removed");
    }
}

/// What `updates\` takes: its files and those of its folders.
fn disk_bytes(dir: &Path) -> u64 {
    fn walk(dir: &Path, depth: u8) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match entry.metadata() {
                Ok(meta) if meta.is_dir() && depth > 0 => walk(&entry.path(), depth - 1),
                Ok(meta) if meta.is_file() => meta.len(),
                _ => 0,
            })
            .sum()
    }
    walk(dir, 1)
}
