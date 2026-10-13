//! Markiro standalone host library. `src/main.rs` wires it into the
//! `run` / `service` / `print-fingerprint` commands; tests start it directly.

pub mod audit;
pub mod auth;
pub mod backup;
pub mod clock;
pub mod cloud_import;
pub mod config;
pub mod db;
pub mod error;
pub mod facts;
pub mod feed;
pub mod inn;
pub mod install;
#[cfg(windows)]
pub mod install_windows;
pub mod license;
pub mod logging;
pub mod network;
pub mod network_profile;
pub mod pairing_code;
pub mod rate_limit;
pub mod restore;
pub mod routes;
pub mod secrets;
pub mod server;
#[cfg(windows)]
pub mod service;
pub mod shifts;
pub mod templates;
pub mod tls;
pub mod validate;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use config::{HostConfig, HostPaths};
use sqlx::SqlitePool;
use tls::TlsIdentity;

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// How long `stop` waits for open connections before aborting them.
const SHUTDOWN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// How long a process waits for blocking threads when its runtime ends
/// (`main.rs` and `service.rs`). A plain drop of a runtime waits for them
/// without limit, and a write to an unreachable network folder (the second
/// folder of copies, a copy on a share) can block its thread for minutes with
/// nothing to cancel it: the process would never exit, and the service
/// manager would show a stopped host as still stopping. Five seconds after
/// `RunningHost::stop` (which already gives the worker 10) fits Windows'
/// 30-second stop hint; whatever still runs then is abandoned with the
/// process.
pub const RUNTIME_SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// End `runtime`, waiting no longer than `limit` for its blocking threads.
pub fn shutdown_runtime_within(runtime: tokio::runtime::Runtime, limit: std::time::Duration) {
    runtime.shutdown_timeout(limit);
}

/// [`shutdown_runtime_within`] [`RUNTIME_SHUTDOWN_TIMEOUT`].
pub fn shutdown_runtime(runtime: tokio::runtime::Runtime) {
    shutdown_runtime_within(runtime, RUNTIME_SHUTDOWN_TIMEOUT);
}

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
    stopping: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    /// The backup worker (plan РК); it ends with `stopping`.
    backups: tokio::task::JoinHandle<()>,
    /// The license's minute look (plan ЛЦ-2); it ends with `stopping`.
    license: tokio::task::JoinHandle<()>,
    pool: SqlitePool,
    _lock: std::fs::File,
}

impl RunningHost {
    pub async fn stop(self) -> Result<(), BoxError> {
        self.stopping.send_replace(true);
        let mut task = self.task;
        match tokio::time::timeout(SHUTDOWN_DEADLINE, &mut task).await {
            Ok(joined) => joined??,
            Err(_) => {
                tracing::warn!("graceful shutdown timed out; aborting open connections");
                task.abort();
            }
        }
        // A copy in progress finishes first; one that takes longer than the
        // deadline is abandoned, and its `.partial` file is removed by the
        // next run.
        let mut backups = self.backups;
        if tokio::time::timeout(SHUTDOWN_DEADLINE, &mut backups)
            .await
            .is_err()
        {
            tracing::warn!("the backup worker did not stop in time; aborting it");
            backups.abort();
        }
        let mut license = self.license;
        if tokio::time::timeout(SHUTDOWN_DEADLINE, &mut license)
            .await
            .is_err()
        {
            tracing::warn!("the license look did not stop in time; aborting it");
            license.abort();
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
    // A restore cut off between its renames left its marker: the database
    // in place may lack its WAL, or be missing (an empty one would be made
    // here). The next `markiro-host restore` finishes it first.
    restore::refuse_unfinished(paths)?;
    let config = HostConfig::load_or_create(paths, options.port_override)?;
    let pool = db::open(&paths.database_file()).await?;
    // Build the unknown-login verifier now, off the async threads, so the
    // first unknown login does not pay for building it.
    tokio::task::spawn_blocking(|| {
        secrets::dummy_password_phc();
    });
    let identity = TlsIdentity::load_or_create(&paths.tls_dir(), &config.host_id)?;
    let bind = options
        .bind
        .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), config.port));
    let listener = server::TlsListener::bind(bind, identity.server_config()?).await?;
    let addr = listener.bound_addr();
    let clock: std::sync::Arc<dyn clock::Clock> = std::sync::Arc::new(clock::SystemClock);
    let backups = backup::Backups::from_paths(paths, config.host_id.clone());
    let state = server::AppState::new(pool.clone(), config.host_id.clone(), clock.clone())
        .with_endpoint(identity.fingerprint.clone(), addr.port())
        .with_backups(backups.clone())
        // The trial's mark: the registry on Windows, none elsewhere.
        .with_license(std::sync::Arc::new(license::LicenseService::new(
            markiro_proto::trust::license_keyset(),
            license::trial_mark::system(),
        )));
    let stopping = state.stopping.clone();
    let backup_worker = backup::worker::spawn(backups, clock, stopping.subscribe());
    // The license (plan ЛЦ-2): the trial of a site from before it, the state
    // and the INN at the start, then a look every minute.
    state.license.startup(&state).await;
    let license_ticker = license::spawn_ticker(state.clone(), stopping.subscribe());
    let mut stopped = state.stopping.subscribe();
    let task = tokio::spawn(server::serve(listener, state, async move {
        let _ = stopped.wait_for(|stopping| *stopping).await;
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
        stopping,
        task,
        backups: backup_worker,
        license: license_ticker,
        pool,
        _lock: lock,
    })
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn a_blocking_thread_that_never_returns_cannot_hold_the_process_back() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (started, running) = std::sync::mpsc::channel();
        runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            std::thread::sleep(Duration::from_secs(8));
        });
        running.recv().unwrap();
        let begun = Instant::now();
        shutdown_runtime_within(runtime, Duration::from_millis(200));
        assert!(
            begun.elapsed() < Duration::from_secs(4),
            "the runtime waited for its blocking thread: {:?}",
            begun.elapsed()
        );
    }

    #[test]
    fn the_process_waits_for_a_blocked_thread_for_the_documented_time_and_no_longer() {
        assert_eq!(RUNTIME_SHUTDOWN_TIMEOUT, Duration::from_secs(5));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let (started, running) = std::sync::mpsc::channel();
        runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            std::thread::sleep(RUNTIME_SHUTDOWN_TIMEOUT + Duration::from_secs(4));
        });
        running.recv().unwrap();
        let begun = Instant::now();
        shutdown_runtime(runtime);
        let waited = begun.elapsed();
        assert!(
            waited >= RUNTIME_SHUTDOWN_TIMEOUT - Duration::from_millis(500),
            "{waited:?}"
        );
        assert!(
            waited < RUNTIME_SHUTDOWN_TIMEOUT + Duration::from_secs(2),
            "the runtime waited for its blocking thread: {waited:?}"
        );
    }
}
