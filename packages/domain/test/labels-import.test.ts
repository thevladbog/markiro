import { describe, expect, it } from "vitest";

import { LABEL_FIELDS, MAX_LABEL_CODE_BYTES } from "../src/index.js";
import {
  assertImportInputLimits,
  importedElementId,
  parseTemplatePayload,
} from "../src/labels/import.js";
import { parseZplLabel } from "../src/labels/zpl-import.js";

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
      expect.objectContaining({ code: "LABEL_CODE_INVALID", cause: { line: 12, source: "{{warehouse.bin}}" } }),
    );
    expect(() => parseTemplatePayload("Товар: {{product.name}}", 13)).toThrow(
      expect.objectContaining({ code: "LABEL_CODE_INVALID", cause: { line: 13, source: "Товар: {{product.name}}" } }),
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
          "^FO10,500^GFA,10,10,1,FF^FS",
          "^XZ",
        ].join("\n"),
        203,
      );

      expect(result.spec.elements).toEqual([
        expect.objectContaining({ kind: "barcode", format: "code128", data: { literal: "123" } }),
        expect.objectContaining({ kind: "barcode", format: "ean13", data: { literal: "4600682000013" } }),
        expect.objectContaining({ kind: "barcode", format: "datamatrix" }),
        expect.objectContaining({ kind: "barcode", format: "qr", data: { literal: "https://markiro.app" } }),
        expect.objectContaining({ kind: "line", xMm: expect.any(Number), x2Mm: expect.any(Number) }),
        expect.objectContaining({ kind: "box", widthMm: expect.any(Number), heightMm: expect.any(Number) }),
        expect.objectContaining({ kind: "text", text: "Hello^World" }),
      ]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ line: 10, source: "^FO10,500^GFA,10,10,1,FF^FS" }),
      ]);
    });

    it("rejects missing size, unknown placeholders, and ambiguous commands", () => {
      expect(() => parseZplLabel("^XA^FO1,1^FDtext^FS^XZ", 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
      expect(() =>
        parseZplLabel("^XA^PW400^LL400^FO1,1^FD{{warehouse.bin}}^FS^XZ", 203),
      ).toThrow(expect.objectContaining({ code: "LABEL_CODE_INVALID" }));
      expect(() =>
        parseZplLabel("^XA^PW400^LL400^FO1,1^A0R,20,20^FDtext^FS^XZ", 203),
      ).toThrow(expect.objectContaining({ code: "LABEL_CODE_INVALID" }));
    });
  });
});
