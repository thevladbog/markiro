use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;

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
}
