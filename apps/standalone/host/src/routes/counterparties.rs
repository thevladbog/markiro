//! Counterparties (spec §4.3): the customers of contract manufacturing.
//! `GET /v1/office/counterparties` (every role), `POST` and `PUT …/{id}`
//! (administrators, `PUT` with `expectedRev`). A counterparty is archived
//! instead of deleted and is not in the station feed; a change still takes a
//! revision, like every record with a `rev`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{CounterpartyCreate, CounterpartyRecord, CounterpartyUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

const SELECT: &str = "SELECT id, name, inn, gln, gs1_prefixes, archived, rev FROM counterparties";

#[derive(sqlx::FromRow)]
struct CounterpartyRow {
    id: String,
    name: String,
    inn: Option<String>,
    gln: String,
    gs1_prefixes: String,
    archived: bool,
    rev: i64,
}

fn record(row: CounterpartyRow) -> Result<CounterpartyRecord, ApiError> {
    Ok(CounterpartyRecord {
        id: row.id,
        name: row.name,
        inn: row.inn,
        gln: row.gln,
        gs1_prefixes: serde_json::from_str(&row.gs1_prefixes).map_err(ApiError::internal)?,
        archived: row.archived,
        rev: row.rev,
    })
}

async fn read(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<CounterpartyRecord>, ApiError> {
    let row: Option<CounterpartyRow> = sqlx::query_as(&format!("{SELECT} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

pub async fn list_counterparties(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<CounterpartyRecord>>, ApiError> {
    let rows: Vec<CounterpartyRow> =
        sqlx::query_as(&format!("{SELECT} ORDER BY archived, name, id"))
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

pub async fn create_counterparty(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(create): ApiJson<CounterpartyCreate>,
) -> Result<Json<CounterpartyRecord>, ApiError> {
    context.require_admin()?;
    let company = validate::company(
        "",
        &create.name,
        create.inn.as_deref(),
        &create.gln,
        &create.gs1_prefixes,
    )?;
    let at = state.timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO counterparties (id, name, inn, gln, gs1_prefixes, archived, rev) \
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&company.name)
    .bind(&company.inn)
    .bind(&company.gln)
    .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(rev)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::COUNTERPARTY_CREATE,
            target_type: Some("counterparty"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "name": company.name, "gln": company.gln }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let created = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("counterparty vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(created))
}

pub async fn update_counterparty(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<CounterpartyUpdate>,
) -> Result<Json<CounterpartyRecord>, ApiError> {
    context.require_admin()?;
    let company = validate::company(
        "",
        &update.name,
        update.inn.as_deref(),
        &update.gln,
        &update.gs1_prefixes,
    )?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such counterparty"))?;
    if current.rev != update.expected_rev {
        return Err(ApiError::stale_revision(current.rev));
    }
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(company.name)),
        ("inn", json!(current.inn), json!(company.inn)),
        ("gln", json!(current.gln), json!(company.gln)),
        (
            "gs1Prefixes",
            json!(current.gs1_prefixes),
            json!(company.gs1_prefixes),
        ),
        ("archived", json!(current.archived), json!(update.archived)),
    ]) else {
        // Nothing actually changed: report the record as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return Ok(Json(current));
    };
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE counterparties SET name = ?, inn = ?, gln = ?, gs1_prefixes = ?, archived = ?, \
         rev = ? WHERE id = ?",
    )
    .bind(&company.name)
    .bind(&company.inn)
    .bind(&company.gln)
    .bind(serde_json::to_string(&company.gs1_prefixes).map_err(ApiError::internal)?)
    .bind(update.archived)
    .bind(rev)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::COUNTERPARTY_UPDATE,
            target_type: Some("counterparty"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("counterparty vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(updated))
}
