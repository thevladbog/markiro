import request from "supertest";
// setupWarehouseApi binds the server once through listenOnLoopback.
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  PALLET_REPRINT_PROTOCOL,
  makePalletLabelSource,
  buildPalletLabelTemplates,
  palletLabelFields,
  palletCompositionDigest,
} from "@markiro/domain";
import { setupWarehouseApi, WAREHOUSE_TEST_SSCC } from "./support/warehouse-reprint.js";
describe.skipIf(!process.env.DATABASE_URL)(
  "pallet source after acknowledged composition changes",
  () => {
    let h: Awaited<ReturnType<typeof setupWarehouseApi>>;
    beforeAll(async () => {
      h = await setupWarehouseApi();
    });
    afterAll(async () => {
      await h?.close();
    });
    it("quarantines a source with a removed unit rather than treating it as incomplete ingestion", async () => {
      const palletId = randomUUID(),
        sscc = "146000000000001231";
      await h.db.insert(schema.pallets).values({
        id: palletId,
        tenantId: h.a.tenantId,
        shiftId: h.shiftId,
        terminalId: h.a.deviceId,
        devicePalletId: "local",
        sscc,
        closedAt: new Date("2026-10-11T00:00:00Z"),
        printSkippedAt: new Date("2026-10-11T00:01:00Z"),
      });
      await h.db
        .update(schema.boxes)
        .set({ palletId })
        .where(and(eq(schema.boxes.tenantId, h.a.tenantId), eq(schema.boxes.id, h.boxId)));
      const template = buildPalletLabelTemplates()[0];
      if (!template) throw new Error("Missing template");
      const source = makePalletLabelSource({
        version: 1,
        sscc,
        shiftId: h.shiftId,
        closedAt: "2026-10-11T00:00:00.000Z",
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
            shelfLifeDays: null,
            productionDate: null,
            operatorName: null,
            counterpartyName: null,
            shiftNumber: null,
            boxCount: 1,
            itemCount: 1,
            closedAt: "2026-10-11T00:00:00Z",
          }),
        },
      });
      await h.db
        .update(schema.boxItems)
        .set({ removedAt: new Date("2026-10-11T00:02:00Z") })
        .where(and(eq(schema.boxItems.tenantId, h.a.tenantId), eq(schema.boxItems.boxId, h.boxId)));
      const result = await request(h.app.getHttpServer())
        .post("/station/warehouse-reprint/pallet-sources")
        .set("x-api-key", h.a.apiKey)
        .send({ protocol: PALLET_REPRINT_PROTOCOL, entries: [source] })
        .expect(200);
      expect(result.body.results).toEqual([{ revision: source.revision, status: "conflict" }]);
      expect(
        await h.db
          .select()
          .from(schema.palletLabelSources)
          .where(eq(schema.palletLabelSources.tenantId, h.a.tenantId)),
      ).toHaveLength(0);
    });
  },
);
