use markiro_host::yandex::state::{Binding, CloudAuditAction, CloudAuditEvent, DeliveryStore};
use uuid::Uuid;

fn binding() -> Binding {
    Binding {
        generation: Uuid::new_v4(),
        client_id: "client".into(),
        account_id: "account".into(),
        host_id: Uuid::new_v4(),
        source: Default::default(),
    }
}

#[tokio::test]
async fn old_source_observation_cannot_pause_a_new_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DeliveryStore::open(&tmp.path().join("state.db"))
        .await
        .unwrap();
    let old = binding();
    store.connect(&old).await.unwrap();
    let mut new = binding();
    new.source.restore_epoch = Some("new".into());
    store.connect(&new).await.unwrap();
    assert!(store
        .observe_source(old.generation, &Default::default())
        .await
        .is_err());
    assert!(!store.status().await.unwrap().paused);
}

#[tokio::test]
async fn rejected_source_does_not_block_new_valid_pending_copy() {
    let dir = tempfile::tempdir().unwrap();
    let store = DeliveryStore::open(&dir.path().join("state.db"))
        .await
        .unwrap();
    let b = binding();
    store.connect(&b).await.unwrap();
    store
        .enqueue_latest(b.generation, "markiro-host-bad.db")
        .await
        .unwrap();
    let bad = store.claim(b.generation).await.unwrap().unwrap();
    store
        .enqueue_latest(b.generation, "markiro-host-good.db")
        .await
        .unwrap();
    store
        .reject(b.generation, bad.snapshot_id, "integrity")
        .await
        .unwrap();
    assert_eq!(
        store
            .claim(b.generation)
            .await
            .unwrap()
            .unwrap()
            .source_file,
        "markiro-host-good.db"
    );
}

#[tokio::test]
async fn queue_coalesces_latest_and_survives_restart() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("delivery.db");
    let store = DeliveryStore::open(&path).await.unwrap();
    let bound = binding();
    store.connect(&bound).await.unwrap();
    store
        .enqueue_latest(bound.generation, "markiro-host-one.db")
        .await
        .unwrap();
    let first = store.claim(bound.generation).await.unwrap().unwrap();
    store
        .enqueue_latest(bound.generation, "markiro-host-two.db")
        .await
        .unwrap();
    store
        .enqueue_latest(bound.generation, "markiro-host-three.db")
        .await
        .unwrap();
    drop(store);
    let store = DeliveryStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .claim(bound.generation)
            .await
            .unwrap()
            .unwrap()
            .snapshot_id,
        first.snapshot_id
    );
    store
        .confirm(
            bound.generation,
            first.snapshot_id,
            "2026-10-23T01:00:00Z",
            "2026-10-22T23:00:00Z",
        )
        .await
        .unwrap();
    assert_eq!(
        store
            .claim(bound.generation)
            .await
            .unwrap()
            .unwrap()
            .source_file,
        "markiro-host-three.db"
    );
    let state = store.status().await.unwrap();
    assert_eq!(state.last_copy_at.as_deref(), Some("2026-10-22T23:00:00Z"));
    assert_eq!(
        state.last_upload_at.as_deref(),
        Some("2026-10-23T01:00:00Z")
    );
}

#[tokio::test]
async fn disconnect_and_reconnect_fence_old_generation_and_late_confirm() {
    let tmp = tempfile::tempdir().unwrap();
    let store = DeliveryStore::open(&tmp.path().join("delivery.db"))
        .await
        .unwrap();
    let old = binding();
    store.connect(&old).await.unwrap();
    store
        .enqueue_latest(old.generation, "markiro-host-one.db")
        .await
        .unwrap();
    let job = store.claim(old.generation).await.unwrap().unwrap();
    store.disconnect(old.generation).await.unwrap();
    let next = binding();
    store.connect(&next).await.unwrap();
    assert!(!store.is_current(old.generation).await.unwrap());
    assert!(store
        .confirm(
            old.generation,
            job.snapshot_id,
            "2026-10-23T01:00:00Z",
            "2026-10-22T23:00:00Z"
        )
        .await
        .is_err());
    assert!(store
        .enqueue_latest(old.generation, "markiro-host-two.db")
        .await
        .is_err());
    assert!(store.status().await.unwrap().last_upload_at.is_none());
}

#[tokio::test]
async fn audit_outbox_survives_restart_and_connection_switch_until_explicit_ack() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("delivery.db");
    let store = DeliveryStore::open(&path).await.unwrap();
    let old = binding();
    let event = CloudAuditEvent {
        event_id: Uuid::new_v4(),
        at: "2026-10-23T01:00:00Z".into(),
        actor_user_id: Some(Uuid::new_v4()),
        action: CloudAuditAction::Connect,
        target_id: old.generation,
        client_id: old.client_id.clone(),
        account_id: old.account_id.clone(),
        host_id: old.host_id,
        snapshot_id: None,
    };
    store
        .connect_with_event(&old, Some(event.clone()))
        .await
        .unwrap();
    store.disconnect(old.generation).await.unwrap();
    let next = binding();
    store.connect(&next).await.unwrap();
    drop(store);
    let store = DeliveryStore::open(&path).await.unwrap();
    assert_eq!(store.events().await.unwrap(), vec![event.clone()]);
    store.ack_event(event.event_id).await.unwrap();
    store.ack_event(event.event_id).await.unwrap();
    assert!(store.events().await.unwrap().is_empty());
}
