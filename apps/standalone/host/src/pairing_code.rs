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

    use super::{generate, payload, ALPHABET, CODE_LENGTH, CODE_LIFETIME};
    use crate::clock::{format_timestamp, parse_timestamp};

    /// The shared fixture is what this host answers: the payload it builds
    /// for the fixture's code, both timestamps in the host's own format, and
    /// a lifetime of `CODE_LIFETIME` from `createdAt` to `expiresAt`.
    #[test]
    fn the_shared_pairing_code_fixture_matches_the_host() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/pairing-code.json")).unwrap();
        let text = |key: &str| fixture[key].as_str().unwrap().to_owned();
        assert_eq!(
            payload(
                &[Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)],
                45710,
                &"ab".repeat(32),
                &text("code"),
            ),
            text("payload")
        );
        let created = parse_timestamp(&text("createdAt")).unwrap();
        assert_eq!(format_timestamp(created), text("createdAt"));
        assert_eq!(format_timestamp(created + CODE_LIFETIME), text("expiresAt"));
    }

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

    /// The payloads of `pairing-payloads.json` that are the host's own spelling: what the host builds
    /// from the parsed parts is the text (the TypeScript and Kotlin readers parse the same texts).
    #[test]
    fn the_host_builds_the_canonical_payloads_of_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../proto/fixtures/pairing-payloads.json"))
                .unwrap();
        let mut canonical = 0;
        for case in fixture["valid"].as_array().unwrap() {
            if case["canonical"] != true {
                continue;
            }
            canonical += 1;
            let parsed = &case["parsed"];
            let addresses: Vec<Ipv4Addr> = parsed["addresses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|address| address.as_str().unwrap().parse().unwrap())
                .collect();
            assert_eq!(
                payload(
                    &addresses,
                    parsed["port"].as_u64().unwrap() as u16,
                    parsed["fingerprint"].as_str().unwrap(),
                    parsed["code"].as_str().unwrap(),
                ),
                case["text"].as_str().unwrap()
            );
        }
        assert_eq!(canonical, 2);
    }
}
