import { describe, expect, it } from "vitest";

import {
  boxLabelFields,
  buildDefaultLabelTemplates,
  buildPalletSheetPresets,
  palletLabelFields,
  type LabelTemplateSpec,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import type { EnteredShift } from "../src/host/protocol.js";
import { boxLabelData, palletLabelData, renderLabel } from "../src/floor/print/label-render.js";
import { EGAIS_NOT_ON_SHEET_LINE, renderShiftSheet } from "../src/floor/print/shift-render.js";
import { sourceFields } from "../src/floor/warehouse/warehouse-work.js";
import { renderSheetBytes } from "../src/labels/sheet-render.js";
import { sheetLogoOf } from "../src/labels/logo.js";
import { enteredShift, ENTERED } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import { FIRST_SSCC } from "./support/printing.js";
import { BOX_SOURCE } from "./support/warehouse.js";

const EGAIS = "0150320000001234567";
const BOX = { sscc: "046006820000035007", itemCount: 20, closedAt: "2026-10-08T08:00:00.000Z" };
const PALLET = { sscc: FIRST_SSCC, boxCount: 3, itemCount: 60, closedAt: BOX.closedAt };

/** `ENTERED` with its frozen product changed by `product`; without an `egaisCode` key the snapshot has none. */
function frozen(product: {
  chzProductGroupCode?: number;
  egaisCode?: string | null;
}): EnteredShift {
  const base = { ...ENTERED.snapshot.product };
  if (!("egaisCode" in product)) delete base.egaisCode;
  return {
    ...ENTERED,
    snapshot: { ...ENTERED.snapshot, product: { ...base, ...product } },
  };
}

/** The shift stored and read back as the work screen gets it. */
async function stored(shift: EnteredShift) {
  const { executor } = openLocalDb();
  return enteredShift(executor, shift);
}

/** A rasterizer whose bytes spell the text, so a label's bytes tell its texts apart. */
const spelling: RasterizeTextFn = async (value) => {
  const codes = [...value].map((char) => (char.codePointAt(0) ?? 0) & 0xff);
  const row = Math.max(1, codes.length);
  const hex = (codes.length === 0 ? [0] : codes)
    .map((code) => code.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return { hex, totalBytes: row, bytesPerRow: row, width: row * 8, height: 1 };
};

/** The stock box layout that prints the «ЕГАИС» row (the domain's `defaults.ts`). */
function egaisLayout(): LabelTemplateSpec {
  const template = buildDefaultLabelTemplates().find((each) =>
    each.spec.elements.some((element) => "field" in element && element.field === "product.egais"),
  );
  if (template === undefined) throw new Error("no stock layout prints the EGAIS code");
  return template.spec;
}

describe("the EGAIS code on the station's labels (plan ТОВ)", () => {
  it("a box label prints the code the shift froze, through the station's own copy", async () => {
    const shift = await stored(frozen({ chzProductGroupCode: 15, egaisCode: EGAIS }));
    expect(shift.snapshot.product.egaisCode).toBe(EGAIS);
    expect(boxLabelData(shift, BOX, "Иванов")["product.egais"]).toBe(EGAIS);
  });

  it("equals the domain's fields of the cloud station for the same product", async () => {
    const shift = await stored(frozen({ chzProductGroupCode: 15, egaisCode: EGAIS }));
    const { product, counterpartyName } = shift.snapshot;
    expect(boxLabelData(shift, BOX, "Иванов")).toEqual(
      boxLabelFields({
        sscc: BOX.sscc,
        itemCount: BOX.itemCount,
        productName: product.name,
        productPrintName: product.printName,
        gtin14: product.gtin14,
        egaisCode: EGAIS,
        shelfLifeDays: product.shelfLifeDays,
        operatorName: "Иванов",
        counterpartyName,
        closedAt: BOX.closedAt,
        productionDate: shift.copy.productionDate,
        shiftNumber: shift.copy.number,
      }),
    );
  });

  it("the stock box label's bytes are the cloud's for the same fields, and carry the code", async () => {
    const shift = await stored(frozen({ chzProductGroupCode: 15, egaisCode: EGAIS }));
    const { product, counterpartyName } = shift.snapshot;
    const spec = egaisLayout();
    const cloud = boxLabelFields({
      sscc: BOX.sscc,
      itemCount: BOX.itemCount,
      productName: product.name,
      productPrintName: product.printName,
      gtin14: product.gtin14,
      egaisCode: EGAIS,
      shelfLifeDays: product.shelfLifeDays,
      operatorName: "Иванов",
      counterpartyName,
      closedAt: BOX.closedAt,
      productionDate: shift.copy.productionDate,
      shiftNumber: shift.copy.number,
    });
    for (const printer of [
      { language: "zpl", dpi: 203 },
      { language: "zpl", dpi: 300 },
      { language: "tspl", dpi: 203 },
      { language: "tspl", dpi: 300 },
    ] as const) {
      const station = await renderLabel(
        spec,
        boxLabelData(shift, BOX, "Иванов"),
        printer,
        spelling,
      );
      expect(station).toStrictEqual(await renderLabel(spec, cloud, printer, spelling));
      const without = await renderLabel(spec, { ...cloud, "product.egais": "" }, printer, spelling);
      expect(station, `${printer.language} ${printer.dpi}`).not.toStrictEqual(without);
    }
  });

  it("a pallet label prints it too", async () => {
    const shift = await stored(frozen({ chzProductGroupCode: 15, egaisCode: EGAIS }));
    expect(palletLabelData(shift, PALLET, "Иванов")["product.egais"]).toBe(EGAIS);
  });

  it("a snapshot of a host before plan ТОВ prints an empty field", async () => {
    const older = frozen({});
    expect("egaisCode" in older.snapshot.product).toBe(false);
    const shift = await stored(older);
    expect(boxLabelData(shift, BOX, null)["product.egais"]).toBe("");
    expect(palletLabelData(shift, PALLET, null)["product.egais"]).toBe("");
  });

  it("a warehouse reprint takes the code of the record's shift", () => {
    const source = { ...BOX_SOURCE, product: { ...BOX_SOURCE.product, egaisCode: EGAIS } };
    expect(sourceFields(source)["product.egais"]).toBe(EGAIS);
    const older = { ...BOX_SOURCE, product: { ...BOX_SOURCE.product } };
    delete older.product.egaisCode;
    expect(sourceFields(older)["product.egais"]).toBe("");
  });

  it("the A4 sheet of a pallet carries the frozen code into the sheet renderer", async () => {
    const [sheet] = buildPalletSheetPresets();
    if (sheet === undefined) throw new Error("no stock sheet");
    const logo: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8).fill(1) };
    const base = await stored(frozen({ chzProductGroupCode: 15, egaisCode: EGAIS }));
    const organization = { name: "ООО «Пивоварня»", inn: "7701234567", logo };
    const shift = {
      ...base,
      snapshot: {
        ...base.snapshot,
        organization,
        palletSheet: {
          id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
          name: sheet.name,
          revision: 1,
          spec: sheet.spec,
        },
      },
    };
    const fields = palletLabelFields({
      sscc: PALLET.sscc,
      boxCount: PALLET.boxCount,
      itemCount: PALLET.itemCount,
      productName: base.snapshot.product.name,
      productPrintName: base.snapshot.product.printName,
      gtin14: base.snapshot.product.gtin14,
      egaisCode: EGAIS,
      shelfLifeDays: base.snapshot.product.shelfLifeDays,
      operatorName: "Иванов",
      counterpartyName: null,
      closedAt: PALLET.closedAt,
      productionDate: base.copy.productionDate,
      shiftNumber: base.copy.number,
    });
    const texts: string[] = [];
    const recording: RasterizeTextFn = async (value, options) => {
      texts.push(value);
      return spelling(value, options);
    };
    const bytes = await renderShiftSheet(shift, fields, { sheetRasterize: recording });
    expect(texts).toContain(EGAIS);
    const context = {
      sscc: PALLET.sscc,
      productPrintName: fields["product.printName"],
      gtin14: base.snapshot.product.gtin14,
      egaisCode: EGAIS,
      productionDate: base.copy.productionDate,
      shelfLifeDays: base.snapshot.product.shelfLifeDays,
      boxCount: PALLET.boxCount,
      itemCount: PALLET.itemCount,
      shiftNumber: base.copy.number,
      organizationName: organization.name,
      organizationInn: organization.inn,
      logo: sheetLogoOf(logo, "organization"),
    };
    expect(bytes).toStrictEqual(await renderSheetBytes(sheet.spec, context, spelling));
  });

  it("an A4 sheet prints without a frozen code that is not 19 digits, and says so", async () => {
    const [sheet] = buildPalletSheetPresets();
    if (sheet === undefined) throw new Error("no stock sheet");
    const logo: MonoBitmap = { width: 8, height: 8, stride: 1, pixels: new Uint8Array(8).fill(1) };
    const base = await stored(frozen({ chzProductGroupCode: 15, egaisCode: "EG-0150320000001" }));
    const shift = {
      ...base,
      snapshot: {
        ...base.snapshot,
        organization: { name: "ООО «Пивоварня»", inn: "7701234567", logo },
        palletSheet: {
          id: "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b",
          name: sheet.name,
          revision: 1,
          spec: sheet.spec,
        },
      },
    };
    const fields = palletLabelData(shift, PALLET, "Иванов");
    // The thermal label still prints it as the shift froze it.
    expect(fields["product.egais"]).toBe("EG-0150320000001");
    const lines: string[] = [];
    const texts: string[] = [];
    const bytes = await renderShiftSheet(shift, fields, {
      sheetRasterize: async (value, options) => {
        texts.push(value);
        return spelling(value, options);
      },
      report: (line) => lines.push(line),
    });
    expect(bytes.length).toBeGreaterThan(0);
    expect(texts).not.toContain("EG-0150320000001");
    expect(lines).toEqual([EGAIS_NOT_ON_SHEET_LINE]);
  });
});
