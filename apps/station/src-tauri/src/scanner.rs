use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Event name carrying one decoded scan payload to the webview.
pub const SCAN_EVENT: &str = "station://scan";

/// Set to false to ask the reader thread to stop.
static SCANNING: AtomicBool = AtomicBool::new(false);

/// Pulls every complete line out of an accumulating buffer, leaving a partial
/// tail in place. Scanners terminate payloads with CR, LF or CRLF, and a read
/// can split a payload across chunks, so the tail must survive.
pub fn split_lines(buffer: &mut String) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(idx) = buffer.find(['\r', '\n']) {
        let line = buffer[..idx].trim().to_string();
        buffer.drain(..=idx);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|p| p.port_name).collect())
}

#[tauri::command]
pub fn open_scanner(app: AppHandle, port: String, baud: u32) -> Result<(), String> {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return Err("Scanner already open".into());
    }
    let mut handle = serialport::new(&port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| {
            SCANNING.store(false, Ordering::SeqCst);
            e.to_string()
        })?;

    let app = Arc::new(app);
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut chunk = [0u8; 256];
        while SCANNING.load(Ordering::SeqCst) {
            match handle.read(&mut chunk) {
                Ok(0) => continue,
                Ok(n) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    for line in split_lines(&mut buffer) {
                        let _ = app.emit(SCAN_EVENT, line);
                    }
                }
                // A read timeout is the normal idle case, not an error.
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        SCANNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn close_scanner() -> Result<(), String> {
    SCANNING.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_lines;

    #[test]
    fn extracts_complete_lines_and_keeps_the_tail() {
        let mut buf = String::from("0104600000000015\r\n0104600000000022\r\npartial");
        let lines = split_lines(&mut buf);
        assert_eq!(lines, vec!["0104600000000015", "0104600000000022"]);
        assert_eq!(buf, "partial");
    }

    #[test]
    fn returns_nothing_until_a_terminator_arrives() {
        let mut buf = String::from("still-typing");
        assert!(split_lines(&mut buf).is_empty());
        assert_eq!(buf, "still-typing");
    }

    #[test]
    fn skips_empty_lines_from_crlf_pairs() {
        let mut buf = String::from("A\r\n\r\nB\n");
        assert_eq!(split_lines(&mut buf), vec!["A", "B"]);
        assert!(buf.is_empty());
    }
}
