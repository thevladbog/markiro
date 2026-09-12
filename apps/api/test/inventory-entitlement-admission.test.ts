import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Test } from "@nestjs/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDb, schema, type Db } from "@markiro/db";
import { INVENTORY_CHZ_STATUSES } from "@markiro/domain";

import { DB } from "../src/auth/auth.module";
import { InventoriesService } from "../src/modules/inventories/inventories.service";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";
import { InventorySnapshotService } from "../src/modules/inventories/inventory-snapshot.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import { admissionScopeDigest } from "../src/subscriptions/entitlement-admission.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
afterAll(() => connection.pool.end());

describe.skipIf(!process.env.DATABASE_URL)("inventory entitlement admission owners", () => {
  async function fixture(options: { grantInventory?: boolean } = {}) {
    const planVersionId = await createPublishedPlan(connection.db, {
      maxLines: 10,
      maxStations: 10,
      maxKiosks: 10,
      maxCabinetUsers: 10,
    });
    const managed = await createManagedSubscription(connection.db, { planVersionId });
    const actorUserId = randomUUID();
    await connection.db.insert(schema.user).values({
      id: actorUserId,
      name: "Inventory owner",
      email: `${actorUserId}@example.invalid`,
    });
    const platformUserId = randomUUID();
    await connection.db.insert(schema.platformUsers).values({
      id: platformUserId,
      email: `${platformUserId}@example.invalid`,
      name: "Inventory admission fixture",
      role: "platform_admin",
      status: "active",
    });
    const sourceId = randomUUID();
    if (options.grantInventory !== false)
      await connection.db.insert(schema.entitlementSources).values({
        id: sourceId,
        versionId: sourceId,
        tenantId: managed.tenantId,
        subscriptionId: managed.subscriptionId,
        kind: "compatibility",
        effects: [{ key: "inventory", featureEnabled: true }],
        operationIds: [
          "inventory.task.create.v1",
          "inventory.file.create.v1",
          "inventory.task.start.v1",
        ],
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 600_000),
        reason: "Inventory shadow fixture",
        decisionReference: "P1B3-TEST",
        requestId: randomUUID(),
        createdByPlatformUserId: platformUserId,
      });
    const productId = randomUUID();
    const lineId = randomUUID();
    await connection.db.insert(schema.products).values({
      id: productId,
      tenantId: managed.tenantId,
      gtin14: "04680089900383",
      name: "Admission inventory product",
      status: "active",
    });
    await connection.db
      .insert(schema.lines)
      .values({ id: lineId, tenantId: managed.tenantId, name: "Admission inventory line" });

    const objects = new Map<string, Buffer>();
    const storage = {
      putVerified: vi.fn(async (key: string, bytes: Buffer, _mime: string, sha256: string) => {
        objects.set(key, Buffer.from(bytes));
        return { byteSize: bytes.byteLength, sha256 };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
    const entitlements = new EntitlementsService(connection.db, "managed_only");
    const module = await Test.createTestingModule({
      providers: [
        { provide: DB, useValue: connection.db },
        { provide: ObjectStorageService, useValue: storage },
        { provide: InventorySnapshotService, useValue: {} },
        { provide: EntitlementsService, useValue: entitlements },
        EntitlementAdmissionService,
        InventoriesService,
        InventoryLifecycleService,
      ],
    }).compile();
    return {
      ...managed,
      actorUserId,
      productId,
      lineId,
      inventories: module.get(InventoriesService),
      lifecycle: module.get(InventoryLifecycleService),
      admission: module.get(EntitlementAdmissionService),
      storage,
    };
  }

  const createInput = (productId: string, lineId: string) => ({
    productId,
    lineId,
    mode: "check" as const,
    productionDateFrom: "2026-08-01",
    productionDateTo: "2026-08-31",
    boxLabelTemplateId: null,
  });

  async function observations(db: Db, tenantId: string) {
    return db
      .select()
      .from(schema.entitlementShadowObservations)
      .where(eq(schema.entitlementShadowObservations.tenantId, tenantId));
  }

  it("observes each new inventory effect once and replays import and start bytes", async () => {
    const f = await fixture();
    const created = await f.inventories.create(
      f.tenantId,
      f.actorUserId,
      createInput(f.productId, f.lineId),
    );
    const createObservation = (await observations(connection.db, f.tenantId)).at(-1);
    expect(createObservation).toMatchObject({
      tenantId: f.tenantId,
      actorType: "cabinet",
      actorId: f.actorUserId,
      operationId: "inventory.task.create.v1",
      outcome: "allow",
      resourceScope: {
        digest: admissionScopeDigest({
          inventoryId: created.id,
          productId: f.productId,
          lineId: f.lineId,
          mode: "check",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
          boxLabelTemplateId: null,
        }),
      },
    });

    const bytes = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"));
    const imported = await f.inventories.importEvidence(
      f.tenantId,
      f.actorUserId,
      created.id,
      "INTRODUCED",
      { originalName: "introduced.csv", mimeType: "text/csv", bytes },
    );
    const replayedImport = await f.inventories.importEvidence(
      f.tenantId,
      f.actorUserId,
      created.id,
      "INTRODUCED",
      { originalName: "introduced.csv", mimeType: "text/csv", bytes },
    );
    expect(replayedImport).toEqual(imported);
    expect((await observations(connection.db, f.tenantId)).at(-1)).toMatchObject({
      operationId: "inventory.file.create.v1",
      resourceScope: {
        digest: admissionScopeDigest({
          inventoryId: created.id,
          declaredStatus: "INTRODUCED",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          parseOutcome: "succeeded",
          parsedStatus: "INTRODUCED",
          includedGtin14: "04680089900383",
        }),
      },
    });

    const imports = INVENTORY_CHZ_STATUSES.map((status, index) => ({
      id: status === "INTRODUCED" ? imported.id : randomUUID(),
      tenantId: f.tenantId,
      inventoryId: created.id,
      declaredStatus: status,
      fileName: `${status.toLowerCase()}.csv`,
      containerKind: "csv" as const,
      byteSize: 1,
      sha256:
        status === "INTRODUCED"
          ? createHash("sha256").update(bytes).digest("hex")
          : index.toString(16).padStart(64, "0"),
      objectKey: `private/${created.id}/${status}`,
      parsedStatus: status,
      includedGtin14: "04680089900383",
      parseOutcome: "succeeded" as const,
      rowCount: status === "INTRODUCED" ? imported.rowCount : 0,
      errorCount: 0,
      duplicateCount: 0,
      createdByUserId: f.actorUserId,
    }));
    await connection.db
      .insert(schema.inventoryImports)
      .values(imports.filter((row) => row.declaredStatus !== "INTRODUCED"));
    const [snapshot] = await connection.db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId: f.tenantId,
        inventoryId: created.id,
        revision: 1,
        combinedDigest: "a".repeat(64),
        productName: "Admission inventory product",
        lineName: "Admission inventory line",
        boxCapacity: 1,
        emittedCount: 0,
        introducedCount: 0,
        appliedCount: 0,
        retiredCount: 0,
        writtenOffCount: 0,
        disaggregationCount: 0,
        protectedCount: 0,
        expectedCount: 0,
        packageCount: 0,
        looseCount: 0,
        fixedByUserId: f.actorUserId,
      })
      .returning({ id: schema.inventorySnapshots.id });
    if (!snapshot) throw new Error("Expected snapshot fixture");
    await connection.db.insert(schema.inventorySnapshotInputs).values(
      imports.map((row) => ({
        tenantId: f.tenantId,
        snapshotId: snapshot.id,
        inventoryId: created.id,
        status: row.declaredStatus,
        importId: row.id,
        importParseOutcome: "succeeded" as const,
      })),
    );
    await connection.db
      .update(schema.inventories)
      .set({ status: "ready", activeSnapshotId: snapshot.id })
      .where(
        and(eq(schema.inventories.tenantId, f.tenantId), eq(schema.inventories.id, created.id)),
      );
    const manifest = await f.lifecycle.start(f.tenantId, f.actorUserId, created.id);
    expect(await f.lifecycle.start(f.tenantId, f.actorUserId, created.id)).toEqual(manifest);

    const rows = await observations(connection.db, f.tenantId);
    expect(rows.map((row) => row.operationId)).toEqual([
      "inventory.task.create.v1",
      "inventory.file.create.v1",
      "inventory.task.start.v1",
    ]);
    expect(rows.every((row) => row.registryVersion === "p1b.v1")).toBe(true);
    expect(rows.at(-1)).toMatchObject({
      resourceScope: {
        digest: admissionScopeDigest({
          inventoryId: created.id,
          snapshotId: snapshot.id,
          snapshotRevision: 1,
          combinedDigest: "a".repeat(64),
        }),
      },
    });
    const [stored] = await connection.db
      .select()
      .from(schema.inventories)
      .where(eq(schema.inventories.id, created.id));
    expect(stored).toMatchObject({
      createdByUserId: f.actorUserId,
      startedByUserId: f.actorUserId,
      status: "running",
      stationManifest: manifest,
    });
    const audits = await connection.db
      .select({
        organizationId: schema.tenantAuditEvents.organizationId,
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        before: schema.tenantAuditEvents.before,
        after: schema.tenantAuditEvents.after,
        requestId: schema.tenantAuditEvents.requestId,
      })
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, f.tenantId));
    expect(audits).toEqual([
      {
        organizationId: f.tenantId,
        actorUserId: f.actorUserId,
        action: "inventory.created",
        outcome: "success",
        targetType: "inventory",
        targetId: created.id,
        before: null,
        requestId: null,
        after: {
          tenantId: f.tenantId,
          actorUserId: f.actorUserId,
          inventoryId: created.id,
          number: created.number,
          productId: f.productId,
          gtin14: "04680089900383",
          lineId: f.lineId,
          mode: "check",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
          boxLabelTemplateId: null,
        },
      },
      {
        organizationId: f.tenantId,
        actorUserId: f.actorUserId,
        action: "inventory.import.processed",
        outcome: "success",
        targetType: "inventory_import",
        targetId: imported.id,
        before: null,
        requestId: null,
        after: {
          tenantId: f.tenantId,
          actorUserId: f.actorUserId,
          inventoryId: created.id,
          importId: imported.id,
          result: "succeeded",
          declaredStatus: "INTRODUCED",
          parsedStatus: "INTRODUCED",
          includedGtin14: "04680089900383",
          rowCount: imported.rowCount,
          errorCount: 0,
          duplicateCount: imported.duplicateCount,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
      {
        organizationId: f.tenantId,
        actorUserId: f.actorUserId,
        action: "inventory.started",
        outcome: "success",
        targetType: "inventory",
        targetId: created.id,
        before: null,
        requestId: null,
        after: {
          tenantId: f.tenantId,
          actorUserId: f.actorUserId,
          inventoryId: created.id,
          snapshotId: snapshot.id,
          snapshotRevision: 1,
          combinedDigest: "a".repeat(64),
          counts: {
            emitted: 0,
            introduced: 0,
            applied: 0,
            retired: 0,
            writtenOff: 0,
            disaggregation: 0,
            protected: 0,
            expected: 0,
            packages: 0,
            loose: 0,
          },
          productId: f.productId,
          productName: "Admission inventory product",
          gtin14: "04680089900383",
          boxCapacity: 1,
          lineId: f.lineId,
          lineName: "Admission inventory line",
          mode: "check",
        },
      },
    ]);
  });

  it("rejects malformed and foreign-tenant creation before any effect", async () => {
    const f = await fixture();
    const foreign = await fixture();
    await expect(
      f.inventories.create(f.tenantId, f.actorUserId, {
        ...createInput(f.productId, f.lineId),
        productionDateFrom: "2026-09-01",
        productionDateTo: "2026-08-01",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.inventories.create(
        foreign.tenantId,
        foreign.actorUserId,
        createInput(f.productId, f.lineId),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await observations(connection.db, f.tenantId)).toEqual([]);
    expect(await observations(connection.db, foreign.tenantId)).toEqual([]);
  });

  it("keeps current business success for disabled, stale, and failed shadow evaluation", async () => {
    const disabled = await fixture({ grantInventory: false });
    const disabledCreated = await disabled.inventories.create(
      disabled.tenantId,
      disabled.actorUserId,
      createInput(disabled.productId, disabled.lineId),
    );
    expect(disabledCreated.id).toEqual(expect.any(String));
    expect((await observations(connection.db, disabled.tenantId)).at(-1)?.outcome).not.toBe(
      "allow",
    );

    const stale = await fixture();
    const capture = stale.admission.capture.bind(stale.admission);
    vi.spyOn(stale.admission, "capture").mockImplementationOnce(async (tenantId) => {
      const facts = await capture(tenantId);
      await connection.db.insert(schema.lines).values({ tenantId, name: "Proof drift" });
      return facts;
    });
    const staleCreated = await stale.inventories.create(
      stale.tenantId,
      stale.actorUserId,
      createInput(stale.productId, stale.lineId),
    );
    expect(staleCreated.id).toEqual(expect.any(String));
    expect((await observations(connection.db, stale.tenantId)).at(-1)).toMatchObject({
      outcome: "unknown",
      reasonCodes: ["shadow_snapshot_stale"],
    });

    const failed = await fixture();
    const functionName = `test_shadow_fail_${randomUUID().replaceAll("-", "")}`;
    await connection.db.execute(
      sql.raw(
        `create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception 'synthetic shadow failure'; end $$`,
      ),
    );
    await connection.db.execute(
      sql.raw(
        `create trigger ${functionName} before insert on entitlement_shadow_observations for each row execute function ${functionName}()`,
      ),
    );
    try {
      const created = await failed.inventories.create(
        failed.tenantId,
        failed.actorUserId,
        createInput(failed.productId, failed.lineId),
      );
      expect(created.id).toEqual(expect.any(String));
      expect(await observations(connection.db, failed.tenantId)).toEqual([]);
    } finally {
      await connection.db.execute(
        sql.raw(`drop trigger ${functionName} on entitlement_shadow_observations`),
      );
      await connection.db.execute(sql.raw(`drop function ${functionName}()`));
    }
  });
});
