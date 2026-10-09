//! The COM scanners' runtime, ported from the cloud station
//! (`apps/station/src-tauri/src/scanner/runtime.rs`) with bare refusal codes:
//! one thread per configured port opens it, reads, frames scans at CR/LF and
//! reconnects after a pause when the port is missing or drops; a status
//! snapshot with a growing `revision` goes out on every change. Opening and
//! emitting are injected (`PortOpener`, `EventSink`), so the tests drive it
//! with fake ports.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::sync::{Arc, Condvar, Mutex, TryLockError, Weak};
use std::time::Duration;

/// The most scanners one configuration may name. A station has a handful of
/// COM ports; the bound keeps a malformed request from starting a thread per
/// element of an enormous array.
pub const MAX_SCANNERS: usize = 32;

/// The longest port name, in characters (the printer's bound too).
pub const MAX_PORT_NAME_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScannerConfig {
    pub port: String,
    pub baud: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScannerConnection {
    pub port: String,
    pub baud: u32,
    pub status: ConnectionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScannerSnapshot {
    pub revision: u64,
    pub scanners: Vec<ScannerConnection>,
}

#[derive(Debug, Clone)]
pub enum ScannerEvent {
    Scan(String),
    Status(ScannerSnapshot),
}

/// Why `configure_scanners` or `list_serial_ports` refused, as the bare code
/// the webview reads (`src/hardware/hardware.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScannerError {
    /// Not `[{ port, baud }]`, more than `MAX_SCANNERS` of them, a port name
    /// empty, longer than `MAX_PORT_NAME_CHARS` or holding a control
    /// character (NUL included), a baud rate of 0, or one port twice (`COM3`
    /// and `com3` are one port).
    InvalidScanners,
    /// The system did not list its serial ports.
    SerialUnavailable,
}

impl ScannerError {
    pub fn code(self) -> &'static str {
        match self {
            ScannerError::InvalidScanners => "invalid_scanners",
            ScannerError::SerialUnavailable => "serial_unavailable",
        }
    }
}

pub type PortOpener = Arc<dyn Fn(&ScannerConfig) -> io::Result<Box<dyn Read + Send>> + Send + Sync>;
// Sinks must enqueue events without calling back into the manager. Emission
// shares the state lock with configuration so stale readers cannot emit later.
pub type EventSink = Arc<dyn Fn(ScannerEvent) + Send + Sync>;

#[derive(Default)]
struct Cancellation {
    cancelled: Mutex<bool>,
    wake: Condvar,
}

impl Cancellation {
    fn cancel(&self) {
        *self.cancelled.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Returns immediately on cancellation, including cancellation before wait.
    fn wait(&self, duration: Duration) -> bool {
        let guard = self.cancelled.lock().unwrap_or_else(|e| e.into_inner());
        let (cancelled, _) = self
            .wake
            .wait_timeout_while(guard, duration, |cancelled| !*cancelled)
            .unwrap_or_else(|e| e.into_inner());
        !*cancelled
    }
}

struct Worker {
    config: ScannerConfig,
    id: u64,
    status: ConnectionStatus,
    cancellation: Arc<Cancellation>,
}

#[derive(Default)]
struct State {
    revision: u64,
    next_worker: u64,
    workers: BTreeMap<String, Worker>,
    // A retiring worker keeps its port gate alive even after removal. Re-adding
    // that port waits for its old handle to drop, without delaying other ports.
    gates: BTreeMap<String, Weak<Mutex<()>>>,
}

impl State {
    fn snapshot(&self) -> ScannerSnapshot {
        ScannerSnapshot {
            revision: self.revision,
            scanners: self
                .workers
                .values()
                .map(|worker| ScannerConnection {
                    port: worker.config.port.clone(),
                    baud: worker.config.baud,
                    status: worker.status,
                })
                .collect(),
        }
    }

    fn publish(&mut self, sink: &EventSink) {
        self.revision += 1;
        sink(ScannerEvent::Status(self.snapshot()));
    }
}

struct Core {
    state: Mutex<State>,
    opener: PortOpener,
    sink: EventSink,
    retry: Duration,
}

impl Core {
    fn set_status(&self, port: &str, id: u64, status: ConnectionStatus) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(worker) = state.workers.get_mut(port).filter(|worker| worker.id == id) else {
            return false;
        };
        if worker.status != status {
            worker.status = status;
            state.publish(&self.sink);
        }
        true
    }

    fn scans(&self, port: &str, id: u64, scans: Vec<String>) {
        if scans.is_empty() {
            return;
        }
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .workers
            .get(port)
            .is_some_and(|worker| worker.id == id)
        {
            for scan in scans {
                (self.sink)(ScannerEvent::Scan(scan));
            }
        }
    }
}

pub struct ScannerManager {
    core: Arc<Core>,
}

impl ScannerManager {
    pub fn new(opener: PortOpener, sink: EventSink, retry: Duration) -> Self {
        Self {
            core: Arc::new(Core {
                state: Mutex::default(),
                opener,
                sink,
                retry,
            }),
        }
    }

    /// Validates the entire request before mutation; no serial I/O or thread
    /// joining runs on the IPC thread. Missing and busy ports remain configured.
    pub fn configure(&self, scanners: Vec<ScannerConfig>) -> Result<(), ScannerError> {
        if scanners.len() > MAX_SCANNERS {
            return Err(ScannerError::InvalidScanners);
        }
        let mut requested = BTreeMap::new();
        for mut config in scanners {
            config.port = canonical_port(&config.port);
            if config.port.is_empty()
                || config.port.chars().count() > MAX_PORT_NAME_CHARS
                || config.port.chars().any(char::is_control)
                || config.baud == 0
            {
                return Err(ScannerError::InvalidScanners);
            }
            if requested.insert(config.port.clone(), config).is_some() {
                return Err(ScannerError::InvalidScanners);
            }
        }

        let mut starts = Vec::new();
        {
            let mut state = self.core.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.workers.len() == requested.len()
                && state
                    .workers
                    .iter()
                    .all(|(port, worker)| requested.get(port) == Some(&worker.config))
            {
                // A caller may have reset its display while entering/leaving
                // setup. Acknowledge even an unchanged set with a fresh
                // snapshot, preserving every worker and pending fragment.
                state.publish(&self.core.sink);
                return Ok(());
            }
            state.workers.retain(|port, worker| {
                let retained = requested.get(port) == Some(&worker.config);
                if !retained {
                    worker.cancellation.cancel();
                }
                retained
            });
            state.gates.retain(|_, gate| gate.strong_count() > 0);
            for (port, config) in requested {
                if state.workers.contains_key(&port) {
                    continue;
                }
                let gate = state
                    .gates
                    .get(&port)
                    .and_then(Weak::upgrade)
                    .unwrap_or_default();
                state.gates.insert(port.clone(), Arc::downgrade(&gate));
                state.next_worker += 1;
                let id = state.next_worker;
                let cancellation = Arc::new(Cancellation::default());
                state.workers.insert(
                    port,
                    Worker {
                        config: config.clone(),
                        id,
                        status: ConnectionStatus::Disconnected,
                        cancellation: Arc::clone(&cancellation),
                    },
                );
                starts.push((config, id, cancellation, gate));
            }
            state.publish(&self.core.sink);
        }
        for (config, id, cancellation, gate) in starts {
            let core = Arc::clone(&self.core);
            std::thread::spawn(move || run_port(core, config, id, cancellation, gate));
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ScannerSnapshot {
        self.core
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot()
    }
}

impl Drop for ScannerManager {
    fn drop(&mut self) {
        let _ = self.configure(Vec::new());
    }
}

fn canonical_port(port: &str) -> String {
    let port = port.trim();
    if port
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("COM"))
        && port.len() > 3
        && port.as_bytes()[3..].iter().all(u8::is_ascii_digit)
    {
        port.to_ascii_uppercase()
    } else {
        port.to_string()
    }
}

fn run_port(
    core: Arc<Core>,
    config: ScannerConfig,
    id: u64,
    cancellation: Arc<Cancellation>,
    gate: Arc<Mutex<()>>,
) {
    let _port_guard = loop {
        if cancellation.is_cancelled() {
            return;
        }
        match gate.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::Poisoned(error)) => break error.into_inner(),
            Err(TryLockError::WouldBlock) => {
                if !cancellation.wait(Duration::from_millis(10)) {
                    return;
                }
            }
        }
    };
    while !cancellation.is_cancelled() {
        // Blocking open and read never hold the shared configuration lock.
        if let Ok(mut handle) = (core.opener)(&config) {
            if !core.set_status(&config.port, id, ConnectionStatus::Connected) {
                return;
            }
            // The unfinished frame belongs only to this connection attempt.
            let mut framer = Framer::default();
            let mut chunk = [0u8; 256];
            while !cancellation.is_cancelled() {
                match handle.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let scans = framer.absorb(&chunk[..n]);
                        if framer.take_oversize() {
                            // The port's name only: never a byte of the frame.
                            eprintln!(
                                "standalone: scanner {} dropped a frame over {MAX_FRAME_BYTES} bytes",
                                config.port
                            );
                        }
                        core.scans(&config.port, id, scans);
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::TimedOut
                                | io::ErrorKind::WouldBlock
                                | io::ErrorKind::Interrupted
                        ) =>
                    {
                        continue
                    }
                    Err(_) => break,
                }
            }
            // Release the OS handle before publishing loss or retrying open.
            // The unfinished buffer belongs only to this connection attempt.
            drop(handle);
            if !core.set_status(&config.port, id, ConnectionStatus::Disconnected) {
                return;
            }
        }
        if !cancellation.wait(core.retry) {
            return;
        }
    }
}

/// The longest frame a scanner may send, terminator excluded. A longer one
/// is dropped whole (see `Framer`).
pub const MAX_FRAME_BYTES: usize = 4096;

/// Assembles scans from the serial byte stream. A frame ends at CR, LF or any
/// run of them (CRLF, LFCR, a scanner's double terminator), empty frames
/// are skipped, and the bytes between terminators are decoded as UTF-8 with
/// replacement only once the frame is whole, so a read that splits a
/// multibyte character, or the GS byte `0x1D`, cannot change the scan. Nothing
/// depends on how the operating system chops the stream into reads.
///
/// A frame longer than `MAX_FRAME_BYTES` (a scanner without a terminator,
/// noise on a floating line) is dropped whole, through its terminator: its
/// tail is never emitted as a scan of its own, and memory stays bounded.
#[derive(Default)]
struct Framer {
    pending: Vec<u8>,
    /// Inside an oversize frame: skip bytes up to the next terminator.
    discarding: bool,
    /// Oversize frames dropped since `take_oversize` last asked.
    oversize: usize,
}

impl Framer {
    fn absorb(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut scans = Vec::new();
        for &byte in chunk {
            if byte == b'\r' || byte == b'\n' {
                // `pending` is empty while discarding, so a dropped frame
                // is never emitted.
                if !self.pending.is_empty() {
                    scans.push(String::from_utf8_lossy(&self.pending).into_owned());
                }
                self.pending.clear();
                self.discarding = false;
            } else if self.discarding {
                continue;
            } else if self.pending.len() == MAX_FRAME_BYTES {
                self.pending.clear();
                self.discarding = true;
                self.oversize += 1;
            } else {
                self.pending.push(byte);
            }
        }
        scans
    }

    /// Whether an oversize frame was dropped since the last call.
    fn take_oversize(&mut self) -> bool {
        std::mem::take(&mut self.oversize) > 0
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
