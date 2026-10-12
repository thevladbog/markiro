import { expect, it } from "vitest";
import * as domain from "../src/index.js";
import {
  a4PalletSource,
  thermalPalletSource,
  sheetChoice,
  thermalChoice,
} from "./support/pallet-reprint.js";

it("uses saved A4 facts in a chosen thermal template without retaining the old template", () => {
  const source = a4PalletSource();
  const data = domain.palletDataFromLegacySource(source);
  expect(data.fields).toMatchObject({
    sscc: "146000000000001231",
    qty: "1",
    "qty.boxes": "1",
    date: "11.10.2026",
    expiry: "11.10.2026",
    "product.printName": "Исторический товар",
  });
  expect(data).not.toHaveProperty("rendering");
  expect(data).not.toHaveProperty("template");
  const rendered = domain.renderingFromPalletData(data, thermalChoice());
  expect(rendered.choice.kind).toBe("thermal");
  expect(rendered.fields).toEqual(data.fields);
  expect(rendered.sourceRevision).toBe(data.revision);
  domain.assertPalletRenderingV3MatchesData(data, rendered);
});

it("preserves a saved thermal expiry when selecting A4 instead of inferring shelf life", () => {
  const source = thermalPalletSource();
  if (source.rendering.kind !== "thermal") throw new Error("Expected thermal source");
  const { revision, ...body } = source;
  expect(revision).toHaveLength(64);
  const changed = domain.makePalletLabelSource({
    ...body,
    rendering: {
      ...source.rendering,
      fields: { ...source.rendering.fields, expiry: "15.11.2026" },
    },
  });
  const data = domain.palletDataFromLegacySource(changed);
  expect(data.expiryDate).toBe("2026-11-15");
  const rendered = domain.renderingFromPalletData(data, sheetChoice());
  expect(rendered.choice.kind).toBe("a4");
  expect(rendered.fields.expiry).toBe("15.11.2026");
  domain.assertPalletRenderingV3MatchesData(data, rendered);
});

it("rejects a re-fingerprinted rendering which changes historical quantities", () => {
  const data = domain.palletDataFromLegacySource(a4PalletSource());
  const rendered = domain.renderingFromPalletData(data, thermalChoice());
  const { renderingRevision, ...body } = rendered;
  expect(renderingRevision).toHaveLength(64);
  const changed = { ...body, fields: { ...body.fields, qty: "7" } };
  expect(() =>
    domain.assertPalletRenderingV3MatchesData(data, {
      ...changed,
      renderingRevision: domain.productLabelValueDigest(changed),
    }),
  ).toThrow();
});

it("leaves legacy V2 type restrictions intact", () => {
  expect(() => domain.makePalletRenderingV2(a4PalletSource(), thermalChoice())).toThrow(
    "WAREHOUSE_PALLET_TEMPLATE_KIND",
  );
});

it("rejects data containing a unit code even with a recalculated digest", () => {
  const data = domain.palletDataFromLegacySource(a4PalletSource());
  const { revision, ...body } = data;
  expect(revision).toHaveLength(64);
  expect(() =>
    domain.makePalletData({ ...body, fields: { ...body.fields, "km.code": "secret-unit-code" } }),
  ).toThrow();
});
it("rejects invalid civil dates instead of replacing them with today's values", () => {
  const source = thermalPalletSource();
  if (source.rendering.kind !== "thermal") throw new Error("Expected thermal source");
  const { revision, ...body } = source;
  expect(revision).toHaveLength(64);
  const changed = domain.makePalletLabelSource({
    ...body,
    rendering: { ...source.rendering, fields: { ...source.rendering.fields, date: "31.02.2026" } },
  });
  expect(() => domain.palletDataFromLegacySource(changed)).toThrow();
});
it("reports missing production date for a template that requires that field", () => {
  const data = domain.palletDataFromLegacySource(a4PalletSource());
  const { revision, ...body } = data;
  expect(revision).toHaveLength(64);
  const undated = domain.makePalletData({
    ...body,
    productionDate: null,
    expiryDate: null,
    fields: { ...body.fields, date: "", expiry: "" },
  });
  expect(() => domain.renderingFromPalletData(undated, thermalChoice())).toThrow(
    "WAREHOUSE_SOURCE_DATE",
  );
});

it("adapts dated A4 data without shelf life as an absent expiry", () => {
  const source = a4PalletSource();
  if (source.rendering.kind !== "a4") throw new Error("Expected A4");
  const { revision, ...body } = source;
  expect(revision).toHaveLength(64);
  const saved = domain.makePalletLabelSource({
    ...body,
    rendering: { ...source.rendering, facts: { ...source.rendering.facts, shelfLifeDays: null } },
  });
  expect(domain.palletDataFromLegacySource(saved)).toMatchObject({
    productionDate: "2026-10-11",
    expiryDate: null,
    fields: { date: "11.10.2026", expiry: "" },
  });
});
