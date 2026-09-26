//! Secrets: random device keys and session tokens and their stored hashes.
//! (The PBKDF2 PHC format for passwords joins in plan 1b1, task 3.)

use aws_lc_rs::digest::{digest, SHA256};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
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
}
