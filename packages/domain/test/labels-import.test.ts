import { describe, expect, it } from "vitest";

import {
  generateZpl,
  LABEL_FIELDS,
  MAX_LABEL_CODE_BYTES,
  parseLabelTemplate,
  sampleLabelData,
} from "../src/index.js";
import {
  assertImportInputLimits,
  importedElementId,
  parseTemplatePayload,
  parseLabelCode,
} from "../src/labels/import.js";
import { parseZplLabel } from "../src/labels/zpl-import.js";
import { parseTsplLabel } from "../src/labels/tspl-import.js";
import { generateTspl } from "../src/labels/tspl.js";
import { buildSscc } from "../src/gs1/sscc.js";

describe("label code import contract", () => {
  it("exports one canonical ordered label-field inventory", () => {
    expect(LABEL_FIELDS).toEqual([
      "product.name",
      "product.printName",
      "product.gtin",
      "product.egais",
      "km.code",
      "sscc",
      "shift.no",
      "date",
      "expiry",
      "qty",
      "qty.boxes",
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
    expect(parseTemplatePayload("{{product.egais}}", 9)).toEqual({
      kind: "field",
      field: "product.egais",
    });
    expect(parseTemplatePayload("{{expiry}}", 10)).toEqual({ kind: "field", field: "expiry" });
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
    it("keeps modal module width across fields without applying it to a matrix", () => {
      const { spec } = parseZplLabel(
        "^XA^PW800^LL800^BY3^FO20,20^BCN,60,N,N,N^FD{{sscc}}^FS" +
          "^FO20,100^BEN,60,N^FD{{product.gtin}}^FS" +
          "^FO20,200^BXN,100^FD{{km.code}}^FS^XZ",
        203,
      );
      expect(spec.elements[0]).toMatchObject({ moduleWidthMm: (3 * 25.4) / 203 });
      expect(spec.elements[1]).toMatchObject({ moduleWidthMm: (3 * 25.4) / 203 });
      expect(spec.elements[2]).not.toHaveProperty("moduleWidthMm");
      expect(
        parseZplLabel("^XA^PW800^LL800^FO20,20^BCN,60,N,N,N^FD{{sscc}}^FS^XZ", 203).spec
          .elements[0],
      ).not.toHaveProperty("moduleWidthMm");
    });

    it.each(["0", "11", "2.5", "invalid", ""])("rejects invalid ^BY module width %s", (width) => {
      expect(() => parseZplLabel(`^XA^PW800^LL800^BY${width}^XZ`, 203)).toThrow(
        expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
      );
    });

    it("preserves explicit linear barcode module width for imported SSCC labels", () => {
      const result = parseZplLabel(
        "^XA\n^PW464\n^LL320\n^FO16,200^BY2^BCN,64,N,N,N^FD{{sscc}}^FS\n^XZ",
        203,
      );
      expect(result.warnings).toEqual([]);
      expect(result.spec.elements).toEqual([
        expect.objectContaining({
          format: "code128",
          data: "sscc",
          moduleWidthMm: (2 * 25.4) / 203,
        }),
      ]);
    });

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

    it("reads the ^FB line count into maxLines and leaves single-line fields untouched", () => {
      const result = parseZplLabel(
        [
          "^XA",
          "^PW464",
          "^LL320",
          "^FO16,16^A0N,28,28^FB432,3,0,L,0^FD{{product.printName}}^FS",
          "^FO16,120^A0N,28,28^FB432,1,0,C,0^FDОдна строка^FS",
          "^FO16,160^A0N,28,28^FB432^FDБез счётчика^FS",
          "^FO16,200^A0N,28,28^FB432,99,0,L,0^FDПотолок^FS",
          "^FO16,240^A0N,28,28^FB432,2.5,0,L,0^FDДробь^FS",
          "^XZ",
        ].join("\n"),
        203,
      );

      const [wrapped, single, bare, capped, fractional] = result.spec.elements;
      expect(wrapped).toMatchObject({ kind: "field", field: "product.printName", maxLines: 3 });
      expect(single).not.toHaveProperty("maxLines");
      expect(bare).not.toHaveProperty("maxLines");
      expect(capped).toMatchObject({ kind: "text", text: "Потолок", maxLines: 16 });
      expect(fractional).not.toHaveProperty("maxLines");
    });

    it("round-trips maxLines through generateZpl", async () => {
      const spec = parseLabelTemplate({
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
            maxWidthMm: 54,
            maxLines: 3,
          },
        ],
      });
      // Latin-only data keeps the emitter on the native ^A0N/^FB path: a
      // Cyrillic value is rasterized into ^GFA, which the importer reports
      // as unsupported.
      const zpl = await generateZpl(spec, {
        ...sampleLabelData(),
        "product.printName": "Plain name",
      });
      expect(zpl).toMatch(/\^FB432,3,0,[LCR],0/);

      const back = parseZplLabel(zpl, 203);
      expect(back.spec.elements[0]).toMatchObject({
        kind: "text",
        text: "Plain name",
        maxLines: 3,
      });
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

    it("reads back as the SSCC field the EAN128 the domain writes for it", async () => {
      const spec = parseLabelTemplate({
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "tspl",
        elements: [
          {
            kind: "barcode",
            id: "b1",
            xMm: 5,
            yMm: 5,
            format: "code128",
            data: "sscc",
            sizeMm: 10,
          },
        ],
      });
      const exported = await generateTspl(spec, sampleLabelData());
      expect(exported).toContain('"EAN128"');
      const result = parseTsplLabel(exported, 203);
      expect(result.spec.elements).toEqual([
        expect.objectContaining({ kind: "barcode", format: "code128", data: "sscc" }),
      ]);
      expect(result.warnings).toEqual([]);
      for (const payload of ["00{{sscc}}", "{{sscc}}"]) {
        const again = parseTsplLabel(
          `SIZE 58 mm, 40 mm\nBARCODE 40,40,"EAN128",80,0,0,2,2,"${payload}"`,
          203,
        );
        expect(again.spec.elements[0]).toEqual(
          expect.objectContaining({ format: "code128", data: "sscc" }),
        );
      }
    });

    it("round-trips the EAN128 the domain writes for any valid SSCC", async () => {
      const spec = parseLabelTemplate({
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "tspl",
        elements: [
          {
            kind: "barcode",
            id: "b1",
            xMm: 5,
            yMm: 5,
            format: "code128",
            data: "sscc",
            sizeMm: 10,
          },
        ],
      });
      let checked = 0;
      for (const extension of [0, 3, 9]) {
        for (const prefix of ["4600682", "46006820", "460068200"]) {
          for (const serial of [0, 1, 7, 12345, 99999]) {
            const sscc = buildSscc(extension, prefix, serial);
            const exported = await generateTspl(spec, { ...sampleLabelData(), sscc });
            expect(exported).toContain(`"EAN128",`);
            expect(exported).toContain(`"00${sscc}"`);
            const result = parseTsplLabel(exported, 203);
            expect(result.spec.elements).toEqual([
              expect.objectContaining({ kind: "barcode", format: "code128", data: "sscc" }),
            ]);
            expect(result.warnings).toEqual([]);
            checked += 1;
          }
        }
      }
      expect(checked).toBe(45);
    });

    it("refuses an EAN128 that holds no SSCC", () => {
      for (const payload of [
        "0012345",
        "0104600682000013",
        "00004601234560000018",
        "{{product.gtin}}",
        "00{{product.gtin}}",
        "0000{{sscc}}",
        "{{sscc}}00",
        "0 0346006820000000014",
        "01346006820000000014",
        "003460068200000000140",
        "00346006820000000015",
      ]) {
        expect(
          () =>
            parseTsplLabel(
              `SIZE 58 mm, 40 mm\nBARCODE 40,40,"EAN128",80,0,0,2,2,"${payload}"`,
              203,
            ),
          payload,
        ).toThrow(expect.objectContaining({ code: "LABEL_CODE_INVALID" }));
      }
    });

    it("reads an EAN128 with 00 and a valid SSCC as the SSCC field, type case-insensitive", () => {
      for (const type of ["EAN128", "ean128"]) {
        const result = parseTsplLabel(
          `SIZE 58 mm, 40 mm\nBARCODE 40,40,"${type}",80,0,0,2,2,"00346006820000000014"`,
          203,
        );
        expect(result.spec.elements).toEqual([
          expect.objectContaining({ kind: "barcode", format: "code128", data: "sscc" }),
        ]);
      }
    });

    it("keeps reading the 128 and EAN13 barcodes it read before", () => {
      const result = parseTsplLabel(
        [
          "SIZE 58 mm, 40 mm",
          'BARCODE 40,40,"128",80,0,0,2,2,"{{product.gtin}}"',
          'BARCODE 40,140,"128",80,0,0,2,2,"{{sscc}}"',
          'BARCODE 40,240,"128",80,0,0,2,2,"ABC-123"',
          'BARCODE 40,340,"EAN13",80,0,0,2,2,"4600682000013"',
          'BARCODE 40,440,"EAN13",80,0,0,2,2,"{{product.gtin}}"',
        ].join("\n"),
        203,
      );
      expect(result.spec.elements).toEqual([
        expect.objectContaining({ format: "code128", data: "product.gtin" }),
        expect.objectContaining({ format: "code128", data: "sscc" }),
        expect.objectContaining({ format: "code128", data: { literal: "ABC-123" } }),
        expect.objectContaining({ format: "ean13", data: { literal: "4600682000013" } }),
        expect.objectContaining({ format: "ean13", data: "product.gtin" }),
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("leaves the 128 the old export wrote with a literal !1 as the literal it is", () => {
      // The pre-#692 export wrote "128" with "!100<sscc>"; only EAN128 is read as the SSCC field.
      const result = parseTsplLabel(
        'SIZE 58 mm, 40 mm\nBARCODE 40,40,"128",80,0,0,2,2,"!100346006820000000014"',
        203,
      );
      expect(result.spec.elements).toEqual([
        expect.objectContaining({
          format: "code128",
          data: { literal: "!100346006820000000014" },
        }),
      ]);
    });

    it("still refuses unknown TSPL barcode types", () => {
      for (const type of ["39", "93", "EAN8", "EAN128M", "UPCA"]) {
        expect(() =>
          parseTsplLabel(`SIZE 58 mm, 40 mm\nBARCODE 40,40,"${type}",80,0,0,2,2,"12345"`, 203),
        ).toThrow(expect.objectContaining({ code: "LABEL_CODE_INVALID" }));
      }
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
