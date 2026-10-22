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

/// `text` without its ANSI escape sequences.
///
/// The host paints its stdout layer even when stdout is a file, so a spawned host's log reads
/// `ESC[31mERRORESC[0m`: matching " ERROR " needs the colour gone. CSI sequences are removed
/// (`ESC [`, parameter and intermediate bytes, one final byte `@`..`~`); a lone or unfinished
/// `ESC` is dropped, any other text is kept.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

pub fn scan_log(text: &str) -> LogScan {
    let mut scan = LogScan {
        available: true,
        ..LogScan::default()
    };
    for raw in text.lines() {
        let line = strip_ansi(raw);
        let line = line.as_str();
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

    /// `bin run --data-dir <data_dir> --port <free port>` with its output in `log`. The command
    /// line binds every interface (it has no flag for less), for as long as the run lasts: run
    /// it on a machine you trust.
    pub async fn spawned(bin: &Path, data_dir: &Path, log: &Path) -> Result<Host, Error> {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            .local_addr()?
            .port();
        Host::spawned_on(bin, data_dir, log, port, false).await
    }

    /// `spawned` on a given port; `append` keeps what `log` holds (a restart).
    pub async fn spawned_on(
        bin: &Path,
        data_dir: &Path,
        log: &Path,
        port: u16,
        append: bool,
    ) -> Result<Host, Error> {
        let out = if append {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)?
        } else {
            std::fs::File::create(log)?
        };
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
        // The identity appears when the host has started (at once on a restart); a child that
        // ends meanwhile (its port taken, its folder refused) is said at once, not after a minute.
        let paths = HostPaths::new(data_dir);
        let started = Instant::now();
        loop {
            if let Process::Spawned { child, .. } = &mut host.process {
                if let Some(status) = child.try_wait()? {
                    return Err(format!(
                        "markiro-host ended at its start ({status}): see {}",
                        log.display()
                    )
                    .into());
                }
            }
            if host.fingerprint.is_empty() {
                if let Ok(identity) = markiro_host::tls::TlsIdentity::load(&paths.tls_dir()) {
                    host.fingerprint = identity.fingerprint;
                }
            }
            if !host.fingerprint.is_empty()
                && wait_ready(&host.base, &host.fingerprint, Duration::from_millis(1))
                    .await
                    .is_ok()
            {
                return Ok(host);
            }
            if started.elapsed() > Duration::from_secs(60) {
                host.stop().await.ok();
                return Err("the host did not answer /v1/hello in 60 s".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// The port of the host's address.
    pub fn port(&self) -> Option<u16> {
        self.base
            .rsplit(':')
            .next()
            .and_then(|port| port.parse().ok())
    }

    /// Kill the host this harness spawned at once, as a crash would (`SIGKILL` on Unix,
    /// `TerminateProcess` on Windows), and reap it; `true` when it was still running. Any other
    /// host is refused: the harness kills only the child it started, never a process found by
    /// name, and never signals a child that already ended.
    pub fn kill_hard(&mut self) -> Result<bool, Error> {
        match &mut self.process {
            Process::Spawned { child, .. } => {
                if child.try_wait()?.is_some() {
                    return Ok(false);
                }
                child.kill()?;
                child.wait()?;
                Ok(true)
            }
            _ => Err("only a host this harness spawned is killed".into()),
        }
    }

    /// Start the binary again on the same data folder and port, appending to the same log, after
    /// a kill or a stop; the identity (fingerprint) must be the same.
    pub async fn restart(&mut self, bin: &Path) -> Result<(), Error> {
        let (Some(data_dir), Some(port)) = (self.data_dir.clone(), self.port()) else {
            return Err("no data folder or port to restart on".into());
        };
        let log = match &mut self.process {
            Process::Spawned { child, log } => {
                if child.try_wait()?.is_none() {
                    return Err("the host still runs: stop or kill it first".into());
                }
                log.clone()
            }
            _ => return Err("only a host this harness spawned restarts".into()),
        };
        let mut fresh = Host::spawned_on(bin, &data_dir, &log, port, true).await?;
        if fresh.fingerprint != self.fingerprint {
            fresh.stop().await.ok();
            return Err("the restarted host has another identity".into());
        }
        self.pid = fresh.pid;
        self.process = std::mem::replace(&mut fresh.process, Process::Attached);
        Ok(())
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

/// The `markiro-host` binary of this build's target folder, built when it is missing (tests).
#[cfg(test)]
pub(crate) fn test_host_binary() -> PathBuf {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::pinned_client;
    use std::io::Write;

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

    /// The host's stdout layer paints (tracing's default `ansi`), also when stdout is a file: a
    /// spawned host's log holds these shapes (level coloured, timestamp/target/`=` dimmed, field
    /// names italic).
    const COLOURED: &str = "\
\x1b[2m2026-10-20T10:00:00.123456Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mmarkiro_host\x1b[0m\x1b[2m:\x1b[0m markiro-host listening \x1b[3maddr\x1b[0m\x1b[2m=\x1b[0m127.0.0.1:1\n\
\x1b[2m2026-10-20T10:00:01.123456Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mmarkiro_host::error\x1b[0m\x1b[2m:\x1b[0m request failed \x1b[3merror\x1b[0m\x1b[2m=\x1b[0merror returned from database: (code: 5) database is locked\n\
\x1b[2m2026-10-20T10:00:02.123456Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[1;2mroute\x1b[0m\x1b[2m{\x1b[0m\x1b[3mdevice\x1b[0m\x1b[2m=\x1b[0md\x1b[2m}\x1b[0m\x1b[2m:\x1b[0m \x1b[2mmarkiro_host::routes::facts\x1b[0m\x1b[2m:\x1b[0m a fact batch failed\n\
\x1b[2m2026-10-20T10:00:03.123456Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mmarkiro_host::facts\x1b[0m\x1b[2m:\x1b[0m a fact was rejected\n";

    #[test]
    fn the_log_scan_sees_through_the_colour_a_spawned_hosts_log_carries() {
        let scan = scan_log(COLOURED);
        assert_eq!(
            (scan.error_lines, scan.busy_lines),
            (2, 1),
            "{:?}",
            scan.first_errors
        );
        assert_eq!(scan.first_errors.len(), 2);
        assert!(
            scan.first_errors.iter().all(|line| !line.contains('\x1b')),
            "{:?}",
            scan.first_errors
        );
        assert!(scan.first_errors[0].contains(" ERROR markiro_host::error"));
        assert!(is_busy_line(
            "\x1b[2mcode\x1b[0m: \x1b[31mSQLITE_BUSY\x1b[0m"
        ));
    }

    #[test]
    fn a_clean_coloured_log_counts_nothing() {
        let clean = "\
\x1b[2m2026-10-20T10:00:00.1Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mmarkiro_host\x1b[0m\x1b[2m:\x1b[0m listening\n\
\x1b[2m2026-10-20T10:00:01.1Z\x1b[0m \x1b[34m DEBUG\x1b[0m \x1b[2mmarkiro_host\x1b[0m\x1b[2m:\x1b[0m the word ERRORS is not a level\n\
\x1b[2m2026-10-20T10:00:02.1Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mmarkiro_host\x1b[0m\x1b[2m:\x1b[0m slow request\n";
        let scan = scan_log(clean);
        assert_eq!(
            (scan.available, scan.error_lines, scan.busy_lines),
            (true, 0, 0)
        );
        assert!(scan.first_errors.is_empty());
    }

    #[test]
    fn ansi_sequences_are_stripped_and_plain_text_is_kept() {
        assert_eq!(strip_ansi("\x1b[31mERROR\x1b[0m x"), "ERROR x");
        assert_eq!(strip_ansi("\x1b[1;2;38;5;9mA\x1b[m"), "A");
        assert_eq!(strip_ansi("plain [31m text"), "plain [31m text");
        assert_eq!(strip_ansi("dangling \x1b"), "dangling ");
        assert_eq!(strip_ansi("Привет \x1b[0mмир"), "Привет мир");
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
        super::test_host_binary()
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
        let real = host.log_scan();
        assert!(real.available);
        // The real log is painted (the host's stdout layer colours a file too) and, being clean,
        // counts nothing; an ERROR line of the host's own shape appended to it is then counted.
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(
            text.contains('\x1b'),
            "the spawned host's log carries no colour: {text}"
        );
        assert_eq!((real.error_lines, real.busy_lines), (0, 0), "{text}");
        let error_line = "\x1b[2m2026-10-20T10:00:01.123456Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mmarkiro_host::error\x1b[0m\x1b[2m:\x1b[0m request failed\n";
        std::fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(error_line.as_bytes())
            .unwrap();
        assert_eq!(host.log_scan().error_lines, 1);
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
    async fn an_in_process_host_is_never_killed_or_restarted_by_the_harness() {
        let dir = tempfile::tempdir().unwrap();
        let mut host = Host::in_process(dir.path()).await.unwrap();
        assert!(host.kill_hard().is_err());
        assert!(host.restart(Path::new("no-such-binary")).await.is_err());
        host.stop().await.unwrap();
    }

    #[cfg_attr(
        windows,
        ignore = "restarting on the same port is unverified on Windows"
    )]
    #[tokio::test]
    async fn a_killed_host_restarts_on_its_port_with_its_identity() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("host.log");
        let bin = host_binary();
        let mut host = Host::spawned(&bin, &dir.path().join("data"), &log)
            .await
            .unwrap();
        let (base, fingerprint, pid) = (host.base.clone(), host.fingerprint.clone(), host.pid);
        assert_eq!(
            host.port(),
            base.rsplit(':').next().and_then(|p| p.parse().ok())
        );
        let logged = std::fs::metadata(&log).unwrap().len();
        assert!(host.kill_hard().unwrap(), "it was running");
        let client = pinned_client(&fingerprint, Duration::from_secs(2));
        assert!(client.get(format!("{base}/v1/hello")).send().await.is_err());
        assert!(
            !host.kill_hard().unwrap(),
            "an ended child is not signalled"
        );
        host.restart(&bin).await.unwrap();
        assert_eq!(
            (host.base.clone(), host.fingerprint.clone()),
            (base.clone(), fingerprint)
        );
        assert_ne!(host.pid, pid);
        assert!(client
            .get(format!("{base}/v1/hello"))
            .send()
            .await
            .unwrap()
            .status()
            .is_success());
        assert!(
            host.restart(&bin).await.is_err(),
            "a running host is not restarted"
        );
        if logged > 0 {
            assert!(
                std::fs::metadata(&log).unwrap().len() > logged,
                "the log is appended to, not truncated"
            );
        }
        host.stop().await.unwrap();
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
