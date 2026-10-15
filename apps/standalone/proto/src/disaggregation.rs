//! The wire of office disaggregation documents (plan ДЗГ, parity spec §5.1):
//! the documents, their lines, the reasons' dictionary, and the feed record
//! that tells stations whose codes a document freed. The cloud's
//! `apps/api/src/modules/disaggregation/dto.ts` and
//! `disaggregation-reasons/dto.ts` are the reference: the same statuses,
//! minus `written_off`, which only the cloud's pickup produces. Responses
//! tolerate unknown fields; requests refuse them.
//! `proto/fixtures/disaggregation-*.json` and `changes-code-releases.json`
//! hold the shapes both sides read.

use serde::{Deserialize, Serialize};

use super::{parse_variant, BoxReportItem, ExportOrganization, UnknownVariant};

/// Lines of one `POST …/lines` (the cloud's `addLinesSchema`).
pub const MAX_LINES_PER_REQUEST: usize = 500;
/// Lines of one document (the cloud's `MAX_IMPORT_LINES`).
pub const MAX_LINES_PER_DOCUMENT: usize = 10_000;
/// Characters of a line's typed or imported text, trimmed.
pub const MAX_INPUT_CHARS: usize = 64;
pub const MAX_COMMENT_CHARS: usize = 500;
pub const MAX_REASON_NAME_CHARS: usize = 120;

/// `details.constraint` of a document's `conflict`.
pub mod constraints {
    /// The document is applied or cancelled: it changes no more.
    pub const NOT_DRAFT: &str = "document_not_draft";
    /// An apply of a document without a reason.
    pub const REASON_REQUIRED: &str = "reason_required";
    /// An apply of a document without lines.
    pub const NO_LINES: &str = "no_lines";
    /// An apply found lines that are not `ok`; their fresh statuses are
    /// saved, `details.invalidLines` counts them.
    pub const INVALID_LINES: &str = "invalid_lines";
    /// An apply while the host's restore hold is on (`site.facts_held_since`):
    /// it would work on a copy that lacks the stations' later facts.
    pub const RESTORE_HOLD: &str = "restore_hold";
    /// The ЧЗ file of a document that is not applied (plan ДЗГ-О).
    pub const NOT_APPLIED: &str = "document_not_applied";
    pub const ALL: &[&str] = &[
        NOT_DRAFT,
        REASON_REQUIRED,
        NO_LINES,
        INVALID_LINES,
        RESTORE_HOLD,
        NOT_APPLIED,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationStatus {
    Draft,
    Applied,
    Cancelled,
}

impl DisaggregationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Applied => "applied",
            Self::Cancelled => "cancelled",
        }
    }
}

impl std::str::FromStr for DisaggregationStatus {
    type Err = UnknownVariant;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("disaggregation status", text)
    }
}

/// Where a document's lines came from: typed, or an imported file (any
/// import marks the document).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationSource {
    Manual,
    Import,
}

impl DisaggregationSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Import => "import",
        }
    }
}

impl std::str::FromStr for DisaggregationSource {
    type Err = UnknownVariant;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("disaggregation source", text)
    }
}

/// A line's status, the first rule that holds winning (the cloud's
/// `line-validation.ts`): `not_found` → `not_closed` → `shift_open` →
/// `already_disassembled` → `ok`; `duplicate` is a repeat in the document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationLineStatus {
    Ok,
    NotFound,
    NotClosed,
    ShiftOpen,
    AlreadyDisassembled,
    Duplicate,
}

impl DisaggregationLineStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::NotFound => "not_found",
            Self::NotClosed => "not_closed",
            Self::ShiftOpen => "shift_open",
            Self::AlreadyDisassembled => "already_disassembled",
            Self::Duplicate => "duplicate",
        }
    }
}

impl std::str::FromStr for DisaggregationLineStatus {
    type Err = UnknownVariant;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        parse_variant("disaggregation line status", text)
    }
}

/// A reason of the dictionary (`GET /v1/office/disaggregation-reasons`,
/// archived ones included).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReason {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    pub archived: bool,
    pub rev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationReasonCreate {
    pub name: String,
    #[serde(default)]
    pub sort_order: i64,
}

/// The whole reason over its `rev`; `archived: true` archives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationReasonUpdate {
    pub name: String,
    pub sort_order: i64,
    pub archived: bool,
    pub expected_rev: i64,
}

/// A document as the list and the card show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationDocument {
    pub id: String,
    /// `DSG-YY-NNNN`.
    pub doc_no: String,
    pub status: DisaggregationStatus,
    pub reason_id: Option<String>,
    pub reason_name: Option<String>,
    pub comment: Option<String>,
    pub source: DisaggregationSource,
    pub line_count: u32,
    /// The sum of the lines' `codeCount`.
    pub code_count: u64,
    pub created_by: String,
    pub created_by_name: String,
    pub created_at: String,
    pub applied_at: Option<String>,
    pub applied_by: Option<String>,
    pub applied_by_name: Option<String>,
    pub cancelled_at: Option<String>,
    pub cancelled_by: Option<String>,
    pub rev: i64,
}

/// One line: what was typed, the SSCC the domain read (18 digits, `null`
/// when none, or for a repeat), what it names and its status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationLine {
    pub id: String,
    pub sscc_input: String,
    pub sscc: Option<String>,
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    /// The shift of the box or the pallet, for the office's link.
    pub shift_id: Option<String>,
    pub shift_number: Option<String>,
    pub status: DisaggregationLineStatus,
    pub product_id: Option<String>,
    pub product_name: Option<String>,
    /// Live codes of the box, or of the pallet's boxes, when last checked.
    pub code_count: u64,
    pub validated_at: String,
}

/// `GET /v1/office/disaggregation/{id}` and the answer of every write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationDetail {
    pub document: DisaggregationDocument,
    pub lines: Vec<DisaggregationLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationCreate {
    #[serde(default)]
    pub reason_id: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// A field that must be present and may be `null`: a missing one is an
/// error (serde reads a missing `Option` as `None`, which here would clear a
/// draft's header by leaving a key out).
fn required<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// The whole header of a draft over its `rev`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationUpdate {
    #[serde(deserialize_with = "required")]
    pub reason_id: Option<String>,
    #[serde(deserialize_with = "required")]
    pub comment: Option<String>,
    pub expected_rev: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationLineInput {
    pub input: String,
    #[serde(deserialize_with = "required")]
    pub sscc: Option<String>,
}

/// `POST …/{id}/lines`; `import: true` marks the document's source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationLinesAdd {
    pub lines: Vec<DisaggregationLineInput>,
    #[serde(default)]
    pub import: bool,
}

/// `POST …/{id}/apply` and `POST …/{id}/cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationTransition {
    pub expected_rev: i64,
}

/// `data` of a `code_releases` feed item, whose `id` is the box's: a
/// document took this box apart and freed every code it held (plan ДЗГ).
/// A station deletes its own codes of that box once the box is closed
/// there. Never deleted, never a tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReleaseRecord {
    pub shift_id: String,
    pub document_id: String,
    pub released_at: String,
    pub code_count: u32,
}

/// What `GET /v1/office/disaggregation/{id}/report-data` reads (plan ДЗГ-О):
/// `boxes` only the lines, `full` also each box's codes and each pallet's
/// boxes, as the cloud's `variant=boxes|full`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisaggregationReportVariant {
    Boxes,
    Full,
}

/// `GET /v1/office/disaggregation/{id}/report-data` (plan ДЗГ-О): what
/// «Акт дезагрегации» prints of a document, in one snapshot of the host, by
/// the rules of the cloud's `DisaggregationService.reportData`: the lines
/// with an SSCC, in the order they were added; a line's `codeCount` as the
/// line keeps it; the product's name now; the names of the office users who
/// made and applied it. `items` and `boxes` are filled only for `full`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportRows {
    pub id: String,
    pub doc_no: String,
    pub status: DisaggregationStatus,
    pub created_at: String,
    pub applied_at: Option<String>,
    pub created_by_name: Option<String>,
    pub applied_by_name: Option<String>,
    pub reason_name: Option<String>,
    pub comment: Option<String>,
    pub organization: ExportOrganization,
    pub variant: DisaggregationReportVariant,
    pub lines: Vec<DisaggregationReportLine>,
}

/// A line of [`DisaggregationReportRows`]: `sscc` the bare 18 digits; a box's
/// line names its box, a pallet's its pallet. For `full`, a box's `items` are
/// its codes not displaced and not taken out, or taken out by its own
/// disassembly (the rule of «Состав короба»), by GTIN and serial; a pallet's
/// `boxes` the boxes standing on it not taken apart, closed first, with
/// their live units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportLine {
    pub id: String,
    pub sscc: String,
    pub box_id: Option<String>,
    pub pallet_id: Option<String>,
    pub product_name: Option<String>,
    pub code_count: u32,
    pub items: Vec<BoxReportItem>,
    pub boxes: Vec<DisaggregationReportBox>,
}

/// A box standing on a pallet of the act: its bare SSCC and live units.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisaggregationReportBox {
    pub sscc: Option<String>,
    pub units: u32,
}

/// The one ЧЗ file a disaggregation document has (plan ДЗГ-О, owner decision
/// ПР-2): ГИС МТ «Расформирование упаковки», `@markiro/domain`'s
/// `renderGismtDisaggregationXml`.
pub const DISAGGREGATION_XML_FORMAT_ID: &str = "disaggregation_xml_gismt";
pub const DISAGGREGATION_XML_FORMAT_VERSION: u32 = 1;

/// `POST /v1/office/disaggregation/{id}/exports` (plan ДЗГ-О): the office
/// saved the document's ЧЗ file and records it, as `ShiftExportRecord` does
/// for a shift; `packingCount` the packages the file names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisaggregationExportRecord {
    pub format_id: String,
    pub format_version: u32,
    pub packing_count: u32,
}
