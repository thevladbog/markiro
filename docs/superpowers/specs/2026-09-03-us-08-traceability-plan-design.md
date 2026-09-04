# US-08 — Traceability Plan versions and PDF — Design Spec

**Date:** 2026-09-03
**Status:** Draft for review (not implemented)
**Slice:** US-08 from docs/us/implementation-plan.md; depends on US-00 (regulatory profile, baseline, retention value, U.S. capabilities), US-01 (locations, TLC source flag), US-02 (product classification workflow)
**Requirements:** PLN-001, PLN-002, PLN-003, PLN-004, PLN-005, PLN-006, PLN-007, PLN-008, PLN-009 (P1), PLN-010; contributes evidence to REG-007, REG-009, C-012
**Related:**

- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR (bounded context, profile gating)
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — `traceability_profiles.retention_days`, `RequireTraceabilityProfile`, U.S. capabilities
- `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md` — `traceability_locations` and the `tlc_source` location role
- `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md` — `product_traceability_profiles`, coverage status, review cadence
- `docs/superpowers/specs/2026-09-03-us-09-trace-request-design.md` — consumes the effective plan PDF in the trace request package
- `docs/superpowers/specs/2026-09-02-legal-font-pinning-design.md` — why the LibreOffice legal pipeline is not reused at runtime
- `docs/us/requirements.md` (PLN, REG-007, REG-009), `docs/us/data-dictionary.md` (§2 TraceabilityPlanVersion, §8 `/traceability/plans`, §9 `traceability_plan_versions`), `docs/us/regulatory-basis.md` (Traceability Plan, FDA-04), `docs/us/acceptance.md` (§2.1, §2.3, C-012), `docs/us/limitations.md` (language rules)

## Problem

FDA-04 describes a processor Traceability Plan: where and in what format records are kept, how FTL foods are identified, how TLCs are assigned, who the point of contact is, how the plan is updated, and that prior versions are retained for at least two years. Markiro has no document of this kind. The plan must be derived from real tenant configuration (profile, locations, classification workflow) so it never drifts from the system, yet it must be a frozen, approved, reproducible PDF that a later configuration change cannot silently rewrite (PLN-008). The same PDF is shipped inside every trace request package (PLN-010, RQ-006).

## Key facts of the codebase

- Runtime PDFs are rendered in the API with `@react-pdf/renderer` 4.6.1 (`apps/api/package.json`). Two renderers exist: `apps/api/src/modules/billing/print-document-pdf.tsx` (invoice/act/offer) and `apps/api/src/modules/inventories/inventory-act-pdf.tsx` (inventory act). Both `Font.register` IBM Plex Sans Regular/SemiBold from `apps/api/src/modules/billing/assets/`, set `creationDate`/`modificationDate` from the model (never wall clock), render page numbers through `render={({ pageNumber, totalPages }) => ...}` on a `fixed` element, and cap output (10 MiB in billing).
- Determinism is already tested: `apps/api/test/inventory-act-pdf.test.ts` "renders deterministic one-page PDF bytes" renders twice and asserts byte equality. The inventory act takes its timestamp from `metadata.fileDateTime`, not `Date.now()`.
- The billing helpers in `apps/api/src/modules/billing/print-document-layout.ts` (`formatPrintDate`, `formatPrintDateTime`) hard-code `ru-RU` and `Europe/Moscow`; they cannot be reused for a U.S. document.
- `packages/legal-documents` generates PDF/A-2b through DOCX + LibreOffice on a developer machine with pinned fonts (`packages/legal-documents/fonts/`, `src/cli/generate-artifacts.ts`, `src/cli/verify-artifacts.ts`); per the font-pinning spec, CI cannot regenerate those PDFs and macOS needs fonts installed in `~/Library/Fonts`. That pipeline suits controlled static documents, not per-tenant runtime generation. Reusable ideas: `LegalDocumentStatus = "draft" | "active" | "superseded" | "withdrawn"` (`src/types.ts`), structured `LegalBlock` content, and the `PublishedLegalArtifact` shape (`fileName`, `bytes`, `sha256`, `mediaType`, `generator` versions).
- Generated documents are persisted as revisioned rows plus private objects: `invoice_documents` in `packages/db/src/schema/billing.ts` (`revision`, `format`, `status` pending/ready/failed, `object_key`, `sha256`, `byte_size`, `renderer_version`, check `invoice_documents_ready_metadata_check`), written by `apps/api/src/modules/billing/billing-documents.service.ts` (`rendererVersion: "billing-print-v3"`, key `tenants/{tenantId}/invoices/{invoiceId}/r{revision}.{format}`).
- Object storage: `apps/api/src/modules/storage/object-storage.service.ts` exposes `put`, `putVerified(key, body, contentType, sha256)` (HEAD verification of size and `sha256` metadata), `presignRead(key, <=300 s, { downloadFilename })`, `get` bounded to 5 MiB, and `assertSafeKey` which only accepts `tenants/` or `users/` prefixes.
- Retention: `docs/architecture.md` §4 states "Retention: 5 years default, configurable per tenant; full takeout before deletion" for codes and the scan journal; no schema column or job encodes a document retention value. `docs/us/README.md` open question 4 and GQ-4 in the open-questions register assign the materialized value to US-00.
- Audit: `tenant_audit_events` (`packages/db/src/schema/team.ts`: `organization_id`, `actor_user_id`, `action`, `outcome`, `target_type`, `target_id`, `before`, `after`, `request_id`). The insert idiom to follow is `writeAudit` in `apps/api/src/modules/shift-exports/shift-exports.service.ts`.
- Authorization: `@RequirePermissions(...)` from `apps/api/src/authorization/access-policy.ts` with `TenantGuard`, `AuthorizationGuard`, `SubscriptionAccessGuard`; capabilities live in `packages/domain/src/access/cabinet.ts` (`CABINET_CAPABILITY`, roles owner/admin/manager/member). U.S. capabilities are introduced by US-00.
- US-00 (sibling spec) defines the U.S. capability set `traceability.read`, `traceability.master_data.write`, `traceability.receiving.write`, `traceability.transformation.write`, `traceability.shipping.write`, `traceability.qa.manage`, `traceability.export.read`; the profile guard `RequireTraceabilityProfile(...codes)` + `TraceabilityProfileGuard` (403 `traceability_profile_required` on mismatch); `traceability_profiles.retention_days` (default 1825, `CHECK (retention_days >= 730)`), which US-08 reads through the profile DTO; and the rule that every controller under `modules/traceability/**` is listed in `apps/api/test/authorization-metadata.test.ts`.
- US-01 (sibling spec) models the TLC source as the `tlc_source` value of the `traceability_location_role` enum array on `traceability_locations`, so the plan can list TLC source locations by role.
- OpenAPI: `apps/api/src/lib/openapi.ts` (`ApiZodBody`, `ApiZodQuery`, `ApiZodResponse`, `ApiCabinetAuth`, `ApiHttpErrors`); `apps/api/test/openapi-coverage.test.ts` fails any route without `@ApiOperation` and a documented success response.
- Admin: navigation is `NAV_ITEMS` filtered by capability in `apps/admin/src/layout/AppShell.tsx`; routes nest under `ShellPage` in `apps/admin/src/app.tsx`; pages follow `apps/admin/src/pages/<area>/{api.ts,schemas.ts,index.tsx}`; strings live in `apps/admin/src/i18n/en.json` and `ru.json`; UI primitives in `packages/ui/src/components` include `Alert`, `StatusChip`, `DataTabs`, `DefinitionGrid`, `ConfirmDialog`, `Table`, `PageHeader`, `EmptyState`.
- Schema conventions verified in `packages/db/src/schema/product-regulatory.ts` and `shift-exports.ts`: `uuid("id").primaryKey().defaultRandom()`, `tenant_id` text referencing `organization.id`, `unique(table.tenantId, table.id)` to allow composite FKs from other tables, `pgEnum` for closed sets, `check` constraints for status consistency, `timestamp(..., { withTimezone: true })`.

## Design

### Data model

New table in `packages/db/src/schema/traceability.ts` (additive migration; name from data-dictionary §9).

```sql
CREATE TYPE traceability_plan_version_status AS ENUM ('draft', 'effective', 'superseded');

CREATE TABLE traceability_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES organization(id),
  version_number integer NOT NULL,
  status traceability_plan_version_status NOT NULL DEFAULT 'draft',
  sections_schema_version integer NOT NULL DEFAULT 1,
  sections jsonb NOT NULL,                 -- narrative + contact, user-editable while draft
  config_snapshot jsonb,                   -- derived facts frozen at approval
  config_digest char(64),                  -- sha256 of canonical config_snapshot
  change_summary text NOT NULL DEFAULT '',
  created_by_user_id text NOT NULL REFERENCES "user"(id),
  approved_by_user_id text REFERENCES "user"(id),
  approved_at timestamptz,
  effective_at timestamptz,
  superseded_at timestamptz,
  superseded_by_version_id uuid,
  review_due_at timestamptz,               -- PLN-009
  pdf_object_key text,
  pdf_sha256 char(64),
  pdf_byte_size bigint,
  pdf_renderer_version text,
  approval_idempotency_key uuid,           -- set at approval; retries resolve to this row
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traceability_plan_versions_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT traceability_plan_versions_tenant_version_uq UNIQUE (tenant_id, version_number),
  CONSTRAINT traceability_plan_versions_tenant_approval_key_uq
    UNIQUE (tenant_id, approval_idempotency_key),
  CONSTRAINT traceability_plan_versions_superseded_by_fk
    FOREIGN KEY (tenant_id, superseded_by_version_id)
    REFERENCES traceability_plan_versions (tenant_id, id),
  CONSTRAINT traceability_plan_versions_status_consistency CHECK (
    (status = 'draft'
        AND approved_by_user_id IS NULL AND approved_at IS NULL AND effective_at IS NULL
        AND superseded_at IS NULL AND superseded_by_version_id IS NULL
        AND config_snapshot IS NULL AND config_digest IS NULL
        AND pdf_object_key IS NULL AND pdf_sha256 IS NULL AND pdf_byte_size IS NULL
        AND pdf_renderer_version IS NULL AND approval_idempotency_key IS NULL)
    OR (status = 'effective'
        AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND effective_at IS NOT NULL
        AND superseded_at IS NULL AND superseded_by_version_id IS NULL
        AND config_snapshot IS NOT NULL AND config_digest IS NOT NULL
        AND pdf_object_key IS NOT NULL AND pdf_sha256 IS NOT NULL AND pdf_byte_size IS NOT NULL
        AND pdf_renderer_version IS NOT NULL AND approval_idempotency_key IS NOT NULL)
    OR (status = 'superseded'
        AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND effective_at IS NOT NULL
        AND superseded_at IS NOT NULL AND superseded_by_version_id IS NOT NULL
        AND config_snapshot IS NOT NULL AND config_digest IS NOT NULL
        AND pdf_object_key IS NOT NULL AND pdf_sha256 IS NOT NULL AND pdf_byte_size IS NOT NULL
        AND pdf_renderer_version IS NOT NULL AND approval_idempotency_key IS NOT NULL)
  ),
  CONSTRAINT traceability_plan_versions_pdf_sha256_check
    CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX traceability_plan_versions_one_effective_idx
  ON traceability_plan_versions (tenant_id) WHERE status = 'effective';
CREATE UNIQUE INDEX traceability_plan_versions_one_draft_idx
  ON traceability_plan_versions (tenant_id) WHERE status = 'draft';
CREATE INDEX traceability_plan_versions_tenant_created_idx
  ON traceability_plan_versions (tenant_id, created_at);
```

Rules:

- Rows are never deleted or rewritten once `effective`; a superseded row keeps its PDF, snapshot and digest. Immutability is enforced in the service (only `draft` rows accept updates) and by the status check; a trigger is not proposed (OQ-US08-3).
- Retention: no purge job in P0. The tenant retention value is `traceability_profiles.retention_days` (US-00; default 1825, DB floor 730). This slice reads it through the profile DTO, prints it in the record-maintenance section, and adds a test that superseded versions stay listable and downloadable and that the floor holds for the seed tenant (PLN-007, REG-009).
- `sections` (schema version 1) is a typed object with six keys: `record_maintenance`, `ftl_identification`, `tlc_assignment`, `point_of_contact`, `farm_map`, `review_update`. Each narrative section holds `paragraphs: string[]` (plain text, no HTML). `point_of_contact` holds `{ name, title, phone, email? }`. `farm_map` is fixed to `{ applicable: false, explanation }` for the processor profile (PLN-006).
- `config_snapshot` (frozen at approval) holds: profile code, `baseline_version`, baseline verified date and source IDs (REG-001), tenant display name, timezone, retention days, locations carrying the `tlc_source` role (id, business name, city/state; US-01), the classification workflow summary (coverage statuses in use, review cadence days from US-02, count of `covered` products), the TLC assignment rule text (`Transformation only; shipping never assigns`, REG-005), and record-keeping facts (system of record, export formats, object storage class, backup statement from `docs/architecture.md`). `config_digest` is the SHA-256 of the canonical JSON (sorted keys, like `normalizeJson` in `tools/evidence-package/evidence-package.mjs`).

### Domain rules

`packages/domain/src/traceability/plan/` (pure, no I/O):

- `buildPlanConfigSnapshot(input): PlanConfigSnapshot` and `planConfigDigest(snapshot): string` — canonical serialization; digest is order-independent for arrays sorted by stable keys.
- `derivePlanSections(snapshot, narrative): RenderedPlanSections` — merges derived facts with narrative; every required FDA-04 section is present; `farm_map` always renders "Not applicable to the processor profile" with the explanation.
- `validatePlanForApproval(draft): PlanValidationIssue[]` — contact name/title/phone required (PLN-005), `change_summary` non-empty for version >= 2, at least one TLC source location configured, no prohibited wording (matrix from `docs/us/limitations.md`) in narrative.
- `planVersionTransition(state, action)` — `draft --approve--> effective`, `effective --supersede--> superseded`; anything else throws a typed error.
- `planConfigChanged(effective.configDigest, currentDigest): PlanChangeImpact` — returns the changed section keys by comparing snapshot sub-objects, which drives the banner (PLN-008/009).
- `defaultReviewDueAt(effectiveAt)` = `effectiveAt + 365 days` (PLN-009).
- `buildPlanPdfModel(version, priorVersions, snapshot)` — the view model consumed by the renderer: header (tenant, profile code, baseline ID and date, version, effective date, approver name/title), six sections, change history table (all prior versions: number, effective date, approver, summary), disclaimer text from the allowed-wording column only.

### Contracts and API

Zod contracts in `packages/platform-contracts/src/traceability/plans.ts` (`.strict()`), exported via `index.ts`: `traceabilityPlanSectionsSchema`, `traceabilityPlanVersionSchema`, `createPlanDraftBodySchema`, `updatePlanDraftBodySchema`, `approvePlanBodySchema`, `planListResponseSchema` (`{ versions, effectiveVersionId, configurationChanged: { changed: boolean, sections: string[] } }`).

NestJS module `apps/api/src/modules/traceability/plans/` (controller, service, `plan-pdf.tsx`, `plan-config-source.service.ts`). Guards: `TenantGuard, AuthorizationGuard, SubscriptionAccessGuard, TraceabilityProfileGuard` with `@RequireTraceabilityProfile("US_FSMA204_PROCESSOR")` (OQ-US08-7 for the generic profile). Capabilities from US-00: list/detail `traceability.read`; preview/download `traceability.export.read`; draft, update, approve, discard `traceability.qa.manage` (OQ-US08-6 on a dedicated plan capability). The controller is added to `authorization-metadata.test.ts`.

| Method | Route                              | Behavior                                                                                                                                                                 |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/traceability/plans`              | Versions newest first; computes `configurationChanged` against the effective version.                                                                                    |
| POST   | `/traceability/plans`              | Creates the single draft (409 `plan_draft_exists`), prefilled from the effective version's narrative or defaults; `version_number` = max + 1.                            |
| GET    | `/traceability/plans/:id`          | Version detail incl. snapshot and change history.                                                                                                                        |
| PUT    | `/traceability/plans/:id`          | Draft only (409 `plan_version_immutable` otherwise): narrative, contact, `change_summary`.                                                                               |
| POST   | `/traceability/plans/:id/approve`  | Body `{ idempotencyKey }`. Validate, freeze snapshot + digest, render + `putVerified` outside any transaction, then one short transaction flips status (sequence below). |
| GET    | `/traceability/plans/:id/preview`  | Draft only: renders the PDF with a "DRAFT — not effective" watermark and streams bytes; nothing stored.                                                                  |
| GET    | `/traceability/plans/:id/download` | Effective/superseded only: presigned URL (300 s, `downloadFilename`), audit `traceability_plan.downloaded`.                                                              |
| DELETE | `/traceability/plans/:id`          | Draft only; drafts are not regulated records (OQ-US08-4).                                                                                                                |

Approval is synchronous (one page-set PDF renders in well under a second in the existing renderers) but the storage write never happens inside an open DB transaction, following `inventory-document-runner.service.ts` (upload with `putVerified` first, publish in a short transaction, delete attempted objects on failure). Sequence:

1. Idempotency lookup: a row with `(tenant_id, approval_idempotency_key) = (tenant, body.idempotencyKey)` that is this `:id` → return it unchanged (retry after a lost response); the same key on a different version → 409 `idempotency_key_reused`.
2. Load the draft, run `validatePlanForApproval`, build `config_snapshot` + `config_digest` (pure), render the PDF, compute `pdf_sha256`, `putVerified` under the object key below. Nothing is written to the row yet.
3. One short transaction: `SELECT ... FOR UPDATE` on the draft; 409 `plan_version_immutable` if it is no longer `draft`; recompute the config digest and 409 `plan_configuration_changed` if it differs from step 2 (configuration edited during the render); mark the current effective row `superseded` (`superseded_at`, `superseded_by_version_id`); set `status = 'effective'`, `approved_by_user_id`, `approved_at`, `effective_at`, snapshot, digest, PDF columns and `approval_idempotency_key`; write the audit rows.
4. If step 3 fails for any reason, delete the object (best-effort). An orphan left by a crash between 2 and 3 is harmless: the key is version-scoped and the next approval attempt overwrites it; the row never points at an object that was not verified.

A repeat with the same key returns the same effective version; the key is stored on the row and made unique per tenant by `traceability_plan_versions_tenant_approval_key_uq` (OQ-US08-1). Object key: `tenants/{tenantId}/traceability/plans/{versionId}/traceability-plan-v{N}.pdf`. Renderer version constant `traceability-plan-pdf-v1` is written to `pdf_renderer_version` and printed in the footer.

PDF determinism (PLN-010): `creationDate` and `modificationDate` = `effective_at`; every printed timestamp is derived from row data and formatted with `Intl.DateTimeFormat("en-US", { timeZone })` using the tenant timezone plus an explicit UTC offset; fonts are the bundled IBM Plex Sans files (`apps/api/src/modules/billing/assets/`); no images other than the Markiro logo already used by billing; page numbers via the `render` prop; section order fixed by the domain model. A golden SHA-256 for the US-11 seed plan is committed and reviewed like EXP-012.

Audit events (`tenant_audit_events`, `target_type = "traceability_plan_version"`, `target_id = version id`, `actor_user_id = req.userId`, `outcome = success|failure`, `after` carries `tenantId`, `versionNumber`, `status`, plus the fields below):

| Action                                | Extra `after` fields                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `traceability_plan.draft_created`     | `sourceVersionId`                                                 |
| `traceability_plan.draft_updated`     | `changedKeys`                                                     |
| `traceability_plan.approved`          | `effectiveAt`, `configDigest`, `pdfSha256`, `supersededVersionId` |
| `traceability_plan.superseded`        | written on the old row: `supersededByVersionId`                   |
| `traceability_plan.approval_rejected` | `issues` (validation codes), outcome `failure`                    |
| `traceability_plan.downloaded`        | `pdfSha256`, `filename`                                           |
| `traceability_plan.draft_discarded`   | none                                                              |

### Admin UI

`apps/admin/src/pages/traceability/plans/`:

- `PlanVersionsPage` — `PageHeader` "Traceability Plan"; table (version, `StatusChip` with text label, effective date, approver, change summary, actions: view, download PDF); primary action "New draft" (disabled with hint when a draft exists); `EmptyState` for tenants without a plan explaining what the plan is (allowed wording only).
- `PlanEditorPage` — `DataTabs` per section. Derived facts are read-only blocks labelled "Derived from configuration" with a link to the source screen (profile, locations, products); narrative `Textarea` per section; contact `Field`s; change summary. Buttons: Save draft, Preview PDF (opens streamed PDF in a new tab), Approve (`ConfirmDialog` listing the version being superseded and the validation result), Discard draft.
- Banner (`Alert`, warning tone, with icon and text, not color alone): "Configuration changed since version N became effective: TLC source locations, point of contact" — rendered on both pages when `configurationChanged.changed`. For P1 PLN-009 a second `Alert` shows "Annual review due on <date>" when `review_due_at` is within 30 days or past.
- Navigation: a "Traceability" sidebar group (owned by US-00's gating helper) with item "Plan", visible only when the profile is `US_FSMA204_PROCESSOR` and the user has `traceability.read`; editing controls need `traceability.qa.manage`.
- i18n keys `pages.traceability.plans.*` (US-01 convention) added to both `en.json` and `ru.json` (RU strings are required by the app pattern even though RU tenants never see the page). Every key is checked by the US-00 prohibited-wording content test.
- Accessibility (NFR-012): all controls labelled, focus returns to the trigger after dialogs, status chips carry text, the PDF preview link announces that it opens a new tab.

### Station

Not touched.

### Profile gating and RU_CHZ safety

- Routes, navigation and API are gated on the tenant regulatory profile via the US-00 helper; `RU_CHZ` tenants receive 403 `traceability_profile_required` from `/traceability/plans*` and see no navigation entry.
- The migration only adds a table and enum; no existing table or column changes, so RU behavior is unchanged. The RU test suite must stay green; the existing billing and inventory PDF renderers and their assets are not modified, only their font files are imported by path.
- No CommerceML/CHZ types are imported by the plan module (INT-004).

## Testing

- Unit (`packages/domain`): transitions (draft→effective, effective→superseded, illegal moves), `planConfigDigest` stability under key/array reordering, `planConfigChanged` returns changed section keys, `validatePlanForApproval` fails on missing contact/prohibited wording/no TLC source, `farm_map` always not applicable, record-maintenance section prints `retentionDays`, `defaultReviewDueAt`.
- DB (`packages/db`): fresh and upgrade migration; enum, partial unique indexes (second `effective`/`draft` for a tenant rejected), status consistency check (each branch: a draft with any terminal column set, an effective row without `approved_at`/`approval_idempotency_key`, a superseded row without `superseded_by_version_id` are all rejected), composite FK `superseded_by`.
- API e2e (`apps/api/test/traceability-plans.e2e.test.ts`): create → update → approve → new draft → approve chain leaves v1 `superseded` with its original `pdf_sha256`; PUT/DELETE on an effective version → 409; approve twice with the same idempotency key → same row; same key on another version → 409 `idempotency_key_reused`; storage failure during approve leaves the row `draft` and no object; cross-tenant: tenant B's ids → 404 on every route; RU tenant → 403 `traceability_profile_required`; `manager` without `traceability.qa.manage` → 403 on write routes; download only for effective/superseded; audit rows asserted field by field (actor, action, target, outcome, `after.configDigest`, `after.pdfSha256`); `configurationChanged` flips after a location is edited and clears after re-approval (PLN-008).
- PDF: `apps/api/test/traceability-plan-pdf.test.ts` — two renders byte-equal; golden SHA-256 for the seed model; page count; text extraction contains version, effective date, approver, change history, "Not applicable" farm map, baseline ID; prohibited-wording scan of extracted text; date printed in tenant timezone at a DST boundary (NFR-008).
- Admin (`apps/admin/test/traceability-plan-*.test.tsx`): banner shown/hidden by `configurationChanged`; approve dialog blocked with listed issues; "New draft" disabled when a draft exists; keyboard navigation of tabs.
- Browser (acceptance §2.3 "Traceability Plan preview/PDF"): from a clean seed, edit the draft, preview, approve, download; screenshot version list with two versions.
- Negative cases from acceptance §2.4 that apply: prohibited phrase in narrative → rejected; cross-tenant ID → denied; master data edited after approval → historical PDF unchanged.

## Evidence

- `traceability-plan-v1.pdf` and `-v2.pdf` for the seed tenant with SHA-256 recorded; version history screenshot (C-012); the same v2 PDF appearing inside the US-09 package with an identical hash (PLN-010, RQ-006).
- Retention configuration test output referenced by REG-009 and PLN-007 rows in `docs/us/requirements-traceability.md`.
- Golden hash fixture and reviewer note in the PR (EXP-012 style).

## Out of scope

Farm maps, plan templates for non-processor roles, e-signature, email review reminders (PLN-009 P1 is banner-only here), purge/takeout job for expired versions, DOCX export, bilingual PDF, plan comparison/diff view.

## Open questions

| ID         | Question                                                                                                | Options                                                                                                                     | Recommendation                                                                                 | Blocking? |
| ---------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| OQ-US08-1  | Render the PDF synchronously inside the approve request or through a pg-boss job like shift exports?    | (a) synchronous request: upload first, then one short transaction; (b) job with pending/ready states as `invoice_documents` | (a): a few pages, no external inputs, and approval must return an effective version atomically | no        |
| OQ-US08-2  | How is a draft preview delivered?                                                                       | (a) stream bytes from the API with a watermark; (b) store a temporary object and presign                                    | (a); nothing is persisted for drafts                                                           | no        |
| OQ-US08-3  | Immutability enforcement for effective/superseded rows                                                  | (a) service checks + status CHECK; (b) additionally a Postgres trigger rejecting UPDATE/DELETE                              | (a), matching repo conventions (no triggers today); revisit if an audit finding requires (b)   | no        |
| OQ-US08-4  | Abandoned drafts: PLN-001 names only draft/effective/superseded                                         | (a) hard DELETE of draft rows with audit; (b) add `discarded` status                                                        | (a); drafts are not regulated records                                                          | no        |
| OQ-US08-5  | Retention materialization for PLN-007/REG-009                                                           | (a) read `traceability_profiles.retention_days` (US-00, floor 730); (b) per-version `retention_until`; (c) both             | (a) now; (b) only when a purge job exists                                                      | no        |
| OQ-US08-6  | Which capability guards plan drafting and approval?                                                     | (a) reuse US-00 `traceability.qa.manage`; (b) add a dedicated `traceability.plan.manage`                                    | (a); the QA/traceability manager persona owns the plan in `docs/us/demo-scenario.md` §2        | no        |
| OQ-US08-7  | Is the plan offered under `US_GENERIC_LOT_TRACEABILITY`?                                                | (a) processor profile only; (b) generic profile too, worded "traceability procedures"                                       | (a); the plan is an FTR concept and generic tenants must not imply FTR coverage                | no        |
| OQ-US08-8  | May the draft author approve their own version (four-eyes)?                                             | (a) allowed, recorded; (b) require a different user                                                                         | (a) in P0; the synthetic demo has one QA manager                                               | no        |
| OQ-US08-9  | Which fonts back the runtime PDF?                                                                       | (a) billing assets IBM Plex Sans Regular/SemiBold; (b) vendored legal-documents Regular/Bold                                | (a); already loaded by react-pdf and covered by the determinism test                           | no        |
| OQ-US08-10 | Narrative format                                                                                        | (a) plain-text paragraphs; (b) limited markdown; (c) `LegalBlock`-style structured blocks                                   | (a); simplest to render deterministically and to scan for prohibited wording                   | no        |
| OQ-US08-11 | Digest scope: do product classification changes (new covered product) count as "configuration changed"? | (a) only counts and cadence; (b) every product profile change                                                               | (a); the plan describes the procedure, not the product list                                    | no        |
| OQ-US08-12 | What does the PDF print as "generated at"?                                                              | (a) `effective_at` only; (b) a wall-clock render time                                                                       | (a); (b) breaks determinism                                                                    | no        |
| OQ-US08-13 | Change history size in the PDF                                                                          | (a) all prior versions; (b) last 10 plus a count                                                                            | (a) until a tenant exceeds ~20 versions                                                        | no        |
| OQ-US08-14 | PLN-009 reminder channel (P1)                                                                           | (a) banner only; (b) email through `MailJobsService`                                                                        | (a) in P0/P1 scope; email later                                                                | no        |
| OQ-US08-15 | US-08 dependency list: implementation-plan says US-00/02, but TLC source locations come from US-01      | (a) add US-01 as a dependency; (b) render locations section from free text until US-01 lands                                | (a)                                                                                            | no        |
