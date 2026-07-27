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

/// Bound on the open retry loop below: roughly a second total, which covers
/// the setup screen's close-before-open without a new crate.
const OPEN_ATTEMPTS: u32 = 10;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(100);

/// `async` so the Tauri IPC layer runs this off the UI/IPC thread: the retry
/// loop below does up to `OPEN_ATTEMPTS` blocking `open()` calls with sleeps
/// in between, and a mistyped or absent serial port — exactly what the setup
/// screen's Connect button exists to catch — must not freeze the whole
/// station for that long. Mirrors `printer.rs`'s `print_bytes`: the blocking
/// work runs on a `spawn_blocking` thread and this command just awaits it.
#[tauri::command]
pub async fn open_scanner(app: AppHandle, port: String, baud: u32) -> Result<(), String> {
    // Open the port before touching GENERATION. If every attempt fails, the
    // previous session (if any) is left untouched — its thread, port handle
    // and "connected" status all stay valid. Advancing GENERATION first
    // would retire a working session for an open that never happens, which
    // is exactly what used to leave the operator with a dead scanner and a
    // status bar stuck on "connected".
    //
    // The retries matter for a real case: `close_scanner` only signals the
    // reader thread, which keeps the OS handle until its current 200 ms
    // read times out, and serialport opens exclusively on every platform —
    // so an immediate close-then-open on the same port would otherwise fail
    // with a "port busy" error.
    let mut handle = tauri::async_runtime::spawn_blocking(move || {
        let mut attempt = 0;
        loop {
            match serialport::new(&port, baud)
                .timeout(Duration::from_millis(200))
                .open()
            {
                Ok(handle) => return Ok(handle),
                // A missing port can never be fixed by waiting, so don't burn
                // the retry window on it. Note this checks `Io(NotFound)`,
                // not `ErrorKind::NoDevice`: on this crate (serialport 4.x),
                // NoDevice is what a still-held handle reports (EBUSY from
                // TIOCEXCL, or EWOULDBLOCK from flock, both mapped to
                // NoDevice in `posix/error.rs` and `posix/flock.rs`) — i.e.
                // exactly the retiring-reader-thread case the retry window
                // exists for, so it must keep retrying. A path that simply
                // does not exist surfaces as `ENOENT` -> `Io(NotFound)`
                // instead, and that's the one worth failing fast on. (On
                // Windows this crate folds `ERROR_ACCESS_DENIED` in with
                // `ERROR_FILE_NOT_FOUND`/`ERROR_PATH_NOT_FOUND` under
                // `NoDevice`, so this fast path simply won't trigger there —
                // Windows keeps the old retry-everything behaviour.)
                Err(e) if e.kind() == serialport::ErrorKind::Io(std::io::ErrorKind::NotFound) => {
                    return Err(e.to_string());
                }
                Err(e) => {
                    attempt += 1;
                    if attempt >= OPEN_ATTEMPTS {
                        // Return the error straight from the last attempt's
                        // arm: nothing to `.expect()` after the fact.
                        return Err(e.to_string());
                    }
                    std::thread::sleep(OPEN_RETRY_DELAY);
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    // Only now that the handle is in hand do we retire the previous session:
    // its thread sees a newer generation and exits. This is what lets the
    // setup screen recover from a wrong port without an app restart.
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let _ = app.emit(SCANNER_STATUS_EVENT, "connected");
    std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut chunk = [0u8; 256];
        while session_should_run(generation, GENERATION.load(Ordering::SeqCst)) {
            match handle.read(&mut chunk) {
                Ok(0) => continue,
                Ok(n) => {
                    let received = String::from_utf8_lossy(&chunk[..n]);
                    for line in absorb_chunk(&mut buffer, &received) {
                        let _ = app.emit(SCAN_EVENT, line);
                    }
                }
                // A read timeout is the normal idle case, not an error.
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        // Only the session that is still current owns the status: a retired
        // thread exiting must not report a disconnect over its successor.
        //
        // Known residual race (accepted, not closed): between the load above
        // and the emit below, a new session could advance GENERATION, open
        // its port and emit "connected" — this thread would then emit
        // "disconnected" on top of it. This is no longer just a
        // narrow-instruction-window coincidence: `open_scanner`'s retry loop
        // is designed to overlap a dying reader thread (still holding its
        // handle until this loop's own read times out) with a fresh open on
        // the same port, so hitting this window is an expected consequence
        // of that design, not a rare preemption fluke. Closing it would mean
        // serializing the emit with the generation change, which isn't worth
        // it for this window.
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
