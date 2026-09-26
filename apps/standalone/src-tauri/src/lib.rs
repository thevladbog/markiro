//! Tauri shell of the Markiro standalone app. The webview never performs
//! network requests itself: every call to the host goes through commands
//! here, so certificate checks stay in Rust.

pub mod host_probe;

#[tauri::command]
async fn host_hello(address: String) -> Result<host_probe::HelloObservation, String> {
    host_probe::observe_hello(&address)
        .await
        .map_err(|error| error.code().to_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .invoke_handler(tauri::generate_handler![host_hello])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro standalone app");
}
