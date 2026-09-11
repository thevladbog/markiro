# Station: multiple COM scanners

Station keeps every saved scanner port active. Operators can use a stationary
scanner or a handheld backup without changing the active scanner. Configure each
port and its baud rate once in **Workstation setup → Scanner → Add scanner** and
save with **Done**. The list is local to the station and works offline.

## Runtime contract

- Each port has its own reader, frame buffer and connection state. Completed
  scans enter the existing ordered production scan pipeline; there is no new
  transport-level barcode deduplication or change to production/verification rules.
- Reconfiguring the list retains unchanged ports. Removing a port retires its
  reader and prevents late reads or connection attempts from emitting scans.
- A missing, busy or disconnected port retries automatically every two seconds.
  Other ports continue working. Idle read timeouts do not mean disconnection.
- A disconnected reader discards its incomplete frame. Its next connection starts
  with a fresh frame; bytes from different ports or connections are never joined.
- Each connection status is visible in setup. The work screen distinguishes all
  connected, partially connected and none connected. An open COM handle confirms
  the transport, not the optical reader or the radio link behind a wireless base.
- Reconnection targets the saved COM name. If Windows assigns a different name,
  select that new port in setup. Station does not open every discovered serial
  device: ports may also belong to printers or other equipment.
- An empty scanner list selects the existing keyboard-wedge input. This change
  does not combine COM and HID keyboard sources.

The local `hardware_config` JSON gains an authoritative `scanners` array. Old
settings containing only `scanner: {port, baud}` continue to load. New saves keep
`scanner` equal to the first configured port, or `null` for an empty array, so an
older Station can still use the first port. No database schema migration is needed.
Invalid/duplicate stored array entries are excluded while valid ports remain usable.

Native commands are `configure_scanners`, `close_scanner` (all ports),
`list_serial_ports` and `get_scanner_connections`. Connection snapshots carry a
monotonic revision; a delayed initial snapshot cannot overwrite newer events.
The `station://scan` payload remains the raw code string.

## Automated evidence

TypeScript tests cover legacy/list loading, saving and reloading multiple ports,
independent baud rates, duplicate selection, removal, configuring the full set at
startup, individual/partial status, snapshot/event ordering and subscription cleanup.
Rust tests exercise independent readers, missing/busy ports, reconnect, cancellation,
late reads/opens, retained connections, input validation and exact frame bytes.
These tests use simulated transports and do not establish physical acceptance.

## Windows and hardware acceptance

Record Station version, Windows version, scanner models/firmware, interface mode,
COM assignments, baud rates and outcome for each step. Keep raw marking codes out
of public logs and screenshots.

1. Connect two scanners on distinct COM ports. Save both with their actual baud
   rates. Confirm both port statuses and scan the displayed test code with each.
2. Start a test production task offline. Alternate at least ten scans per device,
   including full GS1 Data Matrix codes with GS separators and cryptographic tails.
   Verify exact code interpretation, accepted-unit counts and unchanged duplicate
   handling. Exercise label verification with the other scanner where applicable.
3. Unplug the stationary scanner. Confirm partial availability and continue scanning
   with the handheld without navigating or pressing a connection button.
4. Reconnect the stationary scanner on its saved COM port. Confirm automatic
   recovery and acceptance of its next complete scan. Repeat for the handheld.
5. Start Station with one configured scanner absent or its port occupied by a test
   diagnostic tool. Confirm the other works. Release the port/attach the scanner
   and confirm automatic recovery without restarting Station.
6. Restart Station with both attached; confirm both resume from the saved settings.
7. Remove one scanner in setup and save. Confirm scans from it stop while the other
   continues. Reopen setup and confirm the saved list.
8. If practical, disconnect during transmission of a long code. Confirm its partial
   frame never becomes part of the next code after reconnection.
9. Verify the real printer still works while both configured scanner ports are open.

Physical acceptance: **NOT RUN** until this checklist is exercised on the target
Windows station and actual scanner pair.
