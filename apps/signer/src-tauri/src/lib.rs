mod commands;
mod tray;

use std::sync::Arc;

use signer_core::runtime::Runtime;
#[cfg(windows)]
use signer_core::signer::Signer;
#[cfg(windows)]
use signer_core::storage::SecretStore;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

pub const STATUS_EVENT: &str = "signer://status";
const SIGNER_ICON: tauri::image::Image<'_> = tauri::include_image!("./icons/128x128.png");

/// The deployment this build talks to. Baked in at compile time so a packaged
/// agent can never infer its API target from the webview origin; the service
/// screen can still override it into the config file for a self-hosted tenant.
pub fn default_server_url() -> &'static str {
    option_env!("SIGNER_API_URL").unwrap_or("https://admin.markiro.app")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // Autostart is handled by the NSIS installer's `Run` registry hook
        // (`windows/installer-hooks.nsh`), which works without the app ever
        // having run -- the plugin form was registered here too, with its
        // three `autostart:*` capabilities granted, but `enable()` was never
        // called from anywhere, so it was a second, permanently-dormant
        // autostart mechanism. Removed rather than wired up: the NSIS hook
        // alone is sufficient and needs no webview permission surface.
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let version = app.package_info().version.to_string();

            #[cfg(windows)]
            let signer: Arc<dyn Signer> = match signer_core::signer_backend::signer_backend_from_env()
            {
                signer_core::signer_backend::SignerBackend::Cades => {
                    Arc::new(signer_core::signer_cades::CadesSigner)
                }
                signer_core::signer_backend::SignerBackend::CryptoApi => {
                    Arc::new(signer_core::signer_capi::CapiSigner::new())
                }
            };
            #[cfg(windows)]
            let secrets: Arc<dyn SecretStore> = Arc::new(signer_core::storage_dpapi::DpapiStore);
            #[cfg(not(windows))]
            let (signer, secrets) = commands::unsupported_platform_backends();

            // `Runtime::new` builds its own HTTP client, which is fallible (a
            // broken TLS backend or resolver), so surface that through `setup`'s
            // `Result` rather than unwrapping and taking the whole agent down.
            let runtime = Runtime::new(config_dir, signer, secrets, version)?;
            let runtime = Arc::new(runtime);
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(SIGNER_ICON.clone())?;
            }

            let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let tray_icon = TrayIconBuilder::with_id("markiro-signer")
                .icon(SIGNER_ICON.clone())
                .tooltip("Markiro Подписант")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let initial_status = runtime.status();
            let tray_controller = tray::TrayController::new(
                tray_icon,
                SIGNER_ICON.clone().to_owned(),
                initial_status.phase,
            );
            tray_controller.update_status(app.handle(), &initial_status);
            app.manage(tray_controller);
            app.manage(commands::SignerState {
                runtime: runtime.clone(),
            });

            let animation_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    animation_handle.state::<tray::TrayController>().tick();
                }
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                runtime
                    .run(move |status| {
                        handle
                            .state::<tray::TrayController>()
                            .update_status(&handle, &status);
                        let _ = handle.emit(STATUS_EVENT, status);
                    })
                    .await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window parks the agent in the tray; quitting is an
            // explicit tray action, because a closed window must not stop the
            // token refresh.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::signer_status,
            commands::signer_pair,
            commands::signer_unpair,
            commands::signer_list_certificates,
            commands::signer_select_certificate,
            commands::signer_set_server_url,
            commands::signer_export_journal,
            commands::signer_notify_update,
            commands::signer_set_update_activity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro signer");
}
