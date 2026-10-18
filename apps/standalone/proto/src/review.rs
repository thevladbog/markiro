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
    /// The scan's shift is closed: only a closed shift's box is taken apart
    /// (owner decision ПР-1; plan ДЗГ-О's «Расформировать короб»).
    pub shift_closed: bool,
    /// The scan's box was taken apart (by a station or a document); `false`
    /// without a box.
    pub box_disassembled: bool,
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

/// Who made an exception: a station's operator, or the office through an
/// applied disaggregation document (plan ДЗГ-О).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExceptionSource {
    Station,
    Office,
}

/// One exception of a shift's boxes or pallets: the box's or pallet's SSCC
/// (`null` for an open box), the serial of the code an undo took out, the
/// reason code (words only with `other`), the device's instant and the
/// host's. A station's exception names the station and its operator; an
/// office disassembly (`source: office`, always kind `disassemble`) names
/// the document, the office user who applied it and, as `reasonText`, the
/// document's reason, and has no device or operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftException {
    pub id: String,
    pub source: ExceptionSource,
    pub subject: ExceptionSubject,
    pub kind: ExceptionKind,
    pub subject_id: String,
    pub sscc: Option<String>,
    pub serial: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub operator_name: Option<String>,
    pub document_id: Option<String>,
    pub document_no: Option<String>,
    pub office_user_name: Option<String>,
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

/// The most scans one page of a shift's scan history lists.
pub const SCAN_HISTORY_PAGE_SIZE: u32 = 50;
/// The most a client may ask for in one page.
pub const SCAN_HISTORY_MAX_PAGE_SIZE: u32 = 100;

/// What the journal says about a scan of the work screen: `ok` — accepted
/// into a box (or a validation shift's list); `duplicate` — the code was
/// scanned before (`duplicateSource` says where); `wrong_gtin` — the code is
/// another product's; `invalid` — not a readable code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanHistoryVerdict {
    Ok,
    Duplicate,
    WrongGtin,
    Invalid,
}

impl ScanHistoryVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            ScanHistoryVerdict::Ok => "ok",
            ScanHistoryVerdict::Duplicate => "duplicate",
            ScanHistoryVerdict::WrongGtin => "wrong_gtin",
            ScanHistoryVerdict::Invalid => "invalid",
        }
    }
}

impl std::str::FromStr for ScanHistoryVerdict {
    type Err = String;
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text {
            "ok" => Ok(ScanHistoryVerdict::Ok),
            "duplicate" => Ok(ScanHistoryVerdict::Duplicate),
            "wrong_gtin" => Ok(ScanHistoryVerdict::WrongGtin),
            "invalid" => Ok(ScanHistoryVerdict::Invalid),
            other => Err(format!("unknown scan verdict {other}")),
        }
    }
}

/// One scan of a shift's history, as the office reads it
/// (`GET /v1/office/shifts/{id}/scans`). The code never travels whole: only
/// its GTIN and the last characters of its serial (`serialTail`, at most
/// four), and `null` for both when the scan was no readable code. A box and a
/// pallet come with their SSCC (`null` while open or not yet closed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeScanHistoryItem {
    pub id: String,
    pub scanned_at: String,
    pub received_at: String,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub verdict: ScanHistoryVerdict,
    /// `local` — the station's own journal knew the code; `host` — the host's.
    pub duplicate_source: Option<String>,
    pub gtin14: Option<String>,
    pub serial_tail: Option<String>,
    pub box_id: Option<String>,
    pub box_sscc: Option<String>,
    pub pallet_id: Option<String>,
    pub pallet_sscc: Option<String>,
}

/// A page of a shift's scans, newest first. `nextCursor` is opaque: send it
/// back as `cursor` for the next page; `null` on the last one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeScanHistoryPage {
    pub items: Vec<OfficeScanHistoryItem>,
    pub next_cursor: Option<String>,
}

/// An export of a shift the office saved (`shift.export` in the audit trail), as
/// `GET /v1/office/shifts/{id}/exports` lists it: when, by whom (the office user's
/// name now, `None` when the user is gone), and the record of `ShiftExportRecord`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftExport {
    pub id: i64,
    pub recorded_at: String,
    pub user_name: Option<String>,
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
    /// The files the export stored on the host (migration `0029`), by part;
    /// none for an export made before files were stored.
    pub files: Vec<crate::export_files::ExportFile>,
}

/// The shift's saved exports, newest first, at most `SHIFT_EXPORT_HISTORY_LIMIT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeShiftExports {
    pub items: Vec<OfficeShiftExport>,
}

/// The exports one `GET /v1/office/shifts/{id}/exports` answers at most.
pub const SHIFT_EXPORT_HISTORY_LIMIT: u32 = 50;

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
