//! Code search in the office (owner's beta feedback «Поиск кодов», the
//! cloud's `code-search` for one site): `GET /v1/office/codes` lists the
//! placements of codes in boxes — one row per accepted scan that put a code
//! into a box — and `GET /v1/office/codes/{codeHash}` is one code's card
//! with its history. Every office role reads them; a device key alone never
//! does (`OfficeContext`). Read only: nothing is written, not even an audit
//! row, as the shift's lists.
//!
//! The office classifies what was typed or scanned with the domain's
//! `classifyScan` and sends the hash of a code (`kmHash`, never the code),
//! a GTIN-14, the 18 digits of an SSCC, a shift's number and a period of
//! scan instants (milliseconds since the epoch, both ends `[from, to)`).
//! Each criterion is checked before anything is read. One of them drives
//! the query through its index (code, box, pallet, shift, GTIN, period, in
//! that order); the others narrow it. Each query is a fixed text: the
//! criteria are bound, never written into it. A search counts at most
//! [`CODE_SEARCH_CAP`] matches; a search that matches more is narrowed.

use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::code_search::{
    CodePlacementState, OfficeCodeCard, OfficeCodeEvent, OfficeCodeItem, OfficeCodePage,
    CODE_PAGE_SIZE, CODE_SEARCH_CAP,
};
use markiro_proto::{DuplicateSource, ExceptionKind, ScanVerdict, ShiftOrigin, ShiftStatus};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use sqlx::SqliteConnection;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath, ApiQuery};
use crate::facts::rules;
use crate::server::AppState;
use crate::shifts;

/// The last page a search reaches: the cap in pages.
pub const MAX_PAGE: u32 = CODE_SEARCH_CAP / CODE_PAGE_SIZE;
/// The most rows of each kind a card reads; a code has a handful.
const CARD_LIMIT: i64 = 1_000;
/// The latest instant a period may name: the end of 9999 in milliseconds.
const MAX_MILLIS: i64 = 253_402_300_799_999;
/// Bounds that hold every device instant (`YYYY-MM-DDTHH:MM:SS.sssZ`), for a
/// period left open at either end.
const EARLIEST: &str = "";
const LATEST: &str = "~";

// The parameters every search query binds, in this order: ?1 a code's
// hash, ?2 a GTIN-14, ?3 a shift's id, ?4 a box's id, ?5 a pallet's id, ?6
// and ?7 the period's ends (text of device instants), ?8 the limit, ?9 the
// offset. A criterion not asked is NULL and narrows nothing.

/// The criteria that narrow whatever query drives: each one asked must hold.
macro_rules! narrowed {
    () => {
        " AND (?1 IS NULL OR s.code_hash = ?1) AND (?2 IS NULL OR s.gtin14 = ?2) \
         AND (?3 IS NULL OR s.shift_id = ?3) AND (?4 IS NULL OR i.box_id = ?4) \
         AND (?5 IS NULL OR b.pallet_id = ?5) AND s.scanned_at >= ?6 AND s.scanned_at < ?7"
    };
}

/// A search query's rows: the placement, its box and pallet, the shift with
/// its product and line, the station and the operator, newest scan first.
macro_rules! items {
    ($from:literal, $driver:literal) => {
        concat!(
            "SELECT i.scan_id, i.code_hash, s.gtin14, s.serial, s.scanned_at, i.removed_at, \
             i.displaced_at, b.id AS box_id, b.sscc AS box_sscc, b.closed_at AS box_closed_at, \
             b.disassembled_at AS box_disassembled_at, p.id AS pallet_id, \
             p.sscc AS pallet_sscc, p.disassembled_at AS pallet_disassembled_at, \
             sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
             sh.status AS shift_status, sh.production_date, pr.name AS product_name, \
             l.name AS line_name, s.device_id, d.name AS device_name, \
             op.name AS operator_name ",
            $from,
            " JOIN shifts sh ON sh.id = s.shift_id JOIN products pr ON pr.id = sh.product_id \
             JOIN lines l ON l.id = sh.line_id JOIN devices d ON d.id = s.device_id \
             LEFT JOIN pallets p ON p.id = b.pallet_id \
             LEFT JOIN operators op ON op.id = s.operator_id WHERE ",
            $driver,
            narrowed!(),
            " ORDER BY s.scanned_at DESC, i.scan_id DESC LIMIT ?8 OFFSET ?9"
        )
    };
}

/// A search query's count, up to its limit (?8).
macro_rules! count {
    ($from:literal, $driver:literal) => {
        concat!(
            "SELECT COUNT(*) FROM (SELECT 1 ",
            $from,
            " WHERE ",
            $driver,
            narrowed!(),
            " LIMIT ?8)"
        )
    };
}

/// One query per driving criterion: its joins and its indexed condition.
macro_rules! drivers {
    ($emit:ident) => {
        [
            (
                "code",
                $emit!(
                    "FROM scans s JOIN box_items i ON i.scan_id = s.id \
                     JOIN boxes b ON b.id = i.box_id",
                    "s.code_hash = ?1 AND s.verdict = 'ok'"
                ),
            ),
            (
                "box",
                $emit!(
                    "FROM scans s JOIN box_items i ON i.scan_id = s.id \
                     JOIN boxes b ON b.id = i.box_id",
                    "s.box_id = ?4 AND s.verdict = 'ok'"
                ),
            ),
            (
                "pallet",
                $emit!(
                    "FROM boxes b JOIN scans s ON s.box_id = b.id \
                     JOIN box_items i ON i.scan_id = s.id",
                    "b.pallet_id = ?5 AND s.verdict = 'ok'"
                ),
            ),
            (
                "shift",
                $emit!(
                    "FROM scans s JOIN box_items i ON i.scan_id = s.id \
                     JOIN boxes b ON b.id = i.box_id",
                    "s.shift_id = ?3 AND s.verdict = 'ok'"
                ),
            ),
            (
                "gtin",
                $emit!(
                    "FROM scans s JOIN box_items i ON i.scan_id = s.id \
                     JOIN boxes b ON b.id = i.box_id",
                    "s.gtin14 = ?2 AND s.verdict = 'ok'"
                ),
            ),
            (
                "period",
                $emit!(
                    "FROM scans s JOIN box_items i ON i.scan_id = s.id \
                     JOIN boxes b ON b.id = i.box_id",
                    "s.verdict = 'ok'"
                ),
            ),
        ]
    };
}

/// The rows of each driver, in [`Driver`]'s order.
pub const ITEMS_SQL: [(&str, &str); 6] = drivers!(items);
/// The counts of each driver, in [`Driver`]'s order.
pub const COUNT_SQL: [(&str, &str); 6] = drivers!(count);

/// Every scan of a code, whatever its verdict, oldest first; `placed` says
/// it put the code into a box.
pub const CARD_SCANS_SQL: &str = "SELECT s.id, s.scanned_at, s.verdict, s.duplicate_source, \
     s.gtin14, s.serial, s.canonical, s.shift_id, sh.number_month_key, sh.number_seq, \
     sh.created_from, d.name AS device_name, op.name AS operator_name, s.box_id, \
     EXISTS (SELECT 1 FROM box_items i WHERE i.scan_id = s.id) AS placed \
     FROM scans s JOIN shifts sh ON sh.id = s.shift_id JOIN devices d ON d.id = s.device_id \
     LEFT JOIN operators op ON op.id = s.operator_id \
     WHERE s.code_hash = ?1 ORDER BY s.scanned_at, s.id LIMIT ?2";

/// The exception that took each placement of a code out of its box: of its
/// box, at the instant the item left it, of a kind that takes items out (an
/// undo of this very code), first received first.
pub const CARD_EXCEPTIONS_SQL: &str = "SELECT i.scan_id, e.kind, e.reason_code, \
     e.reason_text, op.name AS operator_name FROM scans s \
     JOIN box_items i ON i.scan_id = s.id \
     JOIN box_exceptions e ON e.box_id = i.box_id AND e.occurred_at = i.removed_at \
     AND e.kind IN ('undo', 'clear', 'disassemble') \
     AND (e.kind <> 'undo' OR e.code_hash = i.code_hash) \
     LEFT JOIN operators op ON op.id = e.operator_id \
     WHERE s.code_hash = ?1 ORDER BY e.received_at, e.id LIMIT ?2";

/// The unit's warehouse reprints of a code (plan СКЛ), oldest first.
pub const CARD_REPRINTS_SQL: &str = "SELECT w.occurred_at, w.outcome, w.reason_code, \
     d.name AS device_name, op.name AS operator_name FROM warehouse_reprints w \
     JOIN devices d ON d.id = w.device_id LEFT JOIN operators op ON op.id = w.operator_id \
     WHERE w.identity = ?1 AND w.subject_kind = 'unit' \
     ORDER BY w.occurred_at, w.record_id LIMIT ?2";

/// The scan that owns a code now.
pub const CARD_OWNER_SQL: &str = "SELECT scan_id FROM code_owners WHERE code_hash = ?1";

/// The box, else the pallet, of an SSCC.
pub const BOX_BY_SSCC_SQL: &str = "SELECT id FROM boxes WHERE sscc = ?1";
pub const PALLET_BY_SSCC_SQL: &str = "SELECT id FROM pallets WHERE sscc = ?1";
/// The shift of a number.
pub const SHIFT_BY_NUMBER_SQL: &str =
    "SELECT id, created_from FROM shifts WHERE number_month_key = ?1 AND number_seq = ?2";

/// Every query of this module by name, for the test that each one searches
/// by an index.
pub const QUERIES: [(&str, &str); 19] = [
    ITEMS_SQL[0],
    ITEMS_SQL[1],
    ITEMS_SQL[2],
    ITEMS_SQL[3],
    ITEMS_SQL[4],
    ITEMS_SQL[5],
    COUNT_SQL[0],
    COUNT_SQL[1],
    COUNT_SQL[2],
    COUNT_SQL[3],
    COUNT_SQL[4],
    COUNT_SQL[5],
    ("card scans", CARD_SCANS_SQL),
    ("card exceptions", CARD_EXCEPTIONS_SQL),
    ("card reprints", CARD_REPRINTS_SQL),
    ("card owner", CARD_OWNER_SQL),
    ("box by sscc", BOX_BY_SSCC_SQL),
    ("pallet by sscc", PALLET_BY_SSCC_SQL),
    ("shift by number", SHIFT_BY_NUMBER_SQL),
];

/// Which criterion drives a search, the index of its query in
/// [`ITEMS_SQL`] and [`COUNT_SQL`].
#[derive(Debug, Clone, Copy)]
enum Driver {
    Code = 0,
    Box = 1,
    Pallet = 2,
    Shift = 3,
    Gtin = 4,
    Period = 5,
}

/// `GET /v1/office/codes?…`: every parameter is text, so a malformed one is
/// `validation_failed` naming it rather than a failure to read the query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeSearchQuery {
    code_hash: Option<String>,
    gtin: Option<String>,
    sscc: Option<String>,
    shift: Option<String>,
    from_ms: Option<String>,
    to_ms: Option<String>,
    page: Option<String>,
}

/// A shift's number as people read it (`shifts::format_number`): its month
/// key, its sequence and, with `/S`, that a station created it.
struct ShiftNumber {
    month_key: String,
    seq: i64,
    station: bool,
}

/// The month keys the host draws numbers from (`shifts::month_key`).
fn is_month_key(text: &str) -> bool {
    (1..=12u8).any(|month| {
        time::Month::try_from(month)
            .ok()
            .and_then(|month| time::Date::from_calendar_date(2000, month, 1).ok())
            .is_some_and(|date| shifts::month_key(date).get(..3) == Some(text))
    })
}

/// `OCT26-004` or `OCT26-004/S`: a month key, a dash, 1-6 digits, and the
/// station's suffix or none. Upper case only, as the host writes it.
fn shift_number(text: &str) -> Result<ShiftNumber, ApiError> {
    let refused = || ApiError::validation("shift", "a shift number such as OCT26-004");
    let (number, station) = match text.strip_suffix("/S") {
        Some(number) => (number, true),
        None => (text, false),
    };
    let (key, seq) = number.split_once('-').ok_or_else(refused)?;
    let year_ok = key.len() == 5 && key.as_bytes()[3..].iter().all(u8::is_ascii_digit);
    if !year_ok || !key.is_char_boundary(3) || !is_month_key(&key[..3]) {
        return Err(refused());
    }
    if !(1..=6).contains(&seq.len()) || !seq.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refused());
    }
    let seq: i64 = seq.parse().map_err(|_| refused())?;
    if seq == 0 {
        return Err(refused());
    }
    Ok(ShiftNumber {
        month_key: key.to_owned(),
        seq,
        station,
    })
}

/// Digits only, 1-15 of them, naming an instant of the years 1970-9999 in
/// milliseconds; returned as a device instant's text, which orders with the
/// stored ones.
fn period_end(field: &str, text: &str) -> Result<String, ApiError> {
    let refused = || ApiError::validation(field, "milliseconds since 1970 up to the year 9999");
    if !(1..=15).contains(&text.len()) || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(refused());
    }
    let millis: i64 = text.parse().map_err(|_| refused())?;
    if millis > MAX_MILLIS {
        return Err(refused());
    }
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map_err(|_| refused())?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    ))
}

/// A search's checked criteria.
struct Criteria {
    code_hash: Option<String>,
    gtin: Option<String>,
    sscc: Option<String>,
    shift: Option<ShiftNumber>,
    from: Option<String>,
    to: Option<String>,
    page: u32,
}

fn criteria(query: CodeSearchQuery) -> Result<Criteria, ApiError> {
    let code_hash = query
        .code_hash
        .map(|hash| {
            if rules::is_code_hash(&hash) {
                Ok(hash)
            } else {
                Err(ApiError::validation(
                    "codeHash",
                    "64 lower-case hex digits are required",
                ))
            }
        })
        .transpose()?;
    let gtin = query
        .gtin
        .map(|gtin| {
            if gtin.len() == 14 && gtin.bytes().all(|byte| byte.is_ascii_digit()) {
                Ok(gtin)
            } else {
                Err(ApiError::validation("gtin", "the GTIN must be 14 digits"))
            }
        })
        .transpose()?;
    let sscc = query
        .sscc
        .map(|sscc| {
            if sscc.len() == 18 && sscc.bytes().all(|byte| byte.is_ascii_digit()) {
                Ok(sscc)
            } else {
                Err(ApiError::validation("sscc", "the SSCC must be 18 digits"))
            }
        })
        .transpose()?;
    let shift = query.shift.as_deref().map(shift_number).transpose()?;
    let from = query
        .from_ms
        .as_deref()
        .map(|from| period_end("fromMs", from))
        .transpose()?;
    let to = query
        .to_ms
        .as_deref()
        .map(|to| period_end("toMs", to))
        .transpose()?;
    if let (Some(from), Some(to)) = (&from, &to) {
        if from >= to {
            return Err(ApiError::validation(
                "toMs",
                "the period ends before it starts",
            ));
        }
    }
    let page = match query.page.as_deref() {
        None => 1,
        Some(text) => text
            .parse::<u32>()
            .ok()
            .filter(|_| text.bytes().all(|byte| byte.is_ascii_digit()))
            .filter(|page| (1..=MAX_PAGE).contains(page))
            .ok_or_else(|| ApiError::validation("page", format!("1-{MAX_PAGE}")))?,
    };
    let asked = code_hash.is_some()
        || gtin.is_some()
        || sscc.is_some()
        || shift.is_some()
        || from.is_some()
        || to.is_some();
    if !asked {
        return Err(ApiError::validation(
            "query",
            "a code, a GTIN, an SSCC, a shift or a period is required",
        ));
    }
    Ok(Criteria {
        code_hash,
        gtin,
        sscc,
        shift,
        from,
        to,
        page,
    })
}

/// The ids the SSCC and the shift's number name; `None` when one of them
/// names nothing on this host, so the search matches nothing.
struct Resolved {
    shift_id: Option<String>,
    box_id: Option<String>,
    pallet_id: Option<String>,
}

async fn resolve(
    conn: &mut SqliteConnection,
    criteria: &Criteria,
) -> Result<Option<Resolved>, ApiError> {
    let mut resolved = Resolved {
        shift_id: None,
        box_id: None,
        pallet_id: None,
    };
    if let Some(sscc) = &criteria.sscc {
        let found: Option<String> = sqlx::query_scalar(BOX_BY_SSCC_SQL)
            .bind(sscc)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        if let Some(id) = found {
            resolved.box_id = Some(id);
        } else {
            let found: Option<String> = sqlx::query_scalar(PALLET_BY_SSCC_SQL)
                .bind(sscc)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            match found {
                Some(id) => resolved.pallet_id = Some(id),
                None => return Ok(None),
            }
        }
    }
    if let Some(number) = &criteria.shift {
        let found: Option<(String, String)> = sqlx::query_as(SHIFT_BY_NUMBER_SQL)
            .bind(&number.month_key)
            .bind(number.seq)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        match found {
            // `/S` names a station's shift; without it the number names
            // the shift whoever created it.
            Some((id, from)) if !number.station || from == ShiftOrigin::Station.as_str() => {
                resolved.shift_id = Some(id);
            }
            _ => return Ok(None),
        }
    }
    Ok(Some(resolved))
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    scan_id: String,
    code_hash: String,
    gtin14: String,
    serial: String,
    scanned_at: String,
    removed_at: Option<String>,
    displaced_at: Option<String>,
    box_id: String,
    box_sscc: Option<String>,
    box_closed_at: Option<String>,
    box_disassembled_at: Option<String>,
    pallet_id: Option<String>,
    pallet_sscc: Option<String>,
    pallet_disassembled_at: Option<String>,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    shift_status: String,
    production_date: String,
    product_name: String,
    line_name: String,
    device_id: String,
    device_name: String,
    operator_name: Option<String>,
}

fn shift_label(month_key: &str, seq: i64, created_from: &str) -> Result<String, ApiError> {
    let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
    Ok(shifts::format_number(month_key, seq, origin))
}

impl ItemRow {
    fn into_wire(self) -> Result<OfficeCodeItem, ApiError> {
        // An item leaves its box once: taken out, or taken by an earlier
        // scan elsewhere.
        let (state, left_at) = match (self.removed_at, self.displaced_at) {
            (Some(at), _) => (CodePlacementState::Removed, Some(at)),
            (None, Some(at)) => (CodePlacementState::Displaced, Some(at)),
            (None, None) if self.box_closed_at.is_some() => (CodePlacementState::Packed, None),
            (None, None) => (CodePlacementState::OpenBox, None),
        };
        let shift_status: ShiftStatus = self.shift_status.parse().map_err(ApiError::internal)?;
        Ok(OfficeCodeItem {
            shift_number: shift_label(&self.number_month_key, self.number_seq, &self.created_from)?,
            scan_id: self.scan_id,
            code_hash: self.code_hash,
            gtin14: self.gtin14,
            serial: self.serial,
            scanned_at: self.scanned_at,
            state,
            left_at,
            box_id: self.box_id,
            box_sscc: self.box_sscc,
            box_closed_at: self.box_closed_at,
            box_disassembled_at: self.box_disassembled_at,
            pallet_id: self.pallet_id,
            pallet_sscc: self.pallet_sscc,
            pallet_disassembled_at: self.pallet_disassembled_at,
            shift_id: self.shift_id,
            shift_status,
            production_date: self.production_date,
            product_name: self.product_name,
            line_name: self.line_name,
            device_id: self.device_id,
            device_name: self.device_name,
            operator_name: self.operator_name,
        })
    }
}

/// The values every search query binds (see the note on parameters).
struct Binds<'a> {
    code_hash: Option<&'a str>,
    gtin: Option<&'a str>,
    shift_id: Option<&'a str>,
    box_id: Option<&'a str>,
    pallet_id: Option<&'a str>,
    from: &'a str,
    to: &'a str,
}

async fn fetch_items(
    conn: &mut SqliteConnection,
    driver: Driver,
    binds: &Binds<'_>,
    limit: i64,
    offset: i64,
) -> Result<Vec<OfficeCodeItem>, ApiError> {
    let rows: Vec<ItemRow> = sqlx::query_as(ITEMS_SQL[driver as usize].1)
        .bind(binds.code_hash)
        .bind(binds.gtin)
        .bind(binds.shift_id)
        .bind(binds.box_id)
        .bind(binds.pallet_id)
        .bind(binds.from)
        .bind(binds.to)
        .bind(limit)
        .bind(offset)
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter().map(ItemRow::into_wire).collect()
}

async fn count_items(
    conn: &mut SqliteConnection,
    driver: Driver,
    binds: &Binds<'_>,
    limit: i64,
) -> Result<i64, ApiError> {
    sqlx::query_scalar(COUNT_SQL[driver as usize].1)
        .bind(binds.code_hash)
        .bind(binds.gtin)
        .bind(binds.shift_id)
        .bind(binds.box_id)
        .bind(binds.pallet_id)
        .bind(binds.from)
        .bind(binds.to)
        .bind(limit)
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)
}

fn empty_page(page: u32) -> OfficeCodePage {
    OfficeCodePage {
        items: Vec::new(),
        page,
        page_count: 1,
        total: 0,
        capped: false,
    }
}

async fn search(
    conn: &mut SqliteConnection,
    criteria: &Criteria,
) -> Result<OfficeCodePage, ApiError> {
    let Some(resolved) = resolve(&mut *conn, criteria).await? else {
        return Ok(empty_page(criteria.page));
    };
    let driver = if criteria.code_hash.is_some() {
        Driver::Code
    } else if resolved.box_id.is_some() {
        Driver::Box
    } else if resolved.pallet_id.is_some() {
        Driver::Pallet
    } else if resolved.shift_id.is_some() {
        Driver::Shift
    } else if criteria.gtin.is_some() {
        Driver::Gtin
    } else {
        Driver::Period
    };
    let binds = Binds {
        code_hash: criteria.code_hash.as_deref(),
        gtin: criteria.gtin.as_deref(),
        shift_id: resolved.shift_id.as_deref(),
        box_id: resolved.box_id.as_deref(),
        pallet_id: resolved.pallet_id.as_deref(),
        from: criteria.from.as_deref().unwrap_or(EARLIEST),
        to: criteria.to.as_deref().unwrap_or(LATEST),
    };
    let counted = count_items(&mut *conn, driver, &binds, i64::from(CODE_SEARCH_CAP) + 1).await?;
    let capped = counted > i64::from(CODE_SEARCH_CAP);
    let total =
        u32::try_from(counted.min(i64::from(CODE_SEARCH_CAP))).map_err(ApiError::internal)?;
    let page_size = i64::from(CODE_PAGE_SIZE);
    let offset = i64::from(criteria.page - 1) * page_size;
    let items = if i64::from(total) > offset {
        fetch_items(&mut *conn, driver, &binds, page_size, offset).await?
    } else {
        Vec::new()
    };
    Ok(OfficeCodePage {
        items,
        page: criteria.page,
        page_count: total.div_ceil(CODE_PAGE_SIZE).max(1),
        total,
        capped,
    })
}

/// `GET /v1/office/codes`: one page of the placements the criteria find.
pub async fn search_codes(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<CodeSearchQuery>,
) -> Result<Json<OfficeCodePage>, ApiError> {
    let criteria = criteria(query)?;
    // One snapshot for the count and the rows.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let page = search(&mut tx, &criteria).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    page.map(Json)
}

#[derive(sqlx::FromRow)]
struct ScanRow {
    id: String,
    scanned_at: String,
    verdict: String,
    duplicate_source: Option<String>,
    gtin14: String,
    serial: String,
    canonical: String,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    device_name: String,
    operator_name: Option<String>,
    box_id: Option<String>,
    placed: bool,
}

#[derive(sqlx::FromRow)]
struct ExceptionRow {
    scan_id: String,
    kind: String,
    reason_code: Option<String>,
    reason_text: Option<String>,
    operator_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ReprintRow {
    occurred_at: String,
    outcome: String,
    reason_code: String,
    device_name: String,
    operator_name: Option<String>,
}

/// A stored word read back into its wire enum.
fn stored<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(ApiError::internal)
}

/// An instant of an event, a device's or the host's, to order the history.
fn instant(text: &str) -> Result<OffsetDateTime, ApiError> {
    OffsetDateTime::parse(text, &Rfc3339).map_err(ApiError::internal)
}

fn event_at(event: &OfficeCodeEvent) -> &str {
    match event {
        OfficeCodeEvent::Scan { at, .. }
        | OfficeCodeEvent::Removed { at, .. }
        | OfficeCodeEvent::Displaced { at, .. }
        | OfficeCodeEvent::Reprint { at, .. } => at,
    }
}

async fn card(conn: &mut SqliteConnection, code_hash: &str) -> Result<OfficeCodeCard, ApiError> {
    let scans: Vec<ScanRow> = sqlx::query_as(CARD_SCANS_SQL)
        .bind(code_hash)
        .bind(CARD_LIMIT)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    // The code as its latest accepted scan read it, else its latest scan.
    let Some(latest) = scans
        .iter()
        .rev()
        .find(|scan| scan.verdict == "ok")
        .or_else(|| scans.last())
    else {
        return Err(ApiError::not_found("no scan of this code"));
    };
    let (gtin14, serial, canonical) = (
        latest.gtin14.clone(),
        latest.serial.clone(),
        latest.canonical.clone(),
    );
    let owner_scan_id: Option<String> = sqlx::query_scalar(CARD_OWNER_SQL)
        .bind(code_hash)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let binds = Binds {
        code_hash: Some(code_hash),
        gtin: None,
        shift_id: None,
        box_id: None,
        pallet_id: None,
        from: EARLIEST,
        to: LATEST,
    };
    let placements = fetch_items(&mut *conn, Driver::Code, &binds, CARD_LIMIT, 0).await?;
    let exceptions: Vec<ExceptionRow> = sqlx::query_as(CARD_EXCEPTIONS_SQL)
        .bind(code_hash)
        .bind(CARD_LIMIT)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let mut exception_of: HashMap<String, ExceptionRow> = HashMap::new();
    for row in exceptions {
        // The first received is the one that took the item out.
        exception_of.entry(row.scan_id.clone()).or_insert(row);
    }
    let reprints: Vec<ReprintRow> = sqlx::query_as(CARD_REPRINTS_SQL)
        .bind(code_hash)
        .bind(CARD_LIMIT)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;

    let mut events = Vec::new();
    for scan in scans {
        events.push(OfficeCodeEvent::Scan {
            shift_number: shift_label(&scan.number_month_key, scan.number_seq, &scan.created_from)?,
            at: scan.scanned_at,
            scan_id: scan.id,
            verdict: stored::<ScanVerdict>(&scan.verdict)?,
            duplicate_source: scan
                .duplicate_source
                .as_deref()
                .map(stored::<DuplicateSource>)
                .transpose()?,
            shift_id: scan.shift_id,
            device_name: scan.device_name,
            operator_name: scan.operator_name,
            box_id: scan.box_id,
            placed: scan.placed,
        });
    }
    for placement in &placements {
        let Some(left_at) = placement.left_at.clone() else {
            continue;
        };
        match placement.state {
            CodePlacementState::Removed => {
                let exception = exception_of.remove(&placement.scan_id);
                events.push(OfficeCodeEvent::Removed {
                    at: left_at,
                    box_id: placement.box_id.clone(),
                    box_sscc: placement.box_sscc.clone(),
                    exception: exception
                        .as_ref()
                        .map(|row| stored::<ExceptionKind>(&row.kind))
                        .transpose()?,
                    reason_code: exception.as_ref().and_then(|row| row.reason_code.clone()),
                    reason_text: exception.as_ref().and_then(|row| row.reason_text.clone()),
                    operator_name: exception.and_then(|row| row.operator_name),
                });
            }
            CodePlacementState::Displaced => events.push(OfficeCodeEvent::Displaced {
                at: left_at,
                box_id: placement.box_id.clone(),
                box_sscc: placement.box_sscc.clone(),
            }),
            CodePlacementState::OpenBox | CodePlacementState::Packed => {}
        }
    }
    for reprint in reprints {
        events.push(OfficeCodeEvent::Reprint {
            at: reprint.occurred_at,
            outcome: reprint.outcome,
            reason_code: reprint.reason_code,
            device_name: reprint.device_name,
            operator_name: reprint.operator_name,
        });
    }
    // Device instants and the host's own differ in form, so the history is
    // ordered by the instants they name; a stable sort keeps the order above
    // for events of one instant (a scan before what followed it).
    let mut keyed = events
        .into_iter()
        .map(|event| Ok((instant(event_at(&event))?, event)))
        .collect::<Result<Vec<_>, ApiError>>()?;
    keyed.sort_by_key(|(at, _)| *at);
    Ok(OfficeCodeCard {
        code_hash: code_hash.to_owned(),
        gtin14,
        serial,
        canonical,
        owner_scan_id,
        placements,
        events: keyed.into_iter().map(|(_, event)| event).collect(),
    })
}

/// `GET /v1/office/codes/{codeHash}`: a malformed hash is
/// `validation_failed`, a code the host never saw `not_found`.
pub async fn code_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(code_hash): ApiPath<String>,
) -> Result<Json<OfficeCodeCard>, ApiError> {
    if !rules::is_code_hash(&code_hash) {
        return Err(ApiError::validation(
            "codeHash",
            "64 lower-case hex digits are required",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let card = card(&mut tx, &code_hash).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    card.map(Json)
}
