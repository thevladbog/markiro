//! The signing capability, kept behind a trait so the runtime is testable on
//! any platform and so a second implementation (CAdESCOM over COM) can replace
//! the CryptoAPI one without touching callers.

use crate::SignerError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateSummary {
    /// SHA-1 hash of the DER certificate, uppercase hex — the same shape
    /// CAdESCOM's `Certificate.Thumbprint` returns, which is what the cloud
    /// stores and the admin UI displays.
    pub thumbprint: String,
    pub subject: String,
    pub inn: Option<String>,
    /// RFC3339 with offset, matching the cloud's `certNotAfter` contract.
    pub not_after: String,
    pub has_private_key: bool,
}

pub trait Signer: Send + Sync {
    /// Certificates in the current user's MY store that can sign a GOST payload.
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError>;

    /// Attached (enveloping) signature over `payload`, base64-encoded — the
    /// form True API's `simpleSignIn` expects for the challenge.
    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError>;
}

/// Pulls the INN out of a certificate subject.
///
/// Russian CAs spell the attribute several ways (`ИНН`, `ИНН ЮЛ`, `INN`,
/// sometimes OID `1.2.643.3.131.1.1`), so match on any of them and accept only
/// a 10- or 12-digit value: the cloud rejects anything else, and a wrong INN
/// would fail the whole report rather than just this field.
pub fn inn_from_subject(subject: &str) -> Option<String> {
    const KEYS: [&str; 4] = ["ИНН ЮЛ", "ИНН", "INN", "1.2.643.3.131.1.1"];
    // Under this OID spelling, a legal entity's 10-digit INN is stored
    // zero-padded to 12 characters (e.g. `007712345678`). Left as-is, that
    // passes the cloud's `^\d{10}(\d{2})?$` check as a *valid but wrong*
    // 12-digit (individual entrepreneur) INN instead of the real 10-digit
    // one, and is shown that way in the cabinet with no error anywhere.
    const OID_KEY: &str = "1.2.643.3.131.1.1";
    for key in KEYS {
        let mut haystack = subject;
        while let Some(index) = haystack.find(key) {
            let rest = &haystack[index + key.len()..];
            let digits: String = rest
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if key == OID_KEY {
                if let Some(unpadded) = digits.strip_prefix("00") {
                    if unpadded.len() == 10 {
                        return Some(unpadded.to_string());
                    }
                }
            }
            if digits.len() == 10 || digits.len() == 12 {
                return Some(digits);
            }
            haystack = rest;
        }
    }
    None
}

/// Parses an uppercase-hex thumbprint (the shape `format_thumbprint` in
/// `signer_capi` produces, e.g. `"AB120F"`) back into raw bytes so it can be
/// fed to `CERT_FIND_HASH` as a `CRYPT_INTEGER_BLOB`.
///
/// Kept here — rather than in `signer_capi`, which is `#[cfg(windows)]` and so
/// never compiles or runs its tests on a non-Windows host — because it is
/// pure string handling with no Win32 dependency.
pub fn thumbprint_bytes(hex: &str) -> Option<Vec<u8>> {
    let chars: Vec<char> = hex.chars().collect();
    if !chars.len().is_multiple_of(2) {
        return None;
    }
    let mut bytes = Vec::with_capacity(chars.len() / 2);
    for pair in chars.chunks(2) {
        let byte_str: String = pair.iter().collect();
        let byte = u8::from_str_radix(&byte_str, 16).ok()?;
        bytes.push(byte);
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_inn_from_a_russian_subject_rdn() {
        assert_eq!(
            inn_from_subject("CN=ООО Ромашка, ИНН=7712345678, O=Ромашка").as_deref(),
            Some("7712345678")
        );
        assert_eq!(
            inn_from_subject("CN=ИП Иванов, ИНН ЮЛ=771234567890").as_deref(),
            Some("771234567890")
        );
        assert_eq!(
            inn_from_subject("CN=Test, INN=7712345678").as_deref(),
            Some("7712345678")
        );
        assert_eq!(inn_from_subject("CN=No inn here"), None);
        // A malformed length is not an INN — better absent than wrong, because
        // the cloud validates 10 or 12 digits and would reject the whole report.
        assert_eq!(inn_from_subject("CN=Test, ИНН=12345"), None);
        // The OID spelling stores a legal entity's INN zero-padded to 12
        // chars. Left un-stripped it still passes the cloud's 10-or-12-digit
        // check, so it must be de-padded rather than merely rejected.
        assert_eq!(
            inn_from_subject("CN=ООО Ромашка, 1.2.643.3.131.1.1=007712345678").as_deref(),
            Some("7712345678")
        );
        // A genuine 12-digit individual-entrepreneur INN under the same OID
        // must survive untouched — only a `00`-padded 12-digit run is a
        // padded 10-digit INN in disguise.
        assert_eq!(
            inn_from_subject("CN=ИП Иванов, 1.2.643.3.131.1.1=771234567890").as_deref(),
            Some("771234567890")
        );
    }

    #[test]
    fn parses_a_thumbprint_hex_string_into_bytes() {
        assert_eq!(thumbprint_bytes("AB120F"), Some(vec![0xAB, 0x12, 0x0F]));
        assert_eq!(thumbprint_bytes(""), Some(vec![]));
    }

    #[test]
    fn rejects_an_odd_length_thumbprint() {
        assert_eq!(thumbprint_bytes("ABC"), None);
    }

    #[test]
    fn rejects_a_non_hex_thumbprint() {
        assert_eq!(thumbprint_bytes("ZZ120F"), None);
        assert_eq!(thumbprint_bytes("ИН1234"), None);
    }
}
