import { describe, expect, it } from "vitest";
import {
  buildWarehouseCodeOnlyLabelTemplate,
  assertDuplicateTemplate,
  labelTemplateUsesField,
} from "../src/index.js";

describe("warehouse code-only template", () => {
  it("prints the full product code without requiring missing historical fields", () => {
    const template = buildWarehouseCodeOnlyLabelTemplate();
    expect(() => assertDuplicateTemplate(template.spec)).not.toThrow();
    expect(labelTemplateUsesField(template.spec, "km.code")).toBe(true);
    for (const field of ["date", "expiry", "operator", "sscc"] as const)
      expect(labelTemplateUsesField(template.spec, field)).toBe(false);
    expect(template.spec.widthMm).toBe(30);
    expect(template.spec.heightMm).toBe(30);
  });
});
it("offers a box layout that needs no unavailable historical fields", async () => {
  const { buildWarehouseCodeOnlyBoxTemplate } = await import("../src/index.js");
  const template = buildWarehouseCodeOnlyBoxTemplate();
  expect(
    template.spec.elements.filter((e) => e.kind === "barcode" && e.data === "sscc"),
  ).toHaveLength(1);
  for (const field of ["date", "expiry", "operator", "km.code"] as const)
    expect(labelTemplateUsesField(template.spec, field)).toBe(false);
});
