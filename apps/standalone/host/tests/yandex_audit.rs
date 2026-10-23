mod support;
use markiro_host::{
    db::begin_write,
    yandex::{
        audit_outbox::{flush_events, write_events_in},
        state::{Binding, CloudAuditAction, CloudAuditEvent, DeliveryStore},
    },
};
use support::app::{admin, audit_trail};
use uuid::Uuid;

#[tokio::test]
async fn replay_after_business_commit_before_ack_writes_one_exact_audit_row() {
    let admin = admin().await;
    let store = DeliveryStore::open(&admin.app.dir().join("delivery.db"))
        .await
        .unwrap();
    let binding = Binding {
        generation: Uuid::new_v4(),
        client_id: "customer-client".into(),
        account_id: "account".into(),
        host_id: Uuid::parse_str(&admin.app.state.host_id).unwrap(),
        source: Default::default(),
    };
    let event = CloudAuditEvent {
        event_id: Uuid::new_v4(),
        at: admin.app.state.timestamp(),
        actor_user_id: Some(Uuid::parse_str(&admin.id).unwrap()),
        action: CloudAuditAction::Connect,
        target_id: binding.generation,
        client_id: binding.client_id.clone(),
        account_id: binding.account_id.clone(),
        host_id: binding.host_id,
        snapshot_id: None,
    };
    store
        .connect_with_event(&binding, Some(event.clone()))
        .await
        .unwrap();
    let mut tx = begin_write(&admin.app.state.pool).await.unwrap();
    write_events_in(&mut tx, &store.events().await.unwrap())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    flush_events(&admin.app.state.pool, &store).await.unwrap();
    flush_events(&admin.app.state.pool, &store).await.unwrap();
    assert!(store.events().await.unwrap().is_empty());
    let rows = audit_trail(&admin.app, "backup.yandex.connect").await;
    assert_eq!(
        rows,
        vec![(
            "office_user".into(),
            Some(admin.id.clone()),
            "backup.yandex.connect".into(),
            Some("backup_yandex_connection".into()),
            Some(binding.generation.to_string()),
            "ok".into(),
            serde_json::json!({"eventId":event.event_id,"clientId":"customer-client","accountId":"account","hostId":binding.host_id})
        )]
    );
}
