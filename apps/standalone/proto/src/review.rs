//! The office's review of production (plan КНФ, parity spec §5.2): the code
//! conflicts the facts have written since stage 2a (`GET /v1/office/conflicts`,
//! `POST …/{id}/review`), a shift's exceptions and its refused records
//! (`GET /v1/office/shifts/{id}/exceptions`, `…/rejections`). The full code
//! never travels this way: a conflict names its code by hash, GTIN and serial.
//! Answers are lenient (a field a newer host adds is tolerated; the webview
//! also reads a refused record's `kind` as any text, where this crate keeps
//! the kinds it knows — the host stores no other);
//! `proto/fixtures/office-{conflict-page,shift-exceptions,shift-rejections}.json`
//! hold the shapes both sides read.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{CodeOwner, ExceptionKind, FactKind};

/// The rows of one page of conflicts.
pub const CONFLICT_PAGE_SIZE: u32 = 50;
/// The last page the list reaches (10 000 conflicts).
pub const CONFLICT_MAX_PAGE: u32 = 200;
/// The most exceptions, and the most refused records, one answer lists for a
/// shift, newest first; `total` counts them all.
pub const SHIFT_REVIEW_LIMIT: u32 = 500;

/// How the loser lost its code: `late` — it arrived after the owner's scan
/// and was scanned later (its receipt said `conflict`); `displaced` — it
/// owned the code, and an earlier scan that arrived later took it (its
/// receipt had said `accepted`, its item left its box).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    Late,
    Displaced,
}

impl ConflictKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictKind::Late => "late",
            ConflictKind::Displaced => "displaced",
        }
    }
}

impl std::str::FromStr for ConflictKind {
    type Err = String;
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "late" => Ok(ConflictKind::Late),
            "displaced" => Ok(ConflictKind::Displaced),
            other => Err(format!("unknown conflict kind {other}")),
        }
    }
}

/// One side of a conflict: the scan, its shift with its number, the device
/// with its name, the operator (when the scan named one), the device's
/// instant, and the box with its SSCC (`null` while the box is open; no box
/// at all for a scan of a validation shift).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflictScan {
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub scanned_at: String,
    pub box_id: Option<String>,
    pub box_sscc: Option<String>,
}

/// One conflict: two accepted scans of one code; the earlier won it.
/// `detectedAt` and `reviewedAt` are the host's instants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflict {
    pub id: String,
    pub kind: ConflictKind,
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub loser: OfficeConflictScan,
    pub winner: OfficeConflictScan,
    pub detected_at: String,
    pub reviewed_at: Option<String>,
    pub reviewed_by_name: Option<String>,
}

/// One page of conflicts, newest detection first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConflictPage {
    pub items: Vec<OfficeConflict>,
    pub page: u32,
    pub page_count: u32,
    pub total: u32,
}

/// What an exception was made on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionSubject {
    Box,
    Pallet,
}

/// One exception of a shift's boxes or pallets as the station sent it: the
/// box's or pallet's SSCC (`null` for an open box), the serial of the code an
/// undo took out, the reason code (words only with `other`), the station
/// and its operator, the device's instant and the host's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftException {
    pub id: String,
    pub subject: ExceptionSubject,
    pub kind: ExceptionKind,
    pub subject_id: String,
    pub sscc: Option<String>,
    pub serial: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftExceptions {
    pub items: Vec<OfficeShiftException>,
    pub total: u32,
}

/// One record of the shift the host refused, as its receipt keeps it: the
/// record's kind, the receipt's code and details (the field of an
/// `invalid_record`), the device and the host's instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftRejection {
    pub record_id: String,
    pub kind: Option<FactKind>,
    pub code: String,
    pub details: Option<Map<String, Value>>,
    pub device_id: String,
    pub device_name: String,
    pub received_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftRejections {
    pub items: Vec<OfficeShiftRejection>,
    pub total: u32,
}

/// The most records one `POST /v1/device/conflicts/status` names.
pub const MAX_CONFLICT_STATUS_RECORDS: usize = 200;
/// The displacements one `GET /v1/device/displacements` answers at most.
pub const DISPLACEMENT_PAGE_SIZE: u32 = 100;

/// `POST /v1/device/conflicts/status` (plan КНФ, the cloud's
/// `/station/conflicts/status`): the station's records whose conflict or
/// displacement nobody has resolved yet, by id. Strict, like every request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConflictStatusRequest {
    pub record_ids: Vec<String>,
}

/// One of the asked records whose conflict the office marked reviewed, with
/// the host's instant of that review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewedRecord {
    pub record_id: String,
    pub reviewed_at: String,
}

/// Of the asked records, those the office reviewed; the device's own only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStatusResponse {
    pub reviewed: Vec<ReviewedRecord>,
}

/// A scan of this device an earlier scan elsewhere took the code from (a
/// `displaced` conflict): its record, shift, code hash and box, when the host
/// saw it, the winner as a `conflict` receipt names one, and whether the
/// office reviewed it already; with the shift's number and the box's SSCC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDisplacement {
    pub conflict_id: String,
    pub record_id: String,
    pub shift_id: String,
    /// The losing shift's number, which the station keeps with the row so it
    /// stays readable after its own copy of the shift is gone.
    pub shift_number: String,
    pub code_hash: String,
    pub box_id: Option<String>,
    /// The box's SSCC on the host (`null` while the host has it open), kept
    /// the same way.
    pub box_sscc: Option<String>,
    pub detected_at: String,
    pub winner: CodeOwner,
    pub reviewed_at: Option<String>,
}

/// One page of a device's displacements, oldest detection first after the
/// cursor it sent; `more` when another page follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDisplacements {
    pub items: Vec<DeviceDisplacement>,
    pub more: bool,
}
