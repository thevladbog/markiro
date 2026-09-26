//! Wire contract between the Markiro standalone host (`markiro-host`) and the
//! devices that talk to it. Every request and response shape has a JSON
//! fixture in `fixtures/`: `tests/fixtures.rs` round-trips them here and
//! `apps/standalone/test/protocol.test.ts` parses the same files with the Zod
//! schemas, so a shape cannot change on one side only.
//!
//! Response types, which devices of different versions read, tolerate
//! unknown fields; request types, which the host parses, reject them with
//! `deny_unknown_fields`. The `product`, `protocol` and `minProtocol` fields
//! of [`Hello`] never change shape: clients read [`HelloEnvelope`] first and
//! decide [`compatibility`] before parsing the rest.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
pub const PROTOCOL_HEADER: &str = "x-markiro-protocol";
/// Request header carrying the office session token.
pub const OFFICE_SESSION_HEADER: &str = "x-office-session";
/// `product` value the host reports in [`Hello`].
pub const HOST_PRODUCT: &str = "markiro-host";
/// Default TCP port of the host (IANA-unassigned range 45679-45823).
pub const DEFAULT_PORT: u16 = 45710;

/// Stable error codes of [`ErrorDetail::code`]; clients show text by code.
pub mod codes {
    pub const NOT_FOUND: &str = "not_found";
    pub const METHOD_NOT_ALLOWED: &str = "method_not_allowed";
    pub const PROTOCOL_UNSUPPORTED: &str = "protocol_unsupported";
    pub const VALIDATION_FAILED: &str = "validation_failed";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    pub const STALE_REVISION: &str = "stale_revision";
    pub const CONFLICT: &str = "conflict";
    pub const LAST_ADMIN: &str = "last_admin";
    pub const SSCC_BELOW_FLOOR: &str = "sscc_below_floor";
    pub const ALREADY_INITIALIZED: &str = "already_initialized";
    pub const LOOPBACK_ONLY: &str = "loopback_only";
    pub const RATE_LIMITED: &str = "rate_limited";
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
#[serde(rename_all = "camelCase")]
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

/// The part of `hello` that keeps its shape in every protocol version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloEnvelope {
    pub product: String,
    pub protocol: u32,
    pub min_protocol: u32,
}

/// Whether this build can talk to a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compatibility {
    Compatible,
    /// The host is older than this app: update the host.
    HostTooOld,
    /// This app is older than the host accepts: update the app.
    AppTooOld,
}

/// Compatibility of a client speaking `client_protocol` with a host that
/// accepts clients from `min_protocol` up to `protocol`.
pub fn compatibility_for(client_protocol: u32, host: &HelloEnvelope) -> Compatibility {
    if client_protocol > host.protocol {
        Compatibility::HostTooOld
    } else if client_protocol < host.min_protocol {
        Compatibility::AppTooOld
    } else {
        Compatibility::Compatible
    }
}

/// [`compatibility_for`] with this build's [`PROTOCOL_VERSION`].
pub fn compatibility(host: &HelloEnvelope) -> Compatibility {
    compatibility_for(PROTOCOL_VERSION, host)
}

/// Fingerprint for visual comparison with another screen: the first 32 hex
/// characters, upper-cased, in eight groups of four (as the webview's
/// `formatFingerprint`).
pub fn display_fingerprint(hex: &str) -> String {
    let head: Vec<char> = hex
        .chars()
        .take(32)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    head.chunks(4)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Body of every non-2xx response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    /// One of [`codes`].
    pub code: String,
    /// Diagnostic text for logs; never shown to a person.
    pub message: String,
    /// Structured detail; always a JSON object when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
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

/// Kind of a paired device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    Station,
    Office,
    Handheld,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Station => "station",
            DeviceKind::Office => "office",
            DeviceKind::Handheld => "handheld",
        }
    }
}

/// `POST /v1/local-pair`: a device on the host's own computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalPairRequest {
    pub kind: DeviceKind,
    pub name: String,
    pub app_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// Response of `local-pair` (and, from plan 1c, `pairing/claim`). The device
/// key is shown exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_key: String,
    pub host_id: String,
}

/// `GET /v1/device`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub paired_at: String,
}

/// Role of an office user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OfficeRole {
    Admin,
    Technologist,
}

impl OfficeRole {
    pub fn as_str(self) -> &'static str {
        match self {
            OfficeRole::Admin => "admin",
            OfficeRole::Technologist => "technologist",
        }
    }
}

/// `POST /v1/office/login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeLoginRequest {
    pub login: String,
    pub password: String,
}

/// The signed-in office user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUser {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
}

/// A new office session; the token is shown exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSession {
    pub token: String,
    pub user: OfficeUser,
    /// Absolute expiry; the session also ends after 30 idle minutes.
    pub expires_at: String,
}

/// A new office user created by the first-run wizard (always an administrator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewOfficeUser {
    pub login: String,
    pub name: String,
    pub password: String,
}

/// Organization fields as entered in the wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgProfileInput {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

/// First serials of the SSCC counters; needed when the company already
/// printed SSCC with other software.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccStart {
    pub box_next_serial: u64,
    pub pallet_next_serial: u64,
}

/// `POST /v1/bootstrap`: the first-run wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BootstrapRequest {
    pub admin: NewOfficeUser,
    pub org: OrgProfileInput,
    pub sscc: SsccStart,
    /// Names of the first production lines (1-20).
    pub lines: Vec<String>,
}

/// Response of `POST /v1/bootstrap`: the administrator is signed in on the
/// device that ran the wizard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapResponse {
    pub session: OfficeSession,
}

/// `GET /v1/office/org`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgProfile {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
    pub rev: i64,
}

/// `PUT /v1/office/org`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgProfileUpdate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
    pub expected_rev: i64,
}

/// One SSCC counter (`GET /v1/office/sscc`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccCounter {
    pub issuer_prefix: String,
    /// 0 = box, 1 = pallet.
    pub extension: u8,
    pub next_serial: u64,
    pub max_serial: u64,
    pub rev: i64,
}

/// `GET /v1/office/sscc`: counters and the device block sizes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccState {
    pub counters: Vec<SsccCounter>,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    /// Revision of the block sizes (site settings).
    pub rev: i64,
}

/// `PUT /v1/office/sscc/counters/{prefix}/{extension}`: move a counter forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccCounterUpdate {
    pub next_serial: u64,
    pub expected_rev: i64,
}

/// `PUT /v1/office/sscc/block-sizes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlockSizesUpdate {
    pub box_block_size: u32,
    pub pallet_block_size: u32,
    pub expected_rev: i64,
}

/// An office user as the administrator sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeUserRecord {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
    pub active: bool,
    pub created_at: String,
    pub rev: i64,
}

/// `POST /v1/office/users`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeUserCreate {
    pub login: String,
    pub name: String,
    pub role: OfficeRole,
    pub password: String,
}

/// `PUT /v1/office/users/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeUserUpdate {
    pub name: String,
    pub role: OfficeRole,
    pub active: bool,
    pub expected_rev: i64,
}

/// `PUT /v1/office/users/{id}/password`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordSet {
    pub password: String,
}
