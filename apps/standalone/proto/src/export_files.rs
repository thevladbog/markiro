//! The files the office generates, kept on the host (beta 3 feedback, host
//! migration `0029`): a shift's and a pallet's ЧЗ exports, a disaggregation
//! document's ГИС МТ file and the printed forms. The office renders a file
//! with `@markiro/domain` exactly as before, hands its bytes to the host in
//! chunks, and the host serves the same bytes back, SHA-256 checked, from the
//! shift's drawer and the box, pallet and disaggregation cards.
//! `proto/fixtures/export-file*.json` and `export-settings*.json` hold the
//! shapes both sides read.

use serde::{Deserialize, Serialize};

/// The largest chunk of a file, in bytes of the file itself (base64 on the
/// wire, so a chunk fits the router's 2 MiB JSON limit). Every chunk but the
/// last has exactly this size.
pub const EXPORT_FILE_CHUNK_BYTES: u64 = 1_048_576;
/// The largest file the host stores: the shell's own total per save.
pub const EXPORT_FILE_MAX_BYTES: u64 = 256 * 1_048_576;
/// The most parts one export may store (a shift split by a tiny line limit
/// would otherwise be a hundred thousand files).
pub const EXPORT_FILE_MAX_PARTS: u32 = 1_000;
/// What the store holds at most, as it occupies the database (after deflate).
/// A file that would pass it is refused with `export_store_full`; the
/// office's own copy in the Documents folder is still made.
pub const EXPORT_STORE_MAX_BYTES: u64 = 2 * 1_073_741_824;
/// The rows of a list of stored files.
pub const EXPORT_FILE_LIST_LIMIT: u32 = 500;
/// The retention the administrator may choose, in days (`null`: keep always).
pub const EXPORT_RETENTION_MIN_DAYS: u32 = 30;
pub const EXPORT_RETENTION_MAX_DAYS: u32 = 3650;

/// What a stored file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFileKind {
    /// A part of a shift's export (`shift_*` formats).
    ShiftExport,
    /// A pallet's ЧЗ document.
    PalletExport,
    /// A disaggregation document's «Расформирование упаковки» file.
    DisaggregationXml,
    /// A printed form (`form_*` formats), as its HTML.
    Form,
}

impl ExportFileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShiftExport => "shift_export",
            Self::PalletExport => "pallet_export",
            Self::DisaggregationXml => "disaggregation_xml",
            Self::Form => "form",
        }
    }
}

/// What a stored file belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportTargetType {
    Shift,
    Pallet,
    WarehousePallet,
    Box,
    DisaggregationDocument,
}

impl ExportTargetType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shift => "shift",
            Self::Pallet => "pallet",
            Self::WarehousePallet => "warehouse_pallet",
            Self::Box => "box",
            Self::DisaggregationDocument => "disaggregation_document",
        }
    }
}

/// The printed forms' format ids (`FormKind` of the office, `form_` first),
/// all at version 1.
pub const FORM_FORMATS: [&str; 6] = [
    "form_box",
    "form_pallet",
    "form_placard",
    "form_placards",
    "form_task",
    "form_act",
];

/// `POST /v1/office/export-files`: the start of one file's upload. A file of
/// at most one chunk may carry its whole bytes in `contentBase64`, and is then
/// stored by this one call. Strict, like every request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportFileBegin {
    /// A UUID the office makes; repeating the call with the same id and the
    /// same fields answers with where the upload stands.
    pub id: String,
    pub batch_id: String,
    pub part_no: u32,
    pub kind: ExportFileKind,
    pub target_type: ExportTargetType,
    pub target_id: String,
    pub format_id: String,
    pub format_version: u32,
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub generator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_base64: Option<String>,
}

/// `PUT /v1/office/export-files/{id}/chunks/{seq}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportFileChunkPut {
    pub content_base64: String,
}

/// Where an upload stands: how many chunks the host holds in order, and
/// whether the file is complete and stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileProgress {
    pub id: String,
    pub chunk_count: u32,
    pub received_chunks: u32,
    pub ready: bool,
}

/// A stored file's record (the bytes are served by chunks).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub id: String,
    pub batch_id: String,
    pub part_no: u32,
    pub kind: ExportFileKind,
    pub target_type: ExportTargetType,
    pub target_id: String,
    pub shift_id: Option<String>,
    pub format_id: String,
    pub format_version: u32,
    pub file_name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub generator: String,
    pub created_at: String,
    /// The office user who stored it (their name now; `None` when gone).
    pub user_name: Option<String>,
}

/// `GET /v1/office/export-files`: stored files, newest first, at most
/// `EXPORT_FILE_LIST_LIMIT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileList {
    pub items: Vec<ExportFile>,
}

/// `POST /v1/office/export-files/{id}/download`: the host checked the stored
/// bytes against their SHA-256 and wrote the `shift.export.download` row; the
/// chunks follow, `GET …/chunks/{seq}` for `seq` in `0..chunkCount`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileOpened {
    pub file: ExportFile,
    pub chunk_count: u32,
}

/// One chunk of a stored file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileChunk {
    pub content_base64: String,
}

/// `GET /v1/office/export-files/settings`: the retention and what the store
/// holds now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    /// Days a stored file is kept; `None`: always (the default).
    pub retention_days: Option<u32>,
    pub file_count: u64,
    /// What the files occupy in the database.
    pub stored_bytes: u64,
    /// What the files weigh as they were made.
    pub original_bytes: u64,
    pub max_stored_bytes: u64,
}

/// `PUT /v1/office/export-files/settings` (administrators).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportSettingsUpdate {
    pub retention_days: Option<u32>,
}
