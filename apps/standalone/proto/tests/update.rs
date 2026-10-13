//! The update wire and rules the host and the shell share (plan ОБН-2): the
//! version form `prepare.mjs` accepts, the installer's name, the SHA-256 of
//! exactly the bytes a manifest names, and the office's report of a start.

use std::io::{self, Read};

use markiro_proto::update::{
    hash_exact, installer_name, AppVersion, HashError, UpdateSource, UpdateStarted, PRODUCT,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

#[test]
fn a_version_is_three_plain_numbers_and_orders_as_numbers() {
    let parse = |text: &str| text.parse::<AppVersion>();
    assert_eq!(
        parse("0.1.0"),
        Ok(AppVersion {
            major: 0,
            minor: 1,
            patch: 0
        })
    );
    assert_eq!(parse("12.0.345").unwrap().to_string(), "12.0.345");
    for bad in [
        "",
        "0.1",
        "v0.1.0",
        "0.1.0-beta.1",
        "01.1.0",
        "0.01.0",
        "1.2.3.4",
        "1..3",
        " 1.2.3",
        "1.2.3\n",
        "1.2.+3",
        "4294967296.0.0",
        "١.٢.٣",
    ] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
    let v = |text: &str| parse(text).unwrap();
    assert!(v("0.2.0") > v("0.1.9"));
    assert!(v("0.10.0") > v("0.9.0"));
    assert!(v("1.0.0") > v("0.99.99"));
    assert_eq!(v("0.2.0"), v("0.2.0"));
}

#[test]
fn the_installer_and_the_product_are_named_as_prepare_mjs_names_them() {
    let version: AppVersion = "0.2.0".parse().unwrap();
    assert_eq!(
        installer_name(&version),
        "markiro-standalone-0.2.0-windows-x86_64-setup.exe"
    );
    assert_eq!(PRODUCT, "markiro-standalone");
}

struct Broken;

impl Read for Broken {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }
}

#[test]
fn the_hash_covers_exactly_the_size_the_manifest_names() {
    assert_eq!(
        hash_exact(&b"abc"[..], 3),
        Ok("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned())
    );
    assert_eq!(hash_exact(&b"abc"[..], 4), Err(HashError::TooShort));
    assert_eq!(hash_exact(&b"abc"[..], 2), Err(HashError::TooLong));
    assert_eq!(
        hash_exact(&b""[..], 0),
        Ok("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned())
    );
    // More than one 64 KiB piece, and one byte past the size.
    let big = vec![7u8; 200_000];
    let expected: String = Sha256::digest(&big)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(hash_exact(&big[..], 200_000), Ok(expected));
    assert_eq!(hash_exact(&big[..], 199_999), Err(HashError::TooLong));
    assert_eq!(
        hash_exact(Broken, 1),
        Err(HashError::Io(io::ErrorKind::PermissionDenied))
    );
    // An endless source is refused as soon as it passes the size.
    assert_eq!(hash_exact(io::repeat(0), 10), Err(HashError::TooLong));
    // An interrupted read is retried, and short reads add up.
    let expected: String = Sha256::digest(b"abcdef")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        hash_exact(Stuttering::new(b"abcdef"), 6),
        Ok(expected.clone())
    );
}

/// Gives one byte per read, after an `Interrupted` before each.
struct Stuttering {
    bytes: Vec<u8>,
    interrupt: bool,
}

impl Stuttering {
    fn new(bytes: &[u8]) -> Self {
        Self {
            bytes: bytes.to_vec(),
            interrupt: true,
        }
    }
}

impl Read for Stuttering {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.interrupt {
            self.interrupt = false;
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        self.interrupt = true;
        if self.bytes.is_empty() || buffer.is_empty() {
            return Ok(0);
        }
        buffer[0] = self.bytes.remove(0);
        Ok(1)
    }
}

#[test]
fn the_report_of_a_started_update_round_trips_and_refuses_what_the_host_does_not_read() {
    let original = fixture("update-started.json");
    let record: UpdateStarted = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(record.source, UpdateSource::File);
    assert_eq!(serde_json::to_value(&record).unwrap(), original);
    let mut from_host = original.clone();
    from_host["source"] = "host".into();
    assert_eq!(
        serde_json::from_value::<UpdateStarted>(from_host)
            .unwrap()
            .source,
        UpdateSource::Host
    );
    // The device is the session's: a body that names one is refused.
    for (field, value) in [
        (
            "deviceId",
            Value::from("7c9e6679-7425-40de-944b-e07fc1f90ae7"),
        ),
        ("source", Value::from("usb")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        assert!(
            serde_json::from_value::<UpdateStarted>(changed).is_err(),
            "{field}"
        );
    }
    let mut missing = original;
    missing.as_object_mut().unwrap().remove("installerSha256");
    assert!(serde_json::from_value::<UpdateStarted>(missing).is_err());
}
