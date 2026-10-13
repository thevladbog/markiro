//! The trial's mark outside the database (plan ЛЦ-2, spec §3.4): the wizard
//! writes it once, a start writes a missing one, and the trial starts at the
//! earlier of the database's and the mark's start, with that start's INN, so
//! neither a reinstall nor an edited value buys a new trial.

mod support;

use std::sync::{Arc, Mutex};

use markiro_host::license::trial_mark::{Mark, TrialMark};
use markiro_host::license::LicenseService;
use serde_json::{json, Value};
use support::app::{admin, admin_of, Admin, TestApp};
use support::license::{office_license, refresh, text, DAY_MS, INN, OTHER_INN, START_MS};

#[derive(Default)]
struct FakeMark {
    mark: Mutex<Option<Mark>>,
    reads: Mutex<usize>,
    writes: Mutex<Vec<Mark>>,
    refuses: bool,
    /// The key cannot be read (`reg.exe` failed or did not start).
    unreadable: bool,
}

impl FakeMark {
    fn holding(started_at: i64, inn: Option<&str>) -> Arc<Self> {
        let fake = Self::default();
        *fake.mark.lock().unwrap() = Some(Mark {
            started_at,
            host_id: "0b0b0000-0000-4000-8000-000000000001".to_owned(),
            inn: inn.map(str::to_owned),
        });
        Arc::new(fake)
    }

    fn writes(&self) -> Vec<Mark> {
        self.writes.lock().unwrap().clone()
    }

    fn reads(&self) -> usize {
        *self.reads.lock().unwrap()
    }
}

impl TrialMark for FakeMark {
    fn read(&self) -> Result<Option<Mark>, String> {
        *self.reads.lock().unwrap() += 1;
        if self.unreadable {
            return Err("reg.exe ended with code 1".to_owned());
        }
        Ok(self.mark.lock().unwrap().clone())
    }

    fn write(&self, mark: &Mark) -> Result<(), String> {
        self.writes.lock().unwrap().push(mark.clone());
        if self.refuses {
            return Err("reg.exe ended with code 1".to_owned());
        }
        *self.mark.lock().unwrap() = Some(mark.clone());
        Ok(())
    }
}

fn service(mark: Arc<FakeMark>) -> Arc<LicenseService> {
    Arc::new(LicenseService::new(
        markiro_proto::trust::license_keyset(),
        mark,
    ))
}

/// A new host whose trial mark is `mark`, before its wizard.
async fn host_with(mark: Arc<FakeMark>) -> TestApp {
    let mut app = TestApp::new().await;
    app.state = app.state.clone().with_license(service(mark));
    app
}

/// The mark the wizard of `admin` writes: now, this host, the wizard's INN.
fn wizard_mark(admin: &Admin) -> Mark {
    Mark {
        started_at: START_MS,
        host_id: admin.app.state.host_id.clone(),
        inn: Some(INN.to_owned()),
    }
}

async fn activation_trial(admin: &Admin) -> Value {
    let (status, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    body["trial"].clone()
}

#[tokio::test]
async fn the_wizard_writes_the_mark_once_with_its_start_its_host_and_its_inn() {
    let mark = Arc::new(FakeMark::default());
    let app = host_with(mark.clone()).await;
    // The service starts before its wizard: the registry is read then, once.
    app.state.license.startup(&app.state).await;
    assert!(mark.writes().is_empty());
    let admin = admin_of(app).await;
    assert_eq!(mark.writes(), [wizard_mark(&admin)]);
    assert_eq!(mark.reads(), 1);
    // A later start finds the mark and writes nothing.
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(mark.writes().len(), 1);
    assert_eq!(mark.reads(), 2);
}

/// The wizard of a host that never looked (a test, or a wizard in the same
/// minute as the start) reads the registry itself before it writes.
#[tokio::test]
async fn a_wizard_before_any_look_reads_the_mark_before_it_writes() {
    let mark = Arc::new(FakeMark::default());
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert_eq!(
        (mark.reads(), mark.writes()),
        (1, vec![wizard_mark(&admin)])
    );
}

#[tokio::test]
async fn a_reinstall_does_not_buy_a_new_trial_and_keeps_the_marks_inn() {
    // The mark of an earlier installation on this computer, with the INN of
    // the organization it was made for.
    let mark = FakeMark::holding(START_MS - 20 * DAY_MS, Some(OTHER_INN));
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert!(mark.writes().is_empty());
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["since"].clone(),
            license["trial"].clone()
        ),
        (
            json!("trial_expired"),
            json!(text(START_MS - 6 * DAY_MS)),
            json!({
                "startedAt": text(START_MS - 20 * DAY_MS),
                "endsAt": text(START_MS - 6 * DAY_MS),
                "inn": OTHER_INN
            })
        )
    );
    // The activation request pairs the start with its own INN.
    assert_eq!(
        activation_trial(&admin).await,
        json!({ "startedAt": text(START_MS - 20 * DAY_MS), "inn": OTHER_INN })
    );
}

#[tokio::test]
async fn a_later_value_in_the_registry_does_not_extend_the_trial_nor_lend_its_inn() {
    let mark = FakeMark::holding(START_MS + 10 * DAY_MS, Some(OTHER_INN));
    let admin = admin_of(host_with(mark.clone()).await).await;
    // A mark is there: the wizard writes none.
    assert!(mark.writes().is_empty());
    let license = office_license(&admin).await;
    assert_eq!(
        license["trial"],
        json!({
            "startedAt": text(START_MS),
            "endsAt": text(START_MS + 14 * DAY_MS),
            "inn": INN
        })
    );
    assert_eq!(
        activation_trial(&admin).await,
        json!({ "startedAt": text(START_MS), "inn": INN })
    );
}

/// The same start in both: the database's INN (the wizard's) is the one.
#[tokio::test]
async fn the_same_start_in_both_keeps_the_databases_inn() {
    let mark = FakeMark::holding(START_MS, Some(OTHER_INN));
    let admin = admin_of(host_with(mark).await).await;
    assert_eq!(office_license(&admin).await["trial"]["inn"], json!(INN));
}

/// A mark without an INN that wins names none: never the database's INN
/// under the mark's start.
#[tokio::test]
async fn an_earlier_mark_without_an_inn_names_none() {
    let mark = FakeMark::holding(START_MS - DAY_MS, None);
    let admin = admin_of(host_with(mark).await).await;
    assert_eq!(
        office_license(&admin).await["trial"],
        json!({
            "startedAt": text(START_MS - DAY_MS),
            "endsAt": text(START_MS + 13 * DAY_MS),
            "inn": null
        })
    );
    assert_eq!(
        activation_trial(&admin).await,
        json!({ "startedAt": text(START_MS - DAY_MS), "inn": "" })
    );
}

/// What the host cannot use of a mark is no mark (plan ЛЦ-2: the registry is
/// read as the database is): a start out of range is absent, so the wizard
/// writes over it; an INN that is no INN is none.
#[tokio::test]
async fn a_mark_out_of_range_is_no_mark_and_an_inn_that_is_no_inn_is_none() {
    let mark = FakeMark::holding(-1, Some(INN));
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert_eq!(mark.writes(), [wizard_mark(&admin)]);
    assert_eq!(
        office_license(&admin).await["trial"]["startedAt"],
        json!(text(START_MS))
    );
    let mark = FakeMark::holding(START_MS - DAY_MS, Some("7701234567"));
    let admin = admin_of(host_with(mark).await).await;
    assert_eq!(
        office_license(&admin).await["trial"],
        json!({
            "startedAt": text(START_MS - DAY_MS),
            "endsAt": text(START_MS + 13 * DAY_MS),
            "inn": null
        })
    );
}

#[tokio::test]
async fn a_trial_in_the_database_without_a_mark_writes_it_at_a_start() {
    let mut admin = admin().await;
    let mark = Arc::new(FakeMark::default());
    admin.app.state = admin.app.state.clone().with_license(service(mark.clone()));
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(mark.writes(), [wizard_mark(&admin)]);
    // Written, it is the registry's now: the next start writes nothing.
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(mark.writes().len(), 1);
}

#[tokio::test]
async fn a_mark_that_cannot_be_written_changes_nothing_else_and_is_tried_again() {
    let mark = Arc::new(FakeMark {
        refuses: true,
        ..FakeMark::default()
    });
    let admin = admin_of(host_with(mark.clone()).await).await;
    assert_eq!(mark.writes().len(), 1);
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["trial"]["startedAt"].clone()
        ),
        (json!("trial"), json!(text(START_MS)))
    );
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(mark.writes(), [wizard_mark(&admin), wizard_mark(&admin)]);
}

/// The trial's start as stored.
async fn trial_start(app: &TestApp) -> Option<i64> {
    sqlx::query_scalar("SELECT trial_started_at FROM license_clock WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// The stored mark of the time.
async fn max_seen(app: &TestApp) -> Option<i64> {
    sqlx::query_scalar("SELECT max_seen_at FROM license_clock WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// The license now, without a session (these tests move days).
async fn license_now(app: &TestApp) -> Value {
    serde_json::to_value(
        app.state
            .license
            .office_license_now(&app.state)
            .await
            .expect("the license now"),
    )
    .unwrap()
}

/// A PC's clock put right (ahead) while the host ran, before the wizard: the
/// trial starts at the wizard by the PC's clock, and nothing takes those days
/// back from it (review of Task 12): neither the stored start nor the mark.
#[tokio::test]
async fn a_clock_put_right_before_the_wizard_does_not_shorten_the_trial() {
    let mark = Arc::new(FakeMark::default());
    let app = host_with(mark.clone()).await;
    app.state.license.startup(&app.state).await;
    app.clock.move_wall(time::Duration::days(2));
    let admin = admin_of(app).await;
    refresh(&admin.app).await;
    let started = START_MS + 2 * DAY_MS;
    assert_eq!(trial_start(&admin.app).await, Some(started));
    assert_eq!(
        mark.writes(),
        [Mark {
            started_at: started,
            ..wizard_mark(&admin)
        }]
    );
    let license = license_now(&admin.app).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["trial"]["startedAt"].clone(),
            license["trial"]["endsAt"].clone(),
            license["daysLeft"].clone()
        ),
        (
            json!("trial"),
            json!(text(started)),
            json!(text(started + 14 * DAY_MS)),
            json!(14)
        )
    );
    // Days later the trial has counted them.
    admin.app.clock.advance(time::Duration::days(5));
    refresh(&admin.app).await;
    assert_eq!(trial_start(&admin.app).await, Some(started));
    assert_eq!(license_now(&admin.app).await["daysLeft"], json!(9));
}

/// Before the wizard there is nothing to protect: a PC whose clock reads
/// 2000 (a flat battery) keeps no mark of it, so once the clock is put right
/// the trial runs its 14 days from the wizard (review of Task 12).
#[tokio::test]
async fn a_wrong_clock_before_the_wizard_leaves_no_mark_and_the_trial_runs_14_days() {
    let app = TestApp::new().await;
    let back_to_2000 = time::Duration::milliseconds(START_MS - 946_684_800_000);
    app.clock.move_wall(-back_to_2000);
    app.state.license.startup(&app.state).await;
    app.clock.advance(time::Duration::hours(2));
    refresh(&app).await;
    assert_eq!(max_seen(&app).await, None);
    // A fresh service on the same data (a restart) finds no mark either.
    let restarted = LicenseService::new(
        markiro_proto::trust::license_keyset(),
        Arc::new(markiro_host::license::trial_mark::NoMark),
    );
    restarted.refresh(&app.state).await.unwrap();
    assert_eq!(max_seen(&app).await, None);
    // The clock is put right while the host runs, then the wizard.
    app.clock.move_wall(back_to_2000);
    let admin = admin_of(app).await;
    let started = START_MS + 2 * 3_600_000;
    assert_eq!(trial_start(&admin.app).await, Some(started));
    assert_eq!(max_seen(&admin.app).await, Some(started));
    let license = license_now(&admin.app).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["trial"]["endsAt"].clone(),
            license["daysLeft"].clone()
        ),
        (
            json!("trial"),
            json!(text(started + 14 * DAY_MS)),
            json!(14)
        )
    );
    admin
        .app
        .clock
        .advance(time::Duration::days(14) - time::Duration::seconds(1));
    assert_eq!(license_now(&admin.app).await["state"], json!("trial"));
    admin.app.clock.advance(time::Duration::seconds(1));
    assert_eq!(
        license_now(&admin.app).await["state"],
        json!("trial_expired")
    );
}

/// The mark never holds a start after the time the host trusts (review of
/// Task 12): a stored start the trusted time has not reached is written as
/// that time.
#[tokio::test]
async fn the_mark_never_takes_a_start_after_the_trusted_time() {
    let mark = Arc::new(FakeMark::default());
    let admin = admin_of(host_with(mark.clone()).await).await;
    // The registry lost its values; the PC's clock jumps two days ahead while
    // the host runs, and the stored start says a day later (as a restore
    // could leave it).
    *mark.mark.lock().unwrap() = None;
    mark.writes.lock().unwrap().clear();
    admin.app.clock.move_wall(time::Duration::days(2));
    sqlx::query("UPDATE license_clock SET trial_started_at = ? WHERE id = 1")
        .bind(START_MS + DAY_MS)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(
        mark.writes(),
        [Mark {
            started_at: START_MS + 5 * 60_000,
            ..wizard_mark(&admin)
        }]
    );
}

/// A key that cannot be read is not a missing mark (review of Task 12):
/// neither the wizard nor a start writes over what the host could not see.
#[tokio::test]
async fn a_mark_that_cannot_be_read_is_never_written_over() {
    let mark = Arc::new(FakeMark {
        unreadable: true,
        ..FakeMark::default()
    });
    let app = host_with(mark.clone()).await;
    app.state.license.startup(&app.state).await;
    let admin = admin_of(app).await;
    admin.app.state.license.startup(&admin.app.state).await;
    assert!(mark.writes().is_empty());
    assert_eq!(mark.reads(), 2);
    assert_eq!(
        office_license(&admin).await["trial"]["startedAt"],
        json!(text(START_MS))
    );
}

/// A `reg.exe` that never answers: its read is released only when the test
/// drops `release`.
struct HangingMark {
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    writes: Mutex<usize>,
}

impl TrialMark for HangingMark {
    fn read(&self) -> Result<Option<Mark>, String> {
        let _ = self.release.lock().unwrap().recv();
        Ok(None)
    }

    fn write(&self, _mark: &Mark) -> Result<(), String> {
        *self.writes.lock().unwrap() += 1;
        Ok(())
    }
}

/// A registry that does not answer holds neither the start nor the wizard
/// (review of Task 12): the read gives up after its time and counts as
/// failed, so nothing is written.
#[tokio::test]
async fn a_registry_that_does_not_answer_holds_up_nothing() {
    let (release, hold) = std::sync::mpsc::channel::<()>();
    let mark = Arc::new(HangingMark {
        release: Mutex::new(hold),
        writes: Mutex::new(0),
    });
    let mut app = TestApp::new().await;
    app.state = app.state.clone().with_license(Arc::new(
        LicenseService::new(markiro_proto::trust::license_keyset(), mark.clone())
            .with_mark_timeout(std::time::Duration::from_millis(50)),
    ));
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        app.state.license.startup(&app.state),
    )
    .await
    .expect("the start does not wait for the registry");
    let admin = tokio::time::timeout(std::time::Duration::from_secs(5), admin_of(app))
        .await
        .expect("the wizard does not wait for the registry");
    assert_eq!(*mark.writes.lock().unwrap(), 0);
    assert_eq!(
        office_license(&admin).await["trial"]["startedAt"],
        json!(text(START_MS))
    );
    drop(release);
}
