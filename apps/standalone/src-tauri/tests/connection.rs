//! The link task against a real `markiro-host` on 127.0.0.1: the statuses and
//! revisions the webview receives, reconnection, and following the pairing.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::Secret;
use markiro_standalone_lib::connection::{
    self, Backoff, ConnectionState, HostRevision, HostStatus, LinkError, LinkEvents, LinkState,
};
use markiro_standalone_lib::device::{DeviceState, HostLink};
use serde_json::Value;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
/// Short pauses, so a reconnection shows within a test.
const FAST: Backoff = Backoff {
    initial: Duration::from_millis(50),
    max: Duration::from_millis(200),
};

#[derive(Debug, Clone, PartialEq)]
enum Heard {
    Status(HostStatus),
    Revision(i64),
}

struct Recorder(mpsc::UnboundedSender<Heard>);

impl LinkEvents for Recorder {
    fn status(&self, status: &HostStatus) {
        let _ = self.0.send(Heard::Status(status.clone()));
    }

    fn revision(&self, revision: HostRevision) {
        let _ = self.0.send(Heard::Revision(revision.rev));
    }
}

/// Run the link task on `link`; returns what it reports, its state and its task.
fn follow(
    link: watch::Receiver<Option<Arc<HostLink>>>,
) -> (
    mpsc::UnboundedReceiver<Heard>,
    ConnectionState,
    JoinHandle<()>,
) {
    let (sender, heard) = mpsc::unbounded_channel();
    let state = ConnectionState::default();
    let task = tokio::spawn(connection::supervise(
        link,
        Arc::new(Recorder(sender)),
        state.clone(),
        FAST,
    ));
    (heard, state, task)
}

/// The next report matching `wanted`, skipping the others, within 10 s.
async fn until(
    heard: &mut mpsc::UnboundedReceiver<Heard>,
    wanted: impl Fn(&Heard) -> bool,
) -> Heard {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let next = heard.recv().await.expect("the link task is running");
            if wanted(&next) {
                return next;
            }
        }
    })
    .await
    .expect("the report arrives within 10 s")
}

/// The next status in `state`.
async fn status_in(heard: &mut mpsc::UnboundedReceiver<Heard>, state: LinkState) -> HostStatus {
    match until(
        heard,
        |heard| matches!(heard, Heard::Status(status) if status.state == state),
    )
    .await
    {
        Heard::Status(status) => status,
        Heard::Revision(_) => unreachable!("only statuses match"),
    }
}

/// The very next report, whatever it is; panics if it is not a status. Used
/// to pin an exact sequence, unlike `status_in`, which skips over reports
/// that do not match.
async fn next_status(heard: &mut mpsc::UnboundedReceiver<Heard>) -> HostStatus {
    match until(heard, |_| true).await {
        Heard::Status(status) => status,
        Heard::Revision(rev) => panic!("expected a status, heard revision {rev}"),
    }
}

async fn next_revision(heard: &mut mpsc::UnboundedReceiver<Heard>) -> i64 {
    match until(heard, |heard| matches!(heard, Heard::Revision(_))).await {
        Heard::Revision(rev) => rev,
        Heard::Status(_) => unreachable!("only revisions match"),
    }
}

async fn start_host(dir: &Path, bind: &str) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some(bind.parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

async fn paired(host: &RunningHost, dir: &Path) -> DeviceState {
    let device = DeviceState::load(dir.to_path_buf());
    device
        .local_pair(&address(host), "Станция", "0.1.0")
        .await
        .unwrap();
    device
}

#[tokio::test]
async fn an_unpaired_device_stays_offline_without_trying() {
    let app_dir = tempfile::tempdir().unwrap();
    let device = DeviceState::load(app_dir.path().to_path_buf());
    let (mut heard, state, task) = follow(device.watch_link());

    assert_eq!(
        until(&mut heard, |_| true).await,
        Heard::Status(HostStatus {
            state: LinkState::Offline,
            last_contact_at: None,
            last_error: None,
            seq: 1,
            restore_epoch: None,
        })
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(heard.try_recv().is_err(), "nothing more while unpaired");
    assert_eq!(state.snapshot().seq, 1);
    task.abort();
}

#[tokio::test]
async fn a_paired_device_comes_online_and_hears_every_revision() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, state, task) = follow(device.watch_link());

    // The exact first two statuses the webview relies on: `Connecting` with
    // `seq` 1 and no error or contact yet, then `Online` with `seq` 2.
    assert_eq!(
        next_status(&mut heard).await,
        HostStatus {
            state: LinkState::Connecting,
            last_contact_at: None,
            last_error: None,
            seq: 1,
            restore_epoch: None,
        }
    );
    let online = next_status(&mut heard).await;
    assert_eq!(online.state, LinkState::Online);
    assert_eq!(online.seq, 2);
    assert_eq!(online.last_error, None);
    assert!(online.last_contact_at.is_some());
    assert_eq!(
        next_revision(&mut heard).await,
        0,
        "the current revision comes first"
    );

    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = device
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200);
    assert_eq!(next_revision(&mut heard).await, 1, "the wizard's commit");
    assert_eq!(state.snapshot().state, LinkState::Online);
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn the_link_goes_offline_with_the_host_and_returns_with_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let bound = host.addr.to_string();
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Online).await;

    host.stop().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert!(
        matches!(
            offline.last_error,
            Some(LinkError::StreamEnded | LinkError::Unreachable)
        ),
        "{offline:?}"
    );
    // `Offline` is immediately followed by a `Connecting` retry with a
    // higher `seq`, before the link eventually comes back `Online`.
    let connecting = next_status(&mut heard).await;
    assert_eq!(connecting.state, LinkState::Connecting);
    assert_eq!(
        connecting.seq,
        offline.seq + 1,
        "{connecting:?} after {offline:?}"
    );

    // The same host comes back on the same address: the link returns on its own.
    let host = start_host(host_dir.path(), &bound).await;
    status_in(&mut heard, LinkState::Online).await;
    assert_eq!(next_revision(&mut heard).await, 0);
    task.abort();
    host.stop().await.unwrap();
}

/// What `markiro-host restore` leaves in the stopped host's `site` (plan РК):
/// a new restore epoch, which `hello` names from then on.
async fn mark_restored(dir: &Path, epoch: &str) {
    let mut db = SqliteConnectOptions::new()
        .filename(HostPaths::new(dir).database_file())
        .connect()
        .await
        .unwrap();
    let marked = sqlx::query("UPDATE site SET restore_epoch = ? WHERE id = 1")
        .bind(epoch)
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(marked.rows_affected(), 1);
    db.close().await.unwrap();
}

#[tokio::test]
async fn the_online_status_names_the_epoch_of_a_restored_host() {
    const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let bound = host.addr.to_string();
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, state, task) = follow(device.watch_link());
    let first = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(
        first.restore_epoch, None,
        "a host never restored names none"
    );

    host.stop().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(offline.restore_epoch, None);
    mark_restored(host_dir.path(), EPOCH).await;
    let host = start_host(host_dir.path(), &bound).await;
    let back = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(back.restore_epoch.as_deref(), Some(EPOCH));
    assert_eq!(state.snapshot().restore_epoch.as_deref(), Some(EPOCH));

    // Forgetting the device leaves no epoch behind for the next pairing.
    device.forget().await.unwrap();
    let forgotten = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(forgotten.restore_epoch, None);
    assert_eq!(state.snapshot().restore_epoch, None);
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_link_swapped_for_another_host_does_not_inherit_the_epoch() {
    const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    host.stop().await.unwrap();
    mark_restored(host_dir.path(), EPOCH).await;
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = paired(&host, app_dir.path()).await;
    let current = device.watch_link().borrow().clone();
    let (swap, link) = watch::channel(current);
    let (mut heard, state, task) = follow(link);
    let online = status_in(&mut heard, LinkState::Online).await;
    assert_eq!(online.restore_epoch.as_deref(), Some(EPOCH));

    // The link changes hands without passing through "unpaired" (a quick
    // forget and re-pair coalesces): the new link's own first status must not
    // carry the old host's epoch.
    let other = HostLink::new(address(&host), "0".repeat(64), Secret::new("any"));
    swap.send(Some(Arc::new(other))).unwrap();
    let connecting = status_in(&mut heard, LinkState::Connecting).await;
    assert_eq!(connecting.restore_epoch, None, "{connecting:?}");
    assert_eq!(state.snapshot().restore_epoch, None);
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn forgetting_the_device_stops_the_link() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = paired(&host, app_dir.path()).await;
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Online).await;

    device.forget().await.unwrap();
    let offline = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!((offline.last_error, offline.last_contact_at), (None, None));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let later: Vec<Heard> = std::iter::from_fn(|| heard.try_recv().ok()).collect();
    assert!(later.is_empty(), "no attempts after forgetting: {later:?}");
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn pairing_later_starts_the_link() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;
    let device = DeviceState::load(app_dir.path().to_path_buf());
    let (mut heard, _state, task) = follow(device.watch_link());
    status_in(&mut heard, LinkState::Offline).await;

    device
        .local_pair(&address(&host), "Станция", "0.1.0")
        .await
        .unwrap();
    status_in(&mut heard, LinkState::Online).await;
    task.abort();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_rejected_key_and_a_changed_certificate_are_reported() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path(), "127.0.0.1:0").await;

    let wrong_key = HostLink::new(
        address(&host),
        host.fingerprint.clone(),
        Secret::new("not-a-key-the-host-issued"),
    );
    let (_key_sender, link) = watch::channel(Some(Arc::new(wrong_key)));
    let (mut heard, _state, task) = follow(link);
    let refused = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(refused.last_error, Some(LinkError::KeyRejected));
    task.abort();

    let wrong_certificate = HostLink::new(address(&host), "0".repeat(64), Secret::new("any"));
    let (_certificate_sender, link) = watch::channel(Some(Arc::new(wrong_certificate)));
    let (mut heard, _state, task) = follow(link);
    let refused = status_in(&mut heard, LinkState::Offline).await;
    assert_eq!(refused.last_error, Some(LinkError::CertificateMismatch));
    task.abort();
    host.stop().await.unwrap();
}
