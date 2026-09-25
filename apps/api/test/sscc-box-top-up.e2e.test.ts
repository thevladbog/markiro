import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("box SSCC top-up", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
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

  async function activeShift(kind: "station" | "handheld" = "station") {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await agent.put("/org/profile").send({ gln: "4601112222005" }).expect(200);
    const templateId = randomUUID();
    await db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId,
      name: "Box top-up template",
      spec: { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] },
    });
    await agent.put("/org/profile").send({ defaultBoxLabelTemplateId: templateId }).expect(200);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: `${Math.floor(Math.random() * 1e13)}`.padStart(14, "0"),
      name: "Top-up product",
      status: "active",
      chzProductGroupCode: 8,
      boxCapacity: 12,
    });
    const created = await agent
      .post("/shifts")
      .send({ productId, mode: "aggregation" })
      .expect(201);
    const shiftId = created.body.id as string;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);
    const device = await createTestStationDevice(app!, agent, "Top-up device", { kind });
    await request(app!.getHttpServer())
      .post(`/shifts/${shiftId}/enter`)
      .set("x-api-key", device.apiKey)
      .send({ entryMethod: "list" })
      .expect(200);
    return { agent, tenantId, shiftId, device };
  }

  it("gives an entered device the exact box-only response without another block while 2000 remain", async () => {
    const { shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const bundle = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const response = await request(server)
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(Object.keys(response.body).sort()).toEqual(["blocks", "issuerProblem", "revokedFrom"]);
    expect(response.body).toEqual({
      blocks: [bundle.body.sscc],
      revokedFrom: [],
      issuerProblem: null,
    });
  });

  it("rejects a non-participant without reserving a block", async () => {
    const { agent, tenantId, shiftId } = await activeShift();
    const other = await createTestStationDevice(app!, agent, "Unentered station");
    await request(app!.getHttpServer())
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", other.apiKey)
      .expect(403);
    const rows = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, other.deviceId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("accepts a handheld participant through the same device contract", async () => {
    const { shiftId, device } = await activeShift("handheld");
    const response = await request(app!.getHttpServer())
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(response.body.blocks).toHaveLength(1);
    expect(response.body.blocks[0].extensionDigit).toBe(0);
  });

  it("returns no grant once the participating shift is no longer active", async () => {
    const { tenantId, shiftId, device } = await activeShift();
    await db
      .update(schema.shifts)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, shiftId)));
    const response = await request(app!.getHttpServer())
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(response.body).toEqual({ blocks: [], revokedFrom: [], issuerProblem: null });
  });

  it("does not let a cabinet session or another tenant reserve this device's block", async () => {
    const { agent, tenantId, shiftId, device } = await activeShift();
    await agent.post(`/shifts/${shiftId}/sscc/top-up`).expect(403);
    const foreignAgent = request.agent(app!.getHttpServer());
    await signUpAndActivate(foreignAgent);
    const foreignDevice = await createTestStationDevice(
      app!,
      foreignAgent,
      "Foreign top-up device",
    );
    await request(app!.getHttpServer())
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", foreignDevice.apiKey)
      .expect(404);
    const rows = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("reserves exactly one ahead block at 400 server-unconsumed serials", async () => {
    const { tenantId, shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const firstBundle = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const first = firstBundle.body.sscc as {
      issuerPrefix: string;
      fromSerial: number;
      toSerial: number;
    };
    const [block] = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
          eq(schema.ssccBlocks.fromSerial, first.fromSerial),
        ),
      );
    expect(block).toBeDefined();
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: first.toSerial - 401 })
      .where(eq(schema.ssccBlocks.id, block!.id));

    const at401 = await request(server)
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(at401.body.blocks).toHaveLength(1);
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: first.toSerial - 400 })
      .where(eq(schema.ssccBlocks.id, block!.id));

    const [at400, parallel] = await Promise.all([
      request(server).post(`/shifts/${shiftId}/sscc/top-up`).set("x-api-key", device.apiKey),
      request(server).post(`/shifts/${shiftId}/sscc/top-up`).set("x-api-key", device.apiKey),
    ]);
    expect(at400.status).toBe(200);
    expect(parallel.status).toBe(200);
    expect(at400.body.blocks).toHaveLength(2);
    expect(parallel.body.blocks).toEqual(at400.body.blocks);
    expect(at400.body.blocks).toEqual([
      { ...first, consumedThroughSerial: first.toSerial - 400, extensionDigit: 0 },
      {
        issuerPrefix: first.issuerPrefix,
        extensionDigit: 0,
        fromSerial: first.toSerial + 1,
        toSerial: first.toSerial + 2000,
        consumedThroughSerial: null,
      },
    ]);
    const repeated = await request(server)
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(repeated.body.blocks).toEqual(at400.body.blocks);
    const rows = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
        ),
      );
    expect(rows).toHaveLength(2);
  });

  it("serializes a top-up racing a bundle refresh for the same device", async () => {
    const { tenantId, shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const first = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: first.body.sscc.toSerial - 400 })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
          eq(schema.ssccBlocks.fromSerial, first.body.sscc.fromSerial),
        ),
      );
    const [topUp, bundle] = await Promise.all([
      request(server).post(`/shifts/${shiftId}/sscc/top-up`).set("x-api-key", device.apiKey),
      request(server).get(`/shifts/${shiftId}/bundle`).set("x-api-key", device.apiKey),
    ]);
    expect(topUp.status).toBe(200);
    expect(bundle.status).toBe(200);
    expect(topUp.body.blocks).toHaveLength(2);
    // Either request may acquire the stream lock first. Both bundle versions
    // are valid during the race; a settled refresh must see the successor.
    expect(topUp.body.blocks).toContainEqual(bundle.body.sscc);
    const settledBundle = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(settledBundle.body.sscc).toEqual(topUp.body.blocks[1]);
    const rows = await db
      .select({ extensionDigit: schema.ssccBlocks.extensionDigit })
      .from(schema.ssccBlocks)
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
        ),
      );
    expect(rows).toEqual([{ extensionDigit: 0 }, { extensionDigit: 0 }]);
  });

  it("gives two participating devices disjoint box ranges without allocating pallets", async () => {
    const { agent, tenantId, shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const handheld = await createTestStationDevice(app!, agent, "Handheld top-up", {
      kind: "handheld",
    });
    await request(server)
      .post(`/shifts/${shiftId}/enter`)
      .set("x-api-key", handheld.apiKey)
      .send({ entryMethod: "list" })
      .expect(200);
    const first = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const second = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", handheld.apiKey)
      .expect(200);
    expect(first.body.sscc.toSerial).toBeLessThan(second.body.sscc.fromSerial);
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: sql`${schema.ssccBlocks.toSerial} - 400` })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          inArray(schema.ssccBlocks.deviceId, [device.deviceId, handheld.deviceId]),
          eq(schema.ssccBlocks.extensionDigit, 0),
        ),
      );
    const [stationTopUp, handheldTopUp] = await Promise.all([
      request(server).post(`/shifts/${shiftId}/sscc/top-up`).set("x-api-key", device.apiKey),
      request(server).post(`/shifts/${shiftId}/sscc/top-up`).set("x-api-key", handheld.apiKey),
    ]);
    expect(stationTopUp.status).toBe(200);
    expect(handheldTopUp.status).toBe(200);
    expect(stationTopUp.body.blocks).toHaveLength(2);
    expect(handheldTopUp.body.blocks).toHaveLength(2);
    const all = [...stationTopUp.body.blocks, ...handheldTopUp.body.blocks] as Array<{
      fromSerial: number;
      toSerial: number;
      extensionDigit: number;
    }>;
    expect(all.every((block) => block.extensionDigit === 0)).toBe(true);
    const sorted = all.sort((a, b) => a.fromSerial - b.fromSerial);
    for (let index = 1; index < sorted.length; index++) {
      expect(sorted[index]!.fromSerial).toBeGreaterThan(sorted[index - 1]!.toSerial);
    }
    const palletRows = await db
      .select({ id: schema.ssccBlocks.id })
      .from(schema.ssccBlocks)
      .where(
        and(eq(schema.ssccBlocks.tenantId, tenantId), eq(schema.ssccBlocks.extensionDigit, 1)),
      );
    expect(palletRows).toHaveLength(0);
  });

  it("returns its existing range without advancing the counter when global capacity is exhausted", async () => {
    const { tenantId, shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const bundle = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const first = bundle.body.sscc as {
      issuerPrefix: string;
      fromSerial: number;
      toSerial: number;
    };
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: first.toSerial - 400 })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
          eq(schema.ssccBlocks.fromSerial, first.fromSerial),
        ),
      );
    await db
      .update(schema.ssccCounters)
      .set({ nextSerial: 10_000_000 })
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, first.issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    const response = await request(server)
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(response.body.blocks).toEqual([
      { ...first, extensionDigit: 0, consumedThroughSerial: first.toSerial - 400 },
    ]);
    const [counter] = await db
      .select({ nextSerial: schema.ssccCounters.nextSerial })
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, first.issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    expect(counter?.nextSerial).toBe(10_000_000);
  });

  it("reserves only the remaining serial space for a terminal partial block", async () => {
    const { tenantId, shiftId, device } = await activeShift();
    const server = app!.getHttpServer();
    const bundle = await request(server)
      .get(`/shifts/${shiftId}/bundle`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    const first = bundle.body.sscc as {
      issuerPrefix: string;
      fromSerial: number;
      toSerial: number;
    };
    await db
      .update(schema.ssccBlocks)
      .set({ consumedThroughSerial: first.toSerial - 400 })
      .where(
        and(
          eq(schema.ssccBlocks.tenantId, tenantId),
          eq(schema.ssccBlocks.deviceId, device.deviceId),
          eq(schema.ssccBlocks.fromSerial, first.fromSerial),
        ),
      );
    await db
      .update(schema.ssccCounters)
      .set({ nextSerial: 9_999_500 })
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, first.issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    const response = await request(server)
      .post(`/shifts/${shiftId}/sscc/top-up`)
      .set("x-api-key", device.apiKey)
      .expect(200);
    expect(response.body.blocks[1]).toEqual({
      issuerPrefix: first.issuerPrefix,
      extensionDigit: 0,
      fromSerial: 9_999_500,
      toSerial: 9_999_999,
      consumedThroughSerial: null,
    });
    const [counter] = await db
      .select({ nextSerial: schema.ssccCounters.nextSerial })
      .from(schema.ssccCounters)
      .where(
        and(
          eq(schema.ssccCounters.tenantId, tenantId),
          eq(schema.ssccCounters.issuerPrefix, first.issuerPrefix),
          eq(schema.ssccCounters.extensionDigit, 0),
        ),
      );
    expect(counter?.nextSerial).toBe(10_000_000);
  });
});
