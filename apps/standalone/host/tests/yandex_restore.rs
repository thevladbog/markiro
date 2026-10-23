mod support;
#[tokio::test]
async fn new_pc_restore_gate_refuses_initialized_target_without_changing_bytes() {
    let admin = support::app::admin().await;
    let paths = markiro_host::config::HostPaths::new(admin.app.dir());
    let before = std::fs::read(paths.database_file()).unwrap();
    assert!(markiro_host::restore::require_empty_target(&paths)
        .await
        .is_err());
    assert_eq!(std::fs::read(paths.database_file()).unwrap(), before);
}

async fn copy(
    admin: &support::app::Admin,
    dir: &std::path::Path,
) -> markiro_host::backup::copy::Manifest {
    let identity = support::backup::write_identity(admin.app.dir(), &admin.app.state.host_id);
    let mut conn = support::backup::worker_conn(&admin.app).await;
    markiro_host::backup::copy::make_copy_with_identity(
        &mut conn,
        dir,
        admin.app.state.now(),
        markiro_proto::backup::BackupTrigger::Manual,
        &admin.app.state.host_id,
        Some(std::sync::Arc::new(identity)),
        std::sync::Arc::new(markiro_host::backup::identity::OwnerOnly),
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn empty_gate_checks_after_reconciling_an_interrupted_working_database() {
    let admin = support::app::admin().await;
    let dir = tempfile::tempdir().unwrap();
    let m = copy(&admin, dir.path()).await;
    let source = dir.path().join(&m.file);
    sqlx::query("UPDATE org_profile SET name='working data after snapshot'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    admin.app.state.pool.close().await;
    let paths = markiro_host::config::HostPaths::new(admin.app.dir());
    markiro_host::restore::restore_crashing(
        &paths,
        &source,
        false,
        admin.app.state.now(),
        markiro_host::restore::CrashPoint::DatabaseAside,
    )
    .await
    .unwrap();
    assert!(
        markiro_host::restore::restore_empty_with(&paths, &source, admin.app.state.now())
            .await
            .is_err()
    );
    use sqlx::ConnectOptions;
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(paths.database_file())
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM org_profile WHERE id=1")
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(name, "working data after snapshot");
}
#[tokio::test]
async fn recovery_receipt_finishes_identity_once_without_applying_snapshot_again() {
    let admin = support::app::admin().await;
    let dir = tempfile::tempdir().unwrap();
    let m = copy(&admin, dir.path()).await;
    let source = dir.path().join(&m.file);
    let target = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(target.path());
    markiro_host::config::HostConfig::load_or_create(&paths, None).unwrap();
    let pool = markiro_host::db::open(&paths.database_file())
        .await
        .unwrap();
    pool.close().await;
    markiro_host::restore::restore_crashing(
        &paths,
        &source,
        false,
        admin.app.state.now(),
        markiro_host::restore::CrashPoint::NewDatabaseInPlace,
    )
    .await
    .unwrap();
    assert!(markiro_host::restore::resume_empty_with_receipt(
        &paths,
        &m.sha256,
        &admin.app.state.timestamp()
    )
    .await
    .unwrap());
    let first = std::fs::read(paths.database_file()).unwrap();
    assert!(markiro_host::restore::resume_empty_with_receipt(
        &paths,
        &m.sha256,
        &admin.app.state.timestamp()
    )
    .await
    .unwrap());
    assert_eq!(std::fs::read(paths.database_file()).unwrap(), first);
}
