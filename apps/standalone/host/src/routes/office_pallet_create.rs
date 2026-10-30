//! Atomic office creation of a closed warehouse pallet, without device facts or a fake shift.
use crate::{
    audit::{self, actions, Entry, Outcome},
    auth::OfficeContext,
    db::{begin_write, commit_with_revision, next_revision},
    error::{ApiError, ApiJson},
    facts::{registry_touch, rules},
    license::{
        gate,
        seats::{self, Feature},
    },
    server::AppState,
    validate,
};
use axum::{extract::State, http::StatusCode, Json};
use markiro_proto::office_pallet_create::{build_pallet_sscc, normalize_sscc, MAX_PALLET_BOXES};
use markiro_proto::{
    OfficePalletCreate, OfficePalletCreated, OfficePalletInputError, OfficePalletValidate,
    OfficePalletValidation,
};
use serde_json::json;
use sqlx::SqliteConnection;
use std::collections::BTreeMap;

#[derive(sqlx::FromRow)]
struct Candidate {
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    product_id: String,
    product_name: String,
    demo: bool,
    production_pallet: Option<String>,
    warehouse_pallet: Option<String>,
    units: i64,
}

fn check_size(codes: &[String]) -> Result<(), ApiError> {
    let count = codes.iter().filter(|s| !s.trim().is_empty()).count();
    if count == 0 || count > MAX_PALLET_BOXES || codes.iter().any(|s| s.len() > 256) {
        return Err(ApiError::validation(
            "codes",
            "1-1000 nonempty box codes, at most 256 bytes each",
        ));
    }
    Ok(())
}

fn input_error(
    line: usize,
    code: &str,
    sscc: Option<&str>,
    pallet: Option<&str>,
) -> OfficePalletInputError {
    OfficePalletInputError {
        line,
        code: code.into(),
        sscc: sscc.map(str::to_owned),
        pallet_id: pallet.map(str::to_owned),
        pallet_kind: None,
    }
}

/// One consistent snapshot; a creation calls this again under BEGIN IMMEDIATE.
async fn inspect(
    conn: &mut SqliteConnection,
    codes: &[String],
) -> Result<OfficePalletValidation, ApiError> {
    let mut seen: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut errors = vec![];
    for (i, raw) in codes.iter().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        match normalize_sscc(raw) {
            Some(sscc) if sscc.starts_with('0') => {
                seen.entry(sscc).or_default().push(i + 1);
            }
            Some(sscc) => errors.push(input_error(i + 1, "not_box", Some(&sscc), None)),
            None => errors.push(input_error(i + 1, "invalid_sscc", None, None)),
        }
    }
    let mut ordered: Vec<_> = seen.into_iter().collect();
    ordered.sort_by_key(|(_, lines)| lines[0]);
    let mut product_id: Option<String> = None;
    let mut product_name = None;
    let mut boxes = 0;
    let mut units = 0;
    for (sscc, lines) in ordered {
        if lines.len() > 1 {
            errors.extend(
                lines
                    .into_iter()
                    .map(|line| input_error(line, "duplicate", Some(&sscc), None)),
            );
            continue;
        }
        let line = lines[0];
        let row:Option<Candidate> = sqlx::query_as(
            "SELECT b.closed_at,b.disassembled_at,sh.product_id,pr.name AS product_name, pr.demo, \
             (SELECT p.id FROM pallets p WHERE p.id=b.pallet_id AND p.disassembled_at IS NULL) AS production_pallet, \
             (SELECT wp.id FROM warehouse_pallet_boxes wb JOIN warehouse_pallets wp ON wp.id=wb.pallet_id \
              WHERE wb.box_sscc=b.sscc AND wb.removed_at IS NULL AND wp.disassembled_at IS NULL) AS warehouse_pallet, \
             (SELECT count(*) FROM box_items i WHERE i.box_id=b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
             FROM boxes b JOIN shifts sh ON sh.id=b.shift_id JOIN products pr ON pr.id=sh.product_id WHERE b.sscc=?")
            .bind(&sscc).fetch_optional(&mut *conn).await.map_err(ApiError::internal)?;
        let Some(row) = row else {
            errors.push(input_error(line, "not_found", Some(&sscc), None));
            continue;
        };
        let occupied = row
            .production_pallet
            .as_deref()
            .or(row.warehouse_pallet.as_deref());
        let code = if row.demo {
            Some("demo_box")
        } else if row.closed_at.is_none() {
            Some("not_closed")
        } else if row.disassembled_at.is_some() {
            Some("disassembled")
        } else if occupied.is_some() {
            Some("already_on_pallet")
        } else if product_id.as_ref().is_some_and(|id| id != &row.product_id) {
            Some("product_mismatch")
        } else {
            None
        };
        if let Some(code) = code {
            let mut error = input_error(line, code, Some(&sscc), occupied);
            if occupied.is_some() {
                error.pallet_kind = Some(
                    if row.production_pallet.is_some() {
                        "production"
                    } else {
                        "warehouse"
                    }
                    .into(),
                );
            }
            errors.push(error);
            continue;
        }
        product_id = Some(row.product_id);
        product_name = Some(row.product_name);
        boxes += 1;
        units += u64::try_from(row.units).map_err(ApiError::internal)?;
    }
    errors.sort_by_key(|e| e.line);
    Ok(OfficePalletValidation {
        valid: errors.is_empty() && boxes > 0,
        product_id,
        product_name,
        boxes,
        units,
        errors,
    })
}

pub async fn validate_codes(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(body): ApiJson<OfficePalletValidate>,
) -> Result<Json<OfficePalletValidation>, ApiError> {
    context.require_shift_planning()?;
    check_size(&body.codes)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let result = inspect(&mut tx, &body.codes).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(result))
}

pub async fn create(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(body): ApiJson<OfficePalletCreate>,
) -> Result<Json<OfficePalletCreated>, ApiError> {
    context.require_shift_planning()?;
    check_size(&body.codes)?;
    validate::client_uuid("requestId", &body.request_id)?;
    let mut canonical: Vec<String> = body
        .codes
        .iter()
        .filter(|s| !s.trim().is_empty())
        .map(|s| normalize_sscc(s).unwrap_or_else(|| s.trim().into()))
        .collect();
    canonical.sort();
    let hash = rules::record_digest(&json!(canonical));
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_shift_planning_in(&mut tx).await?;
    let old: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id,sscc,creation_hash FROM warehouse_pallets WHERE creation_request_id=?",
    )
    .bind(&body.request_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if let Some((id, sscc, old_hash)) = old {
        if old_hash != hash {
            return Err(ApiError::conflict(
                "request_id",
                "this request names a different set of boxes",
            ));
        }
        return Ok(Json(OfficePalletCreated { id, sscc }));
    }
    // A restored copy must reconcile late factory facts before allocating on its view of boxes.
    let held: Option<String> = sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id=1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if let Some(since) = held {
        return Err(ApiError::conflict(
            "restore_hold",
            "resume the restored host before creating pallets",
        )
        .with_details(json!({"constraint":"restore_hold","since":since})));
    }
    gate::require_new_shifts(&state, &mut tx).await?;
    seats::require_feature(&state, &mut tx, Feature::Pallets).await?;
    let checked = inspect(&mut tx, &body.codes).await?;
    if !checked.valid {
        return Err(
            ApiError::conflict("pallet_codes", "fix every box before creating a pallet")
                .with_details(json!({"constraint":"pallet_codes","validation":checked})),
        );
    }
    let product = checked
        .product_id
        .as_deref()
        .ok_or_else(|| ApiError::internal("validated pallet has no product"))?;
    let gtin: String = sqlx::query_scalar("SELECT gtin14 FROM products WHERE id=?")
        .bind(product)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let gln: String = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id=1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if gln.len() != 13 || !gln.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::conflict(
            "org_gln_missing",
            "configure the organization GLN",
        ));
    }
    let prefix = validate::issuer_prefix(&gln);
    let serial: Option<i64> = sqlx::query_scalar(
        "SELECT next_serial FROM sscc_counters WHERE issuer_prefix=? AND extension=1",
    )
    .bind(prefix)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let serial = serial.ok_or_else(|| {
        ApiError::conflict("org_gln_missing", "configure the pallet SSCC counter")
    })?;
    let sscc = build_pallet_sscc(prefix, u64::try_from(serial).map_err(ApiError::internal)?)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                markiro_proto::codes::SSCC_EXHAUSTED,
                "no pallet SSCC serial is left",
            )
        })?;
    if crate::cloud_history::reserved_sscc(&mut tx, &sscc).await? {
        return Err(ApiError::conflict(
            "sscc_reserved",
            "this SSCC is reserved by imported history",
        ));
    }
    let collision:Option<i64>=sqlx::query_scalar("SELECT 1 FROM pallets WHERE sscc=?1 UNION ALL SELECT 1 FROM warehouse_pallets WHERE sscc=?1").bind(&sscc).fetch_optional(&mut *tx).await.map_err(ApiError::internal)?;
    if collision.is_some() {
        return Err(ApiError::conflict(
            "sscc_reserved",
            "this SSCC already exists",
        ));
    }
    let at = state.timestamp();
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let id = uuid::Uuid::new_v4().to_string();
    let block = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "UPDATE sscc_counters SET next_serial=?,rev=? WHERE issuer_prefix=? AND extension=1",
    )
    .bind(serial + 1)
    .bind(rev)
    .bind(prefix)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO sscc_blocks(id,issuer_prefix,extension,device_id,request_id,from_serial,to_serial,consumed_through,issued_at) VALUES(?,?,1,?,?,?,?,?,?)")
        .bind(&block).bind(prefix).bind(&context.device_id).bind(uuid::Uuid::new_v4().to_string()).bind(serial).bind(serial).bind(serial).bind(&at).execute(&mut *tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO warehouse_pallets(id,device_id,product_id,gtin14,opened_at,closed_at,sscc,block_id,serial,box_count_reported,received_at,source,created_by_user_id,creation_request_id,creation_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,'cabinet',?,?,?)")
        .bind(&id).bind(&context.device_id).bind(product).bind(gtin).bind(&at).bind(&at).bind(&sscc).bind(&block).bind(serial).bind(i64::from(checked.boxes)).bind(&at).bind(&context.user.id).bind(&body.request_id).bind(hash).execute(&mut *tx).await.map_err(ApiError::internal)?;
    for code in canonical {
        sqlx::query("INSERT INTO warehouse_pallet_boxes(pallet_id,box_sscc,added_at,record_id,device_id) VALUES(?,?,?,?,?)")
            .bind(&id).bind(&code).bind(&at).bind(&body.request_id).bind(&context.device_id).execute(&mut *tx).await.map_err(ApiError::internal)?;
    }
    registry_touch::warehouse_pallet_boxes(&mut tx, &id, &at).await?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_CREATE,
            target_type: Some("warehouse_pallet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({"sscc":sscc,"boxes":checked.boxes,"units":checked.units}),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(OfficePalletCreated { id, sscc }))
}
