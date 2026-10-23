mod support;
use axum::http::StatusCode;
use markiro_backup_cloud::{
    model::Secret,
    oauth::{ApiRequest, ApiResponse, Transport},
    Result,
};
use markiro_host::yandex::{
    connection::{AccountVerifier, VerifiedAccount, YandexService},
    secret_store::Protector,
};
use serde_json::json;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use support::app::{admin, empty, request, with_device};
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
struct Provider;
impl Transport for Provider {
    fn send(
        &self,
        _: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        Box::pin(async {
            Ok(ApiResponse{status:200,body:br#"{"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_in":3600,"token_type":"bearer"}"#.to_vec()})
        })
    }
}
struct Verifier {
    started: Option<Arc<tokio::sync::Notify>>,
    release: Option<Arc<tokio::sync::Notify>>,
    calls: AtomicUsize,
}
impl AccountVerifier for Verifier {
    fn verify(
        &self,
        _: &Secret,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAccount>> + Send + '_>> {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
                if let Some(started) = &self.started {
                    started.notify_one();
                }
                if let Some(release) = &self.release {
                    release.notified().await;
                }
            }
            Ok(VerifiedAccount {
                id: "synthetic-account".into(),
                label: "Test account".into(),
            })
        })
    }
}
async fn configured(
    verifier: Arc<dyn AccountVerifier>,
) -> (support::app::Admin, Arc<YandexService>) {
    let mut admin = admin().await;
    let service = YandexService::with_dependencies(
        admin.app.dir(),
        Uuid::parse_str(&admin.app.state.host_id).unwrap(),
        Arc::new(Provider),
        Box::new(Cipher),
        verifier,
    )
    .await
    .unwrap();
    admin.app.state.yandex = Some(service.clone());
    (admin, service)
}
fn state_of(reply: &serde_json::Value) -> String {
    reqwest::Url::parse(reply["authorizationUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn admin_connects_and_disconnects_with_exact_public_audit_and_no_secret_response() {
    let (admin, service) = configured(Arc::new(Verifier {
        started: None,
        release: None,
        calls: AtomicUsize::new(0),
    }))
    .await;
    let (status,reply)=admin.call("POST","/v1/office/backups/yandex/auth/begin",Some(json!({"clientId":"customer-client","clientSecret":"synthetic-client-secret","expectedGeneration":null}))).await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert!(!reply.to_string().contains("synthetic-client-secret"));
    let (status, connected) = admin
        .call(
            "POST",
            "/v1/office/backups/yandex/auth/complete",
            Some(json!({"attemptId":reply["attemptId"],"state":state_of(&reply),"code":"code"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{connected}");
    assert_eq!(connected["state"], "connected");
    for secret in [
        "synthetic-client-secret",
        "synthetic-access",
        "synthetic-refresh",
    ] {
        assert!(!connected.to_string().contains(secret));
    }
    let generation = connected["connectionGeneration"].clone();
    let rows = support::app::audit_trail(&admin.app, "backup.yandex.connect").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "office_user");
    assert_eq!(rows[0].1.as_deref(), Some(admin.id.as_str()));
    assert_eq!(rows[0].2, "backup.yandex.connect");
    assert_eq!(rows[0].3.as_deref(), Some("backup_yandex_connection"));
    assert_eq!(rows[0].4.as_deref(), generation.as_str());
    assert_eq!(rows[0].5, "ok");
    assert_eq!(
        rows[0].6,
        json!({"eventId":generation,"clientId":"customer-client","accountId":"synthetic-account","hostId":admin.app.state.host_id})
    );
    let (status, disconnected) = admin
        .call(
            "DELETE",
            "/v1/office/backups/yandex/connection",
            Some(json!({"expectedGeneration":generation})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{disconnected}");
    assert_eq!(disconnected["state"], "disconnected");
    assert!(service
        .tokens
        .current_credentials()
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        support::app::audit_trail(&admin.app, "backup.yandex.disconnect")
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn administrator_deactivated_during_oauth_cannot_commit_credentials() {
    use tower::ServiceExt;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (admin, service) = configured(Arc::new(Verifier {
        started: Some(started.clone()),
        release: Some(release.clone()),
        calls: AtomicUsize::new(0),
    }))
    .await;
    let (_,reply)=admin.call("POST","/v1/office/backups/yandex/auth/begin",Some(json!({"clientId":"customer-client","clientSecret":"synthetic-client-secret","expectedGeneration":null}))).await;
    let request = support::app::json(
        support::app::with_session(
            request("POST", "/v1/office/backups/yandex/auth/complete"),
            &admin.key,
            &admin.token,
        ),
        json!({"attemptId":reply["attemptId"],"state":state_of(&reply),"code":"code"}),
    );
    let router = markiro_host::server::router(admin.app.state.clone()).layer(
        axum::extract::connect_info::MockConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            50000,
        ))),
    );
    let completing = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    started.notified().await;
    sqlx::query("UPDATE office_users SET active=0 WHERE id=?")
        .bind(&admin.id)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    release.notify_one();
    let response = completing.await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(service
        .tokens
        .current_credentials()
        .await
        .unwrap()
        .is_none());
    assert!(
        support::app::audit_trail(&admin.app, "backup.yandex.connect")
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn source_replaced_during_oauth_cannot_commit_a_connection_for_the_previous_dataset() {
    use tower::ServiceExt;
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (admin, service) = configured(Arc::new(Verifier {
        started: Some(started.clone()),
        release: Some(release.clone()),
        calls: AtomicUsize::new(0),
    }))
    .await;
    let (_,reply)=admin.call("POST","/v1/office/backups/yandex/auth/begin",Some(json!({"clientId":"customer-client","clientSecret":"synthetic-client-secret","expectedGeneration":null}))).await;
    let request = support::app::json(
        support::app::with_session(
            request("POST", "/v1/office/backups/yandex/auth/complete"),
            &admin.key,
            &admin.token,
        ),
        json!({"attemptId":reply["attemptId"],"state":state_of(&reply),"code":"code"}),
    );
    let router = markiro_host::server::router(admin.app.state.clone()).layer(
        axum::extract::connect_info::MockConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            50000,
        ))),
    );
    let completing = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    started.notified().await;
    sqlx::query("UPDATE site SET restore_epoch='replacement-epoch'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    release.notify_one();
    let response = completing.await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert!(service
        .tokens
        .current_credentials()
        .await
        .unwrap()
        .is_none());
    assert!(
        support::app::audit_trail(&admin.app, "backup.yandex.connect")
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn device_key_alone_cannot_read_or_manage_yandex_backups() {
    let admin = admin().await;
    for (method, path) in [
        ("GET", "/v1/office/backups/yandex"),
        ("POST", "/v1/office/backups/yandex/auth/begin"),
        ("POST", "/v1/office/backups/yandex/retry"),
    ] {
        let (status, _) = admin
            .app
            .send(empty(with_device(request(method, path), &admin.key)))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn technologist_reads_public_state_but_is_refused_before_parsing_secret_body() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/backups/yandex", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["state"], "disconnected");
    let (status, body) = admin
        .call_as(
            &tech,
            "POST",
            "/v1/office/backups/yandex/auth/begin",
            Some(json!({"clientSecret":"do-not-echo-this","unexpected":"field"})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!body.to_string().contains("do-not-echo-this"));
}
