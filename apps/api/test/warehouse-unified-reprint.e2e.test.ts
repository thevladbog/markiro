import { a4PalletSource } from "./support/pallet-reprint.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { schema, createDb } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import {
  UNIFIED_REPRINT_PROTOCOL,
  PALLET_REPRINT_PROTOCOL,
  makePalletLabelSource,
  palletDataFromLegacySource,
  validatePalletBranding,
  makePalletData,
  palletCompositionDigest,
  palletLabelFields,
  buildPalletLabelTemplates,
  renderingFromPalletData,
  productLabelValueDigest,
} from "@markiro/domain";
import { setupWarehouseApi, WAREHOUSE_TEST_SSCC } from "./support/warehouse-reprint";
const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("unified pallet data admission", () => {
  const databaseName = `markiro_unified_${randomUUID().replaceAll("-", "_")}`;
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
    // setupWarehouseApi binds once with listenOnLoopback before returning.
    h = await setupWarehouseApi(url.toString());
  }, 180000);
  afterAll(async () => {
    if (h) await h.close();
    if (created) await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await maintenance.end();
  });
  it("looks up closed pallet data, accepts a new rendering and audits exact provenance without an original template", async () => {
    const palletId = randomUUID(),
      sscc = "146000000000001231";
    await h.db.insert(schema.pallets).values({
      id: palletId,
      tenantId: h.a.tenantId,
      shiftId: h.shiftId,
      terminalId: h.a.deviceId,
      devicePalletId: "data-pallet",
      sscc,
      closedAt: new Date("2026-10-08T13:00:00Z"),
    });
    await h.db.update(schema.boxes).set({ palletId }).where(eq(schema.boxes.id, h.boxId));
    const data = makePalletData({
      version: 3,
      sscc,
      shiftId: h.shiftId,
      closedAt: "2026-10-08T13:00:00.000Z",
      boxCount: 1,
      itemCount: 1,
      boxSsccs: [WAREHOUSE_TEST_SSCC],
      legacySourceRevision: null,
      compositionDigest: palletCompositionDigest([
        {
          boxSscc: WAREHOUSE_TEST_SSCC,
          codeHash: h.codeHash,
          acceptedAt: "2026-10-08T10:00:00.000Z",
        },
      ]),
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
      productionDate: "2026-10-08",
      expiryDate: "2026-10-08",
      brandingJson: null,
    });
    const post = (key: string, path: string, body: object) =>
      request(h.app.getHttpServer())
        .post(`/station/warehouse-reprint/${path}`)
        .set("X-Api-Key", key)
        .send(body);
    const batch = { protocol: UNIFIED_REPRINT_PROTOCOL, entries: [data] };
    expect((await post(h.a.apiKey, "pallet-data-v3", batch).expect(200)).body.results).toEqual([
      { revision: data.revision, status: "accepted" },
    ]);
    expect(
      (await post(h.a.apiKey, "pallet-data-v3", batch).expect(200)).body.results[0].status,
    ).toBe("accepted");
    const found = (
      await post(h.a.apiKey, "lookup-v3", {
        protocol: UNIFIED_REPRINT_PROTOCOL,
        operatorId: h.a.operatorId,
        raw: sscc,
      }).expect(200)
    ).body;
    expect(found).toEqual({ status: "found", kind: "pallet", data });
    expect(found.data).not.toHaveProperty("rendering");
    expect(
      (
        await post(h.b.apiKey, "lookup-v3", {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          operatorId: h.b.operatorId,
          raw: sscc,
        }).expect(200)
      ).body,
    ).toEqual({ status: "not_found" });
    await post(h.a.apiKey, "lookup-v3", {
      protocol: UNIFIED_REPRINT_PROTOCOL,
      operatorId: h.b.operatorId,
      raw: sscc,
    }).expect(403);
    const template = buildPalletLabelTemplates()[0];
    if (!template) throw new Error("Missing template");
    const templateId = randomUUID();
    await h.db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId: h.a.tenantId,
      name: "Chosen thermal",
      purpose: "pallet",
      spec: template.spec,
    });
    const rendering = renderingFromPalletData(data, {
      kind: "thermal",
      id: templateId,
      name: "Chosen thermal",
      snapshot: template.spec,
      snapshotDigest: productLabelValueDigest(template.spec),
    });
    const jobId = randomUUID();
    const renderBatch = {
      protocol: UNIFIED_REPRINT_PROTOCOL,
      entries: [{ jobId, operatorId: h.a.operatorId, rendering }],
    };
    expect(
      (await post(h.a.apiKey, "pallet-renderings-v3", renderBatch).expect(200)).body.results,
    ).toEqual([{ jobId, renderingRevision: rendering.renderingRevision, status: "accepted" }]);
    const event = {
      eventId: randomUUID(),
      jobId,
      attemptId: randomUUID(),
      sscc,
      sourceRevision: data.revision,
      renderingRevision: rendering.renderingRevision,
      operatorId: h.a.operatorId,
      reason: "damaged",
      occurredAt: "2026-10-13T00:00:00.000Z",
      state: "prepared",
      printFormat: "zpl",
      bytesDigest: "b".repeat(64),
    };
    expect(
      (
        await post(h.a.apiKey, "pallet-events-v3", {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          entries: [event],
        }).expect(200)
      ).body.results,
    ).toEqual([{ eventId: event.eventId, status: "accepted" }]);
    const audits = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, h.a.tenantId),
          eq(schema.tenantAuditEvents.targetId, palletId),
          eq(schema.tenantAuditEvents.action, "pallet_label.prepared"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      organizationId: h.a.tenantId,
      action: "pallet_label.prepared",
      outcome: "accepted",
      targetType: "pallet",
      targetId: palletId,
      after: {
        deviceId: h.a.deviceId,
        operatorId: h.a.operatorId,
        sscc,
        jobId,
        sourceRevision: data.revision,
        renderingRevision: rendering.renderingRevision,
      },
    });
    const { renderingRevision, ...body } = rendering;
    expect(renderingRevision).toHaveLength(64);
    const changed = {
      ...body,
      fields: { ...body.fields, expiry: "01.01.2027" },
      expiryDate: "2027-01-01",
    };
    const changedRendering = { ...changed, renderingRevision: productLabelValueDigest(changed) };
    expect(
      (
        await post(h.a.apiKey, "pallet-renderings-v3", {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          entries: [
            { jobId: randomUUID(), operatorId: h.a.operatorId, rendering: changedRendering },
          ],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("conflict");

    const delivery = {
      sourceRevision: data.revision,
      sequence: 1,
      attemptId: "v3-uncertain-attempt",
      bytesDigest: "b".repeat(64),
      state: "delivery_unknown" as const,
      occurredAt: "2026-10-12T00:00:00.000Z",
    };
    await h.db.insert(schema.palletProductionDeliveries).values({
      tenantId: h.a.tenantId,
      sscc,
      sourceDeviceId: h.a.deviceId,
      sequence: 1,
      digest: productLabelValueDigest(delivery),
      value: delivery,
    });
    const resolution = {
      eventId: randomUUID(),
      sscc,
      sourceRevision: data.revision,
      attemptId: delivery.attemptId,
      productionSequence: 1,
      operatorId: h.a.operatorId,
      reason: "not_printed",
      occurredAt: "2026-10-12T00:01:00.000Z",
      outcome: "confirmed",
      scannedSscc: sscc,
    };
    expect(
      (
        await post(h.a.apiKey, "pallet-production-resolutions", {
          protocol: "warehouse-pallet-production-resolution-v1",
          entries: [resolution],
        }).expect(200)
      ).body.results[0].status,
    ).toBe("accepted");
    expect(
      (
        await post(h.a.apiKey, "lookup-v3", {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          operatorId: h.a.operatorId,
          raw: sscc,
        }).expect(200)
      ).body,
    ).toEqual({ status: "found", kind: "pallet", data });
  }, 60000);
  it("adapts an already closed legacy A4 pallet to a thermal choice without replacing its original source", async () => {
    const legacyHarness = await setupWarehouseApi(url.toString());
    try {
      const sscc = "146000000000001231",
        palletId = randomUUID();
      await legacyHarness.db.insert(schema.pallets).values({
        id: palletId,
        tenantId: legacyHarness.a.tenantId,
        shiftId: legacyHarness.shiftId,
        terminalId: legacyHarness.a.deviceId,
        devicePalletId: "legacy-a4",
        sscc,
        closedAt: new Date("2026-10-08T13:00:00Z"),
      });
      await legacyHarness.db
        .update(schema.boxes)
        .set({ palletId })
        .where(eq(schema.boxes.id, legacyHarness.boxId));
      const fixture = a4PalletSource();
      if (fixture.rendering.kind !== "a4") throw new Error("Expected A4 source");
      const { revision, ...old } = fixture;
      expect(revision).toHaveLength(64);
      const { digest, ...brandingBody } = validatePalletBranding(fixture.rendering.brandingJson);
      expect(digest).toHaveLength(64);
      const branding = { ...brandingBody, tenantId: legacyHarness.a.tenantId };
      const source = makePalletLabelSource({
        ...old,
        shiftId: legacyHarness.shiftId,
        closedAt: "2026-10-08T13:00:00.000Z",
        boxSsccs: [WAREHOUSE_TEST_SSCC],
        compositionDigest: palletCompositionDigest([
          {
            boxSscc: WAREHOUSE_TEST_SSCC,
            codeHash: legacyHarness.codeHash,
            acceptedAt: "2026-10-08T10:00:00.000Z",
          },
        ]),
        rendering: {
          ...fixture.rendering,
          brandingJson: JSON.stringify({ ...branding, digest: productLabelValueDigest(branding) }),
        },
      });
      const post = (path: string, body: object) =>
        request(legacyHarness.app.getHttpServer())
          .post(`/station/warehouse-reprint/${path}`)
          .set("X-Api-Key", legacyHarness.a.apiKey)
          .send(body);
      expect(
        (
          await post("pallet-sources", {
            protocol: PALLET_REPRINT_PROTOCOL,
            entries: [source],
          }).expect(200)
        ).body.results[0].status,
      ).toBe("accepted");
      const found = (
        await post("lookup-v3", {
          protocol: UNIFIED_REPRINT_PROTOCOL,
          operatorId: legacyHarness.a.operatorId,
          raw: `]C100${sscc}`,
        }).expect(200)
      ).body;
      const data = palletDataFromLegacySource(source);
      expect(found).toEqual({ status: "found", kind: "pallet", data });
      const preset = buildPalletLabelTemplates()[0];
      if (!preset) throw new Error("Missing thermal preset");
      const templateId = randomUUID();
      await legacyHarness.db.insert(schema.labelTemplates).values({
        id: templateId,
        tenantId: legacyHarness.a.tenantId,
        name: "Thermal after A4",
        purpose: "pallet",
        spec: preset.spec,
      });
      const rendering = renderingFromPalletData(data, {
        kind: "thermal",
        id: templateId,
        name: "Thermal after A4",
        snapshot: preset.spec,
        snapshotDigest: productLabelValueDigest(preset.spec),
      });
      expect(
        (
          await post("pallet-renderings-v3", {
            protocol: UNIFIED_REPRINT_PROTOCOL,
            entries: [{ jobId: randomUUID(), operatorId: legacyHarness.a.operatorId, rendering }],
          }).expect(200)
        ).body.results[0].status,
      ).toBe("accepted");
      const [retained] = await legacyHarness.db
        .select()
        .from(schema.palletLabelSources)
        .where(
          and(
            eq(schema.palletLabelSources.tenantId, legacyHarness.a.tenantId),
            eq(schema.palletLabelSources.sscc, sscc),
          ),
        );
      expect(retained?.value).toEqual(source);
      expect(retained?.revision).toBe(source.revision);
      await legacyHarness.db.insert(schema.palletProductionDeliveries).values({
        tenantId: legacyHarness.a.tenantId,
        sscc,
        sourceDeviceId: legacyHarness.a.deviceId,
        sequence: 1,
        digest: "b".repeat(64),
        value: {
          sourceRevision: source.revision,
          sequence: 1,
          attemptId: "uncertain-attempt",
          bytesDigest: "b".repeat(64),
          state: "delivery_unknown",
          occurredAt: "2026-10-09T00:00:00.000Z",
        },
      });
      expect(
        (
          await post("lookup-v3", {
            protocol: UNIFIED_REPRINT_PROTOCOL,
            operatorId: legacyHarness.a.operatorId,
            raw: sscc,
          }).expect(200)
        ).body,
      ).toEqual({
        status: "unavailable",
        code: "delivery_unresolved",
        diagnostic: {
          sscc,
          sourceRevision: source.revision,
          attemptId: "uncertain-attempt",
          productionSequence: 1,
          originDeviceId: legacyHarness.a.deviceId,
          shiftId: source.shiftId,
          kind: "delivery_unknown",
        },
      });
    } finally {
      await legacyHarness.close();
    }
  }, 60000);
});
