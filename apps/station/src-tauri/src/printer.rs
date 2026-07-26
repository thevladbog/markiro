use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Deserialize;

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

#[tauri::command]
pub fn print_bytes(target: PrintTarget, payload_base64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_base64)?;
    match target {
        PrintTarget::Serial { port, baud } => {
            let mut handle = serialport::new(&port, baud)
                .timeout(Duration::from_secs(5))
                .open()
                .map_err(|e| e.to_string())?;
            handle.write_all(&bytes).map_err(|e| e.to_string())?;
            handle.flush().map_err(|e| e.to_string())
        }
        PrintTarget::Tcp { host, port } => {
            let mut stream =
                TcpStream::connect((host.as_str(), port)).map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|e| e.to_string())?;
            stream.write_all(&bytes).map_err(|e| e.to_string())?;
            stream.flush().map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::decode_payload;

    #[test]
    fn decodes_base64_into_exact_bytes() {
        // "^XA" plus a byte above 0x7F, which must survive intact.
        let encoded = "XlhBpA==";
        assert_eq!(decode_payload(encoded).unwrap(), vec![0x5E, 0x58, 0x41, 0xA4]);
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
