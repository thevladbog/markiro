//! The driver printing commands (plan ДРВ) over [`super::driver`], ported
//! from the cloud station's `printer_windows_commands.rs` (#696). Each runs
//! on a thread for blocking work, never on the IPC thread, and answers within
//! `DRIVER_WAIT`: a driver that does not return is `delivery_unknown` for a
//! print (the call may still print) and `unavailable` for a question. The
//! webview's own limit (`PRINT_SEND_LIMIT_MS`, 20 s) is shorter, so the work
//! screen reads `timeout` first; the print runtime keeps the queue busy until
//! this command really answers.

use super::driver::{self, Failure, Observation, Outcome, Receipt};
use std::time::Duration;

const DRIVER_WAIT: Duration = Duration::from_secs(30);

async fn await_driver<T: Send + 'static>(
    mut task: tauri::async_runtime::JoinHandle<T>,
    limit: Duration,
) -> Result<T, ()> {
    match tokio::time::timeout(limit, &mut task).await {
        Ok(result) => result.map_err(|_| ()),
        Err(_) => {
            // Cancels a queued worker only: a running Win32 call can still print.
            task.abort();
            Err(())
        }
    }
}

/// The shell prints through Windows drivers: `true` exactly on Windows.
#[tauri::command]
pub fn supports_windows_printing() -> bool {
    cfg!(windows)
}

/// What a print that did not answer in time is: the call may still print, so
/// it is `delivery_unknown`, never `before_start`.
fn unknown_print() -> Outcome {
    Outcome::Failed {
        ok: false,
        error: Failure {
            code: "driver_failure",
            phase: "delivery_unknown",
            receipt: None,
        },
    }
}

/// Runs a print on a blocking thread for at most `limit`.
async fn print_within(limit: Duration, job: impl FnOnce() -> Outcome + Send + 'static) -> Outcome {
    await_driver(tauri::async_runtime::spawn_blocking(job), limit)
        .await
        .unwrap_or_else(|()| unknown_print())
}

/// Runs a question on a blocking thread for at most `limit`.
async fn observe_within(
    limit: Duration,
    job: impl FnOnce() -> Observation + Send + 'static,
) -> Observation {
    await_driver(tauri::async_runtime::spawn_blocking(job), limit)
        .await
        .unwrap_or(Observation::Unavailable)
}

/// Prints one `mono-raster-v1` page to the Windows queue `queue` as the
/// document `documentName` (`Markiro:<uuid>`). Always answers an [`Outcome`].
/// `paper` is absent for a label and `"a4"` for an A4 sheet (plan А4); any
/// other word is `invalid_artifact` before the queue is opened.
#[tauri::command]
pub async fn print_windows_raster(
    queue: String,
    payload_base64: String,
    document_name: String,
    paper: Option<String>,
) -> Result<Outcome, String> {
    Ok(print_within(DRIVER_WAIT, move || {
        driver::print(queue, payload_base64, document_name, paper)
    })
    .await)
}

/// The spooler's word on a receipt's job.
#[tauri::command]
pub async fn get_windows_print_job(receipt: Receipt) -> Observation {
    observe_within(DRIVER_WAIT, move || driver::observe(receipt)).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    #[test]
    fn a_stalled_driver_releases_the_caller_without_claiming_the_worker_stopped() {
        tauri::async_runtime::block_on(async {
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let (done, finished) = std::sync::mpsc::channel::<()>();
            let (entered, started) = tokio::sync::oneshot::channel::<()>();
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

    fn block_until(release: std::sync::mpsc::Receiver<()>) {
        let _ = release.recv();
    }

    #[test]
    fn a_print_that_does_not_answer_is_delivery_unknown_never_before_start() {
        tauri::async_runtime::block_on(async {
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let outcome = super::print_within(Duration::from_millis(5), move || {
                block_until(blocked);
                super::unknown_print()
            })
            .await;
            assert_eq!(
                serde_json::to_value(&outcome).unwrap(),
                serde_json::json!({
                    "ok": false,
                    "error": { "code": "driver_failure", "phase": "delivery_unknown" }
                })
            );
            let _ = release.send(());
        });
    }

    #[test]
    fn a_print_that_dies_is_delivery_unknown_too() {
        tauri::async_runtime::block_on(async {
            let outcome =
                super::print_within(Duration::from_secs(5), || panic!("the driver thread dies"))
                    .await;
            assert_eq!(
                serde_json::to_value(&outcome).unwrap()["error"]["phase"],
                "delivery_unknown"
            );
        });
    }

    #[test]
    fn a_print_that_answers_keeps_its_own_answer() {
        tauri::async_runtime::block_on(async {
            let refused = super::print_within(Duration::from_secs(5), || super::Outcome::Failed {
                ok: false,
                error: super::Failure {
                    code: "geometry_mismatch",
                    phase: "before_start",
                    receipt: None,
                },
            })
            .await;
            assert_eq!(
                serde_json::to_value(&refused).unwrap(),
                serde_json::json!({
                    "ok": false,
                    "error": { "code": "geometry_mismatch", "phase": "before_start" }
                })
            );
        });
    }

    #[test]
    fn a_question_that_does_not_answer_or_dies_is_unavailable() {
        tauri::async_runtime::block_on(async {
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let stalled = super::observe_within(Duration::from_millis(5), move || {
                block_until(blocked);
                super::Observation::Absent
            })
            .await;
            assert_eq!(
                serde_json::to_value(&stalled).unwrap(),
                serde_json::json!({ "state": "unavailable" })
            );
            let _ = release.send(());
            let dead =
                super::observe_within(Duration::from_secs(5), || panic!("the driver thread dies"))
                    .await;
            assert_eq!(
                serde_json::to_value(&dead).unwrap(),
                serde_json::json!({ "state": "unavailable" })
            );
            let answered =
                super::observe_within(Duration::from_secs(5), || super::Observation::Absent).await;
            assert_eq!(
                serde_json::to_value(&answered).unwrap(),
                serde_json::json!({ "state": "absent" })
            );
        });
    }

    #[test]
    fn the_command_waits_longer_than_the_webview_does() {
        // `PRINT_SEND_LIMIT_MS` is 20 s in the webview: it must read `timeout` first.
        assert!(super::DRIVER_WAIT > Duration::from_millis(20_000));
    }
}
