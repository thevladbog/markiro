# Standalone agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for
`apps/standalone`, the cloud-less product described in
[the design](../../docs/superpowers/specs/2026-09-26-standalone-station-design.md)
and [stage 1](../../docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md).

## Layout

- `host/` — `markiro-host`, the LAN service: HTTPS on port 45710 and the
  master SQLite; migrations in `host/migrations`.
- `src-tauri/` — the station and office shell; the local SQLite and every
  network call to the host live here.
- `proto/` — wire types (serde) and JSON fixtures; `src/host/protocol.ts`
  mirrors them with Zod.
- `src/` — the React webview.

## Single site, no tenants

One installation serves one site. Schemas have no `tenant_id`, so the root
rule about composite tenant keys does not apply here; isolation is the
separate installation.

## Three identities

Office users (login and password, a session bound to a device), operators
(PIN and badge, verified on the device) and devices (a per-device key) never
grant each other's rights. A device key alone never opens office routes.

## Local pairing trust

`POST /v1/local-pair` and `POST /v1/bootstrap` accept only loopback peers, and
loopback is their only gate: any process on the host PC can pair a device.
That is acceptable because the host PC is the site's trusted machine; the
app pins the certificate it observed over loopback. Devices on the network
pair only with a one-time code (plan 1c).

## Audit

Every office change, login outcome, pairing and initialization writes one
`audit_log` row. Tests assert the exact actor, action, target, result and
details; details never hold secrets, salts or hashes.

## Databases

DDL lives only in `host/migrations` and `src-tauri/migrations`. An applied
migration is never edited — add a new one; sqlx verifies checksums at start.

## Writes

- Every multi-statement write uses `db::begin_write` (`BEGIN IMMEDIATE`), not a
  deferred `pool.begin()`: a deferred transaction that reads then writes can
  hit `SQLITE_BUSY` on a stale WAL snapshot before `busy_timeout` gets a
  chance to help.
- One `next_revision` per changing transaction, stamped on every row that
  transaction changes.
- Never touch `state.pool` while a write transaction is open. Read through
  the transaction (`&mut *tx`) instead of acquiring a second pooled
  connection: the pool has only 4 connections, and a second acquire can wait
  behind another writer's `busy_timeout` instead of returning at once.
- Hash passwords (PBKDF2) before `begin_write`, off the async runtime
  (`spawn_blocking`); never hold the write lock across that work.
- Return no-ops before `next_revision`: no revision bump, no row write, no
  audit row for a request that changes nothing.
- Admin writes re-check rights with `OfficeContext::require_admin_in` inside
  the transaction, in addition to the early `require_admin` rejection. The
  extractor's role and active flag are read before the request hashes a
  password; re-checking inside the transaction stops a write a demotion or
  deactivation ended in that window.

## Protocol

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; the Rust tests parse every fixture, and the Vitest suite
parses every fixture whose shape crosses the IPC boundary. Raise
`PROTOCOL_VERSION` for an incompatible change; the host keeps accepting the
previous version. Response types, which devices of different versions read,
tolerate unknown fields; request types, which the host parses, reject them
with `deny_unknown_fields`. The `product`, `protocol` and `minProtocol`
fields of `hello` never change shape: read `HelloEnvelope` first and decide
compatibility (`host_too_old`, `app_too_old`) before parsing the rest.

## Network and TLS

The webview never performs HTTP. Rust calls the host with the aws-lc-rs
provider selected explicitly. Authenticated calls (from plan 1c) verify the
pinned certificate fingerprint (`markiro_proto::certificate_fingerprint`);
today only `host_probe` exists, and it observes a fingerprint without
trusting it. `host_probe` accepts any certificate and exists only to
discover a host before a person or a pairing code confirms the fingerprint.

## Marking rules

GS1, KM, SSCC and label rules stay in `@markiro/domain`; the host stores and
arbitrates but does not reimplement them.

## Logs

Never log device keys, session tokens, pairing codes, passwords, PINs, any
hash or the TLS private key.

## Verification

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` —
  the workspace is rustfmt-clean and CI enforces it.
- `cargo test --manifest-path apps/standalone/Cargo.toml --workspace`. The
  Tauri crate needs `apps/standalone/dist`: build the webview first with
  `pnpm turbo run build --filter='@markiro/standalone...'`.
- `pnpm --filter @markiro/standalone test`, `typecheck`, `lint`, `build`.
- The Windows service (and later DPAPI and kiosk mode) is only compiled by
  the `standalone-windows-build` job; running it needs a manual check on
  Windows; a host run on macOS proves none of it.
