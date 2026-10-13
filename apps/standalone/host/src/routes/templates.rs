//! Label templates (spec §4.3): `GET /v1/office/templates` (every role;
//! summaries without the layout), `GET …/{id}` (with it), `POST`, `PUT
//! …/{id}` and `DELETE …/{id}` (administrators and technologists; `PUT`
//! with `expectedRev`). The host keeps `spec` an object of at most 256 KB and
//! 64 levels (`validate::template_spec`); the UI checks the layout. A purpose
//! never changes. A stock template, from the wizard, keeps its name, purpose
//! and layout and is never deleted
//! (`stock_template`): it may be disabled or narrowed, and copied by a
//! `POST`. A template is never disabled, narrowed out of a category it is
//! the default of, or deleted while it is a default (`template_is_default`),
//! nor deleted while a planned shift names it (`template_in_use`: its box,
//! pallet or duplicate template, plan РЕЖ part B).
//! Deleting a template clears the products' preferences that name it, each
//! product at the delete's revision, and leaves a tombstone.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    entities, LabelTemplate, LabelTemplateCreate, LabelTemplateSummary, LabelTemplateUpdate,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::feed;
use crate::server::AppState;
use crate::templates::{self, Scope};
use crate::validate;

/// The summary columns: the size, resolution and language as the stored
/// spec has them, `NULL` where it has none of the right JSON type. The
/// numbers are read as JSON text and parsed here, never as SQLite values: an
/// integer above `i64::MAX` comes back from `json_extract` as a REAL that
/// sqlx cannot decode, and one stored layout would make the whole list fail.
const SUMMARY: &str = "SELECT id, name, purpose, enabled, category_codes, stock, rev, \
     CASE WHEN json_type(spec, '$.widthMm') IN ('integer', 'real') \
         THEN spec -> '$.widthMm' END AS width_mm, \
     CASE WHEN json_type(spec, '$.heightMm') IN ('integer', 'real') \
         THEN spec -> '$.heightMm' END AS height_mm, \
     CASE WHEN json_type(spec, '$.dpi') = 'integer' THEN spec -> '$.dpi' END AS dpi, \
     CASE WHEN json_type(spec, '$.language') = 'text' \
         THEN json_extract(spec, '$.language') END AS language \
     FROM label_templates";

const SELECT: &str =
    "SELECT id, name, purpose, enabled, category_codes, stock, spec, rev FROM label_templates";

#[derive(sqlx::FromRow)]
struct SummaryRow {
    id: String,
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    rev: i64,
    width_mm: Option<String>,
    height_mm: Option<String>,
    dpi: Option<String>,
    language: Option<String>,
}

#[derive(sqlx::FromRow)]
struct TemplateRow {
    id: String,
    name: String,
    purpose: String,
    enabled: bool,
    category_codes: Option<String>,
    stock: bool,
    spec: String,
    rev: i64,
}

fn parse_codes(text: Option<String>) -> Result<Option<Vec<u32>>, ApiError> {
    text.map(|codes| serde_json::from_str(&codes))
        .transpose()
        .map_err(ApiError::internal)
}

/// A number of the stored spec, as JSON text (`58`, `58.5`).
fn spec_number(text: Option<String>) -> Option<serde_json::Number> {
    text.and_then(|text| serde_json::from_str(&text).ok())
}

fn summary(row: SummaryRow) -> Result<LabelTemplateSummary, ApiError> {
    Ok(LabelTemplateSummary {
        id: row.id,
        name: row.name,
        purpose: row.purpose.parse().map_err(ApiError::internal)?,
        enabled: row.enabled,
        chz_product_group_codes: parse_codes(row.category_codes)?,
        stock: row.stock,
        width_mm: spec_number(row.width_mm),
        height_mm: spec_number(row.height_mm),
        // An integer that fits a `u32`: a negative one, or one above the
        // range, is `null` like any other value of the wrong kind.
        dpi: row.dpi.and_then(|text| text.parse::<u32>().ok()),
        language: row.language,
        rev: row.rev,
    })
}

fn template(row: TemplateRow) -> Result<LabelTemplate, ApiError> {
    Ok(LabelTemplate {
        id: row.id,
        name: row.name,
        purpose: row.purpose.parse().map_err(ApiError::internal)?,
        enabled: row.enabled,
        chz_product_group_codes: parse_codes(row.category_codes)?,
        stock: row.stock,
        spec: serde_json::from_str(&row.spec).map_err(ApiError::internal)?,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<LabelTemplate>, ApiError> {
    let row: Option<TemplateRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(template).transpose()
}

/// Codes as `label_templates.category_codes` stores them.
fn codes_text(codes: Option<&[u32]>) -> Result<Option<String>, ApiError> {
    codes
        .map(serde_json::to_string)
        .transpose()
        .map_err(ApiError::internal)
}

pub async fn list_templates(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<LabelTemplateSummary>>, ApiError> {
    let rows: Vec<SummaryRow> = sqlx::query_as(&format!("{SUMMARY} ORDER BY name, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(summary)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn get_template(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<LabelTemplate>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read(&mut conn, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such template"))
}

pub async fn create_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<LabelTemplateCreate>,
) -> Result<Json<LabelTemplate>, ApiError> {
    context.require_catalog()?;
    let name = validate::template_name("name", &create.name)?;
    let codes = create.chz_product_group_codes.as_deref();
    validate::category_codes("chzProductGroupCodes", codes)?;
    let spec = validate::template_spec("spec", &create.spec)?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    templates::check_groups(&mut tx, "chzProductGroupCodes", codes).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(create.purpose.as_str())
    .bind(create.enabled)
    .bind(codes_text(codes)?)
    .bind(&spec)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_CREATE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name, "purpose": create.purpose }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("template vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<LabelTemplateUpdate>,
) -> Result<Json<LabelTemplate>, ApiError> {
    context.require_catalog()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::template_name("name", name))
        .transpose()?;
    if let Some(codes) = &update.chz_product_group_codes {
        validate::category_codes("chzProductGroupCodes", codes.as_deref())?;
    }
    let spec = update
        .spec
        .as_ref()
        .map(|spec| validate::template_spec("spec", spec))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(codes) = &update.chz_product_group_codes {
        templates::check_groups(&mut tx, "chzProductGroupCodes", codes.as_deref()).await?;
    }
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such template"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let name = name.unwrap_or_else(|| current.name.clone());
    let enabled = update.enabled.unwrap_or(current.enabled);
    let codes = update
        .chz_product_group_codes
        .clone()
        .unwrap_or_else(|| current.chz_product_group_codes.clone());
    let spec_changed = update
        .spec
        .as_ref()
        .is_some_and(|spec| *spec != current.spec);
    if current.stock && (name != current.name || spec_changed) {
        return Err(ApiError::conflict(
            "stock_template",
            "a stock template keeps its name and layout: copy it to change them",
        ));
    }
    if enabled != current.enabled || codes != current.chz_product_group_codes {
        // A default stays a template that fits its slot.
        let usage = templates::usage(&mut tx, &id, current.purpose).await?;
        let next = Scope {
            purpose: current.purpose,
            enabled,
            codes: codes.clone(),
        };
        let organization = usage.organization && !templates::fits(&next, current.purpose, None);
        let categories: Vec<u32> = usage
            .categories
            .into_iter()
            .filter(|code| !templates::fits(&next, current.purpose, Some(*code)))
            .collect();
        if organization || !categories.is_empty() {
            return Err(templates::is_default(organization, categories));
        }
    }
    let Some(details) = audit::update_details_hiding(
        &[
            ("name", json!(current.name), json!(name)),
            ("enabled", json!(current.enabled), json!(enabled)),
            (
                "chzProductGroupCodes",
                json!(current.chz_product_group_codes),
                json!(codes),
            ),
        ],
        // The layout is named, never logged.
        &[("spec", spec_changed)],
    ) else {
        // Nothing actually changed: report the template as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE label_templates SET name = ?, enabled = ?, category_codes = ?, \
         spec = COALESCE(?, spec), rev = ? WHERE id = ?",
    )
    .bind(&name)
    .bind(enabled)
    .bind(codes_text(codes.as_deref())?)
    .bind(spec.filter(|_| spec_changed))
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_UPDATE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("template vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// The planned shifts that name a template (`?1`) as their box, pallet or
/// duplicate template (plan РЕЖ, part B): SQLite answers it from the planned
/// shifts by `shifts_status_production_date`, never a scan of `shifts` (a
/// unit test pins the plan).
const PLANNED_SHIFTS_NAMING: &str = "SELECT id FROM shifts WHERE (box_template_id = ?1 \
     OR pallet_template_id = ?1 OR validation_print_template_id = ?1) \
     AND status = 'planned' ORDER BY id";

/// `DELETE /v1/office/templates/{id}` → 204. A template deleted already (its
/// tombstone stands) answers 204 again, so a delete repeated after a lost
/// answer does not fail; one that never existed is `not_found`.
pub async fn delete_template(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let Some(current) = read(&mut tx, &id).await? else {
        let deleted: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM tombstones WHERE entity = ? AND id = ?")
                .bind(entities::LABEL_TEMPLATES)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        return match deleted {
            Some(_) => Ok(StatusCode::NO_CONTENT),
            None => Err(ApiError::not_found("no such template")),
        };
    };
    if current.stock {
        return Err(ApiError::conflict(
            "stock_template",
            "a stock template is never deleted: disable it instead",
        ));
    }
    let usage = templates::usage(&mut tx, &id, current.purpose).await?;
    if usage.organization || !usage.categories.is_empty() {
        return Err(templates::is_default(usage.organization, usage.categories));
    }
    // A planned shift prints its boxes, its pallets or its duplicates with
    // this template once a station opens it; an open or closed shift has the
    // layout in its snapshot.
    let planned: Vec<String> = sqlx::query_scalar(PLANNED_SHIFTS_NAMING)
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if !planned.is_empty() {
        return Err(ApiError::conflict(
            "template_in_use",
            "a planned shift prints with this template",
        )
        .with_details(json!({ "constraint": "template_in_use", "shiftIds": planned })));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    // The products' preferences go first and take the revision, so a
    // station's copy of each product changes too (`ON DELETE SET NULL`
    // would change the rows behind the feed's back).
    let cleared = sqlx::query(
        "UPDATE products SET \
         default_box_template_id = CASE WHEN default_box_template_id = ?1 \
             THEN NULL ELSE default_box_template_id END, \
         default_pallet_template_id = CASE WHEN default_pallet_template_id = ?1 \
             THEN NULL ELSE default_pallet_template_id END, \
         rev = ?2 \
         WHERE default_box_template_id = ?1 OR default_pallet_template_id = ?1",
    )
    .bind(&id)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    sqlx::query("DELETE FROM label_templates WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    feed::remove(&mut tx, entities::LABEL_TEMPLATES, &id, rev)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_DELETE,
            target_type: Some("template"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "name": current.name,
                "purpose": current.purpose,
                "productsCleared": cleared,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::PLANNED_SHIFTS_NAMING;

    /// `template_in_use` reads the planned shifts by their status
    /// (`shifts_status_production_date`) whatever template slot names the
    /// template: no scan of `shifts`.
    #[tokio::test]
    async fn the_planned_shifts_naming_a_template_are_read_by_their_status() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        let plan: Vec<String> = sqlx::query(&format!("EXPLAIN QUERY PLAN {PLANNED_SHIFTS_NAMING}"))
            .bind("00000000-0000-4000-8000-000000000000")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert!(
            plan.iter().all(|step| !step.starts_with("SCAN")),
            "{plan:?}"
        );
        assert!(
            plan.iter()
                .any(|step| step.contains("shifts_status_production_date")),
            "{plan:?}"
        );
    }
}
