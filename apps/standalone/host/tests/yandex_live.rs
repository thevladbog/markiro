//! Explicit live smoke: synthetic temp DB only, no credentials on disk or logs.
mod support;
use markiro_backup_cloud::{
    callback::CallbackListener,
    client::{DiskClient, RemoteObject},
    envelope,
    model::{ClientProfile, NativeCopyPaths, Secret, SnapshotId, OBJECTS},
    oauth::{DirectTransport, OAuthAttempt, OAuthClient},
    publication::{self, ObjectTransport, TransferFuture},
};
use std::{path::Path, sync::Arc};

struct Remote {
    client: DiskClient,
    host: uuid::Uuid,
    snapshot: uuid::Uuid,
}
impl ObjectTransport for Remote {
    fn put<'a>(&'a self, name: &'a str, source: &'a Path) -> TransferFuture<'a> {
        Box::pin(async move {
            println!("LIVE_PUT {name}");
            self.client
                .put_new(&RemoteObject::new(self.host, self.snapshot, name)?, source)
                .await
        })
    }
    fn get<'a>(&'a self, name: &'a str, target: &'a Path) -> TransferFuture<'a> {
        Box::pin(async move {
            println!("LIVE_GET {name}");
            self.client
                .get_stream(&RemoteObject::new(self.host, self.snapshot, name)?, target)
                .await
        })
    }
}

#[tokio::test]
#[ignore = "live Yandex OAuth + synthetic upload; explicitly run with AUTONOM_YANDEX_LIVE=1"]
async fn synthetic_publish_download_and_restore() {
    assert_eq!(std::env::var("AUTONOM_YANDEX_LIVE").as_deref(), Ok("1"));
    let client_id = "dacd86d869664a09847d6a54e6f26fac";
    let now = || time::OffsetDateTime::now_utc().unix_timestamp();
    let mut attempt = OAuthAttempt::new(client_id, now()).unwrap();
    let url = attempt.authorization_url().unwrap();
    let state = Secret::new(
        url.query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned(),
    )
    .unwrap();
    let listener = CallbackListener::bind().await.unwrap();
    // Public authorization URL only; code/verifier/tokens are never printed.
    std::fs::write(
        "/private/tmp/autonom-yandex-live-authorize-url.txt",
        url.as_str(),
    )
    .unwrap();
    println!("LIVE_READY_FOR_BROWSER");
    let code = listener.receive(&state).await.unwrap();
    let oauth = OAuthClient::new(DirectTransport::new().unwrap());
    let tokens = oauth
        .complete(&mut attempt, code.state.expose(), code.code.expose(), now())
        .await
        .unwrap();
    let remote_client = DiskClient::new(tokens.access).unwrap();
    remote_client.check_folder().await.unwrap();
    remote_client.account().await.unwrap();
    println!("LIVE_AUTHENTICATED");

    let admin = support::app::admin().await;
    sqlx::query("UPDATE org_profile SET name='AUTONOM SYNTHETIC DISK SMOKE'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let identity = support::backup::write_identity(admin.app.dir(), &admin.app.state.host_id);
    let mut conn = support::backup::worker_conn(&admin.app).await;
    let copy = markiro_host::backup::copy::make_copy_with_identity(
        &mut conn,
        dir.path(),
        time::OffsetDateTime::now_utc(),
        markiro_proto::backup::BackupTrigger::Manual,
        &admin.app.state.host_id,
        Some(Arc::new(identity)),
        Arc::new(markiro_host::backup::identity::OwnerOnly),
    )
    .await
    .unwrap();
    let source = NativeCopyPaths::beside(dir.path().join(&copy.file));
    let original =
        [&source.database, &source.manifest, &source.identity].map(|p| std::fs::read(p).unwrap());
    let profile = ClientProfile::new(client_id).unwrap();
    let snapshot = SnapshotId::new();
    let staged = markiro_host::yandex::delivery::stage_native(
        source.clone(),
        profile,
        dir.path().join("stage"),
        snapshot,
        None,
        None,
    )
    .await
    .unwrap();
    let host = staged.complete.host_id;
    let remote = Remote {
        client: remote_client.clone(),
        host,
        snapshot: snapshot.0,
    };
    remote_client
        .ensure_snapshot_dir(host, snapshot.0)
        .await
        .unwrap();
    println!(
        "LIVE_PUBLISHING {} bytes",
        staged
            .complete
            .objects
            .values()
            .map(|o| o.size_bytes)
            .sum::<u64>()
    );
    publication::publish(
        &remote,
        &staged,
        client_id,
        &dir.path().join("verify"),
        markiro_host::yandex::delivery::verify_native,
    )
    .await
    .unwrap();
    println!("LIVE_PUBLISHED_AND_READBACK_VERIFIED");
    let catalog = markiro_backup_cloud::catalog::list(
        &remote_client,
        client_id,
        Some(host),
        &dir.path().join("catalog"),
    )
    .await
    .unwrap();
    assert_eq!(catalog.len(), 1);
    assert_eq!(catalog[0], staged.complete);
    let downloaded = dir.path().join("downloaded");
    envelope::private_dir(&downloaded).unwrap();
    for name in std::iter::once("complete.json").chain(OBJECTS) {
        remote.get(name, &downloaded.join(name)).await.unwrap();
    }
    let native =
        envelope::open_copy(&downloaded, client_id, &dir.path().join("new-pc-native")).unwrap();
    markiro_host::yandex::delivery::verify_native(native.clone())
        .await
        .unwrap();
    for (path, expected) in [&native.database, &native.manifest, &native.identity]
        .into_iter()
        .zip(original)
    {
        assert_eq!(std::fs::read(path).unwrap(), expected);
    }
    let target = tempfile::tempdir().unwrap();
    let paths = markiro_host::config::HostPaths::new(target.path());
    markiro_host::config::HostConfig::load_or_create(&paths, None).unwrap();
    markiro_host::db::open(&paths.database_file())
        .await
        .unwrap()
        .close()
        .await;
    markiro_host::restore::restore_empty_with(
        &paths,
        &native.database,
        time::OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    use sqlx::ConnectOptions;
    let mut restored = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(paths.database_file())
        .read_only(true)
        .connect()
        .await
        .unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM org_profile WHERE id=1")
        .fetch_one(&mut restored)
        .await
        .unwrap();
    assert_eq!(name, "AUTONOM SYNTHETIC DISK SMOKE");
    let report = serde_json::json!({
        "date":"2026-10-23", "platform":"macOS, not Windows service", "clientId":client_id,
        "hostId":host, "snapshotId":snapshot.0, "remotePath":format!("app:/backups/v1/{host}/{}",snapshot.0),
        "syntheticOnly":true, "clientSecretUsed":false, "tokensPersisted":false,
        "checks":{"pkce":true,"appFolder":true,"upload":true,"publicationFullReadback":true,"catalog":true,"independentDownload":true,"threeNativeFilesByteEqual":true,"sqliteIdentityVerification":true,"emptyTargetRestore":true},
        "encryptedBytes":staged.complete.objects.values().map(|o|o.size_bytes).sum::<u64>(),
        "nativeDatabaseBytes":copy.size_bytes,
        "markiroBrokerUsed":false,"originPolicy":"production DiskClient fixed OAuth/API endpoints, public DNS and signed-transfer allowlist; no proxy/automatic redirect; at most three validated download redirects",
        "remoteCopyRetained":true,"windowsValidated":false
    });
    std::fs::write(
        "/private/tmp/autonom-yandex-live-result.json",
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("LIVE_PASS {}", report);
}
