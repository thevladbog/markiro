# Task 9 — Tenant invoices, documents, and offer actions

## Changed behavior

- Added tenant invoice filters (`status`, `from`, `to`), authoritative invoice/payment presentation, confirmed-payment history, and ready-only invoice downloads.
- Added offer/act document registry with type and period API filters, safe local status selection, ready-only signed-URL downloads, and explicit pending/failed/download-error states.
- Added commercial-offer detail with read-only expired/superseded states, capability-gated acceptance/change actions, confirmation, bounded change text, and retry-stable idempotency keys. Successful decisions return to the implemented documents route; request-history rendering is deferred to Task 10.
- Review follow-up: offer detail now receives server-owned `isCurrent`, `actionable`, and latest decision projection; decision retries retain one immutable payload/key and success invalidates the tenant-billing query family before returning to the implemented documents route.
- Review-readiness follow-up: every user-visible and accessibility string on the Task 9 invoice, document, invoice-detail, and offer-detail surfaces now comes from matched RU/EN dictionaries. Dates and money follow the active locale, while server-supplied document, offer-term, and decision content remains unchanged.
- Invoice `from`/`to` and document `type`/`from`/`to` controls now have request-boundary regressions proving that a later request omits cleared query keys. Invoice and offer detail regressions distinguish 404, 403, and retryable 5xx/network failures and exercise `refetch`.
- The isolated PostgreSQL read-contract suite now creates real current, decided, expired, and multi-revision offer families, validates each response through `tenantOfferDetailSchema`, and proves server-owned `isCurrent`, `actionable`, `latestDecision`, expiry, and supersession projections.
- Offer lifecycle status, current/superseded revision authority, and latest tenant decision are now rendered as three separate localized, textual fields. The client displays the server DTO values directly; it no longer replaces lifecycle status with a decision. Real-row and RU/EN component fixtures cover accepted plus paid and changes-requested plus superseded combinations.
- Ambiguous transport and 5xx action failures alone retain an immutable retry attempt. Known Task 5 conflicts and other 409 responses clear the attempt, await billing invalidation and authoritative refetch, show a precise non-retryable message, and never expose a dead Retry control. Validation and other 4xx responses are also non-retryable.
- A synchronous action lock prevents rapid double submission before React state commits. Tests prove exact trimmed change-request payload/key reuse, edit-to-new-key behavior, cross-action isolation, and one POST for a rapid double click.

## Review fix commits

- `d61c24e24` (`fix(billing): honor tenant offer decisions`) — added server-owned offer decision/current/actionable fields, immutable client attempts, billing-family invalidation, consistent destination navigation, and restored the mobile sidebar.
- `95b2ca085` (`fix(admin): clear billing filters and detail errors`) — made server filter keys removable and separated invoice detail 404/403/retryable errors.
- `b60158419` (`fix(admin): complete tenant billing review proof`) — completed RU/EN localization and behavioral/real-row contract proof without amending either prior fix.
- Current round-two commit (`fix(admin): separate offer authority and retry semantics`) — separates the composite offer authority fields and completes terminal-conflict, immutable-retry, action-switch, and synchronous-lock proof.

## Verification

- RED: the focused tests failed against the former invoice-only page and missing document/offer components.
- RED follow-up: 7 focused assertions failed before implementation (three live RU-to-EN renders, offer retry action, and the request-boundary control sequence); the original 17 focused behaviors remained green.
- GREEN follow-up: `node node_modules/vitest/vitest.mjs run test/billing-invoices.test.tsx test/billing-documents.test.tsx test/billing-offer-actions.test.tsx test/billing-task9-requests.test.tsx test/i18n.test.tsx` — 28 passed in 5 files.
- RED round two: `billing-offer-actions.test.tsx` ran 20 tests; 9 new assertions failed against the former combined-status and retry-all implementation while 11 existing/characterization assertions passed.
- GREEN round two: the full focused Task 9 admin and i18n command above now passes 38 tests in 5 files. The offer action file contributes 20 passing tests, including live RU/EN composite-authority rendering and all action retry/lock cases.
- `tenant-billing-read.service.test.ts` plus `tenant-billing-read.integration.test.ts` — 15 passed in 2 files against a uniquely named scratch PostgreSQL database, including the new schema-parsed offer-authority matrix. The suite dropped the scratch database during teardown.
- The round-two API contract run passed the same 15 tests with current-worktree `@markiro/db`, `@markiro/domain`, and `@markiro/platform-contracts` builds. Its isolated parent database `markiro_task9_round2_20260828_0845` and the integration suite's random child database were dropped; an exact post-run lookup returned zero for the parent database.
- Admin and API TypeScript passed with temporary paths to freshly built current-worktree package declarations. Temporary TypeScript, Vitest, and Vite configs were removed afterward and no shared dependency link was changed.
- Scoped ESLint, exact-file Prettier check, `git diff --check`, and the admin Vite production build passed. The build retained its existing large-chunk advisory.
- The hard-coded-string audit found no Russian literals or direct JSX labels/titles/ARIA strings in the three Task 9 page files.

## Not performed

- Browser visual verification is reserved for Task 13.
- Live API/object-storage authorization and signed-download confirmation require the configured external environment.
- The ordinary admin typecheck still resolves `@markiro/domain` through the inherited main-checkout symlink and reports the pre-existing missing Task 3 `BILLING_READ`/`BILLING_REQUEST` declarations. The required current-worktree declaration check passes without changing that shared link.
