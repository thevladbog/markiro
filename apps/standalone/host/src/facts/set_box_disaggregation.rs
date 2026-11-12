use markiro_proto::{disaggregation::DisaggregationLineStatus, receipt_codes};
use serde_json::json;
use sqlx::SqliteConnection;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use super::{batch_revision, rules, Context, Failure, Reject};
use crate::{
    audit::{self, actions, Actor, Entry, Outcome},
    disaggregation::{self, Target},
    error::ApiError,
};

const REASON_ID: &str = "d15a0000-0000-4000-8000-000000000006";

struct SourceBox {
    sscc: String,
    target: Target,
}

fn source_refusal(box_id: &str, constraint: &str) -> Failure {
    Reject {
        code: receipt_codes::BOX_STATE,
        details: Some(json!({ "boxId": box_id, "constraint": constraint })),
    }
    .into()
}

/// Find each live local source box once. Check every source before writing
/// the document, so a refused set never frees only part of its sources.
async fn source_boxes(
    conn: &mut SqliteConnection,
    component_hashes: &[&str],
) -> Result<Vec<SourceBox>, Failure> {
    let hashes = serde_json::to_string(component_hashes).map_err(ApiError::internal)?;
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT b.id, b.sscc FROM json_each(?) h
         JOIN code_owners o ON o.code_hash = h.value
         JOIN boxes b ON b.id = o.box_id
         JOIN box_items i ON i.box_id = b.id AND i.scan_id = o.scan_id
         WHERE b.disassembled_at IS NULL AND i.removed_at IS NULL AND i.displaced_at IS NULL
         ORDER BY b.id",
    )
    .bind(hashes)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let mut boxes = Vec::with_capacity(rows.len());
    for (id, sscc) in rows {
        let sscc = sscc.ok_or_else(|| source_refusal(&id, "source_box_not_closed"))?;
        let target = disaggregation::resolve(&mut *conn, &sscc)
            .await?
            .filter(|target| target.box_id.as_deref() == Some(id.as_str()))
            .ok_or_else(|| ApiError::internal("source box could not be resolved"))?;
        match target.status {
            DisaggregationLineStatus::Ok => boxes.push(SourceBox { sscc, target }),
            DisaggregationLineStatus::ShiftOpen => {
                return Err(source_refusal(&id, "source_shift_open"));
            }
            _ => return Err(source_refusal(&id, "source_box_not_closed")),
        }
    }
    Ok(boxes)
}

/// The caller checked the exact set contents and all set claims. The applied
/// document, code releases and new assembly share the fact batch transaction.
pub(super) async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    component_hashes: &[&str],
    revision: &mut Option<i64>,
) -> Result<Option<String>, Failure> {
    let sources = source_boxes(&mut *conn, component_hashes).await?;
    if sources.is_empty() {
        return Ok(None);
    }
    let operator = context
        .operator_id
        .ok_or_else(|| Reject::field("operatorId"))?;
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operators WHERE id = ? AND active = 1)")
            .bind(operator)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if !active {
        return Err(Reject::field("operatorId").into());
    }

    let at = context.received_at;
    let now = OffsetDateTime::parse(at, &Rfc3339).map_err(ApiError::internal)?;
    let instant = rules::device_text(now);
    let seq = disaggregation::next_seq(&mut *conn).await?;
    let doc_no = disaggregation::format_doc_no(seq, now.year());
    let document_id = Uuid::new_v4().to_string();
    let rev = batch_revision(&mut *conn, revision).await?;
    // The system reason is visible in documents and hidden from the manual picker.
    sqlx::query(
        "INSERT INTO disaggregation_reasons (id, name, sort_order, archived, created_at, rev)
         VALUES (?, 'Сборка набора', 100, 1, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(REASON_ID)
    .bind(at)
    .bind(rev)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO disaggregation_documents
         (id, seq, doc_no, status, reason_id, comment, source, created_at, applied_at,
          updated_at, rev, device_id, operator_id, device_request_id, device_request_json)
         VALUES (?, ?, ?, 'applied', ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&document_id)
    .bind(seq)
    .bind(&doc_no)
    .bind(REASON_ID)
    .bind(format!(
        "Автоматически при сборке набора в смене {}",
        context.shift.number
    ))
    .bind(at)
    .bind(at)
    .bind(at)
    .bind(rev)
    .bind(context.device_id)
    .bind(operator)
    .bind(format!("set_assembly:{}", context.record_id))
    .bind(
        json!({"kind": "set_assembly", "shiftId": context.shift.id, "recordId": context.record_id})
            .to_string(),
    )
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let mut targets = Vec::with_capacity(sources.len());
    for (position, SourceBox { sscc, target }) in (1_i64..).zip(sources) {
        sqlx::query(
            "INSERT INTO disaggregation_document_lines
             (id, document_id, position, sscc_input, sscc, box_id, status, product_id,
              code_count, validated_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&document_id)
        .bind(position)
        .bind(&sscc)
        .bind(&sscc)
        .bind(&target.box_id)
        .bind(&target.product_id)
        .bind(target.code_count)
        .bind(at)
        .bind(at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        targets.push(target);
    }
    let done = disaggregation::apply_targets(&mut *conn, &document_id, &targets, &instant, at, rev)
        .await?;
    audit::record(
        conn,
        at,
        Entry {
            actor: Actor::Device(context.device_id),
            action: actions::DISAGGREGATION_APPLY,
            target_type: Some("disaggregation_document"),
            target_id: Some(&document_id),
            outcome: Outcome::Ok,
            details: json!({
                "docNo": doc_no, "source": "set_assembly", "operatorId": operator,
                "shiftId": context.shift.id, "setRecordId": context.record_id,
                "boxes": done.boxes, "pallets": done.pallets, "codes": done.codes,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    Ok(Some(document_id))
}
