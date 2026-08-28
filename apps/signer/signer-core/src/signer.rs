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
    for key in KEYS {
        let mut haystack = subject;
        while let Some(index) = haystack.find(key) {
            let rest = &haystack[index + key.len()..];
            let digits: String = rest
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if digits.len() == 10 || digits.len() == 12 {
                return Some(digits);
            }
            haystack = rest;
        }
    }
    None
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
    }
}
