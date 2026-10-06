import { describe, expect, it } from "vitest";

import { analyzeImport } from "../src/office/templates/import-analysis.js";

const NAME_FIELD = {
  kind: "field",
  id: "name",
  xMm: 2,
  yMm: 2,
  field: "product.printName",
  fontSizePt: 10,
  bold: true,
  maxWidthMm: 54,
  maxLines: 3,
};

/** A 58×40 layout at 203 dpi, as the JSON import takes it. */
const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    NAME_FIELD,
    { kind: "line", id: "sep", xMm: 2, yMm: 18.2, x2Mm: 56, y2Mm: 18.2, thicknessMm: 0.3 },
  ],
};

/** 58×40 mm at 203 dpi: 464 × 320 dots, one text line. */
const ZPL = ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FDПартия^FS", "^XZ"].join("\n");

describe("checking imported code", () => {
  it("reads JSON with its own resolution and language and keeps the elements", () => {
    const outcome = analyzeImport({
      source: JSON.stringify(JSON_SPEC),
      format: "json",
      dpi: 300,
      purpose: "pallet",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(outcome.analysis.result.spec.elements.map((element) => element.id)).toEqual([
      "name",
      "sep",
    ]);
    expect(outcome.analysis.result.warnings).toEqual([]);
    expect(outcome.analysis.adjustedIds).toEqual([]);
    expect(outcome.analysis).not.toHaveProperty("name");
  });

  it("passes a wrapper's name through and warns about another purpose", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ name: "Паллета 58×40", purpose: "pallet", spec: JSON_SPEC }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.name).toBe("Паллета 58×40");
    expect(outcome.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "PURPOSE_MISMATCH", source: 'purpose: "pallet"' }),
    ]);
  });

  it("moves an element that hangs over the edge inside and names it", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ ...JSON_SPEC, elements: [{ ...NAME_FIELD, xMm: 57 }] }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.adjustedIds).toEqual(["name"]);
    expect(outcome.analysis.result.spec.elements[0]?.xMm).toBeLessThan(57);
  });

  it("turns a schema failure into its issues with dotted paths", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        elements: [{ kind: "text", id: "a", xMm: 1, yMm: 1, text: "x" }],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "elements.0.fontSizePt" }),
        ]),
      },
    });
  });

  it("turns a JSON syntax error into one message and a too large element into its own error", () => {
    expect(analyzeImport({ source: "{", format: "json", dpi: 203, purpose: "box" })).toEqual({
      ok: false,
      error: { kind: "message", message: expect.stringMatching(/^invalid JSON: /) },
    });
    const box = {
      kind: "box",
      id: "b",
      xMm: 0,
      yMm: 0,
      widthMm: 200,
      heightMm: 20,
      thicknessMm: 1,
    };
    expect(
      analyzeImport({
        source: JSON.stringify({ ...JSON_SPEC, elements: [box] }),
        format: "json",
        dpi: 203,
        purpose: "box",
      }),
    ).toEqual({ ok: false, error: { kind: "elementTooLarge" } });
  });

  it("reads ZPL at the chosen resolution and reports a line it drops", () => {
    const at203 = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
    const at300 = analyzeImport({ source: ZPL, format: "zpl", dpi: 300, purpose: "box" });
    expect(at203.ok && at300.ok).toBe(true);
    if (!at203.ok || !at300.ok) return;
    expect(at203.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(at203.analysis.result.spec.elements).toHaveLength(1);
    expect(at300.analysis.result.spec.widthMm).toBeLessThan(at203.analysis.result.spec.widthMm);

    const unsupported = analyzeImport({
      source: ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ"),
      format: "zpl",
      dpi: 203,
      purpose: "box",
    });
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok) return;
    expect(unsupported.analysis.result.warnings).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_COMMAND", line: 5 }),
    ]);
  });

  it("turns a ZPL size over the domain's 300 mm into issues, as JSON", () => {
    expect(
      analyzeImport({
        source: ["^XA", "^PW4000", "^LL4000", "^XZ"].join("\n"),
        format: "zpl",
        dpi: 203,
        purpose: "box",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(/^(widthMm|heightMm)$/) }),
        ]),
      },
    });
  });

  it("reads TSPL", () => {
    const outcome = analyzeImport({
      source: ["SIZE 58 mm, 40 mm", "CLS", 'TEXT 40,40,"0",0,12,12,"{{qty}}"', "PRINT 1"].join(
        "\n",
      ),
      format: "tspl",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({
      widthMm: 58,
      heightMm: 40,
      language: "tspl",
    });
    expect(outcome.analysis.result.spec.elements).toEqual([
      expect.objectContaining({ kind: "field", field: "qty" }),
    ]);
  });

  // Extras beyond the plan (task 2 implementer): guards whose one-line mutants the plan's tests left alive.

  it("measures the layout with the sample data and the code rendering of the purpose", () => {
    const fieldAt = (field: string) =>
      JSON.stringify({
        ...JSON_SPEC,
        elements: [{ ...NAME_FIELD, field, xMm: 40, fontSizePt: 14, maxWidthMm: 30, maxLines: 1 }],
      });
    const matrixAt = JSON.stringify({
      ...JSON_SPEC,
      elements: [
        {
          kind: "barcode",
          id: "km",
          xMm: 50,
          yMm: 2,
          format: "datamatrix",
          data: "km.code",
          sizeMm: 0.5,
        },
      ],
    });
    const adjusted = (source: string, purpose: "box" | "pallet" | "product_duplicate") => {
      const outcome = analyzeImport({ source, format: "json", dpi: 203, purpose });
      return outcome.ok ? outcome.analysis.adjustedIds : outcome;
    };
    // The pallet's quantity (240) is wider than a box's (20); a duplicate has no SSCC to print.
    expect(adjusted(fieldAt("qty"), "box")).toEqual([]);
    expect(adjusted(fieldAt("qty"), "pallet")).toEqual(["name"]);
    expect(adjusted(fieldAt("sscc"), "box")).toEqual(["name"]);
    expect(adjusted(fieldAt("sscc"), "product_duplicate")).toEqual([]);
    // A duplicate draws its code as the raster (sizeMm), the others natively (a 12 mm square).
    expect(adjusted(matrixAt, "box")).toEqual(["km"]);
    expect(adjusted(matrixAt, "product_duplicate")).toEqual([]);
  });

  it("lists the properties the model does not have as warnings with their dotted paths", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        foo: 1,
        elements: [{ ...JSON_SPEC.elements[1], bar: 2 }],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      outcome.analysis.result.warnings.map((warning) => [warning.code, warning.source]),
    ).toEqual([
      ["UNKNOWN_PROPERTY", "elements.0.bar"],
      ["UNKNOWN_PROPERTY", "foo"],
    ]);
  });

  it("names a wrapper whose layout is not an object, and a layout that is not a wrapper", () => {
    expect(
      analyzeImport({ source: '{"spec":1}', format: "json", dpi: 203, purpose: "box" }),
    ).toEqual({ ok: false, error: { kind: "message", message: "spec must be an object" } });
    expect(analyzeImport({ source: "[]", format: "json", dpi: 203, purpose: "box" })).toEqual({
      ok: false,
      error: { kind: "message", message: "expected a label template object" },
    });
  });

  it("reports every schema issue, not only the first", () => {
    const outcome = analyzeImport({ source: "{}", format: "json", dpi: 203, purpose: "box" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== "issues") return;
    expect(outcome.error.issues.map((issue) => issue.path)).toEqual([
      "widthMm",
      "heightMm",
      "dpi",
      "language",
      "elements",
    ]);
  });
});
