# US-02 — Product FTL profiles and traceability lots — Design Spec

> Revised 2026-09-04: read the [shared MVP contract](../../us/mvp-contract.md) first. It resolves cross-slice scope and safety rules and supersedes conflicting draft recommendations below. Design only; implementation is not claimed.

**Date:** 2026-09-03

**Status:** Draft for review (not implemented)

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

The catalog knows a product as a GTIN, a name, capacities and a Chestny ZNAK product group. The U.S. flow needs, per product, a manually reviewed FTL coverage decision with its basis, a structured Product Description that every CTE snapshots, UOM defaults, and — separately from the catalog — lot-level entities with a Traceability Lot Code, a TLC source, an assignment basis, a lifecycle and directed genealogy. None of this may leak into RU tenants or reuse RU fields, and the catalog must stay compatible for the RU product.

## Key facts of the codebase

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

All tables go into new `packages/db/src/schema/traceability.ts` (exported from `packages/db/src/schema.ts`), one additive migration (`NNNN_us_traceability_products_and_lots.sql` — after US-00 `0112` and US-01 `0113`; renumber at implementation time to the next free number). Nothing existing is renamed; the only change to an existing table is the optional GTIN relaxation below (OQ-US02-1).

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
| `reviewed_by`, `reviewed_at`, `review_due_at`          | `text` FK `user.id` set null; `timestamptz`; `timestamptz` P1 (PRD-006)                                  |
| `product_name`, `brand_name`, `commodity`, `variety`   | text; `product_name` NOT NULL, seeded from `products.name` on first save (PRD-002)                       |
| `packaging_size_value`, `packaging_size_uom`           | `numeric(12,3)` + text; CHECK both null or both set, value > 0 (PRD-002, PRD-008)                        |
| `packaging_style`                                      | text (bag, cup, case, bulk, …)                                                                           |
| `default_quantity_uom`                                 | text; default UOM offered on CTE lines (PRD-008)                                                         |
| `created_at`, `updated_at`                             | `timestamptz` defaults                                                                                   |

`traceability_lots` (LOT-001):

| Column                           | Type / rule                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                             | `uuid` PK default random; `unique (tenant_id, id)` for downstream composite FKs                    |
| `tenant_id`, `product_id`        | composite FK to `products(tenant_id, id)`                                                          |
| `tlc`                            | text NOT NULL; CHECK `length(btrim(tlc)) between 1 and 120` (LOT-002, opaque)                      |
| `assignment_basis`               | enum NOT NULL                                                                                      |
| `source_location_id`             | `uuid` nullable; composite FK to `traceability_locations(tenant_id, id)` (US-01)                   |
| `source_reference`               | text nullable (LOT-003 alternative)                                                                |
| `status`                         | enum NOT NULL DEFAULT `active`                                                                     |
| `production_date`, `expiry_date` | `date`, operational only (LOT-011, P1)                                                             |
| `origin_event_id`                | `uuid` nullable, reserved; the composite FK to `traceability_events` is added by US-03's migration |
| `created_by`, `updated_by`       | `text` FK `user.id` set null                                                                       |
| `created_at`, `updated_at`       | `timestamptz`                                                                                      |

Uniqueness per LOT-007 (`tenant + source identity + TLC`), expressed as three partial unique indexes so the same external TLC from different sources coexists and the internal UUID stays the only global identity:

- `traceability_lots_tenant_srcloc_tlc_uq` on `(tenant_id, source_location_id, tlc) WHERE source_location_id IS NOT NULL`;
- `traceability_lots_tenant_srcref_tlc_uq` on `(tenant_id, source_reference, tlc) WHERE source_location_id IS NULL AND source_reference IS NOT NULL`;
- `traceability_lots_tenant_nosrc_tlc_uq` on `(tenant_id, tlc) WHERE source_location_id IS NULL AND source_reference IS NULL` (guards duplicate source-less drafts).

Source is nullable at the DB level because LOT-003 gates _finalization_, not row creation (a receiving draft may reference a lot before the source is known); the domain validator is the gate. Plain indexes: `(tenant_id, product_id)`, `(tenant_id, status)`, `(tenant_id, tlc)`.

`lot_genealogy_edges` (LOT-008):

| Column                                       | Type / rule                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                                         | `uuid` PK                                                                                    |
| `tenant_id`, `input_lot_id`, `output_lot_id` | composite FKs to `traceability_lots(tenant_id, id)`; CHECK `input_lot_id <> output_lot_id`   |
| `transformation_event_id`                    | `uuid` NOT NULL; no FK in this slice, US-04 adds the composite FK to `transformation_events` |
| `quantity_used`, `quantity_uom`              | `numeric(14,3)` nullable + text; semantics fixed in US-04 (OQ-US04-3)                        |
| `created_at`                                 | `timestamptz`                                                                                |

Unique `(tenant_id, transformation_event_id, input_lot_id, output_lot_id)`; indexes on `(tenant_id, input_lot_id)` and `(tenant_id, output_lot_id)`. Edges are never deleted; a superseded revision is distinguished through the event status (US-04).

Cycle prevention: an edge whose `output_lot_id` is already an ancestor of `input_lot_id` is rejected. The check is a pure function over the tenant's edge set (domain) executed inside the inserting transaction with the two lot rows locked `FOR UPDATE`; no DB trigger, matching the repository's convention of service-level invariants.

GTIN (OQ-US02-1, recommended option): `ALTER TABLE products ALTER COLUMN gtin14 DROP NOT NULL`. The existing partial unique index already tolerates NULLs. The API keeps `gtin` mandatory for `RU_CHZ` tenants (server rule, so RU behaviour is unchanged) and optional for U.S. profiles.

Consumer changes required before the migration is enabled (if OQ-US02-1 is decided as (a); each item ships in the same PR as the DDL, ordered so the column is never NULL for a consumer that cannot handle it):

1. `apps/api/src/modules/products/dto.ts` — `createProductSchema.gtin` / update DTO become optional; the OpenAPI schema marks `gtin14` nullable.
2. `apps/api/src/modules/products/products.service.ts` — `normalizeOrThrow` is called only when `gtin` is present; when absent the service reads the tenant profile and answers 400 `GTIN_REQUIRED` for `RU_CHZ`, `NULL` otherwise; `GET /products?search=` keeps matching on `gtin14` with a NULL-safe `ilike`.
3. `apps/api/src/modules/shifts/shifts.service.ts` — `createShift` rejects a GTIN-less product with the same 422 path it already uses for `draft` and `archived` products (the draft/archived checks stay as they are).
4. `apps/api/src/modules/kiosks/kiosks.service.ts` — `setProducts` rejects GTIN-less products the same way, so no kiosk product list ever carries `NULL`.
5. Station mirror — `packages/db/src/sqlite/schema.ts` keeps `product_mirror.gtin14 text NOT NULL`; because 3 and 4 stop GTIN-less products before any shift bundle, the mirror (`apps/station/src/lib/mirror.ts`) needs no schema change, and a test asserts that a GTIN-less product never appears in a station shift payload.
6. Label engine — `packages/domain/src/labels/model.ts` `product.gtin` becomes `string | null`; the renderer skips GTIN-bound barcode elements for `NULL` instead of throwing (U.S. labels are a US-10 concern, but the type must compile).
7. The remaining direct readers of `schema.products.gtin14` listed in Codebase facts (`boxes`, `pickup-orders`, `inventories`, `chz-exports`, `chz-code-statuses`, `national-catalog`, `exchange`) only need the type widened to `string | null`; they are RU-only paths that never see a U.S. product.

A `products.e2e` test then proves the RU tenant still gets 400 `GTIN_REQUIRED` and the existing RU suites stay unchanged.

### Domain rules

New pure files under `packages/domain/src/traceability/` (sub-folders `products/` and `lots/`, next to US-03's `events/`, `documents/`, `receiving/`; no imports from CommerceML, CHZ or national-catalog code, INT-004):

- `products/coverage.ts` — `COVERAGE_STATUSES`, `EXPORT_BLOCKING_COVERAGE = ["unknown", "exemption_review_required"]`, `validateCoverageReview(profile, tenantProfileCode)` returning `{ field, code }[]` (rationale, category, source URL, reviewer required for `covered`/`contains_ftl_same_form` under `US_FSMA204_PROCESSOR`; nothing enforced under `US_GENERIC_LOT_TRACEABILITY`).
- `products/snapshot.ts` — `ProductDescriptionSnapshot` (`productName`, `brandName`, `commodity`, `variety`, `packagingSize: { value, uom } | null`, `packagingStyle`, `gtin: string | null`, `sourceProductId`, `snapshotVersion: 1`) and `buildProductSnapshot(product, profile)`; deterministic key order, strings trimmed, no defaults invented. US-03/US-04/US-05 call it at finalization.
- `lots/tlc.ts` — `normalizeTlc(raw)` (trim, reject control characters, length 1..120, otherwise keep opaque), `formatDemoTlc({ prefix, date, suffix })` producing `NRF-260915-APL01` style codes for seed and the "Suggest TLC" button; `P0_ASSIGNMENT_BASES`.
- `lots/status.ts` — transition table: `active → consumed | shipped | quarantined | recalled | archived`; `quarantined → active | recalled | archived`; `consumed | shipped → recalled | archived`; `recalled → archived`; `archived` terminal. `assertLotTransition(from, to, context?)`. Pending OQ-US05-5: US-05 requires an additional `shipped → active` transition allowed only in operation context `system:shipping_recalculation` (void/amendment of a shipping event restores the balance), never through `POST /traceability/lots/:id/status`; audit semantics are defined in the US-05 spec.
- `lots/completeness.ts` — `assertLotFinalizable(lot)` requires product, TLC and exactly the LOT-003 rule (`sourceLocationId` or `sourceReference`), returns structured gaps for the completeness report.
- `lots/genealogy.ts` — `wouldCreateCycle(edges, candidate)`, `ancestorsOf`, `descendantsOf` (reused by US-06).
- `uom.ts` — versioned vocabulary `UOM_CODES_V1` (`lb`, `oz`, `kg`, `g`, `each`, `case`, `bag`, `cup`, `gal`, `l`) with no conversion functions (PRD-008); US-03's `quantity.ts` suggestions must read this list rather than declare its own (OQ-US02-4).

### Contracts and API

Zod in `packages/platform-contracts/src/traceability/products.ts` and `lots.ts`, exported from the package index: `productTraceabilityProfileSchema`, `upsertProductTraceabilityProfileSchema`, `traceabilityLotSchema`, `createTraceabilityLotSchema`, `listTraceabilityLotsQuerySchema` (filters `productId`, `status`, `tlc`, `sourceLocationId`, `assignmentBasis`, `search`, cursor paging), `changeLotStatusSchema` (`status`, `reason` min 3).

Module `apps/api/src/modules/traceability/` (one Nest module, sub-folders per slice):

| Method | Route                               | Capability (US-00)                                                                                    | Notes                                                                                                                                                            |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/traceability/products/:productId` | `traceability.read`                                                                                   | 404 when the product is another tenant's; returns defaults when no row exists yet                                                                                |
| PUT    | `/traceability/products/:productId` | `traceability.master_data.write` (+ `traceability.qa.manage` when coverage fields change, OQ-US02-12) | Upsert (idempotent); coverage change stamps `reviewed_by = actor`, `reviewed_at = now()`                                                                         |
| GET    | `/traceability/lots`                | `traceability.read`                                                                                   | List with filters above                                                                                                                                          |
| POST   | `/traceability/lots`                | `traceability.master_data.write`                                                                      | Imported lot only; transformation/exempt-receipt assignment belongs to the corresponding event; duplicate per LOT-007 → 409 `LOT_DUPLICATE` with the existing id |
| GET    | `/traceability/lots/:id`            | `traceability.read`                                                                                   | Lot card: product snapshot preview, source, status, genealogy neighbours, event timeline stub                                                                    |
| POST   | `/traceability/lots/:id/status`     | `traceability.qa.manage`                                                                              | Guarded by `assertLotTransition`; reason mandatory                                                                                                               |

Guards: `TenantGuard, AuthorizationGuard, SubscriptionAccessGuard` plus US-00's `TraceabilityProfileGuard` through `@RequireTraceabilityProfile("US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY")`; an `RU_CHZ` tenant receives 403 `traceability_profile_required`. Every query is tenant-scoped in `WHERE` in addition to composite FKs. `POST /traceability/lots` with `assignmentBasis` outside the P0 set → 422 `ASSIGNMENT_BASIS_RESERVED`.

Audit rows in `tenant_audit_events` (`outcome: "success" | "failure"`, `request_id` from the request):

| Action                                          | target_type                    | before / after                                      |
| ----------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| `traceability.product_profile.updated`          | `traceability_product_profile` | full profile diff                                   |
| `traceability.product_profile.coverage_changed` | `traceability_product_profile` | `{ coverageStatus, rationale, reviewer }` (PRD-004) |
| `traceability.lot.created`                      | `traceability_lot`             | `null` / lot                                        |
| `traceability.lot.status_changed`               | `traceability_lot`             | `{ status }` / `{ status, reason }` (LOT-009)       |

OpenAPI: same `ApiZod*` decorators as `products.controller.ts`; the coverage gate (`pnpm --filter @markiro/api` OpenAPI coverage test) must include the new routes.

### Admin UI

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

| ID         | Question                                                                                                                                                                     | Options                                                                                                                                                                                                                                                                                                    | Recommendation                                                                                                                                                                                                                                                                     | Blocking? |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| OQ-US02-1  | How does a U.S. product without GTIN exist given `products.gtin14 NOT NULL` (founding ADR conflict 1)?                                                                       | (a) `DROP NOT NULL`, keep the partial unique index, API requires GTIN only for `RU_CHZ`, `createShift`/`KiosksService.setProducts` reject GTIN-less products until US-10; (b) keep mandatory and document a deviation; (c) GS1 restricted-circulation internal numbers (prefix 2x) with a `gtin_kind` flag | (a). Blast radius is 12 API files that select `products.gtin14` (types become `string \| null`) and Station/kiosk consumers must be checked explicitly, because GTIN-less products cannot reach a shift or a kiosk. (b) fails PRD-007; (c) prints invented identifiers on exports. | yes       |
| OQ-US02-2  | `computeStatus` needs `chz_product_group_code` for `active`, and shifts reject draft products, so a U.S. product can never have a shift (breaks TRN-001/TRN-010).            | (a) profile-aware `computeStatus`: U.S. profiles need only capacities; (b) allow shifts for draft products in U.S. tenants; (c) require a CHZ group on U.S. products (violates PRD-009)                                                                                                                    | (a), implemented in US-02 next to the GTIN rule; RU branch byte-identical. Readiness service must not require EGAIS/CHZ fields for U.S. tenants either.                                                                                                                            | yes       |
| OQ-US02-3  | Should a lot row be allowed without source (DB nullable) or must source be NOT NULL?                                                                                         | nullable + finalization validator; NOT NULL with a placeholder reference                                                                                                                                                                                                                                   | Nullable; LOT-003 is a finalization rule and the completeness report must be able to show the gap.                                                                                                                                                                                 | no        |
| OQ-US02-4  | UOM as a Postgres enum or free text validated against a versioned vocabulary?                                                                                                | `pgEnum`; text + `UOM_CODES_V1` in domain + Zod enum                                                                                                                                                                                                                                                       | Text + vocabulary: the export field registry (US-07) can version it without a DB migration; still no conversions.                                                                                                                                                                  | no        |
| OQ-US02-5  | Where does the optional TLC format policy (LOT-002 "configurable length/regex") live?                                                                                        | column on US-00's `traceability_profiles`; per-product; not in P0                                                                                                                                                                                                                                          | Not in P0; P1 as `tlc_policy jsonb` on the tenant traceability profile (US-00 entity), validated in `tlc.ts`.                                                                                                                                                                      | no        |
| OQ-US02-6  | Reviewer identity: cabinet `user.id` or `employees.id`?                                                                                                                      | `user.id` (as `product_regulatory` does); employee                                                                                                                                                                                                                                                         | `user.id`; QA/reviewer is a cabinet role (PRO-006), employees are station operators.                                                                                                                                                                                               | no        |
| OQ-US02-7  | Product description fields on the profile table versus new columns on `products`?                                                                                            | profile table; `products` columns                                                                                                                                                                                                                                                                          | Profile table (PRD-001 "without duplicating the catalog"; RU catalog untouched).                                                                                                                                                                                                   | no        |
| OQ-US02-8  | Profile endpoint semantics: PUT upsert or PATCH partial?                                                                                                                     | PUT; PATCH                                                                                                                                                                                                                                                                                                 | PUT upsert with the full document; the form always has the whole record and idempotency is free.                                                                                                                                                                                   | no        |
| OQ-US02-9  | Reuse `tenant_audit_events` or add a traceability-specific audit table?                                                                                                      | reuse; new table                                                                                                                                                                                                                                                                                           | Reuse; export runs (US-09) can filter by `action LIKE 'traceability.%'`.                                                                                                                                                                                                           | no        |
| OQ-US02-10 | Under `US_GENERIC_LOT_TRACEABILITY`, hide the coverage section or show it read-only?                                                                                         | hidden with fixed statement; read-only                                                                                                                                                                                                                                                                     | Hidden with the fixed "FTR applicability not assessed in this profile" statement (PRO-005, Scenario B rule).                                                                                                                                                                       | no        |
| OQ-US02-11 | Should `lot_genealogy_edges.transformation_event_id` be NOT NULL now (FK added by US-04) or nullable?                                                                        | NOT NULL, no FK yet; nullable                                                                                                                                                                                                                                                                              | NOT NULL without FK; every edge in P0 comes from a transformation, and US-04 adds the FK additively.                                                                                                                                                                               | no        |
| OQ-US02-12 | US-00 assigns "product traceability profile" to `traceability.master_data.write` and "FTL review" to `traceability.qa.manage`; the profile PUT carries both kinds of fields. | one capability for the whole PUT; per-field check (description → master_data.write, coverage/category/source/reviewer → qa.manage); two endpoints                                                                                                                                                          | Per-field check inside one PUT: a user with master_data.write may complete the description, only QA changes coverage (PRO-006 minimal permissions). Denial test per field group.                                                                                                   | no        |
| OQ-US02-13 | Can a lot's identity (TLC, source, product) be amended once a finalized event references it? US-03 defers this to US-02 (OQ-US03-4).                                         | locked in P0 (void + new event); lot amendment with cascade to snapshots                                                                                                                                                                                                                                   | Locked in P0: `PATCH` of identity fields → 409 `lot_identity_locked` when any finalized event references the lot; only status, dates and operational fields stay editable.                                                                                                         | no        |

## Revised lot and profile boundary

Manual creation accepts imported records only; it cannot bypass CTE finalization with `assignmentBasis=transformation` or `exempt_supplier_receipt`. The generic profile never asserts that a food is outside the FTR. Nullable GTIN requires a full consumer audit, not an assumption that the blast radius ends at API selects. U.S. P0 does not expose Station/kiosk or require packaging capacities merely to record an event.
