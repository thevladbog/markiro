//! Any local pack by SSCC, with an explicitly confirmed snapshot and durable device request ID.
use crate::{
    audit::{self, actions, Actor, Entry, Outcome},
    auth::AuthDevice,
    db::{begin_write, commit_with_revision, next_revision},
    disaggregation::{self, Target},
    error::{ApiError, ApiJson},
    facts::rules,
    server::AppState,
    validate,
};
use aws_lc_rs::digest::{digest, SHA256};
use axum::{extract::State, Json};
use markiro_proto::{
    device_disaggregation::*, disaggregation::DisaggregationLineStatus, DeviceKind,
};
use serde_json::json;
use sqlx::SqliteConnection;

fn sscc(value: &str) -> Result<(), ApiError> {
    if value.len() != 18 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::validation("sscc", "18 digits required"));
    }
    Ok(())
}
async fn admitted(
    conn: &mut SqliteConnection,
    device: &AuthDevice,
    operator: &str,
) -> Result<(), ApiError> {
    device
        .require_kinds_in(
            conn,
            &[DeviceKind::Handheld],
            "only handheld devices disassemble site packs",
        )
        .await?;
    validate::client_uuid("operatorId", operator)?;
    let active: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operators WHERE id=? AND active=1)")
            .bind(operator)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if !active {
        return Err(ApiError::forbidden("an active operator is required"));
    }
    crate::cloud_history::require_ready(conn).await?;
    let held: bool = sqlx::query_scalar("SELECT facts_held_since IS NOT NULL FROM site WHERE id=1")
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if held {
        return Err(ApiError::conflict(
            "restore_hold",
            "resume device facts before disassembly",
        ));
    }
    Ok(())
}

async fn inspect(
    conn: &mut SqliteConnection,
    code: &str,
) -> Result<(Target, PackInspection), ApiError> {
    let target = disaggregation::resolve(&mut *conn, code)
        .await?
        .ok_or_else(|| ApiError::conflict("pack_not_found", "no such pack"))?;
    if target.cloud {
        return Err(ApiError::conflict(
            "cloud_history",
            "imported historical packs require the office administrator",
        ));
    }
    let product = target
        .product_id
        .as_deref()
        .ok_or_else(|| ApiError::internal("pack product missing"))?;
    let (name, demo): (String, bool) = sqlx::query_as("SELECT name,demo FROM products WHERE id=?")
        .bind(product)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if demo {
        return Err(ApiError::conflict(
            "demo_box",
            "demo packs cannot be disaggregated",
        ));
    }
    type Member = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let members:Vec<Member>=sqlx::query_as("SELECT b.id,b.sscc,b.closed_at,b.disassembled_at,(SELECT group_concat(live.scan_id,',') FROM (SELECT i.scan_id FROM box_items i WHERE i.box_id=b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL ORDER BY i.scan_id) live) FROM boxes b WHERE b.id=?1 OR b.pallet_id=?2 OR EXISTS(SELECT 1 FROM warehouse_pallet_boxes wb WHERE wb.pallet_id=?3 AND wb.box_sscc=b.sscc AND wb.removed_at IS NULL) ORDER BY b.id LIMIT 10001")
        .bind(&target.box_id).bind(&target.pallet_id).bind(&target.warehouse_pallet_id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    if members.len() > 10000 {
        return Err(ApiError::conflict(
            "pack_members_limit",
            "pack exceeds the inspection limit",
        ));
    }
    let kind = if target.box_id.is_some() {
        PackKind::Box
    } else {
        PackKind::Pallet
    };
    let boxes = u32::try_from(
        members
            .iter()
            .filter(|m| m.2.is_some() && m.3.is_none())
            .count(),
    )
    .map_err(ApiError::internal)?;
    let snapshot = json!({"sscc":code,"kind":kind,"productId":product,"productName":name,"status":target.status,"units":target.code_count,"boxId":target.box_id,"palletId":target.pallet_id,"warehousePalletId":target.warehouse_pallet_id,"members":members});
    let token = digest(
        &SHA256,
        serde_json::to_string(&snapshot)
            .map_err(ApiError::internal)?
            .as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|b| format!("{b:02x}"))
    .collect();
    let reasons:Vec<(String,String)>=sqlx::query_as("SELECT id,name FROM disaggregation_reasons WHERE archived=0 ORDER BY sort_order,name,id LIMIT 1000").fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
    let response = PackInspection {
        sscc: code.into(),
        kind,
        product_name: name,
        boxes,
        units: u64::try_from(target.code_count).map_err(ApiError::internal)?,
        status: target.status,
        token,
        reasons: reasons
            .into_iter()
            .map(|(id, name)| PackReason { id, name })
            .collect(),
    };
    Ok((target, response))
}

pub async fn lookup(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(body): ApiJson<PackLookup>,
) -> Result<Json<PackInspection>, ApiError> {
    sscc(&body.sscc)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    admitted(&mut tx, &device, &body.operator_id).await?;
    let (_, response) = inspect(&mut tx, &body.sscc).await?;
    Ok(Json(response))
}

pub async fn apply(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(mut body): ApiJson<PackDisassemble>,
) -> Result<Json<PackDisassembled>, ApiError> {
    sscc(&body.sscc)?;
    validate::client_uuid("requestId", &body.request_id)?;
    validate::client_uuid("reasonId", &body.reason_id)?;
    body.request_id = uuid::Uuid::parse_str(&body.request_id)
        .map_err(ApiError::internal)?
        .to_string();
    if body.expected_token.len() != 64
        || !body.expected_token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(ApiError::validation(
            "expectedToken",
            "inspection token required",
        ));
    }
    tokio::spawn(async move { apply_inner(state, device, body).await })
        .await
        .map_err(ApiError::internal)?
        .map(Json)
}

async fn apply_inner(
    state: AppState,
    device: AuthDevice,
    body: PackDisassemble,
) -> Result<PackDisassembled, ApiError> {
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    admitted(&mut tx, &device, &body.operator_id).await?;
    let canonical = serde_json::to_string(&body).map_err(ApiError::internal)?;
    let prior:Option<(String,String,String,String)>=sqlx::query_as("SELECT id,doc_no,device_request_json,applied_at FROM disaggregation_documents WHERE device_id=? AND device_request_id=?").bind(&device.id).bind(&body.request_id).fetch_optional(&mut *tx).await.map_err(ApiError::internal)?;
    if let Some((id, no, old, applied_at)) = prior {
        if old != canonical {
            return Err(ApiError::conflict(
                "request_id",
                "request ID already names a different operation",
            ));
        }
        let (box_id, count): (Option<String>, i64) = sqlx::query_as(
            "SELECT box_id,code_count FROM disaggregation_document_lines WHERE document_id=?",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        return Ok(PackDisassembled {
            document_id: id,
            applied_at,
            doc_no: no,
            sscc: body.sscc,
            kind: if box_id.is_some() {
                PackKind::Box
            } else {
                PackKind::Pallet
            },
            boxes: u32::from(box_id.is_some()),
            codes: if box_id.is_some() {
                u64::try_from(count).map_err(ApiError::internal)?
            } else {
                0
            },
        });
    }
    let (target, inspection) = inspect(&mut tx, &body.sscc).await?;
    if target.status != DisaggregationLineStatus::Ok {
        return Err(ApiError::conflict(
            target.status.as_str(),
            "pack is not ready for disassembly",
        ));
    }
    if inspection.token != body.expected_token {
        return Err(ApiError::conflict(
            "pack_changed",
            "pack changed since inspection; scan and confirm again",
        ));
    }
    if !inspection.reasons.iter().any(|r| r.id == body.reason_id) {
        return Err(ApiError::conflict(
            "reason_required",
            "choose an active reason",
        ));
    }
    let now = state.now();
    let at = state.timestamp();
    let instant = rules::device_text(now);
    let seq = disaggregation::next_seq(&mut tx).await?;
    let no = disaggregation::format_doc_no(seq, now.year());
    let id = uuid::Uuid::new_v4().to_string();
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO disaggregation_documents(id,seq,doc_no,status,reason_id,source,created_at,applied_at,updated_at,rev,device_id,operator_id,device_request_id,device_request_json) VALUES(?,?,?,'applied',?,'manual',?,?,?,?,?,?,?,?)")
        .bind(&id).bind(seq).bind(&no).bind(&body.reason_id).bind(&at).bind(&at).bind(&at).bind(rev).bind(&device.id).bind(&body.operator_id).bind(&body.request_id).bind(canonical).execute(&mut *tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO disaggregation_document_lines(id,document_id,position,sscc_input,sscc,box_id,pallet_id,warehouse_pallet_id,status,product_id,code_count,validated_at,created_at) VALUES(?,?,1,?,?,?,?,?,'ok',?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&id).bind(&body.sscc).bind(&body.sscc).bind(&target.box_id).bind(&target.pallet_id).bind(&target.warehouse_pallet_id).bind(&target.product_id).bind(target.code_count).bind(&at).bind(&at).execute(&mut *tx).await.map_err(ApiError::internal)?;
    let done = disaggregation::apply_targets(&mut tx, &id, &[target], &instant, &at, rev).await?;
    audit::record(&mut tx,&at,Entry{actor:Actor::Device(&device.id),action:actions::DISAGGREGATION_APPLY,target_type:Some("disaggregation_document"),target_id:Some(&id),outcome:Outcome::Ok,details:json!({"docNo":no,"boxes":done.boxes,"pallets":done.pallets,"codes":done.codes,"operatorId":body.operator_id})}).await.map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(PackDisassembled {
        document_id: id,
        applied_at: at,
        doc_no: no,
        sscc: body.sscc,
        kind: inspection.kind,
        boxes: u32::try_from(done.boxes).map_err(ApiError::internal)?,
        codes: u64::try_from(done.codes).map_err(ApiError::internal)?,
    })
}
