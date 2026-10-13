//! The templates' defaults (spec §4.3) as one document: the organization's
//! default of each purpose and every category's. `GET
//! /v1/office/template-defaults` (every role) and `PUT` (administrators and
//! technologists) with the document's `expectedRev`: the newest revision of
//! the organization's record, a category default and a cleared category
//! default's tombstone. Every default must fit its slot (`templates::fits`).
//! The organization's defaults ride its feed record; a category default
//! rides the feed as `<code>:<purpose>`, and clearing one writes its
//! tombstone.
//!
//! The A4 sheets chosen by default beside the pallet labels (beta feedback)
//! are part of the document: the organization's default sheet and each
//! category's (`category_pallet_sheet_defaults`). Each must be an enabled
//! sheet (`pallet_sheets::check_sheet`), so a label template's id is refused
//! there, as a sheet's id is in a label slot (`templates::check_slot` reads
//! only `label_templates`). They are not in the feed: a change of them moves
//! the organization's record, which carries the document's revision. Left
//! out of a request they are kept (an office from before them).

use std::collections::{BTreeMap, HashSet};

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    category_default_id, entities, CategoryPalletSheetDefault, CategoryTemplateDefault,
    TemplateDefaults, TemplateDefaultsUpdate, TemplatePurpose,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::feed;
use crate::routes::pallet_sheets;
use crate::server::AppState;
use crate::templates;

/// The document's revision. It moves with every change of the defaults, and
/// with any change of the organization's record too, which a write over an
/// older revision then has to read again.
const DOCUMENT_REV: &str = "SELECT MAX(rev) FROM (\
     SELECT rev FROM org_profile WHERE id = 1 \
     UNION ALL SELECT rev FROM category_template_defaults \
     UNION ALL SELECT rev FROM tombstones WHERE entity = 'category_template_defaults')";

/// The document; `not_found` before the wizard created the organization.
async fn read(conn: &mut SqliteConnection) -> Result<TemplateDefaults, ApiError> {
    type OrgRow = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<OrgRow> = sqlx::query_as(
        "SELECT default_box_template_id, default_pallet_template_id, \
         default_duplicate_template_id, default_pallet_sheet_template_id \
         FROM org_profile WHERE id = 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let (
        default_box_template_id,
        default_pallet_template_id,
        default_duplicate_template_id,
        default_pallet_sheet_id,
    ) = row.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    let rows: Vec<(u32, String, String)> = sqlx::query_as(
        "SELECT chz_group_code, purpose, template_id FROM category_template_defaults \
         ORDER BY chz_group_code, purpose",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let categories = rows
        .into_iter()
        .map(|(code, purpose, template_id)| {
            Ok(CategoryTemplateDefault {
                chz_product_group_code: code,
                purpose: purpose.parse().map_err(ApiError::internal)?,
                template_id,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let sheets: Vec<(u32, String)> = sqlx::query_as(
        "SELECT chz_group_code, sheet_id FROM category_pallet_sheet_defaults \
         ORDER BY chz_group_code",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let rev: i64 = sqlx::query_scalar(DOCUMENT_REV)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(TemplateDefaults {
        default_box_template_id,
        default_pallet_template_id,
        default_duplicate_template_id,
        categories,
        default_pallet_sheet_id,
        pallet_sheet_categories: sheets
            .into_iter()
            .map(|(code, sheet_id)| CategoryPalletSheetDefault {
                chz_product_group_code: code,
                sheet_id,
            })
            .collect(),
        rev,
    })
}

pub async fn get_template_defaults(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<TemplateDefaults>, ApiError> {
    // One read transaction: the parts and the revision from one snapshot.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let document = read(&mut tx).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(document))
}

pub async fn put_template_defaults(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<TemplateDefaultsUpdate>,
) -> Result<Json<TemplateDefaults>, ApiError> {
    context.require_catalog()?;
    let mut slots = HashSet::new();
    for (index, entry) in update.categories.iter().enumerate() {
        if !slots.insert((entry.chz_product_group_code, entry.purpose)) {
            return Err(ApiError::validation(
                &format!("categories.{index}"),
                "this category's default of this purpose is given twice",
            ));
        }
    }
    let mut sheet_codes = HashSet::new();
    for (index, entry) in update.pallet_sheet_categories.iter().flatten().enumerate() {
        if !sheet_codes.insert(entry.chz_product_group_code) {
            return Err(ApiError::validation(
                &format!("palletSheetCategories.{index}"),
                "this category's default sheet is given twice",
            ));
        }
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    for (field, id, purpose) in [
        (
            "defaultBoxTemplateId",
            &update.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "defaultPalletTemplateId",
            &update.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
        (
            "defaultDuplicateTemplateId",
            &update.default_duplicate_template_id,
            TemplatePurpose::ProductDuplicate,
        ),
    ] {
        if let Some(id) = id {
            templates::check_slot(&mut tx, field, id, purpose, None).await?;
        }
    }
    for (index, entry) in update.categories.iter().enumerate() {
        let code = entry.chz_product_group_code;
        templates::check_groups(
            &mut tx,
            &format!("categories.{index}.chzProductGroupCode"),
            Some(&[code]),
        )
        .await?;
        templates::check_slot(
            &mut tx,
            &format!("categories.{index}.templateId"),
            &entry.template_id,
            entry.purpose,
            Some(code),
        )
        .await?;
    }
    if let Some(Some(id)) = &update.default_pallet_sheet_id {
        pallet_sheets::check_sheet(&mut tx, "defaultPalletSheetId", id).await?;
    }
    for (index, entry) in update.pallet_sheet_categories.iter().flatten().enumerate() {
        templates::check_groups(
            &mut tx,
            &format!("palletSheetCategories.{index}.chzProductGroupCode"),
            Some(&[entry.chz_product_group_code]),
        )
        .await?;
        pallet_sheets::check_sheet(
            &mut tx,
            &format!("palletSheetCategories.{index}.sheetId"),
            &entry.sheet_id,
        )
        .await?;
    }
    let current = read(&mut tx).await?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    // Left out, the sheet defaults stay as stored.
    let default_pallet_sheet_id = update
        .default_pallet_sheet_id
        .clone()
        .unwrap_or_else(|| current.default_pallet_sheet_id.clone());
    let mut pallet_sheet_categories = update
        .pallet_sheet_categories
        .clone()
        .unwrap_or_else(|| current.pallet_sheet_categories.clone());
    pallet_sheet_categories.sort_by_key(|entry| entry.chz_product_group_code);
    let sheets_changed = default_pallet_sheet_id != current.default_pallet_sheet_id
        || pallet_sheet_categories != current.pallet_sheet_categories;
    let mut categories: Vec<CategoryTemplateDefault> = update
        .categories
        .iter()
        .map(|entry| CategoryTemplateDefault {
            chz_product_group_code: entry.chz_product_group_code,
            purpose: entry.purpose,
            template_id: entry.template_id.clone(),
        })
        .collect();
    categories.sort_by_key(|entry| (entry.chz_product_group_code, entry.purpose));
    let Some(details) = audit::update_details(&[
        (
            "defaultBoxTemplateId",
            json!(current.default_box_template_id),
            json!(update.default_box_template_id),
        ),
        (
            "defaultPalletTemplateId",
            json!(current.default_pallet_template_id),
            json!(update.default_pallet_template_id),
        ),
        (
            "defaultDuplicateTemplateId",
            json!(current.default_duplicate_template_id),
            json!(update.default_duplicate_template_id),
        ),
        ("categories", json!(current.categories), json!(categories)),
        (
            "defaultPalletSheetId",
            json!(current.default_pallet_sheet_id),
            json!(default_pallet_sheet_id),
        ),
        (
            "palletSheetCategories",
            json!(current.pallet_sheet_categories),
            json!(pallet_sheet_categories),
        ),
    ]) else {
        // Nothing actually changed: report the document as-is without
        // bumping the revision, writing a row nobody changed, or auditing a
        // no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let organization = (
        &update.default_box_template_id,
        &update.default_pallet_template_id,
        &update.default_duplicate_template_id,
    );
    // A change of the sheet defaults moves the organization's record too: it
    // carries the document's revision for them, which never moves back.
    if sheets_changed
        || organization
            != (
                &current.default_box_template_id,
                &current.default_pallet_template_id,
                &current.default_duplicate_template_id,
            )
    {
        sqlx::query(
            "UPDATE org_profile SET default_box_template_id = ?, \
             default_pallet_template_id = ?, default_duplicate_template_id = ?, \
             default_pallet_sheet_template_id = ?, rev = ? WHERE id = 1",
        )
        .bind(organization.0)
        .bind(organization.1)
        .bind(organization.2)
        .bind(&default_pallet_sheet_id)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    if pallet_sheet_categories != current.pallet_sheet_categories {
        sqlx::query("DELETE FROM category_pallet_sheet_defaults")
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        for entry in &pallet_sheet_categories {
            sqlx::query(
                "INSERT INTO category_pallet_sheet_defaults (chz_group_code, sheet_id) \
                 VALUES (?, ?)",
            )
            .bind(entry.chz_product_group_code)
            .bind(&entry.sheet_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        }
    }
    let was: BTreeMap<(u32, TemplatePurpose), String> = current
        .categories
        .into_iter()
        .map(|entry| {
            (
                (entry.chz_product_group_code, entry.purpose),
                entry.template_id,
            )
        })
        .collect();
    let now: BTreeMap<(u32, TemplatePurpose), String> = categories
        .into_iter()
        .map(|entry| {
            (
                (entry.chz_product_group_code, entry.purpose),
                entry.template_id,
            )
        })
        .collect();
    for &(code, purpose) in was.keys().filter(|slot| !now.contains_key(slot)) {
        sqlx::query(
            "DELETE FROM category_template_defaults WHERE chz_group_code = ? AND purpose = ?",
        )
        .bind(code)
        .bind(purpose.as_str())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        feed::remove(
            &mut tx,
            entities::CATEGORY_TEMPLATE_DEFAULTS,
            &category_default_id(code, purpose),
            rev,
        )
        .await
        .map_err(ApiError::internal)?;
    }
    for (&(code, purpose), template_id) in &now {
        match was.get(&(code, purpose)) {
            Some(old) if old == template_id => {}
            Some(_) => {
                sqlx::query(
                    "UPDATE category_template_defaults SET template_id = ?, rev = ? \
                     WHERE chz_group_code = ? AND purpose = ?",
                )
                .bind(template_id)
                .bind(rev)
                .bind(code)
                .bind(purpose.as_str())
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO category_template_defaults \
                     (chz_group_code, purpose, template_id, rev) VALUES (?, ?, ?, ?)",
                )
                .bind(code)
                .bind(purpose.as_str())
                .bind(template_id)
                .bind(rev)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
                feed::restore(
                    &mut tx,
                    entities::CATEGORY_TEMPLATE_DEFAULTS,
                    &category_default_id(code, purpose),
                )
                .await
                .map_err(ApiError::internal)?;
            }
        }
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::TEMPLATE_DEFAULTS_UPDATE,
            target_type: Some("template_defaults"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx).await?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
