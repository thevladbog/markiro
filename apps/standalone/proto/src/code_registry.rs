//! Additive read model for native journals and accepted imported snapshots.
use crate::code_search::{OfficeCodeCard, OfficeCodeItem};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CodeRegistrySource {
    #[default]
    All,
    Local,
    Cloud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudCodeState {
    Owned,
    Released,
    Historical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCodeItem {
    pub id: String,
    pub code_hash: String,
    pub canonical: Option<String>,
    pub gtin14: Option<String>,
    pub serial: Option<String>,
    pub scanned_at: String,
    pub source_time_zone: String,
    pub state: CloudCodeState,
    pub released_at: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub shift_available: bool,
    pub production_date: Option<String>,
    pub product_name: Option<String>,
    pub line_name: Option<String>,
    pub box_id: Option<String>,
    pub box_sscc: Option<String>,
    pub box_closed_at: Option<String>,
    pub box_disassembled_at: Option<String>,
    pub box_available: bool,
    pub pallet_id: Option<String>,
    pub pallet_sscc: Option<String>,
    pub pallet_disassembled_at: Option<String>,
    pub pallet_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", content = "item", rename_all = "snake_case")]
pub enum CodeRegistryItem {
    Local(OfficeCodeItem),
    Cloud(CloudCodeItem),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRegistryPage {
    pub items: Vec<CodeRegistryItem>,
    pub page: u32,
    pub page_count: u32,
    pub total: u32,
    pub capped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeRegistryCard {
    pub code_hash: String,
    pub local: Option<OfficeCodeCard>,
    pub cloud: Vec<CloudCodeItem>,
    pub cloud_capped: bool,
    pub current_owner: Option<CodeRegistryItem>,
}
