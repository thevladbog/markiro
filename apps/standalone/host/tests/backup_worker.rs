//! The backup worker (plan РК): a scheduled copy at most once an hour while
//! the data changes and at least once a day, «Сделать копию сейчас», the
//! second folder, failures in the status and the audit, and the task that
//! runs it all.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use markiro_host::backup::identity::{KeyFileGuard, OwnerOnly};
use markiro_host::backup::worker::{scheduled_due, spawn};
use markiro_host::backup::{Backups, Worker};
use markiro_host::config::HostPaths;
use markiro_proto::backup::{failure, BackupAttempt, BackupState, BackupTrigger};
use serde_json::json;
use support::app::{add_operator, admin, audit_trail, Admin, AuditRow};
use support::backup::{at, fake_copy, names, write_identity};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/// The copies of `admin`'s host, kept in `local`.
fn backups_in(admin: &Admin, local: &Path) -> Arc<Backups> {
    Backups::new(
        admin.app.dir().to_path_buf(),
        local.to_path_buf(),
        admin.app.dir().join("host.db"),
        HOST_ID,
    )
}

/// A local folder in the app's data folder, as the host has it.
fn local_folder(admin: &Admin) -> PathBuf {
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    local
}

fn worker(admin: &Admin, backups: &Arc<Backups>) -> Worker {
    Worker::new(backups.clone(), admin.app.clock.clone())
}

async fn set_second_dir(admin: &Admin, dir: Option<&Path>) {
    sqlx::query("UPDATE backup_settings SET second_dir = ? WHERE id = 1")
        .bind(dir.map(|dir| dir.display().to_string()))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

fn state(admin: &Admin, backups: &Backups, second: Option<&Path>) -> BackupState {
    backups.state(
        admin.app.state.timestamp(),
        second.map(|dir| dir.display().to_string()),
        0,
    )
}

fn attempt(at: &str, trigger: BackupTrigger, code: Option<&str>) -> Option<BackupAttempt> {
    Some(BackupAttempt {
        at: at.to_owned(),
        trigger,
        ok: code.is_none(),
        code: code.map(str::to_owned),
    })
}

/// The `backup.create` row the host writes for a scheduled run.
fn system_row(result: &str, details: serde_json::Value, file: Option<&str>) -> AuditRow {
    (
        "system".to_owned(),
        None,
        "backup.create".to_owned(),
        Some("backup".to_owned()),
        file.map(str::to_owned),
        result.to_owned(),
        details,
    )
}

const T0: &str = "2026-09-21T14:13:20Z";

#[tokio::test]
async fn a_scheduled_copy_comes_once_an_hour_while_the_data_changes_and_once_a_day() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let first = worker.tick().await.expect("no copy yet: one is due");
    let first = first.local.unwrap();
    assert_eq!(first.created_at, T0);
    assert_eq!(first.trigger, BackupTrigger::Scheduled);
    assert_eq!(
        audit_trail(&admin.app, "backup.create").await,
        [system_row(
            "ok",
            json!({
                "trigger": "scheduled",
                "file": first.file,
                "sizeBytes": first.size_bytes,
                "sha256": first.sha256,
                "local": { "ok": true, "code": null },
                "second": null,
            }),
            Some(&first.file),
        )]
    );
    let after_first = state(&admin, &backups, None);
    assert_eq!(after_first.local.copies, [first.copy()]);
    assert_eq!(
        after_first.local.last_attempt,
        attempt(T0, BackupTrigger::Scheduled, None)
    );
    assert_eq!(after_first.running, None);

    // A change in the same hour waits for the next hour.
    add_operator(&admin, "1001").await;
    assert!(worker.tick().await.is_none(), "one scheduled copy an hour");
    admin.app.clock.advance(time::Duration::hours(1));
    let second = worker
        .tick()
        .await
        .expect("the data changed")
        .local
        .unwrap();
    assert_eq!(second.created_at, "2026-09-21T15:13:20Z");

    // Nothing changed since, not even by the copy's own audit row.
    admin.app.clock.advance(time::Duration::hours(1));
    assert!(worker.tick().await.is_none(), "an idle hour makes no copy");
    admin.app.clock.advance(time::Duration::hours(7));
    assert!(worker.tick().await.is_none(), "still 21 September");

    // A new day gets its copy even when nothing changed.
    admin.app.clock.advance(time::Duration::hours(1));
    let daily = worker.tick().await.expect("no copy of 22 September yet");
    assert_eq!(daily.local.unwrap().created_at, "2026-09-22T00:13:20Z");
    assert_eq!(state(&admin, &backups, None).local.copies.len(), 3);
    assert_eq!(names(&local).len(), 6);
}

#[tokio::test]
async fn a_failed_copy_is_in_the_status_and_the_audit_and_the_next_hour_tries_again() {
    let admin = admin().await;
    let local = admin.app.dir().join("backups");
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let failed = worker.tick().await.unwrap();
    assert_eq!(
        failed.local.unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    assert_eq!(failed.second, None);
    let status = state(&admin, &backups, None);
    assert_eq!(
        status.local.last_attempt,
        attempt(
            T0,
            BackupTrigger::Scheduled,
            Some(failure::DESTINATION_UNAVAILABLE)
        )
    );
    assert!(status.local.copies.is_empty());
    assert_eq!(
        audit_trail(&admin.app, "backup.create").await,
        [system_row(
            "failed",
            json!({
                "trigger": "scheduled",
                "file": null,
                "sizeBytes": null,
                "sha256": null,
                "local": { "ok": false, "code": "destination_unavailable" },
                "second": null,
            }),
            None,
        )]
    );

    std::fs::create_dir_all(&local).unwrap();
    assert!(
        worker.tick().await.is_none(),
        "the failed hour is not retried"
    );
    admin.app.clock.advance(time::Duration::hours(1));
    let retried = worker.tick().await.expect("a failed copy is due again");
    assert!(retried.local.is_ok());
    assert_eq!(
        state(&admin, &backups, None).local.last_attempt,
        attempt("2026-09-21T15:13:20Z", BackupTrigger::Scheduled, None)
    );
}

#[tokio::test]
async fn the_second_folder_gets_every_copy_and_its_failure_is_its_own() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let report = worker.tick().await.unwrap();
    let made = report.local.unwrap();
    assert_eq!(report.second, Some(Ok(())));
    assert_eq!(
        names(&second),
        [made.file.clone(), made.file.replace(".db", ".json")]
    );
    let status = state(&admin, &backups, Some(&second));
    let second_status = status.second.unwrap();
    assert_eq!(second_status.dir, second.display().to_string());
    assert_eq!(second_status.copies, [made.copy()]);
    assert_eq!(
        second_status.last_attempt,
        attempt(T0, BackupTrigger::Scheduled, None)
    );

    // The share goes away: the local copy is still made.
    std::fs::rename(&second, second_parent.path().join("gone")).unwrap();
    add_operator(&admin, "1001").await;
    admin.app.clock.advance(time::Duration::hours(1));
    let report = worker.tick().await.unwrap();
    let kept = report.local.unwrap();
    assert_eq!(
        report.second.unwrap().unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    let status = state(&admin, &backups, Some(&second));
    assert_eq!(
        status.local.last_attempt,
        attempt("2026-09-21T15:13:20Z", BackupTrigger::Scheduled, None)
    );
    let second_status = status.second.unwrap();
    assert_eq!(
        second_status.last_attempt,
        attempt(
            "2026-09-21T15:13:20Z",
            BackupTrigger::Scheduled,
            Some(failure::DESTINATION_UNAVAILABLE)
        )
    );
    assert_eq!(
        second_status.copies,
        [made.copy()],
        "the last copy known there"
    );
    let rows = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(
        rows.last().unwrap(),
        &system_row(
            "failed",
            json!({
                "trigger": "scheduled",
                "file": kept.file,
                "sizeBytes": kept.size_bytes,
                "sha256": kept.sha256,
                "local": { "ok": true, "code": null },
                "second": { "ok": false, "code": "destination_unavailable" },
            }),
            Some(&kept.file),
        )
    );
    assert!(!second.exists(), "the host never creates the second folder");
}

#[tokio::test]
async fn a_failed_local_copy_gives_the_second_folder_nothing() {
    let admin = admin().await;
    let second = tempfile::tempdir().unwrap();
    set_second_dir(&admin, Some(second.path())).await;
    let backups = backups_in(&admin, &admin.app.dir().join("backups"));
    let mut worker = worker(&admin, &backups);
    let report = worker.tick().await.unwrap();
    assert_eq!(
        report.local.unwrap_err().code,
        failure::DESTINATION_UNAVAILABLE
    );
    assert_eq!(
        report.second.unwrap().unwrap_err().code,
        failure::LOCAL_COPY_FAILED
    );
    assert!(names(second.path()).is_empty());
    assert_eq!(
        state(&admin, &backups, Some(second.path()))
            .second
            .unwrap()
            .last_attempt,
        attempt(
            T0,
            BackupTrigger::Scheduled,
            Some(failure::LOCAL_COPY_FAILED)
        )
    );
}

#[tokio::test]
async fn a_manual_copy_names_its_office_user_and_holds_off_other_copies_while_it_waits() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    assert!(worker.run_manual().await.is_none(), "nobody asked");

    assert!(backups.request_manual(&admin.id, at(T0)));
    assert!(!backups.request_manual(&admin.id, at(T0)), "one at a time");
    let waiting = state(&admin, &backups, None);
    let running = waiting.running.unwrap();
    assert_eq!(running.trigger, BackupTrigger::Manual);
    assert_eq!(running.started_at, T0);
    assert!(worker.tick().await.is_none(), "the manual copy goes first");

    let made = worker.run_manual().await.unwrap().local.unwrap();
    assert_eq!(made.trigger, BackupTrigger::Manual);
    let rows = audit_trail(&admin.app, "backup.create").await;
    assert_eq!(
        rows,
        [(
            "office_user".to_owned(),
            Some(admin.id.clone()),
            "backup.create".to_owned(),
            Some("backup".to_owned()),
            Some(made.file.clone()),
            "ok".to_owned(),
            json!({
                "trigger": "manual",
                "file": made.file,
                "sizeBytes": made.size_bytes,
                "sha256": made.sha256,
                "local": { "ok": true, "code": null },
                "second": null,
            }),
        )]
    );
    let done = state(&admin, &backups, None);
    assert_eq!(done.running, None);
    assert_eq!(
        done.local.last_attempt,
        attempt(T0, BackupTrigger::Manual, None)
    );
    assert!(worker.tick().await.is_none(), "the manual copy is today's");
    assert!(backups.request_manual(&admin.id, at(T0)), "asked again");
}

#[tokio::test]
async fn the_folders_are_read_at_start_and_a_new_second_folder_starts_empty() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second = tempfile::tempdir().unwrap();
    let old_local = fake_copy(&local, "2026-09-20T10:00:00Z", "0000000a");
    let old_second = fake_copy(second.path(), "2026-09-20T10:00:00Z", "0000000b");
    set_second_dir(&admin, Some(second.path())).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    worker.scan().await;
    let status = state(&admin, &backups, Some(second.path()));
    assert_eq!(status.local.copies, [old_local.copy()]);
    assert_eq!(status.local.last_attempt, None);
    let second_status = status.second.unwrap();
    assert_eq!(second_status.copies, [old_second.copy()]);
    assert_eq!(second_status.last_attempt, None);
    let other = tempfile::tempdir().unwrap();
    let elsewhere = state(&admin, &backups, Some(other.path())).second.unwrap();
    assert_eq!(elsewhere.dir, other.path().display().to_string());
    assert!(elsewhere.copies.is_empty());
    assert_eq!(state(&admin, &backups, None).second, None);
}

#[test]
fn a_copy_is_due_when_the_data_changed_or_today_has_none() {
    let now = at("2026-10-09T14:05:00Z");
    assert!(scheduled_due(true, Some(at("2026-10-09T13:00:00Z")), now));
    assert!(!scheduled_due(false, Some(at("2026-10-09T00:00:00Z")), now));
    assert!(scheduled_due(false, Some(at("2026-10-08T23:59:59Z")), now));
    assert!(scheduled_due(false, None, now));
}

/// Wait until `done` holds of the status, failing after 10 s rather than
/// hanging.
async fn wait_for(admin: &Admin, backups: &Backups, done: impl Fn(&BackupState) -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !done(&state(admin, backups, None)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the worker task answered in time");
}

#[tokio::test]
async fn the_worker_task_copies_at_start_and_at_once_when_asked_then_stops() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let stopping = tokio::sync::watch::channel(false).0;
    let task = spawn(
        backups.clone(),
        admin.app.clock.clone(),
        stopping.subscribe(),
    );
    wait_for(&admin, &backups, |state| state.local.last_attempt.is_some()).await;
    assert!(backups.request_manual(&admin.id, at(T0)));
    wait_for(&admin, &backups, |state| {
        state.running.is_none() && state.local.copies.len() == 2
    })
    .await;
    let rows = audit_trail(&admin.app, "backup.create").await;
    let actors: Vec<_> = rows.iter().map(|row| row.0.as_str()).collect();
    assert_eq!(actors, ["system", "office_user"]);
    stopping.send_replace(true);
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("the worker stops")
        .unwrap();
}

#[tokio::test]
async fn a_clock_that_goes_back_starts_the_schedule_over_and_makes_no_copy_of_its_own() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    worker.tick().await.unwrap().local.unwrap();

    // The data changed, and the clock is set three hours back: another hour
    // than the one that was served, but not a slot of its own.
    add_operator(&admin, "1001").await;
    admin.app.clock.advance(time::Duration::hours(-3));
    assert!(worker.tick().await.is_none(), "a clock change is no slot");
    assert!(worker.tick().await.is_none(), "nor is the rest of its hour");
    assert_eq!(names(&local).len(), 2);

    // The next hour of the new clock is the next slot.
    admin.app.clock.advance(time::Duration::hours(1));
    let next = worker
        .tick()
        .await
        .expect("the data changed")
        .local
        .unwrap();
    assert_eq!(next.created_at, "2026-09-21T12:13:20Z");
    assert_eq!(names(&local).len(), 4);
    assert!(worker.tick().await.is_none(), "one scheduled copy an hour");
}

#[tokio::test]
async fn what_a_broken_copy_left_is_cleaned_before_the_next_copy_in_both_folders() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second = tempfile::tempdir().unwrap();
    set_second_dir(&admin, Some(second.path())).await;
    let mut kept = Vec::new();
    for dir in [local.as_path(), second.path()] {
        kept.push(fake_copy(dir, "2026-09-20T10:00:00Z", "0000000a"));
        std::fs::write(
            dir.join("markiro-host-20260921T100000Z-deadbeef.db.partial"),
            b"half a copy",
        )
        .unwrap();
        std::fs::write(
            dir.join("markiro-host-20260921T100000Z-feedbeef.db"),
            b"a copy without its manifest",
        )
        .unwrap();
        std::fs::write(dir.join("notes.txt"), b"not ours").unwrap();
    }
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let made = worker.tick().await.unwrap().local.unwrap();
    for (dir, old) in [local.as_path(), second.path()].into_iter().zip(&kept) {
        let mut expected = vec![
            old.file.clone(),
            old.file.replace(".db", ".json"),
            made.file.clone(),
            made.file.replace(".db", ".json"),
            "notes.txt".to_owned(),
        ];
        expected.sort();
        assert_eq!(names(dir), expected, "in {}", dir.display());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_copy_thins_out_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let admin = admin().await;
    let local = local_folder(&admin);
    // Twenty-six hourly copies: the rule keeps 24 of them and deletes two,
    // but only once a new copy has joined them.
    for hour in 0..26 {
        let at = format!("2026-09-{:02}T{:02}:00:00Z", 19 + hour / 24, hour % 24);
        fake_copy(&local, &at, &format!("{hour:08x}"));
    }
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);
    std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = worker.tick().await.unwrap();
    std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(failed.local.unwrap_err().code, failure::ACCESS_DENIED);
    assert_eq!(names(&local).len(), 52, "no copy was deleted");
    assert_eq!(state(&admin, &backups, None).local.copies.len(), 26);

    // The next hour's copy succeeds, and then the rule thins the folder out.
    admin.app.clock.advance(time::Duration::hours(1));
    worker.tick().await.unwrap().local.unwrap();
    assert_eq!(state(&admin, &backups, None).local.copies.len(), 24);
    assert_eq!(names(&local).len(), 48);
}

#[tokio::test]
async fn a_copy_made_with_the_clock_set_back_stays_in_both_folders() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;
    // Thirty copies a week ahead of the host's clock (2026-09-21T14:13:20Z),
    // and one later today: the day and the month of the copy the worker
    // is about to make are already covered by newer copies.
    for folder in [&local, &second] {
        for step in 0..30 {
            let at = format!("2026-09-28T{:02}:{:02}:00Z", step / 4, (step % 4) * 15);
            fake_copy(folder, &at, &format!("{step:08x}"));
        }
        fake_copy(folder, "2026-09-21T20:00:00Z", "0000aaaa");
    }
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let report = worker.tick().await.unwrap();

    let made = report.local.unwrap();
    assert_eq!(report.second, Some(Ok(())));
    for folder in [&local, &second] {
        let db = folder.join(&made.file);
        assert!(db.exists(), "{} keeps the copy just made", folder.display());
    }
    let status = state(&admin, &backups, Some(&second));
    assert!(status.local.copies.contains(&made.copy()));
    assert!(status.second.unwrap().copies.contains(&made.copy()));
}

#[tokio::test]
async fn a_restarted_worker_knows_the_copies_there_are_and_copies_once_at_start() {
    let admin = admin().await;
    let local = local_folder(&admin);
    let before = backups_in(&admin, &local);
    let first = worker(&admin, &before).tick().await.unwrap().local.unwrap();

    // The host restarts five minutes later: new state, the same folder.
    admin.app.clock.advance(time::Duration::minutes(5));
    let after = backups_in(&admin, &local);
    let mut restarted = worker(&admin, &after);
    restarted.scan().await;
    assert_eq!(state(&admin, &after, None).local.copies, [first.copy()]);
    let again = restarted.tick().await.expect("every start makes a copy");
    let again = again.local.unwrap();
    assert_eq!(
        state(&admin, &after, None).local.copies,
        [again.copy(), first.copy()]
    );
    assert!(restarted.tick().await.is_none(), "then the hourly rule");
}

/// Plan I1: the worker reads the data folder's identity before each copy and
/// puts it beside the copy in both folders.
#[tokio::test]
async fn the_worker_puts_the_host_identity_beside_each_copy_in_both_folders() {
    let admin = admin().await;
    write_identity(admin.app.dir(), HOST_ID);
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;
    let backups = backups_in(&admin, &local);
    let mut worker = worker(&admin, &backups);

    let made = worker.tick().await.unwrap().local.unwrap();
    assert!(made.identity.is_some());
    assert_eq!(
        names(&second),
        [
            made.file.clone(),
            made.file.replace(".db", ".identity"),
            made.file.replace(".db", ".json"),
        ]
    );
    let status = state(&admin, &backups, Some(&second));
    assert!(status.local.copies[0].host_identity);
    assert!(status.second.unwrap().copies[0].host_identity);
}

/// An identity that names another host than the worker's stays out of the
/// copy: a data folder that was mixed up says nothing of this host.
#[tokio::test]
async fn an_identity_of_another_host_stays_out_of_the_copy() {
    let admin = admin().await;
    write_identity(admin.app.dir(), "0b7a6c5d-4e3f-4a2b-9c1d-8e7f6a5b4c3d");
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let made = worker(&admin, &backups)
        .tick()
        .await
        .unwrap()
        .local
        .unwrap();
    assert_eq!(made.identity, None);
    assert!(!names(&local).iter().any(|name| name.ends_with(".identity")));
}

/// A guard that refuses the files under `folder` and closes the rest: a
/// share that takes no ACL beside a disk that does.
struct RefusesUnder(PathBuf);

impl KeyFileGuard for RefusesUnder {
    fn protect(&self, path: &Path) -> Result<(), String> {
        if path.starts_with(&self.0) {
            Err("icacls ended with code 5".to_owned())
        } else {
            OwnerOnly.protect(path)
        }
    }
}

fn backups_guarded(admin: &Admin, local: &Path, guard: Arc<dyn KeyFileGuard>) -> Arc<Backups> {
    Backups::new_with_guard(
        admin.app.dir().to_path_buf(),
        local.to_path_buf(),
        admin.app.dir().join("host.db"),
        HOST_ID,
        guard,
    )
}

#[tokio::test]
async fn each_folder_is_closed_by_the_workers_guard_and_a_folder_it_refuses_gets_no_identity() {
    let admin = admin().await;
    write_identity(admin.app.dir(), HOST_ID);
    let local = local_folder(&admin);
    let second_parent = tempfile::tempdir().unwrap();
    let second = second_parent.path().join("ADMIN-PC");
    std::fs::create_dir(&second).unwrap();
    set_second_dir(&admin, Some(&second)).await;

    // The second folder refuses: the local copy has the identity, the second
    // one a copy without it, and the run is a success.
    let backups = backups_guarded(&admin, &local, Arc::new(RefusesUnder(second.clone())));
    let report = worker(&admin, &backups).tick().await.unwrap();
    let made = report.local.unwrap();
    assert!(report.second.unwrap().is_ok());
    assert!(made.identity.is_some());
    assert!(!names(&second)
        .iter()
        .any(|name| name.ends_with(".identity")));
    let status = state(&admin, &backups, Some(&second));
    assert!(status.local.copies[0].host_identity);
    assert!(!status.second.unwrap().copies[0].host_identity);

    // The local folder refuses: no identity there, and so none in the second.
    let other = tempfile::tempdir().unwrap();
    let backups = backups_guarded(
        &admin,
        other.path(),
        Arc::new(RefusesUnder(other.path().to_owned())),
    );
    let report = worker(&admin, &backups).tick().await.unwrap();
    assert_eq!(report.local.unwrap().identity, None);
    assert!(report.second.unwrap().is_ok());
    assert!(!names(other.path())
        .iter()
        .any(|name| name.ends_with(".identity")));
}

#[tokio::test]
async fn a_data_folder_whose_identity_does_not_read_still_gets_its_copies() {
    let admin = admin().await;
    write_identity(admin.app.dir(), HOST_ID);
    // The key lost to a disk fault: the identity no longer reads.
    std::fs::write(
        HostPaths::new(admin.app.dir()).tls_dir().join("key.der"),
        b"x",
    )
    .unwrap();
    let local = local_folder(&admin);
    let backups = backups_in(&admin, &local);
    let report = worker(&admin, &backups).tick().await.unwrap();
    assert_eq!(report.local.unwrap().identity, None);
    let status = state(&admin, &backups, None);
    assert_eq!(status.local.copies.len(), 1);
    assert!(!status.local.copies[0].host_identity);
    assert!(status.local.last_attempt.is_none_or(|attempt| attempt.ok));
}
