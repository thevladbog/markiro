mod runtime;

use runtime::{EventSink, PortOpener, ScannerEvent};
pub use runtime::{ScannerConfig, ScannerManager, ScannerSnapshot};
use std::io;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Scan payload stays a raw string, independent of the source port.
pub const SCAN_EVENT: &str = "station://scan";
pub const SCANNER_STATUS_EVENT: &str = "station://scanner-status";

pub fn manager(app: AppHandle) -> ScannerManager {
    let opener: PortOpener = Arc::new(|config| {
        serialport::new(&config.port, config.baud)
            .timeout(Duration::from_millis(200))
            .open()
            .map(|port| Box::new(port) as Box<dyn io::Read + Send>)
            .map_err(io::Error::other)
    });
    let sink: EventSink = Arc::new(move |event| match event {
        ScannerEvent::Scan(scan) => {
            let _ = app.emit(SCAN_EVENT, scan);
        }
        ScannerEvent::Status(snapshot) => {
            let _ = app.emit(SCANNER_STATUS_EVENT, snapshot);
        }
    });
    ScannerManager::new(opener, sink, Duration::from_secs(2))
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

#[tauri::command]
pub fn configure_scanners(
    state: State<'_, ScannerManager>,
    scanners: Vec<ScannerConfig>,
) -> Result<(), String> {
    state.configure(scanners)
}

#[tauri::command]
pub fn get_scanner_connections(state: State<'_, ScannerManager>) -> ScannerSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn close_scanner(state: State<'_, ScannerManager>) -> Result<(), String> {
    state.configure(Vec::new())
}
