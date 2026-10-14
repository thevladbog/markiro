//! A box's and a pallet's cards and the list of every pallet of the site in
//! the office (plan КРТ, parity spec §5.3, the cloud's `GET
//! /code-search/boxes/:id`, `…/pallets/:id` and `GET /pallets`). Read only;
//! no full code travels here (a code is its GTIN and serial; its full text
//! is the code card's, `code_search`). `proto/fixtures/office-box-card.json`,
//! `office-pallet-card.json` and `office-pallet-page.json` hold the shapes
//! both sides read.

use serde::{Deserialize, Serialize};

use crate::code_search::CodePlacementState;
use crate::{ExceptionKind, PalletExceptionKind, ShiftStatus};

/// The most rows of one kind a card reads (`itemsCapped`, `membersCapped`).
pub const CARD_ROW_LIMIT: u32 = 10_000;
/// The rows of one page of the pallet list, the cloud's default `limit`.
pub const PALLET_PAGE_SIZE: u32 = 100;

/// The shift a box or a pallet belongs to, its product and line now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackShift {
    pub id: String,
    pub number: String,
    pub status: ShiftStatus,
    pub production_date: String,
    pub product_name: String,
    pub line_name: String,
}

/// The pallet a box joined when it closed; the link stays when either is
/// taken apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackPallet {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
}

/// One item of a box: the accepted scan that put its code there, where it
/// stands now (`removed` before `displaced`, as the cloud's `itemState`) and
/// when it left (`removed` the station's instant, `displaced` the host's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxItem {
    pub scan_id: String,
    pub code_hash: String,
    pub gtin14: String,
    pub serial: String,
    pub added_at: String,
    pub state: CodePlacementState,
    pub left_at: Option<String>,
    pub operator_name: Option<String>,
}

/// A station's exception of the box, oldest first: `codeHash` only for an
/// `undo`, a reason code only for `reprint` and `disassemble`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxException {
    pub id: String,
    pub kind: ExceptionKind,
    pub code_hash: Option<String>,
    pub reason_code: Option<String>,
    pub reason_text: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
    pub device_name: String,
    pub operator_name: Option<String>,
}

/// An applied disaggregation document that took the box or the pallet apart
/// (plan ДЗГ), named as `disaggregation::DisaggregationDocument` names it.
/// Empty until plan ДЗГ's tables exist (plan КРТ, task 8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePackDocument {
    pub id: String,
    /// `DSG-YY-NNNN`.
    pub doc_no: String,
    /// The host's instant of the apply.
    pub applied_at: String,
    pub reason_name: Option<String>,
    pub applied_by_name: Option<String>,
}

/// `GET /v1/office/boxes/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeBoxCard {
    pub id: String,
    pub sscc: Option<String>,
    pub shift: OfficePackShift,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    /// Live items now (neither taken out nor taken elsewhere).
    pub units: u32,
    pub item_count_reported: Option<u32>,
    pub digest_matches: Option<bool>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
    pub pallet: Option<OfficePackPallet>,
    /// Every item the box ever had, newest first.
    pub items: Vec<OfficeBoxItem>,
    pub items_capped: bool,
    pub exceptions: Vec<OfficeBoxException>,
    #[serde(default)]
    pub documents: Vec<OfficePackDocument>,
}

/// A box that joined the pallet, taken apart or not, closed newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletBox {
    pub id: String,
    pub sscc: Option<String>,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub units: u32,
}

/// A station's exception of the pallet, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletException {
    pub id: String,
    pub kind: PalletExceptionKind,
    pub reason_code: String,
    pub reason_text: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
    pub device_name: String,
    pub operator_name: Option<String>,
}

/// `GET /v1/office/pallets/{id}`: `boxes` and `units` as `OfficePallet`
/// derives them (closed boxes not taken apart, their live items).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletCard {
    pub id: String,
    pub sscc: Option<String>,
    pub shift: OfficePackShift,
    pub device_id: String,
    pub device_name: String,
    pub operator_name: Option<String>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
    pub print_verified_at: Option<String>,
    pub print_skipped_at: Option<String>,
    pub members: Vec<OfficePalletBox>,
    pub members_capped: bool,
    pub exceptions: Vec<OfficePalletException>,
    #[serde(default)]
    pub documents: Vec<OfficePackDocument>,
}

/// One row of `GET /v1/office/pallets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletRow {
    pub id: String,
    pub sscc: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub production_date: String,
    pub product_id: String,
    pub product_name: String,
    pub line_id: String,
    pub line_name: String,
    pub device_id: String,
    pub device_name: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub box_count_reported: Option<u32>,
}

/// A station the list can be narrowed to (`GET /v1/office/devices` is the
/// administrator's; the list is every office role's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletStation {
    pub id: String,
    pub name: String,
    pub revoked: bool,
}

/// One page of the list: open pallets first, then closed newest first;
/// `nextCursor` continues below the last row, `null` on the last page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletPage {
    pub items: Vec<OfficePalletRow>,
    pub next_cursor: Option<String>,
    pub stations: Vec<OfficePalletStation>,
}
