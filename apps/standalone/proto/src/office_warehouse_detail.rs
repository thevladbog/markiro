//! Warehouse pallet card: real member shifts, with no invented production shift.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePalletOrganization {
    pub name: String,
    pub inn: Option<String>,
    pub time_zone: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePalletMember {
    pub membership_id: String,
    pub id: String,
    pub sscc: String,
    pub shift_id: String,
    pub shift_number: String,
    pub production_date: String,
    pub units: u32,
    pub disassembled_at: Option<String>,
    pub removed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWarehousePalletDetail {
    pub id: String,
    pub sscc: Option<String>,
    pub source: String,
    pub demo: bool,
    pub created_by_name: Option<String>,
    pub device_name: String,
    pub product_id: String,
    pub product_name: String,
    pub gtin14: String,
    pub shelf_life_days: Option<u32>,
    pub opened_at: String,
    pub closed_at: Option<String>,
    pub disassembled_at: Option<String>,
    pub boxes: u32,
    pub units: u32,
    pub organization: OfficeWarehousePalletOrganization,
    pub members: Vec<OfficeWarehousePalletMember>,
}
