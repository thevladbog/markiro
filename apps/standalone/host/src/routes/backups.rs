//! Backups in the office (plan РК): `GET /v1/office/backups` (every role:
//! the state of both folders), `POST /v1/office/backups` (administrators:
//! «Сделать копию сейчас», answered at once with `202`; the worker makes the
//! copy, and the office reads the state again until nothing runs) and
//! `PUT /v1/office/backups/settings` (administrators: the second folder,
//! with `expectedRev`) and `POST /v1/office/backups/resume` (administrators:
//! end the hold of the stations' facts a restore set). A folder is tried
//! before it is saved, outside the write lock and for at most
//! [`PROBE_TIMEOUT`]: a share on a computer that is off can take much longer
//! to fail than the office waits.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::backup::{
    dir_problems, BackupSettingsUpdate, BackupState, RestoreHold, RestoreHoldStation,
};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::backup::{folder, Backups};
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

/// How long trying a folder may take; the office gives up after 10 s.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// The longest folder path the settings keep (the table's CHECK).
const MAX_DIR_CHARS: usize = 260;

fn backups(state: &AppState) -> Result<&Arc<Backups>, ApiError> {
    state
        .backups
        .as_ref()
        .ok_or_else(|| ApiError::not_found("this host keeps no copies"))
}

async fn read_settings(conn: &mut SqliteConnection) -> Result<(Option<String>, i64), ApiError> {
    sqlx::query_as("SELECT second_dir, rev FROM backup_settings WHERE id = 1")
        .fetch_one(conn)
        .await
        .map_err(ApiError::internal)
}

/// The hold a restore set, with every unrevoked station and whether it sent
/// its blocks back for the current epoch; `None` without a hold.
async fn read_hold(conn: &mut SqliteConnection) -> Result<Option<RestoreHold>, ApiError> {
    let (since, epoch): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT facts_held_since, restore_epoch FROM site WHERE id = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    let Some(since) = since else {
        return Ok(None);
    };
    // A restore sets both; an epoch missing beside a hold matches no station.
    let epoch = epoch.unwrap_or_default();
    let stations: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, last_seen_at, known_blocks_epoch FROM devices \
         WHERE kind = 'station' AND revoked_at IS NULL ORDER BY name, id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let stations = stations
        .into_iter()
        .map(|(id, name, last_seen_at, known)| RestoreHoldStation {
            id,
            name,
            last_seen_at,
            reconciled: !epoch.is_empty() && known.as_deref() == Some(epoch.as_str()),
        })
        .collect();
    Ok(Some(RestoreHold {
        since,
        epoch,
        stations,
    }))
}

/// The state as the office reads it: the worker's folders, the settings and
/// the hold, read through `conn`.
async fn answer(
    conn: &mut SqliteConnection,
    backups: &Backups,
    now: String,
) -> Result<BackupState, ApiError> {
    let (second_dir, rev) = read_settings(&mut *conn).await?;
    let mut state = backups.state(now, second_dir, rev);
    state.restore_hold = read_hold(conn).await?;
    Ok(state)
}

pub async fn get_backups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<BackupState>, ApiError> {
    let backups = backups(&state)?;
    // One snapshot for the settings and the hold; nothing is written.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let answered = answer(&mut tx, backups, state.timestamp()).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    answered.map(Json)
}

pub async fn start_backup(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<(StatusCode, Json<BackupState>), ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    // The settings and the hold are read before the copy is asked for: a
    // read that fails answers 500 with no copy queued behind it. The state
    // is then built from memory, which cannot fail.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        let settings = read_settings(&mut tx).await?;
        let hold = read_hold(&mut tx).await?;
        Ok::<_, ApiError>((settings, hold))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let ((second_dir, rev), hold) = read?;
    if !backups.request_manual(&context.user.id, state.now()) {
        return Err(ApiError::conflict(
            "backup_running",
            "a copy is being made already",
        ));
    }
    let mut answered = backups.state(state.timestamp(), second_dir, rev);
    answered.restore_hold = hold;
    Ok((StatusCode::ACCEPTED, Json(answered)))
}

/// The folder as typed, trimmed: 1-260 characters, no control character,
/// an absolute path (a drive path or a share, `\\PC\Share`) with no `..`
/// part, and not in the Windows verbatim or device namespaces (`\\?\`,
/// `\\.\`), which skip the checks of the ordinary path syntax. Nothing of
/// the text is echoed back.
fn second_dir(text: &str) -> Result<String, ApiError> {
    let text = text.trim();
    let count = text.chars().take(MAX_DIR_CHARS + 1).count();
    if !(1..=MAX_DIR_CHARS).contains(&count) || text.chars().any(char::is_control) {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must be 1-260 characters without control characters",
        ));
    }
    if !Path::new(text).is_absolute() {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must be an absolute path",
        ));
    }
    // Both separators on every platform: the text is the administrator's, and
    // a host path on one system can be written in the other's syntax.
    let slashed = text.replace('\\', "/");
    if slashed.split('/').any(|part| part == "..") {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must not contain a .. part",
        ));
    }
    if slashed.starts_with("//?/") || slashed.starts_with("//./") {
        return Err(ApiError::validation(
            "secondDir",
            "the folder must be a drive path or a share, not a device path",
        ));
    }
    Ok(text.to_owned())
}

/// Try `dir` off the async threads, for at most [`PROBE_TIMEOUT`]; a folder
/// that cannot take copies is a `conflict` on `backup_dir` with
/// `details.reason`.
async fn probe(dir: &str, data_dir: &Path) -> Result<(), ApiError> {
    let (dir, data_dir) = (dir.to_owned(), data_dir.to_path_buf());
    probe_within(PROBE_TIMEOUT, move || {
        folder::probe(Path::new(&dir), &data_dir)
    })
    .await
}

/// `work` (the folder trial) on a blocking thread, abandoned after `limit`.
/// The thread cannot be stopped; it ends with the OS call and removes its own
/// probe file.
async fn probe_within<F>(limit: Duration, work: F) -> Result<(), ApiError>
where
    F: FnOnce() -> Result<(), &'static str> + Send + 'static,
{
    let probed = tokio::time::timeout(limit, tokio::task::spawn_blocking(work)).await;
    let problem = match probed {
        Ok(Ok(Ok(()))) => return Ok(()),
        Ok(Ok(Err(problem))) => problem,
        Ok(Err(error)) => return Err(ApiError::internal(error)),
        Err(_) => dir_problems::TIMEOUT,
    };
    Err(
        ApiError::conflict("backup_dir", "the folder cannot take copies")
            .with_details(json!({ "constraint": "backup_dir", "reason": problem })),
    )
}

pub async fn put_settings(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<BackupSettingsUpdate>,
) -> Result<Json<BackupState>, ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    let wanted = update.second_dir.as_deref().map(second_dir).transpose()?;
    if let Some(dir) = &wanted {
        probe(dir, &backups.data_dir).await?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let (current, rev) = read_settings(&mut tx).await?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    if current == wanted {
        // Nothing changes: no revision, no row, no audit; the transaction
        // rolls back when dropped.
        return answer(&mut tx, backups, at).await.map(Json);
    }
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE backup_settings SET second_dir = ?, rev = ? WHERE id = 1")
        .bind(&wanted)
        .bind(new_rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::BACKUP_SETTINGS_UPDATE,
            target_type: Some("backup_settings"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: audit::update_details(&[("secondDir", json!(current), json!(wanted))])
                .unwrap_or_else(|| json!({ "changed": [] })),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // Read through the transaction before the commit releases the lock.
    let answered = answer(&mut tx, backups, at).await?;
    commit_with_revision(tx, &state.revisions, new_rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(answered))
}

/// End the hold a restore set: the stations' facts and code checks are
/// answered again. Whether every station gave its blocks back first is the
/// administrator's call (a station on a dead computer never will); the
/// answer and the audit row say how many did. Resuming without a hold
/// changes nothing and writes no row. Devices and the hold are no feed data:
/// no revision.
pub async fn resume_facts(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<BackupState>, ApiError> {
    context.require_admin()?;
    let backups = backups(&state)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let Some(hold) = read_hold(&mut tx).await? else {
        return answer(&mut tx, backups, at).await.map(Json);
    };
    sqlx::query("UPDATE site SET facts_held_since = NULL WHERE id = 1")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let reconciled = hold.stations.iter().filter(|each| each.reconciled).count();
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::HOST_RESTORE_RESUME,
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "since": hold.since,
                "epoch": hold.epoch,
                "stations": hold.stations.len(),
                "reconciled": reconciled,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let answered = answer(&mut tx, backups, at).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(answered))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_folder_that_does_not_answer_in_time_is_a_timeout_not_a_hang() {
        let started = std::time::Instant::now();
        let error = probe_within(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(1500));
            Ok(())
        })
        .await
        .unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(1000));
        assert_eq!(
            (error.status(), error.code()),
            (StatusCode::CONFLICT, "conflict")
        );
        let details = error.details().unwrap();
        assert_eq!(details["constraint"], json!("backup_dir"));
        assert_eq!(details["reason"], json!(dir_problems::TIMEOUT));
    }

    #[tokio::test]
    async fn a_folder_that_answers_is_taken_as_it_answers() {
        probe_within(PROBE_TIMEOUT, || Ok(())).await.unwrap();
        let error = probe_within(PROBE_TIMEOUT, || Err(dir_problems::UNWRITABLE))
            .await
            .unwrap_err();
        assert_eq!(
            error.details().unwrap()["reason"],
            json!(dir_problems::UNWRITABLE)
        );
        let panicked = probe_within(PROBE_TIMEOUT, || panic!("the probe broke"))
            .await
            .unwrap_err();
        assert_eq!(panicked.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// An absolute folder where the test runs: a drive path on Windows (where
    /// `/srv` is relative to the current drive), a root path elsewhere.
    #[cfg(windows)]
    const ROOT: &str = r"C:\srv";
    #[cfg(not(windows))]
    const ROOT: &str = "/srv";

    #[test]
    fn the_folder_text_is_trimmed_and_checked_without_being_echoed() {
        assert_eq!(
            second_dir(&format!("  {ROOT}/copies \n")).unwrap(),
            format!("{ROOT}/copies")
        );
        for text in [
            String::new(),
            "relative/copies".to_owned(),
            format!("{ROOT}/../etc"),
            format!("{ROOT}/copies/.."),
            format!("{ROOT}\\..\\etc"),
            "//?/C:/copies".to_owned(),
            "//./PhysicalDrive0".to_owned(),
            format!("{ROOT}/co\u{0}pies"),
        ] {
            let error = second_dir(&text).unwrap_err();
            assert_eq!(error.code(), "validation_failed", "{text:?}");
            assert_eq!(error.details().unwrap()["field"], json!("secondDir"));
            assert!(
                !error.message().contains("srv") && !error.message().contains("PhysicalDrive"),
                "the message must not echo the text"
            );
        }
        // 260 characters in all, the root included.
        let longest = format!("{ROOT}/{}", "x".repeat(260 - ROOT.len() - 1));
        assert_eq!(longest.chars().count(), 260);
        assert!(second_dir(&longest).is_ok());
        assert!(second_dir(&format!("{longest}x")).is_err());
        assert!(
            second_dir(&format!("{ROOT}/a..b/copies")).is_ok(),
            "only a whole .. part"
        );
    }

    /// A Windows host refuses a rooted path without a drive or a share: the
    /// copies would land on whichever drive the service runs from.
    #[cfg(windows)]
    #[test]
    fn a_rooted_path_without_a_drive_is_not_absolute_on_windows() {
        let error = second_dir("/srv/copies").unwrap_err();
        assert_eq!(error.message(), "the folder must be an absolute path");
        assert!(second_dir(r"\\PC\Share\copies").is_ok());
    }
}
