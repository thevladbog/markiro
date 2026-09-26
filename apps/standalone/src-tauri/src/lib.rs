//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks and the device key stay in Rust.

pub mod device;
pub mod device_config;
pub mod host_client;
pub mod host_probe;
pub mod secret_store;
pub mod tls;

use serde_json::Value;
use tauri::Manager;

use device::{DeviceState, DeviceStatus};
use host_client::HostResponse;

/// The host service on this computer.
fn local_host_address() -> String {
    format!("https://127.0.0.1:{}", markiro_proto::DEFAULT_PORT)
}

#[tauri::command]
async fn host_hello(address: String) -> Result<host_probe::HelloObservation, String> {
    host_probe::observe_hello(&address)
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
fn device_status(state: tauri::State<'_, DeviceState>) -> Result<Option<DeviceStatus>, String> {
    state.status().map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn host_local_pair(
    state: tauri::State<'_, DeviceState>,
    name: String,
) -> Result<DeviceStatus, String> {
    state
        .local_pair(&local_host_address(), &name, env!("CARGO_PKG_VERSION"))
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn host_request(
    state: tauri::State<'_, DeviceState>,
    method: String,
    path: String,
    body: Option<Value>,
    office_token: Option<String>,
) -> Result<HostResponse, String> {
    state
        .request(&method, &path, body.as_ref(), office_token.as_deref())
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn device_forget(state: tauri::State<'_, DeviceState>) -> Result<(), String> {
    state
        .forget()
        .await
        .map_err(|error| error.code().to_owned())
}

/// The shell's commands. `run` registers them; `tests/ipc.rs` drives the
/// same list through Tauri's mock runtime to pin the webview's IPC contract.
pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        host_hello,
        device_status,
        host_local_pair,
        host_request,
        device_forget
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .setup(|app| {
            // The local data directory, not the (roaming, on Windows)
            // config directory: the device identity must stay on this
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            app.manage(DeviceState::load(dir));
            Ok(())
        })
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
