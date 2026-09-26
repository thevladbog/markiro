//! HTTPS server: router, TLS accept loop and graceful shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{Method, Uri};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use sqlx::SqlitePool;
use time::OffsetDateTime;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::clock::{format_timestamp, Clock};
use crate::error::ApiError;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub host_id: String,
    pub clock: Arc<dyn Clock>,
}

impl AppState {
    pub fn new(pool: SqlitePool, host_id: String, clock: Arc<dyn Clock>) -> Self {
        Self {
            pool,
            host_id,
            clock,
        }
    }

    pub fn now(&self) -> OffsetDateTime {
        self.clock.now()
    }

    /// `now()` in the stored timestamp format.
    pub fn timestamp(&self) -> String {
        format_timestamp(self.now())
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .with_state(state)
}

/// Every route except `hello` requires a supported protocol version
/// (spec §4.5). Apply with `route_layer` on the protected routes only, so
/// `hello` answers any version and unknown paths stay `not_found`.
pub async fn protocol_guard(request: Request, next: Next) -> Result<Response, ApiError> {
    let version = request
        .headers()
        .get(markiro_proto::PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok());
    match version {
        Some(version)
            if (markiro_proto::MIN_PROTOCOL_VERSION..=markiro_proto::PROTOCOL_VERSION)
                .contains(&version) =>
        {
            Ok(next.run(request).await)
        }
        other => Err(ApiError::protocol_unsupported(other)),
    }
}

async fn hello(State(state): State<AppState>) -> Result<Json<markiro_proto::Hello>, ApiError> {
    let initialized = crate::db::is_initialized(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(markiro_proto::Hello {
        product: markiro_proto::HOST_PRODUCT.to_owned(),
        protocol: markiro_proto::PROTOCOL_VERSION,
        min_protocol: markiro_proto::MIN_PROTOCOL_VERSION,
        host_id: state.host_id.clone(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        time: state.timestamp(),
        initialized,
    }))
}

async fn method_not_allowed(method: Method, uri: Uri) -> ApiError {
    ApiError::method_not_allowed(format!("{method} is not allowed on {}", uri.path()))
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

/// Connections whose TLS handshake already completed. Handshakes run in their
/// own tasks, so one slow client cannot stall accepting the next.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    bound: SocketAddr,
}

impl TlsListener {
    pub async fn bind(addr: SocketAddr, tls: Arc<rustls::ServerConfig>) -> std::io::Result<Self> {
        let tcp = TcpListener::bind(addr).await.map_err(|error| {
            std::io::Error::new(error.kind(), format!("cannot listen on {addr}: {error}"))
        })?;
        let bound = tcp.local_addr()?;
        let (sender, connections) = mpsc::channel(64);
        let acceptor = TlsAcceptor::from(tls);
        tokio::spawn(async move {
            loop {
                // Stop accepting (and release the port) as soon as the
                // listener is dropped, without waiting for another client.
                let accepted = tokio::select! {
                    _ = sender.closed() => break,
                    accepted = tcp.accept() => accepted,
                };
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, "accepting a TCP connection failed");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                        Ok(Ok(tls_stream)) => {
                            let _ = sender.send((tls_stream, peer)).await;
                        }
                        Ok(Err(error)) => tracing::debug!(%peer, %error, "TLS handshake failed"),
                        Err(_) => tracing::debug!(%peer, "TLS handshake timed out"),
                    }
                });
            }
        });
        Ok(Self { connections, bound })
    }

    /// The address actually bound (useful after binding port 0).
    pub fn bound_addr(&self) -> SocketAddr {
        self.bound
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.connections.recv().await {
            Some(connection) => connection,
            // The accept task outlives this listener, so this never happens.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.bound)
    }
}

/// Serve until `shutdown` resolves; open connections finish first.
///
/// `into_make_service_with_connect_info::<SocketAddr>()` needs
/// `SocketAddr: Connected<IncomingStream<'_, TlsListener>>`, but axum only
/// ships that impl for its own `TcpListener`; implementing the foreign
/// `Connected` trait for the foreign `SocketAddr` here would violate the
/// orphan rules even though the listener type is local (`IncomingStream`'s
/// outer type is still foreign). Wrapping with the built-in `tap_io` no-op
/// instead produces `TapIo<TlsListener, _>`, for which axum already provides
/// a blanket `Connected` impl over any `Listener`, so no new trait impl or
/// public type is needed.
pub async fn serve(
    listener: TlsListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    use axum::serve::ListenerExt;

    let listener = listener.tap_io(|_io| {});
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::{middleware, Router};
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    async fn call(header: Option<&str>) -> (StatusCode, Value) {
        let app = Router::new()
            .route("/probe", get(|| async { "ok" }))
            .route_layer(middleware::from_fn(super::protocol_guard));
        let mut builder = Request::get("/probe");
        if let Some(value) = header {
            builder = builder.header(markiro_proto::PROTOCOL_HEADER, value);
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn a_supported_version_passes() {
        assert_eq!(call(Some("1")).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn a_missing_header_is_refused_with_details() {
        let (status, body) = call(None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "protocol_unsupported");
        assert_eq!(body["error"]["details"]["protocol"], Value::Null);
        assert_eq!(body["error"]["details"]["minProtocol"], 1);
        assert_eq!(body["error"]["details"]["maxProtocol"], 1);
    }

    #[tokio::test]
    async fn an_out_of_range_or_garbled_version_is_refused() {
        let (status, body) = call(Some("7")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["details"]["protocol"], 7);
        assert_eq!(call(Some("abc")).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(Some("0")).await.0, StatusCode::BAD_REQUEST);
    }
}
