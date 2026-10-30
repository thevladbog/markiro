# @markiro/standalone

Cloud-less Markiro («Markiro Автоном»): the `markiro-host` LAN service with
the master database plus the station and office desktop app. Design:
`docs/superpowers/specs/2026-09-26-standalone-station-design.md`; rules for
changes: [AGENTS.md](AGENTS.md).

## Development

1. Start the host (development data stays in `apps/standalone/.markiro-host`):

   `cargo run --manifest-path apps/standalone/Cargo.toml -p markiro-host -- run --data-dir apps/standalone/.markiro-host`

   The log shows the port (45710) and the certificate fingerprint;
   `print-fingerprint --data-dir apps/standalone/.markiro-host` prints it again.

2. Start the app: `pnpm --filter @markiro/standalone tauri dev`. It looks for
   the host at `https://127.0.0.1:45710`. On a fresh host it opens the
   first-run wizard (administrator, organization, SSCC starts, lines); on an
   initialized host it pairs this computer by itself and shows the floor,
   where «Офис» leads to the office sign-in. The pairing is kept in
   `device.json` in the app's local data directory
   (`%LOCALAPPDATA%\app.markiro.standalone` on Windows,
   `~/Library/Application Support/app.markiro.standalone` on macOS); delete
   it to pair again.

   In the office an administrator edits the organization profile, the SSCC
   counters and block sizes, and the office users; a technologist sees the
   organization and SSCC read-only. «Выйти в цех» ends the office session.

## Create a pallet in the office

Open **Поиск кодов → Палеты → Новый палет**. Enter one box SSCC per line or
load a UTF-8 TXT/CSV file with one column and no header (up to 1 MiB and
1000 boxes). Check the list and correct every reported error before creation.
Boxes must be closed, intact, of one product and free of another live pallet;
they may come from different shifts. Demo boxes cannot form a production pallet.

Creation issues a new SSCC and opens the warehouse pallet card with its member
boxes, contents sheet, A4/A5 placard, GIS MT aggregation XML and disaggregation.
The card keeps the generated files. If the host response is lost, use
**Повторить создание** with the same composition to recover the original result.

## Tests

- Rust: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
  (build the webview first — the Tauri crate embeds `dist/`).
- Webview: `pnpm --filter @markiro/standalone test`.
