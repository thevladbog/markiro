//! Updates from a file (plan ОБН-2, spec §10.1–§10.5): the shell finds the
//! packages, checks the signed manifest and the installer beside it, and
//! starts that very installer with Windows' administrator prompt. The
//! webview names a package only by a path this module found itself; the
//! keys, the installer's bytes and the launch stay here.
//!
//! - [`package`] finds `*.update.jws` in `Документы\Markiro\Обновления` and on
//!   removable drives, and reads an installer through a handle that lets
//!   nobody write, rename or delete it while the app holds it;
//! - [`rules`] decides what the version rules of spec §10.7–§10.8 allow;
//! - [`launch`] starts the installer with Windows' administrator prompt
//!   (`ShellExecuteExW`, verb `runas`; a fake in tests);
//! - [`pending`] keeps `update-pending.json`, the outcome the next start reads.

pub mod fetch;
pub mod launch;
pub mod online;
pub mod package;
pub mod pending;
pub mod rules;
pub mod stage;

use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use markiro_proto::trust::Keyset;
use markiro_proto::update::AppVersion;
use serde::Serialize;
use serde_json::Value;

use crate::device::DeviceState;
use crate::host_probe::{self, HostVersions};
use crate::installation::InstallRole;
use crate::lockdown::{self, LockdownState};
use crate::office_files::{self, OfficeFilesError};
use launch::{LaunchError, Launcher, INSTALLER_ARGUMENTS};
use package::{Checked, FoundPackage, PackageError, RemovableDrives};
use pending::{Pending, UpdateOutcome};
use rules::{Comparison, Confirmation, Decision, HostCheck, Refusal};

/// Why an update command failed: the bare code the webview reads
/// (`src/office/info/update-shell.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    /// A path the last search did not find, or a confirmation of no known name.
    InvalidRequest,
    DocumentsUnavailable,
    Storage,
    /// Not Windows, or this build's version is no `X.Y.Z` (a development build).
    Unsupported,
    ManifestMalformed,
    ManifestUnknownKey,
    ManifestSignature,
    InstallerMissing,
    InstallerMismatch,
    /// The version rules refuse this package (the report says why).
    UpdateRefused,
    /// A warning of the report the person has not confirmed.
    ConfirmationRequired,
    /// Windows' administrator prompt was refused or cancelled.
    UacCancelled,
    LaunchFailed,
}

impl UpdateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::DocumentsUnavailable => "documents_unavailable",
            Self::Storage => "storage",
            Self::Unsupported => "unsupported",
            Self::ManifestMalformed => "manifest_malformed",
            Self::ManifestUnknownKey => "manifest_unknown_key",
            Self::ManifestSignature => "manifest_signature",
            Self::InstallerMissing => "installer_missing",
            Self::InstallerMismatch => "installer_mismatch",
            Self::UpdateRefused => "update_refused",
            Self::ConfirmationRequired => "confirmation_required",
            Self::UacCancelled => "uac_cancelled",
            Self::LaunchFailed => "launch_failed",
        }
    }
}

impl From<PackageError> for UpdateError {
    fn from(error: PackageError) -> Self {
        match error {
            PackageError::ManifestMalformed => Self::ManifestMalformed,
            PackageError::ManifestUnknownKey => Self::ManifestUnknownKey,
            PackageError::ManifestSignature => Self::ManifestSignature,
            PackageError::InstallerMissing => Self::InstallerMissing,
            PackageError::InstallerMismatch => Self::InstallerMismatch,
            PackageError::Storage => Self::Storage,
        }
    }
}

impl From<LaunchError> for UpdateError {
    fn from(error: LaunchError) -> Self {
        match error {
            LaunchError::Cancelled => Self::UacCancelled,
            LaunchError::Failed(_) => Self::LaunchFailed,
            LaunchError::Unsupported => Self::Unsupported,
        }
    }
}

/// What the report of a checked package tells the webview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedReport {
    pub path: String,
    pub kid: String,
    /// The signed manifest, camelCase, as `@markiro/domain` reads it.
    pub manifest: Value,
    /// This app's version.
    pub installed: String,
    /// The installer's full path, for a manual install and `Get-FileHash`.
    pub installer_path: String,
    pub comparison: Comparison,
    pub refusal: Option<Refusal>,
    pub confirmations: Vec<Confirmation>,
    /// The host this PC answers to, as its `hello` said; `None` on the host's
    /// own PC (not asked) or when it did not answer.
    pub host: Option<HostVersions>,
}

/// What [`UpdateState::load`] is built from; `run` gives the real ones, tests their own.
pub struct UpdateConfig {
    /// This build's version (`tauri.conf.json`, as `getVersion()` reads it).
    pub installed: String,
    /// The app's local data folder, where `update-pending.json` lives.
    pub data_dir: PathBuf,
    /// The system's documents folder, `None` when the user has none.
    pub documents: Option<PathBuf>,
    pub drives: Arc<dyn RemovableDrives>,
    pub launcher: Arc<dyn Launcher>,
    /// The release keys this build trusts (`markiro_proto::trust::update_keyset`).
    pub keyset: Keyset,
    /// Leaves the app (`AppHandle::exit` in `run`).
    pub exit: Arc<dyn Fn(i32) + Send + Sync>,
}

/// The update commands' state: what the last search found (the only paths
/// `update_verify` and `update_install` take) and the outcome the start read.
pub struct UpdateState {
    installed: String,
    data_dir: PathBuf,
    updates_dir: Option<PathBuf>,
    drives: Arc<dyn RemovableDrives>,
    launcher: Arc<dyn Launcher>,
    keyset: Arc<Keyset>,
    exit: Arc<dyn Fn(i32) + Send + Sync>,
    found: Mutex<Vec<PathBuf>>,
    outcome: Mutex<Option<UpdateOutcome>>,
    /// The installer's handle once Windows started it: kept until the
    /// process ends, so the file cannot be written, renamed or deleted while
    /// the installer reopens itself to read its data (NSIS does).
    leaving: Mutex<Option<File>>,
}

/// Runs blocking file work (a search, a 60 MB hash, the launch) off the IPC thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, UpdateError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| UpdateError::Storage)
}

/// The host this PC answers to: none asked on the host's own PC; else the
/// pairing's address, or this computer's host when there is no pairing.
async fn host_check(device: &DeviceState) -> HostCheck {
    if device.install_role() == Some(InstallRole::Host) {
        return HostCheck::NotNeeded;
    }
    // A paired PC reads the host's versions through the pinned connection:
    // only the host it was paired with can say what version it runs. An
    // unpaired PC has no certificate to hold the host to and only looks.
    let seen = match device.status() {
        Ok(Some(status)) => {
            host_probe::pinned_host_versions(&status.host_address, &status.fingerprint).await
        }
        _ => host_probe::host_versions(&crate::local_host_address()).await,
    };
    match seen {
        Ok(seen) => HostCheck::Seen(seen),
        Err(_) => HostCheck::Silent,
    }
}

impl UpdateState {
    /// The state, with the outcome of the last update read from the data
    /// folder (`pending::take_outcome`).
    pub fn load(config: UpdateConfig) -> Self {
        let outcome = pending::take_outcome(&config.data_dir, &config.installed);
        Self {
            updates_dir: config.documents.map(|documents| {
                documents
                    .join(office_files::APP_FOLDER)
                    .join(office_files::UPDATES_ROOT)
            }),
            installed: config.installed,
            data_dir: config.data_dir,
            drives: config.drives,
            launcher: config.launcher,
            keyset: Arc::new(config.keyset),
            exit: config.exit,
            found: Mutex::new(Vec::new()),
            outcome: Mutex::new(outcome),
            leaving: Mutex::new(None),
        }
    }

    fn installed_version(&self) -> Result<AppVersion, UpdateError> {
        self.installed.parse().map_err(|_| UpdateError::Unsupported)
    }

    /// A path the last search found, or the manifest of a package this app
    /// downloaded from the host or the optional release channel;
    /// anything else is `invalid_request`. `update_stage` asks it too.
    pub(crate) fn found_path(&self, path: &str) -> Result<PathBuf, UpdateError> {
        let found = self
            .found
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|found| found.to_string_lossy() == path)
            .cloned();
        if let Some(found) = found {
            return Ok(found);
        }
        let downloaded = PathBuf::from(path);
        if fetch::downloaded_manifest(&self.downloads(), &downloaded)
            || online::downloaded_manifest(&self.data_dir, &downloaded)
        {
            return Ok(downloaded);
        }
        Err(UpdateError::InvalidRequest)
    }

    /// Where `update_fetch` keeps the package from the host (plan ОБН-3).
    fn downloads(&self) -> PathBuf {
        self.data_dir.join(fetch::DOWNLOADS)
    }

    /// The packages in the updates folder and on removable drives; their
    /// paths become the ones the other commands take.
    pub async fn scan(&self) -> Result<Vec<FoundPackage>, UpdateError> {
        let drives = Arc::clone(&self.drives);
        let updates_dir = self.updates_dir.clone();
        let keyset = Arc::clone(&self.keyset);
        let found = blocking(move || {
            package::scan(
                &package::places(updates_dir.as_deref(), &drives.roots()),
                &keyset,
            )
        })
        .await?;
        *self.found.lock().unwrap_or_else(PoisonError::into_inner) =
            found.iter().map(|package| package.source.clone()).collect();
        Ok(found)
    }

    /// The package at `path` checked whole, and what the rules say of it.
    async fn check(
        &self,
        device: &DeviceState,
        path: &str,
    ) -> Result<(Checked, Decision, HostCheck), UpdateError> {
        let source = self.found_path(path)?;
        // A package from the host must be of the host's very version (plan
        // ОБН-3, spec §10.11.4); a file keeps the protocol rule of §10.7.
        let from_host = fetch::downloaded_manifest(&self.downloads(), &source);
        let installed = self.installed_version()?;
        let host = host_check(device).await;
        let keyset = Arc::clone(&self.keyset);
        let checked = blocking(move || package::verify(&source, &keyset)).await??;
        let mut offered = checked.manifest.offered();
        offered.from_host = from_host;
        let decision = rules::decide(offered, &installed, &host);
        Ok((checked, decision, host))
    }

    pub async fn verify(
        &self,
        device: &DeviceState,
        path: &str,
    ) -> Result<VerifiedReport, UpdateError> {
        let (checked, decision, host) = self.check(device, path).await?;
        Ok(VerifiedReport {
            path: path.to_owned(),
            kid: checked.manifest.kid.clone(),
            manifest: serde_json::to_value(&checked.manifest.manifest)
                .map_err(|_| UpdateError::ManifestMalformed)?,
            installed: self.installed.clone(),
            installer_path: checked.installer_path.to_string_lossy().into_owned(),
            comparison: decision.comparison,
            refusal: decision.refusal,
            confirmations: decision.confirmations,
            host: match host {
                HostCheck::Seen(seen) => Some(seen),
                HostCheck::NotNeeded | HostCheck::Silent => None,
            },
        })
    }

    /// Checks the package again, refuses what the rules refuse or what was
    /// not confirmed, writes the mark, starts the installer with the
    /// administrator prompt in front of `owner` (the app's window, 0 for
    /// none; see [`Launcher`]) and leaves the app (spec §10.4 steps 2, 5–7).
    /// A refused start puts back the mark an earlier attempt left, if any.
    pub async fn install(
        &self,
        device: &DeviceState,
        lockdown: &LockdownState,
        path: &str,
        confirmed: &[Confirmation],
        owner: usize,
    ) -> Result<(), UpdateError> {
        let (checked, decision, _) = self.check(device, path).await?;
        if decision.refusal.is_some() {
            return Err(UpdateError::UpdateRefused);
        }
        if decision
            .confirmations
            .iter()
            .any(|needed| !confirmed.contains(needed))
        {
            return Err(UpdateError::ConfirmationRequired);
        }
        let earlier = pending::read(&self.data_dir);
        let mark = Pending {
            from: self.installed.clone(),
            to: checked.manifest.manifest.version.clone(),
            started_at_ms: pending::now_ms(),
        };
        pending::write(&self.data_dir, &mark).map_err(|error| {
            eprintln!(
                "standalone: update_install could not write its mark: {:?}",
                error.kind()
            );
            UpdateError::Storage
        })?;
        let launcher = Arc::clone(&self.launcher);
        // The handle opened for the hash goes along, and on a start it is
        // kept in `leaving` until the process ends: nothing changes the file
        // between the hash and the start, nor while the installer runs.
        let joined = blocking(move || {
            let launched = launcher.launch(&checked.launch_path, INSTALLER_ARGUMENTS, owner);
            (launched, checked)
        })
        .await;
        let (launched, held) = match joined {
            Ok(done) => done,
            Err(error) => {
                self.restore_mark(earlier.as_ref());
                return Err(error);
            }
        };
        match launched {
            Ok(()) => {
                *self.leaving.lock().unwrap_or_else(PoisonError::into_inner) = Some(held.installer);
                self.exit_for_update(lockdown);
                Ok(())
            }
            Err(error) => {
                self.restore_mark(earlier.as_ref());
                // `{:?}` names Windows' error number for `Failed`, never a path.
                eprintln!(
                    "standalone: update_install: the installer did not start: {:?}",
                    error
                );
                Err(error.into())
            }
        }
    }

    /// After a refused start: the mark an earlier attempt left comes back
    /// (its «не завершилось» stays true), or none is left.
    fn restore_mark(&self, earlier: Option<&Pending>) {
        let restored = match earlier {
            Some(mark) => pending::write(&self.data_dir, mark),
            None => pending::remove(&self.data_dir),
        };
        if let Err(io) = restored {
            eprintln!(
                "standalone: update_install could not put its mark back: {:?}",
                io.kind()
            );
        }
    }

    /// Whether the installer Windows started is still held (tests).
    pub fn holds_started_installer(&self) -> bool {
        self.leaving
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// The one way the app leaves for an update: kiosk mode's flag off first
    /// (its close guard would refuse the window's close), then the exit.
    pub fn exit_for_update(&self, lockdown: &LockdownState) {
        lockdown::release_for_exit(lockdown);
        (self.exit)(0);
    }

    pub fn outcome(&self) -> Option<UpdateOutcome> {
        self.outcome
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// «Скрыть»: the mark goes, and the outcome with it.
    pub fn dismiss_outcome(&self) -> Result<(), UpdateError> {
        pending::remove(&self.data_dir).map_err(|error| {
            eprintln!(
                "standalone: update_outcome_dismiss storage: {:?}",
                error.kind()
            );
            UpdateError::Storage
        })?;
        *self.outcome.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }

    /// «Открыть папку»: makes `Документы\Markiro\Обновления` and shows it.
    pub fn open_folder(&self) -> Result<(), UpdateError> {
        let folder = self
            .updates_dir
            .as_ref()
            .ok_or(UpdateError::DocumentsUnavailable)?;
        package::ensure_folder(folder)?;
        office_files::show_folder(folder).map_err(|error| match error {
            OfficeFilesError::InvalidRequest => UpdateError::InvalidRequest,
            OfficeFilesError::DocumentsUnavailable => UpdateError::DocumentsUnavailable,
            OfficeFilesError::Storage | OfficeFilesError::FolderUnavailable => UpdateError::Storage,
            OfficeFilesError::Unsupported => UpdateError::Unsupported,
        })
    }
}

fn code(error: UpdateError) -> String {
    error.code().to_owned()
}

#[tauri::command]
pub async fn update_scan(
    state: tauri::State<'_, UpdateState>,
) -> Result<Vec<FoundPackage>, String> {
    state.scan().await.map_err(code)
}

#[tauri::command]
pub async fn update_verify(
    state: tauri::State<'_, UpdateState>,
    device: tauri::State<'_, DeviceState>,
    path: String,
) -> Result<VerifiedReport, String> {
    state.verify(&device, &path).await.map_err(code)
}

/// `confirm` holds the codes of the report's confirmations the person
/// accepted; an unknown code is `invalid_request` before anything is read.
#[tauri::command]
pub async fn update_install<R: tauri::Runtime>(
    webview: tauri::WebviewWindow<R>,
    state: tauri::State<'_, UpdateState>,
    device: tauri::State<'_, DeviceState>,
    lockdown: tauri::State<'_, LockdownState>,
    path: String,
    confirm: Vec<String>,
) -> Result<(), String> {
    let confirmed = confirm
        .iter()
        .map(|text| Confirmation::from_code(text))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| code(UpdateError::InvalidRequest))?;
    // The window that asked owns the administrator prompt (see `Launcher`).
    #[cfg(windows)]
    let owner = webview.hwnd().map(|native| native.0 as usize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = {
        let _ = &webview;
        0
    };
    state
        .install(&device, &lockdown, &path, &confirmed, owner)
        .await
        .map_err(code)
}

#[tauri::command]
pub fn update_outcome(state: tauri::State<'_, UpdateState>) -> Option<UpdateOutcome> {
    state.outcome()
}

#[tauri::command]
pub fn update_outcome_dismiss(state: tauri::State<'_, UpdateState>) -> Result<(), String> {
    state.dismiss_outcome().map_err(code)
}

#[tauri::command]
pub async fn update_open_folder(state: tauri::State<'_, UpdateState>) -> Result<(), String> {
    state.open_folder().map_err(code)
}

#[cfg(test)]
mod tests {
    use super::UpdateError;

    /// The codes the webview reads (`UPDATE_SHELL_CODES` in
    /// `src/office/info/update-shell.ts`, which `test/update-shell.test.ts`
    /// pins to the same fixture): a code of no known name would read there as
    /// `unsupported`.
    #[test]
    fn every_update_error_has_the_code_the_webview_knows() {
        let fixture: Vec<String> =
            serde_json::from_str(include_str!("../../tests/fixtures/update-error-codes.json"))
                .unwrap();
        let codes: Vec<&str> = [
            UpdateError::InvalidRequest,
            UpdateError::DocumentsUnavailable,
            UpdateError::Storage,
            UpdateError::Unsupported,
            UpdateError::ManifestMalformed,
            UpdateError::ManifestUnknownKey,
            UpdateError::ManifestSignature,
            UpdateError::InstallerMissing,
            UpdateError::InstallerMismatch,
            UpdateError::UpdateRefused,
            UpdateError::ConfirmationRequired,
            UpdateError::UacCancelled,
            UpdateError::LaunchFailed,
        ]
        .map(UpdateError::code)
        .to_vec();
        assert_eq!(codes, fixture);
    }
}
