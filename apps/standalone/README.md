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

## Tests

- Rust: `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`
  (build the webview first — the Tauri crate embeds `dist/`).
- Webview: `pnpm --filter @markiro/standalone test`.
