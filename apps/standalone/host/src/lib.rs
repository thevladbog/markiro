//! Markiro standalone host library. `src/main.rs` wires it into the
//! `run` / `service` / `print-fingerprint` commands; tests start it directly.

pub mod clock;
pub mod config;
pub mod db;
pub mod error;
pub mod logging;
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod tls;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use config::{HostConfig, HostPaths};
use sqlx::SqlitePool;
use tls::TlsIdentity;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How long `stop` waits for open connections before aborting them.
const SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// How to start the host. The default listens on every interface at the
/// configured port; tests bind `127.0.0.1:0`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StartOptions {
    /// `--port`; persisted into `host.json`.
    pub port_override: Option<u16>,
    /// Exact bind address; `None` means `0.0.0.0:<configured port>`.
    pub bind: Option<SocketAddr>,
}

/// A started host; `stop` shuts it down gracefully and closes the database.
pub struct RunningHost {
    pub addr: SocketAddr,
    pub fingerprint: String,
    pub host_id: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    pool: SqlitePool,
    _lock: std::fs::File,
}

impl RunningHost {
    pub async fn stop(self) -> Result<(), BoxError> {
        let _ = self.shutdown.send(());
        let mut task = self.task;
        match tokio::time::timeout(SHUTDOWN_DEADLINE, &mut task).await {
            Ok(joined) => joined??,
            Err(_) => {
                tracing::warn!("graceful shutdown timed out; aborting open connections");
                task.abort();
            }
        }
        self.pool.close().await;
        tracing::info!("markiro-host stopped");
        Ok(())
    }
}

/// Open everything under `paths` and start serving.
pub async fn start(paths: &HostPaths, options: StartOptions) -> Result<RunningHost, BoxError> {
    paths.ensure()?;
    let lock = paths.lock()?;
    let config = HostConfig::load_or_create(paths, options.port_override)?;
    let pool = db::open(&paths.database_file()).await?;
    let identity = TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id)?;
    let bind = options
        .bind
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port));
    let listener = server::TlsListener::bind(bind, identity.server_config()?).await?;
    let addr = listener.bound_addr();
    let (shutdown, shutdown_signal) = tokio::sync::oneshot::channel::<()>();
    let state = server::AppState::new(
        pool.clone(),
        config.host_id.clone(),
        std::sync::Arc::new(clock::SystemClock),
    );
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = shutdown_signal.await;
    }));
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        %addr,
        fingerprint = %identity.fingerprint,
        host_id = %config.host_id,
        "markiro-host listening"
    );
    Ok(RunningHost {
        addr,
        fingerprint: identity.fingerprint.clone(),
        host_id: config.host_id,
        shutdown,
        task,
        pool,
        _lock: lock,
    })
}
