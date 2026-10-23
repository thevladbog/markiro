use markiro_backup_cloud::{
    model::Secret,
    oauth::{ApiRequest, ApiResponse, Transport},
    Error, Result,
};
use markiro_host::yandex::{
    connection::{AccountVerifier, AttemptOwner, VerifiedAccount, YandexService},
    secret_store::Protector,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
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
    calls: Mutex<Vec<Vec<String>>>,
}
impl Transport for Provider {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        self.calls
            .lock()
            .unwrap()
            .push(request.form.iter().map(|(k, _)| k.clone()).collect());
        let invalid = request
            .form
            .iter()
            .any(|(k, v)| k == "client_secret" && v.expose() == "wrong-secret");
        Box::pin(async move {
            Ok(if invalid {
                ApiResponse {
                    status: 400,
                    body: br#"{"error":"invalid_client"}"#.to_vec(),
                }
            } else {
                ApiResponse{status:200,body:br#"{"access_token":"access","refresh_token":"refresh","expires_in":3600,"token_type":"bearer"}"#.to_vec()}
            })
        })
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
                label: "Test account".into(),
            })
        })
    }
}
fn make_owner() -> AttemptOwner {
    AttemptOwner {
        user_id: Uuid::new_v4().to_string(),
        device_id: Uuid::new_v4().to_string(),
        session_id: Uuid::new_v4().to_string(),
        source: Default::default(),
    }
}
fn state(reply: &markiro_proto::yandex_backups::AuthBeginReply) -> String {
    reqwest::Url::parse(&reply.authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn attempt_binds_owner_and_secret_and_only_commits_after_refresh_and_folder_checks() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(Provider::default());
    let service = YandexService::with_dependencies(
        tmp.path(),
        Uuid::new_v4(),
        provider.clone(),
        Box::new(Cipher),
        Arc::new(Verifier),
    )
    .await
    .unwrap();
    let owner = make_owner();
    let reply = service
        .begin(
            &owner,
            "customer-client",
            Secret::client_secret("correct-secret".into()).unwrap(),
            None,
            1000,
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(&reply.attempt_id).unwrap();
    assert!(service
        .prepare_complete(&make_owner(), id, &state(&reply), "code", 1001)
        .await
        .is_err());
    assert!(provider.calls.lock().unwrap().is_empty());
    let prepared = service
        .prepare_complete(&owner, id, &state(&reply), "code", 1001)
        .await
        .unwrap();
    assert!(service.journal.status().await.unwrap().binding.is_none());
    service
        .commit(prepared, "2026-10-23T01:00:00Z")
        .await
        .unwrap();
    let credentials = service.tokens.current_credentials().await.unwrap().unwrap();
    assert_eq!(credentials.profile.client_id, "customer-client");
    assert_eq!(credentials.client_secret.expose(), "correct-secret");
    let calls = provider.calls.lock().unwrap();
    assert!(!calls[0].contains(&"client_secret".into()));
    assert!(calls[1].contains(&"client_secret".into()));
}

#[tokio::test]
async fn cancel_prepared_connection_and_wrong_secret_leave_existing_connection_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let service = YandexService::with_dependencies(
        tmp.path(),
        Uuid::new_v4(),
        Arc::new(Provider::default()),
        Box::new(Cipher),
        Arc::new(Verifier),
    )
    .await
    .unwrap();
    let owner = make_owner();
    let begin = service
        .begin(
            &owner,
            "old-client",
            Secret::client_secret("correct-secret".into()).unwrap(),
            None,
            1000,
        )
        .await
        .unwrap();
    let ready = service
        .prepare_complete(
            &owner,
            Uuid::parse_str(&begin.attempt_id).unwrap(),
            &state(&begin),
            "code",
            1001,
        )
        .await
        .unwrap();
    service.commit(ready, "2026-10-23T01:00:00Z").await.unwrap();
    let old = service.tokens.current_credentials().await.unwrap().unwrap();
    let begin = service
        .begin(
            &owner,
            "new-client",
            Secret::client_secret("correct-secret".into()).unwrap(),
            Some(old.generation),
            1002,
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(&begin.attempt_id).unwrap();
    let ready = service
        .prepare_complete(&owner, id, &state(&begin), "code", 1003)
        .await
        .unwrap();
    service.cancel(&owner, id).await.unwrap();
    assert!(service.commit(ready, "2026-10-23T01:01:00Z").await.is_err());
    let bad = service
        .begin(
            &owner,
            "new-client",
            Secret::client_secret("wrong-secret".into()).unwrap(),
            Some(old.generation),
            1004,
        )
        .await
        .unwrap();
    assert!(matches!(
        service
            .prepare_complete(
                &owner,
                Uuid::parse_str(&bad.attempt_id).unwrap(),
                &state(&bad),
                "code",
                1005
            )
            .await,
        Err(Error::Provider("client_credentials_invalid"))
    ));
    assert_eq!(
        service
            .tokens
            .current_credentials()
            .await
            .unwrap()
            .unwrap()
            .generation,
        old.generation
    );
}
