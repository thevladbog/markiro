//! The host under test, in one of three ways: in this process (the harness's
//! own tests: no memory figure, no log), as a child process of the real
//! `markiro-host` binary (the runs that count: its memory and descriptors are
//! its own, and `run` writes the log the busy-line scan reads), or a host
//! somebody else started (attach: the harness only talks to it).

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use markiro_host::config::HostPaths;
use markiro_host::{RunningHost, StartOptions};
use serde::{Deserialize, Serialize};

use crate::api::pinned_client;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

enum Process {
    InProcess(RunningHost),
    Spawned { child: Child, log: PathBuf },
    Attached,
}

pub struct Host {
    pub base: String,
    pub fingerprint: String,
    pub data_dir: Option<PathBuf>,
    pub pid: Option<u32>,
    /// A host on this machine: the first station pairs locally.
    pub local: bool,
    process: Process,
}

/// What the host's own log says of the run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogScan {
    pub available: bool,
    pub error_lines: u64,
    pub busy_lines: u64,
    pub first_errors: Vec<String>,
}

/// Whether a log line tells that SQLite refused to wait for a lock.
pub fn is_busy_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("database is locked")
        || lower.contains("database table is locked")
        || lower.contains("sqlite_busy")
        || lower.contains("(code: 5)")
        || lower.contains("(code: 6)")
}

pub fn scan_log(text: &str) -> LogScan {
    let mut scan = LogScan {
        available: true,
        ..LogScan::default()
    };
    for line in text.lines() {
        if line.contains(" ERROR ") {
            scan.error_lines += 1;
            if scan.first_errors.len() < 5 {
                scan.first_errors.push(line.chars().take(300).collect());
            }
        }
        if is_busy_line(line) {
            scan.busy_lines += 1;
        }
    }
    scan
}

async fn wait_ready(base: &str, fingerprint: &str, limit: Duration) -> Result<(), Error> {
    let client = pinned_client(fingerprint, Duration::from_secs(2));
    let started = Instant::now();
    loop {
        if let Ok(response) = client.get(format!("{base}/v1/hello")).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() > limit {
            return Err("the host did not answer /v1/hello in time".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

impl Host {
    /// The host in this process on a loopback port of its own.
    pub async fn in_process(data_dir: &Path) -> Result<Host, Error> {
        let running = markiro_host::start(
            &HostPaths::new(data_dir),
            StartOptions {
                port_override: None,
                bind: Some(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
            },
        )
        .await?;
        Ok(Host {
            base: format!("https://127.0.0.1:{}", running.addr.port()),
            fingerprint: running.fingerprint.clone(),
            data_dir: Some(data_dir.to_path_buf()),
            pid: None,
            local: true,
            process: Process::InProcess(running),
        })
    }

    /// `bin run --data-dir <data_dir> --port <free port>` with its output in
    /// `log`. The command line binds every interface (it has no flag for
    /// less), for as long as the run lasts: run it on a machine you trust.
    pub async fn spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error> {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port();
        let out = std::fs::File::create(log)?;
        let child = Command::new(bin)
            .args(["run", "--data-dir"])
            .arg(data_dir)
            .args(["--port", &port.to_string()])
            .stdin(Stdio::null())
            .stdout(out.try_clone()?)
            .stderr(out)
            .spawn()?;
        let pid = child.id();
        let mut host = Host {
            base: format!("https://127.0.0.1:{port}"),
            fingerprint: String::new(),
            data_dir: Some(data_dir.to_path_buf()),
            pid: Some(pid),
            local: true,
            process: Process::Spawned {
                child,
                log: log.to_path_buf(),
            },
        };
        // The identity appears when the host has started; read it from disk.
        let paths = HostPaths::new(data_dir);
        let started = Instant::now();
        let fingerprint = loop {
            if let Ok(identity) = markiro_host::tls::TlsIdentity::load(&paths.tls_dir()) {
                break identity.fingerprint;
            }
            if started.elapsed() > Duration::from_secs(60) {
                host.stop().await.ok();
                return Err("the host wrote no TLS identity in 60 s".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        host.fingerprint = fingerprint;
        if let Err(error) = wait_ready(&host.base, &host.fingerprint, Duration::from_secs(60)).await
        {
            host.stop().await.ok();
            return Err(error);
        }
        Ok(host)
    }

    /// A host that runs already: `base` is `https://host:port`.
    pub fn attached(
        base: &str,
        fingerprint: &str,
        data_dir: Option<PathBuf>,
        pid: Option<u32>,
    ) -> Host {
        Host {
            base: base.trim_end_matches('/').to_owned(),
            fingerprint: fingerprint.to_owned(),
            data_dir,
            pid,
            local: false,
            process: Process::Attached,
        }
    }

    /// The host's log so far (a spawned host only).
    pub fn log_scan(&self) -> LogScan {
        match &self.process {
            Process::Spawned { log, .. } => std::fs::read_to_string(log)
                .map(|text| scan_log(&text))
                .unwrap_or_default(),
            _ => LogScan::default(),
        }
    }

    /// Stop what this harness started; `true` when it ended by itself on a
    /// request to stop (SIGINT on Unix; Windows has none: the process is
    /// killed and the database recovers its log on the next start).
    pub async fn stop(&mut self) -> Result<bool, Error> {
        match std::mem::replace(&mut self.process, Process::Attached) {
            Process::InProcess(running) => {
                running.stop().await?;
                Ok(true)
            }
            Process::Spawned { mut child, log } => {
                if child.try_wait()?.is_some() {
                    // Ended already (stopped before, or killed): nothing to ask, and its pid may
                    // belong to another process by now.
                    self.process = Process::Spawned { child, log };
                    return Ok(false);
                }
                let asked = ask_to_stop(&child);
                let started = Instant::now();
                let graceful = loop {
                    if let Some(status) = child.try_wait()? {
                        break asked && status.success();
                    }
                    if started.elapsed() > Duration::from_secs(30) {
                        child.kill().ok();
                        child.wait().ok();
                        break false;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                };
                self.process = Process::Spawned { child, log };
                Ok(graceful)
            }
            Process::Attached => Ok(false),
        }
    }
}

/// A host this harness spawned never outlives it: a panic, an early return or
/// an error path kills the child (a stopped one is already reaped; the kill
/// is then a no-op). A Ctrl-C in a terminal reaches the child too, being in
/// the same foreground process group.
impl Drop for Host {
    fn drop(&mut self) {
        if let Process::Spawned { child, .. } = &mut self.process {
            child.kill().ok();
            child.wait().ok();
        }
    }
}

/// The pids `ask_to_stop` signalled (tests only: a signal to a pid that already ended is the
/// hazard the stop guard exists for, and it cannot be seen from outside).
#[cfg(test)]
static SIGNALLED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

#[cfg(unix)]
fn ask_to_stop(child: &Child) -> bool {
    #[cfg(test)]
    SIGNALLED.lock().unwrap().push(child.id());
    Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn ask_to_stop(_child: &Child) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::pinned_client;

    #[test]
    fn the_log_scan_counts_errors_and_the_lines_that_name_a_busy_database() {
        let log = "\
2026-10-20T10:00:00Z  INFO markiro_host: markiro-host listening\n\
2026-10-20T10:00:01Z ERROR markiro_host::error: request failed error=error returned from database: (code: 5) database is locked\n\
2026-10-20T10:00:02Z ERROR markiro_host::routes::facts: a fact batch failed device=d position=3\n\
2026-10-20T10:00:03Z  WARN markiro_host::facts: a fact was rejected\n";
        let scan = scan_log(log);
        assert_eq!(
            (scan.available, scan.error_lines, scan.busy_lines),
            (true, 2, 1)
        );
        assert_eq!(scan.first_errors.len(), 2);
        assert!(!is_busy_line("an ordinary line"));
        assert!(is_busy_line("SQLITE_BUSY: the database file is locked"));
    }

    #[tokio::test]
    async fn a_host_in_this_process_answers_hello_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let client = pinned_client(&host.fingerprint, Duration::from_secs(5));
        let response = client
            .get(format!("{}/v1/hello", host.base))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(host.stop().await.unwrap());
    }

    #[tokio::test]
    async fn a_pinned_client_trusts_only_the_fingerprint_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        let url = format!("{}/v1/hello", host.base);
        let good = pinned_client(&host.fingerprint, Duration::from_secs(5));
        assert!(good.get(&url).send().await.unwrap().status().is_success());
        let wrong = "0".repeat(host.fingerprint.len());
        assert_ne!(wrong, host.fingerprint);
        let bad = pinned_client(&wrong, Duration::from_secs(5));
        let error = bad
            .get(&url)
            .send()
            .await
            .expect_err("a mismatch must fail");
        assert!(error.is_connect() || error.is_request(), "{error:?}");
        host.stop().await.unwrap();
    }

    fn host_binary() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let debug_dir = exe.parent().unwrap().parent().unwrap();
        let name = if cfg!(windows) {
            "markiro-host.exe"
        } else {
            "markiro-host"
        };
        let bin = debug_dir.join(name);
        if !bin.exists() {
            let status = Command::new(env!("CARGO"))
                .args(["build", "--offline", "--locked", "-p", "markiro-host"])
                .arg("--manifest-path")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../Cargo.toml"))
                .status()
                .unwrap();
            assert!(status.success());
        }
        assert!(bin.exists(), "no markiro-host at {}", bin.display());
        bin
    }

    #[tokio::test]
    async fn a_spawned_host_answers_hello_logs_and_stops_on_sigint() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let data = dir.path().join("data");
        let mut host = Host::spawned(&host_binary(), &data, &log).await.unwrap();
        assert!(host.pid.is_some() && host.local && !host.fingerprint.is_empty());
        let client = pinned_client(&host.fingerprint, Duration::from_secs(5));
        let response = client
            .get(format!("{}/v1/hello", host.base))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(host.log_scan().available);
        let pid = host.pid.unwrap();
        let graceful = host.stop().await.unwrap();
        assert_eq!(graceful, cfg!(unix));
        if cfg!(unix) {
            let alive = Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap();
            assert!(!alive.success(), "the host process is still alive");
        }
        assert!(client
            .get(format!("{}/v1/hello", host.base))
            .send()
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_dropped_spawned_host_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let host = Host::spawned(&host_binary(), &dir.path().join("data"), &log)
            .await
            .unwrap();
        let base = host.base.clone();
        let fingerprint = host.fingerprint.clone();
        drop(host);
        let client = pinned_client(&fingerprint, Duration::from_secs(2));
        assert!(client.get(format!("{base}/v1/hello")).send().await.is_err());
    }

    #[tokio::test]
    async fn an_attached_host_is_only_talked_to() {
        let mut host = Host::attached("https://127.0.0.1:1/", "ab", None, Some(7));
        assert_eq!(host.base, "https://127.0.0.1:1");
        assert!(!host.local);
        assert!(!host.stop().await.unwrap());
        assert_eq!(host.log_scan(), LogScan::default());
    }

    #[tokio::test]
    async fn a_stopped_spawned_host_is_not_signalled_again() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let mut host = Host::spawned(&host_binary(), &dir.path().join("data"), &log)
            .await
            .unwrap();
        let pid = host.pid.unwrap();
        let first = host.stop().await.unwrap();
        assert_eq!(first, cfg!(unix));
        let signalled = |pid: u32| {
            SIGNALLED
                .lock()
                .unwrap()
                .iter()
                .filter(|p| **p == pid)
                .count()
        };
        assert_eq!(
            signalled(pid),
            usize::from(cfg!(unix)),
            "one request to stop"
        );
        // The child ended: a second stop asks nothing of a pid that may be another process's now.
        let started = Instant::now();
        assert!(!host.stop().await.unwrap());
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            signalled(pid),
            usize::from(cfg!(unix)),
            "the second stop signalled nothing"
        );
    }
}
