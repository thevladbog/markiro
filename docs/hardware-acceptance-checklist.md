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

## Station storage (plans 05a, 05b-1)

- [ ] `tauri-plugin-sql` accepts `?` positional placeholders on device.
- [ ] Mirror transactions behave correctly under real scan load (BEGIN/COMMIT over the connection pool).

## Station lifecycle (plan 05a)

- [ ] Updater endpoint reachable; the `{{target}}` placeholder allowlist works.
- [ ] Kiosk lockdown is actually invoked and cannot trap an operator.

## Scanner and printer (plan 05b-2)

- [ ] Serial scanner: real device, baud negotiation, payload terminators.
- [ ] Keyboard-wedge fallback works with a HID scanner and no setup.
- [ ] Printer over TCP 9100 and over serial; test print from the setup screen.
- [ ] USB/spooler printing — out of the 05b-2 transport scope; decide whether it is needed.
