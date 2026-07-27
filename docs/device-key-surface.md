# What a station api-key may reach

A station device authenticates with an organization-owned api-key
(`x-api-key`). `TenantGuard` accepts it for tenant resolution, so **every
tenant-guarded route is reachable by a device unless it also carries
`SessionOnlyGuard`**. A floor device is the most theft-exposed credential in
the system, so this list is deliberately explicit.

## Reachable by a device key

| Route                                                                            | Why the station needs it                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /station/operators`                                                         | the offline sign-in roster (hashes only)                       |
| `GET /shifts`, `POST /shifts`, `GET /shifts/:id/bundle`, `POST /shifts/:id/open` | shift selection, ad-hoc shift creation, and the offline bundle |
| `GET /products`, `POST /products/gtin-check`                                     | resolving a scanned GTIN when creating a shift                 |

## Cabinet-only (`SessionOnlyGuard`)

| Module                     | Why a device must not reach it                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `station-devices`          | a stolen device could enrol or revoke other devices                                                                        |
| `employees`                | `EmployeeDto` carries **plaintext badge codes**, which is exactly what shipping only hashes to devices is meant to prevent |
| `operators` (admin routes) | granting or resetting station access is a manager action                                                                   |

## Rule for new routes

Anything a station does not demonstrably need gets `SessionOnlyGuard`. When
adding a tenant-guarded route, decide which table above it belongs in and add
it there in the same change.
