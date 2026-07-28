# What a station api-key may reach

A station device authenticates with an organization-owned api-key
(`x-api-key`). `TenantGuard` accepts it for tenant resolution, so **every
tenant-guarded route is reachable by a device unless it also carries
`SessionOnlyGuard`**. A floor device is the most theft-exposed credential in
the system, so this list is deliberately explicit.

This document is the source of truth for the `TenantGuard`-guarded surface:
every such route in the API is expected to appear in one of the two tables
below. See "Rule for new routes" for how it stays that way as routes are
added.

## Reachable by a device key

| Route                                                                            | Why the station needs it                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /station/operators`                                                         | the offline sign-in roster (hashes only)                                                                                                                                                                                                                                                                  |
| `GET /shifts`, `POST /shifts`, `GET /shifts/:id/bundle`, `POST /shifts/:id/open` | shift selection, ad-hoc shift creation, and the offline bundle — `GET /shifts` is also the enrollment reachability probe (`whoami()` in `apps/station/src/lib/api-client.ts`, called by `Enrollment.tsx`), so it can never be moved behind `SessionOnlyGuard` without making device enrollment impossible |
| `GET /products`, `POST /products/gtin-check`                                     | resolving a scanned GTIN when creating a shift                                                                                                                                                                                                                                                            |
| `POST /station/scans`                                                            | delivering scans is the device's entire purpose — making it session-only would strand every station's data on its own disk                                                                                                                                                                                |

## Cabinet-only (`SessionOnlyGuard`)

| Module / route                                                                         | Why a device must not reach it                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `station-devices`                                                                      | a stolen device could enrol or revoke other devices                                                                                                                                                                                                        |
| `employees`                                                                            | `EmployeeDto` carries **plaintext badge codes**, which is exactly what shipping only hashes to devices is meant to prevent                                                                                                                                 |
| `operators` (admin routes)                                                             | granting or resetting station access is a manager action                                                                                                                                                                                                   |
| `counterparties` (all routes)                                                          | the station never calls this module; counterparty records are a back-office concern                                                                                                                                                                        |
| `label-templates` (all routes)                                                         | the station never calls this module; label design is a back-office concern                                                                                                                                                                                 |
| `lines` (all routes)                                                                   | the station never calls this module; production-line setup is a back-office concern                                                                                                                                                                        |
| `org-profile` (all routes)                                                             | the station never calls this module; the org's own GS1/GLN identity is a back-office concern                                                                                                                                                               |
| `GET /shifts/:id`, `PATCH /shifts/:id`, `DELETE /shifts/:id`, `POST /shifts/:id/close` | the station only lists, creates, opens and bundles shifts (see above) — reading/editing an arbitrary shift by id, deleting it, or closing it from the floor is a back-office action; closing a shift from the station is deliberately not a station action |
| `GET /products/:id`, `POST /products`, `PATCH /products/:id`, `DELETE /products/:id`   | the station only lists/searches products and does a gtin-check (see above) — get-by-id and every catalog mutation are a back-office action                                                                                                                 |
| `kiosks`                                                                               | device management and pairing-code issue — a stolen device must not be able to enrol or re-pair another                                                                                                                                                    |
| `pickup-orders`                                                                        | the admin's order resolution flow; the kiosk uses `/kiosk/*` behind `KioskDeviceGuard`                                                                                                                                                                     |
| `pickup-reasons`                                                                       | the reason list is edited in the cabinet; the kiosk receives it in its bootstrap payload                                                                                                                                                                   |
| `pickup-rejections`                                                                    | the admin's audit surface for refused scans; exposes **raw marking and badge codes**, which is exactly what shipping only hashes to devices is meant to prevent                                                                                            |

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
  management of kiosk devices, `TenantGuard` + `SessionOnlyGuard`); this
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

Anything a station does not demonstrably need gets `SessionOnlyGuard`. When
adding a `TenantGuard`-guarded route, decide which of the two sections above
it belongs in (reachable or cabinet-only) and add it there in the same
change. A route guarded by something other than `TenantGuard`/`SessionOnlyGuard`
(no guard, or a bespoke device guard like `KioskDeviceGuard`) is out of scope
for this document by construction — but note it here anyway, as above, so
this list of exceptions doesn't silently go stale.
