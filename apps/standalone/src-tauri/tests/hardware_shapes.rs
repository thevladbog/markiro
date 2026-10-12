//! The JSON the shell sends the webview for the scanners' status and the
//! installed printers, and the driver printing answers (plan ДРВ:
//! `windowsPrintOutcomeSchema`, `windowsJobObservationSchema`), pinned to
//! `tests/fixtures/hardware-shapes.json`. The webview's strict schemas
//! (`scannerSnapshotSchema`, `usbPrinterSchema` in `src/hardware/hardware.ts`,
//! parsed against the same file in `test/hardware.test.ts`) drop an event with
//! a field they do not know without a word, so a field added here must reach
//! the fixture and the schema in the same change.

use markiro_standalone_lib::printer::driver::{Failure, Observation, Outcome, Receipt};
use markiro_standalone_lib::printer::UsbPrinter;
use markiro_standalone_lib::scanner::{ConnectionStatus, ScannerConnection, ScannerSnapshot};
use serde_json::Value;

#[test]
fn the_hardware_shapes_are_the_ones_the_fixture_pins() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/hardware-shapes.json")).unwrap();
    let snapshot = ScannerSnapshot {
        revision: 7,
        scanners: vec![
            ScannerConnection {
                port: "COM3".into(),
                baud: 9600,
                status: ConnectionStatus::Connected,
            },
            ScannerConnection {
                port: "COM4".into(),
                baud: 115_200,
                status: ConnectionStatus::Disconnected,
            },
        ],
    };
    let printer = UsbPrinter {
        name: "Zebra ZD421".into(),
        port: "USB001".into(),
    };
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        fixture["scannerSnapshot"]
    );
    assert_eq!(
        serde_json::to_value(&printer).unwrap(),
        fixture["usbPrinter"]
    );
    let receipt = || Receipt {
        queue: "Godex G500".into(),
        job_id: 42,
        document_name: "Markiro:7d1c2a8e-3b4f-4c5d-9e6f-0a1b2c3d4e5f".into(),
    };
    let shapes = [
        (
            "windowsPrintSent",
            serde_json::to_value(Outcome::Success {
                ok: true,
                receipt: receipt(),
            }),
        ),
        (
            "windowsPrintUnknown",
            serde_json::to_value(Outcome::Failed {
                ok: false,
                error: Failure {
                    code: "driver_failure",
                    phase: "delivery_unknown",
                    receipt: Some(receipt()),
                },
            }),
        ),
        (
            "windowsPrintRefused",
            serde_json::to_value(Outcome::Failed {
                ok: false,
                error: Failure {
                    code: "geometry_mismatch",
                    phase: "before_start",
                    receipt: None,
                },
            }),
        ),
        (
            "windowsJobPresent",
            serde_json::to_value(Observation::Present { status_flags: 8 }),
        ),
        (
            "windowsJobAbsent",
            serde_json::to_value(Observation::Absent),
        ),
        (
            "windowsJobIdentityMismatch",
            serde_json::to_value(Observation::IdentityMismatch),
        ),
        (
            "windowsJobUnavailable",
            serde_json::to_value(Observation::Unavailable),
        ),
    ];
    for (key, value) in shapes {
        assert_eq!(value.unwrap(), fixture[key], "{key}");
    }
    // Nothing else is pinned by the file: a new shape needs a new key here.
    assert_eq!(fixture.as_object().unwrap().len(), 9);
}
