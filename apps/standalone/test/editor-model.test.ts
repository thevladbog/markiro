import { describe, expect, it } from "vitest";

import {
  buildDuplicateLabelTemplate,
  buildPalletLabelTemplates,
  sampleLabelData,
  type LabelElement,
  type LabelTemplateSpec,
} from "@markiro/domain";

import {
  BLANK_SPEC,
  checkedSpec,
  DPI_CHOICES,
  draftChanged,
  duplicateLayoutInvalid,
  egaisOutsideScope,
  parseSizeMm,
  presetOf,
  readSpec,
  resizedSpec,
  SIZE_PRESETS,
  startingSpec,
  templateFileName,
  templateJson,
  templateNameRule,
  toDpi,
  type TemplateDraft,
} from "../src/office/templates/editor-model.js";
import { labelRenderOptions, labelSampleData } from "../src/office/templates/label-samples.js";

const EGAIS_FIELD: LabelElement = {
  kind: "field",
  id: "egais",
  xMm: 2,
  yMm: 2,
  field: "product.egais",
  fontSizePt: 8,
  maxWidthMm: 40,
};

/** A 40 × 20 mm box at the top left. */
const WIDE_BOX: LabelElement = {
  kind: "box",
  id: "frame",
  xMm: 10,
  yMm: 10,
  widthMm: 40,
  heightMm: 20,
  thicknessMm: 0.5,
};

function draft(data: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "Коробка 58×40",
    purpose: "box",
    enabled: true,
    scope: { mode: "all", codes: [] },
    spec: BLANK_SPEC,
    ...data,
  };
}

describe("the template editor's model", () => {
  it("starts a box empty, a duplicate as the domain's duplicate and a pallet as the stock pallet", () => {
    expect(startingSpec("box")).toStrictEqual({
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [],
    });
    expect(startingSpec("product_duplicate")).toStrictEqual(buildDuplicateLabelTemplate());
    expect(startingSpec("pallet")).toStrictEqual(buildPalletLabelTemplates()[0]?.spec);
  });

  it("offers the five stock label sizes and 203 and 300 dpi", () => {
    expect(SIZE_PRESETS.map((preset) => [preset.key, preset.widthMm, preset.heightMm])).toEqual([
      ["58x40", 58, 40],
      ["60x40", 60, 40],
      ["75x120", 75, 120],
      ["100x100", 100, 100],
      ["100x150", 100, 150],
    ]);
    for (const preset of SIZE_PRESETS) {
      expect(presetOf(preset.widthMm, preset.heightMm)).toBe(preset.key);
    }
    expect(DPI_CHOICES).toEqual([203, 300]);
  });

  it("names a size's preset and none for any other size", () => {
    expect(presetOf(58, 40)).toBe("58x40");
    expect(presetOf(100, 150)).toBe("100x150");
    expect(presetOf(40, 58)).toBeNull();
    expect(presetOf(58.04, 40)).toBeNull();
  });

  it("reads a typed size with a comma or a point within 10–300 mm and refuses the rest", () => {
    expect(parseSizeMm(" 58 ")).toBe(58);
    expect(parseSizeMm("58,5")).toBe(58.5);
    expect(parseSizeMm("58.5")).toBe(58.5);
    expect(parseSizeMm("10")).toBe(10);
    expect(parseSizeMm("300")).toBe(300);
    for (const text of ["", "9,9", "300.1", "-20", "1e2", "58 мм", "5 8", ".5", "58,"]) {
      expect(parseSizeMm(text)).toBeNull();
    }
  });

  it("takes 300 dpi from a select and 203 for anything else", () => {
    expect(toDpi("300")).toBe(300);
    expect(toDpi("203")).toBe(203);
    expect(toDpi("600")).toBe(203);
  });

  it("reads a stored layout as the domain does, and nothing else", () => {
    const pallet = buildPalletLabelTemplates()[0]?.spec;
    expect(readSpec({ ...pallet })).toStrictEqual(pallet);
    expect(readSpec({ ...BLANK_SPEC, dpi: 600 })).toBeNull();
    expect(readSpec({ widthMm: 58 })).toBeNull();
  });

  it("drops the unknown keys of a stored layout as it reads it", () => {
    const stored = { ...BLANK_SPEC, elements: [{ ...WIDE_BOX, colour: "red" }], note: "x" };
    expect(readSpec(stored)).toStrictEqual({ ...BLANK_SPEC, elements: [WIDE_BOX] });
  });

  it("sends a layout as the domain's schema makes it: unknown keys dropped, a broken layout refused", () => {
    const withExtra = { ...BLANK_SPEC, elements: [{ ...WIDE_BOX, colour: "red" }] };
    expect(checkedSpec(withExtra)).toStrictEqual({ ...BLANK_SPEC, elements: [WIDE_BOX] });
    expect(checkedSpec({ ...BLANK_SPEC, elements: [WIDE_BOX, WIDE_BOX] })).toBeNull();
    expect(checkedSpec({ ...BLANK_SPEC, widthMm: 400 })).toBeNull();
  });

  it("resizes a layout and moves its elements inside, or refuses a size an element does not fit", () => {
    const layout: LabelTemplateSpec = { ...BLANK_SPEC, elements: [WIDE_BOX] };
    expect(resizedSpec(layout, 45, 40, "box")).toStrictEqual({
      ...layout,
      widthMm: 45,
      elements: [{ ...WIDE_BOX, xMm: 5 }],
    });
    expect(resizedSpec(layout, 30, 40, "box")).toBeNull();
    expect(resizedSpec(layout, 100, 150, "pallet")).toStrictEqual({
      ...layout,
      widthMm: 100,
      heightMm: 150,
    });
  });

  it("measures a layout with the sample and the code drawing of its own purpose", () => {
    const quantity: LabelElement = {
      kind: "field",
      id: "qty",
      xMm: 0,
      yMm: 2,
      field: "qty",
      fontSizePt: 8,
    };
    const layout: LabelTemplateSpec = { ...BLANK_SPEC, elements: [quantity] };
    // «240» is wider than «1» and «12»: the box and the duplicate fit 10 mm, a pallet does not.
    expect(resizedSpec(layout, 10, 40, "box")).not.toBeNull();
    expect(resizedSpec(layout, 10, 40, "product_duplicate")).not.toBeNull();
    expect(resizedSpec(layout, 10, 40, "pallet")).toBeNull();
    expect(resizedSpec(layout, 11, 40, "pallet")).not.toBeNull();
    // The duplicate's code is the 22 mm raster; measured natively it is far larger than the label.
    const duplicate = buildDuplicateLabelTemplate();
    expect(resizedSpec(duplicate, 58, 40, "product_duplicate")).not.toBeNull();
    expect(resizedSpec(duplicate, 58, 40, "box")).toBeNull();
  });

  it("measures a duplicate with its own sample and draws its code as the raster", () => {
    expect(labelSampleData("product_duplicate")).toMatchObject({ sscc: "", qty: "1" });
    expect(labelSampleData("pallet")).toMatchObject({ sscc: "376006820000000021", qty: "240" });
    expect(labelSampleData("box").sscc).not.toBe("");
    expect(labelSampleData("box")).toStrictEqual(sampleLabelData());
    const duplicate = labelSampleData("product_duplicate");
    expect(duplicate["km.code"]).toBe(`01${duplicate["product.gtin"]}21DEMO-LABEL-42\u001d93Abcd`);
    expect(duplicate["km.code"]).toContain("\u001d");
    expect(duplicate["product.printName"]).not.toBe(labelSampleData("box")["product.printName"]);
    expect(labelRenderOptions("product_duplicate")).toStrictEqual({ kmDataMatrix: "raster" });
    expect(labelRenderOptions("box")).toStrictEqual({});
    expect(labelRenderOptions("pallet")).toStrictEqual({});
  });

  it("holds a product duplicate to the domain's duplicate rule and no other purpose", () => {
    expect(duplicateLayoutInvalid(buildDuplicateLabelTemplate(), "product_duplicate")).toBe(false);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "product_duplicate")).toBe(true);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "box")).toBe(false);
    expect(duplicateLayoutInvalid(BLANK_SPEC, "pallet")).toBe(false);
  });

  it("warns about the EGAIS field only on categories that leave beer out", () => {
    const layout: LabelTemplateSpec = { ...BLANK_SPEC, elements: [EGAIS_FIELD] };
    expect(egaisOutsideScope(layout, { mode: "selected", codes: [8, 13] })).toBe(true);
    expect(egaisOutsideScope(layout, { mode: "selected", codes: [8, 15] })).toBe(false);
    expect(egaisOutsideScope(layout, { mode: "all", codes: [8] })).toBe(false);
    expect(egaisOutsideScope(BLANK_SPEC, { mode: "selected", codes: [8] })).toBe(false);
  });

  it("trims a name and refuses an empty, an overlong or a control-character one", () => {
    expect(templateNameRule.parse("  Коробка 58×40  ")).toBe("Коробка 58×40");
    expect(templateNameRule.safeParse("x".repeat(200)).success).toBe(true);
    for (const name of ["   ", "x".repeat(201)]) {
      expect(templateNameRule.safeParse(name).error?.issues[0]?.message).toBe(
        "office.templateEditor.errors.name",
      );
    }
    expect(templateNameRule.safeParse("Коробка\t58").error?.issues[0]?.message).toBe(
      "rules.controlCharacter",
    );
  });

  it("finds a change in anything a save sends, and none in the order of categories", () => {
    const opened = draft({ scope: { mode: "selected", codes: [8, 13] } });
    expect(draftChanged(opened, draft({ scope: { mode: "selected", codes: [13, 8] } }))).toBe(
      false,
    );
    expect(draftChanged(opened, draft({ ...opened, name: "Коробка 58×40 " }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, purpose: "pallet" }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, enabled: false }))).toBe(true);
    expect(draftChanged(opened, draft({ scope: { mode: "all", codes: [8, 13] } }))).toBe(true);
    expect(draftChanged(opened, draft({ ...opened, spec: { ...BLANK_SPEC, dpi: 300 } }))).toBe(
      true,
    );
    expect(draftChanged(draft(), draft({ scope: { mode: "all", codes: [8] } }))).toBe(false);
  });

  it("downloads a template as `{ name, purpose, spec }` in that order with a final newline", () => {
    expect(templateJson("Коробка", "box", BLANK_SPEC)).toBe(
      `${JSON.stringify({ name: "Коробка", purpose: "box", spec: BLANK_SPEC }, null, 2)}\n`,
    );
    expect(Object.keys(JSON.parse(templateJson("Коробка", "box", BLANK_SPEC)))).toEqual([
      "name",
      "purpose",
      "spec",
    ]);
  });

  it("makes a file name of a template name, keeping Cyrillic letters", () => {
    expect(templateFileName(" Коробка 58×40 ")).toBe("Коробка-58-40");
    expect(templateFileName("Box_1 (copy)")).toBe("Box_1-copy");
    expect(templateFileName("«»…")).toBe("label");
  });
});
