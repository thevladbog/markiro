//! Label printing (stage 2a spec §5.2, decision 20), ported from the cloud
//! station's `print_bytes` and `list_usb_printers`
//! (`apps/station/src-tauri/src/printer.rs`). Raw ZPL/TSPL bytes go to a
//! network printer (TCP, port 9100 as a rule), a COM port, or — on Windows
//! only — a spooler queue with datatype RAW (`printer/spooler.rs`).
//!
//! Refusals are bare codes that tell the webview what it may do next:
//! `not_sent` — no byte left this computer (the address did not resolve, or
//! the connection, the port or the queue did not open), so printing again
//! cannot double a label; `outcome_unknown` — the failure came after the
//! first write began, so the label may or may not exist, and only the
//! operator decides (plan 2a7 never resends by itself); `invalid_target` and
//! `invalid_payload` — the webview sent something unusable; `unsupported` —
//! a USB queue off Windows. The system's own error text never crosses IPC: it
//! goes to the process's stderr after the command's name and the code, and it
//! names neither the address nor any byte of the label.
//!
//! What a success means: the operating system took every byte (a socket's
//! send buffer, the COM driver, the spooler's queue). A network printer
//! sends no receipt, so a label that was buffered and then lost with the
//! connection is not seen here.

use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod spooler;

/// The longest label `print_bytes` takes: 32 MiB of decoded bytes (a 100 x 150
/// mm bitmap at 300 dpi is about 280 KiB). A longer one is `invalid_payload`,
/// not a send that fills a printer's buffer or the spooler's disk.
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

/// Where the label bytes go, as `src/hardware/hardware.ts` sends it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrintTarget {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
    Usb { printer: String },
}

/// Why `print_bytes` (or `list_usb_printers`) failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrintError {
    /// Nothing was sent; printing again cannot double the label.
    NotSent,
    /// The failure came after the first write began.
    OutcomeUnknown,
    /// The target is not one of the three kinds, or its fields are unusable.
    InvalidTarget,
    /// The payload is not base64, or it is empty, or too long.
    InvalidPayload,
    /// A USB queue off Windows.
    Unsupported,
    /// The Windows spooler did not list its queues (`list_usb_printers`).
    SpoolerUnavailable,
}

impl PrintError {
    /// Stable codes the webview reads (`src/hardware/hardware.ts`).
    pub fn code(self) -> &'static str {
        match self {
            PrintError::NotSent => "not_sent",
            PrintError::OutcomeUnknown => "outcome_unknown",
            PrintError::InvalidTarget => "invalid_target",
            PrintError::InvalidPayload => "invalid_payload",
            PrintError::Unsupported => "unsupported",
            PrintError::SpoolerUnavailable => "spooler_unavailable",
        }
    }
}

/// A failed send: the code, and the system's words for the process log.
#[derive(Debug)]
pub struct PrintFailure {
    pub error: PrintError,
    pub detail: String,
}

impl PrintFailure {
    fn new(error: PrintError, detail: impl std::fmt::Display) -> Self {
        Self {
            error,
            detail: detail.to_string(),
        }
    }
}

impl From<spooler::SpoolerError> for PrintFailure {
    fn from(failure: spooler::SpoolerError) -> Self {
        let error = match failure.stage {
            spooler::Stage::NotSent => PrintError::NotSent,
            spooler::Stage::OutcomeUnknown => PrintError::OutcomeUnknown,
        };
        PrintFailure::new(error, failure.detail)
    }
}

/// How long a send may wait: for the connection (TCP, all addresses of the
/// name together) and for each write (TCP and COM). A write that moves some
/// bytes starts the wait afresh, so the limit is on a stalled printer, not on
/// a long label. The cloud station's 5 s each; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub write: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(5),
            write: Duration::from_secs(5),
        }
    }
}

/// The target the webview sent, checked: a host without spaces or control
/// characters and a port other than 0; a port name and a baud rate other
/// than 0; a queue name. The webview's arguments arrive as JSON, so a shape
/// that is none of the three is `invalid_target` too, not Tauri's own text.
/// A host that is well-formed but does not exist is not rejected here: it
/// fails to resolve, which is `not_sent`.
pub fn parse_target(value: Value) -> Result<PrintTarget, PrintError> {
    let target: PrintTarget =
        serde_json::from_value(value).map_err(|_| PrintError::InvalidTarget)?;
    let plain = |text: &str, max: usize| {
        !text.trim().is_empty()
            && text.chars().count() <= max
            && !text.chars().any(char::is_control)
    };
    let usable = match &target {
        PrintTarget::Serial { port, baud } => plain(port, 256) && *baud > 0,
        PrintTarget::Tcp { host, port } => {
            plain(host, 253) && !host.chars().any(char::is_whitespace) && *port > 0
        }
        PrintTarget::Usb { printer } => plain(printer, 256),
    };
    if usable {
        Ok(target)
    } else {
        Err(PrintError::InvalidTarget)
    }
}

/// Tauri's IPC is JSON, so the label's bytes arrive base64-encoded (standard
/// alphabet, canonical padding, no whitespace — what `btoa` writes); an empty
/// label is refused, not sent as nothing, and so is one over
/// [`MAX_PAYLOAD_BYTES`].
pub fn decode_payload(payload_base64: &str) -> Result<Vec<u8>, PrintError> {
    match STANDARD.decode(payload_base64) {
        Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_PAYLOAD_BYTES => Ok(bytes),
        _ => Err(PrintError::InvalidPayload),
    }
}

/// `host:port` to its socket addresses; a name that resolves to nothing is
/// `not_sent` at once, instead of after the operating system's long wait.
fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, PrintFailure> {
    (host, port)
        .to_socket_addrs()
        .map(Iterator::collect)
        .map_err(|error| PrintFailure::new(PrintError::NotSent, format!("resolve: {error}")))
}

/// Opens a connection to the first address that answers, within `timeout` for
/// all of them together (a name with both an IPv6 and an IPv4 address, and a
/// printer that listens on one). No byte has been written, so every failure
/// here is `not_sent`.
pub fn connect(addresses: &[SocketAddr], timeout: Duration) -> Result<TcpStream, PrintFailure> {
    connect_with(addresses, timeout, TcpStream::connect_timeout)
}

/// [`connect`] with the attempt as a parameter: the addresses are tried in
/// order, each with what is left of `timeout`, and no new attempt starts once
/// it is spent (the first always does, so a zero timeout is the system's
/// refusal, not silence).
fn connect_with<T>(
    addresses: &[SocketAddr],
    timeout: Duration,
    mut attempt: impl FnMut(&SocketAddr, Duration) -> std::io::Result<T>,
) -> Result<T, PrintFailure> {
    let started = Instant::now();
    let mut last = None;
    for address in addresses {
        let left = timeout.saturating_sub(started.elapsed());
        if last.is_some() && left.is_zero() {
            break;
        }
        match attempt(address, left) {
            Ok(connected) => return Ok(connected),
            Err(error) => last = Some(error),
        }
    }
    let detail = match last {
        Some(error) => format!("connect: {error}"),
        None => "connect: no address".to_owned(),
    };
    Err(PrintFailure::new(PrintError::NotSent, detail))
}

/// Sends `bytes` to `target`, blocking. Everything up to and including
/// opening the connection, the port or the queue is `not_sent`; from the
/// first write on, a failure is `outcome_unknown`.
pub fn print_to(
    target: &PrintTarget,
    bytes: &[u8],
    timeouts: Timeouts,
) -> Result<(), PrintFailure> {
    let unknown = |call: &str, error: std::io::Error| {
        PrintFailure::new(PrintError::OutcomeUnknown, format!("{call}: {error}"))
    };
    match target {
        PrintTarget::Tcp { host, port } => {
            let addresses = resolve(host, *port)?;
            let mut stream = connect(&addresses, timeouts.connect)?;
            stream
                .set_write_timeout(Some(timeouts.write))
                .map_err(|error| {
                    PrintFailure::new(PrintError::NotSent, format!("timeout: {error}"))
                })?;
            stream
                .write_all(bytes)
                .map_err(|error| unknown("write", error))?;
            stream.flush().map_err(|error| unknown("flush", error))
        }
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(port, *baud)
                .timeout(timeouts.write)
                .open()
                .map_err(|error| {
                    PrintFailure::new(PrintError::NotSent, format!("open: {error}"))
                })?;
            handle
                .write_all(bytes)
                .map_err(|error| unknown("write", error))?;
            handle.flush().map_err(|error| unknown("flush", error))
        }
        PrintTarget::Usb { printer } => print_usb(printer, bytes),
    }
}

#[cfg(windows)]
fn print_usb(printer: &str, bytes: &[u8]) -> Result<(), PrintFailure> {
    spooler::print_raw(printer, bytes).map_err(PrintFailure::from)
}

#[cfg(not(windows))]
fn print_usb(_printer: &str, _bytes: &[u8]) -> Result<(), PrintFailure> {
    Err(PrintFailure::new(
        PrintError::Unsupported,
        "USB printing goes through the Windows spooler",
    ))
}

/// Runs the blocking send on a thread for blocking work, never on the IPC
/// thread, so a wrong printer address cannot freeze the window while the
/// system gives up. A send thread that dies, perhaps mid-write, is
/// `outcome_unknown`: nobody knows what printed.
async fn run_blocking<F>(job: F) -> Result<(), PrintFailure>
where
    F: FnOnce() -> Result<(), PrintFailure> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(outcome) => outcome,
        Err(_) => Err(PrintFailure::new(
            PrintError::OutcomeUnknown,
            "the send thread failed",
        )),
    }
}

/// Sends the label's bytes (`payloadBase64`) to `target`. The webview sends
/// one label at a time per address (plan 2a7); two sends at once to one
/// network printer are two connections, never one interleaved stream, and to
/// one COM port the second finds the port taken and is `not_sent`.
#[tauri::command]
pub async fn print_bytes(target: Value, payload_base64: String) -> Result<(), String> {
    let target = parse_target(target).map_err(|error| error.code().to_owned())?;
    let bytes = decode_payload(&payload_base64).map_err(|error| error.code().to_owned())?;
    drop(payload_base64);
    match run_blocking(move || print_to(&target, &bytes, Timeouts::default())).await {
        Ok(()) => Ok(()),
        Err(failure) => {
            eprintln!(
                "standalone: print_bytes {}: {}",
                failure.error.code(),
                failure.detail
            );
            Err(failure.error.code().to_owned())
        }
    }
}

/// One installed Windows printer queue: the spooler's queue name (stable
/// across replugging) and its port, shown for the operator's sake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinter {
    pub name: String,
    pub port: String,
}

/// Every installed queue, queues on `USB…` ports first: vendor drivers need
/// not name a USB connection that way, so none is dropped.
pub fn prioritize_installed_printers(printers: Vec<(String, String)>) -> Vec<UsbPrinter> {
    let mut printers = printers;
    printers.sort_by_key(|(_, port)| !port.to_ascii_uppercase().starts_with("USB"));
    printers
        .into_iter()
        .map(|(name, port)| UsbPrinter { name, port })
        .collect()
}

/// Lists the queues on a thread for blocking work. A spooler that does not
/// answer, or a listing thread that dies, is `spooler_unavailable`, never an
/// empty list.
async fn list_with<F>(lister: F) -> Result<Vec<UsbPrinter>, String>
where
    F: FnOnce() -> Result<Vec<(String, String)>, String> + Send + 'static,
{
    let unavailable = || PrintError::SpoolerUnavailable.code().to_owned();
    match tauri::async_runtime::spawn_blocking(lister).await {
        Ok(Ok(printers)) => Ok(prioritize_installed_printers(printers)),
        Ok(Err(detail)) => {
            eprintln!("standalone: list_usb_printers spooler_unavailable: {detail}");
            Err(unavailable())
        }
        Err(_) => {
            eprintln!(
                "standalone: list_usb_printers spooler_unavailable: the listing thread failed"
            );
            Err(unavailable())
        }
    }
}

/// The installed queues; always empty off Windows.
#[tauri::command]
pub async fn list_usb_printers() -> Result<Vec<UsbPrinter>, String> {
    list_with(installed_printers).await
}

#[cfg(windows)]
fn installed_printers() -> Result<Vec<(String, String)>, String> {
    spooler::installed_printers()
}

#[cfg(not(windows))]
fn installed_printers() -> Result<Vec<(String, String)>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::ErrorKind;
    use std::sync::mpsc;
    use std::thread;

    use super::*;
    use serde_json::json;

    /// Longer than anything below should take, short enough to fail fast.
    const DEADLINE: Duration = Duration::from_secs(10);

    /// Runs `job` on its own thread and waits at most `DEADLINE` for it, so a
    /// call that hangs fails its test instead of hanging the suite.
    fn within<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, outcome) = mpsc::channel();
        thread::spawn(move || {
            let _ = done.send(job());
        });
        outcome
            .recv_timeout(DEADLINE)
            .expect("the call ended within its deadline")
    }

    #[test]
    fn the_three_kinds_of_target_parse_as_the_webview_sends_them() {
        assert_eq!(
            parse_target(json!({ "kind": "tcp", "host": "192.168.1.50", "port": 9100 })),
            Ok(PrintTarget::Tcp {
                host: "192.168.1.50".into(),
                port: 9100
            })
        );
        assert_eq!(
            parse_target(json!({ "kind": "serial", "port": "COM3", "baud": 9600 })),
            Ok(PrintTarget::Serial {
                port: "COM3".into(),
                baud: 9600
            })
        );
        assert_eq!(
            parse_target(json!({ "kind": "usb", "printer": "Zebra ZD421" })),
            Ok(PrintTarget::Usb {
                printer: "Zebra ZD421".into()
            })
        );
    }

    #[test]
    fn an_unusable_target_is_invalid() {
        for value in [
            json!(null),
            json!("tcp"),
            json!({ "kind": "lpt", "port": "LPT1" }),
            json!({ "kind": "tcp", "host": "printer" }),
            json!({ "kind": "tcp", "host": "", "port": 9100 }),
            json!({ "kind": "tcp", "host": "two words", "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer\n", "port": 9100 }),
            json!({ "kind": "tcp", "host": "a".repeat(254), "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer", "port": 0 }),
            json!({ "kind": "tcp", "host": "printer", "port": 65536 }),
            json!({ "kind": "serial", "port": " ", "baud": 9600 }),
            json!({ "kind": "serial", "port": "COM3", "baud": 0 }),
            json!({ "kind": "serial", "port": "COM\u{0}3", "baud": 9600 }),
            json!({ "kind": "usb", "printer": "" }),
            json!({ "kind": "usb", "printer": "Zebra\tZD421" }),
        ] {
            assert_eq!(
                parse_target(value.clone()),
                Err(PrintError::InvalidTarget),
                "{value}"
            );
        }
    }

    /// One rule of `parse_target` per case, each of which the cases above do
    /// not isolate: a control character that is not whitespace, whitespace
    /// that is not a control character, a name of blanks only, the wrong type
    /// or sign or case, and a number past its width.
    #[test]
    fn every_rule_of_a_target_is_checked_on_its_own() {
        for value in [
            // Controls that are not whitespace (the whitespace rule skips them).
            json!({ "kind": "tcp", "host": "pri\u{0}nter", "port": 9100 }),
            json!({ "kind": "tcp", "host": "pri\u{1}nter", "port": 9100 }),
            json!({ "kind": "tcp", "host": "pri\u{7f}nter", "port": 9100 }),
            // Whitespace that is not a control character (the control rule skips it).
            json!({ "kind": "tcp", "host": "pri\u{a0}nter", "port": 9100 }),
            json!({ "kind": "tcp", "host": " printer", "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer ", "port": 9100 }),
            json!({ "kind": "tcp", "host": "   ", "port": 9100 }),
            json!({ "kind": "usb", "printer": "   " }),
            json!({ "kind": "usb", "printer": "Zebra\u{0}ZD421" }),
            json!({ "kind": "serial", "port": "COM\u{7f}3", "baud": 9600 }),
            // Too long, by characters.
            json!({ "kind": "usb", "printer": "я".repeat(257) }),
            json!({ "kind": "serial", "port": "C".repeat(257), "baud": 9600 }),
            // Shapes and numbers.
            json!({ "kind": "TCP", "host": "printer", "port": 9100 }),
            json!({ "host": "printer", "port": 9100 }),
            json!({ "kind": 5, "host": "printer", "port": 9100 }),
            json!({ "kind": "tcp", "host": 5, "port": 9100 }),
            json!({ "kind": "tcp", "host": "printer", "port": "9100" }),
            json!({ "kind": "tcp", "host": "printer", "port": -1 }),
            json!({ "kind": "tcp", "host": "printer", "port": 9100.5 }),
            json!({ "kind": "tcp", "host": "printer", "port": null }),
            json!({ "kind": "serial", "port": "COM3", "baud": -9600 }),
            json!({ "kind": "serial", "port": "COM3", "baud": 4294967296u64 }),
            json!({ "kind": "serial", "port": "COM3" }),
            json!({ "kind": "usb" }),
            json!({ "kind": "usb", "printer": 7 }),
            json!([]),
            json!(42),
        ] {
            assert_eq!(
                parse_target(value.clone()),
                Err(PrintError::InvalidTarget),
                "{value}"
            );
        }
    }

    /// The far edge of every bound is still a target.
    #[test]
    fn the_edges_of_every_bound_are_usable() {
        for value in [
            json!({ "kind": "tcp", "host": "a".repeat(253), "port": 1 }),
            json!({ "kind": "tcp", "host": "printer", "port": 65535 }),
            json!({ "kind": "tcp", "host": "::1", "port": 9100 }),
            json!({ "kind": "tcp", "host": "fe80::1%eth0", "port": 9100 }),
            json!({ "kind": "tcp", "host": "принтер.local", "port": 9100 }),
            json!({ "kind": "serial", "port": "C".repeat(256), "baud": 1 }),
            json!({ "kind": "serial", "port": "COM12", "baud": u32::MAX }),
            // Characters, not bytes: 256 Cyrillic letters are 512 bytes.
            json!({ "kind": "usb", "printer": "я".repeat(256) }),
            json!({ "kind": "usb", "printer": "Zebra ZD421 (копия 2)" }),
        ] {
            assert!(parse_target(value.clone()).is_ok(), "{value}");
        }
    }

    #[test]
    fn the_payload_decodes_to_the_exact_bytes() {
        // "^XA", a byte above 0x7F and the GS1 group separator survive.
        assert_eq!(
            decode_payload("XlhBpB0="),
            Ok(vec![0x5E, 0x58, 0x41, 0xA4, 0x1D])
        );
        for payload in ["", "not base64!!", "XlhB pA=="] {
            assert_eq!(
                decode_payload(payload),
                Err(PrintError::InvalidPayload),
                "{payload:?}"
            );
        }
    }

    /// What `btoa` writes decodes; whatever else a lenient decoder might
    /// take does not.
    #[test]
    fn only_canonical_standard_base64_is_a_payload() {
        // Every length of padding decodes to the exact bytes.
        assert_eq!(decode_payload("XlhB"), Ok(vec![0x5E, 0x58, 0x41]));
        assert_eq!(decode_payload("Xlg="), Ok(vec![0x5E, 0x58]));
        assert_eq!(decode_payload("Xg=="), Ok(vec![0x5E]));
        // The whole byte range: standard '+' and '/' (url-safe '-' '_' refused).
        assert_eq!(decode_payload("+/8="), Ok(vec![0xFB, 0xFF]));
        for payload in [
            "Xg",         // padding missing
            "Xlg",        // padding missing
            "Xg=",        // padding short
            "Xg===",      // padding long
            "Xh==",       // trailing bits that are not zero
            "====",       // padding only
            "=",          // padding only
            "XlhB\n",     // whitespace, even at the end
            "\nXlhB",     //
            " XlhB",      //
            "Xl\nhB",     //
            "\u{39e}g==", // not ASCII
            "Xlh\u{0}",   // a NUL
            "-_8=",       // the url-safe alphabet
            "{\"a\":1}",
            "data:text/plain;base64,XlhB",
        ] {
            assert_eq!(
                decode_payload(payload),
                Err(PrintError::InvalidPayload),
                "{payload:?}"
            );
        }
    }

    #[test]
    fn a_payload_is_bounded() {
        let encode = |len: usize| STANDARD.encode(vec![0x5Eu8; len]);
        // The largest label decodes to every byte of it.
        let largest = decode_payload(&encode(MAX_PAYLOAD_BYTES)).unwrap();
        assert_eq!(largest.len(), MAX_PAYLOAD_BYTES);
        assert!(largest.iter().all(|&byte| byte == 0x5E));
        // One byte more, and a text far past the bound, are refused.
        assert_eq!(
            decode_payload(&encode(MAX_PAYLOAD_BYTES + 1)),
            Err(PrintError::InvalidPayload)
        );
        assert_eq!(
            decode_payload(&encode(MAX_PAYLOAD_BYTES * 2)),
            Err(PrintError::InvalidPayload)
        );
        // Padding that is not base64 is refused at any length.
        assert_eq!(
            decode_payload(&"=".repeat(MAX_PAYLOAD_BYTES * 2)),
            Err(PrintError::InvalidPayload)
        );
    }

    #[test]
    fn refusals_are_bare_codes() {
        let codes: Vec<&str> = [
            PrintError::NotSent,
            PrintError::OutcomeUnknown,
            PrintError::InvalidTarget,
            PrintError::InvalidPayload,
            PrintError::Unsupported,
            PrintError::SpoolerUnavailable,
        ]
        .into_iter()
        .map(PrintError::code)
        .collect();
        assert_eq!(
            codes,
            [
                "not_sent",
                "outcome_unknown",
                "invalid_target",
                "invalid_payload",
                "unsupported",
                "spooler_unavailable"
            ]
        );
    }

    #[test]
    fn the_timeouts_are_five_seconds_each() {
        let timeouts = Timeouts::default();
        assert_eq!(timeouts.connect, Duration::from_secs(5));
        assert_eq!(timeouts.write, Duration::from_secs(5));
    }

    /// The spooler's stages map to the codes one to one, whatever the OS.
    #[test]
    fn the_spooler_stages_map_to_the_codes() {
        for (stage, code) in [
            (spooler::Stage::NotSent, PrintError::NotSent),
            (spooler::Stage::OutcomeUnknown, PrintError::OutcomeUnknown),
        ] {
            let failure = PrintFailure::from(spooler::SpoolerError {
                stage,
                detail: "OpenPrinterW: refused".into(),
            });
            assert_eq!(failure.error, code);
            assert_eq!(failure.detail, "OpenPrinterW: refused");
        }
    }

    #[test]
    fn installed_queues_keep_every_queue_with_usb_ports_first() {
        let pairs: Vec<(String, String)> = prioritize_installed_printers(vec![
            ("Zebra ZD421".into(), "USB001".into()),
            ("Office Laser".into(), "192.168.0.20".into()),
            ("TSC TE200".into(), "usb002".into()),
            ("Virtual".into(), "NOTUSB9".into()),
            ("Microsoft Print to PDF".into(), "PORTPROMPT:".into()),
        ])
        .into_iter()
        .map(|printer| (printer.name, printer.port))
        .collect();
        assert_eq!(
            pairs,
            [
                ("Zebra ZD421".to_owned(), "USB001".to_owned()),
                ("TSC TE200".to_owned(), "usb002".to_owned()),
                ("Office Laser".to_owned(), "192.168.0.20".to_owned()),
                ("Virtual".to_owned(), "NOTUSB9".to_owned()),
                (
                    "Microsoft Print to PDF".to_owned(),
                    "PORTPROMPT:".to_owned()
                ),
            ]
        );
        assert!(prioritize_installed_printers(Vec::new()).is_empty());
    }

    #[test]
    fn a_listed_queue_has_the_webview_shape() {
        let printers = prioritize_installed_printers(vec![("Zebra ZD421".into(), "USB001".into())]);
        assert_eq!(
            serde_json::to_value(&printers).unwrap(),
            json!([{ "name": "Zebra ZD421", "port": "USB001" }])
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_a_usb_queue_is_unsupported_and_none_is_installed() {
        let target = PrintTarget::Usb {
            printer: "Zebra ZD421".into(),
        };
        let failure = print_to(&target, b"^XA^XZ", Timeouts::default()).unwrap_err();
        assert_eq!(failure.error, PrintError::Unsupported);
        assert_eq!(installed_printers(), Ok(Vec::new()));
    }

    /// Each attempt gets what is left of the one timeout, and no attempt
    /// starts once it is spent: a name with many addresses cannot hold the
    /// operator for many timeouts.
    #[test]
    fn the_addresses_share_one_connect_timeout() {
        let addresses: Vec<SocketAddr> = (1..=6)
            .map(|last| SocketAddr::from(([192, 0, 2, last], 9100)))
            .collect();
        let mut given = Vec::new();
        let failure = connect_with(&addresses, Duration::from_millis(1100), |address, left| {
            given.push((*address, left));
            thread::sleep(Duration::from_millis(400));
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))
        })
        .unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("connect"), "{}", failure.detail);
        // Three attempts fit (0, 400 and 800 ms in), the fourth is past 1100 ms.
        assert_eq!(given.len(), 3, "{given:?}");
        assert_eq!(given[0].0, addresses[0]);
        assert!(given[0].1 > Duration::from_millis(1000), "{given:?}");
        assert!(given[0].1 <= Duration::from_millis(1100), "{given:?}");
        assert!(given[1].1 < Duration::from_millis(700), "{given:?}");
        assert!(given[2].1 < given[1].1, "{given:?}");
        assert!(given[2].1 > Duration::ZERO, "{given:?}");
    }

    #[test]
    fn the_first_address_is_tried_even_with_no_time() {
        let address = SocketAddr::from(([192, 0, 2, 1], 9100));
        let mut tries = 0;
        let failure = connect_with(&[address, address], Duration::ZERO, |_, left| {
            tries += 1;
            assert_eq!(left, Duration::ZERO);
            Err::<(), _>(std::io::Error::from(std::io::ErrorKind::InvalidInput))
        })
        .unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert_eq!(tries, 1);
    }

    #[test]
    fn the_first_address_that_answers_wins() {
        let addresses = [
            SocketAddr::from(([192, 0, 2, 1], 9100)),
            SocketAddr::from(([192, 0, 2, 2], 9100)),
            SocketAddr::from(([192, 0, 2, 3], 9100)),
        ];
        let mut tried = Vec::new();
        let connected = connect_with(&addresses, Duration::from_secs(5), |address, _| {
            tried.push(*address);
            if *address == addresses[1] {
                Ok(*address)
            } else {
                Err(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))
            }
        });
        assert_eq!(connected.unwrap(), addresses[1]);
        assert_eq!(tried, [addresses[0], addresses[1]]);
    }

    /// What one call of the fake writer does; once the script is spent it
    /// takes everything it is offered.
    enum Step {
        Take(usize),
        Fail(ErrorKind),
        Zero,
    }

    /// A writer that follows a script and records what it was offered.
    #[derive(Default)]
    struct Script {
        steps: VecDeque<Step>,
        accepted: Vec<u8>,
        offered: Vec<usize>,
        flush_fails: bool,
    }

    impl Script {
        fn of(steps: impl IntoIterator<Item = Step>) -> Self {
            Self {
                steps: steps.into_iter().collect(),
                ..Self::default()
            }
        }
    }

    impl Write for Script {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.offered.push(buf.len());
            match self.steps.pop_front() {
                None => {
                    self.accepted.extend_from_slice(buf);
                    Ok(buf.len())
                }
                Some(Step::Take(count)) => {
                    let count = count.min(buf.len());
                    self.accepted.extend_from_slice(&buf[..count]);
                    Ok(count)
                }
                Some(Step::Fail(kind)) => Err(kind.into()),
                Some(Step::Zero) => Ok(0),
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            if self.flush_fails {
                Err(ErrorKind::BrokenPipe.into())
            } else {
                Ok(())
            }
        }
    }

    const LABEL: &[u8] = b"^XA^FDlabel^FS^XZ";

    /// From the first write on, a failure leaves the label in doubt: TCP and
    /// COM share this, so a refactor cannot make one of them "safe to reprint".
    #[test]
    fn a_write_that_fails_at_once_is_outcome_unknown() {
        let mut writer = Script::of([Step::Fail(ErrorKind::TimedOut)]);
        let failure = send_all(&mut writer, LABEL).unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert!(failure.detail.starts_with("write"), "{}", failure.detail);
        assert!(writer.accepted.is_empty());
    }

    #[test]
    fn a_write_that_fails_after_a_partial_write_is_outcome_unknown() {
        let mut writer = Script::of([Step::Take(3), Step::Fail(ErrorKind::ConnectionReset)]);
        let failure = send_all(&mut writer, LABEL).unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert!(failure.detail.starts_with("write"), "{}", failure.detail);
        assert_eq!(writer.accepted, &LABEL[..3]);
    }

    #[test]
    fn a_writer_that_takes_no_byte_is_outcome_unknown() {
        let mut writer = Script::of([Step::Take(2), Step::Zero]);
        let failure = send_all(&mut writer, LABEL).unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert!(failure.detail.starts_with("write"), "{}", failure.detail);
        assert_eq!(writer.accepted, &LABEL[..2]);
    }

    #[test]
    fn an_interrupted_write_is_retried_not_failed() {
        let mut writer = Script::of([Step::Fail(ErrorKind::Interrupted), Step::Take(5)]);
        send_all(&mut writer, LABEL).unwrap();
        assert_eq!(writer.accepted, LABEL);
    }

    #[test]
    fn a_failing_flush_is_outcome_unknown() {
        let mut writer = Script {
            flush_fails: true,
            ..Script::default()
        };
        let failure = send_all(&mut writer, LABEL).unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert!(failure.detail.starts_with("flush"), "{}", failure.detail);
        assert_eq!(writer.accepted, LABEL);
    }

    /// Each write gets its own wait, so the writer is never offered more than
    /// one chunk at a time, and the bytes arrive in order, once.
    #[test]
    fn a_long_label_goes_out_in_chunks_in_order() {
        let label: Vec<u8> = (0..150_000u32).map(|i| (i % 251) as u8).collect();
        let mut writer = Script::default();
        send_all(&mut writer, &label).unwrap();
        assert_eq!(writer.accepted, label);
        assert_eq!(WRITE_CHUNK_BYTES, 64 * 1024);
        assert_eq!(
            writer.offered,
            [WRITE_CHUNK_BYTES, WRITE_CHUNK_BYTES, 18_928]
        );
    }

    #[test]
    fn a_failure_in_a_later_chunk_is_outcome_unknown() {
        let label = vec![0x5Eu8; 3 * WRITE_CHUNK_BYTES];
        let mut writer = Script::of([
            Step::Take(WRITE_CHUNK_BYTES),
            Step::Take(WRITE_CHUNK_BYTES),
            Step::Fail(ErrorKind::TimedOut),
        ]);
        let failure = send_all(&mut writer, &label).unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert_eq!(writer.accepted.len(), 2 * WRITE_CHUNK_BYTES);
    }

    /// An address literal needs no lookup, so it never waits for one, whatever
    /// the budget; a name does, and is `not_sent` once the budget is spent.
    #[test]
    fn an_address_literal_resolves_at_once_with_no_budget() {
        let addresses = resolve("192.0.2.7", 9100, Duration::ZERO).unwrap();
        assert_eq!(addresses, [SocketAddr::from(([192, 0, 2, 7], 9100))]);
        let addresses = resolve("::1", 9100, Duration::ZERO).unwrap();
        assert_eq!(
            addresses,
            [SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], 9100))]
        );
    }

    #[test]
    fn a_lookup_that_answers_gives_its_addresses() {
        let wanted = vec![SocketAddr::from(([192, 0, 2, 9], 9100))];
        let sent = wanted.clone();
        let found = resolve_with(Duration::from_secs(5), move || Ok(sent)).unwrap();
        assert_eq!(found, wanted);
    }

    #[test]
    fn a_lookup_that_fails_is_not_sent() {
        let failure = resolve_with(Duration::from_secs(5), || {
            Err(std::io::Error::other("no such host"))
        })
        .unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("resolve"), "{}", failure.detail);
        assert!(
            failure.detail.contains("no such host"),
            "{}",
            failure.detail
        );
    }

    #[test]
    fn a_lookup_that_dies_is_not_sent() {
        let failure =
            resolve_with(Duration::from_secs(5), || panic!("the lookup dies")).unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("resolve"), "{}", failure.detail);
    }

    /// The operating system's resolver may wait ten seconds or more for a
    /// name in an offline plant; the print does not.
    #[test]
    fn a_lookup_that_outlasts_the_budget_is_not_sent_when_the_budget_ends() {
        let started = Instant::now();
        let failure = within(|| {
            resolve_with(Duration::from_millis(200), || {
                thread::sleep(Duration::from_secs(3));
                Ok(Vec::new())
            })
        })
        .unwrap_err();
        let waited = started.elapsed();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("resolve"), "{}", failure.detail);
        assert!(
            waited >= Duration::from_millis(200) && waited < Duration::from_secs(2),
            "{waited:?}"
        );
    }

    #[test]
    fn a_name_that_resolves_to_nothing_is_not_sent() {
        // `.invalid` never resolves (RFC 2606): no network is needed.
        let target = PrintTarget::Tcp {
            host: "printer.invalid".into(),
            port: 9100,
        };
        let failure =
            within(move || print_to(&target, b"^XA^XZ", Timeouts::default())).unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("resolve"), "{}", failure.detail);
    }

    #[test]
    fn a_com_port_that_does_not_open_is_not_sent() {
        let target = PrintTarget::Serial {
            port: "/dev/markiro-no-such-port".into(),
            baud: 9600,
        };
        let failure =
            within(move || print_to(&target, b"^XA^XZ", Timeouts::default())).unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert!(failure.detail.starts_with("open"), "{}", failure.detail);
        // The words are the system's, not the port's name.
        assert!(
            !failure.detail.contains("markiro-no-such-port"),
            "{}",
            failure.detail
        );
    }

    /// The send runs on a thread for blocking work: a send that blocks does
    /// not keep the thread that awaits it from running other tasks (on the
    /// real app, the IPC thread).
    #[test]
    fn a_blocked_send_does_not_block_the_thread_that_awaits_it() {
        let blocked = Duration::from_millis(1500);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let ticks = runtime.block_on(async move {
            let send = tokio::spawn(run_blocking(move || {
                thread::sleep(blocked);
                Ok(())
            }));
            let mut ticks = 0;
            while !send.is_finished() {
                tokio::time::sleep(Duration::from_millis(50)).await;
                ticks += 1;
            }
            send.await.unwrap().unwrap();
            ticks
        });
        // A blocked runtime thread would tick once, after the sleep.
        assert!(ticks >= 5, "{ticks} ticks in {blocked:?}");
    }

    #[test]
    fn a_send_thread_that_dies_is_outcome_unknown() {
        let failure =
            tauri::async_runtime::block_on(run_blocking(|| panic!("the send thread dies")))
                .unwrap_err();
        assert_eq!(failure.error, PrintError::OutcomeUnknown);
        assert_eq!(failure.detail, "the send thread failed");
    }

    #[test]
    fn a_send_that_ends_reports_what_the_thread_returned() {
        assert!(tauri::async_runtime::block_on(run_blocking(|| Ok(()))).is_ok());
        let failure = tauri::async_runtime::block_on(run_blocking(|| {
            Err(PrintFailure::new(PrintError::NotSent, "connect: refused"))
        }))
        .unwrap_err();
        assert_eq!(failure.error, PrintError::NotSent);
        assert_eq!(failure.detail, "connect: refused");
    }

    #[test]
    fn a_spooler_that_does_not_answer_is_not_an_empty_list() {
        type Lister = fn() -> Result<Vec<(String, String)>, String>;
        let run = |lister: Lister| tauri::async_runtime::block_on(list_with(lister));
        assert_eq!(
            run(|| Err("EnumPrintersW: the RPC server is unavailable".into())),
            Err("spooler_unavailable".to_owned())
        );
        assert_eq!(
            run(|| panic!("the listing thread dies")),
            Err("spooler_unavailable".to_owned())
        );
        assert_eq!(run(|| Ok(Vec::new())), Ok(Vec::new()));
        let listed = run(|| {
            Ok(vec![
                ("Office Laser".into(), "192.168.0.20".into()),
                ("Zebra ZD421".into(), "USB001".into()),
            ])
        })
        .unwrap();
        assert_eq!(
            listed.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(),
            ["Zebra ZD421", "Office Laser"]
        );
    }
}
