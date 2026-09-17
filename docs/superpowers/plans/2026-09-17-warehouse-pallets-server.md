# Warehouse Pallets — Plan 1 of 3: Database and Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a device attach already-closed boxes to a new `warehouse` pallet through `POST /station/scans`, give the device everything it needs to do so offline (bootstrap + registry fields), and give the cabinet the org-wide list, card data, permission flag and per-pallet GIS MT export.

**Architecture:** One `pallets` table gains `kind`, `product_id`, `device_id` and a nullable `shift_id` (spec §1). The sync batch gains a `palletMemberships[]` record kind with a per-record response (spec §2.2–2.3). The box registry delta feed carries pallet membership so a handheld can refuse a box that already stands on a live pallet (spec §2.4). A device bootstrap endpoint hands out products, the extension-1 serial block and pallet label templates without a shift (spec §2.1). Exports reuse the durable shift-export job with a nullable shift and a pallet id (spec §2.5–2.6).

**Tech Stack:** NestJS 11, Drizzle ORM + drizzle-kit migrations, Zod DTOs, Vitest (unit + supertest e2e against Postgres), `@markiro/domain`, `@markiro/db`.

**Spec:** `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md`. Plans 2 (handheld) and 3 (cabinet UI) follow once this plan has landed.

## Global Constraints

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`, no non-null assertions, `import type` for type-only imports.
- Every tenant business query is tenant-scoped; every new route asserts cross-tenant denial in a test.
- Audit assertions check actor, tenant, action, target, result and metadata — never a row count.
- New migration only; never rewrite an applied migration. Review generated SQL by hand.
- `@markiro/domain` and `@markiro/db` export compiled `dist`: after changing either, run its `build` before API tests.
- Sync batch limits are shared constants in `@markiro/domain`; the handheld fixture JSON must be regenerated and committed with them.
- Warehouse pallet issuer prefix is always the organisation profile's GLN (spec «Decisions»).
- `boxes.pallet_id` may be overwritten only when the pallet it points at has `disassembled_at` set (spec §1.2).
- Audit action names follow the existing `snake_object.verb` shape: `pallet_export.created`, `pallet_export.completed`, `pallet_export.failed`.
- Run `git status --short` before editing; commit only explicit paths.
- Database-backed tests need `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` loaded from `.env` (`set -a; source .env; set +a`). Report skips explicitly.

---

## File map

| Path | Responsibility |
| --- | --- |
| `packages/domain/src/sync/limits.ts` | `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` |
| `packages/domain/src/sync/limits-fixtures.ts`, `apps/handheld/app/src/test/resources/sync-limits-fixtures.json` | shared limit fixture |
| `packages/domain/src/pallet-exports.ts` (new) | `PALLET_EXPORT_FORMATS`, `renderPalletAggregationExport` |
| `packages/db/src/schema/platform.ts` | `pallets` columns/constraints, `pallet_exceptions.shift_id` nullable, `pallet_membership_rejections`, quarantine CHECK |
| `packages/db/src/schema/pickup.ts` | `employee_pickup_policies.can_build_pallets` |
| `packages/db/src/schema/shift-exports.ts` | `shift_exports.shift_id` nullable, `pallet_id` |
| `packages/db/migrations/0162_warehouse_pallets.sql` (generated) | the migration |
| `apps/api/src/modules/station-scans/dto.ts` | `palletMembershipSchema`, pallet closure `kind`/`productId`, response `memberships`, denied `shiftId` nullable |
| `apps/api/src/modules/station-scans/pallet-ingest.ts` | warehouse refs in `upsertPallets`, `applyPalletMemberships`, warehouse closures |
| `apps/api/src/modules/station-scans/station-scans.service.ts` | wiring, read-only denial, registry bumps, response |
| `apps/api/src/modules/disaggregation/disaggregation.service.ts` | registry bump on pallet disassembly |
| `apps/api/src/modules/kiosk/box-registry.service.ts`, `box-registry.dto.ts` | registry pallet fields |
| `apps/api/src/modules/sscc/sscc.service.ts` | `resolveOrganisationIssuerPrefix` |
| `apps/api/src/modules/station-pallets/` (new) | `GET /station/pallet-bootstrap` |
| `apps/api/src/modules/employees/dto.ts`, `employees.service.ts` | `canBuildPallets` |
| `apps/api/src/modules/pallets/dto.ts`, `pallets.service.ts`, `pallets.controller.ts` | org-wide list, filters, cursor, `kind`, `rejectedMembershipCount` |
| `apps/api/src/modules/code-search/dto.ts`, `code-search.service.ts` | pallet card `kind`, warehouse product, box origin shifts, rejections |
| `apps/api/src/modules/shift-exports/*` | pallet export create/list/run |

---

### Task 1: Shared membership batch limit

**Files:**
- Modify: `packages/domain/src/sync/limits.ts`
- Modify: `packages/domain/src/sync/limits-fixtures.ts`
- Modify: `packages/domain/src/index.ts:173-177`
- Modify: `apps/handheld/app/src/test/resources/sync-limits-fixtures.json`
- Test: `packages/domain/test/sync-limits-fixtures.test.ts` (existing; must pass after regeneration)

**Interfaces:**
- Produces: `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH = 100` exported from `@markiro/domain`; fixture key `maxPalletMembershipsPerSyncBatch`.

- [ ] **Step 1: Add the constant**

Append to `packages/domain/src/sync/limits.ts` after `MAX_PALLET_CLOSURES_PER_SYNC_BATCH`:

```ts
/**
 * Upper bound on `palletMemberships` per `/station/scans` batch — one box
 * scanned onto a warehouse pallet per record. Shared with the handheld's
 * `SyncEngine` for the same reason the two limits above are: if the device
 * drains more memberships than the endpoint accepts, the whole batch is
 * rejected every retry and every channel on that device wedges.
 *
 * 100 matches `items`: a membership is one scan, and a batch that carries
 * 100 unit scans can carry 100 box scans.
 */
export const MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH = 100;
```

- [ ] **Step 2: Export it and add it to the fixture**

In `packages/domain/src/index.ts` change the sync limits export block to:

```ts
export {
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH,
  MAX_SYNC_BATCH_ID_CHARS,
} from "./sync/limits.js";
```

In `packages/domain/src/sync/limits-fixtures.ts` import the new constant and extend the interface and builder:

```ts
import {
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH,
  MAX_SYNC_BATCH_ID_CHARS,
} from "./limits.js";

export interface SyncLimitsFixtures {
  maxBoxClosuresPerSyncBatch: number;
  maxPalletClosuresPerSyncBatch: number;
  maxPalletMembershipsPerSyncBatch: number;
  maxSyncBatchIdChars: number;
}

export function buildSyncLimitsFixtures(): SyncLimitsFixtures {
  return {
    maxBoxClosuresPerSyncBatch: MAX_BOX_CLOSURES_PER_SYNC_BATCH,
    maxPalletClosuresPerSyncBatch: MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
    maxPalletMembershipsPerSyncBatch: MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH,
    maxSyncBatchIdChars: MAX_SYNC_BATCH_ID_CHARS,
  };
}
```

- [ ] **Step 3: Run the fixture test to see it fail**

Run: `pnpm --filter @markiro/domain exec vitest run test/sync-limits-fixtures.test.ts`
Expected: FAIL — committed JSON lacks `maxPalletMembershipsPerSyncBatch`.

- [ ] **Step 4: Regenerate the fixture**

Run: `pnpm --filter @markiro/domain fixtures:sync-limits`
Expected: `apps/handheld/app/src/test/resources/sync-limits-fixtures.json` now reads

```json
{
  "maxBoxClosuresPerSyncBatch": 50,
  "maxPalletClosuresPerSyncBatch": 20,
  "maxPalletMembershipsPerSyncBatch": 100,
  "maxSyncBatchIdChars": 200
}
```

- [ ] **Step 5: Run the domain gates**

Run: `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`
Expected: all PASS. (The handheld `SyncLimitsFixturesTest` reads only its three existing keys and is unaffected; plan 2 adds the Kotlin literal.)

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/sync/limits.ts packages/domain/src/sync/limits-fixtures.ts packages/domain/src/index.ts apps/handheld/app/src/test/resources/sync-limits-fixtures.json
git commit -m "feat(domain): shared pallet membership batch limit"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/db/src/schema/platform.ts` (`pallets` ~1060-1129, `palletExceptions` ~1131-1196, `stationSyncQuarantine` CHECK ~654-657)
- Modify: `packages/db/src/schema/pickup.ts:68-87`
- Modify: `packages/db/src/schema/shift-exports.ts:24-92`
- Create: `packages/db/migrations/0162_warehouse_pallets.sql` (via `db:generate`, then reviewed)
- Test: `packages/db/test/warehouse-pallets-migration.test.ts`

**Interfaces:**
- Produces: `schema.pallets.kind` (`"production" | "warehouse"`), `schema.pallets.productId`, `schema.pallets.deviceId`, nullable `schema.pallets.shiftId`; `schema.palletMembershipRejections`; `schema.employeePickupPolicies.canBuildPallets`; `schema.shiftExports.palletId`, nullable `schema.shiftExports.shiftId`; quarantine kind `pallet_membership`.

- [ ] **Step 1: Write the failing migration test**

Create `packages/db/test/warehouse-pallets-migration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The last migration before warehouse pallets. */
const LAST_LEGACY_INDEX = 161;

describe.skipIf(!databaseUrl)("warehouse pallets migration", () => {
  const databaseName = `markiro_warehouse_pallets_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "wh-pallets-tenant";
  const productId = randomUUID();
  const shiftId = randomUUID();
  const deviceId = randomUUID();
  const productionPalletId = randomUUID();

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-wh-pallets-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: LAST_LEGACY_INDEX,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    await pool.query(
      "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())",
      [tenantId],
    );
    await pool.query("INSERT INTO org_profiles (tenant_id) VALUES ($1)", [tenantId]);
    await pool.query(
      `INSERT INTO products (id,tenant_id,gtin14,name,box_capacity,pallet_box_capacity,status)
       VALUES ($1,$2,'04600682000013','Cola',20,12,'active')`,
      [productId, tenantId],
    );
    await pool.query(
      `INSERT INTO shifts (id,tenant_id,product_id,mode,box_capacity,pallet_box_capacity,pallets_enabled,number_month_key,number_seq)
       VALUES ($1,$2,$3,'aggregation',20,12,true,'SEP26',1)`,
      [shiftId, tenantId, productId],
    );
    await pool.query(
      `INSERT INTO station_devices (id,tenant_id,name,kind) VALUES ($1,$2,'TSD-1','handheld')`,
      [deviceId, tenantId],
    );
    // A pre-migration production pallet: must survive as kind='production'.
    await pool.query(
      `INSERT INTO pallets (id,tenant_id,shift_id,terminal_id,device_pallet_id) VALUES ($1,$2,$3,$4,'p1')`,
      [productionPalletId, tenantId, shiftId, deviceId],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("keeps existing pallets as production pallets", async () => {
    const { rows } = await pool.query<{ kind: string; product_id: string | null }>(
      "SELECT kind, product_id FROM pallets WHERE id = $1",
      [productionPalletId],
    );
    expect(rows[0]).toEqual({ kind: "production", product_id: null });
  });

  it("accepts a warehouse pallet with no shift and refuses one without product or device", async () => {
    await pool.query(
      `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
       VALUES ($1,'warehouse',NULL,$2,'w1',$3,$4)`,
      [tenantId, deviceId, productId, deviceId],
    );
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
         VALUES ($1,'warehouse',NULL,$2,'w2',NULL,$3)`,
        [tenantId, deviceId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_kind_shape" });
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id)
         VALUES ($1,'production',NULL,$2,'p9')`,
        [tenantId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_kind_shape" });
  });

  it("makes (tenant, device, device_pallet_id) unique for warehouse pallets only", async () => {
    await expect(
      pool.query(
        `INSERT INTO pallets (tenant_id,kind,shift_id,terminal_id,device_pallet_id,product_id,device_id)
         VALUES ($1,'warehouse',NULL,$2,'w1',$3,$4)`,
        [tenantId, deviceId, productId, deviceId],
      ),
    ).rejects.toMatchObject({ constraint: "pallets_warehouse_device_pallet_uq" });
  });

  it("creates pallet_membership_rejections with a per-pallet unique sscc", async () => {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM pallets WHERE tenant_id = $1 AND kind = 'warehouse'",
      [tenantId],
    );
    const palletId = rows[0]?.id;
    expect(palletId).toBeDefined();
    await pool.query(
      `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
       VALUES ($1,$2,'003460068200000017','not_found',now())`,
      [tenantId, palletId],
    );
    await expect(
      pool.query(
        `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
         VALUES ($1,$2,'003460068200000017','not_found',now())`,
        [tenantId, palletId],
      ),
    ).rejects.toMatchObject({ constraint: "pallet_membership_rejections_tenant_pallet_sscc_uq" });
    await expect(
      pool.query(
        `INSERT INTO pallet_membership_rejections (tenant_id,pallet_id,box_sscc,reason,added_at)
         VALUES ($1,$2,'003460068200000024','accepted',now())`,
        [tenantId, palletId],
      ),
    ).rejects.toMatchObject({ constraint: "pallet_membership_rejections_reason_check" });
  });

  it("lets pallet_exceptions carry no shift and adds the quarantine kind", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'pallet_exceptions' AND column_name = 'shift_id'`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'station_sync_quarantine_record_kind_check'`,
    );
    expect(check.rows[0]?.def).toContain("'pallet_membership'");
  });

  it("adds can_build_pallets and the pallet export columns", async () => {
    const policy = await pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'employee_pickup_policies' AND column_name = 'can_build_pallets'`,
    );
    expect(policy.rows[0]?.column_default).toBe("false");
    const exportCols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'shift_exports' AND column_name IN ('shift_id','pallet_id') ORDER BY column_name`,
    );
    expect(exportCols.rows).toEqual([
      { column_name: "pallet_id", is_nullable: "YES" },
      { column_name: "shift_id", is_nullable: "YES" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/db exec vitest run test/warehouse-pallets-migration.test.ts`
Expected: FAIL — `kind` column does not exist after migrating the current folder.

- [ ] **Step 3: Change the Drizzle schema — `pallets`**

In `packages/db/src/schema/platform.ts`, inside `pallets` columns replace `shiftId: uuid("shift_id").notNull(),` with:

```ts
    /**
     * Null for a warehouse pallet (kind = 'warehouse'), which is built from
     * boxes of arbitrary shifts and belongs to none; not null for a
     * production pallet. `pallets_kind_shape` enforces the pairing.
     */
    shiftId: uuid("shift_id"),
    kind: text("kind").$type<"production" | "warehouse">().notNull().default("production"),
    /**
     * Written only for a warehouse pallet: the product every member box must
     * carry (spec «Homogeneity»). A production pallet's product is reached
     * through its shift, exactly as a box's is.
     */
    productId: uuid("product_id"),
    /**
     * The authenticated station device that built a warehouse pallet. Part
     * of its identity (`pallets_warehouse_device_pallet_uq`) because the
     * device-local `device_pallet_id` is not unique across devices.
     */
    deviceId: uuid("device_id"),
```

and add to the constraint array (after `pallets_device_pallet_uq`):

```ts
    uniqueIndex("pallets_warehouse_device_pallet_uq")
      .on(t.tenantId, t.deviceId, t.devicePalletId)
      .where(sql`${t.kind} = 'warehouse'`),
    index("pallets_tenant_kind_closed_idx").on(t.tenantId, t.kind, t.closedAt),
    check("pallets_kind_check", sql`${t.kind} IN ('production', 'warehouse')`),
    check(
      "pallets_kind_shape",
      sql`(${t.kind} = 'production' AND ${t.shiftId} IS NOT NULL) OR (${t.kind} = 'warehouse' AND ${t.shiftId} IS NULL AND ${t.productId} IS NOT NULL AND ${t.deviceId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "pallets_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
    foreignKey({
      name: "pallets_tenant_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [stationDevices.tenantId, stationDevices.id],
    }),
```

Make sure `uniqueIndex` and `check` are already imported from `drizzle-orm/pg-core` at the top of the file (they are used elsewhere in it).

- [ ] **Step 4: `pallet_exceptions.shift_id` nullable and quarantine kind**

In `palletExceptions` change `shiftId: uuid("shift_id").notNull(),` to `shiftId: uuid("shift_id"),` and update the FK comment-free definition (composite FK stays; MATCH SIMPLE skips null). In `stationSyncQuarantine`'s CHECK replace the kind list with:

```ts
      sql`${t.recordKind} IN ('item', 'box', 'exception', 'product_label_event', 'pallet', 'pallet_exception', 'pallet_membership')`,
```

- [ ] **Step 5: Add `pallet_membership_rejections`**

Append after `palletExceptions` in `platform.ts`:

```ts
/**
 * A membership the server refused (spec §1.4). Append-only: a handheld that
 * reboots after the batch answer has nothing else to rebuild its conflict
 * view from, and the cabinet card counts these. Unique per (pallet, sscc)
 * so a replayed batch cannot duplicate a refusal.
 */
export const palletMembershipRejections = pgTable(
  "pallet_membership_rejections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    palletId: uuid("pallet_id").notNull(),
    boxSscc: char("box_sscc", { length: 18 }).notNull(),
    boxId: uuid("box_id"),
    reason: text("reason")
      .$type<"already_on_pallet" | "not_found" | "not_closed" | "disassembled" | "product_mismatch">()
      .notNull(),
    winningPalletId: uuid("winning_pallet_id"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("pallet_membership_rejections_tenant_pallet_sscc_uq").on(t.tenantId, t.palletId, t.boxSscc),
    check(
      "pallet_membership_rejections_reason_check",
      sql`${t.reason} IN ('already_on_pallet', 'not_found', 'not_closed', 'disassembled', 'product_mismatch')`,
    ),
    foreignKey({
      name: "pallet_membership_rejections_tenant_pallet_fk",
      columns: [t.tenantId, t.palletId],
      foreignColumns: [pallets.tenantId, pallets.id],
    }),
    foreignKey({
      name: "pallet_membership_rejections_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "pallet_membership_rejections_tenant_winning_pallet_fk",
      columns: [t.tenantId, t.winningPalletId],
      foreignColumns: [pallets.tenantId, pallets.id],
    }),
  ],
);
```

- [ ] **Step 6: `can_build_pallets` and export columns**

In `packages/db/src/schema/pickup.ts` add after `canWriteoff`:

```ts
    /** May build warehouse pallets on a handheld (spec §1.5). */
    canBuildPallets: boolean("can_build_pallets").notNull().default(false),
```

In `packages/db/src/schema/shift-exports.ts` change `shiftId: uuid("shift_id").notNull(),` to:

```ts
    /** Null for a per-pallet export; exactly one of shift_id / pallet_id is set. */
    shiftId: uuid("shift_id"),
    palletId: uuid("pallet_id"),
```

and add to the constraint array:

```ts
    check(
      "shift_exports_target_shape",
      sql`(${table.shiftId} IS NOT NULL AND ${table.palletId} IS NULL) OR (${table.shiftId} IS NULL AND ${table.palletId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "shift_exports_tenant_pallet_fk",
      columns: [table.tenantId, table.palletId],
      foreignColumns: [pallets.tenantId, pallets.id],
    }),
```

importing `pallets` from `./platform` (check the file's existing imports; `shifts` is already imported the same way).

- [ ] **Step 7: Generate and review the migration**

Run: `pnpm --filter @markiro/db db:generate`
Expected: a new `packages/db/migrations/0162_*.sql` and `meta/0162_snapshot.json`. Rename the SQL file to `0162_warehouse_pallets.sql` and set the matching `tag` in `meta/_journal.json`. Open the SQL and confirm it contains, in this order: `ALTER TABLE "pallets" ALTER COLUMN "shift_id" DROP NOT NULL`, the three `ADD COLUMN`s with `DEFAULT 'production' NOT NULL` on `kind`, `ALTER TABLE "pallet_exceptions" ALTER COLUMN "shift_id" DROP NOT NULL`, the quarantine CHECK drop/add, `CREATE TABLE "pallet_membership_rejections"`, the two unique/partial indexes, `pallets_kind_shape`, the FKs, `employee_pickup_policies ADD COLUMN can_build_pallets`, and the `shift_exports` changes. If drizzle emits the quarantine CHECK as drop+add, keep it. No data backfill is needed: every existing pallet row has a shift and reads as `production`.

- [ ] **Step 8: Build and run the migration test**

Run: `pnpm --filter @markiro/db build && set -a; source .env; set +a; pnpm --filter @markiro/db exec vitest run test/warehouse-pallets-migration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Run the db package gates**

Run: `pnpm --filter @markiro/db test && pnpm --filter @markiro/db typecheck && pnpm --filter @markiro/db lint`
Expected: PASS. `schema.test.ts` and `sqlite-schema.test.ts` are unaffected (no SQLite change in this plan).

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/src/schema/pickup.ts packages/db/src/schema/shift-exports.ts packages/db/migrations/0162_warehouse_pallets.sql packages/db/migrations/meta/0162_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/warehouse-pallets-migration.test.ts
git commit -m "feat(db): warehouse pallets, membership rejections, pallet exports"
```

---

### Task 3: Sync batch DTO

**Files:**
- Modify: `apps/api/src/modules/station-scans/dto.ts:103-250, 366-392, 434-500`
- Test: `apps/api/test/station-scans-dto.test.ts`

**Interfaces:**
- Produces: `palletMembershipSchema`, `PalletMembershipDto`, `syncBatchSchema.palletMemberships`, pallet closure fields `kind`, `productId`, nullable `shiftId`; `PalletMembershipOutcomeDto`, `SyncBatchResponseDto.memberships`; `DeniedStationRecordDto.recordKind` gains `"pallet_membership"` and `shiftId: string | null`.

- [ ] **Step 1: Write the failing DTO tests**

Append to `apps/api/test/station-scans-dto.test.ts` (it already imports `syncBatchSchema`; add `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` from `@markiro/domain`):

```ts
describe("warehouse pallet records", () => {
  const membership = {
    palletId: "w1",
    boxSscc: "003460068200000017",
    addedAt: "2026-09-17T08:00:00.000Z",
    operatorId: null,
  };

  it("accepts palletMemberships and defaults them to empty", () => {
    expect(syncBatchSchema.parse({ batchId: "b", items: [] }).palletMemberships).toEqual([]);
    const parsed = syncBatchSchema.parse({ batchId: "b", items: [], palletMemberships: [membership] });
    expect(parsed.palletMemberships).toEqual([membership]);
  });

  it("caps palletMemberships at the shared limit", () => {
    const tooMany = Array.from({ length: MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH + 1 }, (_, i) => ({
      ...membership,
      boxSscc: `0034600682${String(i).padStart(7, "0")}1`,
    }));
    expect(() => syncBatchSchema.parse({ batchId: "b", items: [], palletMemberships: tooMany })).toThrow();
  });

  it("rejects a membership naming one box twice for one pallet", () => {
    expect(() =>
      syncBatchSchema.parse({ batchId: "b", items: [], palletMemberships: [membership, membership] }),
    ).toThrow(/at most once/);
  });

  it("defaults a pallet closure to kind production and requires a shift there", () => {
    const closure = {
      palletId: "p1",
      shiftId: "5f1a5cf0-4f8a-4e7a-9b48-3d3f7a0c1d11",
      terminalId: null,
      sscc: "134600682000000017",
      closedAt: "2026-09-17T08:00:00.000Z",
      operatorId: null,
    };
    const parsed = syncBatchSchema.parse({ batchId: "b", items: [], pallets: [closure] });
    expect(parsed.pallets[0]).toMatchObject({ kind: "production", productId: null });
    expect(() =>
      syncBatchSchema.parse({ batchId: "b", items: [], pallets: [{ ...closure, shiftId: null }] }),
    ).toThrow(/shiftId/);
  });

  it("accepts a warehouse closure with no shift and a product, and rejects one with a shift", () => {
    const closure = {
      palletId: "w1",
      kind: "warehouse",
      shiftId: null,
      productId: "5f1a5cf0-4f8a-4e7a-9b48-3d3f7a0c1d11",
      terminalId: null,
      sscc: "134600682000000017",
      closedAt: "2026-09-17T08:00:00.000Z",
      operatorId: null,
    };
    expect(syncBatchSchema.parse({ batchId: "b", items: [], pallets: [closure] }).pallets[0]).toMatchObject({
      kind: "warehouse",
      shiftId: null,
    });
    expect(() =>
      syncBatchSchema.parse({
        batchId: "b",
        items: [],
        pallets: [{ ...closure, shiftId: "5f1a5cf0-4f8a-4e7a-9b48-3d3f7a0c1d11" }],
      }),
    ).toThrow(/shiftId/);
    expect(() =>
      syncBatchSchema.parse({ batchId: "b", items: [], pallets: [{ ...closure, productId: null }] }),
    ).toThrow(/productId/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @markiro/api exec vitest run test/station-scans-dto.test.ts`
Expected: FAIL — `palletMemberships` unknown / `kind` missing.

- [ ] **Step 3: Extend the DTO**

In `apps/api/src/modules/station-scans/dto.ts` import `MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH` alongside the other limits from `@markiro/domain`. Replace `palletClosureSchema` with:

```ts
const palletClosureSchema = z
  .object({
    palletId: z.string().min(1).max(64),
    // Null only for a warehouse pallet; a production pallet keeps its shift.
    shiftId: z.string().uuid().toLowerCase().nullable(),
    terminalId: z.string().nullable(),
    sscc: z.string().regex(/^\d{18}$/),
    closedAt: z.string().datetime(),
    operatorId: z.string().uuid().toLowerCase().nullable(),
    printVerifiedAt: z.string().datetime().nullable().default(null),
    printSkippedAt: z.string().datetime().nullable().default(null),
    // Defaulted for every device that predates warehouse pallets.
    kind: z.enum(["production", "warehouse"]).default("production"),
    productId: z.string().uuid().toLowerCase().nullable().default(null),
  })
  .superRefine((closure, ctx) => {
    if (closure.printVerifiedAt !== null && closure.printSkippedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["printSkippedAt"],
        message: "print verification outcomes are mutually exclusive",
      });
    }
    if (closure.kind === "production" && closure.shiftId === null) {
      ctx.addIssue({ code: "custom", path: ["shiftId"], message: "a production pallet needs a shiftId" });
    }
    if (closure.kind === "warehouse") {
      if (closure.shiftId !== null) {
        ctx.addIssue({ code: "custom", path: ["shiftId"], message: "a warehouse pallet has no shiftId" });
      }
      if (closure.productId === null) {
        ctx.addIssue({ code: "custom", path: ["productId"], message: "a warehouse pallet needs a productId" });
      }
    }
  });

/**
 * One closed box scanned onto a warehouse pallet (spec §2.2). No terminal
 * and no shift: the pallet is the authenticated device's, and the box is
 * looked up by its SSCC across the whole tenant.
 */
export const palletMembershipSchema = z.object({
  palletId: z.string().min(1).max(64),
  boxSscc: z.string().regex(/^\d{18}$/),
  addedAt: z.string().datetime(),
  operatorId: z.string().uuid().toLowerCase().nullable(),
});
export type PalletMembershipDto = z.infer<typeof palletMembershipSchema>;
```

In `syncBatchSchema` change the pallet uniqueness refine key to `${pallet.shiftId ?? "warehouse"}|${pallet.palletId}` and add after `palletExceptions`:

```ts
  palletMemberships: z
    .array(palletMembershipSchema)
    .max(MAX_PALLET_MEMBERSHIPS_PER_SYNC_BATCH)
    .refine(
      (memberships) =>
        new Set(memberships.map((m) => `${m.palletId}|${m.boxSscc}`)).size === memberships.length,
      "Pallet memberships must name each (pallet, box) at most once in a batch",
    )
    .default([]),
```

Change `DeniedStationRecordDto`:

```ts
  recordKind:
    | "item"
    | "box"
    | "exception"
    | "product_label_event"
    | "pallet"
    | "pallet_exception"
    | "pallet_membership";
  recordIndex: number;
  /** Null for a warehouse record, which belongs to no shift. */
  shiftId: string | null;
```

Add the outcome type and response field:

```ts
export type PalletMembershipStatus =
  | "accepted"
  | "replayed"
  | "already_on_pallet"
  | "not_found"
  | "not_closed"
  | "disassembled"
  | "product_mismatch"
  | "subscription_read_only";

export interface PalletMembershipOutcomeDto {
  palletId: string;
  boxSscc: string;
  status: PalletMembershipStatus;
  /** AI-00-prefixed SSCC of the pallet that already holds the box; only with `already_on_pallet`. */
  winningPalletSscc?: string;
}
```

and in `SyncBatchResponseDto` add `memberships?: PalletMembershipOutcomeDto[];` with the comment «Present when the batch carried `palletMemberships`; one entry per record, same order.»

Update the OpenAPI schemas: `deniedStationRecordOpenApiSchema.properties.recordKind.enum` gains `"pallet_membership"`, `shiftId` becomes `{ type: "string", format: "uuid", nullable: true }`; add

```ts
const palletMembershipOutcomeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["palletId", "boxSscc", "status"],
  properties: {
    palletId: { type: "string" },
    boxSscc: { type: "string", pattern: "^[0-9]{18}$" },
    status: {
      type: "string",
      enum: [
        "accepted",
        "replayed",
        "already_on_pallet",
        "not_found",
        "not_closed",
        "disassembled",
        "product_mismatch",
        "subscription_read_only",
      ],
    },
    winningPalletSscc: { type: "string", pattern: "^00[0-9]{18}$" },
  },
};
```

and `memberships: { type: "array", items: palletMembershipOutcomeOpenApiSchema }` in `syncBatchResponseOpenApiSchema.properties`.

- [ ] **Step 4: Run the DTO tests**

Run: `pnpm --filter @markiro/api exec vitest run test/station-scans-dto.test.ts test/openapi-coverage.test.ts`
Expected: PASS. Typecheck will fail until Task 4 wires the service — that is expected here.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/station-scans/dto.ts apps/api/test/station-scans-dto.test.ts
git commit -m "feat(api): pallet membership and warehouse closure DTOs"
```

---

### Task 4: Ingest — memberships and warehouse closures

**Files:**
- Modify: `apps/api/src/modules/station-scans/pallet-ingest.ts`
- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts` (~230-262 substitution, ~372-392 replay, ~404-432 shift lock, ~448-545 read-only, ~1312-1341 pre-pass, ~1573-1615 closures/exceptions, ~1627-1640 touched shifts, ~1666-1674 result, ~1709-1716 quarantine payloads)
- Test: `apps/api/test/station-scans-warehouse-pallets.e2e.test.ts`

**Interfaces:**
- Consumes: DTOs from Task 3; `advanceBoxRegistryVersion`; `SsccService.recordConsumedSerial`.
- Produces: `PalletRef` gains `kind`, `productId`, `deviceId`; `palletKey(shiftId | null, terminalId, devicePalletId)` where `null` shift renders as `"warehouse"`; `applyPalletMemberships(tx, tenantId, memberships, byKey, deviceId, readOnly): Promise<{ outcomes: PalletMembershipOutcomeDto[]; changedBoxIds: string[] }>`; `applyPalletClosures` returns `string[]` of member box ids of closed warehouse pallets.

- [ ] **Step 1: Write the failing e2e test**

Create `apps/api/test/station-scans-warehouse-pallets.e2e.test.ts`. The harness is the one `pallets.e2e.test.ts` uses (copy its imports, `item()`, `postBatch()`, `beforeAll` app boot, product/shift/employee creation and box seeding). Then:

```ts
  // Two production boxes closed in a shift (b1, b2) and one more (b3) in a
  // SECOND shift of the same product, so the warehouse pallet mixes shifts.
  // A fourth box (b4) belongs to a different product; a fifth (b5) is open.

  let device2Key: string;
  let device2Id: string;

  // In beforeAll after the box batches:
  //   device2 = await createTestStationDevice(app!, agent, "TSD-2");
  //   const block = await app!.get(SsccService).allocate(tenantId, ISSUER_PREFIX, PALLET_EXTENSION_DIGIT, stationDeviceId, 5);
  //   warehouseSscc = buildSscc(PALLET_EXTENSION_DIGIT, ISSUER_PREFIX, block.fromSerial);

  const membership = (palletId: string, boxSscc: string) => ({
    palletId,
    boxSscc,
    addedAt: "2026-09-17T09:00:00.000Z",
    operatorId,
  });

  it("attaches closed boxes from two shifts to a warehouse pallet and reports each outcome", async () => {
    const res = await postBatch({
      palletMemberships: [
        membership("w1", B1_SSCC),
        membership("w1", B3_SSCC),
        membership("w1", B4_SSCC), // other product
        membership("w1", B5_SSCC), // still open
        membership("w1", "003460068299999990"), // unknown
      ],
    });
    expect(res.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "accepted" },
      { palletId: "w1", boxSscc: B3_SSCC, status: "accepted" },
      { palletId: "w1", boxSscc: B4_SSCC, status: "product_mismatch" },
      { palletId: "w1", boxSscc: B5_SSCC, status: "not_closed" },
      { palletId: "w1", boxSscc: "003460068299999990", status: "not_found" },
    ]);
    const list = await agent.get("/pallets").query({ kind: "warehouse" }).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ kind: "warehouse", boxCount: 2, rejectedMembershipCount: 3 });
  });

  it("replays a membership as a no-op and refuses the box for another device's pallet", async () => {
    const replay = await postBatch({ palletMemberships: [membership("w1", B1_SSCC)] });
    expect(replay.body.memberships).toEqual([{ palletId: "w1", boxSscc: B1_SSCC, status: "replayed" }]);

    const rival = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device2Key)
      .send({ batchId: `rival-${randomUUID()}`, items: [], palletMemberships: [membership("w1", B1_SSCC)] })
      .expect(201);
    expect(rival.body.memberships).toEqual([
      { palletId: "w1", boxSscc: B1_SSCC, status: "already_on_pallet" },
    ]);
    // Device 2's open pallet has no SSCC yet, so no winningPalletSscc either way;
    // after device 1 closes below, a repeat carries it.
  });

  it("closes the warehouse pallet with an extension-1 serial and bumps its boxes' registry version", async () => {
    const before = await request(app!.getHttpServer())
      .get("/station/box-registry")
      .set("x-api-key", stationKey)
      .expect(200);
    await postBatch({
      pallets: [
        {
          palletId: "w1",
          kind: "warehouse",
          shiftId: null,
          productId,
          terminalId: null,
          sscc: warehouseSscc,
          closedAt: "2026-09-17T09:30:00.000Z",
          operatorId,
          printVerifiedAt: null,
          printSkippedAt: null,
        },
      ],
    });
    const after = await request(app!.getHttpServer())
      .get("/station/box-registry")
      .query({ since: before.body.until })
      .set("x-api-key", stationKey)
      .expect(200);
    const b1 = after.body.items.find((i: { sscc?: string }) => i.sscc === B1_SSCC);
    expect(b1).toMatchObject({ kind: "upsert", palletSscc: warehouseSscc, palletActive: true });

    const rival = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device2Key)
      .send({ batchId: `rival2-${randomUUID()}`, items: [], palletMemberships: [membership("w9", B1_SSCC)] })
      .expect(201);
    expect(rival.body.memberships[0]).toEqual({
      palletId: "w9",
      boxSscc: B1_SSCC,
      status: "already_on_pallet",
      winningPalletSscc: `00${warehouseSscc}`,
    });
  });

  it("re-attaches a box once its old pallet is disassembled", async () => {
    await postBatch({
      palletExceptions: [
        { kind: "disassemble", palletId: "w1", shiftId: null, terminalId: null, operatorId, reason: "перекладка", occurredAt: "2026-09-17T10:00:00.000Z" },
      ],
    });
    const res = await postBatch({ palletMemberships: [membership("w2", B1_SSCC)] });
    expect(res.body.memberships).toEqual([{ palletId: "w2", boxSscc: B1_SSCC, status: "accepted" }]);
  });

  it("does not let another tenant's device see or touch these pallets", async () => {
    const other = request.agent(app!.getHttpServer());
    await signUpAndActivate(other);
    const otherDevice = await createTestStationDevice(app!, other, "Other");
    const res = await request(app!.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", otherDevice.apiKey)
      .send({ batchId: `other-${randomUUID()}`, items: [], palletMemberships: [membership("w1", B1_SSCC)] })
      .expect(201);
    expect(res.body.memberships).toEqual([{ palletId: "w1", boxSscc: B1_SSCC, status: "not_found" }]);
    await other.get("/pallets").query({ kind: "warehouse" }).expect(200).expect((r) => {
      expect(r.body.items).toEqual([]);
    });
  });
```

The `pallet exceptions` DTO's `shiftId` must also become nullable in Task 3's `palletExceptionSchema` (`z.string().uuid().toLowerCase().nullable()`); include that edit in this task if it was missed. The `GET /pallets?kind=` assertions rely on Task 8; until then, replace those two `agent.get("/pallets")` blocks with direct `schema.pallets` selects through `app.get(DB)` and restore them in Task 8.

- [ ] **Step 2: Run to see it fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/station-scans-warehouse-pallets.e2e.test.ts`
Expected: FAIL — `memberships` undefined in the response.

- [ ] **Step 3: `pallet-ingest.ts` — keys, refs, pre-pass**

Replace `palletKey`/`PalletRef` with:

```ts
export function palletKey(
  shiftId: string | null,
  terminalId: string | null,
  devicePalletId: string,
): PalletKey {
  // A shift id is a uuid, so the literal can never collide with one.
  return `${shiftId ?? "warehouse"}|${terminalId ?? ""}|${devicePalletId}`;
}

export interface PalletRef {
  shiftId: string | null;
  terminalId: string | null;
  devicePalletId: string;
  kind: "production" | "warehouse";
  /** Required for a warehouse ref; ignored for production. */
  productId: string | null;
  /** The authenticated device; required for a warehouse ref. */
  deviceId: string | null;
}
```

In `upsertPallets`, insert warehouse and production refs separately (two conflict targets), skipping a warehouse ref whose `productId` is null (its membership reports `not_found` later, and a closure always carries a product):

```ts
  const production = ordered.filter(([, ref]) => ref.kind === "production");
  const warehouse = ordered.filter(
    ([, ref]) => ref.kind === "warehouse" && ref.productId !== null && ref.deviceId !== null,
  );
  if (production.length > 0) {
    await tx
      .insert(schema.pallets)
      .values(
        production.map(([, ref]) => ({
          tenantId,
          kind: "production" as const,
          shiftId: ref.shiftId,
          terminalId: ref.terminalId,
          devicePalletId: ref.devicePalletId,
        })),
      )
      .onConflictDoNothing({
        target: [
          schema.pallets.tenantId,
          schema.pallets.shiftId,
          schema.pallets.terminalId,
          schema.pallets.devicePalletId,
        ],
      });
  }
  if (warehouse.length > 0) {
    await tx
      .insert(schema.pallets)
      .values(
        warehouse.map(([, ref]) => ({
          tenantId,
          kind: "warehouse" as const,
          shiftId: null,
          terminalId: ref.terminalId,
          devicePalletId: ref.devicePalletId,
          productId: ref.productId,
          deviceId: ref.deviceId,
        })),
      )
      .onConflictDoNothing({
        target: [schema.pallets.tenantId, schema.pallets.deviceId, schema.pallets.devicePalletId],
        where: sql`${schema.pallets.kind} = 'warehouse'`,
      });
  }
```

Extend the read-back SELECT to also return `kind` and `deviceId`, drop the `inArray(shiftId, …)` filter when any ref has a null shift (use `or(inArray(shiftId, shiftIds), isNull(shiftId))`), and build the map with `palletKey(row.shiftId, row.terminalId, row.devicePalletId)` — a warehouse row's `shiftId` is null, so its key is the `"warehouse|…"` form the callers compute.

- [ ] **Step 4: `pallet-ingest.ts` — memberships**

Add the DTO type import (`import type { PalletMembershipDto, PalletMembershipOutcomeDto } from "./dto";`) and `formatSsccWithAi` from `@markiro/domain`, then:

```ts
/**
 * Applies this batch's warehouse memberships (spec §2.3) one statement each,
 * sorted by (palletId, boxSscc) for the usual 40P01 reason. The UPDATE is the
 * whole rule: closed, not disassembled, same product as the pallet, and
 * either on no pallet or on a pallet that has since been disassembled.
 * Zero rows matched → one diagnostic SELECT classifies the refusal and a
 * `pallet_membership_rejections` row remembers it.
 */
export async function applyPalletMemberships(
  tx: Transaction,
  tenantId: string,
  memberships: readonly PalletMembershipDto[],
  byKey: Map<PalletKey, string>,
  deviceId: string,
): Promise<{ outcomes: PalletMembershipOutcomeDto[]; changedBoxIds: string[] }> {
  const ordered = [...memberships]
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const left = `${a.m.palletId}|${a.m.boxSscc}`;
      const right = `${b.m.palletId}|${b.m.boxSscc}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const outcomes: PalletMembershipOutcomeDto[] = new Array(memberships.length);
  const changedBoxIds: string[] = [];

  for (const { m, index } of ordered) {
    const palletId = byKey.get(palletKey(null, deviceId, m.palletId));
    if (palletId === undefined) {
      // No pallet row could be created: the box is unknown, so its product
      // could not seed one. Reported as not_found; nothing to record it
      // against.
      outcomes[index] = { palletId: m.palletId, boxSscc: m.boxSscc, status: "not_found" };
      continue;
    }

    const updated = await tx.execute(sql`
      UPDATE boxes b
         SET pallet_id = ${palletId}, updated_at = now()
        FROM shifts s, pallets tp
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${m.boxSscc}
         AND s.tenant_id = b.tenant_id AND s.id = b.shift_id
         AND tp.tenant_id = b.tenant_id AND tp.id = ${palletId}
         AND tp.product_id = s.product_id
         AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL
         AND (b.pallet_id IS NULL
              OR EXISTS (SELECT 1 FROM pallets old
                          WHERE old.tenant_id = b.tenant_id AND old.id = b.pallet_id
                            AND old.id <> ${palletId} AND old.disassembled_at IS NOT NULL))
      RETURNING b.id
    `);
    const accepted = updated.rows[0] as { id: string } | undefined;
    if (accepted) {
      changedBoxIds.push(accepted.id);
      outcomes[index] = { palletId: m.palletId, boxSscc: m.boxSscc, status: "accepted" };
      continue;
    }

    const diag = await tx.execute(sql`
      SELECT b.id, b.closed_at, b.disassembled_at, b.pallet_id,
             old.sscc AS old_sscc, old.disassembled_at AS old_disassembled_at,
             (s.product_id = tp.product_id) AS same_product
        FROM boxes b
        JOIN shifts s ON s.tenant_id = b.tenant_id AND s.id = b.shift_id
        JOIN pallets tp ON tp.tenant_id = b.tenant_id AND tp.id = ${palletId}
        LEFT JOIN pallets old ON old.tenant_id = b.tenant_id AND old.id = b.pallet_id
       WHERE b.tenant_id = ${tenantId} AND b.sscc = ${m.boxSscc}
    `);
    const row = diag.rows[0] as
      | {
          id: string;
          closed_at: Date | null;
          disassembled_at: Date | null;
          pallet_id: string | null;
          old_sscc: string | null;
          old_disassembled_at: Date | null;
          same_product: boolean;
        }
      | undefined;

    let status: PalletMembershipOutcomeDto["status"];
    let winningPalletId: string | null = null;
    let winningPalletSscc: string | undefined;
    if (!row) status = "not_found";
    else if (row.pallet_id === palletId) status = "replayed";
    else if (row.closed_at === null) status = "not_closed";
    else if (row.disassembled_at !== null) status = "disassembled";
    else if (row.pallet_id !== null && row.old_disassembled_at === null) {
      status = "already_on_pallet";
      winningPalletId = row.pallet_id;
      if (row.old_sscc !== null) winningPalletSscc = formatSsccWithAi(row.old_sscc);
    } else status = "product_mismatch";

    outcomes[index] = {
      palletId: m.palletId,
      boxSscc: m.boxSscc,
      status,
      ...(winningPalletSscc !== undefined ? { winningPalletSscc } : {}),
    };
    if (status !== "replayed") {
      await tx
        .insert(schema.palletMembershipRejections)
        .values({
          tenantId,
          palletId,
          boxSscc: m.boxSscc,
          boxId: row?.id ?? null,
          reason: status,
          winningPalletId,
          addedAt: new Date(m.addedAt),
        })
        .onConflictDoNothing();
    }
  }
  return { outcomes, changedBoxIds };
}
```

`Transaction` must expose `execute`; widen the local type: `type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];` already does.

- [ ] **Step 5: `pallet-ingest.ts` — closures and exceptions for warehouse pallets**

In `PalletClosureDto` and `PalletExceptionDto` make `shiftId: string | null` and add to the closure `kind: "production" | "warehouse"; productId: string | null;`. In `applyPalletClosures` compute `const id = byKey.get(palletKey(closure.shiftId, closure.terminalId, closure.palletId));` (unchanged call, now null-aware) and change the return type to `Promise<string[]>`: after a matched (`matched === 1`) closure of a warehouse pallet, collect its member box ids:

```ts
      if (matched === 1 && closure.kind === "warehouse") {
        const members = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, id)));
        memberBoxIds.push(...members.map((b) => b.id));
      }
```

and `return memberBoxIds;`. In `applyPalletExceptions` change the return type to `Promise<string[]>` and, in the `disassemble` branch, select the member box ids the same way and return them (the caller bumps their registry version — spec §2.3 last bullet). Insert `shiftId: ex.shiftId` unchanged (now nullable).

- [ ] **Step 6: Wire the service**

In `station-scans.service.ts`:

1. Input type and substitution (around 230-262): add `palletMemberships?: SyncBatchDto["palletMemberships"];` to the input type; in `body` add `palletMemberships: input.palletMemberships ?? [],` (no terminal field to substitute).
2. Replay branch (around 383): add `...(stored?.memberships ? { memberships: stored.memberships } : {}),`.
3. Shift lock (around 404-417): filter nulls — `...body.pallets.flatMap((p) => (p.shiftId === null ? [] : [p.shiftId])), ...body.palletExceptions.flatMap((e) => (e.shiftId === null ? [] : [e.shiftId])),`.
4. Read-only denial (around 448-545): the `eligible()` helper takes a shift id; for a warehouse closure use `closedAt < endsAt` instead. Replace the pallets flatMap with:

```ts
            ...body.pallets.flatMap((pallet, recordIndex) => {
              const ok =
                pallet.shiftId === null
                  ? endsAt !== null && new Date(pallet.closedAt) < endsAt
                  : eligible(pallet.shiftId);
              return ok
                ? []
                : [{ recordKind: "pallet" as const, recordIndex, shiftId: pallet.shiftId, code: "subscription_read_only" as const }];
            }),
            ...body.palletMemberships.map((membership, recordIndex) => ({
              recordKind: "pallet_membership" as const,
              recordIndex,
              shiftId: null,
              code: "subscription_read_only" as const,
            })),
```

and mirror the pallet-exception flatMap with the same null-shift handling (`occurredAt < endsAt`). In the filtered-body construction add `palletMemberships: body.palletMemberships.filter((_m, index) => !deniedKeys.has(\`pallet_membership:${index}\`)),` and keep the original list in a `const deniedMemberships = body.palletMemberships` snapshot before filtering so the response can report them.
5. Pre-pass (around 1312-1341): every existing ref gets `kind: "production", productId: null, deviceId: null`; closures use `kind: closure.kind, productId: closure.productId, deviceId: closure.kind === "warehouse" ? authenticatedTerminalId : null`; exceptions with `shiftId === null` get `kind: "warehouse", productId: null, deviceId: authenticatedTerminalId` (an exception never creates a warehouse row: `upsertPallets` skips a null product, and a missing pallet is a no-op there). Add membership refs: resolve each distinct `boxSscc` to its shift product in one query before the pre-pass —

```ts
        const membershipProducts = new Map<string, string>();
        if (body.palletMemberships.length > 0) {
          const rows = await tx
            .select({ sscc: schema.boxes.sscc, productId: schema.shifts.productId })
            .from(schema.boxes)
            .innerJoin(
              schema.shifts,
              and(eq(schema.shifts.tenantId, schema.boxes.tenantId), eq(schema.shifts.id, schema.boxes.shiftId)),
            )
            .where(
              and(
                eq(schema.boxes.tenantId, tenantId),
                inArray(schema.boxes.sscc, [...new Set(body.palletMemberships.map((m) => m.boxSscc))]),
              ),
            );
          for (const row of rows) if (row.sscc !== null) membershipProducts.set(row.sscc, row.productId);
        }
```

and push, per membership, `{ shiftId: null, terminalId: authenticatedTerminalId, devicePalletId: m.palletId, kind: "warehouse", productId: membershipProducts.get(m.boxSscc) ?? null, deviceId: authenticatedTerminalId }`. The first membership of a pallet whose box IS known seeds the pallet's product; a batch where every membership's box is unknown creates no row and reports `not_found` for each.
6. After the box-closure loop and before pallet closures:

```ts
        let membershipOutcomes: PalletMembershipOutcomeDto[] = [];
        if (body.palletMemberships.length > 0) {
          const applied = await applyPalletMemberships(
            tx,
            tenantId,
            body.palletMemberships,
            palletsByKey,
            authenticatedTerminalId,
          );
          membershipOutcomes = applied.outcomes;
          await this.advanceBoxRegistryVersions(tx, tenantId, applied.changedBoxIds);
        }
```

7. Pallet closures: `const closedWarehouseMembers = await applyPalletClosures(...)` then `await this.advanceBoxRegistryVersions(tx, tenantId, closedWarehouseMembers);`. Pallet exceptions: `const disassembledMembers = await applyPalletExceptions(...)` then bump those too.
8. Touched shifts (around 1627-1640): filter null shift ids from pallets and pallet exceptions.
9. Result: add `...(memberships.length > 0 ? { memberships } : {})` where `memberships` is the full-length list: denied memberships get `{ palletId, boxSscc, status: "subscription_read_only" }` at their original index and applied ones take theirs from `membershipOutcomes` (build by walking `deniedMemberships` with a cursor over the filtered outcomes).
10. Quarantine payloads (around 1709-1716): add `pallet_membership: body.palletMemberships,` — use the pre-filter body for this map exactly as the other kinds do.

Import `applyPalletMemberships` and `type PalletMembershipOutcomeDto`.

- [ ] **Step 7: Run the e2e test and the existing pallet suites**

Run: `pnpm --filter @markiro/db build && set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/station-scans-warehouse-pallets.e2e.test.ts test/station-scans-pallets.e2e.test.ts test/pallets.e2e.test.ts test/station-scans.e2e.test.ts test/station-scans.service.test.ts`
Expected: PASS. Existing suites prove an old-shape batch still behaves.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/station-scans/pallet-ingest.ts apps/api/src/modules/station-scans/station-scans.service.ts apps/api/src/modules/station-scans/dto.ts apps/api/test/station-scans-warehouse-pallets.e2e.test.ts
git commit -m "feat(api): ingest warehouse pallet memberships and closures"
```

---

### Task 5: Box registry pallet fields and disassembly bumps

**Files:**
- Modify: `apps/api/src/modules/kiosk/box-registry.dto.ts:121-135, 150-185`
- Modify: `apps/api/src/modules/kiosk/box-registry.service.ts:24-37, 280-292, 362-400`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.service.ts:374-404`
- Test: `apps/api/test/kiosk-box-registry.test.ts`, `apps/api/test/kiosk-box-registry-openapi.test.ts`, `apps/api/test/station-scans-warehouse-pallets.e2e.test.ts`

**Interfaces:**
- Produces: registry `upsert` items carry `palletId: string | null`, `palletSscc: string | null`, `palletActive: boolean`, `closedAt: string`, `productionDate: string | null`.

- [ ] **Step 1: Write the failing unit test**

In `apps/api/test/kiosk-box-registry.test.ts` add to the `candidate()` builder defaults `palletId: null, palletSscc: null, palletDisassembledAt: null, productionDate: null` and a test:

```ts
  it("carries pallet membership and production date on an upsert", () => {
    const palletId = randomUUID();
    const change = evaluateBoxRegistryCandidate(
      candidate({ palletId, palletSscc: "134600682000000017", palletDisassembledAt: null, productionDate: "2026-09-10" }),
      [member()],
      false,
    );
    expect(change).toMatchObject({
      kind: "upsert",
      palletId,
      palletSscc: "134600682000000017",
      palletActive: true,
      productionDate: "2026-09-10",
    });
    const retired = evaluateBoxRegistryCandidate(
      candidate({ palletId, palletSscc: "134600682000000017", palletDisassembledAt: new Date() }),
      [member()],
      false,
    );
    expect(retired).toMatchObject({ palletActive: false });
  });
```

(`member()` is the file's existing helper; pass it whatever arguments the existing tests pass for a valid member.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @markiro/api exec vitest run test/kiosk-box-registry.test.ts`
Expected: FAIL — `palletActive` undefined.

- [ ] **Step 3: Extend the candidate, the change and the query**

`box-registry.service.ts` `BoxRegistryCandidate` gains:

```ts
  palletId: string | null;
  palletSscc: string | null;
  palletDisassembledAt: Date | null;
  /** `coalesce(shifts.production_date, shifts.planned_date)`, civil date. */
  productionDate: string | null;
```

`evaluateBoxRegistryCandidate`'s upsert return gains:

```ts
    palletId: candidate.palletId,
    palletSscc: candidate.palletSscc,
    palletActive: candidate.palletId !== null && candidate.palletDisassembledAt === null,
    closedAt: candidate.closedAt.toISOString(),
    productionDate: candidate.productionDate,
```

The `list()` query adds a `leftJoin(schema.pallets, and(eq(schema.pallets.tenantId, schema.boxes.tenantId), eq(schema.pallets.id, schema.boxes.palletId)))` and selects `palletId: schema.boxes.palletId, palletSscc: schema.pallets.sscc, palletDisassembledAt: schema.pallets.disassembledAt, productionDate: sql<string | null>\`coalesce(${schema.shifts.productionDate}, ${schema.shifts.plannedDate})::text\``.

`box-registry.dto.ts` `KioskBoxRegistryChange` upsert variant gains the five fields; `boxRegistryPageOpenApiSchema`'s upsert variant adds them to `required` and `properties` (`palletId` uuid nullable, `palletSscc` `^[0-9]{18}$` nullable, `palletActive` boolean, `closedAt` date-time, `productionDate` date nullable). Update `kiosk-box-registry-openapi.test.ts`'s expected `required` list for the upsert variant accordingly.

- [ ] **Step 4: Bump the registry on cabinet pallet disassembly**

In `disaggregation.service.ts` inside `if (palletIds.length > 0)`, after the `palletExceptions` insert:

```ts
        // Member boxes keep `pallet_id`, but every handheld's registry
        // mirror must learn the pallet is retired, or it keeps refusing
        // these boxes as «already on a pallet» (spec §2.3).
        const memberBoxes = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.palletId, palletIds)));
        await advanceBoxRegistryVersion(
          tx,
          tenantId,
          memberBoxes.map((box) => box.id),
        );
```

- [ ] **Step 5: Extend the e2e**

In `station-scans-warehouse-pallets.e2e.test.ts` add after the disassembly test: create a disaggregation document with a pallet line for `w2`'s SSCC (close `w2` first through `pallets[]`), apply it via the existing cabinet routes (`POST /disaggregation-documents`, add line, `POST /disaggregation-documents/:id/apply` — copy the exact calls from `apps/api/test/disaggregation-pallets.e2e.test.ts`), then fetch `/station/box-registry?since=<until before apply>` and assert `B1_SSCC` appears with `palletActive: false`.

- [ ] **Step 6: Run**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/kiosk-box-registry.test.ts test/kiosk-box-registry-openapi.test.ts test/kiosk-box-registry.e2e.test.ts test/station-scans-warehouse-pallets.e2e.test.ts test/station-writeoffs.e2e.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/kiosk/box-registry.dto.ts apps/api/src/modules/kiosk/box-registry.service.ts apps/api/src/modules/disaggregation/disaggregation.service.ts apps/api/test/kiosk-box-registry.test.ts apps/api/test/kiosk-box-registry-openapi.test.ts apps/api/test/station-scans-warehouse-pallets.e2e.test.ts
git commit -m "feat(api): box registry carries pallet membership"
```

---

### Task 6: `GET /station/pallet-bootstrap`

**Files:**
- Modify: `apps/api/src/modules/sscc/sscc.service.ts:329-362`
- Create: `apps/api/src/modules/station-pallets/dto.ts`, `station-pallets.service.ts`, `station-pallets.controller.ts`, `station-pallets.module.ts`
- Modify: `apps/api/src/app.module.ts` (register the module beside `StationWriteoffsModule`)
- Test: `apps/api/test/station-pallet-bootstrap.e2e.test.ts`

**Interfaces:**
- Produces: `SsccService.resolveOrganisationIssuerPrefix(tenantId, executor?)`; `StationPalletBootstrapDto` as in spec §2.1 with `byCategory` keyed by `chzProductGroupCode: number`.

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/api/test/station-pallet-bootstrap.e2e.test.ts — same boot as station-writeoffs.e2e.test.ts
describe.skipIf(!ready)("station pallet bootstrap", () => {
  // beforeAll: sign up, create device, create two products (one with
  // chzProductGroupCode 8 and palletBoxCapacity 12, one archived), create an
  // employee and PATCH its pickup-policy with canBuildPallets: true (Task 7),
  // set org profile GLN via PUT /org/profile { gln: "4600682000012" }.

  it("returns products, operators, the extension-1 block and templates", async () => {
    const res = await request(app!.getHttpServer())
      .get("/station/pallet-bootstrap")
      .set("x-api-key", apiKey)
      .expect(200);
    expect(res.body.products.map((p: { id: string }) => p.id)).toEqual([activeProductId]);
    expect(res.body.products[0]).toMatchObject({ palletBoxCapacity: 12, chzProductGroupCode: 8 });
    expect(res.body.operators).toContainEqual({ employeeId, canBuildPallets: true });
    expect(res.body.palletSscc).toMatchObject({ extensionDigit: 1, issuerPrefix: "046006820" });
    expect(res.body.palletSsccRevokedFrom).toEqual([]);
    expect(res.body.palletLabelTemplates.organisation).not.toBeNull(); // stock «Паллета 100×150» seeded by 0130
    expect(Array.isArray(res.body.palletLabelTemplates.byCategory)).toBe(true);
  });

  it("hands the same block back on a second call", async () => {
    const first = await request(app!.getHttpServer()).get("/station/pallet-bootstrap").set("x-api-key", apiKey);
    const second = await request(app!.getHttpServer()).get("/station/pallet-bootstrap").set("x-api-key", apiKey);
    expect(second.body.palletSscc.fromSerial).toBe(first.body.palletSscc.fromSerial);
  });

  it("degrades to a null block without an organisation GLN", async () => {
    // a second tenant with a device and no GLN
    expect(res.body.palletSscc).toBeNull();
    expect(res.body.products).toEqual([]);
  });

  it("refuses a cabinet session and another tenant's device key", async () => {
    await agent.get("/station/pallet-bootstrap").expect(403);
    // other tenant's device sees its own (empty) catalogue, never ours
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/station-pallet-bootstrap.e2e.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Split the issuer prefix resolver**

In `sscc.service.ts` add above `resolveIssuerPrefix`:

```ts
  /** The organisation's own prefix — what every warehouse pallet carries (spec «Decisions»). */
  async resolveOrganisationIssuerPrefix(
    tenantId: string,
    executor: Pick<Db, "select"> = this.db,
  ): Promise<string> {
    const [profile] = await executor
      .select({ gln: schema.orgProfiles.gln })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.gln) throw new BadRequestException("organisation profile has no GLN");
    return deriveIssuerPrefix(profile.gln, "organisation profile");
  }
```

and make the tail of `resolveIssuerPrefix` call it (`return this.resolveOrganisationIssuerPrefix(tenantId, executor);`).

- [ ] **Step 4: DTO**

`apps/api/src/modules/station-pallets/dto.ts`:

```ts
import type { SchemaObject } from "@nestjs/swagger";
import type { LabelTemplateSpec } from "@markiro/domain";
import type { ShiftBundleDto } from "../shifts/dto";

export interface StationPalletBootstrapDto {
  generatedAt: string;
  products: {
    id: string;
    gtin14: string;
    name: string;
    printName: string | null;
    shelfLifeDays: number | null;
    palletBoxCapacity: number | null;
    chzProductGroupCode: number | null;
  }[];
  operators: { employeeId: string; canBuildPallets: boolean }[];
  palletSscc: ShiftBundleDto["palletSscc"];
  palletSsccRevokedFrom: number[];
  palletLabelTemplates: {
    organisation: LabelTemplateSpec | null;
    byCategory: { chzProductGroupCode: number; template: LabelTemplateSpec }[];
  };
}

export const stationPalletBootstrapOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["generatedAt", "products", "operators", "palletSscc", "palletSsccRevokedFrom", "palletLabelTemplates"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    products: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "gtin14", "name", "printName", "shelfLifeDays", "palletBoxCapacity", "chzProductGroupCode"],
        properties: {
          id: { type: "string", format: "uuid" },
          gtin14: { type: "string" },
          name: { type: "string" },
          printName: { type: "string", nullable: true },
          shelfLifeDays: { type: "integer", nullable: true },
          palletBoxCapacity: { type: "integer", nullable: true },
          chzProductGroupCode: { type: "integer", nullable: true },
        },
      },
    },
    operators: {
      type: "array",
      items: {
        type: "object",
        required: ["employeeId", "canBuildPallets"],
        properties: { employeeId: { type: "string", format: "uuid" }, canBuildPallets: { type: "boolean" } },
      },
    },
    palletSscc: {
      type: "object",
      nullable: true,
      required: ["issuerPrefix", "extensionDigit", "fromSerial", "toSerial", "consumedThroughSerial"],
      properties: {
        issuerPrefix: { type: "string" },
        extensionDigit: { type: "integer", enum: [1] },
        fromSerial: { type: "integer" },
        toSerial: { type: "integer" },
        consumedThroughSerial: { type: "integer", nullable: true },
      },
    },
    palletSsccRevokedFrom: { type: "array", items: { type: "integer" } },
    palletLabelTemplates: {
      type: "object",
      required: ["organisation", "byCategory"],
      properties: {
        organisation: { type: "object", nullable: true, additionalProperties: true },
        byCategory: {
          type: "array",
          items: {
            type: "object",
            required: ["chzProductGroupCode", "template"],
            properties: {
              chzProductGroupCode: { type: "integer" },
              template: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  },
};
```

- [ ] **Step 5: Service**

`station-pallets.service.ts`:

```ts
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LabelTemplateSpec } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { PALLET_EXTENSION_DIGIT, SsccCapacityExhaustedException, SsccService } from "../sscc/sscc.service";
import type { StationPalletBootstrapDto } from "./dto";

/** Same size the shift bundle uses; see `PALLET_BLOCK_SIZE` in shifts.service.ts. */
const PALLET_BLOCK_SIZE = 200;

@Injectable()
export class StationPalletsService {
  private readonly logger = new Logger(StationPalletsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sscc: SsccService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async bootstrap(tenantId: string, deviceId: string): Promise<StationPalletBootstrapDto> {
    const [products, operators, profile, categoryDefaults] = await Promise.all([
      this.db
        .select({
          id: schema.products.id,
          gtin14: schema.products.gtin14,
          name: schema.products.name,
          printName: schema.products.printName,
          shelfLifeDays: schema.products.shelfLifeDays,
          palletBoxCapacity: schema.products.palletBoxCapacity,
          chzProductGroupCode: schema.products.chzProductGroupCode,
        })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.archived, false))),
      this.db
        .select({
          employeeId: schema.employeePickupPolicies.employeeId,
          canBuildPallets: schema.employeePickupPolicies.canBuildPallets,
        })
        .from(schema.employeePickupPolicies)
        .where(eq(schema.employeePickupPolicies.tenantId, tenantId)),
      this.db
        .select({ templateId: schema.orgProfiles.defaultPalletLabelTemplateId })
        .from(schema.orgProfiles)
        .where(eq(schema.orgProfiles.tenantId, tenantId))
        .then((rows) => rows[0] ?? null),
      this.db
        .select({
          chzProductGroupCode: schema.orgPalletLabelTemplateDefaults.chzProductGroupCode,
          templateId: schema.orgPalletLabelTemplateDefaults.templateId,
        })
        .from(schema.orgPalletLabelTemplateDefaults)
        .where(eq(schema.orgPalletLabelTemplateDefaults.tenantId, tenantId)),
    ]);

    const templateIds = [
      ...new Set([profile?.templateId ?? null, ...categoryDefaults.map((d) => d.templateId)].filter((id): id is string => id !== null)),
    ];
    const specs = new Map<string, LabelTemplateSpec>();
    if (templateIds.length > 0) {
      const rows = await this.db
        .select({ id: schema.labelTemplates.id, spec: schema.labelTemplates.spec, enabled: schema.labelTemplates.enabled })
        .from(schema.labelTemplates)
        .where(eq(schema.labelTemplates.tenantId, tenantId));
      for (const row of rows) if (row.enabled && templateIds.includes(row.id)) specs.set(row.id, row.spec as LabelTemplateSpec);
    }

    const block = await this.palletBlock(tenantId, deviceId);
    return {
      generatedAt: new Date().toISOString(),
      products,
      operators,
      ...block,
      palletLabelTemplates: {
        organisation: profile?.templateId ? (specs.get(profile.templateId) ?? null) : null,
        byCategory: categoryDefaults.flatMap((d) => {
          const template = specs.get(d.templateId);
          return template ? [{ chzProductGroupCode: d.chzProductGroupCode, template }] : [];
        }),
      },
    };
  }

  /** Mirrors `ShiftsService.bundleSscc`'s pallet half, without a shift. */
  private async palletBlock(
    tenantId: string,
    deviceId: string,
  ): Promise<Pick<StationPalletBootstrapDto, "palletSscc" | "palletSsccRevokedFrom">> {
    const none = { palletSscc: null, palletSsccRevokedFrom: [] as number[] };
    return this.db.transaction(async (tx) => {
      const access = await this.entitlements.resolveRecovery(tenantId, tx, new Date());
      if (access.access === "read_only") return none;
      let issuerPrefix: string;
      try {
        issuerPrefix = await this.sscc.resolveOrganisationIssuerPrefix(tenantId, tx);
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        this.logger.warn(`Tenant ${tenantId} pallet bootstrap has no serial block -- ${error.message}`);
        return none;
      }
      try {
        const palletSscc = await this.sscc.allocateForBundle(tenantId, issuerPrefix, PALLET_EXTENSION_DIGIT, deviceId, PALLET_BLOCK_SIZE, tx);
        const palletSsccRevokedFrom = await this.sscc.revokedFromSerials(tenantId, issuerPrefix, PALLET_EXTENSION_DIGIT, deviceId, tx);
        return { palletSscc, palletSsccRevokedFrom };
      } catch (error) {
        if (!(error instanceof SsccCapacityExhaustedException)) throw error;
        this.logger.warn(`Tenant ${tenantId} pallet bootstrap has no serial block -- ${error.message}`);
        return none;
      }
    });
  }
}
```

Check the exact column name of the label-template enabled flag (`schema.labelTemplates.enabled`) and the spec column (`spec`) against `packages/db/src/schema/labels.ts` before relying on them; both are used by `ShiftsService.findLabelTemplate` and `listPalletLabelTemplates` as shown.

- [ ] **Step 6: Controller and module**

`station-pallets.controller.ts`:

```ts
import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { AllowStationOrPermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { stationPalletBootstrapOpenApiSchema, type StationPalletBootstrapDto } from "./dto";
import { StationPalletsService } from "./station-pallets.service";

@ApiTags("station-pallets")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class StationPalletsController {
  constructor(private readonly service: StationPalletsService) {}

  @Get("station/pallet-bootstrap")
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "Get the handheld warehouse-pallet bootstrap",
    description:
      "Catalogue with pallet capacities, per-operator pallet permission, this device's extension-1 SSCC block for the organisation's GLN, and the default pallet label templates. The block is null when the subscription is read-only, the organisation has no GLN, or the prefix is exhausted.",
  })
  @ApiStationAuth()
  @ApiOkResponse({ schema: stationPalletBootstrapOpenApiSchema })
  @ApiHttpErrors(401, 403, 429)
  bootstrap(@Req() req: RequestWithTenant): Promise<StationPalletBootstrapDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.service.bootstrap(req.tenantId!, req.deviceId);
  }
}
```

`station-pallets.module.ts` imports `SsccModule`, declares the controller and provides the service. Register `StationPalletsModule` in `app.module.ts` next to `StationWriteoffsModule`.

- [ ] **Step 7: Run**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/station-pallet-bootstrap.e2e.test.ts test/openapi-coverage.test.ts test/openapi-docs.test.ts`
Expected: PASS (the `canBuildPallets` PATCH in the test's `beforeAll` needs Task 7; run Task 7 first if executing out of order, or set the flag through `app.get(DB)` until then).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/sscc/sscc.service.ts apps/api/src/modules/station-pallets apps/api/src/app.module.ts apps/api/test/station-pallet-bootstrap.e2e.test.ts
git commit -m "feat(api): station pallet bootstrap endpoint"
```

---

### Task 7: Employee permission `canBuildPallets`

**Files:**
- Modify: `apps/api/src/modules/employees/dto.ts:25-30, 69-73, 122-131`
- Modify: `apps/api/src/modules/employees/employees.service.ts:194, 215-231, 391-399`
- Test: `apps/api/test/employees.e2e.test.ts`

**Interfaces:**
- Produces: `employeePickupPolicySchema.canBuildPallets: boolean (default false)`; `EmployeePickupPolicyDto.canBuildPallets`.

- [ ] **Step 1: Write the failing test**

Add to `employees.e2e.test.ts` (using its existing agent/employee setup):

```ts
  it("stores canBuildPallets on the pickup policy and audits the change", async () => {
    const res = await agent
      .patch(`/employees/${employeeId}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 5, canWriteoff: false, canBuildPallets: true })
      .expect(200);
    expect(res.body.pickupPolicy).toMatchObject({ canBuildPallets: true });
    const got = await agent.get(`/employees/${employeeId}`).expect(200);
    expect(got.body.pickupPolicy.canBuildPallets).toBe(true);
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(and(eq(schema.tenantAuditEvents.organizationId, tenantId), eq(schema.tenantAuditEvents.action, "employee.pickup_policy.updated")))
      .orderBy(desc(schema.tenantAuditEvents.createdAt))
      .limit(1);
    expect(audit).toMatchObject({
      actorUserId: userId,
      outcome: "success",
      targetType: "employee",
      targetId: employeeId,
      before: { canBuildPallets: false },
      after: { canBuildPallets: true },
    });
  });

  it("defaults canBuildPallets to false when the client omits it", async () => {
    const res = await agent
      .patch(`/employees/${employeeId}/pickup-policy`)
      .send({ limitMode: "limited", dayLimit: 5, canWriteoff: false })
      .expect(200);
    expect(res.body.pickupPolicy.canBuildPallets).toBe(false);
  });
```

(`db`, `tenantId`, `userId` — reuse however the file already obtains them; if it has no `db`, get it with `app.get(DB)` as `station-writeoffs.e2e.test.ts` does.)

- [ ] **Step 2: Run to see it fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/employees.e2e.test.ts`
Expected: FAIL — `canBuildPallets` undefined.

- [ ] **Step 3: Implement**

`dto.ts`: `employeePickupPolicySchema` gains `canBuildPallets: z.boolean().default(false),`; `EmployeePickupPolicyDto` gains `canBuildPallets: boolean;`; `employeePickupPolicyOpenApiSchema` adds `canBuildPallets: { type: "boolean" }` to properties and to `required`. `employees.service.ts`: `toPickupPolicyDto` returns `canBuildPallets: policy.canBuildPallets`; both bulk updaters pass `canBuildPallets: before.canBuildPallets`. Because the bulk-update response type and the update path use `EmployeePickupPolicyDto`, TypeScript will point at every place that must carry the field. Check `pickup-orders.service.ts` and `device-pairing/secret-response.openapi.ts`: they build their own `canWriteoff`-only types and need no change.

- [ ] **Step 4: Run**

Run: `pnpm --filter @markiro/api exec vitest run test/employees.e2e.test.ts test/employees-dto.test.ts test/employees-controller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/employees/dto.ts apps/api/src/modules/employees/employees.service.ts apps/api/test/employees.e2e.test.ts
git commit -m "feat(api): employee canBuildPallets permission"
```

---

### Task 8: Cabinet pallet list and card

**Files:**
- Modify: `apps/api/src/modules/pallets/dto.ts`, `pallets.service.ts`, `pallets.controller.ts`
- Modify: `apps/api/src/modules/code-search/dto.ts:214-290, 637-700`, `code-search.service.ts:894-1050`
- Test: `apps/api/test/pallets.e2e.test.ts`, `apps/api/test/station-scans-warehouse-pallets.e2e.test.ts` (restore the two `GET /pallets` assertions from Task 4), `apps/api/test/code-search-pallets.e2e.test.ts`

**Interfaces:**
- Produces: `GET /pallets` query `{ shiftId?, kind?, productId?, deviceId?, closedFrom?, closedTo?, limit?, cursor? }`, response `{ items, nextCursor? }`; `PalletDto` gains `kind`, `productId`, `productName`, `deviceName`, `rejectedMembershipCount`; `PalletCardDto` gains `kind`, `rejections[]`, `shiftId: string | null`, and each box gains `shiftId`, `shiftNumber`, `productionDate`.

- [ ] **Step 1: Write the failing tests**

In `pallets.e2e.test.ts` add:

```ts
  it("lists pallets org-wide with kind filter and cursor paging", async () => {
    const page = await agent.get("/pallets").query({ kind: "production", limit: 1 }).expect(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ kind: "production", rejectedMembershipCount: 0, productName: "Cola" });
    if (page.body.nextCursor) {
      const next = await agent.get("/pallets").query({ kind: "production", limit: 1, cursor: page.body.nextCursor }).expect(200);
      expect(next.body.items[0]?.id).not.toBe(page.body.items[0].id);
    }
  });

  it("still 404s a shift outside the tenant and rejects a malformed cursor", async () => {
    await agent.get("/pallets").query({ shiftId: randomUUID() }).expect(404);
    await agent.get("/pallets").query({ cursor: "not-a-cursor" }).expect(400);
  });
```

In the warehouse e2e (Task 4) restore the `GET /pallets?kind=warehouse` assertions and add:

```ts
  it("shows the warehouse pallet card with box origin shifts and rejections", async () => {
    const list = await agent.get("/pallets").query({ kind: "warehouse" }).expect(200);
    const w1 = list.body.items.find((p: { boxCount: number }) => p.boxCount >= 1);
    const card = await agent.get(`/code-search/pallets/${w1.id}`).expect(200);
    expect(card.body).toMatchObject({ kind: "warehouse", shiftId: null, shiftNumber: null, productName: "Cola" });
    expect(card.body.boxes.map((b: { shiftId: string }) => b.shiftId).sort()).toEqual([shiftId, secondShiftId].sort());
    expect(card.body.rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ boxSscc: `00${B4_SSCC}`, reason: "product_mismatch" })]),
    );
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/pallets.e2e.test.ts test/station-scans-warehouse-pallets.e2e.test.ts`
Expected: FAIL — `kind` query rejected / `kind` absent.

- [ ] **Step 3: List DTO**

`pallets/dto.ts`:

```ts
export const listPalletsQuerySchema = z
  .object({
    shiftId: z.string().uuid().optional(),
    kind: z.enum(["production", "warehouse"]).optional(),
    productId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    closedFrom: z.string().datetime().optional(),
    closedTo: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();

export interface PalletListCursor {
  closedAt: string | null;
  id: string;
}

export function encodePalletListCursor(cursor: PalletListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePalletListCursor(raw: string): PalletListCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const cursor = z.object({ closedAt: z.string().datetime().nullable(), id: z.string().uuid() }).strict().parse(parsed);
    if (encodePalletListCursor(cursor) !== raw) throw new Error("non-canonical");
    return cursor;
  } catch {
    throw new BadRequestException("Invalid pallet list cursor");
  }
}
```

`PalletDto` gains `kind: "production" | "warehouse"; productId: string | null; productName: string | null; deviceName: string | null; rejectedMembershipCount: number;` and `ListPalletsResponseDto` gains `nextCursor?: string`. Mirror all of it in `palletOpenApiSchema` / `listPalletsOpenApiSchema` (`required` included).

- [ ] **Step 4: List service**

In `listPallets`: keep the shift 404 only when `query.shiftId` is given. Product comes from `coalesce(pallets.product_id, shifts.product_id)` — add `leftJoin(schema.shifts, …)` on `pallets.shiftId` and `leftJoin(schema.products, and(eq(products.tenantId, pallets.tenantId), eq(products.id, sql\`coalesce(${schema.pallets.productId}, ${schema.shifts.productId})\`)))`; `deviceName` from a `leftJoin(schema.stationDevices …)` on `coalesce(pallets.device_id::text, pallets.terminal_id)` (replace the existing `stationDevices.id::text = pallets.terminal_id` join condition with `sql\`${schema.stationDevices.id}::text = coalesce(${schema.pallets.deviceId}::text, ${schema.pallets.terminalId})\``). `rejectedMembershipCount` is a correlated scalar: `sql<number>\`(select count(*) from pallet_membership_rejections r where r.tenant_id = ${schema.pallets.tenantId} and r.pallet_id = ${schema.pallets.id})\`.mapWith(Number)`. Filters: `kind`, `productId` (against the coalesced product), `deviceId`, `closedFrom/closedTo` on `closedAt`. Ordering stays `closed_at desc nulls first, id asc`; keyset: when a cursor is present, add `or(and(isNull(closedAt), cursor.closedAt === null ? gt(id, cursor.id) : sql\`false\`), cursor.closedAt === null ? isNotNull(closedAt) : or(lt(closedAt, cursor.closedAt), and(eq(closedAt, cursor.closedAt), gt(id, cursor.id))))` — nulls come first, so after a null-cursor page the non-null rows all follow. Select `limit + 1`; if more, set `nextCursor` from the last returned row. Add `groupBy` columns for `shifts.id`, `products.id`.

- [ ] **Step 5: Card**

`code-search/dto.ts` `PalletCardDto`: `shiftId: string | null`, add `kind: "production" | "warehouse"`, `rejections: { boxSscc: string; boxId: string | null; reason: string; winningPalletSscc: string | null; addedAt: Date; recordedAt: Date }[]`; `PalletCardBoxDto` gains `shiftId: string; shiftNumber: string | null; productionDate: string | null`. Update `palletCardOpenApiSchema` (properties and `required`; `shiftId` nullable). In `getPalletCard` select `kind: schema.pallets.kind`, join products on the coalesced product id (as in Step 4), join the device on the coalesced device id; in the box query join `shifts` and select `shiftId`, `numberMonthKey/Seq/createdFrom` (format with `formatShiftNumber`, already imported) and `productionDate: sql<string | null>\`coalesce(${schema.shifts.productionDate}, ${schema.shifts.plannedDate})::text\``; add a fourth query over `palletMembershipRejections` left-joined to `pallets` (winner) for `winningPalletSscc` (format with `formatSsccWithAi`), ordered by `recordedAt`; `boxSscc` is returned AI-00-prefixed like every cabinet SSCC.

- [ ] **Step 6: Run**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/pallets.e2e.test.ts test/station-scans-warehouse-pallets.e2e.test.ts test/code-search-pallets.e2e.test.ts test/openapi-coverage.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/pallets apps/api/src/modules/code-search/dto.ts apps/api/src/modules/code-search/code-search.service.ts apps/api/test/pallets.e2e.test.ts apps/api/test/station-scans-warehouse-pallets.e2e.test.ts
git commit -m "feat(api): org-wide pallet list and warehouse pallet card"
```

---

### Task 9: Per-pallet GIS MT aggregation export

**Files:**
- Create: `packages/domain/src/pallet-exports.ts`; export from `packages/domain/src/index.ts`
- Test: `packages/domain/test/pallet-exports.test.ts`
- Modify: `apps/api/src/modules/shift-exports/dto.ts`, `shift-exports.service.ts`, `shift-export-source.service.ts`, `shift-export-runner.service.ts`, `shift-exports.controller.ts`
- Test: `apps/api/test/pallet-exports.e2e.test.ts`, `apps/api/test/shift-export-runner.test.ts`, `apps/api/test/shift-exports-openapi.test.ts`

**Interfaces:**
- Produces (domain): `PALLET_EXPORT_FORMATS: readonly [{ id: "pallet_xml_gismt_aggregation"; version: 1; label: "[XML][ГИСМТ] Агрегация паллеты"; extension: "xml"; mimeType: "application/xml; charset=utf-8" }]`; `renderPalletAggregationExport(input: { formatId: "pallet_xml_gismt_aggregation"; formatVersion: number; organizationInn: string | null; productName: string; closedDate: string; pallet: { sscc: string; boxSsccs: readonly string[] } }): ShiftExportPart`.
- Produces (API): `POST /pallets/:palletId/exports` body `{ formatId, formatVersion, idempotencyKey }` → `ShiftExportDto` with `shiftId: null, palletId`; `GET /pallets/:palletId/exports`; `GET /pallet-exports/formats`. Retry and download reuse the existing `shift-exports/:exportId/*` routes.

- [ ] **Step 1: Domain test**

`packages/domain/test/pallet-exports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PALLET_EXPORT_FORMATS, renderPalletAggregationExport, ShiftExportDomainError } from "../src/index.js";

const pallet = { sscc: "134600682000000017", boxSsccs: ["034600682000000018", "034600682000000025"] };

describe("pallet aggregation export", () => {
  it("advertises one xml format", () => {
    expect(PALLET_EXPORT_FORMATS.map((f) => f.id)).toEqual(["pallet_xml_gismt_aggregation"]);
  });

  it("renders only the pallet pack_content with sscc children and no cis", () => {
    const part = renderPalletAggregationExport({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      organizationInn: "7701234567",
      productName: "Cola",
      closedDate: "2026-09-17",
      pallet,
    });
    const xml = Buffer.from(part.bytes).toString("utf8");
    expect(xml).toContain("<pack_code>00134600682000000017</pack_code>");
    expect(xml).toContain("<sscc>00034600682000000018</sscc>");
    expect(xml).not.toContain("<cis>");
    expect((xml.match(/<pack_content>/g) ?? []).length).toBe(1);
    expect(part).toMatchObject({ partNumber: 1, codeCount: 0, boxCount: 2, mimeType: "application/xml; charset=utf-8" });
    expect(part.filename).toBe("Cola_2026-09-17_паллета_00134600682000000017_2_коробов.xml");
  });

  it("refuses an empty pallet, a missing INN and an unknown format", () => {
    const base = { formatId: "pallet_xml_gismt_aggregation" as const, formatVersion: 1, organizationInn: "7701234567", productName: "Cola", closedDate: "2026-09-17" };
    expect(() => renderPalletAggregationExport({ ...base, pallet: { sscc: pallet.sscc, boxSsccs: [] } })).toThrow(ShiftExportDomainError);
    expect(() => renderPalletAggregationExport({ ...base, organizationInn: "", pallet })).toThrow(/ORG_INN_MISSING/);
    expect(() => renderPalletAggregationExport({ ...base, formatVersion: 2, pallet })).toThrow(/FORMAT_NOT_FOUND/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @markiro/domain exec vitest run test/pallet-exports.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Domain implementation**

`packages/domain/src/pallet-exports.ts`:

```ts
import { GismtAggregationError, renderGismtAggregationXml } from "./gismt-aggregation.js";
import {
  sanitizeShiftExportFilenameSegment,
  ShiftExportDomainError,
  type ShiftExportPart,
} from "./shift-exports.js";

export type PalletExportFormatId = "pallet_xml_gismt_aggregation";

export interface PalletExportFormatDescriptor {
  id: PalletExportFormatId;
  version: 1;
  label: string;
  extension: "xml";
  mimeType: "application/xml; charset=utf-8";
}

/**
 * One pallet → its box SSCCs, as a GIS MT aggregation document. The boxes'
 * own unit codes are NOT repeated: they were reported by their shifts'
 * aggregation exports, and a second `<cis>` aggregation of the same codes
 * would be a second aggregation (spec §2.6).
 */
export const PALLET_EXPORT_FORMATS = Object.freeze([
  Object.freeze({
    id: "pallet_xml_gismt_aggregation",
    version: 1,
    label: "[XML][ГИСМТ] Агрегация паллеты",
    extension: "xml",
    mimeType: "application/xml; charset=utf-8",
  } as const),
] as const satisfies readonly PalletExportFormatDescriptor[]);

export function getPalletExportFormat(formatId: string, formatVersion: number): PalletExportFormatDescriptor {
  const descriptor = PALLET_EXPORT_FORMATS.find((f) => f.id === formatId && f.version === formatVersion);
  if (!descriptor) throw new ShiftExportDomainError("FORMAT_NOT_FOUND");
  return descriptor;
}

export interface RenderPalletAggregationExportInput {
  formatId: PalletExportFormatId;
  formatVersion: number;
  organizationInn: string | null;
  productName: string;
  /** Civil date the pallet closed, YYYY-MM-DD, for the filename. */
  closedDate: string;
  pallet: { sscc: string; boxSsccs: readonly string[] };
}

export function renderPalletAggregationExport(input: RenderPalletAggregationExportInput): ShiftExportPart {
  const descriptor = getPalletExportFormat(input.formatId, input.formatVersion);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.closedDate)) throw new Error("Invalid closed date");
  if (input.pallet.boxSsccs.length === 0) throw new ShiftExportDomainError("EMPTY_SOURCE");
  const organizationInn = input.organizationInn?.trim() ?? "";
  if (organizationInn === "") throw new ShiftExportDomainError("ORG_INN_MISSING");

  let rendered;
  try {
    rendered = renderGismtAggregationXml({
      organizationInn,
      boxes: [],
      pallets: [{ sscc: input.pallet.sscc, boxSsccs: input.pallet.boxSsccs }],
    });
  } catch (error) {
    if (error instanceof GismtAggregationError) {
      throw new ShiftExportDomainError(error.code === "INVALID_SSCC" ? "INVALID_BOX_SSCC" : error.code);
    }
    throw error;
  }

  const boxCount = input.pallet.boxSsccs.length;
  const productName = sanitizeShiftExportFilenameSegment(input.productName);
  return {
    partNumber: 1,
    physicalLineCount: rendered.physicalLineCount,
    codeCount: 0,
    boxCount,
    filename: `${productName}_${input.closedDate}_паллета_00${input.pallet.sscc}_${boxCount}_коробов.${descriptor.extension}`,
    mimeType: descriptor.mimeType,
    bytes: rendered.bytes,
  };
}
```

Check `GismtAggregationRenderResult` in `gismt-aggregation.ts` for the exact field names (`bytes`, `physicalLineCount`) and adjust; export `sanitizeShiftExportFilenameSegment` and `ShiftExportDomainError` from `shift-exports.ts` if they are not already public (they are exported). Add to `index.ts`:

```ts
export {
  getPalletExportFormat,
  PALLET_EXPORT_FORMATS,
  renderPalletAggregationExport,
} from "./pallet-exports.js";
export type {
  PalletExportFormatDescriptor,
  PalletExportFormatId,
  RenderPalletAggregationExportInput,
} from "./pallet-exports.js";
```

- [ ] **Step 4: Domain gates**

Run: `pnpm --filter @markiro/domain test && pnpm --filter @markiro/domain typecheck && pnpm --filter @markiro/domain lint && pnpm --filter @markiro/domain build`
Expected: PASS.

- [ ] **Step 5: API e2e test**

`apps/api/test/pallet-exports.e2e.test.ts` — boot like `shift-exports-pallets.e2e.test.ts` (it already builds a closed pallet through `/station/scans` and runs the export job inline; copy its runner invocation), then:

```ts
  it("queues, runs and audits a per-pallet export", async () => {
    await agent.put("/org/profile").send({ inn: "7701234567" }).expect(200); // if the profile route needs more fields, copy the body shift-exports.e2e uses
    const created = await agent
      .post(`/pallets/${palletId}/exports`)
      .send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: randomUUID() })
      .expect(201);
    expect(created.body).toMatchObject({ shiftId: null, palletId, formatId: "pallet_xml_gismt_aggregation", status: "queued" });
    await runner.run(created.body.id, { retryCount: 0, retryLimit: 3 });
    const list = await agent.get(`/pallets/${palletId}/exports`).expect(200);
    expect(list.body[0]).toMatchObject({ status: "ready", totalBoxCount: 2, totalCodeCount: 0 });
    const xml = await downloadArtifact(list.body[0].artifacts[0]); // helper from shift-exports.e2e
    expect(xml).not.toContain("<cis>");
    expect(xml).toContain(`<pack_code>${palletSsccWithAi}</pack_code>`);
    const audits = await db.select().from(schema.tenantAuditEvents).where(and(eq(schema.tenantAuditEvents.organizationId, tenantId), eq(schema.tenantAuditEvents.targetId, created.body.id)));
    expect(audits.map((a) => a.action).sort()).toEqual(["pallet_export.completed", "pallet_export.created"]);
    expect(audits.find((a) => a.action === "pallet_export.created")).toMatchObject({ actorUserId: userId, outcome: "success", targetType: "shift_export", after: expect.objectContaining({ palletId, formatId: "pallet_xml_gismt_aggregation" }) });
  });

  it("refuses an open or disassembled pallet and a pallet of another tenant", async () => {
    await agent.post(`/pallets/${openPalletId}/exports`).send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: randomUUID() }).expect(409);
    await otherAgent.post(`/pallets/${palletId}/exports`).send({ formatId: "pallet_xml_gismt_aggregation", formatVersion: 1, idempotencyKey: randomUUID() }).expect(404);
    await agent.get(`/pallet-exports/formats`).expect(200).expect((r) => expect(r.body.map((f: { id: string }) => f.id)).toEqual(["pallet_xml_gismt_aggregation"]));
  });
```

- [ ] **Step 6: Run to see it fail**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/pallet-exports.e2e.test.ts`
Expected: FAIL — 404 on `POST /pallets/:id/exports`.

- [ ] **Step 7: API DTO and controller**

`shift-exports/dto.ts`: add

```ts
export const createPalletExportSchema = z.strictObject({
  formatId: z.enum(["pallet_xml_gismt_aggregation"]),
  formatVersion: z.number().int().min(1),
  idempotencyKey: z.uuid(),
});
export type CreatePalletExportDto = z.infer<typeof createPalletExportSchema>;
```

change `ShiftExportDto.shiftId` to `string | null` and add `palletId: string | null`; extend `shiftExportOpenApiSchema` (`shiftId` nullable, `palletId` nullable uuid, both required), add `createPalletExportOpenApiSchema` and `palletExportFormatOpenApiSchema` (same shape as the shift format schema without `boxMode`). Update `shift-exports-openapi.test.ts` expectations for the new fields.

Controller: add

```ts
  @Get("pallet-exports/formats")
  @ApiOperation({ summary: "List pallet export formats" })
  @ApiOkResponse({ schema: { type: "array", items: palletExportFormatOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  palletFormats(): readonly PalletExportFormatDescriptor[] {
    return this.exports.palletFormats();
  }

  @Post("pallets/:palletId/exports")
  @AllowSubscriptionReadOnly("export")
  @ApiOperation({
    summary: "Create a pallet export",
    description: "Queues a GIS MT aggregation of the pallet's box SSCCs (no unit codes); idempotent per idempotencyKey.",
  })
  @ApiParam({ name: "palletId", format: "uuid", type: "string" })
  @ApiBody({ schema: createPalletExportOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftExportOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  createPalletExport(
    @Req() req: SessionRequest,
    @Param("palletId", new ParseUUIDPipe()) palletId: string,
    @Body(new ZodValidationPipe(createPalletExportSchema)) body: CreatePalletExportDto,
  ): Promise<ShiftExportDto> {
    return this.exports.createForPallet(req.tenantId, req.userId, palletId, body);
  }

  @Get("pallets/:palletId/exports")
  @ApiOperation({ summary: "List exports for a pallet" })
  @ApiParam({ name: "palletId", format: "uuid", type: "string" })
  @ApiOkResponse({ schema: { type: "array", items: shiftExportOpenApiSchema } })
  @ApiHttpErrors(401, 403)
  listPalletExports(@Req() req: SessionRequest, @Param("palletId", new ParseUUIDPipe()) palletId: string): Promise<ShiftExportDto[]> {
    return this.exports.listForPallet(req.tenantId, palletId);
  }
```

- [ ] **Step 8: Service**

`shift-exports.service.ts`:

- `palletFormats()` returns `PALLET_EXPORT_FORMATS`.
- `createForPallet(tenantId, actorUserId, palletId, input)`: verify the format is advertised in `PALLET_EXPORT_FORMATS`; inside a transaction select the pallet (`id, closedAt, disassembledAt`) tenant-scoped → `NotFoundException` if absent, `ConflictException("Pallet must be closed")` if `closedAt` null, `ConflictException("Pallet is disassembled")` if `disassembledAt` set; insert with `shiftId: null, palletId, maxLines: null`; `writeAudit(tx, created, actorUserId, "pallet_export.created", "success", { status: "queued" })`. Idempotency conflict handling is the same as `create` with `existing.palletId !== palletId` in the mismatch check. Then `enqueueOrFail` and `getById`.
- `listForPallet(tenantId, palletId)` → `listedRows(and(eq(tenantId), eq(palletId)))`.
- `listedRows`: change the `shifts` `innerJoin` to `leftJoin` (a pallet export has no shift); `lateDataAt` becomes nullable already.
- `toDtos`: emit `shiftId: row.shiftId, palletId: row.palletId`.
- `writeAudit`: choose the action prefix from the row — when `row.palletId !== null` replace the leading `shift_export.` with `pallet_export.` and put `palletId` in `after`. Do the same in the runner's `writeAudit` (both write `targetType: "shift_export"`; keep that — it is the table's name).

`shift-export-source.service.ts`: add

```ts
  loadPallet(tenantId: string, palletId: string): Promise<PalletExportSnapshot> {
    return this.db.transaction(async (tx) => {
      const [pallet] = await tx
        .select({
          sscc: schema.pallets.sscc,
          closedAt: schema.pallets.closedAt,
          disassembledAt: schema.pallets.disassembledAt,
          productName: sql<string | null>`coalesce(${schema.products.name}, ${shiftProducts.name})`,
        })
        .from(schema.pallets)
        .leftJoin(schema.products, and(eq(schema.products.tenantId, schema.pallets.tenantId), eq(schema.products.id, schema.pallets.productId)))
        .leftJoin(schema.shifts, and(eq(schema.shifts.tenantId, schema.pallets.tenantId), eq(schema.shifts.id, schema.pallets.shiftId)))
        .leftJoin(shiftProducts, and(eq(shiftProducts.tenantId, schema.shifts.tenantId), eq(shiftProducts.id, schema.shifts.productId)))
        .where(and(eq(schema.pallets.tenantId, tenantId), eq(schema.pallets.id, palletId)));
      if (!pallet || pallet.sscc === null || pallet.closedAt === null) throw new ShiftExportSourceError("PALLET_NOT_CLOSED");
      if (pallet.disassembledAt !== null) throw new ShiftExportSourceError("PALLET_DISASSEMBLED");
      const boxes = await tx
        .select({ sscc: schema.boxes.sscc })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.palletId, palletId), isNotNull(schema.boxes.closedAt), isNull(schema.boxes.disassembledAt)))
        .orderBy(schema.boxes.closedAt, schema.boxes.id);
      const [inn] = await tx.select({ inn: schema.orgProfiles.inn }).from(schema.orgProfiles).where(eq(schema.orgProfiles.tenantId, tenantId));
      return {
        sourceSnapshotStartedAt: new Date(),
        productName: pallet.productName ?? "продукция",
        closedDate: pallet.closedAt.toISOString().slice(0, 10),
        organizationInn: inn?.inn ?? null,
        pallet: { sscc: pallet.sscc, boxSsccs: boxes.flatMap((b) => (b.sscc === null ? [] : [b.sscc])) },
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
```

with `const shiftProducts = alias(schema.products, "shift_products")` (`alias` from `drizzle-orm/pg-core`) and `PalletExportSnapshot { sourceSnapshotStartedAt; productName; closedDate; organizationInn; pallet }`. Add `"PALLET_NOT_CLOSED"` and `"PALLET_DISASSEMBLED"` to `ShiftExportSourceErrorCode` (shift-export-source.service.ts:11-17) and to `SHIFT_EXPORT_SAFE_ERROR_CODES` (shift-export-runner.service.ts:15-31) so `safeDomainErrorCode` publishes them as a safe failure; `shift_exports.error_code` is plain text, so no migration is needed. Add the two codes to whatever admin-facing error-code enum the OpenAPI schema of `shiftExportOpenApiSchema.errorCode` lists, if it enumerates them. Verify the org profile INN column name in `packages/db/src/schema/org-profile.ts` (the shift source already reads it — copy that select).

`shift-export-runner.service.ts` `run`: branch after `claim`:

```ts
      if (claimed.palletId !== null) {
        const snapshot = await this.source.loadPallet(claimed.tenantId, claimed.palletId);
        // snapshot columns: productNameSnapshot + shiftDateSnapshot (closed date) — same UPDATE as the shift path
        const part = renderPalletAggregationExport({
          formatId: "pallet_xml_gismt_aggregation",
          formatVersion: claimed.formatVersion,
          organizationInn: snapshot.organizationInn,
          productName: snapshot.productName,
          closedDate: snapshot.closedDate,
          pallet: snapshot.pallet,
        });
        parts = [part];
      } else { /* existing shift path */ }
```

Restructure so `parts` feeds the existing upload/publish loop unchanged (`openPalletSuppressedBoxCount` is `0` for a pallet export). The `formatId` literal is safe because `createPalletExportSchema` only admits that id; guard with `getPalletExportFormat(claimed.formatId, claimed.formatVersion)` first so a corrupted row fails as `FORMAT_NOT_FOUND`.

- [ ] **Step 9: Runner unit test**

Add to `apps/api/test/shift-export-runner.test.ts` one case: a claimed row with `palletId` set makes the runner call `source.loadPallet` (mock) and upload exactly one artifact whose `codeCount` is 0 and `boxCount` equals the mocked `boxSsccs.length`; follow the file's existing mocking style for `source`, `storage` and `db`.

- [ ] **Step 10: Run**

Run: `pnpm --filter @markiro/domain build && set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/pallet-exports.e2e.test.ts test/shift-exports.e2e.test.ts test/shift-exports-pallets.e2e.test.ts test/shift-export-runner.test.ts test/shift-export-source.test.ts test/shift-exports-openapi.test.ts test/jobs-shift-exports.test.ts test/openapi-coverage.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/domain/src/pallet-exports.ts packages/domain/src/index.ts packages/domain/test/pallet-exports.test.ts apps/api/src/modules/shift-exports apps/api/test/pallet-exports.e2e.test.ts apps/api/test/shift-export-runner.test.ts apps/api/test/shift-exports-openapi.test.ts
git commit -m "feat: per-pallet GIS MT aggregation export"
```

---

### Task 10: Full gates and spec sync

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md` (§2.5 audit action name → `pallet_export.created`; §2.5 card → served by `GET /code-search/pallets/:id`; §1.3 drop the redundant index sentence — `pallet_exceptions_tenant_pallet_idx` already exists)

- [ ] **Step 1: Update the three spec lines above**

- [ ] **Step 2: Run the wide gates**

Run: `set -a; source .env; set +a; pnpm turbo lint typecheck test build --filter=@markiro/domain --filter=@markiro/db --filter=@markiro/api --concurrency=1 --force && pnpm format:check && git diff --check`
Expected: PASS. Record any `describe.skipIf` skips (missing `DATABASE_URL`/auth env) explicitly in the report.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-17-warehouse-pallet-aggregation-design.md
git commit -m "docs: align warehouse pallet spec with server implementation"
```

---

## Self-review against the spec

- §1.1 pallets → Task 2. §1.2 overwrite rule → Task 4 UPDATE predicate. §1.3 → Task 2 (index dropped as redundant, spec updated in Task 10). §1.4 → Task 2 + Task 4. §1.5 → Task 2 + Task 7.
- §2.1 bootstrap → Task 6. §2.2 DTO → Task 3. §2.3 ingest order, pre-pass, registry bumps (membership, warehouse closure, disassembly on both paths) → Tasks 4 and 5. §2.4 registry → Task 5. §2.5 list/card/export/employee → Tasks 8, 9, 7; the org-profile pallet-template picker is UI work for plan 3 (the API already exists). §2.6 renderer → Task 9.
- §5 legacy batches → existing suites in Task 4 Step 7; race → Task 4 test; replay → Task 4 test; read-only → Task 4 Step 6 (denied + quarantine + `subscription_read_only` outcome).
- §6 API tests: cross-tenant on bootstrap (Task 6), memberships (Task 4), list/card (Tasks 4, 8), export (Task 9), employee flag (existing employees suite covers tenant scoping of the route); exact audit on export (Task 9) and on disassembly (existing disaggregation suite; Task 5 adds the registry assertion); statuses incl. `replayed` (Task 4); two-device race (Task 4); registry bump three ways (Tasks 4, 5); XML sscc-only (Task 9); bootstrap degrade (Task 6).
