/// Minimal IPC smoke command; proves the webview<->Rust bridge is wired.
#[tauri::command]
pub fn hello(name: &str) -> String {
    format!("Hello, {name}, from the Markiro station core")
}

use tauri::{AppHandle, Manager};

use crate::config::{self, StationConfig};
use crate::storage::{self, StationStorage, StorageGate};

/// Reads `station.json` from the resolved storage folder, minting a stable
/// machine id on first run. Waits until storage is resolved; a blocked
/// resolution is an error and never mints a new identity.
#[tauri::command]
pub async fn read_config(gate: State<'_, StorageGate>) -> Result<StationConfig, String> {
    read_config_in(gate.inner()).await
}

/// Persists the station config (mode 0600 on unix). `server_url`, when set,
/// is validated as http(s) with no userinfo before the write is attempted.
#[tauri::command]
pub async fn write_config(gate: State<'_, StorageGate>, cfg: StationConfig) -> Result<(), String> {
    write_config_in(gate.inner(), &cfg).await
}

/// Clears only the rejected station credential and reproducible display
/// metadata. `machine_id` and `device_id` stay durable for a same-record
/// recovery pairing; local production facts live in SQLite and are untouched.
#[tauri::command]
pub async fn clear_credential(gate: State<'_, StorageGate>) -> Result<(), String> {
    clear_credential_in(gate.inner()).await
}

/// The `sqlite:` URL `src/lib/sqlite.ts` opens. Never the plugin's relative
/// form, which resolves against the roaming app-config folder.
#[tauri::command]
pub async fn station_database_url(gate: State<'_, StorageGate>) -> Result<String, String> {
    database_url_in(gate.inner()).await
}

/// Storage folder, mode and notices for the Update screen.
#[tauri::command]
pub async fn station_storage_status(
    gate: State<'_, StorageGate>,
) -> Result<StationStorage, String> {
    gate.ready().await
}

/// Async commands no longer run one at a time on the main thread. This keeps
/// the synchronous `station.json` calls serialized, so `clear_credential`'s
/// read-modify-write never interleaves with `write_config`. It guards no data
/// and is never held across an `.await`.
static CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());

fn lock_config_file() -> MutexGuard<'static, ()> {
    CONFIG_FILE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Where `read_config` may mint a first identity. A claimed folder always
/// holds the station files, so a missing `station.json` there means another
/// logon session finished the move: minting would split the identity.
fn mintable_config_dir(storage: StationStorage) -> Result<PathBuf, String> {
    if storage.runs_from_claim() && !storage.dir.join(storage::CONFIG_FILE).exists() {
        return Err(format!(
            "station.json is missing from the claimed folder {}; another session may have finished moving the station files, so restart the station",
            storage.dir.display()
        ));
    }
    Ok(storage.dir)
}

async fn read_config_in(gate: &StorageGate) -> Result<StationConfig, String> {
    let storage = gate.ready().await?;
    let _config_file = lock_config_file();
    config::read_config(&mintable_config_dir(storage)?)
}

async fn write_config_in(gate: &StorageGate, cfg: &StationConfig) -> Result<(), String> {
    if let Some(url) = &cfg.server_url {
        config::validate_http_url(url)?;
    }
    let dir = gate.ready().await?.dir;
    let _config_file = lock_config_file();
    config::write_config(&dir, cfg)
}

async fn clear_credential_in(gate: &StorageGate) -> Result<(), String> {
    let storage = gate.ready().await?;
    let _config_file = lock_config_file();
    config::clear_credential(&mintable_config_dir(storage)?)
}

async fn database_url_in(gate: &StorageGate) -> Result<String, String> {
    Ok(storage::database_url(&gate.ready().await?.database_path()))
}

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::State;

#[cfg(windows)]
fn cover_current_monitor(window: &tauri::WebviewWindow) -> Result<(), String> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW},
    };

    let native = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = native.0 as windows_sys::Win32::Foundation::HWND;
    let monitor_handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor_handle.is_null() {
        return Err("No monitor for main window".to_string());
    }

    let mut monitor = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor_handle, &mut monitor) } == 0 {
        return Err("Could not read main-window monitor bounds".to_string());
    }

    let bounds = monitor.rcMonitor;
    if unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
    } == 0
    {
        return Err("Could not cover the main-window monitor".to_string());
    }
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn cover_current_monitor(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Whether the main window is in kiosk lockdown. Read by the window-close
/// guard in `lib.rs` to decide whether to `prevent_close()`.
#[derive(Default)]
pub struct LockdownState(pub Mutex<bool>);

fn rollback_failed_lockdown(
    window: &tauri::WebviewWindow,
    state: &Mutex<bool>,
    original_failure: String,
) -> String {
    let mut rollback_errors = Vec::new();
    if let Err(error) = window.set_fullscreen(false) {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = window.set_always_on_top(false) {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = window.set_skip_taskbar(false) {
        rollback_errors.push(error.to_string());
    }
    if let Err(error) = window.set_decorations(true) {
        rollback_errors.push(error.to_string());
    }
    match state.lock() {
        Ok(mut is_locked) => *is_locked = false,
        Err(error) => rollback_errors.push(error.to_string()),
    }

    if rollback_errors.is_empty() {
        original_failure
    } else {
        format!(
            "{original_failure}; lockdown rollback also failed: {}",
            rollback_errors.join("; ")
        )
    }
}

/// Engages kiosk lockdown on the main window: fullscreen, no decorations,
/// always-on-top, hidden from the taskbar/dock. Idempotent. Mirrors idento's
/// `enter_lockdown`. Window close is additionally blocked at the OS-event
/// level (see `lib.rs`), not just via `set_closable` (which has a documented
/// Linux caveat).
#[tauri::command]
pub fn enter_lockdown(app: AppHandle, state: State<'_, LockdownState>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No main window".to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    if let Err(original_failure) = cover_current_monitor(&window) {
        return Err(rollback_failed_lockdown(
            &window,
            &state.0,
            original_failure,
        ));
    }
    *state.0.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Reverses `enter_lockdown`. Attempts all restorations regardless of any
/// individual failure (a `?`-chain would leave the window half-locked) and
/// clears the flag unconditionally so an operator can never be trapped;
/// per-property errors are still surfaced for diagnostics.
#[tauri::command]
pub fn exit_lockdown(app: AppHandle, state: State<'_, LockdownState>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "No main window".to_string())?;
    let mut errors = Vec::new();
    if let Err(e) = window.set_skip_taskbar(false) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_always_on_top(false) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_decorations(true) {
        errors.push(e.to_string());
    }
    if let Err(e) = window.set_fullscreen(false) {
        errors.push(e.to_string());
    }
    *state.0.lock().map_err(|e| e.to_string())? = false;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_greets_by_name() {
        assert_eq!(
            hello("Line 1"),
            "Hello, Line 1, from the Markiro station core"
        );
    }

    #[test]
    fn lockdown_state_starts_unlocked() {
        let state = LockdownState::default();
        assert!(!*state.0.lock().expect("lockdown mutex should be available"));
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("markiro-station-commands-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn config_commands_use_the_resolved_folder() {
        runtime().block_on(async {
            let dir = temp_dir();
            let (sender, gate) = storage::storage_gate();
            sender.resolve(Ok(StationStorage {
                dir: dir.clone(),
                mode: crate::storage::StorageMode::Local,
                notices: Vec::new(),
            }));
            let mut cfg = read_config_in(&gate).await.unwrap();
            assert!(dir.join("station.json").exists());
            cfg.api_key = Some("credential-placeholder".into());
            cfg.server_url = Some("https://api.example".into());
            write_config_in(&gate, &cfg).await.unwrap();
            clear_credential_in(&gate).await.unwrap();
            assert_eq!(read_config_in(&gate).await.unwrap().api_key, None);
            assert_eq!(
                database_url_in(&gate).await.unwrap(),
                storage::database_url(&dir.join("station-mirror.db"))
            );
        });
    }

    fn legacy_gate(dir: &std::path::Path) -> StorageGate {
        let (sender, gate) = storage::storage_gate();
        sender.resolve(Ok(StationStorage {
            dir: dir.to_path_buf(),
            mode: crate::storage::StorageMode::Legacy,
            notices: vec![crate::storage::StorageNotice::LegacyInUse],
        }));
        gate
    }

    /// Another logon session can finish the move while this one runs from the
    /// claimed folder: its `station.json` is then gone, never to be minted.
    #[test]
    fn a_claimed_folder_without_its_config_never_mints() {
        runtime().block_on(async {
            let claim = temp_dir().join("app.markiro.station.migrating-1");
            std::fs::create_dir_all(&claim).unwrap();
            let gate = legacy_gate(&claim);
            let error = read_config_in(&gate).await.unwrap_err();
            assert!(error.contains(&claim.display().to_string()), "{error}");
            assert!(clear_credential_in(&gate).await.is_err());
            assert!(!claim.join("station.json").exists());

            // While the claimed folder holds its config, it serves as before.
            let mut cfg = config::read_config(&temp_dir()).unwrap();
            cfg.api_key = Some("credential-placeholder".into());
            config::write_config(&claim, &cfg).unwrap();
            assert_eq!(read_config_in(&gate).await.unwrap(), cfg);
            clear_credential_in(&gate).await.unwrap();
            assert_eq!(read_config_in(&gate).await.unwrap().api_key, None);

            // A fresh station kept in the roaming folder still gets an identity.
            let roaming = temp_dir().join("app.markiro.station");
            assert!(read_config_in(&legacy_gate(&roaming)).await.is_ok());
            assert!(roaming.join("station.json").exists());
        });
    }

    #[test]
    fn a_blocked_gate_refuses_every_command_and_mints_nothing() {
        runtime().block_on(async {
            let (sender, gate) = storage::storage_gate();
            sender.resolve(Err("blocked".into()));
            assert_eq!(read_config_in(&gate).await, Err("blocked".to_string()));
            assert!(clear_credential_in(&gate).await.is_err());
            assert!(database_url_in(&gate).await.is_err());
            let cfg = StationConfig {
                machine_id: "machine-1".into(),
                tenant_id: None,
                device_id: None,
                device_name: None,
                organization_name: None,
                line_id: None,
                line_name: None,
                api_key: None,
                server_url: Some("ftp://nope".into()),
            };
            // URL validation still runs first, as before.
            assert!(write_config_in(&gate, &cfg)
                .await
                .unwrap_err()
                .contains("scheme"));
        });
    }
}
