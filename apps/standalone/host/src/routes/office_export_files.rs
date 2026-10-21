//! The files the office generates, kept on the host (beta 3 feedback, host
//! migration `0029`): `POST /v1/office/export-files` starts (and, for a file
//! of one chunk, finishes) a file's upload, `PUT …/{id}/chunks/{seq}` adds a
//! chunk, `POST …/{id}/complete` seals it, `GET /v1/office/export-files` lists
//! files by shift or by card, `POST …/{id}/download` checks the stored bytes
//! against their SHA-256 and opens a download, `GET …/{id}/chunks/{seq}`
//! serves a chunk, and `GET`/`PUT /v1/office/export-files/settings` read and
//! set the retention.
//!
//! The office renders a file with `@markiro/domain` exactly as the cloud does
//! and hands the host its bytes; the host never renders or interprets them.
//! It keeps them, unchanged, in `export_file_chunks` (at most 1 MiB a chunk,
//! deflated when that is smaller), so a database copy and a restore carry them.
//! A file is `ready` once every chunk is in and the SHA-256 and the size of the
//! whole match what the office declared; a half-sent file is never listed or
//! served and goes after an hour. Every route needs an office session (a
//! device key is `401`); the files of a disaggregation document's ГИС МТ
//! export are stored by the roles that may disaggregate, as the export's own
//! record is. Disk exhaustion is bounded three ways: a file is at most 256
//! MiB, the store at most [`EXPORT_STORE_MAX_BYTES`] as it occupies the
//! database, and a shift stores at most [`EXPORT_FILE_MAX_PARTS`] parts per
//! export; each refusal is a precise code and the office's own copy in the
//! Documents folder is made anyway.

use std::io::{Read, Write};

use aws_lc_rs::digest::{Context, SHA256};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use markiro_proto::codes;
use markiro_proto::disaggregation::{
    DISAGGREGATION_XML_FORMAT_ID, DISAGGREGATION_XML_FORMAT_VERSION,
};
use markiro_proto::export_files::{
    ExportFile, ExportFileBegin, ExportFileChunk, ExportFileChunkPut, ExportFileKind,
    ExportFileList, ExportFileOpened, ExportFileProgress, ExportSettings, ExportSettingsUpdate,
    ExportTargetType, EXPORT_FILE_CHUNK_BYTES, EXPORT_FILE_LIST_LIMIT, EXPORT_FILE_MAX_BYTES,
    EXPORT_FILE_MAX_PARTS, EXPORT_RETENTION_MAX_DAYS, EXPORT_RETENTION_MIN_DAYS,
    EXPORT_STORE_MAX_BYTES, FORM_FORMATS,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};
use time::Duration;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::clock::{format_timestamp, parse_timestamp};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::routes::office_exports::{PALLET_FORMATS, SHIFT_FORMATS};
use crate::server::AppState;
use crate::validate;

/// A file left half sent this long is deleted when the next file starts.
const STALE_UPLOAD: Duration = Duration::hours(1);

/// Every column of `export_files` the answers read, with the name of the user
/// who stored the file now.
const FILE_SQL: &str = "SELECT f.id, f.batch_id, f.part_no, f.kind, f.target_type, f.target_id, \
     f.shift_id, f.format_id, f.format_version, f.file_name, f.media_type, f.size_bytes, \
     f.sha256, f.generator, f.created_at, u.name AS user_name, f.chunk_count, f.state, \
     f.actor_id FROM export_files f \
     LEFT JOIN office_users u ON u.id = f.actor_id";

#[derive(sqlx::FromRow)]
struct FileRow {
    id: String,
    batch_id: String,
    part_no: i64,
    kind: String,
    target_type: String,
    target_id: String,
    shift_id: Option<String>,
    format_id: String,
    format_version: i64,
    file_name: String,
    media_type: String,
    size_bytes: i64,
    sha256: String,
    generator: String,
    created_at: String,
    user_name: Option<String>,
    chunk_count: i64,
    state: String,
    actor_id: String,
}

impl FileRow {
    fn parse_kind(text: &str) -> Result<ExportFileKind, ApiError> {
        serde_json::from_value(json!(text)).map_err(ApiError::internal)
    }

    fn parse_target(text: &str) -> Result<ExportTargetType, ApiError> {
        serde_json::from_value(json!(text)).map_err(ApiError::internal)
    }

    fn record(&self) -> Result<ExportFile, ApiError> {
        Ok(ExportFile {
            id: self.id.clone(),
            batch_id: self.batch_id.clone(),
            part_no: u32::try_from(self.part_no).map_err(ApiError::internal)?,
            kind: Self::parse_kind(&self.kind)?,
            target_type: Self::parse_target(&self.target_type)?,
            target_id: self.target_id.clone(),
            shift_id: self.shift_id.clone(),
            format_id: self.format_id.clone(),
            format_version: u32::try_from(self.format_version).map_err(ApiError::internal)?,
            file_name: self.file_name.clone(),
            media_type: self.media_type.clone(),
            size_bytes: u64::try_from(self.size_bytes).map_err(ApiError::internal)?,
            sha256: self.sha256.clone(),
            generator: self.generator.clone(),
            created_at: self.created_at.clone(),
            user_name: self.user_name.clone(),
        })
    }
}

/// The files of the given ids as records, in the given order; used by the
/// shift's export history to attach each export's parts.
pub async fn files_of_batches(
    conn: &mut SqliteConnection,
    shift_id: &str,
    batch_ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<ExportFile>>, ApiError> {
    let mut by_batch: std::collections::HashMap<String, Vec<ExportFile>> =
        std::collections::HashMap::new();
    if batch_ids.is_empty() {
        return Ok(by_batch);
    }
    let rows: Vec<FileRow> = sqlx::query_as(&format!(
        "{FILE_SQL} WHERE (f.shift_id = ?1 OR (f.target_type = 'pallet' AND f.target_id = ?1)) AND f.state = 'ready' \
         AND f.kind IN ('shift_export', 'pallet_export') ORDER BY f.batch_id, f.part_no"
    ))
    .bind(shift_id)
    .fetch_all(conn)
    .await
    .map_err(ApiError::internal)?;
    for row in rows {
        if batch_ids.contains(&row.batch_id) {
            by_batch
                .entry(row.batch_id.clone())
                .or_default()
                .push(row.record()?);
        }
    }
    Ok(by_batch)
}

/// The media type of a file by its extension, and `None` for an extension the
/// host does not store.
fn media_type_of(file_name: &str, kind: ExportFileKind) -> Option<&'static str> {
    let extension = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    match (kind, extension.as_str()) {
        (ExportFileKind::Form, "html") => Some("text/html; charset=utf-8"),
        (ExportFileKind::Form, _) => None,
        (_, "txt") => Some("text/plain; charset=utf-8"),
        (_, "csv") => Some("text/csv; charset=utf-8"),
        (_, "xml") => Some("application/xml; charset=utf-8"),
        _ => None,
    }
}

/// A name a file may be stored by: no control character, no path separator
/// and none of the characters Windows refuses in a name.
fn clean_file_name(name: &str) -> bool {
    let chars = name.chars().count();
    (1..=200).contains(&chars)
        && !name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        && !name.ends_with([' ', '.'])
}

/// The target a kind (and, for a form, its format) is stored under.
fn target_fits(begin: &ExportFileBegin) -> bool {
    match begin.kind {
        ExportFileKind::ShiftExport => begin.target_type == ExportTargetType::Shift,
        ExportFileKind::PalletExport => begin.target_type == ExportTargetType::Pallet,
        ExportFileKind::DisaggregationXml => {
            begin.target_type == ExportTargetType::DisaggregationDocument
        }
        ExportFileKind::Form => match begin.format_id.as_str() {
            "form_box" => begin.target_type == ExportTargetType::Box,
            "form_pallet" | "form_placard" => begin.target_type == ExportTargetType::Pallet,
            "form_placards" | "form_task" => begin.target_type == ExportTargetType::Shift,
            "form_act" => begin.target_type == ExportTargetType::DisaggregationDocument,
            _ => false,
        },
    }
}

/// Whether the format is one the office generates for the kind.
fn format_known(begin: &ExportFileBegin) -> bool {
    let format = (begin.format_id.as_str(), begin.format_version);
    match begin.kind {
        ExportFileKind::ShiftExport => SHIFT_FORMATS.contains(&format),
        ExportFileKind::PalletExport => PALLET_FORMATS.contains(&format),
        ExportFileKind::DisaggregationXml => {
            format
                == (
                    DISAGGREGATION_XML_FORMAT_ID,
                    DISAGGREGATION_XML_FORMAT_VERSION,
                )
        }
        ExportFileKind::Form => FORM_FORMATS.contains(&format.0) && format.1 == 1,
    }
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

fn chunk_count_of(size: u64) -> u64 {
    size.div_ceil(EXPORT_FILE_CHUNK_BYTES)
}

/// The size chunk `seq` of a `size`-byte file has.
fn chunk_size_of(size: u64, seq: u64) -> u64 {
    let rest = size - seq * EXPORT_FILE_CHUNK_BYTES;
    rest.min(EXPORT_FILE_CHUNK_BYTES)
}

fn validate_begin(begin: &ExportFileBegin) -> Result<(), ApiError> {
    validate::client_uuid("id", &begin.id)?;
    validate::client_uuid("batchId", &begin.batch_id)?;
    validate::client_uuid("targetId", &begin.target_id)?;
    if !(1..=EXPORT_FILE_MAX_PARTS).contains(&begin.part_no) {
        return Err(ApiError::validation(
            "partNo",
            "a part is numbered from 1 and a export has at most 1000 parts",
        ));
    }
    if !target_fits(begin) {
        return Err(ApiError::validation(
            "targetType",
            "the kind and the format are not of this target",
        ));
    }
    if !format_known(begin) {
        return Err(ApiError::validation(
            "formatId",
            "not a file the office generates",
        ));
    }
    if !clean_file_name(&begin.file_name) || media_type_of(&begin.file_name, begin.kind).is_none() {
        return Err(ApiError::validation(
            "fileName",
            "a plain name ending in the extension of the format",
        ));
    }
    if !is_sha256(&begin.sha256) {
        return Err(ApiError::validation(
            "sha256",
            "64 lower-case hexadecimal digits",
        ));
    }
    let generator_chars = begin.generator.chars().count();
    if !(1..=64).contains(&generator_chars) || begin.generator.chars().any(char::is_control) {
        return Err(ApiError::validation(
            "generator",
            "1-64 printable characters",
        ));
    }
    if begin.size_bytes == 0 {
        return Err(ApiError::validation(
            "sizeBytes",
            "a file has at least a byte",
        ));
    }
    if begin.size_bytes > EXPORT_FILE_MAX_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            codes::EXPORT_FILE_TOO_LARGE,
            "the file is larger than the host stores",
        )
        .with_details(json!({ "maxBytes": EXPORT_FILE_MAX_BYTES })));
    }
    Ok(())
}

/// The shift a target belongs to (`Some(None)`: a target with no shift), or
/// `None` when the target does not exist.
async fn resolve_target(
    conn: &mut SqliteConnection,
    target_type: ExportTargetType,
    target_id: &str,
) -> Result<Option<Option<String>>, ApiError> {
    let found: Option<Option<String>> = match target_type {
        ExportTargetType::Shift => {
            sqlx::query_scalar::<_, String>("SELECT id FROM shifts WHERE id = ?1 UNION ALL SELECT s.id FROM cloud_history_shifts s JOIN cloud_history_batches b ON b.id=s.batch_id AND b.status='complete' WHERE s.id=?1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?
                .map(Some)
        }
        ExportTargetType::Pallet => {
            sqlx::query_scalar::<_, Option<String>>("SELECT shift_id FROM pallets WHERE id = ?1 UNION ALL SELECT p.shift_id FROM cloud_history_pallets p JOIN cloud_history_batches b ON b.id=p.batch_id AND b.status='complete' WHERE p.id=?1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?
        }
        ExportTargetType::Box => {
            sqlx::query_scalar::<_, String>("SELECT shift_id FROM boxes WHERE id = ?1 UNION ALL SELECT x.shift_id FROM cloud_history_boxes x JOIN cloud_history_batches b ON b.id=x.batch_id AND b.status='complete' WHERE x.id=?1")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?
                .map(Some)
        }
        ExportTargetType::DisaggregationDocument => {
            sqlx::query_scalar::<_, String>("SELECT id FROM disaggregation_documents WHERE id = ?")
                .bind(target_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?
                .map(|_| None)
        }
    };
    Ok(found)
}

fn decode_chunk(content_base64: &str, field: &str) -> Result<Vec<u8>, ApiError> {
    // A chunk of at most 1 MiB is at most 1 398 104 characters of base64.
    if content_base64.len() > 1_398_104 {
        return Err(ApiError::validation(field, "a chunk is at most 1 MiB"));
    }
    STANDARD
        .decode(content_base64)
        .map_err(|_| ApiError::validation(field, "not base64"))
}

/// A chunk as the database keeps it: deflated when that saves a tenth.
fn encode_chunk(raw: &[u8]) -> Result<(&'static str, Vec<u8>), ApiError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw).map_err(ApiError::internal)?;
    let deflated = encoder.finish().map_err(ApiError::internal)?;
    if deflated.len() < raw.len() - raw.len() / 10 {
        Ok(("deflate", deflated))
    } else {
        Ok(("identity", raw.to_vec()))
    }
}

/// A chunk as the office made it; `None` when it cannot be read back (the
/// stored bytes are damaged).
fn decode_stored(encoding: &str, content: &[u8]) -> Option<Vec<u8>> {
    match encoding {
        "identity" => Some(content.to_vec()),
        "deflate" => {
            let mut raw = Vec::new();
            DeflateDecoder::new(content)
                .take(EXPORT_FILE_CHUNK_BYTES + 1)
                .read_to_end(&mut raw)
                .ok()?;
            Some(raw)
        }
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut context = Context::new(&SHA256);
    context.update(bytes);
    hex(context.finish().as_ref())
}

/// What the store holds now: files, bytes in the database, bytes as made.
async fn store_usage(conn: &mut SqliteConnection) -> Result<(u64, u64, u64), ApiError> {
    let (count, stored, original): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(stored_bytes), 0), \
         COALESCE(SUM(CASE WHEN state = 'ready' THEN size_bytes ELSE 0 END), 0) FROM export_files",
    )
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok((
        u64::try_from(count).map_err(ApiError::internal)?,
        u64::try_from(stored).map_err(ApiError::internal)?,
        u64::try_from(original).map_err(ApiError::internal)?,
    ))
}

fn store_full(stored: u64) -> ApiError {
    ApiError::new(
        StatusCode::INSUFFICIENT_STORAGE,
        codes::EXPORT_STORE_FULL,
        "the host's store of files is full",
    )
    .with_details(json!({ "storedBytes": stored, "maxBytes": EXPORT_STORE_MAX_BYTES }))
}

async fn retention_days(conn: &mut SqliteConnection) -> Result<Option<u32>, ApiError> {
    let days: Option<i64> =
        sqlx::query_scalar("SELECT retention_days FROM export_settings WHERE id = 1")
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    days.map(|d| u32::try_from(d).map_err(ApiError::internal))
        .transpose()
}

/// Deletes the files half sent an hour ago, and, when `days` is set, the
/// stored files older than that. Answers how many stored files it deleted.
async fn sweep(conn: &mut SqliteConnection, now: &str, days: Option<u32>) -> Result<u64, ApiError> {
    let at = parse_timestamp(now).map_err(ApiError::internal)?;
    let stale = format_timestamp(at - STALE_UPLOAD);
    sqlx::query("DELETE FROM export_files WHERE state = 'uploading' AND created_at < ?")
        .bind(&stale)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(days) = days else {
        return Ok(0);
    };
    let cutoff = format_timestamp(at - Duration::days(i64::from(days)));
    let removed = sqlx::query("DELETE FROM export_files WHERE state = 'ready' AND created_at < ?")
        .bind(&cutoff)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?
        .rows_affected();
    Ok(removed)
}

async fn audit_purge(
    conn: &mut SqliteConnection,
    context: &OfficeContext,
    at: &str,
    removed: u64,
    days: Option<u32>,
) -> Result<(), ApiError> {
    if removed == 0 {
        return Ok(());
    }
    audit::record(
        conn,
        at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_EXPORT_PURGE,
            target_type: None,
            target_id: None,
            outcome: Outcome::Ok,
            details: json!({ "removedFiles": removed, "retentionDays": days }),
        },
    )
    .await
    .map_err(ApiError::internal)
}

async fn load_file(conn: &mut SqliteConnection, id: &str) -> Result<FileRow, ApiError> {
    validate::client_uuid("id", id)?;
    sqlx::query_as::<_, FileRow>(&format!("{FILE_SQL} WHERE f.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::not_found("no such stored file"))
}

async fn received_chunks(conn: &mut SqliteConnection, id: &str) -> Result<u32, ApiError> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM export_file_chunks WHERE file_id = ?")
            .bind(id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    u32::try_from(count).map_err(ApiError::internal)
}

fn progress(row: &FileRow, received: u32) -> Result<ExportFileProgress, ApiError> {
    Ok(ExportFileProgress {
        id: row.id.clone(),
        chunk_count: u32::try_from(row.chunk_count).map_err(ApiError::internal)?,
        received_chunks: received,
        ready: row.state == "ready",
    })
}

/// Stores chunk `seq`, which must be the next one. A chunk already stored is
/// accepted again only when its bytes are the same.
async fn put_chunk_in(
    conn: &mut SqliteConnection,
    row: &FileRow,
    seq: u64,
    raw: &[u8],
) -> Result<(), ApiError> {
    let size = u64::try_from(row.size_bytes).map_err(ApiError::internal)?;
    let chunks = u64::try_from(row.chunk_count).map_err(ApiError::internal)?;
    if seq >= chunks {
        return Err(ApiError::validation("seq", "the file has fewer chunks"));
    }
    if raw.len() as u64 != chunk_size_of(size, seq) {
        return Err(ApiError::validation(
            "contentBase64",
            "a chunk is 1 MiB, the last one what is left",
        ));
    }
    let held = u64::from(received_chunks(conn, &row.id).await?);
    if seq < held {
        let stored: (String, Vec<u8>) = sqlx::query_as(
            "SELECT encoding, content FROM export_file_chunks WHERE file_id = ? AND seq = ?",
        )
        .bind(&row.id)
        .bind(i64::try_from(seq).map_err(ApiError::internal)?)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        return if decode_stored(&stored.0, &stored.1).as_deref() == Some(raw) {
            Ok(())
        } else {
            Err(ApiError::conflict(
                "chunk",
                "the chunk is stored already with other bytes",
            ))
        };
    }
    if seq > held {
        return Err(ApiError::conflict(
            "chunk",
            "the chunks come in order, one after another",
        ));
    }
    let (encoding, content) = encode_chunk(raw)?;
    let (_, stored, _) = store_usage(conn).await?;
    if stored + content.len() as u64 > EXPORT_STORE_MAX_BYTES {
        // A half-sent file is no use: it goes, and the room with it.
        sqlx::query("DELETE FROM export_files WHERE id = ?")
            .bind(&row.id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        return Err(store_full(stored));
    }
    sqlx::query(
        "INSERT INTO export_file_chunks (file_id, seq, encoding, sha256, content) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(i64::try_from(seq).map_err(ApiError::internal)?)
    .bind(encoding)
    .bind(sha256_hex(raw))
    .bind(&content)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query("UPDATE export_files SET stored_bytes = stored_bytes + ? WHERE id = ?")
        .bind(i64::try_from(content.len()).map_err(ApiError::internal)?)
        .bind(&row.id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

/// The SHA-256 and the size of the whole file as its chunks hold it; `None`
/// when a chunk is missing or cannot be read.
async fn digest_of(
    conn: &mut SqliteConnection,
    row: &FileRow,
) -> Result<Option<(String, u64)>, ApiError> {
    let chunks: Vec<(i64, String, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, encoding, content FROM export_file_chunks WHERE file_id = ? ORDER BY seq",
    )
    .bind(&row.id)
    .fetch_all(conn)
    .await
    .map_err(ApiError::internal)?;
    if i64::try_from(chunks.len()).map_err(ApiError::internal)? != row.chunk_count {
        return Ok(None);
    }
    let mut context = Context::new(&SHA256);
    let mut size = 0_u64;
    for (expected, (seq, encoding, content)) in chunks.iter().enumerate() {
        if *seq != i64::try_from(expected).map_err(ApiError::internal)? {
            return Ok(None);
        }
        let Some(raw) = decode_stored(encoding, content) else {
            return Ok(None);
        };
        size += raw.len() as u64;
        context.update(&raw);
    }
    Ok(Some((hex(context.finish().as_ref()), size)))
}

/// Seals a file whose chunks are all in: the whole must be what was declared.
/// A file that is not goes (the office starts it again) with `validation_failed`.
async fn finish(
    conn: &mut SqliteConnection,
    context: &OfficeContext,
    row: &FileRow,
    at: &str,
) -> Result<(), ApiError> {
    let digest = digest_of(conn, row).await?;
    let size = u64::try_from(row.size_bytes).map_err(ApiError::internal)?;
    if digest.as_ref() != Some(&(row.sha256.clone(), size)) {
        sqlx::query("DELETE FROM export_files WHERE id = ?")
            .bind(&row.id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        // A caller that keeps the deletion commits before it answers.
        return Err(ApiError::validation(
            "sha256",
            "the chunks are not the file that was declared",
        ));
    }
    sqlx::query("UPDATE export_files SET state = 'ready' WHERE id = ?")
        .bind(&row.id)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        conn,
        at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_EXPORT_STORE,
            target_type: Some(&row.target_type),
            target_id: Some(&row.target_id),
            outcome: Outcome::Ok,
            details: file_details(row),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let days = retention_days(conn).await?;
    let removed = sweep(conn, at, days).await?;
    audit_purge(conn, context, at, removed, days).await?;
    Ok(())
}

fn file_details(row: &FileRow) -> serde_json::Value {
    json!({
        "fileId": row.id,
        "batchId": row.batch_id,
        "partNo": row.part_no,
        "kind": row.kind,
        "formatId": row.format_id,
        "formatVersion": row.format_version,
        "fileName": row.file_name,
        "sizeBytes": row.size_bytes,
        "sha256": row.sha256,
    })
}

/// `POST /v1/office/export-files`.
pub async fn begin(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(begin): ApiJson<ExportFileBegin>,
) -> Result<Json<ExportFileProgress>, ApiError> {
    validate_begin(&begin)?;
    let disaggregation_file = begin.kind == ExportFileKind::DisaggregationXml;
    if disaggregation_file {
        context.require_disaggregation()?;
    }
    let inline = match &begin.content_base64 {
        None => None,
        Some(text) => {
            if begin.size_bytes > EXPORT_FILE_CHUNK_BYTES {
                return Err(ApiError::validation(
                    "contentBase64",
                    "only a file of one chunk is sent whole",
                ));
            }
            Some(decode_chunk(text, "contentBase64")?)
        }
    };
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    if disaggregation_file {
        context.require_disaggregation_in(&mut tx).await?;
    } else {
        context.require_session_in(&mut tx).await?;
    }
    let existing: Option<FileRow> = sqlx::query_as(&format!("{FILE_SQL} WHERE f.id = ?"))
        .bind(&begin.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if let Some(row) = existing {
        // The same call repeated answers where the upload stands; another one
        // under the same id is a conflict.
        let same = row.batch_id == begin.batch_id
            && row.part_no == i64::from(begin.part_no)
            && row.kind == begin.kind.as_str()
            && row.target_type == begin.target_type.as_str()
            && row.target_id == begin.target_id
            && row.format_id == begin.format_id
            && row.format_version == i64::from(begin.format_version)
            && row.file_name == begin.file_name
            && row.sha256 == begin.sha256
            && row.size_bytes == i64::try_from(begin.size_bytes).map_err(ApiError::internal)?
            && row.actor_id == context.user.id;
        if !same {
            return Err(ApiError::conflict(
                "export_file",
                "another file is stored under this id",
            ));
        }
        if row.state == "uploading" {
            if let Some(raw) = &inline {
                let held = received_chunks(&mut tx, &row.id).await?;
                if held == 0 {
                    put_chunk_in(&mut tx, &row, 0, raw).await?;
                }
                let row = load_file(&mut tx, &row.id).await?;
                finish(&mut tx, &context, &row, &at).await?;
            }
        }
        let row = load_file(&mut tx, &row.id).await?;
        let held = received_chunks(&mut tx, &row.id).await?;
        let answer = progress(&row, held)?;
        tx.commit().await.map_err(ApiError::internal)?;
        return Ok(Json(answer));
    }
    let Some(shift_id) = resolve_target(&mut tx, begin.target_type, &begin.target_id).await? else {
        return Err(ApiError::validation(
            "targetId",
            "no such shift, pallet, box or document",
        ));
    };
    if let Some(shift_id) = &shift_id {
        crate::demo::refuse_gismt(&mut tx, shift_id, &begin.format_id).await?;
    }
    // A stale half-sent file may hold the (batch, part) this one wants.
    sweep(&mut tx, &at, None).await?;
    let taken: Option<String> =
        sqlx::query_scalar("SELECT id FROM export_files WHERE batch_id = ? AND part_no = ?")
            .bind(&begin.batch_id)
            .bind(i64::from(begin.part_no))
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if taken.is_some() {
        return Err(ApiError::conflict(
            "export_file",
            "this part of this export is stored already",
        ));
    }
    let (_, stored, _) = store_usage(&mut tx).await?;
    if stored >= EXPORT_STORE_MAX_BYTES {
        return Err(store_full(stored));
    }
    let media_type = media_type_of(&begin.file_name, begin.kind).ok_or_else(|| {
        ApiError::validation(
            "fileName",
            "a plain name ending in the extension of the format",
        )
    })?;
    sqlx::query(
        "INSERT INTO export_files (id, batch_id, part_no, kind, target_type, target_id, shift_id, \
         format_id, format_version, file_name, media_type, size_bytes, chunk_count, sha256, \
         generator, state, created_at, actor_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)",
    )
    .bind(&begin.id)
    .bind(&begin.batch_id)
    .bind(i64::from(begin.part_no))
    .bind(begin.kind.as_str())
    .bind(begin.target_type.as_str())
    .bind(&begin.target_id)
    .bind(&shift_id)
    .bind(&begin.format_id)
    .bind(i64::from(begin.format_version))
    .bind(&begin.file_name)
    .bind(media_type)
    .bind(i64::try_from(begin.size_bytes).map_err(ApiError::internal)?)
    .bind(i64::try_from(chunk_count_of(begin.size_bytes)).map_err(ApiError::internal)?)
    .bind(&begin.sha256)
    .bind(&begin.generator)
    .bind(&at)
    .bind(&context.user.id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let mut row = load_file(&mut tx, &begin.id).await?;
    let mut held = 0;
    if let Some(raw) = inline {
        put_chunk_in(&mut tx, &row, 0, &raw).await?;
        finish(&mut tx, &context, &row, &at).await?;
        row = load_file(&mut tx, &begin.id).await?;
        held = 1;
    }
    let answer = progress(&row, held)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}

/// A write that refuses must still keep the deletion it made of a bad file:
/// the transaction commits and the error is returned after it.
async fn commit_then_fail(
    tx: sqlx::Transaction<'static, sqlx::Sqlite>,
    error: ApiError,
) -> ApiError {
    match tx.commit().await {
        Ok(()) => error,
        Err(failure) => ApiError::internal(failure),
    }
}

#[derive(Deserialize)]
pub struct ChunkPath {
    id: String,
    seq: u32,
}

/// `PUT /v1/office/export-files/{id}/chunks/{seq}`.
pub async fn put_chunk(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(path): ApiPath<ChunkPath>,
    ApiJson(put): ApiJson<ExportFileChunkPut>,
) -> Result<Json<ExportFileProgress>, ApiError> {
    let raw = decode_chunk(&put.content_base64, "contentBase64")?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let row = load_file(&mut tx, &path.id).await?;
    if row.actor_id != context.user.id {
        return Err(ApiError::forbidden("the file is another user's upload"));
    }
    if row.state != "uploading" {
        return Err(ApiError::conflict(
            "export_file",
            "the file is stored already",
        ));
    }
    if row.kind == "disaggregation_xml" {
        context.require_disaggregation_in(&mut tx).await?;
    }
    let seq = u64::from(path.seq);
    match put_chunk_in(&mut tx, &row, seq, &raw).await {
        Ok(()) => {}
        Err(error) if error.code() == codes::EXPORT_STORE_FULL => {
            // The file was deleted to give its room back: keep that.
            return Err(commit_then_fail(tx, error).await);
        }
        Err(error) => return Err(error),
    }
    let row = load_file(&mut tx, &path.id).await?;
    let held = received_chunks(&mut tx, &path.id).await?;
    let answer = progress(&row, held)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}

/// `POST /v1/office/export-files/{id}/complete`.
pub async fn complete(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ExportFileProgress>, ApiError> {
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let row = load_file(&mut tx, &id).await?;
    if row.actor_id != context.user.id {
        return Err(ApiError::forbidden("the file is another user's upload"));
    }
    if row.state == "ready" {
        let held = received_chunks(&mut tx, &id).await?;
        let answer = progress(&row, held)?;
        tx.commit().await.map_err(ApiError::internal)?;
        return Ok(Json(answer));
    }
    let held = received_chunks(&mut tx, &id).await?;
    if i64::from(held) != row.chunk_count {
        return Err(ApiError::conflict(
            "chunk",
            "the file is not sent in full yet",
        ));
    }
    if let Err(error) = finish(&mut tx, &context, &row, &at).await {
        return Err(commit_then_fail(tx, error).await);
    }
    let row = load_file(&mut tx, &id).await?;
    let answer = progress(&row, held)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    shift_id: Option<String>,
    target_type: Option<ExportTargetType>,
    target_id: Option<String>,
    kind: Option<ExportFileKind>,
}

/// `GET /v1/office/export-files?shiftId=` or `?targetType=&targetId=`, with an
/// optional `kind`: the stored files, newest first.
pub async fn list(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> Result<Json<ExportFileList>, ApiError> {
    let kind = query.kind.map(ExportFileKind::as_str);
    let order = format!(
        " ORDER BY f.created_at DESC, f.batch_id, f.part_no LIMIT {EXPORT_FILE_LIST_LIMIT}"
    );
    let rows: Vec<FileRow> = match (&query.shift_id, query.target_type, &query.target_id) {
        (Some(shift), None, None) => {
            validate::client_uuid("shiftId", shift)?;
            sqlx::query_as(&format!(
                "{FILE_SQL} WHERE f.shift_id = ?1 AND f.state = 'ready' \
                 AND (?2 IS NULL OR f.kind = ?2){order}"
            ))
            .bind(shift)
            .bind(kind)
            .fetch_all(&state.pool)
            .await
        }
        (None, Some(target_type), Some(target)) => {
            validate::client_uuid("targetId", target)?;
            sqlx::query_as(&format!(
                "{FILE_SQL} WHERE f.target_type = ?1 AND f.target_id = ?2 AND f.state = 'ready' \
                 AND (?3 IS NULL OR f.kind = ?3){order}"
            ))
            .bind(target_type.as_str())
            .bind(target)
            .bind(kind)
            .fetch_all(&state.pool)
            .await
        }
        _ => {
            return Err(ApiError::validation(
                "shiftId",
                "name a shift, or a target type with its id",
            ))
        }
    }
    .map_err(ApiError::internal)?;
    let items = rows
        .iter()
        .map(FileRow::record)
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(ExportFileList { items }))
}

/// `POST /v1/office/export-files/{id}/download`: checks the stored bytes
/// against the SHA-256 and the size the file was stored with, and only then
/// writes the `shift.export.download` row and opens the download. Bytes that
/// no longer match are `export_file_corrupted` with a `failed` row, and the
/// host serves nothing of the file.
pub async fn open_download(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ExportFileOpened>, ApiError> {
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let row = load_file(&mut tx, &id).await?;
    if row.state != "ready" {
        return Err(ApiError::not_found("no such stored file"));
    }
    let size = u64::try_from(row.size_bytes).map_err(ApiError::internal)?;
    let digest = digest_of(&mut tx, &row).await?;
    let sound = digest.as_ref() == Some(&(row.sha256.clone(), size));
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_EXPORT_DOWNLOAD,
            target_type: Some(&row.target_type),
            target_id: Some(&row.target_id),
            outcome: if sound { Outcome::Ok } else { Outcome::Failed },
            details: if sound {
                file_details(&row)
            } else {
                let mut details = file_details(&row);
                details["reason"] = json!("corrupted");
                details
            },
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let record = row.record()?;
    let chunk_count = u32::try_from(row.chunk_count).map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    if !sound {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::EXPORT_FILE_CORRUPTED,
            "the stored file no longer matches its SHA-256",
        )
        .with_details(json!({ "fileId": record.id })));
    }
    Ok(Json(ExportFileOpened {
        file: record,
        chunk_count,
    }))
}

/// `GET /v1/office/export-files/{id}/chunks/{seq}`.
pub async fn get_chunk(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(path): ApiPath<ChunkPath>,
) -> Result<Json<ExportFileChunk>, ApiError> {
    validate::client_uuid("id", &path.id)?;
    let stored: Option<(String, String, Vec<u8>)> = sqlx::query_as(
        "SELECT c.encoding, c.sha256, c.content FROM export_file_chunks c \
         JOIN export_files f ON f.id = c.file_id AND f.state = 'ready' \
         WHERE c.file_id = ? AND c.seq = ?",
    )
    .bind(&path.id)
    .bind(i64::from(path.seq))
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (encoding, chunk_sha256, content) =
        stored.ok_or_else(|| ApiError::not_found("no such chunk"))?;
    let corrupted = || {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            codes::EXPORT_FILE_CORRUPTED,
            "the stored chunk no longer matches its SHA-256",
        )
    };
    let raw = decode_stored(&encoding, &content).ok_or_else(corrupted)?;
    if sha256_hex(&raw) != chunk_sha256 {
        return Err(corrupted());
    }
    Ok(Json(ExportFileChunk {
        content_base64: STANDARD.encode(raw),
    }))
}

async fn read_settings(pool: &SqlitePool) -> Result<ExportSettings, ApiError> {
    let mut conn = pool.acquire().await.map_err(ApiError::internal)?;
    let days = retention_days(&mut conn).await?;
    let (count, stored, original) = store_usage(&mut conn).await?;
    Ok(ExportSettings {
        retention_days: days,
        file_count: count,
        stored_bytes: stored,
        original_bytes: original,
        max_stored_bytes: EXPORT_STORE_MAX_BYTES,
    })
}

/// `GET /v1/office/export-files/settings`, every office role.
pub async fn get_settings(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<ExportSettings>, ApiError> {
    Ok(Json(read_settings(&state.pool).await?))
}

/// `PUT /v1/office/export-files/settings` (administrators): the retention in
/// days, 30–3650, or `null` to keep every file always. Saving it deletes the
/// stored files older than it, and says how many in the audit trail.
pub async fn put_settings(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<ExportSettingsUpdate>,
) -> Result<Json<ExportSettings>, ApiError> {
    context.require_admin()?;
    if let Some(days) = update.retention_days {
        if !(EXPORT_RETENTION_MIN_DAYS..=EXPORT_RETENTION_MAX_DAYS).contains(&days) {
            return Err(ApiError::validation(
                "retentionDays",
                "30-3650 days, or none to keep the files always",
            ));
        }
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let before = retention_days(&mut tx).await?;
    sqlx::query("UPDATE export_settings SET retention_days = ? WHERE id = 1")
        .bind(update.retention_days.map(i64::from))
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if before != update.retention_days {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::SHIFT_EXPORT_RETENTION,
                target_type: None,
                target_id: None,
                outcome: Outcome::Ok,
                details: json!({ "from": before, "to": update.retention_days }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let removed = sweep(&mut tx, &at, update.retention_days).await?;
    audit_purge(&mut tx, &context, &at, removed, update.retention_days).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(read_settings(&state.pool).await?))
}
