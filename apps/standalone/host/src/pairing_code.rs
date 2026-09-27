//! One-time pairing codes (spec §4.7): generating one, its lifetime and
//! failed-attempt limit, and the machine-readable payload the office shows as
//! a DataMatrix code. The code format itself — the Crockford alphabet, its
//! length and `normalize` — lives in `markiro_proto::pairing`, re-exported
//! below, so a device can check a code's shape before it ever reaches the
//! host.

use std::net::Ipv4Addr;

pub use markiro_proto::pairing::{normalize, ALPHABET, CODE_LENGTH};

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

    use super::{generate, payload, ALPHABET, CODE_LENGTH};

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
