//! Audit trail of office actions, pairing and initialization (spec §4.9).
//! `details` never contains PINs, passwords, keys, tokens, salts or hashes.

use serde_json::Value;
use sqlx::SqliteConnection;

#[derive(Debug, Clone, Copy)]
pub enum Actor<'a> {
    OfficeUser(&'a str),
    Device(&'a str),
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Denied,
    Failed,
}

pub struct Entry<'a> {
    pub actor: Actor<'a>,
    pub action: &'a str,
    pub target_type: Option<&'a str>,
    pub target_id: Option<&'a str>,
    pub outcome: Outcome,
    pub details: Value,
}

pub async fn record(
    conn: &mut SqliteConnection,
    at: &str,
    entry: Entry<'_>,
) -> Result<(), sqlx::Error> {
    let (actor_kind, actor_id) = match entry.actor {
        Actor::OfficeUser(id) => ("office_user", Some(id)),
        Actor::Device(id) => ("device", Some(id)),
        Actor::System => ("system", None),
    };
    let outcome = match entry.outcome {
        Outcome::Ok => "ok",
        Outcome::Denied => "denied",
        Outcome::Failed => "failed",
    };
    sqlx::query(
        "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, result, details) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(at)
    .bind(actor_kind)
    .bind(actor_id)
    .bind(entry.action)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(outcome)
    .bind(entry.details.to_string())
    .execute(conn)
    .await?;
    Ok(())
}
