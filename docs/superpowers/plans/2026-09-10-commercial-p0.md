# Commercial P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new catalog sales preserve correct resource quantities, calendar license terms, seller tax policy and immutable document wording from editor through payment application.

**Architecture:** Extend existing catalog, seller-profile, offer, invoice and subscription services with explicit workflow operations. Reuse shared deterministic calculations and immutable commercial snapshots; do not build a parallel billing engine.

**Tech Stack:** Node 24+, pnpm 11.22.0 through Corepack, TypeScript, Zod, NestJS, Drizzle/PostgreSQL, React, Vitest.

**Spec:** [Approved P0 design](../specs/2026-09-10-commercial-p0-design.md), [functional requirements v1.2](../specs/2026-09-10-catalog-entitlements-functional-requirements.md).

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/catalog-entitlements` on `codex/catalog-entitlements`.
- The user authorized commit, push and PR on 2026-09-11 after local P0 acceptance. Deployment and cleanup remain outside the authorized scope.
- Resource quotas are nonnegative PostgreSQL integers or null. Zero means not included; null means unlimited.
- Trial days remain positive integers or null, where null disables automatic trial configuration. Add-on increments stay strictly positive.
- Plan line quantity is exactly one; add-on quantity counts resources rather than subscription periods.
- New paid intervals are `[startsAt, endsAt)` in `Europe/Moscow`.
- Immediate activation starts at the server time of applying confirmed payment. After-current activation starts at the current term end.
- Persist the original renewal anchor; clamp absent days without changing that anchor.
- Issued document snapshots never change. Historical records without authoritative term data are legacy.
- One `chzIntegration` commercial module includes National Catalog access; P1 enforcement and P2 recurring services are outside this plan.
- Use current platform/tenant authorization, locks, idempotency and audit. No production-data mutations or policy bypasses.
- Write and observe focused failing tests before implementation; rebuild shared exports before consumers.
- Do not link another checkout's mutable node_modules/dist. Do not change dependency policy or lockfile to make installation pass.

## File responsibilities

- `packages/domain/src/commercial-terms.ts`: deterministic calendar and seller-tax functions only.
- `packages/platform-contracts/src/commercial-terms.ts`: authoritative new commercial-value schemas; export through index.
- Existing `catalog.ts`, `tenants.ts`, `commercial.ts`: preserve legacy schemas and add a negotiated current commercial representation.
- `packages/db/src/schema/saas.ts`, `billing.ts`, new migration: nullable commercial metadata, policy provenance and paid interval metadata; preserve old bytes and dates.
- `apps/api/src/modules/platform-catalog/*`, `billing-profiles/*`: draft/publish/review and seller policy.
- `apps/api/src/modules/billing/*`, `platform-offers/*`, `subscriptions/*`: frozen terms, issuance and one paid-license application behavior.
- Existing SaaS catalog/legal/offer/billing components: edit and display new terms with current components/translations.
- `docs/operations/commercial-p0-rollout.md` and an API CLI report: compatibility, impact, rollout, rollback and evidence.

### Task 1: Deterministic calendar and seller-tax values

**Files:** Create `packages/domain/src/commercial-terms.ts`, `packages/domain/test/commercial-terms.test.ts`; modify `packages/domain/src/index.ts`.

**Interfaces:** Produces these public domain types/functions. Dates are validated ISO instants; output timestamps are canonical UTC strings. No database or network dependencies.

```ts
type CommercialBillingPeriod = "month" | "year";
type CommercialPeriod = {
  billingPeriod: CommercialBillingPeriod;
  billingTimezone: "Europe/Moscow";
  calendarPolicyVersion: 1;
  anchorAt: string;
  cycle: number;
  startsAt: string;
  endsAt: string;
};
type SellerTaxPolicy =
  | { kind: "without_vat"; regime: "npd" | "other" }
  | {
      kind: "vat";
      regime: "other";
      allowedRatesBps: number[];
      defaultRateBps: number;
      defaultIncluded: boolean;
    };
type CommercialTax = { vatRateBps: number | null; vatIncluded: boolean };

function resolveCommercialPeriod(input: {
  anchorAt: string;
  billingPeriod: CommercialBillingPeriod;
  cycle: number;
}): CommercialPeriod;
function commercialTaxDefaults(policy: SellerTaxPolicy): CommercialTax;
function isCommercialTaxAllowed(policy: SellerTaxPolicy, value: CommercialTax): boolean;
```

- [x] Write and run failing literal calendar tests. The following independently calculated case catches fixed-day durations and clamped-anchor drift:

```ts
const input = { anchorAt: "2027-01-31T09:00:00.000Z", billingPeriod: "month" as const };
expect(resolveCommercialPeriod({ ...input, cycle: 0 })).toMatchObject({
  startsAt: "2027-01-31T09:00:00.000Z",
  endsAt: "2027-02-28T09:00:00.000Z",
});
expect(resolveCommercialPeriod({ ...input, cycle: 1 })).toMatchObject({
  startsAt: "2027-02-28T09:00:00.000Z",
  endsAt: "2027-03-31T09:00:00.000Z",
});
```

- [x] Add leap-year literal boundaries, Moscow date crossing UTC midnight, invalid ISO/date/cycle, overflow and negative/fractional cycle cases. Derive every expected timestamp independently.
- [x] Test Without VAT versus numeric zero and configured-rate membership:

```ts
const npd = { kind: "without_vat", regime: "npd" } as const;
expect(commercialTaxDefaults(npd)).toEqual({ vatRateBps: null, vatIncluded: false });
expect(isCommercialTaxAllowed(npd, { vatRateBps: 0, vatIncluded: false })).toBe(false);
expect(isCommercialTaxAllowed(npd, { vatRateBps: null, vatIncluded: true })).toBe(false);
```

- [x] Implement original-anchor calendar arithmetic with a fixed declared billing timezone and bounded valid dates. Reject malformed policy data; never derive regime from a seller's legal form. Export functions/types.
- [x] Run `corepack pnpm --filter @markiro/domain exec vitest run test/commercial-terms.test.ts`, then domain test/typecheck/lint/build. Save red/green evidence and exact exported interface in the task report; do not commit.

### Task 2: Additive persistence and compatible commercial contracts

**Files:** Modify `packages/db/src/schema/saas.ts`, `packages/db/src/schema/billing.ts`, current `packages/platform-contracts/src/{catalog,tenants,commercial,index}.ts`; create `packages/platform-contracts/src/commercial-terms.ts`; add a NEW numbered PostgreSQL migration/metadata and focused tests beside existing migration/catalog/commercial tests.

**Interfaces:** Consumes Task 1 types. Produces runtime schemas for `SellerTaxPolicy`, `CommercialPeriod`, and versioned `CommercialLineTerms`. New persisted fields are nullable for legacy rows.

```ts
type CommercialLineTerms = {
  version: 1;
  subject: "software_license" | "service" | "development_work";
  documentNameRu: string;
  documentNameEn: string | null;
  sellerPolicyRevision: number;
  billingPeriod: "month" | "year" | null;
  billingTimezone: "Europe/Moscow" | null;
  activationRule: "on_application" | "after_current" | null;
};
```

Persist catalog document names, subject and seller-policy revision as version data; operator profile `taxPolicy`; offer/invoice line `commercialTerms`; subscription/add-on `commercialPeriod`. Names and JSON columns use repository conventions. Report final exported schema names before dependent tasks begin.

- [x] Extend focused schema tests first: accept resource zero and null; reject negative/fraction/overflow, zero trial/increment, malformed tax policies, mismatched kind/period/subject and duplicate effects.

```ts
expect(planEntitlementsSchema.safeParse({ ...validPlan, maxKiosks: 0 }).success).toBe(true);
expect(planEntitlementsSchema.safeParse({ ...validPlan, demoDurationDays: 0 }).success).toBe(false);
```

- [x] Preserve legacy request/response schemas as explicit exports where strict consumers need them. Current representation must include new fields and zero values; test both versions using complete payloads. Define `X-Markiro-Commercial-Version: 2` as the negotiated updated representation; do not emit unknown fields to legacy parsers.
- [x] Add nullable columns and replace only quota `> 0` checks with `>= 0`; trial/increment checks stay positive. Add subject/kind and commercial JSON shape validation at storage/runtime boundaries. Use Drizzle generation after reading config; review generated SQL and metadata rather than editing old migrations. Do not hand-edit the pnpm lockfile.
- [x] Test migration against a database containing legacy null quotas, paid subscriptions and issued snapshot data. Assert exact legacy values unchanged after migration, plus zero accepted and invalid values rejected.
- [x] Run contracts test/typecheck/lint/build; DB focused migration/schema tests and DB test/typecheck/lint/build. Rebuild dependencies before consumer checks. No new enforcement is enabled by this task; no commit.

### Task 3: Seller policy and validated catalog workflows

**Files:** Existing `apps/api/src/modules/{billing-profiles,platform-catalog}/*`, `platform-http/platform-openapi.ts` and affected route contracts; tests `platform-catalog.e2e.test.ts`, billing profile tests, new commercial review tests.

**Interfaces:** Consume Task 2 fields/schemas. Existing platform capability checks remain. Updated callers negotiate version 2. Add editor context and review endpoints within the existing catalog controller, with contracts/OpenAPI. Publication commands bind to current draft/seller revisions; no arbitrary evaluator.

```ts
type CommercialReviewIdentity = {
  catalogVersionId: string;
  draftUpdatedAt: string;
  sellerPolicyRevision: number;
};
type CatalogPublicationReview = {
  identity: CommercialReviewIdentity;
  errors: Array<{ code: string; path: string }>;
};
```

- [x] Write tests that modified requests cannot publish disallowed VAT, that missing Russian document name blocks publication, and that a changed seller policy or draft invalidates review. Assert no partially published version or incorrect audit event.
- [x] Extend seller profile revisions with explicit tax policy. New/changed NPD policy only permits Without VAT; missing legacy policy is unconfigured and must be reviewed. Preserve customer profile semantics; tax policy is seller-only.
- [x] Add editor context from current seller policy and existing permissions. Create/save/clone carry true billing period and document fields; licenses derive `unit` from period, services retain their unit. Never mutate published terms.
- [x] Re-read catalog/version/seller under established locks in publish. Validate kind/subject, document names, period, amount, tax policy and supported existing effects. Current API responses preserve negotiated representation; legacy reads return an explicit safe `client_update_required` for unrepresentable zero values rather than misreporting them.
- [x] Example decisive test shape:

```ts
const review = await reviewCatalog(versionId);
await changeSellerPolicy();
await expect(publishReviewed(versionId, review.identity)).rejects.toMatchObject({
  response: { code: "commercial_review_stale" },
});
expect(await persistedCatalogStatus(versionId)).toBe("draft");
```

The helper names above describe test-local fixtures around actual services; do not add them to production classes.

- [x] Verify new module/P1 policy promises cannot be sold through a P0-only implementation. Preserve previously published legacy terms for reading and explicitly reviewed future sale; do not turn a missing migration into unrestricted defaults.
- [x] Run focused API tests against an isolated migrated database; exact platform audit and tenant/role denial tests; API typecheck/lint/build after shared builds. No commit.

### Task 4: Frozen document terms and unified paid-license application

**Files:** Existing `apps/api/src/modules/billing/{billing.service,billing-application.service,commercial-snapshots,print-document-model}.ts`, `platform-offers/platform-offers.service.ts`, `subscriptions/subscription-lifecycle.service.ts`, document renderers as necessary; focused billing/offer/lifecycle tests; commercial response contracts as required.

**Interfaces:** Consume `CommercialLineTerms`, `CommercialPeriod`, `resolveCommercialPeriod`. Add a focused internal paid-license application boundary over the existing lifecycle, accepting the frozen line, confirmed payment provenance, tenant and platform actor. Keep origin discrimination for paid offer line versus paid invoice line.

```ts
type PaidLicenseOrigin =
  | { kind: "invoice"; invoiceLineId: string; paymentId: string }
  | { kind: "offer"; offerLineId: string; paymentId: string };
```

- [x] Write failing database tests for one annual plan through invoice and direct offer payment. Assert exact one-year end, quantity one, amount `69000.00`, and unchanged invoice snapshot. Reject plan quantity two; addon quantity two grants two resources for one period.
- [x] Freeze versioned document descriptions, sale subject, seller-policy revision and term intention in offer/invoice lines. Taking an accepted offer into an invoice uses its frozen terms rather than current catalog. English issue requires an English document name.
- [x] Revalidate seller policy at issuance under current locks. A stale policy fails for review; do not silently rewrite draft prices/tax. Render resolved stored names and term rule from the snapshot. Reprint legacy and new snapshots through explicit version-aware reading without backfilling historical facts.
- [x] Replace both paid-plan/add-on paths with one lifecycle behavior. Immediate starts at one captured application time; after-current starts at the retained current end. Preserve anchor/cycle on same-period renewal; deliberate period change begins a new anchor. Add-on paid interval is independently resolved and effective access bounded by the base subscription. Retry returns stored dates.
- [x] Keep existing payment-confirmation and pending/applied/failure states. Apply rights, period metadata, provenance, ledger outcome and audit in the same transaction. Prevent fulfilling the same sold line through both legacy offer payment and a derived invoice; reuse existing workflow locks and link mapping.
- [x] Required test outcomes include:

```ts
expect(first.subscription.endsAt).toBe("2027-09-10T09:00:00.000Z");
expect(retry.subscription.id).toBe(first.subscription.id);
expect(retry.subscription.endsAt).toBe(first.subscription.endsAt);
expect(await issuedSnapshotBytes(invoiceId)).toEqual(beforePaymentSnapshot);
```

- [x] Test concurrent application, partial transaction failure, archived catalog after issuance, policy changes, source-offer/invoice double application and legacy ambiguous periods. Unknown legacy annual/monthly intent requires review; it does not create a silently corrected term.
- [x] Run focused billing/lifecycle/offer/document suites, migration tests if new constraints are needed, then API gates and affected contracts. No commit.

### Task 5: SaaS administration and customer-visible commercial terms

**Files:** Existing SaaS `pages/catalog/{CatalogCreatePanel,CatalogVersionPanel,CatalogVatField,api}.tsx/ts`, `pages/legal/LegalProfileForm.tsx`, offer/billing editors and views, locale files and tests; tenant billing views/clients only where needed to display new terms correctly.

**Interfaces:** Use negotiated current contracts and editor context/review responses from Tasks 2–4. Reuse `@markiro/ui`; no new design system.

- [x] Write focused form tests for zero/finite/unlimited mode and empty Limited input. Observe failing annual create/edit request tests before modifying controls.

```ts
await user.selectOptions(screen.getByLabelText(/period/i), "year");
await user.type(screen.getByLabelText(/price/i), "69000.00");
await user.click(screen.getByRole("button", { name: /save/i }));
expect(capturedCreate).toMatchObject({ billingPeriod: "year", unitPrice: "69000.00" });
```

Use actual translated accessible names and existing request capture helpers in the test implementation.

- [x] Add explicit period and quota controls, separate trial input, versioned document names/subject, seller-derived allowed tax controls, and synchronized summary. Clone preserves structured period; new review validates current seller state.
- [x] Extend seller editor for explicit policy configuration without silently inferring a regime. Show a configuration requirement when policy is absent. Keep customer profile form free of seller-only data.
- [x] Publication and invoice issuance show actual reviewed conditions and refresh stale previews without losing input. Prevent duplicate submission; retain dirty-close and keyboard/focus behavior. Plan quantity is one; add-on quantity remains resource quantity.
- [x] Add Russian/English translations. Display known activation dates or the agreed start rule accurately; never display a guessed payment date. Verify tenant views do not expose internal seller policy notes or other tenants.
- [x] Run affected component/client tests and package test/typecheck/lint/build. Browser-check desktop/narrow layouts and both locales, capture screenshots of changed catalog forms. No commit.

### Task 6: Migration evidence, compatibility, final integration and review

**Files:** Create `apps/api/src/cli/report-commercial-p0-impact.ts`, tests for report/compatibility, `docs/operations/commercial-p0-rollout.md`; update public API/architecture docs and CI ownership when needed.

**Interfaces:** A read-only report with counts and safe row identifiers for annual-unit/monthly-period mismatches, missing document names/policy, null-ended paid subscriptions and unrepresentable legacy clients. No correction statements or secrets.

- [x] Test report against isolated fixtures and assert categories/identifiers with exact inputs; no source-text assertions. Default output omits sensitive billing/customer payloads. Execute on local test fixtures only.
- [x] Verify negotiated legacy/current API responses and write restrictions, including resource zero; old positive/null responses stay parseable and truthful. Document client deployment order before first zero-quota publication. Recovery/read endpoints keep appropriate behavior.
- [x] Complete requirement-to-test mapping for all P0 requirements, including trial preservation, frozen historical documents, calendar anchors, repeated payments and schema rollback limits. P1-only ACs are marked P1, not claimed passing.
- [x] Run scoped package gates, then broad workspace gates with local test environment and concurrency one. Run `corepack pnpm format:check` and `git diff --check`. Report actual infrastructure skips separately.
- [x] Perform requested UI browser verification/screenshots and local document rendering. Record external production, provider, physical and legal acceptance as not performed, with their separate rollout gates.
- [x] Dispatch broad final review of the full scoped diff and approved spec; resolve actionable findings, re-run checks justified by fixes, and leave a reviewable uncommitted result. Do not push, publish, deploy or delete worktree.

## Completion evidence — 2026-09-11

Tasks 1–6 are complete for the approved P0 scope. Task reviews, the whole-change review and its
single scoped fix re-review are complete; all actionable final findings were addressed. P1 module
enforcement/device policies and P2 recurring services remain outside this implementation.

The forced workspace run completed all 13 package test suites: 745 files, 8,810 passed tests and
4 conditional API skips. It completed 45 of 52 lint/typecheck/test/build tasks before stopping at
an API test-only TypeScript error. The correction retained the exact frozen-term assertion while
reading typed persisted invoice lines. Its 33 focused tests and API typecheck passed; all seven
unfinished workspace tasks and a fresh API lint then passed. No production source changed after
the full test run. This is combined final coverage, not a claim that the original aggregate
command exited successfully.

Production-bundle contracts passed 542 tests with no skips. The first sandboxed attempt could
not access the package-manager store, container socket or local test listeners; the same command
passed with the required local permissions and no code changes. Workspace format and diff checks
passed. All 123 scoped files matched the final source manifest before this documentation-only
completion update; only the stated test file differed from the original full-run manifest.

Three optional local-infrastructure tests were skipped because their fixed Mailpit endpoint does
not match the isolated sink; one live National Catalog test lacked provider credentials. The
22 inventory tests ran against the owned PostgreSQL database. Existing warnings were preserved,
including five hook warnings in unchanged Admin pages; none were suppressed to pass a gate.

Local browser acceptance covered RU/EN at desktop and narrow widths, seller/catalog workflows,
stale publication review, VAT/payable totals, invoice payment/application/retry, a two-unit add-on,
and two consecutive paid plan periods. The generated Russian annual invoice PDF was inspected
visually and textually, and existing stored document bytes remained unchanged. See the
[P0 acceptance map](../../operations/commercial-p0-acceptance.md) and
[rollout/recovery guide](../../operations/commercial-p0-rollout.md).

Remote CI, deployment, real bank/provider operations, English PDF generation, legal/tax acceptance,
Windows/native device and physical printing checks were not performed by these local gates.
At initial P0 acceptance, branch `codex/catalog-entitlements` remained uncommitted; no push, PR,
deployment or cleanup had been performed. The user subsequently authorized commit, push and PR.
Detailed logs, exact hashes, reviews and browser evidence remain in the
ignored local `.superpowers/sdd/2026-09-10-commercial-p0/` evidence package.

## Publication integration with main

The exact accepted P0 was saved as `f7e6cfbd2`. The publication preflight then found nine newer
upstream commits at `0758ba834`, including the offer workspace and print variants. Integration
preserves that workspace and its preview-bound publication while carrying P0 frozen commercial
terms, seller policy, localized periods and precise errors through the new routes and screens.

Incoming migration 0127 and its snapshot remain byte-identical to main. The commercial migration
is now 0128, generated from the incoming snapshot; its SQL is unchanged from accepted P0. Fresh
isolated databases exercise this chain, preserving the earlier local verification databases.

Focused integration checks passed: 137 API tests, 146 contract tests, five additive-migration
tests, 17 workspace tests and 13 editor tests, plus affected static/build gates. Actual local
MFA/catalog/buyer setup and annual offer creation, preview, publication and clean PDF download
passed. RU/EN at 1440 and 390 widths in both themes passed all eight browser cases. The new PDF
was inspected visually and textually: one A4 page, one year, RUB 69,000 and Without VAT.

Publication gates are complete: all 52 workspace tasks and 13 package test suites are covered,
with 759 passing files, 8,935 passed tests and four expected conditional API skips. The forced
aggregate command stopped after 46 successful tasks on an incoming V2 invoice test fixture.
Two bounded test-only corrections supplied valid saved service terms/total and moved the browser
tool's model type import to the built API declaration; the original business assertions remain
and exact frozen line values are additionally checked. Failed/unfinished tasks and affected SaaS
typecheck then passed. The initial failed aggregate exit is retained as combined-run evidence.

Production-bundle contracts passed 546/546 with no skips. Separate browser-tool typecheck and
19/19 offer browser tests passed; actual API/browser/PDF checks are recorded above. Full workspace
formatting and final diff checks passed. Product source stayed unchanged after the broad freeze;
only the two reviewed test fixtures changed before final documentation. Integration review and
scoped re-review found no remaining Critical/Important issue. Exact task/count/hash records remain
in the ignored publication evidence package; durable results are in the acceptance map.

## PR #503 conflict resolution with agreements

Main advanced to `d6ae5c123` after the initial PR publication. Its agreement migration 0128,
translations, contracts, role-derived principal fixtures and routes are preserved. The commercial
migration is now 0129 with unchanged SQL and a regenerated snapshot based on incoming 0128.
The additive migration fixture starts through 0128 and preserves a saved agreement alongside
the historical commercial records. Current deployment instructions reference 0129; the earlier
migration numbers above remain a record of those earlier integrations.

Conflict-resolution checks cover all 52 workspace tasks and 13 package suites: 766 passing files,
9,006 passed tests and four expected conditional API skips. The forced aggregate stopped after
30 successful tasks with an unexplained SIGTERM; remaining tasks passed separately. Two initial
SaaS parallel render waits timed out; diagnostic and full serial runs passed 321/321 without
source, assertion, timeout or tracked configuration changes. Original interrupted/failed runs
remain recorded, so this is combined coverage rather than a successful aggregate exit.

Settled production-bundle contracts passed 546/546 after an earlier concurrent DB build changed
output mtimes during the immutability check. The fresh owned database exercised migration 0129
and all 22 inventory tests. Formatting and diff checks passed; all 4,082 frozen files matched
before final documentation. Bounded integration review found no actionable issues. Earlier
browser/PDF evidence remains separate; this conflict resolution does not claim new browser,
provider, Windows/native or physical acceptance. See the acceptance map for verification limits
and the ignored `.superpowers/sdd/2026-09-11-pr503-conflicts/` directory for exact local records.
