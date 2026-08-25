import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

const GTIN14 = "04680089900383";
const DIGEST = "a".repeat(64);

type Agent = ReturnType<typeof request.agent>;

interface RunningInventoryFixture {
  tenantId: string;
  inventoryId: string;
  inventoryNumber: string;
  lineId: string;
  otherLineId: string;
  snapshotId: string;
  operatorId: string;
}

describe.skipIf(!ready)("station inventory task access e2e", () => {
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

  async function seedRunningInventory(agent: Agent): Promise<RunningInventoryFixture> {
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected tenant member");

    const productId = randomUUID();
    const lineId = randomUUID();
    const otherLineId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN14,
      name: "Inventory Water",
      status: "active",
    });
    await db.insert(schema.lines).values([
      { id: lineId, tenantId, name: "Inventory line" },
      { id: otherLineId, tenantId, name: "Other line" },
    ]);

    const inventoryId = randomUUID();
    const inventoryNumber = `INV-${inventoryId.slice(0, 8)}`;
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: inventoryNumber,
      productId,
      gtin14Snapshot: GTIN14,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: member.userId,
    });
    const [snapshot] = await db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId,
        inventoryId,
        revision: 1,
        combinedDigest: DIGEST,
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
        fixedByUserId: member.userId,
      })
      .returning({ id: schema.inventorySnapshots.id });
    if (!snapshot) throw new Error("Expected snapshot");

    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshot.id,
        stationManifest: {
          inventoryId,
          inventoryNumber,
          snapshotId: snapshot.id,
          snapshotRevision: 1,
          combinedDigest: DIGEST,
          codeCount: 0,
          productId,
          productName: "Inventory Water",
          gtin14: GTIN14,
          mode: "check",
          lineId,
          lineName: "Inventory line",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
          boxLabelTemplate: null,
          limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
        },
        startedByUserId: member.userId,
        startedAt: new Date(),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );

    const operator = await agent
      .post("/employees")
      .send({ fullName: "Inventory Operator" })
      .expect(201);
    await agent
      .put(`/operators/${operator.body.id as string}`)
      .send({
        login: String((Number.parseInt(inventoryId.slice(0, 8), 16) % 900_000) + 100_000),
        pin: "1234",
      })
      .expect(200);

    return {
      tenantId,
      inventoryId,
      inventoryNumber,
      lineId,
      otherLineId,
      snapshotId: snapshot.id,
      operatorId: operator.body.id as string,
    };
  }

  async function station(agent: Agent, name: string, lineId: string) {
    const device = await createTestStationDevice(app!, agent, name);
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, device.deviceId));
    return device;
  }

  it("lists only running tasks assigned to the authenticated device's server-side line", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedRunningInventory(agent);
    const assigned = await station(agent, "Assigned station", fixture.lineId);
    const other = await station(agent, "Other station", fixture.otherLineId);

    const visible = await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .set("x-api-key", assigned.apiKey)
      .expect(200);
    expect(visible.body).toEqual({
      items: [
        {
          inventoryId: fixture.inventoryId,
          inventoryNumber: fixture.inventoryNumber,
          productName: "Inventory Water",
          mode: "check",
          lineId: fixture.lineId,
          lineName: "Inventory line",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
        },
      ],
    });

    await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .query({ lineId: fixture.lineId })
      .set("x-api-key", other.apiKey)
      .expect(200, { items: [] });
  });

  it("resolves a task barcode as preview but requires explicit confirmation to join across lines", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedRunningInventory(agent);
    const device = await station(agent, "Cross-line station", fixture.otherLineId);
    const barcode = `markiro:inventory:v1:${fixture.inventoryId}`;

    const preview = await request(app!.getHttpServer())
      .post("/station/inventory-tasks/resolve-barcode")
      .set("x-api-key", device.apiKey)
      .send({ barcode })
      .expect(200);
    expect(preview.body).toEqual({
      task: {
        inventoryId: fixture.inventoryId,
        inventoryNumber: fixture.inventoryNumber,
        productName: "Inventory Water",
        mode: "check",
        lineId: fixture.lineId,
        lineName: "Inventory line",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
      },
      deviceLineId: fixture.otherLineId,
      requiresDifferentLineConfirmation: true,
    });

    await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", device.apiKey)
      .send({ operatorId: fixture.operatorId, barcode, confirmDifferentLine: false })
      .expect(409, { code: "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED" });

    await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", device.apiKey)
      .send({ operatorId: fixture.operatorId, barcode, confirmDifferentLine: true })
      .expect(200);

    const [participant] = await db
      .select()
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, device.deviceId),
        ),
      );
    expect(participant).toMatchObject({
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      deviceId: device.deviceId,
      operatorId: fixture.operatorId,
      configuredLineId: fixture.otherLineId,
      joinMethod: "task_barcode",
      differentLineConfirmed: true,
      leftAt: null,
      pendingEventCount: 0,
      openBoxCount: 0,
    });

    const audit = await db
      .select({
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
          eq(schema.tenantAuditEvents.action, "inventory.station.joined"),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
        ),
      );
    expect(audit).toEqual([
      {
        actorUserId: null,
        action: "inventory.station.joined",
        outcome: "success",
        targetType: "inventory",
        targetId: fixture.inventoryId,
        after: {
          tenantId: fixture.tenantId,
          inventoryId: fixture.inventoryId,
          snapshotId: fixture.snapshotId,
          snapshotRevision: 1,
          deviceId: device.deviceId,
          operatorId: fixture.operatorId,
          configuredLineId: fixture.otherLineId,
          inventoryLineId: fixture.lineId,
          joinMethod: "task_barcode",
          taskBarcodeUsed: true,
          differentLineConfirmed: true,
        },
      },
    ]);
  });

  it("denies unconfirmed barcode-less cross-line joins, cross-tenant ids, non-running tasks, and revoked devices", async () => {
    const owner = request.agent(app!.getHttpServer());
    const fixture = await seedRunningInventory(owner);
    const device = await station(owner, "Boundary station", fixture.otherLineId);

    await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", device.apiKey)
      .send({ operatorId: fixture.operatorId, confirmDifferentLine: true })
      .expect(409, { code: "INVENTORY_TASK_BARCODE_REQUIRED" });

    const otherTenant = request.agent(app!.getHttpServer());
    const other = await seedRunningInventory(otherTenant);
    const foreignDevice = await station(otherTenant, "Foreign station", other.lineId);
    await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", foreignDevice.apiKey)
      .send({ operatorId: other.operatorId })
      .expect(404);

    await db
      .update(schema.inventories)
      .set({ status: "ready", stationManifest: null })
      .where(eq(schema.inventories.id, fixture.inventoryId));
    await request(app!.getHttpServer())
      .post("/station/inventory-tasks/resolve-barcode")
      .set("x-api-key", device.apiKey)
      .send({ barcode: `markiro:inventory:v1:${fixture.inventoryId}` })
      .expect(404);

    await db
      .update(schema.stationDevices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.stationDevices.id, device.deviceId));
    await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .set("x-api-key", device.apiKey)
      .expect(401);
  });
});
