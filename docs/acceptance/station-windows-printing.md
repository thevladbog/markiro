# Station printing through Windows

Status: implementation under local validation; Windows application and physical
printer acceptance remain separate release gates.

In Settings → Printers select an installed Windows queue and “Through Windows”.
Install the vendor's driver first. Configure paper dimensions and printer DPI
(203 or 300); print the test label and scan its unique code. RAW ZPL/TSPL remains
available for Windows queues, TCP/IP and serial/COM, including existing Bluetooth
serial connections. Existing profiles keep RAW behavior. There is no BLE pairing
or automatic conversion of old print jobs.

The universal layer is the Windows driver, so support depends on a working driver
that accepts the exact label geometry. A printer without a compatible Windows
driver is not covered by this mode.

## Output and recovery

The station renders one complete monochrome page locally, including bundled-font
text and full GS1 data. No cloud rendering, fit-to-page or automatic rotation is
used. Preflight checks actual DPI, physical size, printable area and mandatory
barcode whitespace. A failed check requires correcting the queue settings.

Every Windows attempt persists its frozen profile, artifact digest and sending
claim before hardware output. A process failure or transport exception leaves an
unknown result, never an automatic retry. Reprints require an operator action;
product duplicates keep their existing reason and full-code verification rules.
Old ZPL/TSPL jobs replay their original bytes on a compatible RAW profile.

The local receipt contains queue, job ID and a unique document name. A queue lookup
checks all three. “Absent” is only a spooler observation; scan the paper label to
confirm the result. Review an unknown result at the physical printer before
requesting another copy. Test labels use a fresh code on every print.

Unresolved Windows deliveries prevent parent destination/byte cleanup. Operator
verification or an explicit recovery decision resolves the local uncertainty.
Local receipts do not change immutable server event digests or pinned old batches.

## Automated gates

- Domain codec vectors, full-page GS1 decode, strict RAW/raster event parsing.
- SQLite upgrades, claim races, restart, receipt identity and retained old jobs.
- Station preparation/output/reprint/verification and RAW regressions.
- API events/history and tenant/actor/policy checks against isolated PostgreSQL.
- Kotlin shared-fixture parity; Android build/lint remain distinct from devices.
- `cargo test --manifest-path tools/station-printer-tests/Cargo.toml --locked` runs
  the actual printer core without Tauri/WebView2. Windows CI also compiles the full
  Station application. A macOS test or Windows target typecheck is not Windows IO.

## Required physical acceptance

Record Windows version, driver version, printer model, connection, DPI, stock size
and the exact Station source SHA. Exercise at least two driver families, USB and
network-installed queues, plus RAW ZPL and TSPL controls.

1. Test, box, pallet, inventory and product-duplicate labels, plus warehouse reprints.
2. 203/300 DPI, Cyrillic, long text, dates, QR, EAN-13, Code 128/SSCC and full
   product Data Matrix including group separators and crypto tail.
3. Measure label size; scan the codes independently and compare exact payloads.
4. Wrong DPI/paper/printable margins must fail before document submission.
5. Offline/stopped queue, service interruption and Station restart during sending
   must expose uncertainty without an unsolicited extra label.
6. Change current catalog/template/printer settings, then reprint a saved product
   job; its artifact digest and full payload must remain unchanged.
7. Check job disappearance and reused IDs do not mark a label verified.

Publish the compatible API before Station. Do not downgrade while raster jobs are
unresolved. No release, deployment or physical acceptance is implied by local tests.

Win32 references: [DEVMODE](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-devmodew),
[device capabilities](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdevicecaps),
[GDI printing](https://learn.microsoft.com/en-us/windows/win32/printdocs/gdi-printing).

## Local validation on 2026-10-10

Implementation branch: `codex/station-windows-printing`, based on
`0ebdcb5a498c64a37cf0e3de57a2ce2efdf0e11e`. Results below describe local validation before PR publication.

Passed on the final implementation:

- Station: 152 files, 2075 tests; domain: 74 files, 1019 tests.
- Printing API events: 38 tests against a disposable PostgreSQL database.
- SQLite schema: 76 tests; focused driver recovery/retention/receipt/UI tests.
- Station, domain, DB, API and admin lint/typecheck/build; repository formatting
  and whitespace checks. Admin history consumer tests also passed.
- Browser setup: 5 checks; 1024×768 screenshot inspected, including mode switching,
  remembered RAW language, DPI and footer reachability. Native capability was
  simulated for this browser check.
- Android unit tests, lint and debug APK build.
- Host Rust: 160 tests; standalone printer core: 6 tests; actual driver core
  typechecked for `x86_64-pc-windows-msvc` with real Windows bindings.
- Production bundle: 580 checks; affected-CI selection: 23 checks.

The broad DB run had 656 passing tests and two timeout failures. The SQLite
schema rerun passed; the unchanged legacy PostgreSQL migration fixture still
exceeded its 20-second test budget. Executing that exact fixture separately
completed successfully in 39.1 seconds. The timeout was not increased.

The broad API run was stopped after timing failures in inventory-documents and
exchange-import. Exchange-import passed a focused rerun. The long inventory
lifecycle still exceeded its 5-second budget and interfered with subsequent
shared-fixture cases. These general gates are **not** claimed green.

The complete Windows application could not be cross-built on macOS because the
C toolchain lacked the Windows SDK headers required by `ring`. The Windows-target
printer-core check does not replace that build. Windows CI, real driver/queue
behavior, printed dimensions and independent physical scanning remain required.
No release, deployment or physical printing was performed during this validation.
