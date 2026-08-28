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
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("cades") => SignerBackend::Cades,
        _ => SignerBackend::CryptoApi,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_cryptoapi_and_honours_an_explicit_override() {
        assert_eq!(backend_from_value(None), SignerBackend::CryptoApi);
        assert_eq!(backend_from_value(Some("cades")), SignerBackend::Cades);
        assert_eq!(backend_from_value(Some("CADES")), SignerBackend::Cades);
        // An unknown value must not silently disable signing.
        assert_eq!(backend_from_value(Some("nonsense")), SignerBackend::CryptoApi);
    }
}
