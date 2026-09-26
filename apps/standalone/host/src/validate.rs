//! Input rules the host enforces itself. Marking rules (GTIN, KM, labels)
//! stay in `@markiro/domain`; these are structural checks of host data.

use markiro_proto::OrgProfileInput;

use crate::error::ApiError;

/// Office login: ASCII letters, digits, `.`, `_`, `-`; 3-64 characters.
pub fn office_login(field: &str, login: &str) -> Result<(), ApiError> {
    let valid = (3..=64).contains(&login.len())
        && login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "3-64 Latin letters, digits, dots, underscores or hyphens",
        ))
    }
}

/// A person's display name: trimmed, 1-100 characters.
pub fn person_name(field: &str, name: &str) -> Result<String, ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        Err(ApiError::validation(
            field,
            "the name must be 1-100 characters",
        ))
    } else {
        Ok(trimmed.to_owned())
    }
}

/// A password: 8-128 characters (the upper bound keeps PBKDF2 input small).
pub fn password(field: &str, password: &str) -> Result<(), ApiError> {
    if (8..=128).contains(&password.chars().count()) {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "the password must be 8-128 characters",
        ))
    }
}

/// Organization fields after validation (trimmed, normalized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidOrg {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
    pub time_zone: String,
}

fn digits(text: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Validate organization fields; `prefix` is the JSON path of the object in
/// the request (`org` in the wizard, empty for `PUT /v1/office/org`).
pub fn org(prefix: &str, input: &OrgProfileInput) -> Result<ValidOrg, ApiError> {
    let field = |name: &str| {
        if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}.{name}")
        }
    };
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::validation(
            &field("name"),
            "the name must be 1-200 characters",
        ));
    }
    let inn = match input.inn.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(inn) if digits(inn, 10..=10) || digits(inn, 12..=12) => Some(inn.to_owned()),
        Some(_) => {
            return Err(ApiError::validation(
                &field("inn"),
                "the INN must be 10 or 12 digits",
            ))
        }
    };
    let gln = input.gln.trim();
    if !digits(gln, 13..=13) {
        return Err(ApiError::validation(
            &field("gln"),
            "the GLN must be 13 digits",
        ));
    }
    let mut gs1_prefixes: Vec<String> = Vec::new();
    for gs1_prefix in &input.gs1_prefixes {
        let gs1_prefix = gs1_prefix.trim();
        if !digits(gs1_prefix, 4..=12) {
            return Err(ApiError::validation(
                &field("gs1Prefixes"),
                "each GS1 prefix must be 4-12 digits",
            ));
        }
        if !gs1_prefixes.iter().any(|known| known == gs1_prefix) {
            gs1_prefixes.push(gs1_prefix.to_owned());
        }
    }
    if gs1_prefixes.len() > 10 {
        return Err(ApiError::validation(
            &field("gs1Prefixes"),
            "at most 10 GS1 prefixes",
        ));
    }
    let time_zone = input.time_zone.trim();
    let time_zone_ok = (1..=64).contains(&time_zone.len())
        && time_zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'));
    if !time_zone_ok {
        return Err(ApiError::validation(
            &field("timeZone"),
            "an IANA time zone name is required",
        ));
    }
    Ok(ValidOrg {
        name: name.to_owned(),
        inn,
        gln: gln.to_owned(),
        gs1_prefixes,
        time_zone: time_zone.to_owned(),
    })
}

/// SSCC issuer prefix: the first 9 digits of the GLN, as in the cloud
/// (`deriveIssuerPrefix` in apps/api).
pub fn issuer_prefix(gln: &str) -> &str {
    &gln[..9]
}

/// How many serials fit after `prefix` in an SSCC (`buildSscc` in the domain).
pub fn serial_capacity(prefix: &str) -> u64 {
    10u64.pow(16 - prefix.len() as u32)
}

/// The first serial of an extension digit: boxes start at 1, pallets at 0.
pub fn first_serial(extension: u8) -> u64 {
    if extension == 0 {
        1
    } else {
        0
    }
}

/// A production line name: trimmed, 1-100 characters. Returns the name and
/// its uniqueness key (Unicode lower case; SQLite's `lower()` folds ASCII only).
pub fn line_name(field: &str, name: &str) -> Result<(String, String), ApiError> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 100 {
        Err(ApiError::validation(
            field,
            "the line name must be 1-100 characters",
        ))
    } else {
        Ok((trimmed.to_owned(), trimmed.to_lowercase()))
    }
}

pub fn sscc_serial(field: &str, extension: u8, prefix: &str, serial: u64) -> Result<(), ApiError> {
    let capacity = serial_capacity(prefix);
    if serial < first_serial(extension) || serial >= capacity {
        Err(ApiError::validation(
            field,
            format!(
                "the serial must be {}..{}",
                first_serial(extension),
                capacity - 1
            ),
        ))
    } else {
        Ok(())
    }
}
