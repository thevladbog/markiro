//! Host traffic must never go through proxy environment variables: IT often
//! sets them on factory PCs, and the host is always on the local network.

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use markiro_standalone_lib::host_probe::observe_hello;

#[tokio::test]
async fn proxy_environment_variables_are_ignored() {
    let closed_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let proxy = format!("http://127.0.0.1:{closed_port}");
    for name in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        std::env::set_var(name, &proxy);
    }
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
    host.stop().await.unwrap();
}
