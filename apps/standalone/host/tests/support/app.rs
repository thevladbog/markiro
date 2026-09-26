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
