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

/// Whether `text` is 1 to `max` characters (counted as `char`s, never bytes,
/// so a Cyrillic name counts as its letters) with no control character
/// (`char::is_control`: NUL, tab, line breaks, DEL and the C1 range).
///
/// The NUL is why controls are refused: it is not whitespace, so `str::trim`
/// keeps it, but SQLite's `length()` stops at the first one. A name that
/// starts with it fails the tables' `CHECK (length(trim(name)) BETWEEN …)` as
/// a 500 instead of a validation error, and one with a NUL inside passes
/// them, so two names that look the same could both be active. The count
/// looks at `max + 1` characters at most, and the scan for control characters
/// only runs on a text that fits, so an oversized input costs no more than a
/// small one.
fn is_plain(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.chars().take(max + 1).count()) && !text.chars().any(char::is_control)
}

/// Free text after the one rule every text field shares: trimmed, then
/// [`is_plain`] of at most `max` characters. `what` names the field in the
/// diagnostic message; the error is `validation_failed` on `field`.
fn clean_text<'a>(field: &str, text: &'a str, max: usize, what: &str) -> Result<&'a str, ApiError> {
    let text = text.trim();
    if is_plain(text, max) {
        Ok(text)
    } else {
        Err(ApiError::validation(
            field,
            format!("{what} must be 1-{max} characters without control characters"),
        ))
    }
}

/// A person's display name: trimmed, 1-100 characters, no control character.
pub fn person_name(field: &str, name: &str) -> Result<String, ApiError> {
    clean_text(field, name, 100, "the name").map(str::to_owned)
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

/// Optional free text: trimmed, blank is none, otherwise at most `max`
/// characters without control characters.
fn optional_text(
    field: &str,
    text: Option<&str>,
    max: usize,
    what: &str,
) -> Result<Option<String>, ApiError> {
    match text.filter(|text| !text.trim().is_empty()) {
        None => Ok(None),
        Some(text) => clean_text(field, text, max, what).map(|text| Some(text.to_owned())),
    }
}

/// An operator's role: free text like the cloud's employee role (at most
/// 120 characters), or none.
pub fn operator_role(field: &str, role: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, role, 120, "the role")
}

/// A badge's label: free text of at most 100 characters, or none.
pub fn badge_label(field: &str, label: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, label, 100, "the label")
}

/// A badge verifier the office computed: a PHC string in the
/// `@markiro/domain` format with exactly `secrets::BADGE_ITERATIONS` and the
/// site's badge salt, as the cloud hashes badges. One badge code then always
/// gives one string, so the partial unique index keeps it on one operator;
/// another count or salt would let a copy of the badge through.
pub fn badge_phc(field: &str, phc: &str, site_salt: &[u8]) -> Result<(), ApiError> {
    match crate::secrets::parse_phc(phc) {
        Some(parsed)
            if parsed.iterations == crate::secrets::BADGE_ITERATIONS
                && parsed.salt() == site_salt =>
        {
            Ok(())
        }
        _ => Err(ApiError::validation(
            field,
            format!(
                "a PBKDF2 PHC string with {} iterations and the site's badge salt is required",
                crate::secrets::BADGE_ITERATIONS
            ),
        )),
    }
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
            format!(
                "a PBKDF2 PHC string with {}-{} iterations is required",
                crate::secrets::MIN_ITERATIONS,
                crate::secrets::MAX_ITERATIONS
            ),
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

/// How many distinct GS1 prefixes a company may have.
const MAX_GS1_PREFIXES: usize = 10;

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
    let name = clean_text(&path(prefix, "name"), name, 200, "the name")?;
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
            // The 11th distinct prefix ends it: the list never grows past the
            // cap, so a huge request costs no more than a small one.
            if valid_prefixes.len() == MAX_GS1_PREFIXES {
                return Err(ApiError::validation(
                    &path(prefix, "gs1Prefixes"),
                    format!("at most {MAX_GS1_PREFIXES} GS1 prefixes"),
                ));
            }
            valid_prefixes.push(gs1_prefix.to_owned());
        }
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
    let name = device_name("name", name)?;
    let app_version = clean_text("appVersion", app_version, 50, "the app version")?;
    // A capability is an identifier stored as sent, so it is checked as it
    // stands, not trimmed: nothing the rule refuses can be stored through it.
    if capabilities.len() > 32
        || !capabilities
            .iter()
            .all(|capability| is_plain(capability.as_str(), 64) && !capability.trim().is_empty())
    {
        return Err(ApiError::validation(
            "capabilities",
            "at most 32 capabilities of 1-64 characters without control characters",
        ));
    }
    Ok((name, app_version))
}

/// A device's name: trimmed, 1-100 characters, no control character.
pub fn device_name<'a>(field: &str, name: &'a str) -> Result<&'a str, ApiError> {
    clean_text(field, name, 100, "the name")
}

/// A production line name: trimmed, 1-100 characters, no control character.
/// Returns the name and its uniqueness key (Unicode lower case; SQLite's
/// `lower()` folds ASCII only).
pub fn line_name(field: &str, name: &str) -> Result<(String, String), ApiError> {
    let trimmed = clean_text(field, name, 100, "the line name")?;
    Ok((trimmed.to_owned(), trimmed.to_lowercase()))
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

/// A GTIN-14 the office normalized with `normalizeToGtin14`: trimmed,
/// exactly 14 ASCII digits. The check digit and the GS1 prefix are the UI's
/// rules (`@markiro/domain`); the host checks the shape only.
pub fn gtin14(field: &str, gtin14: &str) -> Result<String, ApiError> {
    let gtin14 = gtin14.trim();
    if digits(gtin14, 14..=14) {
        Ok(gtin14.to_owned())
    } else {
        Err(ApiError::validation(field, "the GTIN must be 14 digits"))
    }
}

/// A product's name: trimmed, 1-200 characters, as the cloud's.
pub fn product_name(field: &str, name: &str) -> Result<String, ApiError> {
    clean_text(field, name, 200, "the name").map(str::to_owned)
}

/// A product's short print name (the cloud's `printName`): free text of at
/// most 200 characters, or none.
pub fn print_name(field: &str, name: Option<&str>) -> Result<Option<String>, ApiError> {
    optional_text(field, name, 200, "the print name")
}

/// The most units a box holds. The cloud bounds none; this cap only keeps a
/// typing slip out of production.
pub const MAX_BOX_CAPACITY: u32 = 100_000;
/// The most boxes a pallet holds, for the same reason.
pub const MAX_PALLET_BOX_CAPACITY: u32 = 10_000;
/// The longest shelf life in days, the cloud's `shelfLifeDays` bound.
pub const MAX_SHELF_LIFE_DAYS: u32 = 3_650;

/// An optional count: none, or 1 to `max`.
pub fn count(field: &str, value: Option<u32>, max: u32) -> Result<(), ApiError> {
    match value {
        Some(value) if !(1..=max).contains(&value) => {
            Err(ApiError::validation(field, format!("1-{max}, or none")))
        }
        _ => Ok(()),
    }
}

/// The largest plan of a shift. The cloud bounds none (`min(1)`); this cap
/// only keeps a typing slip out of production.
pub const MAX_PLANNED_QTY: u32 = 10_000_000;

/// A civil date `YYYY-MM-DD` of the years 1-9999 (`shifts::civil_date`),
/// not trimmed: a date is no free text, and the office sends what its date
/// field holds.
pub fn civil_date(field: &str, text: &str) -> Result<time::Date, ApiError> {
    crate::shifts::civil_date(text)
        .ok_or_else(|| ApiError::validation(field, "a real calendar date YYYY-MM-DD is required"))
}

/// An identifier the client makes up (a station's request id): a UUID in
/// its canonical form, lower-case and hyphenated, as `crypto.randomUUID()`
/// writes it, so one id never has two spellings.
pub fn client_uuid(field: &str, text: &str) -> Result<(), ApiError> {
    match uuid::Uuid::try_parse(text) {
        Ok(parsed) if parsed.hyphenated().to_string() == text => Ok(()),
        _ => Err(ApiError::validation(
            field,
            "a lower-case hyphenated UUID is required",
        )),
    }
}

/// A label template's name: trimmed, 1-200 characters, as the cloud's.
pub fn template_name(field: &str, name: &str) -> Result<String, ApiError> {
    clean_text(field, name, 200, "the name").map(str::to_owned)
}

/// The largest layout the host keeps: 256 KB of compact JSON.
pub const MAX_SPEC_BYTES: usize = 256 * 1024;

/// The deepest layout the host keeps: 64 levels, where an object or an array
/// is a level and a scalar none (`{"a": 1}` is one level deep, `{"a": [{}]}`
/// three). A feed page wraps a layout in four more levels (the page object,
/// `items`, the item, `data`), and the station shell parses every host answer
/// with `serde_json`, which stops at 127: a layout 124 levels deep would be
/// stored and served by `GET …/{id}`, but the page that carries it would not
/// parse, and no later change would reach any station. A real layout nests a
/// handful of levels, so the bound only keeps a broken client out; it stays
/// well under the 123 a page leaves.
pub const MAX_SPEC_DEPTH: usize = 64;

/// Whether `value` nests more than `levels` levels deep (see
/// [`MAX_SPEC_DEPTH`]). It descends at most `levels + 1` levels into any
/// value, so no input makes it recurse deeply.
fn nests_deeper_than(value: &serde_json::Value, levels: usize) -> bool {
    use serde_json::Value;
    match value {
        Value::Array(items) => {
            levels == 0 || items.iter().any(|item| nests_deeper_than(item, levels - 1))
        }
        Value::Object(fields) => {
            levels == 0
                || fields
                    .values()
                    .any(|field| nests_deeper_than(field, levels - 1))
        }
        _ => false,
    }
}

/// A template's layout: a JSON object of at most [`MAX_SPEC_BYTES`] once
/// written compactly, which is how the host stores it (object keys in byte
/// order), and at most [`MAX_SPEC_DEPTH`] levels deep. Returns that text.
/// Whether it is a label is the UI's check (`labelTemplateSpecSchema`).
pub fn template_spec(field: &str, spec: &serde_json::Value) -> Result<String, ApiError> {
    if !spec.is_object() {
        return Err(ApiError::validation(
            field,
            "the spec must be a JSON object",
        ));
    }
    if nests_deeper_than(spec, MAX_SPEC_DEPTH) {
        return Err(ApiError::validation(
            field,
            format!("the spec must be at most {MAX_SPEC_DEPTH} levels deep"),
        ));
    }
    let text = serde_json::to_string(spec).map_err(ApiError::internal)?;
    if text.len() > MAX_SPEC_BYTES {
        return Err(ApiError::validation(
            field,
            format!("the spec must be at most {MAX_SPEC_BYTES} bytes"),
        ));
    }
    Ok(text)
}

/// The most codes a template lists: more than there are product groups, so
/// the bound only caps the work one request can ask for.
pub const MAX_CATEGORY_CODES: usize = 100;

/// A template's categories: `None` for every category, or a non-empty list
/// of at most [`MAX_CATEGORY_CODES`] codes without repeats. That each code is
/// a product group is checked against the table (`templates::check_groups`).
pub fn category_codes(field: &str, codes: Option<&[u32]>) -> Result<(), ApiError> {
    let Some(codes) = codes else {
        return Ok(());
    };
    if codes.is_empty() || codes.len() > MAX_CATEGORY_CODES {
        return Err(ApiError::validation(
            field,
            format!("1-{MAX_CATEGORY_CODES} product-group codes, or null for every category"),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    if !codes.iter().all(|code| seen.insert(code)) {
        return Err(ApiError::validation(
            field,
            "a product-group code is repeated",
        ));
    }
    Ok(())
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
    fn an_office_login_is_3_to_64_latin_letters_digits_dots_underscores_or_hyphens() {
        let longest = "a".repeat(64);
        for login in ["adm", "i.smirnova", "tech_1", "a-b", longest.as_str()] {
            assert!(office_login("login", login).is_ok(), "{login}");
        }
        let too_long = "a".repeat(65);
        for login in ["ad", too_long.as_str(), "ирина", "a b", "a@b"] {
            assert_eq!(field(office_login("login", login)), "login", "{login}");
        }
    }

    #[test]
    fn a_person_name_is_trimmed_to_1_to_100_characters() {
        assert_eq!(person_name("name", " Ирина ").unwrap(), "Ирина");
        assert!(person_name("name", &"и".repeat(100)).is_ok());
        assert_eq!(field(person_name("name", "  ")), "name");
        assert_eq!(field(person_name("name", &"и".repeat(101))), "name");
    }

    #[test]
    fn a_password_is_8_to_128_characters() {
        assert!(password("password", "12345678").is_ok());
        assert!(password("password", &"п".repeat(128)).is_ok());
        assert_eq!(field(password("password", "1234567")), "password");
        assert_eq!(field(password("password", &"п".repeat(129))), "password");
    }

    #[test]
    fn the_organization_adds_a_time_zone_to_the_company_fields() {
        let input = |time_zone: &str| OrgProfileInput {
            name: "ООО «Атолл»".to_owned(),
            inn: None,
            gln: GLN.to_owned(),
            gs1_prefixes: vec![],
            time_zone: time_zone.to_owned(),
        };
        assert_eq!(
            org("org", &input(" Europe/Moscow ")).unwrap().time_zone,
            "Europe/Moscow"
        );
        assert!(org("", &input("Etc/GMT+3")).is_ok());
        assert_eq!(field(org("org", &input(""))), "org.timeZone");
        assert_eq!(field(org("", &input("Europe Moscow"))), "timeZone");
        assert_eq!(field(org("org", &input_named(""))), "org.name");
    }

    fn input_named(name: &str) -> OrgProfileInput {
        OrgProfileInput {
            name: name.to_owned(),
            inn: None,
            gln: GLN.to_owned(),
            gs1_prefixes: vec![],
            time_zone: "Europe/Moscow".to_owned(),
        }
    }

    #[test]
    fn a_line_name_comes_with_its_unicode_lower_case_key() {
        assert_eq!(
            line_name("lines.0", " Линия 1 ").unwrap(),
            ("Линия 1".to_owned(), "линия 1".to_owned())
        );
        assert_eq!(field(line_name("lines.0", " ")), "lines.0");
        assert_eq!(field(line_name("name", &"л".repeat(101))), "name");
    }

    #[test]
    fn an_sscc_serial_lies_between_the_first_serial_and_the_capacity() {
        assert_eq!(issuer_prefix(GLN), "460123400");
        assert_eq!(serial_capacity("460123400"), 10_000_000);
        assert_eq!((first_serial(0), first_serial(1)), (1, 0));
        assert!(sscc_serial("sscc.boxNextSerial", 0, "460123400", 1).is_ok());
        assert!(sscc_serial("sscc.palletNextSerial", 1, "460123400", 0).is_ok());
        assert!(sscc_serial("nextSerial", 0, "460123400", 9_999_999).is_ok());
        assert_eq!(
            field(sscc_serial("sscc.boxNextSerial", 0, "460123400", 0)),
            "sscc.boxNextSerial"
        );
        assert_eq!(
            field(sscc_serial("nextSerial", 1, "460123400", 10_000_000)),
            "nextSerial"
        );
    }

    #[test]
    fn a_device_registration_checks_its_version_and_capabilities() {
        assert_eq!(
            device_registration(" Станция ", " 0.1.0 ", &["scanner".to_owned()]).unwrap(),
            ("Станция", "0.1.0")
        );
        assert_eq!(
            field(device_registration("Станция", " ", &[])),
            "appVersion"
        );
        assert_eq!(
            field(device_registration("Станция", &"1".repeat(51), &[])),
            "appVersion"
        );
        assert_eq!(
            field(device_registration("Станция", "0.1.0", &[String::new()])),
            "capabilities"
        );
        let many: Vec<String> = (0..33).map(|n| format!("c{n}")).collect();
        assert_eq!(
            field(device_registration("Станция", "0.1.0", &many)),
            "capabilities"
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
    fn a_badge_hash_carries_the_site_salt_and_exactly_the_domain_iterations() {
        let salt: Vec<u8> = (0..16).collect();
        let phc = |iterations: u32, salt: &str| {
            format!(
                "pbkdf2$sha256${iterations}${salt}$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0="
            )
        };
        assert!(badge_phc("badgePhc", &phc(100_000, "AAECAwQFBgcICQoLDA0ODw=="), &salt).is_ok());
        for bad in [
            phc(200_000, "AAECAwQFBgcICQoLDA0ODw=="),
            phc(10_000, "AAECAwQFBgcICQoLDA0ODw=="),
            phc(100_000, "bWFya2lyby1waW4tc2FsdA=="),
            "MRK-000742".to_owned(),
        ] {
            assert_eq!(
                field(badge_phc("badgePhc", &bad, &salt)),
                "badgePhc",
                "{bad}"
            );
        }
    }

    #[test]
    fn a_zero_padded_iteration_count_is_a_second_spelling_and_is_refused() {
        // A station reads `0100000` as 100 000, but the unique index over a
        // badge's text tells it from `100000` and would keep both copies.
        let salt: Vec<u8> = (0..16).collect();
        let canonical = "pbkdf2$sha256$100000$AAECAwQFBgcICQoLDA0ODw==$LEcu0ewwRD5rBHrpCjvxni/q2cURiavbRlNRgDPb+n0=";
        assert!(badge_phc("badgePhc", canonical, &salt).is_ok());
        for count in ["0100000", "000000100000"] {
            let padded = canonical.replacen("$100000$", &format!("${count}$"), 1);
            assert_ne!(padded, canonical);
            assert_eq!(
                field(badge_phc("badgePhc", &padded, &salt)),
                "badgePhc",
                "{count}"
            );
        }
    }

    #[test]
    fn a_device_name_is_trimmed_to_1_to_100_characters() {
        assert_eq!(device_name("name", " Станция 2 ").unwrap(), "Станция 2");
        assert!(device_name("name", &"с".repeat(100)).is_ok());
        assert_eq!(field(device_name("name", " ")), "name");
        assert_eq!(field(device_name("name", &"с".repeat(101))), "name");
        assert_eq!(field(device_registration(" ", "0.1.0", &[])), "name");
    }

    #[test]
    fn a_badge_label_is_optional_text_of_at_most_100_characters() {
        assert_eq!(badge_label("label", Some(" ")).unwrap(), None);
        assert!(badge_label("label", Some(&"п".repeat(100))).is_ok());
        assert_eq!(field(badge_label("label", Some(&"п".repeat(101)))), "label");
    }

    type TextCheck = fn(&str) -> Result<(), ApiError>;

    /// The free-text validators that trim their input, each with the
    /// `details.field` it names.
    fn text_validators() -> [(&'static str, TextCheck); 11] {
        [
            ("name", |text| person_name("name", text).map(drop)),
            ("name", |text| product_name("name", text).map(drop)),
            ("name", |text| template_name("name", text).map(drop)),
            ("printName", |text| {
                print_name("printName", Some(text)).map(drop)
            }),
            ("org.name", |text| {
                company("org", text, None, GLN, &[]).map(drop)
            }),
            ("lines.0", |text| line_name("lines.0", text).map(drop)),
            ("name", |text| device_name("name", text).map(drop)),
            ("name", |text| {
                device_registration(text, "0.1.0", &[]).map(drop)
            }),
            ("appVersion", |text| {
                device_registration("Станция", text, &[]).map(drop)
            }),
            ("role", |text| operator_role("role", Some(text)).map(drop)),
            ("label", |text| badge_label("label", Some(text)).map(drop)),
        ]
    }

    /// One rule for every free-text field: no control character, wherever it
    /// stands. A NUL first passes `str::trim` but SQLite's `length()` stops at
    /// it, so the tables' CHECKs failed as a 500; a NUL inside passed them, so
    /// two names that look the same could both be stored.
    #[test]
    fn every_free_text_field_refuses_a_control_character_wherever_it_stands() {
        for (expected, check) in text_validators() {
            for text in [
                "\u{0}Иванов",
                "Ива\u{0}нов",
                "Иванов\u{0}",
                "Ива\tнов",
                "Иван\nов",
                "Ива\u{7f}нов",
                "Ива\u{85}нов",
            ] {
                assert_eq!(field(check(text)), expected, "{text:?}");
            }
        }
    }

    #[test]
    fn every_free_text_field_still_accepts_ordinary_text() {
        for (expected, check) in text_validators() {
            for text in [
                "Иванов Иван",
                "Ирина-Мария О'Нил",
                "  Иванов  ",
                // Whitespace at the edges, control characters among it, is
                // trimmed before the rule looks at the text.
                "\tИванов\n",
                "\u{85}Иванов",
                // A no-break space is text, not a control character.
                "Иван\u{a0}Иванов",
            ] {
                assert!(check(text).is_ok(), "{expected} {text:?}");
            }
        }
    }

    /// A capability is an identifier stored as sent, so the rule checks it as
    /// it stands: nothing the rule refuses can be stored through it.
    #[test]
    fn a_capability_is_checked_as_sent_without_control_characters() {
        let capability =
            |text: &str| device_registration("Станция", "0.1.0", &[text.to_owned()]).map(drop);
        for text in ["scanner", "validation-dm-duplicate-v1", "сканер", " x "] {
            assert!(capability(text).is_ok(), "{text:?}");
        }
        for text in [
            "",
            "\u{0}scanner",
            "scan\u{0}ner",
            "scanner\u{0}",
            "scan\tner",
            "scanner\n",
            "scan\u{7f}ner",
            "scan\u{85}ner",
            "   ",
        ] {
            assert_eq!(field(capability(text)), "capabilities", "{text:?}");
        }
    }

    #[test]
    fn a_line_name_is_at_most_100_characters_not_bytes() {
        // 100 Cyrillic letters are 200 bytes: the limit counts characters, and
        // after trimming.
        let longest = "л".repeat(100);
        assert_eq!(line_name("name", &longest).unwrap().0, longest);
        assert_eq!(
            line_name("name", &format!("  {longest} ")).unwrap().1,
            longest
        );
        assert_eq!(field(line_name("name", &"л".repeat(101))), "name");
        assert_eq!(
            field(line_name("name", &format!(" {} ", "л".repeat(101)))),
            "name"
        );
    }

    #[test]
    fn a_device_registration_counts_characters_and_pins_every_limit() {
        // 50 Cyrillic letters are 100 bytes.
        let version = |text: &str| device_registration("Станция", text, &[]).map(drop);
        assert!(version(&"в".repeat(50)).is_ok());
        assert_eq!(field(version(&"в".repeat(51))), "appVersion");
        let capabilities = |count: usize| {
            let list: Vec<String> = (0..count).map(|n| format!("c{n}")).collect();
            device_registration("Станция", "0.1.0", &list).map(drop)
        };
        assert!(capabilities(0).is_ok());
        assert!(capabilities(32).is_ok());
        assert_eq!(field(capabilities(33)), "capabilities");
        let capability =
            |text: &str| device_registration("Станция", "0.1.0", &[text.to_owned()]).map(drop);
        assert!(capability(&"я".repeat(64)).is_ok());
        assert_eq!(field(capability(&"я".repeat(65))), "capabilities");
    }

    #[test]
    fn a_time_zone_is_an_iana_name_of_at_most_64_characters() {
        let zone = |text: &str| {
            org(
                "org",
                &OrgProfileInput {
                    time_zone: text.to_owned(),
                    ..input_named("ООО «Атолл»")
                },
            )
            .map(|org| org.time_zone)
        };
        for text in [
            "Asia/Ust-Nera",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+3",
            &"A".repeat(64),
        ] {
            assert_eq!(zone(text).unwrap(), text);
        }
        assert_eq!(field(zone(&"A".repeat(65))), "org.timeZone");
        assert_eq!(field(zone("Europe/Мск")), "org.timeZone");
    }

    #[test]
    fn a_person_name_is_measured_after_trimming_and_unicode_whitespace_is_trimmed() {
        let longest = "и".repeat(100);
        assert_eq!(
            person_name("name", &format!("  {longest}  ")).unwrap(),
            longest
        );
        assert_eq!(
            field(person_name("name", &format!("  {}  ", "и".repeat(101)))),
            "name"
        );
        // No-break space, em space and ideographic space are whitespace.
        assert_eq!(
            person_name("name", "\u{a0}\u{2003}Ирина\u{3000}").unwrap(),
            "Ирина"
        );
        assert_eq!(field(person_name("name", "\u{a0}\u{3000}")), "name");
    }

    /// Pins today's rule: an office login is checked for its letters, not
    /// their case; the column's NOCASE collation makes «Admin» and «admin» one
    /// login.
    #[test]
    fn an_office_login_may_have_upper_case_letters() {
        assert!(office_login("login", "Admin.User").is_ok());
        assert!(office_login("login", "TECH_1").is_ok());
    }

    /// More than 10 distinct prefixes are refused at the 11th, not after a
    /// pass that compares every prefix with every other.
    #[test]
    fn a_huge_prefix_list_is_refused_at_the_eleventh_distinct_prefix() {
        let many: Vec<String> = (0..50_000).map(|n| format!("{n:07}")).collect();
        let started = std::time::Instant::now();
        let refusal = company("", "Берег", None, GLN, &many).unwrap_err();
        assert_eq!(refusal.code(), "validation_failed");
        assert_eq!(refusal.details().unwrap()["field"], "gs1Prefixes");
        assert_eq!(refusal.message(), "at most 10 GS1 prefixes");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "the refusal took {:?}",
            started.elapsed()
        );
        // Ten distinct prefixes, each sent many times, stay fine.
        let repeated: Vec<String> = (0..50_000).map(|n| format!("{:07}", n % 10)).collect();
        assert_eq!(
            company("", "Берег", None, GLN, &repeated)
                .unwrap()
                .gs1_prefixes
                .len(),
            10
        );
    }

    /// The bounds in the messages are the constants', so a raised ceiling or
    /// a changed badge count cannot leave a stale number behind.
    #[test]
    fn the_iteration_messages_are_built_from_the_constants() {
        let pin = pin_phc("pinPhc", "x").unwrap_err();
        assert!(
            pin.message().contains(&format!(
                "{}-{} iterations",
                crate::secrets::MIN_ITERATIONS,
                crate::secrets::MAX_ITERATIONS
            )),
            "{}",
            pin.message()
        );
        let badge = badge_phc("badgePhc", "x", &[]).unwrap_err();
        assert!(
            badge
                .message()
                .contains(&format!("{} iterations", crate::secrets::BADGE_ITERATIONS)),
            "{}",
            badge.message()
        );
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

    #[test]
    fn a_gtin14_is_fourteen_ascii_digits_and_nothing_else() {
        assert_eq!(
            gtin14("gtin14", " 04600682000013 ").unwrap(),
            "04600682000013"
        );
        for bad in [
            "4600682000013",
            "046006820000131",
            "0460068200001X",
            "٠٤٦٠٠٦٨٢٠٠٠٠١٣",
            "",
        ] {
            assert_eq!(field(gtin14("gtin14", bad)), "gtin14", "{bad:?}");
        }
    }

    #[test]
    fn product_names_count_characters_and_a_print_name_may_be_blank() {
        assert!(product_name("name", &"м".repeat(200)).is_ok());
        assert_eq!(field(product_name("name", &"м".repeat(201))), "name");
        assert_eq!(field(product_name("name", " ")), "name");
        assert_eq!(print_name("printName", Some("  ")).unwrap(), None);
        assert_eq!(print_name("printName", None).unwrap(), None);
        assert_eq!(
            print_name("printName", Some(" Молоко "))
                .unwrap()
                .as_deref(),
            Some("Молоко")
        );
        assert_eq!(
            field(print_name("printName", Some(&"м".repeat(201)))),
            "printName"
        );
    }

    #[test]
    fn a_count_is_none_or_one_to_its_bound() {
        assert!(count("boxCapacity", None, MAX_BOX_CAPACITY).is_ok());
        assert!(count("boxCapacity", Some(1), MAX_BOX_CAPACITY).is_ok());
        assert!(count("boxCapacity", Some(MAX_BOX_CAPACITY), MAX_BOX_CAPACITY).is_ok());
        assert_eq!(
            field(count("boxCapacity", Some(0), MAX_BOX_CAPACITY)),
            "boxCapacity"
        );
        assert_eq!(
            field(count(
                "shelfLifeDays",
                Some(MAX_SHELF_LIFE_DAYS + 1),
                MAX_SHELF_LIFE_DAYS
            )),
            "shelfLifeDays"
        );
    }

    #[test]
    fn a_spec_is_an_object_of_at_most_256_kb_once_written_compactly() {
        let spec = serde_json::json!({ "widthMm": 58, "dpi": 203 });
        // Stored compactly, its keys in byte order.
        assert_eq!(
            template_spec("spec", &spec).unwrap(),
            r#"{"dpi":203,"widthMm":58}"#
        );
        let filler = |bytes: usize| serde_json::json!({ "f": "x".repeat(bytes - 8) });
        assert_eq!(
            template_spec("spec", &filler(MAX_SPEC_BYTES))
                .unwrap()
                .len(),
            MAX_SPEC_BYTES
        );
        assert_eq!(
            field(template_spec("spec", &filler(MAX_SPEC_BYTES + 1))),
            "spec"
        );
        for not_an_object in [
            serde_json::json!([]),
            serde_json::json!("{}"),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                field(template_spec("spec", &not_an_object)),
                "spec",
                "{not_an_object}"
            );
        }
    }

    #[test]
    fn category_codes_are_every_category_or_a_short_list_without_repeats() {
        assert!(category_codes("codes", None).is_ok());
        assert!(category_codes("codes", Some(&[8, 15])).is_ok());
        let longest: Vec<u32> = (1..=100).collect();
        assert!(category_codes("codes", Some(&longest)).is_ok());
        let too_long: Vec<u32> = (1..=101).collect();
        for bad in [&[][..], &[8, 15, 8][..], &too_long[..]] {
            assert_eq!(
                field(category_codes("codes", Some(bad))),
                "codes",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_template_name_counts_characters_not_bytes_and_is_trimmed() {
        // 200 Cyrillic letters are 400 bytes: the limit counts characters, and
        // after trimming.
        let longest = "ш".repeat(200);
        assert_eq!(
            template_name("name", &format!("  {longest} ")).unwrap(),
            longest
        );
        assert_eq!(field(template_name("name", &"ш".repeat(201))), "name");
        assert_eq!(field(template_name("name", " ")), "name");
        // The error names the field the caller gives, as the wizard's
        // `templates.0.name` will.
        assert_eq!(
            field(template_name("templates.0.name", "")),
            "templates.0.name"
        );
    }

    /// `levels` objects nested one in another, the innermost empty.
    fn nested_objects(levels: usize) -> serde_json::Value {
        let mut spec = serde_json::json!({});
        for _ in 1..levels {
            spec = serde_json::json!({ "a": spec });
        }
        spec
    }

    /// An object around `levels - 1` arrays nested one in another, the
    /// innermost empty: `levels` levels in all.
    fn nested_arrays(levels: usize) -> serde_json::Value {
        let mut spec = serde_json::json!([]);
        for _ in 2..levels {
            spec = serde_json::json!([spec]);
        }
        serde_json::json!({ "a": spec })
    }

    /// Objects and arrays one in another, an object outermost and the
    /// innermost empty: `levels` levels in all.
    fn nested_alternately(levels: usize) -> serde_json::Value {
        let mut spec = serde_json::json!({});
        for level in 2..levels {
            spec = if level % 2 == 0 {
                serde_json::json!([spec])
            } else {
                serde_json::json!({ "a": spec })
            };
        }
        serde_json::json!({ "a": spec })
    }

    /// `levels` objects nested one in another around a scalar: the scalar is
    /// no level of its own.
    fn nested_around_a_scalar(levels: usize) -> serde_json::Value {
        let mut spec = serde_json::json!({ "a": 1 });
        for _ in 1..levels {
            spec = serde_json::json!({ "a": spec });
        }
        spec
    }

    /// An object or an array is a level, a scalar none: 64 levels are kept and
    /// 65 refused however they nest. (Literals, not `MAX_SPEC_DEPTH`, so that
    /// the test pins the bound itself.)
    #[test]
    fn a_spec_is_at_most_64_levels_deep_whichever_way_it_nests() {
        let builders: [(&str, fn(usize) -> serde_json::Value); 4] = [
            ("objects", nested_objects),
            ("an object around arrays", nested_arrays),
            ("objects and arrays", nested_alternately),
            ("objects around a scalar", nested_around_a_scalar),
        ];
        for (kind, nested) in builders {
            assert!(
                template_spec("spec", &nested(64)).is_ok(),
                "{kind}: 64 levels"
            );
            assert_eq!(
                field(template_spec("spec", &nested(65))),
                "spec",
                "{kind}: 65 levels"
            );
        }
        // The first levels and the flat cases.
        for spec in [
            serde_json::json!({}),
            serde_json::json!({ "a": 1 }),
            serde_json::json!({ "a": [1, 2, { "b": null }] }),
            nested_objects(2),
        ] {
            assert!(template_spec("spec", &spec).is_ok(), "{spec}");
        }
    }

    /// An object of `levels` levels in all whose one deep branch is an object
    /// chain (`levels - 1` levels, the innermost empty) beside a scalar, which
    /// is no level. The keys fix the order the object keeps them in, so the
    /// deep branch comes first or last.
    fn deep_object_beside_a_scalar(levels: usize, deep_first: bool) -> serde_json::Value {
        let deep = nested_objects(levels - 1);
        if deep_first {
            serde_json::json!({ "a": deep, "b": 1 })
        } else {
            serde_json::json!({ "a": 1, "b": deep })
        }
    }

    /// An object around an array of `levels` levels in all: the array holds
    /// a deep object chain (`levels - 2` levels, the innermost empty) and a
    /// scalar, in the given order.
    fn deep_array_beside_a_scalar(levels: usize, deep_first: bool) -> serde_json::Value {
        let deep = nested_objects(levels - 2);
        let items = if deep_first {
            serde_json::json!([deep, 1])
        } else {
            serde_json::json!([1, deep])
        };
        serde_json::json!({ "a": items })
    }

    /// The depth of a layout is that of its DEEPEST branch, whatever stands
    /// beside it: a real layout has shallow keys (`widthMm`, `language`)
    /// around the `elements` that nest, and an array holds shallow items
    /// next to deep ones. Both orders, so that a measure that follows only the
    /// first child, or only the last, or the shallowest, fails too. (The
    /// single-chain cases above cannot tell any of them from the right one.)
    #[test]
    fn the_deepest_branch_sets_the_depth_whatever_stands_beside_it() {
        let builders: [(&str, fn(usize, bool) -> serde_json::Value); 2] = [
            ("an object", deep_object_beside_a_scalar),
            ("an array", deep_array_beside_a_scalar),
        ];
        for (kind, build) in builders {
            for deep_first in [true, false] {
                let order = if deep_first {
                    "deep first"
                } else {
                    "deep last"
                };
                assert!(
                    template_spec("spec", &build(64, deep_first)).is_ok(),
                    "{kind}, {order}: 64 levels"
                );
                assert_eq!(
                    field(template_spec("spec", &build(65, deep_first))),
                    "spec",
                    "{kind}, {order}: 65 levels"
                );
            }
        }
    }

    /// Depth is not size: a deep layout is refused however small, a flat one
    /// kept up to the size bound.
    #[test]
    fn a_deep_spec_is_refused_however_small_and_a_flat_one_kept_however_large() {
        let deep = nested_objects(65);
        let text = serde_json::to_string(&deep).unwrap();
        assert!(text.len() < 1_000, "{} bytes", text.len());
        assert_eq!(field(template_spec("spec", &deep)), "spec");
        // Two levels and some 260 KB: 130 000 numbers in one array.
        let flat = serde_json::json!({ "elements": vec![1; 130_000] });
        let kept = template_spec("spec", &flat).unwrap();
        assert!(
            (250_000..=MAX_SPEC_BYTES).contains(&kept.len()),
            "{} bytes",
            kept.len()
        );
    }

    #[test]
    fn the_depth_refusal_names_the_bound() {
        let refused = template_spec("spec", &nested_objects(65)).unwrap_err();
        assert!(refused.message().contains("64"), "{}", refused.message());
    }

    /// A feed page wraps a layout in four levels (the page object, `items`,
    /// the item, `data`), and serde_json, which the station shell parses every
    /// host answer with, stops at 127: 123 levels of layout travel in a page
    /// and 124 do not. The bound stays well under that.
    #[test]
    fn a_layout_at_the_bound_fits_a_feed_page_the_station_can_parse() {
        let page = |layout: serde_json::Value| {
            serde_json::json!({ "items": [{ "data": { "spec": layout } }] }).to_string()
        };
        let parses = |layout: serde_json::Value| {
            serde_json::from_str::<serde_json::Value>(&page(layout)).is_ok()
        };
        assert!(parses(nested_objects(123)));
        assert!(!parses(nested_objects(124)));
        assert!(parses(nested_objects(MAX_SPEC_DEPTH)));
        assert!(MAX_SPEC_DEPTH <= 123);
    }
}
