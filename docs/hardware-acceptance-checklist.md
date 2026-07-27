# Hardware Acceptance Checklist

Executed once, on real hardware, when the MVP is assembled. Every item here
was deliberately deferred because CI cannot prove it. Record the outcome
beside each item.

## Label output (plans 04, 05b-2)

- [ ] ZPL `^BX` DataMatrix with GS1 FNC1 prints and scans back on a real Zebra.
- [ ] TSPL `DMATRIX` GS1/FNC1 behaviour — currently unverified; raw GS passthrough is pinned.
- [ ] TSPL `DMATRIX` cell-size form: `w`/`h` are a symbol area, not a module size.
- [ ] Cyrillic raster output matches the admin editor's preview byte-for-byte.
- [ ] TSPL binary payload survives serial and TCP transport (base64 → Rust → printer).

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

## Scanner and printer (plan 05b-2)

- [ ] Serial scanner: real device, baud negotiation, payload terminators.
- [ ] Keyboard-wedge fallback works with a HID scanner and no setup.
- [ ] Scanner AIM symbology identifier / prefix-suffix configuration: some
      scanners emit an AIM prefix (e.g. `]d2` for a GS1 DataMatrix) before
      every scanned string by default. If nobody disables that in the
      scanner's own configuration (or strips it in code), every scan fails
      `classifyScan` as invalid — this can burn an hour on the floor before
      anyone thinks to check it. Confirm the scanner is configured to send
      the bare payload, or that prefix stripping is handled.
- [ ] Connect the scanner, then press Connect again on the same port: the
      working scanner keeps running and an error is shown (it is not silently
      killed).
- [ ] Connect on one port, then connect on a different port: the first session
      stops and only the second delivers scans.
- [ ] Unplug the scanner mid-shift: the status bar flips to "no signal".
- [ ] Close and immediately reopen the same port (the setup screen's
      close-before-open): the reopen succeeds without restarting the app.
- [ ] Printer over TCP 9100 and over serial; test print from the setup screen.
- [ ] USB/spooler printing — out of the 05b-2 transport scope; decide whether it is needed.
