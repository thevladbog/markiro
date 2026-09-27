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
    pub const PAIRING_CODE_INVALID: &str = "pairing_code_invalid";
    pub const PAIRING_CODE_EXPIRED: &str = "pairing_code_expired";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
        NOT_FOUND,
        METHOD_NOT_ALLOWED,
        PROTOCOL_UNSUPPORTED,
        VALIDATION_FAILED,
        UNAUTHORIZED,
        FORBIDDEN,
        STALE_REVISION,
        CONFLICT,
        LAST_ADMIN,
        SSCC_BELOW_FLOOR,
        ALREADY_INITIALIZED,
        LOOPBACK_ONLY,
        RATE_LIMITED,
        INTERNAL,
        PAIRING_CODE_INVALID,
        PAIRING_CODE_EXPIRED,
    ];
}

/// Values of an `unauthorized` error's `details.credential`: which credential
/// the request failed on, so the client can tell "re-pair this device" from
/// "sign in again" from "wrong password" (spec §4.6).
pub mod credentials {
    pub const DEVICE: &str = "device";
    pub const SESSION: &str = "session";
    pub const PASSWORD: &str = "password";
}

pub mod pairing;

/// Serde for a field of a partial update that may be absent (keep the stored
/// value), `null` (clear it) or a value (set it): an `Option<Option<T>>` with
/// `#[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]`.
/// Plain serde reads `null` as an absent field.
pub mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
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

/// A secret on the wire: a device key, a session token or a password. It
/// serializes as a plain JSON string, but `Debug` never prints the value, so
/// a stray `{:?}` or a `tracing` field cannot leak it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret itself; call only where the value is actually needed.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(***)")
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

/// `POST /v1/pairing/claim`: a device in the local network pairs with a
/// one-time code from the office.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimRequest {
    pub code: Secret,
    pub kind: DeviceKind,
    pub name: String,
    pub app_version: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// Response of `local-pair` and `pairing/claim`. The device key is shown
/// exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub device_id: String,
    pub device_key: Secret,
    pub host_id: String,
}

/// `POST /v1/office/pairing-codes`: a one-time code for pairing another
/// device. The code and the payload carrying it are shown once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    /// 10 Crockford base32 characters.
    pub code: Secret,
    pub expires_at: String,
    /// `markiro-host:1?h=<addresses>&p=<port>&f=<fingerprint>&c=<code>`.
    pub payload: Secret,
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

/// `PUT /v1/device/line`: a station chooses the line it works on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceLineRequest {
    pub line_id: String,
}

/// A paired device as the administrator sees it (`GET /v1/office/devices`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub app_version: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// Entities of the change feed (spec §4.4). Plan 1e adds products,
/// templates and template defaults.
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
    pub const OPERATORS: &str = "operators";
    pub const OPERATOR_BADGES: &str = "operator_badges";
}

/// `GET /v1/changes`: reference records changed after `since`, oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    /// A device paired with another host stops syncing on a mismatch.
    pub host_id: String,
    /// Apply `items`, remember this revision, and ask again with `since = rev`
    /// while `has_more`. Without more items it is the host's current revision.
    pub rev: i64,
    pub has_more: bool,
    pub items: Vec<ChangeItem>,
}

/// One changed or deleted reference record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    /// One of [`entities`].
    pub entity: String,
    pub id: String,
    pub rev: i64,
    pub deleted: bool,
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`],
    /// [`OperatorRecord`], [`OperatorBadgeRecord`]); absent when `deleted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// `data` of an `org_profile` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgRecord {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

/// `data` of a `site` item: only what stations use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    /// The site's badge salt: 16 bytes, standard base64 with padding.
    pub badge_salt: String,
    pub box_block_size: u32,
    pub pallet_block_size: u32,
}

/// `data` of a `lines` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRecord {
    pub name: String,
    pub archived: bool,
}

/// `data` of an `operators` item. Only an active operator is in the feed: a
/// deactivation arrives as a tombstone, never as a flag (spec §4.4), and a
/// PIN change as a record with the new hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorRecord {
    /// Personnel number: 3-12 digits, typed on the station keypad.
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    /// PBKDF2 PHC string of the PIN (`@markiro/domain`).
    pub pin_phc: Secret,
}

/// `data` of an `operator_badges` item. Only a badge that is not revoked is
/// in the feed: a revocation arrives as a tombstone. A badge grants nothing
/// by itself: a station signs in with it only while the record of its
/// operator is there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorBadgeRecord {
    pub operator_id: String,
    /// PBKDF2 PHC string of the badge code, with the site's badge salt.
    pub badge_phc: Secret,
    pub label: Option<String>,
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
    pub password: Secret,
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
    pub token: Secret,
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
    pub password: Secret,
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
    /// The issuer prefix derived from the organization's current GLN
    /// (`validate::issuer_prefix`), so the UI never re-derives the rule.
    pub current_issuer_prefix: String,
    /// Revision of the block sizes (site settings), not of the whole state.
    pub block_sizes_rev: i64,
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
    pub password: Secret,
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
    pub password: Secret,
}

/// `PUT /v1/office/me/password`: a signed-in office user changes their own password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordChange {
    pub current_password: Secret,
    pub new_password: Secret,
}

/// A counterparty (`GET /v1/office/counterparties`): a customer of contract
/// manufacturing. Archived instead of deleted; not in the station feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CounterpartyRecord {
    pub id: String,
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub rev: i64,
}

/// `POST /v1/office/counterparties`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterpartyCreate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

/// `PUT /v1/office/counterparties/{id}`: every field, like the organization
/// profile; `archived: true` archives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CounterpartyUpdate {
    pub name: String,
    #[serde(default)]
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A production line as the office sees it (`GET /v1/office/lines`,
/// archived lines included).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLine {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub rev: i64,
}

/// `POST /v1/office/lines`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineCreate {
    pub name: String,
}

/// `PUT /v1/office/lines/{id}`: only the fields sent change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    pub expected_rev: i64,
}

/// A badge as the administrator sees it: never its hash. Revoked badges are
/// listed too, with `revoked_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeInfo {
    pub id: String,
    pub label: Option<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

/// An operator as the administrator sees it (`GET /v1/office/operators`):
/// never a hash, only whether a PIN is set and the badges' metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeOperator {
    pub id: String,
    /// Personnel number: 3-12 digits; it never changes.
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub active: bool,
    pub has_pin: bool,
    pub badges: Vec<BadgeInfo>,
    pub rev: i64,
}

/// `POST /v1/office/operators`: the office computed `pin_phc` from the PIN
/// with `@markiro/domain`; the host never sees the PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorCreate {
    pub login: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub pin_phc: Secret,
}

/// `PUT /v1/office/operators/{id}`: only the fields sent change; `role:
/// null` clears the role, and a new `pin_phc` replaces the PIN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub role: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_phc: Option<Secret>,
    pub expected_rev: i64,
}
