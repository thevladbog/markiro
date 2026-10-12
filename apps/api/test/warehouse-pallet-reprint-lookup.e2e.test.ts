import request from "supertest";
import { createTestStationDevice } from "./support/auth";
// setupWarehouseApi binds the server once through listenOnLoopback.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  palletCompositionDigest,
  makePalletLabelSource,
  palletLabelFields,
  buildPalletLabelTemplates,
  PALLET_REPRINT_PROTOCOL,
} from "@markiro/domain";
import {
  setupWarehouseApi,
  WAREHOUSE_TEST_KM,
  WAREHOUSE_TEST_SSCC,
} from "./support/warehouse-reprint";
describe.skipIf(!process.env.DATABASE_URL)("Station pallet reprint source", () => {
  let h: Awaited<ReturnType<typeof setupWarehouseApi>>;
  const palletId = randomUUID(),
    sscc = "146000000000001231";
  beforeAll(async () => {
    h = await setupWarehouseApi();
    await h.db.insert(schema.pallets).values({
      id: palletId,
      tenantId: h.a.tenantId,
      shiftId: h.shiftId,
      terminalId: h.a.deviceId,
      devicePalletId: "local-pallet",
      sscc,
      closedAt: new Date("2026-10-08T13:00:00Z"),
      printVerifiedAt: new Date("2026-10-08T13:01:00Z"),
    });
    await h.db.update(schema.boxes).set({ palletId }).where(eq(schema.boxes.id, h.boxId));
  });
  afterAll(async () => {
    await h?.close();
  });
  const post = (key: string, path: string, body: object) =>
    request(h.app.getHttpServer())
      .post(`/station/warehouse-reprint/${path}`)
      .set("x-api-key", key)
      .send(body);
  it("uploads idempotently and finds the same production pallet by pallet, box and complete KM", async () => {
    const template = buildPalletLabelTemplates()[0];
    if (!template) throw new Error("template missing");
    const source = makePalletLabelSource({
      version: 1,
      sscc,
      shiftId: h.shiftId,
      closedAt: "2026-10-08T13:00:00.000Z",
      boxCount: 1,
      itemCount: 1,
      boxSsccs: [WAREHOUSE_TEST_SSCC],
      compositionDigest: palletCompositionDigest([
        {
          boxSscc: WAREHOUSE_TEST_SSCC,
          codeHash: h.codeHash,
          acceptedAt: "2026-10-08T10:00:00.000Z",
        },
      ]),
      rendering: {
        kind: "thermal",
        rendererVersion: "thermal-v1",
        template: template.spec,
        brandingJson: null,
        fields: palletLabelFields({
          sscc,
          productName: "Original",
          productPrintName: null,
          gtin14: "04600682000013",
          egaisCode: null,
          shelfLifeDays: 1,
          operatorName: null,
          counterpartyName: null,
          productionDate: "2026-10-08",
          shiftNumber: null,
          boxCount: 1,
          itemCount: 1,
          closedAt: "2026-10-08T13:00:00Z",
        }),
      },
    });
    const body = { protocol: PALLET_REPRINT_PROTOCOL, entries: [source] };
    await post(h.a.apiKey, "pallet-sources", body).expect(200);
    await post(h.a.apiKey, "pallet-sources", body).expect(200);
    for (const raw of [sscc, `]C100${WAREHOUSE_TEST_SSCC}`, WAREHOUSE_TEST_KM]) {
      const result = await post(h.a.apiKey, "pallet-lookup", {
        protocol: PALLET_REPRINT_PROTOCOL,
        operatorId: h.a.operatorId,
        raw,
      }).expect(200);
      expect(result.body).toEqual({ status: "found", source });
    }
    expect(
      (
        await post(h.b.apiKey, "pallet-lookup", {
          protocol: PALLET_REPRINT_PROTOCOL,
          operatorId: h.b.operatorId,
          raw: sscc,
        }).expect(200)
      ).body.status,
    ).toBe("not_found");
    await h.a.cabinet
      .post("/station/warehouse-reprint/pallet-lookup")
      .send({ protocol: PALLET_REPRINT_PROTOCOL, operatorId: h.a.operatorId, raw: sscc })
      .expect(403);
    const lookupPallet = async () =>
      (
        await post(h.a.apiKey, "pallet-lookup", {
          protocol: PALLET_REPRINT_PROTOCOL,
          operatorId: h.a.operatorId,
          raw: sscc,
        }).expect(200)
      ).body;
    await h.db
      .update(schema.pallets)
      .set({ printVerifiedAt: null })
      .where(eq(schema.pallets.id, palletId));
    expect(await lookupPallet()).toEqual({ status: "unavailable", code: "delivery_unresolved" });
    const delivery = {
      sourceRevision: source.revision,
      sequence: 1,
      attemptId: "original-send",
      bytesDigest: "d".repeat(64),
      state: "sent",
      occurredAt: "2026-10-11T00:00:00.000Z",
    };
    const uploadDelivery = async (proof: typeof delivery) =>
      (await post(h.a.apiKey, "pallet-sources", { ...body, productionDelivery: proof }).expect(200))
        .body.results[0].status;
    expect(await uploadDelivery(delivery)).toBe("accepted");
    expect(await lookupPallet()).toEqual({ status: "found", source });
    expect(
      (
        await h.db
          .select({ printVerifiedAt: schema.pallets.printVerifiedAt })
          .from(schema.pallets)
          .where(eq(schema.pallets.id, palletId))
      )[0]?.printVerifiedAt,
    ).toBeNull();
    const unknown = {
      ...delivery,
      sequence: 2,
      state: "delivery_unknown",
      occurredAt: "2026-10-11T00:01:00.000Z",
    };
    await h.db
      .update(schema.pallets)
      .set({ printVerifiedAt: new Date("2026-10-08T13:01:00Z") })
      .where(eq(schema.pallets.id, palletId));
    expect(await uploadDelivery(unknown)).toBe("accepted");
    expect(await lookupPallet()).toEqual({ status: "unavailable", code: "delivery_unresolved" });
    expect(await uploadDelivery(delivery)).toBe("accepted");
    expect(await lookupPallet()).toEqual({ status: "unavailable", code: "delivery_unresolved" });
    expect(await uploadDelivery({ ...unknown, state: "sent" })).toBe("conflict");
    expect(await lookupPallet()).toEqual({ status: "unavailable", code: "delivery_unresolved" });
    await h.db
      .update(schema.pallets)
      .set({ printVerifiedAt: new Date("2026-10-11T00:02:00Z") })
      .where(eq(schema.pallets.id, palletId));
    expect(await lookupPallet()).toEqual({ status: "found", source });
    const restored = { ...delivery, sequence: 3, occurredAt: "2026-10-11T00:03:00.000Z" };
    expect(await uploadDelivery(restored)).toBe("accepted");
    expect(await lookupPallet()).toEqual({ status: "found", source });
    expect(await uploadDelivery({ ...delivery, state: "delivery_unknown" })).toBe("conflict");
    const otherDevice = await createTestStationDevice(
      h.app,
      h.a.cabinet,
      "Other pallet source device",
    );
    const foreignOrigin = await post(otherDevice.apiKey, "pallet-sources", {
      ...body,
      productionDelivery: { ...restored, sequence: 4, state: "delivery_unknown" },
    }).expect(200);
    expect(foreignOrigin.body.results).toEqual([{ revision: source.revision, status: "conflict" }]);
    expect(await lookupPallet()).toEqual({ status: "found", source });
    expect(
      await h.db
        .select()
        .from(schema.palletProductionDeliveries)
        .where(
          and(
            eq(schema.palletProductionDeliveries.tenantId, h.a.tenantId),
            eq(schema.palletProductionDeliveries.sscc, sscc),
          ),
        ),
    ).toHaveLength(3);
    const palletState = await h.db
      .select({ printVerifiedAt: schema.pallets.printVerifiedAt })
      .from(schema.pallets)
      .where(eq(schema.pallets.id, palletId));
    expect(palletState[0]?.printVerifiedAt?.toISOString()).toBe("2026-10-11T00:02:00.000Z");
    const failedDelivery = {
      ...delivery,
      sequence: 4,
      state: "failed_before_send",
      occurredAt: "2026-10-11T00:04:00.000Z",
    };
    expect(await uploadDelivery(failedDelivery)).toBe("accepted");
    expect(await lookupPallet()).toEqual({ status: "unavailable", code: "delivery_unresolved" });
    await h.db
      .update(schema.pallets)
      .set({ printSkippedAt: new Date("2026-10-11T00:05:00Z") })
      .where(eq(schema.pallets.id, palletId));
    expect(await lookupPallet()).toEqual({ status: "found", source });
    const event = {
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      sscc,
      sourceRevision: source.revision,
      operatorId: h.a.operatorId,
      reason: "damaged",
      occurredAt: "2026-10-11T00:00:00.000Z",
      state: "prepared",
      printFormat: "zpl",
      bytesDigest: "b".repeat(64),
    };
    const sendEvent = async (value: typeof event) =>
      post(h.a.apiKey, "pallet-events", {
        protocol: PALLET_REPRINT_PROTOCOL,
        entries: [value],
      }).expect(200);
    expect((await sendEvent(event)).body.results).toEqual([
      { eventId: event.eventId, status: "accepted" },
    ]);
    expect((await sendEvent(event)).body.results).toEqual([
      { eventId: event.eventId, status: "accepted" },
    ]);
    const sent = {
      ...event,
      eventId: randomUUID(),
      state: "sent",
      occurredAt: "2026-10-11T00:00:01.000Z",
    };
    expect((await sendEvent(sent)).body.results[0].status).toBe("accepted");
    const incompatible = {
      ...sent,
      eventId: randomUUID(),
      state: "failed_before_send",
      occurredAt: "2026-10-11T00:00:02.000Z",
    };
    expect((await sendEvent(incompatible)).body.results[0].status).toBe("conflict");
    const verified = {
      ...sent,
      eventId: randomUUID(),
      state: "verified",
      occurredAt: "2026-10-11T00:00:03.000Z",
    };
    expect((await sendEvent(verified)).body.results[0].status).toBe("accepted");
    const audit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, h.a.tenantId),
          eq(schema.tenantAuditEvents.targetId, palletId),
        ),
      );
    expect(audit.filter((row) => row.action.startsWith("pallet_label."))).toHaveLength(3);
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "pallet_label.prepared",
        "pallet_label.sent",
        "pallet_label.verified",
      ]),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        actorUserId: null,
        outcome: "accepted",
        targetType: "pallet",
        targetId: palletId,
        after: { deviceId: h.a.deviceId, ...verified },
      }),
    );
    const rejectedPrepared = {
      ...event,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      operatorId: randomUUID(),
    };
    const validPrepared = {
      ...event,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
    };
    const mixed = await post(h.a.apiKey, "pallet-events", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [rejectedPrepared, validPrepared],
    }).expect(200);
    expect(mixed.body.results).toEqual([
      { eventId: rejectedPrepared.eventId, status: "conflict" },
      { eventId: validPrepared.eventId, status: "accepted" },
    ]);
    expect((await sendEvent(rejectedPrepared)).body.results[0].status).toBe("conflict");
    const orphan = {
      ...rejectedPrepared,
      operatorId: h.a.operatorId,
      eventId: randomUUID(),
      state: "sent",
    };
    expect((await sendEvent(orphan)).body.results[0].status).toBe("conflict");
    const outOfOrder = {
      ...event,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      state: "sent",
    };
    expect((await sendEvent(outOfOrder)).body.results[0].status).toBe("retryable");
    const failed = {
      ...validPrepared,
      eventId: randomUUID(),
      state: "failed_before_send",
      occurredAt: "2026-10-11T00:00:01.000Z",
    };
    expect((await sendEvent(failed)).body.results[0].status).toBe("accepted");
    const failedAudit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, h.a.tenantId),
          eq(schema.tenantAuditEvents.action, "pallet_label.failed_before_send"),
        ),
      );
    expect(failedAudit).toEqual([
      expect.objectContaining({
        actorUserId: null,
        outcome: "accepted",
        targetType: "pallet",
        targetId: palletId,
        after: { deviceId: h.a.deviceId, ...failed },
      }),
    ]);
    const mismatched = {
      ...event,
      eventId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      sourceRevision: "f".repeat(64),
    };
    expect((await sendEvent(mismatched)).body.results[0].status).toBe("conflict");
    expect(
      (
        await sendEvent({
          ...mismatched,
          eventId: randomUUID(),
          state: "sent",
          sourceRevision: source.revision,
        })
      ).body.results[0].status,
    ).toBe("conflict");
    const noResource = await post(h.b.apiKey, "pallet-events", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [{ ...event, eventId: randomUUID(), operatorId: h.b.operatorId }],
    }).expect(200);
    expect(noResource.body.results[0].status).toBe("retryable");
    await h.a.cabinet
      .post("/station/warehouse-reprint/pallet-events")
      .send({ protocol: PALLET_REPRINT_PROTOCOL, entries: [event] })
      .expect(403);
    await h.db
      .update(schema.pallets)
      .set({ disassembledAt: new Date() })
      .where(and(eq(schema.pallets.id, palletId), eq(schema.pallets.tenantId, h.a.tenantId)));
    expect(
      (
        await post(h.a.apiKey, "pallet-lookup", {
          protocol: PALLET_REPRINT_PROTOCOL,
          operatorId: h.a.operatorId,
          raw: sscc,
        }).expect(200)
      ).body.status,
    ).toBe("unavailable");
  });
});
