//! The host's copies on a schedule and on request (plan РК). One worker
//! task makes every copy, one at a time, on a connection of its own:
//!
//! - every minute it asks whether a scheduled copy is due: at most one an
//!   hour (UTC), made in the first minute of the hour in which the
//!   database changed since the last good copy (`PRAGMA data_version` of
//!   the worker's connection, which only other connections move, so the
//!   worker's own audit row does not count), or in which there is no copy
//!   of today (UTC) yet, changed or not;
//! - «Сделать копию сейчас» ([`Backups::request_manual`]) wakes it at once.
//!
//! A run makes the local copy (`copy::make_copy`), keeps the local folder
//! to the retention rule, copies the new copy into the second folder when
//! one is set, writes one `backup.create` audit row and puts the outcome
//! of each folder into the status the office reads. A failure is in that
//! status and in the audit row, never only in the process log; the next
//! hour tries again. A run is a task of its own: a panic in it is the
//! run's `internal` failure, and the worker goes on.
//!
//! Nothing here runs beside a copy: the worker is one task, a run is awaited
//! to its end, and it is the only caller of `folder::clean` (before each
//! copy, in both folders), so the cleaning never meets a copy being
//! written. The folders are rotated only after a verified copy has joined
//! them. The schedule follows the host clock, which the tests move; a clock
//! that goes back starts the schedule over without a copy of its own. A
//! restarted host reads the manifests of its folders and copies at once.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use markiro_proto::backup::{
    failure, BackupAttempt, BackupCopy, BackupDestination, BackupRunning, BackupState,
    BackupTrigger,
};
use serde_json::json;
use sqlx::{ConnectOptions, Connection, SqliteConnection};
use time::OffsetDateTime;
use tokio::sync::{watch, Notify};
use tokio::task::JoinHandle;

use super::copy::{make_copy, Failure, Manifest};
use super::folder;
use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::clock::{format_timestamp, parse_timestamp, Clock};
use crate::config::HostPaths;

/// How often the worker asks whether a scheduled copy is due.
pub const TICK: Duration = Duration::from_secs(60);
/// The office lists at most this many copies of a folder.
const LISTED: usize = 50;

#[derive(Debug, Clone)]
struct FolderStatus {
    dir: String,
    last_attempt: Option<BackupAttempt>,
    copies: Vec<BackupCopy>,
}

impl FolderStatus {
    fn new(dir: String) -> Self {
        Self {
            dir,
            last_attempt: None,
            copies: Vec::new(),
        }
    }

    fn destination(&self) -> BackupDestination {
        BackupDestination {
            dir: self.dir.clone(),
            last_attempt: self.last_attempt.clone(),
            copies: self.copies.clone(),
        }
    }
}

#[derive(Debug)]
struct Status {
    running: Option<BackupRunning>,
    /// The office user whose «Сделать копию сейчас» waits for the worker;
    /// `running` is set with it, so `running` alone says whether a copy runs
    /// or waits.
    pending_manual: Option<String>,
    local: FolderStatus,
    /// Keyed by the folder as the settings name it.
    second: Option<FolderStatus>,
}

/// The copies' shared state: what the office reads and how it asks for a
/// copy. The worker task ([`spawn`]) makes the copies.
pub struct Backups {
    pub data_dir: PathBuf,
    pub local_dir: PathBuf,
    pub db_path: PathBuf,
    pub host_id: String,
    status: Mutex<Status>,
    wake: Notify,
}

fn listed(copies: &[Manifest]) -> Vec<BackupCopy> {
    copies.iter().take(LISTED).map(Manifest::copy).collect()
}

impl Backups {
    pub fn new(
        data_dir: PathBuf,
        local_dir: PathBuf,
        db_path: PathBuf,
        host_id: impl Into<String>,
    ) -> Arc<Self> {
        let local = FolderStatus::new(local_dir.display().to_string());
        Arc::new(Self {
            data_dir,
            local_dir,
            db_path,
            host_id: host_id.into(),
            status: Mutex::new(Status {
                running: None,
                pending_manual: None,
                local,
                second: None,
            }),
            wake: Notify::new(),
        })
    }

    /// The host's own folders: `<data dir>/backups` and `<data dir>/host.db`.
    pub fn from_paths(paths: &HostPaths, host_id: impl Into<String>) -> Arc<Self> {
        Self::new(
            paths.data_dir.clone(),
            paths.backups_dir(),
            paths.database_file(),
            host_id,
        )
    }

    fn status(&self) -> std::sync::MutexGuard<'_, Status> {
        // A panic while the lock was held leaves plain data behind; the
        // status stays readable.
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// «Сделать копию сейчас» of the office user `user_id`: `false` while a
    /// copy runs or waits already (nothing changes then).
    pub fn request_manual(&self, user_id: &str, at: OffsetDateTime) -> bool {
        let mut status = self.status();
        if status.running.is_some() {
            return false;
        }
        status.running = Some(BackupRunning {
            trigger: BackupTrigger::Manual,
            started_at: format_timestamp(at),
        });
        status.pending_manual = Some(user_id.to_owned());
        drop(status);
        self.wake.notify_one();
        true
    }

    /// What `GET /v1/office/backups` answers. `second_dir` and `settings_rev`
    /// come from the settings row: a folder the worker has not tried since it
    /// was set shows no attempt and no copies yet.
    pub fn state(&self, now: String, second_dir: Option<String>, settings_rev: i64) -> BackupState {
        let status = self.status();
        let second = second_dir.map(|dir| match &status.second {
            Some(known) if known.dir == dir => known.destination(),
            _ => FolderStatus::new(dir).destination(),
        });
        BackupState {
            now,
            local: status.local.destination(),
            second,
            settings_rev,
            running: status.running.clone(),
            // The hold lives in the database; the office's routes read it.
            restore_hold: None,
        }
    }

    /// The newest verified local copy's time.
    fn newest_local(&self) -> Option<OffsetDateTime> {
        let status = self.status();
        status
            .local
            .copies
            .first()
            .and_then(|copy| parse_timestamp(&copy.created_at).ok())
    }

    /// Mark a scheduled copy as running: `false` if another runs or waits.
    fn begin_scheduled(&self, at: OffsetDateTime) -> bool {
        let mut status = self.status();
        if status.running.is_some() {
            return false;
        }
        status.running = Some(BackupRunning {
            trigger: BackupTrigger::Scheduled,
            started_at: format_timestamp(at),
        });
        true
    }

    fn take_manual(&self) -> Option<String> {
        self.status().pending_manual.take()
    }
}

/// Whether a scheduled copy is due at `now`: the data changed since the last
/// good copy, or the newest copy is not of today (UTC). The hour slot is the
/// caller's.
pub fn scheduled_due(changed: bool, newest: Option<OffsetDateTime>, now: OffsetDateTime) -> bool {
    changed || newest.is_none_or(|at| at.date() != now.date())
}

/// What one run did.
#[derive(Debug, Clone)]
pub struct RunReport {
    pub trigger: BackupTrigger,
    pub local: Result<Manifest, Failure>,
    /// `None` without a second folder.
    pub second: Option<Result<(), Failure>>,
}

/// The worker's connection: the master database without migrations (the
/// pool ran them), with the pool's pragmas.
async fn connect(db_path: &Path) -> Result<SqliteConnection, sqlx::Error> {
    crate::db::options(db_path)
        .create_if_missing(false)
        .connect()
        .await
}

async fn data_version(conn: &mut SqliteConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("PRAGMA data_version")
        .fetch_one(conn)
        .await
}

/// Makes the copies; see the module documentation.
pub struct Worker {
    backups: Arc<Backups>,
    clock: Arc<dyn Clock>,
    conn: Option<SqliteConnection>,
    /// `PRAGMA data_version` read before the last good local copy.
    copied_version: Option<i64>,
    /// The UTC hour (`unix time / 3600`) of the last scheduled run.
    last_hour: Option<i64>,
    /// The host clock's reading at the last scheduled run (or at the last
    /// time the clock was seen to go back).
    last_run: Option<OffsetDateTime>,
}

impl Worker {
    pub fn new(backups: Arc<Backups>, clock: Arc<dyn Clock>) -> Self {
        Self {
            backups,
            clock,
            conn: None,
            copied_version: None,
            last_hour: None,
            last_run: None,
        }
    }

    async fn conn(&mut self) -> Result<&mut SqliteConnection, sqlx::Error> {
        if self.conn.is_none() {
            self.conn = Some(connect(&self.backups.db_path).await?);
        }
        Ok(self.conn.as_mut().expect("just opened"))
    }

    async fn second_dir(&mut self) -> Result<Option<String>, sqlx::Error> {
        let conn = self.conn().await?;
        sqlx::query_scalar("SELECT second_dir FROM backup_settings WHERE id = 1")
            .fetch_one(conn)
            .await
    }

    /// Read both folders into the status (at start, before any copy). A
    /// folder that cannot be read lists nothing.
    pub async fn scan(&mut self) {
        let second_dir = match self.second_dir().await {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!(%error, "reading the backup settings failed");
                None
            }
        };
        let local_dir = self.backups.local_dir.clone();
        let second = second_dir.clone();
        let listed = tokio::task::spawn_blocking(move || {
            let local = folder::list(&local_dir).map(|copies| listed(&copies));
            let second =
                second.map(|dir| folder::list(Path::new(&dir)).map(|copies| listed(&copies)));
            (local, second)
        })
        .await;
        let Ok((local, second)) = listed else { return };
        let mut status = self.backups.status();
        status.local.copies = local.unwrap_or_default();
        status.second = second_dir.map(|dir| FolderStatus {
            dir,
            last_attempt: None,
            copies: second.and_then(Result::ok).unwrap_or_default(),
        });
    }

    /// A scheduled copy if one is due ([`scheduled_due`]) and nothing else
    /// runs; `None` otherwise.
    pub async fn tick(&mut self) -> Option<RunReport> {
        let now = self.clock.now();
        let hour = now.unix_timestamp().div_euclid(3600);
        if self.last_run.is_some_and(|last| now < last) {
            // The host clock went back (set by hand, corrected by the time
            // service). The hour it shows now is taken as already served:
            // the schedule starts over from here, so a change of the clock
            // never makes a copy of its own, and the next hour is the next
            // slot.
            tracing::warn!("the host clock went back; the backup schedule starts over");
            self.last_run = Some(now);
            self.last_hour = Some(hour);
            return None;
        }
        if self.last_hour == Some(hour) {
            return None;
        }
        let version = match self.conn().await {
            Ok(conn) => data_version(conn).await.ok(),
            Err(_) => None,
        };
        let changed = version.is_none() || version != self.copied_version;
        if !scheduled_due(changed, self.backups.newest_local(), now) {
            return None;
        }
        if !self.backups.begin_scheduled(now) {
            return None;
        }
        self.last_hour = Some(hour);
        self.last_run = Some(now);
        Some(self.run(BackupTrigger::Scheduled, None, now).await)
    }

    /// The copy an office user asked for, if one waits.
    pub async fn run_manual(&mut self) -> Option<RunReport> {
        let user = self.backups.take_manual()?;
        let now = self.clock.now();
        Some(self.run(BackupTrigger::Manual, Some(user), now).await)
    }

    async fn run(
        &mut self,
        trigger: BackupTrigger,
        user: Option<String>,
        at: OffsetDateTime,
    ) -> RunReport {
        let conn = self.conn.take();
        let backups = self.backups.clone();
        let task = tokio::spawn(run_once(backups, conn, trigger, at));
        let (conn, version, report) = match task.await {
            Ok(done) => done,
            Err(error) => {
                tracing::error!(panicked = error.is_panic(), "a backup run did not finish");
                let failed = Failure::new(failure::INTERNAL, "the run did not finish");
                (None, None, failed_report(trigger, failed))
            }
        };
        self.conn = conn;
        if report.local.is_ok() {
            self.copied_version = version;
        }
        self.record(&report, user.as_deref(), at).await;
        self.finish(&report, at);
        report
    }

    fn finish(&self, report: &RunReport, at: OffsetDateTime) {
        let attempt = |result: Result<(), &Failure>| BackupAttempt {
            at: format_timestamp(at),
            trigger: report.trigger,
            ok: result.is_ok(),
            code: result.err().map(|failure| failure.code.to_owned()),
        };
        let mut status = self.backups.status();
        status.running = None;
        status.local.last_attempt = Some(attempt(report.local.as_ref().map(|_| ())));
        if let (Some(second), Some(result)) = (status.second.as_mut(), report.second.as_ref()) {
            second.last_attempt = Some(attempt(result.as_ref().map(|_| ())));
        }
    }

    /// One `backup.create` row: the scheduled copy's actor is the host, a
    /// manual one's the office user who asked. Only the outcome of each
    /// folder, never a detail of an error.
    async fn record(&mut self, report: &RunReport, user: Option<&str>, at: OffsetDateTime) {
        let outcome = |result: Result<(), &Failure>| match result {
            Ok(()) => json!({ "ok": true, "code": null }),
            Err(failure) => json!({ "ok": false, "code": failure.code }),
        };
        let manifest = report.local.as_ref().ok();
        let file = manifest.map(|manifest| manifest.file.clone());
        let ok = report.local.is_ok() && report.second.as_ref().is_none_or(Result::is_ok);
        let details = json!({
            "trigger": report.trigger,
            "file": file,
            "sizeBytes": manifest.map(|manifest| manifest.size_bytes),
            "sha256": manifest.map(|manifest| manifest.sha256.clone()),
            "local": outcome(report.local.as_ref().map(|_| ())),
            "second": report.second.as_ref().map(|result| outcome(result.as_ref().map(|_| ()))),
        });
        let entry = Entry {
            actor: user.map_or(Actor::System, Actor::OfficeUser),
            action: actions::BACKUP_CREATE,
            target_type: Some("backup"),
            target_id: file.as_deref(),
            outcome: if ok { Outcome::Ok } else { Outcome::Failed },
            details,
        };
        let written = match self.conn().await {
            Ok(conn) => audit::record(conn, &format_timestamp(at), entry).await,
            Err(error) => Err(error),
        };
        if let Err(error) = written {
            tracing::error!(%error, "the backup audit row was not written");
        }
    }

    /// Close the worker's connection.
    pub async fn close(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = conn.close().await;
        }
    }
}

fn failed_report(trigger: BackupTrigger, failed: Failure) -> RunReport {
    RunReport {
        trigger,
        local: Err(failed),
        second: None,
    }
}

/// One run on `conn` (opened here when `None`); returns the connection for
/// the next run, the data version read before the copy, and the report.
async fn run_once(
    backups: Arc<Backups>,
    conn: Option<SqliteConnection>,
    trigger: BackupTrigger,
    at: OffsetDateTime,
) -> (Option<SqliteConnection>, Option<i64>, RunReport) {
    let mut conn = match conn {
        Some(conn) => conn,
        None => match connect(&backups.db_path).await {
            Ok(conn) => conn,
            Err(error) => {
                let failed = Failure::new(failure::INTERNAL, error.to_string());
                return (None, None, failed_report(trigger, failed));
            }
        },
    };
    let version = data_version(&mut conn).await.ok();
    let second_dir: Option<String> =
        match sqlx::query_scalar("SELECT second_dir FROM backup_settings WHERE id = 1")
            .fetch_one(&mut conn)
            .await
        {
            Ok(dir) => dir,
            Err(error) => {
                let failed = Failure::new(failure::INTERNAL, error.to_string());
                return (Some(conn), None, failed_report(trigger, failed));
            }
        };
    let local_dir = backups.local_dir.clone();
    let cleaned = tokio::task::spawn_blocking(move || folder::clean(&local_dir)).await;
    if let Ok(Err(error)) = cleaned {
        tracing::warn!(%error, "cleaning the local backup folder failed");
    }
    let local = make_copy(&mut conn, &backups.local_dir, at, trigger, &backups.host_id).await;
    match &local {
        Ok(manifest) => tracing::info!(
            file = %manifest.file,
            size = manifest.size_bytes,
            "backup copy made"
        ),
        Err(failed) => tracing::warn!(
            code = failed.code,
            detail = %failed.detail,
            "backup copy failed"
        ),
    }
    let local_dir = backups.local_dir.clone();
    let made = local.clone().ok();
    let second = second_dir.clone();
    let folders = tokio::task::spawn_blocking(move || {
        // The rule thins the copies out only after a new verified copy has
        // joined them: a failed run leaves every copy there is.
        // The copy just made stays whatever the rule says (a clock set back).
        let fresh = made.as_ref().map(|manifest| manifest.file.as_str());
        let local_copies = if made.is_some() {
            folder::rotate(&local_dir, fresh)
        } else {
            folder::list(&local_dir)
        }
        .map(|copies| listed(&copies));
        let second = second.map(|dir| {
            let dir = PathBuf::from(dir);
            let result = match &made {
                Some(manifest) => folder::clean(&dir)
                    .map_err(|error| {
                        Failure::new(super::copy::classify_io(&error), error.to_string())
                    })
                    .and_then(|_| folder::replicate(&local_dir, manifest, &dir)),
                None => Err(Failure::new(
                    failure::LOCAL_COPY_FAILED,
                    "the local copy failed",
                )),
            };
            let copies = if result.is_ok() {
                folder::rotate(&dir, fresh)
            } else {
                folder::list(&dir)
            };
            (result, copies.map(|copies| listed(&copies)))
        });
        (local_copies, second)
    })
    .await;
    let (local_copies, second_result) = folder_outcome(folders, second_dir.as_ref());
    if let Some((Err(failed), _)) = &second_result {
        tracing::warn!(
            code = failed.code,
            detail = %failed.detail,
            "backup copy into the second folder failed"
        );
    }
    {
        let mut status = backups.status();
        match local_copies {
            Ok(copies) => status.local.copies = copies,
            Err(error) => tracing::warn!(%error, "listing the local backup folder failed"),
        }
        match (&second_dir, &second_result) {
            (Some(dir), Some((_, copies))) => {
                let entry = match status.second.take() {
                    Some(known) if &known.dir == dir => known,
                    _ => FolderStatus::new(dir.clone()),
                };
                let mut entry = entry;
                if let Ok(copies) = copies {
                    entry.copies = copies.clone();
                }
                status.second = Some(entry);
            }
            _ => status.second = None,
        }
    }
    let report = RunReport {
        trigger,
        local,
        second: second_result.map(|(result, _)| result),
    };
    (Some(conn), version, report)
}

/// The local folder's copies, and the second folder's result and copies
/// (when one is set), as the folder task gives them.
type FolderLists = (
    std::io::Result<Vec<BackupCopy>>,
    Option<(Result<(), Failure>, std::io::Result<Vec<BackupCopy>>)>,
);

/// What the folder task gave, or, when it did not finish (a panic), an
/// `internal` failure for the second folder and no list for either: a list
/// that is not `Ok` leaves the one the status holds, so the office does not
/// see «нет проверенных копий» until the next good run.
fn folder_outcome(
    folders: Result<FolderLists, tokio::task::JoinError>,
    second_dir: Option<&String>,
) -> FolderLists {
    match folders {
        Ok(folders) => folders,
        Err(error) => {
            tracing::error!(
                panicked = error.is_panic(),
                "a backup folder task did not finish"
            );
            let unknown = || std::io::Error::other("the folder task did not finish");
            let failed = Failure::new(failure::INTERNAL, "the folder task did not finish");
            (
                Err(unknown()),
                second_dir.map(|_| (Err(failed), Err(unknown()))),
            )
        }
    }
}

/// The worker task: a run at once when asked, a scheduled check every
/// [`TICK`], until `stopping` turns `true`.
pub fn spawn(
    backups: Arc<Backups>,
    clock: Arc<dyn Clock>,
    mut stopping: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut worker = Worker::new(backups.clone(), clock);
        worker.scan().await;
        let mut ticks = tokio::time::interval(TICK);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                // The `Ref` the wait answers is not `Send`: drop it inside.
                () = async {
                    let _ = stopping.wait_for(|stopping| *stopping).await;
                } => break,
                () = backups.wake.notified() => {
                    worker.run_manual().await;
                }
                _ = ticks.tick() => {
                    worker.tick().await;
                }
            }
        }
        worker.close().await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder task that panicked tells nothing of the folders: the lists the
    /// status holds stay (a list that is not `Ok` never replaces them), and
    /// the second folder's run is an `internal` failure.
    #[tokio::test]
    async fn a_folder_task_that_did_not_finish_keeps_the_lists_the_status_holds() {
        let panicked = tokio::task::spawn_blocking(|| -> FolderLists {
            panic!("a folder task that panics");
        })
        .await
        .unwrap_err();
        let second_dir = Some(r"E:\Markiro".to_owned());
        let (local, second) = folder_outcome(Err(panicked), second_dir.as_ref());
        assert!(local.is_err(), "no list replaces the local one");
        let (result, copies) = second.expect("a second folder is set");
        assert_eq!(result.unwrap_err().code, failure::INTERNAL);
        assert!(copies.is_err(), "no list replaces the second folder's");
        let panicked = tokio::task::spawn_blocking(|| -> FolderLists {
            panic!("a folder task that panics");
        })
        .await
        .unwrap_err();
        assert!(folder_outcome(Err(panicked), None).1.is_none());
    }
}
