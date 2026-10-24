//! The payloads a simulated device sends: codes with distinct serials, the
//! SSCC of a serial, a device's instants and the facts of a box, a pallet and
//! a close, built from the wire types of `markiro-proto` so a change of the
//! protocol breaks this crate's build, not a night of soak.

use markiro_host::facts::rules;
use markiro_proto::{
    BoxClosedFact, DuplicateSource, FactKind, FactRecord, PalletClosedFact, ScanFact, ScanRawKind,
    ScanVerdict, ScannedCode, ShiftClosedFact,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// The product's GTIN-14: the one `site.rs` creates, which every code carries.
pub const GTIN14: &str = "04600682000013";

/// The 18-digit SSCC of `extension`, `prefix` and `serial`, with its GS1
/// check digit: the serial fills what the prefix leaves of the 16 digits
/// after the extension (the domain's `buildSscc`).
pub fn sscc(extension: u8, prefix: &str, serial: u64) -> String {
    let width = 16usize.saturating_sub(prefix.len());
    let body = format!("{extension}{prefix}{serial:0width$}");
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(place, digit)| u32::from(digit - b'0') * if place % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

/// A code of the marking: its serial is unique to (run, device, n), its hash
/// is the SHA-256 of its canonical text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Code {
    pub hash: String,
    pub serial: String,
    pub canonical: String,
    /// The first eight bytes of the hash: what the ledger keys codes by.
    pub key: u64,
}

impl Code {
    pub fn new(run: u32, device: u32, n: u64) -> Code {
        let serial = format!("L{run:04x}D{device:02}N{n:010}");
        let canonical = format!("01{GTIN14}21{serial}\u{1d}93T{n:06x}");
        let digest = Sha256::digest(canonical.as_bytes());
        let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let key = u64::from_be_bytes(digest[..8].try_into().expect("eight bytes"));
        Code {
            hash,
            serial,
            canonical,
            key,
        }
    }

    pub fn scanned(&self) -> ScannedCode {
        ScannedCode {
            code_hash: self.hash.clone(),
            gtin14: GTIN14.to_owned(),
            serial: self.serial.clone(),
            canonical: self.canonical.clone(),
        }
    }
}

/// A device's instants: wall time as `Date.toISOString` writes it, never
/// repeated and never going back, whatever the clock does.
#[derive(Debug, Clone, Default)]
pub struct DeviceClock {
    last_ms: i64,
}

pub fn text_of(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .expect("a representable instant");
    rules::device_text(at)
}

pub fn now_ms() -> i64 {
    (OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

impl DeviceClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// The next instant, in milliseconds.
    pub fn next_ms(&mut self) -> i64 {
        self.last_ms = now_ms().max(self.last_ms + 1);
        self.last_ms
    }

    pub fn tick(&mut self) -> String {
        text_of(self.next_ms())
    }
}

/// A record of `kind` in `shift` as the host receives it, with no operator.
pub fn record(id: &str, kind: FactKind, shift: &str, data: Value) -> Value {
    serde_json::to_value(FactRecord {
        id: id.to_owned(),
        kind,
        shift_id: shift.to_owned(),
        operator_id: None,
        data,
    })
    .expect("a record is JSON")
}

fn data<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("a fact's data is JSON")
}

/// An accepted scan of `code` into `box_id`.
pub fn scan_ok(code: &Code, box_id: &str, at: &str) -> Value {
    data(ScanFact {
        scanned_at: at.to_owned(),
        verdict: ScanVerdict::Ok,
        duplicate_source: None,
        raw_kind: ScanRawKind::Km,
        raw_length: code.canonical.len() as u32,
        code: Some(code.scanned()),
        box_id: Some(box_id.to_owned()),
    })
}

/// A scan the host's check called taken: a journal row only.
pub fn scan_duplicate(code: &Code, at: &str) -> Value {
    data(ScanFact {
        scanned_at: at.to_owned(),
        verdict: ScanVerdict::Duplicate,
        duplicate_source: Some(DuplicateSource::Host),
        raw_kind: ScanRawKind::Km,
        raw_length: code.canonical.len() as u32,
        code: Some(code.scanned()),
        box_id: None,
    })
}

/// A box closed with serial `serial` of `block_id` over the codes `hashes`.
#[allow(clippy::too_many_arguments)]
pub fn box_closed(
    box_id: &str,
    sscc: &str,
    block_id: &str,
    serial: u64,
    opened_at: &str,
    closed_at: &str,
    hashes: &[String],
    pallet_id: Option<&str>,
) -> Value {
    data(BoxClosedFact {
        box_id: box_id.to_owned(),
        sscc: sscc.to_owned(),
        block_id: block_id.to_owned(),
        serial,
        opened_at: opened_at.to_owned(),
        closed_at: closed_at.to_owned(),
        item_count: hashes.len() as u32,
        membership_digest: rules::box_membership_digest(hashes),
        pallet_id: pallet_id.map(str::to_owned),
    })
}

/// A pallet closed with serial `serial` of the pallet block `block_id`.
pub fn pallet_closed(
    pallet_id: &str,
    sscc: &str,
    block_id: &str,
    serial: u64,
    opened_at: &str,
    closed_at: &str,
    boxes: u32,
) -> Value {
    data(PalletClosedFact {
        pallet_id: pallet_id.to_owned(),
        sscc: sscc.to_owned(),
        block_id: block_id.to_owned(),
        serial,
        opened_at: opened_at.to_owned(),
        closed_at: closed_at.to_owned(),
        box_count: boxes,
    })
}

/// A device's close of its part of the shift.
pub fn shift_closed(
    planned: Option<u32>,
    actual: u32,
    boxes: u32,
    reason: Option<&str>,
    closed_at: &str,
) -> Value {
    data(ShiftClosedFact {
        planned_qty_snapshot: planned,
        actual_qty: actual,
        closed_box_count: boxes,
        reason_code: reason.map(str::to_owned),
        closed_at: closed_at.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_sscc_carries_its_gs1_check_digit() {
        // The host's own tests build the same two (tests/support/app.rs).
        assert_eq!(sscc(0, "460068200", 1500), "046006820000015000");
        assert_eq!(sscc(1, "460068200", 40), "146006820000000409");
    }

    #[test]
    fn codes_of_other_devices_and_numbers_never_share_a_serial_or_a_hash() {
        let mut serials = std::collections::HashSet::new();
        let mut hashes = std::collections::HashSet::new();
        for device in 0..6 {
            for n in 0..500 {
                let code = Code::new(1, device, n);
                assert!(serials.insert(code.serial.clone()));
                assert!(hashes.insert(code.hash.clone()));
                assert_eq!(code.hash.len(), 64);
                assert!(
                    code.serial.len() <= 20,
                    "a GS1 serial has 20 characters at most"
                );
            }
        }
        assert_ne!(Code::new(1, 0, 0).serial, Code::new(2, 0, 0).serial);
        assert_eq!(Code::new(1, 2, 3), Code::new(1, 2, 3));
    }

    #[test]
    fn a_code_keeps_the_group_separator_and_the_shape_the_host_checks() {
        let code = Code::new(1, 0, 7);
        assert!(code.canonical.starts_with("0104600682000013"));
        assert!(code.canonical.contains('\u{1d}'));
        let scanned = code.scanned();
        assert_eq!((scanned.gtin14.len(), scanned.code_hash.len()), (14, 64));
        assert!(rules::is_code_hash(&scanned.code_hash));
    }

    #[test]
    fn a_device_never_repeats_an_instant_and_writes_it_as_the_host_reads_it() {
        let mut clock = DeviceClock::new();
        let mut last = String::new();
        for _ in 0..2000 {
            let at = clock.tick();
            assert!(rules::device_instant(&at).is_some(), "{at}");
            assert!(at > last, "{at} after {last}");
            last = at;
        }
    }

    #[test]
    fn facts_have_the_shape_the_host_reads() {
        let code = Code::new(1, 0, 1);
        let record = record(
            "00000000-0000-4000-8000-000000000001",
            FactKind::Scan,
            "00000000-0000-4000-8000-0000000000aa",
            scan_ok(
                &code,
                "b0000000-0000-4000-8000-000000000001",
                "2026-10-20T10:00:00.000Z",
            ),
        );
        let parsed: FactRecord = serde_json::from_value(record).unwrap();
        assert_eq!(parsed.kind, FactKind::Scan);
        let closed = box_closed(
            "b0000000-0000-4000-8000-000000000001",
            &sscc(0, "460068200", 1),
            "00000000-0000-4000-8000-0000000000bb",
            1,
            "2026-10-20T10:00:00.000Z",
            "2026-10-20T10:01:00.000Z",
            &[code.hash.clone()],
            Some("a0000000-0000-4000-8000-000000000001"),
        );
        let parsed: BoxClosedFact = serde_json::from_value(closed).unwrap();
        assert_eq!(parsed.item_count, 1);
        assert_eq!(
            parsed.membership_digest,
            rules::box_membership_digest(&[code.hash])
        );
    }

    #[test]
    fn payloads_pass_the_hosts_own_public_validators() {
        use markiro_host::validate;
        // The host reads an SSCC back to its serial; a box and a pallet one.
        for (extension, serial) in [(0u8, 1u64), (0, 1500), (1, 0), (1, 40)] {
            let text = sscc(extension, "460068200", serial);
            assert_eq!(text.len(), 18);
            assert!(rules::names_serial(&text, extension, "460068200", serial));
            assert!(validate::sscc_serial("serial", extension, "460068200", serial).is_ok());
        }
        assert!(!rules::names_serial(
            &sscc(0, "460068200", 2),
            0,
            "460068200",
            3
        ));
        assert!(validate::gtin14("gtin14", GTIN14).is_ok());
        // The host reads a code hash as 64 lowercase hex and a canonical text
        // without NUL; the shape and the instants the host rebuilds agree.
        let code = Code::new(7, 3, 99);
        assert!(rules::is_code_hash(&code.hash));
        let at = text_of(1_760_000_000_123);
        assert_eq!(at, "2025-10-09T08:53:20.123Z");
        assert_eq!(
            rules::device_instant(&at).map(|t| t.unix_timestamp()),
            Some(1_760_000_000)
        );
        assert!(!code.canonical.contains('\0'));
    }
}
