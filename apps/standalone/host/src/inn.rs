//! The Russian taxpayer number (ИНН) of the license check (spec 2026-10-13
//! §4.9, plan ЛЦ-1): a port of `@markiro/domain`'s `isValidInn` and
//! `normalizeInn`, held to the same answers by
//! `packages/domain/fixtures/inn-cases.json` (`tests/inn.rs`). Both values of
//! a comparison are normalized; one whose check digits fail equals nothing.

const TEN: [u32; 9] = [2, 4, 10, 3, 5, 9, 4, 6, 8];
const TWELVE_FIRST: [u32; 10] = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const TWELVE_SECOND: [u32; 11] = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

fn check_digit(digits: &[u32], weights: &[u32]) -> u32 {
    weights
        .iter()
        .zip(digits)
        .map(|(weight, digit)| weight * digit)
        .sum::<u32>()
        % 11
        % 10
}

/// Exactly 10 or 12 ASCII digits whose check digits hold; nothing trimmed.
pub fn is_valid(value: &str) -> bool {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let digits: Vec<u32> = value.bytes().map(|byte| u32::from(byte - b'0')).collect();
    match digits.len() {
        10 => check_digit(&digits, &TEN) == digits[9],
        12 => {
            check_digit(&digits, &TWELVE_FIRST) == digits[10]
                && check_digit(&digits, &TWELVE_SECOND) == digits[11]
        }
        _ => false,
    }
}

/// `value` without the whitespace JavaScript's `String.prototype.trim`
/// removes, if that is a valid INN.
pub fn normalize(value: &str) -> Option<String> {
    let trimmed = value.trim_matches(is_js_whitespace);
    is_valid(trimmed).then(|| trimmed.to_owned())
}

/// JavaScript's whitespace (WhiteSpace and LineTerminator): Unicode
/// `White_Space` without U+0085, plus U+FEFF. Rust's own `trim` differs in
/// exactly these two, and the shared fixture holds both.
fn is_js_whitespace(character: char) -> bool {
    (character.is_whitespace() && character != '\u{85}') || character == '\u{feff}'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_or_short_value_is_no_inn() {
        assert!(!is_valid(""));
        assert_eq!(normalize("   "), None);
        assert!(!is_valid("123456789"));
    }
}
