import { describe, expect, it } from "vitest";

import { analyzeImport } from "../src/pages/labels/editor/import-analysis.js";

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

/** Four elements of the pallet 58×40 layout from the JSON-import task. */
const JSON_SPEC = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    NAME_FIELD,
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
      kind: "field",
      id: "val-date",
      xMm: 2,
      yMm: 21.6,
      field: "date",
      fontSizePt: 8,
      bold: true,
      maxWidthMm: 18,
    },
  ],
};

const ZPL = ["^XA", "^PW464", "^LL320", "^FO40,40^A0N,34,34^FDПартия^FS", "^XZ"].join("\n");

describe("analyzeImport", () => {
  it("parses JSON with the label's own dpi and language and keeps the elements", () => {
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
      "sep1",
      "cap-date",
      "val-date",
    ]);
    expect(outcome.analysis.result.warnings).toEqual([]);
    expect(outcome.analysis).not.toHaveProperty("name");
  });

  it("passes a wrapper name through and reports a purpose mismatch as a warning", () => {
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

  it("fits an element that hangs over the edge and reports its id", () => {
    const outcome = analyzeImport({
      source: JSON.stringify({ ...JSON_SPEC, elements: [{ ...NAME_FIELD, xMm: 57 }] }),
      format: "json",
      dpi: 203,
      purpose: "pallet",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.adjustedIds).toEqual(["name"]);
  });

  it("turns schema failures into an issue list with dotted paths", () => {
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

  it("turns a ZPL dimension overflow into an issue list, same as JSON", () => {
    // 4000 dots at 203 dpi is 4000 * 25.4 / 203 ~= 500mm, over the schema's
    // 300mm max for both widthMm and heightMm -- the realistic trigger is
    // picking the wrong import DPI for a label authored at a higher one.
    const outcome = analyzeImport({
      source: ["^XA", "^PW4000", "^LL4000", "^XZ"].join("\n"),
      format: "zpl",
      dpi: 203,
      purpose: "box",
    });
    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: "issues",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(/^(widthMm|heightMm)$/) }),
        ]),
      },
    });
  });

  it("turns a JSON syntax error and an oversized element into single messages", () => {
    const syntax = analyzeImport({ source: "{", format: "json", dpi: 203, purpose: "box" });
    expect(syntax).toEqual({
      ok: false,
      error: { kind: "message", message: expect.stringMatching(/^invalid JSON: /) },
    });

    const tooLarge = analyzeImport({
      source: JSON.stringify({
        ...JSON_SPEC,
        elements: [
          { kind: "box", id: "b", xMm: 0, yMm: 0, widthMm: 200, heightMm: 200, thicknessMm: 1 },
        ],
      }),
      format: "json",
      dpi: 203,
      purpose: "box",
    });
    expect(tooLarge).toEqual({ ok: false, error: { kind: "elementTooLarge" } });
  });

  it("still routes ZPL and TSPL through parseLabelCode with the chosen dpi", () => {
    const outcome = analyzeImport({ source: ZPL, format: "zpl", dpi: 203, purpose: "box" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.analysis.result.spec).toMatchObject({ dpi: 203, language: "zpl" });
    expect(outcome.analysis.result.spec.elements).toHaveLength(1);
    expect(outcome.analysis.result.sourceLineByElementId).toEqual({ "import-zpl-1": 4 });

    const unsupported = analyzeImport({
      source: `${ZPL.replace("^XZ", "^GFA,10,10,1,FF\n^XZ")}`,
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
});
