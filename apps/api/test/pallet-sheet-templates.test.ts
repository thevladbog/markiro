import { describe, expect, it } from "vitest";
import { buildPalletSheetPresets } from "@markiro/domain";
import {
  createLabelTemplateSchema,
  updateLabelTemplateSchema,
} from "../src/modules/label-templates/dto";
const spec = buildPalletSheetPresets()[0]!.spec;
describe("pallet sheet template input boundary", () => {
  it("accepts an explicit pallet V2 and preserves the editable spec", () => {
    expect(
      createLabelTemplateSchema.parse({
        name: "Sheet",
        purpose: "pallet",
        spec,
        format: "pallet_sheet_v2",
      }),
    ).toMatchObject({ spec, format: "pallet_sheet_v2" });
  });
  it.each(["box", "product_duplicate"])("rejects V2 purpose %s", (purpose) => {
    expect(createLabelTemplateSchema.safeParse({ name: "Sheet", purpose, spec }).success).toBe(
      false,
    );
  });
  it("rejects unsupported versions and explicit format mismatch", () => {
    expect(
      createLabelTemplateSchema.safeParse({
        name: "Sheet",
        purpose: "pallet",
        spec: { ...spec, schemaVersion: 3 },
      }).success,
    ).toBe(false);
    expect(
      createLabelTemplateSchema.safeParse({
        name: "Sheet",
        purpose: "pallet",
        spec,
        format: "label_v1",
      }).success,
    ).toBe(false);
  });
  it("retains the expected revision on partial V2 changes", () => {
    expect(updateLabelTemplateSchema.parse({ name: "Changed", expectedRevision: 1 })).toEqual({
      name: "Changed",
      expectedRevision: 1,
    });
    expect(updateLabelTemplateSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
  });
});
