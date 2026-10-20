//! Production lines: `GET /v1/office/lines` (every role, archived lines
//! included), `POST` and `PUT …/{id}` (administrators, `PUT` with
//! `expectedRev`). Lines ride the station feed, so a rename or an archive
//! takes a new revision. Archiving a line leaves the devices assigned to it
//! alone; a station cannot pick an archived line (`PUT /v1/device/line`).
//! Since plan 2b a line also has its limit of devices in one shift (`maxStations`).

use axum::extract::State;
use axum::Json;
use markiro_proto::{LineCreate, LineUpdate, OfficeLine};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::shift_participants;
use crate::validate;

#[derive(sqlx::FromRow)]
struct LineRow {
    id: String,
    name: String,
    archived: bool,
    max_stations: u32,
    rev: i64,
}

impl From<LineRow> for OfficeLine {
    fn from(row: LineRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            archived: row.archived,
            max_stations: row.max_stations,
            rev: row.rev,
        }
    }
}

async fn read(conn: &mut SqliteConnection, id: &str) -> Result<Option<OfficeLine>, ApiError> {
    let row: Option<LineRow> =
        sqlx::query_as("SELECT id, name, archived, max_stations, rev FROM lines WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(row.map(OfficeLine::from))
}

/// A write that hit `lines_active_name_key`: another active line already has
/// the name, compared without case.
fn name_taken(error: sqlx::Error) -> ApiError {
    ApiError::conflict_on_unique_violation(error, "line_name", "another active line has this name")
}

pub async fn list_lines(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<OfficeLine>>, ApiError> {
    let rows: Vec<LineRow> = sqlx::query_as(
        "SELECT id, name, archived, max_stations, rev FROM lines ORDER BY archived, name_key, id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(rows.into_iter().map(OfficeLine::from).collect()))
}

pub async fn create_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<LineCreate>,
) -> Result<Json<OfficeLine>, ApiError> {
    context.require_admin()?;
    let (name, name_key) = validate::line_name("name", &create.name)?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    // A seat of the license (plan ЛЦ-2): lines that are not archived.
    crate::license::seats::require_seat(&state, &mut tx, crate::license::seats::Quota::Lines)
        .await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO lines (id, name, name_key, archived, rev) VALUES (?, ?, ?, 0, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&name_key)
        .bind(rev)
        .execute(&mut *tx)
        .await
        .map_err(name_taken)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::LINE_CREATE,
            target_type: Some("line"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("line vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

/// `conflict` on `line_stations_in_use`: an active shift of the line has more devices at work than
/// the new limit (plan 2b); `details.active` is the busiest shift's count.
fn stations_in_use(active: u32) -> ApiError {
    ApiError::conflict(
        "line_stations_in_use",
        "more devices work a shift of this line than the new limit",
    )
    .with_details(json!({ "constraint": "line_stations_in_use", "active": active }))
}

/// `PUT /v1/office/lines/{id}` (administrators, `expectedRev`): its name, its archive flag and
/// (plan 2b) its limit of devices in one shift, 1–16 (`validation_failed` on `maxStations`), never
/// below the live devices working an active shift of the line (`conflict` on
/// `line_stations_in_use`). A name or flag change writes `line.update`, a limit change
/// `line.max_stations_changed`; nothing changed writes nothing and takes no revision.
pub async fn update_line(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<LineUpdate>,
) -> Result<Json<OfficeLine>, ApiError> {
    context.require_admin()?;
    let renamed = update
        .name
        .as_deref()
        .map(|name| validate::line_name("name", name))
        .transpose()?;
    let limit = update
        .max_stations
        .map(|value| validate::max_stations("maxStations", value))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such line"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let name = renamed
        .as_ref()
        .map_or(current.name.as_str(), |(name, _)| name.as_str());
    let archived = update.archived.unwrap_or(current.archived);
    let max_stations = limit.unwrap_or(current.max_stations);
    // A line back from the archive takes a seat of the license (plan ЛЦ-2).
    if current.archived && !archived {
        crate::license::seats::require_seat(&state, &mut tx, crate::license::seats::Quota::Lines)
            .await?;
    }
    if max_stations < current.max_stations {
        let in_use = shift_participants::line_slots_in_use(&mut tx, &id).await?;
        if max_stations < in_use {
            return Err(stations_in_use(in_use));
        }
    }
    let details = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("archived", json!(current.archived), json!(archived)),
    ]);
    let limit_changed = max_stations != current.max_stations;
    if details.is_none() && !limit_changed {
        // Nothing actually changed: report the line as-is without bumping the revision, writing
        // a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE lines SET name = COALESCE(?, name), name_key = COALESCE(?, name_key), \
         archived = ?, max_stations = ?, rev = ? WHERE id = ?",
    )
    .bind(renamed.as_ref().map(|(name, _)| name))
    .bind(renamed.as_ref().map(|(_, name_key)| name_key))
    .bind(archived)
    .bind(max_stations)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(name_taken)?;
    if let Some(details) = details {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::LINE_UPDATE,
                target_type: Some("line"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details,
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    if limit_changed {
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: context.actor(),
                action: actions::LINE_MAX_STATIONS_CHANGED,
                target_type: Some("line"),
                target_id: Some(&id),
                outcome: Outcome::Ok,
                details: json!({ "from": current.max_stations, "to": max_stations }),
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("line vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
