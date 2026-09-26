//! In-process router harness: real SQLite in a temp dir, a manual clock, and
//! `MockConnectInfo` so routes that check the peer address can be exercised.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::request::Builder;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use markiro_host::clock::ManualClock;
use markiro_host::server::{router, AppState};
use serde_json::Value;
use tower::ServiceExt;

pub const LOOPBACK: ([u8; 4], u16) = ([127, 0, 0, 1], 50_000);
pub const LAN: ([u8; 4], u16) = ([192, 168, 1, 20], 50_000);

/// 2026-09-21T14:13:20Z — a fixed start for the manual clock.
pub const START: i64 = 1_790_000_000;

pub struct TestApp {
    pub state: AppState,
    pub clock: Arc<ManualClock>,
    _dir: tempfile::TempDir,
}

impl TestApp {
    pub async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pool = markiro_host::db::open(&dir.path().join("host.db"))
            .await
            .unwrap();
        let clock = Arc::new(ManualClock::new(
            time::OffsetDateTime::from_unix_timestamp(START).unwrap(),
        ));
        let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone());
        Self {
            state,
            clock,
            _dir: dir,
        }
    }

    /// Send `request` as if it came from `peer`; returns the status and the
    /// JSON body (`Value::Null` when the body is empty).
    pub async fn send_from(
        &self,
        peer: impl Into<SocketAddr>,
        request: Request<Body>,
    ) -> (StatusCode, Value) {
        let response = router(self.state.clone())
            .layer(MockConnectInfo(peer.into()))
            .oneshot(request)
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
    }

    pub async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        self.send_from(LOOPBACK, request).await
    }
}

/// A request builder with the protocol header already set.
pub fn request(method: &str, path: &str) -> Builder {
    Request::builder().method(method).uri(path).header(
        markiro_proto::PROTOCOL_HEADER,
        markiro_proto::PROTOCOL_VERSION.to_string(),
    )
}

pub fn json(builder: Builder, body: Value) -> Request<Body> {
    builder
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub fn empty(builder: Builder) -> Request<Body> {
    builder.body(Body::empty()).unwrap()
}

/// Add `Authorization: Bearer <key>`.
pub fn with_device(builder: Builder, key: &str) -> Builder {
    builder.header("authorization", format!("Bearer {key}"))
}

/// Pair a device of `kind` from loopback; returns its id and key.
pub async fn pair_device(app: &TestApp, kind: &str) -> (String, String) {
    let (status, body) = app
        .send(json(
            request("POST", "/v1/local-pair"),
            serde_json::json!({ "kind": kind, "name": "Тестовое устройство", "appVersion": "0.1.0" }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["deviceId"].as_str().unwrap().to_owned(),
        body["deviceKey"].as_str().unwrap().to_owned(),
    )
}

/// Insert an active office user directly; returns its id.
pub async fn seed_office_user(app: &TestApp, login: &str, role: &str, password: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let phc = markiro_host::secrets::hash_password(password);
    let mut tx = markiro_host::db::begin_write(&app.state.pool)
        .await
        .unwrap();
    let rev = markiro_host::db::next_revision(&mut tx).await.unwrap();
    sqlx::query(
        "INSERT INTO office_users (id, login, name, role, password_phc, active, created_at, rev) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(login)
    .bind(format!("Пользователь {login}"))
    .bind(role)
    .bind(phc)
    .bind(app.state.timestamp())
    .bind(rev)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// Add the device key and the office session token.
pub fn with_session(builder: Builder, device_key: &str, token: &str) -> Builder {
    with_device(builder, device_key).header(markiro_proto::OFFICE_SESSION_HEADER, token)
}

/// Log in on the device; returns the session token.
pub async fn login(app: &TestApp, device_key: &str, login: &str, password: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/office/login"), device_key),
            serde_json::json!({ "login": login, "password": password }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["token"].as_str().unwrap().to_owned()
}

/// A valid wizard request.
pub fn bootstrap_body() -> Value {
    serde_json::json!({
        "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
        "org": {
            "name": "ООО «Атолл»",
            "inn": "7701234567",
            "gln": "4600682000010",
            "gs1Prefixes": ["4600682"],
            "timeZone": "Europe/Moscow"
        },
        "sscc": { "boxNextSerial": 1500, "palletNextSerial": 40 },
        "lines": ["Линия 1", "Линия 2"]
    })
}

/// Run the wizard from loopback with `device_key`; returns the admin's token.
pub async fn bootstrap(app: &TestApp, device_key: &str) -> String {
    let (status, body) = app
        .send(json(
            with_device(request("POST", "/v1/bootstrap"), device_key),
            bootstrap_body(),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["session"]["token"].as_str().unwrap().to_owned()
}
