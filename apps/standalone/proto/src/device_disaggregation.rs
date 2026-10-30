//! Handheld disaggregation of any local pack of this site. No marking codes leave the host.
use crate::disaggregation::DisaggregationLineStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackKind {
    Box,
    Pallet,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackLookup {
    pub sscc: String,
    pub operator_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackReason {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInspection {
    pub sscc: String,
    pub kind: PackKind,
    pub product_name: String,
    pub boxes: u32,
    pub units: u64,
    pub status: DisaggregationLineStatus,
    pub token: String,
    pub reasons: Vec<PackReason>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackDisassemble {
    pub request_id: String,
    pub sscc: String,
    pub operator_id: String,
    pub reason_id: String,
    pub expected_token: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackDisassembled {
    pub document_id: String,
    pub doc_no: String,
    pub sscc: String,
    pub kind: PackKind,
    pub boxes: u32,
    pub codes: u64,
    pub applied_at: String,
}
