import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, count, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";
import { inventorySnapshotContentDigest, type LabelTemplateSpec } from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { formatInventoryTaskBarcode } from "../src/modules/inventories/station-inventory.dto";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const GTIN14 = "04680089900383";
const DIGEST = "b".repeat(64);
const SNAPSHOT_ITEMS = [
  {
    codeHash: "a".repeat(64),
    canonicalRaw: "010468008990038321A",
    gtin14: GTIN14,
    serial: "A",
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: "2026-08-10",
    parentSscc: "046000000000000012",
    expected: true,
    protected: false,
  },
  {
    codeHash: "b".repeat(64),
    canonicalRaw: "010468008990038321B",
    gtin14: GTIN14,
    serial: "B",
    sourceStatus: "INTRODUCED" as const,
    sourceState: null,
    sourceProductionDate: "2026-08-11",
    parentSscc: null,
    expected: true,
    protected: false,
  },
  {
    codeHash: "c".repeat(64),
    canonicalRaw: "010468008990038321C",
    gtin14: GTIN14,
    serial: "C",
    sourceStatus: "EMITTED" as const,
    sourceState: null,
    sourceProductionDate: null,
    parentSscc: null,
    expected: false,
    protected: false,
  },
];
const CONTENT_DIGEST = inventorySnapshotContentDigest(SNAPSHOT_ITEMS);
const LABEL_SPEC = {
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
    },
  ],
} satisfies LabelTemplateSpec;

type Agent = ReturnType<typeof request.agent>;

interface BundleFixture {
  tenantId: string;
  inventoryId: string;
  snapshotId: string;
  snapshotFixedAt: string;
  productId: string;
  lineId: string;
  operatorId: string;
  deviceId: string;
  apiKey: string;
}

describe.skipIf(!ready)("station inventory bundle e2e", () => {
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

  async function seedBundle(
    agent: Agent,
    mode: "check" | "repack" = "check",
    withGln = true,
  ): Promise<BundleFixture> {
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected tenant member");

    const productId = randomUUID();
    const lineId = randomUUID();
    const templateId = mode === "repack" ? randomUUID() : null;
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN14,
      name: "Bundle Water",
      status: "active",
      boxCapacity: 12,
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Bundle line" });
    if (templateId) {
      await db.insert(schema.labelTemplates).values({
        id: templateId,
        tenantId,
        name: "Frozen bundle label",
        spec: LABEL_SPEC,
      });
    }
    if (withGln) {
      await db.insert(schema.orgProfiles).values({ tenantId, gln: "4600000090007" });
    }

    const inventoryId = randomUUID();
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${inventoryId.slice(0, 8)}`,
      productId,
      gtin14Snapshot: GTIN14,
      lineId,
      mode,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplateId: templateId,
      createdByUserId: member.userId,
    });
    const [snapshot] = await db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId,
        inventoryId,
        revision: 1,
        combinedDigest: DIGEST,
        productName: "Bundle product",
        lineName: "Bundle line",
        emittedCount: 1,
        introducedCount: 2,
        appliedCount: 0,
        retiredCount: 0,
        writtenOffCount: 0,
        disaggregationCount: 0,
        protectedCount: 0,
        expectedCount: 2,
        packageCount: 1,
        looseCount: 1,
        fixedByUserId: member.userId,
      })
      .returning({ id: schema.inventorySnapshots.id, fixedAt: schema.inventorySnapshots.fixedAt });
    if (!snapshot) throw new Error("Expected snapshot");
    await db
      .insert(schema.inventorySnapshotCodes)
      .values(SNAPSHOT_ITEMS.map((item) => ({ tenantId, snapshotId: snapshot.id, ...item })));

    const stationManifest = {
      inventoryId,
      inventoryNumber: `INV-${inventoryId.slice(0, 8)}`,
      snapshotId: snapshot.id,
      snapshotRevision: 1,
      snapshotFixedAt: snapshot.fixedAt.toISOString(),
      combinedDigest: DIGEST,
      contentDigest: CONTENT_DIGEST,
      codeCount: 3,
      productId,
      productName: "Bundle Water",
      gtin14: GTIN14,
      boxCapacity: 12,
      mode,
      lineId,
      lineName: "Bundle line",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplate:
        templateId === null
          ? null
          : { id: templateId, name: "Frozen bundle label", spec: LABEL_SPEC },
      limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
    };
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshot.id,
        stationManifest,
        startedByUserId: member.userId,
        startedAt: new Date(),
      })
      .where(eq(schema.inventories.id, inventoryId));

    const operator = await agent
      .post("/employees")
      .send({ fullName: "Bundle Operator" })
      .expect(201);
    await agent
      .put(`/operators/${operator.body.id as string}`)
      .send({
        login: String((Number.parseInt(inventoryId.slice(0, 8), 16) % 900_000) + 100_000),
        pin: "1234",
      })
      .expect(200);
    const device = await createTestStationDevice(app!, agent, "Bundle station");
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, device.deviceId));

    return {
      tenantId,
      inventoryId,
      snapshotId: snapshot.id,
      snapshotFixedAt: snapshot.fixedAt.toISOString(),
      productId,
      lineId,
      operatorId: operator.body.id as string,
      deviceId: device.deviceId,
      apiKey: device.apiKey,
    };
  }

  async function join(fixture: BundleFixture) {
    return request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", fixture.apiKey)
      .send({ operatorId: fixture.operatorId })
      .expect(200);
  }

  async function createOperator(agent: Agent, fullName: string): Promise<string> {
    const operator = await agent.post("/employees").send({ fullName }).expect(201);
    await agent
      .put(`/operators/${operator.body.id as string}`)
      .send({
        login: String((Number.parseInt(randomUUID().slice(0, 8), 16) % 900_000) + 100_000),
        pin: "1234",
      })
      .expect(200);
    return operator.body.id as string;
  }

  async function attachExpiredSubscription(
    tenantId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<void> {
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
    });
    await createManagedSubscription(db, { tenantId, planVersionId, startsAt, endsAt });
  }

  it("publishes the immutable manifest and bounded snapshot-pinned code pages in code-hash order", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);

    const manifest = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(manifest.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      snapshotId: fixture.snapshotId,
      snapshotRevision: 1,
      snapshotFixedAt: fixture.snapshotFixedAt,
      combinedDigest: DIGEST,
      contentDigest: CONTENT_DIGEST,
      codeCount: 3,
      boxCapacity: 12,
      mode: "check",
      boxLabelTemplate: null,
      sscc: null,
      ssccRevokedFrom: [],
      ssccRevokedBlocks: [],
    });
    expect(JSON.stringify(manifest.body)).not.toMatch(/objectKey|private\//i);

    const first = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
      .query({ limit: 2 })
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(first.body).toEqual({
      snapshotId: fixture.snapshotId,
      snapshotRevision: 1,
      snapshotFixedAt: fixture.snapshotFixedAt,
      combinedDigest: DIGEST,
      contentDigest: CONTENT_DIGEST,
      cursor: null,
      items: [
        {
          codeHash: "a".repeat(64),
          canonicalRaw: "010468008990038321A",
          gtin14: GTIN14,
          serial: "A",
          sourceStatus: "INTRODUCED",
          sourceState: null,
          sourceProductionDate: "2026-08-10",
          parentSscc: "046000000000000012",
          expected: true,
          protected: false,
        },
        {
          codeHash: "b".repeat(64),
          canonicalRaw: "010468008990038321B",
          gtin14: GTIN14,
          serial: "B",
          sourceStatus: "INTRODUCED",
          sourceState: null,
          sourceProductionDate: "2026-08-11",
          parentSscc: null,
          expected: true,
          protected: false,
        },
      ],
      nextCursor: "b".repeat(64),
      pageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const second = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
      .query({ limit: 2, cursor: first.body.nextCursor as string })
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(second.body.items.map((item: { codeHash: string }) => item.codeHash)).toEqual([
      "c".repeat(64),
    ]);
    expect(second.body.nextCursor).toBeNull();
    expect(second.body).toMatchObject({
      snapshotFixedAt: fixture.snapshotFixedAt,
      contentDigest: CONTENT_DIGEST,
      cursor: "b".repeat(64),
      pageDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
      .query({ limit: 201 })
      .set("x-api-key", fixture.apiKey)
      .expect(400);
    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
      .query({ cursor: "f".repeat(64), snapshotId: randomUUID() })
      .set("x-api-key", fixture.apiKey)
      .expect(400);
  });

  it("backfills and serves a legacy running manifest from verified snapshot rows", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);
    const [inventory] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    const legacy = structuredClone(inventory!.manifest) as Record<string, unknown>;
    delete legacy.snapshotFixedAt;
    delete legacy.contentDigest;
    await db
      .update(schema.inventories)
      .set({ stationManifest: legacy })
      .where(eq(schema.inventories.id, fixture.inventoryId));

    const response = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(response.body).toMatchObject({
      snapshotFixedAt: fixture.snapshotFixedAt,
      contentDigest: CONTENT_DIGEST,
    });
    const [stored] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(stored?.manifest).toMatchObject({
      snapshotFixedAt: fixture.snapshotFixedAt,
      contentDigest: CONTENT_DIGEST,
    });
  });

  it("rejects a legacy running manifest with a corrupt immutable anchor", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);
    const [inventory] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    const legacy = structuredClone(inventory!.manifest) as Record<string, unknown>;
    delete legacy.snapshotFixedAt;
    delete legacy.contentDigest;
    legacy.snapshotId = randomUUID();
    await db
      .update(schema.inventories)
      .set({ stationManifest: legacy })
      .where(eq(schema.inventories.id, fixture.inventoryId));

    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(409, { code: "INVENTORY_BUNDLE_INVALID" });
  });

  it("rejects a current manifest whose content digest was forged", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);
    const [inventory] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    await db
      .update(schema.inventories)
      .set({
        stationManifest: {
          ...(inventory!.manifest as Record<string, unknown>),
          contentDigest: "f".repeat(64),
        },
      })
      .where(eq(schema.inventories.id, fixture.inventoryId));

    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(409, { code: "INVENTORY_BUNDLE_INVALID" });
  });

  it("rejects current snapshot rows mutated after the manifest proof was frozen", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);
    await db
      .update(schema.inventorySnapshotCodes)
      .set({ sourceState: "MUTATED_AFTER_FIXATION" })
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, fixture.tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, fixture.snapshotId),
          eq(schema.inventorySnapshotCodes.codeHash, "a".repeat(64)),
        ),
      );

    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
      .set("x-api-key", fixture.apiKey)
      .expect(409, { code: "INVENTORY_BUNDLE_INVALID" });
  });

  it("rejects current snapshot counts that no longer match frozen rows", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent);
    await join(fixture);
    await db
      .update(schema.inventorySnapshots)
      .set({ introducedCount: 1 })
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, fixture.tenantId),
          eq(schema.inventorySnapshots.id, fixture.snapshotId),
        ),
      );

    await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(409, { code: "INVENTORY_BUNDLE_INVALID" });
  });

  it("reuses a device's existing SSCC block with original bounds and consumed cursor without creating a shift", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent, "repack");
    await db
      .update(schema.products)
      .set({ boxCapacity: 48 })
      .where(
        and(
          eq(schema.products.tenantId, fixture.tenantId),
          eq(schema.products.id, fixture.productId),
        ),
      );
    const [beforeShifts] = await db
      .select({ value: count() })
      .from(schema.shifts)
      .where(eq(schema.shifts.tenantId, fixture.tenantId));

    const first = await join(fixture);
    expect(first.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      mode: "repack",
      boxCapacity: 12,
      boxLabelTemplate: { name: "Frozen bundle label", spec: LABEL_SPEC },
      sscc: {
        allocationOrder: expect.any(Number),
        issuerPrefix: "460000009",
        extensionDigit: 0,
        fromSerial: expect.any(Number),
        toSerial: expect.any(Number),
        consumedThroughSerial: null,
      },
      ssccRevokedBlocks: [],
    });
    const original = first.body.sscc as {
      allocationOrder: number;
      fromSerial: number;
      toSerial: number;
    };
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: original.fromSerial + 7 })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, fixture.tenantId),
          eq(schema.ssccBlocks.deviceId, fixture.deviceId),
          eq(schema.ssccBlocks.fromSerial, original.fromSerial),
        ),
      );

    const repeated = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(repeated.body.sscc).toEqual({
      allocationOrder: original.allocationOrder,
      issuerPrefix: "460000009",
      extensionDigit: 0,
      fromSerial: original.fromSerial,
      toSerial: original.toSerial,
      consumedThroughSerial: original.fromSerial + 7,
    });
    expect(repeated.body.ssccRevokedBlocks).toEqual([]);

    const [afterShifts] = await db
      .select({ value: count() })
      .from(schema.shifts)
      .where(eq(schema.shifts.tenantId, fixture.tenantId));
    expect(afterShifts?.value).toBe(beforeShifts?.value);
  });

  it("does not expose another tenant's SSCC allocation activity in bundle order", async () => {
    const firstFixture = await seedBundle(request.agent(app!.getHttpServer()), "repack");
    const secondFixture = await seedBundle(request.agent(app!.getHttpServer()), "repack");

    const first = await join(firstFixture);
    const second = await join(secondFixture);
    expect(first.body.sscc.allocationOrder).toBe(1);
    expect(second.body.sscc.allocationOrder).toBe(1);
  });

  it("identifies a valid same-range replacement independently from its revoked predecessor", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedBundle(agent, "repack");
    const first = await join(fixture);
    const original = first.body.sscc as {
      allocationOrder: number;
      fromSerial: number;
      toSerial: number;
    };

    await db.transaction(async (tx) => {
      await tx
        .update(schema.ssccBlocks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, fixture.tenantId),
            eq(schema.ssccBlocks.allocationOrder, original.allocationOrder),
          ),
        );
      await tx
        .update(schema.ssccCounters)
        .set({ nextSerial: original.fromSerial })
        .where(
          and(
            eq(schema.ssccCounters.tenantId, fixture.tenantId),
            eq(schema.ssccCounters.issuerPrefix, "460000009"),
            eq(schema.ssccCounters.extensionDigit, 0),
          ),
        );
    });

    const reused = await request(app!.getHttpServer())
      .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
      .set("x-api-key", fixture.apiKey)
      .expect(200);
    expect(reused.body.sscc).toMatchObject({
      allocationOrder: expect.any(Number),
      fromSerial: original.fromSerial,
      toSerial: original.toSerial,
      consumedThroughSerial: null,
    });
    expect(reused.body.sscc.allocationOrder).toBeGreaterThan(original.allocationOrder);
    expect(reused.body.ssccRevokedFrom).toEqual([]);
    expect(reused.body.ssccRevokedBlocks).toEqual([
      {
        allocationOrder: original.allocationOrder,
        fromSerial: original.fromSerial,
        toSerial: original.toSerial,
      },
    ]);
  });

  it.each([
    { name: "operator changes", initial: "assigned", retry: "other_operator" },
    { name: "the configured device line changes", initial: "cross_line", retry: "other_line" },
    { name: "barcode join semantics change", initial: "assigned", retry: "task_barcode" },
    {
      name: "the different-line confirmation context changes",
      initial: "assigned",
      retry: "cross_line",
    },
  ] as const)(
    "rejects an active repack participant conflict when $name before allocating another SSCC block",
    async ({ initial, retry }) => {
      const agent = request.agent(app!.getHttpServer());
      const fixture = await seedBundle(agent, "repack");
      const otherOperatorId = await createOperator(agent, "Other Bundle Operator");
      const firstOtherLineId = randomUUID();
      const secondOtherLineId = randomUUID();
      await db.insert(schema.lines).values([
        { id: firstOtherLineId, tenantId: fixture.tenantId, name: "Other bundle line A" },
        { id: secondOtherLineId, tenantId: fixture.tenantId, name: "Other bundle line B" },
      ]);
      if (initial === "cross_line") {
        await db
          .update(schema.stationDevices)
          .set({ lineId: firstOtherLineId })
          .where(
            and(
              eq(schema.stationDevices.tenantId, fixture.tenantId),
              eq(schema.stationDevices.id, fixture.deviceId),
            ),
          );
      }

      const barcode = formatInventoryTaskBarcode(fixture.inventoryId);
      await request(app!.getHttpServer())
        .post(`/station/inventories/${fixture.inventoryId}/join`)
        .set("x-api-key", fixture.apiKey)
        .send({
          operatorId: fixture.operatorId,
          ...(initial === "cross_line" ? { barcode, confirmDifferentLine: true } : {}),
        })
        .expect(200);

      await db
        .update(schema.inventoryDeviceParticipants)
        .set({ pendingEventCount: 7, openBoxCount: 3 })
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, fixture.deviceId),
          ),
        );
      const [allocatedBlock] = await db
        .select({ id: schema.ssccBlocks.id, toSerial: schema.ssccBlocks.toSerial })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, fixture.tenantId),
            eq(schema.ssccBlocks.deviceId, fixture.deviceId),
          ),
        );
      if (!allocatedBlock) throw new Error("Expected repack join to allocate an SSCC block");
      await db
        .update(schema.ssccBlocks)
        .set({ consumedThroughSerial: allocatedBlock.toSerial })
        .where(eq(schema.ssccBlocks.id, allocatedBlock.id));

      const participantWhere = and(
        eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
        eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
        eq(schema.inventoryDeviceParticipants.deviceId, fixture.deviceId),
      );
      const auditWhere = and(
        eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
        eq(schema.tenantAuditEvents.action, "inventory.station.joined"),
        eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
      );
      const [participantBefore] = await db
        .select()
        .from(schema.inventoryDeviceParticipants)
        .where(participantWhere);
      const auditsBefore = await db.select().from(schema.tenantAuditEvents).where(auditWhere);
      const blocksBefore = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, fixture.tenantId),
            eq(schema.ssccBlocks.deviceId, fixture.deviceId),
          ),
        );
      if (!participantBefore) throw new Error("Expected active inventory participant");

      if (retry === "other_line") {
        await db
          .update(schema.stationDevices)
          .set({ lineId: secondOtherLineId })
          .where(
            and(
              eq(schema.stationDevices.tenantId, fixture.tenantId),
              eq(schema.stationDevices.id, fixture.deviceId),
            ),
          );
      } else if (retry === "cross_line") {
        await db
          .update(schema.stationDevices)
          .set({ lineId: firstOtherLineId })
          .where(
            and(
              eq(schema.stationDevices.tenantId, fixture.tenantId),
              eq(schema.stationDevices.id, fixture.deviceId),
            ),
          );
      }

      await request(app!.getHttpServer())
        .post(`/station/inventories/${fixture.inventoryId}/join`)
        .set("x-api-key", fixture.apiKey)
        .send({
          operatorId: retry === "other_operator" ? otherOperatorId : fixture.operatorId,
          ...(retry === "other_line" || retry === "task_barcode" || retry === "cross_line"
            ? { barcode }
            : {}),
          ...(retry === "other_line" || retry === "cross_line"
            ? { confirmDifferentLine: true }
            : {}),
        })
        .expect(409, { code: "INVENTORY_ACTIVE_PARTICIPANT_CONFLICT" });

      const [participantAfter] = await db
        .select()
        .from(schema.inventoryDeviceParticipants)
        .where(participantWhere);
      const auditsAfter = await db.select().from(schema.tenantAuditEvents).where(auditWhere);
      const blocksAfter = await db
        .select()
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, fixture.tenantId),
            eq(schema.ssccBlocks.deviceId, fixture.deviceId),
          ),
        );
      expect(participantAfter).toEqual(participantBefore);
      expect(auditsAfter).toEqual(auditsBefore);
      expect(blocksAfter).toEqual(blocksBefore);
    },
  );

  it("fails a repack join atomically when its frozen template or usable SSCC allocation is unavailable", async () => {
    const invalidTemplateAgent = request.agent(app!.getHttpServer());
    const invalidTemplate = await seedBundle(invalidTemplateAgent, "repack");
    const [inventory] = await db
      .select({ manifest: schema.inventories.stationManifest })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, invalidTemplate.inventoryId));
    await db
      .update(schema.inventories)
      .set({
        stationManifest: {
          ...(inventory!.manifest as Record<string, unknown>),
          boxLabelTemplate: null,
        },
      })
      .where(eq(schema.inventories.id, invalidTemplate.inventoryId));
    await request(app!.getHttpServer())
      .post(`/station/inventories/${invalidTemplate.inventoryId}/join`)
      .set("x-api-key", invalidTemplate.apiKey)
      .send({ operatorId: invalidTemplate.operatorId })
      .expect(409, { code: "INVENTORY_BUNDLE_INVALID" });

    const noSsccAgent = request.agent(app!.getHttpServer());
    const noSscc = await seedBundle(noSsccAgent, "repack", false);
    await request(app!.getHttpServer())
      .post(`/station/inventories/${noSscc.inventoryId}/join`)
      .set("x-api-key", noSscc.apiKey)
      .send({ operatorId: noSscc.operatorId })
      .expect(409, { code: "INVENTORY_SSCC_UNAVAILABLE" });

    for (const fixture of [invalidTemplate, noSscc]) {
      const participants = await db
        .select({ id: schema.inventoryDeviceParticipants.id })
        .from(schema.inventoryDeviceParticipants)
        .where(eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId));
      const audits = await db
        .select({ id: schema.tenantAuditEvents.id })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
            eq(schema.tenantAuditEvents.action, "inventory.station.joined"),
            eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
          ),
        );
      expect({ participants, audits }).toEqual({ participants: [], audits: [] });
    }
  });

  it("enforces the strict recovery boundary before bundle admission and SSCC/participant/audit publication", async () => {
    const endsAt = new Date(Date.now() - 60_000);
    for (const boundary of ["before", "equal", "after"] as const) {
      const agent = request.agent(app!.getHttpServer());
      const fixture = await seedBundle(agent, "repack");
      const startedAt = new Date(
        endsAt.getTime() + (boundary === "before" ? -1 : boundary === "equal" ? 0 : 1),
      );
      await db
        .update(schema.inventories)
        .set({ startedAt })
        .where(
          and(
            eq(schema.inventories.tenantId, fixture.tenantId),
            eq(schema.inventories.id, fixture.inventoryId),
          ),
        );
      await attachExpiredSubscription(
        fixture.tenantId,
        new Date(endsAt.getTime() - 86_400_000),
        endsAt,
      );

      const joinRequest = request(app!.getHttpServer())
        .post(`/station/inventories/${fixture.inventoryId}/join`)
        .set("x-api-key", fixture.apiKey)
        .send({ operatorId: fixture.operatorId });
      if (boundary === "before") {
        await joinRequest.expect(200);
        await request(app!.getHttpServer())
          .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
          .set("x-api-key", fixture.apiKey)
          .expect(200);
        await request(app!.getHttpServer())
          .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
          .set("x-api-key", fixture.apiKey)
          .expect(200);

        await db
          .update(schema.inventories)
          .set({ startedAt: endsAt })
          .where(
            and(
              eq(schema.inventories.tenantId, fixture.tenantId),
              eq(schema.inventories.id, fixture.inventoryId),
            ),
          );
        await request(app!.getHttpServer())
          .get(`/station/inventories/${fixture.inventoryId}/bundle/manifest`)
          .set("x-api-key", fixture.apiKey)
          .expect(403, { code: "subscription_read_only" });
        await request(app!.getHttpServer())
          .get(`/station/inventories/${fixture.inventoryId}/bundle/codes`)
          .set("x-api-key", fixture.apiKey)
          .expect(403, { code: "subscription_read_only" });
        continue;
      }

      await joinRequest.expect(403, { code: "subscription_read_only" });
      const participants = await db
        .select({ id: schema.inventoryDeviceParticipants.id })
        .from(schema.inventoryDeviceParticipants)
        .where(
          and(
            eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
            eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
            eq(schema.inventoryDeviceParticipants.deviceId, fixture.deviceId),
          ),
        );
      const audits = await db
        .select({ id: schema.tenantAuditEvents.id })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
            eq(schema.tenantAuditEvents.action, "inventory.station.joined"),
            eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
          ),
        );
      const blocks = await db
        .select({ id: schema.ssccBlocks.id })
        .from(schema.ssccBlocks)
        .where(
          and(
            eq(schema.ssccBlocks.tenantId, fixture.tenantId),
            eq(schema.ssccBlocks.deviceId, fixture.deviceId),
          ),
        );
      expect({ participants, audits, blocks }).toEqual({
        participants: [],
        audits: [],
        blocks: [],
      });
    }
  });
});
