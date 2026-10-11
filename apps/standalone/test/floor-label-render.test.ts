import {
  buildDatedBoxLabelTemplates,
  generateTspl,
  generateZpl,
  withPrinterDpi,
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
