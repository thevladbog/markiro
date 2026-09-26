use markiro_host::config::{ConfigError, HostConfig, HostPaths};
use markiro_host::db;
use markiro_host::tls::{TlsError, TlsIdentity};

#[test]
fn host_id_persists_and_port_override_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let first = HostConfig::load_or_create(&paths, None).unwrap();
    assert_eq!(first.port, markiro_proto::DEFAULT_PORT);
    let second = HostConfig::load_or_create(&paths, Some(46000)).unwrap();
    assert_eq!(second.host_id, first.host_id);
    assert_eq!(second.port, 46000);
    let third = HostConfig::load_or_create(&paths, None).unwrap();
    assert_eq!(third.port, 46000);
}

#[test]
fn corrupt_config_is_reported_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    std::fs::write(paths.config_file(), b"{not json").unwrap();
    assert!(HostConfig::load_or_create(&paths, None).is_err());
    assert_eq!(std::fs::read(paths.config_file()).unwrap(), b"{not json");
}

#[test]
fn port_zero_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    assert!(HostConfig::load_or_create(&paths, Some(0)).is_err());
}

#[test]
fn tls_identity_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let first = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let second = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(
        first.fingerprint,
        markiro_proto::certificate_fingerprint(&first.cert_der)
    );
    assert_eq!(first.fingerprint.len(), 64);
    first.server_config().unwrap();
}

#[test]
fn incomplete_tls_identity_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    std::fs::remove_file(dir.path().join("cert.der")).unwrap();
    assert!(TlsIdentity::load_or_create(dir.path(), "host-a").is_err());
}

#[cfg(unix)]
#[test]
fn private_key_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let mode = std::fs::metadata(dir.path().join("key.der"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn debug_output_never_contains_the_key() {
    let dir = tempfile::tempdir().unwrap();
    let identity = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let debug = format!("{identity:?}");
    assert!(debug.contains(&identity.fingerprint));
    assert!(!debug.contains("key"));
}

#[tokio::test]
async fn migrations_apply_once_and_site_starts_uninitialized() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("host.db");
    let pool = db::open(&path).await.unwrap();
    assert!(!db::is_initialized(&pool).await.unwrap());
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rev, 0);
    pool.close().await;

    let reopened = db::open(&path).await.unwrap();
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(applied, 1);
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(journal, "wal");
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(synchronous, 2);
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(&reopened)
        .await
        .unwrap();
    assert_eq!(busy_timeout, 5000);
}

#[tokio::test]
async fn deleting_host_json_does_not_get_recreated_by_load_or_create() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let config = HostConfig::load_or_create(&paths, None).unwrap();
    let pool = db::open(&paths.database_file()).await.unwrap();
    TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id).unwrap();
    pool.close().await;

    std::fs::remove_file(paths.config_file()).unwrap();
    assert!(HostConfig::load_or_create(&paths, None).is_err());
    assert!(!paths.config_file().exists());
}

#[test]
fn host_config_load_on_an_empty_dir_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    assert!(matches!(
        HostConfig::load(&paths),
        Err(ConfigError::Missing { .. })
    ));
}

#[test]
fn tls_identity_load_is_missing_on_an_empty_dir_and_matches_load_or_create_when_present() {
    let dir = tempfile::tempdir().unwrap();
    assert!(matches!(
        TlsIdentity::load(dir.path()),
        Err(TlsError::Missing { .. })
    ));

    let created = TlsIdentity::load_or_create(dir.path(), "host-a").unwrap();
    let loaded = TlsIdentity::load(dir.path()).unwrap();
    assert_eq!(loaded.fingerprint, created.fingerprint);
}

#[test]
fn load_or_create_without_an_override_does_not_rewrite_an_existing_file() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    paths.ensure().unwrap();
    let hand_formatted: &[u8] =
        b"{\n  \"hostId\":   \"3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f\",\n  \"port\": 45710\n}\n";
    std::fs::write(paths.config_file(), hand_formatted).unwrap();

    let config = HostConfig::load_or_create(&paths, None).unwrap();
    assert_eq!(config.port, 45710);
    assert_eq!(std::fs::read(paths.config_file()).unwrap(), hand_formatted);
}
