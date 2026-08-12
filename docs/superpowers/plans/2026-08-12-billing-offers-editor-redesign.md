# Billing and Commercial Offer Editors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary one-line billing and commercial-offer forms with searchable, multi-line document composers and remove native selects from SaaS-admin.

**Architecture:** Add one accessible `Combobox` to `@markiro/ui`, then build a shared `DocumentComposer` in SaaS-admin around a reducer-owned draft and pure exact-money helpers. Thin invoice and offer route components configure the shared editor and submit their existing backend payloads; list/detail screens remain separate and commercial offers can prefill an invoice editor through explicit navigation state.

**Tech Stack:** React 19, React Router data routes, TanStack Query, Zod, Radix UI, `@markiro/ui`, vanilla CSS tokens, Vitest, Testing Library.

## Global Constraints

- Preserve the existing industrial Markiro visual language: IBM Plex Sans/Mono, warm light surfaces, one green accent, rigid grids, and tabular numerics.
- Do not change invoice or commercial-offer database semantics in this plan.
- Use only published catalog versions for new document lines.
- Support 1–100 lines; quantities are positive integers; money remains a two-decimal string.
- Client totals are previews; backend-returned totals are authoritative after creation.
- A plan or add-on line must expose an explicit supported activation policy.
- Long tenant and catalog lists use an accessible searchable combobox; short enumerations use the existing Radix `Select` without `native`.
- No `<select>` remains in `apps/saas-admin/src` after Task 5.
- Preserve unsaved form state after server errors and guard route/sign-out/unload navigation.
- Keep all visible controls at least 44 px high and contain mobile horizontal overflow within named table regions.
- Do not stage `.env`, `.playwright-mcp/`, `.pnpm-store/`, or unrelated dirty files.

---

### Task 1: Accessible searchable Combobox in `@markiro/ui`

**Files:**

- Create: `packages/ui/src/components/Combobox.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/src/index.ts`
- Modify: `packages/ui/src/styles.css`
- Create: `packages/ui/test/combobox.test.tsx`

**Interfaces:**

- Produces:
  ```ts
  export interface ComboboxOption<TValue extends string = string> {
    value: TValue;
    label: string;
    description?: string;
    group?: string;
    keywords?: readonly string[];
    disabled?: boolean;
  }

  export interface ComboboxProps<TValue extends string = string> {
    label: string;
    options: readonly ComboboxOption<TValue>[];
    value?: TValue;
    onValueChange: (value: TValue) => void;
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    loading?: boolean;
    disabled?: boolean;
    error?: string;
    className?: string;
  }
  ```
- Uses the existing `OverlayLayer` portal container so the popup works inside drawers and confirmation layers.
- Performs case-insensitive local filtering across `label`, `description`, `group`, and `keywords`.

- [ ] **Step 1: Write the failing combobox behavior tests**

  Add literal tests that render the real component and assert: trigger has `role="combobox"`; typing `production v3` leaves only the matching catalog option; ArrowDown/Enter selects it; Escape closes and restores trigger focus; grouped options expose group labels; loading and empty text are distinct; error is associated through `aria-describedby`.

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/ui exec vitest run test/combobox.test.tsx
  ```

  Expected: FAIL because `Combobox` is not exported.

- [ ] **Step 3: Implement the minimal component**

  Use Radix Popover plus a semantic input/listbox implementation. Keep filter state internal and emit only a value:

  ```tsx
  <button role="combobox" aria-expanded={open} aria-controls={listboxId}>…</button>
  <input role="searchbox" value={query} onChange={…} />
  <div id={listboxId} role="listbox">
    {filtered.map((option) => (
      <button role="option" aria-selected={option.value === value} onClick={…}>…</button>
    ))}
  </div>
  ```

  Implement roving active option, Enter selection, Escape close, and focus restoration without adding dependencies.

- [ ] **Step 4: Add intentional UI styling**

  Add `.mk-combobox*` rules using existing tokens: 44 px trigger, 360 px bounded popup, mono secondary descriptions, grouped section labels, selected green rail, hover/focus/pressed states, and a 390 px viewport-safe width.

- [ ] **Step 5: Verify and commit**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/ui test
  CI=true pnpm --filter @markiro/ui typecheck
  CI=true pnpm --filter @markiro/ui lint
  CI=true pnpm --filter @markiro/ui build
  ```

  Commit only Task 1 files:

  ```bash
  git commit -m "feat(ui): add searchable combobox"
  ```

---

### Task 2: Pure document draft model and exact preview totals

**Files:**

- Create: `apps/saas-admin/src/pages/documents/types.ts`
- Create: `apps/saas-admin/src/pages/documents/documentDraft.ts`
- Create: `apps/saas-admin/test/document-draft.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type DocumentKind = "invoice" | "offer";
  export type ActivationPolicy = "immediate" | "after_current" | "manual";

  export interface DocumentLineDraft {
    id: string;
    kind: "plan" | "addon" | "service";
    catalogVersionId: string;
    catalogItemCode: string;
    version: number;
    nameRu: string;
    nameEn: string;
    quantity: number;
    unit: string;
    agreedUnitPrice: string;
    vatRateBps: number | null;
    vatIncluded: boolean;
    activationPolicy: ActivationPolicy | null;
  }

  export interface DocumentDraft {
    tenantId: string;
    applicationMode: "manual" | "automatic";
    date: string;
    lines: DocumentLineDraft[];
  }

  export type DocumentDraftAction =
    | { type: "tenant.selected"; tenantId: string }
    | { type: "catalog.added"; version: CatalogVersionDto; separate?: boolean }
    | { type: "line.quantityChanged"; id: string; quantity: number }
    | { type: "line.priceChanged"; id: string; price: string }
    | { type: "line.vatIncludedChanged"; id: string; included: boolean }
    | { type: "line.policyChanged"; id: string; policy: ActivationPolicy }
    | { type: "line.moved"; id: string; direction: -1 | 1 }
    | { type: "line.removed"; id: string };

  export function documentDraftReducer(
    draft: DocumentDraft,
    action: DocumentDraftAction,
  ): DocumentDraft;
  export function calculateDocumentTotals(lines: readonly DocumentLineDraft[]): {
    subtotal: string;
    vatTotal: string;
    total: string;
  };
  export function validateDocumentDraft(draft: DocumentDraft): Record<string, string>;
  ```

- [ ] **Step 1: Write failing reducer and money tests**

  Assert literal outcomes for: adding plan/add-on/service; selecting the same version increments quantity; `separate: true` creates a second line; removal; move boundaries; invalid quantity; exact VAT-included `120.00` at 20% produces subtotal `100.00`, VAT `20.00`, total `120.00`; VAT-excluded `100.00` produces total `120.00`; mixed totals; no floating-point artifacts.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-draft.test.ts
  ```

  Expected: FAIL because the document draft module does not exist.

- [ ] **Step 3: Implement reducer and integer-cent helpers**

  Parse `/^\d{1,12}\.\d{2}$/` into bigint cents. Mirror backend VAT arithmetic exactly and return two-decimal strings. Use stable client IDs generated at the action boundary; keep the reducer deterministic by accepting the completed line identity in tests or via a `createLineFromCatalog(version, id)` helper.

- [ ] **Step 4: Implement validation and payload adapters**

  Add:

  ```ts
  export function toInvoiceCreateInput(draft: DocumentDraft): CreateInvoiceInput;
  export function toOfferCreateInput(draft: DocumentDraft): CreateOfferInput;
  ```

  The invoice maps `immediate` directly; the offer adapter maps `immediate` to backend `immediately`. Service policies are `null`.

- [ ] **Step 5: Verify and commit**

  Run the focused file and SaaS-admin typecheck. Commit:

  ```bash
  git commit -m "feat(saas-admin): add document draft model"
  ```

---

### Task 3: Shared multi-line DocumentComposer

**Files:**

- Create: `apps/saas-admin/src/pages/documents/DocumentComposer.tsx`
- Create: `apps/saas-admin/src/pages/documents/DocumentLinesTable.tsx`
- Create: `apps/saas-admin/src/pages/documents/DocumentSummary.tsx`
- Create: `apps/saas-admin/src/pages/documents/CatalogPositionPicker.tsx`
- Create: `apps/saas-admin/src/pages/documents/TenantPicker.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/document-composer.test.tsx`

**Interfaces:**

- Consumes `Combobox`, `DocumentDraft`, reducer, totals, validation, `TenantListItem[]`, and `CatalogVersionDto[]`.
- Produces:

  ```ts
  export interface DocumentComposerProps {
    kind: "invoice" | "offer";
    initialDraft?: DocumentDraft;
    tenants: readonly TenantListItem[];
    catalog: readonly CatalogVersionDto[];
    loadingSources: boolean;
    submitting: boolean;
    submitError?: string;
    onSubmit: (draft: DocumentDraft) => Promise<void>;
    onCancel: () => void;
  }
  ```

- [ ] **Step 1: Write failing end-user behavior tests**

  Test the real composer with 3 literal catalog records. Assert tenant search by name/slug; catalog search by RU name/code/`v3`; adding three kinds; duplicate increment; separate-line action; edit quantity and price; remove/move; plan/add-on policy controls; service has no policy; literal subtotal/VAT/total; submit receives all lines in visible order; no native `select`; submit error preserves every value.

- [ ] **Step 2: Run test and verify RED**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-composer.test.tsx
  ```

  Expected: FAIL because `DocumentComposer` is missing.

- [ ] **Step 3: Implement semantic editor structure**

  Use:

  ```tsx
  <form className="document-composer" onSubmit={…}>
    <section className="document-composer__workspace" aria-labelledby="document-lines-title">…</section>
    <aside className="document-summary" aria-labelledby="document-summary-title">…</aside>
  </form>
  ```

  Use `TenantPicker` and `CatalogPositionPicker` comboboxes. Use the shared `Select` without `native` for application mode, line policy, and VAT preset.

- [ ] **Step 4: Implement the line table and empty state**

  Render a named, focusable table region. On an empty draft, show one composed onboarding row with the catalog picker rather than an empty card. Each remove button must be named `Удалить <position name>`; move buttons are disabled at boundaries.

- [ ] **Step 5: Implement the sticky summary and navigation guard**

  Call `useNavigationGuard(dirty, submitting)`. Summary uses `aria-live="polite"`, displays line count/subtotal/VAT/total, and lists blocking errors. Main action reads `Создать черновик счёта` or `Создать черновик предложения`.

- [ ] **Step 6: Add industrial editor CSS**

  Use a `minmax(0, 1fr) minmax(18rem, 0.34fr)` grid, a 1 px vertical rule, sticky summary, tabular numbers, green selected rail, restrained hover/pressed transitions, and no inline layout styles. At 900 px collapse the summary below; at 390 px keep page width exact and scroll only the line table.

- [ ] **Step 7: Verify and commit**

  Run focused composer/draft tests, typecheck, lint, and build. Commit:

  ```bash
  git commit -m "feat(saas-admin): add multi-line document composer"
  ```

---

### Task 4: Invoice and offer creation routes

**Files:**

- Create: `apps/saas-admin/src/pages/billing/CreateInvoicePage.tsx`
- Create: `apps/saas-admin/src/pages/offers/CreateOfferPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/BillingPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Modify: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/api.ts`
- Modify: `apps/saas-admin/src/pages/tenants/TenantPage.tsx`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/billing-editor.test.tsx`
- Create: `apps/saas-admin/test/offer-editor.test.tsx`

**Interfaces:**

- Routes:
  ```tsx
  <Route path="/billing/new" element={<CreateInvoicePage />} />
  <Route path="/offers/new" element={<CreateOfferPage />} />
  ```
- Query parameters: `tenantId` prefills a tenant. Router state `sourceOfferId` loads offer detail and prefills invoice lines.
- `createInvoice(input: CreateInvoiceInput)` and `createOffer(input: CreateOfferInput)` use explicit typed inputs rather than `unknown`.

- [ ] **Step 1: Write failing invoice route tests**

  Assert `/billing` has a header action linking to `/billing/new`; `/billing/new?tenantId=<id>` preselects the tenant; three lines submit one exact `POST /api/platform/invoices` payload; success navigates to `/billing` with a created-document notice; a 409 leaves the editor intact.

- [ ] **Step 2: Write failing offer route tests**

  Assert `/offers/new` uses the same multi-line behavior and exact offer activation-policy mapping; published offer detail action opens `/billing/new` with `sourceOfferId`; the invoice editor loads `GET /offers/:id` and copies all literal lines, not the summary row.

- [ ] **Step 3: Run both files and verify RED**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/saas-admin exec vitest run test/billing-editor.test.tsx test/offer-editor.test.tsx
  ```

  Expected: FAIL because the creation routes/components do not exist.

- [ ] **Step 4: Implement typed API boundaries and routes**

  Add Zod response/input schemas where current functions accept `unknown`. Fetch tenants with `limit=100`, published catalog versions once per editor, and offer detail only when `sourceOfferId` is present. Do not silently truncate a selected tenant outside page 1: if a valid prefilled ID is missing from the page, fetch its detail and append a picker option.

- [ ] **Step 5: Simplify list screens**

  Remove the inline temporary create cards and their local state. Keep list/loading/error/detail actions; put `Создать счёт` and `Создать предложение` in each `PageHeader.actions` slot. From tenant detail, add both actions with the tenant query parameter.

- [ ] **Step 6: Verify and commit**

  Run both focused files plus existing billing/offers/tenant tests, typecheck, lint, and build. Commit:

  ```bash
  git commit -m "feat(saas-admin): add invoice and offer creation routes"
  ```

---

### Task 5: Remove native selects across SaaS-admin

**Files:**

- Modify: `apps/saas-admin/src/pages/team/TeamPage.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVatField.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogUnitField.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/AddonEffectsEditor.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/TenantsPage.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/test/team.test.tsx`
- Modify: `apps/saas-admin/test/catalog.test.tsx`
- Modify: `apps/saas-admin/test/tenants.test.tsx`
- Modify: `apps/saas-admin/test/tenant-detail.test.tsx`
- Create: `apps/saas-admin/test/custom-controls.test.tsx`

**Interfaces:**

- Short lists use `Select` with Radix defaults.
- Tenant and catalog search use `Combobox` from Task 1.
- No production SaaS-admin component renders a native `select`.

- [ ] **Step 1: Write failing integration tests for custom controls**

  Render team, catalog, tenant list, and subscription assignment routes. Assert `document.querySelectorAll("select")` is empty, each control opens through a combobox/button trigger, keyboard selection changes the user-visible value, and role/assignment mutations still send exact values.

- [ ] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  CI=true pnpm --filter @markiro/saas-admin exec vitest run test/custom-controls.test.tsx
  ```

  Expected: FAIL with native selects found.

- [ ] **Step 3: Replace direct `<select>` and `native` usages**

  Replace the two team selectors and remove every `native` prop found by:

  ```bash
  rg -n '<select|<Select[^>]*native|native\s*$|native=' apps/saas-admin/src -g '*.tsx'
  ```

  Preserve labels, disabled/loading behavior, exact values, and mutation calls. Remove obsolete `.native-field select` CSS only after no consumer remains.

- [ ] **Step 4: Verify affected suites and commit**

  Run team, catalog, tenants, tenant-detail, and custom-control tests; typecheck and lint. Commit:

  ```bash
  git commit -m "refactor(saas-admin): replace native selects"
  ```

---

### Task 6: Final validation and browser acceptance

**Files:**

- Modify only files required by defects found during validation.

**Interfaces:**

- No new interfaces. This task verifies the complete design contract.

- [ ] **Step 1: Run complete package gates**

  ```bash
  CI=true pnpm --filter @markiro/ui test
  CI=true pnpm --filter @markiro/ui typecheck
  CI=true pnpm --filter @markiro/ui lint
  CI=true pnpm --filter @markiro/ui build
  CI=true pnpm --filter @markiro/saas-admin test
  CI=true pnpm --filter @markiro/saas-admin typecheck
  CI=true pnpm --filter @markiro/saas-admin lint
  CI=true pnpm --filter @markiro/saas-admin build
  CI=true pnpm format:check
  git diff --check
  ```

- [ ] **Step 2: Run desktop browser acceptance at 1280×800**

  Verify invoice and offer editors with 3 mixed lines: tenant/catalog search, keyboard-only selection, duplicate increment, separate line, move/remove, exact visible totals, unsaved navigation confirmation, submit error preservation, and no console error/warning. Measure document width equals client width and one `h1` exists.

- [ ] **Step 3: Run mobile browser acceptance at 390×844**

  Verify page scroll width equals client width; table region contains its own overflow and is focusable; summary follows the table; every visible interactive target is at least 44 px; combobox popup fits the viewport; no control is clipped.

- [ ] **Step 4: Run mutation review**

  Confirm a test fails for each realistic regression: line adapter drops the second line; duplicate creates another line; VAT flips included/excluded; offer policy sends `immediate` instead of `immediately`; source offer uses list summary without details; a native select returns; dirty guard is removed.

- [ ] **Step 5: Commit validation fixes**

  Stage explicit affected paths, inspect `git diff --cached`, and commit:

  ```bash
  git commit -m "fix(saas-admin): polish document editor workflows"
  ```
