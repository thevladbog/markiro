import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import { INVENTORY_CHZ_STATUSES, type LabelTemplateSpec } from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { setOnlyOrganizationMemberRole, signUpAndActivate } from "./support/auth";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const GTIN14 = "04680089900383";
const SNAPSHOT_DIGEST = "a".repeat(64);
const BOX_LABEL_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      id: "sscc",
      kind: "barcode",
      xMm: 4,
      yMm: 12,
      format: "code128",
      data: "sscc",
      sizeMm: 18,
      moduleWidthMm: 0.25,
    },
  ],
} satisfies LabelTemplateSpec;

const BOX_LABEL_SPEC_V2 = {
  ...BOX_LABEL_SPEC,
  elements: BOX_LABEL_SPEC.elements.map((element) => ({ ...element, xMm: 9 })),
} satisfies LabelTemplateSpec;

type Agent = ReturnType<typeof request.agent>;

interface ReadyInventoryFixture {
  tenantId: string;
  actorUserId: string;
  inventoryId: string;
  inventoryNumber: string;
  productId: string;
  lineId: string;
  snapshotId: string;
  templateId: string | null;
}

interface MutableStoredManifest {
  productionDateFrom: string;
  productionDateTo: string;
  boxLabelTemplate: {
    spec: { elements: Array<Record<string, unknown>> };
  } | null;
}

const snapshotCounts = {
  emitted: 2,
  introduced: 3,
  applied: 0,
  retired: 4,
  writtenOff: 1,
  disaggregation: 0,
  protected: 1,
  expected: 2,
  packages: 1,
  loose: 2,
} as const;

describe.skipIf(!ready)("inventory ready/start lifecycle e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function actorUserId(tenantId: string): Promise<string> {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory actor fixture");
    return member.userId;
  }

  async function setDefaultTemplate(tenantId: string, templateId: string | null): Promise<void> {
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, defaultBoxLabelTemplateId: templateId })
      .onConflictDoUpdate({
        target: schema.orgProfiles.tenantId,
        set: { defaultBoxLabelTemplateId: templateId, updatedAt: new Date() },
      });
  }

  async function seedTemplate(tenantId: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id,
      tenantId,
      name,
      spec: BOX_LABEL_SPEC,
    });
    return id;
  }

  async function seedReadyInventory(
    agent: Agent,
    mode: "check" | "repack" = "check",
  ): Promise<ReadyInventoryFixture> {
    const tenantId = await signUpAndActivate(agent);
    const actorId = await actorUserId(tenantId);
    const productId = randomUUID();
    const lineId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN14,
      name: "Inventory Water",
      status: "active",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Inventory line" });

    const templateId = mode === "repack" ? await seedTemplate(tenantId, "Frozen box label") : null;
    if (templateId !== null) await setDefaultTemplate(tenantId, templateId);

    const created = await agent
      .post("/inventories")
      .send({
        productId,
        lineId,
        mode,
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
        boxLabelTemplateId: templateId,
      })
      .expect(201);
    const inventoryId = created.body.id as string;

    const imports = INVENTORY_CHZ_STATUSES.map((status, index) => ({
      id: randomUUID(),
      tenantId,
      inventoryId,
      declaredStatus: status,
      fileName: `${status.toLowerCase()}.csv`,
      containerKind: "csv" as const,
      byteSize: 1,
      sha256: index.toString(16).padStart(64, "0"),
      objectKey: `private/${inventoryId}/${status}`,
      parsedStatus: status,
      includedGtin14: GTIN14,
      parseOutcome: "succeeded" as const,
      rowCount: [2, 3, 0, 4, 1, 0][index]!,
      errorCount: 0,
      duplicateCount: 0,
      createdByUserId: actorId,
    }));
    await db.insert(schema.inventoryImports).values(imports);
    const [snapshot] = await db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId,
        inventoryId,
        revision: 1,
        combinedDigest: SNAPSHOT_DIGEST,
        emittedCount: snapshotCounts.emitted,
        introducedCount: snapshotCounts.introduced,
        appliedCount: snapshotCounts.applied,
        retiredCount: snapshotCounts.retired,
        writtenOffCount: snapshotCounts.writtenOff,
        disaggregationCount: snapshotCounts.disaggregation,
        protectedCount: snapshotCounts.protected,
        expectedCount: snapshotCounts.expected,
        packageCount: snapshotCounts.packages,
        looseCount: snapshotCounts.loose,
        fixedByUserId: actorId,
      })
      .returning({ id: schema.inventorySnapshots.id });
    if (!snapshot) throw new Error("Expected snapshot fixture");
    await db.insert(schema.inventorySnapshotInputs).values(
      imports.map((input) => ({
        tenantId,
        snapshotId: snapshot.id,
        inventoryId,
        status: input.declaredStatus,
        importId: input.id,
        importParseOutcome: "succeeded" as const,
      })),
    );
    await db
      .update(schema.inventories)
      .set({ status: "ready", activeSnapshotId: snapshot.id, updatedAt: new Date() })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );

    return {
      tenantId,
      actorUserId: actorId,
      inventoryId,
      inventoryNumber: created.body.number as string,
      productId,
      lineId,
      snapshotId: snapshot.id,
      templateId,
    };
  }

  async function overwriteStoredManifest(
    fixture: ReadyInventoryFixture,
    manifest: unknown,
  ): Promise<void> {
    await db.execute(sql`
      update inventories
      set station_manifest = ${JSON.stringify(manifest)}::jsonb
      where tenant_id = ${fixture.tenantId} and id = ${fixture.inventoryId}
    `);
  }

  async function expectStoredManifestRejected(
    agent: Agent,
    fixture: ReadyInventoryFixture,
    manifest: unknown,
  ): Promise<void> {
    await overwriteStoredManifest(fixture, manifest);
    const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(409);
    expect(response.body).toEqual({ code: "INVENTORY_STORED_MANIFEST_INVALID" });
    expect(JSON.stringify(response.body)).not.toContain("manifest-secret");
  }

  it("transitions ready check inventory once and returns the frozen sanitized manifest with an exact durable audit", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);

    const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(response.body).toEqual({
      inventoryId: fixture.inventoryId,
      inventoryNumber: fixture.inventoryNumber,
      snapshotId: fixture.snapshotId,
      snapshotRevision: 1,
      combinedDigest: SNAPSHOT_DIGEST,
      codeCount: 10,
      productId: fixture.productId,
      productName: "Inventory Water",
      gtin14: GTIN14,
      mode: "check",
      lineId: fixture.lineId,
      lineName: "Inventory line",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplate: null,
      limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /actor|startedBy|objectKey|fileName|canonical|raw|credential|pin|badge|kmList/i,
    );

    const [stored] = await db
      .select({
        status: schema.inventories.status,
        stationManifest: schema.inventories.stationManifest,
        startedByUserId: schema.inventories.startedByUserId,
        startedAt: schema.inventories.startedAt,
      })
      .from(schema.inventories)
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, fixture.inventoryId),
        ),
      );
    expect(stored).toEqual({
      status: "running",
      stationManifest: response.body,
      startedByUserId: fixture.actorUserId,
      startedAt: expect.any(Date),
    });

    const audits = await db
      .select({
        organizationId: schema.tenantAuditEvents.organizationId,
        actorUserId: schema.tenantAuditEvents.actorUserId,
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        targetType: schema.tenantAuditEvents.targetType,
        targetId: schema.tenantAuditEvents.targetId,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.started"),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
        ),
      );
    expect(audits).toEqual([
      {
        organizationId: fixture.tenantId,
        actorUserId: fixture.actorUserId,
        action: "inventory.started",
        outcome: "success",
        targetType: "inventory",
        targetId: fixture.inventoryId,
        after: {
          tenantId: fixture.tenantId,
          actorUserId: fixture.actorUserId,
          inventoryId: fixture.inventoryId,
          snapshotId: fixture.snapshotId,
          snapshotRevision: 1,
          combinedDigest: SNAPSHOT_DIGEST,
          counts: snapshotCounts,
          productId: fixture.productId,
          productName: "Inventory Water",
          gtin14: GTIN14,
          lineId: fixture.lineId,
          lineName: "Inventory line",
          mode: "check",
        },
      },
    ]);
  });

  it("returns the inventory-resolved repack print model after the tenant default changes", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    const replacement = await seedTemplate(fixture.tenantId, "Replacement default");
    await setDefaultTemplate(fixture.tenantId, replacement);

    const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(response.body.boxLabelTemplate).toEqual({
      id: fixture.templateId,
      name: "Frozen box label",
      spec: BOX_LABEL_SPEC,
    });
    expect(response.body.boxLabelTemplate.id).not.toBe(replacement);
  });

  it("makes duplicate and concurrent starts idempotent without changing started fields or duplicating the success audit", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");

    const [first, second] = await Promise.all([
      agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201),
      agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201),
    ]);
    expect(second.body).toEqual(first.body);
    const [afterRace] = await db
      .select({
        startedByUserId: schema.inventories.startedByUserId,
        startedAt: schema.inventories.startedAt,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));

    await agent
      .patch(`/label-templates/${fixture.templateId!}`)
      .send({ spec: BOX_LABEL_SPEC_V2 })
      .expect(200);

    const duplicate = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(duplicate.body).toEqual(first.body);
    expect(duplicate.body.boxLabelTemplate.spec).toEqual(BOX_LABEL_SPEC);
    const [afterDuplicate] = await db
      .select({
        startedByUserId: schema.inventories.startedByUserId,
        startedAt: schema.inventories.startedAt,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(afterDuplicate).toEqual(afterRace);

    const audits = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.started"),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("rejects an invalid newly generated manifest before persisting running state", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    const lifecycle = app!.get(InventoryLifecycleService);
    const manifestSpy = vi
      .spyOn(lifecycle as unknown as { toManifest: (facts: unknown) => unknown }, "toManifest")
      .mockReturnValue({ inventoryId: fixture.inventoryId, privateDetail: "manifest-secret" });

    try {
      const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(409);
      expect(response.body).toEqual({ code: "INVENTORY_STORED_MANIFEST_INVALID" });
      expect(JSON.stringify(response.body)).not.toContain("manifest-secret");
    } finally {
      manifestSpy.mockRestore();
    }

    const [inventory] = await db
      .select({
        status: schema.inventories.status,
        stationManifest: schema.inventories.stationManifest,
        startedAt: schema.inventories.startedAt,
      })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(inventory).toEqual({ status: "ready", stationManifest: null, startedAt: null });
  });

  it("rejects a corrupt stored running manifest with a sanitized stable error", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);

    await expectStoredManifestRejected(agent, fixture, {
      inventoryId: fixture.inventoryId,
      privateDetail: "manifest-secret",
    });
  });

  it("rejects an unknown field in the deepest stored label object without leaking it", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    const manifest = structuredClone(started.body) as MutableStoredManifest;
    const element = manifest.boxLabelTemplate!.spec.elements[0]!;
    element.data = { literal: "safe", privateDetail: "manifest-secret" };

    await expectStoredManifestRejected(agent, fixture, manifest);
  });

  it("rejects an impossible civil date in a stored manifest", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    const manifest = structuredClone(started.body) as MutableStoredManifest;
    manifest.productionDateFrom = "2026-02-30";

    await expectStoredManifestRejected(agent, fixture, manifest);
  });

  it("rejects an inverted stored production date range", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    const manifest = structuredClone(started.body) as MutableStoredManifest;
    manifest.productionDateFrom = "2026-09-01";
    manifest.productionDateTo = "2026-08-31";

    await expectStoredManifestRejected(agent, fixture, manifest);
  });

  it("rejects invalid stored label variants and domain-invalid specs", async () => {
    const invalidVariantAgent = request.agent(app!.getHttpServer());
    const invalidVariantFixture = await seedReadyInventory(invalidVariantAgent, "repack");
    const variantStart = await invalidVariantAgent
      .post(`/inventories/${invalidVariantFixture.inventoryId}/start`)
      .expect(201);
    const invalidVariant = structuredClone(variantStart.body) as MutableStoredManifest;
    invalidVariant.boxLabelTemplate!.spec.elements[0]!.kind = "circle";
    await expectStoredManifestRejected(invalidVariantAgent, invalidVariantFixture, invalidVariant);

    const invalidSpecAgent = request.agent(app!.getHttpServer());
    const invalidSpecFixture = await seedReadyInventory(invalidSpecAgent, "repack");
    const specStart = await invalidSpecAgent
      .post(`/inventories/${invalidSpecFixture.inventoryId}/start`)
      .expect(201);
    const invalidSpec = structuredClone(specStart.body) as MutableStoredManifest;
    invalidSpec.boxLabelTemplate!.spec.elements.push({
      ...invalidSpec.boxLabelTemplate!.spec.elements[0]!,
    });
    await expectStoredManifestRejected(invalidSpecAgent, invalidSpecFixture, invalidSpec);
  });

  it("rolls back status, manifest, and start evidence when the success audit fails", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_inventory_start_audit_fail_${suffix}`;
    const triggerName = `${functionName}_trigger`;
    await setup.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.action = 'inventory.started' and new.target_id = '${fixture.inventoryId}' then
          raise exception 'injected inventory start audit failure';
        end if;
        return new;
      end
      $$
    `);
    await setup.pool.query(
      `create trigger ${triggerName} before insert on tenant_audit_events for each row execute function ${functionName}()`,
    );

    try {
      const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(500);
      expect(JSON.stringify(response.body)).not.toContain("injected inventory start audit failure");
    } finally {
      await setup.pool.query(`drop trigger ${triggerName} on tenant_audit_events`);
      await setup.pool.query(`drop function ${functionName}()`);
    }

    await expect(
      db
        .select({
          status: schema.inventories.status,
          stationManifest: schema.inventories.stationManifest,
          startedByUserId: schema.inventories.startedByUserId,
          startedAt: schema.inventories.startedAt,
        })
        .from(schema.inventories)
        .where(eq(schema.inventories.id, fixture.inventoryId)),
    ).resolves.toEqual([
      { status: "ready", stationManifest: null, startedByUserId: null, startedAt: null },
    ]);
    await expect(
      db
        .select({ id: schema.tenantAuditEvents.id })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
            eq(schema.tenantAuditEvents.action, "inventory.started"),
            eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
          ),
        ),
    ).resolves.toEqual([]);
  });

  it("serializes start with update so ready/running parameters cannot be mutated", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);

    const [start, update] = await Promise.all([
      agent.post(`/inventories/${fixture.inventoryId}/start`),
      agent.patch(`/inventories/${fixture.inventoryId}`).send({ productionDateTo: "2026-09-30" }),
    ]);
    expect(start.status).toBe(201);
    expect(update.status).toBe(409);
    expect(update.body).toMatchObject({ code: "INVENTORY_NOT_EDITABLE" });
    const [stored] = await db
      .select({ status: schema.inventories.status, to: schema.inventories.productionDateTo })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(stored).toEqual({ status: "running", to: "2026-08-31" });
  });

  it("rejects draft, preparing, closed, and completed inventories with a stable transition error", async () => {
    for (const status of ["draft", "preparing", "closed", "completed"] as const) {
      const agent = request.agent(app!.getHttpServer());
      const fixture = await seedReadyInventory(agent);
      const now = new Date();
      if (status === "closed" || status === "completed") {
        await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
      }
      await db
        .update(schema.inventories)
        .set(
          status === "draft" || status === "preparing"
            ? { status, activeSnapshotId: null }
            : status === "completed"
              ? {
                  status,
                  completedByUserId: fixture.actorUserId,
                  completedAt: now,
                  completionAcknowledgedByUserId: fixture.actorUserId,
                  completionAcknowledgedAt: now,
                }
              : { status },
        )
        .where(eq(schema.inventories.id, fixture.inventoryId));

      await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(409, {
        code: "INVENTORY_START_REQUIRES_READY",
      });
    }
  });

  it("rejects an incomplete or non-v1 active snapshot before transition", async () => {
    const missingInputAgent = request.agent(app!.getHttpServer());
    const missingInput = await seedReadyInventory(missingInputAgent);
    await db
      .delete(schema.inventorySnapshotInputs)
      .where(
        and(
          eq(schema.inventorySnapshotInputs.snapshotId, missingInput.snapshotId),
          eq(schema.inventorySnapshotInputs.status, "APPLIED"),
        ),
      );
    await missingInputAgent
      .post(`/inventories/${missingInput.inventoryId}/start`)
      .expect(409, { code: "INVENTORY_SNAPSHOT_INCOMPLETE" });

    const revisionAgent = request.agent(app!.getHttpServer());
    const wrongRevision = await seedReadyInventory(revisionAgent);
    await db
      .update(schema.inventorySnapshots)
      .set({ revision: 2 })
      .where(eq(schema.inventorySnapshots.id, wrongRevision.snapshotId));
    await revisionAgent
      .post(`/inventories/${wrongRevision.inventoryId}/start`)
      .expect(409, { code: "INVENTORY_SNAPSHOT_INCOMPLETE" });
  });

  it("revalidates active product, snapshotted GTIN, and a usable resolved repack print model", async () => {
    const inactiveAgent = request.agent(app!.getHttpServer());
    const inactive = await seedReadyInventory(inactiveAgent);
    await db
      .update(schema.products)
      .set({ status: "draft" })
      .where(eq(schema.products.id, inactive.productId));
    await inactiveAgent
      .post(`/inventories/${inactive.inventoryId}/start`)
      .expect(422, { code: "INVENTORY_PRODUCT_INACTIVE" });

    const gtinAgent = request.agent(app!.getHttpServer());
    const changedGtin = await seedReadyInventory(gtinAgent);
    await db
      .update(schema.products)
      .set({ gtin14: "04680089900390" })
      .where(eq(schema.products.id, changedGtin.productId));
    await gtinAgent
      .post(`/inventories/${changedGtin.inventoryId}/start`)
      .expect(409, { code: "INVENTORY_PRODUCT_GTIN_CHANGED" });

    const printAgent = request.agent(app!.getHttpServer());
    const invalidPrint = await seedReadyInventory(printAgent, "repack");
    await db
      .update(schema.labelTemplates)
      .set({ spec: { language: "zpl", elements: [] } })
      .where(eq(schema.labelTemplates.id, invalidPrint.templateId!));
    await printAgent
      .post(`/inventories/${invalidPrint.inventoryId}/start`)
      .expect(409, { code: "INVENTORY_PRINT_CONFIGURATION_INVALID" });
  });

  it("enforces UUID, operations-write, tenant, and subscription-write boundaries", async () => {
    await request(app!.getHttpServer()).post(`/inventories/${randomUUID()}/start`).expect(401);

    const memberAgent = request.agent(app!.getHttpServer());
    const memberFixture = await seedReadyInventory(memberAgent);
    await setOnlyOrganizationMemberRole(db, memberFixture.tenantId, "member");
    await memberAgent.post(`/inventories/${memberFixture.inventoryId}/start`).expect(403);

    const owner = request.agent(app!.getHttpServer());
    const owned = await seedReadyInventory(owner);
    await owner.post("/inventories/not-a-uuid/start").expect(400);
    const other = request.agent(app!.getHttpServer());
    await seedReadyInventory(other);
    await other.post(`/inventories/${owned.inventoryId}/start`).expect(404);

    const subscriptionAgent = request.agent(app!.getHttpServer());
    const subscriptionFixture = await seedReadyInventory(subscriptionAgent);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    const subscription = await createManagedSubscription(db, {
      tenantId: subscriptionFixture.tenantId,
      planVersionId,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(Date.now() - 1_000), updatedAt: new Date() })
      .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));
    await subscriptionAgent
      .post(`/inventories/${subscriptionFixture.inventoryId}/start`)
      .expect(403, { code: "subscription_read_only" });
  });
});
