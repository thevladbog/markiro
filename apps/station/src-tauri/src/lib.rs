mod commands;
mod config;

use tauri::Manager;

/// Builds and runs the Tauri application. Plugins mirror the idento kiosk
/// baseline: single-instance (one station per machine), sql (SQLite mirror),
/// updater (release-channel updates). Hardware/config/lockdown commands are
/// added in later 05a tasks.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::LockdownState::default())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            commands::enter_lockdown,
            commands::exit_lockdown,
            commands::set_update_endpoint
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
}
