# Category Product Attributes Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver category-specific product data and read-only National Catalog import as independently reviewable slices without introducing an external dependency into Station production.

**Architecture:** The work is split at stable interfaces: domain/schema persistence first, then the National Catalog adapter, then the admin experience, then the additive Station projection. Each slice leaves working, testable software and can be rejected or delayed without invalidating the preceding slice.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle/Postgres, NestJS 11, React 19, TanStack Query, pg-boss, Station SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

## Global Constraints

- Preserve tenant isolation with composite tenant foreign keys and explicit cross-tenant denial tests.
- National Catalog v1 is read-only: no create, edit, sign, publish, or archive methods.
- External data never silently overwrites accepted Markiro values; apply always uses a persisted preview and product revision check.
- Station receives only an additive operational projection and never calls National Catalog, 1C, or True API.
- `products.status` remains the compatibility projection of production readiness during these slices.
- Existing `egaisCode` and `shelfLifeDays` remain compatible through the offline queue horizon; invalid legacy values are surfaced, not discarded.
- All category schemas are centrally versioned by Markiro; tenants cannot create custom schemas in v1.
- Every new tenant mutation writes exact `tenant_audit_events` actor, action, target, outcome, before, and after data.
- Local TypeScript imports use `.js`; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` remain enabled.
- Every API route includes OpenAPI coverage and cabinet capability/subscription guards matching neighboring product routes.
- All admin copy is added to both `apps/admin/src/i18n/ru.json` and `en.json`.
- Never put bearer tokens in logs, audit metadata, snapshots, job payloads, or client responses.

---

## Delivery slices

| Order | Plan                                                   | Independently testable outcome                                                                                                    |
| ----- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `2026-08-31-category-attributes-foundation.md`         | Versioned schemas, tenant product profiles/values, provenance, EGAIS collection, readiness, and safe category changes through API |
| 2     | `2026-08-31-national-catalog-readonly-import.md`       | Token-backed category/card reads, schema refresh, snapshots, preview/apply, freshness jobs, and classifier report                 |
| 3     | `2026-08-31-category-attributes-admin-pilot.md`        | Product-card readiness, dynamic pilot forms, category changes, National Catalog lookup, and field-level diff confirmation         |
| 4     | `2026-08-31-station-operational-product-projection.md` | Versioned compact projection in shift bundles and backward-compatible SQLite mirroring                                            |

Slice 2 consumes only the service/repository interfaces produced by slice 1. Slice 3 consumes the HTTP contracts from slices 1 and 2. Slice 4 consumes the readiness/value service from slice 1 and does not depend on the admin implementation.

## Shared interfaces between slices

Slice 1 owns and exports these domain contracts from `@markiro/domain`:

```ts
export type ProductAttributeSource = "manual" | "1c" | "national_catalog" | "migration";
export type ReadinessDimension = "production" | "code_ordering" | "circulation" | "egais";
export type ReadinessState = "ready" | "not_ready" | "not_applicable" | "stale";

export interface ProductReadinessReason {
  code: string;
  attributeId?: string;
  triggerAttributeId?: string;
  schemaVersionId?: string;
}

export interface ProductReadinessDimensionResult {
  dimension: ReadinessDimension;
  state: ReadinessState;
  reasons: ProductReadinessReason[];
}
```

Slice 1 owns the API mutation boundary:

```ts
export interface ProductRegulatoryRepository {
  getProfile(tenantId: string, productId: string): Promise<ProductRegulatoryProfileDto>;
  previewCategoryChange(
    tenantId: string,
    productId: string,
    input: CategoryChangeInput,
  ): Promise<CategoryChangePreviewDto>;
  applyProposal(
    tenantId: string,
    actorUserId: string | null,
    proposalId: string,
    input: { acceptedEntryIds: string[] },
  ): Promise<ProductRegulatoryProfileDto>;
}
```

Slice 2 adds National Catalog proposal sources through that interface; it does not add a second merge engine. Slice 4 consumes this projection contract:

```ts
export interface ProductOperationalProjectionV1 {
  version: 1;
  primaryEgaisCode: string | null;
  shelfLifeDays: number | null;
  kegOpenLifetime: { value: number; unit: "hour" | "day" } | null;
}
```

## 1C boundary

The existing CommerceML path remains limited to its accepted fields while these four slices land. Add a regression test in slice 1 that CommerceML processing does not write product regulatory tables. A later 1C proposal plan requires a real customer fixture identifying the exact CommerceML property identifiers and units; without that evidence, implementing EGAIS/permit mappings would violate the approved no-guessing rule.

The later plan must consume the same persisted proposal/diff/apply boundary with source `1c`; it must not modify product attributes directly from the exchange controller.

## Spec coverage review

| Approved spec area                                          | Owning plan/task                                   |
| ----------------------------------------------------------- | -------------------------------------------------- |
| Hybrid data model, provenance, immutable history            | Foundation Tasks 1–3                               |
| Category compatibility and safe category change             | Foundation Task 4; Admin Task 4                    |
| Multiple EGAIS codes and legacy migration                   | Foundation Tasks 2 and 5                           |
| Independent readiness dimensions                            | Foundation Tasks 1 and 3; Admin Task 2             |
| National Catalog authentication and read-only client        | National Catalog Task 1                            |
| Schema discovery/version/activation                         | National Catalog Task 2                            |
| GTIN lookup, snapshots, diff, confirmation                  | National Catalog Tasks 3–4; Admin Task 5           |
| ETag freshness, retries, classifier-wide matrix             | National Catalog Task 5                            |
| Pilot dynamic forms and conditional fields                  | Admin Task 3                                       |
| Compact offline projection and rolling compatibility        | Station Tasks 1–5                                  |
| No tenant field builder or outbound National Catalog writes | Global constraints and negative tests in all plans |
| 1C cannot silently overwrite regulatory values              | Foundation Task 5 regression guard                 |

The only deliberately deferred implementation is extraction of regulatory properties from 1C. Its architectural boundary is complete, but exact extraction needs a real CommerceML property fixture and a separate reviewed mapping decision; inventing property identifiers in these plans would violate the approved source-provenance rule.

## Global completion gate

After all four slices:

```bash
set -a
source .env
set +a
pnpm turbo lint typecheck test build --concurrency=1 --force
pnpm format:check
git diff --check
```

Expected: all commands pass. Report database-backed skips, National Catalog live-token validation, browser review, Windows/Station, scanner, and printer validation separately.
