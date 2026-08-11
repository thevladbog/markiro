/// Minimal IPC smoke command; proves the webview<->Rust bridge is wired.
#[tauri::command]
pub fn hello(name: &str) -> String {
    format!("Hello, {name}, from the Markiro station core")
}

use tauri::{AppHandle, Manager};

use crate::config::{self, StationConfig};

/// Reads the on-disk station config from the OS app-config dir, minting a
/// stable machine id on first run.
#[tauri::command]
pub fn read_config(app: AppHandle) -> Result<StationConfig, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    config::read_config(&dir)
}

/// Persists the station config (mode 0600 on unix). `server_url`, when set,
/// is validated as http(s) with no userinfo before the write is attempted.
#[tauri::command]
pub fn write_config(app: AppHandle, cfg: StationConfig) -> Result<(), String> {
    if let Some(url) = &cfg.server_url {
        config::validate_http_url(url)?;
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    config::write_config(&dir, &cfg)
}

/// Clears only the rejected station credential and reproducible display
/// metadata. `machine_id` and `device_id` stay durable for a same-record
/// recovery pairing; local production facts live in SQLite and are untouched.
#[tauri::command]
pub fn clear_credential(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    config::clear_credential(&dir)
}

use std::sync::Mutex;

use tauri::State;

/// Whether the main window is in kiosk lockdown. Read by the window-close
/// guard in `lib.rs` to decide whether to `prevent_close()`.
#[derive(Default)]
pub struct LockdownState(pub Mutex<bool>);

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
    window.set_fullscreen(true).map_err(|e| e.to_string())?;
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_skip_taskbar(true).map_err(|e| e.to_string())?;
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
}
