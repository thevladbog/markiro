import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildDuplicateLabelTemplate,
  canonicalizeKm,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  PRODUCT_LABEL_PROTOCOL,
  productLabelValueDigest,
  validationPrintPolicySchema,
  type ProductLabelEvent,
  type ProductLabelReceipt,
} from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { syncBatchSchema } from "../src/modules/station-scans/dto";
import { stationScansBodyParser } from "../src/modules/station-scans/body-parser";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
describe.skipIf(!ready)("station product label events", () => {
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
  const receipt = (
    accepted: ProductLabelEvent[],
    rejected: ProductLabelReceipt["quarantined"] = [],
  ): ProductLabelReceipt => ({
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: accepted.map((e) => e.eventId),
    quarantined: rejected,
  });

  it("accepts the scan and prepared fact atomically with exact device, operator and immutable audit fields", async () => {
    const f = await fixture();
    const body = batch([f.prepared], [f.item]);
    expect((await send(body)).body).toEqual({
      applied: 1,
      alreadyApplied: false,
      conflicts: [],
      productLabelReceipt: receipt([f.prepared]),
    });
    const rows = await db
      .select()
      .from(schema.productLabelEvents)
      .where(
        and(
          eq(schema.productLabelEvents.tenantId, tenantId),
          eq(schema.productLabelEvents.jobId, f.prepared.jobId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      deviceId: station.deviceId,
      eventId: f.prepared.eventId,
      jobId: f.prepared.jobId,
      sequence: 1,
      operatorId,
      event: f.prepared,
      payloadDigest: productLabelValueDigest(f.prepared),
      receiveStatus: "accepted",
      reasonCode: null,
    });
    expect((await send(body)).body).toEqual({
      applied: 0,
      alreadyApplied: true,
      conflicts: [],
      productLabelReceipt: receipt([f.prepared]),
    });
    expect((await send(batch([f.prepared]))).body.productLabelReceipt).toEqual(
      receipt([f.prepared]),
    );
    expect(
      await db
        .select()
        .from(schema.scanEvents)
        .where(
          and(eq(schema.scanEvents.tenantId, tenantId), eq(schema.scanEvents.shiftId, f.shiftId)),
        ),
    ).toHaveLength(1);
  });

  it("accepts event-only batches and a later verification without changing accepted unit counts", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    const printing = batch([f.sending, f.sent]);
    await send(printing);
    await agent.post(`/shifts/${f.shiftId}/close`).send({ reason: "finished" }).expect(200);
    expect((await send(batch([f.verified]))).body.productLabelReceipt).toEqual(
      receipt([f.verified]),
    );
    expect((await send(printing)).body.productLabelReceipt).toEqual(receipt([f.sending, f.sent]));
    const [job] = await db
      .select()
      .from(schema.productLabelJobs)
      .where(
        and(
          eq(schema.productLabelJobs.tenantId, tenantId),
          eq(schema.productLabelJobs.jobId, f.prepared.jobId),
        ),
      );
    expect(job?.projection).toMatchObject({
      latestSequence: 4,
      status: "completed",
      verificationOutcome: "verified",
    });
    expect(
      await db
        .select()
        .from(schema.codes)
        .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.shiftId, f.shiftId))),
    ).toHaveLength(1);
    const [shift] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, f.shiftId));
    expect(shift?.lateDataAt).not.toBeNull();
  });

  it("does not mark a closed shift as late data for an already received event replayed in a new batch", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    await agent.post(`/shifts/${f.shiftId}/close`).send({ reason: "finished" }).expect(200);
    await send(batch([f.prepared]));
    const [shift] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, f.shiftId));
    expect(shift?.lateDataAt).toBeNull();
  });

  it("accepts all 100 bounded events and rejects duplicate event IDs before storage", async () => {
    const f = await fixture();
    const rejectedScans: ProductLabelEvent[] = Array.from({ length: 96 }, (_, index) => ({
      ...f.sending,
      eventId: randomUUID(),
      sequence: index + 4,
      kind: "verification_rejected",
      reason: "mismatch",
    }));
    const events = [
      f.prepared,
      f.sending,
      f.sent,
      ...rejectedScans,
      { ...f.verified, sequence: 100 },
    ];
    expect((await send(batch(events, [f.item]))).body.productLabelReceipt).toEqual(receipt(events));
    await send(
      batch([...events, { ...f.sending, eventId: randomUUID(), sequence: 101 }]),
      station,
      400,
    );
    await send(batch([f.prepared, f.prepared]), station, 400);
  });

  it("rejects changed batch contents and reuse of an event ID with a different payload", async () => {
    const f = await fixture();
    const body = batch([f.prepared], [f.item]);
    await send(body);
    await send(
      { ...body, productLabelEvents: [{ ...f.prepared, bytesDigest: "b".repeat(64) }] },
      station,
      409,
    );
    const altered = batch([{ ...f.prepared, bytesDigest: "b".repeat(64) }]);
    expect((await send(altered, station, 409)).body.code).toBe("product_label_event_mismatch");
    expect(
      await db
        .select()
        .from(schema.syncBatches)
        .where(
          and(
            eq(schema.syncBatches.tenantId, tenantId),
            eq(schema.syncBatches.batchId, altered.batchId),
          ),
        ),
    ).toHaveLength(0);
  });

  it.each(["parent", "policy", "crypto", "operator", "sequence", "dpi"])(
    "quarantines invalid %s facts while preserving other jobs",
    async (kind) => {
      const bad = await fixture();
      const good = await fixture();
      let event: ProductLabelEvent = bad.prepared;
      if (kind === "policy") event = { ...event, policyRevision: randomUUID() };
      if (kind === "crypto")
        event = {
          ...event,
          payloadDigest: duplicatePayloadDigest(bad.item.raw.replace("tail", "fail")),
        };
      if (kind === "operator") event = { ...event, operatorId: randomUUID() };
      if (kind === "sequence") event = { ...event, sequence: 2 };
      if (kind === "dpi") event = { ...event, dpi: 300 };
      const code =
        kind === "parent"
          ? "parent_missing"
          : kind === "sequence"
            ? "sequence_gap"
            : kind === "operator"
              ? "invalid_transition"
              : "policy_mismatch";
      const body = batch(
        [event, good.prepared],
        [...(kind === "parent" ? [] : [bad.item]), good.item],
      );
      expect((await send(body)).body.productLabelReceipt).toEqual(
        receipt([good.prepared], [{ eventId: event.eventId, code }]),
      );
      const [quarantine] = await db
        .select()
        .from(schema.stationSyncQuarantine)
        .where(
          and(
            eq(schema.stationSyncQuarantine.tenantId, tenantId),
            eq(schema.stationSyncQuarantine.batchId, body.batchId),
          ),
        );
      expect(quarantine).toMatchObject({
        tenantId,
        terminalId: station.deviceId,
        batchId: body.batchId,
        recordKind: "product_label_event",
        recordIndex: 0,
        shiftId: bad.shiftId,
        reason: code,
        payload: event,
      });
      expect(
        await db
          .select()
          .from(schema.productLabelJobs)
          .where(
            and(
              eq(schema.productLabelJobs.tenantId, tenantId),
              eq(schema.productLabelJobs.jobId, bad.prepared.jobId),
            ),
          ),
      ).toHaveLength(0);
    },
  );

  it("keeps a rejected event's receipt stable after its parent arrives in a different batch", async () => {
    const f = await fixture();
    const expected = receipt([], [{ eventId: f.prepared.eventId, code: "parent_missing" }]);
    expect((await send(batch([f.prepared]))).body.productLabelReceipt).toEqual(expected);
    expect((await send(batch([f.prepared], [f.item]))).body.productLabelReceipt).toEqual(expected);
    expect((await send(batch([f.sending]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: f.sending.eventId, code: "sequence_gap" }]),
    );
  });

  it("does not allow another authenticated device to attach to an accepted scan", async () => {
    const f = await fixture();
    await send(batch([], [f.item]));
    expect((await send(batch([f.prepared]), otherStation)).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: f.prepared.eventId, code: "parent_missing" }]),
    );
  });

  it("retains losing ownership as a rejected physical fact", async () => {
    const f = await fixture();
    await send(
      batch(
        [],
        [{ ...f.item, scannedAt: new Date(Date.parse(f.item.scannedAt) - 1000).toISOString() }],
      ),
      otherStation,
    );
    expect((await send(batch([f.prepared], [f.item]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: f.prepared.eventId, code: "ownership_conflict" }]),
    );
  });

  it("keeps pre-feature batch digest replay compatible when the new channel is empty", async () => {
    const f = await fixture();
    const parsed = syncBatchSchema.parse({ batchId: `old:${randomUUID()}`, items: [f.item] });
    const { productLabelEvents, ...legacy } = parsed;
    expect(productLabelEvents).toEqual([]);
    const bound = {
      ...legacy,
      items: legacy.items.map((item) => ({ ...item, terminalId: station.deviceId })),
    };
    await db.insert(schema.syncBatches).values({
      tenantId,
      batchId: parsed.batchId,
      terminalId: station.deviceId,
      payloadDigest: productLabelValueDigest(bound),
      result: { applied: 1, alreadyApplied: false, conflicts: [] },
    });
    expect((await send({ batchId: parsed.batchId, items: [f.item] })).body).toEqual({
      applied: 0,
      alreadyApplied: true,
      conflicts: [],
    });
  });

  it("quarantines a foreign-tenant reference without losing a valid job in the same batch", async () => {
    const f = await fixture();
    const foreignAgent = request.agent(app.getHttpServer());
    const foreignTenantId = await signUpAndActivate(foreignAgent);
    const foreignDevice = await createTestStationDevice(app, foreignAgent, "Foreign");
    const body = batch([f.prepared]);
    expect((await send(body, foreignDevice)).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: f.prepared.eventId, code: "parent_missing" }]),
    );
    expect(
      await db
        .select()
        .from(schema.productLabelJobs)
        .where(eq(schema.productLabelJobs.tenantId, foreignTenantId)),
    ).toHaveLength(0);
    const invalid = {
      ...f.prepared,
      eventId: randomUUID(),
      jobId: randomUUID(),
      shiftId: randomUUID(),
    };
    expect((await send(batch([invalid, f.prepared], [f.item]))).body.productLabelReceipt).toEqual(
      receipt([f.prepared], [{ eventId: invalid.eventId, code: "parent_missing" }]),
    );
  });

  it("does not change a known job's origin or apply a stale attempt over a verified one", async () => {
    const f = await fixture();
    const other = await fixture();
    await send(batch([f.prepared, f.sending, f.sent, f.verified], [f.item]));
    const forged = { ...other.prepared, jobId: f.prepared.jobId };
    expect((await send(batch([forged], [other.item]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: forged.eventId, code: "invalid_transition" }]),
    );
    const stale = { ...f.sent, sequence: 5, eventId: randomUUID() };
    expect((await send(batch([stale]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: stale.eventId, code: "invalid_transition" }]),
    );
    const [job] = await db
      .select()
      .from(schema.productLabelJobs)
      .where(eq(schema.productLabelJobs.jobId, f.prepared.jobId));
    expect(job?.projection).toMatchObject({ latestSequence: 4, verificationOutcome: "verified" });
  });

  it("atomically rolls back other scans and jobs when an event-ID payload collision occurs", async () => {
    const original = await fixture();
    const later = await fixture();
    await send(batch([original.prepared], [original.item]));
    const altered = { ...original.prepared, bytesDigest: "b".repeat(64) };
    await send(batch([later.prepared, altered], [later.item]), station, 409);
    expect(
      await db
        .select()
        .from(schema.codes)
        .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.shiftId, later.shiftId))),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.productLabelJobs)
        .where(eq(schema.productLabelJobs.jobId, later.prepared.jobId)),
    ).toHaveLength(0);
  });

  it("serializes concurrent delivery of the same immutable event in separate batches", async () => {
    const f = await fixture();
    await send(batch([], [f.item]));
    const replies = await Promise.all([send(batch([f.prepared])), send(batch([f.prepared]))]);
    for (const reply of replies)
      expect(reply.body.productLabelReceipt).toEqual(receipt([f.prepared]));
    expect(
      await db
        .select()
        .from(schema.productLabelEvents)
        .where(eq(schema.productLabelEvents.jobId, f.prepared.jobId)),
    ).toHaveLength(1);
  });

  it("does not create a second original job for the same accepted unit", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    const duplicate = {
      ...f.prepared,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
    };
    expect((await send(batch([duplicate]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: duplicate.eventId, code: "invalid_transition" }]),
    );
  });

  it("finds the matching full scan among other accepted scans with the same timestamp", async () => {
    const f = await fixture();
    const shortKm = canonicalizeKm(`010460000000001521SHORT${randomUUID().slice(0, 8)}`);
    const unrelated = {
      ...f.item,
      raw: shortKm.raw,
      code: { codeHash: kmHash(shortKm), gtin14: shortKm.gtin14, serial: shortKm.serial },
    };
    expect((await send(batch([f.prepared], [unrelated, f.item]))).body.productLabelReceipt).toEqual(
      receipt([f.prepared]),
    );
  });

  it("preserves the event as quarantine if ownership changes after prepared was received", async () => {
    const f = await fixture();
    await send(batch([f.prepared], [f.item]));
    await send(
      batch(
        [],
        [{ ...f.item, scannedAt: new Date(Date.parse(f.item.scannedAt) - 1000).toISOString() }],
      ),
      otherStation,
    );
    const body = batch([f.sending, f.sent]);
    expect((await send(body)).body.productLabelReceipt).toEqual(
      receipt(
        [],
        [f.sending, f.sent].map((event) => ({
          eventId: event.eventId,
          code: "ownership_conflict",
        })),
      ),
    );
    expect(
      await db
        .select()
        .from(schema.stationSyncQuarantine)
        .where(
          and(
            eq(schema.stationSyncQuarantine.tenantId, tenantId),
            eq(schema.stationSyncQuarantine.batchId, body.batchId),
          ),
        ),
    ).toHaveLength(2);
    const [job] = await db
      .select()
      .from(schema.productLabelJobs)
      .where(eq(schema.productLabelJobs.jobId, f.prepared.jobId));
    expect(job?.latestSequence).toBe(1);
  });

  it("records an explicit reprint and a different verifying operator without erasing the original verification", async () => {
    const f = await fixture();
    await send(batch([f.prepared, f.sending, f.sent, f.verified], [f.item]));
    const secondOperatorId = randomUUID();
    await db
      .insert(schema.employees)
      .values({ id: secondOperatorId, tenantId, fullName: "Сменщик" });
    const attemptId = randomUUID();
    const next = [
      { ...f.prepared, sequence: 5, attemptNo: 2, reason: "damaged" as const },
      { ...f.sending, sequence: 6 },
      { ...f.sent, sequence: 7 },
      { ...f.verified, sequence: 8 },
    ].map((event) => ({
      ...event,
      eventId: randomUUID(),
      attemptId,
      operatorId: secondOperatorId,
    }));
    expect((await send(batch(next))).body.productLabelReceipt).toEqual(receipt(next));
    const facts = await db
      .select()
      .from(schema.productLabelEvents)
      .where(eq(schema.productLabelEvents.jobId, f.prepared.jobId))
      .orderBy(schema.productLabelEvents.sequence);
    expect(facts[3]).toMatchObject({ operatorId, event: f.verified });
    expect(facts[7]).toMatchObject({ operatorId: secondOperatorId, event: next[3] });
    const reused = {
      ...f.prepared,
      eventId: randomUUID(),
      sequence: 9,
      attemptNo: 3,
      reason: "lost" as const,
    };
    expect((await send(batch([reused]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: reused.eventId, code: "invalid_transition" }]),
    );
  });

  it("quarantines ineligible label events with their denied parent and keeps the receipt stable after renewal", async () => {
    const bad = await fixture();
    const good = await fixture();
    const endsAt = new Date(Date.now() - 60_000);
    await db
      .update(schema.shifts)
      .set({ openedAt: new Date(endsAt.getTime() - 1000) })
      .where(eq(schema.shifts.id, good.shiftId));
    const planVersionId = await createPublishedPlan(db, {
      maxLines: null,
      maxStations: null,
      maxKiosks: null,
      maxCabinetUsers: null,
      labelEditorEnabled: true,
      publicApiEnabled: true,
      palletsEnabled: true,
    });
    const subscription = await createManagedSubscription(db, {
      tenantId,
      planVersionId,
      startsAt: new Date(endsAt.getTime() - 86_400_000),
      endsAt,
    });
    try {
      const body = batch([bad.prepared, good.prepared], [bad.item, good.item]);
      expect((await send(body)).body.productLabelReceipt).toEqual(
        receipt(
          [good.prepared],
          [{ eventId: bad.prepared.eventId, code: "subscription_read_only" }],
        ),
      );
      const denied = await db
        .select()
        .from(schema.stationSyncQuarantine)
        .where(
          and(
            eq(schema.stationSyncQuarantine.tenantId, tenantId),
            eq(schema.stationSyncQuarantine.batchId, body.batchId),
          ),
        );
      expect(denied.map((row) => row.recordKind).sort()).toEqual(["item", "product_label_event"]);
    } finally {
      await db
        .update(schema.tenantSubscriptions)
        .set({ endsAt: new Date(Date.now() + 86_400_000) })
        .where(eq(schema.tenantSubscriptions.id, subscription.subscriptionId));
    }
    expect((await send(batch([bad.prepared], [bad.item]))).body.productLabelReceipt).toEqual(
      receipt([], [{ eventId: bad.prepared.eventId, code: "subscription_read_only" }]),
    );
  });
});
