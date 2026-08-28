# Task 8 Report: Tenant Billing Overview and Subscription

## Result

The tenant cabinet now renders the server-owned billing projection at `/billing`
and `/billing/subscription`. Both pages use the Task 4 DTO directly: no plan,
access, offer, or limit state is derived from `AccessDocument` in the client.
The retired settings subscription component was removed after the canonical
routes and component tests were migrated.

## RED / GREEN

- **RED:** `billing-overview.test.tsx` and the replacement subscription test
  initially failed to import `BillingOverviewPage` and `BillingSubscriptionPage`.
  The failing focused command therefore confirmed that neither page existed.
- **GREEN:** focused overview, subscription, and i18n checks pass: **3 files,
  11 tests**. They cover loaded data, unmanaged/empty, loading, request error,
  approaching/reached/exceeded limits, a bounded progress control, scheduled
  subscription, offer, operations, active request, add-ons, services, and the
  exact contextual capacity-request URL.

## Files and behavior

- `apps/admin/src/pages/billing/api.ts` owns Task 4 response types, stable
  `tenantBillingKeys`, overview/subscription fetch hooks, and the narrow shared
  post-action invalidation helper for overview, subscription, documents,
  requests, and offers.
- `BillingOverviewPage`, `BillingSubscriptionPage`, `BillingSections`, and
  `format` render the DTO with the only money/date formatting boundary.
- `app.tsx` replaces the billing index and subscription placeholders; the old
  `settings/SubscriptionPage.tsx` is deleted.
- RU and EN billing copy, scoped billing CSS, and focused page/route fixtures
  were added or updated.

## Visual and accessibility decisions

- The composition is deliberately compact and operational: current
  subscription, actionable offer, four limit cards, operations, and the active
  request appear in that order. Subscription detail adds scheduled change,
  add-ons, and services.
- Existing `Card`, `StatusChip`, `Button`, `Spinner`, and `EmptyState` are used
  with existing tokens only. Financial values use the scoped mono class; no new
  token, gradient, glass treatment, or entitlement-editing control was added.
- Every server state is shown through translated status-chip text and glyphs.
  Limit usage remains text-readable; progress is bounded to its assigned maximum
  so an exceeded limit never produces a negative or over-100% visual width.
- Capacity links are capability-gated and use
  `type=capacity_change&contextType=limit&contextId=<limit>`.

## Checks

- PASS — focused Vitest plus i18n: 3 files / 11 tests.
- PASS — admin TypeScript check with the temporary worktree-domain package link;
  the original dependency link was restored afterwards.
- PASS — admin ESLint: 0 errors; 5 pre-existing hook-dependency warnings remain
  in unrelated boxes/conflicts pages.
- PASS — production Vite build; the existing large-chunk advisory remains.
- PASS — scoped Prettier and `git diff --check`.

## Limits

- The existing `billing-routing.test.tsx` was updated with the new endpoints,
  but its Vitest process cannot start in this worktree: Vite rejects the
  already-installed parent-checkout `@fontsource/ibm-plex-mono` WOFF path before
  executing a test. Retrying with local escalation and with temporary current
  domain/UI links produced the same Vite filesystem denial. This is an
  environment dependency-boundary issue, not a test assertion failure.
- No browser/responsive screenshot, live API, or external billing workflow was
  run; browser visual confirmation remains Task 13.

## Commit

`feat(admin): show tenant subscription and billing overview`
