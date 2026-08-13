# Task 4 report — device product-image delivery

Implemented commit `3f8ccfd0`.

- Kiosk bootstrap now emits optional nullable image descriptors from one allowlist-scoped join.
- Added `GET /kiosk/products/:id/image/:checksum`, guarded by `KioskDeviceGuard` and verified against the kiosk allowlist, tenant, active asset, and current checksum before private presigning.
- Added `GET /station/products/:id/image/:checksum`, guarded by `TenantGuard`, `StationOnlyGuard`, and subscription read policy.
- Station shift bundles now carry the product image descriptor; old device payloads remain compatible because image is optional.
- Added focused controller contract tests and route-inventory entries.

Checks: `git diff --check` passed. Focused Vitest/TypeScript commands were invoked but emitted no runner output in this environment and are therefore not treated as a verified pass. Database-backed e2e, real object storage, browser, kiosk, station, Windows/Tauri, and hardware gates were not run.
