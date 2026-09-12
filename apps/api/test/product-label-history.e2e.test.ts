import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildDuplicateLabelTemplate,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  PRODUCT_LABEL_PROTOCOL,
  validationPrintPolicySchema,
  type ProductLabelEvent,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { stationScansBodyParser } from "../src/modules/station-scans/body-parser";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("product label history", () => {
  let app: INestApplication;
  let db: Db;
  let tenantId: string;
  let agent: ReturnType<typeof request.agent>;
  let station: Awaited<ReturnType<typeof createTestStationDevice>>;
  let otherStation: typeof station;
  let productId: string;
  let templateId: string;
  let operatorId: string;
  beforeAll(async () => {
    const env = loadEnv({ ...process.env, VALIDATION_DM_DUPLICATE_ENABLED: "true" });
    const setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(stationScansBodyParser);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    station = await createTestStationDevice(app, agent, "A");
    otherStation = await createTestStationDevice(app, agent, "B");
    productId = randomUUID();
    templateId = randomUUID();
    operatorId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600000000015",
      name: "Кега",
      status: "active",
    });
    await db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId,
      name: "Дубликат",
      purpose: "product_duplicate",
      spec: buildDuplicateLabelTemplate(),
    });
    await db.insert(schema.employees).values({ id: operatorId, tenantId, fullName: "Оператор" });
  });
  afterAll(async () => {
    await app?.close();
  });

  async function fixture() {
    const created = await agent
      .post("/shifts")
      .send({
        productId,
        mode: "validation",
        validationPrint: { mode: "duplicate_dm", verification: "required", templateId },
      })
      .expect(201);
    const shiftId: string = created.body.id;
    const opened = await agent.post(`/shifts/${shiftId}/open`).expect(200);
    const policy = validationPrintPolicySchema.parse(opened.body.validationPrint);
    if (policy.mode !== "duplicate_dm") throw new Error("fixture policy missing");
    const raw = `]d2010460000000001521S${randomUUID().slice(0, 8)}\u001d91Key1\u001d92Crypto(93)^FNC1tail`;
    const km = parseDuplicateKm(raw);
    const acceptedAt = new Date().toISOString();
    const prepared: ProductLabelEvent = {
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      sequence: 1,
      shiftId,
      codeHash: kmHash(km),
      acceptedAt,
      policyRevision: policy.policyRevision,
      templateDigest: policy.snapshot.digest,
      payloadDigest: duplicatePayloadDigest(km.raw),
      operatorId,
      occurredAt: acceptedAt,
      kind: "prepared",
      attemptNo: 1,
      reason: null,
      language: "zpl",
      dpi: 203,
      bytesDigest: "a".repeat(64),
    };
    const item = {
      shiftId,
      terminalId: "untrusted-local-id",
      raw,
      verdict: "ok",
      scannedAt: acceptedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId: null,
      operatorId,
    };
    const base = {
      eventId: randomUUID(),
      jobId: prepared.jobId,
      attemptId: prepared.attemptId,
      sequence: 2,
      shiftId,
      codeHash: prepared.codeHash,
      acceptedAt,
      policyRevision: prepared.policyRevision,
      templateDigest: prepared.templateDigest,
      payloadDigest: prepared.payloadDigest,
      operatorId,
      occurredAt: acceptedAt,
    };
    const sending: ProductLabelEvent = { ...base, kind: "sending" };
    const sent: ProductLabelEvent = { ...base, eventId: randomUUID(), sequence: 3, kind: "sent" };
    const verified: ProductLabelEvent = {
      ...base,
      eventId: randomUUID(),
      sequence: 4,
      kind: "verified",
      scannedPayloadDigest: prepared.payloadDigest,
    };
    return { prepared, sending, sent, verified, item, shiftId };
  }
  function send(body: object, device = station, status = 201) {
    return request(app.getHttpServer())
      .post("/station/scans")
      .set("x-api-key", device.apiKey)
      .set("x-station-capabilities", PRODUCT_LABEL_PROTOCOL)
      .send(body)
      .expect(status);
  }
  const batch = (events: ProductLabelEvent[], items: unknown[] = []) => ({
    batchId: `labels:${randomUUID()}`,
    items,
    productLabelEvents: events,
  });

  it("persists an explicit skip once and exposes its actor without increasing verified totals", async () => {
    const f = await fixture();
    const skip: ProductLabelEvent = {
      ...f.sent,
      eventId: randomUUID(),
      sequence: 4,
      kind: "verification_skipped",
    };
    const events = [f.prepared, f.sending, f.sent, skip];
    await send(batch(events, [f.item]));
    await send(batch([skip]));
    const history = await agent.get(`/shifts/${f.shiftId}/product-labels`).expect(200);
    expect(history.body.summary).toMatchObject({
      sentAttempts: 1,
      verifiedAttempts: 0,
      unresolvedJobs: 0,
    });
    expect(history.body.items[0]).toMatchObject({
      jobId: skip.jobId,
      deviceId: station.deviceId,
      status: "completed",
      verificationOutcome: "skipped",
    });
    const saved = await db
      .select()
      .from(schema.productLabelEvents)
      .where(
        and(
          eq(schema.productLabelEvents.tenantId, tenantId),
          eq(schema.productLabelEvents.eventId, skip.eventId),
        ),
      );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      tenantId,
      deviceId: station.deviceId,
      jobId: skip.jobId,
      receiveStatus: "accepted",
      event: skip,
    });
    const foreign = await send(batch([skip]), otherStation);
    expect(foreign.body.productLabelReceipt).toEqual({
      protocol: PRODUCT_LABEL_PROTOCOL,
      acceptedEventIds: [],
      quarantined: [{ eventId: skip.eventId, code: "parent_missing" }],
    });
  });

  it("counts attempts separately from units and pages accepted events without raw labels", async () => {
    const f = await fixture();
    await send(batch([f.prepared, f.sending, f.sent], [f.item]));
    const second: ProductLabelEvent = {
      ...f.prepared,
      eventId: randomUUID(),
      attemptId: randomUUID(),
      sequence: 4,
      attemptNo: 2,
      reason: "damaged",
    };
    const send2: ProductLabelEvent = {
      ...f.sending,
      eventId: randomUUID(),
      attemptId: second.attemptId,
      sequence: 5,
    };
    const sent2: ProductLabelEvent = {
      ...f.sent,
      eventId: randomUUID(),
      attemptId: second.attemptId,
      sequence: 6,
    };
    const verified2: ProductLabelEvent = {
      ...f.verified,
      eventId: randomUUID(),
      attemptId: second.attemptId,
      sequence: 7,
    };
    const secondBatch = batch([second, send2, sent2, verified2]);
    await send(secondBatch);
    await send(secondBatch);
    const body = (await agent.get(`/shifts/${f.shiftId}/product-labels?limit=1`).expect(200)).body;
    expect(body.summary).toEqual({
      sentAttempts: 2,
      verifiedAttempts: 1,
      unresolvedJobs: 0,
      reprintAttempts: 1,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      jobId: f.prepared.jobId,
      deviceId: station.deviceId,
      attemptNo: 2,
      verificationOutcome: "verified",
      ownershipConflict: false,
    });
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain(f.item.raw);
    expect(JSON.stringify(body)).not.toContain("Crypto");
    const first = (
      await agent
        .get(`/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events?limit=3`)
        .expect(200)
    ).body;
    expect(first.items).toEqual([f.prepared, f.sending, f.sent]);
    expect(first.nextSequence).toBe(3);
    const rest = (
      await agent
        .get(
          `/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events?afterSequence=3&limit=100`,
        )
        .expect(200)
    ).body;
    expect(rest.items.map((e: ProductLabelEvent) => e.sequence)).toEqual([4, 5, 6, 7]);
    expect(rest.nextSequence).toBeNull();
    const summary = (await agent.get(`/shifts/${f.shiftId}/summary`).expect(200)).body;
    expect(summary.output.acceptedUnits).toBe(1);
  });
  it("enforces cabinet, tenant, shift and device boundaries and validates cursors", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    const foreign = request.agent(app.getHttpServer());
    await signUpAndActivate(foreign);
    await foreign.get(`/shifts/${f.shiftId}/product-labels`).expect(404);
    await foreign.get(`/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events`).expect(404);
    await agent
      .get(`/shifts/${randomUUID()}/product-labels/${f.prepared.jobId}/events`)
      .expect(404);
    await agent
      .get(
        `/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events?deviceId=${otherStation.deviceId}`,
      )
      .expect(404);
    await request(app.getHttpServer())
      .get(`/shifts/${f.shiftId}/product-labels`)
      .set("x-api-key", station.apiKey)
      .expect(403);
    for (const query of ["limit=0", "limit=101", "cursor=bad", "limit=1.2"])
      await agent.get(`/shifts/${f.shiftId}/product-labels?${query}`).expect(400);
  });
  it("paginates colliding device-local IDs without mixing devices", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    const [original] = await db
      .select()
      .from(schema.productLabelJobs)
      .where(
        and(
          eq(schema.productLabelJobs.tenantId, tenantId),
          eq(schema.productLabelJobs.jobId, f.prepared.jobId),
        ),
      );
    if (!original) throw new Error("job missing");
    await db
      .insert(schema.productLabelJobs)
      .values({ ...original, deviceId: otherStation.deviceId });
    const first = (await agent.get(`/shifts/${f.shiftId}/product-labels?limit=1`).expect(200)).body;
    const second = (
      await agent
        .get(
          `/shifts/${f.shiftId}/product-labels?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
        .expect(200)
    ).body;
    expect(first.items[0].deviceId).not.toBe(second.items[0].deviceId);
    expect(second.nextCursor).toBeNull();
    await agent.get(`/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events`).expect(404);
    const scoped = (
      await agent
        .get(
          `/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events?deviceId=${station.deviceId}`,
        )
        .expect(200)
    ).body;
    expect(scoped.items).toEqual([f.prepared]);
  });
  it("shows an ownership rejection without counting rejected transport as a successful print", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    await send(
      batch(
        [],
        [{ ...f.item, scannedAt: new Date(Date.parse(f.item.scannedAt) - 1000).toISOString() }],
      ),
      otherStation,
    );
    await send(batch([f.sending, f.sent]));
    const body = (await agent.get(`/shifts/${f.shiftId}/product-labels`).expect(200)).body;
    expect(body.summary).toEqual({
      sentAttempts: 0,
      verifiedAttempts: 0,
      unresolvedJobs: 1,
      reprintAttempts: 0,
    });
    expect(body.items[0].ownershipConflict).toBe(true);
    expect(
      (
        await agent
          .get(`/shifts/${f.shiftId}/product-labels/${f.prepared.jobId}/events`)
          .expect(200)
      ).body.items,
    ).toEqual([f.prepared]);
  });
});
