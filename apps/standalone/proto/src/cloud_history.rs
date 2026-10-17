//! Separate, bounded history contract. Hashes and canonical codes are redacted by `Secret`.
//! The first JSONL line is `CloudHistoryManifest`, then ordered `CloudHistoryPart`s.
use crate::{cloud_import::CloudImportSource, Secret};
use serde::{Deserialize, Serialize};

pub const CLOUD_HISTORY_FORMAT: &str = "markiro-cloud-history";
pub const CLOUD_HISTORY_FORMAT_VERSION: u32 = 1;
pub const MAX_HISTORY_PART_ROWS: usize = 5_000;
pub const MAX_HISTORY_PART_BYTES: usize = 4 * 1_048_576;
pub const MAX_HISTORY_MANIFEST_BYTES: usize = 1_048_576;
pub const MAX_HISTORY_PARTS: usize = 10_000;
pub const MAX_HISTORY_REQUEST_BYTES: usize = 8 * 1_048_576;

/// Dedicated imported read model; no local template/device identifiers are invented.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudShiftCard {
    pub source_time_zone: String,
    pub shift: CloudHistoryShift,
    pub code_count: u64,
    pub box_count: u64,
    pub pallet_count: u64,
    pub late_data_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudShiftPage {
    pub items: Vec<CloudShiftCard>,
    pub total: u64,
    pub page: u32,
    pub page_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBoxCard {
    pub source_time_zone: String,
    pub pack: CloudHistoryBox,
    pub shift_number: String,
    pub product_name: Option<String>,
    /// Declared production date only. Placards do not fall back to planned dates.
    pub production_date: Option<String>,
    pub units: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPalletRows {
    pub pallet: CloudHistoryPallet,
    pub organization: crate::ExportOrganization,
    pub boxes: Vec<CloudBoxCard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryManifest {
    pub format: String,
    pub format_version: u32,
    pub exported_at: String,
    pub since: String,
    pub source: CloudImportSource,
    pub organization: CloudHistoryOrganization,
    pub counts: CloudHistoryCounts,
    pub parts: Vec<CloudHistoryPartSummary>,
    pub checksum: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryOrganization {
    pub name: String,
    #[serde(deserialize_with = "required")]
    pub inn: Option<String>,
    pub gln: String,
    pub time_zone: String,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryCounts {
    pub shifts: u64,
    pub codes: u64,
    pub boxes: u64,
    pub items: u64,
    pub pallets: u64,
    pub owners: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPartSummary {
    pub index: u32,
    pub checksum: String,
    pub counts: CloudHistoryCounts,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPart {
    pub index: u32,
    pub payload: CloudHistoryPayload,
    pub checksum: String,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPayload {
    pub shifts: Vec<CloudHistoryShift>,
    pub codes: Vec<CloudHistoryCode>,
    pub boxes: Vec<CloudHistoryBox>,
    pub items: Vec<CloudHistoryItem>,
    pub pallets: Vec<CloudHistoryPallet>,
    pub owners: Vec<CloudHistoryOwner>,
}
impl CloudHistoryPayload {
    pub fn counts(&self) -> CloudHistoryCounts {
        CloudHistoryCounts {
            shifts: self.shifts.len() as u64,
            codes: self.codes.len() as u64,
            boxes: self.boxes.len() as u64,
            items: self.items.len() as u64,
            pallets: self.pallets.len() as u64,
            owners: self.owners.len() as u64,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryShift {
    pub id: String,
    pub number: String,
    pub mode: String,
    #[serde(deserialize_with = "required")]
    pub production_date: Option<String>,
    #[serde(deserialize_with = "required")]
    pub planned_date: Option<String>,
    #[serde(deserialize_with = "required")]
    pub opened_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub closed_at: Option<String>,
    pub product_id: String,
    #[serde(deserialize_with = "required")]
    pub product_name: Option<String>,
    pub gtin14: String,
    #[serde(deserialize_with = "required")]
    pub shelf_life_days: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub line_id: Option<String>,
    #[serde(deserialize_with = "required")]
    pub line_name: Option<String>,
    pub pallets_enabled: bool,
    pub in_window: bool,
    pub created_from: String,
    pub number_month_key: String,
    pub number_seq: u64,
    pub created_at: String,
    #[serde(deserialize_with = "required")]
    pub planned_qty: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub box_capacity: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub pallet_box_capacity: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub counterparty_id: Option<String>,
    #[serde(deserialize_with = "required")]
    pub counterparty_name: Option<String>,
    #[serde(deserialize_with = "required")]
    pub close_reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryCode {
    pub shift_id: String,
    pub hash: Secret,
    pub canonical: Secret,
    pub scanned_at: String,
    #[serde(deserialize_with = "required")]
    pub gtin14: Option<String>,
    #[serde(deserialize_with = "required")]
    pub serial: Option<Secret>,
    pub flat_only: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryBox {
    pub id: String,
    pub shift_id: String,
    #[serde(deserialize_with = "required")]
    pub sscc: Option<String>,
    pub opened_at: String,
    #[serde(deserialize_with = "required")]
    pub closed_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub disassembled_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub pallet_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryItem {
    pub box_id: String,
    pub hash: Secret,
    pub added_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryPallet {
    pub id: String,
    #[serde(deserialize_with = "required")]
    pub shift_id: Option<String>,
    pub kind: String,
    #[serde(deserialize_with = "required")]
    pub product_id: Option<String>,
    #[serde(deserialize_with = "required")]
    pub product_name: Option<String>,
    #[serde(deserialize_with = "required")]
    pub gtin14: Option<String>,
    #[serde(deserialize_with = "required")]
    pub shelf_life_days: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub sscc: Option<String>,
    pub opened_at: String,
    #[serde(deserialize_with = "required")]
    pub closed_at: Option<String>,
    #[serde(deserialize_with = "required")]
    pub disassembled_at: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryOwner {
    pub hash: Secret,
    pub shift_id: String,
    pub number: String,
    pub scanned_at: String,
    #[serde(deserialize_with = "required")]
    pub box_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryImportRequest {
    pub manifest: CloudHistoryManifest,
    pub part: CloudHistoryPart,
    pub dry_run: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryImportState {
    pub batch_id: String,
    pub source: CloudImportSource,
    pub status: CloudHistoryStatus,
    pub received_indices: Vec<u32>,
    pub total_parts: u32,
    pub counts: CloudHistoryCounts,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudHistoryStatus {
    Pending,
    Complete,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudHistoryCompleteRequest {
    pub batch_id: String,
}

/// Cancellation has the same bounded identity-only body; only pending batches may be removed.
pub type CloudHistoryCancelRequest = CloudHistoryCompleteRequest;

fn required<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
