mod commands;
mod config;

/// Builds and runs the Tauri application. Plugins mirror the idento kiosk
/// baseline: single-instance (one station per machine), sql (SQLite mirror),
/// updater (release-channel updates). Hardware/config/lockdown commands are
/// added in later 05a tasks.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::hello,
            commands::read_config,
            commands::write_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro station");
}
