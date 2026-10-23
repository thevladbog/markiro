use markiro_backup_cloud::{model::*, oauth::*, Error, Result};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct Capture {
    requests: Arc<Mutex<Vec<(String, String)>>>,
    response: String,
}
impl Transport for Capture {
    fn send(
        &self,
        request: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        self.requests.lock().unwrap().push((
            request.url.to_string(),
            request
                .form
                .iter()
                .map(|(k, v)| format!("{k}={}", v.expose()))
                .collect::<Vec<_>>()
                .join("&"),
        ));
        let body = self.response.as_bytes().to_vec();
        Box::pin(async move { Ok(ApiResponse { status: 200, body }) })
    }
}
fn capture() -> Capture {
    Capture { requests: Default::default(), response: r#"{"access_token":"same-access","refresh_token":"refresh-token","expires_in":3600,"token_type":"bearer"}"#.into() }
}

#[tokio::test]
async fn code_grant_uses_pkce_without_secret_and_replay_is_refused() {
    let transport = capture();
    let client = OAuthClient::new(transport.clone());
    let mut attempt = OAuthAttempt::new("client-one", 1000).unwrap();
    let url = attempt.authorization_url().unwrap();
    let params: std::collections::BTreeMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(params["code_challenge_method"], "S256");
    assert!(params["state"].len() >= 43);
    assert!(client
        .complete(&mut attempt, "wrong-state", "code", 1001)
        .await
        .is_err());
    client
        .complete(&mut attempt, &params["state"], "code", 1002)
        .await
        .unwrap();
    assert!(client
        .complete(&mut attempt, &params["state"], "code", 1003)
        .await
        .is_err());
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "https://oauth.yandex.ru/token");
    assert!(requests[0].1.contains("code_verifier="));
    assert!(!requests[0].1.contains("client_secret"));
}

#[tokio::test]
async fn expired_attempt_is_refused_before_network() {
    let transport = capture();
    let mut attempt = OAuthAttempt::new("client", 1000).unwrap();
    let url = attempt.authorization_url().unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert!(OAuthClient::new(transport.clone())
        .complete(&mut attempt, &state, "code", 1601)
        .await
        .is_err());
    assert!(transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn refresh_binds_secret_and_client_and_accepts_unchanged_token() {
    let transport = capture();
    let credentials = RuntimeCredentials {
        profile: ClientProfile::new("client-one").unwrap(),
        client_secret: Secret::client_secret("customer-secret".into()).unwrap(),
        tokens: TokenSet {
            access: Secret::new("same-access".into()).unwrap(),
            refresh: Secret::new("refresh-token".into()).unwrap(),
            expires_at: 1000,
        },
        account_id: "account".into(),
        host_id: uuid::Uuid::new_v4(),
        generation: uuid::Uuid::new_v4(),
    };
    let tokens = OAuthClient::new(transport.clone())
        .refresh(&credentials, 1001)
        .await
        .unwrap();
    assert_eq!(tokens.access.expose(), "same-access");
    assert_eq!(tokens.expires_at, 4601);
    assert!(!format!("{credentials:?}").contains("customer-secret"));
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].0, "https://oauth.yandex.ru/token");
    assert!(requests[0].1.contains("client_id=client-one"));
    assert!(requests[0].1.contains("client_secret=customer-secret"));
}

#[test]
fn markiro_unknown_and_private_origins_are_denied_before_send() {
    for url in [
        "https://markiro.ru/token",
        "https://api.markiro.ru/",
        "http://oauth.yandex.ru/token",
        "https://127.0.0.1/token",
        "https://oauth.yandex.ru.evil.example/token",
        "https://oauth.yandex.ru:444/token",
        "https://u:p@oauth.yandex.ru/token",
        "https://oauth.yandex.ru/other",
    ] {
        assert!(
            matches!(ApiRequest::token(url, vec![]), Err(Error::OriginDenied)),
            "{url}"
        );
    }
}

struct Unavailable;
impl Transport for Unavailable {
    fn send(
        &self,
        _: ApiRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ApiResponse>> + Send + '_>> {
        Box::pin(async {
            Ok(ApiResponse {
                status: 503,
                body: br#"{"error":"backend_unavailable"}"#.to_vec(),
            })
        })
    }
}
#[tokio::test]
async fn unavailable_token_endpoint_is_transient_and_not_an_authorization_denial() {
    let mut attempt = OAuthAttempt::new("client", 1000).unwrap();
    let url = attempt.authorization_url().unwrap();
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    assert!(matches!(
        OAuthClient::new(Unavailable)
            .complete(&mut attempt, &state, "code", 1001)
            .await,
        Err(Error::Network)
    ));
}
