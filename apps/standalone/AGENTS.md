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

## Databases

DDL lives only in `host/migrations` and `src-tauri/migrations`. An applied
migration is never edited — add a new one; sqlx verifies checksums at start.

## Protocol

Changing a wire shape means changing `proto`, the Zod schemas and the
fixtures together; both test suites parse every fixture. Raise
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
