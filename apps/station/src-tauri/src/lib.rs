mod commands;
mod config;
mod printer;
mod scanner;
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
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
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
            commands::enter_lockdown,
            commands::exit_lockdown,
            scanner::list_serial_ports,
            scanner::open_scanner,
            scanner::close_scanner,
            printer::print_bytes,
            printer::list_usb_printers,
            updater::station_update_check,
            updater::station_update_download_and_install,
            updater::station_update_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
}
