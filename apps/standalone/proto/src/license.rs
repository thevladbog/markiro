//! The site's license (plan ЛЦ-2, spec 2026-10-13 §8.2): what the office
//! reads (`GET /v1/office/license`), the preview and the load of a file, and
//! the license line of a device's own record (`GET /v1/device`). The state
//! is a word, not an enum, in every answer: a newer host may add one, and an
//! older device must still read its record (the shell parses `DeviceInfo`
//! too).

use serde::{Deserialize, Serialize};

/// `details.constraint` of a `conflict` the license causes.
pub mod constraints {
    /// New shifts do not open: the license or the trial ran out, or the
    /// organization's INN is not the file's (`details.state`, `since`).
    pub const LICENSE_RESTRICTED: &str = "license_restricted";
    /// Every seat of a quota is taken (`details.quota`, `used`, `limit`).
    pub const SEAT_LIMIT: &str = "seat_limit";
    /// The license does not include the feature (`details.feature`).
    pub const FEATURE_DISABLED: &str = "feature_disabled";
    /// The emergency extension of this file (or of the trial) was used.
    pub const EMERGENCY_USED: &str = "emergency_used";
    /// New shifts open: there is nothing to extend.
    pub const EMERGENCY_NOT_NEEDED: &str = "emergency_not_needed";

    pub const ALL: &[&str] = &[
        LICENSE_RESTRICTED,
        SEAT_LIMIT,
        FEATURE_DISABLED,
        EMERGENCY_USED,
        EMERGENCY_NOT_NEEDED,
    ];
}

/// `details.reason` of a refused file (`validation_failed` on `file`) and of
/// the `denied` row of `license.load`, in the order the host checks (§4.3).
pub mod refusals {
    pub const MALFORMED: &str = "license_malformed";
    pub const UNKNOWN_KEY: &str = "license_unknown_key";
    pub const SIGNATURE: &str = "license_signature";
    pub const WRONG_HOST: &str = "license_wrong_host";
    pub const INN_MISMATCH: &str = "license_inn_mismatch";
    pub const INN_MISSING: &str = "license_inn_missing";
    pub const OLDER: &str = "license_older";

    pub const ALL: &[&str] = &[
        MALFORMED,
        UNKNOWN_KEY,
        SIGNATURE,
        WRONG_HOST,
        INN_MISMATCH,
        INN_MISSING,
        OLDER,
    ];
}

/// What an accepted file warns of (`warnings`).
pub mod warnings {
    /// The file's term ended already: it is kept, and new shifts need a newer one.
    pub const EXPIRED: &str = "expired";
    /// The file begins later: it waits for its `validFrom`.
    pub const NOT_YET_VALID: &str = "not_yet_valid";
    /// A quota is below what the site uses: nothing is disconnected, new
    /// additions are refused.
    pub const OVER_LIMIT: &str = "over_limit";

    pub const ALL: &[&str] = &[EXPIRED, NOT_YET_VALID, OVER_LIMIT];
}

/// The license states (spec §3.2).
pub mod states {
    pub const TRIAL: &str = "trial";
    pub const ACTIVE: &str = "active";
    pub const EXPIRING: &str = "expiring";
    pub const GRACE: &str = "grace";
    pub const RESTRICTED: &str = "restricted";
    pub const WRONG_HOST: &str = "wrong_host";
    pub const INN_MISMATCH: &str = "inn_mismatch";
    pub const TRIAL_EXPIRED: &str = "trial_expired";

    pub const ALL: &[&str] = &[
        TRIAL,
        ACTIVE,
        EXPIRING,
        GRACE,
        RESTRICTED,
        WRONG_HOST,
        INN_MISMATCH,
        TRIAL_EXPIRED,
    ];
}

/// `plan` of a file, and the built-in trial's in a preview.
pub mod plans {
    pub const TRIAL: &str = "trial";
    pub const DEMO: &str = "demo";
    pub const SUBSCRIPTION: &str = "subscription";

    pub const ALL: &[&str] = &[TRIAL, DEMO, SUBSCRIPTION];
}

/// The file's quota keys, as the cloud names them (`ENTITLEMENT_QUOTA_KEYS`).
pub const QUOTA_KEYS: [&str; 4] = ["lines", "stations", "kiosks", "cabinetUsers"];
/// The file's feature keys (`ENTITLEMENT_FEATURE_KEYS`).
pub const FEATURE_KEYS: [&str; 8] = [
    "labelEditor",
    "publicApi",
    "pallets",
    "chzIntegration",
    "inventory",
    "commerceMl",
    "handheld",
    "customLogo",
];

/// A quota: the file's limit (`None`: no limit), what the site uses, and
/// whether it uses more than the file allows. `u64`, as
/// `trust::LicenseQuotas`: the cloud allows limits up to 2^53 − 1, and a
/// valid signed file must never read as malformed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaUse {
    pub limit: Option<u64>,
    pub used: u64,
    pub over: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseQuotas {
    pub lines: QuotaUse,
    pub stations: QuotaUse,
    pub kiosks: QuotaUse,
    pub cabinet_users: QuotaUse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFeatures {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
    pub custom_logo: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseCustomer {
    pub name: String,
    pub inn: String,
}

/// The file in force.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseSummary {
    pub license_id: String,
    pub sequence: u64,
    pub kid: String,
    pub customer: LicenseCustomer,
    /// `demo` or `subscription`.
    pub plan: String,
    pub plan_version_id: String,
    pub issued_at: String,
    pub valid_from: String,
    /// Exclusive.
    pub valid_until: String,
    pub grace_days: u32,
}

/// The built-in trial: its start (the wizard), its end and the INN the
/// wizard took.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialInfo {
    pub started_at: String,
    pub ends_at: String,
    pub inn: Option<String>,
}

/// What the license is bound to: this host and the organization's INN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseBinding {
    pub host_id: String,
    pub fingerprint: String,
    pub org_inn: Option<String>,
    /// `None` without a file in force.
    pub inn_matches: Option<bool>,
}

/// The PC's clock as the host sees it (spec §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseFlags {
    /// Days the PC's clock is behind the last known time; `None` within a day.
    pub clock_behind_days: Option<u32>,
    /// The PC's clock is more than a day ahead of the time the host trusts.
    pub clock_ahead: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseEmergency {
    pub available: bool,
    /// The end of an emergency extension that runs now.
    pub until: Option<String>,
}

/// `GET /v1/office/license` (every office role), and the answer of a load
/// (with `warnings`) and of the emergency extension.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeLicense {
    /// One of [`states`].
    pub state: String,
    pub since: String,
    pub flags: LicenseFlags,
    pub effective_at: String,
    pub phase_ends_at: Option<String>,
    pub days_left: Option<u32>,
    pub warn_days: u32,
    /// New shifts open now (the state, or an emergency extension that runs).
    pub opens_new_shifts: bool,
    pub license: Option<LicenseSummary>,
    pub trial: Option<TrialInfo>,
    pub binding: LicenseBinding,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
    pub emergency: LicenseEmergency,
    /// What an accepted file warns of ([`warnings`]); empty and left out
    /// when there is nothing to say.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// One column of the preview's «было → станет».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseTerms {
    /// `None` for the built-in trial.
    pub license_id: Option<String>,
    pub sequence: Option<u64>,
    /// One of [`plans`].
    pub plan: String,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub grace_days: u32,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
}

/// `POST /v1/office/license/preview` (administrators): the file checked as a
/// load checks it, nothing written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicensePreview {
    pub before: LicenseTerms,
    pub after: LicenseTerms,
    /// `plan`, `validFrom`, `validUntil`, `graceDays`, `quotas.<key>`,
    /// `features.<key>` that differ, in that order.
    pub changes: Vec<String>,
    pub warnings: Vec<String>,
}

/// The license line of `GET /v1/device`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLicense {
    /// One of [`states`].
    pub state: String,
    pub since: String,
    pub phase_ends_at: Option<String>,
    /// New shifts open until then although the state says otherwise (§3.5).
    pub emergency_until: Option<String>,
}

/// `DeviceInfo.license`: a line of the wrong shape (a `null` time, a missing
/// field, a type of a newer host) reads as no line, so the device keeps its
/// record and the shell's `device_refresh` goes on.
pub(crate) fn device_license_or_none<'de, D>(
    deserializer: D,
) -> Result<Option<DeviceLicense>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// `POST /v1/office/license/preview` and `PUT /v1/office/license`: the text
/// of a `.mklic` file, at most 16 KiB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseLoadRequest {
    pub file: String,
}
