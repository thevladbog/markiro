mod support;
use markiro_backup_cloud::model::{ClientProfile, NativeCopyPaths, SnapshotId};
use markiro_host::{
    backup::{copy::make_copy_with_identity, identity::OwnerOnly},
    yandex::delivery::stage_native,
};
use markiro_proto::backup::BackupTrigger;
use std::sync::Arc;

#[test]
fn cloud_workspace_always_reserves_room_for_the_live_database() {
    use markiro_host::yandex::delivery::check_budget;
    assert!(check_budget(512 * 1024 * 1024 + 100, 100).is_ok());
    assert!(check_budget(512 * 1024 * 1024 + 99, 100).is_err());
    assert!(check_budget(u64::MAX, u64::MAX).is_err());
    let size = 10 * 1024 * 1024 * 1024;
    let free = 41 * 1024 * 1024 * 1024;
    assert!(check_budget(
        free,
        markiro_host::yandex::delivery::workspace_bytes(size, false).unwrap()
    )
    .is_ok());
    assert!(check_budget(
        free - size,
        markiro_host::yandex::delivery::workspace_bytes(size, true).unwrap()
    )
    .is_ok());
}

#[test]
fn cleanup_removes_only_retired_private_workspaces_and_keeps_active_stage() {
    use markiro_host::yandex::delivery::clean_workspaces;
    let dir = tempfile::tempdir().unwrap();
    let generation = uuid::Uuid::new_v4();
    let id = uuid::Uuid::new_v4();
    let active = format!("snapshot-{generation}-{id}");
    let retired = format!("snapshot-{}-{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let partial = format!("{active}.partial-{}", uuid::Uuid::new_v4());
    let verify = format!("verify-{}", uuid::Uuid::new_v4());
    for name in [
        &active,
        &retired,
        &partial,
        &verify,
        "unrelated",
        "snapshot-unknown",
    ] {
        std::fs::create_dir(dir.path().join(name)).unwrap();
    }
    std::fs::write(dir.path().join("credentials.bin"), b"synthetic").unwrap();
    clean_workspaces(dir.path(), Some(&active)).unwrap();
    for name in [&active, "unrelated", "snapshot-unknown", "credentials.bin"] {
        assert!(dir.path().join(name).exists());
    }
    for name in [&retired, &partial, &verify] {
        assert!(!dir.path().join(name).exists());
    }
}

#[tokio::test]
async fn staging_uses_snapshot_organization_and_keeps_original_native_manifest() {
    let admin = support::app::admin().await;
    let dir = tempfile::tempdir().unwrap();
    let identity = support::backup::write_identity(admin.app.dir(), &admin.app.state.host_id);
    let mut conn = support::backup::worker_conn(&admin.app).await;
    let manifest = make_copy_with_identity(
        &mut conn,
        dir.path(),
        admin.app.state.now(),
        BackupTrigger::Manual,
        &admin.app.state.host_id,
        Some(Arc::new(identity)),
        Arc::new(OwnerOnly),
    )
    .await
    .unwrap();
    let source = NativeCopyPaths::beside(dir.path().join(&manifest.file));
    let original = std::fs::read(&source.manifest).unwrap();
    let expected: (String, Option<String>) =
        sqlx::query_as("SELECT name,inn FROM org_profile WHERE id=1")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    sqlx::query("UPDATE org_profile SET name='changed after snapshot'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let stage = stage_native(
        source.clone(),
        ClientProfile::new("client").unwrap(),
        dir.path().join("stage"),
        SnapshotId::new(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(stage.complete.organization_label, expected.0);
    assert_eq!(stage.complete.inn, expected.1.unwrap_or_default());
    assert_eq!(stage.complete.app_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(std::fs::read(&source.manifest).unwrap(), original);
    let wrong = markiro_host::yandex::state::SourceContext {
        restore_epoch: Some("another dataset".into()),
        dataset_epoch: None,
    };
    assert!(stage_native(
        source,
        ClientProfile::new("client").unwrap(),
        dir.path().join("wrong"),
        SnapshotId::new(),
        None,
        Some(wrong)
    )
    .await
    .is_err());
    assert!(!dir.path().join("wrong").exists());
}

#[tokio::test]
async fn recovery_verifier_identifies_a_newer_schema_before_ready() {
    let admin = support::app::admin().await;
    let dir = tempfile::tempdir().unwrap();
    let identity = support::backup::write_identity(admin.app.dir(), &admin.app.state.host_id);
    let mut conn = support::backup::worker_conn(&admin.app).await;
    let manifest = make_copy_with_identity(
        &mut conn,
        dir.path(),
        admin.app.state.now(),
        BackupTrigger::Manual,
        &admin.app.state.host_id,
        Some(Arc::new(identity)),
        Arc::new(OwnerOnly),
    )
    .await
    .unwrap();
    let paths = NativeCopyPaths::beside(dir.path().join(manifest.file));
    markiro_host::yandex::delivery::verify_native(paths.clone())
        .await
        .unwrap();
    let before = std::fs::read(&paths.database).unwrap();
    let mut sidecar: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&paths.manifest).unwrap()).unwrap();
    sidecar["schemaVersion"] = serde_json::json!(i64::MAX);
    std::fs::write(&paths.manifest, serde_json::to_vec(&sidecar).unwrap()).unwrap();
    assert!(matches!(
        markiro_host::yandex::delivery::verify_native(paths.clone()).await,
        Err(markiro_backup_cloud::Error::Provider(
            "incompatible_version"
        ))
    ));
    assert_eq!(std::fs::read(paths.database).unwrap(), before);
}
