//! Wire contract between the Markiro standalone host (`markiro-host`) and the
//! devices that talk to it. Every request and response shape has a JSON
//! fixture in `fixtures/`: `tests/fixtures.rs` round-trips them here and
//! `apps/standalone/test/protocol.test.ts` parses the same files with the Zod
//! schemas, so a shape cannot change on one side only.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
pub const PROTOCOL_HEADER: &str = "x-markiro-protocol";
/// `product` value the host reports in [`Hello`].
pub const HOST_PRODUCT: &str = "markiro-host";
/// Default TCP port of the host (IANA-unassigned range 45679-45823).
pub const DEFAULT_PORT: u16 = 45710;

/// Stable error codes of [`ErrorDetail::code`]; clients show text by code.
pub mod codes {
    pub const NOT_FOUND: &str = "not_found";
    pub const PROTOCOL_UNSUPPORTED: &str = "protocol_unsupported";
    pub const INTERNAL: &str = "internal";
}

/// Lower-case hex SHA-256 of a certificate's DER: the value devices pin and
/// the pairing payload carries.
pub fn certificate_fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `GET /v1/hello`: who answers, which protocol range it understands, and
/// whether the first-run wizard has completed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub product: String,
    pub protocol: u32,
    pub min_protocol: u32,
    pub host_id: String,
    pub version: String,
    /// Host clock, UTC RFC 3339.
    pub time: String,
    pub initialized: bool,
}

/// Body of every non-2xx response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorDetail {
    /// One of [`codes`].
    pub code: String,
    /// Diagnostic text for logs; never shown to a person.
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ErrorBody {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            error: ErrorDetail {
                code: code.to_owned(),
                message: message.into(),
                details: None,
            },
        }
    }
}
