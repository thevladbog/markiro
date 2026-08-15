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
it only to the exact method/path pairs in the device table below, including
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
| `GET /station/operators`                                                                                             | the offline sign-in roster (hashes only); `StationOnlyGuard` explicitly rejects a Better Auth session                                                                                                                                                                                                                                                                                                                                      |
| `GET /shifts`, `POST /shifts`, `GET /shifts/:id/bundle`, `GET /shifts/:id/reference-bundle`, `POST /shifts/:id/open` | shift selection, ad-hoc shift creation, the ordinary allocating offline bundle, and an allocation-free reference refresh used only after local print-recovery classification — `GET /shifts` is also the enrollment reachability probe (`whoami()` in `apps/station/src/lib/api-client.ts`, called by `Enrollment.tsx`); `AllowStationOrPermissions` keeps the station path while requiring the matching cabinet capability from a session |
| `GET /products`, `POST /products/gtin-check`                                                                         | resolving a scanned GTIN when creating a shift; `AllowStationOrPermissions` keeps the station path while requiring `operations.read` from a cabinet session                                                                                                                                                                                                                                                                                |
| `POST /station/scans`                                                                                                | delivering scans is the device's entire purpose; `StationOnlyGuard` explicitly rejects browser sessions and requires `req.deviceId`, which is the authoritative terminal identity for the complete batch                                                                                                                                                                                                                                   |
| `POST /station/conflicts/status`                                                                                     | reconciles only hashes already present in this device's local conflict mirror; the response is tenant- and authenticated-device-scoped and identifies only manager-reviewed rows, so it exposes neither raw codes nor another terminal's conflicts                                                                                                                                                                                         |

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
| `label-templates` (all routes)                                                                                             | the station never calls this module; label design is a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lines` (all routes)                                                                                                       | the station never calls this module; production-line setup is a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `org-profile` (all routes)                                                                                                 | the station never calls this module; the org's own GS1/GLN identity is a back-office concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /shifts/planning-config`, `GET /shifts/:id`, `PATCH /shifts/:id`, `DELETE /shifts/:id`, `POST /shifts/:id/close`      | the station only lists, creates, opens and bundles shifts (see above). The planning-config route is a cabinet operations-read boundary exposing only `defaultBoxLabelTemplateId`; reading/editing an arbitrary shift by id, deleting it, or closing it from the floor is also a back-office action; closing a shift from the station is deliberately not a station action                                                                                                                                                                                                                                                                                                                                                      |
| `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id`, `DELETE /products/:id/external-link` | the station only lists/searches products and does a gtin-check (see above) — get-by-id and every catalog mutation are a back-office action; breaking a product's external link (Task 10) is served by `ProductExternalLinkController` in the integrations module rather than `ProductsController`; all use `RequirePermissions`, with external unlink requiring integration write access                                                                                                                                                                                                                                                                                                                                       |
| `kiosks`                                                                                                                   | device management and pairing-code issue — a stolen device must not be able to enrol or re-pair another                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pickup-orders`                                                                                                            | the admin's order resolution flow; the kiosk uses `/kiosk/*` behind `KioskDeviceGuard`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pickup-reasons`                                                                                                           | the reason list is edited in the cabinet; the kiosk receives it in its bootstrap payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pickup-rejections`                                                                                                        | the admin's audit surface for refused scans; exposes **raw marking and badge codes**, which is exactly what shipping only hashes to devices is meant to prevent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `integrations`                                                                                                             | configuring exchange channels, reading their journal, issuing/rotating a channel's machine credentials (`POST /integrations/:type/credentials`, whose one-time secret response must never reach a device), and resolving the unmatched-nomenclature queue (`GET /integrations/:type/candidates`, `POST .../candidates/:id/link`, `.../hide`, `.../unhide` — Task 10), and minting/listing/revoking `public_api` keys (`GET`/`POST /integrations/public_api/keys`, `DELETE /integrations/public_api/keys/:id` — Task 11, served by the separate `api-keys` module; the POST response's one-time secret must never reach a device either) is a back-office concern; the station never calls this module or the `api-keys` module |

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
  `TenantGuard` or a cabinet authorization policy. Conversely,
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
