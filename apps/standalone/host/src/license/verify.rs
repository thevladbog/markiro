//! The check of a license file before anything is written (spec §4.3), in
//! its order: the form, the key, the signature, the payload and its issuer
//! (`markiro_proto::trust`, plan ЛЦ-1), then this host, the organization's
//! INN and the order of the site's files.

use markiro_proto::license::{refusals, warnings};
use markiro_proto::trust::{Keyset, LicensePayloadV1, LicensePlan, TrustError};

use super::seats::{self, Usage};
use super::state::{self, Features, Quotas, StoredLicense};

/// The most a license file may hold, as sent (spec §4.3 step 1).
pub const MAX_FILE_BYTES: usize = markiro_proto::trust::MAX_LICENSE_BYTES;

/// Why a file was refused. From `WrongHost` on, the signature checked out,
/// so the file's id can name it in the audit row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    UnknownKey,
    Signature,
    WrongHost {
        license_id: String,
        file_host_id: String,
    },
    InnMismatch {
        license_id: String,
        file_inn: String,
        org_inn: String,
    },
    InnMissing {
        license_id: String,
    },
    Older {
        license_id: String,
        newest: i64,
    },
}

impl Refusal {
    /// `details.reason` ([`refusals`]).
    pub fn reason(&self) -> &'static str {
        match self {
            Refusal::Malformed => refusals::MALFORMED,
            Refusal::UnknownKey => refusals::UNKNOWN_KEY,
            Refusal::Signature => refusals::SIGNATURE,
            Refusal::WrongHost { .. } => refusals::WRONG_HOST,
            Refusal::InnMismatch { .. } => refusals::INN_MISMATCH,
            Refusal::InnMissing { .. } => refusals::INN_MISSING,
            Refusal::Older { .. } => refusals::OLDER,
        }
    }

    /// The file's id, once its signature checked out.
    pub fn license_id(&self) -> Option<&str> {
        match self {
            Refusal::WrongHost { license_id, .. }
            | Refusal::InnMismatch { license_id, .. }
            | Refusal::InnMissing { license_id }
            | Refusal::Older { license_id, .. } => Some(license_id),
            Refusal::Malformed | Refusal::UnknownKey | Refusal::Signature => None,
        }
    }
}

/// A file this build trusts, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub license: StoredLicense,
    /// The file's text, trimmed: what `licenses.compact` keeps.
    pub compact: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Newer than every stored file.
    New,
    /// The file is stored already: nothing to write.
    Same,
}

/// Steps 1–4: the size of the text as sent, then plan ЛЦ-1's form, key,
/// signature, payload and issuer.
pub fn read(file: &str, keyset: &Keyset) -> Result<Verified, Refusal> {
    // The text as sent: a good file padded past the limit is still too big.
    if file.len() > MAX_FILE_BYTES {
        return Err(Refusal::Malformed);
    }
    let compact = file.trim();
    let (payload, kid) =
        markiro_proto::trust::verify_license(compact, keyset).map_err(|error| match error {
            TrustError::Malformed => Refusal::Malformed,
            TrustError::UnknownKey => Refusal::UnknownKey,
            TrustError::BadSignature => Refusal::Signature,
        })?;
    let license = stored_of(&payload, kid).ok_or(Refusal::Malformed)?;
    Ok(Verified {
        license,
        compact: compact.to_owned(),
    })
}

/// The payload as the host keeps it. Plan ЛЦ-1 has checked its rules
/// (`LicensePayloadV1::is_valid`: every number up to 2^53 − 1, `graceDays`
/// up to 60, `validFrom` before `validUntil`), so the conversions hold.
fn stored_of(payload: &LicensePayloadV1, kid: String) -> Option<StoredLicense> {
    let ms = |value: u64| i64::try_from(value).ok();
    Some(StoredLicense {
        license_id: payload.license_id.clone(),
        sequence: ms(payload.sequence)?,
        kid,
        host_id: payload.host_id.clone(),
        issued_at: ms(payload.issued_at)?,
        valid_from: ms(payload.valid_from)?,
        valid_until: ms(payload.valid_until)?,
        grace_days: i64::from(payload.grace_days),
        plan: match payload.plan {
            LicensePlan::Demo => markiro_proto::license::plans::DEMO,
            LicensePlan::Subscription => markiro_proto::license::plans::SUBSCRIPTION,
        }
        .to_owned(),
        plan_version_id: payload.plan_version_id.clone(),
        customer_name: payload.customer.name.clone(),
        customer_inn: payload.customer.inn.clone(),
        quotas: Quotas {
            lines: payload.quotas.lines,
            stations: payload.quotas.stations,
            kiosks: payload.quotas.kiosks,
            cabinet_users: payload.quotas.cabinet_users,
        },
        features: Features {
            label_editor: payload.features.label_editor,
            public_api: payload.features.public_api,
            pallets: payload.features.pallets,
            chz_integration: payload.features.chz_integration,
            inventory: payload.features.inventory,
            commerce_ml: payload.features.commerce_ml,
            handheld: payload.features.handheld,
        },
    })
}

/// Steps 5–7: this host's file, the organization's INN (normalized and
/// checked by its check digit, §4.9; the GLN and the prefixes are not part
/// of it), newer than every stored file. The same file again is no refusal:
/// nothing changes. `stored` are the files the host can use; `newest` is the
/// highest stored `sequence` of any row, one the host cannot read included,
/// so such a row never lets an older file in.
pub fn admit(
    verified: &Verified,
    host_id: &str,
    org_inn: Option<&str>,
    stored: &[StoredLicense],
    newest: Option<i64>,
) -> Result<Admission, Refusal> {
    let license = &verified.license;
    let license_id = license.license_id.clone();
    if license.host_id != host_id {
        return Err(Refusal::WrongHost {
            license_id,
            file_host_id: license.host_id.clone(),
        });
    }
    // `org_profile.inn` is NULL or 10 or 12 digits (its CHECK): never blank.
    let Some(org) = org_inn else {
        return Err(Refusal::InnMissing { license_id });
    };
    if !state::inn_matches(Some(org), &license.customer_inn) {
        return Err(Refusal::InnMismatch {
            license_id,
            file_inn: license.customer_inn.clone(),
            org_inn: org.to_owned(),
        });
    }
    // «The same file» is decided by `licenseId` alone: the issuer gives
    // every file its own id (a new `sequence` is a new id), and this host,
    // INN and signature were checked above.
    if stored
        .iter()
        .any(|known| known.license_id == license.license_id)
    {
        return Ok(Admission::Same);
    }
    match newest {
        Some(newest) if license.sequence <= newest => Err(Refusal::Older { license_id, newest }),
        _ => Ok(Admission::New),
    }
}

/// What an accepted file warns of, at the effective time `now`: the time
/// the host keeps after the load (`routes::time_after_load`).
pub fn warnings_for(license: &StoredLicense, now: i64, usage: &Usage) -> Vec<String> {
    let mut found = Vec::new();
    if license.valid_until <= now {
        found.push(warnings::EXPIRED.to_owned());
    }
    if license.valid_from > now {
        found.push(warnings::NOT_YET_VALID.to_owned());
    }
    if seats::over_any(&license.quotas, usage) {
        found.push(warnings::OVER_LIMIT.to_owned());
    }
    found
}
