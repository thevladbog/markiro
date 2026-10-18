import {
  buildDatedBoxLabelTemplates,
  buildDefaultLabelTemplates,
  buildPalletLabelTemplates,
  decodeMonoRaster,
  generateTspl,
  generateZpl,
  mmToDots,
  sampleLabelData,
  withPrinterDpi,
  type LabelTemplateSpec,
  type MonoBitmap,
  type RasterizeTextFn,
  type RasterResult,
} from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import { boxLabelData, latin1ToBytes, renderLabel } from "../src/floor/print/label-render.js";
import { RasterTooLargeError } from "../src/labels/rasterizer.js";
import { enteredShift, ENTERED, OTHER_GTIN } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRaster } from "./support/printing.js";

const SSCC = "046006820000035007";
const CLOSED_AT = "2026-10-08T06:20:00.000Z";

function decode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

describe("a box label's fields", () => {
  it("come from the shift's snapshot, the box and the operator — never from today's copy", async () => {
    const { executor } = openLocalDb();
    // The host's list renamed the product and the counterparty after the shift opened.
    const shift = await enteredShift(executor, {
      ...ENTERED,
      productName: "Молоко (новое имя)",
      productGtin14: OTHER_GTIN,
      counterpartyName: "ООО «Другой»",
    });
    expect(boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна")).toEqual(
      {
        "product.name": "Молоко 3,2% 0,9 л",
        "product.printName": "Молоко 3,2%",
        "product.gtin": "04600682000013",
        "product.egais": "",
        "km.code": "",
        sscc: SSCC,
        "shift.no": "OCT26-004",
        date: "08.10.2026",
        expiry: "17.10.2026",
        qty: "12",
        "qty.boxes": "",
        operator: "Анна",
        "counterparty.name": "ООО «Северный берег»",
      },
    );
  });
});

describe("a box label's dates", () => {
  const box = { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT };

  /** The entered shift with another production date and shelf life in its frozen product. */
  function shiftWith(productionDate: string, shelfLifeDays: number | null) {
    return {
      ...ENTERED,
      productionDate,
      snapshot: {
        ...ENTERED.snapshot,
        product: { ...ENTERED.snapshot.product, shelfLifeDays },
      },
    };
  }

  it.each([
    // The last usable day inclusive: production day + shelf life - 1.
    [
      "a one-day shelf life expires on the production day",
      "2026-09-10",
      1,
      "10.09.2026",
      "10.09.2026",
    ],
    ["a leap day plus 366 days", "2028-02-29", 366, "29.02.2028", "28.02.2029"],
    ["a year boundary", "2026-12-31", 30, "31.12.2026", "29.01.2027"],
    ["no shelf life leaves the expiry empty", "2026-09-10", null, "10.09.2026", ""],
  ])("print %s", async (_name, productionDate, shelfLifeDays, date, expiry) => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, shiftWith(productionDate, shelfLifeDays));
    const fields = boxLabelData(shift, box, "Анна");
    expect({ date: fields.date, expiry: fields.expiry }).toEqual({ date, expiry });
  });

  it("are the shift's civil days, whatever zone the computer is in and whenever the box closed", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const lateBox = { ...box, closedAt: "2026-10-08T20:00:00.000Z" };
    const realZone = process.env.TZ;
    try {
      const printed = ["UTC", "Asia/Tokyo", "Pacific/Honolulu"].map((zone) => {
        process.env.TZ = zone;
        const fields = boxLabelData(shift, lateBox, "Анна");
        return [fields.date, fields.expiry];
      });
      // Tokyo is already on the 9th at 20:00 UTC: the shift's day (the 8th) still stands.
      expect(printed).toEqual([
        ["08.10.2026", "17.10.2026"],
        ["08.10.2026", "17.10.2026"],
        ["08.10.2026", "17.10.2026"],
      ]);
    } finally {
      if (realZone === undefined) delete process.env.TZ;
      else process.env.TZ = realZone;
    }
  });
});

describe("a label's bytes", () => {
  it("are the domain's document for the printer's language and resolution: the model the office previews", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const spec = shift.snapshot.boxTemplate.spec;
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна");
    const zpl203 = decode(
      await renderLabel(spec, fields, { language: "zpl", dpi: 203 }, fakeRaster),
    );
    const zpl300 = decode(
      await renderLabel(spec, fields, { language: "zpl", dpi: 300 }, fakeRaster),
    );
    const tspl = decode(
      await renderLabel(spec, fields, { language: "tspl", dpi: 300 }, fakeRaster),
    );
    // The template is TSPL at 203 dpi; the printer's language and resolution win.
    expect(zpl203).toBe(await generateZpl(spec, fields, { rasterizeText: fakeRaster }));
    expect(zpl203).toContain("^PW464");
    expect(zpl300).toBe(
      await generateZpl(withPrinterDpi(spec, 300), fields, { rasterizeText: fakeRaster }),
    );
    expect(zpl300).toContain("^PW685");
    expect(tspl).toBe(
      await generateTspl(withPrinterDpi(spec, 300), fields, { rasterizeText: fakeRaster }),
    );
    expect(tspl.startsWith("SIZE 58 mm, 40 mm")).toBe(true);
  });

  it("draw the Cyrillic text through the rasterizer it is given, with the printer's dots", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, null);
    const rasterize = vi.fn<RasterizeTextFn>(fakeRaster);
    await renderLabel(
      shift.snapshot.boxTemplate.spec,
      fields,
      { language: "zpl", dpi: 300 },
      rasterize,
    );
    expect(rasterize).toHaveBeenCalledWith(
      "Молоко 3,2%",
      expect.objectContaining({ fontSizePx: 42, bold: false }),
    );
  });

  it("reject when the rasterizer cannot draw a text, so nothing half-rendered is printed", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, null);
    const refusing: RasterizeTextFn = async (): Promise<RasterResult> => {
      throw new RasterTooLargeError(5000, 32);
    };
    await expect(
      renderLabel(
        shift.snapshot.boxTemplate.spec,
        fields,
        { language: "tspl", dpi: 203 },
        refusing,
      ),
    ).rejects.toBeInstanceOf(RasterTooLargeError);
  });

  it("are, for the stock dated 58 x 40 box label, exactly these bytes: the SSCC as GS1-128 and its digits", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна");
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    const zpl = await renderLabel(stock, fields, { language: "zpl", dpi: 203 }, fakeRaster);
    expect(decode(zpl)).toBe(
      "^XA\n^PW464\n^LL320\n^FO16,16^GFA,2,2,1,FF00^FS\n^FO16,145^GB432,2,2^FS\n" +
        "^FO16,150^GFA,2,2,1,FF00^FS\n^FO160,150^GFA,2,2,1,FF00^FS\n^FO304,150^GFA,2,2,1,FF00^FS\n" +
        "^FO16,173^A0N,23,23^FB144,1,0,L,0^FD08.10.2026^FS\n" +
        "^FO160,173^A0N,23,23^FB144,1,0,L,0^FD17.10.2026^FS\n" +
        "^FO304,167^GFA,2,2,1,FF00^FS\n^FO16,209^GB432,2,2^FS\n^FO16,214^GFA,2,2,1,FF00^FS\n" +
        "^FO160,214^A0N,23,23^FB288,1,0,L,0^FD^FS\n^FO16,251^GB432,2,2^FS\n" +
        "^FO76,256^BY2^BCN,38,N,N,N^FD>;>800046006820000035007^FS\n" +
        "^FO16,296^A0N,14,14^FB432,1,0,C,0^FD(00)046006820000035007^FS\n^XZ\n",
    );

    const tspl = await renderLabel(stock, fields, { language: "tspl", dpi: 203 }, fakeRaster);
    expect(decode(tspl)).toBe(
      "SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\n" +
        "BITMAP 16,16,1,2,0,\u0000\u00ff\nBAR 16,145,432,2\nBITMAP 16,150,1,2,0,\u0000\u00ff\n" +
        "BITMAP 160,150,1,2,0,\u0000\u00ff\nBITMAP 304,150,1,2,0,\u0000\u00ff\n" +
        'TEXT 16,173,"0",0,8,8,"08.10.2026"\nTEXT 160,173,"0",0,8,8,"17.10.2026"\n' +
        "BITMAP 304,167,1,2,0,\u0000\u00ff\nBAR 16,209,432,2\nBITMAP 16,214,1,2,0,\u0000\u00ff\n" +
        'TEXT 160,214,"0",0,8,8,""\nBAR 16,251,432,2\n' +
        'BARCODE 76,256,"EAN128",38,0,0,2,2,"00046006820000035007"\n' +
        'TEXT 147,296,"0",0,5,5,"(00)046006820000035007"\nPRINT 1\n',
    );
    // One byte per bitmap byte: a UTF-8 encoding would send 0xC3 0xBF for 0xFF.
    expect(tspl.includes(0xc3)).toBe(false);
    expect(tspl.filter((byte) => byte === 0xff)).toHaveLength(6);
  });

  it("send the stock label's Cyrillic text to the rasterizer as it is, fitted to the label", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor);
    const fields = boxLabelData(shift, { sscc: SSCC, itemCount: 12, closedAt: CLOSED_AT }, "Анна");
    const stock = buildDatedBoxLabelTemplates()[0]?.spec;
    if (stock === undefined) throw new Error("the domain has no stock box label");
    const rasterize = vi.fn<RasterizeTextFn>(fakeRaster);
    await renderLabel(stock, fields, { language: "zpl", dpi: 203 }, rasterize);
    const drawn = rasterize.mock.calls.map(([text]) => text);
    expect(drawn).toContain("Молоко 3,2% 0,9 л");
    expect(drawn).toContain("12 шт.");
    expect(drawn).toContain("Дата производства:");
    expect(rasterize).toHaveBeenCalledWith(
      "Молоко 3,2% 0,9 л",
      expect.objectContaining({ bold: true, maxWidthPx: 432, maxLines: 3 }),
    );
  });

  it("keep every byte of a latin1 document as one byte", () => {
    expect([...latin1ToBytes("Aÿ\u0080\u001d")]).toEqual([0x41, 0xff, 0x80, 0x1d]);
  });
});

/**
 * A layout holding only an `organization_logo` box of 4 × 2 mm at (2, 2), on a
 * 58 × 40 label: the dots of a logo are the whole document, so its bytes can be
 * checked by hand.
 */
const LOGO_BOX: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      id: "logo",
      kind: "organization_logo",
      source: "organization",
      fallback: "markiro",
      xMm: 2,
      yMm: 2,
      widthMm: 4,
      heightMm: 2,
    },
  ],
};

/** 8 × 2 dots: the first row is ink in its left half, the second in its right half. */
const TWO_ROWS: MonoBitmap = {
  width: 8,
  height: 2,
  stride: 1,
  pixels: new Uint8Array([0xf0, 0x0f]),
};

describe("the organization logo on a label (#703)", () => {
  it("is a ^GFA graphic in ZPL: scaled into its box at 203 dpi, centred in the box's height", async () => {
    const zpl = decode(
      await renderLabel(
        LOGO_BOX,
        sampleLabelData(),
        { language: "zpl", dpi: 203 },
        undefined,
        TWO_ROWS,
      ),
    );
    // 4 × 2 mm is 32 × 16 dots; 8 × 2 grows by 4 to 32 × 8 and sits 4 dots below the box's top
    // (2 mm = 16 dots, + 4). Four rows of FFFF0000, then four rows of 0000FFFF.
    expect(zpl).toBe(
      "^XA\n^PW464\n^LL320\n^FO16,20^GFA,32,32,4," +
        "FFFF0000".repeat(4) +
        "0000FFFF".repeat(4) +
        "^FS\n^XZ\n",
    );
  });

  it("is a BITMAP in TSPL with the bits inverted, at the same place", async () => {
    const tspl = decode(
      await renderLabel(
        LOGO_BOX,
        sampleLabelData(),
        { language: "tspl", dpi: 203 },
        undefined,
        TWO_ROWS,
      ),
    );
    expect(tspl).toBe(
      "SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nBITMAP 16,20,4,8,0," +
        "\u0000\u0000\u00ff\u00ff".repeat(4) +
        "\u00ff\u00ff\u0000\u0000".repeat(4) +
        "\nPRINT 1\n",
    );
  });

  it("is rescaled for a 300 dpi printer from the layout's millimetres (ZPL)", async () => {
    const zpl = decode(
      await renderLabel(
        LOGO_BOX,
        sampleLabelData(),
        { language: "zpl", dpi: 300 },
        undefined,
        TWO_ROWS,
      ),
    );
    // 4 × 2 mm is 47 × 24 dots; 8 × 2 grows by 5.875 to 47 × 12 (6 bytes a row) and sits 6 dots
    // below the box's top (2 mm = 24 dots, + 6). Six rows ink in the left 24 dots, six in the right 23.
    expect(zpl).toBe(
      "^XA\n^PW685\n^LL472\n^FO24,30^GFA,72,72,6," +
        "FFFFFF000000".repeat(6) +
        "000000FFFFFE".repeat(6) +
        "^FS\n^XZ\n",
    );
  });

  it("is rescaled for a 300 dpi printer from the layout's millimetres (TSPL)", async () => {
    const tspl = decode(
      await renderLabel(
        LOGO_BOX,
        sampleLabelData(),
        { language: "tspl", dpi: 300 },
        undefined,
        TWO_ROWS,
      ),
    );
    const head = "SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nBITMAP 24,30,6,12,0,";
    // Inverted: ink is 0. The last bit of a row is padding, white (1), so the right half ends 01.
    expect(tspl).toBe(
      head +
        "\u0000\u0000\u0000\u00ff\u00ff\u00ff".repeat(6) +
        "\u00ff\u00ff\u00ff\u0000\u0000\u0001".repeat(6) +
        "\nPRINT 1\n",
    );
  });

  it("leaves the box empty and the geometry as it was when there is no logo", async () => {
    const withText: LabelTemplateSpec = {
      ...LOGO_BOX,
      elements: [
        { kind: "text", id: "lot", xMm: 4, yMm: 10, text: "LOT", fontSizePt: 10 },
        ...LOGO_BOX.elements,
        { kind: "line", id: "rule", xMm: 4, yMm: 30, x2Mm: 54, y2Mm: 30, thicknessMm: 0.3 },
      ],
    };
    const without: LabelTemplateSpec = {
      ...withText,
      elements: withText.elements.filter((element) => element.kind !== "organization_logo"),
    };
    for (const language of ["zpl", "tspl"] as const) {
      for (const dpi of [203, 300] as const) {
        const printer = { language, dpi };
        const none = await renderLabel(withText, sampleLabelData(), printer);
        const nullLogo = await renderLabel(withText, sampleLabelData(), printer, undefined, null);
        const absent = await renderLabel(without, sampleLabelData(), printer);
        expect(decode(none)).toBe(decode(absent));
        expect(decode(nullLogo)).toBe(decode(absent));
        const drawn = await renderLabel(withText, sampleLabelData(), printer, undefined, TWO_ROWS);
        // Only the logo's own command is added: the rest of the document is the same, in order.
        const drawnText = decode(drawn);
        if (language === "zpl") {
          expect(drawnText.replace(/\^FO\d+,\d+\^GFA,[^\n]*\^FS\n/, "")).toBe(decode(absent));
          expect(drawnText).not.toBe(decode(absent));
        } else {
          expect(drawnText.match(/BITMAP /g)).toHaveLength(1);
          expect(decode(absent)).not.toContain("BITMAP ");
        }
      }
    }
  });

  it("keeps the logo inside its box on the stock layouts at both resolutions, for a wide, a tall and a square logo", async () => {
    const wide: MonoBitmap = {
      width: 64,
      height: 8,
      stride: 8,
      pixels: new Uint8Array(64).fill(0xff),
    };
    const tall: MonoBitmap = {
      width: 8,
      height: 64,
      stride: 1,
      pixels: new Uint8Array(64).fill(0xff),
    };
    const square: MonoBitmap = {
      width: 16,
      height: 16,
      stride: 2,
      pixels: new Uint8Array(32).fill(0xff),
    };
    const layouts = [...buildDefaultLabelTemplates(), ...buildPalletLabelTemplates()].filter(
      (template) => template.spec.elements.some((element) => element.kind === "organization_logo"),
    );
    expect(layouts.length).toBeGreaterThan(0);
    let checked = 0;
    for (const template of layouts) {
      for (const element of template.spec.elements) {
        if (element.kind !== "organization_logo") continue;
        for (const dpi of [203, 300] as const) {
          for (const logo of [wide, tall, square]) {
            const spec = { ...template.spec, elements: [element] };
            const zpl = decode(
              await renderLabel(spec, sampleLabelData(), { language: "zpl", dpi }, undefined, logo),
            );
            const found = /\^FO(\d+),(\d+)\^GFA,(\d+),\d+,(\d+),/.exec(zpl);
            if (found === null) throw new Error(`no graphic for ${template.name} at ${dpi}`);
            const [x = -1, y = -1, total = -1, perRow = 1] = found.slice(1).map(Number);
            const boxX = mmToDots(element.xMm, dpi);
            const boxY = mmToDots(element.yMm, dpi);
            const boxW = mmToDots(element.widthMm, dpi);
            const boxH = mmToDots(element.heightMm, dpi);
            expect(x).toBe(boxX);
            expect(y).toBeGreaterThanOrEqual(boxY);
            expect(perRow).toBeLessThanOrEqual(Math.ceil(boxW / 8));
            expect(y + total / perRow).toBeLessThanOrEqual(boxY + boxH);
            expect(boxX + boxW).toBeLessThanOrEqual(mmToDots(spec.widthMm, dpi));
            expect(boxY + boxH).toBeLessThanOrEqual(mmToDots(spec.heightMm, dpi));
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it("is in a driver page (mono-raster) as the same picture, and absent without a logo", async () => {
    const printer = {
      language: "zpl" as const,
      dpi: 203 as const,
      mode: "windows_driver" as const,
    };
    const blank = await renderLabel(LOGO_BOX, sampleLabelData(), printer);
    const nullLogo = await renderLabel(LOGO_BOX, sampleLabelData(), printer, undefined, null);
    const drawn = await renderLabel(LOGO_BOX, sampleLabelData(), printer, undefined, TWO_ROWS);
    expect(decode(nullLogo)).toBe(decode(blank));
    const page = decodeMonoRaster(drawn);
    // 16 dots in from the left and 20 down: the rows are the ZPL ones, 32 dots wide.
    expect(page.requiredBounds).toEqual({ left: 16, top: 20, right: 48, bottom: 28 });
    expect(decodeMonoRaster(blank).pixels.every((byte) => byte === 0)).toBe(true);
  });
});
