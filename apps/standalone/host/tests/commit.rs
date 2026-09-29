//! A write's commit and the wake-up that announces it are one unit: hyper
//! drops a handler's future when the client hangs up (the shell's client
//! gives up after 10 s), and that must never split them.

mod support;

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use markiro_host::db::{begin_write, commit_and_notify, commit_with_revision, next_revision};
use support::app::TestApp;

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
