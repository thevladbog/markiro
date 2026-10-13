//! The license's routes (plan ЛЦ-2, spec §8.2) and the wire shapes they
//! answer with (`markiro_proto::license`).

use axum::extract::State;
use axum::Json;
use markiro_proto::license::{
    LicenseBinding, LicenseCustomer, LicenseEmergency, LicenseFeatures, LicenseFlags,
    LicenseQuotas, LicenseSummary, OfficeLicense, QuotaUse, TrialInfo,
};
use markiro_proto::trust::{
    ActivationLicense, ActivationOrganization, ActivationRequest, ActivationTrial, ActivationUsage,
    ACTIVATION_REQUEST_FORMAT,
};

use super::seats::{self, Usage};
use super::state::{Features, Quotas, StoredLicense};
use super::{ms_text, Snapshot};
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

fn quota_use(limit: Option<u64>, used: u64) -> QuotaUse {
    QuotaUse {
        limit,
        used,
        over: limit.is_some_and(|limit| used > limit),
    }
}

pub fn quotas_wire(quotas: &Quotas, usage: &Usage) -> LicenseQuotas {
    LicenseQuotas {
        lines: quota_use(quotas.lines, usage.lines),
        stations: quota_use(quotas.stations, usage.stations),
        kiosks: quota_use(quotas.kiosks, usage.kiosks),
        cabinet_users: quota_use(quotas.cabinet_users, usage.cabinet_users),
    }
}

pub fn features_wire(features: &Features) -> LicenseFeatures {
    LicenseFeatures {
        label_editor: features.label_editor,
        public_api: features.public_api,
        pallets: features.pallets,
        chz_integration: features.chz_integration,
        inventory: features.inventory,
        commerce_ml: features.commerce_ml,
        handheld: features.handheld,
    }
}

fn summary(license: &StoredLicense) -> LicenseSummary {
    LicenseSummary {
        license_id: license.license_id.clone(),
        sequence: u64::try_from(license.sequence).unwrap_or(0),
        kid: license.kid.clone(),
        customer: LicenseCustomer {
            name: license.customer_name.clone(),
            inn: license.customer_inn.clone(),
        },
        plan: license.plan.clone(),
        plan_version_id: license.plan_version_id.clone(),
        issued_at: ms_text(license.issued_at),
        valid_from: ms_text(license.valid_from),
        valid_until: ms_text(license.valid_until),
        grace_days: u32::try_from(license.grace_days).unwrap_or(0),
    }
}

/// `GET /v1/office/license` of `snapshot`.
pub fn office_license(app: &AppState, snapshot: &Snapshot, usage: &Usage) -> OfficeLicense {
    let evaluation = &snapshot.evaluation;
    OfficeLicense {
        state: evaluation.phase.as_str().to_owned(),
        since: ms_text(evaluation.since),
        flags: LicenseFlags {
            clock_behind_days: snapshot.reading.behind_days(),
            clock_ahead: snapshot.reading.ahead,
        },
        effective_at: ms_text(snapshot.reading.effective),
        phase_ends_at: evaluation.phase_ends_at.map(ms_text),
        days_left: evaluation.days_left,
        warn_days: evaluation.warn_days,
        opens_new_shifts: evaluation.opens_new_shifts,
        license: evaluation.license.as_ref().map(summary),
        trial: evaluation.trial.map(|trial| TrialInfo {
            started_at: ms_text(trial.started_at),
            ends_at: ms_text(trial.ends_at),
            inn: snapshot.clock_row.trial_inn.clone(),
        }),
        binding: LicenseBinding {
            host_id: app.host_id.clone(),
            fingerprint: app.endpoint.fingerprint.clone(),
            org_inn: snapshot.org_inn.clone(),
            inn_matches: evaluation.inn_matches,
        },
        quotas: quotas_wire(&evaluation.quotas, usage),
        features: features_wire(&evaluation.features),
        emergency: LicenseEmergency {
            available: evaluation.emergency_available,
            until: evaluation.emergency_until.map(ms_text),
        },
        warnings: Vec::new(),
    }
}

/// `GET /v1/office/license`: every office role.
pub async fn get_license(
    State(app): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeLicense>, ApiError> {
    app.license.office_license_now(&app).await.map(Json)
}

/// `GET /v1/office/license/activation-request` (administrators): what the
/// office saves for Маркиро to issue a file (spec §6.3). Not signed, no
/// secret in it; `usage` keeps an operator from issuing a quota below it.
/// Built as plan ЛЦ-1's `ActivationRequest`, so its shape is the domain's
/// schema; an INN the host does not have is empty, as that type wants. It is
/// never written to the service log.
pub async fn activation_request(
    State(app): State<AppState>,
    context: OfficeContext,
) -> Result<Json<ActivationRequest>, ApiError> {
    context.require_admin()?;
    let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let newest = snapshot
        .licenses
        .iter()
        .max_by_key(|license| license.sequence);
    Ok(Json(ActivationRequest {
        format: ACTIVATION_REQUEST_FORMAT.to_owned(),
        host_id: app.host_id.clone(),
        host_fingerprint: app.endpoint.fingerprint.clone(),
        host_version: env!("CARGO_PKG_VERSION").to_owned(),
        organization: ActivationOrganization {
            name: name.unwrap_or_default(),
            inn: snapshot.org_inn.clone().unwrap_or_default(),
        },
        trial: snapshot.evaluation.trial.map(|trial| ActivationTrial {
            started_at: ms_text(trial.started_at),
            inn: snapshot.clock_row.trial_inn.clone().unwrap_or_default(),
        }),
        current_license: newest.map(|license| ActivationLicense {
            license_id: license.license_id.clone(),
            sequence: u64::try_from(license.sequence).unwrap_or(0),
        }),
        usage: ActivationUsage {
            stations: usage.stations,
            cabinet_users: usage.cabinet_users,
            lines: usage.lines,
        },
        created_at: app.timestamp(),
    }))
}
