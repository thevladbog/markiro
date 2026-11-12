import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

const data = { ...domain.sampleLabelData(), "shift.lotNumber": "0042Бк07A" };
const spec = {
  widthMm: 75,
  heightMm: 120,
  language: "zpl",
  dpi: 203,
  elements: [
    {
      kind: "text",
      id: "cap-lot-number",
      xMm: 4,
      yMm: 62,
      text: "Номер партии",
      fontSizePt: 10,
      when: { field: "shift.lotNumber", op: "present" },
    },
    {
      kind: "field",
      id: "val-lot-number",
      xMm: 4,
      yMm: 68,
      field: "shift.lotNumber",
      fontSizePt: 12,
      minFontSizePt: 8,
      fontFamily: "monospace",
      maxWidthMm: 67,
      maxLines: 2,
      lineHeight: 1,
    },
  ],
} as const;

it("loads saved label fields from both sides of the lot-number upgrade", () => {
  const legacy = domain.sampleLabelData();
  expect(domain.labelFieldDataSchema.parse(legacy)).toEqual(legacy);
  expect(domain.labelFieldDataSchema.parse(data)).toEqual(data);
});

it("keeps lot number fields and conditional text out of the cloud thermal template contract", () => {
  const caption = spec.elements[0];
  const field = spec.elements[1];
  expect(domain.cloudLabelTemplateSpecStrictSchema.safeParse(spec).success).toBe(false);
  expect(
    domain.cloudLabelTemplateSpecStrictSchema.safeParse({
      ...spec,
      elements: [{ ...field, field: "shift.no" }],
    }).success,
  ).toBe(true);
  expect(domain.cloudLabelTemplateSpecSchema.parse({ ...spec, elements: [caption] })).toEqual({
    ...spec,
    elements: [
      {
        kind: caption.kind,
        id: caption.id,
        xMm: caption.xMm,
        yMm: caption.yMm,
        text: caption.text,
        fontSizePt: caption.fontSizePt,
      },
    ],
  });
  expect(domain.cloudLabelTemplateSpecSchema.safeParse(spec).success).toBe(false);
  expect(domain.labelTemplateSpecStrictSchema.safeParse(spec).success).toBe(true);
});

function recordingRaster() {
  const printed: { text: string; lines: string[]; fontSizePx: number }[] = [];
  const rasterizeText: domain.RasterizeTextFn = async (text, opts) => {
    const measure = (line: string) => line.length * opts.fontSizePx * 0.6;
    const wrap = opts.overflow === "error" ? domain.wrapTextToWidthStrict : domain.wrapTextToWidth;
    const lines = wrap(text, measure, opts.maxWidthPx ?? 4096, opts.maxLines ?? 1);
    const width = Math.max(1, Math.ceil(Math.max(...lines.map(measure))));
    const height = Math.ceil(opts.fontSizePx * (opts.lineHeight ?? 1.5)) * lines.length;
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    printed.push({ text, lines, fontSizePx: opts.fontSizePx });
    return { width, height, bytesPerRow, totalBytes, hex: "80".repeat(totalBytes) };
  };
  return { rasterizeText, printed };
}

describe("conditional thermal lot number", () => {
  it("parses the conditional block and hides both lines without a lot", async () => {
    const template = domain.parseLabelTemplate(spec);
    expect(template.elements[0]).toMatchObject({ when: { field: "shift.lotNumber" } });
    const { rasterizeText, printed } = recordingRaster();
    const plan = await domain.createLabelRenderPlan(template, domain.sampleLabelData(), {
      language: "zpl",
      dpi: 203,
      rasterizeText,
    });
    expect(plan.elements).toHaveLength(0);
    expect(printed).toHaveLength(0);
  });

  it.each([domain.generateZpl, domain.generateTspl])("prints complete text in %p", async (emit) => {
    const template = domain.parseLabelTemplate(spec);
    const { rasterizeText, printed } = recordingRaster();
    await emit(template, data, { rasterizeText });
    expect(printed.map(({ text }) => text)).toEqual(["Номер партии", "0042Бк07A"]);
  });

  it("wraps an unbroken mixed-script number before reducing its font", async () => {
    const template = domain.parseLabelTemplate(spec);
    const { rasterizeText, printed } = recordingRaster();
    const longLot = "0042Бк07A".repeat(5);
    await domain.generateZpl(template, { ...data, "shift.lotNumber": longLot }, { rasterizeText });
    const value = printed.find(({ text }) => text === longLot);
    expect(value?.lines).toHaveLength(2);
    expect(value?.lines.join("")).toBe(longLot);
    expect(value?.fontSizePx).toBe(34);
  });

  it("uses a smaller font to fit in two lines and refuses text beyond the floor", async () => {
    const template = domain.parseLabelTemplate(spec);
    const { rasterizeText, printed } = recordingRaster();
    const longLot = "0042Бк07A".repeat(7);
    await domain.generateTspl(template, { ...data, "shift.lotNumber": longLot }, { rasterizeText });
    const value = printed.find(({ text }) => text === longLot);
    expect(value?.lines).toHaveLength(2);
    expect(value?.lines.join("")).toBe(longLot);
    expect(value?.fontSizePx).toBeLessThan(34);
    expect(value?.fontSizePx).toBeGreaterThanOrEqual(23);
    await expect(
      domain.generateZpl(
        template,
        { ...data, "shift.lotNumber": "0042Бк07A".repeat(100) },
        { rasterizeText },
      ),
    ).rejects.toMatchObject({ code: "LABEL_LOT_NUMBER_OVERFLOW" });
  });
});

it("links same-size stock variants without changing the legacy sources", () => {
  const variants = domain.buildStockLotNumberLabelVariants();
  expect(variants).toHaveLength(23);
  for (const { sourceSpec, spec: variant } of variants) {
    expect(variant).toMatchObject({
      widthMm: sourceSpec.widthMm,
      heightMm: sourceSpec.heightMm,
      language: sourceSpec.language,
      dpi: sourceSpec.dpi,
    });
    expect(domain.labelTemplateUsesField(sourceSpec, "shift.lotNumber")).toBe(false);
    expect(
      domain.labelTemplateUsesField(domain.parseLabelTemplate(variant), "shift.lotNumber"),
    ).toBe(true);
    for (const symbol of sourceSpec.elements.filter((element) => element.kind === "barcode")) {
      const variantSymbol = variant.elements.find((element) => element.id === symbol.id);
      expect(variantSymbol?.kind).toBe("barcode");
      if (variantSymbol?.kind === "barcode") {
        expect(variantSymbol.sizeMm).toBe(symbol.sizeMm);
        expect(variantSymbol.moduleWidthMm).toBe(symbol.moduleWidthMm);
      }
    }
  }
});

it("keeps both name fields in the dated and date-free 75×120 box layouts", () => {
  const boxes = domain
    .buildStockLotNumberLabelVariants()
    .filter(
      ({ purpose, spec }) => purpose === "box" && spec.widthMm === 75 && spec.heightMm === 120,
    );
  const names = boxes.map(({ sourceName, updatedSourceSpec, spec }) => {
    const field = spec.elements.find(({ id }) => id === "val-name");
    expect(updatedSourceSpec?.elements.find(({ id }) => id === "val-name")).toEqual(field);
    return [sourceName, field?.kind === "field" ? field.field : null];
  });
  expect(names).toEqual([
    ["Коробка 75×120", "product.name"],
    ["Коробка 75×120 без дат", "product.name"],
    ["Коробка 75×120 [Назв. для печати]", "product.printName"],
    ["Коробка 75×120 без дат [Назв. для печати]", "product.printName"],
  ]);
});

it("offers both 75×120 duplicate layouts with one complete marking code", () => {
  const wide = domain
    .buildStockLotNumberLabelVariants()
    .filter(({ purpose, spec }) => purpose === "product_duplicate" && spec.widthMm === 75);
  expect(wide.map(({ spec }) => spec.elements.find(({ id }) => id === "product"))).toEqual([
    expect.objectContaining({ field: "product.name", fontSizePt: 17, bold: true, maxLines: 3 }),
    expect.objectContaining({
      field: "product.printName",
      fontSizePt: 17,
      bold: true,
      maxLines: 3,
    }),
  ]);
  for (const { sourceSpec, spec: variant } of wide) {
    for (const layout of [sourceSpec, variant]) {
      expect(domain.labelTemplateSpecStrictSchema.parse(layout).heightMm).toBe(120);
      expect(() => domain.assertDuplicateTemplate(layout)).not.toThrow();
      expect(layout.elements.filter((element) => element.kind === "barcode")).toEqual([
        expect.objectContaining({ format: "datamatrix", data: "km.code", sizeMm: 30 }),
      ]);
    }
  }
});

it("keeps the geometry when converting cloud pallet label resolution", () => {
  const pallet = domain.buildPalletLabelTemplates().find(({ spec }) => spec.widthMm === 75);
  if (!pallet) throw new Error("Missing 75×120 pallet");
  expect(domain.withPrinterDpi(pallet.spec, 300).elements).toBe(pallet.spec.elements);
});

it("renders the pallet lot in both printer languages only when a lot is assigned", async () => {
  const pallet = domain
    .buildStockLotNumberLabelVariants()
    .find(({ purpose, spec }) => purpose === "pallet" && spec.widthMm === 75);
  if (!pallet?.updatedSourceSpec) throw new Error("Missing 75×120 pallet");
  for (const layout of [pallet.spec, pallet.updatedSourceSpec]) {
    const title = layout.elements.find(({ id }) => id === "val-name");
    if (title?.kind !== "field") throw new Error("Missing product title");
    const otherText = layout.elements.filter(
      (element) => element !== title && (element.kind === "field" || element.kind === "text"),
    );
    expect(
      otherText.every(
        (element) => !("fontFamily" in element) || element.fontFamily !== "monospace",
      ),
    ).toBe(true);
    expect(
      otherText.every(
        (element) => !("fontSizePt" in element) || element.fontSizePt < title.fontSizePt,
      ),
    ).toBe(true);
  }
  for (const emit of [domain.generateZpl, domain.generateTspl]) {
    for (const hasLot of [true, false]) {
      const { rasterizeText, printed } = recordingRaster();
      await emit(pallet.spec, hasLot ? data : domain.sampleLabelData(), { rasterizeText });
      expect(printed.some(({ text }) => text === "Номер партии")).toBe(hasLot);
      expect(printed.some(({ text }) => text === data["shift.lotNumber"])).toBe(hasLot);
      expect(printed.map(({ text }) => text)).toEqual(
        expect.arrayContaining(["12 кор.", "20 шт."]),
      );
    }
  }
});

it.each([203, 300] as const)("centres the SSCC of a 75×120 pallet at %i dpi", async (dpi) => {
  const pallet = domain
    .buildAutonomStockLabelTemplates()
    .find(({ purpose, spec }) => purpose === "pallet" && spec.widthMm === 75);
  if (!pallet) throw new Error("Missing 75×120 pallet");
  const { rasterizeText } = recordingRaster();
  const spec = domain.withAutonomPrinterDpi(pallet.spec, dpi);
  for (const language of ["zpl", "tspl"] as const) {
    const plan = await domain.createLabelRenderPlan(spec, domain.sampleLabelData(), {
      language,
      dpi,
      rasterizeText,
    });
    const symbol = plan.elements.find(({ id }) => id === "bc-sscc");
    expect(symbol?.kind).toBe("barcode");
    if (symbol?.kind !== "barcode") throw new Error("Missing SSCC");
    const labelWidth = domain.mmToDots(spec.widthMm, dpi);
    expect(Math.abs(2 * symbol.xDots + symbol.widthDots - labelWidth)).toBeLessThanOrEqual(1);
  }
});

it.each([203, 300] as const)(
  "aligns quantities and the lot in the 75×120 pallet at %i dpi",
  async (dpi) => {
    const pallet = domain
      .buildStockLotNumberLabelVariants()
      .find(({ purpose, spec }) => purpose === "pallet" && spec.widthMm === 75);
    if (!pallet) throw new Error("Missing 75×120 pallet");
    const { rasterizeText, printed } = recordingRaster();
    const plan = await domain.createLabelRenderPlan(domain.withPrinterDpi(pallet.spec, dpi), data, {
      language: "zpl",
      dpi,
      rasterizeText,
    });
    const values = ["val-boxes", "val-units", "val-date", "val-lot-number"].map((id) => {
      const element = plan.elements.find((candidate) => candidate.id === id);
      if (element?.kind !== "raster") throw new Error(`Missing raster ${id}`);
      return element;
    });
    const right = values.map(({ xDots, raster }) => xDots + raster.width);
    expect(new Set(right).size).toBe(1);
    expect(values.at(-1)?.yDots).toBe(
      plan.elements.find(({ id }) => id === "cap-lot-number")?.yDots,
    );
    expect(printed.find(({ text }) => text === data["shift.lotNumber"])?.lines).toEqual([
      data["shift.lotNumber"],
    ]);
  },
);

it("keeps the host stock fixture synchronized with the stock variant builders", () => {
  const fixtureUrl = new URL(
    "../../../apps/standalone/host/stock/lot-number-variants.json",
    import.meta.url,
  );
  const fixture = readFileSync(fixtureUrl, "utf8");
  const variants = {
    labels: domain.buildStockLotNumberLabelVariants(),
    sheets: domain.buildPalletSheetLotNumberPresets(),
  };
  expect(JSON.parse(fixture)).toEqual(JSON.parse(JSON.stringify(variants)));
});

it("renders the complete lot number independently of EGAIS on an A4 two-up sheet", async () => {
  const preset = domain
    .buildPalletSheetLotNumberPresets()
    .find((p) => p.sourceKey === "pallet-a4-two-a5");
  if (!preset) throw new Error("Missing A5 lot-number layout");
  const logo = {
    width: 8,
    height: 1,
    stride: 1,
    pixels: new Uint8Array([128]),
    digest: "sample",
    source: "markiro" as const,
  };
  const context = {
    sscc: "146000000000001231",
    productPrintName: "Вода питьевая",
    gtin14: "04600000000015",
    egaisCode: null,
    productionDate: null,
    shelfLifeDays: null,
    boxCount: 48,
    itemCount: 576,
    shiftNumber: "OCT26-014/S",
    organizationName: "Завод",
    logo,
  };
  const geometry = domain.nominalSheetGeometry(preset.spec);
  const { rasterizeText, printed } = recordingRaster();
  await domain.renderPalletSheet(preset.spec, context, geometry, rasterizeText);
  expect(printed.map(({ text }) => text)).not.toContain("Номер партии");
  printed.length = 0;
  const lotNumber = "0042Бк07A".repeat(7);
  await domain.renderPalletSheet(preset.spec, { ...context, lotNumber }, geometry, rasterizeText);
  expect(printed.map(({ text }) => text)).toContain("Номер партии");
  expect(printed.map(({ text }) => text)).not.toContain("КОД ЕГАИС");
  expect(printed.find(({ text }) => text === lotNumber)?.lines.join("")).toBe(lotNumber);
  printed.length = 0;
  await domain.renderPalletSheet(
    preset.spec,
    {
      ...context,
      egaisCode: "0101234567890123456",
      productionDate: "2026-11-11",
      shelfLifeDays: 180,
      lotNumber,
    },
    geometry,
    rasterizeText,
  );
  expect(printed.map(({ text }) => text)).toContain("КОД ЕГАИС");
  expect(printed.find(({ text }) => text === lotNumber)?.lines.join("")).toBe(lotNumber);
});

it("limits font measurement to the characters a bounded label could actually hold", () => {
  let measuredChars = 0;
  expect(() =>
    domain.wrapTextToWidthStrict(
      "Ж".repeat(100_000),
      (text) => {
        measuredChars += text.length;
        return text.length;
      },
      10,
      2,
    ),
  ).toThrowError(expect.objectContaining({ code: "LABEL_TEXT_OVERFLOW" }));
  expect(measuredChars).toBeLessThan(200);
});

it.each([
  [
    "zpl",
    "^XA^PW600^LL960^FO32,100^A0N,28,28^FB536,2,0,L,0^FD{{shift.lotNumber}}^FS^XZ",
    "^XA^PW600^LL960^FO32,100^BCN,60,N,N,N^FD{{shift.lotNumber}}^FS^XZ",
  ],
  [
    "tspl",
    'SIZE 75 mm,120 mm\nCLS\nTEXT 32,100,"0",0,10,10,"{{shift.lotNumber}}"\nPRINT 1',
    'SIZE 75 mm,120 mm\nCLS\nBARCODE 32,100,"128",60,0,0,2,2,"{{shift.lotNumber}}"\nPRINT 1',
  ],
] as const)("imports a %s lot number only as printable text", (language, text, barcode) => {
  const options = { language, dpi: 203 } as const;
  expect(domain.parseLabelCode(text, options).spec.elements).toEqual([
    expect.objectContaining({ kind: "field", field: "shift.lotNumber" }),
  ]);
  expect(() => domain.parseLabelCode(barcode, options)).toThrow(
    expect.objectContaining({ code: "LABEL_CODE_INVALID" }),
  );
});
