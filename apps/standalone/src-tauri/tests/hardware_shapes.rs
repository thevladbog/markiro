//! The JSON the shell sends the webview for the scanners' status and the
//! installed printers, pinned to `tests/fixtures/hardware-shapes.json`. The
//! webview's strict schemas (`scannerSnapshotSchema`, `usbPrinterSchema` in
//! `src/hardware/hardware.ts`, parsed against the same file in
//! `test/hardware.test.ts`) drop an event with a field they do not know
//! without a word, so a field added here must reach the fixture and the
//! schema in the same change.

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
    // Nothing else is pinned by the file: a new shape needs a new key here.
    assert_eq!(fixture.as_object().unwrap().len(), 2);
}
