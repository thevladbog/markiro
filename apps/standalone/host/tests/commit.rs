//! A write's commit and the wake-up that announces it are one unit: hyper
//! drops a handler's future when the client hangs up (the shell's client
//! gives up after 10 s), and that must never split them. The first tests pin
//! the helpers; the last two pin that the writers use them.

mod support;

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use axum::extract::{FromRequestParts, State};
use markiro_host::auth::OfficeContext;
use markiro_host::db::{begin_write, commit_and_notify, commit_with_revision, next_revision};
use markiro_host::error::{ApiJson, ApiPath};
use markiro_host::routes::devices::revoke_device;
use markiro_host::routes::operators::update_operator;
use markiro_proto::OperatorUpdate;
use serde_json::json;
use support::app::{
    add_operator, admin, audit_trail, host_revision, pair_device, request, tombstones,
    with_session, Admin, TestApp,
};
use tokio::sync::Notify;

/// Whether `lines` has the row the test wrote, read through the pool.
async fn line_exists(app: &TestApp) -> bool {
    let found: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lines WHERE id = 'abandoned'")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    found == 1
}

/// A caller that goes away while the commit is in flight does not take the
/// wake-up with it: the write lands, and so does the revision the streams are
/// woken with. Without it a station keeps a deactivated operator or a revoked
/// badge until some later commit.
#[tokio::test]
async fn a_commit_abandoned_in_flight_still_lands_and_still_wakes_the_streams() {
    let app = TestApp::new().await;
    let mut revisions = app.state.revisions.subscribe();

    let mut tx = begin_write(&app.state.pool).await.unwrap();
    let rev = next_revision(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO lines (id, name, name_key, archived, rev) VALUES ('abandoned', 'Линия', 'линия', 0, ?)",
    )
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();

    // Poll the commit exactly once, then drop it: the first poll hands COMMIT
    // to SQLite and returns pending, which is the moment hyper drops the
    // handler's future.
    let mut commit = Box::pin(commit_with_revision(tx, &app.state.revisions, rev));
    let first = std::future::poll_fn(|cx| Poll::Ready(commit.as_mut().poll(cx))).await;
    assert!(
        first.is_pending(),
        "the commit was still in flight after one poll, so the caller went away mid-commit"
    );
    drop(commit);

    // The write lands...
    let mut landed = false;
    for _ in 0..500 {
        if line_exists(&app).await {
            landed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(landed, "the abandoned commit still committed the row");
    // ...and the streams are woken with its revision.
    tokio::time::timeout(Duration::from_secs(5), revisions.changed())
        .await
        .expect("the commit landed but its wake-up was lost with the caller")
        .expect("the revision channel is open");
    assert_eq!(*revisions.borrow_and_update(), rev);
}

/// The notification follows a successful commit, and only a successful one: a
/// COMMIT that SQLite refuses reports its error and wakes nobody.
#[tokio::test]
async fn the_notification_follows_a_successful_commit_only() {
    let app = TestApp::new().await;

    // A commit that succeeds: the notification has run, and the row is there.
    let mut tx = begin_write(&app.state.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO lines (id, name, name_key, archived, rev) VALUES ('abandoned', 'Линия', 'линия', 0, 1)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let notified = Arc::new(AtomicBool::new(false));
    let flag = notified.clone();
    commit_and_notify(tx, move || flag.store(true, Ordering::SeqCst))
        .await
        .unwrap();
    assert!(notified.load(Ordering::SeqCst));
    assert!(line_exists(&app).await);

    // A commit SQLite refuses: a deferred foreign key checked at COMMIT.
    let mut tx = begin_write(&app.state.pool).await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO operator_badges (id, operator_id, badge_phc, created_at, rev) \
         VALUES ('orphan', 'no-such-operator', 'x', 'now', 1)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let notified = Arc::new(AtomicBool::new(false));
    let flag = notified.clone();
    let refused = commit_and_notify(tx, move || flag.store(true, Ordering::SeqCst)).await;
    assert!(refused.is_err(), "the commit was refused");
    assert!(!notified.load(Ordering::SeqCst), "nobody is woken for it");
    let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operator_badges")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(orphans, 0, "and nothing of it was stored");
}

/// A notification that panics after the commit reports a failure that says
/// nothing of the panic, and the write stays committed.
#[tokio::test]
async fn a_panic_after_the_commit_is_reported_without_its_message() {
    let app = TestApp::new().await;
    let mut tx = begin_write(&app.state.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO lines (id, name, name_key, archived, rev) VALUES ('abandoned', 'Линия', 'линия', 0, 1)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let outcome = commit_and_notify(tx, || panic!("panic-payload-marker")).await;
    let error = outcome.expect_err("the task did not finish normally");
    assert!(matches!(error, sqlx::Error::WorkerCrashed), "{error}");
    assert!(!error.to_string().contains("panic-payload-marker"));
    assert!(line_exists(&app).await, "the commit itself had landed");
}

/// How many requests each route-level test abandons, every one on a record of
/// its own, so differences in scheduling between rounds show.
const ROUNDS: usize = 20;

/// Wakes the test that polls a handler by hand. `notify_one` keeps a wake that
/// arrives while the test is busy elsewhere, so none is lost between two polls.
struct Wakes(Notify);

impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.0.notify_one();
    }
}

/// Drive `handler` by hand, as hyper does until the client hangs up, and drop
/// it the moment `committed` reports that its write has landed: a client that
/// hangs up right after COMMIT. Returns whether it did.
///
/// The handler is polled only when its waker has fired, and after every wake
/// `committed` is asked before the next poll. The wake that reports a COMMIT
/// (or the end of `commit_and_notify`'s task) comes after the row is visible
/// to other connections, so that question answers yes and the handler is
/// dropped without ever learning that its commit returned. Whatever a writer
/// still does after `commit().await` in its own future is lost with it; what
/// runs in the commit's own spawned task (`commit_and_notify`) is not.
///
/// A wake that told the handler nothing new can let one poll run past its
/// COMMIT and finish it before it is dropped. That round abandoned nothing
/// and returns `false`; a handler that failed is a broken test and panics.
async fn hang_up_after_commit<T, E, Fut>(
    handler: impl Future<Output = Result<T, E>>,
    mut committed: impl FnMut() -> Fut,
) -> bool
where
    E: std::fmt::Debug,
    Fut: Future<Output = bool>,
{
    let wakes = Arc::new(Wakes(Notify::new()));
    let waker = Waker::from(wakes.clone());
    let mut cx = Context::from_waker(&waker);
    let mut handler = Box::pin(handler);
    loop {
        if let Poll::Ready(outcome) = handler.as_mut().poll(&mut cx) {
            outcome.expect("the handler failed");
            return false;
        }
        tokio::time::timeout(Duration::from_secs(5), wakes.0.notified())
            .await
            .expect("the handler was never woken");
        if committed().await {
            drop(handler);
            return true;
        }
    }
}

/// The administrator's own session as the router's extractor builds it: the
/// handlers below take an `OfficeContext`, and this is the one they would get.
async fn office_context(admin: &Admin) -> OfficeContext {
    let (mut parts, ()) = with_session(request("POST", "/"), &admin.key, &admin.token)
        .body(())
        .unwrap()
        .into_parts();
    OfficeContext::from_request_parts(&mut parts, &admin.app.state)
        .await
        .unwrap()
}

/// Whether the device's revocation has landed, read through the pool.
async fn is_revoked(app: &TestApp, id: &str) -> bool {
    let revoked_at: Option<String> =
        sqlx::query_scalar("SELECT revoked_at FROM devices WHERE id = ?")
            .bind(id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    revoked_at.is_some()
}

/// The revoking request's client hangs up right after COMMIT, as hyper's drop
/// of the handler's future has it. The device stays revoked and the streams
/// are still woken, or a revoked station's open stream would outlive its key
/// until some later revocation. The sequential shape, `commit` and then
/// `send_modify` in the handler's own future, loses the wake-up in the first
/// round that abandons its request; with none abandoned the test fails too.
#[tokio::test]
async fn a_revocation_abandoned_after_its_commit_still_wakes_the_streams() {
    let admin = admin().await;
    let context = office_context(&admin).await;
    let mut revoked = Vec::new();
    let mut abandoned = 0;
    for round in 0..ROUNDS {
        let (device, _) = pair_device(&admin.app, "station").await;
        let mut revocations = admin.app.state.revocations.subscribe();
        let handler = revoke_device(
            State(admin.app.state.clone()),
            context.clone(),
            ApiPath(device.clone()),
        );
        if hang_up_after_commit(handler, || is_revoked(&admin.app, &device)).await {
            abandoned += 1;
        }
        tokio::time::timeout(Duration::from_secs(5), revocations.changed())
            .await
            .unwrap_or_else(|_| {
                panic!("round {round}: the revocation committed, but its wake-up was lost")
            })
            .expect("the revocation channel is open");
        assert_eq!(
            *revocations.borrow_and_update(),
            round as u64 + 1,
            "round {round}: one wake-up for one revocation"
        );
        revoked.push(device);
    }
    assert!(abandoned > 0, "no request was abandoned after its commit");
    // Each request left its whole write behind, audit row included.
    assert_eq!(
        audit_trail(&admin.app, "device.revoke").await,
        revoked
            .iter()
            .map(|device| admin.row(
                "device.revoke",
                "device",
                device,
                json!({ "kind": "station", "name": "Тестовое устройство" })
            ))
            .collect::<Vec<_>>()
    );
}

/// Whether the operator's deactivation has landed, read through the pool.
async fn is_deactivated(app: &TestApp, id: &str) -> bool {
    let active: bool = sqlx::query_scalar("SELECT active FROM operators WHERE id = ?")
        .bind(id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    !active
}

/// The same for a writer that commits through `commit_with_revision`: the
/// office's client hangs up right after the commit that deactivates an
/// operator. The operator is off the feed, and the stations are still woken
/// with the revision that carries its tombstone, or a station would keep the
/// deactivated operator's PIN until some later commit.
#[tokio::test]
async fn a_deactivation_abandoned_after_its_commit_still_wakes_the_stations() {
    let admin = admin().await;
    let context = office_context(&admin).await;
    let mut deactivated = Vec::new();
    let mut abandoned = 0;
    for round in 0..ROUNDS {
        let (id, rev) = add_operator(&admin, &format!("{:04}", 1000 + round)).await;
        let mut revisions = admin.app.state.revisions.subscribe();
        let handler = update_operator(
            State(admin.app.state.clone()),
            context.clone(),
            ApiPath(id.clone()),
            ApiJson(OperatorUpdate {
                name: None,
                role: None,
                active: Some(false),
                pin_phc: None,
                expected_rev: rev,
            }),
        );
        if hang_up_after_commit(handler, || is_deactivated(&admin.app, &id)).await {
            abandoned += 1;
        }
        tokio::time::timeout(Duration::from_secs(5), revisions.changed())
            .await
            .unwrap_or_else(|_| {
                panic!("round {round}: the deactivation committed, but its wake-up was lost")
            })
            .expect("the revision channel is open");
        let revision = host_revision(&admin.app).await;
        assert_eq!(
            revision,
            rev + 1,
            "round {round}: the deactivation took one revision"
        );
        assert_eq!(
            *revisions.borrow_and_update(),
            revision,
            "round {round}: the streams are woken with it"
        );
        deactivated.push((id, revision));
    }
    assert!(abandoned > 0, "no request was abandoned after its commit");
    // Each request left its whole write behind: the tombstone the stations
    // read after the wake-up, and the audit row.
    let mut tombstoned: Vec<_> = deactivated
        .iter()
        .map(|(id, rev)| ("operators".to_owned(), id.clone(), *rev))
        .collect();
    tombstoned.sort();
    assert_eq!(tombstones(&admin.app).await, tombstoned);
    assert_eq!(
        audit_trail(&admin.app, "operator.update").await,
        deactivated
            .iter()
            .map(|(id, _)| admin.row(
                "operator.update",
                "operator",
                id,
                json!({ "changed": ["active"], "active": { "from": true, "to": false } })
            ))
            .collect::<Vec<_>>()
    );
}
