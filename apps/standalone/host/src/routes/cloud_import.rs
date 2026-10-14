//! `POST /v1/office/import` (administrators): the cloud's data moved into a
//! new site in one transaction (plan IMP, pilot spec §8.7). The file is
//! checked first (`cloud_import::check`), then, inside the write transaction:
//! the administrator again, an import already done (the same `importId`
//! answers its stored summary, another is `already_imported`), a site that
//! is not empty (`site_not_empty`), the organization's GLN (`org_gln`) and
//! the product groups. Every row of the file is written at one revision and
//! rides the feed; the counters only move forward. `dryRun` runs all of it
//! and rolls back. The audit row `import.cloud` is the import's record: it
//! holds the summary a repeat answers with, and never a hash or the salt.

use std::collections::HashSet;

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, Request, State};
use axum::Json;
use markiro_proto::cloud_import::{
    CloudImportRequest, CloudImportSummary, ShiftNumberCounterValue, SsccCounterValue,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::cloud_import::{self, ValidImport};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::ApiError;
use crate::server::AppState;

/// The route's own body limit: a catalog whose layouts reach 256 KB each
/// passes axum's default 2 MiB easily.
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

/// What a site may not hold before the import, in the order the refusal
/// names it: a row that needs another (a shift its product, a block its
/// device) comes before what it needs, so each entry is the answer for a
/// site that holds only it. Lines may be there (the wizard made them), and
/// so may the wizard's stock templates; badges need operators, and an
/// employee may need its operator.
const NOT_EMPTY: [(&str, &str); 8] = [
    ("shifts", "SELECT EXISTS (SELECT 1 FROM shifts)"),
    ("sscc_blocks", "SELECT EXISTS (SELECT 1 FROM sscc_blocks)"),
    (
        "category_template_defaults",
        "SELECT EXISTS (SELECT 1 FROM category_template_defaults)",
    ),
    ("products", "SELECT EXISTS (SELECT 1 FROM products)"),
    (
        "label_templates",
        "SELECT EXISTS (SELECT 1 FROM label_templates WHERE stock = 0)",
    ),
    ("employees", "SELECT EXISTS (SELECT 1 FROM employees)"),
    ("operators", "SELECT EXISTS (SELECT 1 FROM operators)"),
    (
        "counterparties",
        "SELECT EXISTS (SELECT 1 FROM counterparties)",
    ),
];

/// The import already done: its id and its summary, from its audit row.
async fn earlier_import(
    conn: &mut SqliteConnection,
) -> Result<Option<(String, String, CloudImportSummary)>, ApiError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT at, details FROM audit_log WHERE action = ? AND result = 'ok' ORDER BY id LIMIT 1",
    )
    .bind(actions::IMPORT_CLOUD)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let Some((at, details)) = row else {
        return Ok(None);
    };
    let mut details: Value = serde_json::from_str(&details).map_err(ApiError::internal)?;
    let import_id = details["importId"]
        .as_str()
        .ok_or_else(|| ApiError::internal("an import.cloud row without importId"))?
        .to_owned();
    let summary = serde_json::from_value(details["summary"].take()).map_err(ApiError::internal)?;
    Ok(Some((import_id, at, summary)))
}

async fn require_empty(conn: &mut SqliteConnection) -> Result<(), ApiError> {
    for (entity, query) in NOT_EMPTY {
        let found: bool = sqlx::query_scalar(query)
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        if found {
            return Err(
                ApiError::conflict("site_not_empty", "the site already holds data")
                    .with_details(json!({ "constraint": "site_not_empty", "entity": entity })),
            );
        }
    }
    Ok(())
}

async fn require_groups(conn: &mut SqliteConnection, valid: &ValidImport) -> Result<(), ApiError> {
    let known: HashSet<u32> = sqlx::query_scalar("SELECT code FROM chz_product_groups")
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?
        .into_iter()
        .collect();
    match valid
        .group_refs
        .iter()
        .find(|(_, code)| !known.contains(code))
    {
        Some((field, _)) => Err(ApiError::validation(field, "no such product group")),
        None => Ok(()),
    }
}

fn count(items: usize) -> Result<u32, ApiError> {
    u32::try_from(items).map_err(ApiError::internal)
}

/// Writes every row of `valid` at `rev`; returns the summary.
async fn write(
    conn: &mut SqliteConnection,
    valid: &ValidImport,
    rev: i64,
    at: &str,
) -> Result<CloudImportSummary, ApiError> {
    let site_salt: Option<Vec<u8>> = sqlx::query_scalar("SELECT badge_salt FROM site WHERE id = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    // No operator, so no badge, is on the site yet (`require_empty`): a new
    // salt invalidates nothing, and the `site` record takes it to stations.
    let badge_salt_replaced = match &valid.badge_salt {
        Some(salt) if site_salt.as_deref() != Some(salt.as_slice()) => {
            sqlx::query("UPDATE site SET badge_salt = ?, rev = ? WHERE id = 1")
                .bind(salt.as_slice())
                .bind(rev)
                .execute(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            true
        }
        _ => false,
    };

    let present: HashSet<String> =
        sqlx::query_scalar("SELECT name_key FROM lines WHERE archived = 0")
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?
            .into_iter()
            .collect();
    let mut lines_created = 0;
    for line in &valid.lines {
        if present.contains(&line.name_key) {
            continue;
        }
        sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
            .bind(&line.id)
            .bind(&line.name)
            .bind(&line.name_key)
            .bind(rev)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        lines_created += 1;
    }

    for each in &valid.counterparties {
        let company = &each.company;
        sqlx::query(
            "INSERT INTO counterparties (id, name, inn, gln, gs1_prefixes, archived, rev) \
             VALUES (?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(&each.id)
        .bind(&company.name)
        .bind(&company.inn)
        .bind(&company.gln)
        .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.templates {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(&each.id)
        .bind(&each.name)
        .bind(each.purpose.as_str())
        .bind(each.enabled)
        .bind(
            each.codes
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(ApiError::internal)?,
        )
        .bind(&each.spec)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    let org_defaults = u32::from(valid.default_box_template_id.is_some())
        + u32::from(valid.default_pallet_template_id.is_some());
    if org_defaults > 0 {
        sqlx::query(
            "UPDATE org_profile SET \
             default_box_template_id = coalesce(?, default_box_template_id), \
             default_pallet_template_id = coalesce(?, default_pallet_template_id), \
             rev = ? WHERE id = 1",
        )
        .bind(&valid.default_box_template_id)
        .bind(&valid.default_pallet_template_id)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    for each in &valid.categories {
        sqlx::query(
            "INSERT INTO category_template_defaults (chz_group_code, purpose, template_id, rev) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(each.code)
        .bind(each.purpose.as_str())
        .bind(&each.template_id)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.products {
        sqlx::query(
            "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
             pallet_box_capacity, shelf_life_days, default_box_template_id, \
             default_pallet_template_id, egais_code, default_counterparty_id, archived, rev) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.gtin14)
        .bind(&each.name)
        .bind(&each.print_name)
        .bind(each.group)
        .bind(each.box_capacity)
        .bind(each.pallet_box_capacity)
        .bind(each.shelf_life_days)
        .bind(&each.default_box_template_id)
        .bind(&each.default_pallet_template_id)
        .bind(&each.egais_code)
        .bind(&each.default_counterparty_id)
        .bind(each.archived)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    for each in &valid.operators {
        sqlx::query(
            "INSERT INTO operators (id, login, name, role, pin_phc, active, rev) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.login)
        .bind(&each.name)
        .bind(&each.role)
        .bind(&each.pin_phc)
        .bind(each.active)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    for each in &valid.badges {
        sqlx::query(
            "INSERT INTO operator_badges (id, operator_id, badge_phc, label, created_at, rev) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&each.id)
        .bind(&each.operator_id)
        .bind(&each.badge_phc)
        .bind(&each.label)
        .bind(at)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }

    // Forward only: a counter the site already has above the file's start
    // keeps its value (the wizard's, or one moved on in «SSCC»).
    let mut sscc_counters = Vec::with_capacity(valid.sscc_counters.len());
    for each in &valid.sscc_counters {
        let next = i64::try_from(each.next_serial).map_err(ApiError::internal)?;
        sqlx::query(
            "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) VALUES (?, ?, ?, ?) \
             ON CONFLICT (issuer_prefix, extension) DO UPDATE SET \
             next_serial = excluded.next_serial, rev = excluded.rev \
             WHERE excluded.next_serial > sscc_counters.next_serial",
        )
        .bind(&each.issuer_prefix)
        .bind(each.extension)
        .bind(next)
        .bind(rev)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        let stands: i64 = sqlx::query_scalar(
            "SELECT next_serial FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
        )
        .bind(&each.issuer_prefix)
        .bind(each.extension)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        sscc_counters.push(SsccCounterValue {
            issuer_prefix: each.issuer_prefix.clone(),
            extension: each.extension,
            next_serial: u64::try_from(stands).map_err(ApiError::internal)?,
        });
    }
    let mut shift_number_counters = Vec::with_capacity(valid.shift_number_counters.len());
    for each in &valid.shift_number_counters {
        sqlx::query(
            "INSERT INTO shift_number_counters (month_key, last_seq) VALUES (?, ?) \
             ON CONFLICT (month_key) DO UPDATE SET last_seq = excluded.last_seq \
             WHERE excluded.last_seq > shift_number_counters.last_seq",
        )
        .bind(&each.month_key)
        .bind(each.last_seq)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
        let stands: u32 =
            sqlx::query_scalar("SELECT last_seq FROM shift_number_counters WHERE month_key = ?")
                .bind(&each.month_key)
                .fetch_one(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        shift_number_counters.push(ShiftNumberCounterValue {
            month_key: each.month_key.clone(),
            last_seq: stands,
        });
    }

    Ok(CloudImportSummary {
        dry_run: false,
        repeated: false,
        lines_created,
        lines_present: count(valid.lines.len())? - lines_created,
        counterparties: count(valid.counterparties.len())?,
        templates: count(valid.templates.len())?,
        org_defaults,
        category_defaults: count(valid.categories.len())?,
        products: count(valid.products.len())?,
        operators: count(valid.operators.len())?,
        badges: count(valid.badges.len())?,
        badge_salt_replaced,
        sscc_counters,
        shift_number_counters,
    })
}

/// The text a body the host cannot read gets. Fixed: serde's own texts quote
/// the offending value, and a file edited by hand may hold a verifier or the
/// salt where a number belongs.
fn unreadable(rejection: &JsonRejection) -> &'static str {
    match rejection {
        JsonRejection::MissingJsonContentType(_) => "Content-Type application/json is required",
        JsonRejection::BytesRejection(_) => "the body could not be read or is larger than 32 MiB",
        _ => "the body is not a transfer file this host reads",
    }
}

/// The administrator's office session, then the file. The role is checked
/// before the body is buffered, so a technologist makes the host read and
/// parse nothing, and every rejection of the body has a fixed text.
pub struct AdminImport {
    context: OfficeContext,
    request: CloudImportRequest,
}

impl FromRequest<AppState> for AdminImport {
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, ApiError> {
        let (mut parts, body) = request.into_parts();
        let context = OfficeContext::from_request_parts(&mut parts, state).await?;
        context.require_admin()?;
        let request = Request::from_parts(parts, body);
        match Json::<CloudImportRequest>::from_request(request, state).await {
            Ok(Json(request)) => Ok(Self { context, request }),
            Err(rejection) => Err(ApiError::malformed(unreadable(&rejection))),
        }
    }
}

pub async fn import(
    State(state): State<AppState>,
    AdminImport { context, request }: AdminImport,
) -> Result<Json<CloudImportSummary>, ApiError> {
    let valid = cloud_import::check(&request)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    if let Some((import_id, imported_at, summary)) = earlier_import(&mut tx).await? {
        if import_id == request.import_id {
            return Ok(Json(CloudImportSummary {
                repeated: true,
                ..summary
            }));
        }
        return Err(
            ApiError::conflict("already_imported", "this site already took an import")
                .with_details(
                    json!({ "constraint": "already_imported", "importedAt": imported_at }),
                ),
        );
    }
    require_empty(&mut tx).await?;
    let site_gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let site_gln = site_gln.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    if site_gln != valid.gln {
        return Err(
            ApiError::conflict("org_gln", "the organization's GLN is not the file's").with_details(
                json!({
                    "constraint": "org_gln",
                    "siteGln": site_gln,
                    "fileGln": valid.gln,
                }),
            ),
        );
    }
    require_groups(&mut tx, &valid).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let summary = write(&mut tx, &valid, rev, &at).await?;
    // The lines it added take seats of the license (plan ЛЦ-2): beyond the
    // file the import (and its dry run) is refused whole, without a row.
    crate::license::seats::require_added_seats(
        &state,
        &mut tx,
        crate::license::seats::Quota::Lines,
        u64::from(summary.lines_created),
    )
    .await?;
    if request.dry_run {
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(CloudImportSummary {
            dry_run: true,
            ..summary
        }));
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::IMPORT_CLOUD,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "importId": request.import_id,
                "exportedAt": request.exported_at,
                "rehearsal": request.rehearsal,
                "sourceTenantId": request.source.tenant_id,
                "summary": summary,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // The import never writes the organization's INN; the license is looked
    // at again all the same (plan ЛЦ-2, spec §4.9).
    state.license.refresh_after_write(&state).await;
    Ok(Json(summary))
}
