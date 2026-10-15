//! Office disaggregation documents (plan ДЗГ, parity spec §5.1; the cloud's
//! `apps/api/src/modules/disaggregation`): a draft with a number, a reason
//! and lines by SSCC, applied for good or cancelled.
//!
//! - `GET /v1/office/disaggregation` — the list, newest first, narrowed by
//!   `status`, `reasonId`, `from`/`to` (host instants against the creation
//!   moment) and `q` (a piece of the number); every office role.
//! - `POST` creates a draft, `GET …/{id}` is the card (the document and its
//!   lines), `PUT …/{id}` changes a draft's header over its `rev`.
//! - `POST …/{id}/lines` adds lines and `DELETE …/{id}/lines/{lineId}` takes
//!   one away; a draft only. The webview reads the SSCC out of what was typed
//!   or imported (the marking rules live in `@markiro/domain`); the host
//!   checks the shape and what the SSCC names.
//! - `POST …/{id}/apply` and `…/cancel`, both over the card's `rev`.
//!
//! Every write takes the write lock before it reads (`begin_write`) and
//! checks the role and the draft again inside it, as the other office
//! writes do; each answers with the card it wrote.

use std::collections::HashSet;

use axum::extract::State;
use axum::Json;
use markiro_proto::disaggregation::{
    constraints, DisaggregationCreate, DisaggregationDetail, DisaggregationDocument,
    DisaggregationLine, DisaggregationLineStatus as LineStatus, DisaggregationLinesAdd,
    DisaggregationStatus, DisaggregationTransition, DisaggregationUpdate, MAX_COMMENT_CHARS,
    MAX_INPUT_CHARS, MAX_LINES_PER_DOCUMENT, MAX_LINES_PER_REQUEST,
};
use markiro_proto::ShiftOrigin;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::clock::{format_timestamp, parse_timestamp};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::disaggregation::{self, Target};
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;
use crate::validate;

const TARGET_TYPE: &str = "disaggregation_document";

/// The list's most documents, newest first.
const LIST_LIMIT: i64 = 1_000;
/// The longest piece of a number the list searches for.
const MAX_QUERY_CHARS: usize = 40;

const DOCUMENTS_SQL: &str = "SELECT d.id, d.doc_no, d.status, d.reason_id, r.name AS reason_name, \
     d.comment, d.source, \
     (SELECT COUNT(*) FROM disaggregation_document_lines l WHERE l.document_id = d.id) \
       AS line_count, \
     (SELECT COALESCE(SUM(l.code_count), 0) FROM disaggregation_document_lines l \
       WHERE l.document_id = d.id) AS code_count, \
     d.created_by, cu.name AS created_by_name, d.created_at, d.applied_at, d.applied_by, \
     au.name AS applied_by_name, d.cancelled_at, d.cancelled_by, d.rev \
     FROM disaggregation_documents d \
     LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
     JOIN office_users cu ON cu.id = d.created_by \
     LEFT JOIN office_users au ON au.id = d.applied_by";

const LINES_SQL: &str = "SELECT l.id, l.sscc_input, l.sscc, l.box_id, l.pallet_id, l.status, \
     l.product_id, p.name AS product_name, l.code_count, l.validated_at, s.id AS shift_id, \
     s.number_month_key, s.number_seq, s.created_from \
     FROM disaggregation_document_lines l \
     LEFT JOIN products p ON p.id = l.product_id \
     LEFT JOIN boxes b ON b.id = l.box_id \
     LEFT JOIN pallets pl ON pl.id = l.pallet_id \
     LEFT JOIN shifts s ON s.id = COALESCE(b.shift_id, pl.shift_id) \
     WHERE l.document_id = ? ORDER BY l.position";

#[derive(sqlx::FromRow)]
struct DocumentRow {
    id: String,
    doc_no: String,
    status: String,
    reason_id: Option<String>,
    reason_name: Option<String>,
    comment: Option<String>,
    source: String,
    line_count: i64,
    code_count: i64,
    created_by: String,
    created_by_name: String,
    created_at: String,
    applied_at: Option<String>,
    applied_by: Option<String>,
    applied_by_name: Option<String>,
    cancelled_at: Option<String>,
    cancelled_by: Option<String>,
    rev: i64,
}

impl DocumentRow {
    fn document(self) -> Result<DisaggregationDocument, ApiError> {
        Ok(DisaggregationDocument {
            id: self.id,
            doc_no: self.doc_no,
            status: self.status.parse().map_err(ApiError::internal)?,
            reason_id: self.reason_id,
            reason_name: self.reason_name,
            comment: self.comment,
            source: self.source.parse().map_err(ApiError::internal)?,
            line_count: u32::try_from(self.line_count).map_err(ApiError::internal)?,
            code_count: u64::try_from(self.code_count).map_err(ApiError::internal)?,
            created_by: self.created_by,
            created_by_name: self.created_by_name,
            created_at: self.created_at,
            applied_at: self.applied_at,
            applied_by: self.applied_by,
            applied_by_name: self.applied_by_name,
            cancelled_at: self.cancelled_at,
            cancelled_by: self.cancelled_by,
            rev: self.rev,
        })
    }
}

#[derive(sqlx::FromRow)]
struct LineRow {
    id: String,
    sscc_input: String,
    sscc: Option<String>,
    box_id: Option<String>,
    pallet_id: Option<String>,
    status: String,
    product_id: Option<String>,
    product_name: Option<String>,
    code_count: i64,
    validated_at: String,
    shift_id: Option<String>,
    number_month_key: Option<String>,
    number_seq: Option<i64>,
    created_from: Option<String>,
}

impl LineRow {
    fn line(self) -> Result<DisaggregationLine, ApiError> {
        let shift_number = match (self.number_month_key, self.number_seq, self.created_from) {
            (Some(month_key), Some(seq), Some(origin)) => {
                let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
                Some(shifts::format_number(&month_key, seq, origin))
            }
            _ => None,
        };
        Ok(DisaggregationLine {
            id: self.id,
            sscc_input: self.sscc_input,
            sscc: self.sscc,
            box_id: self.box_id,
            pallet_id: self.pallet_id,
            shift_id: self.shift_id,
            shift_number,
            status: self.status.parse().map_err(ApiError::internal)?,
            product_id: self.product_id,
            product_name: self.product_name,
            code_count: u64::try_from(self.code_count).map_err(ApiError::internal)?,
            validated_at: self.validated_at,
        })
    }
}

/// The card as the office reads it, through `conn` (the caller's
/// transaction, so a write answers with what it wrote).
pub(crate) async fn detail(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<DisaggregationDetail>, ApiError> {
    let row: Option<DocumentRow> = sqlx::query_as(&format!("{DOCUMENTS_SQL} WHERE d.id = ?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let lines: Vec<LineRow> = sqlx::query_as(LINES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Some(DisaggregationDetail {
        document: row.document()?,
        lines: lines
            .into_iter()
            .map(LineRow::line)
            .collect::<Result<_, _>>()?,
    }))
}

async fn card(conn: &mut SqliteConnection, id: &str) -> Result<DisaggregationDetail, ApiError> {
    detail(conn, id)
        .await?
        .ok_or_else(|| ApiError::internal("document vanished"))
}

/// What a write needs to know of a draft.
pub(crate) struct DraftRow {
    pub doc_no: String,
    pub reason_id: Option<String>,
    pub comment: Option<String>,
    pub rev: i64,
}

/// A draft for a write: 404 without it, `conflict` `document_not_draft`
/// after it is applied or cancelled.
pub(crate) async fn draft(conn: &mut SqliteConnection, id: &str) -> Result<DraftRow, ApiError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        doc_no: String,
        status: String,
        reason_id: Option<String>,
        comment: Option<String>,
        rev: i64,
    }
    let row: Option<Row> = sqlx::query_as(
        "SELECT doc_no, status, reason_id, comment, rev FROM disaggregation_documents \
         WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Err(ApiError::not_found("no such document"));
    };
    let status: DisaggregationStatus = row.status.parse().map_err(ApiError::internal)?;
    if status != DisaggregationStatus::Draft {
        return Err(ApiError::conflict(
            constraints::NOT_DRAFT,
            "the document is not a draft",
        ));
    }
    Ok(DraftRow {
        doc_no: row.doc_no,
        reason_id: row.reason_id,
        comment: row.comment,
        rev: row.rev,
    })
}

/// Take a revision and stamp the document with it and the moment.
pub(crate) async fn touch(
    conn: &mut SqliteConnection,
    id: &str,
    at: &str,
    rev: i64,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE disaggregation_documents SET updated_at = ?, rev = ? WHERE id = ?")
        .bind(at)
        .bind(rev)
        .bind(id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

async fn audited(
    conn: &mut SqliteConnection,
    context: &OfficeContext,
    at: &str,
    action: &str,
    id: &str,
    details: serde_json::Value,
) -> Result<(), ApiError> {
    audit::record(
        conn,
        at,
        Entry {
            actor: context.actor(),
            action,
            target_type: Some(TARGET_TYPE),
            target_id: Some(id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ListQuery {
    status: Option<String>,
    reason_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    q: Option<String>,
}

/// A host instant in its one spelling, or `validation_failed` on `field`.
fn instant(field: &str, text: Option<&str>) -> Result<Option<String>, ApiError> {
    text.map(|text| {
        parse_timestamp(text).map(format_timestamp).map_err(|_| {
            ApiError::validation(field, "an instant like 2026-10-13T09:05:00Z is required")
        })
    })
    .transpose()
}

pub async fn list_documents(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ListQuery>,
) -> Result<Json<Vec<DisaggregationDocument>>, ApiError> {
    let status = query
        .status
        .as_deref()
        .map(|status| {
            status
                .parse::<DisaggregationStatus>()
                .map(|status| status.as_str())
                .map_err(|_| ApiError::validation("status", "draft, applied or cancelled"))
        })
        .transpose()?;
    if let Some(reason) = &query.reason_id {
        validate::client_uuid("reasonId", reason)?;
    }
    let from = instant("from", query.from.as_deref())?;
    let to = instant("to", query.to.as_deref())?;
    let piece = match query.q.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => {
            let text = validate::clean_text("q", text, MAX_QUERY_CHARS, "the query")?;
            Some(
                text.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_"),
            )
        }
    };
    let sql = format!(
        "{DOCUMENTS_SQL} WHERE (?1 IS NULL OR d.status = ?1) AND (?2 IS NULL OR d.reason_id = ?2) \
         AND (?3 IS NULL OR d.created_at >= ?3) AND (?4 IS NULL OR d.created_at <= ?4) \
         AND (?5 IS NULL OR d.doc_no LIKE '%' || ?5 || '%' ESCAPE '\\') \
         ORDER BY d.created_at DESC, d.seq DESC LIMIT ?6"
    );
    let rows: Vec<DocumentRow> = sqlx::query_as(&sql)
        .bind(status)
        .bind(&query.reason_id)
        .bind(from)
        .bind(to)
        .bind(piece)
        .bind(LIST_LIMIT)
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(DocumentRow::document)
        .collect::<Result<_, _>>()
        .map(Json)
}

pub async fn get_document(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    detail(&mut conn, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such document"))
}

/// A comment after the header's one rule: trimmed, nothing at all is none.
fn comment_of(text: Option<&str>) -> Result<Option<String>, ApiError> {
    match text.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) => validate::clean_text("comment", text, MAX_COMMENT_CHARS, "the comment")
            .map(|text| Some(text.to_owned())),
    }
}

/// A reason the header may name: a live one, or the one it names already
/// (an archived reason stays on the documents that took it).
async fn check_reason(
    conn: &mut SqliteConnection,
    reason_id: Option<&str>,
    current: Option<&str>,
) -> Result<(), ApiError> {
    let Some(reason_id) = reason_id else {
        return Ok(());
    };
    validate::client_uuid("reasonId", reason_id)?;
    let archived: Option<bool> =
        sqlx::query_scalar("SELECT archived FROM disaggregation_reasons WHERE id = ?")
            .bind(reason_id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    match archived {
        Some(false) => Ok(()),
        Some(true) if current == Some(reason_id) => Ok(()),
        Some(true) => Err(ApiError::validation(
            "reasonId",
            "the reason is archived; name a live one",
        )),
        None => Err(ApiError::validation("reasonId", "no such reason")),
    }
}

pub async fn create_document(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<DisaggregationCreate>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    let comment = comment_of(create.comment.as_deref())?;
    if let Some(reason) = &create.reason_id {
        validate::client_uuid("reasonId", reason)?;
    }
    let now = state.now();
    let at = format_timestamp(now);
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    check_reason(&mut tx, create.reason_id.as_deref(), None).await?;
    let seq = disaggregation::next_seq(&mut tx).await?;
    let doc_no = disaggregation::format_doc_no(seq, now.to_offset(time::UtcOffset::UTC).year());
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO disaggregation_documents (id, seq, doc_no, status, reason_id, comment, \
         source, created_by, created_at, updated_at, rev) \
         VALUES (?, ?, ?, 'draft', ?, ?, 'manual', ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(seq)
    .bind(&doc_no)
    .bind(&create.reason_id)
    .bind(&comment)
    .bind(&context.user.id)
    .bind(&at)
    .bind(&at)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_CREATE,
        &id,
        json!({ "docNo": doc_no, "reasonId": create.reason_id, "comment": comment }),
    )
    .await?;
    let created = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_document(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<DisaggregationUpdate>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    let comment = comment_of(update.comment.as_deref())?;
    if let Some(reason) = &update.reason_id {
        validate::client_uuid("reasonId", reason)?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let current = draft(&mut tx, &id).await?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    check_reason(
        &mut tx,
        update.reason_id.as_deref(),
        current.reason_id.as_deref(),
    )
    .await?;
    let Some(details) = audit::update_details(&[
        (
            "reasonId",
            json!(current.reason_id),
            json!(update.reason_id),
        ),
        ("comment", json!(current.comment), json!(comment)),
    ]) else {
        // Nothing actually changed: the card as it is, without a revision, a
        // row nobody changed, or an audit row for a no-op.
        let same = card(&mut tx, &id).await?;
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(same));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE disaggregation_documents SET reason_id = ?, comment = ?, updated_at = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(&update.reason_id)
    .bind(&comment)
    .bind(&at)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_UPDATE,
        &id,
        details,
    )
    .await?;
    let updated = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// One line as the host will store it, checked before the lock.
struct NewLine {
    input: String,
    sscc: Option<String>,
}

fn new_lines(add: &DisaggregationLinesAdd) -> Result<Vec<NewLine>, ApiError> {
    if add.lines.is_empty() || add.lines.len() > MAX_LINES_PER_REQUEST {
        return Err(ApiError::validation(
            "lines",
            format!("1-{MAX_LINES_PER_REQUEST} lines are required"),
        ));
    }
    add.lines
        .iter()
        .enumerate()
        .map(|(n, line)| {
            let input = validate::clean_text(
                &format!("lines.{n}.input"),
                &line.input,
                MAX_INPUT_CHARS,
                "the input",
            )?;
            if let Some(sscc) = &line.sscc {
                if sscc.len() != 18 || !sscc.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(ApiError::validation(
                        &format!("lines.{n}.sscc"),
                        "an SSCC is 18 digits",
                    ));
                }
            }
            Ok(NewLine {
                input: input.to_owned(),
                sscc: line.sscc.clone(),
            })
        })
        .collect()
}

/// Write one line with the status its `target` gave.
#[allow(clippy::too_many_arguments)]
async fn insert_line(
    conn: &mut SqliteConnection,
    document_id: &str,
    position: i64,
    input: &str,
    sscc: Option<&str>,
    status: LineStatus,
    target: Option<&Target>,
    at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO disaggregation_document_lines (id, document_id, position, sscc_input, sscc, \
         box_id, pallet_id, status, product_id, code_count, validated_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(document_id)
    .bind(position)
    .bind(input)
    .bind(sscc)
    .bind(target.and_then(|t| t.box_id.as_deref()))
    .bind(target.and_then(|t| t.pallet_id.as_deref()))
    .bind(status.as_str())
    .bind(target.map(|t| t.product_id.as_str()))
    .bind(target.map_or(0, |t| t.code_count))
    .bind(at)
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

pub async fn add_lines(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(add): ApiJson<DisaggregationLinesAdd>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    // Every line is checked whole before the lock: a refusal writes nothing.
    let lines = new_lines(&add)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let current = draft(&mut tx, &id).await?;
    let (count, last): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MAX(position), 0) FROM disaggregation_document_lines \
         WHERE document_id = ?",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let total = usize::try_from(count)
        .map_err(ApiError::internal)?
        .saturating_add(lines.len());
    if total > MAX_LINES_PER_DOCUMENT {
        return Err(ApiError::validation(
            "lines",
            format!("a document holds at most {MAX_LINES_PER_DOCUMENT} lines"),
        ));
    }
    let present: Vec<String> = sqlx::query_scalar(
        "SELECT sscc FROM disaggregation_document_lines WHERE document_id = ? \
         AND sscc IS NOT NULL",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let mut present: HashSet<String> = present.into_iter().collect();
    for (offset, line) in lines.iter().enumerate() {
        let position = last + 1 + i64::try_from(offset).map_err(ApiError::internal)?;
        let Some(sscc) = line.sscc.as_deref() else {
            // Not read as an SSCC: nothing to look for.
            insert_line(
                &mut tx,
                &id,
                position,
                &line.input,
                None,
                LineStatus::NotFound,
                None,
                &at,
            )
            .await?;
            continue;
        };
        if !present.insert(sscc.to_owned()) {
            // A repeat: the cloud's marker, the input kept and the SSCC not.
            insert_line(
                &mut tx,
                &id,
                position,
                &line.input,
                None,
                LineStatus::Duplicate,
                None,
                &at,
            )
            .await?;
            continue;
        }
        match disaggregation::resolve(&mut tx, sscc).await? {
            None => {
                insert_line(
                    &mut tx,
                    &id,
                    position,
                    &line.input,
                    Some(sscc),
                    LineStatus::NotFound,
                    None,
                    &at,
                )
                .await?;
            }
            Some(target) => {
                insert_line(
                    &mut tx,
                    &id,
                    position,
                    &line.input,
                    Some(sscc),
                    target.status,
                    Some(&target),
                    &at,
                )
                .await?;
            }
        }
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE disaggregation_documents SET source = CASE WHEN ? THEN 'import' ELSE source END, \
         updated_at = ?, rev = ? WHERE id = ?",
    )
    .bind(add.import)
    .bind(&at)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_LINES_ADD,
        &id,
        json!({ "docNo": current.doc_no, "added": lines.len(), "import": add.import }),
    )
    .await?;
    let answer = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(answer))
}

pub async fn delete_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath((id, line_id)): ApiPath<(String, String)>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let current = draft(&mut tx, &id).await?;
    let input: Option<String> = sqlx::query_scalar(
        "DELETE FROM disaggregation_document_lines WHERE id = ? AND document_id = ? \
         RETURNING sscc_input",
    )
    .bind(&line_id)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let Some(input) = input else {
        return Err(ApiError::not_found("no such line"));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    touch(&mut tx, &id, &at, rev).await?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_LINE_DELETE,
        &id,
        json!({ "docNo": current.doc_no, "lineId": line_id, "ssccInput": input }),
    )
    .await?;
    let answer = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(answer))
}

pub async fn cancel_document(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(transition): ApiJson<DisaggregationTransition>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let current = draft(&mut tx, &id).await?;
    if current.rev != transition.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE disaggregation_documents SET status = 'cancelled', cancelled_at = ?, \
         cancelled_by = ?, updated_at = ?, rev = ? WHERE id = ?",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&at)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_CANCEL,
        &id,
        json!({ "docNo": current.doc_no }),
    )
    .await?;
    let answer = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(answer))
}

/// Write what line `line_id` names now: the status, the target and the
/// codes, and the moment it was checked. `None` is nothing (`not_found`).
async fn revalidate_line(
    conn: &mut SqliteConnection,
    line_id: &str,
    target: Option<&Target>,
    at: &str,
) -> Result<(), ApiError> {
    let status = target.map_or(LineStatus::NotFound, |target| target.status);
    sqlx::query(
        "UPDATE disaggregation_document_lines SET status = ?, box_id = ?, pallet_id = ?, \
         product_id = ?, code_count = ?, validated_at = ? WHERE id = ?",
    )
    .bind(status.as_str())
    .bind(target.and_then(|t| t.box_id.as_deref()))
    .bind(target.and_then(|t| t.pallet_id.as_deref()))
    .bind(target.map(|t| t.product_id.as_str()))
    .bind(target.map_or(0, |t| t.code_count))
    .bind(at)
    .bind(line_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

/// Apply a draft: one transaction under the facts' lock (`routes/facts.rs`),
/// so no station batch runs between the checks below and the writes. Every
/// line is checked again from the live tables; when one is not `ok` the
/// fresh statuses are saved, the document stays a draft and the answer is
/// `conflict` `invalid_lines`. Otherwise each box is taken apart as a
/// station's `disassemble` takes it, each pallet as a station's pallet
/// `disassemble`, under one revision.
pub async fn apply_document(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(transition): ApiJson<DisaggregationTransition>,
) -> Result<Json<DisaggregationDetail>, ApiError> {
    context.require_disaggregation()?;
    // A big document holds the write lock for seconds, and a client that
    // gives up (the webview's own limit) drops this future: the apply runs
    // on its own task, so a hang-up never cuts it midway and a retry finds
    // it done instead of racing it.
    tokio::spawn(apply(state, context, id, transition))
        .await
        .map_err(ApiError::internal)?
        .map(Json)
}

async fn apply(
    state: AppState,
    context: OfficeContext,
    id: String,
    transition: DisaggregationTransition,
) -> Result<DisaggregationDetail, ApiError> {
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    // A restore holds the stations' facts (`site.facts_held_since`) until an
    // administrator resumes them: the host is a copy that lacks everything
    // after it, so an apply would take boxes apart on stale data and the
    // facts that follow would meet the result. Read under the lock, with the
    // role: the hold cannot start between this check and the writes.
    let held: Option<String> = sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if let Some(since) = held {
        return Err(ApiError::conflict(
            constraints::RESTORE_HOLD,
            "the host was restored from a copy: documents wait until the office resumes the facts",
        )
        .with_details(json!({ "constraint": constraints::RESTORE_HOLD, "since": since })));
    }
    let now = state.now();
    let at = format_timestamp(now);
    let doc = draft(&mut tx, &id).await?;
    if doc.rev != transition.expected_rev {
        return Err(ApiError::stale_revision(doc.rev));
    }
    if doc.reason_id.is_none() {
        return Err(ApiError::conflict(
            constraints::REASON_REQUIRED,
            "the document has no reason",
        ));
    }
    let lines: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, sscc FROM disaggregation_document_lines WHERE document_id = ? \
         ORDER BY position",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if lines.is_empty() {
        return Err(ApiError::conflict(
            constraints::NO_LINES,
            "the document has no lines",
        ));
    }
    // Every line again, from the live tables; a line without an SSCC (not
    // read, or a repeat) keeps its status and is never `ok`.
    let mut targets = Vec::with_capacity(lines.len());
    let mut invalid = 0usize;
    for (line_id, sscc) in &lines {
        let Some(sscc) = sscc else {
            invalid += 1;
            continue;
        };
        let target = disaggregation::resolve(&mut tx, sscc).await?;
        revalidate_line(&mut tx, line_id, target.as_ref(), &at).await?;
        match target {
            Some(target) if target.status == LineStatus::Ok => targets.push(target),
            _ => invalid += 1,
        }
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    if invalid > 0 {
        // The fresh statuses stay and the document stays a draft (the cloud
        // commits them before it answers `invalid_lines`).
        touch(&mut tx, &id, &at, rev).await?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::DISAGGREGATION_APPLY,
                target_type: Some(TARGET_TYPE),
                target_id: Some(&id),
                outcome: Outcome::Failed,
                details: json!({ "docNo": doc.doc_no, "invalidLines": invalid }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
        commit_with_revision(tx, &state.revisions, rev)
            .await
            .map_err(ApiError::internal)?;
        return Err(ApiError::conflict(
            constraints::INVALID_LINES,
            "some lines of the document are not ok",
        )
        .with_details(
            json!({ "constraint": constraints::INVALID_LINES, "invalidLines": invalid }),
        ));
    }
    let instant = rules::device_text(now);
    let done = disaggregation::apply_targets(&mut tx, &id, &targets, &instant, &at, rev).await?;
    sqlx::query(
        "UPDATE disaggregation_documents SET status = 'applied', applied_at = ?, \
         applied_by = ?, updated_at = ?, rev = ? WHERE id = ?",
    )
    .bind(&at)
    .bind(&context.user.id)
    .bind(&at)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audited(
        &mut tx,
        &context,
        &at,
        actions::DISAGGREGATION_APPLY,
        &id,
        json!({ "docNo": doc.doc_no, "boxes": done.boxes, "pallets": done.pallets,
            "codes": done.codes }),
    )
    .await?;
    let answer = card(&mut tx, &id).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(answer)
}
