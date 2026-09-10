import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";
import { inventorySnapshotContentDigest } from "@markiro/domain";

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
const EMPTY_CONTENT_DIGEST = inventorySnapshotContentDigest([]);

type Agent = ReturnType<typeof request.agent>;

interface RunningInventoryFixture {
  tenantId: string;
  inventoryId: string;
  inventoryNumber: string;
  productId: string;
  lineId: string;
  otherLineId: string;
  snapshotId: string;
  operatorId: string;
}

describe.skipIf(!ready)("handheld inventory task access e2e", () => {
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
      boxCapacity: 12,
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
        productName: "Inventory Water",
        lineName: "Inventory line",
        boxCapacity: 12,
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
      .returning({ id: schema.inventorySnapshots.id, fixedAt: schema.inventorySnapshots.fixedAt });
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
          snapshotFixedAt: snapshot.fixedAt.toISOString(),
          combinedDigest: DIGEST,
          contentDigest: EMPTY_CONTENT_DIGEST,
          codeCount: 0,
          productId,
          productName: "Inventory Water",
          productPrintName: null,
          egaisCode: null,
          shelfLifeDays: null,
          gtin14: GTIN14,
          boxCapacity: 12,
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
      productId,
      lineId,
      otherLineId,
      snapshotId: snapshot.id,
      operatorId: operator.body.id as string,
    };
  }

  async function device(agent: Agent, name: string, lineId: string, kind: "station" | "handheld") {
    const created = await createTestStationDevice(app!, agent, name, { kind });
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, created.deviceId));
    return created;
  }

  async function seedSecondRunningInventory(fixture: RunningInventoryFixture, lineId: string) {
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, fixture.tenantId));
    if (!member) throw new Error("Expected tenant member");
    const inventoryId = randomUUID();
    const inventoryNumber = `INV-${inventoryId.slice(0, 8)}`;
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId: fixture.tenantId,
      number: inventoryNumber,
      productId: fixture.productId,
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
        tenantId: fixture.tenantId,
        inventoryId,
        revision: 1,
        combinedDigest: DIGEST,
        productName: "Inventory Water",
        lineName: "Other line",
        boxCapacity: 12,
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
      .returning({ id: schema.inventorySnapshots.id, fixedAt: schema.inventorySnapshots.fixedAt });
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
          snapshotFixedAt: snapshot.fixedAt.toISOString(),
          combinedDigest: DIGEST,
          contentDigest: EMPTY_CONTENT_DIGEST,
          codeCount: 0,
          productId: fixture.productId,
          productName: "Inventory Water",
          productPrintName: null,
          egaisCode: null,
          shelfLifeDays: null,
          gtin14: GTIN14,
          boxCapacity: 12,
          mode: "check",
          lineId,
          lineName: "Other line",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
          boxLabelTemplate: null,
          limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
        },
        startedByUserId: member.userId,
        startedAt: new Date(),
      })
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, inventoryId),
        ),
      );
    return { inventoryId, inventoryNumber };
  }

  it("lists every running inventory for a handheld with scope=all and only the line for a station", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedRunningInventory(agent);
    const other = await seedSecondRunningInventory(fixture, fixture.otherLineId);
    const handheld = await device(agent, "Handheld A", fixture.lineId, "handheld");
    const station = await device(agent, "Station A", fixture.lineId, "station");

    const own = await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .set("x-api-key", handheld.apiKey)
      .expect(200);
    expect(own.body.items.map((item: { inventoryId: string }) => item.inventoryId)).toEqual([
      fixture.inventoryId,
    ]);

    const all = await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .query({ scope: "all" })
      .set("x-api-key", handheld.apiKey)
      .expect(200);
    expect(all.body.items.map((item: { inventoryId: string }) => item.inventoryId).sort()).toEqual(
      [fixture.inventoryId, other.inventoryId].sort(),
    );
    expect(
      all.body.items.find(
        (item: { inventoryId: string }) => item.inventoryId === other.inventoryId,
      ),
    ).toMatchObject({ lineId: fixture.otherLineId, lineName: "Other line", mode: "check" });

    const stationAll = await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .query({ scope: "all" })
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(stationAll.body.items.map((item: { inventoryId: string }) => item.inventoryId)).toEqual([
      fixture.inventoryId,
    ]);

    await request(app!.getHttpServer())
      .get("/station/inventory-tasks")
      .query({ scope: "everything" })
      .set("x-api-key", handheld.apiKey)
      .expect(400);
  });

  it("lets a handheld join another line's task with confirmation only, while a station still needs the barcode", async () => {
    const agent = request.agent(app!.getHttpServer());
    const fixture = await seedRunningInventory(agent);
    const handheld = await device(agent, "Handheld B", fixture.otherLineId, "handheld");
    const station = await device(agent, "Station B", fixture.otherLineId, "station");

    const stationAttempt = await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", station.apiKey)
      .send({ operatorId: fixture.operatorId, confirmDifferentLine: true })
      .expect(409);
    expect(stationAttempt.body).toMatchObject({ code: "INVENTORY_TASK_BARCODE_REQUIRED" });

    const unconfirmed = await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", handheld.apiKey)
      .send({ operatorId: fixture.operatorId })
      .expect(409);
    expect(unconfirmed.body).toMatchObject({
      code: "INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED",
    });

    const joined = await request(app!.getHttpServer())
      .post(`/station/inventories/${fixture.inventoryId}/join`)
      .set("x-api-key", handheld.apiKey)
      .send({ operatorId: fixture.operatorId, confirmDifferentLine: true })
      .expect(200);
    expect(joined.body).toMatchObject({
      inventoryId: fixture.inventoryId,
      mode: "check",
      sscc: null,
    });

    const [participant] = await db
      .select({
        deviceId: schema.inventoryDeviceParticipants.deviceId,
        differentLineConfirmed: schema.inventoryDeviceParticipants.differentLineConfirmed,
      })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, handheld.deviceId),
        ),
      );
    expect(participant).toEqual({ deviceId: handheld.deviceId, differentLineConfirmed: true });
  });
});
