use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Instant;

const TEST_RETRY: Duration = Duration::from_millis(20);

enum ReadStep {
    Bytes(Vec<u8>),
    Disconnect,
    Delayed(Vec<u8>, Receiver<()>, Sender<()>),
}

struct TestPort {
    input: Receiver<ReadStep>,
    dropped: Sender<()>,
}

impl Read for TestPort {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let bytes = match self.input.recv_timeout(Duration::from_millis(10)) {
            Ok(ReadStep::Bytes(bytes)) => bytes,
            Ok(ReadStep::Delayed(bytes, release, entered)) => {
                entered.send(()).unwrap();
                release.recv().unwrap();
                bytes
            }
            Ok(ReadStep::Disconnect) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::from(io::ErrorKind::BrokenPipe));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(io::Error::from(io::ErrorKind::TimedOut));
            }
        };
        buf[..bytes.len()].copy_from_slice(&bytes);
        Ok(bytes.len())
    }
}

impl Drop for TestPort {
    fn drop(&mut self) {
        let _ = self.dropped.send(());
    }
}

struct PortControl {
    input: Sender<ReadStep>,
    dropped: Receiver<()>,
}

impl PortControl {
    fn bytes(&self, bytes: &[u8]) {
        self.input.send(ReadStep::Bytes(bytes.to_vec())).unwrap();
    }
}

enum OpenStep {
    Ready(TestPort),
    Delayed(TestPort, Receiver<()>),
}

type OpenQueues = Arc<Mutex<HashMap<String, VecDeque<OpenStep>>>>;

struct Rig {
    manager: ScannerManager,
    queues: OpenQueues,
    attempts: Arc<Mutex<Vec<ScannerConfig>>>,
    events: Arc<Mutex<Vec<ScannerEvent>>>,
}

fn wait_until(predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "scanner worker did not reach expected state"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

impl Rig {
    fn new(retry: Duration) -> Self {
        let queues: OpenQueues = Arc::default();
        let attempts = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::new(Mutex::new(Vec::new()));
        let open_queues = Arc::clone(&queues);
        let open_attempts = Arc::clone(&attempts);
        let sink_events = Arc::clone(&events);
        let opener: PortOpener = Arc::new(move |config| {
            open_attempts.lock().unwrap().push(config.clone());
            let step = open_queues
                .lock()
                .unwrap()
                .get_mut(&config.port)
                .and_then(VecDeque::pop_front);
            let port = match step {
                Some(OpenStep::Ready(port)) => port,
                Some(OpenStep::Delayed(port, release)) => {
                    release.recv().unwrap();
                    port
                }
                None => return Err(io::Error::from(io::ErrorKind::NotFound)),
            };
            Ok(Box::new(port))
        });
        let sink: EventSink = Arc::new(move |event| sink_events.lock().unwrap().push(event));
        Self {
            manager: ScannerManager::new(opener, sink, retry),
            queues,
            attempts,
            events,
        }
    }

    fn port(&self, name: &str, delayed: Option<Receiver<()>>) -> PortControl {
        let (input, rx) = mpsc::channel();
        let (dropped_tx, dropped) = mpsc::channel();
        let port = TestPort {
            input: rx,
            dropped: dropped_tx,
        };
        let step = match delayed {
            Some(release) => OpenStep::Delayed(port, release),
            None => OpenStep::Ready(port),
        };
        self.queues
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .push_back(step);
        PortControl { input, dropped }
    }

    fn configure(&self, ports: &[&str]) {
        self.manager
            .configure(ports.iter().map(|port| config(port, 9600)).collect())
            .unwrap();
    }

    fn scans(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                ScannerEvent::Scan(scan) => Some(scan.clone()),
                _ => None,
            })
            .collect()
    }

    fn connected(&self, port: &str) -> bool {
        self.manager
            .snapshot()
            .scanners
            .iter()
            .any(|scanner| scanner.port == port && scanner.status == ConnectionStatus::Connected)
    }

    fn attempt_count(&self, port: &str) -> usize {
        self.attempts
            .lock()
            .unwrap()
            .iter()
            .filter(|config| config.port == port)
            .count()
    }
}

fn config(port: &str, baud: u32) -> ScannerConfig {
    ScannerConfig {
        port: port.to_string(),
        baud,
    }
}

#[test]
fn two_ports_keep_independent_fragments_and_exact_raw_payloads() {
    let rig = Rig::new(TEST_RETRY);
    let a = rig.port("COM3", None);
    let b = rig.port("COM4", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM3") && rig.connected("COM4"));
    a.bytes(b" 010460000000001521serial\x1d91key\x1d92crypto");
    b.bytes(b"SECOND\r\n");
    wait_until(|| rig.scans() == ["SECOND"]);
    a.bytes(b"+tail= \r\n");
    wait_until(|| rig.scans().len() == 2);
    assert_eq!(
        rig.scans(),
        [
            "SECOND",
            " 010460000000001521serial\x1d91key\x1d92crypto+tail= "
        ]
    );
    // A UTF-8 character split by the OS read must survive framing, too.
    b.bytes(&[0xd0]);
    b.bytes(&[0x90, b'\n']);
    wait_until(|| rig.scans().len() == 3);
    assert_eq!(rig.scans()[2], "А");
}

#[test]
fn absent_port_retries_without_blocking_healthy_port_and_recovers() {
    let rig = Rig::new(TEST_RETRY);
    let healthy = rig.port("COM4", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM4") && rig.attempt_count("COM3") >= 2);
    assert!(!rig.connected("COM3"));
    healthy.bytes(b"HEALTHY\r");
    wait_until(|| rig.scans() == ["HEALTHY"]);
    let restored = rig.port("COM3", None);
    wait_until(|| rig.connected("COM3"));
    restored.bytes(b"RESTORED\n");
    wait_until(|| rig.scans().len() == 2);
    assert_eq!(rig.scans(), ["HEALTHY", "RESTORED"]);
    assert_eq!(rig.attempt_count("COM4"), 1);
}

#[test]
fn reconnect_drops_partial_payload_and_leaves_other_port_running() {
    let rig = Rig::new(TEST_RETRY);
    let old = rig.port("COM3", None);
    let healthy = rig.port("COM4", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM3") && rig.connected("COM4"));
    old.bytes(b"UNFINISHED");
    old.input.send(ReadStep::Disconnect).unwrap();
    old.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| !rig.connected("COM3"));
    healthy.bytes(b"CONTINUES\n");
    wait_until(|| rig.scans() == ["CONTINUES"]);
    assert!(rig.connected("COM4"));
    let replacement = rig.port("COM3", None);
    wait_until(|| rig.connected("COM3"));
    replacement.bytes(b"NEW\r\n");
    wait_until(|| rig.scans().len() == 2);
    assert_eq!(rig.scans(), ["CONTINUES", "NEW"]);
    assert_eq!(rig.attempt_count("COM4"), 1);
}

#[test]
fn changing_one_port_retains_other_worker_and_pending_fragment() {
    let rig = Rig::new(TEST_RETRY);
    let a = rig.port("COM3", None);
    let b = rig.port("COM4", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM3") && rig.connected("COM4"));
    a.bytes(b"PENDING-");
    let replacement = rig.port("COM4", None);
    rig.manager
        .configure(vec![config("com3", 9600), config("COM4", 115200)])
        .unwrap();
    b.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| rig.connected("COM4"));
    a.bytes(b"TAIL\n");
    replacement.bytes(b"OTHER\n");
    wait_until(|| rig.scans().len() == 2);
    assert!(rig.scans().contains(&"PENDING-TAIL".to_string()));
    assert_eq!(rig.attempt_count("COM3"), 1);
    assert_eq!(
        rig.attempts
            .lock()
            .unwrap()
            .iter()
            .filter(|config| config.port == "COM4")
            .map(|config| config.baud)
            .collect::<Vec<_>>(),
        [9600, 115200]
    );
}

#[test]
fn removal_suppresses_delayed_read_and_replacement_waits_for_handle_drop() {
    let rig = Rig::new(TEST_RETRY);
    let old = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    let (release, blocked) = mpsc::channel();
    let (entered, reading) = mpsc::channel();
    old.input
        .send(ReadStep::Delayed(b"STALE\n".to_vec(), blocked, entered))
        .unwrap();
    reading.recv_timeout(Duration::from_secs(3)).unwrap();
    rig.configure(&[]);
    let closed_revision = rig.manager.snapshot().revision;
    let replacement = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    std::thread::sleep(Duration::from_millis(40));
    assert_eq!(
        rig.attempt_count("COM3"),
        1,
        "replacement must wait for the old handle"
    );
    release.send(()).unwrap();
    old.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| rig.connected("COM3"));
    replacement.bytes(b"CURRENT\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["CURRENT"]);
    let events = rig.events.lock().unwrap();
    assert!(!events.iter().any(|event| matches!(event, ScannerEvent::Status(snapshot) if snapshot.revision > closed_revision && snapshot.scanners.is_empty())));
}

#[test]
fn close_cancels_retry_and_suppresses_delayed_open_completion() {
    let rig = Rig::new(Duration::from_millis(150));
    let (release, blocked) = mpsc::channel();
    let delayed = rig.port("COM3", Some(blocked));
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.attempt_count("COM3") == 1 && rig.attempt_count("COM4") == 1);
    rig.configure(&[]);
    let closed = rig.manager.snapshot();
    release.send(()).unwrap();
    delayed
        .dropped
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(rig.attempt_count("COM4"), 1);
    assert_eq!(rig.manager.snapshot(), closed);
    assert!(rig.scans().is_empty());
    assert!(
        matches!(rig.events.lock().unwrap().last(), Some(ScannerEvent::Status(snapshot)) if snapshot == &closed)
    );
}

#[test]
fn configuration_validation_is_atomic_and_com_only_is_case_insensitive() {
    let rig = Rig::new(TEST_RETRY);
    let active = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    let before = rig.manager.snapshot();
    for invalid in [
        vec![config("COM4", 9600), config("com4", 9600)],
        vec![config(" ", 9600)],
        vec![config("COM3", 0)],
    ] {
        assert!(rig.manager.configure(invalid).is_err());
        assert_eq!(rig.manager.snapshot(), before);
    }
    active.bytes(b"STILL-ACTIVE\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["STILL-ACTIVE"]);
    rig.configure(&["COM3", "/dev/ttyA", "/dev/ttya"]);
    assert_eq!(rig.manager.snapshot().scanners.len(), 3);
}

#[test]
fn reapplying_same_ports_acknowledges_status_without_reopening_or_losing_fragment() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    let before = rig.manager.snapshot();
    port.bytes(b"PENDING-");
    rig.configure(&["com3"]);
    let acknowledged = rig.manager.snapshot();
    assert_eq!(acknowledged.revision, before.revision + 1);
    assert_eq!(acknowledged.scanners, before.scanners);
    assert!(
        matches!(rig.events.lock().unwrap().last(), Some(ScannerEvent::Status(snapshot)) if snapshot == &acknowledged)
    );
    port.bytes(b"TAIL\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["PENDING-TAIL"]);
    assert_eq!(rig.attempt_count("COM3"), 1);
}

#[test]
fn snapshot_revisions_order_events_and_noop_config_retains_connected_status() {
    let rig = Rig::new(TEST_RETRY);
    let _port = rig.port("COM3", None);
    assert_eq!(rig.manager.snapshot().revision, 0);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    let connected = rig.manager.snapshot();
    assert_eq!(connected.revision, 2);
    rig.configure(&["com3"]);
    let acknowledged = rig.manager.snapshot();
    assert_eq!(acknowledged.revision, 3);
    assert_eq!(acknowledged.scanners, connected.scanners);
    rig.configure(&[]);
    let snapshot = rig.manager.snapshot();
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        serde_json::json!({"revision":4,"scanners":[]})
    );
    let events = rig.events.lock().unwrap();
    let snapshots: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            ScannerEvent::Status(snapshot) => Some(snapshot),
            _ => None,
        })
        .collect();
    assert_eq!(
        snapshots
            .iter()
            .map(|snapshot| snapshot.revision)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    assert_eq!(
        serde_json::to_value(snapshots[1]).unwrap(),
        serde_json::json!({"revision":2,"scanners":[{"port":"COM3","baud":9600,"status":"connected"}]})
    );
}

#[test]
fn framing_preserves_gs_crypto_tail_and_payload_spaces() {
    let mut buf = " 010460000000001521serial\u{1d}91key\u{1d}92crypto+tail= \r\n"
        .as_bytes()
        .to_vec();
    assert_eq!(
        split_lines(&mut buf),
        vec![" 010460000000001521serial\u{1d}91key\u{1d}92crypto+tail= "]
    );
}

#[test]
fn extracts_complete_lines_and_keeps_the_tail() {
    let mut buf = "0104600000000015\r\n0104600000000022\r\npartial"
        .as_bytes()
        .to_vec();
    let lines = split_lines(&mut buf);
    assert_eq!(lines, vec!["0104600000000015", "0104600000000022"]);
    assert_eq!(buf, b"partial");
}

#[test]
fn returns_nothing_until_a_terminator_arrives() {
    let mut buf = "still-typing".as_bytes().to_vec();
    assert!(split_lines(&mut buf).is_empty());
    assert_eq!(buf, b"still-typing");
}

#[test]
fn skips_empty_lines_from_crlf_pairs() {
    let mut buf = "A\r\n\r\nB\n".as_bytes().to_vec();
    assert_eq!(split_lines(&mut buf), vec!["A", "B"]);
    assert!(buf.is_empty());
}

#[test]
fn absorb_chunk_returns_complete_lines_and_keeps_the_tail_pending() {
    let mut buffer = Vec::new();
    let lines = absorb_chunk(&mut buffer, "0104600000000015\r\npartial".as_bytes());
    assert_eq!(lines, vec!["0104600000000015"]);
    assert_eq!(buffer, b"partial");
}

#[test]
fn absorb_chunk_discards_the_buffer_once_it_exceeds_the_cap_without_a_terminator() {
    let mut buffer = Vec::new();
    let noise = "x".repeat(1024);
    let mut emitted = Vec::new();

    // Track bytes sent independently of `buffer`'s length: once the cap is
    // crossed, `absorb_chunk` clears `buffer` back to empty, so looping on
    // `buffer.len()` would never observe "past the cap" and never stop.
    let mut total_sent = 0usize;
    while total_sent <= MAX_BUFFER_BYTES {
        emitted.extend(absorb_chunk(&mut buffer, noise.as_bytes()));
        total_sent += noise.len();
    }

    assert!(emitted.is_empty());
    assert!(
        buffer.is_empty(),
        "expected the oversized, terminator-less buffer to be discarded"
    );
}

#[test]
fn absorb_chunk_emits_a_payload_split_across_two_chunks_intact() {
    let mut buffer = Vec::new();
    let first = absorb_chunk(&mut buffer, "0104600000000015".as_bytes());
    assert!(first.is_empty());
    assert_eq!(buffer, b"0104600000000015");

    let second = absorb_chunk(&mut buffer, "\r\n".as_bytes());
    assert_eq!(second, vec!["0104600000000015"]);
    assert!(buffer.is_empty());
}
