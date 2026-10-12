import request from "supertest";
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
          eq(schema.tenantAuditEvents.action, "pallet_label.reprinted"),
        ),
      );
    expect(audit).toHaveLength(3);
    expect(audit).toContainEqual(
      expect.objectContaining({
        actorUserId: null,
        outcome: "accepted",
        targetType: "pallet",
        targetId: palletId,
        after: { deviceId: h.a.deviceId, ...verified },
      }),
    );
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
