//! In-process router harness: real SQLite in a temp dir, a manual clock, and
//! `MockConnectInfo` so routes that check the peer address can be exercised.

use std::net::{Ipv4Addr, SocketAddr};
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

/// The certificate fingerprint `TestApp` reports: "ab" 32 times.
pub fn test_fingerprint() -> String {
    "ab".repeat(32)
}

/// The LAN addresses `TestApp` reports for pairing payloads.
pub const TEST_ADDRESSES: [Ipv4Addr; 2] =
    [Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(192, 168, 1, 10)];

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
        let state = AppState::new(pool, uuid::Uuid::new_v4().to_string(), clock.clone())
            .with_endpoint(test_fingerprint(), 45710)
            .with_addresses(|| TEST_ADDRESSES.to_vec());
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

/// A host after the wizard, with the administrator signed in on the station
/// that ran it.
pub struct Admin {
    pub app: TestApp,
    pub key: String,
    pub token: String,
    pub id: String,
}

/// A new host: a paired station runs the wizard, and the administrator's
/// session stays open on it.
pub async fn admin() -> Admin {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (status, me) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let id = me["id"].as_str().unwrap().to_owned();
    Admin {
        app,
        key,
        token,
        id,
    }
}

impl Admin {
    /// An office request with the administrator's session.
    pub async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.call_as(&self.token, method, path, body).await
    }

    /// An office request with another session on the same station.
    pub async fn call_as(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = with_session(request(method, path), &self.key, token);
        match body {
            Some(body) => self.app.send(json(builder, body)).await,
            None => self.app.send(empty(builder)).await,
        }
    }

    /// A technologist signed in on the same station; returns the token.
    pub async fn technologist(&self) -> String {
        seed_office_user(&self.app, "tech", "technologist", "technologist password").await;
        login(&self.app, &self.key, "tech", "technologist password").await
    }

    /// The `ok` audit row a change by this administrator writes.
    pub fn row(
        &self,
        action: &str,
        target_type: &str,
        target_id: &str,
        details: Value,
    ) -> AuditRow {
        (
            "office_user".to_owned(),
            Some(self.id.clone()),
            action.to_owned(),
            Some(target_type.to_owned()),
            Some(target_id.to_owned()),
            "ok".to_owned(),
            details,
        )
    }
}

/// `pinPhc` of `proto/fixtures/phc-password.json`: the PIN 4821. The host
/// checks only the shape of a PIN hash, never which PIN it hides.
pub const PIN_4821: &str =
    "pbkdf2$sha256$100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";

/// A new operator with `login` through the office API; returns its id and
/// revision.
pub async fn add_operator(admin: &Admin, login: &str) -> (String, i64) {
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/operators",
            Some(
                serde_json::json!({ "login": login, "name": "Анна Кузнецова", "pinPhc": PIN_4821 }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    (
        created["id"].as_str().unwrap().to_owned(),
        created["rev"].as_i64().unwrap(),
    )
}

/// The host's current revision (`host_revision.rev`).
pub async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// Every tombstone the host holds, as `(entity, id, rev)`.
pub async fn tombstones(app: &TestApp) -> Vec<(String, String, i64)> {
    sqlx::query_as("SELECT entity, id, rev FROM tombstones ORDER BY entity, id")
        .fetch_all(&app.state.pool)
        .await
        .unwrap()
}

/// Every audit row, whatever its action: a refused request or a no-op writes
/// none.
pub async fn audit_rows(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

/// An audit row: actor kind and id, action, target type and id, result and
/// the parsed `details`.
pub type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Value,
);

/// Every audit row of `action`, oldest first.
pub async fn audit_trail(app: &TestApp, action: &str) -> Vec<AuditRow> {
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log WHERE action = ? ORDER BY id",
    )
    .bind(action)
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(
            |(kind, id, action, target_type, target_id, result, details)| {
                (
                    kind,
                    id,
                    action,
                    target_type,
                    target_id,
                    result,
                    serde_json::from_str(&details).unwrap(),
                )
            },
        )
        .collect()
}
