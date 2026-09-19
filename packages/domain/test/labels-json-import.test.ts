import { describe, expect, it } from "vitest";

import { DomainError } from "../src/errors.js";
import { MAX_LABEL_CODE_BYTES } from "../src/labels/import.js";
import { parseLabelJson } from "../src/labels/json-import.js";
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

function thrownBy(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a DomainError");
}

describe("parseLabelJson", () => {
  it("imports a bare spec unchanged, with no warnings and no name", () => {
    const result = parseLabelJson(JSON.stringify(EXAMPLE_SPEC), { purpose: "pallet" });
    expect(result.spec).toEqual(EXAMPLE_SPEC);
    expect(result.warnings).toEqual([]);
    expect(result.sourceLineByElementId).toEqual({});
    expect(result).not.toHaveProperty("name");
  });

  it("unwraps a request body, returns its trimmed name and checks purpose against the template", () => {
    const body = { name: "  Паллета 58×40  ", purpose: "pallet", spec: EXAMPLE_SPEC };
    const matching = parseLabelJson(JSON.stringify(body), { purpose: "pallet" });
    expect(matching.name).toBe("Паллета 58×40");
    expect(matching.spec).toEqual(EXAMPLE_SPEC);
    expect(matching.warnings).toEqual([]);

    const mismatching = parseLabelJson(JSON.stringify(body), { purpose: "box" });
    expect(mismatching.warnings).toEqual([
      expect.objectContaining({
        code: "PURPOSE_MISMATCH",
        line: null,
        source: 'purpose: "pallet"',
      }),
    ]);
  });

  it("ignores the other wrapper keys silently and drops a blank or overlong name", () => {
    const fromGet = {
      id: "2b6f0c1e-0000-4000-8000-000000000001",
      name: "   ",
      purpose: "pallet",
      spec: EXAMPLE_SPEC,
      enabled: true,
      chzProductGroupCodes: [23, 33],
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    const result = parseLabelJson(JSON.stringify(fromGet), { purpose: "pallet" });
    expect(result.warnings).toEqual([]);
    expect(result).not.toHaveProperty("name");

    const long = parseLabelJson(JSON.stringify({ name: "x".repeat(250), spec: EXAMPLE_SPEC }), {
      purpose: "pallet",
    });
    expect(long.name).toHaveLength(200);
  });

  it("warns about every unknown property inside spec with a dotted path and strips it", () => {
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
    const result = parseLabelJson(JSON.stringify(input), { purpose: "pallet" });

    expect(result.warnings.map((warning) => warning.source).sort()).toEqual(
      ["comment", "elements.0.maxlines", "elements.1.data.foo"].sort(),
    );
    for (const warning of result.warnings) {
      expect(warning).toMatchObject({ code: "UNKNOWN_PROPERTY", line: null });
    }
    expect(result.spec).not.toHaveProperty("comment");
    expect(result.spec.elements[0]).not.toHaveProperty("maxlines");
    expect(result.spec.elements[1]).toMatchObject({ data: { literal: "123" } });
  });

  it("rejects malformed input with a blocking error", () => {
    expect(thrownBy(() => parseLabelJson("{", { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: expect.stringMatching(/^invalid JSON: /),
    });
    expect(thrownBy(() => parseLabelJson("[]", { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: "expected a label template object",
    });
    expect(thrownBy(() => parseLabelJson('{"spec": 42}', { purpose: "box" }))).toMatchObject({
      code: "LABEL_CODE_INVALID",
      message: "spec must be an object",
    });
  });

  it("enforces the shared size and element limits", () => {
    expect(
      thrownBy(() => parseLabelJson("X".repeat(MAX_LABEL_CODE_BYTES + 1), { purpose: "box" })).code,
    ).toBe("LABEL_CODE_TOO_LARGE");
    const tooMany = {
      ...EXAMPLE_SPEC,
      elements: Array.from({ length: 1001 }, (_, index) => ({
        kind: "line",
        id: `l${index}`,
        xMm: 0,
        yMm: 0,
        x2Mm: 1,
        y2Mm: 1,
        thicknessMm: 0.3,
      })),
    };
    expect(thrownBy(() => parseLabelJson(JSON.stringify(tooMany), { purpose: "box" })).code).toBe(
      "LABEL_CODE_LIMIT",
    );
  });

  it("reports schema issues with their paths, exactly like the API", () => {
    const missingFont = {
      ...EXAMPLE_SPEC,
      elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
    };
    const error = thrownBy(() => parseLabelJson(JSON.stringify(missingFont), { purpose: "box" }));
    expect(error.code).toBe("LABEL_INVALID");
    const issues = error.cause as Array<{ path: string; message: string }>;
    expect(issues.map((issue) => issue.path)).toContain("elements.0.fontSizePt");

    const duplicateIds = {
      ...EXAMPLE_SPEC,
      elements: [
        { kind: "text", id: "a", xMm: 1, yMm: 1, text: "x", fontSizePt: 6 },
        { kind: "text", id: "a", xMm: 1, yMm: 5, text: "y", fontSizePt: 6 },
      ],
    };
    const duplicate = thrownBy(() =>
      parseLabelJson(JSON.stringify(duplicateIds), { purpose: "box" }),
    );
    const duplicateIssues = duplicate.cause as Array<{ path: string; message: string }>;
    expect(duplicateIssues).toEqual([
      { path: "elements", message: expect.stringContaining('duplicate element id "a"') },
    ]);
  });
});
