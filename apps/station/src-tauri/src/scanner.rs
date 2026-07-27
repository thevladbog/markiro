use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Event name carrying one decoded scan payload to the webview.
pub const SCAN_EVENT: &str = "station://scan";

/// Event carrying the scanner's connection state to the webview.
pub const SCANNER_STATUS_EVENT: &str = "station://scanner-status";

/// Monotonic session counter. Each reader thread captures the generation it
/// was started with and exits as soon as the current one differs, so a fast
/// close→open can never leave two readers alive — which is what makes
/// close-before-open safe for the setup screen.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// A reader keeps running only while its own generation is still current.
pub fn session_should_run(mine: u64, current: u64) -> bool {
    mine == current
}

/// Upper bound on how much unterminated data we keep waiting on a line
/// terminator. A barcode payload is at most a couple hundred bytes, so this
/// is two orders of magnitude above any real payload.
const MAX_BUFFER_BYTES: usize = 4096;

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

/// Appends a chunk and returns the complete lines it produced, discarding the
/// pending buffer when it grows past `MAX_BUFFER_BYTES`. A barcode payload is
/// at most a couple hundred bytes, so a buffer beyond the cap without a
/// terminator is garbage — most often a wrong baud rate producing framing
/// noise — and keeping it can never yield a valid scan.
pub fn absorb_chunk(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let lines = split_lines(buffer);
    if buffer.len() > MAX_BUFFER_BYTES {
        eprintln!(
            "scanner: discarding {} bytes without a line terminator (wrong baud rate or non-scanner device?)",
            buffer.len()
        );
        buffer.clear();
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
    // Starting a new session implicitly retires the previous one: its thread
    // sees a newer generation and exits. This is what lets the setup screen
    // recover from a wrong port without an app restart.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let mut handle = serialport::new(&port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| e.to_string())?;

    let _ = app.emit(SCANNER_STATUS_EVENT, "connected");
    let app = app.clone();
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut chunk = [0u8; 256];
        while session_should_run(generation, GENERATION.load(Ordering::SeqCst)) {
            match handle.read(&mut chunk) {
                Ok(0) => continue,
                Ok(n) => {
                    for line in absorb_chunk(&mut buffer, &String::from_utf8_lossy(&chunk[..n])) {
                        let _ = app.emit(SCAN_EVENT, line);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        // Only the session that is still current owns the status: a retired
        // thread exiting must not report a disconnect over its successor.
        if session_should_run(generation, GENERATION.load(Ordering::SeqCst)) {
            let _ = app.emit(SCANNER_STATUS_EVENT, "disconnected");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn close_scanner(app: AppHandle) -> Result<(), String> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit(SCANNER_STATUS_EVENT, "disconnected");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::session_should_run;
    use super::{absorb_chunk, split_lines, MAX_BUFFER_BYTES};

    #[test]
    fn a_session_runs_while_it_is_the_current_generation() {
        assert!(session_should_run(7, 7));
    }

    #[test]
    fn a_session_stops_once_a_newer_generation_starts() {
        assert!(!session_should_run(7, 8));
    }

    #[test]
    fn a_stale_session_stops_even_if_the_counter_moved_far() {
        assert!(!session_should_run(1, 42));
    }

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

    #[test]
    fn absorb_chunk_returns_complete_lines_and_keeps_the_tail_pending() {
        let mut buffer = String::new();
        let lines = absorb_chunk(&mut buffer, "0104600000000015\r\npartial");
        assert_eq!(lines, vec!["0104600000000015"]);
        assert_eq!(buffer, "partial");
    }

    #[test]
    fn absorb_chunk_discards_the_buffer_once_it_exceeds_the_cap_without_a_terminator() {
        let mut buffer = String::new();
        let noise = "x".repeat(1024);
        let mut emitted = Vec::new();

        // Track bytes sent independently of `buffer`'s length: once the cap is
        // crossed, `absorb_chunk` clears `buffer` back to empty, so looping on
        // `buffer.len()` would never observe "past the cap" and never stop.
        let mut total_sent = 0usize;
        while total_sent <= MAX_BUFFER_BYTES {
            emitted.extend(absorb_chunk(&mut buffer, &noise));
            total_sent += noise.len();
        }

        assert!(emitted.is_empty());
        assert!(
            buffer.is_empty(),
            "expected the oversized, terminator-less buffer to be discarded"
        );
    }

    #[test]
    fn absorb_chunk_emits_a_payload_split_across_two_chunks_intact() {
        let mut buffer = String::new();
        let first = absorb_chunk(&mut buffer, "0104600000000015");
        assert!(first.is_empty());
        assert_eq!(buffer, "0104600000000015");

        let second = absorb_chunk(&mut buffer, "\r\n");
        assert_eq!(second, vec!["0104600000000015"]);
        assert!(buffer.is_empty());
    }
}
