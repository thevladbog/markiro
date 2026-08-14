# Task 5 report: admin pickup policy and company branding controls

## Status

Implemented the approved desktop-admin policy and branding controls, including separated bulk employee actions, tenant-wide enforcement, normalized company-logo management, and removal of the compatibility-only kiosk limit from create/edit payloads. The complete admin package is green. The focused API contract/e2e group is green; the branch-wide API suite remains blocked by the inherited test-seed gap described below.

Planned commit: `feat(admin): manage kiosk pickup policy`

## Behavior changed

- Added an employee `pickup-policy` editor backed by the existing single-employee PATCH. Switching to unlimited retains the numeric `dayLimit`, and the request always preserves the independently edited `canWriteoff` value.
- Added selected-employee bulk mode with a 500-employee client bound, disabled actions without a selection, and separate confirmations and request shapes for limit assignment and writeoff permission. Limit requests never carry `canWriteoff`; writeoff requests never carry limit fields. Failed requests leave their confirmation and accessible API error visible for retry.
- Added the tenant setting for all-kiosk-total limit enforcement. The copy explicitly states that employee values are retained while enforcement is disabled.
- Added one-file JPEG/PNG/WebP logo upload, an immediate preview of the server-returned normalized same-origin URL, explicit remove, a labelled Markiro fallback, and accessible client/server errors. SVG and external/non-profile URLs are not previewed.
- Extended the cabinet organization-profile contract with nullable `logoUrl`/`logoRevision`, and upload now returns both current fields. Added tenant-authenticated `GET /org/profile/logo/:revision`, reusing the existing bounded active-logo read so a tenant can stream only its own active `image/webp`; object keys remain private and the kiosk device route is unchanged.
- Removed `dayLimitPerEmployee` from admin kiosk create/update input types, form controls, initial values, and POST/PATCH bodies. The server compatibility field and kiosk DTO response remain intact.
- Added RU/EN copy and kept existing `@markiro/ui`, panel navigation, keyboard/focus, dirty-state, and query-cache patterns.

## TDD evidence

- RED admin: the four focused files initially produced 9 expected failures (81 passed) for missing policy controls/routes, separated bulk payloads, branding controls, and kiosk payload removal.
- GREEN admin: `org-profile`, `employees`, `employees-routing`, and `kiosks-routing` pass 90/90 tests.
- RED API: authorization metadata rejected the un-inventoried cabinet logo handler, and profile response/stream assertions failed before the new fields and route existed.
- GREEN API: the final combined profile processor/controller/service, authorization metadata, subscription inventory, and live profile e2e group passes 58/58 tests. The e2e fixture's second WebP frame was corrected from value 1 to 255 after Sharp metadata proved the former was optimized to a single frame; the processor itself already rejected a genuinely animated source.

## Automated verification

- `@markiro/admin test`: 51 files / 638 tests passed. jsdom printed its established canvas/navigation limitations; no tests failed.
- `@markiro/admin typecheck`, `lint`, and `build`: passed. Lint retains five pre-existing hook warnings in unmodified boxes/conflicts pages; Vite retains its established large-chunk warning.
- `@markiro/api` focused final group: 6 files / 58 tests passed, including no/current logo, upload response, cabinet stream, wrong/foreign revision, missing object, invalid input, auth metadata, and subscription inventory.
- `@markiro/api typecheck`, `lint`, and `build`: passed.
- `git diff --check` and changed-file Prettier: passed.
- Local branch migrations were applied to the development Postgres before e2e verification because the shared database initially lacked `pickup_tenant_policies`; no data was dropped or rewritten.

## Branch-wide API suite gap

`@markiro/api test` ran 123 files: 107 passed, 1 skipped, and 15 failed (1162 passed, 51 skipped, 55 failed). The failing files were `authorization.e2e`, `device-key-triage.e2e`, `kiosk-bootstrap-hashes.e2e`, `kiosk-pairing.e2e`, `kiosks.e2e`, `pickup-conflicts.e2e`, `pickup-export.e2e`, `pickup-orders.e2e`, `pickup-rejections.e2e`, `pickup-slip.e2e`, `products.e2e`, `shifts-bundle.e2e`, `sscc-settings.e2e`, `sscc.e2e`, and `subscription-expiry.e2e`.

Their shared inherited setup helpers create organizations/kiosks without the Task 1-4 required `pickup_tenant_policies` row. Calls to `GET/PUT /org/profile`, kiosk bootstrap/pairing, or downstream pickup setup then return 500, causing cascading failures. The Task 5 profile e2e helper creates this required row and is green. Per the parent ruling, this central branch-fixture repair is a load-bearing Task 6 gate and was not mass-edited into this scoped admin commit.

## Manual and external verification

No visual browser session, real S3/MinIO request, offline kiosk, hardware, or production deployment was exercised. Component DOM tests verify accessible names, confirmations, errors, focus return, and exact request payloads; automated DOM tests do not constitute visual browser acceptance.

## Self-review

- Single and bulk actions use only the existing API contracts; limit and writeoff fields cannot cross between bulk requests.
- The numeric limit remains editable and retained in unlimited mode; tenant disabling changes only enforcement.
- Cabinet logo URLs are relative, revisioned, tenant-scoped, active-only, and WebP-only; UI preview accepts only the cabinet profile path and prepends the same-origin `/api` proxy.
- No SVG/external URL, object-storage key, secret, kiosk token, or compatibility-only kiosk limit is submitted or exposed.
- Unrelated admin lint warnings, API fixture repair, server compatibility fields, and prior task behavior were not refactored.

## Fix round 1

### Review findings resolved

1. The bulk day-limit field now uses the same translated positive-integer error as the single-employee editor. Zero and decimal values set `aria-invalid`, expose the associated error text, and keep limit assignment disabled; entering a valid integer removes the error and restores the action.
2. The single-employee policy editor now owns an explicit accepted baseline. A clean editor rehydrates when a background response changes the incoming policy, while a dirty editor preserves its local draft. A successful PATCH consumes the returned employee, updates every matching employee-list cache before invalidation, adopts the returned policy as the new baseline, and clears dirty state without waiting for a refetch.

### TDD and verification evidence

- RED: the strengthened employee suite had four intentional failures with 17 existing/new assertions passing: clean rehydration, successful baseline/cache adoption, invalid zero, and invalid decimal. The dirty-refetch draft-preservation regression already passed against the old implementation.
- GREEN focused: `employees.test.tsx` passes 21/21; the combined employee component/routing group passes 54/54.
- GREEN full admin: 51 files / 643 tests passed. The established jsdom canvas/navigation messages remain non-failing environment limitations.
- Admin typecheck, lint, and build passed. Lint retains only the five pre-existing hook warnings in unmodified boxes/conflicts pages; Vite retains its established large-chunk warning.
- Changed-file Prettier and `git diff --check` passed. No browser or external-system verification was added in this fix round.
