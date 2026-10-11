import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import { makeSheetSpec, legacySpec } from "./support/pallet-sheet.js";

describe("portable stored-template JSON", () => {
  it("imports a sheet wrapper with exact conditions and branding bindings", () => {
    const payload = { name: "Палета А4", purpose: "pallet", spec: makeSheetSpec() };
    expect(domain.parseStoredLabelJson?.(JSON.stringify(payload))).toEqual(payload);
  });
  it("round trips the schema without resolved tenant or device data", () => {
    const payload = {
      name: "Палета А4",
      purpose: "pallet" as const,
      spec: makeSheetSpec(),
      tenantId: "private",
      revision: 9,
      queue: "private",
    };
    const json = domain.serializeStoredLabelJson(payload);
    expect(JSON.parse(json)).toEqual({
      name: "Палета А4",
      purpose: "pallet",
      spec: makeSheetSpec(),
    });
    expect(domain.parseStoredLabelJson(json)).toEqual({
      name: "Палета А4",
      purpose: "pallet",
      spec: makeSheetSpec(),
    });
  });
  it("imports a bare sheet only with explicit editor name and purpose", () => {
    const json = JSON.stringify(makeSheetSpec());
    expect(() => domain.parseStoredLabelJson(json)).toThrow("name");
    expect(
      domain.parseStoredLabelJson(json, { nameForBareSpec: "А4", purposeForBareSpec: "pallet" }),
    ).toEqual({ name: "А4", purpose: "pallet", spec: makeSheetSpec() });
  });
  it("retains a legacy template without inventing V2 metadata", () => {
    const payload = { name: "Старая этикетка", purpose: "pallet" as const, spec: legacySpec };
    expect(domain.parseStoredLabelJson(domain.serializeStoredLabelJson(payload))).toEqual(payload);
  });
  it.each(["box", "product_duplicate"])("refuses a sheet under purpose %s", (purpose) => {
    expect(() =>
      domain.parseStoredLabelJson(JSON.stringify({ name: "x", purpose, spec: makeSheetSpec() })),
    ).toThrow("purpose");
  });
  it.each(["{", "[]", "null", '"text"'])("rejects invalid document %s", (input) => {
    expect(() => domain.parseStoredLabelJson(input)).toThrow(domain.DomainError);
  });
  it("counts UTF-8 bytes rather than code units", () => {
    const spec = makeSheetSpec();
    const source = JSON.stringify({
      name: "x",
      purpose: "pallet",
      spec: {
        ...spec,
        body: [{ id: "text", kind: "text", text: "я".repeat(140_000), fontSizePt: 12 }],
      },
    });
    expect(source.length).toBeLessThan(256 * 1024);
    expect(() => domain.parseStoredLabelJson(source)).toThrow("256");
  });
  it("refuses unknown versions rather than exporting dropped data", () => {
    const payload = {
      name: "x",
      purpose: "pallet",
      spec: { ...makeSheetSpec(), schemaVersion: 3 },
    };
    expect(() => domain.parseStoredLabelJson(JSON.stringify(payload))).toThrow("version");
  });
});
