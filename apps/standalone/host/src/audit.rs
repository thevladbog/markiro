//! Audit trail of office actions, pairing and initialization (spec §4.9).
//! `details` never contains PINs, passwords, keys, tokens, salts or hashes.

use serde_json::Value;
use sqlx::SqliteConnection;

/// Action names of `audit_log.action`. A new writer adds its name here, so
/// the audit screen (plan 5) translates one list.
pub mod actions {
    pub const HOST_BOOTSTRAP: &str = "host.bootstrap";
    pub const HOST_NETWORK_CONFIRM: &str = "host_network.confirm";
    /// `markiro-host restore` put a copy back (plan РК); the host is the
    /// actor.
    pub const HOST_RESTORE: &str = "host.restore";
    /// An administrator resumed the stations' facts a restore held.
    pub const HOST_RESTORE_RESUME: &str = "host.restore.resume";
    /// The host copied its database before this build's pending migrations
    /// (plan ОБН-1); `failed` when the copy or the migrations failed. The
    /// host is the actor, the copy its target.
    pub const HOST_UPGRADE: &str = "host.upgrade";
    /// The office started an installer on its PC (plan ОБН-2): the session's
    /// device is the target, and the row records what the office reported,
    /// as `shift.export` does.
    pub const APP_UPDATE_START: &str = "app.update.start";
    /// An administrator uploaded an update package; the host keeps it as
    /// `staged\` until it runs that version (plan ОБН-3).
    pub const UPDATE_PACKAGE_STAGE: &str = "update.package.stage";
    /// The host made the staged package current at its start or hourly; at
    /// its start also `failed` for a current package that is not of its
    /// version or does not check out (plan ОБН-3). The host is the actor.
    pub const UPDATE_PACKAGE_PROMOTE: &str = "update.package.promote";
    /// A device began downloading the installer from byte 0; a resumed
    /// download writes none (plan ОБН-3).
    pub const UPDATE_DOWNLOAD: &str = "update.download";
    pub const DEVICE_LOCAL_PAIR: &str = "device.local_pair";
    pub const OFFICE_LOGIN: &str = "office.login";
    pub const OFFICE_LOGOUT: &str = "office.logout";
    pub const OFFICE_USER_CREATE: &str = "office_user.create";
    pub const OFFICE_USER_UPDATE: &str = "office_user.update";
    /// An administrator set someone's password, or a user changed their own
    /// (then `actor_id == target_id`).
    pub const OFFICE_USER_PASSWORD: &str = "office_user.password";
    /// An office user's photo set or replaced (their own, plan АВА), and
    /// cleared (their own, or an administrator's of someone else's: the actor
    /// and the target tell which); the details name the size, never the picture.
    pub const OFFICE_USER_AVATAR_SET: &str = "office_user.avatar.set";
    pub const OFFICE_USER_AVATAR_CLEAR: &str = "office_user.avatar.clear";
    pub const ORG_UPDATE: &str = "org.update";
    pub const SSCC_COUNTER_UPDATE: &str = "sscc.counter.update";
    pub const SSCC_BLOCK_SIZES_UPDATE: &str = "sscc.block_sizes.update";
    pub const PAIRING_CODE_CREATE: &str = "pairing_code.create";
    pub const DEVICE_CLAIM: &str = "device.claim";
    /// A device paired again with its own `deviceId` (plan ТСД-Х, task Х6).
    pub const DEVICE_REKEY: &str = "device.rekey";
    pub const DEVICE_LINE: &str = "device.line";
    pub const COUNTERPARTY_CREATE: &str = "counterparty.create";
    pub const COUNTERPARTY_UPDATE: &str = "counterparty.update";
    pub const LINE_CREATE: &str = "line.create";
    pub const LINE_UPDATE: &str = "line.update";
    /// An administrator changed a line's limit of devices in one shift (plan 2b): `{ from, to }`.
    /// A name or archive change in the same request writes its own `line.update`.
    pub const LINE_MAX_STATIONS_CHANGED: &str = "line.max_stations_changed";
    pub const OPERATOR_CREATE: &str = "operator.create";
    pub const OPERATOR_UPDATE: &str = "operator.update";
    pub const OPERATOR_BADGE_CREATE: &str = "operator_badge.create";
    pub const OPERATOR_BADGE_REVOKE: &str = "operator_badge.revoke";
    /// An employee of the site's register (migration `0018`); linking and
    /// unlinking an operator are updates of its `operatorId`.
    pub const EMPLOYEE_CREATE: &str = "employee.create";
    pub const EMPLOYEE_UPDATE: &str = "employee.update";
    pub const DEVICE_UPDATE: &str = "device.update";
    pub const DEVICE_REVOKE: &str = "device.revoke";
    pub const PRODUCT_CREATE: &str = "product.create";
    pub const PRODUCT_UPDATE: &str = "product.update";
    /// A product's photo set or replaced, and cleared (plan ТОВ); the
    /// details name the size, never the bytes.
    pub const PRODUCT_PHOTO_SET: &str = "product.photo.set";
    pub const PRODUCT_PHOTO_CLEAR: &str = "product.photo.clear";
    pub const TEMPLATE_CREATE: &str = "template.create";
    pub const TEMPLATE_UPDATE: &str = "template.update";
    pub const TEMPLATE_DELETE: &str = "template.delete";
    pub const TEMPLATE_DEFAULTS_UPDATE: &str = "template_defaults.update";
    pub const ORG_LOGO_SET: &str = "org.logo.set";
    pub const ORG_LOGO_CLEAR: &str = "org.logo.clear";
    pub const PALLET_SHEET_CREATE: &str = "pallet_sheet.create";
    pub const PALLET_SHEET_UPDATE: &str = "pallet_sheet.update";
    pub const PALLET_SHEET_DELETE: &str = "pallet_sheet.delete";
    pub const PALLET_SHEET_DEFAULT: &str = "pallet_sheet.default";
    /// A shift planned in the office or created at a station.
    pub const SHIFT_CREATE: &str = "shift.create";
    pub const SHIFT_UPDATE: &str = "shift.update";
    pub const SHIFT_DELETE: &str = "shift.delete";
    /// «Удалить демо-данные» (spec 2026-10-21): the demo product and all its shifts made.
    pub const DEMO_DATA_DELETE: &str = "demo_data.delete";
    /// A station opened a planned shift: its snapshot is frozen.
    pub const SHIFT_OPEN: &str = "shift.open";
    /// A device became a participant of an open shift it did not open, or came back to it after
    /// it left (plan 2b): `{ number, rejoined }`; the device is the actor. An active
    /// participant's entry again writes none.
    pub const SHIFT_JOIN: &str = "shift.join";
    /// A participant paused its part and freed its slot (plan 2b): `{ number }`; the device is
    /// the actor. A leave repeated writes none.
    pub const SHIFT_LEAVE: &str = "shift.leave";
    /// A shift closed by the close of its last participant (a station's or a handheld's close is
    /// a fact, plan 2a2; plan 2b: a shared shift's row adds `participants`, `acceptedTotal`,
    /// `reasonMissing`). The office's close writes `shift.force_closed` since plan 2b.
    pub const SHIFT_CLOSE: &str = "shift.close";
    /// A participant closed its part while another still works the shift (plan 2b): `{ number,
    /// actualQty, closedBoxCount, reasonCode }`; the device is the actor. The close of the last
    /// part writes `shift.close` instead.
    pub const SHIFT_PART_CLOSED: &str = "shift.part_closed";
    /// The office closed an active shift whole (plan 2b; `shift.close` before it): every part
    /// still open closed as the office's; `{ reason, notClosed: [{ deviceId, state }] }`.
    pub const SHIFT_FORCE_CLOSED: &str = "shift.force_closed";
    /// The office gave the reason a shift its devices closed without lacked (plan 2b, spec
    /// §12.9): `{ reasonCode }`.
    pub const SHIFT_CLOSE_REASON: &str = "shift.close_reason";
    /// A station got a block of SSCC serials.
    pub const SSCC_BLOCK_ISSUE: &str = "sscc.block.issue";
    /// The cloud's data moved into this site (plan IMP); the row holds the
    /// import's summary, which a repeat of the same import answers with.
    pub const IMPORT_CLOUD: &str = "import.cloud";
    pub const IMPORT_CLOUD_HISTORY_PART: &str = "import.cloud_history.part";
    pub const IMPORT_CLOUD_HISTORY_COMPLETE: &str = "import.cloud_history.complete";
    pub const IMPORT_CLOUD_HISTORY_CANCEL: &str = "import.cloud_history.cancel";
    /// The office saved the files of a shift's or a pallet's export (plan
    /// ЧЗ); nothing else changed.
    pub const SHIFT_EXPORT: &str = "shift.export";
    /// The office stored a file it generated on the host (migration `0029`):
    /// a part of an export, a disaggregation file or a printed form. The
    /// target is what the file belongs to; the details name the file, never
    /// its bytes.
    pub const SHIFT_EXPORT_STORE: &str = "shift.export.store";
    /// A stored file was downloaded again; `failed` (with `reason`
    /// `corrupted`) when its bytes no longer matched their SHA-256 and the
    /// host served nothing.
    pub const SHIFT_EXPORT_DOWNLOAD: &str = "shift.export.download";
    /// Stored files deleted by the retention setting; the details count them.
    pub const SHIFT_EXPORT_PURGE: &str = "shift.export.purge";
    /// An administrator changed how long stored files are kept.
    pub const SHIFT_EXPORT_RETENTION: &str = "shift.export.retention";
    /// The office marked a code conflict reviewed (plan КНФ); the details name
    /// its kind, the losing shift and device and the winning shift, never the
    /// code or its hash. A conflict reviewed already writes no row.
    pub const CONFLICT_REVIEW: &str = "conflict.review";
    /// The office's disaggregation reasons (plan ДЗГ); a change that changes
    /// nothing writes no row.
    pub const DISAGGREGATION_REASON_CREATE: &str = "disaggregation_reason.create";
    pub const DISAGGREGATION_REASON_UPDATE: &str = "disaggregation_reason.update";
    /// The office's disaggregation documents (plan ДЗГ); the target is the
    /// document.
    pub const DISAGGREGATION_CREATE: &str = "disaggregation.create";
    pub const DISAGGREGATION_UPDATE: &str = "disaggregation.update";
    pub const DISAGGREGATION_LINES_ADD: &str = "disaggregation.lines.add";
    pub const DISAGGREGATION_LINE_DELETE: &str = "disaggregation.lines.delete";
    /// `ok` with what the apply took apart, `failed` when a line was not `ok`.
    pub const DISAGGREGATION_APPLY: &str = "disaggregation.apply";
    pub const DISAGGREGATION_CANCEL: &str = "disaggregation.cancel";
    /// The office saved a document's ЧЗ file «Расформирование упаковки» and
    /// recorded it (plan ДЗГ-О): no data changed, as `shift.export`.
    pub const DISAGGREGATION_EXPORT: &str = "disaggregation.export";
    /// After a restore, a station gave the host back a block the copy had
    /// lost (plan РК).
    pub const SSCC_BLOCK_REGISTER: &str = "sscc.block.register";
    /// A copy of the database, scheduled (the host's) or asked for in the
    /// office (plan РК); `failed` when a folder did not get it.
    pub const BACKUP_CREATE: &str = "backup.create";
    pub const BACKUP_YANDEX_CONNECT: &str = "backup.yandex.connect";
    pub const BACKUP_YANDEX_DISCONNECT: &str = "backup.yandex.disconnect";
    pub const BACKUP_YANDEX_UPLOAD: &str = "backup.yandex.upload";
    pub const BACKUP_YANDEX_PURGE: &str = "backup.yandex.purge";
    /// An administrator set or cleared the second folder of copies.
    pub const BACKUP_SETTINGS_UPDATE: &str = "backup.settings.update";
    /// An administrator loaded a license file (plan ЛЦ-2); `denied` for a
    /// file the host refused, with its reason: unlike other refused office
    /// writes, a foreign or forged file is an event for the log.
    pub const LICENSE_LOAD: &str = "license.load";
    /// The license state changed (the host is the actor): a phase that ended
    /// by time, a file, the organization's INN.
    pub const LICENSE_STATE: &str = "license.state";
    /// An administrator opened new shifts for 72 hours more (spec §3.5).
    pub const LICENSE_EMERGENCY: &str = "license.emergency";
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
    /// A code made for one device was claimed for another, or without a device, or the reverse.
    pub const RECOVERY_MISMATCH: &str = "recovery_mismatch";
    pub const CODE_USED: &str = "code_used";
    pub const TOO_MANY_ATTEMPTS: &str = "too_many_attempts";
    pub const CODE_EXPIRED: &str = "code_expired";
    /// A refused license file (plan ЛЦ-2, spec §4.3), as the answer names it.
    pub const LICENSE_MALFORMED: &str = markiro_proto::license::refusals::MALFORMED;
    pub const LICENSE_UNKNOWN_KEY: &str = markiro_proto::license::refusals::UNKNOWN_KEY;
    pub const LICENSE_SIGNATURE: &str = markiro_proto::license::refusals::SIGNATURE;
    pub const LICENSE_WRONG_HOST: &str = markiro_proto::license::refusals::WRONG_HOST;
    pub const LICENSE_INN_MISMATCH: &str = markiro_proto::license::refusals::INN_MISMATCH;
    pub const LICENSE_INN_MISSING: &str = markiro_proto::license::refusals::INN_MISSING;
    pub const LICENSE_OLDER: &str = markiro_proto::license::refusals::OLDER;
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
