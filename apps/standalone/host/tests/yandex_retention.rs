use markiro_backup_cloud::model::SnapshotId;
use markiro_backup_cloud::{Error, Result};
use markiro_host::yandex::retention::{candidates, CopyStamp};
use markiro_host::yandex::{
    retention::{rotate, Remote},
    state::{Binding, DeliveryStore},
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use uuid::Uuid;
#[tokio::test]
async fn retry_after_blocks_retention_requests_and_survives_reopen() {
    use std::sync::atomic::AtomicUsize;
    struct Limited(AtomicUsize);
    impl Remote for Limited {
        fn copies(&self) -> Pin<Box<dyn Future<Output = Result<Vec<CopyStamp>>> + Send + '_>> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(Error::RetryAfter {
                    seconds: 3600,
                    status: 429,
                })
            })
        }
        fn delete<'a>(
            &'a self,
            _: SnapshotId,
            _: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async { panic!("no deletion before inventory") })
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.db");
    let store = DeliveryStore::open(&path).await.unwrap();
    let b = Binding {
        generation: Uuid::new_v4(),
        client_id: "client".into(),
        account_id: "account".into(),
        host_id: Uuid::new_v4(),
        source: Default::default(),
    };
    store.connect(&b).await.unwrap();
    store
        .enqueue_latest(b.generation, "markiro-host-source.db")
        .await
        .unwrap();
    let job = store.claim(b.generation).await.unwrap().unwrap();
    store
        .confirm(
            b.generation,
            job.snapshot_id,
            "2026-10-23T00:00:00Z",
            "2026-10-23T00:00:00Z",
        )
        .await
        .unwrap();
    let remote = Limited(AtomicUsize::new(0));
    markiro_host::yandex::retention::rotate_due(&remote, &store, &b, || {
        time::OffsetDateTime::UNIX_EPOCH
    })
    .await
    .unwrap();
    assert_eq!(remote.0.load(Ordering::SeqCst), 1);
    drop(store);
    let store = DeliveryStore::open(&path).await.unwrap();
    assert_eq!(store.status().await.unwrap().retention_retry_at, 3600);
    markiro_host::yandex::retention::rotate_due(&remote, &store, &b, || {
        time::OffsetDateTime::UNIX_EPOCH + time::Duration::seconds(3599)
    })
    .await
    .unwrap();
    assert_eq!(remote.0.load(Ordering::SeqCst), 1);
    markiro_host::yandex::retention::rotate_due(&remote, &store, &b, || {
        time::OffsetDateTime::UNIX_EPOCH + time::Duration::seconds(3600)
    })
    .await
    .unwrap();
    assert_eq!(remote.0.load(Ordering::SeqCst), 2);
}
struct Disk {
    copies: Vec<CopyStamp>,
    calls: Mutex<Vec<String>>,
    fail: AtomicBool,
}
impl Remote for Disk {
    fn copies(&self) -> Pin<Box<dyn Future<Output = Result<Vec<CopyStamp>>> + Send + '_>> {
        Box::pin(async {
            Ok(self
                .copies
                .iter()
                .map(|c| CopyStamp {
                    host_id: c.host_id,
                    id: c.id,
                    at: c.at,
                })
                .collect())
        })
    }
    fn delete<'a>(
        &'a self,
        _id: SnapshotId,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(name.into());
            if name == "database.age" && self.fail.swap(false, Ordering::SeqCst) {
                Err(Error::Network)
            } else {
                Ok(())
            }
        })
    }
}
#[tokio::test]
async fn purge_withdraws_marker_first_and_resumes_after_crash_with_one_audit_event() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = DeliveryStore::open(&path).await.unwrap();
    let host = Uuid::new_v4();
    let b = Binding {
        generation: Uuid::new_v4(),
        host_id: host,
        client_id: "client".into(),
        account_id: "account".into(),
        source: Default::default(),
    };
    store.connect(&b).await.unwrap();
    store
        .enqueue_latest(b.generation, "markiro-host-last.db")
        .await
        .unwrap();
    let confirmed = store
        .claim(b.generation)
        .await
        .unwrap()
        .unwrap()
        .snapshot_id;
    store
        .confirm(
            b.generation,
            confirmed,
            "2026-10-23T00:00:00Z",
            "2026-10-23T00:00:00Z",
        )
        .await
        .unwrap();
    let mut copies: Vec<_> = (0..30)
        .map(|n| CopyStamp {
            host_id: host,
            id: SnapshotId::new(),
            at: time::OffsetDateTime::UNIX_EPOCH + time::Duration::hours(n),
        })
        .collect();
    copies.push(CopyStamp {
        host_id: host,
        id: confirmed,
        at: time::OffsetDateTime::UNIX_EPOCH - time::Duration::hours(1),
    });
    let disk = Disk {
        copies,
        calls: Mutex::new(Vec::new()),
        fail: AtomicBool::new(true),
    };
    assert!(rotate(&disk, &store, &b, "2026-10-23T00:00:00Z")
        .await
        .is_err());
    assert_eq!(
        &disk.calls.lock().unwrap()[..2],
        ["complete.json", "database.age"]
    );
    assert_eq!(store.events().await.unwrap().len(), 1);
    drop(store);
    let store = DeliveryStore::open(&path).await.unwrap();
    let id = store.events().await.unwrap()[0].event_id;
    // A real catalog no longer returns the withdrawn snapshot after marker deletion.
    let removed = store.status().await.unwrap().purges[0].snapshot;
    let mut disk = disk;
    disk.copies.retain(|c| c.id != removed);
    rotate(&disk, &store, &b, "2026-10-23T00:00:00Z")
        .await
        .unwrap();
    assert_eq!(
        store
            .events()
            .await
            .unwrap()
            .iter()
            .filter(|e| e.event_id == id)
            .count(),
        1
    );
    assert!(store.status().await.unwrap().purges.is_empty());
}
#[test]
fn rotation_keeps_newest_union_and_just_confirmed_after_clock_rollback() {
    let host = Uuid::new_v4();
    let other = Uuid::new_v4();
    let mut copies: Vec<_> = (0..90)
        .map(|day| CopyStamp {
            host_id: host,
            id: SnapshotId::new(),
            at: time::OffsetDateTime::UNIX_EPOCH + time::Duration::days(day),
        })
        .collect();
    let confirmed = copies[0].id;
    let foreign = SnapshotId::new();
    copies.push(CopyStamp {
        host_id: other,
        id: foreign,
        at: time::OffsetDateTime::UNIX_EPOCH,
    });
    let removed = candidates(&copies, host, confirmed);
    assert!(!removed.contains(&confirmed));
    assert!(!removed.contains(&foreign));
    assert!(!removed.contains(&copies[89].id));
    assert!(!removed.is_empty());
}
