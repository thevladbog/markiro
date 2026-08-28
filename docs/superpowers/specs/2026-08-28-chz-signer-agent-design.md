# Chestny ZNAK Signer Agent — Design Spec

**Date:** 2026-08-28

**Status:** Proposed for implementation

**Scope:** A Windows tray application that lives on the customer machine where the UKEP
(qualified electronic signature) is installed, periodically re-authenticates against
True API GIS MT on behalf of the tenant, and delivers the resulting short-lived Bearer
token to the Markiro cloud through a task-queue protocol.

## Background and motivation

True API GIS MT is the only Chestny ZNAK API that covers both inventory needs: ordering
CSV exports of marking codes filtered by status (`dispenser/tasks` with
`FILTERED_CIS_REPORT`) and polling current statuses of specific codes
(`POST /cises/info`, up to 1000 codes per request). All read methods require only an
`Authorization: Bearer` token. UKEP is required in exactly one place for reads: obtaining
the token. The flow is `GET /auth/key` → sign the returned `data` challenge with an
attached CAdES-BES (GOST) signature → `POST /auth/simpleSignIn` → token valid for at most
10 hours, not renewable — the whole flow repeats each time.

The private key must never leave the customer's machine, and customers install UKEP in
different places: sometimes on the computer that already runs the Markiro Station,
sometimes on a separate accountant/director machine with no Markiro software at all.
Hence a standalone signer agent that works anywhere, with a core that the Station can
embed later.

Reference API facts (True API v721.0, 26.08.2026):

- Auth: `GET /auth/key` returns `{uuid, data}`; the client signs `data` with an
  **attached** CAdES-BES signature (base64, GOST); `POST /auth/simpleSignIn` accepts
  `{uuid, data, inn?}` and returns a JWT token. `inn` is mandatory when the signer acts
  under an MChD (machine-readable power of attorney) for an organization.
- Token lifetime: at most 10 hours; a revoked MChD invalidates the token immediately.
- JWT tokens are supported until the end of 2026 (operator announcements to be tracked).
- Global limit: 50 requests/second per participant.
- Document submission (future) requires a **detached** CAdES signature per document.

## Outcome

A tenant pairs one signer agent with their Markiro workspace using a short-lived pairing
code. From then on the cloud schedules a `true_api_auth` task roughly every 8.5 hours;
the agent claims it, performs the full True API authentication flow locally (challenge
signing included), and returns a fresh Bearer token. The cloud stores the token per
tenant and uses it for all True API reads (status refresh jobs, dispenser exports —
designed separately). The private key never leaves the customer machine; the cloud only
ever holds 10-hour tokens.

The task protocol is deliberately generic: `true_api_auth` is the only task type
implemented now, but the envelope supports future types (detached document signing for
GIS MT submissions) without protocol changes.

## Components

### `apps/signer` — Tauri 2 tray application (Windows-only)

Same stack and build infrastructure as the Station: Tauri 2 (Rust backend, small React
frontend on `@markiro/ui`), auto-update via `@tauri-apps/plugin-updater`, autostart on
user login. Runs as a tray icon; clicking it opens a compact window with:

- pairing screen (enter pairing code, shows tenant/organization name after pairing);
- certificate picker: enumerates the `MY` certificate store, filters GOST certificates
  with a private key, persists the chosen thumbprint;
- status panel: last token obtained at / expires at, last task outcome, connectivity;
- local operation journal (rolling file mirrored in the UI);
- tray notifications for actionable failures ("insert the Rutoken", "certificate
  expires in 14 days", "PIN required").

### `signer-core` — Rust crate

Separated from the Tauri shell so the Station can embed it later. Responsibilities:

- task-queue protocol client (pairing, long-poll, claim/complete/fail, backoff);
- True API authentication flow (`auth/key` → sign → `simpleSignIn`);
- CAdES signing behind a trait. The Windows implementation drives CryptoPro via the
  CAdESCOM COM interface (requires CryptoPro CSP and the CryptoPro CAdES SDK/plug-in
  installed on the machine — documented as an install prerequisite). Attached CAdES-BES
  for the token challenge; detached mode reserved for the future document task type.
- secret storage behind a trait; Windows implementation uses DPAPI (per-user scope).

### `apps/api` — new `signer-agents` module

- pairing endpoints and agent authentication guard (agentId + secret), rate-limited
  following the existing kiosk pairing pattern;
- task queue endpoints (long-poll next, complete, fail);
- per-tenant True API token storage;
- pg-boss cron that schedules token refresh and detects degradation;
- audit through the existing `integration_sessions` / `integration_events` journal.

### Admin UI

A new card in the existing Integrations section (same pattern as the 1C CommerceML
integration): generate a pairing code, list agents (hostname, version, last seen,
certificate subject/expiry), current token status, journal, revoke button.

## Data model (Postgres)

- `chz_signer_agents` — id, tenantId, hostname/name, appVersion, selected certificate
  info (thumbprint, subject, INN, notAfter), status (`active` | `revoked`), lastSeenAt,
  createdAt.
- `chz_signer_pairing_codes` — code (short-lived, single-use), tenantId, expiresAt,
  usedAt, createdBy. Brute-force protection reuses the kiosk pairing attempt-window
  pattern.
- `chz_signer_tasks` — id, tenantId, agentId (set on claim), type (`true_api_auth`;
  later `sign_detached`), status (`pending` → `claimed` → `completed` | `failed` |
  `expired`), payload jsonb, result jsonb (token value redacted from the journal),
  attempts, error code/message, claimedAt, completedAt, createdAt.
- `chz_api_tokens` — one active row per tenant: token (encrypted at the application
  level with a key from env — the value is 10-hour bearer access to the tenant's
  Chestny ZNAK data), tokenType (`jwt`), obtainedAt, expiresAt, agentId,
  certThumbprint.

Tenant-level integration settings (stored with the integration record): True API base
URL (sandbox / production), optional `inn` for MChD-based authorization.

## Protocol (agent ↔ cloud)

All connections are initiated by the agent over HTTPS — works behind NAT, no inbound
ports.

1. **Pairing.** `POST /signer-agents/pair` `{pairingCode, hostname, appVersion}` →
   `{agentId, agentSecret, tenantName}`. The secret is stored via DPAPI and never shown
   again.
2. **Polling.** `GET /signer-agents/tasks/next` — long-poll (~25 s server hold). Serves
   as the heartbeat (updates lastSeenAt, records appVersion). Returns a task or 204.
   Returning a task atomically claims it for this agent (`pending` → `claimed`).
3. **Executing `true_api_auth`.** Payload: `{trueApiBaseUrl, inn?}`. The agent performs
   the complete flow locally: `GET {base}/auth/key` → attached CAdES-BES over `data`
   with the selected certificate → `POST {base}/auth/simpleSignIn` (`inn` included when
   provided) → returns `{token, expiresAt, certThumbprint}` to the cloud. The challenge
   never travels through the cloud and cannot expire in transit.
4. **Completion.** `POST /signer-agents/tasks/:id/complete` with the result, or
   `POST /signer-agents/tasks/:id/fail` with a structured error code.

Protocol contracts live as zod schemas in `packages/platform-contracts`; the Rust side
mirrors them with serde types. A contract test keeps the two in sync via shared JSON
fixtures.

## Scheduling and degradation

- A pg-boss cron (every 15 minutes) checks tenants with the signer integration enabled:
  if the active token expires within 90 minutes and no pending/claimed `true_api_auth`
  task exists, enqueue one. Net effect: refresh roughly every 8.5 hours with margin.
- A pending task unclaimed for 30 minutes becomes `expired`; a replacement is enqueued.
  Repeated failures or an expired token mark the integration degraded: badge in the
  admin UI, `integration_events` record, optional email alert through the existing
  email outbox.
- Revoking an agent invalidates its secret; the agent receives 401 on the next poll,
  wipes local state, and returns to the pairing screen. The tenant's stored tokens are
  purged on revoke.

## Error handling

Agent-side error classes, each with a structured code reported to the cloud:

- **Crypto:** certificate expired/not found, container or hardware token absent, PIN
  required, CryptoPro not installed. Tray notification + surfaced in the admin journal.
  For unattended operation the customer documentation recommends a container with a
  saved PIN; interactive PIN prompts are supported but pause automation until resolved.
- **Network:** local retries with exponential backoff; the task stays claimed until its
  server-side timeout, after which the cloud re-enqueues.
- **True API:** errors are passed through verbatim (e.g. 403 "no active contract for
  the product group") so the admin sees the real cause.

The agent keeps a local rolling journal file; the cloud keeps the authoritative audit in
`integration_sessions` / `integration_events` (pairing, task lifecycle, token refresh,
degradation transitions). Token values never appear in journals.

## Security

- The private key never leaves the customer machine; the agent transmits only CAdES
  signatures and resulting tokens.
- `agentSecret` is stored via DPAPI; agent config lives under `%APPDATA%\Markiro Signer`.
- The cloud stores only short-lived (≤10 h) tokens, encrypted at rest; access to them is
  tenant-scoped.
- The pairing code is short-lived, single-use, and rate-limited.
- The tray UI always shows which tenant/organization the agent is paired to.

## Testing

- `signer-core`: unit tests with the signing trait mocked and an HTTP mock for the
  protocol and True API flow (challenge → simpleSignIn), including error mapping.
  The real CAdESCOM path is exercised manually on a Windows VM with a CryptoPro test
  certificate against the True API sandbox (`markirovka.sandbox.crptech.ru`).
- `apps/api`: e2e lifecycle tests (pair → poll → claim → complete/fail → token stored)
  on the existing NestJS test infrastructure; unit tests for the cron decision logic
  (when to enqueue, when to mark degraded) and for token encryption round-trip.
- Contract fixtures shared between zod and serde as described above.

## Out of scope

- Consuming the token: status refresh jobs (`cises/info`), dispenser export ordering
  (`FILTERED_CIS_REPORT`), and their storage model are a separate design.
- Detached document signing (`sign_detached` task type) — envelope reserved, not
  implemented.
- macOS / Linux support.
- Embedding `signer-core` into the Station.
- Multiple certificates or multiple organizations per agent (one agent = one tenant =
  one selected certificate in v1).
