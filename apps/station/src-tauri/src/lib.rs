mod commands;
mod config;
mod grant_clock;
mod grant_transaction;
mod power;
mod printer;
mod printer_raster;
mod printer_windows;
mod printer_windows_commands;
mod scanner;
mod storage;
mod updater;

use tauri::Manager;

// Set the runtime window icon as well as the bundle icon so Windows does not
// fall back to a cached/default process icon in the taskbar.
const STATION_ICON: tauri::image::Image<'_> = tauri::include_image!("./icons/128x128.png");

/// Builds and runs the Tauri application. Plugins mirror the idento kiosk
/// baseline: single-instance (one station per machine), sql (SQLite mirror),
/// updater (release-channel updates). Hardware/config/lockdown commands are
/// added in later 05a tasks.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::LockdownState::default())
        .manage(updater::StationUpdaterState::default())
        .manage(power::SystemAwakeState::default())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            app.manage(scanner::manager(app.handle().clone()));
            start_storage_resolution(app)?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(STATION_ICON.clone())?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let locked = window
                    .state::<commands::LockdownState>()
                    .0
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                if locked {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::read_config,
            commands::write_config,
            commands::clear_credential,
            commands::station_database_url,
            commands::station_storage_status,
            commands::enter_lockdown,
            commands::exit_lockdown,
            grant_clock::grant_clock_sample,
            grant_transaction::grant_atomic_execute,
            power::set_system_awake,
            scanner::list_serial_ports,
            scanner::configure_scanners,
            scanner::get_scanner_connections,
            scanner::close_scanner,
            printer::print_bytes,
            printer::list_usb_printers,
            printer_windows_commands::supports_windows_printing,
            printer_windows_commands::preflight_windows_raster,
            printer_windows_commands::print_windows_raster,
            printer_windows_commands::get_windows_print_job,
            updater::station_update_check,
            updater::station_update_download_and_install,
            updater::station_update_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
}

/// Resolves where `station.json` and `station-mirror.db` live, on a background
/// thread: `setup` runs on the UI thread after the main window exists, and the
/// one-time move copies the database. Storage commands wait on the gate.
fn start_storage_resolution(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let (resolved, gate) = storage::storage_gate();
    app.manage(gate);
    let legacy_dir = app.path().app_config_dir()?;
    let local_dir = app.path().app_local_data_dir()?;
    std::thread::Builder::new()
        .name("station-storage".into())
        .spawn(move || {
            let resolution = storage::resolve(
                &legacy_dir,
                &local_dir,
                storage::profile_facts(),
                &mut |_| Ok(()),
            );
            match &resolution {
                Ok(storage) if !storage.notices.is_empty() => eprintln!(
                    "station: storage {:?} in {} with notices {:?}",
                    storage.mode,
                    storage.dir.display(),
                    storage.notices
                ),
                Ok(_) => {}
                Err(reason) => eprintln!("station: storage blocked: {reason}"),
            }
            resolved.resolve(resolution);
        })?;
    Ok(())
}
