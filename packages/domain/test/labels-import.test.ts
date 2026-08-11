import { describe, expect, it } from "vitest";

import { LABEL_FIELDS, MAX_LABEL_CODE_BYTES } from "../src/index.js";
import {
  assertImportInputLimits,
  importedElementId,
  parseTemplatePayload,
} from "../src/labels/import.js";
import { parseZplLabel } from "../src/labels/zpl-import.js";
import { parseTsplLabel } from "../src/labels/tspl-import.js";
import { parseLabelCode } from "../src/labels/import.js";

describe("label code import contract", () => {
  it("exports one canonical ordered label-field inventory", () => {
    expect(LABEL_FIELDS).toEqual([
      "product.name",
      "product.gtin",
      "km.code",
      "sscc",
      "shift.no",
      "date",
      "qty",
      "operator",
      "counterparty.name",
    ]);
  });

  it("rejects source larger than 256 KiB before language parsing", () => {
    expect(() => assertImportInputLimits("X".repeat(MAX_LABEL_CODE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "LABEL_CODE_TOO_LARGE" }),
    );
  });

  it("recognizes only an exact known field placeholder", () => {
    expect(parseTemplatePayload("{{product.name}}", 7)).toEqual({
      kind: "field",
      field: "product.name",
    });
    expect(parseTemplatePayload("Партия", 8)).toEqual({ kind: "literal", value: "Партия" });
  });

  it("rejects unknown and mixed placeholders with a source location", () => {
    expect(() => parseTemplatePayload("{{warehouse.bin}}", 12)).toThrow(
      expect.objectContaining({
        code: "LABEL_CODE_INVALID",
        cause: { line: 12, source: "{{warehouse.bin}}" },
      }),
    );
    expect(() => parseTemplatePayload("Товар: {{product.name}}", 13)).toThrow(
      expect.objectContaining({
        code: "LABEL_CODE_INVALID",
        cause: { line: 13, source: "Товар: {{product.name}}" },
      }),
    );
  });

  it("creates stable ids from language and element order", () => {
    expect(importedElementId("zpl", 1)).toBe("import-zpl-1");
    expect(importedElementId("tspl", 2)).toBe("import-tspl-2");
  });

  describe("ZPL subset", () => {
    it("imports native text and a field in draw order", () => {
      const result = parseZplLabel(
        [
          "^XA",
          "^PW799",
          "^LL400",
          "^FO80,40^A0N,34,34^FDПартия^FS",
          "^FO80,100^A0N,34,34^FB320,1,0,C,0^FD{{product.name}}^FS",
          "^XZ",
        ].join("\n"),
        203,
      );

      expect(result.spec.widthMm).toBeCloseTo(100, 1);
      expect(result.spec.heightMm).toBeCloseTo(50, 1);
      expect(result.spec.language).toBe("zpl");
      expect(result.spec.elements).toEqual([
        expect.objectContaining({ id: "import-zpl-1", kind: "text", text: "Партия" }),
        expect.objectContaining({
          id: "import-zpl-2",
          kind: "field",
          field: "product.name",
          align: "center",
        }),
      ]);
      expect((result.spec.elements[0] as { fontSizePt: number }).fontSizePt).toBeCloseTo(
        (34 * 72) / 203,
        5,
      );
      expect(result.sourceLineByElementId).toEqual({ "import-zpl-1": 4, "import-zpl-2": 5 });
    });

    it("imports barcodes, a thin line, a box, and decodes ^FH payloads", () => {
      const result = parseZplLabel(
        [
          "^XA",
          "^PW1200^LL800",
          "^FO10,10^BCN,80,N,N,N^FD123^FS",
          "^FO200,10^BEN,80^FD4600682000013^FS",
          "^FO300,10^BXN,4,200,,,,^FD010460068200001321abcDEF1234567^FS",
          "^FO400,10^BQN,2,4^FDQA,https://markiro.app^FS",
          "^FO10,200^GB300,4,4^FS",
          "^FO400,200^GB300,180,4^FS",
          "^FO10,400^FH_^FDHello_5EWorld^FS",
          "^GFA,10,10,1,FF",
          "^XZ",
        ].join("\n"),
        203,
      );

      expect(result.spec.elements).toEqual([
        expect.objectContaining({ kind: "barcode", format: "code128", data: { literal: "123" } }),
        expect.objectContaining({
          kind: "barcode",
          format: "ean13",
          data: { literal: "4600682000013" },
        }),
        expect.objectContaining({ kind: "barcode", format: "datamatrix" }),
        expect.objectContaining({
          kind: "barcode",
          format: "qr",
          data: { literal: "https://markiro.app" },
        }),
        expect.objectContaining({
          kind: "line",
          xMm: expect.any(Number),
          x2Mm: expect.any(Number),
        }),
        expect.objectContaining({
          kind: "box",
          widthMm: expect.any(Number),
          heightMm: expect.any(Number),
        }),
        expect.objectContaining({ kind: "text", text: "Hello^World" }),
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ line: 10, source: "^GFA,10,10,1,FF" }),
      ]);
    });

    it("rejects missing size, unknown placeholders, and ambiguous commands", () => {
      expect(() => parseZplLabel("^XA^FO1,1^FDtext^FS^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseZplLabel("^XA^PW400^LL400^FO1,1^FD{{warehouse.bin}}^FS^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseZplLabel("^XA^PW400^LL400^FO1,1^A0R,20,20^FDtext^FS^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseZplLabel("^XA^PW400^LL400^FO1,1^FDtext^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseZplLabel("^XA^PW400^LL400^FO1,1^FDtext^FS^XZ^XA^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
    });

    it("keeps fields across physical lines and accepts regex-special ^FH indicators", () => {
      const result = parseZplLabel(
        "^XA\n^PW400\n^LL400\n^FO10,10\n^FH[\n^FDHello[5EWorld\n^FS\n^XZ",
        203,
      );
      expect(result.spec.elements[0]).toEqual(expect.objectContaining({ text: "Hello^World" }));
    });
  });

  describe("TSPL subset", () => {
    it("imports text, fields, barcodes, line, and box in source order", () => {
      const source = [
        "SIZE 100 mm, 50 mm",
        "GAP 2 mm, 0 mm",
        "DIRECTION 1",
        "CLS",
        'TEXT 80,40,"0",0,12,12,2,"{{product.name}}"',
        'BARCODE 80,100,"128",80,1,0,2,2,"{{sscc}}"',
        'DMATRIX 300,40,4,4,"{{km.code}}"',
        'QRCODE 400,40,M,4,A,0,"https://markiro.app"',
        "BAR 80,220,160,4",
        "BOX 300,220,480,300,4",
        "PRINT 1",
      ].join("\n");

      const result = parseTsplLabel(source, 203);

      expect(result.spec).toEqual(
        expect.objectContaining({ widthMm: 100, heightMm: 50, dpi: 203, language: "tspl" }),
      );
      expect(result.spec.elements.map((element) => element.kind)).toEqual([
        "field",
        "barcode",
        "barcode",
        "barcode",
        "line",
        "box",
      ]);
      expect(result.spec.elements[0]).toEqual(
        expect.objectContaining({ field: "product.name", align: "center" }),
      );
      expect(result.spec.elements[2]).toEqual(
        expect.objectContaining({ format: "datamatrix", data: "km.code" }),
      );
      expect(result.warnings).toEqual([]);
      expect(result.sourceLineByElementId).toEqual({
        "import-tspl-1": 5,
        "import-tspl-2": 6,
        "import-tspl-3": 7,
        "import-tspl-4": 8,
        "import-tspl-5": 9,
        "import-tspl-6": 10,
      });
      expect(result.spec.elements[4]).toEqual(
        expect.objectContaining({ x2Mm: expect.any(Number), y2Mm: expect.any(Number) }),
      );
      const bar = result.spec.elements[4]!;
      if (bar.kind === "line") {
        expect(bar.y2Mm).toBe(bar.yMm);
        expect(bar.thicknessMm).toBeGreaterThan(0);
      }
      expect(() => parseTsplLabel("SIZE 100 mm, 50 mm\nBAR 10,10,0,4", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
    });

    it("decodes doubled quotes and reports unsupported bitmap lines", () => {
      const result = parseTsplLabel(
        [
          "SIZE 100 mm, 50 mm",
          'TEXT 10,10,"0",0,12,12,"He said ""yes"""',
          "BITMAP 10,100,2,2,1,FF00",
        ].join("\n"),
        203,
      );

      expect(result.spec.elements[0]).toEqual(expect.objectContaining({ text: 'He said "yes"' }));
      expect(result.warnings).toEqual([
        expect.objectContaining({ line: 3, source: "BITMAP 10,100,2,2,1,FF00" }),
      ]);
    });

    it("rejects missing size, rotation, unsupported fonts, and malformed quotes", () => {
      expect(() => parseTsplLabel('TEXT 1,1,"0",0,12,12,"x"', 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseTsplLabel('SIZE 100 mm, 50 mm\nTEXT 1,1,"0",90,12,12,"x"', 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseTsplLabel('SIZE 100 mm, 50 mm\nTEXT 1,1,"1",0,12,12,"x"', 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() => parseTsplLabel('SIZE 100 mm, 50 mm\nTEXT 1,1,"0,0,12,12,"x"', 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
    });

    it("dispatches by language and preserves selected dpi", () => {
      const zpl = parseLabelCode("^XA\n^PW799\n^LL400\n^XZ", { language: "zpl", dpi: 300 });
      const tspl = parseLabelCode("SIZE 100 mm, 50 mm", { language: "tspl", dpi: 300 });
      expect(zpl.spec).toEqual(expect.objectContaining({ language: "zpl", dpi: 300 }));
      expect(tspl.spec).toEqual(expect.objectContaining({ language: "tspl", dpi: 300 }));
    });
  });
});
