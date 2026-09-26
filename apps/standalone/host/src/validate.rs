//! Input rules the host enforces itself. Marking rules (GTIN, KM, labels)
//! stay in `@markiro/domain`; these are structural checks of host data.

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
