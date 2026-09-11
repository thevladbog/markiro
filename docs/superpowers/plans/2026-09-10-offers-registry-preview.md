# Offers registry and document variants implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ID-only offers surface with a searchable registry, a complete detail screen, safe draft preview and immutable signed print variants.

**Architecture:** Preserve legacy offers endpoints and add a platform-only registry/workspace projection. Use the existing print model for preview and frozen snapshots for released artifacts. Keep commercial revisions separate from print variants.

**Tech Stack:** NestJS, Drizzle/Postgres, strict Zod contracts, React Query/React Router, @markiro/ui, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-10-offers-registry-preview-design.md` (approved by user).

## Global Constraints

- Preserve the uncommitted report filter changes. No commits, staging, push, PR or production actions are authorized.
- Reuse @markiro/ui, IBM Plex Sans/Mono and shared Markiro tokens; RU/EN, light/dark, desktop 1440 and mobile 390.
- Financial model, customer acceptance and entitlement application rules do not change.
- User separately approved correcting subtotal/VAT breakdown for NEW offer issues only, keeping total and historical snapshots/artifacts unchanged. Preview and publish use the same checked minor-unit calculation with per-line rounding; add literal included/excluded/mixed/no-VAT rounding tests.
- Existing issued snapshots, object keys and ready document bytes remain immutable.
- Platform billing.read/billing.write boundaries remain enforced; no customer credentials on platform routes.
- Search covers the server-side result set; page sizes 25/50/100, default 25, stable createdAt DESC/id DESC.
- Preview never publishes, assigns a number, stores final artifacts or sends notifications.
- Signed means existing supplier signature/seal images, not electronic signing; retain seller tax-ID authorization.
- Every behavior change starts with a focused RED test, followed by implementation and GREEN evidence.
- Use corepack pnpm. Rebuild db/contracts before consumer checks. DB tests use loopback development infrastructure only.

## Task 1: Registry and workspace projection

**Files:** Create `packages/platform-contracts/src/offer-workspace.ts`, export from `src/index.ts`; create `apps/api/src/modules/platform-offers/offer-workspace.service.ts`; modify platform-offers controller/module; add contracts and API tests and route inventory entries.

**Interfaces:** Export `platformOfferWorkspaceContracts`, `OfferRegistryQuery`, `OfferRegistry`, `OfferWorkspace`. Endpoints `GET /platform/offers/registry` and `GET /platform/offers/:id/workspace`; keep legacy `/offers` unchanged. Registry response `{items, page, limit, total}`; each item contains existing offer record plus tenantName, tenantSlug, buyerLegalName, buyerTaxId, lineSummary (first three stored names), lineCount. Workspace `{offer, tenant: {id,name,slug}, parties: {seller,buyer}, revisions, decision, documents, actions}` with shared existing offer/document schemas. Resolve published parties from snapshot; draft parties from current authoritative billing profiles. Actions are server-derived booleans `publish`, `cancel`, `revise`, `pay`, `createInvoice`, `addSignedVariant`; derive them from current family/decision/state and actor capability, not status alone.

- [ ] Write contract tests proving defaults, literal query escaping inputs, page-size bounds, date ordering, nullable missing profiles and strict response fields. Example behavior:
  ```ts
  expect(platformOfferWorkspaceContracts.registry.query.parse({})).toMatchObject({
    page: 1,
    limit: 25,
  });
  expect(platformOfferWorkspaceContracts.registry.query.safeParse({ limit: 26 }).success).toBe(
    false,
  );
  ```
- [ ] Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/offer-workspace.test.ts`; observe missing contract failure before implementation.
- [ ] Implement query/response schemas using existing commercial schemas (no copied unions). Query fields `search`, `tenantId`, `status`, `createdFrom`, `createdTo`, `page`, `limit`; dates are explicit ISO timestamps and form half-open interval.
- [ ] Write API tests on real scoped queries where infrastructure permits: missing tenant profile remains in results; name/number/INN/stored-line projection; count and pagination stability; 403 capability; snapshot parties differ from current profile; newer family revision/changes_requested/accepted decisions produce correct actions.
- [ ] Run focused API tests RED; implement projection service, controller routes before `:id`, module registration and contract route inventory. Avoid per-row queries: batch selected offer IDs and tenant IDs or relational aggregate SQL.
- [ ] Run contract build/test/typecheck/lint and focused API tests/typecheck/lint. Report exact exported types for the UI task.

## Task 2: Draft preview and immutable signed variants

**Files:** Create `offer-preview.service.ts` and `offer-preview-model.ts` under platform-offers as needed; extend `offer-workspace.ts` contracts; modify platform-offers service/controller/module, offer-documents service, print-document-layout/html; modify `packages/db/src/schema/saas.ts` plus new generated migration/metadata; update affected renderer/schema/API/route tests.

**Interfaces:** `GET /platform/offers/:id/preview` returns `{html, fingerprint}` for a saved draft; `POST /:id/publish` optionally accepts `{previewFingerprint}` and legacy empty body. `POST /:id/documents` accepts `{printVariant: 'clean'|'signed'}` (legacy defaults clean). Document responses already carry `printVariant`; persisted offers must now supply it. Task 1 workspace actions/documents remain the UI source of truth.

- [ ] Write renderer RED test: authorized seller offer with signed variant produces existing signature and seal images, unauthorized seller remains rejected. Use fixture model with literal expected image presence and no customer signature. Run focused print renderer test before removing the offer-only prohibition.
- [ ] Add DB RED tests proving print_variant defaults clean and uniqueness distinguishes variants for one offer/revision/format. Generate a forward-only migration using pnpm; inspect constraints and preserve legacy keys. Do not edit migration history or lockfile manually.
- [ ] Write preview RED tests: actual draft line/terms data rendered, draft mark present, no publication/snapshot/object/email effects, missing requisites explicit, unsafe terms sanitized. Add publish test with changed preview inputs returning conflict before mutation. Hash canonical resolved input model; compare inside publication transaction, preserving legacy optional behavior.
- [ ] Implement preview via common print model/renderer. No fake published number; mark draft and leave issue timestamp visibly unassigned. Preview cache-control no-store; UI will sandbox HTML. Published documents continue to use their saved model.
- [ ] Add document lifecycle RED tests for revision 5, clean and signed coexistence, ready-byte immutability, parallel retry/idempotency, partial HTML/PDF failure, precise actor/tenant/action/variant audit and no repeat notification. Use development DB for concurrency when possible.
- [ ] Implement variant storage and rendering: identify offer revision from selected offer, validate seller from snapshot and state, unique variant rows, variant-specific new object keys, no overwrite of ready files. Serialize render attempts using existing locking convention or lock/lease-safe ownership with byte/metadata consistency. Render retries only non-ready documents. Do not silently reuse r1 for later offers.
- [ ] Run db build/test/typecheck/lint, contracts build/test/typecheck/lint, focused API renderer/lifecycle/OpenAPI tests, affected tenant document consumers. Record infrastructure skips separately.

## Task 3: Offers registry, detail and preview UI

**Files:** Modify `apps/saas-admin/src/pages/offers/OffersPage.tsx`, `api.ts`, `app.tsx`, `global.css`, i18n ru/en; create `OfferDetailPage.tsx`, `OfferDocuments.tsx`, `OfferPreview.tsx` and scoped helpers when needed; update offer editor/list tests and new `offers-workspace.test.tsx`.

**Interfaces:** Use Task 1 workspace and registry types and Task 2 preview/variant endpoints through `platformApiFetch` schemas. `/offers/:offerId` is detail; `/offers?selected=id` remains compatible. `returnTo`/location state contains only safe local registry URL. Existing creation flow remains; selecting newly created document opens its detail.

- [ ] Write UI RED test with human names and mixed statuses: IDs not primary text, localized money, stored line summary, filters query server, no client N+1 detail calls. Run focused tests and observe old page mismatch.
- [ ] Implement registry with search debounce, URL-backed filters/page, custom Select/Combobox/DatePicker, clear filters, pending/error/retry/empty/read-only. Use server counts. Route navigation preserves search context.
- [ ] Write detail RED tests for saved lines and snapshot parties, preview loads without publish POST, publish sends fingerprint, conflict requires refreshed preview, errors preserve inputs, signed variant loads separately. Payment/revise retries preserve idempotency/payload after ambiguous errors; buttons follow workspace actions.
- [ ] Implement full detail with facts, stored terms/lines/totals, history/decision, documents, preview and confirm dialogs. `iframe` preview is sandboxed without script or same-origin permission. Do not inject raw HTML into application DOM. Navigate/download without asynchronous popup dependency. Pending documents refresh with bounded recovery and stop when ready/unmounted.
- [ ] Implement signed action wording and confirm: same issued data, images rather than electronic signature, no customer notification. Keep both clean and signed documents visible; HTML available when PDF failed.
- [ ] Run SaaS focused tests then full package tests/typecheck/lint/build and prettier. Existing report tests must remain green.

## Task 4: Browser proof and final integration

**Files:** Add scoped Playwright fixtures/spec under `tools/production-browser` following the isolated reports suite pattern; document commands in `docs/operations/` if required for reproducible execution.

**Interfaces:** Actual Vite SaaS app, intercepted synthetic platform responses; tests assert outgoing API payloads and visible behavior, never claim production verification.

- [ ] Write browser cases at 390/1440 for registry to detail and back, preserved filters, keyboard search, delayed preview/publish, signed variant generation and delayed download navigation. Exercise RU/EN and light/dark; HTML fixture includes multiple rows and terms to expose overflow.
- [ ] Run isolated browser suite, inspect screenshots for registry, preview, signed variant. Assert no page horizontal overflow, usable controls and readable document. Capture artifact paths for final handoff.
- [ ] Run scoped package gates, full formatting and `git diff --check`. Review new migration, API inventory and consumer contracts together. Record actual database coverage and external checks not run.
- [ ] Run task and whole-change reviews; fix still-valid findings with covering tests. Preserve all prior report edits. Report changed behavior, checks, screenshots and no deployment/commit status.

## Execution record

Use this plan's `.superpowers/sdd/2026-09-10-offers-registry-preview/` ledger.
Task reviewers inspect uncommitted scoped diff packages because commits are not
authorized. Do not delete the ledger before the work is committed by a separately
authorized action; it is the recovery record for this uncommitted work.
