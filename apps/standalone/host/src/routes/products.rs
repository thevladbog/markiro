//! The catalog (spec §4.3). `GET /v1/office/product-groups` lists the ЧЗ
//! product groups: the cloud's static lookup, read by every office role and
//! written by nobody. Products: `GET /v1/office/products` (every role,
//! archived products included), `POST` and `PUT …/{id}` (administrators and
//! technologists; `PUT` takes every field and `expectedRev`). A product is
//! archived instead of deleted and rides the station feed with its flag. Its
//! preferred A4 sheet (`defaultPalletSheetId`, beta feedback) is the office's
//! only: the feed's record does not carry it, and a `PUT` without it keeps it.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeProduct, ProductCreate, ProductGroup, ProductUpdate, TemplatePurpose};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

/// `GET /v1/office/product-groups`: every group, by code.
pub async fn list_product_groups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<ProductGroup>>, ApiError> {
    let rows: Vec<(u32, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(code, alias, name)| ProductGroup { code, alias, name })
            .collect(),
    ))
}

const SELECT: &str = "SELECT p.id, p.gtin14, p.name, p.print_name, p.chz_group_code, \
     p.box_capacity, p.pallet_box_capacity, p.shelf_life_days, p.default_box_template_id, \
     p.default_pallet_template_id, p.default_pallet_sheet_id, p.egais_code, \
     p.default_counterparty_id, \
     (SELECT ph.checksum FROM product_photos ph WHERE ph.product_id = p.id) AS photo_checksum, \
     p.archived, p.status, p.rev FROM products p";

#[derive(sqlx::FromRow)]
struct ProductRow {
    id: String,
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    default_pallet_sheet_id: Option<String>,
    egais_code: Option<String>,
    default_counterparty_id: Option<String>,
    photo_checksum: Option<String>,
    archived: bool,
    status: String,
    rev: i64,
}

fn record(row: ProductRow) -> Result<OfficeProduct, ApiError> {
    Ok(OfficeProduct {
        id: row.id,
        gtin14: row.gtin14,
        name: row.name,
        print_name: row.print_name,
        chz_product_group_code: row.chz_group_code,
        box_capacity: row.box_capacity,
        pallet_box_capacity: row.pallet_box_capacity,
        shelf_life_days: row.shelf_life_days,
        default_box_template_id: row.default_box_template_id,
        default_pallet_template_id: row.default_pallet_template_id,
        default_pallet_sheet_id: row.default_pallet_sheet_id,
        egais_code: row.egais_code,
        default_counterparty_id: row.default_counterparty_id,
        photo_checksum: row.photo_checksum,
        archived: row.archived,
        status: row.status.parse().map_err(ApiError::internal)?,
        rev: row.rev,
    })
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeProduct>, ApiError> {
    let row: Option<ProductRow> = sqlx::query_as(&format!("{SELECT} WHERE p.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// The fields a create and an update share, as the request sent them.
struct Sent<'a> {
    gtin14: &'a str,
    name: &'a str,
    print_name: Option<&'a str>,
    chz_product_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<&'a str>,
    default_pallet_template_id: Option<&'a str>,
    /// `None`: keep the stored sheet (an update that leaves it out).
    default_pallet_sheet_id: Option<Option<&'a str>>,
    /// `None`: keep the stored code (an update that leaves it out).
    egais_code: Option<Option<&'a str>>,
    /// `None`: keep the stored counterparty (an update that leaves it out).
    default_counterparty_id: Option<Option<&'a str>>,
}

impl<'a> From<&'a ProductCreate> for Sent<'a> {
    fn from(create: &'a ProductCreate) -> Self {
        Self {
            gtin14: &create.gtin14,
            name: &create.name,
            print_name: create.print_name.as_deref(),
            chz_product_group_code: create.chz_product_group_code,
            box_capacity: create.box_capacity,
            pallet_box_capacity: create.pallet_box_capacity,
            shelf_life_days: create.shelf_life_days,
            default_box_template_id: create.default_box_template_id.as_deref(),
            default_pallet_template_id: create.default_pallet_template_id.as_deref(),
            default_pallet_sheet_id: Some(create.default_pallet_sheet_id.as_deref()),
            egais_code: Some(create.egais_code.as_deref()),
            default_counterparty_id: Some(create.default_counterparty_id.as_deref()),
        }
    }
}

impl<'a> From<&'a ProductUpdate> for Sent<'a> {
    fn from(update: &'a ProductUpdate) -> Self {
        Self {
            gtin14: &update.gtin14,
            name: &update.name,
            print_name: update.print_name.as_deref(),
            chz_product_group_code: update.chz_product_group_code,
            box_capacity: update.box_capacity,
            pallet_box_capacity: update.pallet_box_capacity,
            shelf_life_days: update.shelf_life_days,
            default_box_template_id: update.default_box_template_id.as_deref(),
            default_pallet_template_id: update.default_pallet_template_id.as_deref(),
            default_pallet_sheet_id: update
                .default_pallet_sheet_id
                .as_ref()
                .map(|id| id.as_deref()),
            egais_code: update.egais_code.as_ref().map(|code| code.as_deref()),
            default_counterparty_id: update
                .default_counterparty_id
                .as_ref()
                .map(|id| id.as_deref()),
        }
    }
}

/// The shared fields after validation (trimmed, checked).
struct Fields {
    gtin14: String,
    name: String,
    print_name: Option<String>,
    chz_product_group_code: Option<u32>,
    box_capacity: Option<u32>,
    pallet_box_capacity: Option<u32>,
    shelf_life_days: Option<u32>,
    default_box_template_id: Option<String>,
    default_pallet_template_id: Option<String>,
    /// `None`: keep the stored sheet.
    default_pallet_sheet_id: Option<Option<String>>,
    /// `None`: keep the stored code; checked against the group once the
    /// stored one is known (`effective_egais_code`).
    egais_code: Option<Option<String>>,
    /// `None`: keep the stored counterparty.
    default_counterparty_id: Option<Option<String>>,
}

impl Sent<'_> {
    fn validate(&self) -> Result<Fields, ApiError> {
        let gtin14 = validate::gtin14("gtin14", self.gtin14)?;
        let name = validate::product_name("name", self.name)?;
        let print_name = validate::print_name("printName", self.print_name)?;
        validate::count("boxCapacity", self.box_capacity, validate::MAX_BOX_CAPACITY)?;
        validate::count(
            "palletBoxCapacity",
            self.pallet_box_capacity,
            validate::MAX_PALLET_BOX_CAPACITY,
        )?;
        validate::count(
            "shelfLifeDays",
            self.shelf_life_days,
            validate::MAX_SHELF_LIFE_DAYS,
        )?;
        let egais_code = self
            .egais_code
            .map(|code| validate::egais_code("egaisCode", code))
            .transpose()?;
        // A code sent is checked against the group sent before anything is
        // read, so the refusal is the same for an unknown or stale product;
        // a code left out is checked once the stored one is known.
        if matches!(egais_code, Some(Some(_))) {
            check_egais_group(self.chz_product_group_code)?;
        }
        Ok(Fields {
            gtin14,
            name,
            print_name,
            chz_product_group_code: self.chz_product_group_code,
            box_capacity: self.box_capacity,
            pallet_box_capacity: self.pallet_box_capacity,
            shelf_life_days: self.shelf_life_days,
            default_box_template_id: self.default_box_template_id.map(str::to_owned),
            default_pallet_template_id: self.default_pallet_template_id.map(str::to_owned),
            default_pallet_sheet_id: self.default_pallet_sheet_id.map(|id| id.map(str::to_owned)),
            egais_code,
            default_counterparty_id: self.default_counterparty_id.map(|id| id.map(str::to_owned)),
        })
    }
}

/// The code a write leaves on the product — the one sent, or the stored one
/// when an update leaves it out — and the rule that only a product of ЧЗ
/// group 15 carries one (plan ТОВ, the cloud's `isEgaisApplicable`): a code
/// with another group or none is `validation_failed` on `egaisCode`, also
/// when an older office keeps the code and changes the group.
fn effective_egais_code(fields: &Fields, stored: Option<&str>) -> Result<Option<String>, ApiError> {
    let code = match &fields.egais_code {
        Some(sent) => sent.clone(),
        None => stored.map(str::to_owned),
    };
    if code.is_some() {
        check_egais_group(fields.chz_product_group_code)?;
    }
    Ok(code)
}

/// `validation_failed` on `egaisCode` unless the group is ЧЗ group 15.
fn check_egais_group(group: Option<u32>) -> Result<(), ApiError> {
    if group == Some(validate::EGAIS_PRODUCT_GROUP_CODE) {
        Ok(())
    } else {
        Err(ApiError::validation(
            "egaisCode",
            "only a product of ЧЗ group 15 carries an EGAIS code",
        ))
    }
}

/// What the fields refer to exists: the product group, and for each default
/// template a template of the slot's purpose. Whether that template is
/// enabled and covers the product's group is the domain's rule: the office
/// applies it when choosing one and the station before using one, so a
/// template disabled or narrowed later never blocks editing or archiving
/// the product. Deleting a template clears the pointers (`templates`). The
/// preferred A4 sheet names a sheet, enabled or not, for the same reason;
/// deleting it clears the pointer (`pallet_sheets`).
async fn check_references(conn: &mut SqliteConnection, fields: &Fields) -> Result<(), ApiError> {
    if let Some(code) = fields.chz_product_group_code {
        let known: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM chz_product_groups WHERE code = ?")
                .bind(code)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        if known.is_none() {
            return Err(ApiError::validation(
                "chzProductGroupCode",
                "no such product group",
            ));
        }
    }
    for (field, id, purpose) in [
        (
            "defaultBoxTemplateId",
            &fields.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "defaultPalletTemplateId",
            &fields.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
    ] {
        let Some(id) = id else {
            continue;
        };
        let found: Option<String> =
            sqlx::query_scalar("SELECT purpose FROM label_templates WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
        if found.as_deref() != Some(purpose.as_str()) {
            return Err(ApiError::validation(
                field,
                format!("a {} template is required", purpose.as_str()),
            ));
        }
    }
    // A sheet, never a label template: the slot reads the sheets' table.
    if let Some(Some(id)) = &fields.default_pallet_sheet_id {
        crate::routes::pallet_sheets::check_sheet_exists(conn, "defaultPalletSheetId", id).await?;
    }
    Ok(())
}

/// The default counterparty a write SENDS must be in use, as a shift's
/// (`shifts::counterparty_in_use`); one archived after it was chosen stays
/// on the product, so an update that keeps it — sent unchanged or left out —
/// is not refused for it.
async fn check_default_counterparty(
    conn: &mut SqliteConnection,
    sent: Option<&str>,
    stored: Option<&str>,
) -> Result<(), ApiError> {
    let Some(id) = sent else { return Ok(()) };
    if Some(id) == stored || crate::shifts::counterparty_in_use(conn, id).await? {
        Ok(())
    } else {
        Err(ApiError::validation(
            "defaultCounterpartyId",
            "no such counterparty in use",
        ))
    }
}

/// A write that hit `products_active_gtin14`: another product in use has
/// the GTIN.
fn gtin_taken(error: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(error, "gtin14", "another product in use has this GTIN")
}

pub async fn list_products(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<OfficeProduct>>, ApiError> {
    let rows: Vec<ProductRow> =
        sqlx::query_as(&format!("{SELECT} ORDER BY p.archived, p.name, p.id"))
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn create_product(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<ProductCreate>,
) -> Result<Json<OfficeProduct>, ApiError> {
    context.require_catalog()?;
    let fields = Sent::from(&create).validate()?;
    let egais_code = effective_egais_code(&fields, None)?;
    let default_counterparty_id = fields.default_counterparty_id.clone().flatten();
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_references(&mut tx, &fields).await?;
    check_default_counterparty(&mut tx, default_counterparty_id.as_deref(), None).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO products (id, gtin14, name, print_name, chz_group_code, box_capacity, \
         pallet_box_capacity, shelf_life_days, default_box_template_id, \
         default_pallet_template_id, default_pallet_sheet_id, egais_code, \
         default_counterparty_id, archived, rev) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&fields.gtin14)
    .bind(&fields.name)
    .bind(&fields.print_name)
    .bind(fields.chz_product_group_code)
    .bind(fields.box_capacity)
    .bind(fields.pallet_box_capacity)
    .bind(fields.shelf_life_days)
    .bind(&fields.default_box_template_id)
    .bind(&fields.default_pallet_template_id)
    .bind(
        fields
            .default_pallet_sheet_id
            .as_ref()
            .and_then(Option::as_deref),
    )
    .bind(&egais_code)
    .bind(&default_counterparty_id)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(gtin_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_CREATE,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: if egais_code.is_some() || default_counterparty_id.is_some() {
                json!({
                    "gtin14": fields.gtin14,
                    "name": fields.name,
                    "egaisCode": egais_code,
                    "defaultCounterpartyId": default_counterparty_id,
                })
            } else {
                json!({ "gtin14": fields.gtin14, "name": fields.name })
            },
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("product vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_product(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<ProductUpdate>,
) -> Result<Json<OfficeProduct>, ApiError> {
    context.require_catalog()?;
    let fields = Sent::from(&update).validate()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_catalog_in(&mut tx).await?;
    check_references(&mut tx, &fields).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such product"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let default_pallet_sheet_id = fields
        .default_pallet_sheet_id
        .clone()
        .unwrap_or_else(|| current.default_pallet_sheet_id.clone());
    let egais_code = effective_egais_code(&fields, current.egais_code.as_deref())?;
    let default_counterparty_id = fields
        .default_counterparty_id
        .clone()
        .unwrap_or_else(|| current.default_counterparty_id.clone());
    check_default_counterparty(
        &mut tx,
        default_counterparty_id.as_deref(),
        current.default_counterparty_id.as_deref(),
    )
    .await?;
    let Some(details) = audit::update_details(&[
        ("gtin14", json!(current.gtin14), json!(fields.gtin14)),
        ("name", json!(current.name), json!(fields.name)),
        (
            "printName",
            json!(current.print_name),
            json!(fields.print_name),
        ),
        (
            "chzProductGroupCode",
            json!(current.chz_product_group_code),
            json!(fields.chz_product_group_code),
        ),
        (
            "boxCapacity",
            json!(current.box_capacity),
            json!(fields.box_capacity),
        ),
        (
            "palletBoxCapacity",
            json!(current.pallet_box_capacity),
            json!(fields.pallet_box_capacity),
        ),
        (
            "shelfLifeDays",
            json!(current.shelf_life_days),
            json!(fields.shelf_life_days),
        ),
        (
            "defaultBoxTemplateId",
            json!(current.default_box_template_id),
            json!(fields.default_box_template_id),
        ),
        (
            "defaultPalletTemplateId",
            json!(current.default_pallet_template_id),
            json!(fields.default_pallet_template_id),
        ),
        (
            "defaultPalletSheetId",
            json!(current.default_pallet_sheet_id),
            json!(default_pallet_sheet_id),
        ),
        ("egaisCode", json!(current.egais_code), json!(egais_code)),
        (
            "defaultCounterpartyId",
            json!(current.default_counterparty_id),
            json!(default_counterparty_id),
        ),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the product as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE products SET gtin14 = ?, name = ?, print_name = ?, chz_group_code = ?, \
         box_capacity = ?, pallet_box_capacity = ?, shelf_life_days = ?, \
         default_box_template_id = ?, default_pallet_template_id = ?, \
         default_pallet_sheet_id = ?, egais_code = ?, default_counterparty_id = ?, \
         archived = ?, rev = ? WHERE id = ?",
    )
    .bind(&fields.gtin14)
    .bind(&fields.name)
    .bind(&fields.print_name)
    .bind(fields.chz_product_group_code)
    .bind(fields.box_capacity)
    .bind(fields.pallet_box_capacity)
    .bind(fields.shelf_life_days)
    .bind(&fields.default_box_template_id)
    .bind(&fields.default_pallet_template_id)
    .bind(&default_pallet_sheet_id)
    .bind(&egais_code)
    .bind(&default_counterparty_id)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(gtin_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::PRODUCT_UPDATE,
            target_type: Some("product"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("product vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
