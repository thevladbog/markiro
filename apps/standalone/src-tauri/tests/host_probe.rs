use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use markiro_standalone_lib::host_probe::{observe_hello, ProbeError};

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
