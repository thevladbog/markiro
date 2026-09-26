//! Secrets: random device keys and session tokens, their stored hashes, and
//! the PBKDF2 PHC format for office passwords, shared with `@markiro/domain`
//! (`crypto/phc.ts`).

use std::num::NonZeroU32;
use std::sync::OnceLock;

use aws_lc_rs::digest::{digest, SHA256};
use aws_lc_rs::pbkdf2;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;

const KEY_BYTES: usize = 32;

/// A new device key or session token: 32 random bytes, base64url.
pub fn random_key() -> String {
    let mut bytes = [0u8; KEY_BYTES];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random generator is available");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// What the database stores for a key or a token: lower-case hex SHA-256.
/// Keys are 256-bit random values, so an unsalted hash is enough.
pub fn key_hash(key: &str) -> String {
    digest(&SHA256, key.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Iterations for office passwords, verified only on the host, so it can
/// afford more work than a kiosk tablet. PINs and badges keep the domain's
/// 100 000.
pub const PASSWORD_ITERATIONS: u32 = 600_000;
const SALT_BYTES: usize = 16;
const DIGEST_BYTES: usize = 32;
/// The domain's floor: a tampered verifier must not cheapen the work.
const MIN_ITERATIONS: u32 = 10_000;

/// A parsed `pbkdf2$sha256$<iterations>$<salt>$<digest>` string.
pub struct Phc {
    pub iterations: u32,
    salt: Vec<u8>,
    digest: Vec<u8>,
}

/// Parse a PHC string in the `@markiro/domain` format: canonical standard
/// base64 with padding, a 16-byte salt and a 32-byte digest. Stricter than
/// `parsePhc` on the iteration count, which must be plain ASCII digits.
pub fn parse_phc(text: &str) -> Option<Phc> {
    let mut parts = text.split('$');
    let (Some("pbkdf2"), Some("sha256"), Some(iterations), Some(salt), Some(digest), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    if !iterations.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let iterations: u32 = iterations.parse().ok()?;
    if iterations < MIN_ITERATIONS {
        return None;
    }
    Some(Phc {
        iterations,
        salt: decode_canonical(salt, SALT_BYTES)?,
        digest: decode_canonical(digest, DIGEST_BYTES)?,
    })
}

fn decode_canonical(text: &str, expected_bytes: usize) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(text).ok()?;
    (bytes.len() == expected_bytes && STANDARD.encode(&bytes) == text).then_some(bytes)
}

/// Hash a password for storage with a fresh random salt.
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; SALT_BYTES];
    aws_lc_rs::rand::fill(&mut salt).expect("the system random generator is available");
    let mut digest = [0u8; DIGEST_BYTES];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PASSWORD_ITERATIONS).expect("non-zero"),
        &salt,
        password.as_bytes(),
        &mut digest,
    );
    format!(
        "pbkdf2$sha256${PASSWORD_ITERATIONS}${}${}",
        STANDARD.encode(salt),
        STANDARD.encode(digest)
    )
}

/// Constant-time check of `password` against a stored PHC string; a
/// malformed verifier never matches.
pub fn verify_password(phc: &str, password: &str) -> bool {
    let Some(parsed) = parse_phc(phc) else {
        return false;
    };
    let iterations = NonZeroU32::new(parsed.iterations).expect("parse_phc enforces the floor");
    pbkdf2::verify(
        pbkdf2::PBKDF2_HMAC_SHA256,
        iterations,
        &parsed.salt,
        password.as_bytes(),
        &parsed.digest,
    )
    .is_ok()
}

/// A verifier for a password nobody has: an unknown login costs the same as
/// a wrong password.
pub fn dummy_password_phc() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("markiro: no such office user"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_43_base64url_characters_and_distinct() {
        let first = random_key();
        let second = random_key();
        assert_eq!(first.len(), 43);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(first, second);
    }

    #[test]
    fn key_hash_is_hex_sha256() {
        assert_eq!(
            key_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// Computed independently with Python's `hashlib.pbkdf2_hmac`.
    const REFERENCE: &str =
        "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=";

    #[test]
    fn verifies_an_independently_computed_phc() {
        assert!(verify_password(REFERENCE, "correct horse battery"));
        assert!(!verify_password(REFERENCE, "correct horse batterY"));
    }

    #[test]
    fn hashes_round_trip_in_the_domain_format() {
        let phc = hash_password("пароль-сотрудника");
        let parts: Vec<&str> = phc.split('$').collect();
        assert_eq!(parts[..3], ["pbkdf2", "sha256", "600000"]);
        assert_eq!(parts[3].len(), 24);
        assert_eq!(parts[4].len(), 44);
        assert!(verify_password(&phc, "пароль-сотрудника"));
        assert!(!verify_password(&phc, "другой пароль"));
    }

    /// Spec §6: the host and `@markiro/domain` read each other's PHC strings.
    #[test]
    fn shares_the_phc_format_with_the_domain() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/phc-password.json")).unwrap();
        let text = |key: &str| fixture[key].as_str().unwrap().to_owned();
        assert!(verify_password(&text("passwordPhc"), &text("password")));
        assert!(verify_password(&text("pinPhc"), &text("pin")));
        assert_eq!(parse_phc(&text("pinPhc")).unwrap().iterations, 100_000);
    }

    #[test]
    fn malformed_verifiers_never_match() {
        for bad in [
            "pbkdf2$sha256$9999$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha1$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$+10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=",
            "pbkdf2$sha256$10000$bWFya2lyby1zdGFuZGFsbw==$33q/nWS7HYqVkEapiJW+qfJkAK+dEw5JDvZadD5palE=$x",
            "",
        ] {
            assert!(parse_phc(bad).is_none(), "{bad}");
            assert!(!verify_password(bad, "correct horse battery"), "{bad}");
        }
    }
}
