# Station Operational Product Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a compact, versioned product operational projection through shift bundles while preserving old Station fields and fully offline production behavior.

**Architecture:** The API derives projection v1 only from accepted typed product data and reviewed exact mappings. The bundle adds the projection without removing legacy EGAIS/shelf-life fields; Station mirrors projection metadata and keg duration into additive SQLite columns while continuing to feed existing print/workflow readers from their old columns.

**Tech Stack:** `@markiro/domain`, NestJS shift bundles, Drizzle SQLite runtime migrations, React/Tauri Station TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

## Global Constraints

- Requires completed category-attributes foundation; it does not require admin UI availability.
- Projection v1 contains only `primaryEgaisCode`, `shelfLifeDays`, and optional keg open lifetime `{ value, unit }`.
- National Catalog cards, schemas, conflicts, source snapshots, and tokens never enter the bundle or SQLite.
- Existing bundle `egaisCode` and `shelfLifeDays` remain populated from projection v1 for rolling compatibility.
- Old servers and old bundles remain readable; omitted projection fields clear stale optional projection data without breaking shift entry.
- Bundle/mirror failure remains recoverable and must not block an operator from entering an already available offline shift.
- Add SQLite runtime migration and authoritative schema together; generated SQLite diff is inspection-only.

---

## File Structure

| File                                                                        | Responsibility                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/domain/src/product-attributes/operational-projection.ts`          | Strict projection v1 schema/type                  |
| `apps/api/src/modules/product-regulatory/operational-projection.service.ts` | Tenant-scoped exact projection derivation         |
| `apps/api/src/modules/shifts/dto.ts`                                        | Additive shift-bundle OpenAPI/TypeScript contract |
| `apps/api/src/modules/shifts/shifts.service.ts`                             | Projection load and legacy field compatibility    |
| `packages/db/src/sqlite/schema.ts`                                          | Authoritative local projection columns            |
| `packages/db/src/sqlite/migrations.ts`                                      | Restart-safe additive runtime migration           |
| `apps/station/src/lib/mirror.ts`                                            | Bundle type, upsert, and shift-context reads      |

### Task 1: Projection v1 domain contract

**Files:**

- Create: `packages/domain/src/product-attributes/operational-projection.ts`
- Modify: `packages/domain/src/product-attributes/index.ts`
- Test: `packages/domain/test/product-operational-projection.test.ts`

**Interfaces:**

- Produces `productOperationalProjectionV1Schema`, `parseProductOperationalProjection`, and `ProductOperationalProjectionV1`.

- [ ] **Step 1: Write failing strict-contract tests**

```ts
expect(
  parseProductOperationalProjection({
    version: 1,
    primaryEgaisCode: "0101234567890123456",
    shelfLifeDays: 184,
    kegOpenLifetime: { value: 72, unit: "hour" },
  }),
).toEqual(expect.objectContaining({ version: 1 }));

expect(() =>
  parseProductOperationalProjection({
    version: 1,
    primaryEgaisCode: "bad",
    shelfLifeDays: 184,
    kegOpenLifetime: null,
  }),
).toThrow();
```

Also reject extra keys, non-positive shelf life/duration, unsupported duration units, and versions other than 1.

- [ ] **Step 2: Run and confirm missing export**

Run: `pnpm --filter @markiro/domain exec vitest run test/product-operational-projection.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement strict v1 schema**

```ts
export const productOperationalProjectionV1Schema = z
  .object({
    version: z.literal(1),
    primaryEgaisCode: z
      .string()
      .regex(/^\d{19}$/)
      .nullable(),
    shelfLifeDays: z.number().int().positive().max(3650).nullable(),
    kegOpenLifetime: z
      .object({
        value: z.number().int().positive(),
        unit: z.enum(["hour", "day"]),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ProductOperationalProjectionV1 = z.infer<typeof productOperationalProjectionV1Schema>;
export const parseProductOperationalProjection = (input: unknown) =>
  productOperationalProjectionV1Schema.parse(input);
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/domain exec vitest run test/product-operational-projection.test.ts
pnpm --filter @markiro/domain typecheck
pnpm --filter @markiro/domain lint
pnpm --filter @markiro/domain build
git add packages/domain/src/product-attributes packages/domain/test/product-operational-projection.test.ts
git commit -m "feat(domain): define Station product projection"
```

### Task 2: API projection derivation and additive bundle contract

**Files:**

- Create: `apps/api/src/modules/product-regulatory/operational-projection.service.ts`
- Modify: `apps/api/src/modules/product-regulatory/product-regulatory.module.ts`
- Modify: `apps/api/src/modules/shifts/shifts.module.ts`
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Test: `apps/api/test/shifts.service.test.ts`
- Test: `apps/api/test/shifts.e2e.test.ts`
- Test: `apps/api/test/openapi-docs.test.ts`

**Interfaces:**

- Produces `OperationalProjectionService.build(tenantId, productId): Promise<ProductOperationalProjectionV1>`.
- Bundle product adds optional `operationalProjection`; legacy scalar fields equal projection v1 fields.

- [ ] **Step 1: Write failing projection/bundle tests**

Seed accepted EGAIS primary, shelf life, and an active reviewed mapping for keg duration. Assert bundle response:

```ts
expect(bundle.product.operationalProjection).toEqual({
  version: 1,
  primaryEgaisCode: "0101234567890123456",
  shelfLifeDays: 184,
  kegOpenLifetime: { value: 72, unit: "hour" },
});
expect(bundle.product.egaisCode).toBe(bundle.product.operationalProjection.primaryEgaisCode);
expect(bundle.product.shelfLifeDays).toBe(bundle.product.operationalProjection.shelfLifeDays);
```

Assert a conflicting/unreviewed mapping produces `kegOpenLifetime: null`; no active regulatory profile still returns projection v1 from stable legacy fields; another tenant's value is never selected.

- [ ] **Step 2: Run and confirm missing projection**

Run: `pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts`

Expected: FAIL on `operationalProjection`.

- [ ] **Step 3: Implement exact derivation**

Load product by tenant/id, selected primary EGAIS code, and only active attribute mappings whose target is `kegOpenLifetime` and whose schema matches the active profile. Validate the built object with the domain parser before returning it. No external service call is permitted in this service.

- [ ] **Step 4: Add bundle property without breaking old clients**

Add `operationalProjection` to the Station bundle product TypeScript/OpenAPI property set but do not require it during the rolling window. `ShiftsService` sets it for every current-server response and derives legacy `egaisCode`/`shelfLifeDays` from it. `reference-bundle` and normal bundle use the same product builder.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts test/openapi-docs.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
git add apps/api/src/modules/product-regulatory apps/api/src/modules/shifts apps/api/test/shifts.service.test.ts apps/api/test/shifts.e2e.test.ts apps/api/test/openapi-docs.test.ts
git commit -m "feat(api): bundle Station product projection"
```

### Task 3: Additive SQLite schema and restart-safe migration

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/src/sqlite/migrations.ts`
- Test: `packages/db/test/sqlite-schema.test.ts`
- Create: `packages/db/test/station-runtime-migrations.test.ts`

**Interfaces:**

- Adds nullable product mirror columns `operational_projection_version`, `keg_open_lifetime_value`, and `keg_open_lifetime_unit`; existing EGAIS/shelf-life columns remain.

- [ ] **Step 1: Write failing schema/runtime migration tests**

Assert a fresh DB and a pre-projection DB both end with the three columns, existing product rows survive, repeated migration is a no-op, and no existing EGAIS/shelf-life value is changed.

- [ ] **Step 2: Add authoritative schema and runtime migration**

Add the columns to `productMirror`. Append one numbered `STATION_MIGRATIONS` entry using guarded `ALTER TABLE ... ADD COLUMN`; use the repository's existing column-existence helper/pattern so restart after partial application is safe. Add a SQLite check or write-time validation limiting unit to `hour|day|null`.

- [ ] **Step 3: Inspect generated parity diff**

Run `pnpm --filter @markiro/db db:generate:sqlite` only as an inspection aid. Do not commit generated directories. Confirm the diff contains exactly the three expected columns.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts test/station-runtime-migrations.test.ts
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db lint
pnpm --filter @markiro/db build
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/migrations.ts packages/db/test/sqlite-schema.test.ts packages/db/test/station-runtime-migrations.test.ts
git commit -m "feat(db): store Station product projection metadata"
```

### Task 4: Mirror projection with rolling compatibility

**Files:**

- Modify: `apps/station/src/lib/mirror.ts`
- Test: `apps/station/test/mirror.test.ts`
- Test: `apps/station/test/shift-bundle.test.ts`

**Interfaces:**

- `StationBundle.product.operationalProjection?: ProductOperationalProjectionV1`.
- `readShiftContext` adds nullable projection version/keg duration while retaining existing EGAIS/shelf-life fields.

- [ ] **Step 1: Write failing new/old/newer bundle tests**

Assert current projection round-trip; older bundle without projection clears only projection metadata and continues using its legacy EGAIS/shelf-life values; a future unsupported version is ignored with a bounded console warning and does not erase last usable legacy fields; repeated mirror is idempotent.

- [ ] **Step 2: Parse before write and mirror atomically**

When `version === 1`, parse using `@markiro/domain`, use projection EGAIS/shelf-life as authoritative for that bundle, and upsert all projection columns in the existing product statement. When absent, write version/keg columns null and preserve current rolling behavior for legacy fields. Never fetch schema/card data.

- [ ] **Step 3: Expose shift context without changing workflows**

Add:

```ts
operationalProjectionVersion: number | null;
kegOpenLifetime: { value: number; unit: "hour" | "day" } | null;
```

Existing label/workflow readers continue receiving `egaisCode` and `shelfLifeDays`; no online guard is added.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db build
pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/shift-bundle.test.ts
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
git add apps/station/src/lib/mirror.ts apps/station/test/mirror.test.ts apps/station/test/shift-bundle.test.ts
git commit -m "feat(station): mirror product operational projection"
```

### Task 5: Offline and compatibility completion gate

**Files:**

- Modify only scoped files required by failures caused by Tasks 1–4.

**Interfaces:**

- Produces the accepted offline projection slice.

- [ ] **Step 1: Run cross-package gates**

```bash
pnpm --filter @markiro/domain test
pnpm --filter @markiro/domain build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
pnpm format:check
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Run explicit offline recovery checks**

With Network disabled after a successful bundle mirror, restart Station and verify the shift context retains EGAIS, shelf life, and keg duration. Mirror an old fixture after a new one and verify documented clearing/preservation behavior. This is host-level offline validation, not Windows/scanner/printer proof.

- [ ] **Step 3: Report unrun physical gates**

List Windows installer/update, real scanner, printer output, and factory network acceptance as unrun unless those environments were actually exercised. Commit only exact corrections if the checks exposed a defect; do not create an empty completion commit.
