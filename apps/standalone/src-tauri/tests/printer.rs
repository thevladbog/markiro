//! `print_to` against stub printers (stage 2a spec §5.2, §7): a TCP printer
//! on 127.0.0.1 that takes the whole label, one that is not there, one that
//! cuts the connection in the middle of a label and one that stops reading.
//! Each send runs on its own thread and is awaited with a deadline, so a send
//! that hangs fails its test instead of hanging the suite. The stubs listen
//! on loopback, so the suite runs outside the agents' sandbox. A COM printer
//! has no stub here: macOS refuses a serial port's settings on a
//! pseudo-terminal (`ENOTTY`), so the COM path is checked by hand with a real
//! printer or a com0com pair on Windows.

use std::io::Read;
use std::net::{SocketAddr, TcpListener};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use markiro_standalone_lib::printer::{
    connect, print_to, PrintError, PrintFailure, PrintTarget, Timeouts,
};

/// Longer than any send here should take, short enough to fail fast.
const DEADLINE: Duration = Duration::from_secs(10);

/// A label of `len` bytes that are not all ASCII: ZPL's text plus the bytes
/// above 0x7F and the GS1 group separator that a TSPL bitmap or a DataMatrix
/// carry.
fn label(len: usize) -> Vec<u8> {
    (0..len)
        .map(|index| match index % 4 {
            0 => b'^',
            1 => 0x1D,
            2 => 0xA4,
            _ => (index % 251) as u8,
        })
        .collect()
}

/// Runs `print_to` on its own thread and waits at most `DEADLINE` for it.
fn send(target: PrintTarget, bytes: Vec<u8>, timeouts: Timeouts) -> Result<(), PrintFailure> {
    let (done, outcome) = mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(print_to(&target, &bytes, timeouts));
    });
    outcome
        .recv_timeout(DEADLINE)
        .expect("the send ended within its deadline")
}

fn tcp(port: u16) -> PrintTarget {
    PrintTarget::Tcp {
        host: "127.0.0.1".into(),
        port,
    }
}

#[test]
fn a_network_printer_receives_the_exact_bytes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        received.send(bytes).unwrap();
    });
    let bytes = label(64 * 1024);

    assert!(send(tcp(port), bytes.clone(), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), bytes);
}

#[test]
fn a_printer_that_is_not_listening_is_not_sent() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let failure = send(tcp(port), label(16), Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("connect"), "{}", failure.detail);
}

/// The printer reads the first kilobyte and closes the connection with the
/// rest still unread, which makes its side reset it: the label may be half
/// printed, so the send is `outcome_unknown`, never `not_sent`.
#[test]
fn a_connection_cut_in_the_middle_of_a_label_is_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut first = [0u8; 1024];
        stream.read_exact(&mut first).unwrap();
        drop(stream);
    });

    let failure = send(tcp(port), label(64 * 1024 * 1024), Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(failure.detail.starts_with("write"), "{}", failure.detail);
}

/// A printer that accepts the connection and stops reading (out of paper,
/// its buffer full): once the system's buffers fill up, the write times out,
/// and the label may or may not print later.
#[test]
fn a_printer_that_stops_reading_is_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (accepted, hold) = mpsc::channel();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        // Hold the connection, unread, until the test ends.
        accepted.send(stream).unwrap();
    });
    let timeouts = Timeouts {
        connect: Duration::from_secs(5),
        write: Duration::from_millis(200),
    };

    let failure = send(tcp(port), label(64 * 1024 * 1024), timeouts).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(failure.detail.starts_with("write"), "{}", failure.detail);
    drop(hold.recv_timeout(DEADLINE).unwrap());
}

/// An address on loopback where nobody listens.
fn dead_address() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

/// Runs `job` on its own thread and waits at most `DEADLINE` for it.
fn within<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> T {
    let (done, outcome) = mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(job());
    });
    outcome
        .recv_timeout(DEADLINE)
        .expect("the call ended within its deadline")
}

/// A stub that takes `connections` connections one after another and sends
/// each connection's bytes, read to the end, down the channel.
fn stub_printer(connections: usize) -> (u16, mpsc::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = mpsc::channel();
    thread::spawn(move || {
        for _ in 0..connections {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            received.send(bytes).unwrap();
        }
    });
    (port, printed)
}

/// Every byte value, in an order a text-oriented path would damage: NUL, the
/// GS1 group separator, CR and LF, the bytes above 0x7F, the EOF byte.
#[test]
fn every_byte_value_reaches_the_printer_unchanged() {
    let (port, printed) = stub_printer(1);
    let bytes: Vec<u8> = (0..=255u8).cycle().take(256 * 40).collect();

    assert!(send(tcp(port), bytes.clone(), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), bytes);
}

/// A label bigger than the system's buffers goes out in several writes to a
/// printer that reads it in pieces; none is lost or doubled.
#[test]
fn a_long_label_to_a_slow_printer_arrives_whole() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match stream.read(&mut chunk).unwrap() {
                0 => break,
                read => bytes.extend_from_slice(&chunk[..read]),
            }
            thread::sleep(Duration::from_micros(200));
        }
        received.send(bytes).unwrap();
    });
    let bytes = label(6 * 1024 * 1024);

    assert!(send(tcp(port), bytes.clone(), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), bytes);
}

/// Two labels at once to one network printer are two connections whose bytes
/// do not mix, and neither send sees the other.
#[test]
fn two_sends_at_once_to_one_printer_do_not_mix() {
    let (port, printed) = stub_printer(2);
    let first = vec![b'A'; 2 * 1024 * 1024];
    let second = vec![b'B'; 2 * 1024 * 1024];

    let one = {
        let first = first.clone();
        thread::spawn(move || send(tcp(port), first, Timeouts::default()))
    };
    let two = {
        let second = second.clone();
        thread::spawn(move || send(tcp(port), second, Timeouts::default()))
    };
    assert!(one.join().unwrap().is_ok());
    assert!(two.join().unwrap().is_ok());

    let mut labels = vec![
        printed.recv_timeout(DEADLINE).unwrap(),
        printed.recv_timeout(DEADLINE).unwrap(),
    ];
    labels.sort();
    assert_eq!(labels, [first, second]);
}

/// An IPv6 literal is a host like any other (skipped on a computer without
/// an IPv6 loopback).
#[test]
fn a_network_printer_on_an_ipv6_literal_receives_the_bytes() {
    let Ok(listener) = TcpListener::bind("[::1]:0") else {
        eprintln!("no IPv6 loopback: skipped");
        return;
    };
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        received.send(bytes).unwrap();
    });
    let target = PrintTarget::Tcp {
        host: "::1".into(),
        port,
    };

    assert!(send(target, label(1024), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), label(1024));
}

/// `localhost` names an IPv6 and an IPv4 loopback on most computers; the
/// printer listens on IPv4 only.
#[test]
fn a_name_with_several_addresses_reaches_a_printer_on_any_of_them() {
    let (port, printed) = stub_printer(1);
    let target = PrintTarget::Tcp {
        host: "localhost".into(),
        port,
    };

    assert!(send(target, label(1024), Timeouts::default()).is_ok());
    assert_eq!(printed.recv_timeout(DEADLINE).unwrap(), label(1024));
}

/// A name with several addresses, the first of which is nobody's: the
/// connection goes through to the next.
#[test]
fn connecting_tries_every_address_within_one_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let live = listener.local_addr().unwrap();
    let timeout = Duration::from_secs(5);

    let stream = within(move || connect(&[dead_address(), live], timeout)).unwrap();
    assert_eq!(stream.peer_addr().unwrap(), live);
    drop(stream);

    let failure = within(move || connect(&[dead_address(), dead_address()], timeout)).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("connect"), "{}", failure.detail);

    let failure = connect(&[], timeout).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert_eq!(failure.detail, "connect: no address");
}

/// With no time at all there is no connection: `not_sent`.
#[test]
fn a_connect_timeout_of_zero_is_not_sent() {
    let address = dead_address();
    let failure = connect(&[address, address], Duration::ZERO).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("connect"), "{}", failure.detail);
}

/// The operating system refuses a zero write timeout after the connection is
/// open and before the first byte: the one failure between the two that a
/// stub can cause. Nothing was written, so it is `not_sent`.
#[test]
fn a_write_timeout_of_zero_is_not_sent() {
    let (port, _printed) = stub_printer(1);
    let timeouts = Timeouts {
        connect: Duration::from_secs(5),
        write: Duration::ZERO,
    };

    let failure = send(tcp(port), label(16), timeouts).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("timeout"), "{}", failure.detail);
}

/// An address that never answers (TEST-NET-1, RFC 5737) is `not_sent` inside
/// the connect timeout, whether the network drops the packets or refuses
/// the route at once.
#[test]
fn a_printer_that_never_answers_is_not_sent() {
    let target = PrintTarget::Tcp {
        host: "192.0.2.1".into(),
        port: 9100,
    };
    let timeouts = Timeouts {
        connect: Duration::from_millis(300),
        write: Duration::from_secs(5),
    };

    let failure = send(target, label(16), timeouts).unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(failure.detail.starts_with("connect"), "{}", failure.detail);
}

/// A printer that accepts the connection and closes it at once, before the
/// first byte is read: the bytes may or may not have been taken, so the
/// answer is `outcome_unknown`, not `not_sent`.
#[test]
fn a_printer_that_hangs_up_is_outcome_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        drop(stream);
    });

    let failure = send(tcp(port), label(64 * 1024 * 1024), Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(failure.detail.starts_with("write"), "{}", failure.detail);
}

/// The errors name neither the printer's address nor a byte of the label.
#[test]
fn a_failure_names_no_address_and_no_byte() {
    let address = dead_address();

    let failure = send(
        tcp(address.port()),
        b"^XA^FDSECRET-LABEL-TEXT^FS^XZ".to_vec(),
        Timeouts::default(),
    )
    .unwrap_err();
    assert_eq!(failure.error, PrintError::NotSent);
    assert!(!failure.detail.contains("127.0.0.1"), "{}", failure.detail);
    assert!(
        !failure.detail.contains(&address.port().to_string()),
        "{}",
        failure.detail
    );
    assert!(!failure.detail.contains("SECRET"), "{}", failure.detail);

    // The same after the first write began.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        drop(stream);
    });
    let mut secret = b"^XA^FDSECRET-LABEL-TEXT^FS^XZ".to_vec();
    secret.resize(64 * 1024 * 1024, b'^');
    let failure = send(tcp(port), secret, Timeouts::default()).unwrap_err();
    assert_eq!(failure.error, PrintError::OutcomeUnknown);
    assert!(!failure.detail.contains("127.0.0.1"), "{}", failure.detail);
    assert!(
        !failure.detail.contains(&port.to_string()),
        "{}",
        failure.detail
    );
    assert!(!failure.detail.contains("SECRET"), "{}", failure.detail);
}
