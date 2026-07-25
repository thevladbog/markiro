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
   the config, and routes to operator sign-in (`OperatorLogin`) — not
   directly to shift selection, since an operator still has to authenticate
   locally by PIN/badge first.

## Operator credential hash contract

`operators_mirror` stores PIN/badge verifiers as a PHC-like string:
`pbkdf2$sha256$<iterations>$<saltBase64>$<hashBase64>`, computed by
`apps/station/src/lib/crypto.ts` with WebCrypto `SubtleCrypto`
PBKDF2-SHA256. The format string alone underspecifies interop — the
server-side hasher (`apps/api/src/lib/pin-hash.ts`, which mints these hashes
for `operator_credentials`) MUST also match these pinned constraints:

- **Derived key length is EXACTLY 32 bytes** (`dkLen=32` / 256-bit).
- **Base64 is STANDARD, WITH padding** (`btoa`/`atob`, RFC 4648 §4) — **NOT**
  the PHC-spec unpadded B64 (RFC 4648 §5). A stock PHC encoder/decoder will
  break interop here.
- **Salt is 16 bytes.**
- **Iterations ≥ 100000 for newly minted hashes** (the station's own
  `hashSecret` always mints at 100000; older/foreign hashes with a lower
  count still verify, but nothing new should be minted below that floor —
  `verifySecret` also rejects any hash below a 10000-iteration floor
  outright, so anything under that is simply invalid).

`apps/station/test/crypto.test.ts`'s known-vector test (cross-checked
byte-for-byte against Node's `pbkdf2Sync`) is the **executable spec**: the
server's hasher must reproduce that exact vector, not just satisfy the prose
above.

## Operator roster

During initialization — right after enrollment, and again on every later
app start while online — the station pulls `GET /station/operators` (device
api-key, callable before any operator has signed in) into `operators_mirror`;
see "Operator credential hash contract" above for the verifier format stored
there. The same roster, produced by the same server-side service method,
also rides along with every `GET /shifts/:id/bundle` download, so opening a
shift refreshes the mirror too. Sign-in is by personnel number + PIN, or a
badge scan, checked locally against whatever is currently in the mirror. An
operator hired, or newly granted station access, while the device is offline
cannot sign in until the next successful roster sync — a successful sync
replaces the whole mirror, so a revoked or deactivated operator likewise
stops authenticating offline as soon as the device reconnects.

## Tests

```bash
pnpm --filter @markiro/station test    # vitest (jsdom); uses node:sqlite
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```
