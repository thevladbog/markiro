//! The import's rules that need no database (plan IMP, pilot spec §8.7):
//! every row of the file checked as the office routes check one, with the
//! request's JSON path as `details.field` (`payload.products.2.gtin14`).
//! The export tool already wrote every value the way these rules want it,
//! so a refusal means a damaged file or a bug, and the whole import is
//! refused (`routes/cloud_import.rs`). What needs the database — the site
//! is empty, its GLN, the product groups — is the route's.

use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use markiro_proto::cloud_import::{CloudImportRequest, CLOUD_IMPORT_FORMAT_VERSIONS};
use markiro_proto::{OrgProfileInput, TemplatePurpose};

use crate::error::ApiError;
use crate::templates::{fits, Scope};
use crate::validate;

pub struct Line {
    pub id: String,
    pub name: String,
    pub name_key: String,
}

pub struct Counterparty {
    pub id: String,
    pub company: validate::ValidCompany,
}

pub struct Template {
    pub id: String,
    pub name: String,
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    pub codes: Option<Vec<u32>>,
    /// The layout as the host stores it (`validate::template_spec`).
    pub spec: String,
}

pub struct CategoryDefault {
    pub code: u32,
    pub purpose: TemplatePurpose,
    pub template_id: String,
}

pub struct Product {
    pub id: String,
    pub gtin14: String,
    pub name: String,
    pub print_name: Option<String>,
    pub group: Option<u32>,
    pub box_capacity: Option<u32>,
    pub pallet_box_capacity: Option<u32>,
    pub shelf_life_days: Option<u32>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub egais_code: Option<String>,
    pub default_counterparty_id: Option<String>,
    pub archived: bool,
}

pub struct Operator {
    pub id: String,
    pub login: String,
    pub name: String,
    pub role: Option<String>,
    pub pin_phc: String,
    pub active: bool,
}

pub struct Badge {
    pub id: String,
    pub operator_id: String,
    pub badge_phc: String,
    pub label: Option<String>,
}

pub struct SsccCounter {
    pub issuer_prefix: String,
    pub extension: u8,
    pub next_serial: u64,
}

pub struct ShiftNumberCounter {
    pub month_key: String,
    pub last_seq: u32,
}

/// The file after the checks, ready to write.
pub struct ValidImport {
    pub gln: String,
    pub badge_salt: Option<Vec<u8>>,
    pub lines: Vec<Line>,
    pub counterparties: Vec<Counterparty>,
    pub templates: Vec<Template>,
    pub default_box_template_id: Option<String>,
    pub default_pallet_template_id: Option<String>,
    pub categories: Vec<CategoryDefault>,
    pub products: Vec<Product>,
    pub operators: Vec<Operator>,
    pub badges: Vec<Badge>,
    pub sscc_counters: Vec<SsccCounter>,
    pub shift_number_counters: Vec<ShiftNumberCounter>,
    /// Every product-group code a row names, with the row's field: the
    /// route checks them against `chz_product_groups` in one read.
    pub group_refs: Vec<(String, u32)>,
}

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// A shift-number counter's key: `MONYY`, as `shifts::month_key` writes it.
/// The text comes from a file, so it is cut by bytes: a slice at a byte that
/// is no character boundary (`ABÀ1`: five bytes) would panic the handler.
fn is_month_key(text: &str) -> bool {
    text.len() == 5
        && text.get(..3).is_some_and(|month| MONTHS.contains(&month))
        && text.as_bytes()[3..].iter().all(u8::is_ascii_digit)
}

/// `validation_failed` on `field` when `id` was seen before in its list.
fn unique_id<'a>(seen: &mut HashSet<&'a str>, field: &str, id: &'a str) -> Result<(), ApiError> {
    validate::client_uuid(field, id)?;
    if seen.insert(id) {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "the id is repeated in the file",
        ))
    }
}

pub fn check(request: &CloudImportRequest) -> Result<ValidImport, ApiError> {
    validate::client_uuid("importId", &request.import_id)?;
    if !CLOUD_IMPORT_FORMAT_VERSIONS.contains(&request.format_version) {
        return Err(ApiError::validation(
            "formatVersion",
            "this host reads format versions 1 and 2",
        ));
    }
    if time::OffsetDateTime::parse(
        &request.exported_at,
        &time::format_description::well_known::Rfc3339,
    )
    .is_err()
    {
        return Err(ApiError::validation(
            "exportedAt",
            "an RFC 3339 time is required",
        ));
    }
    validate::clean_text(
        "source.tenantId",
        &request.source.tenant_id,
        100,
        "the tenant",
    )?;
    validate::clean_text(
        "source.tenantName",
        &request.source.tenant_name,
        200,
        "the name",
    )?;
    let payload = &request.payload;
    let org = &payload.organization;
    let org = validate::org(
        "payload.organization",
        &OrgProfileInput {
            name: org.name.clone(),
            inn: org.inn.clone(),
            gln: org.gln.clone(),
            gs1_prefixes: org.gs1_prefixes.clone(),
            time_zone: org.time_zone.clone(),
        },
    )?;
    let badge_salt = match &payload.badge_salt {
        None => None,
        Some(salt) => {
            let bytes = STANDARD
                .decode(salt.expose())
                .ok()
                .filter(|bytes| bytes.len() == 16 && STANDARD.encode(bytes) == salt.expose());
            Some(bytes.ok_or_else(|| {
                ApiError::validation("payload.badgeSalt", "16 bytes in standard base64")
            })?)
        }
    };
    let mut group_refs = Vec::new();

    let mut ids = HashSet::new();
    let mut keys = HashSet::new();
    // Grow only after validation: a body may contain millions of short invalid
    // rows within its byte limit. Reserving from their count amplifies memory
    // use even when the first row is refused. The same applies to each list below.
    let mut lines = Vec::new();
    for (index, line) in payload.lines.iter().enumerate() {
        unique_id(&mut ids, &format!("payload.lines.{index}.id"), &line.id)?;
        let field = format!("payload.lines.{index}.name");
        let (name, name_key) = validate::line_name(&field, &line.name)?;
        if !keys.insert(name_key.clone()) {
            return Err(ApiError::validation(&field, "line names must be unique"));
        }
        lines.push(Line {
            id: line.id.clone(),
            name,
            name_key,
        });
    }

    let mut ids = HashSet::new();
    let mut counterparties = Vec::new();
    for (index, each) in payload.counterparties.iter().enumerate() {
        unique_id(
            &mut ids,
            &format!("payload.counterparties.{index}.id"),
            &each.id,
        )?;
        counterparties.push(Counterparty {
            id: each.id.clone(),
            company: validate::company(
                &format!("payload.counterparties.{index}"),
                &each.name,
                each.inn.as_deref(),
                &each.gln,
                &each.gs1_prefixes,
            )?,
        });
    }

    // The ids a product's default counterparty may name (plan ТОВ).
    let counterparty_ids: HashSet<&str> =
        counterparties.iter().map(|each| each.id.as_str()).collect();

    let mut ids = HashSet::new();
    let mut templates = Vec::new();
    let mut scopes: HashMap<&str, Scope> = HashMap::new();
    for (index, each) in payload.templates.iter().enumerate() {
        let field = |name: &str| format!("payload.templates.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        let name = validate::template_name(&field("name"), &each.name)?;
        let spec = validate::template_spec(&field("spec"), &each.spec)?;
        // The cloud's A4 pallet sheet (`pallet_sheet_v2`) is no thermal
        // label: the export leaves it out, so one here means a damaged file.
        if each.spec.get("kind").and_then(serde_json::Value::as_str) == Some("pallet_sheet") {
            return Err(ApiError::validation(
                &field("spec"),
                "an A4 pallet sheet is not a label template",
            ));
        }
        let codes = each.chz_product_group_codes.as_deref();
        validate::category_codes(&field("chzProductGroupCodes"), codes)?;
        for &code in codes.unwrap_or_default() {
            group_refs.push((field("chzProductGroupCodes"), code));
        }
        scopes.insert(
            &each.id,
            Scope {
                purpose: each.purpose,
                enabled: each.enabled,
                codes: each.chz_product_group_codes.clone(),
            },
        );
        templates.push(Template {
            id: each.id.clone(),
            name,
            purpose: each.purpose,
            enabled: each.enabled,
            codes: each.chz_product_group_codes.clone(),
            spec,
        });
    }

    // A default names a template of the file that fits its slot, as
    // `templates::check_slot` checks one in `PUT /v1/office/template-defaults`.
    let defaults = &payload.template_defaults;
    for (field, id, purpose) in [
        (
            "payload.templateDefaults.defaultBoxTemplateId",
            &defaults.default_box_template_id,
            TemplatePurpose::Box,
        ),
        (
            "payload.templateDefaults.defaultPalletTemplateId",
            &defaults.default_pallet_template_id,
            TemplatePurpose::Pallet,
        ),
    ] {
        if let Some(id) = id {
            if !scopes
                .get(id.as_str())
                .is_some_and(|scope| fits(scope, purpose, None))
            {
                return Err(ApiError::validation(
                    field,
                    "a template of the file that fits this default is required",
                ));
            }
        }
    }
    let mut slots = HashSet::new();
    let mut categories = Vec::new();
    for (index, each) in defaults.categories.iter().enumerate() {
        let field = format!("payload.templateDefaults.categories.{index}");
        if !slots.insert((each.chz_product_group_code, each.purpose)) {
            return Err(ApiError::validation(
                &field,
                "a category default is given twice",
            ));
        }
        if !scopes
            .get(each.template_id.as_str())
            .is_some_and(|scope| fits(scope, each.purpose, Some(each.chz_product_group_code)))
        {
            return Err(ApiError::validation(
                &format!("{field}.templateId"),
                "a template of the file that fits this default is required",
            ));
        }
        group_refs.push((
            format!("{field}.chzProductGroupCode"),
            each.chz_product_group_code,
        ));
        categories.push(CategoryDefault {
            code: each.chz_product_group_code,
            purpose: each.purpose,
            template_id: each.template_id.clone(),
        });
    }

    let mut ids = HashSet::new();
    let mut gtins_in_use = HashSet::new();
    let mut products = Vec::new();
    for (index, each) in payload.products.iter().enumerate() {
        let field = |name: &str| format!("payload.products.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        let gtin14 = validate::gtin14(&field("gtin14"), &each.gtin14)?;
        if !each.archived && !gtins_in_use.insert(gtin14.clone()) {
            return Err(ApiError::validation(
                &field("gtin14"),
                "another product in use has this GTIN",
            ));
        }
        let name = validate::product_name(&field("name"), &each.name)?;
        let print_name = validate::print_name(&field("printName"), each.print_name.as_deref())?;
        validate::count(
            &field("boxCapacity"),
            each.box_capacity,
            validate::MAX_BOX_CAPACITY,
        )?;
        validate::count(
            &field("palletBoxCapacity"),
            each.pallet_box_capacity,
            validate::MAX_PALLET_BOX_CAPACITY,
        )?;
        validate::count(
            &field("shelfLifeDays"),
            each.shelf_life_days,
            validate::MAX_SHELF_LIFE_DAYS,
        )?;
        if let Some(code) = each.chz_product_group_code {
            group_refs.push((field("chzProductGroupCode"), code));
        }
        for (name, id, purpose) in [
            (
                "defaultBoxTemplateId",
                &each.default_box_template_id,
                TemplatePurpose::Box,
            ),
            (
                "defaultPalletTemplateId",
                &each.default_pallet_template_id,
                TemplatePurpose::Pallet,
            ),
        ] {
            if let Some(id) = id {
                if scopes.get(id.as_str()).map(|scope| scope.purpose) != Some(purpose) {
                    return Err(ApiError::validation(
                        &field(name),
                        format!("a {} template of the file is required", purpose.as_str()),
                    ));
                }
            }
        }
        // The office's rules (plan ТОВ): an EGAIS code only with ЧЗ group
        // 15, a default counterparty only one this file carries.
        let egais_code = validate::egais_code(&field("egaisCode"), each.egais_code.as_deref())?;
        if egais_code.is_some()
            && each.chz_product_group_code != Some(validate::EGAIS_PRODUCT_GROUP_CODE)
        {
            return Err(ApiError::validation(
                &field("egaisCode"),
                "only a product of ЧЗ group 15 carries an EGAIS code",
            ));
        }
        if let Some(id) = &each.default_counterparty_id {
            if !counterparty_ids.contains(id.as_str()) {
                return Err(ApiError::validation(
                    &field("defaultCounterpartyId"),
                    "a counterparty of the file is required",
                ));
            }
        }
        products.push(Product {
            id: each.id.clone(),
            gtin14,
            name,
            print_name,
            group: each.chz_product_group_code,
            box_capacity: each.box_capacity,
            pallet_box_capacity: each.pallet_box_capacity,
            shelf_life_days: each.shelf_life_days,
            default_box_template_id: each.default_box_template_id.clone(),
            default_pallet_template_id: each.default_pallet_template_id.clone(),
            egais_code,
            default_counterparty_id: each.default_counterparty_id.clone(),
            archived: each.archived,
        });
    }

    let mut ids = HashSet::new();
    let mut logins = HashSet::new();
    let mut operators = Vec::new();
    for (index, each) in payload.operators.iter().enumerate() {
        let field = |name: &str| format!("payload.operators.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        validate::operator_login(&field("login"), &each.login)?;
        if !logins.insert(each.login.as_str()) {
            return Err(ApiError::validation(
                &field("login"),
                "the personnel number is repeated in the file",
            ));
        }
        let name = validate::person_name(&field("name"), &each.name)?;
        let role = validate::operator_role(&field("role"), each.role.as_deref())?;
        validate::pin_phc(&field("pinPhc"), each.pin_phc.expose())?;
        operators.push(Operator {
            id: each.id.clone(),
            login: each.login.clone(),
            name,
            role,
            pin_phc: each.pin_phc.expose().to_owned(),
            active: each.active,
        });
    }

    let operator_ids: HashSet<&str> = operators.iter().map(|each| each.id.as_str()).collect();
    let mut ids = HashSet::new();
    let mut hashes = HashSet::new();
    let mut badges = Vec::new();
    for (index, each) in payload.badges.iter().enumerate() {
        let field = |name: &str| format!("payload.badges.{index}.{name}");
        unique_id(&mut ids, &field("id"), &each.id)?;
        if !operator_ids.contains(each.operator_id.as_str()) {
            return Err(ApiError::validation(
                &field("operatorId"),
                "an operator of the file is required",
            ));
        }
        let salt = badge_salt.as_deref().ok_or_else(|| {
            ApiError::validation("payload.badgeSalt", "the badges need their salt")
        })?;
        validate::badge_phc(&field("badgePhc"), each.badge_phc.expose(), salt)?;
        if !hashes.insert(each.badge_phc.expose()) {
            return Err(ApiError::validation(
                &field("badgePhc"),
                "the badge is repeated in the file",
            ));
        }
        badges.push(Badge {
            id: each.id.clone(),
            operator_id: each.operator_id.clone(),
            badge_phc: each.badge_phc.expose().to_owned(),
            label: validate::badge_label(&field("label"), each.label.as_deref())?,
        });
    }

    let mut keys = HashSet::new();
    let mut sscc_counters = Vec::new();
    for (index, each) in payload.sscc_counters.iter().enumerate() {
        let field = |name: &str| format!("payload.ssccCounters.{index}.{name}");
        if each.extension > 1 {
            return Err(ApiError::validation(
                &field("extension"),
                "0 (boxes) or 1 (pallets)",
            ));
        }
        let prefix = &each.issuer_prefix;
        if !(4..=12).contains(&prefix.len()) || !prefix.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(ApiError::validation(
                &field("issuerPrefix"),
                "an issuer prefix is 4-12 digits",
            ));
        }
        validate::sscc_serial(
            &field("nextSerial"),
            each.extension,
            prefix,
            each.next_serial,
        )?;
        if !keys.insert((prefix.as_str(), each.extension)) {
            return Err(ApiError::validation(
                &format!("payload.ssccCounters.{index}"),
                "the counter is repeated in the file",
            ));
        }
        sscc_counters.push(SsccCounter {
            issuer_prefix: prefix.clone(),
            extension: each.extension,
            next_serial: each.next_serial,
        });
    }

    let mut months = HashSet::new();
    let mut shift_number_counters = Vec::new();
    for (index, each) in payload.shift_number_counters.iter().enumerate() {
        let field = |name: &str| format!("payload.shiftNumberCounters.{index}.{name}");
        if !is_month_key(&each.month_key) {
            return Err(ApiError::validation(
                &field("monthKey"),
                "a month key MONYY is required",
            ));
        }
        if each.last_seq == 0 {
            return Err(ApiError::validation(
                &field("lastSeq"),
                "a number of 1 or more",
            ));
        }
        if !months.insert(each.month_key.as_str()) {
            return Err(ApiError::validation(
                &field("monthKey"),
                "the month is repeated in the file",
            ));
        }
        shift_number_counters.push(ShiftNumberCounter {
            month_key: each.month_key.clone(),
            last_seq: each.last_seq,
        });
    }

    Ok(ValidImport {
        gln: org.gln,
        badge_salt,
        lines,
        counterparties,
        templates,
        default_box_template_id: defaults.default_box_template_id.clone(),
        default_pallet_template_id: defaults.default_pallet_template_id.clone(),
        categories,
        products,
        operators,
        badges,
        sscc_counters,
        shift_number_counters,
        group_refs,
    })
}
