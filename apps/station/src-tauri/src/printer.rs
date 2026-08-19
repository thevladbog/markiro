use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// How long to wait for the TCP handshake before giving up — matches the
/// existing write timeout below. Without this, `TcpStream::connect` blocks
/// for the OS's full connect timeout (which can be far longer than 5s) on a
/// mistyped or unreachable printer address, freezing the command (and, since
/// it used to be a synchronous Tauri command, the whole UI) for that long.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Where the label bytes go. Industrial ZPL/TSPL printers accept raw payloads
/// over a serial port or TCP 9100; USB printers go through the Windows print
/// spooler (`spooler::print_raw`) and are Windows-only.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrintTarget {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
    Usb { printer: String },
}

/// Tauri's IPC is JSON, so the label bytes arrive base64-encoded — that is
/// where plan 04's latin1 string carrier for TSPL's binary BITMAP ends.
pub fn decode_payload(payload_base64: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(payload_base64).map_err(|e| e.to_string())
}

/// One installed Windows printer queue bound to a USB port. Identified by the
/// spooler queue name (stable across replugging), not the `USBnnn` port.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPrinter {
    pub name: String,
    pub port: String,
}

/// Keeps only queues whose port says USB (`USB001`, ...). Pure so it is
/// testable on every OS; the Win32 enumeration behind it is not. Outside
/// `cfg(test)`, only the `cfg(windows)` branch of `list_usb_printers` calls
/// this, so non-Windows release builds would otherwise warn it dead.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn filter_usb_printers(printers: Vec<(String, String)>) -> Vec<UsbPrinter> {
    printers
        .into_iter()
        .filter(|(_, port)| port.to_ascii_uppercase().starts_with("USB"))
        .map(|(name, port)| UsbPrinter { name, port })
        .collect()
}

/// `async` + `spawn_blocking` for the same reason as `print_bytes`: the
/// spooler RPC is blocking and must not stall the IPC thread.
#[tauri::command]
pub async fn list_usb_printers() -> Result<Vec<UsbPrinter>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<UsbPrinter>, String> {
        #[cfg(windows)]
        {
            Ok(filter_usb_printers(spooler::enumerate_local_printers()?))
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Windows print-spooler access: enumeration and RAW printing. Everything
/// unsafe stays inside this module.
#[cfg(windows)]
mod spooler {
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, EnumPrintersW, OpenPrinterW,
        StartDocPrinterW, StartPagePrinter, WritePrinter, DOC_INFO_1W, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_2W,
    };

    pub(super) fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn from_wide(ptr: *const u16) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }

    pub(super) fn last_error(call: &str) -> String {
        format!("{call} failed: {}", std::io::Error::last_os_error())
    }

    /// Local queues as (queue name, port name) pairs. The first
    /// `EnumPrintersW` call intentionally measures the needed buffer size.
    pub fn enumerate_local_printers() -> Result<Vec<(String, String)>, String> {
        unsafe {
            let mut needed = 0u32;
            let mut returned = 0u32;
            let first_call_ok = EnumPrintersW(
                PRINTER_ENUM_LOCAL,
                std::ptr::null(),
                2,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut returned,
            ) != 0;
            if !first_call_ok {
                // ERROR_INSUFFICIENT_BUFFER (122) is the expected failure mode
                // of this sizing idiom: `needed` now holds the real buffer
                // size and we fall through to the real call below. Any other
                // failure (e.g. the Print Spooler service being stopped,
                // RPC_S_SERVER_UNAVAILABLE) must not be reported as "no
                // printers found" -- that sends an operator chasing a USB
                // cable for a service outage instead of restarting the
                // spooler.
                const ERROR_INSUFFICIENT_BUFFER: i32 = 122;
                if std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER)
                {
                    return Err(last_error("EnumPrintersW"));
                }
            }
            if needed == 0 {
                return Ok(Vec::new());
            }
            let mut buffer = vec![0u8; needed as usize];
            if EnumPrintersW(
                PRINTER_ENUM_LOCAL,
                std::ptr::null(),
                2,
                buffer.as_mut_ptr(),
                needed,
                &mut needed,
                &mut returned,
            ) == 0
            {
                return Err(last_error("EnumPrintersW"));
            }
            let infos = std::slice::from_raw_parts(
                buffer.as_ptr() as *const PRINTER_INFO_2W,
                returned as usize,
            );
            Ok(infos
                .iter()
                .map(|info| (from_wide(info.pPrinterName), from_wide(info.pPortName)))
                .collect())
        }
    }

    /// Sends raw ZPL/TSPL bytes through the spooler with datatype RAW, so the
    /// driver renders nothing and the printer firmware interprets its native
    /// language. Handles are closed on every path.
    pub fn print_raw(printer: &str, bytes: &[u8]) -> Result<(), String> {
        let printer_w = wide(printer);
        let doc_name = wide("Markiro label");
        let datatype = wide("RAW");
        unsafe {
            let mut handle = PRINTER_HANDLE::default();
            if OpenPrinterW(printer_w.as_ptr(), &mut handle, std::ptr::null_mut()) == 0 {
                return Err(format!(
                    "printer \"{printer}\": {}",
                    last_error("OpenPrinterW")
                ));
            }
            let result = print_document(handle, printer, &doc_name, &datatype, bytes);
            ClosePrinter(handle);
            result
        }
    }

    unsafe fn print_document(
        handle: PRINTER_HANDLE,
        printer: &str,
        doc_name: &[u16],
        datatype: &[u16],
        bytes: &[u8],
    ) -> Result<(), String> {
        let doc = DOC_INFO_1W {
            pDocName: doc_name.as_ptr() as *mut u16,
            pOutputFile: std::ptr::null_mut(),
            pDatatype: datatype.as_ptr() as *mut u16,
        };
        if StartDocPrinterW(handle, 1, &doc) == 0 {
            return Err(format!(
                "printer \"{printer}\": {}",
                last_error("StartDocPrinterW")
            ));
        }
        let page_result = (|| {
            if StartPagePrinter(handle) == 0 {
                return Err(format!(
                    "printer \"{printer}\": {}",
                    last_error("StartPagePrinter")
                ));
            }
            let mut written = 0u32;
            let write_ok = WritePrinter(
                handle,
                bytes.as_ptr() as *const core::ffi::c_void,
                bytes.len() as u32,
                &mut written,
            );
            let write_err = (write_ok == 0 || written != bytes.len() as u32)
                .then(|| format!("printer \"{printer}\": {}", last_error("WritePrinter")));
            EndPagePrinter(handle);
            write_err.map_or(Ok(()), Err)
        })();
        EndDocPrinter(handle);
        page_result
    }
}

/// Resolves `host:port` to a single socket address, failing with a clear
/// message when the host does not resolve to any address at all — instead of
/// letting `TcpStream::connect` discover that the slow way after hanging on
/// the OS connect timeout.
fn resolve_socket_addr(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve printer host \"{host}\": {e}"))?
        .next()
        .ok_or_else(|| format!("printer host \"{host}\" did not resolve to any address"))
}

/// Synchronous dispatch to one transport. Split out of `print_bytes` so the
/// non-Windows USB error is unit-testable without the Tauri runtime.
fn print_to_target(target: PrintTarget, bytes: &[u8]) -> Result<(), String> {
    match target {
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(&port, baud)
                .timeout(Duration::from_secs(5))
                .open()
                .map_err(|e| e.to_string())?;
            handle.write_all(bytes).map_err(|e| e.to_string())?;
            handle.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Tcp { host, port } => {
            let addr = resolve_socket_addr(&host, port)?;
            let mut stream =
                TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            stream.write_all(bytes).map_err(|e| e.to_string())?;
            stream.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Usb { printer } => {
            #[cfg(windows)]
            {
                spooler::print_raw(&printer, bytes)
            }
            #[cfg(not(windows))]
            {
                let _ = printer;
                Err("USB printing is only available on Windows".to_string())
            }
        }
    }
}

/// `async` so the Tauri IPC layer runs this off the UI thread: `print_bytes`
/// does blocking I/O (serial, TCP, and the USB spooler), and a mistyped
/// printer address — exactly what the setup screen's test print exists to
/// catch — must not freeze the whole station while the OS gives up on the
/// connection.
///
/// Being an `async fn` alone is not enough: `print_to_target` still does
/// blocking serial open/write/flush, blocking DNS resolution
/// (`to_socket_addrs`), and blocking spooler RPCs, which would run straight
/// on whichever async worker thread Tauri picked for this command and starve
/// every other async task scheduled on it for as long as the OS takes.
/// `spawn_blocking` moves the entire dispatch onto a thread dedicated to
/// blocking work, and this command just awaits the result.
#[tauri::command]
pub async fn print_bytes(target: PrintTarget, payload_base64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_base64)?;
    tauri::async_runtime::spawn_blocking(move || print_to_target(target, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{decode_payload, resolve_socket_addr};

    #[test]
    fn decodes_base64_into_exact_bytes() {
        // "^XA" plus a byte above 0x7F, which must survive intact.
        let encoded = "XlhBpA==";
        assert_eq!(decode_payload(encoded).unwrap(), vec![0x5E, 0x58, 0x41, 0xA4]);
    }

    #[test]
    fn resolve_socket_addr_parses_an_ip_literal_without_any_dns_lookup() {
        let addr = resolve_socket_addr("127.0.0.1", 9100).unwrap();
        assert_eq!(addr.to_string(), "127.0.0.1:9100");
    }

    #[test]
    fn resolve_socket_addr_reports_a_clear_error_when_the_host_does_not_resolve() {
        // ".invalid" is reserved by RFC 2606 to never resolve to anything, on
        // any resolver, so this is deterministic without live network access
        // (verified in this sandbox: it fails in well under a second, purely
        // from the OS resolver rejecting the reserved TLD — no real query).
        let err = resolve_socket_addr("this-host-should-not-exist.invalid", 9100).unwrap_err();
        assert!(
            err.contains("this-host-should-not-exist.invalid"),
            "error should name the offending host: {err}"
        );
    }

    #[test]
    fn rejects_malformed_base64() {
        assert!(decode_payload("not base64!!").is_err());
    }

    #[test]
    fn decodes_an_empty_payload_to_no_bytes() {
        assert_eq!(decode_payload("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn filter_usb_printers_keeps_only_usb_ports_case_insensitively() {
        let filtered = super::filter_usb_printers(vec![
            ("Zebra ZD421".to_string(), "USB001".to_string()),
            ("Office Laser".to_string(), "192.168.0.20".to_string()),
            ("TSC TE200".to_string(), "usb002".to_string()),
            ("Microsoft Print to PDF".to_string(), "PORTPROMPT:".to_string()),
        ]);
        let pairs: Vec<(String, String)> =
            filtered.into_iter().map(|p| (p.name, p.port)).collect();
        assert_eq!(
            pairs,
            vec![
                ("Zebra ZD421".to_string(), "USB001".to_string()),
                ("TSC TE200".to_string(), "usb002".to_string()),
            ]
        );
    }

    #[test]
    fn filter_usb_printers_returns_empty_for_no_printers() {
        assert!(super::filter_usb_printers(Vec::new()).is_empty());
    }

    #[test]
    fn deserializes_a_usb_print_target() {
        let target: super::PrintTarget =
            serde_json::from_str(r#"{"kind":"usb","printer":"Zebra ZD421"}"#).unwrap();
        match target {
            super::PrintTarget::Usb { printer } => assert_eq!(printer, "Zebra ZD421"),
            _ => panic!("expected the usb variant"),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn usb_printing_reports_windows_only_off_windows() {
        let err = super::print_to_target(
            super::PrintTarget::Usb {
                printer: "Zebra ZD421".to_string(),
            },
            b"^XA^XZ",
        )
        .unwrap_err();
        assert!(err.contains("Windows"), "error should say Windows-only: {err}");
    }
}
