import { describe, expect, it } from "vitest";

import type { LabelTemplateSummary } from "../src/host/protocol.js";
import i18n from "../src/i18n/index.js";
import { templateOptions } from "../src/office/template-options.js";

const t = i18n.t;

function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: false,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 1,
    ...data,
  } satisfies LabelTemplateSummary;
}

const FULL = "1a5c8f6e-3b7d-4c9e-8f0a-5b6c7d8e9f0a";
const SHORT = "2b6d9a7f-4c8e-4d0f-9a1b-6c7d8e9f0a1b";
const MILK = "3c7e0b8a-5d9f-4e1a-8b2c-7d8e9f0a1b2c";
const OFF = "4d8f1c9b-6e0a-4f2b-9c3d-8e9f0a1b2c3d";
const BOX = "5e9a2d0c-7f1b-4a3c-8d4e-9f0a1b2c3d4e";
const TEMPLATES: LabelTemplateSummary[] = [
  summary(SHORT, "Дубликат 58×40 [Краткое]", { purpose: "product_duplicate" }),
  summary(FULL, "Дубликат 10×10", { purpose: "product_duplicate" }),
  summary(MILK, "Дубликат молока", { purpose: "product_duplicate", chzProductGroupCodes: [8] }),
  summary(OFF, "Дубликат старый", { purpose: "product_duplicate", enabled: false }),
  summary(BOX, "Коробка 58×40"),
];

function labels(options: { label: string }[]): string[] {
  return options.map((option) => option.label);
}

describe("template choices", () => {
  it("offer «Не выбран» with the empty value, then the templates that fit a duplicate slot, by name with numbers by value", () => {
    const organization = templateOptions(TEMPLATES, "product_duplicate", null, [], t);
    expect(organization).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: FULL, label: "Дубликат 10×10" },
      { value: SHORT, label: "Дубликат 58×40 [Краткое]" },
    ]);
    // A category's slot takes a duplicate template scoped to that category too.
    expect(labels(templateOptions(TEMPLATES, "product_duplicate", 8, [], t))).toStrictEqual([
      "Не выбран",
      "Дубликат 10×10",
      "Дубликат 58×40 [Краткое]",
      "Дубликат молока",
    ]);
    expect(labels(templateOptions(TEMPLATES, "box", 8, [], t))).toStrictEqual([
      "Не выбран",
      "Коробка 58×40",
    ]);
  });

  it("put the numbers of a name by value, 58×40 before 100×100, and leave the list it is given as it is", () => {
    const wide = summary("7a1c4e2f-9b3d-4f5a-8c6e-1d2f3a4b5c6d", "Дубликат 100×100", {
      purpose: "product_duplicate",
    });
    const narrow = summary("8b2d5f3a-0c4e-4a6b-9d7f-2e3a4b5c6d7e", "Дубликат 58×40", {
      purpose: "product_duplicate",
    });
    const list = Object.freeze([wide, narrow]);
    expect(labels(templateOptions(list, "product_duplicate", null, [], t))).toStrictEqual([
      "Не выбран",
      "Дубликат 58×40",
      "Дубликат 100×100",
    ]);
    expect(list).toStrictEqual([wide, narrow]);
  });

  it("keep a kept id that does not fit as a marked choice, once: by name, as missing from the list, or by its first eight characters while the list loads", () => {
    const gone = "6f0b3e1d-8a2c-4b4d-9e5f-0a1b2c3d4e5f";
    expect(
      templateOptions(TEMPLATES, "product_duplicate", 13, [MILK, gone, "", MILK, FULL], t),
    ).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: FULL, label: "Дубликат 10×10" },
      { value: SHORT, label: "Дубликат 58×40 [Краткое]" },
      { value: MILK, label: "Дубликат молока — не подходит" },
      { value: gone, label: "Шаблон 6f0b3e1d… — нет в списке" },
    ]);
    expect(templateOptions(undefined, "pallet", null, [gone], t)).toStrictEqual([
      { value: "", label: "Не выбран" },
      { value: gone, label: "Шаблон 6f0b3e1d…" },
    ]);
  });

  it("put templates of the same name in the order of their ids, as «Шаблоны» lists them", () => {
    const later = summary("9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c", "Коробка 58×40");
    const earlier = summary("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "Коробка 58×40");
    for (const list of [
      [later, earlier],
      [earlier, later],
    ]) {
      expect(templateOptions(list, "box", null, [], t).map((option) => option.value)).toStrictEqual(
        ["", earlier.id, later.id],
      );
    }
  });
});
