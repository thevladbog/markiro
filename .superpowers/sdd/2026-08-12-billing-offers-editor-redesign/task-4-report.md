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
- Root `pnpm format:check` was run before review round 1 and failed on six pre-existing files. The now-affected document-draft test was formatted with this fix; two plan files, two design-spec files, and `packages/ui/src/components/Combobox.tsx` remain unrelated formatting debt.

## Manual/external checks

No browser session or live platform API was exercised. Automated DOM coverage verifies routing and request behavior; visual browser verification remains separate.

## Review round 1

- Direct visits to `/billing/new` and `/offers/new` now follow the established create-route capability pattern: principals without `billing.write` are redirected to the corresponding read-only list before editor queries or editable controls mount.
- Offer-to-invoice copying now preserves every detail line. Catalog-backed lines keep their kind and activation policy; a legacy catalog-less line becomes the billing DTO's valid `custom` line with `catalogVersionId: null`, while retaining names, quantity, unit, agreed price, VAT terms, and ordering.
- Decimal offer VAT is converted to basis points from its string digits, without binary floating-point arithmetic (`"1.13"` becomes `113`).
- RED: the three focused files had four expected failures: two exposed direct-route editors, the legacy source line threw during rendering, and the draft adapter could not represent a custom invoice line.
- GREEN: `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/billing-editor.test.tsx test/offer-editor.test.tsx test/document-draft.test.ts` — 3 files, 28 tests passed.
- Affected verification: `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/billing-editor.test.tsx test/offer-editor.test.tsx test/document-composer.test.tsx test/document-draft.test.ts test/tenant-detail.test.tsx test/tenants.test.tsx` — 6 files, 57 tests passed. Typecheck, lint, build, targeted Prettier, and diff-check also passed.
