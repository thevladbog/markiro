//! Office-only warehouse pallet creation. No device fact/protocol change.
use serde::{Deserialize, Serialize};

pub const MAX_PALLET_BOXES: usize = 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficePalletValidate {
    pub codes: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficePalletCreate {
    pub request_id: String,
    pub codes: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletInputError {
    pub line: usize,
    pub code: String,
    pub sscc: Option<String>,
    pub pallet_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pallet_kind: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletValidation {
    pub valid: bool,
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    pub boxes: u32,
    pub units: u64,
    pub errors: Vec<OfficePalletInputError>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePalletCreated {
    pub id: String,
    pub sscc: String,
}

/// Rust counterpart of domain's parseScannedSscc, pinned by office-pallet-sscc.json.
/// The request trims ECMAScript whitespace; scanner wrappers are otherwise unchanged.
pub fn normalize_sscc(raw: &str) -> Option<String> {
    let raw = raw.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    if raw.len() > 25 {
        return None;
    }
    let raw = raw.strip_prefix("]C1").unwrap_or(raw);
    let raw = if let Some(rest) = raw.strip_prefix("(00)") {
        rest
    } else if raw.len() == 20 {
        raw.strip_prefix("00")?
    } else {
        raw
    };
    if raw.len() != 18 || !raw.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let body = &raw[..17];
    (check_digit(body) == raw.as_bytes()[17] - b'0').then(|| raw.to_owned())
}

fn check_digit(body: &str) -> u8 {
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, c)| u32::from(c - b'0') * if i % 2 == 0 { 3 } else { 1 })
        .sum();
    ((10 - sum % 10) % 10) as u8
}

/// Domain's buildSscc for the office's extension-1 counter. Callers validate the prefix/serial.
pub fn build_pallet_sscc(prefix: &str, serial: u64) -> Option<String> {
    if !(4..=12).contains(&prefix.len()) || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let width = 16 - prefix.len();
    if serial >= 10u64.pow(width as u32) {
        return None;
    }
    let body = format!("1{prefix}{serial:0width$}");
    Some(format!("{body}{}", check_digit(&body)))
}
