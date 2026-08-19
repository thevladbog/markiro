# Station USB Printer Support — Design

**Date:** 2026-08-19
**Status:** Approved for planning
**Scope:** `apps/station` (React UI + Tauri/Rust shell)

## Problem

The line station prints ZPL/TSPL labels to network (TCP:9100) and COM (serial)
printers. USB-attached label printers cannot be detected or used, even though
they are the most common way a Zebra/TSC printer arrives on a factory line.
The station must detect USB printers, let the operator connect one, and keep
the existing printer-language choice (ZPL or TSPL) available for every
connection type.

## Decisions

1. **Windows only.** Production stations run Windows (Tauri beta). On other
   platforms detection returns an empty list and USB printing returns a clear
   "Windows only" error. Development on macOS keeps working; the USB list is
   simply empty there.
2. **Spooler RAW printing.** Print through the Windows spooler with
   `pDatatype = "RAW"` (`OpenPrinterW` → `StartDocPrinterW` → `WritePrinter` →
   `EndDocPrinter` → `ClosePrinter`). Bytes pass to the printer untouched; the
   vendor driver does not render anything. The printer must be installed as a
   Windows printer (vendor driver or Generic / Text Only) — that is the normal
   state after plugging in a Zebra/TSC on Windows.
3. **No PDF path.** Thermal label printers interpret ZPL/TSPL in firmware and
   do not accept PDF. Rendering PDF through the GDI driver path would create a
   second print pipeline, risk barcode degradation through driver scaling, and
   violate the repository invariant that preview and print share one
   client-side model. PDF output remains a separate future slice
   (see the existing note in `hardware-config.ts`).
4. **Detection = installed local printers on USB ports.** Enumerate with
   `EnumPrintersW(PRINTER_ENUM_LOCAL, level 2)` and keep only queues whose
   port name starts with `USB`. Network queues, PDF printers, and other noise
   are excluded; network label printers keep using the existing TCP transport
   directly.
5. **List + manual refresh UX.** The setup panel gains a "USB" transport
   option showing a touch-friendly list of detected printers with a refresh
   button — the same pattern the scanner uses with `list_serial_ports`. No
   live plug/unplug subscription.
6. **Config identifies the printer by spooler queue name.** The queue name is
   stable across replugging into a different USB socket; the `USBnnn` port
   number is not.
7. **Printer language is unchanged.** `printerLanguage: "zpl" | "tspl"` is
   already a transport-independent field selected in the setup panel; USB
   inherits it as-is.

## Architecture

### Rust (Tauri shell)

- New command `list_usb_printers() -> Vec<UsbPrinter { name, port }>`:
  - Windows: `EnumPrintersW` level 2, filter `pPortName` starting with `USB`,
    run inside `spawn_blocking` like `print_bytes`.
  - Non-Windows: returns an empty `Vec`.
- `PrintTarget` gains a third variant: `Usb { printer: String }`
  (serde tag `"usb"`). Printing uses the spooler RAW sequence above inside the
  existing `spawn_blocking` in `print_bytes`. Non-Windows returns
  "USB printing is only available on Windows".
- Win32 calls are isolated behind `#[cfg(windows)]`; the USB-port filter is a
  pure function over `(name, port)` pairs so it is unit-testable on any OS.
- `Cargo.toml`: extend the existing `windows-sys` target dependency with the
  `Win32_Graphics_Printing` and `Win32_Foundation` features. No new crates.
- Register `list_usb_printers` in the `generate_handler` list in `lib.rs`.
- Existing `Serial`/`Tcp` behavior is untouched.

### TypeScript contract and config

- `hardware.ts`: `PrintTarget` union gains `{ kind: "usb"; printer: string }`;
  `HardwareContract` gains
  `listUsbPrinters(): Promise<{ name: string; port: string }[]>`;
  `tauriHardware` maps it to `invoke("list_usb_printers")`.
- `hardware-config.ts`: `parsePrinter` accepts `kind: "usb"` with a non-empty
  `printer` string, otherwise `null`. Old configs stored in `station_meta`
  parse exactly as before (backward compatible).
- `printerLanguage` field, defaults, and persistence are unchanged.

### Setup UI

- `PrinterSetupPanel.tsx`: transport radio becomes
  None / TCP / COM / USB. Selecting USB shows:
  - a radio list of detected printers (`setup-touch-choice` pattern), each
    item rendered as `queue name · port`;
  - a "Refresh" button that re-invokes `listUsbPrinters`;
  - an empty-state hint: "No USB printers found. Check the connection and
    that the printer is installed in Windows";
  - if the saved printer is missing from a fresh list, it stays rendered as
    selected with a "not found" marker so a refresh cannot silently drop the
    stored configuration.
- Test print works unchanged: enabled when a USB printer is selected.
- The ZPL/TSPL language block keeps its current position and behavior.
- Panel state (selected USB printer name, detected list, refresh handler)
  lives in `WorkstationSetup.tsx` alongside the existing transport state.
- New i18n keys in `ru.json`/`en.json`: `setup.transportUsb`,
  `setup.usbPrinterList`, `setup.usbRefresh`, `setup.usbNotFound`,
  `setup.usbMissingSaved`. No hard-coded language paths.

## Error handling

- Spooler failures (`OpenPrinterW`, `StartDocPrinterW`, `WritePrinter`) map to
  a string error naming the printer and the Win32 error code from
  `GetLastError`, flowing through the same channel as TCP/COM print errors to
  the existing failure UI.
- A printer that disappeared by print time is an ordinary print error; the
  line is not blocked (existing error handling already guarantees this).

## Testing

Automated:

- Rust (`cargo test`, cross-platform): serde round-trip for
  `PrintTarget::Usb`, the USB-port filter function, the non-Windows error
  text. `EnumPrinters`/`WritePrinter` themselves are not unit-tested.
- TS (Vitest): `parsePrinter` usb variant and config round-trip plus legacy
  JSON compatibility; panel tests for transport switching, list rendering,
  refresh, missing-saved marker, and test-print enablement; print-target
  routing in `print-label`.
- Package gates: `pnpm --filter @markiro/station` test / typecheck / lint /
  build; `cargo test --manifest-path apps/station/src-tauri/Cargo.toml`.

Physical acceptance (separate from automated checks, goes to the hardware
acceptance checklist):

- Real Zebra (ZPL) and TSC (TSPL) over USB on a Windows station: detection,
  test print, box-label print, Cyrillic and DataMatrix output identical to the
  TCP path, and behavior when the cable is unplugged mid-shift.

## Out of scope

- PDF or GDI/driver-rendered printing.
- Live plug/unplug device notifications.
- macOS/Linux USB printing.
- Direct `usbprint.sys` / WinUSB access bypassing the spooler.
