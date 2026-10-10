//! Audit trail of office actions, pairing and initialization (spec §4.9).
//! `details` never contains PINs, passwords, keys, tokens, salts or hashes.

use serde_json::Value;
use sqlx::SqliteConnection;

/// Action names of `audit_log.action`. A new writer adds its name here, so
/// the audit screen (plan 5) translates one list.
pub mod actions {
    pub const HOST_BOOTSTRAP: &str = "host.bootstrap";
    /// `markiro-host restore` put a copy back (plan РК); the host is the
    /// actor.
    pub const HOST_RESTORE: &str = "host.restore";
    /// An administrator resumed the stations' facts a restore held.
    pub const HOST_RESTORE_RESUME: &str = "host.restore.resume";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
    pub const OFFICE_USER_CREATE: &str = "office_user.create";
    pub const OFFICE_USER_UPDATE: &str = "office_user.update";
    /// An administrator set someone's password, or a user changed their own
    /// (then `actor_id == target_id`).
    pub const OFFICE_USER_PASSWORD: &str = "office_user.password";
    pub const ORG_UPDATE: &str = "org.update";
    pub const SSCC_COUNTER_UPDATE: &str = "sscc.counter.update";
    pub const SSCC_BLOCK_SIZES_UPDATE: &str = "sscc.block_sizes.update";
    pub const PAIRING_CODE_CREATE: &str = "pairing_code.create";
    pub const DEVICE_CLAIM: &str = "device.claim";
    pub const DEVICE_LINE: &str = "device.line";
    pub const COUNTERPARTY_CREATE: &str = "counterparty.create";
    pub const COUNTERPARTY_UPDATE: &str = "counterparty.update";
    pub const LINE_CREATE: &str = "line.create";
    pub const LINE_UPDATE: &str = "line.update";
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
    pub const TEMPLATE_CREATE: &str = "template.create";
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
    /// A shift planned in the office or created at a station.
    pub const SHIFT_CREATE: &str = "shift.create";
    pub const SHIFT_UPDATE: &str = "shift.update";
    pub const SHIFT_DELETE: &str = "shift.delete";
    /// A station opened a planned shift: its snapshot is frozen.
    pub const SHIFT_OPEN: &str = "shift.open";
    /// The office closed an active shift (a station's close is a fact, plan
    /// 2a2).
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// After a restore, a station gave the host back a block the copy had
    /// lost (plan РК).
    pub const SSCC_BLOCK_REGISTER: &str = "sscc.block.register";
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
    /// An administrator set or cleared the second folder of copies.
    pub const BACKUP_SETTINGS_UPDATE: &str = "backup.settings.update";
}

/// `details.reason` of a denied row: every denial names one.
pub mod reasons {
    /// The typed login is not a valid login at all; its text is not recorded.
    pub const INVALID_LOGIN: &str = "invalid_login";
    /// No such login; its text is not recorded either.
    pub const UNKNOWN_LOGIN: &str = "unknown_login";
    pub const WRONG_PASSWORD: &str = "wrong_password";
    pub const INACTIVE: &str = "inactive";
    /// The record changed while the password was being hashed.
    pub const CHANGED: &str = "changed";
    pub const WRONG_CURRENT_PASSWORD: &str = "wrong_current_password";
    /// No live code matches (or the input is not a code at all).
    pub const UNKNOWN_CODE: &str = "unknown_code";
    pub const CODE_USED: &str = "code_used";
    pub const TOO_MANY_ATTEMPTS: &str = "too_many_attempts";
    pub const CODE_EXPIRED: &str = "code_expired";
}

/// `details` of an update row: `changed` names the changed fields in order,
/// and each of them also appears as `{ "from": …, "to": … }`. `None` when
/// nothing changed, so the caller can return the record as-is.
pub fn update_details(fields: &[(&str, Value, Value)]) -> Option<Value> {
    update_details_hiding(fields, &[])
}

/// [`update_details`] plus fields whose values never enter the log (a PIN
/// hash): a changed one is named in `changed`, after the others, and has no
/// `{ from, to }`.
pub fn update_details_hiding(
    fields: &[(&str, Value, Value)],
    hidden: &[(&str, bool)],
) -> Option<Value> {
    let mut details = serde_json::Map::new();
    let mut changed = Vec::new();
    for (name, from, to) in fields {
        if from != to {
            changed.push(Value::String((*name).to_owned()));
            details.insert(
                (*name).to_owned(),
                serde_json::json!({ "from": from, "to": to }),
            );
        }
    }
    for (name, did_change) in hidden {
        if *did_change {
            changed.push(Value::String((*name).to_owned()));
        }
    }
    if changed.is_empty() {
        return None;
    }
    details.insert("changed".to_owned(), Value::Array(changed));
    Some(Value::Object(details))
}

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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{update_details, update_details_hiding};

    #[test]
    fn hidden_fields_are_named_without_their_values() {
        assert_eq!(
            update_details_hiding(
                &[("name", json!("Анна"), json!("Анна Петрова"))],
                &[("pinPhc", true)]
            ),
            Some(json!({
                "changed": ["name", "pinPhc"],
                "name": { "from": "Анна", "to": "Анна Петрова" },
            }))
        );
        assert_eq!(
            update_details_hiding(&[], &[("pinPhc", true)]),
            Some(json!({ "changed": ["pinPhc"] }))
        );
        assert_eq!(
            update_details_hiding(
                &[("name", json!("Анна"), json!("Анна"))],
                &[("pinPhc", false)]
            ),
            None
        );
    }

    #[test]
    fn update_details_lists_changed_fields_with_their_values() {
        let details = update_details(&[
            ("name", json!("Старое"), json!("Новое")),
            ("role", json!("admin"), json!("admin")),
            ("active", json!(true), json!(false)),
        ]);
        assert_eq!(
            details,
            Some(json!({
                "changed": ["name", "active"],
                "name": { "from": "Старое", "to": "Новое" },
                "active": { "from": true, "to": false },
            }))
        );
    }

    #[test]
    fn update_details_is_none_when_nothing_changed() {
        assert_eq!(
            update_details(&[("name", json!("Та же"), json!("Та же"))]),
            None
        );
    }
}
