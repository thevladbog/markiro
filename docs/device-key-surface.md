# What a station api-key may reach

A station device authenticates with an organization-owned api-key
(`x-api-key`). `TenantGuard` accepts it for tenant resolution. The next
authorization boundary must then classify the caller explicitly: station-only
routes use `StationOnlyGuard`, shared station/cabinet routes use
`AllowStationOrPermissions`, and cabinet-only routes use `RequirePermissions`
through `AuthorizationGuard`. A floor device is the most theft-exposed
credential in the system, so this list is deliberately explicit.

This document is the source of truth for the `TenantGuard`-guarded surface:
every such route in the API is expected to appear in one of the two tables
below. See "Rule for new routes" for how it stays that way as routes are
added.

## Provisioning and durable device lifecycle

Station and kiosk credentials share one server-side generation boundary, but
remain separate trust domains. Cabinet users create or retain a durable device
record and reveal an eight-digit, 15-minute pairing code once. Only the keyed
digest is stored; issuing another code retires the previous live code, and
successful redemption consumes it atomically. Responses that contain a code,
device token, or station key carry `Cache-Control: no-store`.

The unauthenticated redemption routes are deliberately narrow:
`POST /station/pair` provisions the pre-created station record and
`POST /kiosk/pair` provisions the active kiosk record. Both use the shared
persisted per-source/global attempt limiter. Re-pairing rotates the credential
on the same durable device ID; revoke/unbind clears the credential and live
codes without deleting the device or its production history.

A fresh station obtains its API base only from the trusted build-time
`VITE_STATION_API_URL`; it never derives a backend host from the webview URL.
After pairing, the durable station config retains that server URL for recovery.
Cross-origin station requests require the exact `STATION_ORIGIN`. CORS grants
it only to the unauthenticated `POST /station/pair` and `POST /station/pair/recovery`
and to the exact method/path pairs in the device table below, including
the shared `/shifts` and `/products` routes; it is not added to adjacent
cabinet-only methods, cabinet-session routes, or kiosk routes. Preflight is
classified by `Access-Control-Request-Method`, while path matching ignores a
query string and normalizes a trailing slash in the same way as the router.
The shipped Windows Tauri 2 webview origin is exactly
`http://tauri.localhost`; `tauri://localhost` is retained only for non-Windows
Tauri platforms and is not the deployed Windows value. Before a Windows
Station release, `pnpm verify:station-production-cors` must confirm that
`https://admin.markiro.app/station/pair` returns HTTP 204 and echoes the
Windows origin for the real pairing preflight.

An authenticated station `401` seals its current credential generation before
recovery is shown. The station keeps its machine/device IDs and every local
production fact (outbox, journal, boxes, exceptions, conflicts, SSCC ranges,
batch IDs and sync ceilings). It removes only the rejected credential and
reproducible operator/shift/product caches. Pairing the same device record then
rebuilds those caches and resumes the unchanged queue; network errors, timeouts,
`429`, and `5xx` do not enter this recovery path.

Stations enrolled before the durable `deviceId` field was added require a
one-time authenticated identity backfill. Roll out the API first: the station
calls `GET /station/identity` with its existing key, persists the server-resolved
device ID and display metadata through the atomic config writer, and only then
starts roster, shift, or sync requests. A timeout, network error, `429`, or `5xx`
leaves the key, config, and local facts untouched; cached offline sign-in remains
available and the station retries only on reconnect or an explicit operator
retry. A `401` at this pre-backfill boundary cannot safely enter ordinary
same-device re-pairing because the local queue has no proven durable owner. It
therefore stays in a service-recovery state without clearing the key or exposing
pairing; service must restore a valid same-device credential/identity path before
that legacy queue can be adopted.

## Reachable by a device key

| Route                                                                                                                | Why the station needs it                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /station/identity`                                                                                              | one-time migration of pre-`deviceId` configs; `TenantGuard` resolves the durable row solely from the presented station key and `StationOnlyGuard` rejects cabinet sessions; the request accepts no client device or tenant identifier                                                                                                                                                                                                      |
| `POST /station/heartbeat`                                                                                            | line presence, once a minute even when idle, and service enrollment's key check (`whoami()`). `TenantGuard` records the caller's own `lastSeenAt`; the handler does nothing else, takes no body and returns `204`, so cost stays flat as shift history grows. `StationOnlyGuard` rejects sessions; handhelds are accepted; recovery keys stay denied; no subscription gate, like `GET /station/identity`                                   |
| `GET /station/operators`                                                                                             | the offline sign-in roster (hashes only); `StationOnlyGuard` explicitly rejects a Better Auth session                                                                                                                                                                                                                                                                                                                                      |
| `GET /shifts`, `POST /shifts`, `GET /shifts/:id/bundle`, `GET /shifts/:id/reference-bundle`, `POST /shifts/:id/open` | shift selection, ad-hoc shift creation, the ordinary allocating offline bundle, and an allocation-free reference refresh used only after local print-recovery classification — `GET /shifts?status=active` remains the bounded presence and key-check fallback for an older API that predates `POST /station/heartbeat`; `AllowStationOrPermissions` keeps the station path while requiring the matching cabinet capability from a session |
| `POST /shifts/:id/enter`                                                                                             | rejoining an active shift from the list or its task form records this device as a participant, so a second station makes closing administrator-only; `StationOnlyGuard` rejects sessions. The rejoin stays offline-first: only a closed shift, a required update or a rejected credential stops it                                                                                                                                         |
| `POST /shifts/:id/sscc/top-up`                                                                                       | reconciles and tops up this device's box SSCC ranges ahead of need, for the Station and the handheld; `StationOnlyGuard` rejects sessions, and it stays available for shift subscription recovery                                                                                                                                                                                                                                          |
| `GET /shifts/box-label-templates`                                                                                    | the NewShift box-template picker: summaries only (id, name, size, dpi, language) plus the organisation default id; template `spec`s stay cabinet-only and reach the station exclusively through the shift bundle after the snapshot exists; `AllowStationOrPermissions` requires `operations.read` from a cabinet session                                                                                                                  |
| `GET /shifts/pallet-label-templates`                                                                                 | NewShift pallet-template picker: tenant/category-filtered summaries without specs, plus the resolved category/organisation default; cabinet sessions require `operations.read`.                                                                                                                                                                                                                                                            |
| `GET /shifts/product-label-templates?productId=UUID`                                                                 | Tenant- and product-category-scoped duplicate-label summaries (id, name, size, dpi), without specs or box defaults. Available to station credentials and cabinet sessions with `operations.read`; the product is required and must belong to the same tenant.                                                                                                                                                                              |
| `GET /shifts/planning-config`                                                                                        | Read the resolved box default, duplicate-print protocol availability and whether the organisation GLN is configured, for shift planning.                                                                                                                                                                                                                                                                                                   |
| `GET /products`, `POST /products/gtin-check`                                                                         | resolving a scanned GTIN when creating a shift; `AllowStationOrPermissions` keeps the station path while requiring `operations.read` from a cabinet session                                                                                                                                                                                                                                                                                |
| `POST /station/scans`                                                                                                | delivering scans is the device's entire purpose; `StationOnlyGuard` explicitly rejects browser sessions and requires `req.deviceId`, which is the authoritative terminal identity for the complete batch                                                                                                                                                                                                                                   |
| `POST /station/boxes/reconciliation`                                                                                 | Compares up to 200 closed boxes owned by this authenticated station with effective server membership and safely fills only a missing pallet link. The request contains identity, counts and a versioned digest, never raw marking codes; the response returns per-box status without another device's contents. Available for subscription recovery while durable local work remains pending.                                              |
| `GET /shifts/:id/code-history`                                                                                       | Paginated ownership and active/current reprocessing history for a validation shift this device has entered. Tenant/product scope derives from that shift. Pages share an immutable, device-bound snapshot for one hour; expired snapshots require restarting the page chain.                                                                                                                                                               |
| `POST /station/validation-occurrences/status`                                                                        | Reconciles up to 500 own occurrence identities in participated shifts, including acknowledged acceptances subsequently displaced. Returns no foreign device metadata.                                                                                                                                                                                                                                                                      |
| `POST /station/conflicts/status`                                                                                     | reconciles only hashes already present in this device's local conflict mirror; the response is tenant- and authenticated-device-scoped and identifies only manager-reviewed rows, so it exposes neither raw codes nor another terminal's conflicts                                                                                                                                                                                         |
| `POST /station/codes/releases`                                                                                       | incrementally returns tenant-scoped hashes whose exact ownership was released by undo, clear, or disassembly; the station persists the box-registry revision and deletes only matching local duplicate keys, while raw marking codes never cross this read boundary                                                                                                                                                                        |
| `GET /station/device-replacement-intent/v1`                                                                          | reads this device's replacement drain intent or explicit source closure tombstone (optional `knownIntentId`); `StationOnlyGuard`, available for replacement-readiness subscription recovery                                                                                                                                                                                                                                                |
| `POST /station/device-replacement-intent/v1/acknowledge`                                                             | acknowledges an exact replacement closure from the authenticated source device, so its local drain can end                                                                                                                                                                                                                                                                                                                                 |
| `POST /station/device-replacement-readiness`                                                                         | reports bounded replacement readiness evidence for the authenticated device; `StationOnlyGuard`                                                                                                                                                                                                                                                                                                                                            |
| `POST /station/replacement-recovery/readiness`                                                                       | the purpose-bound replacement evidence recovery report; `AllowReplacementEvidenceRecovery` admits the recovery credential, and a fresh zero report revokes it                                                                                                                                                                                                                                                                              |
| `POST /station/grants/v1/readiness`                                                                                  | reports the durable offline-grant installation of the authenticated device; `StationOnlyGuard`, allowed with a read-only subscription                                                                                                                                                                                                                                                                                                      |

## Cabinet-only (`RequirePermissions`; bootstrap `RequireMembership`)

| Module / route                                                                                                             | Why a device must not reach it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /access/me`                                                                                                           | the admin UI's membership-only bootstrap; `RequireMembership` reloads a Better Auth organization membership and explicitly rejects a station key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /devices`                                                                                                             | unified cabinet inventory of stations and kiosks; a floor key must not enumerate peer device names, places, lifecycle, or activity. The MVP sorts actionable status as awaiting pairing, offline, revoked, then online; each group is name/type/id ascending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `station-devices`                                                                                                          | a stolen device could enrol or revoke other devices                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /conflicts`, `POST /conflicts/:id/review`                                                                             | the manager's backstop for scans a station never learns it lost (see Task 06b-7) — a station has no business reading, let alone reviewing, another terminal's conflicts; pinned by a 403 e2e test for both routes (`apps/api/test/conflicts.e2e.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /boxes`                                                                                                               | the per-shift box list, including `contentsChangedAfterClose` (Task 14) — a manager-only signal that a closed, taped-and-labelled box a station cannot correct is short an item; pinned by a 403 e2e test (`apps/api/test/boxes.e2e.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /box-exceptions`                                                                                                      | the undo/clear/reprint/disassemble audit trail — a manager-only ledger, same reasoning as `GET /boxes`; pinned by a 403 e2e test (`apps/api/test/box-exceptions.e2e.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `employees`                                                                                                                | `EmployeeDto` carries **plaintext badge codes**, which is exactly what shipping only hashes to devices is meant to prevent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `operators` (admin routes)                                                                                                 | granting or resetting station access is a manager action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `counterparties` (all routes)                                                                                              | the station never calls this module; counterparty records are a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `label-templates` (all routes)                                                                                             | the station never calls this module; label design is a back-office concern — the NewShift picker reads spec-free summaries from `GET /shifts/box-label-templates` instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lines` (all routes)                                                                                                       | the station never calls this module; production-line setup is a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `org-profile` (all routes)                                                                                                 | the station never calls this module; the org's own GS1/GLN identity is a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /shifts/:id`, `PATCH /shifts/:id`, `DELETE /shifts/:id`, `POST /shifts/:id/close`                                     | the station only lists, creates, opens and bundles shifts (see above). Reading/editing an arbitrary shift by id, deleting it, or closing it from the floor is also a back-office action; closing a shift from the station is deliberately not a station action                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id`, `DELETE /products/:id/external-link` | the station only lists/searches products and does a gtin-check (see above) — get-by-id and every catalog mutation are a back-office action; breaking a product's external link (Task 10) is served by `ProductExternalLinkController` in the integrations module rather than `ProductsController`; all use `RequirePermissions`, with external unlink requiring integration write access                                                                                                                                                                                                                                                                                                                                       |
| `kiosks`                                                                                                                   | device management and pairing-code issue — a stolen device must not be able to enrol or re-pair another                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pickup-orders`                                                                                                            | the admin's order resolution flow; the kiosk uses `/kiosk/*` behind `KioskDeviceGuard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pickup-reasons`                                                                                                           | the reason list is edited in the cabinet; the kiosk receives it in its bootstrap payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pickup-rejections`                                                                                                        | the admin's audit surface for refused scans; exposes **raw marking and badge codes**, which is exactly what shipping only hashes to devices is meant to prevent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `integrations`                                                                                                             | configuring exchange channels, reading their journal, issuing/rotating a channel's machine credentials (`POST /integrations/:type/credentials`, whose one-time secret response must never reach a device), and resolving the unmatched-nomenclature queue (`GET /integrations/:type/candidates`, `POST .../candidates/:id/link`, `.../hide`, `.../unhide` — Task 10), and minting/listing/revoking `public_api` keys (`GET`/`POST /integrations/public_api/keys`, `DELETE /integrations/public_api/keys/:id` — Task 11, served by the separate `api-keys` module; the POST response's one-time secret must never reach a device either) is a back-office concern; the station never calls this module or the `api-keys` module |

## Replacement waiting and productive admission

A replacement target may pair immediately with a client supporting
`replacement-boundary-v1`. Its credential can read reference data and deliver
recovery evidence while the server-owned `newWorkAllowedAt` fence remains active.
Every productive decision below runs inside the mutation transaction while holding
the durable device lock. Device grants apply the same saved boundary under their
ordered grant locks, independently of observe/strict rollout mode.

| Device route or operation                                                                                                                    | Transaction owner and replacement behavior                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /shifts`                                                                                                                               | `ShiftsService.createShift`: denies new validation, duplicate-label/reprocessing, aggregation and pallet scope while waiting or draining.                                                                                                                                                                     |
| `POST /shifts/:id/open`, `POST /shifts/:id/enter`                                                                                            | `ShiftsService.enterShift`: denies target entry before the boundary; an already participating draining source may resume its current task.                                                                                                                                                                    |
| `GET /shifts/:id/bundle` for aggregation                                                                                                     | `ShiftsService.bundleSscc`: box and pallet serial allocation checks the shared admission fence before taking the shift lock. Validation reference bundles allocate no serials.                                                                                                                                |
| `POST /station/inventories/:id/join`                                                                                                         | `StationInventoryAccessService.join`: fences new participation; existing source participants retain recovery.                                                                                                                                                                                                 |
| `GET /station/inventories/:id/bundle/manifest` for repack                                                                                    | `StationInventoryBundleService.prepareJoinManifest`: fences serial allocation, including renewed ranges for an existing participant. Check manifests are reference-only.                                                                                                                                      |
| `POST /station/writeoffs`                                                                                                                    | `PickupOrdersService.insertOrderWithRetry`: fences a fresh handheld document after the serialized idempotency lookup. An already committed device sequence returns its saved document. A waiting target’s fresh submission and an unproven draining-source document are durably quarantined before admission. |
| `POST /station/grants/v1/device`, `POST /station/grants/v1/tasks`                                                                            | `GrantIssuerService`/`grantPoolDenial`: no device/task issuance before the target boundary; grant configuration reports the persisted replacement fence.                                                                                                                                                      |
| `POST /station/scans`, shift closure, inventory event batches/leave, native grant evidence                                                   | Old draining-source recovery continues. A waiting target has no legitimate prior production: its scan/label/box/pallet/inventory/closure submissions are quarantined without business effects. Native evidence is quarantined even in observe mode.                                                           |
| Templates, catalog/GTIN lookup, lines, operator roster, task lists, reference bundles, conflict/code reconciliation, readiness/configuration | Reference or recovery only; no productive scope is created. Cabinet label/box/pallet management routes remain inaccessible to device credentials.                                                                                                                                                             |

Legacy target submissions return HTTP 409 with `code: device_replacement_waiting`,
`outcome: quarantined`, `receiptId`, and the saved `newWorkAllowedAt`. The bounded
`device_grant_evidence` record retains the normalized manufacturing payload and
an exact audit fact before that response is sent. Retrying the same device,
operation and batch/sequence replays the receipt; altered payloads return
`device_replacement_evidence_conflict`. Native envelopes use the existing bounded
`device_grant_ingest_receipts` owner and return HTTP 200 with a quarantined receipt,
the same explicit reason and `reconciliation.status: not_applied`.

A draining source's previously uncommitted v1 write-off has no verifiable
pre-drain scope. It is retained with HTTP 409 `code: device_replacement_draining`,
`reason: unproven_pre_drain_scope`, `outcome: quarantined`, and `receiptId`; the
client's `createdAt` never proves authority. The final write transaction rechecks
the source lock, so drain beginning during an in-flight request also retains the
rejected submission after rollback. An exact already committed sequence keeps
its saved business outcome. This does not restrict established source task sync.

Quarantine classification commits with initial retention, so a lost response or
process restart cannot later turn the same submission into accepted production.
After the boundary, new submissions use ordinary ingestion; quarantined
submissions remain held for review and continue to block clean replacement
readiness. Reference reads, empty sync probes, and old draining-source sync remain
available. Exact already-committed legacy production replays retain their saved
outcome.

The cutover boundary includes all unexpired device and task issuances belonging to
the durable source, including earlier credential epochs. Security revoke and key
rotation do not invalidate signed authority retained by a disconnected client.
When that source is itself a replacement target, its inherited saved boundary is
included in both normal and emergency preview facts and the next durable receipt.
The boundary is never earlier than server time, a recorded authority horizon, or
an applicable conservative policy fallback. Chaining replacements cannot shorten
the wait.

Legacy inventory leave accepts an optional UUID `requestId`. Current Station
uses its persisted activation identity; Handheld freezes its completion event
identity and legacy request body in the local recovery commit before sending.
Both survive retry and database reopen. Native leave retains its envelope
`batchId`. An older body without `requestId` uses a fixed legacy identity for the
device and inventory: a retained request always replays its quarantine receipt,
even after the boundary or later participation. A later legitimate leave requires
a distinct explicit request identity. Changed content under a retained identity
is a conflict. Previously queued unidentified Handheld bodies remain unchanged
through upgrade and retry.

Write-off replay/quarantine and shift closure use the subscription recovery
policy, including when a subscription is read-only or expired. A genuinely new
handheld write-off still checks current subscription write access inside its
serialized business transaction, after committed-sequence replay and replacement
admission. Inventory leave is retained before participant lookup, so a waiting
target without any participation cannot lose its submission to a 404. Established
source leave and closure remain recoverable under restricted subscription access.

## Rule for new routes

This document, and the two sections above, are about `TenantGuard`-guarded
routes — the ones a station's `x-api-key` resolves a tenant through. Not
every route in the API is one of those, and a route that isn't doesn't
belong in either section:

- `GET /health` (`apps/api/src/health.controller.ts`) carries **no guard at
  all** — an intentionally unauthenticated liveness check, not a triage gap.
- The kiosk device-facing routes in
  `apps/api/src/modules/kiosk/kiosk.controller.ts` (singular) authenticate via
  `x-kiosk-token` through `KioskDeviceGuard`, a different device secret
  entirely (looked up against `kiosks.deviceTokenHash`, not an api-key). **A
  reader must not confuse this with the `kiosks` row in the Cabinet-only
  table above**: that row is the plural `kiosks.controller.ts` (admin
  management of kiosk devices, `TenantGuard` + `AuthorizationGuard` with
  `RequirePermissions`); this
  singular `kiosk.controller.ts` already has its own guard and was never in
  scope for this document.
- `POST /kiosk/pair` (`apps/api/src/modules/kiosk/kiosk-pair.controller.ts`) carries
  **no guard** — a device has no credential until it succeeds. Brute force is bounded by
  a fixed-window rate limiter — a per-source attempt budget plus a global backstop,
  both recorded in `kiosk_pair_attempts` — not by a per-code lockout: a wrong guess
  matches no row, so there is nothing for a per-code counter to count. The per-source
  dimension only distinguishes callers when `TRUST_PROXY_HOPS` is set correctly behind
  a proxy; misconfigured, every caller collapses onto the proxy's own address and only
  the (much larger) global backstop bounds guessing.
- `POST /station/pair` (`apps/api/src/modules/station-pairing/station-pair.controller.ts`)
  also carries **no guard**: a factory station has no credential until it redeems its
  one-time eight-digit pairing code. Its HMAC-protected code and the same persisted
  per-source/global pairing limiter are the deliberate boundary; it must not gain
  `TenantGuard` or a cabinet authorization policy. `POST /station/pair/recovery`
  restores the same station identity on the same terms: it is unguarded, bounded by
  the code and the same limiter, and changes no credential unless the expected
  tenant, device and kind match the code's device. Conversely,
  `POST /station-devices/:id/pairing-code` stays cabinet-only under
  `CREDENTIALS_MANAGE`, so a station key cannot issue a replacement credential.
- `GET/POST /1c_exchange` (`apps/api/src/modules/exchange/exchange.controller.ts`)
  carries **no guard either**, and unlike every other exception in this section, it
  never falls back on `TenantGuard`/`AuthorizationGuard` at all — not even indirectly.
  This is deliberate, not a gap `TenantGuard` should have caught: the tenant for this
  route is resolved from the 1С CommerceML exchange's own machine credentials (HTTP
  Basic on `checkauth`, minted and hashed exactly like a kiosk device token — see
  `exchange-credentials.ts`), then from the session cookie `checkauth` itself issues —
  never from a Better Auth session or a station `x-api-key`. A station's `x-api-key`
  simply does not authenticate here at all: `TenantGuard.canActivate` is never even
  invoked for this route. Brute force on `checkauth` is bounded by a per-source
  fixed-window attempt counter (`exchange_attempts`, `assertUnderCheckauthLimit`) —
  deliberately ONE tier, not the kiosk-pairing route's two (per-source budget +
  global backstop): the guessable secret here is 24 random bytes (192 bits), not an
  8-digit code, so distributing guesses across sources doesn't turn an infeasible
  brute force into a feasible one the way it does for a 10^8-entry code space: see
  the comment above `assertUnderCheckauthLimit` in `exchange-credentials.ts`.

Anything a station does not demonstrably need gets an explicit cabinet
`RequirePermissions` policy. When adding a `TenantGuard`-guarded route, decide
which of the two sections above it belongs in (station-reachable or
cabinet-only) and add it there in the same change. A station-only route must
use `StationOnlyGuard`; a shared route must use `AllowStationOrPermissions`;
and `/access/me` is the sole `RequireMembership` bootstrap route. A route that
does not use `TenantGuard` (no guard, or a bespoke device guard like
`KioskDeviceGuard`) is out of scope for the two tables by construction — but
note it here anyway, as above, so this list of exceptions does not silently go
stale.

## Public integration keys

`/public/v1` is a separate public-key surface, guarded by `PublicApiGuard` and an explicit scope on every route. Public keys never authenticate Station/Handheld, kiosk or signer device APIs; device keys never authenticate public integration routes. Cabinet issuance and scope editing remain behind the cabinet integration permission boundary. Existing unscoped keys authorize no public operation.

Public inventory preparation calls the existing create/import/snapshot/start owners with a durable API-key actor. It does not impersonate a cabinet user or return the native manifest/operator credentials. Reading public progress and results requires current `publicApi` and `inventory` rights; native recovery remains independent of those public rights. The combined entitlement registry is `p1c.native.v1`, with separate `public.*.v1` bindings.

See [Public API operations](operations/public-api.md) for scopes, retries, projection and deployment rules. All new cabinet/CHZ/public imports use attempt-owned storage keys. Before exposing public routes, drain old cabinet/CHZ cleanup writers that still share historical content-addressed keys; new readers retain exact historical cabinet-path compatibility. This work does not activate strict offline grant enforcement.

## Platform replacement target pairing

The platform can issue a normal target code through
`POST /platform/tenants/:tenantId/device-licensing/replacements/:preparationId/target/code`.
It reloads `tenants.write` and `billing.write`, requires a completed execution and
its current revision, and locks the reserved target. Cabinet uses the existing
`POST /station-devices/:id/pairing-code` route.

Issuance uses the existing normal-code hash, expiry and one-time claim policy.
An immutable working-device observation binds its code ID to the tenant,
preparation, execution, target kind and credential epoch. Only that platform
binding enables transactional normal-key provisioning without a cabinet member.
The code claim, hashed key insertion, target publication and assignment transition
commit together; a failed publication leaves no orphan key or consumed code.
Ordinary cabinet pairing retains its existing provisioning path.

The target remains subject to the execution's server boundary. A waiting target
requires `replacement-boundary-v1`; pairing itself does not permit early work.
A lost code response requires a fresh issuance with the latest execution revision;
the prior live code is retired. No plaintext code is stored in a receipt or audit.

Replacement list responses expose the latest stored readiness measurements,
including `unsupported`, report receipt time and storage/journal revisions.
These observations do not override server eligibility or execution/recovery state.

## Emergency replacement evidence credentials

`POST /device-licensing/replacements/:preparationId/recovery/code` (and the platform
counterpart) requires current credential-management authority and the **execution**
revision. The completed preparation is immutable. Codes use the existing hash,
expiry, one-time claim and limiter. The immutable issuance event binds the code ID
to the execution and source credential epoch; plaintext is returned once and never
stored in events or receipts. A lost issuance response requires a new request with
the current execution revision.

The recovery pairing route requires `replacement-evidence-recovery-v1` and the
sealed local tenant/device/kind identity. Ordinary pairing cannot redeem this code.
The source remains revoked and its assignment remains released. Key metadata binds
`replacement_evidence_recovery`, execution and source; every request rechecks the
live key, execution recovery state, current epoch and released assignment. The key
is hashed and inserted in the same transaction as code redemption, with a 24-hour
expiry. This purpose-specific issuer also supports platform operators who have no
cabinet membership; it does not create a tenant member or ordinary production key.

Recovery access requires `AllowReplacementEvidenceRecovery` on the **handler**.
The exact permitted handlers are identity; legacy scans (including product-label,
box/pallet and exception channels); validation/conflict/release acknowledgements;
legacy shift closures; committed handheld write-off replay or unproven source
evidence retention; inventory event batches/progress/leave; native evidence
scans/shift closures/inventory batches/leave; grant verification keyset; and the
separate `/station/replacement-recovery/readiness` report. Other routes deny by
default, including allocating bundles, task selection/start/join, all grant
issuance/configuration, catalog mutation and credential issuance. Existing tenant,
device-kind, task participation and quarantine checks still apply to uploads. An
authenticated recovery principal on an explicitly allowed recovery/read handler
may deliver evidence for expired or unmanaged tenants, including enforcement `all`;
ordinary station credentials retain the existing subscription rules.

After emergency transfer, every mutating evidence handler also checks the immutable
source execution. Legacy payloads can replay only an exact committed receipt owned
by the source; altered bytes cannot poison that receipt. First-delivery scan,
label, box/pallet, exception, inventory and closure payloads are durably quarantined
(HTTP 409, `device_replacement_recovery`, `unproven_pre_replacement_evidence`).
Write-offs retain their existing `device_replacement_draining` receipt semantics.
Native evidence first retained after cutover is quarantined independently of
observe/strict mode (HTTP 200, `not_applied`, the same recovery reason). Only an
exact immutable server receipt predating execution `startedAt` may resume native
business reconciliation; client timestamps and signed task grants alone do not
prove that a new submission existed before cutover. Exact finalized receipts
replay without effects. Every quarantine remains stable on retry.

Identity, validation/conflict status, code-release pages, inventory progress and
keyset handlers only read; the separately bound readiness report writes recovery
measurements and audit, never production facts. `/station/operators` stays denied.

Recovery reports use a new source/epoch-bound intent and the existing append-only
report store. Original drain reports, cancellation/completion tombstones and ACKs
are preserved and cannot be rebound to the new key. Fresh zero measurements plus
current server-work checks complete recovery and revoke the key atomically. Lost
report responses preserve the native pending body; a subsequent revoked response
seals the client. Administrative unavailable closure requires a reason, request ID,
execution revision and an exact audit fact; it does not invent a zero report.

Recovery binding version 1 explicitly declares `operatorRoster: preserve_sealed`.
The response's empty `operators` array does not replace the sealed roster. Both
clients persist an owner-bound snapshot of the existing offline verifiers before
clearing live authentication during sealing. Matching recovery publication restores
that snapshot; restart or interrupted publication cannot replace it with an empty
roster. Ordinary pairing still publishes the authoritative response roster. An
unknown or mismatched owner never inherits retained operator authentication.

Both native clients persist the recovery purpose before publishing credentials,
retain journals, pinned requests, saved label bytes and grant evidence, block
productive work and grant installation, and retry the exact recovery report after
restart. Recovery completion does not reopen production on the transferred source.
