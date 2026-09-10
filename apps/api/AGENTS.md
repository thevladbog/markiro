# API agent instructions

These instructions supplement the [root AGENTS.md](../../AGENTS.md) for
`apps/api`. Read the relevant controllers, guards, contracts, persistence and
tests together; controller behavior alone is not the complete API contract.

## Routes, capabilities and recovery access

- For a new or changed route, identify its trust domain: tenant cabinet,
  station/handheld, kiosk, platform, or an explicitly defined public-token flow.
  Select existing guards and access-policy decorators for that domain. Do not
  make a route public or omit its policy to fix a client or test failure.
- Customer routes must declare their subscription policy. Preserve intended
  recovery and read/export access when a subscription is restricted; do not
  classify every POST as new production work. Inspect
  `src/subscriptions/subscription-access-policy.ts` and its guard.
- Update the applicable route inventory and contract tests with the route:
  `test/subscription-route-inventory.test.ts`, `test/platform-route-contracts.ts`
  and `test/platform-contract-openapi.test.ts`. Keep public OpenAPI and shared
  request/response schemas aligned with runtime behavior.
- Test denial across tenants and credential kinds, restricted subscription
  behavior, and exact audit fields. Handheld shares station authentication but
  has device-kind restrictions; preserve them server-side.
- Platform operations use the platform principal and capabilities, not cabinet
  membership or a device key. Revalidate access at protected boundaries. For
  multi-tenant report requests validate the explicit tenant/filter scope and
  preserve creator ownership; possession of a report ID is not authorization.

## Durable background work and report artifacts

For platform exports read the
[operational guide](../../docs/operations/platform-report-exports.md) and
`src/platform-reports/`. Its retention, limits and definitions are authoritative;
do not duplicate their numeric values here.

- Persist the request and its audit fact before relying on queue delivery.
  Preserve the same idempotency key for transport retries of unchanged input;
  changed parameters or a requested new generation are a distinct intent.
  Queue repair must recover committed work after a failed wake-up.
- Preserve fenced leases and attempt-specific object keys. A stale worker must
  not publish over a newer attempt or delete the winning artifact. Test process
  failure, lease expiry, duplicate delivery and an ambiguous commit after upload.
  An exception is not proof that the database commit failed.
- Recheck the creator's current access when executing work and authorizing a
  download. Keep artifacts private, signed URLs bounded by readiness/expiry and
  access policy, and deletion retryable. Do not log URLs, report payloads or
  credentials. PostgreSQL owns lifecycle state; object presence alone is not
  proof that a report is ready.
- Keep source reads consistent with the report's declared snapshot. Respect
  row/byte/time limits; exceeding a limit must not silently produce a truncated
  successful report. An empty valid result can still be successful.
- Preserve metric meaning: missing facts are `null`, not inferred zero; current
  projections/names are not asserted historical values; sends, reprint requests,
  verified printing and accepted units are separate facts. Do not reconstruct
  historical source files that the platform never retained.

Use `test/platform-report-lifecycle.test.ts`, the report source/renderer/module
tests, and affected contract tests for changes here. The isolated download UI
check is documented in the operational guide; it is separate from API tests.

## Verification and external boundaries

Build changed workspace dependencies before consumer tests and follow the root
API gates. Database-backed checks must run against an appropriate test database
with the required migrations and environment; report explicit skips. Pure unit
tests do not prove database isolation, live object storage, queue delivery,
Chestny ZNAK, mail or 1C integration behavior.
