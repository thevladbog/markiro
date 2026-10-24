use markiro_backup_cloud::{
    callback::{parse_callback, CallbackListener},
    model::Secret,
};
static CALLBACK_PORT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[test]
fn live_yandex_callback_accepts_bounded_cid_but_never_uses_it_as_state() {
    let expected = Secret::new("expected-state".into()).unwrap();
    assert!(parse_callback(
        "/oauth/yandex/callback?state=expected-state&code=synthetic&cid=provider-correlation_123",
        &expected
    )
    .is_ok());
    for tail in [
        "cid=one&cid=two",
        "cid=",
        "cid=%0A",
        "cid=one&state=expected-state",
        "cid=one&unexpected=1",
    ] {
        assert!(parse_callback(
            &format!("/oauth/yandex/callback?state=expected-state&code=synthetic&{tail}"),
            &expected
        )
        .is_err());
    }
    assert!(parse_callback(
        "/oauth/yandex/callback?state=wrong&code=synthetic&cid=expected-state",
        &expected
    )
    .is_err());
}

#[tokio::test]
async fn listener_binds_only_loopback_and_fails_on_busy_registered_port() {
    let _port = CALLBACK_PORT.lock().await;
    let listener = CallbackListener::bind().await.unwrap();
    assert_eq!(
        listener.local_addr().unwrap().to_string(),
        "127.0.0.1:45711"
    );
    assert!(CallbackListener::bind().await.is_err());
}

#[tokio::test]
async fn valid_provider_denial_closes_listener_without_waiting_for_timeout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let _port = CALLBACK_PORT.lock().await;
    let listener = CallbackListener::bind().await.unwrap();
    let waiting = tokio::spawn(async move {
        listener
            .receive(&Secret::new("state".into()).unwrap())
            .await
    });
    let mut browser = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, 45711))
        .await
        .unwrap();
    browser.write_all(b"GET /oauth/yandex/callback?error=access_denied&state=state HTTP/1.1\r\nHost: 127.0.0.1:45711\r\n\r\n").await.unwrap();
    let mut response = Vec::new();
    browser.read_to_end(&mut response).await.unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiting).await;
    assert!(result.is_ok(), "provider denial must finish immediately");
    assert!(matches!(
        result.unwrap().unwrap(),
        Err(markiro_backup_cloud::Error::Provider("cancelled"))
    ));
    assert!(parse_callback(
        "/oauth/yandex/callback?error=access_denied&code=one&state=state",
        &Secret::new("state".into()).unwrap()
    )
    .is_err());
}

#[test]
fn callback_refuses_repeated_keys_foreign_path_wrong_state_and_large_input() {
    let expected = Secret::new("correct-state".into()).unwrap();
    let good = parse_callback(
        "/oauth/yandex/callback?code=one&state=correct-state",
        &expected,
    )
    .unwrap();
    assert_eq!(good.code.expose(), "one");
    assert!(!format!("{good:?}").contains("correct-state"));
    for target in [
        "/other?code=one&state=correct-state",
        "/oauth/yandex/callback?code=one&code=two&state=correct-state",
        "/oauth/yandex/callback?code=one&state=wrong",
        "https://markiro.ru/oauth/yandex/callback?code=one&state=correct-state",
        "/oauth/yandex/callback?code=one&state=correct-state&unexpected=1",
    ] {
        assert!(parse_callback(target, &expected).is_err(), "{target}");
    }
    assert!(parse_callback(
        &format!(
            "/oauth/yandex/callback?code={}&state=correct-state",
            "a".repeat(9000)
        ),
        &expected
    )
    .is_err());
}
