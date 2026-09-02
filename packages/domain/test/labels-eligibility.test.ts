import { describe, expect, it } from "vitest";

import {
  isBoxLabelTemplateEligible,
  labelTemplateUsesField,
  resolveBoxLabelTemplateDefault,
  type LabelTemplateSpec,
} from "../src/index.js";

describe("isBoxLabelTemplateEligible", () => {
  it("accepts an enabled universal template for any category, including an unknown one", () => {
    const template = { enabled: true, chzProductGroupCodes: null };
    expect(isBoxLabelTemplateEligible(template, 15)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, null)).toBe(true);
  });

  it("accepts a scoped template only for a listed category", () => {
    const template = { enabled: true, chzProductGroupCodes: [15, 22] };
    expect(isBoxLabelTemplateEligible(template, 15)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, 22)).toBe(true);
    expect(isBoxLabelTemplateEligible(template, 8)).toBe(false);
    expect(isBoxLabelTemplateEligible(template, null)).toBe(false);
  });

  it("never accepts a disabled template", () => {
    expect(isBoxLabelTemplateEligible({ enabled: false, chzProductGroupCodes: null }, 15)).toBe(
      false,
    );
    expect(isBoxLabelTemplateEligible({ enabled: false, chzProductGroupCodes: [15] }, 15)).toBe(
      false,
    );
  });
});

describe("resolveBoxLabelTemplateDefault", () => {
  it("prefers the category default over the organisation default", () => {
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: "cat", organizationDefaultId: "org" }),
    ).toEqual({ templateId: "cat", source: "category" });
  });

  it("falls back to the organisation default, then to nothing", () => {
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: null, organizationDefaultId: "org" }),
    ).toEqual({ templateId: "org", source: "organization" });
    expect(
      resolveBoxLabelTemplateDefault({ categoryDefaultId: null, organizationDefaultId: null }),
    ).toEqual({ templateId: null, source: null });
  });
});

describe("labelTemplateUsesField", () => {
  const base = { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl" } as const;

  it("finds a field element bound to the field", () => {
    const spec: LabelTemplateSpec = {
      ...base,
      elements: [{ kind: "field", id: "e", xMm: 1, yMm: 1, field: "product.egais", fontSizePt: 8 }],
    };
    expect(labelTemplateUsesField(spec, "product.egais")).toBe(true);
    expect(labelTemplateUsesField(spec, "product.gtin")).toBe(false);
  });

  it("finds a barcode whose data is bound to the field, ignoring literals and text", () => {
    const spec: LabelTemplateSpec = {
      ...base,
      elements: [
        { kind: "text", id: "t", xMm: 1, yMm: 1, text: "ЕГАИС", fontSizePt: 8 },
        {
          kind: "barcode",
          id: "b",
          xMm: 1,
          yMm: 10,
          format: "code128",
          data: "product.egais",
          sizeMm: 10,
        },
        {
          kind: "barcode",
          id: "l",
          xMm: 1,
          yMm: 25,
          format: "code128",
          data: { literal: "X" },
          sizeMm: 10,
        },
      ],
    };
    expect(labelTemplateUsesField(spec, "product.egais")).toBe(true);
    expect(labelTemplateUsesField({ ...base, elements: [] }, "product.egais")).toBe(false);
  });
});
