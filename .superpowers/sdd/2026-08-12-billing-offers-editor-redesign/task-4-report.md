# Task 4 — Invoice and offer creation routes

## Delivered

- Added `/billing/new` and `/offers/new`, each backed by the shared `DocumentComposer` and the Task 3 typed draft adapters.
- Replaced the temporary inline creation cards with capability-gated page-header actions, including tenant-detail actions that prefill `tenantId`.
- Added typed Zod request/response boundaries for invoice and offer creation, offer summary/detail loading, and exact offer-detail prefill for invoice-from-offer.
- Loads catalog versions once per editor and exposes only published versions. Tenant picker requests `limit=100`; a valid prefilled tenant outside that page is loaded through the existing tenant-detail boundary and appended to the picker.
- Preserves a failed 409 draft and lets the next navigation through the global dirty-draft guard only after a successful create. Success returns to the respective list with a created notice.

## TDD evidence

1. RED: `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/billing-editor.test.tsx test/offer-editor.test.tsx` failed all four initial scenarios because the page-header actions and creation routes did not exist.
2. GREEN: the focused and affected suite passes with literal three-line invoice/offer payload assertions, offer activation-policy mapping, source-offer detail prefill, out-of-page tenant prefill, and 409 draft preservation.

## Verification

- `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/billing-editor.test.tsx test/offer-editor.test.tsx test/document-composer.test.tsx test/document-draft.test.ts test/tenant-detail.test.tsx test/tenants.test.tsx` — 6 files, 54 tests passed.
- `pnpm --filter @markiro/saas-admin typecheck` — passed.
- `pnpm --filter @markiro/saas-admin lint` — passed.
- `pnpm --filter @markiro/saas-admin build` — passed.
- Targeted `prettier --check` on all Task 4 files and `git diff --check` — passed.
- Root `pnpm format:check` was run and fails only on six pre-existing unrelated files: `apps/saas-admin/test/document-draft.test.ts`, two plan files, two design-spec files, and `packages/ui/src/components/Combobox.tsx`. None is changed by Task 4.

## Manual/external checks

No browser session or live platform API was exercised. Automated DOM coverage verifies routing and request behavior; visual browser verification remains separate.
