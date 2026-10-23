use markiro_host::yandex::{
    queue::CloudQueue,
    state::{Binding, DeliveryStore},
};
use std::sync::Arc;
use uuid::Uuid;

#[tokio::test]
async fn pins_follow_active_and_latest_pending_across_restart_and_claim() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let store = Arc::new(DeliveryStore::open(&path).await.unwrap());
    let b = Binding {
        generation: Uuid::new_v4(),
        client_id: "client".into(),
        account_id: "account".into(),
        host_id: Uuid::new_v4(),
        source: Default::default(),
    };
    store.connect(&b).await.unwrap();
    let queue = CloudQueue::open(store.clone()).await.unwrap();
    queue.offer("markiro-host-one.db").await.unwrap();
    let (job, pin) = queue.claim(b.generation).await.unwrap().unwrap();
    queue.offer("markiro-host-two.db").await.unwrap();
    queue.offer("markiro-host-three.db").await.unwrap();
    assert_eq!(
        queue.pins.names(),
        ["markiro-host-one.db", "markiro-host-three.db"]
    );
    queue.staged(&job.source_file).await;
    drop(pin); // private staging finished
    assert_eq!(queue.pins.names(), ["markiro-host-three.db"]);
    drop(queue);
    let queue = CloudQueue::open(store.clone()).await.unwrap();
    assert_eq!(
        queue.pins.names(),
        ["markiro-host-one.db", "markiro-host-three.db"]
    );
    let (resumed, pin) = queue.claim(b.generation).await.unwrap().unwrap();
    assert_eq!(job.snapshot_id, resumed.snapshot_id);
    drop(pin);
    store
        .confirm(
            b.generation,
            job.snapshot_id,
            "2026-10-23T01:00:00Z",
            "2026-10-23T01:00:00Z",
        )
        .await
        .unwrap();
    let (next, _pin) = queue.claim(b.generation).await.unwrap().unwrap();
    assert_eq!(next.source_file, "markiro-host-three.db");
}

#[tokio::test]
async fn disconnected_offers_do_not_pin_or_queue_local_backups() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(
        DeliveryStore::open(&dir.path().join("state.db"))
            .await
            .unwrap(),
    );
    let queue = CloudQueue::open(store.clone()).await.unwrap();
    queue.offer("markiro-host-one.db").await.unwrap();
    assert!(queue.pins.names().is_empty());
    assert!(store.status().await.unwrap().pending.is_none());
}
