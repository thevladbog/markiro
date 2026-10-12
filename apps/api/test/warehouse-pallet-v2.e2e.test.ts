import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestStationDevice } from "./support/auth";
import { schema, createDb } from "@markiro/db";
import { eq } from "drizzle-orm";
import {
  PALLET_REPRINT_V2_PROTOCOL,
  PALLET_REPRINT_PROTOCOL,
  makePalletLabelSource,
  makePalletRenderingV2,
  palletCompositionDigest,
  palletLabelFields,
  buildPalletLabelTemplates,
  productLabelValueDigest,
} from "@markiro/domain";
// setupWarehouseApi binds the server once through listenOnLoopback.
import { setupWarehouseApi, WAREHOUSE_TEST_SSCC } from "./support/warehouse-reprint";
const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("pallet reprint V2 admission", () => {
  const databaseName = `markiro_pallet_api_v2_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${databaseName}`;
  url.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid").pool;
  let created = false,
    h: Awaited<ReturnType<typeof setupWarehouseApi>>;
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const migration = createDb(url.toString());
    try {
      await migrate(migration.db, {
        migrationsFolder: resolve(process.cwd(), "../../packages/db/migrations"),
      });
    } finally {
      await migration.pool.end();
    }
    h = await setupWarehouseApi(url.toString());
  }, 180000);
  afterAll(async () => {
    if (h) await h.app.close();
    if (created) await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });
  it("keeps V1 and exposes V2, freezes a selected rendering and audits exact event provenance", async () => {
    const capabilities = await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/source-capabilities")
      .set("X-Api-Key", h.a.apiKey)
      .expect(200);
    expect(capabilities.body.protocols).toContain(PALLET_REPRINT_V2_PROTOCOL);
    const sscc = "146000000000001231",
      palletId = randomUUID();
    await h.db.insert(schema.pallets).values({
      id: palletId,
      tenantId: h.a.tenantId,
      shiftId: h.shiftId,
      terminalId: h.a.deviceId,
      devicePalletId: "v2-pallet",
      sscc,
      closedAt: new Date("2026-10-08T13:00:00Z"),
      printVerifiedAt: new Date("2026-10-08T13:01:00Z"),
    });
    await h.db.update(schema.boxes).set({ palletId }).where(eq(schema.boxes.id, h.boxId));
    const template = buildPalletLabelTemplates()[0];
    if (!template) throw new Error("Missing template");
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
          productName: "Historical",
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
    const post = (key: string, path: string, body: object) =>
      request(h.app.getHttpServer())
        .post(`/station/warehouse-reprint/${path}`)
        .set("X-Api-Key", key)
        .send(body);
    await post(h.a.apiKey, "pallet-sources", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [source],
    }).expect(200);
    const templateId = randomUUID();
    await h.db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId: h.a.tenantId,
      name: "Selected",
      purpose: "pallet",
      spec: template.spec,
    });
    const rendering = makePalletRenderingV2(source, {
        kind: "thermal",
        id: templateId,
        name: "Selected",
        snapshot: template.spec,
        snapshotDigest: productLabelValueDigest(template.spec),
      }),
      jobId = randomUUID();
    const body = {
      protocol: PALLET_REPRINT_V2_PROTOCOL,
      entries: [{ jobId, operatorId: h.a.operatorId, rendering }],
    };
    expect((await post(h.a.apiKey, "pallet-renderings-v2", body).expect(200)).body.results).toEqual(
      [{ jobId, renderingRevision: rendering.renderingRevision, status: "accepted" }],
    );
    expect(
      (await post(h.a.apiKey, "pallet-renderings-v2", body).expect(200)).body.results[0].status,
    ).toBe("accepted");
    const event = {
      eventId: randomUUID(),
      jobId,
      attemptId: randomUUID(),
      sscc,
      sourceRevision: source.revision,
      renderingRevision: rendering.renderingRevision,
      operatorId: h.a.operatorId,
      reason: "damaged",
      occurredAt: "2026-10-12T00:00:00.000Z",
      state: "prepared",
      printFormat: "zpl",
      bytesDigest: "b".repeat(64),
    };
    expect(
      (
        await post(h.a.apiKey, "pallet-events-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          entries: [event],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("accepted");
    const catalog = await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/pallet-templates-v2")
      .set("X-Api-Key", h.a.apiKey)
      .expect(200);
    expect(catalog.body.templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: templateId, kind: "thermal" })]),
    );
    const foreignTemplateId = randomUUID();
    await h.db.insert(schema.labelTemplates).values({
      id: foreignTemplateId,
      tenantId: h.b.tenantId,
      name: "Foreign",
      purpose: "pallet",
      spec: template.spec,
    });
    const foreignRendering = makePalletRenderingV2(source, {
      kind: "thermal",
      id: foreignTemplateId,
      name: "Foreign",
      snapshot: template.spec,
      snapshotDigest: productLabelValueDigest(template.spec),
    });
    expect(
      (
        await post(h.a.apiKey, "pallet-renderings-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          entries: [
            { jobId: randomUUID(), operatorId: h.a.operatorId, rendering: foreignRendering },
          ],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    const renamed = makePalletRenderingV2(source, {
      kind: "thermal",
      id: templateId,
      name: "Changed",
      snapshot: template.spec,
      snapshotDigest: productLabelValueDigest(template.spec),
    });
    expect(
      (
        await post(h.a.apiKey, "pallet-renderings-v2", {
          ...body,
          entries: [{ jobId, operatorId: h.a.operatorId, rendering: renamed }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    expect(
      (
        await post(h.a.apiKey, "pallet-events-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          entries: [{ ...event, eventId: randomUUID(), jobId: randomUUID() }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("retryable");
    expect(
      (
        await post(h.a.apiKey, "pallet-events-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          entries: [
            { ...event, eventId: randomUUID(), renderingRevision: renamed.renderingRevision },
          ],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    if (source.rendering.kind !== "thermal") throw new Error("Expected thermal source");
    const otherSource = makePalletLabelSource({
      version: source.version,
      shiftId: source.shiftId,
      closedAt: source.closedAt,
      boxCount: source.boxCount,
      itemCount: source.itemCount,
      compositionDigest: source.compositionDigest,
      boxSsccs: source.boxSsccs,
      originalAttempt: source.originalAttempt,
      sscc: "146000000000001248",
      rendering: {
        ...source.rendering,
        fields: { ...source.rendering.fields, sscc: "146000000000001248" },
      },
    });
    await h.db.insert(schema.palletLabelSources).values({
      tenantId: h.a.tenantId,
      sscc: otherSource.sscc,
      palletId,
      sourceDeviceId: h.a.deviceId,
      revision: otherSource.revision,
      value: otherSource,
    });
    const substitutedJobId = randomUUID();
    await post(h.a.apiKey, "pallet-renderings-v2", {
      ...body,
      entries: [{ jobId: substitutedJobId, operatorId: h.a.operatorId, rendering }],
    }).expect(200);
    const substituted = {
      ...event,
      jobId: substitutedJobId,
      eventId: randomUUID(),
      sscc: otherSource.sscc,
      sourceRevision: otherSource.revision,
    };
    const valid = event;
    expect(
      (
        await post(h.a.apiKey, "pallet-events-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          entries: [substituted, valid],
        }).expect(200)
      ).body.results,
    ).toEqual([
      { eventId: substituted.eventId, status: "conflict" },
      { eventId: valid.eventId, status: "accepted" },
    ]);
    await h.db
      .update(schema.labelTemplates)
      .set({ enabled: false })
      .where(eq(schema.labelTemplates.id, templateId));
    expect(
      (
        await post(h.a.apiKey, "pallet-renderings-v2", {
          ...body,
          entries: [{ jobId: randomUUID(), operatorId: h.a.operatorId, rendering }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("accepted");
    const audits = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, palletId));
    expect(audits.filter((row) => row.action === "pallet_label.prepared")).toMatchObject([
      {
        organizationId: h.a.tenantId,
        actorUserId: null,
        action: "pallet_label.prepared",
        outcome: "accepted",
        targetType: "pallet",
        targetId: palletId,
        after: {
          deviceId: h.a.deviceId,
          ...event,
          templateId,
          templateName: "Selected",
          templateKind: "thermal",
        },
      },
    ]);
    expect(
      (
        await post(h.b.apiKey, "pallet-renderings-v2", {
          ...body,
          entries: [{ jobId: randomUUID(), operatorId: h.b.operatorId, rendering }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("retryable");
    await h.a.cabinet
      .post("/station/warehouse-reprint/pallet-renderings-v2")
      .send(body)
      .expect(403);
    await h.db
      .update(schema.pallets)
      .set({ printVerifiedAt: null })
      .where(eq(schema.pallets.id, palletId));
    const delivery = {
      sourceRevision: source.revision,
      sequence: 1,
      attemptId: "original-unknown",
      bytesDigest: "d".repeat(64),
      state: "delivery_unknown",
      occurredAt: "2026-10-12T00:00:00.000Z",
    };
    await post(h.a.apiKey, "pallet-sources", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [source],
      productionDelivery: delivery,
    }).expect(200);
    const diagnostic = (
      await post(h.a.apiKey, "pallet-lookup-v2", {
        protocol: PALLET_REPRINT_V2_PROTOCOL,
        operatorId: h.a.operatorId,
        raw: sscc,
      }).expect(200)
    ).body;
    expect(diagnostic).toMatchObject({
      status: "unavailable",
      code: "delivery_unresolved",
      diagnostic: {
        sscc,
        attemptId: delivery.attemptId,
        productionSequence: 1,
        kind: "delivery_unknown",
        originDeviceId: h.a.deviceId,
      },
    });
    const resolution = {
      eventId: randomUUID(),
      sscc,
      sourceRevision: source.revision,
      attemptId: delivery.attemptId,
      productionSequence: 1,
      operatorId: h.a.operatorId,
      reason: "not_printed",
      occurredAt: "2026-10-12T00:01:00.000Z",
      outcome: "confirmed",
      scannedSscc: sscc,
    };
    const other = await createTestStationDevice(h.app, h.a.cabinet, "Other station");
    expect(
      (
        await post(other.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [{ ...resolution, eventId: randomUUID() }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    await h.db
      .update(schema.operatorCredentials)
      .set({ active: false })
      .where(eq(schema.operatorCredentials.employeeId, h.a.operatorId));
    expect(
      (
        await post(h.a.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [{ ...resolution, eventId: randomUUID() }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    await post(h.a.apiKey, "pallet-lookup-v2", {
      protocol: PALLET_REPRINT_V2_PROTOCOL,
      operatorId: h.a.operatorId,
      raw: sscc,
    }).expect(403);
    await h.db
      .update(schema.operatorCredentials)
      .set({ active: true })
      .where(eq(schema.operatorCredentials.employeeId, h.a.operatorId));
    await h.db
      .update(schema.stationDevices)
      .set({ kind: "handheld" })
      .where(eq(schema.stationDevices.id, other.deviceId));
    await request(h.app.getHttpServer())
      .get("/station/warehouse-reprint/pallet-templates-v2")
      .set("X-Api-Key", other.apiKey)
      .expect(403);
    await post(other.apiKey, "pallet-events-v2", {
      protocol: PALLET_REPRINT_V2_PROTOCOL,
      entries: [event],
    }).expect(403);
    const aheadResolution = {
      ...resolution,
      attemptId: "next-original-unknown",
      productionSequence: 2,
    };
    expect(
      (
        await post(h.a.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [aheadResolution],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("retryable");
    expect(
      (
        await post(h.b.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [{ ...resolution, eventId: randomUUID(), operatorId: h.b.operatorId }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("retryable");
    await post(h.a.apiKey, "pallet-sources", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [source],
      productionDelivery: { ...delivery, attemptId: aheadResolution.attemptId, sequence: 2 },
    }).expect(200);
    expect(
      (
        await post(h.a.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [{ ...resolution, eventId: randomUUID() }],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");
    expect(
      (
        await post(h.a.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [aheadResolution],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("accepted");
    expect(
      (
        await post(h.a.apiKey, "pallet-lookup-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          operatorId: h.a.operatorId,
          raw: sscc,
        }).expect(200)
      ).body.status,
    ).toBe("found");
    const resolutionAudits = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, palletId));
    expect(
      resolutionAudits.filter((row) => row.action === "pallet_production.confirmed"),
    ).toMatchObject([
      {
        organizationId: h.a.tenantId,
        actorUserId: null,
        action: "pallet_production.confirmed",
        outcome: "accepted",
        targetType: "pallet",
        targetId: palletId,
        after: { deviceId: h.a.deviceId, ...aheadResolution },
      },
    ]);
    await post(h.a.apiKey, "pallet-sources", {
      protocol: PALLET_REPRINT_PROTOCOL,
      entries: [source],
      productionDelivery: { ...delivery, sequence: 3, attemptId: "later-unknown" },
    }).expect(200);
    expect(
      (
        await post(h.a.apiKey, "pallet-lookup-v2", {
          protocol: PALLET_REPRINT_V2_PROTOCOL,
          operatorId: h.a.operatorId,
          raw: sscc,
        }).expect(200)
      ).body.code,
    ).toBe("delivery_unresolved");
  });
});
