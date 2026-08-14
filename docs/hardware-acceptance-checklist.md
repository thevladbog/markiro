# Hardware Acceptance Checklist

Executed once, on real hardware, when the MVP is assembled. Every item here
was deliberately deferred because CI cannot prove it. Record the outcome
beside each item.

## Label output (plans 04, 05b-2, 06c)

- [ ] ZPL `^BX` DataMatrix with GS1 FNC1 prints and scans back on a real Zebra.
- [ ] TSPL `DMATRIX` GS1/FNC1 behaviour — currently unverified; raw GS passthrough is pinned.
- [ ] TSPL `DMATRIX` cell-size form: `w`/`h` are a symbol area, not a module size.
- [ ] Cyrillic raster output matches the admin editor's preview byte-for-byte.
- [ ] TSPL binary payload survives serial and TCP transport (base64 → Rust → printer).
- [ ] **GS1-128 SSCC on a real printer.** Print a box label and scan it. The
      scanner must report `(00)` followed by 18 digits — not 20 bare digits
      and not a literal `>8` / `!1` in the barcode. Verify on both a Zebra
      (ZPL) and a TSC (TSPL) printer: the FNC1 escape differs per language
      and neither is provable from emitted text alone.
- [ ] **Print verification round-trip (opt-in, 06c).** With print
      verification enabled for the workstation, close a box: `PrintVerification`
      takes over the scanner. Scanning the box's own freshly-printed label
      advances immediately; scanning a different (foreign) SSCC or the same
      label a second time after a reprint shows the mismatch message and
      Reprint remains available; scanning a non-SSCC payload shows the
      "not an SSCC" message. Skip always works, including with the scanner
      disconnected — confirm neither button is ever disabled or hidden.

## Station storage (plans 05a, 05b-1, 05b-2)

- [ ] `tauri-plugin-sql` accepts `?` positional placeholders on device.
- [ ] Multi-statement `BEGIN`/`COMMIT` over `tauri-plugin-sql`'s connection
      pool is NOT atomic — each `exec.run` call can land on a different
      pooled connection (sqlx `Pool::connect`, up to 10, FIFO idle queue), so
      a `COMMIT` can fail with "no transaction is active" under real
      overlapping DB work. The scan journal (`journal.ts`'s `recordScan`) no
      longer relies on a transaction at all: it writes the code row first and
      treats a `codes_mirror.code_hash` PRIMARY KEY violation as the
      duplicate verdict. `upsertBundle` (`mirror.ts`) and `syncOperatorRoster`
      (`roster-sync.ts`) still write their statements individually with no
      transaction; confirm on real hardware that the partial-update window
      this leaves (a failure between the operator upserts and the trailing
      delete can leave a stale operator row until the next successful sync)
      is acceptable, or close it properly in the next slice.
- [ ] A `codes_mirror` primary-key violation surfaced through
      `tauri-plugin-sql` on device contains the "UNIQUE constraint failed"
      wording that `journal.ts`'s `isUniqueConstraintError` matches on (the
      "PRIMARY KEY" phrasing is also accepted). Duplicate detection now
      hinges on recognising this exact error text — if the on-device driver
      phrases the conflict differently, duplicates would surface as hard
      write errors instead of the `duplicate` verdict.

## Station lifecycle (plan 05a)

- [ ] Updater endpoint reachable; the `{{target}}` placeholder allowlist works.
- [ ] Kiosk lockdown is actually invoked and cannot trap an operator.

## Station touch workplace (fullscreen touch UI)

Record the Windows version, station build/commit, display model and native
resolution, touch controller, scanner and printer models, and whether gloves
were used. A host browser or macOS Tauri run does not satisfy these checks.

### Manual station beta update

- [ ] Before the workflow, the applied production runtime secret has the exact
      `STATION_ORIGIN=http://tauri.localhost` value. Record the deployment
      version/reference only; do not copy or record the secret payload. The
      Windows Station origin is not `tauri://localhost`.
- [ ] After that deployment and before the beta workflow, run
      `pnpm verify:station-production-cors` against production and record a
      PASS. The live preflight must prove the exact Windows `Origin` and Station
      capability header for every Station route at
      `https://admin.markiro.app` (pairing, roster, shifts and their open/bundle
      actions, product lookup, and GTIN check); CI or a browser run is not a
      substitute.
- [ ] Only after the preceding preflight passes, run `Publish station beta` from
      `main` for the approved commit SHA. Record the workflow URL and result;
      the build must not be treated as Windows acceptance.
- [ ] Download the immutable Windows installer manually and compare its version
      and SHA-256 with `SHA256SUMS`; verify the updater bundle signature against
      `latest.json`, its immutable release URL, and the recorded commit digest
      separately.
- [ ] Install beta.1 from the immutable NSIS `*.exe` produced by the workflow
      step `Build signed Windows NSIS updater artifacts`, pin its taskbar
      shortcut, then update through Station to beta.2 produced by the same step
      while no shift is active. Confirm installation is blocked during an active
      shift and pending outbox data is retained.
- [ ] Record any SmartScreen prompt and operator decision in the beta acceptance
      table; CI cannot replace this Windows/hardware check.
- [ ] After the beta.1 → beta.2 restart, the desktop shortcut, Start menu,
      previously pinned taskbar shortcut and application window all show the
      branded Markiro Station icon. The beta.1/old white-circle icon is absent
      from every shipped icon surface. Record both versions, Windows build,
      `Publish station beta` workflow URL and screenshots.
- [ ] Pair the packaged Windows Tauri WebView with a real, currently valid code
      issued by `admin.markiro.app`; record only the outcome and release/station
      identity, never the pairing code. Confirm waiting, redeeming, error and
      success/recovery states remain actionable.
- [ ] Enter the pairing/login flow with the touch keypad, a physical keyboard,
      and the production scanner (including keyboard-wedge input when used).
      Each method must reach the intended field/action without a mouse-only
      dependency or unintended duplicate entry.
- [ ] At 1280×800, confirm the packaged app has no document/nested scroll or
      clipped primary action in pairing, login and the active-shift console;
      record 1024×768 and 1280×1024 observations where the target display
      supports them.
- [ ] From the live console, exit fullscreen with no active shift and re-enter
      it. With an active shift, confirm the exit warning requires an explicit
      confirmation; cancel, confirmed exit, and re-entry must preserve the
      shift state and pending outbox/queues.

- [ ] On the target Windows station, production startup enters fullscreen and
      blocks ordinary close/minimize/resize paths. The hidden service workflow
      can leave lockdown, and Done/Back reliably re-enters it.
- [ ] At native 1280×800 and 1024×768, and secondarily at 1280×1024, every
      pairing, login, shift, work, correction, conflict, setup, offline, and
      print-verification state has no document or nested scroll region and no
      clipped primary action.
- [ ] Every floor action remains at least 64×64 px and readable with a gloved
      finger. Keypad keys remain 80–96 px. Disabled controls do not move when
      pressed; enabled controls show pressed feedback.
- [ ] Keyboard-only traversal has a visible focus indicator on representative
      pairing, login, pager, work, correction, setup, and dialog controls. No
      required instruction or action appears only on hover.
- [ ] Russian and English long copy remains readable without obscuring the
      current scan, box state, recovery action, or footer.
- [ ] With work pending, physically remove the network, continue scanning, and
      restore it. The local journal survives, status changes are truthful, the
      queue drains idempotently, and conflicts remain a deliberate review
      screen rather than interrupting scan intake.
- [ ] Restart the packaged station while scans, box closures, exceptions, and
      print outcomes are pending. All durable facts recover and sync without
      duplication or loss.
- [ ] Test the touchscreen with the production gloves and cleaning/protective
      film used on the line. Confirm taps near adjacent actions do not select
      the wrong control and that repeated scanning does not leave focus on a
      destructive or exit action.

### Live roster and floor recovery (next Station beta)

These checks apply to the packaged Windows beta. Keep them unchecked until the
named environment and hardware have been exercised; host tests and a browser
gallery do not replace this record.

- [ ] Create an active Station operator while badge login is already open; scan the new badge without restarting.
- [ ] Disconnect the network; authenticate a previously cached operator without an HTTP request.
- [ ] Load, open, create, and rejoin a shift through `https://admin.markiro.app`.
- [ ] At 1280×800, 1024×768, and 1280×720, verify Update, Change operator, and window-mode controls do not overlap status or each other.
- [ ] During an active shift, queue a scan, change operator, and verify the same shift resumes with correct old/new attribution.
- [ ] Exercise keyboard-wedge and configured serial scanner input on Windows/WebView2 hardware.
- [ ] Reveal and hide the Windows taskbar; verify the footer and all floor actions remain recoverable.

### Aggregation and box-label recovery (next Station beta)

Keep every item unchecked until it has been exercised in the packaged Windows
beta with the named scanner, printer, and display conditions. Automated tests
and the browser gallery do not satisfy these checks.

- [ ] In the cabinet, configure organisation default box-label template A. In
      the packaged Station, create an aggregation shift without choosing a
      template, close a box, and print it on the real printer. Confirm the
      physical label uses template A and contains the 18-digit SSCC allocated
      to that box; scan the label back and record the same SSCC.
- [ ] With organisation default A still configured, create a planned
      aggregation shift with explicit per-shift override B. Open it in the
      packaged Station, close a box, and confirm the physical label uses B,
      not A, with the SSCC allocated to that box.
- [ ] Clear the organisation default and create a validation shift without an
      override. Confirm the shift is created and opened without requiring or
      mirroring a box-label template. Restore the intended default before
      testing aggregation again.
- [ ] With a template configured as the organisation default, try to delete it
      from the cabinet. Confirm deletion is rejected with an actionable
      conflict, the default remains configured, and no template or shift
      binding is silently cleared.
- [ ] Use a separate legacy test tenant for the backfilled recovery case; do
      not reuse the preceding A/B tenant. Before migration, confirm this tenant
      has exactly one tenant-owned label template, no organisation default, and
      the previously affected active aggregation shift has a null template
      snapshot. Preserve that shift in persistent unresolved box-label recovery
      and record its box and 18-digit SSCC. After the database migration and API
      rollout, confirm the sole template became both the organisation default
      and the shift snapshot. Install the packaged beta, run
      `Повторить восстановление`, and print on the same real printer. Confirm
      recovery uses that template and retains the exact same box and SSCC
      without a second box close, SSCC allocation, journal entry, or outbox
      entry. Do not add or remove templates before migration: zero- or
      multiple-template tenants are intentionally not auto-backfilled.
- [ ] For the same backfilled active-shift case, disconnect the network before
      `Повторить восстановление`. Confirm recovery remains blocked with an
      honest offline error and preserves the same box, SSCC, journal, outbox,
      and print state. Restore connectivity, retry, and resolve the original
      label without a second close or allocation.
- [ ] Start a fresh issuer prefix and confirm the first printed box uses serial `0000001` plus a valid final check digit.
- [ ] Scan production-like EAN-13 and KM DataMatrix; verify GTIN, serial, and AI 91/92/93 presentation.
- [ ] Fill a 20-place box and confirm each cell, auto-close, and reset after print resolution.
- [ ] Disconnect the printer during close; confirm the exact persistent category survives restart.
- [ ] On packaged Windows, from persistent unresolved box-label recovery choose `Configure printer / Настроить принтер`; while setup is open and after returning, confirm the same unresolved box and 18-digit SSCC remain, product scans and ordinary controls stay sealed, then resolve through retry and scan-back verification when enabled without a second close or serial allocation.
- [ ] Retry after restoring the printer and confirm the same 18-digit SSCC prints once.
- [ ] Repeat the failure and explicitly continue without a label; confirm the skip is synchronized and the next box accepts scans.
- [ ] Enable scan-back verification and scan GS1-128 `(00)` plus the expected SSCC.
- [ ] Repeat at packaged Windows 1280×800 and 1024×768 with the taskbar hidden in lockdown.

## Scanner and printer (plans 05b-2, 05b-3)

- [ ] Serial scanner: real device, baud negotiation, payload terminators.
- [ ] Keyboard-wedge fallback works with a HID scanner and no setup.
- [ ] Scanner AIM symbology identifier / prefix-suffix configuration: verify
      both a bare GS1 payload and the standard `]d2` prefix. The parser accepts
      `]d2` and canonical storage removes it; any other configured prefix must
      be rejected rather than guessed away.
- [ ] Connect the scanner, then in Setup type a nonexistent or wrong port
      and press Connect: the status bar drops to "No signal", an error is
      shown, and the scanner stops delivering scans (closing the previous
      session before the open is attempted is what produces this, not a
      crash — the close-before-open trade this slice makes).
- [ ] Recover from that without restarting the app: select the correct
      port and press Connect, or just press Done — either reopens the
      session and the bar returns to green.
- [ ] Leave Setup via Done or Back with the scanner configuration
      unchanged: the session still closes and reopens (the `sessionEpoch`
      reconcile), so a session left in a bad state by Setup's own Connect
      button never survives leaving the screen.
- [ ] Connect on one port, then connect on a different port: the first session
      stops and only the second delivers scans.
- [ ] Rapidly reconnect to a different port several times in a row while the
      scanner is actively delivering scans (connect A, immediately connect B,
      immediately connect A again, ...): the status bar settles on
      "connected" and stays there — it must never end up stuck on "no
      signal" from a retiring session's disconnect landing after its
      successor's connect (the generation-and-status lock in `scanner.rs`
      is what this proves).
- [ ] Unplug the scanner mid-shift: the status bar flips to "no signal".
- [ ] Close and immediately reopen the same port (the setup screen's
      close-before-open): the reopen succeeds without restarting the app.
- [ ] Printer over TCP 9100 and over serial; test print from the setup screen.
- [ ] USB/spooler printing — out of the 05b-2 transport scope; decide whether it is needed.
- [ ] A ZPL template prints correctly on a TSPL printer and vice versa (the
      configured language wins): `renderLabelBytes` picks the emitter from
      `hardware_config.printerLanguage`, not the template's own `language`
      field, so this is what actually needs proving on real printers.
- [ ] The setup screen's test print produces the same output as a real
      label print: today `WorkstationSetup` is the only call site for
      `renderLabelBytes`/`hw.print`, so confirm any later per-shift printing
      renders through the same path rather than a divergent one.
