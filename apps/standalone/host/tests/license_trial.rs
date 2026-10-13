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
use support::license::{office_license, text, DAY_MS, INN, OTHER_INN, START_MS};

#[derive(Default)]
struct FakeMark {
    mark: Mutex<Option<Mark>>,
    reads: Mutex<usize>,
    writes: Mutex<Vec<Mark>>,
    refuses: bool,
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
    fn read(&self) -> Option<Mark> {
        *self.reads.lock().unwrap() += 1;
        self.mark.lock().unwrap().clone()
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
