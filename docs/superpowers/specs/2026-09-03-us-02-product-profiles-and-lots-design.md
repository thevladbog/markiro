# US-02 — Product FTL profiles and traceability lots — Design Spec

> Revised 2026-09-06: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Dated catalog, product-profile and lot persistence/API increments have local evidence; lot UI and event consumers remain design, not acceptance.

**Date:** 2026-09-03

**Status:** Catalog identity decision approved 2026-09-05; domain/contracts, nullable storage with legacy guards and US catalog API implemented and reviewed locally. The [connected catalog UI](../../us/catalog-browser.md) is implemented, locally verified and reviewed. The [product-profile rule/contract foundation](../plans/2026-09-05-us-02-product-profile-contracts.md) and [profile persistence/API increment](../plans/2026-09-05-us-02-product-profile-persistence.md) are implemented locally. The [connected product-profile UI](../../us/catalog-browser.md#product-profile-increment--2026-09-06), [lot domain foundation](../plans/2026-09-06-us-02-lot-domain-foundation.md) and [imported-lot persistence/API](../plans/2026-09-06-us-02-lot-persistence.md) were added on 2026-09-06. Lot UI, identity correction, genealogy storage and event/export consumers remain unimplemented. See implementation progress for validation/review limits; no release acceptance is implied.

**Slice:** US-02 from docs/us/implementation-plan.md; depends on US-00 (tenant regulatory profile, capabilities, profile gate) and US-01 (traceability locations)

**Requirements:** PRD-001, PRD-002, PRD-003, PRD-004, PRD-005, PRD-006, PRD-007, PRD-008, PRD-009, PRD-010, LOT-001, LOT-002, LOT-003, LOT-004, LOT-005, LOT-006, LOT-007, LOT-008, LOT-009, LOT-011 (starred proposal)

**Related:**

- `docs/superpowers/specs/2026-09-03-us-traceability-design.md` — founding ADR; schema conflict 1 (GTIN) is resolved here.
- `docs/superpowers/specs/2026-09-03-us-00-regulatory-profile-design.md` — `RequireTraceabilityProfile`, `profileFeatures`, the seven `traceability.*` capabilities, `ProfileOnly` and `shell.sections.traceability`.
- `docs/superpowers/specs/2026-09-03-us-01-parties-locations-design.md` — `traceability_locations` (TLC source) and `buildLocationDescriptionSnapshot`.
- `docs/superpowers/specs/2026-09-03-us-03-receiving-and-documents-design.md` — first consumer of `buildProductSnapshot`, `origin_event_id` and the lot service.
- `docs/superpowers/specs/2026-09-03-us-04-transformation-design.md` — consumer of lots and genealogy edges; owns `trace_lot_boxes`.
- `docs/superpowers/specs/2026-08-28-product-archived-flag-design.md` — "hide, do not delete" idiom and the partial GTIN unique index.
- `docs/superpowers/specs/2026-08-29-chz-product-groups-design.md` — CHZ product group that must not be reused as FTL category.
- `docs/us/data-dictionary.md` §2, §3, §5, §7.2, §8, §9, §10 — canonical names.
- `docs/us/requirements.md`, `docs/us/acceptance.md` §2.4, `docs/us/demo-scenario.md` §5.2.

## Problem

### Approved catalog boundary — 2026-09-05

The owner approved one shared product/catalog model, not a duplicate US catalog. US and RU instances keep separate databases and infrastructure. GTIN is optional for `US_FSMA204_PROCESSOR` and `US_GENERIC_LOT_TRACEABILITY`, required for `RU_CHZ`; unknown profiles fail closed. A missing GTIN is `null`, never an invented identifier. Supplied GTINs use the existing GS1 validation and canonical GTIN-14 normalization.

The first [implementation increment](../plans/2026-09-05-us-02-catalog-contract-foundation.md) adds a pure domain policy and strict US product contracts only. Existing RU DTOs remain strict and unchanged. These contracts contain no client-selected tenant or regulatory profile; services must resolve current trusted context at the protected boundary. This increment does not yet allow creating a GTIN-less product through a running API.

The current [catalog persistence plan](../plans/2026-09-05-us-02-catalog-persistence.md) implements nullable storage together with legacy consumer guards, followed by an isolated US CRUD API under `/traceability/catalog/products`. Product profile/FTL endpoints remain a separate namespace and are not included. Catalog `updatedAt` begins tracking at the migration baseline for pre-existing rows; no historical RU modification time is reconstructed. Actual US catalog changes maintain it explicitly. The US writer refuses GTIN changes when legacy operational references exist, without changing the existing RU replacement workflow. Future US case/reference writers must coordinate on the product row lock. Implementation and verification are recorded separately from this design intent in the [dated progress record](../../us/implementation-plan.md#us-02-catalog-persistence-increment--2026-09-05).

Nullable persistence ships atomically with consumer guards and regression tests. US P0 CTE readiness does not depend on RU `active` status, CHZ groups, packaging capacities, shifts or Station. The older proposal to change RU product readiness for US shifts is superseded by the shared MVP contract.

The catalog knows a product as a GTIN, a name, capacities and a Chestny ZNAK product group. The U.S. flow needs, per product, a manually reviewed FTL coverage decision with its basis, a structured Product Description that every CTE snapshots, UOM defaults, and — separately from the catalog — lot-level entities with a Traceability Lot Code, a TLC source, an assignment basis, a lifecycle and directed genealogy. None of this may leak into RU tenants or reuse RU fields, and the catalog must stay compatible for the RU product.

## Original codebase baseline — 2026-09-03

This historical inventory predates the catalog increment above. Migration0116 now relaxes `products.gtin14` and adds `updated_at`; current code/tests and the dated progress record supersede the old storage and migration inventory below.

- `products` (`packages/db/src/schema/platform.ts`): `gtin14 char(14) NOT NULL`; `products_tenant_gtin_unarchived_uq` is already a **partial** unique index on `(tenant_id, gtin14) WHERE archived = false`; `products_tenant_id_uq` on `(tenant_id, id)` is the composite-FK anchor. Packaging fields are `box_capacity`, `pallet_capacity`, `shelf_life_days`, `print_name`; `archived boolean NOT NULL DEFAULT false`; `chz_product_group_code` is an integer FK to `chz_product_groups.code`.
- `ProductsService.computeStatus` (`apps/api/src/modules/products/products.service.ts`) returns `active` only when `chzProductGroupCode`, `boxCapacity` and `palletCapacity` are all non-null; `ShiftsService.createShift` (`apps/api/src/modules/shifts/shifts.service.ts`, `product.status === "draft"` branch) rejects draft products. A product without a CHZ group can therefore never be used in a shift today.
- `createProductSchema.gtin` is `z.string().min(1)` (`apps/api/src/modules/products/dto.ts`); the service normalizes it with `normalizeToGtin14` from `packages/domain/src/gs1/gtin.ts` (GTIN-8/12/13/14, check digit, zero-pad). `GET /products?search=` matches `ilike` on name or `gtin14`.
- Direct readers of `schema.products.gtin14` in the API: 12 files (`products`, `shifts`, `boxes`, `kiosk/box-registry`, `pickup-orders`, `inventories` ×2, `chz-exports`, `chz-code-statuses`, `national-catalog`, `exchange`). The station resolves a scanned GTIN through `GET /products?search=` and `candidate.gtin14 === gtin14` (`apps/station/src/pages/NewShift.tsx`); the station SQLite mirror declares `product_mirror.gtin14 text NOT NULL` (`packages/db/src/sqlite/schema.ts`); the kiosk classifies KM codes by the GTIN embedded in the code (`apps/kiosk/src/domain-guard/classify.ts`), not by `products.gtin14`. The label model exposes a `product.gtin` field (`packages/domain/src/labels/model.ts`).
- `product_regulatory_profiles` (`packages/db/src/schema/product-regulatory.ts`) is the RU per-product regulatory record: separate table, key `(tenant_id, product_id)`, composite FK `product_regulatory_profiles_tenant_product_fk` to `products(tenant_id, id)`, reviewer columns as `text(...).references(() => user.id, { onDelete: "set null" })`, closed value sets as `pgEnum`. It has an API (`apps/api/src/modules/product-regulatory`, routes under `/products/:id/regulatory-*`) but no admin UI yet.
- Audit: `tenant_audit_events` (`packages/db/src/schema/team.ts`) with `organization_id`, `actor_user_id`, `action`, `outcome`, `target_type`, `target_id`, `before`, `after`, `request_id`; written directly by services (see `ProductsService` image audit, action `product.image.replaced`, `outcome: "success" | "failure"`).
- Authorization: `CABINET_CAPABILITY` (`packages/domain/src/access/cabinet.ts`), controller decorators `@RequirePermissions` / `@AllowStationOrPermissions`, guard chain `TenantGuard, AuthorizationGuard, SubscriptionAccessGuard` (`apps/api/src/modules/products/products.controller.ts`). Admin uses `useCan` / `RequireCapability` (`apps/admin/src/access/context.tsx`) and a static nav list in `apps/admin/src/layout/AppShell.tsx`.
- Admin catalog: `apps/admin/src/pages/catalog/index.tsx` (table + filters + `Outlet`), `ProductPanelRoute.tsx` (SidePanel routes `catalog/new`, `catalog/:productId/edit` in `apps/admin/src/app.tsx`), `ProductForm.tsx`. i18n is one flat JSON per language (`apps/admin/src/i18n/en.json`, `ru.json`, keys `pages.catalog.*`, `nav.*`); missing keys throw in tests.
- Schema registration: `packages/db/src/schema.ts` re-exports every schema file; latest migration is `0111_label_template_scope_and_defaults.sql`. Schema tests use `getTableConfig` (`packages/db/test/label-template-scope.test.ts`); composite-FK denial tests live in `packages/db/test/tenant-isolation.test.ts`; migration-content tests read the SQL file (`tenant-operational-timezone-migration.test.ts`).
- `org_profiles.time_zone` (`packages/db/src/schema/org-profile.ts`) defaults to `Europe/Moscow`; US-00 makes U.S. tenants set an explicit zone.

## Design

### Data model

Product profiles are implemented under `packages/db/src/schema/traceability-products.ts`, exported from `packages/db/src/schema.ts`, with additive migration0117. Imported lot records are implemented under `packages/db/src/schema/traceability-lots.ts` with additive migration0118. Genealogy/event tables require subsequent additive migrations. Nullable GTIN storage and the catalog update timestamp already belong to migration0116; do not repeat or rewrite these migrations. Nothing existing is renamed.

Enums (`pgEnum`):

- `traceability_coverage_status`: `covered`, `contains_ftl_same_form`, `not_covered`, `unknown`, `exemption_review_required` (PRD-003).
- `tlc_assignment_basis`: `transformation`, `initial_packing`, `first_land_receiving`, `exempt_supplier_receipt`, `imported` (LOT-004; the last three of the P0 set are `transformation`, `imported`, `exempt_supplier_receipt`; the rest are accepted by the DB but rejected by the P0 API validator as reserved).
- `traceability_lot_status`: `active`, `consumed`, `shipped`, `quarantined`, `recalled`, `archived` (LOT-009).

`product_traceability_profiles` (PRD-001, 1:1 with `products`, same key shape as `product_regulatory_profiles`):

| Column                                                 | Type / rule                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `tenant_id`, `product_id`                              | PK `(tenant_id, product_id)`; composite FK to `products(tenant_id, id)`                                  |
| `coverage_status`                                      | enum NOT NULL DEFAULT `unknown`                                                                          |
| `coverage_rationale`                                   | text; API requires it when status is not `unknown` in `US_FSMA204_PROCESSOR`                             |
| `ftl_category`, `ftl_source_url`, `ftl_source_version` | text; category is free text from a domain-side suggestion list, never `chz_product_group_code` (PRD-009) |
| `ftl_ingredient_note`                                  | text, P1 (PRD-005)                                                                                       |
| `evidence_url`                                         | text, P1 (PRD-010); an object-storage attachment is deferred to DOC-003 in US-03                         |
| `reviewed_by`, `reviewed_at`, `review_due_at`          | historical cabinet `user.id` text snapshot without live FK; `timestamptz`; `timestamptz` P1 (PRD-006)    |
| `product_name`, `brand_name`, `commodity`, `variety`   | text; `product_name` NOT NULL, seeded from `products.name` on first save (PRD-002)                       |
| `packaging_size_value`, `packaging_size_uom`           | `numeric(12,3)` + text; CHECK both null or both set, value > 0 (PRD-002, PRD-008)                        |
| `packaging_style`                                      | text (bag, cup, case, bulk, …)                                                                           |
| `default_quantity_uom`                                 | text; default UOM offered on CTE lines (PRD-008)                                                         |
| `created_at`, `updated_at`                             | `timestamptz` defaults                                                                                   |
| `revision`                                             | positive integer, starts at 1; unsaved API defaults use 0                                                |

The persistence increment retains reviewer ID/time as historical provenance, not a live user relationship: deleting an account must not null the attribution or make a reviewed profile unreadable. Current membership still authorizes every write. Only the opaque ID is copied, not names/emails. This supersedes the original `ON DELETE SET NULL` proposal. Package decimals are strictly validated before storage and returned padded to three decimals with no rounding or conversion; equivalent decimal spellings are no-ops. The v1 UOM vocabulary also has storage checks, so changing accepted units requires a deliberate additive migration.

`traceability_lots` (LOT-001, implemented record subset; event origin and operational dates are deferred):

| Column                                            | Type / rule                                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                              | `uuid` PK default random; `unique (tenant_id, id)` for downstream composite FKs                                                                              |
| `tenant_id`, `product_id`                         | composite FK to `products(tenant_id, id)`                                                                                                                    |
| `tlc`                                             | text NOT NULL; 1..120 code points, outer-space canonical form, no C0/C1 controls; API additionally rejects invalid Unicode and noncanonical outer whitespace |
| `assignment_basis`                                | enum NOT NULL                                                                                                                                                |
| `source_location_id`                              | `uuid` nullable; composite FK to `traceability_locations(tenant_id, id)` (US-01)                                                                             |
| `source_reference_kind`, `source_reference_value` | nullable pair; `web_url`, exact value at most 1024 UTF-8 bytes (LOT-003 alternative)                                                                         |
| `source_reference_location_id`                    | nullable UUID; composite tenant FK to locations; mandatory with a reference                                                                                  |
| `status`                                          | enum NOT NULL DEFAULT `active`                                                                                                                               |
| `revision`, `last_status_reason`                  | positive integer starts at 1; nullable internal retry metadata, trimmed reason 3..2000                                                                       |
| `created_by`, `updated_by`                        | historical opaque actor IDs, required text with no live user FK                                                                                              |
| `created_at`, `updated_at`                        | `timestamptz`                                                                                                                                                |

The current source shape is either entirely absent, one location, or a typed reference with an explicitly resolved same-tenant location. Storage rejects partial or competing forms. `web_url` requires absolute HTTP(S), without credentials, whitespace, controls or backslashes; scheme case is accepted without changing the stored value. No URL is fetched or canonicalized. GLN/FFRN are deferred. A selected location may still have an incomplete description: a reference/ID alone is not finalizability. Future finalization must validate and freeze the complete resolved description and exact reference content; a processor transformation requires its actual source location.

Uniqueness per LOT-007 (`tenant + source identity + TLC`), implemented as three partial unique indexes so the same external TLC from different sources coexists and the internal UUID stays the only global identity. Product is excluded; archive never releases identity:

- `traceability_lots_location_tlc_uq` on `(tenant_id, source_location_id, tlc) WHERE source_location_id IS NOT NULL`;
- `traceability_lots_reference_tlc_uq` on `(tenant_id, source_reference_kind, source_reference_value, tlc) WHERE source_reference_kind IS NOT NULL` (resolved location is not part of reference identity);
- `traceability_lots_missing_source_tlc_uq` on `(tenant_id, tlc) WHERE source_location_id IS NULL AND source_reference_kind IS NULL` (guards duplicate incomplete records).

Source is nullable because LOT-003 gates _finalization_, not row creation. The completeness/finalization gate and source/identity correction route are still pending; the current API cannot complete a source-less record after creation. Historical actor IDs and audit before/after snapshots survive account deletion. Plain indexes: `(tenant_id, product_id)`, `(tenant_id, status)`, `(tenant_id, tlc)`.

`lot_genealogy_edges` (LOT-008, target design only; not included in migration0118):

| Column                                       | Type / rule                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                                         | `uuid` PK                                                                                    |
| `tenant_id`, `input_lot_id`, `output_lot_id` | composite FKs to `traceability_lots(tenant_id, id)`; CHECK `input_lot_id <> output_lot_id`   |
| `transformation_event_id`                    | `uuid` NOT NULL; no FK in this slice, US-04 adds the composite FK to `transformation_events` |
| `quantity_used`, `quantity_uom`              | `numeric(14,3)` nullable + text; semantics fixed in US-04 (OQ-US04-3)                        |
| `created_at`                                 | `timestamptz`                                                                                |

Unique `(tenant_id, transformation_event_id, input_lot_id, output_lot_id)`; indexes on `(tenant_id, input_lot_id)` and `(tenant_id, output_lot_id)`. Edges are never deleted; a superseded revision is distinguished through the event status (US-04).

Cycle prevention: an edge whose `output_lot_id` is already an ancestor of `input_lot_id` is rejected. The pure domain function filters the supplied edge view by tenant. The inserting service must select current event revisions consistently and serialize concurrent topology changes; locking only a candidate's two endpoints does not in general prevent cycles created by concurrent disjoint candidates. Transaction/locking and amendment-history tests belong to US-04; they are not proved by a pure graph test.

GTIN (OQ-US02-1, implemented locally in migration0116): `ALTER TABLE products ALTER COLUMN gtin14 DROP NOT NULL`. The existing partial unique index tolerates NULLs. Preserve the RU API contract with required GTIN; use an additive US contract and server-resolved profile for optional GTIN writes to the same product model.

Consumer checks and changes required before enabling nullable storage must ship with the DDL. The following is an audit checklist, not a claim that type widening alone proves safety:

1. Keep `apps/api/src/modules/products/dto.ts` strict for RU. Add US-only catalog routes and OpenAPI responses with nullable `gtin14`; do not broaden the existing RU endpoint's accepted input.
2. Preserve required-GTIN RU writes and validate persisted GTIN at RU response boundaries. The US service resolves tenant/profile and authorization from current trusted state, normalizes supplied GTINs, and stores null only for a known US profile. Search and uniqueness must handle null explicitly.
3. `apps/api/src/modules/shifts/shifts.service.ts` — `createShift` rejects a GTIN-less product with the same 422 path it already uses for `draft` and `archived` products (the draft/archived checks stay as they are).
4. `apps/api/src/modules/kiosks/kiosks.service.ts` — `setProducts` rejects GTIN-less products the same way, so no kiosk product list ever carries `NULL`.
5. Station mirror — keep `product_mirror.gtin14 text NOT NULL`; verify every shift bundle and sync path, including historical data. Do not assume creation-time guards alone protect subsequent reads or GTIN updates.
6. Label engine — keep existing RU barcode behavior. Explicitly reject unsupported GTIN-less input before a GTIN-dependent renderer; do not silently omit barcode elements. US label behavior remains a US-10 decision.
7. Audit the remaining direct readers (`boxes`, `pickup-orders`, `inventories`, `chz-exports`, `chz-code-statuses`, `national-catalog`, `exchange`) and downstream consumers. Preserve tenant/edition boundaries and add precise guards where a GTIN is required; widening types or asserting non-null is not sufficient.

Regression tests must preserve existing RU validation/error behavior, prove US null persistence and tenant denial, and ensure GTIN-less products cannot enter unsupported operational or offline payloads. The domain `GTIN_REQUIRED` code is not a claim that the current RU DTO already emits that exact HTTP error.

### Domain rules

New pure files under `packages/domain/src/traceability/` (sub-folders `products/` and `lots/`, next to US-03's `events/`, `documents/`, `receiving/`; no imports from CommerceML, CHZ or national-catalog code, INT-004):

- `products/coverage.ts` — `COVERAGE_STATUSES`, `EXPORT_BLOCKING_COVERAGE = ["unknown", "exemption_review_required"]`, `validateCoverageReview(profile, tenantProfileCode)` returning `{ field, code }[]` (rationale, category, source URL, reviewer required for `covered`/`contains_ftl_same_form` under `US_FSMA204_PROCESSOR`; nothing enforced under `US_GENERIC_LOT_TRACEABILITY`).
- `products/snapshot.ts` — `ProductDescriptionSnapshot` (`productName`, `brandName`, `commodity`, `variety`, `packagingSize: { value, uom } | null`, `packagingStyle`, `gtin: string | null`, `sourceProductId`, `snapshotVersion: 1`) and `buildProductSnapshot(product, profile)`; deterministic key order, strings trimmed, no defaults invented. US-03/US-04/US-05 call it at finalization.
- `lots/tlc.ts` — implemented `normalizeTlc(raw)` for entry (outer trim, reject controls and invalid Unicode before trimming, 1..120 Unicode code points, otherwise opaque and case-sensitive). `formatDemoTlc({ prefix, date, suffix })` produces `NRF-260915-APL01` style suggestions for valid civil dates, without assignment or uniqueness guarantees. Persisted/snapshot text is validated without normalization.
- `lots/assignment.ts` — implemented `P0_ASSIGNMENT_BASES` and `assertLotAssignmentBasis(basis, context)`: manual imported only; receiving imported/exempt-supplier-receipt; transformation transformation only. Context must be server-selected. This is not proof of exemption review, missing-supplier-TLC checks or event finalization.
- `lots/status.ts` — implemented manual transition table: `active → consumed | shipped | quarantined | recalled | archived`; `quarantined → active | recalled | archived`; `consumed | shipped → recalled | archived`; `recalled → archived`; `archived` terminal. `assertLotTransition(from, to)` rejects unknown values and self-transitions; a service must separately handle idempotent retries. Pending OQ-US05-5: shipping recalculation may need system-only `shipped → active`, never through a manual status body. No recalculation/context override is implemented in this increment.
- `lots/completeness.ts` — planned, not implemented: validate product, TLC and a complete source description or validated typed reference resolving that description; processor transformation requires its actual location. Return structured gaps; do not equate a nonblank source string/ID with finalizability.
- `lots/genealogy.ts` — implemented `wouldCreateCycle(edges, candidate)`, `ancestorsOf(edges, tenantId, lotId)`, `descendantsOf(edges, tenantId, lotId)` (future US-06 consumers). Iterative traversal filters tenant, returns unique ordinal-sorted IDs excluding the starting lot and terminates on cyclic input without a depth cutoff. Callers select the current or pinned event-revision view and establish authorization/completeness; no readiness conclusion is returned.
- `uom.ts` — versioned vocabulary `UOM_CODES_V1` (`lb`, `oz`, `kg`, `g`, `each`, `case`, `bag`, `cup`, `gal`, `l`) with no conversion functions (PRD-008); US-03's `quantity.ts` suggestions must read this list rather than declare its own (OQ-US02-4).

### Contracts and API

Implemented Zod contracts in `packages/platform-contracts/src/traceability/products.ts`: `productTraceabilityProfileSchema` (including revision), `upsertProductTraceabilityProfileSchema` (editable fields only), and `putProductTraceabilityProfileSchema` (editable fields plus mandatory `expectedRevision`). Lot field contracts in `lots.ts` define entry/preserved TLC, assignment vocabularies, status and strict `changeLotStatusSchema` (`status`, trimmed `reason` 3..2000). `lot-records.ts` implements typed source, full create/read/list schemas and `postLotStatusSchema` with mandatory `expectedRevision`. Client tenant, actor and system context are rejected. List filters cover product, exact TLC, resolved/source location, assignment basis, status and literal substring search, with bounded limit/offset; ordering is stable by created time and UUID.

Profile persistence lives in `apps/api/src/modules/traceability/products/`, lot persistence in `traceability/lots/`. Both controllers are registered only in the isolated `UsDevelopmentModule`. The routes below are implemented; lot paths remain unavailable through the browser proxy:

| Method | Route                               | Capability (US-00)                                                                                    | Notes                                                                                                                                                            |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/traceability/products/:productId` | `traceability.read`                                                                                   | 404 when the product is another tenant's; returns defaults when no row exists yet                                                                                |
| PUT    | `/traceability/products/:productId` | `traceability.master_data.write` (+ `traceability.qa.manage` when coverage fields change, OQ-US02-12) | Full document + expectedRevision; stale divergent save → 409; actual coverage change stamps trusted reviewer/time                                                |
| GET    | `/traceability/lots`                | `traceability.read`                                                                                   | List with filters above                                                                                                                                          |
| POST   | `/traceability/lots`                | `traceability.master_data.write`                                                                      | Imported lot only; transformation/exempt-receipt assignment belongs to the corresponding event; duplicate per LOT-007 → 409 `LOT_DUPLICATE` with the existing id |
| GET    | `/traceability/lots/:id`            | `traceability.read`                                                                                   | Stored record only; no product snapshot, genealogy or event timeline yet                                                                                         |
| POST   | `/traceability/lots/:id/status`     | `traceability.qa.manage`                                                                              | Current expectedRevision + reason + valid transition; 200 on success, 409 on divergent stale write                                                               |

Current profile boundary: `UsSessionGuard` verifies the US session/MFA; the store reloads and locks current membership and the valid US regulatory profile in its transaction. The legacy proposal to register these routes in the shared RU controller/guard chain is superseded. No RU route is registered; a malformed/RU profile in the US database fails closed with 503, and missing profile/membership permission returns 403. Every query is tenant-scoped in `WHERE` in addition to composite FKs. Product-row locking serializes initial inserts and later saves. Unchanged current saves and identical immediate retries create no revision, timestamps or audit; all other mismatched revisions return 409. Description-only saves preserve coverage stamps, including for managers. Generic profiles permit only unknown coverage with no classification metadata. Future `POST /traceability/lots` with `assignmentBasis` outside the P0 set must return 422 `ASSIGNMENT_BASIS_RESERVED`.

Lot creation locks current product/source-location/party rows and rejects archived references. Concurrent same-source/TLC creates return one record and one audit, with a tenant-scoped 409 for the other command. QA writes lock the lot, increment revision and audit atomically. Only an identical immediate previous-revision retry by the same actor returns the stored result without another audit; a current-revision self-transition returns 422. No DELETE, PATCH identity, event route or system status override is registered.

Audit rows in `tenant_audit_events`: implemented profile and lot saves record `outcome: "success"` and a server-generated `request_id`, atomically with the data. Failed audit insertion rolls back all writes. The actions below are implemented:

| Action                                          | target_type                    | before / after                                                      |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `traceability.product_profile.updated`          | `traceability_product_profile` | full before/after profile snapshots                                 |
| `traceability.product_profile.coverage_changed` | `traceability_product_profile` | full before/after, including rationale/source/reviewer              |
| `traceability.lot.created`                      | `traceability_lot`             | `null` / lot                                                        |
| `traceability.lot.status_changed`               | `traceability_lot`             | full before/after lot records, with reason added to after (LOT-009) |

OpenAPI: same `ApiZod*` decorators as `products.controller.ts`; the coverage gate (`pnpm --filter @markiro/api` OpenAPI coverage test) must include the new routes.

### Admin UI

Current isolated implementation: `apps/admin/src/us/catalog/profile-view.tsx` opens from Products, with grouped description, packaging and coverage sections, EN/ES copy, generic not-assessed state, role-aware fields and revision-conflict recovery. It uses the US-only client and exact UUID proxy, not the shared RU router. Reviewer IDs are shown as IDs; no user display names are fabricated. Source suggestions, history, table-wide coverage summaries and lot screens below remain target design. See [browser scope and evidence](../../us/catalog-browser.md#product-profile-increment--2026-09-06).

`apps/admin/src/pages/traceability/` with i18n under `pages.traceability.*` (en/es):

- **Product FTL review card** — route `catalog/:productId/traceability` rendered as a `SidePanel` next to `catalog/:productId/edit` (same `Outlet` context, `closeCatalogPanel`). Sections: coverage (`RadioGroup` with the five statuses, rationale `Textarea`, category `Combobox` with suggestions and free text, source URL + version, reviewer/date read-only, review due `DatePicker` P1); product description (name, brand, commodity, variety, packaging size value + UOM `Select`, packaging style, default UOM). A `StatusChip` with text (`Unknown`, `Covered`, …) also appears in the catalog table column when the tenant profile is U.S. `unknown` shows an inline `Alert` "blocks compliance-ready export". Under `US_GENERIC_LOT_TRACEABILITY` the coverage section is replaced by the fixed statement "FTR applicability not assessed in this profile; general lot traceability only" (PRO-005) and only the description section is editable.
- **Lots list** — `/traceability/lots`: `FilterBar` (product, status, TLC search), `Table` with TLC, product, source (location name or reference), basis, status chip, production date; `EmptyState` with "Lots are created by Receiving and Transformation events; you can also add an imported lot manually"; `Pager`.
- **Lot card** — `/traceability/lots/:id`: header TLC + status chip + actions (`Change status` with reason `ConfirmDialog`), `DefinitionGrid` for product description, source, basis, dates; genealogy neighbours (inputs/outputs) as lists linking to other lot cards; box count placeholder filled by US-04; event timeline filled by US-03/US-05.
- Navigation: `nav.traceabilityLots` entry in US-00's `shell.sections.traceability` group of `AppShell.tsx` with `feature: "traceability"` and capability `traceability.read`, so `AppShell`'s feature filter hides it for RU tenants; routes are wrapped in `RequireCapability` and US-00's `ProfileOnly`.
- Accessibility (NFR-012): all inputs labelled through `Field`, status conveyed by text in `StatusChip`, error summaries focusable, keyboard-only flow tested in the admin browser suite.

### Station

Not touched. The station keeps resolving products by GTIN; a GTIN-less U.S. product cannot be selected on a station until US-10, and `ShiftsService.createShift` rejects it (see OQ-US02-1) so the SQLite `product_mirror.gtin14 NOT NULL` column is never violated.

### Profile gating and RU_CHZ safety

- All new tables are empty for RU tenants; no RU code path reads them.
- Routes and navigation are hidden behind the US-00 profile guard/hook; RU tenants get 403 and see no new menu items.
- The GTIN relaxation is DDL-only for RU tenants: the service keeps `gtin` mandatory when the tenant profile is `RU_CHZ`, the partial unique index is unchanged, existing RU tests (`products.e2e`, `shifts`, station, kiosk, exchange) are re-run unchanged and must stay green (PRO-003).
- `chz_product_group_code` is never read or written by the traceability module (PRD-009); a lint-level import boundary test (`apps/api/test/traceability-import-boundary.test.ts`) asserts the module does not import `exchange/`, `chz-*` or `national-catalog`.

## Testing

- Unit (`packages/domain`): coverage validator matrix per profile; snapshot builder determinism and trimming; `normalizeTlc` edge cases (whitespace, control chars, 120 limit, unicode kept); `formatDemoTlc` golden strings `OSS-260914-A1`, `NRF-260915-APL01`; lot transitions incl. rejected ones; `wouldCreateCycle` on chains and diamonds; `assertLotFinalizable` gaps.
- DB (`packages/db/test`): `traceability-schema.test.ts` via `getTableConfig` (PKs, composite FK names, the three partial indexes, checks); migration-content test asserting the products change is exactly one `ALTER COLUMN gtin14 DROP NOT NULL` with no `UPDATE`/`DELETE`; fresh migrate and upgrade from the US-01 migration through `runtime-migrate.test.ts` pattern; `tenant-isolation.test.ts` extended: lot pointing at tenant B's product or location → `23503`; same TLC + same source → `23505`; same TLC + different source location → accepted.
- API e2e (`apps/api/test/traceability-products.e2e.test.ts`, `traceability-lots.e2e.test.ts`): RU tenant → 403; product of another tenant → 404; PUT idempotent; coverage change writes the audit row with actor; `unknown` reported as export-blocking flag on GET; POST lot duplicate → 409 with existing id; reserved basis → 422; status transitions and reasons; U.S. tenant creates a product without `gtin` (201) while RU tenant gets 400 `GTIN_REQUIRED`.
- Admin (`apps/admin/test`): card renders per profile, prohibited-phrase content test on new i18n keys (REG-002), keyboard flow for the review form.
- Negative cases from `docs/us/acceptance.md` §2.4 covered here: "TLC without source → error" (finalization validator), "Cross-tenant ID supplied → denied", "Covered product has unknown FTL status → blocked" (flag surfaced; the block itself is asserted in US-03/US-04/US-07 finalization and export tests).

## Evidence

- C-004: screenshot of the fresh-cut apple product with its FTL review card (covered, category "Fruits (fresh-cut)", FDA-02 source URL and `US-REG-2026-09-03` version).
- C-005: JSON of `GET /traceability/products/:id` plus the audit row for the coverage change.
- C-006: lot cards for `OSS-260914-A1`, `OSS-260914-A2` (imported, source Orchard Slice Supply) and `NRF-260915-APL01` (transformation, source North River) and the `GET /traceability/lots` response.
- Migration test output and the tenant-isolation run included in the slice verification report.

## Out of scope

Receiving/transformation/shipping events and their snapshots (US-03/04/05), the lot-box bridge (US-04), search and graph endpoints (US-06), export field registry (US-07), readiness dashboard that lists overdue reviews (US-08/US-11 consume `review_due_at`), object-storage attachments for the classification basis (DOC-003), configurable TLC regex policy (P1, see OQ-US02-5), any automatic coverage or exemption decision.

## Open questions

| ID         | Question                                                                                                                                                                     | Options                                                                                                                                           | Recommendation                                                                                                                                                                                                                | Blocking? |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US02-1  | How can a US product omit GTIN without a second catalog?                                                                                                                     | Shared product model with nullable storage; separate US/RU contracts and instances.                                                               | **Accepted by owner 2026-09-05.** GTIN optional for known US profiles, mandatory for RU. First increment adds policy/contracts only; nullable DDL must ship with the full consumer audit and guards. No invented identifiers. | no        |
| OQ-US02-2  | Should US P0 depend on RU product readiness or shifts?                                                                                                                       | Couple to RU readiness; or keep CTE readiness separate.                                                                                           | **Resolved by shared MVP contract.** US P0 events do not require Station, shifts, CHZ groups or capacities. Keep RU readiness unchanged; any US Station readiness rule belongs to US-10.                                      | no        |
| OQ-US02-3  | Should a lot row be allowed without source (DB nullable) or must source be NOT NULL?                                                                                         | nullable + finalization validator; NOT NULL with a placeholder reference                                                                          | Nullable; LOT-003 is a finalization rule and the completeness report must be able to show the gap.                                                                                                                            | no        |
| OQ-US02-4  | UOM as a Postgres enum or free text validated against a versioned vocabulary?                                                                                                | `pgEnum`; text + `UOM_CODES_V1` in domain + Zod enum                                                                                              | Implemented as text with v1 domain/contract validation and storage checks. New accepted units require an additive migration; no conversions.                                                                                  | no        |
| OQ-US02-5  | Where does the optional TLC format policy (LOT-002 "configurable length/regex") live?                                                                                        | column on US-00's `traceability_profiles`; per-product; not in P0                                                                                 | Not in P0; P1 as `tlc_policy jsonb` on the tenant traceability profile (US-00 entity), validated in `tlc.ts`.                                                                                                                 | no        |
| OQ-US02-6  | Reviewer identity: cabinet `user.id` or `employees.id`?                                                                                                                      | `user.id` (as `product_regulatory` does); employee                                                                                                | `user.id`; QA/reviewer is a cabinet role (PRO-006), employees are station operators.                                                                                                                                          | no        |
| OQ-US02-7  | Product description fields on the profile table versus new columns on `products`?                                                                                            | profile table; `products` columns                                                                                                                 | Profile table (PRD-001 "without duplicating the catalog"; RU catalog untouched).                                                                                                                                              | no        |
| OQ-US02-8  | Profile endpoint semantics: PUT upsert or PATCH partial?                                                                                                                     | PUT; PATCH                                                                                                                                        | Implemented as full PUT plus expectedRevision. Current no-op and identical immediate retry preserve the record; stale divergent saves conflict.                                                                               | no        |
| OQ-US02-9  | Reuse `tenant_audit_events` or add a traceability-specific audit table?                                                                                                      | reuse; new table                                                                                                                                  | Reuse; export runs (US-09) can filter by `action LIKE 'traceability.%'`.                                                                                                                                                      | no        |
| OQ-US02-10 | Under `US_GENERIC_LOT_TRACEABILITY`, hide the coverage section or show it read-only?                                                                                         | hidden with fixed statement; read-only                                                                                                            | Hidden with the fixed "FTR applicability not assessed in this profile" statement (PRO-005, Scenario B rule).                                                                                                                  | no        |
| OQ-US02-11 | Should `lot_genealogy_edges.transformation_event_id` be NOT NULL now (FK added by US-04) or nullable?                                                                        | NOT NULL, no FK yet; nullable                                                                                                                     | NOT NULL without FK; every edge in P0 comes from a transformation, and US-04 adds the FK additively.                                                                                                                          | no        |
| OQ-US02-12 | US-00 assigns "product traceability profile" to `traceability.master_data.write` and "FTL review" to `traceability.qa.manage`; the profile PUT carries both kinds of fields. | one capability for the whole PUT; per-field check (description → master_data.write, coverage/category/source/reviewer → qa.manage); two endpoints | Per-field check inside one PUT: a user with master_data.write may complete the description, only QA changes coverage (PRO-006 minimal permissions). Denial test per field group.                                              | no        |
| OQ-US02-13 | Can a lot's identity (TLC, source, product) be amended once a finalized event references it? US-03 defers this to US-02 (OQ-US03-4).                                         | locked in P0 (void + new event); lot amendment with cascade to snapshots                                                                          | Locked in P0: `PATCH` of identity fields → 409 `lot_identity_locked` when any finalized event references the lot; only status, dates and operational fields stay editable.                                                    | no        |

## Revised lot and profile boundary

Manual creation accepts imported records only; it cannot bypass CTE finalization with `assignmentBasis=transformation` or `exempt_supplier_receipt`. The generic profile never asserts that a food is outside the FTR. Nullable GTIN requires a full consumer audit, not an assumption that the blast radius ends at API selects. U.S. P0 does not expose Station/kiosk or require packaging capacities merely to record an event.
