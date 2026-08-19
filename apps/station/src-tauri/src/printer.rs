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
/// over a serial port or TCP 9100; USB/spooler printing is platform-specific
/// and is on the hardware acceptance checklist instead.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrintTarget {
    Serial { port: String, baud: u32 },
    Tcp { host: String, port: u16 },
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

/// Windows print-spooler access: enumeration here, RAW printing added by the
/// next task. Everything unsafe stays inside this module.
#[cfg(windows)]
mod spooler {
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W,
    };

    /// Unused by enumeration; kept for the RAW-printing task that follows
    /// this one, which needs it to call `OpenPrinterW`/`StartDocPrinterW`.
    #[allow(dead_code)]
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
            EnumPrintersW(
                PRINTER_ENUM_LOCAL,
                std::ptr::null(),
                2,
                std::ptr::null_mut(),
                0,
                &mut needed,
                &mut returned,
            );
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

/// `async` so the Tauri IPC layer runs this off the UI thread: `print_bytes`
/// does blocking I/O (serial and TCP), and a mistyped printer address —
/// exactly what the setup screen's test print exists to catch — must not
/// freeze the whole station while the OS gives up on the connection.
///
/// Being an `async fn` alone is not enough: the body below still does
/// blocking serial open/write/flush and blocking DNS resolution
/// (`to_socket_addrs`), which would run straight on whichever async worker
/// thread Tauri picked for this command and starve every other async task
/// scheduled on it for as long as the OS takes. `spawn_blocking` moves the
/// entire match onto a thread dedicated to blocking work, and this command
/// just awaits the result.
#[tauri::command]
pub async fn print_bytes(target: PrintTarget, payload_base64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_base64)?;
    let result = tauri::async_runtime::spawn_blocking(move || match target {
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(&port, baud)
                .timeout(Duration::from_secs(5))
                .open()
                .map_err(|e| e.to_string())?;
            handle.write_all(&bytes).map_err(|e| e.to_string())?;
            handle.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Tcp { host, port } => {
            let addr = resolve_socket_addr(&host, port)?;
            let mut stream =
                TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            stream.write_all(&bytes).map_err(|e| e.to_string())?;
            stream.flush().map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    result
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
}
