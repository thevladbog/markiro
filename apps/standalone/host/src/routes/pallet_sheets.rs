//! A4 pallet sheets (plan А4, pilot spec §29): `GET /v1/office/pallet-sheets`
//! (every role), `POST`, `PUT …/{id}`, `DELETE …/{id}` and
//! `PUT /v1/office/pallet-sheet-default` (administrators and technologists).
//! The host keeps a sheet's layout as an object of `schemaVersion` 2 of at
//! most 64 KiB (`validate::sheet_spec`); the office and the station read it
//! with the domain. A stock sheet is added by its preset key, once: the same
//! key again answers the sheet already there, renamed or not. The layout of a
//! sheet never changes (a new layout is a new sheet). A sheet is not switched
//! off or deleted while it is the default (`template_is_default`), nor deleted
//! while a planned shift names it (`template_in_use`); an open or closed shift
//! has the sheet in its snapshot. Sheets take no feed revision: no station
//! copies them, a shift freezes its sheet when it opens.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{
    PalletSheet, PalletSheetCreate, PalletSheetDefaultUpdate, PalletSheetUpdate, PalletSheets,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

const SELECT: &str =
    "SELECT id, name, enabled, preset_key, revision, spec FROM pallet_sheet_templates";

/// A stock sheet by its preset key: the unique index finds it.
pub const BY_PRESET_SQL: &str =
    "SELECT id, name, enabled, preset_key, revision, spec FROM pallet_sheet_templates \
     WHERE preset_key = ?";

/// The planned shifts that name a sheet: the partial index finds them.
pub const PLANNED_SHIFTS_SQL: &str = "SELECT id FROM shifts \
     WHERE pallet_sheet_template_id = ? AND status = 'planned' ORDER BY id";

/// The default sheet while it is enabled: two primary-key lookups.
pub const DEFAULT_SHEET_SQL: &str = "SELECT s.id FROM org_profile o JOIN pallet_sheet_templates s \
     ON s.id = o.default_pallet_sheet_template_id WHERE o.id = 1 AND s.enabled = 1";

type SheetRow = (String, String, bool, Option<String>, i64, String);

fn sheet(
    (id, name, enabled, preset_key, revision, spec): SheetRow,
) -> Result<PalletSheet, ApiError> {
    Ok(PalletSheet {
        id,
        name,
        enabled,
        preset_key,
        revision,
        spec: serde_json::from_str(&spec).map_err(ApiError::internal)?,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<PalletSheet>, ApiError> {
    let row: Option<SheetRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(sheet).transpose()
}

async fn default_id(conn: &mut SqliteConnection) -> Result<Option<String>, ApiError> {
    let id: Option<Option<String>> =
        sqlx::query_scalar("SELECT default_pallet_sheet_template_id FROM org_profile WHERE id = 1")
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(id.flatten())
}

async fn list(conn: &mut SqliteConnection) -> Result<PalletSheets, ApiError> {
    let rows: Vec<SheetRow> = sqlx::query_as(&format!("{SELECT} ORDER BY name, id"))
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(PalletSheets {
        sheets: rows.into_iter().map(sheet).collect::<Result<_, _>>()?,
        default_id: default_id(conn).await?,
    })
}

/// The organization's default sheet while it is enabled: what a shift with
/// pallets gets when its request names no sheet (plan А4, decision А4-3).
pub async fn default_sheet(conn: &mut SqliteConnection) -> Result<Option<String>, ApiError> {
    let id: Option<String> = sqlx::query_scalar(DEFAULT_SHEET_SQL)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(id)
}

/// `validation_failed` on `field` unless `id` names an enabled sheet.
pub async fn check_sheet(
    conn: &mut SqliteConnection,
    field: &str,
    id: &str,
) -> Result<(), ApiError> {
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT enabled FROM pallet_sheet_templates WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    match enabled {
        Some(true) => Ok(()),
        _ => Err(ApiError::validation(field, "no such enabled sheet")),
    }
}

fn is_default() -> ApiError {
    ApiError::conflict(
        "template_is_default",
        "the sheet is the organization's default",
    )
}

pub async fn list_sheets(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<PalletSheets>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    list(&mut conn).await.map(Json)
}

pub async fn create_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<PalletSheetCreate>,
) -> Result<Json<PalletSheet>, ApiError> {
    context.require_catalog()?;
    let name = validate::template_name("name", &create.name)?;
    if let Some(key) = &create.preset_key {
        validate::preset_key("presetKey", key)?;
    }
    let spec = validate::sheet_spec("spec", &create.spec)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(key) = &create.preset_key {
        let existing: Option<SheetRow> = sqlx::query_as(BY_PRESET_SQL)
            .bind(key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        if let Some(row) = existing {
            tx.commit().await.map_err(ApiError::internal)?;
            return sheet(row).map(Json);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO pallet_sheet_templates \
         (id, name, enabled, preset_key, spec, revision, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(create.enabled)
    .bind(&create.preset_key)
    .bind(&spec)
    .bind(&at)
    .bind(&at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_CREATE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name, "presetKey": create.preset_key }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("sheet vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<PalletSheetUpdate>,
) -> Result<Json<PalletSheet>, ApiError> {
    context.require_catalog()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::template_name("name", name))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such sheet"))?;
    if current.revision != update.expected_revision {
        return Err(ApiError::stale_revision(current.revision));
    }
    let next_name = name.unwrap_or_else(|| current.name.clone());
    let next_enabled = update.enabled.unwrap_or(current.enabled);
    if !next_enabled && default_id(&mut tx).await?.as_deref() == Some(id.as_str()) {
        return Err(is_default());
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(next_name)),
        ("enabled", json!(current.enabled), json!(next_enabled)),
    ]) else {
        tx.commit().await.map_err(ApiError::internal)?;
        return Ok(Json(current));
    };
    sqlx::query(
        "UPDATE pallet_sheet_templates SET name = ?, enabled = ?, revision = revision + 1, \
         updated_at = ? WHERE id = ?",
    )
    .bind(&next_name)
    .bind(next_enabled)
    .bind(&at)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_UPDATE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("sheet vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

pub async fn delete_sheet(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<StatusCode, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such sheet"))?;
    if default_id(&mut tx).await?.as_deref() == Some(id.as_str()) {
        return Err(is_default());
    }
    // A planned shift prints its pallets on this sheet once a station opens
    // it; an open or closed shift has the sheet in its snapshot.
    let planned: Vec<String> = sqlx::query_scalar(PLANNED_SHIFTS_SQL)
        .bind(&id)
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if !planned.is_empty() {
        return Err(ApiError::conflict(
            "template_in_use",
            "a planned shift prints its pallets on this sheet",
        )
        .with_details(json!({ "constraint": "template_in_use", "shiftIds": planned })));
    }
    sqlx::query("DELETE FROM pallet_sheet_templates WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PALLET_SHEET_DELETE,
            target_type: Some("pallet_sheet"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": current.name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn put_default(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<PalletSheetDefaultUpdate>,
) -> Result<Json<PalletSheets>, ApiError> {
    context.require_catalog()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    if let Some(id) = &update.template_id {
        check_sheet(&mut tx, "templateId", id).await?;
    }
    let current = default_id(&mut tx).await?;
    if let Some(details) =
        audit::update_details(&[("templateId", json!(current), json!(update.template_id))])
    {
        sqlx::query("UPDATE org_profile SET default_pallet_sheet_template_id = ? WHERE id = 1")
            .bind(&update.template_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::PALLET_SHEET_DEFAULT,
                target_type: Some("org_profile"),
                target_id: Some("1"),
                outcome: Outcome::Ok,
                details,
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let answer = list(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answer))
}
