use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use markiro_standalone_lib::host_probe::{observe_hello, pinned_host_versions, ProbeError};

#[tokio::test]
async fn observes_the_host_and_the_certificate_it_presents() {
    let dir = tempfile::tempdir().unwrap();
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&HostPaths::new(dir.path()), options).await.unwrap();

    let observation = observe_hello(&format!("https://{}", host.addr))
        .await
        .unwrap();
    assert_eq!(observation.fingerprint, host.fingerprint);
    assert_eq!(observation.hello.host_id, host.host_id);
    assert!(!observation.hello.initialized);

    host.stop().await.unwrap();
}

#[tokio::test]
async fn nothing_listening_is_unreachable() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let result = observe_hello(&format!("https://127.0.0.1:{port}")).await;
    assert_eq!(
        result.map(|observation| observation.fingerprint),
        Err(ProbeError::Unreachable)
    );
}

#[tokio::test]
async fn pinned_versions_come_only_from_the_certificate_that_was_paired() {
    let dir = tempfile::tempdir().unwrap();
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let host = start(&HostPaths::new(dir.path()), options).await.unwrap();
    let address = format!("https://{}", host.addr);

    let seen = pinned_host_versions(&address, &host.fingerprint)
        .await
        .unwrap();
    assert_eq!(seen.version.as_deref(), Some(markiro_host::HOST_VERSION));
    // Another certificate answering at the same address is not the host.
    let other = "ab".repeat(32);
    assert_eq!(
        pinned_host_versions(&address, &other).await,
        Err(ProbeError::Unreachable)
    );

    host.stop().await.unwrap();
}
