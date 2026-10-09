use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Instant;

const TEST_RETRY: Duration = Duration::from_millis(20);

enum ReadStep {
    Bytes(Vec<u8>),
    Error(io::ErrorKind),
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
            Ok(ReadStep::Error(kind)) => return Err(io::Error::from(kind)),
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
        vec![config("COM\0", 9600)],
        vec![config("COM3", 0)],
    ] {
        assert_eq!(
            rig.manager.configure(invalid),
            Err(ScannerError::InvalidScanners)
        );
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

fn statuses(rig: &Rig) -> Vec<ScannerSnapshot> {
    rig.events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            ScannerEvent::Status(snapshot) => Some(snapshot.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn a_scan_split_at_the_group_separator_and_at_every_byte_arrives_once_and_whole() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    // Cut right before and right after each GS, inside the AIM prefix, and the
    // CR from the LF.
    for part in [
        &b"]d"[..],
        b"2010460000000001521serial",
        b"\x1d",
        b"91key",
        b"\x1d92crypto",
        b"\r",
        b"\n",
    ] {
        port.bytes(part);
    }
    // A second scan whose terminator is the only byte of its read, then a read
    // holding the end of one scan and a whole one, with a CR-only terminator.
    port.bytes(b"SECOND");
    port.bytes(b"\r");
    port.bytes(b"THI");
    port.bytes(b"RD\rFOURTH\r\n");
    wait_until(|| rig.scans().len() == 4);
    assert_eq!(
        rig.scans(),
        [
            "]d2010460000000001521serial\x1d91key\x1d92crypto",
            "SECOND",
            "THIRD",
            "FOURTH"
        ]
    );
}

#[test]
fn a_zero_length_read_is_a_lost_port_and_the_next_connection_starts_clean() {
    let rig = Rig::new(TEST_RETRY);
    let old = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    old.bytes(b"HALF-A-SCAN");
    old.bytes(b"");
    old.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    let replacement = rig.port("COM3", None);
    wait_until(|| rig.attempt_count("COM3") == 2 && rig.connected("COM3"));
    replacement.bytes(b"NEW\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["NEW"]);
}

#[test]
fn a_read_that_is_interrupted_or_times_out_keeps_the_port_and_any_other_error_loses_it() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    port.bytes(b"HALF-");
    for kind in [
        io::ErrorKind::Interrupted,
        io::ErrorKind::WouldBlock,
        io::ErrorKind::TimedOut,
    ] {
        port.input.send(ReadStep::Error(kind)).unwrap();
    }
    port.bytes(b"SCAN\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["HALF-SCAN"]);
    assert!(rig.connected("COM3"));
    assert_eq!(rig.attempt_count("COM3"), 1);

    let replacement = rig.port("COM3", None);
    port.input
        .send(ReadStep::Error(io::ErrorKind::PermissionDenied))
        .unwrap();
    port.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| rig.attempt_count("COM3") == 2 && rig.connected("COM3"));
    replacement.bytes(b"AFTER\n");
    wait_until(|| rig.scans().len() == 2);
    assert_eq!(rig.scans(), ["HALF-SCAN", "AFTER"]);
}

#[test]
fn a_dropped_and_reopened_port_publishes_each_change_once_in_order() {
    let rig = Rig::new(TEST_RETRY);
    let old = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    old.input.send(ReadStep::Disconnect).unwrap();
    old.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    let _replacement = rig.port("COM3", None);
    wait_until(|| rig.attempt_count("COM3") == 2 && rig.connected("COM3"));
    let seen: Vec<_> = statuses(&rig)
        .iter()
        .map(|snapshot| {
            (
                snapshot.revision,
                snapshot
                    .scanners
                    .iter()
                    .map(|s| s.status)
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    use ConnectionStatus::{Connected, Disconnected};
    assert_eq!(
        seen,
        [
            (1, vec![Disconnected]),
            (2, vec![Connected]),
            (3, vec![Disconnected]),
            (4, vec![Connected]),
        ]
    );
}

#[test]
fn an_absent_port_is_retried_at_the_retry_pace_not_in_a_busy_loop() {
    let rig = Rig::new(Duration::from_millis(100));
    rig.configure(&["COM9"]);
    wait_until(|| rig.attempt_count("COM9") >= 2);
    let before = rig.attempt_count("COM9");
    std::thread::sleep(Duration::from_millis(350));
    let during = rig.attempt_count("COM9") - before;
    // About 3.5 attempts; a loop without the pause makes thousands.
    assert!(during <= 5, "{during} attempts in 350 ms at a 100 ms retry");
    // Nothing is published while a port stays absent.
    assert_eq!(rig.manager.snapshot().revision, 1);
    assert_eq!(statuses(&rig).len(), 1);
}

#[test]
fn removing_a_connected_port_closes_its_handle_and_closing_twice_is_harmless() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM3"));
    rig.configure(&[]);
    port.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(rig.manager.snapshot().scanners, []);
    let closed = rig.manager.snapshot().revision;
    rig.configure(&[]);
    assert_eq!(rig.manager.snapshot().scanners, []);
    assert_eq!(rig.manager.snapshot().revision, closed + 1);
    // Bytes pushed at a closed port go nowhere: the reader is gone.
    assert!(port
        .input
        .send(ReadStep::Bytes(b"LATE\n".to_vec()))
        .is_err());
    assert!(rig.scans().is_empty());
}

#[test]
fn the_handle_is_released_before_the_loss_is_published() {
    // The sink runs inside the publishing call, so it sees the handle's state
    // at the very moment "disconnected" is announced.
    let (input, rx) = mpsc::channel();
    let (dropped_tx, dropped) = mpsc::channel();
    let port = Arc::new(Mutex::new(Some(TestPort {
        input: rx,
        dropped: dropped_tx,
    })));
    let opener: PortOpener = Arc::new(move |_| match port.lock().unwrap().take() {
        Some(port) => Ok(Box::new(port)),
        None => Err(io::Error::from(io::ErrorKind::NotFound)),
    });
    let dropped = Mutex::new(dropped);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_by_sink = Arc::clone(&seen);
    let sink: EventSink = Arc::new(move |event| {
        if let ScannerEvent::Status(snapshot) = event {
            if snapshot
                .scanners
                .iter()
                .any(|scanner| scanner.status == ConnectionStatus::Disconnected)
                && snapshot.revision > 1
            {
                let released = dropped.lock().unwrap().try_recv().is_ok();
                seen_by_sink.lock().unwrap().push(released);
            }
        }
    });
    let manager = ScannerManager::new(opener, sink, TEST_RETRY);
    manager.configure(vec![config("COM3", 9600)]).unwrap();
    wait_until(|| manager.snapshot().revision == 2);
    input.send(ReadStep::Disconnect).unwrap();
    wait_until(|| !seen.lock().unwrap().is_empty());
    // A listener told "disconnected" may open the port at once: the OS handle
    // was already closed when it was told.
    assert_eq!(*seen.lock().unwrap(), [true]);
}

#[test]
fn a_removed_workers_late_open_does_not_mark_its_replacement_connected() {
    let rig = Rig::new(TEST_RETRY);
    let (release_old, old_gate) = mpsc::channel();
    let (release_new, new_gate) = mpsc::channel();
    let old = rig.port("COM3", Some(old_gate));
    let new = rig.port("COM3", Some(new_gate));
    rig.configure(&["COM3"]);
    wait_until(|| rig.attempt_count("COM3") == 1);
    // The old worker is stuck inside its open while the port is removed and
    // added again (a new worker, queued behind the old one).
    rig.configure(&[]);
    rig.configure(&["COM3"]);
    release_old.send(()).unwrap();
    old.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| rig.attempt_count("COM3") == 2);
    assert!(!rig.connected("COM3"));
    assert!(statuses(&rig).iter().all(|snapshot| snapshot
        .scanners
        .iter()
        .all(|scanner| scanner.status == ConnectionStatus::Disconnected)));
    release_new.send(()).unwrap();
    wait_until(|| rig.connected("COM3"));
    new.bytes(b"NEW\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["NEW"]);
}

#[test]
fn dropping_the_manager_closes_every_port() {
    let rig = Rig::new(TEST_RETRY);
    let a = rig.port("COM3", None);
    let b = rig.port("COM4", None);
    rig.configure(&["COM3", "COM4"]);
    wait_until(|| rig.connected("COM3") && rig.connected("COM4"));
    let Rig { manager, .. } = rig;
    drop(manager);
    a.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    b.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[test]
fn a_poisoned_lock_neither_keeps_a_port_open_nor_refuses_a_new_configuration() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    let core = Arc::clone(&rig.manager.core);
    let poisoner = std::thread::spawn(move || {
        let _held = core.state.lock().unwrap();
        panic!("poison the configuration lock");
    });
    assert!(poisoner.join().is_err());
    assert!(rig.manager.core.state.is_poisoned());
    let replacement = rig.port("COM4", None);
    rig.configure(&["COM4"]);
    port.dropped.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_until(|| rig.connected("COM4"));
    replacement.bytes(b"STILL-WORKS\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["STILL-WORKS"]);
    rig.configure(&[]);
    replacement
        .dropped
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
}

#[test]
fn a_refused_configuration_publishes_nothing_and_changes_nothing() {
    let rig = Rig::new(TEST_RETRY);
    let port = rig.port("COM3", None);
    rig.configure(&["COM3"]);
    wait_until(|| rig.connected("COM3"));
    port.bytes(b"HALF-");
    let before = (rig.manager.snapshot(), statuses(&rig).len());
    let too_many: Vec<_> = (0..=MAX_SCANNERS)
        .map(|n| config(&format!("COM{n}"), 9600))
        .collect();
    assert_eq!(
        rig.manager.configure(too_many),
        Err(ScannerError::InvalidScanners)
    );
    // A bad element after good ones refuses the whole request.
    assert_eq!(
        rig.manager
            .configure(vec![config("COM5", 9600), config("COM6", 0)]),
        Err(ScannerError::InvalidScanners)
    );
    assert_eq!((rig.manager.snapshot(), statuses(&rig).len()), before);
    assert_eq!(rig.attempt_count("COM5"), 0);
    port.bytes(b"DONE\n");
    wait_until(|| !rig.scans().is_empty());
    assert_eq!(rig.scans(), ["HALF-DONE"]);
}

#[test]
fn port_names_and_the_number_of_scanners_are_bounded_and_canonical() {
    let rig = Rig::new(TEST_RETRY);
    let names = |rig: &Rig| -> Vec<String> {
        rig.manager
            .snapshot()
            .scanners
            .into_iter()
            .map(|s| s.port)
            .collect()
    };
    // The most scanners, and the longest name, are accepted.
    let longest = "p".repeat(MAX_PORT_NAME_CHARS);
    let full: Vec<_> = (0..MAX_SCANNERS)
        .map(|n| config(&format!("COM{}", n + 1), 9600))
        .collect();
    assert_eq!(rig.manager.configure(full), Ok(()));
    assert_eq!(rig.manager.snapshot().scanners.len(), MAX_SCANNERS);
    assert_eq!(rig.manager.configure(vec![config(&longest, 9600)]), Ok(()));
    assert_eq!(names(&rig), std::slice::from_ref(&longest));
    for refused in [
        format!("{longest}p"),
        "COM\t3".to_string(),
        "COM3\u{7f}".to_string(),
        "COM\u{85}3".to_string(),
        "/dev/tty\nUSB0".to_string(),
        "\0".to_string(),
        "".to_string(),
        " \t ".to_string(),
    ] {
        assert_eq!(
            rig.manager.configure(vec![config(&refused, 9600)]),
            Err(ScannerError::InvalidScanners),
            "{refused:?}"
        );
    }
    // The name is trimmed; only an all-digit COMn is upper-cased.
    for (given, kept) in [
        (" com12 ", "COM12"),
        ("Com3", "COM3"),
        ("com", "com"),
        ("com3x", "com3x"),
        ("com\u{663}", "com\u{663}"),
        ("/dev/ttyUSB0", "/dev/ttyUSB0"),
        // The first letter is the Cyrillic С (U+0421), which looks like the
        // Latin C: only the ASCII spelling is a COM port to upper-case. Written
        // as an escape on purpose, so that no editor turns it into a Latin one.
        ("\u{421}OM3", "\u{421}OM3"),
    ] {
        assert_eq!(rig.manager.configure(vec![config(given, 115_200)]), Ok(()));
        assert_eq!(names(&rig), [kept], "{given:?}");
    }
    // Two spellings of one COM port are one port twice.
    assert_eq!(
        rig.manager
            .configure(vec![config(" com3", 9600), config("COM3", 19_200)]),
        Err(ScannerError::InvalidScanners)
    );
    assert_eq!(rig.manager.configure(vec![]), Ok(()));
    assert_eq!(rig.manager.snapshot().scanners, []);
    assert_eq!(
        rig.manager.configure(vec![config("COM3", u32::MAX)]),
        Ok(())
    );
}

#[test]
fn concurrent_reconfiguration_publishes_consecutive_revisions_and_the_last_matches_the_snapshot() {
    let rig = Rig::new(Duration::from_millis(3));
    // Every port opens and drops at once, so statuses flap while four threads
    // reconfigure.
    for name in ["COM3", "COM4"] {
        for _ in 0..80 {
            let _ = rig.port(name, None);
        }
    }
    let sets: [&[&str]; 4] = [&["COM3"], &["COM3", "COM4"], &[], &["COM4"]];
    std::thread::scope(|scope| {
        for offset in 0..4 {
            let rig = &rig;
            scope.spawn(move || {
                for round in 0..40 {
                    rig.configure(sets[(offset + round) % 4]);
                }
            });
        }
    });
    rig.configure(&[]);
    // Retiring workers publish nothing once removed.
    std::thread::sleep(Duration::from_millis(50));
    let all = statuses(&rig);
    let revisions: Vec<u64> = all.iter().map(|snapshot| snapshot.revision).collect();
    assert_eq!(revisions, (1..=revisions.len() as u64).collect::<Vec<_>>());
    assert_eq!(all.last(), Some(&rig.manager.snapshot()));
    assert_eq!(rig.manager.snapshot().revision, revisions.len() as u64);
}

fn frames(chunks: &[&[u8]]) -> (Vec<String>, Framer) {
    let mut framer = Framer::default();
    let mut scans = Vec::new();
    for chunk in chunks {
        scans.extend(framer.absorb(chunk));
    }
    (scans, framer)
}

#[test]
fn framing_preserves_gs_crypto_tail_and_payload_spaces() {
    let (scans, framer) =
        frames(&[" 010460000000001521serial\u{1d}91key\u{1d}92crypto+tail= \r\n".as_bytes()]);
    assert_eq!(
        scans,
        [" 010460000000001521serial\u{1d}91key\u{1d}92crypto+tail= "]
    );
    assert!(framer.pending.is_empty());
}

#[test]
fn extracts_complete_lines_and_keeps_the_tail() {
    let (scans, framer) = frames(&[b"0104600000000015\r\n0104600000000022\r\npartial"]);
    assert_eq!(scans, ["0104600000000015", "0104600000000022"]);
    assert_eq!(framer.pending, b"partial");
}

#[test]
fn returns_nothing_until_a_terminator_arrives() {
    let (scans, framer) = frames(&[b"still-", b"typing"]);
    assert!(scans.is_empty());
    assert_eq!(framer.pending, b"still-typing");
}

#[test]
fn every_terminator_form_ends_a_frame_and_empty_frames_are_skipped() {
    let (scans, framer) = frames(&[b"A\rB\nC\r\nD\n\rE\r\r\n\nF\n", b"\r\n\r\n\n\r"]);
    assert_eq!(scans, ["A", "B", "C", "D", "E", "F"]);
    assert!(framer.pending.is_empty());
    // Only terminators produce nothing, however many.
    assert!(frames(&[b"\r\n\r\n\n\r", b"\n"]).0.is_empty());
    // A frame of spaces is a scan: payload spaces are never trimmed.
    assert_eq!(frames(&[b" \n  \r"]).0, [" ", "  "]);
}

#[test]
fn bytes_are_decoded_only_when_the_frame_is_whole() {
    // A Cyrillic letter cut between its two bytes, a replacement for a byte
    // that is no UTF-8 (a Latin-1 scanner), NUL and a BOM kept as they came.
    let (scans, _) = frames(&[
        &[0xd0],
        &[0x90, b'\n'],
        &[b'c', b'a', b'f', 0xe9, b'\n'],
        &[0xff, 0xfe, b'\n'],
        b"A\0B\n",
        &[0xef, 0xbb, 0xbf, b'X', b'\n'],
    ]);
    assert_eq!(
        scans,
        ["А", "caf\u{fffd}", "\u{fffd}\u{fffd}", "A\0B", "\u{feff}X"]
    );
    // Every byte value but the terminators in one frame: nothing is dropped
    // or reordered, only replaced.
    let garbage: Vec<u8> = (0..=255u8).filter(|b| *b != b'\r' && *b != b'\n').collect();
    let mut stream = garbage.clone();
    stream.push(b'\n');
    let (scans, _) = frames(&[&stream]);
    assert_eq!(scans, [String::from_utf8_lossy(&garbage).into_owned()]);
}

#[test]
fn the_chunking_of_the_stream_never_changes_the_scans() {
    let stream: Vec<u8> = [
        &b"]d2010460000000001521serial\x1d91key\x1d92crypto\r\n"[..],
        "Привет\r".as_bytes(),
        b"\n\n]C1\x1d\x1d\rA\0B\r\n",
        &[0xff, 0xd0, b'\n', 0xd0],
        &[0x90, b'\r', b'T', b'A', b'I', b'L'],
    ]
    .concat();
    let (whole, whole_framer) = frames(&[&stream]);
    assert_eq!(
        whole,
        [
            "]d2010460000000001521serial\x1d91key\x1d92crypto",
            "Привет",
            "]C1\x1d\x1d",
            "A\0B",
            "\u{fffd}\u{fffd}",
            "А"
        ]
    );
    assert_eq!(whole_framer.pending, b"TAIL");
    // Cut in two at every position, in three at every pair, then byte by byte.
    for cut in 0..=stream.len() {
        let (scans, framer) = frames(&[&stream[..cut], &stream[cut..]]);
        assert_eq!(scans, whole, "cut at {cut}");
        assert_eq!(framer.pending, whole_framer.pending, "cut at {cut}");
    }
    for first in 0..=stream.len() {
        for second in first..=stream.len() {
            let parts: [&[u8]; 3] = [&stream[..first], &stream[first..second], &stream[second..]];
            assert_eq!(frames(&parts).0, whole, "cuts at {first} and {second}");
        }
    }
    let bytewise: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(frames(&bytewise).0, whole);
}

#[test]
fn a_frame_of_exactly_the_limit_is_a_scan_and_one_byte_more_is_dropped_whole() {
    let exact = vec![b'x'; MAX_FRAME_BYTES];
    // The byte over the limit is a GS, as one in a long crypto tail may be.
    let mut over = vec![b'y'; MAX_FRAME_BYTES];
    over.push(0x1d);
    let mut stream = exact.clone();
    stream.push(b'\n');
    stream.extend_from_slice(&over);
    stream.extend_from_slice(b"\nNEXT\n");
    let (scans, framer) = frames(&[&stream]);
    assert_eq!(scans, [String::from_utf8(exact).unwrap(), "NEXT".into()]);
    assert!(framer.pending.is_empty() && !framer.discarding);
    // The same through reads of the size the port driver uses.
    let chunks: Vec<&[u8]> = stream.chunks(256).collect();
    assert_eq!(frames(&chunks).0, scans);
    let bytewise: Vec<&[u8]> = stream.chunks(1).collect();
    assert_eq!(frames(&bytewise).0, scans);
}

#[test]
fn an_oversize_frame_leaves_no_fragment_and_bounded_memory() {
    let mut framer = Framer::default();
    let noise = [b'x'; 256];
    let mut sent = 0;
    while sent <= 100 * MAX_FRAME_BYTES {
        assert!(framer.absorb(&noise).is_empty());
        assert!(framer.pending.len() <= MAX_FRAME_BYTES);
        sent += noise.len();
    }
    // The terminator ends the dropped frame; what follows is a clean frame.
    assert!(framer.absorb(b"tail-of-the-dropped-frame").is_empty());
    assert_eq!(framer.absorb(b"\r\nGOOD\n"), ["GOOD"]);
    assert!(framer.take_oversize());
    assert!(!framer.take_oversize());
    assert!(framer.pending.is_empty() && !framer.discarding);
    // Without a terminator the frame stays dropped, however the reads fall.
    let mut again = Framer::default();
    again.absorb(&vec![b'z'; MAX_FRAME_BYTES + 1]);
    assert!(again.absorb(b"more").is_empty() && again.discarding);
    assert_eq!(again.absorb(b"\nOK\n"), ["OK"]);
    // Each dropped frame is counted once.
    let mut counted = Framer::default();
    let long = vec![b'q'; MAX_FRAME_BYTES + 10];
    counted.absorb(&long);
    counted.absorb(b"\n");
    counted.absorb(&long);
    assert_eq!(counted.oversize, 2);
}
