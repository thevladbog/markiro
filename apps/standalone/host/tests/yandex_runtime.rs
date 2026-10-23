mod support;
use markiro_backup_cloud::{
    model::Secret,
    oauth::{ApiRequest, ApiResponse, Transport},
    Result,
};
use markiro_host::yandex::{
    connection::{AccountVerifier, AttemptOwner, VerifiedAccount, YandexService},
    runtime,
    secret_store::Protector,
};
use markiro_proto::yandex_backups::{ConnectionState, ErrorCode};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use uuid::Uuid;

struct Cipher;
impl Protector for Cipher {
    fn protect(&self, b: &[u8]) -> Result<Vec<u8>> {
        Ok(b.iter().map(|b| b ^ 0xa5).collect())
    }
    fn unprotect(&self, b: &[u8]) -> Result<Vec<u8>> {
        self.protect(b)
    }
}
#[derive(Default)]
struct Provider {
    calls: AtomicUsize,
    reject: AtomicBool,
    delayed: std::sync::Mutex<Option<Arc<markiro_host::clock::ManualClock>>>,
}
impl Transport for Provider {
    fn send(
        &self,
        _: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reject = self.reject.load(Ordering::SeqCst);
        Box::pin(async move {
            if let Some(clock) = self.delayed.lock().unwrap().as_ref() {
                clock.advance(time::Duration::hours(1));
                return Err(markiro_backup_cloud::Error::RetryAfter {
                    seconds: 120,
                    status: 503,
                });
            }
            Ok(if reject {
                ApiResponse {
                    status: 400,
                    body: br#"{"error":"invalid_client"}"#.to_vec(),
                }
            } else {
                ApiResponse{status:200,body:br#"{"access_token":"access","refresh_token":"refresh","expires_in":1,"token_type":"bearer"}"#.to_vec()}
            })
        })
    }
}

#[tokio::test]
async fn retry_after_starts_when_the_slow_request_fails() {
    let (admin, service, provider) = configured().await;
    *provider.delayed.lock().unwrap() = Some(admin.app.clock.clone());
    runtime::tick(&admin.app.state, &service).await.unwrap();
    let now = admin.app.state.now().unix_timestamp();
    assert_eq!(
        service.journal.status().await.unwrap().refresh_retry_at,
        now + 120
    );
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    admin.app.clock.advance(time::Duration::seconds(119));
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    admin.app.clock.advance(time::Duration::seconds(1));
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn missing_source_and_oversized_stage_do_not_block_next_pending() {
    for oversized in [false, true] {
        let (admin, service, _) = configured().await;
        let generation = service
            .journal
            .status()
            .await
            .unwrap()
            .binding
            .unwrap()
            .generation;
        service
            .queue
            .offer("markiro-host-missing.db")
            .await
            .unwrap();
        let (job, pin) = service.queue.claim(generation).await.unwrap().unwrap();
        drop(pin);
        if oversized {
            let stage = service
                .private_dir
                .join(format!("snapshot-{generation}-{}", job.snapshot_id.0));
            std::fs::create_dir(&stage).unwrap();
            std::fs::write(stage.join("complete.json"), vec![b' '; 65537]).unwrap();
        }
        service.queue.offer("markiro-host-next.db").await.unwrap();
        let state =
            admin
                .app
                .state
                .clone()
                .with_backups(markiro_host::backup::Backups::from_paths(
                    &markiro_host::config::HostPaths::new(admin.app.dir()),
                    admin.app.state.host_id.clone(),
                ));
        markiro_host::yandex::delivery::tick(&state, &service)
            .await
            .unwrap();
        assert!(service.journal.status().await.unwrap().active.is_none());
        assert_eq!(
            service
                .queue
                .claim(generation)
                .await
                .unwrap()
                .unwrap()
                .0
                .source_file,
            "markiro-host-next.db"
        );
    }
}
struct Verifier;
impl AccountVerifier for Verifier {
    fn verify(
        &self,
        _: &Secret,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAccount>> + Send + '_>> {
        Box::pin(async {
            Ok(VerifiedAccount {
                id: "account".into(),
                label: "account".into(),
            })
        })
    }
}
async fn configured() -> (support::app::Admin, Arc<YandexService>, Arc<Provider>) {
    let admin = support::app::admin().await;
    let provider = Arc::new(Provider::default());
    let service = YandexService::with_dependencies(
        admin.app.dir(),
        Uuid::parse_str(&admin.app.state.host_id).unwrap(),
        provider.clone(),
        Box::new(Cipher),
        Arc::new(Verifier),
    )
    .await
    .unwrap();
    let owner = AttemptOwner {
        user_id: admin.id.clone(),
        device_id: Uuid::new_v4().to_string(),
        session_id: Uuid::new_v4().to_string(),
        source: Default::default(),
    };
    let reply = service
        .begin(
            &owner,
            "customer-client",
            Secret::client_secret("customer-secret".into()).unwrap(),
            None,
            admin.app.state.now().unix_timestamp(),
        )
        .await
        .unwrap();
    let state = reqwest::Url::parse(&reply.authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let prepared = service
        .prepare_complete(
            &owner,
            Uuid::parse_str(&reply.attempt_id).unwrap(),
            &state,
            "code",
            admin.app.state.now().unix_timestamp(),
        )
        .await
        .unwrap();
    service
        .commit(prepared, &admin.app.state.timestamp())
        .await
        .unwrap();
    (admin, service, provider)
}

#[tokio::test]
async fn runtime_refreshes_after_all_office_sessions_are_closed() {
    let (admin, service, provider) = configured().await;
    sqlx::query("DELETE FROM office_sessions")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    assert_eq!(
        service
            .tokens
            .current_credentials()
            .await
            .unwrap()
            .unwrap()
            .client_secret
            .expose(),
        "customer-secret"
    );
}
#[tokio::test]
async fn invalid_client_stops_automatic_refresh_until_native_reconnect() {
    let (admin, service, provider) = configured().await;
    provider.reject.store(true, Ordering::SeqCst);
    runtime::tick(&admin.app.state, &service).await.unwrap();
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    let state = service
        .status(admin.app.state.now().unix_timestamp())
        .await
        .unwrap();
    assert_eq!(state.state, ConnectionState::ReauthRequired);
    assert_eq!(state.error_code, Some(ErrorCode::ClientCredentialsInvalid));
}
#[tokio::test]
async fn restored_source_pauses_cloud_before_any_new_yandex_request() {
    let (admin, service, provider) = configured().await;
    sqlx::query("UPDATE site SET restore_epoch='new-restored-epoch'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    runtime::tick(&admin.app.state, &service).await.unwrap();
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert!(service.journal.status().await.unwrap().paused);
    assert_eq!(
        service
            .status(admin.app.state.now().unix_timestamp())
            .await
            .unwrap()
            .error_code,
        Some(ErrorCode::ClientSecretRequired)
    );
}

#[tokio::test]
async fn worker_wake_preserves_one_permit_for_each_independent_loop() {
    let (_admin, service, _) = configured().await;
    // Drain permits from connection commit before simulating an explicit retry.
    service.wake.notified().await;
    service.wake_refresh.notified().await;
    service.wake_workers();
    tokio::time::timeout(std::time::Duration::from_millis(100), async {
        service.wake_refresh.notified().await;
        service.wake.notified().await;
    })
    .await
    .expect("refresh must not consume delivery's retry signal");
}

#[tokio::test]
async fn delivery_preserves_and_does_not_retry_permanent_credential_errors() {
    let (admin, service, provider) = configured().await;
    let generation = service
        .journal
        .status()
        .await
        .unwrap()
        .binding
        .unwrap()
        .generation;
    service
        .queue
        .offer("markiro-host-missing.db")
        .await
        .unwrap();
    let (job, _) = service.queue.claim(generation).await.unwrap().unwrap();
    service
        .journal
        .fail(generation, job.snapshot_id, "secret_unavailable", 0)
        .await
        .unwrap();
    let calls = provider.calls.load(Ordering::SeqCst);
    markiro_host::yandex::delivery::tick(&admin.app.state, &service)
        .await
        .unwrap();
    let status = service
        .status(admin.app.state.now().unix_timestamp())
        .await
        .unwrap();
    assert_eq!(status.error_code, Some(ErrorCode::SecretUnavailable));
    assert_eq!(
        service
            .journal
            .status()
            .await
            .unwrap()
            .active
            .unwrap()
            .failures,
        1
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), calls);
}
