import { describe, expect, it, vi } from "vitest";
import type { LabelTemplateSpec, RasterResult } from "@markiro/domain";

import {
  inventoryBoxLabelFields,
  renderInventoryBoxLabel,
} from "../src/lib/inventory-box-label.js";

const INPUT = {
  sscc: "046006820000621515",
  quantity: 6,
  productName: "Пиво светлое 0,45 л",
  productPrintName: "Пиво 0,45 л",
  gtin14: "04680089900038",
  egaisCode: "0101234567890123456",
  shelfLifeDays: 184,
  productionDate: "2026-08-19",
} as const;

const SPEC: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    {
      id: "name",
      kind: "field",
      field: "product.printName",
      xMm: 2,
      yMm: 2,
      fontSizePt: 10,
    },
    { id: "sscc", kind: "barcode", format: "code128", data: "sscc", xMm: 2, yMm: 12, sizeMm: 8 },
    { id: "date", kind: "field", field: "date", xMm: 2, yMm: 24, fontSizePt: 8 },
    { id: "expiry", kind: "field", field: "expiry", xMm: 22, yMm: 24, fontSizePt: 8 },
    { id: "qty", kind: "field", field: "qty", xMm: 48, yMm: 24, fontSizePt: 8 },
  ],
};

const raster: RasterResult = {
  hex: "A5",
  totalBytes: 1,
  bytesPerRow: 1,
  width: 8,
  height: 1,
};

describe("inventory box label", () => {
  it("freezes the observed civil date, quantity, product facts, expiry and bare SSCC", () => {
    expect(inventoryBoxLabelFields(INPUT)).toEqual({
      "product.name": "Пиво светлое 0,45 л",
      "product.printName": "Пиво 0,45 л",
      "product.gtin": "04680089900038",
      "product.egais": "0101234567890123456",
      "km.code": "",
      sscc: "046006820000621515",
      "shift.no": "",
      date: "19.08.2026",
      expiry: "19.02.2027",
      qty: "6",
      operator: "",
      "counterparty.name": "",
    });
  });

  it("keeps expiry blank when the frozen shelf life is absent or invalid", () => {
    expect(inventoryBoxLabelFields({ ...INPUT, shelfLifeDays: null }).expiry).toBe("");
    expect(inventoryBoxLabelFields({ ...INPUT, shelfLifeDays: 0 }).expiry).toBe("");
  });

  it("emits stable ZPL and TSPL bytes from the same frozen facts and bare SSCC", async () => {
    const rasterize = vi.fn(async () => raster);
    const zpl = await renderInventoryBoxLabel(SPEC, INPUT, "zpl", rasterize);
    const tspl = await renderInventoryBoxLabel(SPEC, INPUT, "tspl", rasterize);

    expect(new TextDecoder("latin1").decode(zpl)).toBe(
      "^XA\n^PW464\n^LL320\n^FO16,16^GFA,1,1,1,A5^FS\n^FO16,96^BCN,64,N,N,N^FD>;>800046006820000621515^FS\n^FO16,192^A0N,23,23^FD19.08.2026^FS\n^FO176,192^A0N,23,23^FD19.02.2027^FS\n^FO384,192^GFA,1,1,1,A5^FS\n^XZ\n",
    );
    expect(new TextDecoder("latin1").decode(tspl)).toBe(
      'SIZE 58 mm, 40 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nBITMAP 16,16,1,1,0,Z\nBARCODE 16,96,"128",64,0,0,2,2,"!100046006820000621515"\nTEXT 16,192,"0",0,8,8,"19.08.2026"\nTEXT 176,192,"0",0,8,8,"19.02.2027"\nBITMAP 384,192,1,1,0,Z\nPRINT 1\n',
    );
    expect(rasterize).toHaveBeenCalledWith(
      "Пиво 0,45 л",
      expect.objectContaining({ fontFamily: "sans-serif" }),
    );
  });

  it("rejects a presented or malformed SSCC instead of changing label identity", () => {
    expect(() => inventoryBoxLabelFields({ ...INPUT, sscc: "(00)046006820000621515" })).toThrow(
      "inventory box SSCC is invalid",
    );
  });

  it("rejects an 18-digit SSCC with an invalid GS1 check digit", () => {
    expect(() => inventoryBoxLabelFields({ ...INPUT, sscc: "046006820000621519" })).toThrow(
      "inventory box SSCC is invalid",
    );
  });
});
