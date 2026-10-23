use super::{open_browser, safe_error, validate_authorize, YandexNativeState};
use crate::installation::{self, InstallRole};
use markiro_backup_cloud::{
    callback::CallbackListener,
    client::{DiskClient, RemoteObject, RequestGuard},
    envelope,
    model::{ClientProfile, CompleteManifestV1, OBJECTS},
    oauth::{DirectTransport, OAuthAttempt, OAuthClient},
    Error, Result,
};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use tokio::sync::watch;

pub struct Session {
    client: DiskClient,
    profile: ClientProfile,
    copies: Vec<CompleteManifestV1>,
    root: PathBuf,
    selected: Option<CompleteManifestV1>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
struct Cancel(watch::Receiver<bool>);
impl RequestGuard for Cancel {
    fn check(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async {
            if *self.0.borrow() {
                Err(Error::InvalidAttempt)
            } else {
                Ok(())
            }
        })
    }
    fn cancelled(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async {
            let mut rx = self.0.clone();
            let _ = rx.wait_for(|v| *v).await;
        })
    }
}
fn host_only() -> Result<()> {
    if installation::read_beside_executable() != Some(InstallRole::Host) {
        return Err(Error::Provider("host_role_required"));
    }
    Ok(())
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyInfo {
    snapshot_id: String,
    host_id: String,
    created_at: String,
    organization_label: String,
    inn: String,
    app_version: String,
    size_bytes: u64,
}
impl From<&CompleteManifestV1> for CopyInfo {
    fn from(c: &CompleteManifestV1) -> Self {
        Self {
            snapshot_id: c.snapshot_id.0.to_string(),
            host_id: c.host_id.to_string(),
            created_at: c.created_at.clone(),
            organization_label: c.organization_label.clone(),
            inn: c.inn.clone(),
            app_version: c.app_version.clone(),
            size_bytes: c.objects.values().map(|v| v.size_bytes).sum(),
        }
    }
}

#[tauri::command]
pub async fn yandex_recovery_auth<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, YandexNativeState>,
    client_id: String,
) -> std::result::Result<String, String> {
    host_only().map_err(safe_error)?;
    let mut cancelled = state.begin().await.map_err(safe_error)?;
    let result=async {
        let profile=ClientProfile::new(&client_id)?;
        // The installed host must still be awaiting bootstrap.
        let hello=crate::host_probe::observe_hello(&crate::local_host_address()).await.map_err(|_|Error::Network)?;
        if hello.hello.initialized{return Err(Error::Provider("target_initialized"));}
        let mut attempt=OAuthAttempt::new(&client_id,now())?;let url=attempt.authorization_url()?.to_string();let expected=validate_authorize(&url,&client_id)?;
        let listener=CallbackListener::bind().await?;open_browser(&url)?;
        let code=tokio::select! {v=listener.receive(&expected)=>v?,_=cancelled.wait_for(|v|*v)=>return Err(Error::InvalidAttempt)};
        let oauth=OAuthClient::new(DirectTransport::new()?);
        let tokens=tokio::select!{value=oauth.complete(&mut attempt,code.state.expose(),code.code.expose(),now())=>value?,_=cancelled.wait_for(|v|*v)=>return Err(Error::InvalidAttempt)};
        let client=DiskClient::new(tokens.access)?;
        let checked=client.clone().with_guard(Arc::new(Cancel(cancelled.clone())));
        checked.check_folder().await?;let account=checked.account().await?;
        let base=app.path().app_local_data_dir().map_err(|_|Error::SecretUnavailable)?;
        let root=base.join(format!("yandex-recovery-{}",uuid::Uuid::new_v4()));envelope::private_dir(&root)?;
        *state.recovery.lock().await=Some(Session{client,profile,copies:vec![],root,selected:None});Ok(account.id)
    }.await;
    state.end().await;
    result.map_err(safe_error)
}
#[tauri::command]
pub async fn yandex_recovery_list(
    state: tauri::State<'_, YandexNativeState>,
) -> std::result::Result<Vec<CopyInfo>, String> {
    host_only().map_err(safe_error)?;
    let cancelled = state.begin().await.map_err(safe_error)?;
    let result = async {
        let mut sessions = state.recovery.lock().await;
        let s = sessions.as_mut().ok_or(Error::InvalidAttempt)?;
        let client = s
            .client
            .clone()
            .with_guard(Arc::new(Cancel(cancelled.clone())));
        let mut copies = markiro_backup_cloud::catalog::list(
            &client,
            &s.profile.client_id,
            None,
            &s.root.join(format!("catalog-{}", uuid::Uuid::new_v4())),
        )
        .await?;
        copies.sort_by(|a, b| {
            a.host_id
                .cmp(&b.host_id)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });
        let result = copies.iter().map(CopyInfo::from).collect();
        s.copies = copies;
        Ok(result)
    }
    .await;
    state.end().await;
    result.map_err(safe_error)
}
#[tauri::command]
pub async fn yandex_recovery_download(
    state: tauri::State<'_, YandexNativeState>,
    host_id: String,
    snapshot_id: String,
) -> std::result::Result<(), String> {
    host_only().map_err(safe_error)?;
    let cancelled = state.begin().await.map_err(safe_error)?;
    let result=async {
        let mut sessions=state.recovery.lock().await;let s=sessions.as_mut().ok_or(Error::InvalidAttempt)?;
        let chosen=s.copies.iter().find(|c|c.host_id.to_string()==host_id&&c.snapshot_id.0.to_string()==snapshot_id).ok_or(Error::InvalidAttempt)?.clone();
        s.selected=None;
        check_download_budget(&s.root,chosen.objects.values().map(|v|v.size_bytes).sum())?;
        let folder=s.root.join("downloaded");if folder.exists(){std::fs::remove_dir_all(&folder)?;}envelope::private_dir(&folder)?;
        let client=s.client.clone().with_guard(Arc::new(Cancel(cancelled.clone())));
        // Commit is fetched afresh, then exact object hashes/identity are verified.
        for name in std::iter::once("complete.json").chain(OBJECTS){client.get_stream(&RemoteObject::new(chosen.host_id,chosen.snapshot_id.0,name)?,&folder.join(name)).await?;}
        let actual=envelope::read_complete(&folder,&s.profile.client_id)?;if actual!=chosen{return Err(Error::Integrity);}
        let stage=folder.clone();let client_id=s.profile.client_id.clone();let output=s.root.join(format!("native-{}",uuid::Uuid::new_v4()));let output_copy=output.clone();
        let task=tokio::task::spawn_blocking(move||{let result=envelope::open_copy(&stage,&client_id,&output_copy).and_then(|native|verify_downloaded_native(&native.database));let _=std::fs::remove_dir_all(output_copy);result});
        let mut stop=cancelled.clone();tokio::select!{result=task=>result.map_err(|_|Error::Integrity)??,_=stop.wait_for(|v|*v)=>return Err(Error::InvalidAttempt)};
        // Native SQLite/TLS validation is repeated by the elevated Host helper.
        let _=std::fs::remove_dir_all(output);
        let profile_path=s.root.join("profile.json");if !profile_path.exists(){let mut profile=envelope::private_file(&profile_path)?;use std::io::Write;profile.write_all(&serde_json::to_vec(&s.profile).map_err(|_|Error::InvalidFormat)?)?;profile.sync_all()?;}
        if *cancelled.borrow(){return Err(Error::InvalidAttempt);}s.selected=Some(chosen);Ok(())
    }.await;
    state.end().await;
    result.map_err(safe_error)
}
#[cfg(windows)]
fn verify_downloaded_native(database: &std::path::Path) -> Result<()> {
    let helper = std::env::current_exe()?.with_file_name("markiro-host.exe");
    let status = std::process::Command::new(helper)
        .arg("verify-yandex-copy")
        .arg(database)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    match status.code() {
        Some(0) => Ok(()),
        Some(6) => Err(Error::Provider("incompatible_version")),
        _ => Err(Error::Integrity),
    }
}
#[cfg(not(windows))]
fn verify_downloaded_native(_database: &std::path::Path) -> Result<()> {
    Err(Error::SecretUnavailable)
}
#[cfg(windows)]
fn check_download_budget(path: &std::path::Path, size: u64) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(Error::Provider("local_space"));
    }
    if size
        .checked_mul(2)
        .and_then(|v| v.checked_add(512 * 1024 * 1024))
        .is_none_or(|v| v > available)
    {
        return Err(Error::Provider("local_space"));
    }
    Ok(())
}
#[cfg(not(windows))]
fn check_download_budget(_path: &std::path::Path, _size: u64) -> Result<()> {
    Err(Error::SecretUnavailable)
}
#[tauri::command]
pub async fn yandex_recovery_restore(
    device: tauri::State<'_, crate::device::DeviceState>,
    local: tauri::State<'_, crate::local_db::LocalDbState>,
    state: tauri::State<'_, YandexNativeState>,
    old_host_stopped: bool,
) -> std::result::Result<(), String> {
    host_only().map_err(safe_error)?;
    if !old_host_stopped {
        return Err("old_host_confirmation_required".into());
    }
    let _cancelled = state.begin().await.map_err(safe_error)?;
    let result = async {
        let sessions = state.recovery.lock().await;
        let s = sessions.as_ref().ok_or(Error::InvalidAttempt)?;
        if s.selected.is_none() {
            return Err(Error::InvalidAttempt);
        }
        let selected = s.selected.as_ref().ok_or(Error::InvalidAttempt)?;
        local
            .get()
            .map_err(|_| Error::SecretUnavailable)?
            .require_settled_outbox()
            .await
            .map_err(|_| Error::Provider("unsent_facts"))?;
        if local
            .get()
            .map_err(|_| Error::SecretUnavailable)?
            .has_recovery_copies()
            .await
            .map_err(|_| Error::SecretUnavailable)?
        {
            return Err(Error::Provider("local_copies_present"));
        }
        let stage = s.root.clone();
        tokio::task::spawn_blocking(move || launch_helper(Some(&stage)))
            .await
            .map_err(|_| Error::SecretUnavailable)??;
        let observation = wait_hello().await?;
        if observation.fingerprint != selected.tls_fingerprint
            || observation.hello.host_id != selected.host_id.to_string()
            || !observation.hello.initialized
        {
            return Err(Error::Integrity);
        }
        device.forget().await.map_err(|_| Error::InvalidAttempt)?;
        device
            .local_pair(
                &crate::local_host_address(),
                "Autonom recovery",
                env!("CARGO_PKG_VERSION"),
            )
            .await
            .map_err(|_| Error::Network)?;
        Ok(())
    }
    .await;
    state.end().await;
    result.map_err(safe_error)
}
async fn wait_hello() -> Result<crate::host_probe::HelloObservation> {
    wait_ready(|| async {
        let hello = crate::host_probe::observe_hello(&crate::local_host_address())
            .await
            .map_err(|_| Error::Network)?;
        if !hello.hello.initialized {
            return Err(Error::Network);
        }
        Ok(hello)
    })
    .await
}
async fn wait_ready<T, F, Fut>(mut probe: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    for _ in 0..60 {
        if let Ok(value) = probe().await {
            return Ok(value);
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err(Error::Network)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_is_available_only_for_a_bounded_unfinished_job() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("job.json");
        assert!(!unfinished_job(&path));
        for bytes in [b"{}".as_slice(), br#"{"complete":true}"#, b"bad json"] {
            std::fs::write(&path, bytes).unwrap();
            assert!(!unfinished_job(&path));
        }
        std::fs::write(&path, br#"{"complete":false}"#).unwrap();
        assert!(unfinished_job(&path));
        std::fs::write(&path, vec![b' '; 65537]).unwrap();
        assert!(!unfinished_job(&path));
    }
    #[tokio::test]
    async fn waits_for_a_slow_service_instead_of_failing_after_start() {
        let count = std::sync::atomic::AtomicUsize::new(0);
        let result = wait_ready(|| async {
            if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                Err(Error::Network)
            } else {
                Ok(7)
            }
        })
        .await
        .unwrap();
        assert_eq!(result, 7);
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 3);
    }
}
#[cfg(any(windows, test))]
fn unfinished_job(path: &std::path::Path) -> bool {
    markiro_backup_cloud::envelope::read_bounded(path, 65536)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|job| job.get("complete").and_then(serde_json::Value::as_bool))
        == Some(false)
}
#[tauri::command]
pub fn yandex_recovery_available() -> bool {
    if host_only().is_err() {
        return false;
    }
    #[cfg(windows)]
    {
        return std::env::var_os("ProgramData").is_some_and(|root| {
            unfinished_job(
                &std::path::PathBuf::from(root).join("Markiro/Host/yandex-recovery-job.json"),
            )
        });
    }
    #[cfg(not(windows))]
    false
}
#[tauri::command]
pub async fn yandex_recovery_resume(
    device: tauri::State<'_, crate::device::DeviceState>,
    local: tauri::State<'_, crate::local_db::LocalDbState>,
    state: tauri::State<'_, YandexNativeState>,
) -> std::result::Result<(), String> {
    host_only().map_err(safe_error)?;
    if !yandex_recovery_available() {
        return Err("restore_failed".into());
    }
    let _cancel = state.begin().await.map_err(safe_error)?;
    let result = async {
        local
            .get()
            .map_err(|_| Error::SecretUnavailable)?
            .require_settled_outbox()
            .await
            .map_err(|_| Error::Provider("unsent_facts"))?;
        if local
            .get()
            .map_err(|_| Error::SecretUnavailable)?
            .has_recovery_copies()
            .await
            .map_err(|_| Error::SecretUnavailable)?
        {
            return Err(Error::Provider("local_copies_present"));
        }
        tokio::task::spawn_blocking(|| launch_helper(None))
            .await
            .map_err(|_| Error::SecretUnavailable)??;
        wait_hello().await?;
        device.forget().await.map_err(|_| Error::InvalidAttempt)?;
        device
            .local_pair(
                &crate::local_host_address(),
                "Autonom recovery",
                env!("CARGO_PKG_VERSION"),
            )
            .await
            .map_err(|_| Error::Network)?;
        Ok(())
    }
    .await;
    state.end().await;
    result.map_err(safe_error)
}
#[cfg(windows)]
fn launch_helper(stage: Option<&std::path::Path>) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        UI::Shell::*,
    };
    let executable = std::env::current_exe()?
        .parent()
        .ok_or(Error::InvalidFormat)?
        .join("markiro-host.exe");
    let wide = |s: &std::ffi::OsStr| {
        s.to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let arguments = if let Some(stage) = stage {
        let text = stage.to_str().ok_or(Error::InvalidFormat)?;
        if text.contains(['"', '\r', '\n']) || text.ends_with('\\') {
            return Err(Error::InvalidFormat);
        }
        format!("recover-yandex \"{text}\"")
    } else {
        "recover-yandex-resume".into()
    };
    let file = wide(executable.as_os_str());
    let args = wide(std::ffi::OsStr::new(&arguments));
    let verb = wide(std::ffi::OsStr::new("runas"));
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = args.as_ptr();
    info.nShow = 0;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(if unsafe { GetLastError() } == ERROR_CANCELLED {
            Error::Provider("cancelled")
        } else {
            Error::Network
        });
    }
    let wait = unsafe { WaitForSingleObject(info.hProcess, u32::MAX) };
    let mut exit = 1;
    let ok = unsafe { GetExitCodeProcess(info.hProcess, &mut exit) };
    unsafe { CloseHandle(info.hProcess) };
    if wait != 0 || ok == 0 || exit != 0 {
        return Err(Error::Provider("restore_failed"));
    }
    Ok(())
}
#[cfg(not(windows))]
fn launch_helper(_stage: Option<&std::path::Path>) -> Result<()> {
    Err(Error::SecretUnavailable)
}

#[tauri::command]
pub async fn yandex_profile_import() -> std::result::Result<ClientProfile, String> {
    tokio::task::spawn_blocking(import_profile)
        .await
        .map_err(|_| "secret_unavailable".to_owned())?
        .map_err(safe_error)
}
#[cfg(windows)]
fn import_profile() -> Result<ClientProfile> {
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    let mut file = [0u16; 32768];
    let filter: Vec<u16> = "JSON\0*.json\0\0".encode_utf16().collect();
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.lpstrFile = file.as_mut_ptr();
    dialog.nMaxFile = 32768;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if unsafe { GetOpenFileNameW(&mut dialog) } == 0 {
        return Err(Error::Provider("cancelled"));
    }
    let end = file
        .iter()
        .position(|c| *c == 0)
        .ok_or(Error::InvalidFormat)?;
    let path = String::from_utf16(&file[..end]).map_err(|_| Error::InvalidFormat)?;
    ClientProfile::from_bytes(&envelope::read_bounded(std::path::Path::new(&path), 65536)?)
}
#[cfg(not(windows))]
fn import_profile() -> Result<ClientProfile> {
    Err(Error::SecretUnavailable)
}
#[tauri::command]
pub fn yandex_profile_export<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    client_id: String,
) -> std::result::Result<String, String> {
    (move || {
        let profile = ClientProfile::new(&client_id)?;
        let parent = app
            .path()
            .document_dir()
            .map_err(|_| Error::SecretUnavailable)?;
        let folder = parent.join(format!("Autonom-Yandex-{}", uuid::Uuid::new_v4()));
        envelope::private_dir(&folder)?;
        let path = folder.join("yandex-connection.json");
        use std::io::Write;
        envelope::private_file(&path)?
            .write_all(&serde_json::to_vec_pretty(&profile).map_err(|_| Error::InvalidFormat)?)?;
        Ok(path.to_string_lossy().to_string())
    })()
    .map_err(safe_error)
}
