# What a station api-key may reach

A station device authenticates with an organization-owned api-key
(`x-api-key`). `TenantGuard` accepts it for tenant resolution, so **every
tenant-guarded route is reachable by a device unless it also carries
`SessionOnlyGuard`**. A floor device is the most theft-exposed credential in
the system, so this list is deliberately explicit.

This document is **not** a claim that the whole API has been triaged — see
"Not yet triaged" below for tenant-guarded surfaces a device key can still
reach that this pass deliberately left alone.

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

## Not yet triaged

These modules are `TenantGuard`-only today — reachable by a device key — and
were deliberately **left alone** by this pass. They belong to the
pickup-kiosk workstream (a parallel branch), which owns `kiosk-device.guard.ts`
and is expected to classify them (as station-reachable, kiosk-reachable, or
cabinet-only) as part of its own work:

| Module           | Notes                                     |
| ---------------- | ----------------------------------------- |
| `kiosks`         | pickup-kiosk device enrollment/management |
| `pickup-orders`  | pickup-kiosk order flow                   |
| `pickup-reasons` | pickup-kiosk reason codes                 |

**A reader must not treat the two tables above as an exhaustive account of
the device-key surface** — the modules in this section are also reachable by
a device key (a station's own, since `TenantGuard` does not distinguish
between a station's key and a future kiosk device's key) until the
pickup-kiosk workstream triages them.

## Rule for new routes

This document, and the three sections above, are about `TenantGuard`-guarded
routes — the ones a station's `x-api-key` resolves a tenant through. Not
every route in the API is one of those, and a route that isn't doesn't
belong in any of the three sections:

- `GET /health` (`apps/api/src/health.controller.ts`) carries **no guard at
  all** — an intentionally unauthenticated liveness check, not a triage gap.
- The kiosk device-facing routes in
  `apps/api/src/modules/kiosk/kiosk.controller.ts` (singular) authenticate via
  `x-kiosk-token` through `KioskDeviceGuard`, a different device secret
  entirely (looked up against `kiosks.deviceTokenHash`, not an api-key). **A
  reader must not conclude from "Not yet triaged" that all kiosk surface is
  `TenantGuard`-only**: that section's `kiosks` row is the plural
  `kiosks.controller.ts` (admin management of kiosk devices, still
  `TenantGuard`-only and genuinely untriaged); this singular
  `kiosk.controller.ts` already has its own guard and was never in scope for
  this document.

Anything a station does not demonstrably need gets `SessionOnlyGuard`. When
adding a `TenantGuard`-guarded route, decide which of the three sections
above it belongs in (reachable, cabinet-only, or — only if it is explicitly
out of scope for this triage, e.g. a pickup-kiosk route — not yet triaged)
and add it there in the same change. "Not yet triaged" is not a resting
place for new station or cabinet routes; it exists solely for the
pickup-kiosk workstream's own `TenantGuard`-only modules until they classify
them. A route guarded by something other than `TenantGuard`/`SessionOnlyGuard`
(no guard, or a bespoke device guard like `KioskDeviceGuard`) is out of scope
for this document by construction — but note it here anyway, as above, so
this list of exceptions doesn't silently go stale.
