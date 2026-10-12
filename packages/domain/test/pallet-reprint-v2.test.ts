import { expect, it } from "vitest";
import * as domain from "../src/index.js";
import {
  a4PalletSource,
  thermalPalletSource,
  sheetChoice,
  thermalChoice,
} from "./support/pallet-reprint.js";

it.each([0, 1, 2])(
  "freezes A4 choice %i without changing historical facts or the source",
  (index) => {
    const source = a4PalletSource(),
      before = JSON.stringify(source),
      choice = sheetChoice(index);
    const rendering = domain.makePalletRenderingV2(source, choice);
    expect(rendering.templateId).toBe(choice.id);
    expect(rendering.rendering.template).toEqual(choice.snapshot);
    domain.assertPalletRenderingMatchesSource(source, rendering);
    expect(JSON.stringify(source)).toBe(before);
    expect(domain.palletRenderingV2Schema.parse(rendering)).toEqual(rendering);
  },
);
it("supports thermal and the historical template without a catalog ID", () => {
  const source = thermalPalletSource(),
    choice = thermalChoice();
  const rendering = domain.makePalletRenderingV2(source, { ...choice, id: null });
  expect(rendering.templateId).toBeNull();
  expect(rendering.rendering).toEqual(source.rendering);
  domain.assertPalletRenderingMatchesSource(source, rendering);
});
it("rejects type changes, tampered source facts and rendering digests", () => {
  const source = a4PalletSource();
  expect(() => domain.makePalletRenderingV2(source, thermalChoice())).toThrow();
  const rendering = domain.makePalletRenderingV2(source, sheetChoice(1));
  expect(
    domain.palletRenderingV2Schema.safeParse({ ...rendering, renderingRevision: "b".repeat(64) })
      .success,
  ).toBe(false);
  expect(() =>
    domain.assertPalletRenderingMatchesSource({ ...source, itemCount: 2 }, rendering),
  ).toThrow();
  expect(() =>
    domain.assertPalletRenderingMatchesSource(source, {
      ...rendering,
      sourceRevision: "b".repeat(64),
    }),
  ).toThrow();
});
it("requires exact original SSCC confirmation and rejects extra fields", () => {
  const source = a4PalletSource();
  const resolution = {
    eventId: "00000000-0000-4000-8000-000000000010",
    sscc: source.sscc,
    sourceRevision: source.revision,
    attemptId: "production-1",
    operatorId: "00000000-0000-4000-8000-000000000011",
    reason: "not_printed",
    occurredAt: "2026-10-12T00:00:00.000Z",
    outcome: "confirmed",
    scannedSscc: source.sscc,
  };
  expect(domain.palletProductionResolutionSchema.parse(resolution)).toEqual(resolution);
  expect(
    domain.palletProductionResolutionSchema.safeParse({
      ...resolution,
      scannedSscc: source.boxSsccs[0],
    }).success,
  ).toBe(false);
  expect(
    domain.palletProductionResolutionSchema.safeParse({ ...resolution, code: "raw KM" }).success,
  ).toBe(false);
});

it("rejects refingerprinted historical data and falsely claiming an original template", () => {
  const source = a4PalletSource(),
    rendering = domain.makePalletRenderingV2(source, sheetChoice(1));
  if (rendering.rendering.kind !== "a4") throw new Error("Missing A4 rendering");
  const { renderingRevision, ...body } = rendering;
  expect(renderingRevision).toHaveLength(64);
  const changed = {
    ...body,
    rendering: {
      ...rendering.rendering,
      facts: { ...rendering.rendering.facts, productPrintName: "Current catalog name" },
    },
  };
  expect(() =>
    domain.assertPalletRenderingMatchesSource(source, {
      ...changed,
      renderingRevision: domain.productLabelValueDigest(changed),
    }),
  ).toThrow("WAREHOUSE_PALLET_SOURCE_CHANGED");
  expect(() => domain.makePalletRenderingV2(source, { ...sheetChoice(1), id: null })).toThrow(
    "WAREHOUSE_PALLET_TEMPLATE_CHANGED",
  );
  expect(
    domain.palletTemplateChoiceSchema.safeParse({
      ...sheetChoice(),
      snapshotDigest: "b".repeat(64),
    }).success,
  ).toBe(false);
});
it("keeps V1 events strict and links V2 events to a rendering revision", () => {
  const event = {
    eventId: "00000000-0000-4000-8000-000000000010",
    jobId: "00000000-0000-4000-8000-000000000011",
    attemptId: "00000000-0000-4000-8000-000000000012",
    sscc: a4PalletSource().sscc,
    sourceRevision: a4PalletSource().revision,
    operatorId: "00000000-0000-4000-8000-000000000013",
    reason: "damaged",
    occurredAt: "2026-10-12T00:00:00.000Z",
    state: "prepared",
    printFormat: "mono-raster-v1",
    bytesDigest: "a".repeat(64),
  };
  const v2 = { ...event, renderingRevision: "b".repeat(64) };
  expect(domain.palletReprintEventV2Schema.parse(v2)).toEqual(v2);
  expect(domain.palletReprintEventSchema.safeParse(v2).success).toBe(false);
  expect(domain.palletReprintEventV2Schema.safeParse(event).success).toBe(false);
});
