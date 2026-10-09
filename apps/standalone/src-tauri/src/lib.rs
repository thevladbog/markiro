//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks and the device key stay in Rust.

pub mod connection;
pub mod device;
pub mod device_config;
pub mod host_client;
pub mod host_probe;
pub mod local_db;
pub mod lockdown;
pub mod secret_store;
pub mod tls;

use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{Emitter, Manager, Runtime};

use connection::{Backoff, ConnectionState, HostRevision, HostStatus, LinkEvents};
use device::{DeviceError, DeviceState, DeviceStatus};
use host_client::HostResponse;
use local_db::{LocalDbState, LocalStatement};

/// The host service on this computer.
fn local_host_address() -> String {
    format!("https://127.0.0.1:{}", markiro_proto::DEFAULT_PORT)
}

/// The connection task's reports as Tauri events (`src/host/connection.ts`).
struct TauriLinkEvents<R: Runtime>(tauri::AppHandle<R>);

impl<R: Runtime> LinkEvents for TauriLinkEvents<R> {
    fn status(&self, status: &HostStatus) {
        // A closed window hears nothing; the next status replaces this one.
        let _ = self.0.emit(connection::STATUS_EVENT, status);
    }

    fn revision(&self, revision: HostRevision) {
        let _ = self.0.emit(connection::REVISION_EVENT, revision);
    }
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
async fn host_claim(
    state: tauri::State<'_, DeviceState>,
    address: String,
    fingerprint: String,
    code: String,
    name: String,
) -> Result<DeviceStatus, String> {
    state
        .claim(
            &address,
            &fingerprint,
            &code,
            &name,
            env!("CARGO_PKG_VERSION"),
        )
        .await
        .map_err(|error| error.code().to_owned())
}

/// `timeoutMs` (100–10 000) limits this one request instead of the client's
/// 10 s; running past it answers `timeout` (stage 2a spec §5.2).
#[tauri::command]
async fn host_request(
    state: tauri::State<'_, DeviceState>,
    method: String,
    path: String,
    body: Option<Value>,
    office_token: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HostResponse, String> {
    state
        .request_within(
            &method,
            &path,
            body.as_ref(),
            office_token.as_deref(),
            timeout_ms,
        )
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn device_select_line(
    state: tauri::State<'_, DeviceState>,
    line_id: String,
) -> Result<DeviceStatus, String> {
    state
        .select_line(&line_id)
        .await
        .map_err(|error| error.code().to_owned())
}

/// Read this device's record from the host again and keep the line the
/// office assigned; the webview calls it at the same moments as the
/// reference sync (once the link's `watch` has subscribed or failed, and
/// after every revision event), and again after a failed read.
#[tauri::command]
async fn device_refresh(state: tauri::State<'_, DeviceState>) -> Result<DeviceStatus, String> {
    state
        .refresh()
        .await
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first. An open local database is
/// cleared (`LocalDb::clear_copies`); one that did not open is removed with
/// its `-wal`, `-shm` and `-journal` files (`LocalDbState::remove_unopened`),
/// since it may still hold PIN and badge hashes. When either fails, the
/// command answers `storage` and `device.json` stays for another try.
#[tauri::command]
async fn device_forget(
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
) -> Result<(), String> {
    let cleared = match local.get() {
        Ok(db) => db.clear_copies().await.is_ok(),
        Err(_) => local.remove_unopened().is_ok(),
    };
    if !cleared {
        return Err(DeviceError::Storage.code().to_owned());
    }
    state
        .forget()
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn local_query(
    state: tauri::State<'_, LocalDbState>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>, String> {
    let db = state.get().map_err(|error| error.code().to_owned())?;
    db.query(&sql, params)
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
async fn local_transaction(
    state: tauri::State<'_, LocalDbState>,
    statements: Vec<LocalStatement>,
) -> Result<Vec<u64>, String> {
    let db = state.get().map_err(|error| error.code().to_owned())?;
    db.transaction(statements)
        .await
        .map_err(|error| error.code().to_owned())
}

#[tauri::command]
fn connection_status(state: tauri::State<'_, ConnectionState>) -> HostStatus {
    state.snapshot()
}

/// The shell's commands. `run` registers them; `tests/ipc.rs` drives the
/// same list through Tauri's mock runtime to pin the webview's IPC contract.
pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        host_hello,
        device_status,
        host_local_pair,
        host_claim,
        host_request,
        device_select_line,
        device_refresh,
        device_forget,
        local_query,
        local_transaction,
        connection_status,
        lockdown::enter_lockdown,
        lockdown::exit_lockdown
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
            let device = DeviceState::load(dir.clone());
            let link = device.watch_link();
            app.manage(device);
            // The local database opens before the window shows. When it
            // cannot open, the app still starts and the local commands say so.
            app.manage(tauri::async_runtime::block_on(LocalDbState::open(&dir)));
            let status = ConnectionState::default();
            app.manage(status.clone());
            tauri::async_runtime::spawn(connection::supervise(
                link,
                Arc::new(TauriLinkEvents(app.handle().clone())),
                status,
                Backoff::default(),
            ));
            Ok(())
        })
        .manage(lockdown::LockdownState::default())
        .on_window_event(lockdown::refuse_close_while_locked)
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
