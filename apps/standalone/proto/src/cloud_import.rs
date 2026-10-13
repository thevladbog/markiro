//! `POST /v1/office/import`: the cloud's data moved into a new site (plan
//! IMP, pilot spec §8). The export tool (`tools/standalone-export`) writes a
//! file whose `payload` is [`CloudImportPayload`] exactly; the office checks
//! the file's checksum and sends this request, built from the file as
//! `{ importId, dryRun, formatVersion, exportedAt, rehearsal, source, payload }`.
//! There is no request fixture of its own: the tests build it from
//! `cloud-export-file.json`, which the tool builds from its raw fixture, so
//! the two cannot drift apart. The answer's fixture is
//! `cloud-import-summary.json`.
//!
//! The request carries PIN and badge hashes and the badge salt as
//! [`Secret`]s: a `{:?}` of it prints none of them.

use serde::{Deserialize, Serialize};

use crate::{CategoryTemplateDefaultInput, Secret, TemplatePurpose};

/// The import file's `formatVersion` the tool writes: 2 since plan ТОВ (a
/// product's EGAIS code and default counterparty).
pub const CLOUD_IMPORT_FORMAT_VERSION: u32 = 2;

/// Every `formatVersion` this build reads: a file of format 1, already made
/// at a client's, stays good (its products carry neither new field).
pub const CLOUD_IMPORT_FORMAT_VERSIONS: [u32; 2] = [1, 2];

/// The import, or its trial (`dryRun`: every check and every write, then a
/// rollback). `importId`, a lower-case hyphenated UUID the office makes up
/// once per file, makes it repeatable: the same id after a lost answer gets
/// the stored summary back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportRequest {
    pub import_id: String,
    pub dry_run: bool,
    pub format_version: u32,
    /// When the tool read the cloud (RFC 3339), for the audit row.
    pub exported_at: String,
    /// A rehearsal file (made while the cloud was not clean): the audit
    /// row says so.
    pub rehearsal: bool,
    pub source: CloudImportSource,
    pub payload: CloudImportPayload,
}

/// Which cloud tenant the file came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportSource {
    pub tenant_id: String,
    pub tenant_name: String,
}

/// Everything that moves (pilot spec §8.2). Ids are the cloud's UUIDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudImportPayload {
    /// The site's organization must have this GLN; nothing else of it is
    /// written (the wizard and «Организация» own the profile).
    pub organization: CloudOrganization,
    /// The tenant's badge salt (16 bytes, standard base64 with padding): it
    /// becomes the site's, so the badges' hashes move as they are (§8.3).
    pub badge_salt: Option<Secret>,
    pub lines: Vec<CloudLine>,
    pub counterparties: Vec<CloudCounterparty>,
    pub templates: Vec<CloudTemplate>,
    pub template_defaults: CloudTemplateDefaults,
    pub products: Vec<CloudProduct>,
    pub operators: Vec<CloudOperator>,
    pub badges: Vec<CloudBadge>,
    /// Where the standalone's counters start (forward only).
    pub sscc_counters: Vec<CloudSsccCounter>,
    /// The cloud's last shift number of each month (forward only).
    pub shift_number_counters: Vec<CloudShiftNumberCounter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudOrganization {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudLine {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudCounterparty {
    pub id: String,
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTemplate {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub chz_product_group_codes: Option<Vec<u32>>,
    pub spec: serde_json::Value,
}

/// The organization's box and pallet defaults (`null` keeps the wizard's)
/// and the category defaults; the cloud has no product-duplicate default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTemplateDefaults {
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub categories: Vec<CategoryTemplateDefaultInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudProduct {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub chz_product_group_code: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    /// The EGAIS code (plan ТОВ, format 2): only with ЧЗ group 15.
    #[serde(default)]
    pub egais_code: Option<String>,
    /// A counterparty of the same file (plan ТОВ, format 2).
    #[serde(default)]
    pub default_counterparty_id: Option<String>,
    pub archived: bool,
}

/// An operator with the cloud's PIN hash, byte for byte (§8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudOperator {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub pin_phc: Secret,
    pub active: bool,
}

/// A badge in use, hashed under [`CloudImportPayload::badge_salt`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudBadge {
    pub id: String,
    pub operator_id: String,
    pub badge_phc: Secret,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudSsccCounter {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudShiftNumberCounter {
    pub month_key: String,
    pub last_seq: u32,
}

/// The answer: what the import wrote (or, for `dryRun`, would write), and
/// the counters as they stand after it. `repeated` is a repeat of an import
/// already done, answered from its audit row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudImportSummary {
    pub dry_run: bool,
    pub repeated: bool,
    pub lines_created: u32,
    /// File lines whose name an active line of the site already has (the
    /// wizard's): kept as they are, not created again.
    pub lines_present: u32,
    pub counterparties: u32,
    pub templates: u32,
    /// How many of the organization's two defaults the file set.
    pub org_defaults: u32,
    pub category_defaults: u32,
    pub products: u32,
    pub operators: u32,
    pub badges: u32,
    /// The site's badge salt became the file's.
    pub badge_salt_replaced: bool,
    pub sscc_counters: Vec<SsccCounterValue>,
    pub shift_number_counters: Vec<ShiftNumberCounterValue>,
}

/// A counter of the file as it stands after the import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsccCounterValue {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

/// A month of the file as its counter stands after the import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftNumberCounterValue {
    pub month_key: String,
    pub last_seq: u32,
}
