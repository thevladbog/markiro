import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  warehousePreparedEvent,
  warehouseLookupResultSchema,
  warehouseTemplateCatalogSchema,
  type WarehouseReprintEvent,
} from "@markiro/domain";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
// setupWarehouseApi binds the server once through listenOnLoopback.
import { setupWarehouseApi, WAREHOUSE_TEST_SSCC } from "./support/warehouse-reprint";
const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
describe.skipIf(!ready)("warehouse event history", () => {
  let h: Awaited<ReturnType<typeof setupWarehouseApi>>;
  let prepared: Extract<WarehouseReprintEvent, { kind: "prepared" }>;
  const post = (events: WarehouseReprintEvent[]) =>
    request(h.app.getHttpServer())
      .post("/station/warehouse-reprint/event-batches")
      .set("x-api-key", h.a.apiKey)
      .send({ protocol: "warehouse-label-reprint-v1", events });
  beforeAll(async () => {
    h = await setupWarehouseApi();
    const result = warehouseLookupResultSchema.parse(
      (await h.lookup(h.a.apiKey, h.a.operatorId, `!100${WAREHOUSE_TEST_SSCC}`)).body,
    );
    if (result.status !== "found") throw new Error("fixture source");
    const catalog = warehouseTemplateCatalogSchema.parse(
      (
        await request(h.app.getHttpServer())
          .get("/station/warehouse-reprint/templates")
          .set("x-api-key", h.a.apiKey)
      ).body,
    );
    const t = catalog.templates.find((t) => t.id === h.boxTemplateId);
    if (!t) throw new Error("fixture template");
    prepared = {
      ...warehousePreparedEvent(),
      eventId: randomUUID(),
      jobId: randomUUID(),
      sessionId: randomUUID(),
      attemptId: randomUUID(),
      operatorId: h.a.operatorId,
      sourceId: result.source.sourceId,
      sourceRevision: result.source.revision,
      sourceShiftId: h.shiftId,
      templateId: t.id,
      templateRevision: t.revision,
      templateDigest: t.digest,
      payloadDigest: result.source.payloadDigest,
      repair: result.repair,
    };
  });
  afterAll(async () => h?.close());
  it("replays exact receipts and audit without touching production facts", async () => {
    const tail = (kind: "sending" | "sent", sequence: number): WarehouseReprintEvent => ({
      kind,
      eventId: randomUUID(),
      jobId: prepared.jobId,
      sessionId: prepared.sessionId,
      attemptId: prepared.attemptId,
      operatorId: h.a.operatorId,
      occurredAt: prepared.occurredAt,
      sequence,
    });
    const events = [prepared, tail("sending", 2), tail("sent", 3)];
    const before = await h.db.select().from(schema.boxes).where(eq(schema.boxes.id, h.boxId));
    const first = await post(events).expect(200);
    expect(first.body).toEqual({
      protocol: "warehouse-label-reprint-v1",
      acceptedEventIds: events.map((e) => e.eventId),
      quarantined: [],
    });
    expect((await post(events).expect(200)).body).toEqual(first.body);
    const audit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, prepared.jobId));
    expect(audit).toHaveLength(3);
    for (const event of events) {
      expect(audit.find((a) => a.action === `warehouse_label.${event.kind}`)).toMatchObject({
        organizationId: h.a.tenantId,
        actorUserId: null,
        outcome: "accepted",
        targetType: "warehouse_label_job",
        targetId: prepared.jobId,
        after: expect.objectContaining({
          deviceId: h.a.deviceId,
          operatorId: h.a.operatorId,
          eventId: event.eventId,
          sequence: event.sequence,
          sourceId: prepared.sourceId,
          templateDigest: prepared.templateDigest,
          repair: prepared.repair,
          scanDigest: prepared.scanDigest,
          reason: prepared.reason,
          attemptId: event.attemptId,
        }),
      });
    }
    expect(JSON.stringify(audit)).not.toContain("crypto");
    expect(await h.db.select().from(schema.boxes).where(eq(schema.boxes.id, h.boxId))).toEqual(
      before,
    );
    await post([{ ...prepared, reason: "lost" }]).expect(409);
  });
  it("durably quarantines gaps, missing parents and foreign operators", async () => {
    const gap: WarehouseReprintEvent = {
      kind: "verified",
      eventId: randomUUID(),
      jobId: prepared.jobId,
      sessionId: prepared.sessionId,
      attemptId: prepared.attemptId,
      operatorId: h.a.operatorId,
      sequence: 9,
      occurredAt: prepared.occurredAt,
    };
    const receipt = await post([gap]).expect(200);
    expect(receipt.body.quarantined).toEqual([{ eventId: gap.eventId, code: "sequence_gap" }]);
    expect((await post([gap]).expect(200)).body).toEqual(receipt.body);
    const foreign = {
      ...prepared,
      eventId: randomUUID(),
      jobId: randomUUID(),
      operatorId: h.b.operatorId,
    };
    expect((await post([foreign]).expect(200)).body.quarantined).toEqual([
      { eventId: foreign.eventId, code: "invalid_operator" },
    ]);
    const missing = { ...gap, eventId: randomUUID(), jobId: randomUUID(), sequence: 2 };
    expect((await post([missing]).expect(200)).body.quarantined).toEqual([
      { eventId: missing.eventId, code: "parent_missing" },
    ]);
  });
  it("accepts interrupted sending and recovery after template archive", async () => {
    const p = { ...prepared, eventId: randomUUID(), jobId: randomUUID(), attemptId: randomUUID() };
    const base = {
      jobId: p.jobId,
      sessionId: p.sessionId,
      attemptId: p.attemptId,
      operatorId: p.operatorId,
      occurredAt: p.occurredAt,
    };
    await post([p, { ...base, kind: "sending", sequence: 2, eventId: randomUUID() }]).expect(200);
    await h.db
      .update(schema.labelTemplates)
      .set({ enabled: false })
      .where(eq(schema.labelTemplates.id, p.templateId));
    try {
      const unknown: WarehouseReprintEvent = {
        ...base,
        kind: "delivery_unknown",
        sequence: 3,
        eventId: randomUUID(),
        errorCode: "interrupted",
      };
      const verify: WarehouseReprintEvent = {
        ...base,
        kind: "verified",
        sequence: 4,
        eventId: randomUUID(),
      };
      expect((await post([unknown, verify]).expect(200)).body.acceptedEventIds).toEqual([
        unknown.eventId,
        verify.eventId,
      ]);
    } finally {
      await h.db
        .update(schema.labelTemplates)
        .set({ enabled: true })
        .where(eq(schema.labelTemplates.id, p.templateId));
    }
  });
  it("audits the explicit retry reason on every event of that attempt", async () => {
    const p = {
      ...prepared,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      reason: "damaged" as const,
    };
    const next = randomUUID();
    const base = {
      jobId: p.jobId,
      sessionId: p.sessionId,
      operatorId: p.operatorId,
      occurredAt: p.occurredAt,
    };
    const events: WarehouseReprintEvent[] = [
      p,
      { ...base, attemptId: p.attemptId, kind: "sending", sequence: 2, eventId: randomUUID() },
      { ...base, attemptId: p.attemptId, kind: "sent", sequence: 3, eventId: randomUUID() },
      {
        ...base,
        attemptId: next,
        kind: "reprint_prepared",
        attemptNo: 2,
        reason: "lost",
        sequence: 4,
        eventId: randomUUID(),
      },
      { ...base, attemptId: next, kind: "sending", sequence: 5, eventId: randomUUID() },
      { ...base, attemptId: next, kind: "sent", sequence: 6, eventId: randomUUID() },
      { ...base, attemptId: next, kind: "verified", sequence: 7, eventId: randomUUID() },
    ];
    expect((await post(events).expect(200)).body.acceptedEventIds).toEqual(
      events.map((e) => e.eventId),
    );
    const audit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, p.jobId));
    for (const event of events)
      expect(audit.find((a) => a.after?.eventId === event.eventId)).toMatchObject({
        organizationId: h.a.tenantId,
        actorUserId: null,
        action: `warehouse_label.${event.kind}`,
        outcome: "accepted",
        targetType: "warehouse_label_job",
        targetId: p.jobId,
        after: expect.objectContaining({
          deviceId: h.a.deviceId,
          operatorId: h.a.operatorId,
          eventId: event.eventId,
          sequence: event.sequence,
          attemptId: event.attemptId,
          attemptNo: event.sequence < 4 ? 1 : 2,
          reason: event.sequence < 4 ? "damaged" : "lost",
        }),
      });
  });
});
