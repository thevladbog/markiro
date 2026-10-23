use markiro_backup_cloud::{model::*, oauth::*, Result};
use markiro_host::yandex::{
    secret_store::{Protector, ServiceCredentialStore},
    state::DeliveryStore,
    tokens::TokenSupervisor,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

struct TestCipher;
impl Protector for TestCipher {
    fn protect(&self, b: &[u8]) -> Result<Vec<u8>> {
        Ok(b.iter().map(|b| b ^ 0xa5).collect())
    }
    fn unprotect(&self, b: &[u8]) -> Result<Vec<u8>> {
        self.protect(b)
    }
}

struct UnreadableOldCipher;
impl Protector for UnreadableOldCipher {
    fn protect(&self, b: &[u8]) -> Result<Vec<u8>> {
        Ok(b.iter().map(|b| b ^ 0xa5).collect())
    }
    fn unprotect(&self, _: &[u8]) -> Result<Vec<u8>> {
        Err(markiro_backup_cloud::Error::SecretUnavailable)
    }
}

#[tokio::test]
async fn journal_failure_restores_original_ciphertext_without_decrypting_it() {
    use sqlx::ConnectOptions;
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let dir = tmp.path().join("private");
    let journal_path = tmp.path().join("delivery.db");
    let store = Arc::new(ServiceCredentialStore::with_protector(&dir, TestCipher).unwrap());
    let journal = Arc::new(DeliveryStore::open(&journal_path).await.unwrap());
    let provider = Provider {
        calls: Default::default(),
        started: None,
        release: None,
    };
    let first = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal.clone(),
        host,
        OAuthClient::new(provider.clone()),
    ));
    let old = credentials(host);
    let old_generation = old.generation;
    first.replace_if_current(old, None).await.unwrap();
    let before = std::fs::read(dir.join("credentials.dpapi")).unwrap();
    let fresh = credentials(host);
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&journal_path)
        .connect()
        .await
        .unwrap();
    sqlx::query(&format!("CREATE TRIGGER reject_new_generation BEFORE UPDATE ON delivery WHEN instr(NEW.state, '{}') > 0 BEGIN SELECT RAISE(FAIL, 'synthetic journal failure'); END",fresh.generation)).execute(&mut conn).await.unwrap();
    let unreadable =
        Arc::new(ServiceCredentialStore::with_protector(&dir, UnreadableOldCipher).unwrap());
    let supervisor = Arc::new(TokenSupervisor::new(
        unreadable,
        journal.clone(),
        host,
        OAuthClient::new(provider),
    ));
    assert!(supervisor
        .replace_if_current(fresh, Some(old_generation))
        .await
        .is_err());
    assert_eq!(
        std::fs::read(dir.join("credentials.dpapi")).unwrap(),
        before
    );
    assert_eq!(
        journal.status().await.unwrap().binding.unwrap().generation,
        old_generation
    );
}

#[tokio::test]
async fn verified_reconnect_does_not_need_decryptable_old_credentials() {
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let dir = tmp.path().join("private");
    let store = Arc::new(ServiceCredentialStore::with_protector(&dir, TestCipher).unwrap());
    let journal = Arc::new(
        DeliveryStore::open(&tmp.path().join("delivery.db"))
            .await
            .unwrap(),
    );
    let provider = Provider {
        calls: Default::default(),
        started: None,
        release: None,
    };
    let supervisor = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal.clone(),
        host,
        OAuthClient::new(provider.clone()),
    ));
    let old = credentials(host);
    let old_generation = old.generation;
    supervisor.replace_if_current(old, None).await.unwrap();
    let unreadable =
        Arc::new(ServiceCredentialStore::with_protector(&dir, UnreadableOldCipher).unwrap());
    let supervisor = Arc::new(TokenSupervisor::new(
        unreadable,
        journal,
        host,
        OAuthClient::new(provider),
    ));
    let fresh = credentials(host);
    let fresh_generation = fresh.generation;
    supervisor
        .replace_if_current(fresh, Some(old_generation))
        .await
        .unwrap();
    assert_eq!(store.load().unwrap().unwrap().generation, fresh_generation);
}
#[derive(Clone)]
struct Provider {
    calls: Arc<Mutex<Vec<String>>>,
    started: Option<Arc<tokio::sync::Notify>>,
    release: Option<Arc<tokio::sync::Notify>>,
}
impl Transport for Provider {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        assert_eq!(request.url.as_str(), "https://oauth.yandex.ru/token");
        self.calls.lock().unwrap().extend(
            request
                .form
                .iter()
                .filter(|(k, _)| k == "client_secret")
                .map(|(_, s)| s.expose().to_owned()),
        );
        Box::pin(async move {
            if let Some(started) = &self.started {
                started.notify_one();
            }
            if let Some(release) = &self.release {
                release.notified().await;
            }
            Ok(ApiResponse {status:200,body:br#"{"access_token":"updated-access","refresh_token":"updated-refresh","expires_in":3600,"token_type":"bearer"}"#.to_vec()})
        })
    }
}
fn credentials(host: uuid::Uuid) -> RuntimeCredentials {
    RuntimeCredentials {
        profile: ClientProfile::new("customer-client").unwrap(),
        client_secret: Secret::client_secret("customer-secret".into()).unwrap(),
        tokens: TokenSet {
            access: Secret::new("old-access".into()).unwrap(),
            refresh: Secret::new("old-refresh".into()).unwrap(),
            expires_at: 1000,
        },
        account_id: "customer-account".into(),
        host_id: host,
        generation: uuid::Uuid::new_v4(),
    }
}

#[tokio::test]
async fn refresh_runs_from_reopened_service_store_without_office_and_preserves_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let store = Arc::new(
        ServiceCredentialStore::with_protector(&tmp.path().join("private"), TestCipher).unwrap(),
    );
    let journal = Arc::new(
        DeliveryStore::open(&tmp.path().join("delivery.db"))
            .await
            .unwrap(),
    );
    let provider = Provider {
        calls: Default::default(),
        started: None,
        release: None,
    };
    let supervisor = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal.clone(),
        host,
        OAuthClient::new(provider.clone()),
    ));
    supervisor
        .replace_if_current(credentials(host), None)
        .await
        .unwrap();
    drop(supervisor);
    let supervisor = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal,
        host,
        OAuthClient::new(provider.clone()),
    ));
    assert!(supervisor.tick(1001).await.unwrap());
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.tokens.refresh.expose(), "updated-refresh");
    assert_eq!(loaded.client_secret.expose(), "customer-secret");
    assert!(!supervisor.tick(1002).await.unwrap());
    assert_eq!(*provider.calls.lock().unwrap(), vec!["customer-secret"]);
}

#[tokio::test]
async fn late_refresh_cannot_overwrite_new_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let store = Arc::new(
        ServiceCredentialStore::with_protector(&tmp.path().join("private"), TestCipher).unwrap(),
    );
    let journal = Arc::new(
        DeliveryStore::open(&tmp.path().join("delivery.db"))
            .await
            .unwrap(),
    );
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let provider = Provider {
        calls: Default::default(),
        started: Some(started.clone()),
        release: Some(release.clone()),
    };
    let supervisor = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal.clone(),
        host,
        OAuthClient::new(provider),
    ));
    let old = credentials(host);
    supervisor
        .replace_if_current(old.clone(), None)
        .await
        .unwrap();
    let worker = supervisor.clone();
    let pending = tokio::spawn(async move { worker.tick(1001).await });
    started.notified().await;
    supervisor.disconnect(old.generation).await.unwrap();
    let mut new = credentials(host);
    new.tokens.access = Secret::new("new-connection-access".into()).unwrap();
    let new_generation = new.generation;
    supervisor
        .replace_if_current(new, journal.status().await.unwrap().connection_generation)
        .await
        .unwrap();
    release.notify_one();
    assert!(pending.await.unwrap().is_err());
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.generation, new_generation);
    assert_eq!(loaded.tokens.access.expose(), "new-connection-access");
}

#[tokio::test]
async fn disconnect_keeps_an_epoch_so_initial_none_cannot_reconnect_after_a_full_connection_cycle()
{
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let store = Arc::new(
        ServiceCredentialStore::with_protector(&tmp.path().join("private"), TestCipher).unwrap(),
    );
    let journal = Arc::new(
        DeliveryStore::open(&tmp.path().join("delivery.db"))
            .await
            .unwrap(),
    );
    let provider = Provider {
        calls: Default::default(),
        started: None,
        release: None,
    };
    let supervisor = Arc::new(TokenSupervisor::new(
        store,
        journal.clone(),
        host,
        OAuthClient::new(provider),
    ));
    let old = credentials(host);
    let generation = old.generation;
    supervisor.replace_if_current(old, None).await.unwrap();
    supervisor.disconnect(generation).await.unwrap();
    assert!(
        supervisor
            .replace_if_current(credentials(host), None)
            .await
            .is_err(),
        "an initial empty-state expectation must not match a later disconnect"
    );
}

struct BlockingCipher {
    started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    released: std::sync::Condvar,
    gate: Mutex<bool>,
}
struct BlockingProtection(Arc<BlockingCipher>);
impl Protector for BlockingProtection {
    fn protect(&self, b: &[u8]) -> Result<Vec<u8>> {
        if let Some(started) = self.0.started.lock().unwrap().take() {
            let _ = started.send(());
        }
        let mut released = self.0.gate.lock().unwrap();
        while !*released {
            released = self.0.released.wait(released).unwrap();
        }
        Ok(b.iter().map(|b| b ^ 0xa5).collect())
    }
    fn unprotect(&self, b: &[u8]) -> Result<Vec<u8>> {
        Ok(b.iter().map(|b| b ^ 0xa5).collect())
    }
}

#[tokio::test]
async fn cancelling_caller_cannot_release_mutation_while_dpapi_is_still_writing() {
    let tmp = tempfile::tempdir().unwrap();
    let host = uuid::Uuid::new_v4();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let cipher = Arc::new(BlockingCipher {
        started: Mutex::new(Some(started_tx)),
        released: std::sync::Condvar::new(),
        gate: Mutex::new(false),
    });
    let store = Arc::new(
        ServiceCredentialStore::with_protector(
            &tmp.path().join("private"),
            BlockingProtection(cipher.clone()),
        )
        .unwrap(),
    );
    let journal = Arc::new(
        DeliveryStore::open(&tmp.path().join("delivery.db"))
            .await
            .unwrap(),
    );
    let provider = Provider {
        calls: Default::default(),
        started: None,
        release: None,
    };
    let supervisor = Arc::new(TokenSupervisor::new(
        store.clone(),
        journal.clone(),
        host,
        OAuthClient::new(provider),
    ));
    let credentials = credentials(host);
    let generation = credentials.generation;
    let connecting = supervisor.clone();
    let connect =
        tokio::spawn(async move { connecting.replace_if_current(credentials, None).await });
    started_rx.await.unwrap();
    connect.abort();
    let _ = connect.await;
    let disconnecting = supervisor.clone();
    let mut disconnect = tokio::spawn(async move { disconnecting.disconnect(generation).await });
    let finished =
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut disconnect).await;
    // Release DPAPI even on failure so no blocked thread survives this test.
    let was_finished = finished.is_ok();
    *cipher.gate.lock().unwrap() = true;
    cipher.released.notify_all();
    match finished {
        Ok(result) => result.unwrap().unwrap(),
        Err(_) => disconnect.await.unwrap().unwrap(),
    };
    assert!(
        !was_finished,
        "disconnect must wait for the in-flight disk mutation"
    );
    assert!(
        store.load().unwrap().is_none(),
        "a cancelled writer must never resurrect credentials after disconnect"
    );
}
