//! The rules of facts that the host and the webview must answer alike, each
//! pinned by a fixture both read: the digest of a box's members
//! (`box-digest.json`, the domain's `boxMembershipDigestV1`), the form of a
//! device's instant (`device-instants.json`, what `Date.toISOString` writes)
//! and when a station's close needs a reason (`shift-close-reasons.json`,
//! the domain's `shiftCloseReasonRequired`), and how the first 17 digits of
//! a box's or a pallet's SSCC name its serial (`sscc-serials.json`, built by
//! the domain's `buildSscc`). The digest of a record is the host's own: it
//! keys idempotency.

use aws_lc_rs::digest::{digest, SHA256};
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The digest of a record as received: SHA-256 of its compact JSON, whose
/// object keys serde_json writes in byte order (the crate is built without
/// `preserve_order`), so the same record with its keys in another order has
/// the same digest. A record sent again with the same id and digest gets its
/// stored receipt; with another digest, `payload_mismatch`.
pub fn record_digest(record: &Value) -> String {
    sha256_hex(record.to_string().as_bytes())
}

/// The domain's `boxMembershipDigestV1`: SHA-256 of
/// `markiro:box-members:v1\n` followed by the box's code hashes in byte
/// order, joined by line feeds. It does not validate: its one caller reads
/// the live `box_items` of a box, whose hashes passed `is_code_hash` on the
/// way in and are distinct by `box_items_live`, and a station sends only the
/// digest, so there is no input to refuse and no `Result`.
pub fn box_membership_digest(code_hashes: &[String]) -> String {
    let mut sorted: Vec<&str> = code_hashes.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sha256_hex(format!("markiro:box-members:v1\n{}", sorted.join("\n")).as_bytes())
}

/// A device's instant as `Date.toISOString` writes it:
/// `YYYY-MM-DDTHH:MM:SS.sssZ`, exactly 24 characters naming a real UTC
/// instant. Any other spelling of the same instant (no milliseconds, an
/// offset, a lower-case `t`) is refused, so the stored text orders the
/// instants and the earliest scan is found by comparing it.
pub fn device_instant(text: &str) -> Option<OffsetDateTime> {
    let at = OffsetDateTime::parse(text, &Rfc3339).ok()?;
    let written = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    );
    // The text written back names its offset `Z`: another offset never
    // matches it.
    (written == text).then_some(at)
}

/// An instant written as a device writes its own ([`device_instant`]'s form,
/// 24 characters with milliseconds): what the office's disaggregation
/// stamps on the fact tables (plan ДЗГ), so their columns hold one kind of
/// text and the box report finds the items a disassembly took out by
/// equality.
pub fn device_text(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

/// A code's hash as the domain's `kmHash` writes it: 64 lower-case hex
/// digits.
pub fn is_code_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Whether `sscc` is the SSCC of `serial` under `issuer_prefix` and the
/// extension digit `extension` (a box 0, a pallet 1), whatever its check
/// digit: its first 17 digits are the extension, the prefix and the serial
/// padded to the prefix's width, as the domain's `buildSscc` writes them. The
/// check digit is a marking rule, the domain's (stage 2a spec, decision 13).
/// Text shorter than that names no serial.
pub fn names_serial(sscc: &str, extension: u8, issuer_prefix: &str, serial: u64) -> bool {
    let width = 16 - issuer_prefix.len();
    serial < crate::validate::serial_capacity(issuer_prefix)
        && sscc
            .get(..17)
            .is_some_and(|body| body == format!("{extension}{issuer_prefix}{serial:0width$}"))
}

/// The domain's `shiftCloseReasonRequired`: a station's close needs one of
/// the six reason codes when the shift had a plan and the fact differs.
pub fn close_reason_required(planned_qty: Option<u32>, actual_qty: u32) -> bool {
    planned_qty.is_some_and(|planned| planned != actual_qty)
}
