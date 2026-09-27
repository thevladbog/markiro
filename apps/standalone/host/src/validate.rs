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

/// An operator's personnel number: 3-12 ASCII digits, as in the cloud
/// (`apps/api/src/modules/operators/dto.ts`). Leading zeros are part of it.
pub fn operator_login(field: &str, login: &str) -> Result<(), ApiError> {
    if (3..=12).contains(&login.len()) && login.bytes().all(|byte| byte.is_ascii_digit()) {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "the personnel number must be 3-12 digits",
        ))
    }
}

/// Optional free text: trimmed, blank is none, at most `max` characters.
fn optional_text(field: &str, text: Option<&str>, max: usize) -> Result<Option<String>, ApiError> {
    match text.map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) if text.chars().count() <= max => Ok(Some(text.to_owned())),
        Some(_) => Err(ApiError::validation(
            field,
            format!("at most {max} characters"),
        )),
    }
}

/// An operator's role: free text like the cloud's employee role (at most
/// 120 characters), or none.
pub fn operator_role(field: &str, role: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, role, 120)
}

/// A PIN verifier the office computed: a PHC string in the `@markiro/domain`
/// format with `secrets::MIN_ITERATIONS..=secrets::MAX_ITERATIONS`
/// iterations. The host never sees the PIN, so this is all it can check.
pub fn pin_phc(field: &str, phc: &str) -> Result<(), ApiError> {
    if crate::secrets::parse_phc(phc).is_some() {
        Ok(())
    } else {
        Err(ApiError::validation(
            field,
            "a PBKDF2 PHC string with 10000-1000000 iterations is required",
        ))
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

/// The JSON path of the field `name` in the object at `prefix` (empty for the
/// request's top level).
fn path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}.{name}")
    }
}

/// Company fields after validation (trimmed, normalized): the organization's
/// and a counterparty's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidCompany {
    pub name: String,
    pub inn: Option<String>,
    pub gln: String,
    pub gs1_prefixes: Vec<String>,
}

/// Validate company fields: a name of 1-200 characters, an INN of 10 or 12
/// digits or none (blank is none), a 13-digit GLN, at most 10 distinct GS1
/// prefixes of 4-12 digits. `prefix` is the JSON path of the object in the
/// request.
pub fn company(
    prefix: &str,
    name: &str,
    inn: Option<&str>,
    gln: &str,
    gs1_prefixes: &[String],
) -> Result<ValidCompany, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::validation(
            &path(prefix, "name"),
            "the name must be 1-200 characters",
        ));
    }
    let inn = match inn.map(str::trim) {
        None | Some("") => None,
        Some(inn) if digits(inn, 10..=10) || digits(inn, 12..=12) => Some(inn.to_owned()),
        Some(_) => {
            return Err(ApiError::validation(
                &path(prefix, "inn"),
                "the INN must be 10 or 12 digits",
            ))
        }
    };
    let gln = gln.trim();
    if !digits(gln, 13..=13) {
        return Err(ApiError::validation(
            &path(prefix, "gln"),
            "the GLN must be 13 digits",
        ));
    }
    let mut valid_prefixes: Vec<String> = Vec::new();
    for gs1_prefix in gs1_prefixes {
        let gs1_prefix = gs1_prefix.trim();
        if !digits(gs1_prefix, 4..=12) {
            return Err(ApiError::validation(
                &path(prefix, "gs1Prefixes"),
                "each GS1 prefix must be 4-12 digits",
            ));
        }
        if !valid_prefixes.iter().any(|known| known == gs1_prefix) {
            valid_prefixes.push(gs1_prefix.to_owned());
        }
    }
    if valid_prefixes.len() > 10 {
        return Err(ApiError::validation(
            &path(prefix, "gs1Prefixes"),
            "at most 10 GS1 prefixes",
        ));
    }
    Ok(ValidCompany {
        name: name.to_owned(),
        inn,
        gln: gln.to_owned(),
        gs1_prefixes: valid_prefixes,
    })
}

/// Validate organization fields; `prefix` is the JSON path of the object in
/// the request (`org` in the wizard, empty for `PUT /v1/office/org`).
pub fn org(prefix: &str, input: &OrgProfileInput) -> Result<ValidOrg, ApiError> {
    let company = company(
        prefix,
        &input.name,
        input.inn.as_deref(),
        &input.gln,
        &input.gs1_prefixes,
    )?;
    let time_zone = input.time_zone.trim();
    let time_zone_ok = (1..=64).contains(&time_zone.len())
        && time_zone
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'));
    if !time_zone_ok {
        return Err(ApiError::validation(
            &path(prefix, "timeZone"),
            "an IANA time zone name is required",
        ));
    }
    Ok(ValidOrg {
        name: company.name,
        inn: company.inn,
        gln: company.gln,
        gs1_prefixes: company.gs1_prefixes,
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

/// A device's own description at pairing (`local-pair` and `pairing/claim`):
/// returns the trimmed name and app version.
pub fn device_registration<'a>(
    name: &'a str,
    app_version: &'a str,
    capabilities: &[String],
) -> Result<(&'a str, &'a str), ApiError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::validation(
            "name",
            "the name must be 1-100 characters",
        ));
    }
    let app_version = app_version.trim();
    if app_version.is_empty() || app_version.len() > 50 {
        return Err(ApiError::validation(
            "appVersion",
            "the app version must be 1-50 characters",
        ));
    }
    if capabilities.len() > 32
        || capabilities
            .iter()
            .any(|capability| capability.is_empty() || capability.len() > 64)
    {
        return Err(ApiError::validation(
            "capabilities",
            "at most 32 capabilities of 1-64 characters",
        ));
    }
    Ok((name, app_version))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The `details.field` of a validation error.
    fn field<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        let error = result.expect_err("a validation error");
        assert_eq!(error.code(), "validation_failed");
        error
            .details()
            .and_then(|details| details.get("field"))
            .and_then(|field| field.as_str())
            .expect("details.field")
            .to_owned()
    }

    const GLN: &str = "4601234000017";

    #[test]
    fn company_fields_are_trimmed_and_normalized() {
        let prefixes = [
            " 4601234 ".to_owned(),
            "4601234".to_owned(),
            "4609876".to_owned(),
        ];
        assert_eq!(
            company("", " ООО «Берег» ", Some(" "), " 4601234000017 ", &prefixes).unwrap(),
            ValidCompany {
                name: "ООО «Берег»".to_owned(),
                inn: None,
                gln: GLN.to_owned(),
                gs1_prefixes: vec!["4601234".to_owned(), "4609876".to_owned()],
            }
        );
        let twelve = company("", "Берег", Some("781234567890"), GLN, &[]).unwrap();
        assert_eq!(twelve.inn.as_deref(), Some("781234567890"));
        assert_eq!(
            company("", &"я".repeat(200), None, GLN, &[])
                .unwrap()
                .name
                .chars()
                .count(),
            200
        );
    }

    #[test]
    fn company_errors_name_the_field_under_its_prefix() {
        assert_eq!(field(company("", " ", None, GLN, &[])), "name");
        assert_eq!(field(company("", &"я".repeat(201), None, GLN, &[])), "name");
        assert_eq!(
            field(company("org", "Берег", Some("12345678901"), GLN, &[])),
            "org.inn"
        );
        assert_eq!(
            field(company("", "Берег", None, "460123400001", &[])),
            "gln"
        );
        assert_eq!(
            field(company("", "Берег", None, GLN, &["460".to_owned()])),
            "gs1Prefixes"
        );
        let eleven: Vec<String> = (0..11).map(|n| format!("46012{n:02}")).collect();
        assert_eq!(
            field(company("", "Берег", None, GLN, &eleven)),
            "gs1Prefixes"
        );
    }

    #[test]
    fn a_personnel_number_is_3_to_12_ascii_digits() {
        for login in ["042", "0042", "123456789012"] {
            assert!(operator_login("login", login).is_ok(), "{login}");
        }
        for login in ["42", "1234567890123", "12a4", "٠١٢٣", " 0042", ""] {
            assert_eq!(field(operator_login("login", login)), "login", "{login:?}");
        }
    }

    #[test]
    fn a_role_is_optional_trimmed_text_of_at_most_120_characters() {
        assert_eq!(operator_role("role", None).unwrap(), None);
        assert_eq!(operator_role("role", Some("  ")).unwrap(), None);
        assert_eq!(
            operator_role("role", Some(" Упаковщик "))
                .unwrap()
                .as_deref(),
            Some("Упаковщик")
        );
        assert!(operator_role("role", Some(&"м".repeat(120))).is_ok());
        assert_eq!(field(operator_role("role", Some(&"м".repeat(121)))), "role");
    }

    #[test]
    fn a_pin_hash_is_a_domain_phc_string_within_the_iteration_bounds() {
        let phc = |iterations: u32| {
            format!("pbkdf2$sha256${iterations}$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=")
        };
        assert!(pin_phc("pinPhc", &phc(100_000)).is_ok());
        assert!(pin_phc("pinPhc", &phc(1_000_000)).is_ok());
        for bad in [phc(9_999), phc(1_000_001), "4821".to_owned(), String::new()] {
            assert_eq!(field(pin_phc("pinPhc", &bad)), "pinPhc", "{bad}");
        }
    }
}
