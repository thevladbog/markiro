//! One-time pairing codes (spec §4.7): 10 Crockford base32 characters, and the
//! machine-readable payload the office shows as a DataMatrix code.

use std::net::Ipv4Addr;

/// Crockford base32: no I, L, O or U, so a code read aloud or typed from a
/// screen cannot be confused.
pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LENGTH: usize = 10;
/// How long a code can be claimed.
pub const CODE_LIFETIME: time::Duration = time::Duration::minutes(10);
/// Failed claims a live code survives; the next one finds it dead.
pub const MAX_FAILED_ATTEMPTS: i64 = 5;

/// A new code: 50 random bits as 10 Crockford characters. Each random byte
/// keeps its low 5 bits; 256 is a multiple of 32, so every symbol is equally
/// likely.
pub fn generate() -> String {
    let mut bytes = [0u8; CODE_LENGTH];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random generator is available");
    bytes
        .iter()
        .map(|byte| char::from(ALPHABET[usize::from(byte & 0x1f)]))
        .collect()
}

/// The canonical form of a typed or scanned code: upper case, without spaces
/// or hyphens, with Crockford's aliases (O reads as 0, I and L as 1). `None`
/// when the input cannot be a code at all.
pub fn normalize(input: &str) -> Option<String> {
    let mut code = String::with_capacity(CODE_LENGTH);
    for symbol in input.chars() {
        let symbol = match symbol.to_ascii_uppercase() {
            ' ' | '-' => continue,
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

/// The DataMatrix payload (spec §4.7):
/// `markiro-host:1?h=<a,b>&p=<port>&f=<fingerprint>&c=<code>`.
pub fn payload(addresses: &[Ipv4Addr], port: u16, fingerprint: &str, code: &str) -> String {
    let hosts = addresses
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    format!("markiro-host:1?h={hosts}&p={port}&f={fingerprint}&c={code}")
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::{generate, normalize, payload, ALPHABET, CODE_LENGTH};

    #[test]
    fn a_code_is_ten_crockford_characters() {
        for _ in 0..100 {
            let code = generate();
            assert_eq!(code.len(), CODE_LENGTH);
            assert!(code.bytes().all(|byte| ALPHABET.contains(&byte)), "{code}");
        }
        assert_ne!(generate(), generate());
    }

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
    fn the_payload_carries_addresses_port_fingerprint_and_code() {
        let fingerprint = "ab".repeat(32);
        assert_eq!(
            payload(
                &[Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)],
                45710,
                &fingerprint,
                "7K3MQ9XV2D",
            ),
            format!("markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f={fingerprint}&c=7K3MQ9XV2D")
        );
        assert_eq!(
            payload(&[], 45710, &fingerprint, "7K3MQ9XV2D"),
            format!("markiro-host:1?h=&p=45710&f={fingerprint}&c=7K3MQ9XV2D")
        );
    }
}
