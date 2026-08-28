//! Backend selection for signing: CryptoAPI (default) or CAdESCOM (opt-in
//! fallback, see `signer_cades`).
//!
//! Kept in its own module, free of any Windows-only dependency, so the
//! selection logic — and its test — compiles and runs on every host. Both
//! signer implementations themselves stay `#[cfg(windows)]`, but which one
//! the shell should construct is a pure string-matching decision that has no
//! reason to be unreachable on macOS or Linux CI.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerBackend {
    CryptoApi,
    Cades,
}

/// Chosen at startup from `MARKIRO_SIGNER_BACKEND`. Defaults to CryptoAPI: it
/// needs only the CSP, while CAdESCOM additionally needs the CryptoPro CAdES
/// SDK / browser plug-in.
pub fn signer_backend_from_env() -> SignerBackend {
    backend_from_value(std::env::var("MARKIRO_SIGNER_BACKEND").ok().as_deref())
}

pub fn backend_from_value(value: Option<&str>) -> SignerBackend {
    match value.map(str::trim) {
        Some(trimmed) if trimmed.eq_ignore_ascii_case("cades") => SignerBackend::Cades,
        Some(trimmed) if !trimmed.is_empty() => {
            // The operator set something, and it wasn't "cades" — most
            // likely a typo (`cadescom`) or a stray trailing character. Say
            // so rather than silently falling back, or they will believe
            // they switched backends when they did not.
            tracing::warn!(
                value = trimmed,
                "unrecognised MARKIRO_SIGNER_BACKEND value; defaulting to CryptoAPI"
            );
            SignerBackend::CryptoApi
        }
        _ => SignerBackend::CryptoApi,
    }
}

/// Strips the CR/LF line breaks that `CryptBinaryToString`-style base64
/// encoders (which is what CAdESCOM's `SignCades` ultimately uses) insert
/// every 64 characters, so every `Signer` implementation hands
/// `trueapi.rs` the same single-line shape. `signer_capi.rs` already
/// produces one line via `STANDARD.encode`; `signer_cades.rs` calls this
/// before returning so the two backends stay interchangeable.
///
/// Lives here rather than in `signer_cades.rs` because this module is not
/// `#[cfg(windows)]`-gated, so the helper (and its test) builds and runs on
/// every host, including this macOS one — `signer_backend.rs` already holds
/// the other cross-platform, backend-selection-adjacent logic.
pub fn strip_base64_line_breaks(value: &str) -> String {
    value.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_cryptoapi_and_honours_an_explicit_override() {
        assert_eq!(backend_from_value(None), SignerBackend::CryptoApi);
        assert_eq!(backend_from_value(Some("cades")), SignerBackend::Cades);
        assert_eq!(backend_from_value(Some("CADES")), SignerBackend::Cades);
        // Untrimmed whitespace around an otherwise-valid value still resolves.
        assert_eq!(backend_from_value(Some("cades ")), SignerBackend::Cades);
        assert_eq!(backend_from_value(Some("  CaDeS\n")), SignerBackend::Cades);
        // An unknown value must not silently disable signing.
        assert_eq!(backend_from_value(Some("nonsense")), SignerBackend::CryptoApi);
        // A near-miss (the CAdESCOM prog-id, not the backend name) also
        // falls back rather than silently doing nothing.
        assert_eq!(backend_from_value(Some("cadescom")), SignerBackend::CryptoApi);
        // Whitespace-only is treated the same as unset, not as "unrecognised".
        assert_eq!(backend_from_value(Some("   ")), SignerBackend::CryptoApi);
    }

    #[test]
    fn strips_cr_lf_from_base64_line_breaks() {
        assert_eq!(
            strip_base64_line_breaks("QUJD\r\nREVG\r\nR0hJ"),
            "QUJDREVGR0hJ"
        );
        assert_eq!(strip_base64_line_breaks("no-breaks-here"), "no-breaks-here");
        assert_eq!(strip_base64_line_breaks("only\r\n\r\n"), "only");
        assert_eq!(strip_base64_line_breaks(""), "");
    }
}
