//! Bounded validation independent of webview checks. Error paths never contain source values.
use crate::{error::ApiError, validate};
use markiro_proto::cloud_history::*;
use serde::Serialize;
use std::collections::HashSet;

fn invalid(field: &str) -> ApiError {
    ApiError::validation(field, "invalid cloud history value")
}
pub fn digest(bytes: &[u8]) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
/// serde_json's default Map is sorted; converting structs to Value gives recursively sorted keys.
pub fn checksum<T: Serialize>(value: &T) -> Result<String, ApiError> {
    let mut value = serde_json::to_value(value).map_err(ApiError::internal)?;
    value
        .as_object_mut()
        .ok_or_else(|| invalid("checksum"))?
        .remove("checksum");
    Ok(format!(
        "sha256:{}",
        digest(&serde_json::to_vec(&value).map_err(ApiError::internal)?)
    ))
}
pub fn checksum_shape(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(markiro_proto::is_sha256_hex)
}
fn bounded<T: Serialize>(v: &T, max: usize, field: &str) -> Result<(), ApiError> {
    if serde_json::to_vec(v).map_err(ApiError::internal)?.len() > max {
        return Err(invalid(field));
    }
    Ok(())
}
fn text(v: &str, max: usize, field: &str) -> Result<(), ApiError> {
    if v.is_empty() || v.len() > max || v.chars().any(char::is_control) {
        return Err(invalid(field));
    }
    Ok(())
}
fn instant(v: &str, field: &str) -> Result<time::OffsetDateTime, ApiError> {
    if v.len() > 40 {
        return Err(invalid(field));
    }
    time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339)
        .map_err(|_| invalid(field))
}
fn pack_times(
    open: &str,
    close: &Option<String>,
    dis: &Option<String>,
    sscc: &Option<String>,
    field: &str,
) -> Result<(), ApiError> {
    // Cloud opens use server insertion time; closes/disassembly can come from an
    // offline device with an independent clock. Validate state, never their order.
    instant(open, field)?;
    for value in [close, dis].into_iter().flatten() {
        instant(value, field)?;
    }
    if (dis.is_some() && close.is_none()) || close.is_some() != sscc.is_some() {
        return Err(invalid(field));
    }
    if let Some(sscc) = sscc {
        gs1(sscc, 18, field)?;
    }
    Ok(())
}
fn gs1(v: &str, len: usize, field: &str) -> Result<(), ApiError> {
    if v.len() != len || !v.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid(field));
    }
    let sum: u32 = v
        .bytes()
        .rev()
        .enumerate()
        .map(|(i, b)| u32::from(b - b'0') * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    if sum % 10 != 0 {
        return Err(invalid(field));
    }
    Ok(())
}
fn number(v: &str, field: &str) -> Result<(), ApiError> {
    if !v.is_ascii() {
        return Err(invalid(field));
    }
    let plain = v.strip_suffix("/S").unwrap_or(v);
    let Some((month, seq)) = plain.split_once('-') else {
        return Err(invalid(field));
    };
    if month.len() != 5
        || ![
            "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
        ]
        .contains(&&month[..3.min(month.len())])
        || !month.as_bytes()[3..].iter().all(u8::is_ascii_digit)
        || seq.len() < 3
        || seq.len() > 10
        || !seq.bytes().all(|b| b.is_ascii_digit())
        || seq.parse::<u64>().unwrap_or(0) == 0
    {
        return Err(invalid(field));
    }
    let parsed = seq.parse::<u32>().map_err(|_| invalid(field))?;
    if format!("{parsed:03}") != seq {
        return Err(invalid(field));
    }
    Ok(())
}
pub fn count_values(c: &CloudHistoryCounts) -> [u64; 6] {
    [c.shifts, c.codes, c.boxes, c.items, c.pallets, c.owners]
}
fn totals(c: &CloudHistoryCounts) -> Result<u64, ApiError> {
    count_values(c).into_iter().try_fold(0u64, |s, v| {
        s.checked_add(v).ok_or_else(|| invalid("counts"))
    })
}
fn small_integer(v: Option<u64>, field: &str) -> Result<(), ApiError> {
    if v.is_some_and(|n| n > 9_007_199_254_740_991) {
        return Err(invalid(field));
    }
    Ok(())
}
/// Match domain canonicalizeKm/parseKm/kmHash: preserve the exact canonical bytes and hash only AI01/21.
fn code(c: &CloudHistoryCode, field: &str) -> Result<(), ApiError> {
    let raw = c.canonical.expose();
    if raw.len() > 1024
        || raw.trim_matches([' ', '\t']) != raw
        || raw.contains('\u{fffd}')
        || raw
            .chars()
            .any(|c| (c < '\u{20}' && c != '\u{1d}') || c == '\u{7f}')
    {
        return Err(invalid(field));
    }
    let Some(gtin) = raw.get(2..16) else {
        return Err(invalid(field));
    };
    if !raw.starts_with("01") || raw.get(16..18) != Some("21") {
        return Err(invalid(field));
    }
    gs1(gtin, 14, field)?;
    let mut segments = raw[18..].split('\u{1d}');
    let serial = segments.next().ok_or_else(|| invalid(field))?;
    if serial.is_empty() {
        return Err(invalid(field));
    }
    let mut ais = HashSet::new();
    for s in segments {
        let Some(ai) = s.get(..2) else {
            return Err(invalid(field));
        };
        if s.len() <= 2 || !ai.bytes().all(|b| b.is_ascii_digit()) || !ais.insert(ai) {
            return Err(invalid(field));
        }
    }
    if c.gtin14.as_deref().is_some_and(|g| g != gtin)
        || c.serial.as_ref().is_some_and(|s| s.expose() != serial)
        || c.hash.expose() != digest(format!("01{gtin}21{serial}").as_bytes())
    {
        return Err(invalid(field));
    }
    if !c.flat_only && (c.gtin14.is_none() || c.serial.is_none()) {
        return Err(invalid(field));
    }
    Ok(())
}
pub fn check_manifest(m: &CloudHistoryManifest) -> Result<(), ApiError> {
    bounded(m, MAX_HISTORY_MANIFEST_BYTES, "manifest")?;
    if m.format != CLOUD_HISTORY_FORMAT
        || m.format_version != CLOUD_HISTORY_FORMAT_VERSION
        || m.parts.is_empty()
        || m.parts.len() > MAX_HISTORY_PARTS
    {
        return Err(invalid("manifest"));
    }
    instant(&m.exported_at, "manifest.exportedAt")?;
    validate::civil_date("manifest.since", &m.since)?;
    let tenant = &m.source.tenant_id;
    if tenant.is_empty()
        || tenant.len() > 64
        || !tenant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(invalid("manifest.source"));
    }
    text(&m.source.tenant_name, 1000, "manifest.source")?;
    text(&m.organization.name, 1000, "manifest.organization")?;
    // Catalog/wizard GLNs are exactly 13 digits; keep that accepted source contract.
    if m.organization.gln.len() != 13 || !m.organization.gln.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("manifest.organization.gln"));
    }
    text(
        &m.organization.time_zone,
        100,
        "manifest.organization.timeZone",
    )?;
    if m.organization.time_zone.len() > 64
        || !m
            .organization
            .time_zone
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_-+".contains(&b))
    {
        return Err(invalid("manifest.organization.timeZone"));
    }
    if let Some(inn) = &m.organization.inn {
        if ![10, 12].contains(&inn.len()) || !inn.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("manifest.organization.inn"));
        }
    }
    let mut sum = [0u64; 6];
    for (index, part) in m.parts.iter().enumerate() {
        if part.index as usize != index
            || !checksum_shape(&part.checksum)
            || totals(&part.counts)? > MAX_HISTORY_PART_ROWS as u64
        {
            return Err(invalid("manifest.parts"));
        }
        for (i, n) in count_values(&part.counts).into_iter().enumerate() {
            sum[i] = sum[i]
                .checked_add(n)
                .ok_or_else(|| invalid("manifest.counts"))?;
        }
    }
    if sum != count_values(&m.counts) || !checksum_shape(&m.checksum) || checksum(m)? != m.checksum
    {
        return Err(invalid("manifest.checksum"));
    }
    Ok(())
}
pub fn check(r: &CloudHistoryImportRequest) -> Result<(), ApiError> {
    let m = &r.manifest;
    let p = &r.part;
    bounded(m, MAX_HISTORY_MANIFEST_BYTES, "manifest")?;
    bounded(p, MAX_HISTORY_PART_BYTES, "part")?;
    bounded(r, MAX_HISTORY_REQUEST_BYTES, "request")?;
    check_manifest(m)?;
    let summary = m
        .parts
        .get(p.index as usize)
        .ok_or_else(|| invalid("part.index"))?;
    if summary.counts != p.payload.counts()
        || summary.checksum != p.checksum
        || checksum(p)? != p.checksum
    {
        return Err(invalid("part.checksum"));
    }
    let data = &p.payload;
    for (i, s) in data.shifts.iter().enumerate() {
        let f = format!("part.payload.shifts.{i}");
        validate::client_uuid(&f, &s.id)?;
        validate::client_uuid(&f, &s.product_id)?;
        for id in [&s.line_id, &s.counterparty_id].into_iter().flatten() {
            validate::client_uuid(&f, id)?;
        }
        number(&s.number, &f)?;
        if !["aggregation", "validation"].contains(&s.mode.as_str())
            || !["station", "admin"].contains(&s.created_from.as_str())
            || s.number_seq == 0
            || s.number_seq > u32::MAX as u64
        {
            return Err(invalid(&f));
        }
        let expected = format!(
            "{}-{:03}{}",
            s.number_month_key,
            s.number_seq,
            if s.created_from == "station" {
                "/S"
            } else {
                ""
            }
        );
        if expected != s.number {
            return Err(invalid(&f));
        }
        gs1(&s.gtin14, 14, &f)?;
        for d in [&s.production_date, &s.planned_date].into_iter().flatten() {
            validate::civil_date(&f, d)?;
        }
        // Preserve raw cloud instants, including a device close before a server
        // open/creation. A missing open does not establish a creation-time bound.
        instant(&s.created_at, &f)?;
        for value in [&s.opened_at, &s.closed_at].into_iter().flatten() {
            instant(value, &f)?;
        }
        for v in [
            s.planned_qty,
            s.box_capacity,
            s.pallet_box_capacity,
            s.shelf_life_days,
        ] {
            small_integer(v, &f)?;
        }
        if s.shelf_life_days
            .is_some_and(|n| n == 0 || n > u64::from(validate::MAX_SHELF_LIFE_DAYS))
        {
            return Err(invalid(&f));
        }
        for v in [
            &s.product_name,
            &s.line_name,
            &s.counterparty_name,
            &s.close_reason,
        ]
        .into_iter()
        .flatten()
        {
            text(v, 2000, &f)?;
        }
    }
    for (i, c) in data.codes.iter().enumerate() {
        let f = format!("part.payload.codes.{i}");
        validate::client_uuid(&f, &c.shift_id)?;
        instant(&c.scanned_at, &f)?;
        code(c, &f)?;
    }
    for (i, b) in data.boxes.iter().enumerate() {
        let f = format!("part.payload.boxes.{i}");
        validate::client_uuid(&f, &b.id)?;
        validate::client_uuid(&f, &b.shift_id)?;
        if let Some(id) = &b.pallet_id {
            validate::client_uuid(&f, id)?;
        }
        pack_times(&b.opened_at, &b.closed_at, &b.disassembled_at, &b.sscc, &f)?;
    }
    for (i, p) in data.pallets.iter().enumerate() {
        let f = format!("part.payload.pallets.{i}");
        validate::client_uuid(&f, &p.id)?;
        if let Some(gtin) = &p.gtin14 {
            gs1(gtin, 14, &f)?;
        }
        if let Some(name) = &p.product_name {
            text(name, 2000, &f)?;
        }
        if p.shelf_life_days
            .is_some_and(|n| n == 0 || n > u64::from(validate::MAX_SHELF_LIFE_DAYS))
        {
            return Err(invalid(&f));
        }
        for id in [&p.shift_id, &p.product_id].into_iter().flatten() {
            validate::client_uuid(&f, id)?;
        }
        if !["production", "warehouse"].contains(&p.kind.as_str())
            || (p.kind == "warehouse") != p.shift_id.is_none()
        {
            return Err(invalid(&f));
        }
        pack_times(&p.opened_at, &p.closed_at, &p.disassembled_at, &p.sscc, &f)?;
    }
    for (i, it) in data.items.iter().enumerate() {
        let f = format!("part.payload.items.{i}");
        validate::client_uuid(&f, &it.box_id)?;
        instant(&it.added_at, &f)?;
        if !markiro_proto::is_sha256_hex(it.hash.expose()) {
            return Err(invalid(&f));
        }
    }
    for (i, o) in data.owners.iter().enumerate() {
        let f = format!("part.payload.owners.{i}");
        validate::client_uuid(&f, &o.shift_id)?;
        number(&o.number, &f)?;
        instant(&o.scanned_at, &f)?;
        if let Some(id) = &o.box_id {
            validate::client_uuid(&f, id)?;
        }
        if !markiro_proto::is_sha256_hex(o.hash.expose()) {
            return Err(invalid(&f));
        }
    }
    Ok(())
}
