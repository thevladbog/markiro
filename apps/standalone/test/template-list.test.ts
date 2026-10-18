import { describe, expect, it } from "vitest";

import type { LabelTemplate, LabelTemplateSummary } from "../src/host/protocol.js";
import { templatesByName, withTemplateChange } from "../src/office/templates/template-list.js";

function summary(id: string, name: string, data: Partial<LabelTemplateSummary> = {}) {
  return {
    id,
    name,
    purpose: "box",
    enabled: true,
    chzProductGroupCodes: null,
    stock: true,
    widthMm: 58,
    heightMm: 40,
    dpi: 203,
    language: "zpl",
    rev: 3,
    ...data,
  } satisfies LabelTemplateSummary;
}

const A = summary("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "Коробка 100×100");
const B = summary("1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", "Коробка 58×40", {
  widthMm: 58.5,
  dpi: null,
  language: null,
});
const C = summary("2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f", "Паллета 100×150", {
  purpose: "pallet",
});

describe("the templates list", () => {
  it("sorts by name with numbers by value, then by id, without changing the list it is given", () => {
    const twin = summary("00000000-0000-4000-8000-000000000001", "Коробка 58×40");
    const list = Object.freeze([C, A, B, twin]);
    expect(templatesByName(list).map((each) => each.id)).toStrictEqual([twin.id, B.id, A.id, C.id]);
    expect(list).toStrictEqual([C, A, B, twin]);
  });

  it("merges a template a write returned into its summary in place: name, flag, categories, stock and revision, keeping the size, resolution and language", () => {
    const saved: LabelTemplate = {
      id: B.id,
      name: "Коробка 58×40 (своя)",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: [8, 13],
      stock: false,
      spec: { widthMm: 75, heightMm: 120, dpi: 300, language: "tspl", elements: [] },
      rev: 9,
    };
    const list = Object.freeze([A, Object.freeze(B), C]);
    const merged = withTemplateChange(list, saved);
    expect(merged).toStrictEqual([
      A,
      {
        id: B.id,
        name: "Коробка 58×40 (своя)",
        purpose: "box",
        enabled: false,
        chzProductGroupCodes: [8, 13],
        stock: false,
        widthMm: 58.5,
        heightMm: 40,
        dpi: null,
        language: null,
        rev: 9,
      },
      C,
    ]);
    expect(merged[0]).toBe(A);
    expect(merged[2]).toBe(C);
    expect(list[1]).toBe(B);
    expect(B.enabled).toBe(true);
  });

  it("never takes the purpose from the answer: a write does not change what a template prints", () => {
    const answer: LabelTemplate = {
      id: C.id,
      name: C.name,
      purpose: "box",
      enabled: C.enabled,
      chzProductGroupCodes: C.chzProductGroupCodes,
      stock: C.stock,
      spec: {},
      rev: 4,
    };
    expect(withTemplateChange([C], answer)).toStrictEqual([{ ...C, rev: 4 }]);
  });

  it("changes nothing for a template the list lacks", () => {
    const stranger: LabelTemplate = {
      id: "3d4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a",
      name: "Чужой",
      purpose: "box",
      enabled: false,
      chzProductGroupCodes: null,
      stock: false,
      spec: {},
      rev: 10,
    };
    const list = [A, B];
    const merged = withTemplateChange(list, stranger);
    expect(merged).toStrictEqual([A, B]);
    expect(merged).not.toBe(list);
  });
});
