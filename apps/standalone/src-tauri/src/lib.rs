//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks and the device key stay in Rust.

pub mod connection;
pub mod device;
pub mod device_config;
pub mod external_link;
pub mod host_client;
pub mod host_probe;
pub mod installation;
pub mod local_db;
pub mod lockdown;
pub mod office_files;
pub mod power;
pub mod printer;
pub mod scanner;
pub mod secret_store;
pub mod tls;
pub mod window_policy;

use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value};
use tauri::{Emitter, Manager, Runtime};
use tokio::sync::watch;

use connection::{Backoff, ConnectionState, HostRevision, HostStatus, LinkEvents};
use device::{DeviceError, DeviceState, DeviceStatus, HostLink};
use host_client::HostResponse;
use installation::InstallRole;
use local_db::{LocalDbError, LocalDbState, LocalStatement, OpenFailure, UnsentGuard};

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
/// 10 s. When that limit ends the request first — connecting and the TLS
/// handshake count — the answer is `timeout`; a limit above the client's own
/// 2 s to connect leaves a host that never connects to that 2 s, which reads
/// as `unreachable`, and so does a refused connection (stage 2a spec §5.2).
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

/// The installer's role for this computer: `"host"`, `"station"`,
/// `"office"`, or `null` in a development build (plan УСТ).
#[tauri::command]
fn install_role(state: tauri::State<'_, DeviceState>) -> Option<InstallRole> {
    state.install_role()
}

/// Reach the paired host at a new address with the same certificate
/// (`DeviceState::change_address`).
#[tauri::command]
async fn device_change_address(
    state: tauri::State<'_, DeviceState>,
    address: String,
) -> Result<DeviceStatus, String> {
    state
        .change_address(&address)
        .await
        .map_err(|error| error.code().to_owned())
}

/// Read this device's record from the host again and keep the line the
/// office assigned and the name it gave the device; the webview calls it at
/// the same moments as the reference sync (once the link's `watch` has
/// subscribed or failed, and after every revision event), and again after a
/// failed read.
#[tauri::command]
async fn device_refresh(state: tauri::State<'_, DeviceState>) -> Result<DeviceStatus, String> {
    state
        .refresh()
        .await
        .map_err(|error| error.code().to_owned())
}

/// Forget the pairing: the local copies go first. An open local database is
/// cleared (`LocalDb::clear_copies`) unless this pairing still has outbox
/// records without a receipt: then the command answers `unsent_facts`, clears
/// nothing and keeps `device.json`, until the records are sent or the person
/// confirms with `keepUnsent: true` (the records stay on disk). With
/// `device.json` unreadable, any pairing's unsent records count.
///
/// A database that did not open is a different case, and only a corrupt one
/// (`OpenFailure::Corrupt`: not a database, `SQLITE_CORRUPT`) may be touched.
/// Any other failure — a migration this app version does not know, a changed
/// checksum, a busy or unreadable file, a full disk — leaves a file that may
/// be sound and hold unsent records: the command answers `storage` and keeps
/// everything in place, `keepUnsent` or not. A corrupt file is first read on
/// a read-only connection without migrations: if it still lists an `outbox`
/// with unsent records, the same guard applies (`unsent_facts` unless
/// `keepUnsent: true`, and an `outbox` that cannot be counted answers
/// `unsent_facts` too). Then it is moved aside with its `-wal`, `-shm` and
/// `-journal` files and a new database opens (`LocalDbState::
/// set_aside_unopened`): nothing is deleted. When clearing or moving fails, the
/// command answers `storage` and `device.json` stays for another try (stage
/// 2a spec §5.2, question В7).
///
/// One window stays by design: a fact written between the clear's commit and
/// the removal of `device.json` belongs to the pairing that is still current,
/// but the count did not see it, and it loses its link with no confirmation.
/// Nothing guards it here; the forget screen (plan 2a5) is offered only with
/// no open shift and with the fact writer stopped, so no fact is written
/// while the forget runs.
#[tauri::command]
async fn device_forget(
    state: tauri::State<'_, DeviceState>,
    local: tauri::State<'_, LocalDbState>,
    keep_unsent: Option<bool>,
) -> Result<(), String> {
    let status = state.status();
    let guard = match (keep_unsent, &status) {
        (Some(true), _) | (_, Ok(None)) => UnsentGuard::Ignore,
        (_, Ok(Some(paired))) => UnsentGuard::Pairing(&paired.host_id, &paired.device_id),
        (_, Err(_)) => UnsentGuard::AnyPairing,
    };
    let storage = || DeviceError::Storage.code().to_owned();
    let refused = |count: Option<u64>| {
        match count {
            Some(count) => {
                eprintln!("standalone: device_forget refused: {count} unsent outbox records")
            }
            None => eprintln!("standalone: device_forget refused: the outbox cannot be counted"),
        }
        LocalDbError::UnsentRecords { count: 0 }.code().to_owned()
    };
    match local.get() {
        Ok(db) => match db.clear_copies(guard).await {
            Ok(()) => {}
            Err(LocalDbError::UnsentRecords { count }) => return Err(refused(Some(count))),
            Err(_) => return Err(storage()),
        },
        Err(_) => {
            if local.open_failure() == Some(OpenFailure::Other) {
                eprintln!("standalone: device_forget kept a local database that is not corrupt");
                return Err(storage());
            }
            match local.unopened_unsent_records(guard).await {
                Ok(0) => {}
                Ok(count) => return Err(refused(Some(count))),
                Err(_) => return Err(refused(None)),
            }
            if let Err(error) = local.set_aside_unopened().await {
                eprintln!(
                    "standalone: device_forget could not set the local database aside: {:?}",
                    error.kind()
                );
                return Err(storage());
            }
        }
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
        device_change_address,
        install_role,
        local_query,
        local_transaction,
        connection_status,
        lockdown::enter_lockdown,
        lockdown::exit_lockdown,
        window_policy::kiosk_permitted_now,
        power::set_system_awake,
        printer::print_bytes,
        printer::list_usb_printers,
        printer::driver_commands::supports_windows_printing,
        printer::driver_commands::print_windows_raster,
        printer::driver_commands::get_windows_print_job,
        scanner::list_serial_ports,
        scanner::configure_scanners,
        scanner::get_scanner_connections,
        scanner::close_scanners,
        office_files::save_office_files,
        office_files::open_office_folder,
        office_files::open_office_file,
        external_link::open_external_link
    ]
}

/// Manages every state the commands read: the device, the local database
/// (opened here, before the window shows; when it cannot open, the app still
/// starts and the local commands say so), the connection status, the scanner
/// manager (it needs the app's handle for its events), kiosk mode, the
/// awake lease, the office's folder under the documents folder (plan ЧЗ) and
/// what the installation and the launch permit of kiosk mode
/// (`window_policy`). `installation` is the installer's file for this
/// computer (`installation::read_file_beside_executable` in `run`), and
/// `args` the launch's arguments (`--windowed`). Returns the device's link,
/// which the connection task watches.
/// `run`'s `setup` calls it, and `tests/ipc.rs` calls it on a mock app (the
/// mock builder does not run `setup`), so a state a command reads cannot go
/// missing here with only a compile to notice.
pub fn manage_state<R: Runtime, I, S>(
    app: &tauri::AppHandle<R>,
    dir: &Path,
    installation: Option<installation::InstallationFile>,
    args: I,
) -> watch::Receiver<Option<Arc<HostLink>>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let role: Option<InstallRole> = installation.map(|file| file.role);
    let device = DeviceState::load(dir.to_path_buf()).with_install_role(role);
    let link = device.watch_link();
    app.manage(device);
    app.manage(tauri::async_runtime::block_on(LocalDbState::open(dir)));
    app.manage(ConnectionState::default());
    app.manage(scanner::manager(app.clone()));
    app.manage(lockdown::LockdownState::default());
    app.manage(window_policy::KioskPolicyState::from_launch(
        installation,
        args,
    ));
    app.manage(power::SystemAwakeState::default());
    app.manage(office_files::OfficeFilesState::from_documents(
        app.path().document_dir().ok(),
    ));
    link
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch brings the running window back, and with
        // `--windowed` unlocks it (`window_policy::on_second_launch`).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            window_policy::on_second_launch(app, &argv);
        }))
        .setup(|app| {
            // The local data directory, not the (roaming, on Windows)
            // config directory: the device identity must stay on this
            // computer and never follow a Windows user profile elsewhere.
            let dir = app.path().app_local_data_dir()?;
            // The window opens ordinary: 1280x800 at most, inside its monitor's
            // work area, centred, never maximized. Kiosk mode (stations) and
            // the office's window mode are the webview's decision, later.
            if let Some(window) = app.get_webview_window(lockdown::MAIN_WINDOW) {
                lockdown::settle_ordinary_window(&window);
            }
            let link = manage_state(
                app.handle(),
                &dir,
                installation::read_file_beside_executable(),
                std::env::args(),
            );
            let status = app.state::<ConnectionState>().inner().clone();
            tauri::async_runtime::spawn(connection::supervise(
                link,
                Arc::new(TauriLinkEvents(app.handle().clone())),
                status,
                Backoff::default(),
            ));
            Ok(())
        })
        .on_window_event(lockdown::refuse_close_while_locked)
        .invoke_handler(invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
