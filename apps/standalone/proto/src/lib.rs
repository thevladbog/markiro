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

/// Protocol version this build speaks: 6 since plan ТСД (handhelds on the
/// host): the channel `POST /v1/device/pallet-events`, `GET
/// /v1/device/box-registry`, `GET /v1/device/org/print`, `recoverDeviceId` of
/// a claim and the capability `handheld-host-v1`; a handheld of protocol 6
/// against a host of 5 is `host_too_old`. 5 came with part B of plan РЕЖ (the
/// duplicate print of a validation shift: its [`ValidationPrint`] policy, the
/// snapshot's [`SnapshotValidationPrint`] and the `unit_label` fact,
/// [`UnitLabelFact`]); 4 came with part A (the shift modes: the body of a
/// shift entry naming what the station works, [`ShiftEnter`], and a
/// validation shift's `ok` scan without a box); 3 came with plan ПЛ-Х
/// (pallets: the shift's pallet fields, pallet blocks, the pallet facts and a
/// box's `palletId`). A new fact kind, a new field of a fact's `data` or a
/// new meaning of one raises it, because an older host refuses such a record
/// for good.
pub const PROTOCOL_VERSION: u32 = 6;
/// Oldest protocol version this build still accepts from a client.
pub const MIN_PROTOCOL_VERSION: u32 = 1;
/// Request header carrying the client's protocol version.
pub const PROTOCOL_HEADER: &str = "x-markiro-protocol";
pub const DATASET_EPOCH_HEADER: &str = "x-markiro-dataset-epoch";
/// Request header carrying the office session token.
pub const OFFICE_SESSION_HEADER: &str = "x-office-session";
/// Request header carrying the app's own version on every request of the
/// shell (plan ОБН-1): the host records it on the device
/// (`devices.app_version`, spec §10.11.7). A host before it ignores it.
pub const APP_VERSION_HEADER: &str = "x-markiro-app-version";
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
    /// The SSCC counter of a prefix reached the end of its serials: no block
    /// of it can be issued any more.
    pub const SSCC_EXHAUSTED: &str = "sscc_exhausted";
    /// The host was restored from a copy and holds the stations' facts (and
    /// code checks) until an administrator resumes them (plan РК): a station
    /// sends them again later, as after a lost connection.
    pub const RESTORE_PENDING: &str = "restore_pending";
    /// The host's store of generated files is full (host migration `0029`);
    /// a retention setting or a smaller export makes room.
    pub const EXPORT_STORE_FULL: &str = "export_store_full";
    /// A generated file is larger than the host stores.
    pub const EXPORT_FILE_TOO_LARGE: &str = "export_file_too_large";
    /// A stored file no longer matches the SHA-256 it was stored with: the
    /// host serves nothing of it.
    pub const EXPORT_FILE_CORRUPTED: &str = "export_file_corrupted";
    /// The host checks its update package again after its files changed
    /// (plan ОБН-3): `503` with `Retry-After`, ask again in a moment.
    pub const PACKAGE_VERIFYING: &str = "package_verifying";
    /// Three devices download the update from the host already (plan
    /// ОБН-3): `503` with `Retry-After: 30`.
    pub const UPDATE_BUSY: &str = "update_busy";
    /// An office user's photo (plan АВА): larger than 2 MiB. `413`.
    pub const AVATAR_TOO_LARGE: &str = "avatar_too_large";
    /// Not a JPEG, PNG or WebP by its first bytes, or an animated one. `415`.
    pub const AVATAR_UNSUPPORTED_TYPE: &str = "avatar_unsupported_type";
    /// A side under 128 dots. `422`.
    pub const AVATAR_TOO_SMALL: &str = "avatar_too_small";
    /// A side over 4096 dots (the header is read, nothing decoded). `422`.
    pub const AVATAR_DIMENSIONS_TOO_LARGE: &str = "avatar_dimensions_too_large";
    /// The picture is not square: the office crops before it uploads. `422`.
    pub const AVATAR_NOT_SQUARE: &str = "avatar_not_square";
    /// The signature is a picture's but its header is cut or inconsistent. `422`.
    pub const AVATAR_CORRUPT: &str = "avatar_corrupt";
    /// The user has no photo (the raw image route). `404`.
    pub const AVATAR_NOT_FOUND: &str = "avatar_not_found";
    /// Another user's photo is replaced: only its owner sets one. `403`.
    pub const FORBIDDEN_REPLACE_OTHER: &str = "forbidden_replace_other";

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
        SSCC_EXHAUSTED,
        RESTORE_PENDING,
        EXPORT_STORE_FULL,
        EXPORT_FILE_TOO_LARGE,
        EXPORT_FILE_CORRUPTED,
        PACKAGE_VERIFYING,
        UPDATE_BUSY,
        AVATAR_TOO_LARGE,
        AVATAR_UNSUPPORTED_TYPE,
        AVATAR_TOO_SMALL,
        AVATAR_DIMENSIONS_TOO_LARGE,
        AVATAR_NOT_SQUARE,
        AVATAR_CORRUPT,
        AVATAR_NOT_FOUND,
        FORBIDDEN_REPLACE_OTHER,
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

/// Codes of a `rejected` fact receipt (stage 2a spec §4.8). They are no
/// error codes of an HTTP answer: a batch of facts is answered 200 with a
/// receipt per record, and a record the host refuses names one of these.
pub mod receipt_codes {
    /// The record could not be read, or one of its fields breaks its rule
    /// (`details.field` names it when the record itself was readable). A box
    /// or pallet fact of a validation shift names `shift_mode` (plan РЕЖ).
    pub const INVALID_RECORD: &str = "invalid_record";
    /// A record with this id was received before with other content.
    pub const PAYLOAD_MISMATCH: &str = "payload_mismatch";
    pub const UNKNOWN_SHIFT: &str = "unknown_shift";
    /// The device never entered the shift the record names.
    pub const NOT_ENTERED: &str = "not_entered";
    /// An accepted scan's GTIN is not the one the shift's snapshot froze.
    pub const GTIN_MISMATCH: &str = "gtin_mismatch";
    /// No box of this device and this shift has the id.
    pub const BOX_UNKNOWN: &str = "box_unknown";
    /// A scan names a box that is closed.
    pub const BOX_CLOSED: &str = "box_closed";
    /// A box closed with one SSCC (or on one pallet) is closed again with
    /// another.
    pub const BOX_ALREADY_CLOSED: &str = "box_already_closed";
    /// The box is not in the state the record needs (an exception or a
    /// label check of an open box, an undo in a closed one).
    pub const BOX_STATE: &str = "box_state";
    /// The SSCC is not of the record's extension (a box 0, a pallet 1) and
    /// the shift's prefix, or its serial lies in no live block of that
    /// extension issued to this device.
    pub const SSCC_NOT_ISSUED: &str = "sscc_not_issued";
    /// Another box (or pallet) carries the SSCC, or is closed on its serial
    /// of its block.
    pub const SSCC_TAKEN: &str = "sscc_taken";
    /// The shift works without pallets, and the record names a pallet.
    pub const NO_PALLETS: &str = "no_pallets";
    /// No pallet of this device and this shift has the id: another device's
    /// or another shift's has it, or (for a label check or an exception) no
    /// pallet at all.
    pub const PALLET_UNKNOWN: &str = "pallet_unknown";
    /// A pallet closed with one SSCC is closed again with another.
    pub const PALLET_ALREADY_CLOSED: &str = "pallet_already_closed";
    /// The pallet is not in the state the record needs (a label check or an
    /// exception of an open pallet, an exception of one taken apart).
    pub const PALLET_STATE: &str = "pallet_state";
    /// What the record is about is not on the host: a unit label event (plan
    /// РЕЖ, part B) of a code this station has no accepted scan of in this
    /// shift.
    pub const SUBJECT_UNKNOWN: &str = "subject_unknown";
    /// No closed box has this SSCC (a pallet event names a box the host never closed).
    pub const BOX_NOT_FOUND: &str = "box_not_found";
    /// The box exists but is taken apart: it is no closed box any more.
    pub const BOX_NOT_CLOSED: &str = "box_not_closed";
    /// The box stands on another pallet; `details.palletSscc` (`null` while that pallet is open) and
    /// `details.palletId` name it.
    pub const BOX_ON_PALLET: &str = "box_on_pallet";
    /// The box is of another product than the pallet.
    pub const PRODUCT_MISMATCH: &str = "product_mismatch";
    /// The pallet is closed (or taken apart): a box neither joins nor leaves it.
    pub const PALLET_NOT_OPEN: &str = "pallet_not_open";
    /// A warehouse pallet closed with a box count the host does not hold; `details.counted` is its own.
    pub const PALLET_COUNT_MISMATCH: &str = "pallet_count_mismatch";
    /// The license has no `pallets` feature: a new warehouse pallet is refused (open ones go on).
    pub const FEATURE_DISABLED: &str = "feature_disabled";

    /// Every code above, for the parity fixture the webview also reads.
    pub const ALL: &[&str] = &[
        INVALID_RECORD,
        PAYLOAD_MISMATCH,
        UNKNOWN_SHIFT,
        NOT_ENTERED,
        GTIN_MISMATCH,
        BOX_UNKNOWN,
        BOX_CLOSED,
        BOX_ALREADY_CLOSED,
        BOX_STATE,
        SSCC_NOT_ISSUED,
        SSCC_TAKEN,
        NO_PALLETS,
        PALLET_UNKNOWN,
        PALLET_ALREADY_CLOSED,
        PALLET_STATE,
        SUBJECT_UNKNOWN,
        BOX_NOT_FOUND,
        BOX_NOT_CLOSED,
        BOX_ON_PALLET,
        PRODUCT_MISMATCH,
        PALLET_NOT_OPEN,
        PALLET_COUNT_MISMATCH,
        FEATURE_DISABLED,
    ];
}

/// Reason codes of a box exception (stage 2a spec, decision 36): a station
/// sends a code, never translated text; free text of at most
/// [`exception_reasons::MAX_TEXT_CHARS`] characters goes only with
/// [`exception_reasons::OTHER`].
pub mod exception_reasons {
    pub const OTHER: &str = "other";
    pub const MAX_TEXT_CHARS: usize = 200;
    /// Why a box's label is printed again.
    pub const REPRINT: &[&str] = &[
        "damaged_label",
        "unreadable_label",
        "printer_jam",
        "quality_request",
        OTHER,
    ];
    /// Why a closed box is taken apart.
    pub const DISASSEMBLE: &[&str] = &[
        "wrong_product",
        "wrong_quantity",
        "damaged_package",
        "quality_rejected",
        OTHER,
    ];
}

/// The domain's six `SHIFT_CLOSE_REASON_CODES`: the reason a station gives
/// when it closes a shift whose fact differs from its plan.
pub mod shift_close_reasons {
    pub const ALL: &[&str] = &[
        "production_defect",
        "material_shortage",
        "equipment_stop",
        "production_order_changed",
        "planned_quantity_error",
        "other_production_deviation",
    ];
}

pub mod backup;
pub mod cloud_history;
pub mod cloud_import;
pub mod code_registry;
pub mod code_search;
pub mod disaggregation;
pub mod export_files;
pub mod handheld;
pub mod license;
pub mod pack_cards;
pub mod pairing;
pub mod review;
pub mod trust;
pub mod update;
pub mod usage_stats;

pub use handheld::*;

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
    /// Set by `markiro-host restore` (plan РК), a new UUID at every restore:
    /// a device that sees it change knows the host went back to a copy and
    /// registers its SSCC blocks again (`POST /v1/device/sscc/blocks/known`).
    /// Absent until the first restore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_epoch: Option<String>,
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

/// A secret on the wire: a device key, a session token, a password, a PIN or
/// badge verifier or the badge salt. It serializes as a plain JSON string, but
/// `Debug` never prints the value, so a stray `{:?}` or a `tracing` field
/// cannot leak it.
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

/// A stored name that is no variant of the enum it was read as
/// ([`DeviceKind`], [`OfficeRole`]). `what` says which enum failed, so a log
/// line reads `unknown office role "x"`, not just `unknown value "x"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownVariant {
    pub what: &'static str,
    pub value: String,
}

impl std::fmt::Display for UnknownVariant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "unknown {} {:?}", self.what, self.value)
    }
}

impl std::error::Error for UnknownVariant {}

/// The variant `text` names, read by serde itself (`rename_all` included), so
/// the set of names lives only in the enum's derive: a variant added there is
/// parsed at once, and a hand-written parser cannot fall behind it.
fn parse_variant<T: serde::de::DeserializeOwned>(
    what: &'static str,
    text: &str,
) -> Result<T, UnknownVariant> {
    use serde::de::IntoDeserializer;
    T::deserialize(IntoDeserializer::<serde::de::value::Error>::into_deserializer(text)).map_err(
        |_| UnknownVariant {
            what,
            value: text.to_owned(),
        },
    )
}

impl std::str::FromStr for DeviceKind {
    type Err = UnknownVariant;

    /// The name [`DeviceKind::as_str`] gives, as `devices.kind` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("device kind", text)
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
    /// The `deviceId` of the device this claim re-pairs (plan ТСД-Х, task Х6): the host gives that
    /// device a new key when the code was made for it. Left out, a claim pairs a new device.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recover_device_id: Option<String>,
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
/// device. The code and the payload carrying it are shown once; `id` is what
/// «Новый код» sends as `replaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCode {
    pub id: String,
    /// 10 Crockford base32 characters.
    pub code: Secret,
    pub created_at: String,
    pub expires_at: String,
    /// `markiro-host:1?h=<addresses>&p=<port>&f=<fingerprint>&c=<code>`.
    pub payload: Secret,
}

/// The optional body of `POST /v1/office/pairing-codes`. `replaces` names the
/// code «Новый код» takes over: a live code the same office user created
/// expires at once; anything else is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingCodeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
}

/// `GET /v1/device`. `license` (plan ЛЦ-2) is the site's license state as
/// the host computed it: a host before ЛЦ-2 sends none, and `PUT
/// /v1/device/line` answers without it. A license line this build cannot
/// read is `None`: it never blocks the device's own record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub name: String,
    pub line_id: Option<String>,
    pub paired_at: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "license::device_license_or_none"
    )]
    pub license: Option<license::DeviceLicense>,
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
    /// The version the device last reported (`APP_VERSION_HEADER`), or the
    /// one it named when it paired until it reports (plan ОБН-1).
    pub app_version: String,
    /// The protocol it spoke when it last reported, or at pairing.
    pub protocol: u32,
    /// When the host first heard it report its current version and
    /// protocol; `None` while it has reported nothing since it paired.
    pub version_seen_at: Option<String>,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
}

/// `PUT /v1/office/devices/{id}`: only the fields sent change; `lineId: null`
/// clears the line. `name: null` reads as «not sent», like every plain
/// `Option<T>` field (see [`LineUpdate`]): only `lineId`, the double-optional
/// one, tells `null` from an absent field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub line_id: Option<Option<String>>,
}

/// Entities of the change feed (spec §4.4).
pub mod entities {
    pub const ORG_PROFILE: &str = "org_profile";
    pub const SITE: &str = "site";
    pub const LINES: &str = "lines";
    pub const OPERATORS: &str = "operators";
    pub const OPERATOR_BADGES: &str = "operator_badges";
    pub const PRODUCTS: &str = "products";
    pub const LABEL_TEMPLATES: &str = "label_templates";
    pub const CATEGORY_TEMPLATE_DEFAULTS: &str = "category_template_defaults";
    /// A box a disaggregation document took apart (plan ДЗГ): a station acts
    /// on it and keeps no copy ([`crate::disaggregation::CodeReleaseRecord`]).
    pub const CODE_RELEASES: &str = "code_releases";
}

/// The feed id of a category default: `<code>:<purpose>` (`8:box`), the
/// same text the host's feed query builds in SQL.
pub fn category_default_id(chz_product_group_code: u32, purpose: TemplatePurpose) -> String {
    format!("{chz_product_group_code}:{}", purpose.as_str())
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
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeItem {
    /// One of [`entities`].
    pub entity: String,
    pub id: String,
    pub rev: i64,
    pub deleted: bool,
    /// The record ([`OrgRecord`], [`SiteRecord`], [`LineRecord`],
    /// [`OperatorRecord`], [`OperatorBadgeRecord`], [`ProductRecord`],
    /// [`LabelTemplateRecord`], [`CategoryTemplateDefault`]); absent when
    /// `deleted`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Prints what the item is (entity, id, revision, deletion) and never its
/// `data`: on the wire it holds `pinPhc`, `badgePhc` and the badge salt, and
/// it is untyped JSON, so no field can hide itself. A `{:?}` of a
/// [`ChangesResponse`] prints through this.
impl std::fmt::Debug for ChangeItem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChangeItem")
            .field("entity", &self.entity)
            .field("id", &self.id)
            .field("rev", &self.rev)
            .field("deleted", &self.deleted)
            .finish_non_exhaustive()
    }
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
    /// The organization's default template of each purpose (spec §4.3), or
    /// `null`. A record from before plan 1e1 has none of the three and reads
    /// as `null`.
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub default_duplicate_template_id: Option<String>,
}

/// `data` of a `site` item: only what stations use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    /// The site's badge salt: 16 bytes, standard base64 with padding.
    pub badge_salt: Secret,
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

/// What a label template prints (spec §4.3). A template's purpose never
/// changes after it is created, and a default slot takes only a template of
/// its own purpose. The order is that of the stored names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplatePurpose {
    Box,
    Pallet,
    ProductDuplicate,
}

impl TemplatePurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            TemplatePurpose::Box => "box",
            TemplatePurpose::Pallet => "pallet",
            TemplatePurpose::ProductDuplicate => "product_duplicate",
        }
    }
}

impl std::str::FromStr for TemplatePurpose {
    type Err = UnknownVariant;

    /// The name [`TemplatePurpose::as_str`] gives, as `label_templates.purpose`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("template purpose", text)
    }
}

/// Whether a product is ready for production (spec §4.3): `active` once it
/// has a product group and both capacities, `draft` before, as the cloud's
/// `computeStatus`. The host computes it; nobody sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProductStatus {
    Draft,
    Active,
}

impl ProductStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ProductStatus::Draft => "draft",
            ProductStatus::Active => "active",
        }
    }
}

impl std::str::FromStr for ProductStatus {
    type Err = UnknownVariant;

    /// The name [`ProductStatus::as_str`] gives, as `products.status` computes
    /// it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("product status", text)
    }
}

/// `data` of a `products` item. An archived product stays in the feed with
/// `archived: true`: stations keep it for history and leave it out of their
/// pickers. Only the demo product is ever deleted (the office's «Удалить
/// демо-данные»), and it leaves as a tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductRecord {
    /// 14 digits, as the office normalized it (`normalizeToGtin14`).
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    /// Preferences: a station uses one only while the template still fits
    /// the product (enabled, of the slot's purpose, covering its group).
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub archived: bool,
    pub status: ProductStatus,
    /// SHA-256 of the product's photo in lower-case hex, `null` without one
    /// (beta 3): the station fetches the bytes from
    /// `GET /v1/device/products/{id}/photo` when its copy differs. A record
    /// from an older host has none.
    #[serde(default)]
    pub photo_checksum: Option<String>,
    /// The wizard's demo product (spec 2026-10-21): its shifts are demo shifts. Sent only when
    /// true; a record from an older host has none.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub demo: bool,
}

/// `data` of a `label_templates` item. A disabled template stays in the feed
/// with `enabled: false`; a deleted one leaves as a tombstone. `spec` is the
/// layout as JSON, which a station prints from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplateRecord {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `null` for every category, otherwise the product-group codes.
    pub chz_product_group_codes: Option<Vec<u32>>,
    /// From the wizard: its name, purpose and spec never change and it is
    /// never deleted; it may be disabled or narrowed.
    pub stock: bool,
    pub spec: serde_json::Value,
}

/// A category's default template of one purpose: `data` of a
/// `category_template_defaults` item, whose `id` is [`category_default_id`],
/// and an entry of the office's template defaults. A cleared default leaves
/// the feed as a tombstone of that id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTemplateDefault {
    pub chz_product_group_code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
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

impl std::str::FromStr for OfficeRole {
    type Err = UnknownVariant;

    /// The name [`OfficeRole::as_str`] gives, as `office_users.role` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("office role", text)
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
    /// The version of the user's photo (plan АВА), `null` without one; a host
    /// before the photos sends none. The client asks for the picture again
    /// when it changes.
    #[serde(default)]
    pub avatar_version: Option<i64>,
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
    /// The stock label templates the app built with `@markiro/domain` (plan
    /// 1e3); a wizard from before then sends none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub templates: Vec<StockTemplate>,
    /// The wizard's mark «I reserved the host's address» (plan ТСД-П, task П4); left out, nothing
    /// was confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_confirmed: Option<bool>,
    /// «Установить демо-данные» (spec 2026-10-21): the host adds the demo product, its SSCC
    /// counters and a planned demo shift on the first line. Left out, nothing of the kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demo_data: Option<bool>,
}

/// A stock label template of the wizard: enabled, for every category, and
/// kept as it came (`stock`). `orgDefault` makes it the organization's
/// default of its purpose, so the request names no id it does not have yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StockTemplate {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub spec: serde_json::Value,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub org_default: bool,
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

/// The organization's print logo (plan А4): monochrome, `width` × `height`
/// dots, rows MSB first, 1 = ink, each row padded to whole bytes with zero
/// bits, in standard base64. Labels with an `organization_logo` element and
/// A4 sheets print it; without one they print the bundled Markiro logo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgLogo {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
    pub updated_at: String,
}

/// `GET`, `PUT` and `DELETE /v1/office/org/logo`: the logo, or `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgLogoState {
    pub logo: Option<OrgLogo>,
}

/// `PUT /v1/office/org/logo` (administrators): the whole logo, replacing any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgLogoPut {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
}

/// A product's photo (plan ТОВ): a JPEG the office made, at most 640 × 640
/// and 300 000 bytes, in standard base64 with padding. The host checks the
/// sides, the length and the JPEG signature only; it parses no picture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPhoto {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
    /// `image/jpeg`, `image/png` or `image/webp`, derived by the host from
    /// the magic bytes; a host before beta 3.2 sends none (a JPEG).
    #[serde(default = "jpeg_media_type")]
    pub media_type: String,
    /// SHA-256 of the bytes in lower-case hex.
    pub checksum: String,
    pub updated_at: String,
}

fn jpeg_media_type() -> String {
    "image/jpeg".to_owned()
}

/// `GET`, `PUT` and `DELETE /v1/office/products/{id}/photo`: the photo, or
/// `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPhotoState {
    pub photo: Option<ProductPhoto>,
}

/// `PUT /v1/office/products/{id}/photo` (administrators and technologists):
/// the whole photo, replacing any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductPhotoPut {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
}

/// The limits of an office user's photo (plan АВА), the one source the
/// host's checks and the webview's mirror both read
/// (`fixtures/avatar-limits.json` holds them for the parity tests).
pub mod avatar {
    /// The largest picture, in bytes: 2 MiB.
    pub const MAX_BYTES: usize = 2 * 1024 * 1024;
    /// The shortest side, in dots.
    pub const MIN_SIDE: u32 = 128;
    /// The longest side, in dots; the host decodes nothing, so this keeps a
    /// picture that would unpack into gigabytes out of the webview of every
    /// office PC that shows it.
    pub const MAX_SIDE: u32 = 4096;
    /// What the host stores, by the picture's magic bytes.
    pub const MEDIA_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp"];
}

/// An office user's photo (plan АВА): a square JPEG, PNG or WebP the office
/// cropped before it uploaded, in standard base64 with padding. The host
/// derives `mediaType`, `width` and `height` from the picture's own header
/// and never from a word of the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAvatar {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
    pub media_type: String,
    /// SHA-256 of the bytes in lower-case hex.
    pub checksum: String,
    /// What [`OfficeUser::avatar_version`] carries: the host's time of the
    /// change in milliseconds since the Unix epoch, never lower than the
    /// previous version of the same user.
    pub version: i64,
    pub updated_at: String,
}

/// `GET`, `PUT` and `DELETE /v1/office/users/{id}/avatar`: the photo, or
/// `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAvatarState {
    pub avatar: Option<UserAvatar>,
}

/// `PUT /v1/office/users/{id}/avatar` (the user's own photo only): the
/// whole picture, replacing any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UserAvatarPut {
    pub data_base64: String,
}

/// An A4 pallet sheet (plan А4; the cloud's `PalletSheetSpecV2`, #702). The
/// host keeps `spec` an object of `schemaVersion` 2 and `kind`
/// "pallet_sheet" of at most 64 KiB; the domain checks the layout. A stock
/// sheet carries its preset's key (`buildPalletSheetPresets`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletSheet {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub preset_key: Option<String>,
    pub revision: i64,
    pub spec: serde_json::Value,
}

/// `GET /v1/office/pallet-sheets` and `PUT /v1/office/pallet-sheet-default`:
/// every sheet by name and the organization's default sheet, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletSheets {
    pub sheets: Vec<PalletSheet>,
    pub default_id: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

/// `POST /v1/office/pallet-sheets`: a new sheet, or a stock one by its preset
/// key (the same key again answers the sheet already there).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetCreate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_key: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub spec: serde_json::Value,
}

/// `PUT /v1/office/pallet-sheets/{id}`: the name or the state, over the
/// sheet's revision. The layout never changes: a new layout is a new sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    pub expected_revision: i64,
}

/// `PUT /v1/office/pallet-sheet-default`: an enabled sheet, or `null` for none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletSheetDefaultUpdate {
    #[serde(deserialize_with = "present")]
    pub template_id: Option<String>,
}

/// A field that may be `null` but must be there: a body without it is a
/// refusal, not a quiet "no default" (plain serde reads an absent `Option`
/// as `None`).
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
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

/// `POST /v1/device/sscc/blocks`: a station asks for a block of serials of
/// an issuer prefix (its shift's snapshot names it) and an extension (0, a
/// box, in stage 2a). `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SsccBlockRequest {
    pub request_id: String,
    pub issuer_prefix: String,
    pub extension: u8,
}

/// A block of SSCC serials issued to one station, both ends included; the
/// station builds the SSCC with the domain's `buildSscc`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccBlock {
    pub id: String,
    pub issuer_prefix: String,
    pub extension: u8,
    pub from_serial: u64,
    pub to_serial: u64,
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
    /// As [`OfficeUser::avatar_version`].
    #[serde(default)]
    pub avatar_version: Option<i64>,
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

/// An employee (`GET /v1/office/employees`, administrators only): a person
/// of the site, as the cloud's `employees`. Office data, never in the
/// station feed and never a credential. `operatorId` names the one operator
/// the employee is (one operator per employee, one employee per operator),
/// `null` for none; the operator keeps its own personnel number, PIN and
/// badges. An archived employee is linked to no operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployeeRecord {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub operator_id: Option<String>,
    pub archived: bool,
    pub rev: i64,
}

/// `POST /v1/office/employees`; `operatorId` links the new employee to an
/// operator at once («Создать сотрудника» from an operator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmployeeCreate {
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub operator_id: Option<String>,
}

/// `PUT /v1/office/employees/{id}`: every field, like a counterparty;
/// `operatorId: null` unlinks, `archived: true` archives (and needs
/// `operatorId: null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmployeeUpdate {
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub operator_id: Option<String>,
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

/// `PUT /v1/office/lines/{id}`: only the fields sent change. `null` in `name`
/// or `archived` reads as «not sent»: `Option<T>` with `#[serde(default)]` maps
/// it to absent, so `{ "name": null, "expectedRev": 7 }` changes nothing. Only
/// the deliberately double-optional fields (`Option<Option<T>>` with
/// [`nullable`]) tell `null` from an absent one.
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
/// null` clears the role, and a new `pin_phc` replaces the PIN. `null` in
/// `name`, `active` or `pin_phc` reads as «not sent» (see [`LineUpdate`]): only
/// `role`, the double-optional field, tells `null` from an absent one.
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

/// `POST /v1/office/operators/{id}/badges`: the office hashed the badge code
/// with the site's badge salt (`GET /v1/office/badge-salt`) and the domain's
/// 100 000 iterations; the host never sees the code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BadgeCreate {
    pub badge_phc: Secret,
    #[serde(default)]
    pub label: Option<String>,
}

/// `GET /v1/office/badge-salt`: the site's badge salt, 16 bytes in standard
/// base64 with padding — the value the feed's `site` record carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BadgeSalt {
    pub badge_salt: Secret,
}

/// A ЧЗ product group (`GET /v1/office/product-groups`): the cloud's static
/// lookup (spec §2, decision 12), read by every office role and not in the
/// station feed. Products and templates refer to `code`; `alias` is the
/// latin name True API takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductGroup {
    pub code: u32,
    pub alias: String,
    pub name: String,
}

/// A product as the office sees it (`GET /v1/office/products`, archived
/// products included). `status` is computed: `active` with a product group
/// and both capacities, `draft` before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeProduct {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    /// The A4 sheet the product's pallets print on (beta feedback): a
    /// preference, as the two templates; not in the station feed.
    #[serde(default)]
    pub default_pallet_sheet_id: Option<String>,
    /// The EGAIS code the labels print (plan ТОВ, the cloud's
    /// `products.egais_code`): only a product of ЧЗ group 15 has one.
    #[serde(default)]
    pub egais_code: Option<String>,
    /// The counterparty the office's shift dialog offers for the product
    /// (plan ТОВ); one archived later stays named here.
    #[serde(default)]
    pub default_counterparty_id: Option<String>,
    /// SHA-256 of the photo's bytes in lower-case hex, `null` without a photo
    /// (the bytes come from `GET /v1/office/products/{id}/photo`).
    #[serde(default)]
    pub photo_checksum: Option<String>,
    /// The wizard's demo product (spec 2026-10-21): read-only, deleted with the demo data.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub demo: bool,
    pub archived: bool,
    pub status: ProductStatus,
    pub rev: i64,
}

/// `GET /v1/office/demo-data`, and the answer of `DELETE` with what it removed: the demo
/// product and what its shifts made. `activeShifts` names the demo shifts still open (a
/// delete refuses while there is one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoDataSummary {
    pub present: bool,
    pub product_id: Option<String>,
    pub shifts: u32,
    pub boxes: u32,
    pub pallets: u32,
    pub codes: u32,
    pub active_shifts: Vec<String>,
}

/// `POST /v1/office/products`: a product in use. The office normalized the
/// GTIN with `normalizeToGtin14`; every field after `name` may be left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCreate {
    pub gtin14: String,
    pub name: String,
    #[serde(default)]
    pub print_name: Option<String>,
    #[serde(default)]
    pub chz_product_group_code: Option<u32>,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default)]
    pub shelf_life_days: Option<u32>,
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    /// An A4 sheet (`pallet_sheet_templates`), never a label template.
    #[serde(default)]
    pub default_pallet_sheet_id: Option<String>,
    /// The EGAIS code (plan ТОВ): only with ЧЗ group 15.
    #[serde(default)]
    pub egais_code: Option<String>,
    /// A counterparty in use (plan ТОВ).
    #[serde(default)]
    pub default_counterparty_id: Option<String>,
}

/// `PUT /v1/office/products/{id}`: every field, like a counterparty, so an
/// optional field left out or `null` is cleared (a missing `gtin14`, `name`,
/// `archived` or `expectedRev` is refused); `archived: true` archives. The
/// exceptions are the fields newer than the rest — `defaultPalletSheetId`,
/// `egaisCode` and `defaultCounterpartyId` (plan ТОВ): left out they are
/// kept, so an office from before them never clears a product's sheet, its
/// EGAIS code or its counterparty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductUpdate {
    pub gtin14: String,
    pub name: String,
    #[serde(default)]
    pub print_name: Option<String>,
    #[serde(default)]
    pub chz_product_group_code: Option<u32>,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default)]
    pub shelf_life_days: Option<u32>,
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub default_pallet_sheet_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub egais_code: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub default_counterparty_id: Option<Option<String>>,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A label template without its layout (`GET /v1/office/templates`), as
/// the cloud's `LabelTemplateSummaryDto`. The size, the resolution and the
/// language are read from the stored `spec` as they stand, `null` where it
/// has none of the right type: the host does not check a layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplateSummary {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `null` for every category, otherwise the product-group codes.
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub stock: bool,
    pub width_mm: Option<serde_json::Number>,
    pub height_mm: Option<serde_json::Number>,
    pub dpi: Option<u32>,
    pub language: Option<String>,
    pub rev: i64,
}

/// A label template with its layout (`GET /v1/office/templates/{id}`, and
/// the answer of `POST` and `PUT`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelTemplate {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub chz_product_group_codes: Option<Vec<u32>>,
    /// From the wizard: its name, purpose and layout never change, and it is
    /// never deleted.
    pub stock: bool,
    /// The layout as the host stores it; the UI checked it with
    /// `labelTemplateSpecSchema`.
    pub spec: serde_json::Value,
    pub rev: i64,
}

/// `POST /v1/office/templates`: a template of the office's own, never a
/// stock one; a copy of a stock template is a `POST` of its layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelTemplateCreate {
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// Left out or `null`: every category.
    #[serde(default)]
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub spec: serde_json::Value,
}

/// `PUT /v1/office/templates/{id}`: only the fields sent change;
/// `chzProductGroupCodes: null` widens the template to every category, and
/// leaving it out keeps its categories. A purpose never changes, so it is no
/// field here; a stock template takes only `enabled` and its categories (or
/// its own name and layout, unchanged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelTemplateUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub chz_product_group_codes: Option<Option<Vec<u32>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<serde_json::Value>,
    pub expected_rev: i64,
}

/// The templates' defaults as one document (`GET
/// /v1/office/template-defaults`, and the answer of its `PUT`): the
/// organization's default of each purpose and every category default, by
/// code then purpose, and the A4 sheets chosen by default beside the pallet
/// labels: the organization's (`defaultPalletSheetId`, the column the sheets'
/// own route sets too) and each category's, by code. `rev` is the document's
/// revision: the newest of the organization's record, a category default and
/// a cleared category default's tombstone (a change of the sheet defaults
/// moves the organization's record).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDefaults {
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub default_duplicate_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefault>,
    #[serde(default)]
    pub default_pallet_sheet_id: Option<String>,
    #[serde(default)]
    pub pallet_sheet_categories: Vec<CategoryPalletSheetDefault>,
    pub rev: i64,
}

/// A category's default A4 sheet: an entry of the templates' defaults. Not
/// in the station feed (a station prints a sheet only from a shift's
/// snapshot), so a cleared one leaves no tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryPalletSheetDefault {
    pub chz_product_group_code: u32,
    pub sheet_id: String,
}

/// A category default in `PUT /v1/office/template-defaults`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryTemplateDefaultInput {
    pub chz_product_group_code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
}

/// `PUT /v1/office/template-defaults`: the whole document over its `rev`.
/// An organization default left out or `null` is none, and a category
/// default left out of `categories` is cleared. The sheet defaults are newer
/// than the rest: `defaultPalletSheetId` and `palletSheetCategories` left out
/// keep what is stored, so an office from before them clears nothing;
/// `null` is no organization sheet, and a category left out of a sent list
/// is cleared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateDefaultsUpdate {
    #[serde(default)]
    pub default_box_template_id: Option<String>,
    #[serde(default)]
    pub default_pallet_template_id: Option<String>,
    #[serde(default)]
    pub default_duplicate_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefaultInput>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub default_pallet_sheet_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet_categories: Option<Vec<CategoryPalletSheetDefault>>,
    pub expected_rev: i64,
}

/// Where a shift was created (stage 2a spec §4.2): planned in the office, or
/// at a station while the host answered. A station's shift number ends in
/// `/S`. The cloud's name for the office is `admin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftOrigin {
    Office,
    Station,
}

impl ShiftOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftOrigin::Office => "office",
            ShiftOrigin::Station => "station",
        }
    }
}

impl std::str::FromStr for ShiftOrigin {
    type Err = UnknownVariant;

    /// The name [`ShiftOrigin::as_str`] gives, as `shifts.created_from`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift origin", text)
    }
}

/// A shift's status: planned in the office, active once a station opened it
/// (and froze its snapshot), closed for good.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftStatus {
    Planned,
    Active,
    Closed,
}

impl ShiftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftStatus::Planned => "planned",
            ShiftStatus::Active => "active",
            ShiftStatus::Closed => "closed",
        }
    }
}

impl std::str::FromStr for ShiftStatus {
    type Err = UnknownVariant;

    /// The name [`ShiftStatus::as_str`] gives, as `shifts.status` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift status", text)
    }
}

/// What a shift does, as the cloud's: aggregation into boxes, or validation
/// of single codes. Stage 2a took only aggregation; validation (plan РЕЖ,
/// protocol 4) also needed a new shape: the entry's [`ShiftEnter`] and an
/// `ok` [`ScanFact`] without a box.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftMode {
    #[default]
    Aggregation,
    Validation,
}

impl ShiftMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ShiftMode::Aggregation => "aggregation",
            ShiftMode::Validation => "validation",
        }
    }
}

impl std::str::FromStr for ShiftMode {
    type Err = UnknownVariant;

    /// The name [`ShiftMode::as_str`] gives, as `shifts.mode` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("shift mode", text)
    }
}

/// What a station can work, as it names it in the body of
/// `POST /v1/device/shifts/{id}/enter` ([`ShiftEnter::supports`], plan РЕЖ).
pub mod shift_supports {
    /// Validation shifts: single codes accepted without a box.
    pub const VALIDATION: &str = "validation-v1";
    /// Validation shifts that print a Data Matrix duplicate of each accepted
    /// code (part B of plan РЕЖ; declared with protocol 4, checked by the
    /// host from protocol 5).
    pub const VALIDATION_DM_DUPLICATE: &str = "validation-dm-duplicate-v1";
    /// A handheld that speaks the host's protocol (plan ТСД, protocol 6): named in its claim's
    /// `capabilities` and on every entry into a shift, which the host always asks of a handheld.
    pub const HANDHELD_HOST: &str = "handheld-host-v1";
}

/// Whether the operator must scan a printed duplicate before the next unit
/// (the cloud's `verification` of `validationPrint`): `none` lets the next
/// unit go once the label is sent, `required` waits for the check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelVerification {
    None,
    Required,
}

impl LabelVerification {
    pub fn as_str(self) -> &'static str {
        match self {
            LabelVerification::None => "none",
            LabelVerification::Required => "required",
        }
    }
}

impl std::str::FromStr for LabelVerification {
    type Err = UnknownVariant;

    /// The name [`LabelVerification::as_str`] gives.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("label verification", text)
    }
}

/// The print policy of a validation shift (part B of plan РЕЖ, protocol 5),
/// the cloud's `validationPrint` without its reprocessing of earlier codes
/// (part C): `{ "mode": "none" }`, or `{ "mode": "duplicate_dm",
/// "verification", "templateId" }`, a Data Matrix duplicate of each accepted
/// code printed with a `product_duplicate` template. Only a validation shift
/// prints one; an aggregation shift's policy is `none`. Each shape takes
/// exactly its own fields (so `None` is an empty struct variant: serde lets
/// a unit variant of an internally tagged enum ignore unknown fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ValidationPrint {
    None {},
    DuplicateDm {
        verification: LabelVerification,
        #[serde(rename = "templateId")]
        template_id: String,
    },
}

/// The body of `POST /v1/device/shifts/{id}/enter` (protocol 4, plan РЕЖ):
/// what the station can work, from [`shift_supports`]. A station of
/// protocol 3 sends no body, which reads as `{}`: it names nothing, so it
/// enters an aggregation shift as before and no validation shift.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftEnter {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supports: Vec<String>,
}

/// A shift as the office sees it (`GET /v1/office/shifts`, `GET …/{id}` and
/// the answer of every office write). `number` is the host's
/// (`OCT26-004`, `/S` for a station's). Names come from the office's own
/// lists of products, lines and counterparties; `totals` from the facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub mode: ShiftMode,
    pub pallets_enabled: bool,
    pub created_from: ShiftOrigin,
    pub product_id: String,
    pub line_id: String,
    pub counterparty_id: Option<String>,
    /// The shift's production date, `YYYY-MM-DD`; the number's month comes from it.
    pub production_date: String,
    /// The shift's own date (the cloud's `plannedDate`, «Дата смены»): the
    /// working day it takes place, a civil date apart from the production
    /// date. A shift written before it has its production date here.
    pub planned_date: String,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: String,
    /// How many boxes a pallet holds and the pallet label template: both set
    /// exactly when `palletsEnabled` (plan ПЛ-Х), `null` otherwise.
    pub pallet_box_capacity: Option<u32>,
    pub pallet_template_id: Option<String>,
    /// The A4 sheet a shift with pallets prints on an A4 printer (plan А4):
    /// `null` for none, and always `null` without pallets.
    #[serde(default)]
    pub pallet_sheet_template_id: Option<String>,
    /// The shift's print policy (part B of plan РЕЖ, protocol 5); left out
    /// by a host before it, which reads as `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<ValidationPrint>,
    /// The station that opened the shift; `null` while it is planned.
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    /// One of the domain's six `SHIFT_CLOSE_REASON_CODES`, from a station's
    /// close (plan 2a2).
    pub close_reason_code: Option<String>,
    /// The office's words when it closed the shift.
    pub close_reason_text: Option<String>,
    /// When facts first arrived after the shift was closed (plan 2a2).
    pub late_data_at: Option<String>,
    pub created_at: String,
    pub rev: i64,
    /// What the facts of the shift add up to (plan 2a2), in every answer.
    pub totals: ShiftTotals,
}

/// A shift's numbers as its facts give them (stage 2a spec §4.5): units
/// accepted (items in a box, neither taken out by an exception nor taken by
/// an earlier scan elsewhere), the units among them in closed boxes that
/// were not taken apart (the cloud office's «Кодов в закрытых коробах»; the
/// rest are in boxes still open, so a shift closed with a box open shows the
/// gap), boxes closed and not taken apart, open boxes that hold a unit, when
/// the host last received a record of the shift, the devices that entered
/// it, first entry first, and (plan ПЛ-Х) pallets closed and not taken apart
/// and open pallets that hold a box not taken apart; a shift without pallets
/// has none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftTotals {
    pub accepted_units: u64,
    pub units_in_closed_boxes: u64,
    pub closed_boxes: u32,
    pub open_boxes: u32,
    pub last_fact_at: Option<String>,
    pub device_ids: Vec<String>,
    pub closed_pallets: u32,
    pub open_pallets: u32,
    /// The unit labels of a validation shift that prints a duplicate (plan
    /// РЕЖ, part B); left out for every other shift.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_labels: Option<UnitLabelTotals>,
}

/// What a shift's `unit_label` facts give its card (plan РЕЖ, part B; the
/// cloud's `productLabelSummary`): the attempts sent and the attempts
/// verified (each attempt once, whatever was received twice), the jobs whose
/// check was skipped, the reprints (attempts after a job's first), and the
/// jobs not resolved yet: those whose last event is not `verified`,
/// `verification_skipped`, or `sent` when the shift requires no check. A
/// job's last event is its latest by `attemptNo` (every event of an attempt
/// precedes the next attempt's), then by its place in the domain's order of
/// an attempt (`prepared`, `sending`, the print's outcome, a rejected check,
/// a check that passed or was skipped), then by `at` only among events of
/// the same place (the device's clock may step back), then by the station's
/// record id and device: an order neither the record's arrival nor a copy of
/// the database changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitLabelTotals {
    pub sent: u64,
    pub verified: u64,
    pub skipped: u64,
    pub unresolved: u64,
    pub reprints: u64,
}

/// `POST /v1/office/shifts`: a planned shift. `boxCapacity` left out is the
/// product's; `mode` left out is aggregation and `palletsEnabled` false. A
/// shift with pallets names its pallet template and may name its pallet
/// capacity (the product's when left out); one without sends neither. A
/// validation shift (plan РЕЖ) has no pallets: `validation_failed` on
/// `palletsEnabled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftCreate {
    pub product_id: String,
    pub line_id: String,
    pub production_date: String,
    /// The shift's own date (beta 3); left out, the production date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_date: Option<String>,
    pub box_template_id: String,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub planned_qty: Option<u32>,
    #[serde(default)]
    pub counterparty_id: Option<String>,
    #[serde(default)]
    pub mode: ShiftMode,
    #[serde(default)]
    pub pallets_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    /// The shift's A4 sheet (plan А4), only with pallets; left out, a shift
    /// with pallets takes the organization's default sheet when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet_template_id: Option<String>,
    /// The print policy (part B of plan РЕЖ, protocol 5); left out, `none`.
    /// `duplicate_dm` only with `mode: validation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<ValidationPrint>,
}

/// `PUT /v1/office/shifts/{id}`: only the fields sent change, over
/// `expectedRev`. A planned shift takes every field but its product, which
/// is no field here; an active one only `plannedQty` (another field sent
/// with another value is `conflict` on `shift_status`); a closed one
/// nothing. `plannedQty: null` and `counterpartyId: null` clear them; `null`
/// in another field reads as «not sent» (see [`LineUpdate`]). Pallets turned
/// off clear the pallet capacity and template (sending either then is
/// `validation_failed`); turned on, they need a template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_date: Option<String>,
    /// The shift's own date (beta 3); left out, it stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub planned_qty: Option<Option<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub counterparty_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ShiftMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallets_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    /// The shift's A4 sheet (plan А4), only with pallets: an id names that
    /// sheet; `null` is «the organization's main sheet», resolved by the host
    /// when it takes the edit (none when there is no main sheet) and frozen
    /// into the snapshot at opening like any sheet; left out, the shift keeps
    /// its sheet, and pallets just turned on take the main one.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "nullable")]
    pub pallet_sheet_template_id: Option<Option<String>>,
    /// The print policy (part B of plan РЕЖ, protocol 5), only of a planned
    /// shift; left out, the shift keeps its policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<ValidationPrint>,
    pub expected_rev: i64,
}

/// `POST /v1/office/shifts/{id}/close`: the office closes an active shift
/// (a station that died, a shift nobody will finish) with its reason in
/// words, 3–500 characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftClose {
    pub reason: String,
    pub expected_rev: i64,
}

/// A shift as a station sees it (`GET /v1/device/shifts` and the answer of
/// `POST /v1/device/shifts`). The product's name and GTIN and the
/// counterparty's name are the snapshot's once the shift is open, so a
/// change of the catalog does not show on a shift that runs; before that
/// they are the records' own (the station keeps no copy of counterparties).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub mode: ShiftMode,
    pub pallets_enabled: bool,
    pub created_from: ShiftOrigin,
    pub line_id: String,
    pub product_id: String,
    pub product_name: String,
    pub product_gtin14: String,
    pub counterparty_name: Option<String>,
    pub production_date: String,
    /// The shift's own date (beta 3, the cloud's `plannedDate`); left out by
    /// a host before it, which reads as the production date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_date: Option<String>,
    pub planned_qty: Option<u32>,
    pub box_capacity: u32,
    pub box_template_id: String,
    /// How many boxes a pallet holds and the pallet label template, only for
    /// a shift with pallets (plan ПЛ-Х); left out otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    /// The shift's print policy (part B of plan РЕЖ, protocol 5); left out
    /// by a host before it, which reads as `none`. Once the shift is open,
    /// the snapshot's [`SnapshotValidationPrint`] is the same policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<ValidationPrint>,
    /// The station that opened the shift: another one's id means the shift
    /// is busy (stage 2a puts one device on a shift).
    pub owner_device_id: Option<String>,
    pub opened_at: Option<String>,
    pub closed_at: Option<String>,
    /// What the shift froze when it opened: only in the answer of
    /// `POST /v1/device/shifts/{id}/enter`, never in the list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ShiftSnapshot>,
}

/// What a shift freezes when a station opens it (stage 2a spec §4.2): the
/// station prints and reprints from this alone, so a change of the catalog,
/// the template or the organization's GLN never changes a shift that runs.
///
/// A frozen snapshot outlives the host that froze it: the owner's re-entry
/// reads the stored JSON through this struct. A field added here later must
/// therefore be an `Option` with `#[serde(default)]`, or every shift opened
/// before the change would fail to parse (and could not be entered again).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshot {
    pub product: ShiftSnapshotProduct,
    pub box_template: ShiftSnapshotTemplate,
    /// The SSCC issuer prefix of the organization's GLN when the shift
    /// opened: the station asks for blocks of it, of boxes and of pallets.
    pub issuer_prefix: String,
    pub counterparty_name: Option<String>,
    /// The pallet label template as the shift froze it, its layout whole:
    /// only for a shift with pallets (plan ПЛ-Х); left out otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template: Option<ShiftSnapshotTemplate>,
    /// The A4 sheet the shift froze (plan А4): only for a shift with a sheet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet: Option<ShiftSnapshotSheet>,
    /// The organization as the shift froze it (plan А4): its name, INN and
    /// print logo, for the sheet's header and footer and the labels' logo
    /// box. Left out by a host before plan А4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<ShiftSnapshotOrganization>,
    /// The duplicate print as the shift froze it (part B of plan РЕЖ): only
    /// for a validation shift that prints one; left out otherwise, and by
    /// every snapshot frozen before part B, which therefore reads and writes
    /// back as it was stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<SnapshotValidationPrint>,
}

/// A shift's `duplicate_dm` policy as the shift froze it: the check of the
/// printed label and the `product_duplicate` template, its layout whole (its
/// `id` is the policy's `templateId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotValidationPrint {
    pub verification: LabelVerification,
    pub template: ShiftSnapshotTemplate,
}

/// The product as a shift froze it; only an active product opens a shift,
/// so it has a group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotProduct {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: u32,
    pub shelf_life_days: Option<u32>,
    /// The product's EGAIS code as the shift froze it (plan ТОВ): only a
    /// product of ЧЗ group 15 has one. Left out by a host before plan ТОВ.
    #[serde(default)]
    pub egais_code: Option<String>,
}

/// A label template as a shift froze it (its box template, its pallet
/// template when it has pallets, its duplicate template when it prints one),
/// its layout whole. The host never checks a
/// layout; the station checks it with `labelTemplateSpecSchema` when it
/// enters the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotTemplate {
    pub id: String,
    pub name: String,
    pub rev: i64,
    pub spec: serde_json::Value,
}

/// An A4 sheet as a shift froze it: its name, revision and whole layout. The
/// host never checks the layout; the station reads it with the domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotSheet {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub spec: serde_json::Value,
}

/// The organization as a shift froze it (plan А4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotOrganization {
    pub name: String,
    pub inn: Option<String>,
    /// The organization's print logo, `null` for none (the bundled Markiro
    /// logo prints then).
    pub logo: Option<ShiftSnapshotLogo>,
}

/// A print logo as a shift froze it: the bits of `OrgLogo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftSnapshotLogo {
    pub width: u32,
    pub height: u32,
    pub pixels_base64: String,
}

/// `GET /v1/device/shifts`: the planned and active shifts of the station's
/// line, and the shifts it entered that are active or closed within 30 days.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceShifts {
    pub shifts: Vec<DeviceShift>,
}

/// `POST /v1/device/shifts`: a station creates a shift on its own line while
/// the host answers. `requestId` (a lower-case hyphenated UUID the station
/// made up) makes it repeatable: the same request of the same station
/// answers the same shift. Pallets follow the office's rules
/// ([`ShiftCreate`]); a station of stage 2a sends none of their fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceShiftCreate {
    pub request_id: String,
    pub product_id: String,
    pub box_template_id: String,
    pub production_date: String,
    /// The shift's own date, today in the organization's time zone as the
    /// station reads it (beta 3); left out (an older station), the
    /// production date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planned_date: Option<String>,
    #[serde(default)]
    pub box_capacity: Option<u32>,
    #[serde(default)]
    pub planned_qty: Option<u32>,
    #[serde(default)]
    pub counterparty_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pallets_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_box_capacity: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_template_id: Option<String>,
    /// The shift's A4 sheet (plan А4), only with pallets; left out, a shift
    /// with pallets takes the organization's default sheet when it has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sheet_template_id: Option<String>,
    /// The shift's mode (plan РЕЖ, beta 3.2): left out, aggregation, which is
    /// how every station before it creates. A validation shift has no pallets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ShiftMode>,
    /// The print policy of a validation shift ([`ShiftCreate::validation_print`]);
    /// left out, `none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_print: Option<ValidationPrint>,
}

/// What a fact records (stage 2a spec §4.4): the kind tells the host how
/// to read the record's `data`. A kind added later is a new variant; a host
/// that does not know it answers the record `invalid_record`, for good, as it
/// does a new `data` field: either raises `PROTOCOL_VERSION` (the pallet
/// kinds came with protocol 3, plan ПЛ-Х; `unit_label` with protocol 5, part
/// B of plan РЕЖ).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Scan,
    BoxClosed,
    BoxLabel,
    BoxException,
    ShiftClosed,
    PalletClosed,
    PalletLabel,
    PalletException,
    UnitLabel,
}

impl FactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FactKind::Scan => "scan",
            FactKind::BoxClosed => "box_closed",
            FactKind::BoxLabel => "box_label",
            FactKind::BoxException => "box_exception",
            FactKind::ShiftClosed => "shift_closed",
            FactKind::PalletClosed => "pallet_closed",
            FactKind::PalletLabel => "pallet_label",
            FactKind::PalletException => "pallet_exception",
            FactKind::UnitLabel => "unit_label",
        }
    }
}

impl std::str::FromStr for FactKind {
    type Err = UnknownVariant;

    /// The name [`FactKind::as_str`] gives, as `fact_receipts.kind` stores
    /// it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("fact kind", text)
    }
}

/// One record of a device's outbox (`POST /v1/device/facts`): `id` is a
/// lower-case hyphenated UUID the device made up, which keys the receipt;
/// `data` is read by `kind` (`ScanFact`, …). `operatorId` names the
/// operator signed in when it happened, or `null`; the host keeps it as
/// evidence without checking that the operator exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactRecord {
    pub id: String,
    pub kind: FactKind,
    pub shift_id: String,
    #[serde(default)]
    pub operator_id: Option<String>,
    pub data: serde_json::Value,
}

/// `POST /v1/device/facts`: 1–100 records, applied in their order. The host
/// reads each record on its own, so one it cannot read is answered
/// `rejected` and the others are still applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactBatch {
    pub records: Vec<FactRecord>,
}

/// What a station decided about a scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanVerdict {
    /// Accepted: into the box in an aggregation shift, without one in a
    /// validation shift.
    Ok,
    /// A code already taken, by this station's own copy or by the host.
    Duplicate,
    /// A code of another product than the shift's.
    WrongGtin,
    /// No code of marking at all.
    Invalid,
}

impl ScanVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanVerdict::Ok => "ok",
            ScanVerdict::Duplicate => "duplicate",
            ScanVerdict::WrongGtin => "wrong_gtin",
            ScanVerdict::Invalid => "invalid",
        }
    }
}

/// Who found a duplicate: the station's own copy of the shift, or the host
/// asked with `GET /v1/device/codes/{codeHash}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplicateSource {
    Local,
    Host,
}

impl DuplicateSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DuplicateSource::Local => "local",
            DuplicateSource::Host => "host",
        }
    }
}

/// What the domain's `classifyScan` read the scan as: a code of marking, or
/// (for an `invalid` scan) a GTIN, an SSCC or nothing it knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanRawKind {
    Km,
    Gtin,
    Sscc,
    Unknown,
}

impl ScanRawKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanRawKind::Km => "km",
            ScanRawKind::Gtin => "gtin",
            ScanRawKind::Sscc => "sscc",
            ScanRawKind::Unknown => "unknown",
        }
    }
}

/// A code of marking as the domain read it: `codeHash` is `kmHash` (64
/// lower-case hex digits), `canonical` the text `canonicalizeKm` kept (with
/// its group separators, at most 1024 bytes). The host checks their shape,
/// never the code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScannedCode {
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub canonical: String,
}

/// `data` of a `scan` fact: every scan of the work screen, accepted or not.
/// An `invalid` scan carries no text, only its length and what it looked
/// like (it may be a badge, whose code is a secret). `boxId` is always sent:
/// an `ok` scan of an aggregation shift names the box it went into; an `ok`
/// scan of a validation shift is `null` (protocol 4, plan РЕЖ), and so is
/// every scan not accepted. Which of the two an `ok` scan must be is the
/// host's to check against the shift's mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanFact {
    pub scanned_at: String,
    pub verdict: ScanVerdict,
    pub duplicate_source: Option<DuplicateSource>,
    pub raw_kind: ScanRawKind,
    pub raw_length: u32,
    pub code: Option<ScannedCode>,
    /// `ok` in an aggregation shift: the box; `ok` in a validation shift:
    /// `null`.
    pub box_id: Option<String>,
}

/// `data` of a `box_closed` fact: a box closed with the SSCC of serial
/// `serial` from block `blockId`, which the host issued to this station.
/// `itemCount` and `membershipDigest` (the domain's `boxMembershipDigestV1`
/// of the box's code hashes) are what the station saw; the host compares the
/// digest with its own items and keeps the result. In a shift with pallets
/// `palletId` names the station's pallet the box joined as it closed (plan
/// ПЛ-Х); a shift without pallets sends none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxClosedFact {
    pub box_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub item_count: u32,
    pub membership_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_id: Option<String>,
}

/// `data` of a `pallet_closed` fact (plan ПЛ-Х): the station closed its
/// pallet, when it filled or early, with the SSCC of serial `serial` from
/// the pallet block (extension 1) `blockId` the host issued to it.
/// `openedAt` is when its first box closed, `boxCount` how many boxes the
/// station counted on it; the pallet's boxes are the boxes whose
/// `box_closed` named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletClosedFact {
    pub pallet_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub box_count: u32,
}

/// `data` of a `pallet_label` fact (plan ПЛ-Х): the check of a closed
/// pallet's label, as a box's ([`BoxLabelFact`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletLabelFact {
    pub pallet_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a pallet exception does (the cloud station's two).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PalletExceptionKind {
    /// Print a closed pallet's label again.
    Reprint,
    /// Take a closed pallet apart; its SSCC stays used and its boxes stay
    /// as they are.
    Disassemble,
}

impl PalletExceptionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PalletExceptionKind::Reprint => "reprint",
            PalletExceptionKind::Disassemble => "disassemble",
        }
    }
}

/// `data` of a `pallet_exception` fact (plan ПЛ-Х): a reason code of
/// [`exception_reasons`] for the kind (the box exceptions' lists), and
/// words only with `other`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletExceptionFact {
    pub exception: PalletExceptionKind,
    pub pallet_id: String,
    pub reason_code: String,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

/// How a box's printed label was checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LabelOutcome {
    /// The operator scanned the label's SSCC and it matched.
    Verified,
    /// The operator skipped the check.
    Skipped,
}

/// `data` of a `box_label` fact: the check of a closed box's label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxLabelFact {
    pub box_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a box exception does (the cloud's four kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionKind {
    /// Take the last code out of an open box.
    Undo,
    /// Take every code out of an open box.
    Clear,
    /// Print a closed box's label again.
    Reprint,
    /// Take a closed box apart; its SSCC stays used.
    Disassemble,
}

impl ExceptionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ExceptionKind::Undo => "undo",
            ExceptionKind::Clear => "clear",
            ExceptionKind::Reprint => "reprint",
            ExceptionKind::Disassemble => "disassemble",
        }
    }
}

/// `data` of a `box_exception` fact, with the fields of each kind as the
/// cloud's: `undo` names the code and its scan's instant and no reason;
/// `clear` nothing; `reprint` and `disassemble` a reason code of
/// [`exception_reasons`], and words only with `other`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoxExceptionFact {
    pub exception: ExceptionKind,
    pub box_id: String,
    pub code_hash: Option<String>,
    pub target_scanned_at: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
}

/// An event of a unit label job (part B of plan РЕЖ): the kinds of the
/// domain's `productLabelEventSchema` (`@markiro/domain` `product-labels`),
/// by name. An attempt is `prepared`, then `sending`, then `sent` or
/// `delivery_unknown` (never sent again on its own), or `failed_before_send`
/// when the printer no longer fits; its label is then `verified`,
/// `verification_rejected` (the scan did not match) or
/// `verification_skipped` (only after `sent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnitLabelEvent {
    Prepared,
    Sending,
    Sent,
    FailedBeforeSend,
    DeliveryUnknown,
    Verified,
    VerificationRejected,
    VerificationSkipped,
}

impl UnitLabelEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            UnitLabelEvent::Prepared => "prepared",
            UnitLabelEvent::Sending => "sending",
            UnitLabelEvent::Sent => "sent",
            UnitLabelEvent::FailedBeforeSend => "failed_before_send",
            UnitLabelEvent::DeliveryUnknown => "delivery_unknown",
            UnitLabelEvent::Verified => "verified",
            UnitLabelEvent::VerificationRejected => "verification_rejected",
            UnitLabelEvent::VerificationSkipped => "verification_skipped",
        }
    }

    /// The error codes an event of this kind carries, one of them exactly
    /// (`UNIT_LABEL_ERROR_CODES` in `protocol.ts`, the `CHECK` of
    /// `unit_label_events` in the host's `0021`): the domain's `errorCode` of
    /// `failed_before_send` and `delivery_unknown`, its rejection `reason` of
    /// `verification_rejected`; none for every other event, which carries
    /// none. `proto/fixtures/unit-label-rules.json` pins the lists.
    pub fn error_codes(self) -> &'static [&'static str] {
        match self {
            UnitLabelEvent::FailedBeforeSend => &["printer_unconfigured", "printer_changed"],
            UnitLabelEvent::DeliveryUnknown => {
                &["transport_failed", "persistence_failed", "interrupted"]
            }
            UnitLabelEvent::VerificationRejected => &["invalid", "mismatch"],
            UnitLabelEvent::Prepared
            | UnitLabelEvent::Sending
            | UnitLabelEvent::Sent
            | UnitLabelEvent::Verified
            | UnitLabelEvent::VerificationSkipped => &[],
        }
    }
}

impl std::str::FromStr for UnitLabelEvent {
    type Err = UnknownVariant;

    /// The name [`UnitLabelEvent::as_str`] gives.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("unit label event", text)
    }
}

/// Why a unit label is printed again (the domain's `ReprintReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReprintReason {
    NotPrinted,
    Damaged,
    Lost,
}

impl ReprintReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ReprintReason::NotPrinted => "not_printed",
            ReprintReason::Damaged => "damaged",
            ReprintReason::Lost => "lost",
        }
    }
}

impl std::str::FromStr for ReprintReason {
    type Err = UnknownVariant;

    /// The name [`ReprintReason::as_str`] gives.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("reprint reason", text)
    }
}

/// `data` of a `unit_label` fact (protocol 5, part B of plan РЕЖ): one event
/// of the job that prints the Data Matrix duplicate of an accepted code of a
/// validation shift. `jobId` is the station's job (a lower-case hyphenated
/// UUID), `codeHash` the accepted code's `kmHash`, `attemptNo` the attempt
/// from 1 (a reprint is a new attempt with the same bytes). `reason` is set
/// on the `prepared` event of a reprint only (attempt 2 and later), as the
/// domain's rule; `errorCode` on `failed_before_send` (`printer_unconfigured`,
/// `printer_changed`), `delivery_unknown` (`transport_failed`,
/// `persistence_failed`, `interrupted`) and `verification_rejected`
/// (`invalid`, `mismatch`) only. `payloadDigest` and `bytesDigest` are the
/// domain's digests of the printed text and of the printer's bytes: the
/// full code never travels in a fact. Which of these rules a record breaks
/// is the host's to check; so is the operator a decision names
/// ([`UnitLabelFact::is_operator_decision`]) and the code and printed text
/// a job keeps (an event of a known job with another `codeHash` or
/// `payloadDigest` is `invalid_record` on `data.codeHash`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnitLabelFact {
    pub job_id: String,
    pub code_hash: String,
    pub attempt_no: u32,
    pub event: UnitLabelEvent,
    pub reason: Option<ReprintReason>,
    pub error_code: Option<String>,
    pub payload_digest: String,
    pub bytes_digest: String,
    pub at: String,
}

/// Whether `text` is a SHA-256 as the domain writes it: 64 lower-case hex
/// digits (a code's `kmHash`, the digests of a unit label). The host's
/// `facts::rules::is_code_hash` is this rule.
pub fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl UnitLabelFact {
    /// Whether the event is the operator's decision, which names its
    /// operator on the record (`FactRecord::operator_id`; the host refuses
    /// one without, `invalid_record` on `operatorId`, as `factRecordSchema`
    /// does): a skipped check, and the `prepared` event of a reprint (attempt
    /// 2 and later), which carries its reason. Every other event may come
    /// without one: the station's recovery after a restart writes
    /// `delivery_unknown` with nobody signed in. The cloud requires an
    /// operator on every event; the host keeps an event without one.
    pub fn is_operator_decision(&self) -> bool {
        self.event == UnitLabelEvent::VerificationSkipped
            || (self.event == UnitLabelEvent::Prepared && self.attempt_no > 1)
    }

    /// The rules of the event that serde does not hold, as the webview's
    /// `unitLabelFactSchema` and the `CHECK`s of the host's
    /// `unit_label_events` hold them: `codeHash`, `payloadDigest` and
    /// `bytesDigest` are 64 lower-case hex digits, `attemptNo` is 1 or more,
    /// `reason` is set exactly on the `prepared` event of a later attempt,
    /// and `errorCode` exactly on the events that have one, from that
    /// event's list ([`UnitLabelEvent::error_codes`]; a code a newer station
    /// adds is refused). The error is the broken field's name in `data`.
    /// `jobId` (a client UUID) and `at` (a device instant) are the host's own
    /// rules. `proto/fixtures/unit-label-rules.json` pins every case.
    pub fn check(&self) -> Result<(), &'static str> {
        if !is_sha256_hex(&self.code_hash) {
            return Err("codeHash");
        }
        if self.attempt_no < 1 {
            return Err("attemptNo");
        }
        let reprint = self.event == UnitLabelEvent::Prepared && self.attempt_no > 1;
        if self.reason.is_some() != reprint {
            return Err("reason");
        }
        let codes = self.event.error_codes();
        let fits = match &self.error_code {
            None => codes.is_empty(),
            Some(code) => codes.contains(&code.as_str()),
        };
        if !fits {
            return Err("errorCode");
        }
        if !is_sha256_hex(&self.payload_digest) {
            return Err("payloadDigest");
        }
        if !is_sha256_hex(&self.bytes_digest) {
            return Err("bytesDigest");
        }
        Ok(())
    }
}

/// `data` of a `shift_closed` fact: a station closed its shift. The numbers
/// are the station's summary; a reason of [`shift_close_reasons`] is needed
/// when the plan the station saw (`plannedQtySnapshot`) was set and differs
/// from `actualQty` (the domain's `shiftCloseReasonRequired`). The answer to
/// the close of a shift the office closed first is `accepted` with
/// `details.alreadyClosed: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftClosedFact {
    pub planned_qty_snapshot: Option<u32>,
    pub actual_qty: u32,
    pub closed_box_count: u32,
    pub reason_code: Option<String>,
    pub closed_at: String,
}

/// How the host answered a record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactOutcome {
    /// Applied.
    Accepted,
    /// Kept, but the code belongs to an earlier scan (`details.winner`).
    Conflict,
    /// Not applied (`code`, one of [`receipt_codes`]).
    Rejected,
}

impl FactOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            FactOutcome::Accepted => "accepted",
            FactOutcome::Conflict => "conflict",
            FactOutcome::Rejected => "rejected",
        }
    }
}

impl std::str::FromStr for FactOutcome {
    type Err = UnknownVariant;

    /// The name [`FactOutcome::as_str`] gives, as `fact_receipts.outcome`
    /// stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("fact outcome", text)
    }
}

/// The host's answer to one record. `id` is the record's, or `null` when the
/// record had no readable id (then nothing was kept, and the device matches
/// the receipt by its place in the batch). A `rejected` receipt names its
/// `code`; `details` carries the field of an `invalid_record` and the winner
/// of a `conflict`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactReceipt {
    pub id: Option<String>,
    pub outcome: FactOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

/// The answer of `POST /v1/device/facts`: a receipt for each record, in the
/// records' order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactReceipts {
    pub receipts: Vec<FactReceipt>,
}

/// The scan that owns a code (stage 2a spec §4.6): the earliest accepted
/// scan of it. `sameDevice` tells the asking device that the scan is its
/// own. It is a `conflict` receipt's `details.winner` too.
/// Imported cloud ownership has no local scan/device: `deviceId` is the
/// NIL UUID and `sameDevice` is always false. This is provenance, not a
/// navigable device or native shift-journal identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeOwner {
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub scanned_at: String,
    pub same_device: bool,
}

/// `GET /v1/device/codes/{codeHash}` (stage 2a spec §4.6): whether an
/// accepted scan owns the code. A station asks while the link is `online`,
/// within 300 ms; without an answer it accepts the scan on its own copy, and
/// a duplicate shows later as a `conflict` receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodeCheck {
    Free,
    Taken { owner: CodeOwner },
}

/// What a station looks up to print a label again (plan СКЛ, pilot spec
/// §30): `POST /v1/device/warehouse/lookup` with exactly one of the hash of
/// a unit's code (`kmHash`, 64 lower-case hex digits) and the 18 digits of a
/// box's or a pallet's SSCC. The full code never travels this way: the host
/// answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseLookup {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sscc: Option<String>,
}

/// What a warehouse reprint prints: a unit's code, a box's or a pallet's
/// label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarehouseSubjectKind {
    Unit,
    Box,
    Pallet,
}

impl WarehouseSubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WarehouseSubjectKind::Unit => "unit",
            WarehouseSubjectKind::Box => "box",
            WarehouseSubjectKind::Pallet => "pallet",
        }
    }
}

/// Why a record the host has is not printed again: its code was freed by an
/// exception (`released`), or the box or the pallet was taken apart
/// (`disassembled`), or it came with the cloud history import without a fact
/// its label needs (`imported_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarehouseUnavailable {
    Released,
    Disassembled,
    /// An imported unit whose shift the cloud export did not carry: there is
    /// no product, date or number to print it with.
    ImportedNoShift,
    /// An imported record whose shift has no production date.
    ImportedNoProductionDate,
    /// An imported record whose product the catalog does not know (or knows
    /// without a ЧЗ group): no label template fits it.
    ImportedProductUnknown,
}

/// A record the host found, with what its label is rendered from: the
/// product and the counterparty as the shift froze them, the shift's number
/// and production date, `at` — the instant the label dates from (a unit's
/// scan, a box's or a pallet's close) — the counts it was printed with, the
/// name of the operator who scanned or closed it, and the station. A unit
/// carries its full canonical code (GS separators and crypto tail
/// included), a box and a pallet their SSCC; `identity` is what was asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarehouseSource {
    pub kind: WarehouseSubjectKind,
    pub subject_id: String,
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sscc: Option<String>,
    pub product: ShiftSnapshotProduct,
    pub counterparty_name: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub production_date: String,
    pub at: String,
    pub item_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_count: Option<u32>,
    pub operator_name: Option<String>,
    pub device_id: String,
    /// The record came with the cloud history import: no station made it, so
    /// `device_id` is the nil UUID and `operator_name` is empty. Left out for
    /// a native record.
    #[serde(default, skip_serializing_if = "is_false")]
    pub imported: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// The answer of `POST /v1/device/warehouse/lookup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WarehouseLookupResult {
    Found { source: WarehouseSource },
    NotFound,
    Unavailable { reason: WarehouseUnavailable },
}

/// Why a station prints a label again (the cloud's `warehouseReasonSchema`).
pub const WAREHOUSE_REASONS: &[&str] = &["not_printed", "damaged", "lost"];

/// Where one attempt of a reprint ended, as the station recorded it.
pub const WAREHOUSE_OUTCOMES: &[&str] = &["sent", "unknown", "failed", "verified", "cancelled"];

/// The codes of a refused warehouse record
/// (`proto/fixtures/warehouse-receipt-codes.json`).
pub mod warehouse_receipt_codes {
    /// The record could not be read, or a field breaks its rule.
    pub const INVALID_RECORD: &str = "invalid_record";
    /// A record with this id was received before with other content.
    pub const PAYLOAD_MISMATCH: &str = "payload_mismatch";
    /// No unit, box or pallet of the host has this id and identity.
    pub const SUBJECT_UNKNOWN: &str = "subject_unknown";
    pub const ALL: &[&str] = &[INVALID_RECORD, PAYLOAD_MISMATCH, SUBJECT_UNKNOWN];
}

/// One attempt of a warehouse reprint, as the station recorded it: which
/// session and job, the attempt's number (0 — a job that never reached a
/// printer), what was printed (`subjectKind`, the host's `subjectId` and the
/// `identity` looked up: a code's hash or an SSCC, never a full code), why,
/// on which template revision, how it ended (`errorCode` exactly for
/// `failed` and `unknown`), by whom and when (a device instant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseRecord {
    pub id: String,
    pub session_id: String,
    pub job_id: String,
    pub attempt: u32,
    pub subject_kind: WarehouseSubjectKind,
    pub subject_id: String,
    pub identity: String,
    pub reason_code: String,
    pub repair: Option<String>,
    pub template_id: String,
    pub template_rev: i64,
    pub outcome: String,
    pub error_code: Option<String>,
    pub operator_id: Option<String>,
    pub occurred_at: String,
}

/// `POST /v1/device/warehouse/reprints`: 1–100 records; the answer is
/// [`FactReceipts`], a receipt per record in their order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehouseBatch {
    pub records: Vec<WarehouseRecord>,
}

/// `POST /v1/office/shifts/{id}/exports` (plan ЧЗ): the office saved the
/// files of an export and records it in the audit trail; nothing else
/// changes. `formatId` and `formatVersion` are a format `@markiro/domain`
/// advertises (`proto/fixtures/export-formats.json`); a pallet's export names
/// its pallet and has one part and no `maxLines`, a shift's names no pallet.
/// `documentId` is the base `document_id` the files carry; the counts are
/// the parts' sums, as the cloud's export totals them, and
/// `openPalletSuppressedBoxCount` the boxes written on no pallet because
/// their pallet had not closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftExportRecord {
    pub format_id: String,
    pub format_version: u32,
    pub max_lines: Option<u32>,
    pub pallet_id: Option<String>,
    pub document_id: String,
    pub part_count: u32,
    pub code_count: u64,
    pub box_count: u32,
    pub pallet_count: u32,
    pub open_pallet_suppressed_box_count: u32,
}

/// A box of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/boxes`, plan ЧЗ for the card of plan О-Ф): the
/// device's instants as it sent them; `units` the box's live items now;
/// `itemCountReported` and `digestMatches` what the station's close said
/// and how it compared at that moment (stale once the box is taken apart);
/// the label check's instants as the station sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBox {
    pub id: String,
    pub device_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub pallet_id: Option<String>,
    pub units: u32,
    pub item_count_reported: Option<u32>,
    pub digest_matches: Option<bool>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
    /// The operator who closed the box (plan КРТ, П-14), `null` without one.
    #[serde(default)]
    pub operator_name: Option<String>,
}

/// A pallet of a shift as the office lists it (`GET
/// /v1/office/shifts/{id}/pallets`, plan ЧЗ for plan О-Ф): `boxes` its closed
/// boxes not taken apart and `units` their live items, both derived as the
/// cloud's pallet card derives them; `boxCountReported` what the station's
/// close counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePallet {
    pub id: String,
    pub device_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
    /// How many of the boxes that stood on the pallet were taken apart since
    /// (by a station or an applied disaggregation document): they explain a
    /// `boxCountReported` above `boxes`.
    #[serde(default)]
    pub disassembled_boxes: u32,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
}

/// `GET /v1/office/shifts/{id}/export-source` (plan ЧЗ): what a shift's
/// exports are built from, read in one snapshot. The office ports the
/// cloud's source rules (`shift-export-source.service.ts`) over these rows
/// and renders the files with `@markiro/domain`; the host checks nothing of
/// an export itself. `codes` are the codes the shift owns, each with the
/// canonical text of its owning scan (crypto tail included); `boxes` every
/// box of the shift, open and taken apart ones too; `items` the live items
/// of those boxes only (neither taken out by an exception nor taken by an
/// earlier scan elsewhere), the only ones the cloud's rules ever read;
/// `pallets` every pallet of the shift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftExportRows {
    pub shift: ExportShift,
    pub organization: ExportOrganization,
    pub codes: Vec<ExportCode>,
    pub boxes: Vec<ExportBox>,
    pub items: Vec<ExportItem>,
    pub pallets: Vec<ExportPallet>,
}

/// The shift of [`ShiftExportRows`]. `closedAt` is the host's (whole
/// seconds); `stationClosedAt` is the instant of the station's close the
/// host accepted (the device's, with milliseconds), `null` when the office
/// closed the shift or it is not closed. `productName` is the product's
/// name now, as the cloud's export joins it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub production_date: String,
    pub product_name: String,
    pub pallets_enabled: bool,
    pub closed_at: Option<String>,
    pub station_closed_at: Option<String>,
    /// Frozen report operation time for imported snapshots; not a close event.
    /// Native sources omit this and retain their existing close/fallback rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_operation_date_time: Option<String>,
    pub late_data_at: Option<String>,
}

/// The organization as the ЧЗ document names it: `org_name` and `LP_TIN`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOrganization {
    pub name: String,
    pub inn: Option<String>,
    /// Frozen source zone for imported reports. Native responses preserve omission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
}

/// A code the shift owns: its hash, the instant of its owning scan and that
/// scan's canonical text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCode {
    pub code_hash: String,
    pub scanned_at: String,
    pub canonical: String,
    /// Validation reprocessing contributes only to flat TXT/CSV exports.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub flat_only: bool,
}

/// A box of the shift; the device's instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBox {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub pallet_id: Option<String>,
}

/// A live item: the code `codeHash` lies in box `boxId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportItem {
    pub box_id: String,
    pub code_hash: String,
}

/// A pallet of the shift; the device's instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
}

/// `GET /v1/office/boxes/{id}/report-data` (plan О-Ф): what «Состав
/// короба» prints of one box, read in one snapshot. `items` are the codes
/// the cloud's form prints (`CodeSearchService.boxReportData`): the box's
/// live items, and of a box taken apart the items its disassembly took out
/// (`removed_at` equal to the box's `disassembled_at`: the host writes both
/// from the one instant of the `disassemble` fact), never an item taken out
/// earlier or taken by an earlier scan elsewhere; each with its scan's GTIN,
/// serial and canonical text (crypto tail included), ordered by GTIN, then
/// serial, byte for byte. `productName` is the product's name now, as the
/// cloud's form joins it; the device's instants are as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxReportRows {
    pub id: String,
    pub shift_id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub product_name: Option<String>,
    pub organization: ExportOrganization,
    pub items: Vec<BoxReportItem>,
}

/// A code «Состав короба» prints: the AI 01 and AI 21 of its label line and
/// the full canonical text its DataMatrix encodes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxReportItem {
    pub gtin14: String,
    pub serial: String,
    pub canonical: String,
}

/// `GET /v1/office/shifts/{id}/pallet-report-data` (plan О-Ф): what
/// «Состав паллеты» and «Ярлык паллеты» print of the shift's pallets, read
/// in one snapshot, so the placards of the whole shift agree with each
/// other. `pallets` are every pallet of the shift, opened first first;
/// each pallet's `boxes` every box that ever stood on it, closed first first
/// (then by id), boxes taken apart included, as the cloud's forms list them;
/// a box's `units` are its live items now (a box taken apart has none: the
/// forms print it without a count and count it nowhere).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletReportRows {
    pub shift: ReportShift,
    pub organization: ExportOrganization,
    pub pallets: Vec<ReportPallet>,
}

/// The shift of [`PalletReportRows`]: its number, its production date and
/// its product now (name, GTIN, shelf life), as the cloud's forms join the
/// live product.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportShift {
    pub id: String,
    pub number: String,
    pub production_date: String,
    pub product_name: String,
    pub gtin14: String,
    pub shelf_life_days: Option<u32>,
}

/// A pallet of the shift with the boxes that stood on it; the device's
/// instants as it sent them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: Vec<ReportPalletBox>,
}

/// A box that stood on a pallet: it joined at its close, so it is closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPalletBox {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: String,
    pub disassembled_at: Option<String>,
    pub units: u32,
}

#[cfg(test)]
mod tests {
    use super::{
        category_default_id, DeviceKind, DuplicateSource, FactKind, FactOutcome, OfficeRole,
        ProductStatus, ScanRawKind, ScanVerdict, ShiftMode, ShiftOrigin, ShiftStatus,
        TemplatePurpose, UnknownVariant,
    };

    /// Every `TemplatePurpose`, listed like `device_kinds` below.
    fn template_purposes() -> Vec<TemplatePurpose> {
        let purposes = vec![
            TemplatePurpose::Box,
            TemplatePurpose::Pallet,
            TemplatePurpose::ProductDuplicate,
        ];
        for purpose in &purposes {
            match purpose {
                TemplatePurpose::Box
                | TemplatePurpose::Pallet
                | TemplatePurpose::ProductDuplicate => {}
            }
        }
        purposes
    }

    /// Every `ProductStatus`, listed the same way.
    fn product_statuses() -> Vec<ProductStatus> {
        let statuses = vec![ProductStatus::Draft, ProductStatus::Active];
        for status in &statuses {
            match status {
                ProductStatus::Draft | ProductStatus::Active => {}
            }
        }
        statuses
    }

    /// The catalog's stored names parse back like the others, and purposes
    /// sort as their names do, so a list the host orders in SQL by `purpose`
    /// and one ordered in Rust agree.
    #[test]
    fn catalog_names_parse_back_and_purposes_sort_as_their_names() {
        for purpose in template_purposes() {
            assert_eq!(purpose.as_str().parse::<TemplatePurpose>(), Ok(purpose));
            assert_eq!(serde_json::to_value(purpose).unwrap(), purpose.as_str());
        }
        for status in product_statuses() {
            assert_eq!(status.as_str().parse::<ProductStatus>(), Ok(status));
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
        let mut by_name: Vec<TemplatePurpose> = template_purposes().into_iter().rev().collect();
        by_name.sort_by_key(|purpose| purpose.as_str());
        let mut by_order: Vec<TemplatePurpose> = template_purposes().into_iter().rev().collect();
        by_order.sort();
        assert_eq!(by_name, by_order);
        assert_eq!(by_order, template_purposes());
        assert_eq!(
            "Box".parse::<TemplatePurpose>().unwrap_err().to_string(),
            "unknown template purpose \"Box\""
        );
        assert_eq!(
            category_default_id(8, TemplatePurpose::ProductDuplicate),
            "8:product_duplicate"
        );
    }

    /// Every `DeviceKind`. The `match` has no wildcard arm, so a new variant
    /// does not compile until it is listed here; the round trip below then
    /// checks its `as_str` name against serde and `FromStr`.
    fn device_kinds() -> Vec<DeviceKind> {
        let kinds = vec![
            DeviceKind::Station,
            DeviceKind::Office,
            DeviceKind::Handheld,
        ];
        for kind in &kinds {
            match kind {
                DeviceKind::Station | DeviceKind::Office | DeviceKind::Handheld => {}
            }
        }
        kinds
    }

    /// Every `OfficeRole`, listed the same way.
    fn office_roles() -> Vec<OfficeRole> {
        let roles = vec![OfficeRole::Admin, OfficeRole::Technologist];
        for role in &roles {
            match role {
                OfficeRole::Admin | OfficeRole::Technologist => {}
            }
        }
        roles
    }

    /// Every `ShiftOrigin`, listed the same way.
    fn shift_origins() -> Vec<ShiftOrigin> {
        let origins = vec![ShiftOrigin::Office, ShiftOrigin::Station];
        for origin in &origins {
            match origin {
                ShiftOrigin::Office | ShiftOrigin::Station => {}
            }
        }
        origins
    }

    /// Every `ShiftStatus`, listed the same way.
    fn shift_statuses() -> Vec<ShiftStatus> {
        let statuses = vec![
            ShiftStatus::Planned,
            ShiftStatus::Active,
            ShiftStatus::Closed,
        ];
        for status in &statuses {
            match status {
                ShiftStatus::Planned | ShiftStatus::Active | ShiftStatus::Closed => {}
            }
        }
        statuses
    }

    /// Every `ShiftMode`, listed the same way.
    fn shift_modes() -> Vec<ShiftMode> {
        let modes = vec![ShiftMode::Aggregation, ShiftMode::Validation];
        for mode in &modes {
            match mode {
                ShiftMode::Aggregation | ShiftMode::Validation => {}
            }
        }
        modes
    }

    /// Every `FactKind`, listed the same way.
    fn fact_kinds() -> Vec<FactKind> {
        let kinds = vec![
            FactKind::Scan,
            FactKind::BoxClosed,
            FactKind::BoxLabel,
            FactKind::BoxException,
            FactKind::ShiftClosed,
            FactKind::PalletClosed,
            FactKind::PalletLabel,
            FactKind::PalletException,
            FactKind::UnitLabel,
        ];
        for kind in &kinds {
            match kind {
                FactKind::Scan
                | FactKind::BoxClosed
                | FactKind::BoxLabel
                | FactKind::BoxException
                | FactKind::ShiftClosed
                | FactKind::PalletClosed
                | FactKind::PalletLabel
                | FactKind::PalletException
                | FactKind::UnitLabel => {}
            }
        }
        kinds
    }

    /// Every `FactOutcome`, listed the same way.
    fn fact_outcomes() -> Vec<FactOutcome> {
        let outcomes = vec![
            FactOutcome::Accepted,
            FactOutcome::Conflict,
            FactOutcome::Rejected,
        ];
        for outcome in &outcomes {
            match outcome {
                FactOutcome::Accepted | FactOutcome::Conflict | FactOutcome::Rejected => {}
            }
        }
        outcomes
    }

    /// The host stores `as_str` names and reads them back with `FromStr`;
    /// serde writes the same names on the wire.
    #[test]
    fn stored_names_parse_back_into_their_variants() {
        for kind in device_kinds() {
            assert_eq!(kind.as_str().parse::<DeviceKind>(), Ok(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for role in office_roles() {
            assert_eq!(role.as_str().parse::<OfficeRole>(), Ok(role));
            assert_eq!(serde_json::to_value(role).unwrap(), role.as_str());
        }
        for origin in shift_origins() {
            assert_eq!(origin.as_str().parse::<ShiftOrigin>(), Ok(origin));
            assert_eq!(serde_json::to_value(origin).unwrap(), origin.as_str());
        }
        for status in shift_statuses() {
            assert_eq!(status.as_str().parse::<ShiftStatus>(), Ok(status));
            assert_eq!(serde_json::to_value(status).unwrap(), status.as_str());
        }
        for mode in shift_modes() {
            assert_eq!(mode.as_str().parse::<ShiftMode>(), Ok(mode));
            assert_eq!(serde_json::to_value(mode).unwrap(), mode.as_str());
        }
        assert_eq!(ShiftMode::default(), ShiftMode::Aggregation);
        for kind in fact_kinds() {
            assert_eq!(kind.as_str().parse::<FactKind>(), Ok(kind));
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for outcome in fact_outcomes() {
            assert_eq!(outcome.as_str().parse::<FactOutcome>(), Ok(outcome));
            assert_eq!(serde_json::to_value(outcome).unwrap(), outcome.as_str());
        }
        for verdict in [
            ScanVerdict::Ok,
            ScanVerdict::Duplicate,
            ScanVerdict::WrongGtin,
            ScanVerdict::Invalid,
        ] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), verdict.as_str());
        }
        for source in [DuplicateSource::Local, DuplicateSource::Host] {
            assert_eq!(serde_json::to_value(source).unwrap(), source.as_str());
        }
        for raw_kind in [
            ScanRawKind::Km,
            ScanRawKind::Gtin,
            ScanRawKind::Sscc,
            ScanRawKind::Unknown,
        ] {
            assert_eq!(serde_json::to_value(raw_kind).unwrap(), raw_kind.as_str());
        }
        assert_eq!(
            "admin".parse::<ShiftOrigin>().unwrap_err().to_string(),
            "unknown shift origin \"admin\""
        );
    }

    /// Names are exact: another case, padding or an unknown name is refused,
    /// and the error says which enum failed.
    #[test]
    fn a_name_that_is_not_exactly_a_variant_is_refused_and_says_what_failed() {
        for text in [
            "Station",
            "STATION",
            "Office",
            "tablet",
            "",
            "station ",
            " handheld",
        ] {
            let refused = text.parse::<DeviceKind>();
            assert_eq!(
                refused,
                Err(UnknownVariant {
                    what: "device kind",
                    value: text.to_owned()
                }),
                "{text:?}"
            );
        }
        for text in [
            "Admin",
            "ADMIN",
            "Technologist",
            "owner",
            "",
            "admin ",
            " technologist",
        ] {
            let refused = text.parse::<OfficeRole>();
            assert_eq!(
                refused,
                Err(UnknownVariant {
                    what: "office role",
                    value: text.to_owned()
                }),
                "{text:?}"
            );
        }
        assert_eq!(
            "owner".parse::<OfficeRole>().unwrap_err().to_string(),
            "unknown office role \"owner\""
        );
        assert_eq!(
            "Station".parse::<DeviceKind>().unwrap_err().to_string(),
            "unknown device kind \"Station\""
        );
    }
}
