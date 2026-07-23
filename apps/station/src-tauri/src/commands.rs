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
}
