//! Code search in the office (the owner's beta feedback «Поиск кодов», the
//! cloud's `code-search` for a single site): `GET /v1/office/codes` lists the
//! placements of codes in boxes — one row for every accepted scan that put
//! a code into a box, and since plan РЕЖ for every accepted scan of a
//! validation shift that took its code without a box — by the hash of a
//! code, a GTIN, the SSCC of a box or a pallet, a shift's number and a period
//! of scan instants; `GET
//! /v1/office/codes/{codeHash}` is one code's card with its history. Only
//! what the facts of this host hold is found: the cloud's history does not
//! move with the cloud import. `proto/fixtures/office-code-*.json` hold the
//! shapes both sides read.

use serde::{Deserialize, Serialize};

use crate::{DuplicateSource, ExceptionKind, ScanVerdict, ShiftStatus};

/// The rows of one page of a search (`OfficeCodePage::items`).
pub const CODE_PAGE_SIZE: u32 = 50;
/// The most rows a search counts: a search that matches more is narrowed,
/// not paged through (`OfficeCodePage::capped`).
pub const CODE_SEARCH_CAP: u32 = 10_000;

/// Where a placement stands now: in a box still open, in a closed box,
/// taken out by an exception (`undo`, `clear`, a disassembly), taken by an
/// earlier scan of the same code elsewhere, or accepted by a validation
/// shift without a box and still its own (`checked`, plan РЕЖ).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodePlacementState {
    OpenBox,
    Packed,
    Removed,
    Displaced,
    Checked,
}

/// One placement of a code in a box: the accepted scan that put it there,
/// the box and its pallet, the shift with its number, product and line, the
/// station and its operator. `leftAt` is the instant the code left the box
/// (`removed` the station's, `displaced` the host's), else `null`. An
/// accepted scan of a validation shift has no box: `boxId` and every box and
/// pallet field are `null`, its state `checked` or `displaced`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCodeItem {
    pub scan_id: String,
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub scanned_at: String,
    pub state: CodePlacementState,
    pub left_at: Option<String>,
    pub box_id: Option<String>,
    pub box_sscc: Option<String>,
    pub box_closed_at: Option<String>,
    pub box_disassembled_at: Option<String>,
    pub pallet_id: Option<String>,
    pub pallet_sscc: Option<String>,
    pub pallet_disassembled_at: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub shift_status: ShiftStatus,
    pub production_date: String,
    pub product_name: String,
    pub line_name: String,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
}

/// One page of a search, newest scan first. `total` counts the matches up
/// to [`CODE_SEARCH_CAP`]; `capped` says there are more than that.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCodePage {
    pub items: Vec<OfficeCodeItem>,
    pub page: u32,
    pub page_count: u32,
    pub total: u32,
    pub capped: bool,
}

/// One event of a code's history, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OfficeCodeEvent {
    /// A scan of the code on the work screen, whatever the verdict.
    /// `placed` says an accepted scan took the code (into its box, or
    /// without one in a validation shift); an accepted scan that lost the
    /// code to an earlier one did not.
    Scan {
        at: String,
        scan_id: String,
        verdict: ScanVerdict,
        duplicate_source: Option<DuplicateSource>,
        shift_id: String,
        shift_number: String,
        device_name: String,
        operator_name: Option<String>,
        box_id: Option<String>,
        placed: bool,
    },
    /// The code taken out of its box by an exception; `exception` is
    /// `null` when the host holds no exception of that instant. An office
    /// disassembly (plan ДЗГ-О) is `disassemble` with no operator: the
    /// document, the office user who applied it and, as `reason_text`, the
    /// document's reason.
    Removed {
        at: String,
        box_id: String,
        box_sscc: Option<String>,
        exception: Option<ExceptionKind>,
        reason_code: Option<String>,
        reason_text: Option<String>,
        operator_name: Option<String>,
        document_id: Option<String>,
        document_no: Option<String>,
        office_user_name: Option<String>,
    },
    /// The code taken from its box, or from a validation shift's scan
    /// (`boxId` `null`), by an earlier scan elsewhere (`at` is the host's
    /// instant).
    Displaced {
        at: String,
        box_id: Option<String>,
        box_sscc: Option<String>,
    },
    /// The unit's code printed again on a warehouse station (plan СКЛ).
    Reprint {
        at: String,
        outcome: String,
        reason_code: String,
        device_name: String,
        operator_name: Option<String>,
    },
}

/// A code's card: what it is, the scan that owns it now (`null` while it
/// is free), every placement of it in a box (newest first) and its history.
/// `canonical` is the text of its latest scan, with the group separators
/// and the crypto tail the station kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCodeCard {
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub canonical: String,
    pub owner_scan_id: Option<String>,
    pub placements: Vec<OfficeCodeItem>,
    pub events: Vec<OfficeCodeEvent>,
}
