import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import {
  inventorySnapshotContentDigest,
  INVENTORY_CHZ_STATUSES,
  type LabelTemplateSpec,
  type StationInventoryBundleCode,
} from "@markiro/domain";

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
const SNAPSHOT_CODES: StationInventoryBundleCode[] = [
  ...Array.from({ length: 2 }, (_, index) => ({
    sourceStatus: "EMITTED" as const,
    sourceState: index === 0 ? "MOVING_BY_UD" : null,
    sourceProductionDate: null,
    expected: false,
    protected: index === 0,
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: index < 2 ? `2026-08-0${index + 1}` : "2026-07-31",
    expected: index < 2,
    protected: false,
  })),
  ...Array.from({ length: 4 }, () => ({
    sourceStatus: "RETIRED" as const,
    sourceState: null,
    sourceProductionDate: null,
    expected: false,
    protected: false,
  })),
  {
    sourceStatus: "WRITTEN_OFF" as const,
    sourceState: null,
    sourceProductionDate: null,
    expected: false,
    protected: false,
  },
].map((facts, index) => ({
  codeHash: index.toString(16).padStart(64, "0"),
  canonicalRaw: `010468008990038321LIFECYCLE-${index}`,
  gtin14: GTIN14,
  serial: `LIFECYCLE-${index}`,
  parentSscc: index === 0 ? "046000000000000012" : null,
  ...facts,
}));
const CONTENT_DIGEST = inventorySnapshotContentDigest(SNAPSHOT_CODES);
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
  snapshotFixedAt: string;
  templateId: string | null;
}

interface MutableStoredManifest {
  boxCapacity?: number;
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
      printName: "Water 0.5 l",
      egaisCode: "0101234567890123456",
      shelfLifeDays: 184,
      boxCapacity: 12,
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
        productName: "Inventory Water",
        lineName: "Inventory line",
        boxCapacity: 12,
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
      .returning({ id: schema.inventorySnapshots.id, fixedAt: schema.inventorySnapshots.fixedAt });
    if (!snapshot) throw new Error("Expected snapshot fixture");
    await db.insert(schema.inventorySnapshotCodes).values(
      SNAPSHOT_CODES.map((code) => ({
        tenantId,
        snapshotId: snapshot.id,
        canonicalRaw: code.canonicalRaw,
        codeHash: code.codeHash,
        gtin14: code.gtin14,
        serial: code.serial,
        sourceStatus: code.sourceStatus,
        sourceState: code.sourceState,
        sourceProductionDate: code.sourceProductionDate,
        parentSscc: code.parentSscc,
        expected: code.expected,
        protected: code.protected,
      })),
    );
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
      snapshotFixedAt: snapshot.fixedAt.toISOString(),
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
      snapshotFixedAt: fixture.snapshotFixedAt,
      combinedDigest: SNAPSHOT_DIGEST,
      contentDigest: CONTENT_DIGEST,
      codeCount: 10,
      productId: fixture.productId,
      productName: "Inventory Water",
      productPrintName: "Water 0.5 l",
      egaisCode: "0101234567890123456",
      shelfLifeDays: 184,
      gtin14: GTIN14,
      boxCapacity: 12,
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
          boxCapacity: 12,
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
    expect(response.body.boxCapacity).toBe(12);

    await db
      .update(schema.products)
      .set({
        boxCapacity: 48,
        name: "Edited after start",
        printName: "Edited print name",
        egaisCode: null,
        shelfLifeDays: 1,
      })
      .where(
        and(
          eq(schema.products.tenantId, fixture.tenantId),
          eq(schema.products.id, fixture.productId),
        ),
      );
    const duplicate = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(duplicate.body.boxCapacity).toBe(12);
    expect(duplicate.body).toMatchObject({
      productName: "Inventory Water",
      productPrintName: "Water 0.5 l",
      egaisCode: "0101234567890123456",
      shelfLifeDays: 184,
    });
  });

  it("starts from the catalog facts frozen with the snapshot after product and line edits", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    await db
      .update(schema.products)
      .set({ name: "Changed product", boxCapacity: 24 })
      .where(
        and(
          eq(schema.products.tenantId, fixture.tenantId),
          eq(schema.products.id, fixture.productId),
        ),
      );
    await db
      .update(schema.lines)
      .set({ name: "Changed line" })
      .where(and(eq(schema.lines.tenantId, fixture.tenantId), eq(schema.lines.id, fixture.lineId)));

    const response = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(response.body).toMatchObject({
      productName: "Inventory Water",
      lineName: "Inventory line",
      boxCapacity: 12,
    });
  });

  it("requires a positive snapshot box capacity before freezing either inventory mode", async () => {
    for (const mode of ["check", "repack"] as const) {
      const agent = request.agent(app!.getHttpServer());
      const fixture = await seedReadyInventory(agent, mode);
      await db
        .update(schema.inventorySnapshots)
        .set({ boxCapacity: 0 })
        .where(
          and(
            eq(schema.inventorySnapshots.tenantId, fixture.tenantId),
            eq(schema.inventorySnapshots.id, fixture.snapshotId),
          ),
        );

      await agent
        .post(`/inventories/${fixture.inventoryId}/start`)
        .expect(409, { code: "INVENTORY_BOX_CAPACITY_INVALID" });
    }
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

  it("idempotently backfills proof fields on a legacy running manifest", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    const legacy = structuredClone(started.body) as Record<string, unknown>;
    delete legacy.snapshotFixedAt;
    delete legacy.contentDigest;
    await overwriteStoredManifest(fixture, legacy);
    await db
      .update(schema.products)
      .set({ name: "Changed after legacy start", boxCapacity: 48 })
      .where(
        and(
          eq(schema.products.tenantId, fixture.tenantId),
          eq(schema.products.id, fixture.productId),
        ),
      );
    await db
      .update(schema.lines)
      .set({ name: "Changed line after legacy start" })
      .where(and(eq(schema.lines.tenantId, fixture.tenantId), eq(schema.lines.id, fixture.lineId)));

    const upgraded = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(upgraded.body).toEqual(started.body);
    const repeated = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    expect(repeated.body).toEqual(started.body);
    const [stored] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(stored?.manifest).toEqual(started.body);
  });

  it("rejects a legacy running manifest whose immutable snapshot anchor is corrupt", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent);
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);
    const legacy = structuredClone(started.body) as Record<string, unknown>;
    delete legacy.snapshotFixedAt;
    delete legacy.contentDigest;
    legacy.combinedDigest = "f".repeat(64);
    await overwriteStoredManifest(fixture, legacy);

    await agent
      .post(`/inventories/${fixture.inventoryId}/start`)
      .expect(409, { code: "INVENTORY_STORED_MANIFEST_INVALID" });
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

  it("rejects a stored manifest with missing or non-positive frozen box capacity", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);

    const missing = structuredClone(started.body) as MutableStoredManifest;
    delete missing.boxCapacity;
    await expectStoredManifestRejected(agent, fixture, missing);

    const nonPositive = structuredClone(started.body) as MutableStoredManifest;
    nonPositive.boxCapacity = 0;
    await expectStoredManifestRejected(agent, fixture, nonPositive);
  });

  it("rejects stored manifests that disagree with immutable snapshot catalog facts", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedReadyInventory(agent, "repack");
    const started = await agent.post(`/inventories/${fixture.inventoryId}/start`).expect(201);

    for (const patch of [
      { productName: "Different product" },
      { lineName: "Different line" },
      { boxCapacity: 13 },
    ]) {
      await expectStoredManifestRejected(agent, fixture, { ...started.body, ...patch });
    }
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
