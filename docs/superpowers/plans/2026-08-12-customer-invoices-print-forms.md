# Customer Invoice Cabinet and Printable Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate immutable HTML/PDF forms for invoices and commercial offers, add safe offer terms editing, and let a tenant download only its own invoices from `apps/admin`.

**Architecture:** Extend the existing billing document metadata only for invoice format/revision handling and add tenant-scoped offer publication snapshots and artifacts. A shared server-side print model feeds both HTML and PDF renderers; no browser client calculates document content. Platform controllers handle offer and invoice documents, while a dedicated tenant controller derives the tenant only from the authenticated cabinet session.

**Tech Stack:** NestJS, Drizzle/PostgreSQL, Zod, existing private S3-compatible `ObjectStorageService`, `@react-pdf/renderer`, `markdown-it`, `sanitize-html`, React/Vite, MDXEditor, Vitest, Testing Library.

## Global Constraints

- Add only new migrations after the current applied billing migrations; never edit historical SQL or snapshots.
- Keep invoice snapshots immutable after `issue`; freeze an offer print snapshot exactly at `publish`.
- Generate HTML and PDF from one `PrintDocumentModel`; use a bundled Cyrillic-capable TTF font for PDF, never a host font.
- Store only private object keys; never return keys, signed URLs, raw Markdown, or banking/audit fields to the customer cabinet.
- Generate a signed download URL for at most 300 seconds after capability/tenant ownership checks.
- Offer terms support headings, paragraphs, bold, italic, ordered/unordered lists, links, and tables only; reject or strip raw HTML, image, attachment, iframe, inline-style, event-handler, and unsafe-URL content.
- Preserve the existing industrial UI language, 44 px controls, keyboard access, local table overflow, and RU/EN copy.
- Add JavaScript dependencies through pnpm with exact versions; inspect the lockfile diff and license before committing.
- Rebuild `@markiro/db` before every API consumer test after schema changes.
- Do not stage `.env`, local stores, generated `dist`, or unrelated worktree changes.

---

### Task 1: Immutable offer print state and document schema

**Files:**

- Modify: `packages/db/src/schema/saas.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0035_offer_print_documents.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/offer-print-documents-schema.test.ts`
- Modify: `packages/db/test/migration-runtime.test.ts`

**Interfaces:**

- Produces `commercialOfferPrintSnapshots` with exactly one immutable snapshot per
  `(tenantId, offerId, revision)`: number, published date, expiry date, seller/buyer JSONB,
  terms Markdown, sanitized terms HTML, exact totals and line JSONB.
- Produces `commercialOfferDocuments` with `(offerId, revision, format)` uniqueness,
  `pending|ready|failed`, checksum, byte size, renderer version and private object key.
- Adds nullable draft-only `commercialOffers.termsMarkdown`; adds a unique human-readable
  `commercialOffers.number` assigned at publication.

- [ ] **Step 1: Write failing DB schema tests** for offer number uniqueness, one tenant-scoped
      snapshot per publication revision, one document per format/revision, positive revision,
      ready-document metadata, composite tenant foreign keys, and legacy drafts with null number/terms.

- [ ] **Step 2: Run the focused DB test and capture RED.**

  Run: `pnpm --filter @markiro/db exec vitest run test/offer-print-documents-schema.test.ts`

  Expected: failure because the print snapshot/documents schema is absent.

- [ ] **Step 3: Add the Drizzle schema.** Define the snapshot and artifact tables with the
      constraints above. Use JSONB only for the frozen render payload; live offer lines remain in
      `commercialOfferLines`. Do not add a customer-visible offer relation.

- [ ] **Step 4: Generate additive migration `0035_offer_print_documents.sql`.** Inspect that
      it creates tables/indexes/checks without altering migrations 0030–0034 and that existing offer
      drafts can remain unnumbered.

- [ ] **Step 5: Run migration and schema tests, then rebuild DB.**

  Run:

  ```bash
  pnpm --filter @markiro/db db:migrate
  pnpm --filter @markiro/db exec vitest run test/offer-print-documents-schema.test.ts test/migration-runtime.test.ts
  pnpm --filter @markiro/db build
  ```

- [ ] **Step 6: Commit the isolated schema deliverable.**

  ```bash
  git add packages/db/src/schema/saas.ts packages/db/src/schema.ts packages/db/migrations/0035_offer_print_documents.sql packages/db/migrations/meta packages/db/test
  git commit -m "feat(db): add commercial offer print documents"
  ```

### Task 2: Safe Markdown terms boundary and WYSIWYG editor

**Files:**

- Modify: `apps/api/package.json`
- Modify: `apps/saas-admin/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/modules/platform-offers/offer-terms.ts`
- Modify: `apps/api/src/modules/platform-offers/dto.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Create: `apps/api/test/offer-terms.test.ts`
- Create: `apps/saas-admin/src/pages/offers/OfferTermsEditor.tsx`
- Modify: `apps/saas-admin/src/pages/offers/CreateOfferPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/api.ts`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/offer-terms-editor.test.tsx`

**Interfaces:**

- `normalizeOfferTerms(markdown: string | null): { markdown: string | null; html: string | null }`
  accepts at most 20,000 characters and produces deterministic safe HTML.
- `CreateOfferDto` accepts nullable `termsMarkdown`; a draft preserves source Markdown only.
- `OfferTermsEditor` exposes `value`, `onChange(markdown)`, `label`, and `error`; it emits
  Markdown and uses MDXEditor plugins only for headings, basic formatting, lists, links and tables.

- [ ] **Step 1: Add exact dependencies with the package manager.** Add `markdown-it` and
      `sanitize-html` to API and `@mdxeditor/editor` to SaaS-admin with pnpm; inspect the lockfile,
      package licenses and transitive dependency count before retaining the change.

- [ ] **Step 2: Write RED API tests for terms normalization.** Cover an allowed heading/list/link/table;
      raw `<script>`, `javascript:` URL, image, iframe and inline event handler removal; empty input;
      20,001-character rejection; deterministic same-input output. Assert the response never echoes
      generated unsafe HTML.

- [ ] **Step 3: Run the focused terms test and verify RED.**

  Run: `pnpm --filter @markiro/api exec vitest run test/offer-terms.test.ts`

  Expected: missing normalizer or unsafe source is accepted.

- [ ] **Step 4: Implement the bounded Markdown parser/sanitizer.** Disable HTML input in
      `markdown-it`; use an allowlist for only the required structural tags/attributes and `https:`,
      `http:`, and `mailto:` links. Persist normalized Markdown in draft creation, but create frozen
      HTML only during publication.

- [ ] **Step 5: Write and run the editor RED.** Render the real editor and assert toolbar commands
      produce Markdown for bold/list/link/table, preview renders safe output, and labels/errors are
      keyboard-addressable.

  Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/offer-terms-editor.test.tsx`

- [ ] **Step 6: Implement the terms field in the offer composer.** Use MDXEditor client-side with
      only approved plugins and a labelled preview. Preserve the draft through server errors; do not
      add source/HTML toggles, image upload, or raw HTML mode.

- [ ] **Step 7: Run focused API/UI checks and commit.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/offer-terms.test.ts
  pnpm --filter @markiro/saas-admin exec vitest run test/offer-terms-editor.test.tsx
  pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/saas-admin typecheck
  git add apps/api apps/saas-admin package.json pnpm-lock.yaml
  git commit -m "feat(offers): add safe proposal terms editor"
  ```

### Task 3: Shared immutable print model and renderers

**Files:**

- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/modules/billing/print-document-model.ts`
- Create: `apps/api/src/modules/billing/print-document-html.ts`
- Create: `apps/api/src/modules/billing/print-document-pdf.tsx`
- Create: `apps/api/src/modules/billing/assets/IBMPlexSans-Regular.ttf`
- Create: `apps/api/src/modules/billing/assets/IBMPlexSans-SemiBold.ttf`
- Create: `apps/api/test/print-document-model.test.ts`
- Create: `apps/api/test/print-document-renderer.test.ts`

**Interfaces:**

- `type PrintDocumentModel = { kind: "invoice" | "offer"; number: string; status: string;
issuedOrPublishedAt: Date; dueOrExpiresAt: Date | null; seller: BillingProfileSnapshot;
buyer: BillingProfileSnapshot; lines: PrintLine[]; subtotal: string; vatTotal: string;
total: string; termsHtml: string | null }`.
- `toInvoicePrintModel(invoiceDetail)` and `toOfferPrintModel(snapshot)` read only frozen data.
- `renderPrintHtml(model): string` and `renderPrintPdf(model): Promise<Buffer>` produce the same
  textual facts, totals and terms from the model.

- [ ] **Step 1: Add `@react-pdf/renderer` via pnpm and commit only its reviewed exact lockfile
      resolution with the task.** Bundle OFL-licensed IBM Plex Sans TTF files in the API source tree;
      verify their SHA-256 in the asset test rather than relying on a developer machine font.

- [ ] **Step 2: Write failing print-model tests.** Use literal seller/buyer snapshots and mixed
      VAT lines. Assert number/date/status, every row, subtotal/VAT/total, signature/print labels,
      offer expiry/disclaimer, invoice due date, safe terms placement, and that live profile/catalog
      readers are never called.

- [ ] **Step 3: Run the model test and capture RED.**

  Run: `pnpm --filter @markiro/api exec vitest run test/print-document-model.test.ts test/print-document-renderer.test.ts`

  Expected: missing model/renderers.

- [ ] **Step 4: Implement the shared model and HTML renderer.** Escape all text, inject only
      sanitizer-produced `termsHtml`, format money/dates with deterministic RU rules, and put
      `@media print` page rules in the emitted document. Mark the offer with the exact disclaimer
      «Не является счетом на оплату».

- [ ] **Step 5: Implement the PDF renderer from that same model.** Register the bundled TTF
      fonts, create a stable A4 layout with repeated table header and signature blocks, and reject
      output larger than 10 MiB. Do not invoke a browser, external process, or runtime network.

- [ ] **Step 6: Make renderer tests pass.** Assert a valid `%PDF-` header, Cyrillic text in HTML,
      a deterministic content checksum for a fixed model, and that HTML/PDF contain the same line
      count/totals.

- [ ] **Step 7: Commit the renderer.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/print-document-model.test.ts test/print-document-renderer.test.ts
  pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api build
  git add apps/api/package.json pnpm-lock.yaml apps/api/src/modules/billing apps/api/test
  git commit -m "feat(billing): render immutable printable documents"
  ```

### Task 4: Invoice and offer document lifecycle APIs

**Files:**

- Modify: `apps/api/src/modules/billing/billing-documents.service.ts`
- Modify: `apps/api/src/modules/billing/billing.service.ts`
- Modify: `apps/api/src/modules/billing/billing.controller.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.service.ts`
- Modify: `apps/api/src/modules/platform-offers/platform-offers.controller.ts`
- Modify: `apps/api/src/modules/platform-offers/dto.ts`
- Modify: `apps/api/src/modules/billing/billing.module.ts`
- Create: `apps/api/test/billing-documents.e2e.test.ts`
- Create: `apps/api/test/offer-documents.e2e.test.ts`

**Interfaces:**

- `BillingDocumentsService.renderInvoice(invoiceId, revision)` renders both `html` and `pdf`,
  inserts pending rows before storage, and advances each artifact independently to `ready|failed`.
- `OfferDocumentsService.publishAndRender(actor, offerId)` locks the draft, allocates an offer
  number, loads current billing profiles, writes a frozen snapshot, changes status to published,
  then renders both formats.
- Platform routes: `GET/POST /platform/invoices/:id/documents`,
  `GET /platform/invoices/:id/documents/:documentId/download`,
  `GET/POST /platform/offers/:id/documents`, and
  `GET /platform/offers/:id/documents/:documentId/download`.

- [ ] **Step 1: Write invoice document lifecycle RED tests.** Assert issue creates HTML/PDF
      pending artifacts, render creates revision 1 without overwriting existing ready bytes, failed
      PDF retry becomes a new revision, capability denial works, and a profile/catalog change after
      issue leaves both rendered facts unchanged.

- [ ] **Step 2: Write offer publication/document RED tests.** Assert publish requires current
      seller/buyer profiles, allocates a unique number, freezes lines/totals/terms, marks the offer
      published atomically, renders both files, exposes no signed URL in metadata, and cancellation
      does not delete documents.

- [ ] **Step 3: Run both focused e2e tests with configured local PostgreSQL and capture RED.**

  ```bash
  pnpm --filter @markiro/db build
  pnpm --filter @markiro/api exec vitest run test/billing-documents.e2e.test.ts test/offer-documents.e2e.test.ts
  ```

- [ ] **Step 4: Replace the current one-off invoice HTML storage path.** Build both artifacts
      from `PrintDocumentModel`, content-address them by tenant/document/revision/format, save
      checksum/MIME/size/renderer version, and leave `failed` metadata when storage or rendering
      throws. Never return object keys or URLs in list/detail payloads.

- [ ] **Step 5: Implement offer publication snapshots and documents.** Keep the existing publish
      semantics for state/capability/audit, extend its transaction with number/snapshot creation,
      and call rendering only after the committed snapshot can be re-read. A retry always creates
      `max(revision)+1`, never overwrites a ready revision.

- [ ] **Step 6: Add precise download and retry controllers.** Validate document ID and format,
      reload ownership/capability immediately before `presignRead(key, 300)`, and expose only a
      short-lived URL. Return a stable `*_document_not_ready` code for pending/failed artifacts.

- [ ] **Step 7: Run affected API gates and commit.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/billing-documents.e2e.test.ts test/offer-documents.e2e.test.ts
  pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
  git add apps/api/src/modules/billing apps/api/src/modules/platform-offers apps/api/test
  git commit -m "feat(api): publish billing and offer documents"
  ```

### Task 5: Tenant-scoped invoice read/download boundary

**Files:**

- Create: `apps/api/src/modules/tenant-billing/tenant-billing.module.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-invoices.controller.ts`
- Create: `apps/api/src/modules/tenant-billing/tenant-invoices.service.ts`
- Create: `apps/api/test/tenant-invoices.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- `GET /tenant/invoices` returns only `issued|paid|cancelled` summary fields:
  `id`, `number`, `status`, `issueDate`, `dueDate`, `total`, and ready document formats.
- `GET /tenant/invoices/:id` returns the frozen invoice lines/totals and ready document metadata.
- `GET /tenant/invoices/:id/documents/:documentId/download` returns `{ url }` after tenant
  ownership and ready-state checks; unknown/cross-tenant IDs share the same not-found response.

- [ ] **Step 1: Write failing tenant API e2e tests.** Create two tenant fixtures and assert
      list excludes draft and other tenant rows; detail has frozen lines but no seller/buyer raw JSON,
      platform actor, payment import, audit, object key or offer; ready HTML/PDF download works;
      pending/failed/cross-tenant documents do not leak.

- [ ] **Step 2: Run the focused tenant test and capture RED.**

  Run: `pnpm --filter @markiro/api exec vitest run test/tenant-invoices.e2e.test.ts`

  Expected: missing tenant billing route or unscoped response.

- [ ] **Step 3: Implement the service with session-derived tenant identity.** Reuse the existing
      tenant route guard pattern, constrain every select by the authenticated organization ID, map
      rows into the explicit customer DTO, and delegate presigning to the document service only after
      scoped lookup.

- [ ] **Step 4: Register the module and controller.** Document customer routes in OpenAPI without
      platform document endpoints, and add non-leaking error-code mapping.

- [ ] **Step 5: Run focused tests and API static gates, then commit.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/tenant-invoices.e2e.test.ts
  pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
  git add apps/api/src/modules/tenant-billing apps/api/src/app.module.ts apps/api/test/tenant-invoices.e2e.test.ts
  git commit -m "feat(api): expose tenant invoice documents"
  ```

### Task 6: Operator document controls and offer terms UX

**Files:**

- Modify: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/api.ts`
- Modify: `apps/saas-admin/src/pages/billing/BillingPage.tsx`
- Modify: `apps/saas-admin/src/pages/billing/api.ts`
- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Create: `apps/saas-admin/test/document-actions.test.tsx`

**Interfaces:**

- Typed Zod clients expose document metadata with `id`, `format`, `revision`, `status`,
  `createdAt`, and never `objectKey` or signed URL until an explicit download call.
- Operator list/detail controls expose HTML/PDF download and retry only under billing capability;
  retry is confirmation-gated and disabled for ready documents.

- [ ] **Step 1: Write component RED tests.** Cover terms preservation from draft through publish,
      pending/failed/ready rows, explicit retry confirmation, PDF/HTML downloads, disabled
      no-capability state, exact error copy, and no native select or object key leakage.

- [ ] **Step 2: Run the focused UI test and capture RED.**

  Run: `CI=true pnpm --filter @markiro/saas-admin exec vitest run test/document-actions.test.tsx`

  Expected: missing document metadata/actions or terms controls.

- [ ] **Step 3: Implement typed query/mutation boundaries.** Parse platform responses with Zod,
      open only the returned signed URL with a user-initiated link, invalidate the exact invoice/offer
      detail query after retry, and leave the editor draft intact on validation/render errors.

- [ ] **Step 4: Implement visual states.** Use existing status tokens and confirmation dialog;
      provide a semantic table region with mobile-local overflow, 44 px download/retry controls, and
      keyboard-visible focus.

- [ ] **Step 5: Run package gates and commit.**

  ```bash
  pnpm --filter @markiro/saas-admin exec vitest run test/offer-terms-editor.test.tsx test/document-actions.test.tsx
  pnpm --filter @markiro/saas-admin test
  pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint && pnpm --filter @markiro/saas-admin build
  git add apps/saas-admin
  git commit -m "feat(saas-admin): manage printable billing documents"
  ```

### Task 7: Customer invoice cabinet UI and integrated verification

**Files:**

- Create: `apps/admin/src/pages/billing/api.ts`
- Create: `apps/admin/src/pages/billing/InvoicesPage.tsx`
- Create: `apps/admin/src/pages/billing/InvoiceDetailPage.tsx`
- Create: `apps/admin/src/pages/billing/billing.css`
- Create: `apps/admin/test/billing-invoices.test.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/api/test/print-document-flow.e2e.test.ts`
- Create: `.superpowers/sdd/2026-08-12-customer-invoices-print-forms/task-report.md`

**Interfaces:**

- `listTenantInvoices()` and `getTenantInvoice(id)` parse the explicitly reduced customer DTO.
- Routes `/billing/invoices` and `/billing/invoices/:id` are inside the existing customer shell
  and tenant access boundary.

- [ ] **Step 1: Write customer UI RED tests.** Assert loading, empty, ready document download,
      pending/failed document messaging, invoice table keyboard scroll, one `h1`, detail lines/totals,
      no offer/bank/audit/platform fields, and a denied request state.

- [ ] **Step 2: Run the focused UI test and capture RED.**

  Run: `CI=true pnpm --filter @markiro/admin exec vitest run test/billing-invoices.test.tsx`

  Expected: routes and typed API client are absent.

- [ ] **Step 3: Implement the typed API client and two routes.** Mount them inside the existing
      authenticated app shell, add a single navigation item for invoices, and show only server-provided
      summary/detail facts. The download control calls the tenant endpoint only after explicit click.

- [ ] **Step 4: Implement responsive/accessibility styling.** Keep the document list table inside
      a labelled horizontal-scroll region below 900 px; use status text/icons rather than colour only;
      ensure every visible action is at least 44 px.

- [ ] **Step 5: Write the configured cross-layer API RED/green test.** The flow creates profiles,
      creates/issues an invoice, renders both formats, changes profiles/catalog, proves bytes/checksum
      invariant, verifies tenant list/detail/download, publishes an offer with Markdown terms and
      proves the offer cannot enter tenant routes.

- [ ] **Step 6: Run final verification.**

  ```bash
  pnpm --filter @markiro/db build && pnpm --filter @markiro/db test
  pnpm --filter @markiro/api exec vitest run test/print-document-flow.e2e.test.ts
  pnpm --filter @markiro/api test && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint && pnpm --filter @markiro/api build
  pnpm --filter @markiro/saas-admin test && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint && pnpm --filter @markiro/saas-admin build
  pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin build
  pnpm format:check && git diff --check
  ```

- [ ] **Step 7: Perform browser acceptance and report it honestly.** Verify operator invoice and
      offer forms plus 390 px cabinet list/detail: no page overflow, local table scroll, keyboard
      navigation, terms preview, statuses, PDF/HTML download controls, and zero console errors. Record
      unavailable object storage/PDF/browser checks explicitly in the report.

- [ ] **Step 8: Commit the customer cabinet and verification report.**

  ```bash
  git add apps/admin apps/api/test/print-document-flow.e2e.test.ts .superpowers/sdd
  git commit -m "feat(admin): add tenant invoice cabinet"
  ```
