# @markiro/station

Markiro line station — a Tauri 2.11 + React 19 floor-mode app. Reuses
`@markiro/ui` (dark floor theme) and `@markiro/domain` (GTIN normalization).

## Offline model

The station is offline-first. At enrollment it stores a device api-key + server
URL in a `0600` `station.json` (OS app-config dir). A shift is downloaded in
full via `GET /shifts/:id/bundle` into a local SQLite mirror
(`tauri-plugin-sql`, schema from `@markiro/db` `STATION_MIGRATIONS`). Operators
sign in **offline** by PIN/badge, verified locally against `operators_mirror`
(PBKDF2 PHC verifiers) — a PIN is never sent to the server.

## Dev run (macOS)

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # API + Postgres for enrollment
pnpm --filter @markiro/api dev                    # http://localhost:3000
pnpm --filter @markiro/station tauri dev          # launches the desktop webview
```

The Windows installer is produced in CI (see `.github/workflows/ci.yml`); a
`tauri build` is not required on macOS for development.

## Enrollment

1. In the admin panel, create a station device (`POST /station-devices`) and
   copy the one-time api-key.
2. Launch the station, enter the server URL + api-key on the enrollment screen.
3. The station probes `GET /shifts` (200 = the key resolves a tenant), persists
   the config, and routes to shift selection.

## Tests

```bash
pnpm --filter @markiro/station test    # vitest (jsdom); uses node:sqlite
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```
