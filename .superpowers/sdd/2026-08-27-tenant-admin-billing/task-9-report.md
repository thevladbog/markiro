# Task 9 — Tenant invoices, documents, and offer actions

## Changed behavior

- Added tenant invoice filters (`status`, `from`, `to`), authoritative invoice/payment presentation, confirmed-payment history, and ready-only invoice downloads.
- Added offer/act document registry with type and period API filters, safe local status selection, ready-only signed-URL downloads, and explicit pending/failed/download-error states.
- Added commercial-offer detail with read-only expired/superseded states, capability-gated acceptance/change actions, confirmation, bounded change text, and retry-stable idempotency keys. Successful decisions return to the implemented documents route; request-history rendering is deferred to Task 10.
- Review follow-up: offer detail now receives server-owned `isCurrent`, `actionable`, and latest decision projection; decision retries retain one immutable payload/key and success invalidates the tenant-billing query family before returning to the implemented documents route.

## Verification

- RED: the focused tests failed against the former invoice-only page and missing document/offer components.
- GREEN: `node node_modules/vitest/vitest.mjs run test/billing-invoices.test.tsx test/billing-documents.test.tsx test/billing-offer-actions.test.tsx` — 12 passed.
- Scoped ESLint passed, and the admin Vite production build passed.
- The worktree inherits symlinked package dependencies whose `@markiro/domain` declaration build is stale. The focused offer test temporarily supplies the already-present Task 3 billing capability values so it tests the UI behavior without altering shared links.

## Not performed

- Browser visual verification is reserved for Task 13.
- Live API/object-storage authorization and signed-download confirmation require the configured external environment.
- Full `@markiro/admin` typecheck cannot pass in this worktree: its shared `apps/admin/node_modules` resolves `@markiro/domain` to the main checkout, whose source has no Task 3 `BILLING_READ` or `BILLING_REQUEST` exports. The resulting errors also cover pre-existing billing layout, routing, and tests rather than this UI change.
