//! The office's list of every pallet of the site (plan КРТ, parity spec
//! §5.3, the cloud's `GET /pallets`): narrowed by product, line (the
//! shift's), station, a period of closing and an SSCC; open pallets first,
//! then closed newest first, 100 a page, each page below the previous
//! one's last row (a key, never an offset, so a pallet that closes
//! meanwhile neither skips nor repeats a row). Every office role reads it;
//! nothing is written. Each query is a fixed text with the criteria bound.

use axum::extract::State;
use axum::Json;
use markiro_proto::pack_cards::{
    OfficePalletPage, OfficePalletRow, OfficePalletStation, PALLET_PAGE_SIZE,
};
use markiro_proto::ShiftOrigin;
use serde::Deserialize;

use super::office_codes;
use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiQuery};
use crate::facts::rules;
use crate::server::AppState;
use crate::{shifts, validate};

/// The key before every row (`(ifnull(closed_at, '~'), id) < (FIRST_KEY, "")`).
pub const FIRST_KEY: &str = "~~";
/// An open pallet's key: after every digit, so open pallets come first.
pub const OPEN_KEY: &str = "~";

macro_rules! pallet_list {
    ($driver:literal) => {
        concat!(
            "SELECT p.id, p.sscc, p.opened_at, p.closed_at, p.disassembled_at, \
             p.box_count_reported, p.device_id, d.name AS device_name, \
             sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
             sh.production_date, sh.product_id, pr.name AS product_name, sh.line_id, \
             l.name AS line_name, \
             (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
              AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
             (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
              AND i.removed_at IS NULL AND i.displaced_at IS NULL \
              WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL \
              AND b.disassembled_at IS NULL) AS units \
             FROM pallets p JOIN shifts sh ON sh.id = p.shift_id \
             JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
             JOIN devices d ON d.id = p.device_id WHERE ",
            $driver,
            " AND (ifnull(p.closed_at, '~'), p.id) < (?6, ?7) \
             AND (?1 IS NULL OR sh.product_id = ?1) AND (?2 IS NULL OR sh.line_id = ?2) \
             AND (?3 IS NULL OR p.device_id = ?3) AND (?4 IS NULL OR p.closed_at >= ?4) \
             AND (?5 IS NULL OR p.closed_at < ?5) \
             ORDER BY ifnull(p.closed_at, '~') DESC, p.id DESC LIMIT ?8"
        )
    };
}

// Parameters, bound by every query in this order: ?1 product, ?2 line, ?3
// station, ?4 and ?5 the period's ends (device instants' text), ?6 and ?7
// the key below which the page starts, ?8 the limit, ?9 the SSCC.
/// The list, read backwards through `pallets_list_order`.
pub const LIST_SQL: &str = pallet_list!("?9 IS NULL");
/// The list of one SSCC, read through `pallets_sscc`.
pub const BY_SSCC_SQL: &str = pallet_list!("p.sscc = ?9");
/// The stations the list can be narrowed to: a table of a handful.
pub const STATIONS_SQL: &str = "SELECT id, name, revoked_at IS NOT NULL AS revoked \
     FROM devices WHERE kind = 'station' ORDER BY name, id";

/// `GET /v1/office/pallets?…`: every parameter is text, so a malformed one
/// is `validation_failed` naming it rather than a failure to read the query.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PalletListQuery {
    product: Option<String>,
    line: Option<String>,
    device: Option<String>,
    from_ms: Option<String>,
    to_ms: Option<String>,
    sscc: Option<String>,
    cursor: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    box_count_reported: Option<u32>,
    device_id: String,
    device_name: String,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    production_date: String,
    product_id: String,
    product_name: String,
    line_id: String,
    line_name: String,
    boxes: i64,
    units: i64,
}

#[derive(sqlx::FromRow)]
struct StationRow {
    id: String,
    name: String,
    revoked: bool,
}

fn uuid_param(field: &str, value: Option<String>) -> Result<Option<String>, ApiError> {
    value
        .map(|v| validate::client_uuid(field, &v).map(|()| v))
        .transpose()
}

fn decode_cursor(text: &str) -> Result<(String, String), ApiError> {
    let refused = || ApiError::validation("cursor", "a cursor this list gave");
    let (key, id) = text.split_once('~').ok_or_else(refused)?;
    validate::client_uuid("cursor", id).map_err(|_| refused())?;
    let key = if key == "o" {
        OPEN_KEY.to_owned()
    } else {
        office_codes::period_end("cursor", key).map_err(|_| refused())?
    };
    Ok((key, id.to_owned()))
}

/// `o~<id>` after an open pallet, `<ms>~<id>` after a closed one.
pub fn next_cursor(id: &str, closed_at: Option<&str>) -> Result<String, ApiError> {
    match closed_at {
        None => Ok(format!("o~{id}")),
        Some(at) => {
            let at = rules::device_instant(at)
                .ok_or_else(|| ApiError::internal("a pallet's closing is no device instant"))?;
            Ok(format!("{}~{id}", at.unix_timestamp_nanos() / 1_000_000))
        }
    }
}

fn sscc_param(value: Option<String>) -> Result<Option<String>, ApiError> {
    value
        .map(|sscc| {
            if sscc.len() == 18 && sscc.bytes().all(|byte| byte.is_ascii_digit()) {
                Ok(sscc)
            } else {
                Err(ApiError::validation("sscc", "the SSCC must be 18 digits"))
            }
        })
        .transpose()
}

impl PalletRow {
    fn into_wire(self) -> Result<OfficePalletRow, ApiError> {
        let origin: ShiftOrigin = self.created_from.parse().map_err(ApiError::internal)?;
        Ok(OfficePalletRow {
            shift_number: shifts::format_number(&self.number_month_key, self.number_seq, origin),
            boxes: u32::try_from(self.boxes).map_err(ApiError::internal)?,
            units: u64::try_from(self.units).map_err(ApiError::internal)?,
            id: self.id,
            sscc: self.sscc,
            shift_id: self.shift_id,
            production_date: self.production_date,
            product_id: self.product_id,
            product_name: self.product_name,
            line_id: self.line_id,
            line_name: self.line_name,
            device_id: self.device_id,
            device_name: self.device_name,
            opened_at: self.opened_at,
            closed_at: self.closed_at,
            disassembled_at: self.disassembled_at,
            box_count_reported: self.box_count_reported,
        })
    }
}

/// `GET /v1/office/pallets`.
pub async fn list_pallets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<PalletListQuery>,
) -> Result<Json<OfficePalletPage>, ApiError> {
    let product = uuid_param("product", query.product)?;
    let line = uuid_param("line", query.line)?;
    let device = uuid_param("device", query.device)?;
    let from = query
        .from_ms
        .as_deref()
        .map(|value| office_codes::period_end("fromMs", value))
        .transpose()?;
    let to = query
        .to_ms
        .as_deref()
        .map(|value| office_codes::period_end("toMs", value))
        .transpose()?;
    if let (Some(from), Some(to)) = (&from, &to) {
        if from >= to {
            return Err(ApiError::validation(
                "toMs",
                "the period ends before it starts",
            ));
        }
    }
    let sscc = sscc_param(query.sscc)?;
    let (key, after) = match query.cursor.as_deref() {
        Some(cursor) => decode_cursor(cursor)?,
        None => (FIRST_KEY.to_owned(), String::new()),
    };
    let sql = if sscc.is_some() {
        BY_SSCC_SQL
    } else {
        LIST_SQL
    };
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        let rows: Vec<PalletRow> = sqlx::query_as(sql)
            .bind(&product)
            .bind(&line)
            .bind(&device)
            .bind(&from)
            .bind(&to)
            .bind(&key)
            .bind(&after)
            .bind(i64::from(PALLET_PAGE_SIZE) + 1)
            .bind(&sscc)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let stations: Vec<StationRow> = sqlx::query_as(STATIONS_SQL)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((rows, stations))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (mut rows, stations) = read?;
    let more = rows.len() > PALLET_PAGE_SIZE as usize;
    rows.truncate(PALLET_PAGE_SIZE as usize);
    let next = match (more, rows.last()) {
        (true, Some(last)) => Some(next_cursor(&last.id, last.closed_at.as_deref())?),
        _ => None,
    };
    Ok(Json(OfficePalletPage {
        items: rows
            .into_iter()
            .map(PalletRow::into_wire)
            .collect::<Result<Vec<_>, _>>()?,
        next_cursor: next,
        stations: stations
            .into_iter()
            .map(|station| OfficePalletStation {
                id: station.id,
                name: station.name,
                revoked: station.revoked,
            })
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::{decode_cursor, next_cursor, OPEN_KEY};

    const ID: &str = "a0000000-0000-4000-8000-000000000002";

    #[test]
    fn an_open_pallets_cursor_is_o_and_its_id_and_comes_back_as_the_open_key() {
        assert_eq!(next_cursor(ID, None).unwrap(), format!("o~{ID}"));
        assert_eq!(
            decode_cursor(&format!("o~{ID}")).unwrap(),
            (OPEN_KEY.to_owned(), ID.to_owned())
        );
    }

    #[test]
    fn a_closed_pallets_cursor_is_its_closing_in_milliseconds_and_comes_back_as_the_instant() {
        let cursor = next_cursor(ID, Some("2026-10-08T06:00:09.123Z")).unwrap();
        assert_eq!(cursor, format!("1791439209123~{ID}"));
        assert_eq!(
            decode_cursor(&cursor).unwrap(),
            ("2026-10-08T06:00:09.123Z".to_owned(), ID.to_owned())
        );
    }

    #[test]
    fn a_cursor_this_list_did_not_give_is_refused() {
        for bad in [
            "",
            "o",
            "o~",
            "o~nope",
            &format!("x~{ID}"),
            &format!("-1~{ID}"),
            &format!("1e3~{ID}"),
            &format!("O~{ID}"),
            &format!("2026-10-08~{ID}"),
            &format!("1791439209123~{}", ID.to_uppercase()),
        ] {
            assert!(decode_cursor(bad).is_err(), "{bad} was accepted");
        }
    }
}
