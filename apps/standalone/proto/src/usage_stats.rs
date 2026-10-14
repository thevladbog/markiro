//! Usage statistics for the support bundle (beta 3 feedback: «в сведения для
//! поддержки надо ещё добавлять статистические данные — разбивку по месяцам
//! смен в каждом режиме, сканирований, коробов, паллет, ошибок»):
//! `GET /v1/office/usage-stats`, administrators only, read-only.
//!
//! The answer holds counts and nothing else: no code, no hash, no SSCC, no
//! name of a person, product, counterparty or line, no PIN or badge. Every
//! field is an unsigned count; the only text is the month key. The host
//! builds it from grouped, indexed queries over the last twelve calendar
//! months, so what leaves the machine cannot grow with the data. The
//! webview encrypts it for the recipient's public key before it goes into
//! the support text (`src/office/info/support-crypto.ts`).
//!
//! A shift's rows (its scans, boxes, pallets, exceptions, unit labels and
//! refused records) belong to the month of the shift's own date
//! (`shifts.planned_date`, the working day); the host's own instants (a
//! conflict's detection, a document's application, a warehouse reprint) to
//! the UTC month of the instant. `proto/fixtures/usage-stats.json` holds the
//! shape both sides read.

use serde::{Deserialize, Serialize};

/// How many calendar months the answer holds, the current one last.
pub const USAGE_MONTHS: usize = 12;

/// Shifts of a month by what they are. `aggregation` and `validation` add up
/// to every shift of the month; `validationPrint` counts the validation shifts
/// that print the Data Matrix duplicate; `fromOffice` and `fromStation` add up
/// to the same total again; `withPallets` counts the aggregation shifts that
/// collect pallets.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageShifts {
    pub aggregation: u64,
    pub validation: u64,
    pub validation_print: u64,
    pub from_office: u64,
    pub from_station: u64,
    pub with_pallets: u64,
}

/// Scans of the month's shifts by the host's verdict: `accepted` took the
/// code, `duplicates` met it already, `rejected` was no code of the shift's
/// product (a wrong GTIN) or none at all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageScans {
    pub accepted: u64,
    pub duplicates: u64,
    pub rejected: u64,
}

/// Boxes closed in the month's shifts, how many of them were taken apart
/// since, and the codes their stations reported in them (the average codes
/// per box is `codes / closed`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageBoxes {
    pub closed: u64,
    pub disassembled: u64,
    pub codes: u64,
}

/// Pallets closed in the month's shifts and how many were taken apart since.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsagePallets {
    pub closed: u64,
    pub disassembled: u64,
}

/// Exceptions of the month's shifts by kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageExceptions {
    pub box_undo: u64,
    pub box_clear: u64,
    pub box_reprint: u64,
    pub box_disassemble: u64,
    pub pallet_reprint: u64,
    pub pallet_disassemble: u64,
}

/// Code conflicts the host detected in the month: `late` (a record that came
/// after an earlier scan of the code), `displaced` (a scan an earlier one
/// took the code from) and how many of both the office has reviewed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageConflicts {
    pub late: u64,
    pub displaced: u64,
    pub reviewed: u64,
}

/// Labels printed again: warehouse reprints recorded in the month, and the
/// reprints of a validation shift's duplicate labels in the month's shifts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageReprints {
    pub warehouse: u64,
    pub unit_label: u64,
}

/// One calendar month, `month` as `YYYY-MM`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageMonth {
    pub month: String,
    pub shifts: UsageShifts,
    pub scans: UsageScans,
    pub boxes: UsageBoxes,
    pub pallets: UsagePallets,
    pub exceptions: UsageExceptions,
    pub conflicts: UsageConflicts,
    pub reprints: UsageReprints,
    /// Disaggregation documents applied in the month.
    pub disaggregation_applied: u64,
    /// Records of the month's shifts the host refused (a sync error the
    /// station keeps retrying or quarantines).
    pub sync_rejected: u64,
}

/// Paired devices that are not revoked, by kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageDevices {
    pub station: u64,
    pub office: u64,
    pub handheld: u64,
}

/// The answer of `GET /v1/office/usage-stats`: [`USAGE_MONTHS`] months, the
/// oldest first and the current one last, empty months included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageStats {
    pub months: Vec<UsageMonth>,
    pub devices: UsageDevices,
}

impl UsageMonth {
    /// A month with nothing in it.
    pub fn empty(month: String) -> Self {
        Self {
            month,
            shifts: UsageShifts::default(),
            scans: UsageScans::default(),
            boxes: UsageBoxes::default(),
            pallets: UsagePallets::default(),
            exceptions: UsageExceptions::default(),
            conflicts: UsageConflicts::default(),
            reprints: UsageReprints::default(),
            disaggregation_applied: 0,
            sync_rejected: 0,
        }
    }
}
