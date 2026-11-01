//! Additive office-only, read-only global search. Raw marking codes never cross this boundary.
use serde::{Deserialize, Serialize};

pub const SEARCH_LIMIT: usize = 50;
pub const MAX_TEXT_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OfficeSearchRequest {
    #[serde(rename_all = "camelCase")]
    Code {
        code_hash: String,
    },
    Sscc {
        sscc: String,
    },
    Gtin {
        gtin14: String,
    },
    Shift {
        id: String,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    Local,
    Cloud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentTargetType {
    Shift,
    Box,
    Pallet,
    WarehousePallet,
    DisaggregationDocument,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OfficeSearchTarget {
    Shift {
        id: String,
        source: SearchSource,
    },
    Box {
        id: String,
        source: SearchSource,
    },
    Pallet {
        id: String,
        source: SearchSource,
    },
    WarehousePallet {
        id: String,
    },
    Product {
        id: String,
    },
    Disaggregation {
        id: String,
    },
    #[serde(rename_all = "camelCase")]
    Code {
        code_hash: String,
        source: SearchSource,
    },
    #[serde(rename_all = "camelCase")]
    Document {
        id: String,
        target_type: DocumentTargetType,
        target_id: String,
        source: SearchSource,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSearchItem {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub target: OfficeSearchTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeSearchResponse {
    pub items: Vec<OfficeSearchItem>,
    pub truncated: bool,
}
