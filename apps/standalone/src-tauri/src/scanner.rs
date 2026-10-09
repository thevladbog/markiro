//! COM scanners in the shell (stage 2a spec §5.2, decision 24), ported from
//! the cloud station (`apps/station/src-tauri/src/scanner.rs`). The webview
//! hands over the whole desired set of ports at once (`configure_scanners`);
//! each scan reaches it as the event `standalone://scan` with the raw text
//! (the GS1 group separator and any AIM prefix kept: `@markiro/domain` reads
//! them), and every connection change as `standalone://scanner-status`. A
//! keyboard-wedge scanner needs none of this: it types into the window.
//!
//! A scan is production input, so a frame is never altered or split here: it
//! runs between terminators (CR, LF) and arrives whole, or not at all (a frame
//! cut off by an unplugged cable, or longer than 4096 bytes, is dropped, never
//! sent as a fragment). Noise on the line is not a frame of its own: bytes
//! sent without a terminator join the next scan, and the first frame after a
//! port opens may be the tail of one the scanner began earlier. A scanner
//! must therefore be set to send a CR or LF suffix. Nothing a scanner sends
//! reaches the process log or an error code. An event emitted while the
//! webview is not listening (a window reloading) is not queued: the status is
//! recovered by asking (`get_scanner_connections`), a scan is not.

mod runtime;

use std::io;
use std::sync::Arc;
use std::time::Duration;

pub use runtime::{
    ConnectionStatus, EventSink, PortOpener, ScannerConfig, ScannerConnection, ScannerError,
    ScannerEvent, ScannerManager, ScannerSnapshot, MAX_FRAME_BYTES, MAX_PORT_NAME_CHARS,
    MAX_SCANNERS,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};

/// A scan: the raw text between CR/LF, decoded as UTF-8 with replacement.
pub const SCAN_EVENT: &str = "standalone://scan";
/// The configured ports and their connection, `{ revision, scanners }`.
pub const SCANNER_STATUS_EVENT: &str = "standalone://scanner-status";

/// How long a port that is missing or dropped waits before opening again.
pub const RETRY: Duration = Duration::from_secs(2);

/// Opens a real serial port; a read waits at most 200 ms, so a removed
/// configuration stops its thread quickly.
pub fn serial_opener() -> PortOpener {
    Arc::new(|config| {
        serialport::new(&config.port, config.baud)
            .timeout(Duration::from_millis(200))
            .open()
            .map(|port| Box::new(port) as Box<dyn io::Read + Send>)
            .map_err(io::Error::other)
    })
}

/// Emits the runtime's scans and statuses through `emit` (the event's name
/// and its JSON payload). A closed window hears nothing and a failed emit is
/// reported to `report` by the event's name alone: never the scan, whose
/// text may be a badge or a crypto tail. The next status replaces one that
/// was missed; a scan that was not delivered is lost, and the line is the
/// only trace of it.
pub fn emit_sink<E, F, L>(emit: F, report: L) -> EventSink
where
    E: std::fmt::Display,
    F: Fn(&'static str, Value) -> Result<(), E> + Send + Sync + 'static,
    L: Fn(String) + Send + Sync + 'static,
{
    Arc::new(move |event| {
        let (name, payload) = match event {
            ScannerEvent::Scan(scan) => (SCAN_EVENT, Value::String(scan)),
            ScannerEvent::Status(snapshot) => match serde_json::to_value(&snapshot) {
                Ok(payload) => (SCANNER_STATUS_EVENT, payload),
                Err(_) => return report(format!("standalone: {SCANNER_STATUS_EVENT} not built")),
            },
        };
        if let Err(error) = emit(name, payload) {
            report(format!("standalone: {name} not delivered: {error}"));
        }
    })
}

/// Emits the runtime's events to the webview.
pub fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> EventSink {
    emit_sink(
        move |name, payload| app.emit(name, payload),
        |line| eprintln!("{line}"),
    )
}

/// The app's scanner manager: real ports, Tauri events, a 2 s retry.
pub fn manager<R: Runtime>(app: AppHandle<R>) -> ScannerManager {
    ScannerManager::new(serial_opener(), tauri_sink(app), RETRY)
}

/// The names of the serial ports the system knows (`COM3`, `/dev/ttyUSB0`).
/// Listing can take a while on Windows (every driver is asked), so it runs
/// off the main thread.
#[tauri::command(async)]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|error| {
        eprintln!("standalone: list_serial_ports serial_unavailable: {error}");
        ScannerError::SerialUnavailable.code().to_owned()
    })?;
    Ok(ports.into_iter().map(|port| port.port_name).collect())
}

/// The webview's `scanners` argument, read: `[{ port, baud }]` and nothing
/// else (an unknown field, a missing one, a baud that is not a whole number
/// within `u32` and any other shape are `invalid_scanners`, the one code for
/// every unusable configuration). The names and the count are checked by
/// `ScannerManager::configure`.
pub fn parse_scanners(scanners: Option<Value>) -> Result<Vec<ScannerConfig>, ScannerError> {
    let scanners = scanners.ok_or(ScannerError::InvalidScanners)?;
    serde_json::from_value(scanners).map_err(|_| ScannerError::InvalidScanners)
}

/// Replaces the whole set of scanners with `scanners` (`[{ port, baud }]`):
/// ports that stay keep their connection and any half-read scan, removed
/// ones close, new ones start opening. Checked whole before anything
/// changes; no serial I/O runs on the IPC thread. The argument is read here
/// from JSON, so a missing or misshapen one answers `invalid_scanners`, not
/// Tauri's own text.
#[tauri::command]
pub fn configure_scanners(
    state: State<'_, ScannerManager>,
    scanners: Option<Value>,
) -> Result<(), String> {
    let scanners = parse_scanners(scanners).map_err(|error| error.code().to_owned())?;
    state
        .configure(scanners)
        .map_err(|error| error.code().to_owned())
}

/// The latest snapshot: the webview subscribes to the status event first,
/// then asks, and keeps whichever `revision` is newer.
#[tauri::command]
pub fn get_scanner_connections(state: State<'_, ScannerManager>) -> ScannerSnapshot {
    state.snapshot()
}

/// Closes every scanner port. Closing what is already closed is no error, and
/// no state of the manager (a lock poisoned by a panicking sink included)
/// keeps the ports open.
#[tauri::command]
pub fn close_scanners(state: State<'_, ScannerManager>) -> Result<(), String> {
    state
        .configure(Vec::new())
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    type Emitted = Arc<Mutex<Vec<(&'static str, Value)>>>;

    /// A sink over a recording `emit` that fails when `fail` says so, and a
    /// recording log.
    fn sink(fail: bool) -> (EventSink, Emitted, Arc<Mutex<Vec<String>>>) {
        let emitted: Emitted = Arc::default();
        let logged: Arc<Mutex<Vec<String>>> = Arc::default();
        let emit_into = Arc::clone(&emitted);
        let log_into = Arc::clone(&logged);
        let sink = emit_sink(
            move |name, payload| {
                if fail {
                    Err("webview gone")
                } else {
                    emit_into.lock().unwrap().push((name, payload));
                    Ok(())
                }
            },
            move |line| log_into.lock().unwrap().push(line),
        );
        (sink, emitted, logged)
    }

    fn snapshot() -> ScannerSnapshot {
        ScannerSnapshot {
            revision: 7,
            scanners: vec![ScannerConnection {
                port: "COM3".into(),
                baud: 9600,
                status: ConnectionStatus::Connected,
            }],
        }
    }

    #[test]
    fn the_event_names_and_the_retry_are_the_ones_the_webview_and_the_spec_name() {
        assert_eq!(SCAN_EVENT, "standalone://scan");
        assert_eq!(SCANNER_STATUS_EVENT, "standalone://scanner-status");
        assert_eq!(RETRY, Duration::from_secs(2));
        assert_eq!(MAX_FRAME_BYTES, 4096);
    }

    #[test]
    fn a_scan_goes_out_as_its_raw_string_and_a_status_as_the_snapshot() {
        let (sink, emitted, logged) = sink(false);
        // Spaces and a tab around the text are part of the scan.
        let raw = " ]d2010460000000001521serial\u{1d}91key\u{1d}92crypto+tail= \t";
        sink(ScannerEvent::Scan(raw.into()));
        sink(ScannerEvent::Status(snapshot()));
        assert_eq!(
            *emitted.lock().unwrap(),
            [
                (SCAN_EVENT, Value::String(raw.into())),
                (
                    SCANNER_STATUS_EVENT,
                    json!({
                        "revision": 7,
                        "scanners": [{ "port": "COM3", "baud": 9600, "status": "connected" }]
                    })
                ),
            ]
        );
        assert!(logged.lock().unwrap().is_empty());
    }

    #[test]
    fn a_failed_emit_is_reported_by_event_name_and_never_carries_the_scan() {
        let (sink, emitted, logged) = sink(true);
        let secret = "BADGE-0042\u{1d}crypto-tail";
        sink(ScannerEvent::Scan(secret.into()));
        sink(ScannerEvent::Status(snapshot()));
        sink(ScannerEvent::Scan("next".into()));
        assert!(emitted.lock().unwrap().is_empty());
        let logged = logged.lock().unwrap();
        assert_eq!(
            *logged,
            [
                "standalone: standalone://scan not delivered: webview gone",
                "standalone: standalone://scanner-status not delivered: webview gone",
                "standalone: standalone://scan not delivered: webview gone",
            ]
        );
        for line in logged.iter() {
            assert!(!line.contains("BADGE") && !line.contains("crypto"));
        }
    }

    #[test]
    fn the_scanners_argument_is_read_strictly_and_everything_else_is_invalid_scanners() {
        let invalid = Err(ScannerError::InvalidScanners);
        assert_eq!(
            parse_scanners(Some(json!([{ "port": "com3", "baud": 9600 }]))),
            Ok(vec![ScannerConfig {
                port: "com3".into(),
                baud: 9600
            }])
        );
        assert_eq!(parse_scanners(Some(json!([]))), Ok(vec![]));
        for bad in [
            Value::Null,
            json!("COM3"),
            json!({ "port": "COM3", "baud": 9600 }),
            json!([null]),
            json!(["COM3"]),
            json!([{ "port": "COM3" }]),
            json!([{ "baud": 9600 }]),
            json!([{ "port": "COM3", "baud": 9600, "parity": "none" }]),
            json!([{ "port": 3, "baud": 9600 }]),
            json!([{ "port": "COM3", "baud": "9600" }]),
            json!([{ "port": "COM3", "baud": 9600.0 }]),
            json!([{ "port": "COM3", "baud": 9600.5 }]),
            json!([{ "port": "COM3", "baud": -1 }]),
            json!([{ "port": "COM3", "baud": 4_294_967_296_u64 }]),
            json!([{ "port": "COM3", "baud": null }]),
        ] {
            assert_eq!(parse_scanners(Some(bad.clone())), invalid, "{bad}");
        }
        assert_eq!(parse_scanners(None), invalid);
        assert_eq!(
            parse_scanners(Some(json!([{ "port": "COM3", "baud": u32::MAX }]))),
            Ok(vec![ScannerConfig {
                port: "COM3".into(),
                baud: u32::MAX
            }])
        );
    }

    #[test]
    fn the_codes_are_the_bare_strings_the_webview_reads() {
        assert_eq!(ScannerError::InvalidScanners.code(), "invalid_scanners");
        assert_eq!(ScannerError::SerialUnavailable.code(), "serial_unavailable");
    }
}
