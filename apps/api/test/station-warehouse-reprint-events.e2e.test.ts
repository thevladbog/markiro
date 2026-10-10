import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@markiro/db";
import {
  warehousePreparedEvent,
  warehouseLookupResultSchema,
  warehouseTemplateCatalogSchema,
  type WarehouseReprintEvent,
} from "@markiro/domain";
import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
// setupWarehouseApi binds the server once through listenOnLoopback.
import {
  setupWarehouseApi,
  WAREHOUSE_TEST_KM,
  WAREHOUSE_TEST_SSCC,
} from "./support/warehouse-reprint";
import { WarehouseEventsService } from "../src/modules/station-warehouse-reprint/events.service";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";
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
  it("accepts raster prepared events and replays their original receipt", async () => {
    const { language, ...base } = prepared;
    void language;
    const event = {
      ...base,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      sessionId: randomUUID(),
      printFormat: "mono-raster-v1" as const,
    };
    const first = await post([event]).expect(200);
    expect(first.body.acceptedEventIds).toEqual([event.eventId]);
    expect(first.body.quarantined).toEqual([]);
    expect((await post([event]).expect(200)).body).toEqual(first.body);
  });
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
      expect(
        audit.find(
          (a) =>
            typeof a.after === "object" &&
            a.after !== null &&
            "eventId" in a.after &&
            a.after.eventId === event.eventId,
        ),
      ).toMatchObject({
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
  it("receives an offline print after template edits, box disassembly and operator deactivation", async () => {
    const [template] = await h.db
      .select()
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.id, h.boxTemplateId));
    if (!template) throw new Error("fixture template missing");
    const p = { ...prepared, eventId: randomUUID(), jobId: randomUUID(), attemptId: randomUUID() };
    const base = {
      jobId: p.jobId,
      sessionId: p.sessionId,
      attemptId: p.attemptId,
      operatorId: p.operatorId,
      occurredAt: p.occurredAt,
    };
    const events: WarehouseReprintEvent[] = [
      p,
      { ...base, kind: "sending", sequence: 2, eventId: randomUUID() },
      { ...base, kind: "sent", sequence: 3, eventId: randomUUID() },
    ];
    await h.db
      .update(schema.labelTemplates)
      .set({
        enabled: false,
        name: "Edited after print",
        purpose: "product_duplicate",
        chzProductGroupCodes: [15],
        updatedAt: new Date(),
      })
      .where(eq(schema.labelTemplates.id, p.templateId));
    await h.db
      .update(schema.boxes)
      .set({ disassembledAt: new Date() })
      .where(eq(schema.boxes.id, h.boxId));
    await h.db
      .update(schema.operatorCredentials)
      .set({ active: false })
      .where(eq(schema.operatorCredentials.employeeId, p.operatorId));
    await h.db
      .update(schema.employees)
      .set({ status: "archived" })
      .where(eq(schema.employees.id, p.operatorId));
    try {
      const result = (await post(events).expect(200)).body;
      expect(result.quarantined).toEqual([]);
      expect(result.acceptedEventIds).toEqual(events.map((e) => e.eventId));
      expect((await post(events).expect(200)).body).toEqual(result);
      const [saved] = await h.db
        .select()
        .from(schema.warehouseReprintJobs)
        .where(eq(schema.warehouseReprintJobs.jobId, p.jobId));
      expect(saved?.prepared).toEqual(p);
      expect(saved?.projection).toMatchObject({ state: "sent", latestSequence: 3 });
      const audit = await h.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, p.jobId));
      expect(audit).toHaveLength(3);
      expect(audit.find((a) => a.action === "warehouse_label.sent")).toMatchObject({
        organizationId: h.a.tenantId,
        actorUserId: null,
        outcome: "accepted",
        targetId: p.jobId,
        after: expect.objectContaining({
          deviceId: h.a.deviceId,
          operatorId: p.operatorId,
          templateDigest: p.templateDigest,
          bytesDigest: p.bytesDigest,
        }),
      });
      await h.lookup(h.a.apiKey, p.operatorId, `00${p.identity}`).expect(403);
    } finally {
      await h.db
        .update(schema.labelTemplates)
        .set({
          enabled: template.enabled,
          name: template.name,
          purpose: template.purpose,
          chzProductGroupCodes: template.chzProductGroupCodes,
          updatedAt: template.updatedAt,
        })
        .where(eq(schema.labelTemplates.id, p.templateId));
      await h.db
        .update(schema.boxes)
        .set({ disassembledAt: null })
        .where(eq(schema.boxes.id, h.boxId));
      await h.db
        .update(schema.operatorCredentials)
        .set({ active: true })
        .where(eq(schema.operatorCredentials.employeeId, p.operatorId));
      await h.db
        .update(schema.employees)
        .set({ status: "active" })
        .where(eq(schema.employees.id, p.operatorId));
    }
  });
  it("quarantines foreign source and template identities and changed payloads durably", async () => {
    const productId = randomUUID();
    const shiftId = randomUUID();
    const boxId = randomUUID();
    const templateId = randomUUID();
    const [template] = await h.db
      .select()
      .from(schema.labelTemplates)
      .where(eq(schema.labelTemplates.id, h.boxTemplateId));
    if (!template) throw new Error("fixture template missing");
    await h.db.insert(schema.products).values({
      id: productId,
      tenantId: h.b.tenantId,
      gtin14: "04600682000013",
      name: "Foreign product",
      shelfLifeDays: 100,
    });
    await h.db.insert(schema.shifts).values({
      id: shiftId,
      tenantId: h.b.tenantId,
      productId,
      status: "closed",
      mode: "validation",
      numberMonthKey: "OCT26",
      numberSeq: 1,
    });
    await h.db.insert(schema.boxes).values({
      id: boxId,
      tenantId: h.b.tenantId,
      shiftId,
      deviceBoxId: "foreign-box",
      terminalId: randomUUID(),
      sscc: WAREHOUSE_TEST_SSCC,
      closedAt: new Date(),
    });
    await h.db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId: h.b.tenantId,
      name: "Foreign template",
      purpose: "box",
      spec: template.spec,
    });
    const cases = [
      { change: { sourceId: boxId, sourceShiftId: shiftId }, code: "source_not_printable" },
      { change: { sourceShiftId: shiftId }, code: "source_not_printable" },
      { change: { payloadDigest: "0".repeat(64) }, code: "source_not_printable" },
      { change: { templateId }, code: "template_mismatch" },
    ];
    for (const { change, code } of cases) {
      const p = { ...prepared, ...change, eventId: randomUUID(), jobId: randomUUID() };
      const result = (await post([p]).expect(200)).body;
      expect(result).toEqual({
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: [],
        quarantined: [{ eventId: p.eventId, code }],
      });
      expect((await post([p]).expect(200)).body).toEqual(result);
      expect(
        await h.db
          .select()
          .from(schema.warehouseReprintJobs)
          .where(eq(schema.warehouseReprintJobs.jobId, p.jobId)),
      ).toEqual([]);
      const claims = await h.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, p.jobId));
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        organizationId: h.a.tenantId,
        actorUserId: null,
        action: "warehouse_label.prepared_claim",
        outcome: "quarantined",
        targetType: "warehouse_label_job",
        targetId: p.jobId,
        after: {
          deviceId: h.a.deviceId,
          operatorId: p.operatorId,
          eventId: p.eventId,
          rejectionCode: code,
          event: p,
        },
      });
    }
  });
  it("accepts a legacy device box ID without modifying the production box", async () => {
    const [box] = await h.db.select().from(schema.boxes).where(eq(schema.boxes.id, h.boxId));
    if (!box) throw new Error("fixture box missing");
    const p = {
      ...prepared,
      sourceId: box.deviceBoxId,
      eventId: randomUUID(),
      jobId: randomUUID(),
    };
    expect((await post([p]).expect(200)).body).toMatchObject({
      acceptedEventIds: [p.eventId],
      quarantined: [],
    });
    const [saved] = await h.db
      .select()
      .from(schema.warehouseReprintJobs)
      .where(eq(schema.warehouseReprintJobs.jobId, p.jobId));
    expect(saved?.prepared).toEqual(p);
    expect(await h.db.select().from(schema.boxes).where(eq(schema.boxes.id, h.boxId))).toEqual([
      box,
    ]);
  });
  it("ingests the original unit payload while rejecting other source IDs and payload digests", async () => {
    const result = warehouseLookupResultSchema.parse(
      (await h.lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM).expect(200)).body,
    );
    if (result.status !== "found") throw new Error("fixture unit missing");
    const catalog = warehouseTemplateCatalogSchema.parse(
      (
        await request(h.app.getHttpServer())
          .get("/station/warehouse-reprint/templates")
          .set("x-api-key", h.a.apiKey)
          .expect(200)
      ).body,
    );
    const template = catalog.templates.find((t) => t.id === h.unitTemplateId);
    if (!template) throw new Error("fixture unit template missing");
    const p: Extract<WarehouseReprintEvent, { kind: "prepared" }> = {
      ...prepared,
      eventId: randomUUID(),
      jobId: randomUUID(),
      sourceKind: "unit",
      sourceId: result.source.sourceId,
      identity: result.source.identity,
      sourceShiftId: result.source.sourceShiftId,
      sourceRevision: result.source.revision,
      payloadDigest: result.source.payloadDigest,
      templateId: template.id,
      templateRevision: template.revision,
      templateDigest: template.digest,
      repair: null,
    };
    const before = await h.db
      .select()
      .from(schema.codes)
      .where(eq(schema.codes.codeHash, h.codeHash));
    const registryScope = and(
      eq(schema.codeRegistry.tenantId, h.a.tenantId),
      eq(schema.codeRegistry.codeHash, h.codeHash),
    );
    const [registry] = await h.db.select().from(schema.codeRegistry).where(registryScope);
    if (!registry) throw new Error("fixture registry missing");
    // Disaggregation releases current ownership while the original scan remains durable.
    await h.db.delete(schema.codeRegistry).where(registryScope);
    try {
      expect((await post([p]).expect(200)).body).toMatchObject({
        acceptedEventIds: [p.eventId],
        quarantined: [],
      });
      for (const change of [
        { sourceId: randomUUID() },
        { payloadDigest: "0".repeat(64) },
        { sourceShiftId: randomUUID() },
      ]) {
        const bad = { ...p, ...change, eventId: randomUUID(), jobId: randomUUID() };
        expect((await post([bad]).expect(200)).body).toEqual({
          protocol: "warehouse-label-reprint-v1",
          acceptedEventIds: [],
          quarantined: [{ eventId: bad.eventId, code: "source_not_printable" }],
        });
      }
      const [saved] = await h.db
        .select()
        .from(schema.warehouseReprintJobs)
        .where(eq(schema.warehouseReprintJobs.jobId, p.jobId));
      expect(saved?.prepared).toEqual(p);
      expect(
        await h.db.select().from(schema.codes).where(eq(schema.codes.codeHash, h.codeHash)),
      ).toEqual(before);
      expect(await h.db.select().from(schema.codeRegistry).where(registryScope)).toEqual([]);
      await h
        .lookup(h.a.apiKey, h.a.operatorId, WAREHOUSE_TEST_KM)
        .expect(200, { status: "not_found" });
    } finally {
      await h.db.insert(schema.codeRegistry).values(registry);
    }
  });
  it("accepts a repack box's offline history after it has been invalidated", async () => {
    const [shift] = await h.db.select().from(schema.shifts).where(eq(schema.shifts.id, h.shiftId));
    const [member] = await h.db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, h.a.tenantId));
    if (!shift || !member) throw new Error("fixture parent missing");
    const line = randomUUID();
    await h.db
      .insert(schema.lines)
      .values({ id: line, tenantId: h.a.tenantId, name: "Warehouse history" });
    const inventoryId = await seedReportInventory(h.db, {
      tenant: h.a.tenantId,
      product: shift.productId,
      line,
      operator: h.a.operatorId,
      user: member.userId,
    });
    const [box] = await h.db
      .select()
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.inventoryId, inventoryId));
    if (!box) throw new Error("fixture repack missing");
    const p = {
      ...prepared,
      sourceId: box.id,
      sourceShiftId: null,
      identity: box.newSscc,
      payloadDigest: "5531bd10f465eb0e39dd60ab2c1497f2f809a5a214d1c682efc41e069416e219",
      eventId: randomUUID(),
      jobId: randomUUID(),
    };
    await h.db
      .update(schema.inventoryRepackBoxes)
      .set({
        state: "invalidated",
        invalidationSource: "admin",
        invalidatedAt: new Date(),
        printState: "not_ready",
        printAttemptCount: 0,
        printedAt: null,
      })
      .where(eq(schema.inventoryRepackBoxes.id, box.id));
    const [before] = await h.db
      .select()
      .from(schema.inventoryRepackBoxes)
      .where(eq(schema.inventoryRepackBoxes.id, box.id));
    expect((await post([p]).expect(200)).body).toMatchObject({
      acceptedEventIds: [p.eventId],
      quarantined: [],
    });
    expect(
      await h.db
        .select()
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, box.id)),
    ).toEqual([before]);
  });
  it("accepts history on a one-connection pool without nested database acquisition", async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("test DB missing");
    const { db, pool } = createDb(url, { max: 1 });
    pool.options.connectionTimeoutMillis = 300;
    try {
      const service = new WarehouseEventsService(db);
      const p = {
        ...prepared,
        eventId: randomUUID(),
        jobId: randomUUID(),
        attemptId: randomUUID(),
      };
      const result = await service.receive(h.a.tenantId, h.a.deviceId, [p]);
      expect(result).toMatchObject({ acceptedEventIds: [p.eventId], quarantined: [] });
    } finally {
      await pool.end();
    }
  });
});
