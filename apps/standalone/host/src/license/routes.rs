//! The license's routes (plan ЛЦ-2, spec §8.2) and the wire shapes they
//! answer with (`markiro_proto::license`).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::codes;
use markiro_proto::license::constraints;
use markiro_proto::license::{
    plans, DeviceLicense, LicenseBinding, LicenseCustomer, LicenseEmergency, LicenseFeatures,
    LicenseFlags, LicenseLoadRequest, LicensePreview, LicenseQuotas, LicenseSummary, LicenseTerms,
    OfficeLicense, QuotaUse, TrialInfo,
};
use markiro_proto::trust::{
    ActivationLicense, ActivationOrganization, ActivationRequest, ActivationTrial, ActivationUsage,
    ACTIVATION_REQUEST_FORMAT,
};
use serde_json::{json, Value};

use super::seats::{self, Usage};
use super::state::{self, Evaluation, Features, Quotas, StoredLicense};
use super::verify::{self, Admission, Refusal};
use super::{clock, ms_text, store, Snapshot};
use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

/// The body limit of a preview and a load: a file is at most 16 KiB, and its
/// JSON envelope a little more.
pub const MAX_BODY_BYTES: usize = 32 * 1024;

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

/// The license line of `GET /v1/device` (plan ЛЦ-2): the state as the host
/// computes it, so a station explains a refusal before it asks. The line
/// only informs: whatever the state, the device works on (soft enforcement).
pub fn device_license(snapshot: &Snapshot) -> DeviceLicense {
    let evaluation = &snapshot.evaluation;
    DeviceLicense {
        state: evaluation.phase.as_str().to_owned(),
        since: ms_text(evaluation.since),
        phase_ends_at: evaluation.phase_ends_at.map(ms_text),
        emergency_until: evaluation.emergency_until.map(ms_text),
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
    let request = ActivationRequest {
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
    };
    checked_activation_request(request).map(Json)
}

/// The request as plan ЛЦ-1's rules want it, or a precise refusal: the
/// office reads it with the domain's strict schema, so a body that breaks a
/// rule must never leave. The organization's profile takes names the
/// request refuses (`validate::clean_text` counts characters and refuses
/// only `char::is_control`; plan ЛЦ-1 counts UTF-16 units and refuses the
/// line separators and bidirectional controls too): that is the person's to
/// fix, on `org.name`. Anything else is the host's own fault; its log line
/// holds no value.
fn checked_activation_request(request: ActivationRequest) -> Result<ActivationRequest, ApiError> {
    if request.is_valid() {
        return Ok(request);
    }
    let mut named = request.clone();
    named.organization.name = "-".to_owned();
    if named.is_valid() {
        return Err(ApiError::validation(
            "org.name",
            "the organization's name cannot go into an activation request: \
             it must be 1-300 characters without control or direction marks",
        ));
    }
    Err(ApiError::internal(
        "the activation request the host built breaks its own rules",
    ))
}

/// One column of «было → станет» for a file.
fn terms_of_file(license: &StoredLicense, usage: &Usage) -> LicenseTerms {
    LicenseTerms {
        license_id: Some(license.license_id.clone()),
        sequence: u64::try_from(license.sequence).ok(),
        plan: license.plan.clone(),
        valid_from: Some(ms_text(license.valid_from)),
        valid_until: Some(ms_text(license.valid_until)),
        grace_days: u32::try_from(license.grace_days).unwrap_or(0),
        quotas: quotas_wire(&license.quotas, usage),
        features: features_wire(&license.features),
    }
}

/// The column of what is in force now: the file, or the built-in trial.
fn terms_now(evaluation: &Evaluation, usage: &Usage) -> LicenseTerms {
    match &evaluation.license {
        Some(license) => terms_of_file(license, usage),
        None => LicenseTerms {
            license_id: None,
            sequence: None,
            plan: plans::TRIAL.to_owned(),
            valid_from: evaluation.trial.map(|trial| ms_text(trial.started_at)),
            valid_until: evaluation.trial.map(|trial| ms_text(trial.ends_at)),
            grace_days: 0,
            quotas: quotas_wire(&Quotas::default(), usage),
            features: features_wire(&Features::ALL),
        },
    }
}

fn quota_list(quotas: &LicenseQuotas) -> [(&'static str, QuotaUse); 4] {
    [
        ("lines", quotas.lines),
        ("stations", quotas.stations),
        ("kiosks", quotas.kiosks),
        ("cabinetUsers", quotas.cabinet_users),
    ]
}

fn feature_list(features: &LicenseFeatures) -> [(&'static str, bool); 7] {
    [
        ("labelEditor", features.label_editor),
        ("publicApi", features.public_api),
        ("pallets", features.pallets),
        ("chzIntegration", features.chz_integration),
        ("inventory", features.inventory),
        ("commerceMl", features.commerce_ml),
        ("handheld", features.handheld),
    ]
}

/// The fields of `after` that differ from `before`, in the preview's order
/// (plan Д4): `plan`, `validFrom`, `validUntil`, `graceDays`,
/// `quotas.<key>`, `features.<key>`.
fn changes(before: &LicenseTerms, after: &LicenseTerms) -> Vec<String> {
    let mut changes = Vec::new();
    if before.plan != after.plan {
        changes.push("plan".to_owned());
    }
    if before.valid_from != after.valid_from {
        changes.push("validFrom".to_owned());
    }
    if before.valid_until != after.valid_until {
        changes.push("validUntil".to_owned());
    }
    if before.grace_days != after.grace_days {
        changes.push("graceDays".to_owned());
    }
    for ((key, was), (_, will)) in quota_list(&before.quotas)
        .into_iter()
        .zip(quota_list(&after.quotas))
    {
        if was.limit != will.limit {
            changes.push(format!("quotas.{key}"));
        }
    }
    for ((key, was), (_, will)) in feature_list(&before.features)
        .into_iter()
        .zip(feature_list(&after.features))
    {
        if was != will {
            changes.push(format!("features.{key}"));
        }
    }
    changes
}

/// The effective time the host keeps once `license` is stored: the latest
/// issue of every stored file and the new one less a day raises it (§7). The
/// warnings speak of this time, so they never call a file «not yet valid» or
/// «expired» when it is not by the time the host uses after the load.
fn time_after_load(snapshot: &Snapshot, license: &StoredLicense) -> i64 {
    let floor = clock::issue_floor(
        snapshot
            .licenses
            .iter()
            .chain([license])
            .map(|license| license.issued_at),
    );
    floor.map_or(snapshot.reading.effective, |floor| {
        snapshot.reading.effective.max(floor)
    })
}

/// «было → станет» of `license` against what is in force (spec §4.8).
/// «before» is the file in force now (or the trial), which need not be the
/// stored file of the highest `sequence`: a newer file may wait for its
/// start. The `license.load` row's `previousSequence` is the highest stored
/// one, the file the new one replaces by number.
pub fn preview_of(snapshot: &Snapshot, usage: &Usage, license: &StoredLicense) -> LicensePreview {
    let before = terms_now(&snapshot.evaluation, usage);
    let after = terms_of_file(license, usage);
    LicensePreview {
        changes: changes(&before, &after),
        warnings: verify::warnings_for(license, time_after_load(snapshot, license), usage),
        before,
        after,
    }
}

/// `validation_failed` on `file` with the refusal's reason and what the
/// office's text needs (the file's host, both INNs, the newest number).
fn refused(refusal: &Refusal) -> ApiError {
    let mut details = json!({ "field": "file", "reason": refusal.reason() });
    match refusal {
        Refusal::WrongHost { file_host_id, .. } => details["fileHostId"] = json!(file_host_id),
        Refusal::InnMismatch {
            file_inn, org_inn, ..
        } => {
            details["fileInn"] = json!(file_inn);
            details["orgInn"] = json!(org_inn);
        }
        Refusal::Older { newest, .. } => details["newestSequence"] = json!(newest),
        Refusal::Malformed
        | Refusal::UnknownKey
        | Refusal::Signature
        | Refusal::InnMissing { .. } => {}
    }
    ApiError::new(
        StatusCode::BAD_REQUEST,
        codes::VALIDATION_FAILED,
        "the license file was refused",
    )
    .with_details(details)
}

/// `POST /v1/office/license/preview` (administrators): the file checked as
/// a load checks it, nothing written and no audit row.
pub async fn preview_license(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiJson(request): ApiJson<LicenseLoadRequest>,
) -> Result<Json<LicensePreview>, ApiError> {
    context.require_admin()?;
    app.license_limiter.check(peer.ip())?;
    let read = verify::read(&request.file, app.license.keyset());
    let mut tx = app.pool.begin().await.map_err(ApiError::internal)?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    tx.rollback().await.map_err(ApiError::internal)?;
    let verified = read
        .and_then(|verified| {
            verify::admit(
                &verified,
                &app.host_id,
                snapshot.org_inn.as_deref(),
                &snapshot.licenses,
            )
            .map(|_| verified)
        })
        .map_err(|refusal| refused(&refusal))?;
    Ok(Json(preview_of(&snapshot, &usage, &verified.license)))
}

/// `PUT /v1/office/license` (administrators): load a file. Nothing is
/// written before every check passed; a refused file writes only its
/// `denied` row (spec §8.3: a foreign or forged file is an event); the same
/// file again writes nothing. The service log names only the file's id, its
/// number and a refusal's code: never the file, its signature, the INN or
/// the customer's name.
pub async fn load_license(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    context: OfficeContext,
    ApiJson(request): ApiJson<LicenseLoadRequest>,
) -> Result<Json<OfficeLicense>, ApiError> {
    context.require_admin()?;
    app.license_limiter.check(peer.ip())?;
    let read = verify::read(&request.file, app.license.keyset());
    let at = app.timestamp();
    let mut tx = begin_write(&app.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let admitted = read.and_then(|verified| {
        verify::admit(
            &verified,
            &app.host_id,
            snapshot.org_inn.as_deref(),
            &snapshot.licenses,
        )
        .map(|admission| (verified, admission))
    });
    let (verified, admission) = match admitted {
        Ok(admitted) => admitted,
        Err(refusal) => {
            let mut details = json!({ "reason": refusal.reason() });
            if let Refusal::WrongHost { file_host_id, .. } = &refusal {
                details["fileHostId"] = json!(file_host_id);
            }
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: context.actor(),
                    action: actions::LICENSE_LOAD,
                    target_type: Some("license"),
                    target_id: refusal.license_id(),
                    outcome: Outcome::Denied,
                    details,
                },
            )
            .await
            .map_err(ApiError::internal)?;
            tx.commit().await.map_err(ApiError::internal)?;
            tracing::info!(reason = refusal.reason(), "a license file was refused");
            return Err(refused(&refusal));
        }
    };
    let usage = seats::usage(&mut tx).await.map_err(ApiError::internal)?;
    let warnings = verify::warnings_for(
        &verified.license,
        time_after_load(&snapshot, &verified.license),
        &usage,
    );
    if admission == Admission::Same {
        tx.rollback().await.map_err(ApiError::internal)?;
        let mut answer = office_license(&app, &snapshot, &usage);
        answer.warnings = warnings;
        return Ok(Json(answer));
    }
    let license = &verified.license;
    // The file the new one replaces by number: the highest stored
    // `sequence`, not necessarily the file in force (the preview's «before»).
    let previous = snapshot
        .licenses
        .iter()
        .max_by_key(|license| license.sequence);
    store::insert(
        &mut tx,
        license,
        &verified.compact,
        &at,
        Some(&context.user.id),
    )
    .await
    .map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let mut details = json!({
        "licenseId": license.license_id,
        "sequence": license.sequence,
        "previousSequence": previous.map(|previous| previous.sequence),
        "kid": license.kid,
        "warnings": warnings,
    });
    let changed = audit::update_details(&[
        (
            "quotas",
            previous.map_or(Value::Null, |previous| json!(previous.quotas)),
            json!(license.quotas),
        ),
        (
            "features",
            previous.map_or(Value::Null, |previous| json!(previous.features)),
            json!(license.features),
        ),
        (
            "validUntil",
            previous.map_or(Value::Null, |previous| json!(ms_text(previous.valid_until))),
            json!(ms_text(license.valid_until)),
        ),
        (
            "plan",
            previous.map_or(Value::Null, |previous| json!(previous.plan)),
            json!(license.plan),
        ),
    ])
    .unwrap_or_else(|| json!({ "changed": [] }));
    if let (Value::Object(target), Value::Object(source)) = (&mut details, changed) {
        target.extend(source);
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LICENSE_LOAD,
            target_type: Some("license"),
            target_id: Some(&license.license_id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &app.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    // Every stored file, the new one with them, proves the time is not
    // before its issue less a day (§7).
    if let Some(floor) = clock::issue_floor(
        snapshot
            .licenses
            .iter()
            .chain([license])
            .map(|license| license.issued_at),
    ) {
        app.license.raise_floor(&app, floor);
    }
    tracing::info!(
        license_id = %license.license_id,
        sequence = license.sequence,
        "a license file was loaded"
    );
    app.license.refresh_after_write(&app).await;
    let mut answer = app.license.office_license_now(&app).await?;
    answer.warnings = warnings;
    Ok(Json(answer))
}

/// `POST /v1/office/license/emergency` (administrators, spec §3.5): new
/// shifts open 72 hours more, once per file and once for the trial (the key
/// is the file in force's `licenseId` or `"trial"`; it only moves forward, so
/// the one stored key is enough). A repeat is `emergency_used`, checked
/// first (also while the extension runs and new shifts open); a state that
/// opens new shifts is `emergency_not_needed`; neither writes a row.
pub async fn enable_emergency(
    State(app): State<AppState>,
    context: OfficeContext,
) -> Result<Json<OfficeLicense>, ApiError> {
    context.require_admin()?;
    let at = app.timestamp();
    let mut tx = begin_write(&app.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let snapshot = app
        .license
        .snapshot(&app, &mut tx)
        .await
        .map_err(ApiError::internal)?;
    let evaluation = &snapshot.evaluation;
    if evaluation.emergency_used {
        return Err(ApiError::conflict(
            constraints::EMERGENCY_USED,
            "the emergency extension of this license was used",
        ));
    }
    if evaluation.opens_new_shifts {
        return Err(ApiError::conflict(
            constraints::EMERGENCY_NOT_NEEDED,
            "new shifts open: there is nothing to extend",
        ));
    }
    let until = snapshot
        .reading
        .effective
        .saturating_add(state::EMERGENCY_MS);
    store::set_emergency(&mut tx, &evaluation.emergency_key, until)
        .await
        .map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LICENSE_EMERGENCY,
            target_type: Some("license"),
            target_id: evaluation
                .license
                .as_ref()
                .map(|license| license.license_id.as_str()),
            outcome: Outcome::Ok,
            details: json!({ "until": ms_text(until), "licenseId": evaluation.emergency_key }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    commit_with_revision(tx, &app.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    tracing::info!(key = %evaluation.emergency_key, "the license's emergency extension was enabled");
    app.license.office_license_now(&app).await.map(Json)
}
