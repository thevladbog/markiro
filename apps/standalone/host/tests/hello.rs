mod support;

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};

async fn start_host(dir: &Path) -> RunningHost {
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    start(&HostPaths::new(dir), options).await.unwrap()
}

#[tokio::test]
async fn hello_answers_over_tls_with_the_pinned_certificate() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    let response = client
        .get(format!("https://{}/v1/hello", host.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let hello: markiro_proto::Hello = response.json().await.unwrap();
    assert_eq!(hello.product, "markiro-host");
    assert_eq!(hello.protocol, 1);
    assert_eq!(hello.min_protocol, 1);
    assert_eq!(hello.host_id, host.host_id);
    assert_eq!(hello.version, env!("CARGO_PKG_VERSION"));
    assert!(!hello.initialized);
    assert!(hello.time.ends_with('Z'), "{}", hello.time);
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_different_fingerprint_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&"0".repeat(64));
    assert!(client
        .get(format!("https://{}/v1/hello", host.addr))
        .send()
        .await
        .is_err());
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn unknown_routes_return_the_protocol_error_body() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    let response = client
        .get(format!("https://{}/v1/unknown", host.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let body: markiro_proto::ErrorBody = response.json().await.unwrap();
    assert_eq!(body.error.code, "not_found");
    assert_eq!(body.error.message, "no route for GET /v1/unknown");
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn plain_http_is_not_served() {
    let dir = tempfile::tempdir().unwrap();
    let host = start_host(dir.path()).await;
    let client = support::pinned_client(&host.fingerprint);
    assert!(client
        .get(format!("http://{}/v1/hello", host.addr))
        .send()
        .await
        .is_err());
    drop(client);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn restart_keeps_identity() {
    let dir = tempfile::tempdir().unwrap();
    let first = start_host(dir.path()).await;
    let (host_id, fingerprint) = (first.host_id.clone(), first.fingerprint.clone());
    first.stop().await.unwrap();
    let second = start_host(dir.path()).await;
    assert_eq!(second.host_id, host_id);
    assert_eq!(second.fingerprint, fingerprint);
    second.stop().await.unwrap();
}
