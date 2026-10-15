//! The handheld's side of the host protocol (plan ТСД-П, spec 6.4, 6.5, 7): the events of a
//! warehouse pallet outside a shift, the registry of closed boxes, the organization to print and
//! the office's list of warehouse pallets. Requests reject unknown fields and responses tolerate
//! them (`lib.rs`); each shape has a fixture in `fixtures/`.

use serde::{Deserialize, Serialize};

use crate::{parse_variant, LabelOutcome, ShiftSnapshotLogo, UnknownVariant};

/// What a record of `POST /v1/device/pallet-events` says (spec 6.4.1). The list is open: a kind
/// added later raises the protocol version, as a new fact kind does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PalletEventKind {
    /// A handheld began a pallet of one product.
    WarehousePalletOpened,
    /// A closed box went onto the open pallet.
    PalletBoxAdded,
    /// A box was taken back off the open pallet.
    PalletBoxRemoved,
    /// The pallet closed with an SSCC of the handheld's pallet block.
    WarehousePalletClosed,
    /// The check of a closed pallet's label.
    WarehousePalletLabel,
}

impl PalletEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PalletEventKind::WarehousePalletOpened => "warehouse_pallet_opened",
            PalletEventKind::PalletBoxAdded => "pallet_box_added",
            PalletEventKind::PalletBoxRemoved => "pallet_box_removed",
            PalletEventKind::WarehousePalletClosed => "warehouse_pallet_closed",
            PalletEventKind::WarehousePalletLabel => "warehouse_pallet_label",
        }
    }
}

impl std::str::FromStr for PalletEventKind {
    type Err = UnknownVariant;

    /// The name [`PalletEventKind::as_str`] gives, as `device_event_receipts.kind` stores it.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("pallet event kind", text)
    }
}

/// One record of a handheld's outbox for events outside a shift: `id` is a lower-case hyphenated
/// UUID the device made up, which keys the receipt; `data` is read by `kind`. `operatorId` is the
/// operator's UUID or `null` (evidence, no foreign key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PalletEventRecord {
    pub id: String,
    pub kind: PalletEventKind,
    #[serde(default)]
    pub operator_id: Option<String>,
    pub data: serde_json::Value,
}

/// `POST /v1/device/pallet-events`: 1-100 records, applied in their order; the answer is
/// `FactReceipts`, one receipt per record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletEventBatch {
    pub records: Vec<PalletEventRecord>,
}

/// `data` of `warehouse_pallet_opened`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletOpenedData {
    pub pallet_id: String,
    pub product_id: String,
    pub opened_at: String,
}

/// `data` of `pallet_box_added`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletBoxAddedData {
    pub pallet_id: String,
    pub box_sscc: String,
    pub added_at: String,
}

/// `data` of `pallet_box_removed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletBoxRemovedData {
    pub pallet_id: String,
    pub box_sscc: String,
    pub removed_at: String,
}

/// `data` of `warehouse_pallet_closed`: the SSCC of serial `serial` from the pallet block
/// (extension 1) `blockId` the host issued to this device, and how many boxes the device counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletClosedData {
    pub pallet_id: String,
    pub sscc: String,
    pub block_id: String,
    pub serial: u64,
    pub opened_at: String,
    pub closed_at: String,
    pub box_count: u32,
}

/// `data` of `warehouse_pallet_label`: the check of a closed pallet's label, as a box's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WarehousePalletLabelData {
    pub pallet_id: String,
    pub outcome: LabelOutcome,
    pub at: String,
}

/// What a registry item says about its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoxRegistryKind {
    /// The box is closed and stands as the other fields say.
    Upsert,
    /// The box was taken apart: a handheld forgets it.
    Remove,
}

/// One change of the registry of closed boxes (`GET /v1/device/box-registry`). The names are the
/// cloud's `BoxRegistryItemDto`, so a handheld reads both with one mirror. `updatedAt` is the
/// host's time of the change. `bottleCount` is the units the box held when it closed. A box on a
/// pallet names it: `palletSscc` is `null` while that pallet is open. A removal carries only
/// `kind`, `sscc` and `updatedAt`. No code of a unit is ever in an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxRegistryItem {
    pub kind: BoxRegistryKind,
    pub sscc: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottle_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_sscc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub production_date: Option<String>,
}

impl BoxRegistryItem {
    /// The removal of the box `sscc`.
    pub fn remove(sscc: String, updated_at: String) -> Self {
        Self {
            kind: BoxRegistryKind::Remove,
            sscc,
            updated_at,
            box_id: None,
            product_id: None,
            bottle_count: None,
            pallet_id: None,
            pallet_sscc: None,
            pallet_active: None,
            closed_at: None,
            production_date: None,
        }
    }
}

/// A page of the registry. Every page of one walk repeats the `until` the first page named; the
/// next walk asks `since=<until>`. `restoreEpoch` is the host's, so a handheld that sees it
/// change drops the mirror and walks again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxRegistryPage {
    pub until: String,
    pub items: Vec<BoxRegistryItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_epoch: Option<String>,
}

/// `GET /v1/device/org/print`: what a device prints about the organization when no shift is open.
/// `logo` is the print logo when the license has `customLogo`, else `null` (the bundled one
/// prints). `issuerPrefix` is the first nine digits of the organization's GLN.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgPrint {
    pub name: String,
    pub inn: Option<String>,
    pub issuer_prefix: String,
    pub logo: Option<ShiftSnapshotLogo>,
}

/// A warehouse pallet in the office's list (`GET /v1/office/warehouse-pallets`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePallet {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub product_id: String,
    pub product_name: String,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub sscc: Option<String>,
    /// The boxes standing on it now.
    pub boxes: u32,
    /// The count the handheld reported at the close.
    pub box_count_reported: Option<u32>,
}

/// The answer of `GET /v1/office/warehouse-pallets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePallets {
    pub pallets: Vec<OfficeWarehousePallet>,
}
