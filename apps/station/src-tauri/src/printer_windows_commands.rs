use crate::printer_sheet::{WindowsPageGeometry, WindowsPageOptions};
use crate::printer_windows::{self, Failure, Observation, Outcome, Preflight, Receipt};
use std::time::Duration;

const DRIVER_WAIT: Duration = Duration::from_secs(30);

async fn await_driver<T: Send + 'static>(
    mut task: tauri::async_runtime::JoinHandle<T>,
    limit: Duration,
) -> Result<T, ()> {
    match tokio::time::timeout(limit, &mut task).await {
        Ok(result) => result.map_err(|_| ()),
        Err(_) => {
            // Cancels a queued worker only. A running Win32 call can still print.
            task.abort();
            Err(())
        }
    }
}

#[tauri::command]
pub fn supports_windows_printing() -> bool {
    cfg!(windows)
}
#[tauri::command]
pub fn supports_windows_a4_printing() -> bool {
    cfg!(windows)
}
#[tauri::command]
pub async fn get_windows_page_geometry(
    queue: String,
    page_options: WindowsPageOptions,
) -> Result<WindowsPageGeometry, Failure> {
    await_driver(
        tauri::async_runtime::spawn_blocking(move || {
            printer_windows::page_geometry(queue, page_options)
        }),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Err(Failure {
        code: "driver_failure",
        phase: "before_start",
        receipt: None,
    }))
}
#[tauri::command]
pub async fn preflight_windows_raster(
    queue: String,
    payload_base64: String,
    page_options: Option<WindowsPageOptions>,
    geometry_fingerprint: Option<String>,
) -> Result<Preflight, String> {
    Ok(await_driver(
        tauri::async_runtime::spawn_blocking(move || {
            printer_windows::preflight_page(
                queue,
                payload_base64,
                page_options,
                geometry_fingerprint,
            )
        }),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Preflight::Failed {
        ok: false,
        error: Failure {
            code: "driver_failure",
            phase: "before_start",
            receipt: None,
        },
    }))
}
#[tauri::command]
pub async fn print_windows_raster(
    queue: String,
    payload_base64: String,
    document_name: String,
    page_options: Option<WindowsPageOptions>,
    geometry_fingerprint: Option<String>,
) -> Result<Outcome, String> {
    Ok(await_driver(
        tauri::async_runtime::spawn_blocking(move || {
            printer_windows::print_page(
                queue,
                payload_base64,
                document_name,
                page_options,
                geometry_fingerprint,
            )
        }),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Outcome::Failed {
        ok: false,
        error: Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: None,
        },
    }))
}
#[tauri::command]
pub async fn get_windows_print_job(receipt: Receipt) -> Observation {
    await_driver(
        tauri::async_runtime::spawn_blocking(move || printer_windows::observe(receipt)),
        DRIVER_WAIT,
    )
    .await
    .unwrap_or(Observation::Unavailable)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    #[test]
    fn a_stalled_driver_releases_the_caller_without_claiming_the_worker_stopped() {
        tauri::async_runtime::block_on(async {
            let (release, blocked) = std::sync::mpsc::channel();
            let (done, finished) = std::sync::mpsc::channel();
            let (entered, started) = tokio::sync::oneshot::channel();
            let task = tauri::async_runtime::spawn_blocking(move || {
                entered.send(()).unwrap();
                blocked.recv().unwrap();
                done.send(()).unwrap();
            });
            started.await.unwrap();
            assert!(super::await_driver(task, Duration::from_millis(5))
                .await
                .is_err());
            release.send(()).unwrap();
            finished.recv_timeout(Duration::from_secs(1)).unwrap();
        });
    }
}
