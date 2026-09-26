//! HTTPS server: router, TLS accept loop and graceful shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::{Method, Uri};
use axum::routing::get;
use axum::{Json, Router};
use sqlx::SqlitePool;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

use crate::error::ApiError;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub host_id: String,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/v1/hello", get(hello))
        .fallback(not_found)
        .with_state(state)
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
        time: now_rfc3339(),
        initialized,
    }))
}

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ApiError::not_found(format!("no route for {method} {}", uri.path()))
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .expect("zero nanoseconds is always valid")
        .format(&time::format_description::well_known::Rfc3339)
        .expect("RFC 3339 formatting of a UTC time cannot fail")
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
