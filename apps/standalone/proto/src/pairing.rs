//! The pairing-code format shared by the host and devices (spec §4.7):
//! devices check a code's shape before sending it.

/// Crockford base32: no I, L, O or U, so a code read aloud or typed from a
/// screen cannot be confused.
pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LENGTH: usize = 10;

/// The canonical form of a typed or scanned code: upper case, with every
/// separator removed (anything `char::is_whitespace`, the ASCII hyphen, and
/// the Unicode dashes U+2010..=U+2015 and U+2212), and Crockford's aliases (O
/// reads as 0, I and L as 1). `None` when the input cannot be a code at all.
pub fn normalize(input: &str) -> Option<String> {
    let mut code = String::with_capacity(CODE_LENGTH);
    for symbol in input.chars() {
        if symbol.is_whitespace() || is_separator_dash(symbol) {
            continue;
        }
        let symbol = match symbol.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => match u8::try_from(other) {
                Ok(byte) if ALPHABET.contains(&byte) => other,
                _ => return None,
            },
        };
        code.push(symbol);
        if code.len() > CODE_LENGTH {
            return None;
        }
    }
    (code.len() == CODE_LENGTH).then_some(code)
}

/// A dash-like separator beyond the ASCII hyphen: the Unicode dashes
/// U+2010..=U+2015 (hyphen through horizontal bar) and U+2212 (minus sign),
/// either of which a pasted code can carry instead of a plain hyphen.
fn is_separator_dash(symbol: char) -> bool {
    matches!(symbol, '-' | '\u{2010}'..='\u{2015}' | '\u{2212}')
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn a_typed_code_is_normalized_like_crockford_decoding() {
        assert_eq!(normalize("7K3MQ9XV2D").as_deref(), Some("7K3MQ9XV2D"));
        assert_eq!(normalize(" 7k3mq-9xv2d ").as_deref(), Some("7K3MQ9XV2D"));
        // O is read as zero, I and L as one.
        assert_eq!(normalize("OIL0000000").as_deref(), Some("0110000000"));
        assert_eq!(normalize("7K3MQ9XV2U"), None, "U is not a Crockford symbol");
        assert_eq!(normalize("7K3MQ9XV2"), None, "too short");
        assert_eq!(normalize("7K3MQ9XV2DD"), None, "too long");
        assert_eq!(normalize("7K3MQ9XV2Ж"), None);
        assert_eq!(normalize(""), None);
    }

    #[test]
    fn normalize_strips_whitespace_and_unicode_dash_separators() {
        // A tab and an en dash (U+2013).
        assert_eq!(
            normalize("7K3M\tQ9XV\u{2013}2D").as_deref(),
            Some("7K3MQ9XV2D")
        );
        // A non-breaking space (U+00A0) and a minus sign (U+2212).
        assert_eq!(
            normalize("7K3M\u{00A0}Q9XV\u{2212}2D").as_deref(),
            Some("7K3MQ9XV2D")
        );
    }
}
