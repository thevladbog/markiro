//! Label-template rules the host arbitrates (spec §2, decision 11): which
//! template may stand in a default slot, and which defaults a template
//! holds. The layout itself (`spec`) is the UI's (`labelTemplateSpecSchema`).

use markiro_proto::TemplatePurpose;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// What decides whether a template may stand in a default slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub purpose: TemplatePurpose,
    pub enabled: bool,
    /// `None` for every category.
    pub codes: Option<Vec<u32>>,
}

/// Whether a template may stand in the default slot of `purpose` for
/// `category`, where `None` is the organization's slot: an enabled template
/// of the slot's purpose that covers the category, and for the organization
/// every category. `@markiro/domain`'s `isBoxLabelTemplateEligible` and
/// `isPalletLabelTemplateEligible` answer the same for a product's group (a
/// scoped template never fits a product without one), so the organization's
/// slot is the slot of a product without a group. The cases both sides must
/// answer alike are in `proto/fixtures/template-eligibility.json`.
pub fn fits(scope: &Scope, purpose: TemplatePurpose, category: Option<u32>) -> bool {
    scope.enabled
        && scope.purpose == purpose
        && match (&scope.codes, category) {
            (None, _) => true,
            (Some(codes), Some(code)) => codes.contains(&code),
            (Some(_), None) => false,
        }
}

/// `validation_failed` on `field` unless every code is a ЧЗ product group.
/// The codes are distinct (`validate::category_codes`).
pub async fn check_groups(
    conn: &mut SqliteConnection,
    field: &str,
    codes: Option<&[u32]>,
) -> Result<(), ApiError> {
    let Some(codes) = codes else {
        return Ok(());
    };
    let found: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chz_product_groups WHERE code IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(codes).map_err(ApiError::internal)?)
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)?;
    if usize::try_from(found).is_ok_and(|found| found == codes.len()) {
        Ok(())
    } else {
        Err(ApiError::validation(field, "no such product group"))
    }
}

/// The organization's column for its default of `purpose`.
pub fn org_column(purpose: TemplatePurpose) -> &'static str {
    match purpose {
        TemplatePurpose::Box => "default_box_template_id",
        TemplatePurpose::Pallet => "default_pallet_template_id",
        TemplatePurpose::ProductDuplicate => "default_duplicate_template_id",
    }
}

/// The defaults a template holds: whether it is the organization's default
/// of its purpose, and the categories whose default it is, ascending. A slot
/// takes only a template of its own purpose, so no other slot names it.
pub struct Usage {
    pub organization: bool,
    pub categories: Vec<u32>,
}

pub async fn usage(
    conn: &mut SqliteConnection,
    id: &str,
    purpose: TemplatePurpose,
) -> Result<Usage, ApiError> {
    let organization: Option<i64> = sqlx::query_scalar(&format!(
        "SELECT 1 FROM org_profile WHERE id = 1 AND {} = ?",
        org_column(purpose)
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let categories: Vec<u32> = sqlx::query_scalar(
        "SELECT chz_group_code FROM category_template_defaults WHERE template_id = ? \
         ORDER BY chz_group_code",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Usage {
        organization: organization.is_some(),
        categories,
    })
}

/// `conflict` on `template_is_default`, as the cloud's
/// `LABEL_TEMPLATE_IS_DEFAULT`: the template is the organization's default
/// (`organizationDefault`) or the default of the categories listed
/// (`categoryDefaults`), and the change would leave that default unfit or
/// without a template.
pub fn is_default(organization: bool, categories: Vec<u32>) -> ApiError {
    ApiError::conflict(
        "template_is_default",
        "the template is a default that the change would break",
    )
    .with_details(json!({
        "constraint": "template_is_default",
        "organizationDefault": organization,
        "categoryDefaults": categories,
    }))
}
