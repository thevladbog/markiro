import { describe, expect, it } from "vitest";

import { labelTemplateSpecSchema, labelTemplateSpecStrictSchema } from "../src/labels/model.js";

/** The pallet 58×40 layout from the JSON-import task, exactly as the API accepts it. */
const EXAMPLE_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      kind: "field",
      id: "name",
      xMm: 2,
      yMm: 2,
      field: "product.printName",
      fontSizePt: 10,
      bold: true,
      maxWidthMm: 54,
      maxLines: 3,
    },
    { kind: "line", id: "sep1", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-date",
      xMm: 2,
      yMm: 18.8,
      text: "Дата производства:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "text",
      id: "cap-expiry",
      xMm: 20,
      yMm: 18.8,
      text: "Годен до:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "text",
      id: "cap-qty",
      xMm: 38,
      yMm: 18.8,
      text: "Коробов:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-date",
      xMm: 2,
      yMm: 21.6,
      field: "date",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-expiry",
      xMm: 20,
      yMm: 21.6,
      field: "expiry",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-qty",
      xMm: 38,
      yMm: 20.9,
      field: "qty.boxes",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
    { kind: "line", id: "sep2", xMm: 2, yMm: 26.2, x2Mm: 56, y2Mm: 26.2, thicknessMm: 0.3 },
    {
      kind: "text",
      id: "cap-egais",
      xMm: 2,
      yMm: 26.8,
      text: "Код ЕГАИС:",
      fontSizePt: 5,
      maxWidthMm: 18,
    },
    {
      kind: "field",
      id: "val-egais",
      xMm: 20,
      yMm: 26.8,
      field: "product.egais",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 36,
    },
    { kind: "line", id: "sep3", xMm: 2, yMm: 31.4, x2Mm: 56, y2Mm: 31.4, thicknessMm: 0.3 },
    {
      kind: "barcode",
      id: "bc-sscc",
      xMm: 9.5,
      yMm: 32,
      format: "code128",
      data: "sscc",
      sizeMm: 4.8,
      moduleWidthMm: 0.2502,
    },
    {
      kind: "field",
      id: "val-sscc",
      xMm: 2,
      yMm: 37,
      field: "sscc",
      fontSizePt: 5,
      align: "center",
      maxWidthMm: 54,
    },
  ],
};

describe("labelTemplateSpecStrictSchema", () => {
  it("accepts the same document as the lenient schema when nothing is unknown", () => {
    const strict = labelTemplateSpecStrictSchema.safeParse(EXAMPLE_SPEC);
    const lenient = labelTemplateSpecSchema.safeParse(EXAMPLE_SPEC);
    expect(strict.success).toBe(true);
    expect(lenient.success).toBe(true);
    if (strict.success && lenient.success) expect(strict.data).toEqual(lenient.data);
  });

  it("reports unknown properties at every level the lenient schema silently strips", () => {
    const input = {
      ...EXAMPLE_SPEC,
      comment: "top-level note",
      elements: [
        {
          kind: "field",
          id: "name",
          xMm: 2,
          yMm: 2,
          field: "product.printName",
          fontSizePt: 10,
          maxlines: 3,
        },
        {
          kind: "barcode",
          id: "bc",
          xMm: 2,
          yMm: 20,
          format: "code128",
          data: { literal: "123", foo: 1 },
          sizeMm: 5,
        },
      ],
    };

    const lenient = labelTemplateSpecSchema.safeParse(input);
    expect(lenient.success).toBe(true);
    if (lenient.success) {
      expect(lenient.data).not.toHaveProperty("comment");
      expect(lenient.data.elements[0]).not.toHaveProperty("maxlines");
      expect(lenient.data.elements[1]).toMatchObject({ data: { literal: "123" } });
    }

    const strict = labelTemplateSpecStrictSchema.safeParse(input);
    expect(strict.success).toBe(false);
    if (strict.success) return;
    const codes = strict.error.issues.map((issue) => issue.code);
    // Root and element: direct `unrecognized_keys`; the barcode's `data` is a
    // union, so its unknown key arrives inside an `invalid_union` issue.
    expect(codes.filter((code) => code === "unrecognized_keys")).toHaveLength(2);
    expect(codes).toContain("invalid_union");
  });
});
