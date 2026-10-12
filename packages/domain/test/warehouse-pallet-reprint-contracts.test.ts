import { expect, it } from "vitest";
import * as domain from "../src/index.js";
it("separates pallet sources from legacy unit/box sources and rejects mismatched snapshots", () => {
  expect(domain.makePalletLabelSource).toBeTypeOf("function");
  const content = {
    version: 1 as const,
    sscc: "146000000000001231",
    shiftId: "00000000-0000-4000-8000-000000000001",
    closedAt: "2026-10-11T00:00:00.000Z",
    boxCount: 1,
    itemCount: 1,
    compositionDigest: "a".repeat(64),
    boxSsccs: ["046000000000001234"],
    rendering: {
      kind: "thermal" as const,
      rendererVersion: "thermal-v1" as const,
      template: domain.buildPalletLabelTemplates()[0]!.spec,
      fields: domain.palletLabelFields({
        sscc: "146000000000001231",
        productName: "Товар",
        productPrintName: null,
        egaisCode: null,
        shelfLifeDays: null,
        operatorName: null,
        counterpartyName: null,
        productionDate: null,
        shiftNumber: null,
        gtin14: "04600000000015",
        boxCount: 1,
        itemCount: 1,
        closedAt: "2026-10-11T00:00:00.000Z",
      }),
      brandingJson: null,
    },
  };
  const source = domain.makePalletLabelSource(content);
  expect(domain.palletLabelSourceSchema.parse(source)).toEqual(source);
  const delivery = {
    sourceRevision: source.revision,
    sequence: 1,
    attemptId: "production-attempt",
    bytesDigest: "b".repeat(64),
    state: "sent" as const,
    occurredAt: "2026-10-11T00:00:01.000Z",
  };
  const batch = { protocol: domain.PALLET_REPRINT_PROTOCOL, entries: [source] };
  expect(domain.palletSourcesBatchSchema.parse(batch)).toEqual(batch);
  expect(domain.palletSourcesBatchSchema.parse({ ...batch, productionDelivery: delivery })).toEqual(
    { ...batch, productionDelivery: delivery },
  );
  for (const productionDelivery of [
    { ...delivery, sourceRevision: "c".repeat(64) },
    { ...delivery, sequence: 0 },
    { ...delivery, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...delivery, state: "verified" },
  ])
    expect(
      domain.palletSourcesBatchSchema.safeParse({ ...batch, productionDelivery }).success,
    ).toBe(false);
  expect(
    domain.palletSourcesBatchSchema.safeParse({
      ...batch,
      entries: [],
      productionDelivery: delivery,
    }).success,
  ).toBe(false);
  expect(() => domain.palletLabelSourceSchema.parse({ ...source, itemCount: 2 })).toThrow();
  expect(() => domain.makePalletLabelSource({ ...content, sscc: "046000000000001234" })).toThrow();
  expect(() =>
    domain.makePalletLabelSource({
      ...content,
      rendering: { ...content.rendering, brandingJson: "{}" },
    }),
  ).toThrow();
  expect(domain.warehouseSourceSchema.safeParse({ kind: "pallet", ...source }).success).toBe(false);
});
