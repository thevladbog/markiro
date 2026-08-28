# Task 7 Report: Tenant Admin Billing Shell and Routing

## Result

Added the tenant-cabinet billing shell at `/billing`. It is discoverable and
readable only with `BILLING_READ`; its create-request action and direct
`/billing/requests/new` route additionally require `BILLING_REQUEST`.

The shell supplies the compact approved hierarchy: page heading, one primary
request action, five semantic tabs, and an outlet. Neutral route placeholders
keep the child-route contract ready for Tasks 8–10 without fabricating billing
state or fetching data before their typed query pages land.

The saved `/settings/subscription` route and subscription banner now point to
the canonical `/billing/subscription` tab.

## RED / GREEN

- **RED:** The new routing test initially could not compile because
  `BillingLayout` and the guarded billing route tree did not exist. The
  prescribed `pnpm` wrapper was also unavailable locally because its configured
  `@pnpm/exe@11.22.0` registry version could not be fetched.
- **GREEN:** `billing-routing.test.tsx` passes 7 assertions covering owner and
  admin discovery/action, manager and member non-discovery, the direct manager
  denial, the member capability boundary, `aria-current` tab semantics, and the
  legacy redirect. The banner and i18n regressions pass with it.

## Changed files

- `apps/admin/src/layout/AppShell.tsx` — billing sidebar item after cabinet
  access, filtered through `BILLING_READ`.
- `apps/admin/src/app.tsx` — canonical guarded child route tree and legacy
  subscription redirect.
- `apps/admin/src/pages/billing/BillingLayout.tsx` — shared header, capability
  gated CTA, semantic tabs, outlet, and neutral placeholder.
- `apps/admin/src/pages/billing/billing.css` — compact, token-backed layout;
  12px placeholder/card radius; narrow-width tab and card-grid stacking; focus
  styles.
- `apps/admin/src/subscription/SubscriptionBanner.tsx` and its test — canonical
  subscription link.
- `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json` — complete
  billing navigation and shell copy.
- `apps/admin/test/billing-routing.test.tsx` — route and capability coverage.

## Design decisions

- Reconciled the approved rendered reference with the current tenant admin:
  dense `AdminPage` composition, compact tabs, bordered placeholder surface,
  dark primary action, and no motion, gradients, glass effects, or new token
  layer.
- The token inventory contains `--surface-card`, not `--surface-1`; the shell
  therefore uses the existing former token with `--line`, `--fg-1`, `--fg-3`,
  `--accent`, and `--focus-ring` rather than adding an alias.
- The supplied Pen file contains only an empty frame, so the approved rendered
  reference and experience specification provided the usable visual source.

## Checks

- PASS — focused Vitest: `billing-routing`, `subscription-banner`, and i18n:
  3 files, 12 tests.
- PASS — `@markiro/admin` TypeScript no-emit check.
- PASS — `@markiro/admin` production build. Vite retained its existing
  large-chunk advisory only.
- PASS — ESLint for `apps/admin`: no errors; 5 pre-existing hook-dependency
  warnings in `boxes/index.tsx` and `conflicts/index.tsx`.
- PASS — Prettier check for scoped files and `git diff --check`.

The local worktree's untracked workspace symlinks resolve shared package output
from the parent checkout, which predates Task 1's new billing capabilities.
For checks, the `domain` and `ui` symlinks were temporarily pointed at this
worktree's already-built packages, then restored exactly; no dependency links
or generated artifacts are part of the change.

## Limits

No live browser, responsive visual screenshot, or API/server authorization run
was performed. Automated tests prove the client capability boundary; server
enforcement is supplied by the earlier billing API work and still requires its
own integration environment. Tasks 8–10 must replace the neutral placeholders
with their data-aware overview, subscription, invoice/document/offer, and
request pages.

## Commit

The final commit SHA is reported in the task handoff. A commit cannot contain
its own content-derived SHA without changing that SHA.

## Fix Round 1

### Review findings resolved

- Restored `InvoicesPage` and `InvoiceDetailPage` under the guarded billing
  layout, retaining their existing invoice fetches, ready-document download
  action, and `/billing/invoices` plus `/billing/invoices/:id` URLs. Focused
  route tests now prove both pages replace the temporary placeholder.
- An offer detail now marks the Documents tab current with `aria-current="page"`.
  Invoice and request detail retain the normal `NavLink` prefix matching.
- `SubscriptionBanner` now gates its billing link with `BILLING_READ`. A user
  without that capability receives translated recovery copy, never a link to a
  forbidden billing URL. Tests exercise this through the real app shell for an
  owner and manager.
- A billing reader without `BILLING_REQUEST` can use read routes but sees no
  create-request CTA and receives the established forbidden surface for
  `/billing/requests/new`.
- At widths up to 767px, the billing page uses the existing scoped mobile-shell
  pattern to hide the fixed sidebar and gives its labelled tab navigation an
  internal horizontal scroll rail. Links retain 40px touch targets and visible
  focus; this prevents the 224px sidebar from clipping the 320px workspace.

### Fix-round verification

- PASS — routing, banner, and i18n focused Vitest: 3 files, 18 tests.
- PASS — admin TypeScript no-emit check and production build (the existing
  Vite large-chunk advisory remains).
- PASS — admin ESLint without errors; the same 5 pre-existing hook-dependency
  warnings remain in unrelated `boxes` and `conflicts` pages.
- PASS — scoped Prettier and `git diff --check` after the final diff review.

No existing standalone admin invoice test file is present; the expanded real
route coverage is the regression proof added in this round. No live 320px
browser/visual confirmation was run; that remains separate from the source and
component evidence here.

## Fix Round 2

### Review finding resolved

- `InvoicesPage` and `InvoiceDetailPage` are used only beneath `BillingLayout`,
  so they now render embedded billing content rather than a second page header
  and fixed 28px/32px outer gutter. The shared layout owns the only `h1` and
  outer padding; each invoice route uses an `h2` section heading instead.
- Invoice tables retain their existing internal horizontal scroll surface while
  the content sections and document row use `min-width: 0`; the document action
  stacks below its label at narrow widths. This leaves the 320px spacing to the
  shared billing shell rather than adding a nested page gutter.
- The existing query, loading/error/empty states, canonical routes, invoice
  fields, and ready-document download path are unchanged. Route tests exercise
  the download response through `window.open` and assert one page-shell marker
  plus the semantic invoice subheading.

### RED / GREEN

- **RED:** the invoice route test observed two level-one headings before the
  refactor, proving the nested page-header regression.
- **GREEN:** the embedded route has one billing `h1`, an invoice `h2`, no nested
  admin page shell, fetches the real invoice fixtures, and opens the returned
  download URL for ready documents.

### Fix-round verification

- PASS — focused routing, subscription-banner, and i18n Vitest: 3 files,
  18 tests.
- PASS — admin TypeScript no-emit and production build. The build retains only
  the existing Vite large-chunk advisory.
- PASS — admin ESLint without errors; the same five unrelated hook-dependency
  warnings remain in `boxes` and `conflicts`.
- PASS — scoped Prettier and `git diff --check` after final review.

No live browser or 320px screenshot was run. The responsive result is verified
in source and DOM tests only; visual confirmation remains the separate browser
gate.
