import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { TemplateDefaults } from "../src/host/protocol.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  freeKinds,
  freePurposes,
  sameDraft,
  sheetSlotKey,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withOrgSheet,
  withoutCategoryDefault,
  withoutSheetCategoryDefault,
  withSheetCategoryDefault,
} from "../src/office/templates/defaults-form.js";

const SHEET = "6a3f0c5e-1b2d-4e8f-9a7b-0c1d2e3f4a5b";
const SHEET_2 = "7b4a1d6f-2c3e-4f9a-8b8c-1d2e3f4a5b6c";

const BOX = "7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c";
const MILK = "a3b4c5d6-e7f8-4a9b-8c0d-1e2f3a4b5c6d";
const WATER = "8d2f5c3b-0e4a-4f6b-9c7d-2e3f4a5b6c7d";

const DOCUMENT: TemplateDefaults = {
  defaultBoxTemplateId: BOX,
  defaultPalletTemplateId: null,
  defaultDuplicateTemplateId: null,
  categories: [
    { chzProductGroupCode: 8, purpose: "box", templateId: MILK },
    { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
  ],
  defaultPalletSheetId: null,
  palletSheetCategories: [],
  rev: 64,
};

function rejected(field: string): HostError {
  return new HostError({
    kind: "api",
    code: "validation_failed",
    status: 400,
    message: "rejected",
    details: { field },
  });
}

describe("the defaults form", () => {
  it("holds an organization default as its select does, and sends one left at «Не выбран» as null", () => {
    const draft = draftOf(DOCUMENT);
    expect(draft).toStrictEqual({
      defaultBoxTemplateId: BOX,
      defaultPalletTemplateId: "",
      defaultDuplicateTemplateId: "",
      categories: DOCUMENT.categories,
      defaultPalletSheetId: "",
      sheetCategories: [],
    });
    expect(defaultsInput(draft)).toStrictEqual({
      defaultBoxTemplateId: BOX,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: DOCUMENT.categories,
      defaultPalletSheetId: null,
      palletSheetCategories: [],
    });
    const changed = withOrgDefault(
      withOrgDefault(
        withOrgDefault(draft, "defaultBoxTemplateId", ""),
        "defaultPalletTemplateId",
        BOX,
      ),
      "defaultDuplicateTemplateId",
      MILK,
    );
    expect(defaultsInput(changed)).toStrictEqual({
      defaultBoxTemplateId: null,
      defaultPalletTemplateId: BOX,
      defaultDuplicateTemplateId: MILK,
      categories: DOCUMENT.categories,
      defaultPalletSheetId: null,
      palletSheetCategories: [],
    });
    expect(draft.defaultBoxTemplateId).toBe(BOX);
  });

  it("keys a category default by its category and purpose, as the feed does", () => {
    expect(slotKey({ chzProductGroupCode: 8, purpose: "product_duplicate" })).toBe(
      "8:product_duplicate",
    );
  });

  it("finds a draft unchanged with the same defaults in any order, and changed by any default", () => {
    const draft = draftOf(DOCUMENT);
    const reversed = { ...draft, categories: [...draft.categories].reverse() };
    expect(sameDraft(reversed, draft)).toBe(true);
    for (const field of [
      "defaultBoxTemplateId",
      "defaultPalletTemplateId",
      "defaultDuplicateTemplateId",
    ] as const) {
      expect(sameDraft(withOrgDefault(draft, field, WATER), draft), field).toBe(false);
    }
    const [milk, water] = DOCUMENT.categories;
    if (milk === undefined || water === undefined) throw new Error("two category defaults");
    expect(sameDraft({ ...draft, categories: [milk] }, draft)).toBe(false);
    expect(sameDraft({ ...draft, categories: [milk, { ...water, templateId: MILK }] }, draft)).toBe(
      false,
    );
    expect(
      sameDraft({ ...draft, categories: [milk, { ...water, purpose: "pallet" }] }, draft),
    ).toBe(false);
  });

  it("puts a refusal of an organization default under its field, and explains anything else above the form", () => {
    for (const field of [
      "defaultBoxTemplateId",
      "defaultPalletTemplateId",
      "defaultDuplicateTemplateId",
    ] as const) {
      expect(defaultsFailure(rejected(field))).toStrictEqual({
        kind: "field",
        key: field,
        message: "office.templateDefaults.errors.unfit",
      });
    }
    expect(defaultsFailure(rejected("expectedRev"))).toStrictEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(
      defaultsFailure(
        new HostError({ kind: "api", code: "stale_revision", status: 409, message: "stale" }),
      ),
    ).toStrictEqual({ kind: "stale" });
    expect(defaultsFailure(new Error("boom"))).toStrictEqual({
      kind: "alert",
      message: "errors.unknown",
    });
  });
});

describe("the defaults form: category defaults", () => {
  const draft = draftOf(DOCUMENT);

  it("puts a category default in its slot in place, or adds it at the end, and removes one by its slot", () => {
    const changed = withCategoryDefault(draft, {
      chzProductGroupCode: 8,
      purpose: "box",
      templateId: WATER,
    });
    expect(changed.categories).toStrictEqual([
      { chzProductGroupCode: 8, purpose: "box", templateId: WATER },
      { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
    ]);
    const added = withCategoryDefault(draft, {
      chzProductGroupCode: 8,
      purpose: "pallet",
      templateId: BOX,
    });
    expect(added.categories).toStrictEqual([
      ...DOCUMENT.categories,
      { chzProductGroupCode: 8, purpose: "pallet", templateId: BOX },
    ]);
    expect(withoutCategoryDefault(draft, "13:box").categories).toStrictEqual([
      { chzProductGroupCode: 8, purpose: "box", templateId: MILK },
    ]);
    expect(withoutCategoryDefault(draft, "13:pallet").categories).toStrictEqual(
      DOCUMENT.categories,
    );
    expect(draft.categories).toBe(DOCUMENT.categories);
  });

  it("offers the purposes a category has no default of yet, box, pallet, duplicate", () => {
    expect(freePurposes(DOCUMENT.categories, 8)).toStrictEqual(["pallet", "product_duplicate"]);
    expect(freePurposes(DOCUMENT.categories, 3)).toStrictEqual([
      "box",
      "pallet",
      "product_duplicate",
    ]);
    const full = [
      ...DOCUMENT.categories,
      { chzProductGroupCode: 8, purpose: "pallet", templateId: BOX },
      { chzProductGroupCode: 8, purpose: "product_duplicate", templateId: BOX },
    ] as const;
    expect(freePurposes(full, 8)).toStrictEqual([]);
  });

  it("puts a refusal of a category default under the default it names by its index in what was sent", () => {
    const sent = [
      { chzProductGroupCode: 13, purpose: "box", templateId: WATER },
      { chzProductGroupCode: 3, purpose: "pallet", templateId: BOX },
    ] as const;
    expect(defaultsFailure(rejected("categories.1.templateId"), sent)).toStrictEqual({
      kind: "field",
      key: "3:pallet",
      message: "office.templateDefaults.errors.unfit",
    });
    expect(defaultsFailure(rejected("categories.0.chzProductGroupCode"), sent)).toStrictEqual({
      kind: "field",
      key: "13:box",
      message: "office.templateDefaults.errors.category",
    });
    expect(defaultsFailure(rejected("categories.1"), sent)).toStrictEqual({
      kind: "field",
      key: "3:pallet",
      message: "office.templateDefaults.errors.twice",
    });
    for (const field of [
      "categories.2.templateId",
      "categories.1.purpose",
      "categories.x",
      "xcategories.1",
      "categories.1.templateIdx",
    ]) {
      expect(defaultsFailure(rejected(field), sent), field).toStrictEqual({
        kind: "alert",
        message: "errors.api.validation_failed",
      });
    }
  });
});

// Beyond the plan: each test below kills a one-line mutant the plan's tests let live.
describe("the defaults form: category defaults, beyond the plan", () => {
  it("finds a category default by an index of more than one digit", () => {
    const sent = Array.from({ length: 12 }, (_, index) => ({
      chzProductGroupCode: 100 + index,
      purpose: "box" as const,
      templateId: BOX,
    }));
    expect(defaultsFailure(rejected("categories.11.templateId"), sent)).toStrictEqual({
      kind: "field",
      key: "111:box",
      message: "office.templateDefaults.errors.unfit",
    });
    expect(defaultsFailure(rejected("categories.10"), sent)).toStrictEqual({
      kind: "field",
      key: "110:box",
      message: "office.templateDefaults.errors.twice",
    });
  });

  it("keeps the organization's defaults when a category default is put in or taken out", () => {
    const draft = draftOf(DOCUMENT);
    const entry = { chzProductGroupCode: 3, purpose: "box" as const, templateId: WATER };
    for (const changed of [
      withCategoryDefault(draft, entry),
      withCategoryDefault(draft, { ...entry, chzProductGroupCode: 8 }),
      withoutCategoryDefault(draft, "8:box"),
    ]) {
      expect(changed).toMatchObject({
        defaultBoxTemplateId: BOX,
        defaultPalletTemplateId: "",
        defaultDuplicateTemplateId: "",
      });
    }
  });

  it("answers a refusal for a row that is no longer in the draft with the general alert, and one for a row still there with its field", () => {
    const sent = [
      { chzProductGroupCode: 8, purpose: "box" as const, templateId: MILK },
      { chzProductGroupCode: 13, purpose: "box" as const, templateId: WATER },
    ];
    const current = [
      sent[1] ?? { chzProductGroupCode: 13, purpose: "box" as const, templateId: WATER },
    ];
    // The host names `categories.0`, the row of slot 8:box, which the draft no longer holds:
    // no control would show the message.
    expect(defaultsFailure(rejected("categories.0.templateId"), sent, current)).toStrictEqual({
      kind: "alert",
      message: "errors.api.validation_failed",
    });
    expect(defaultsFailure(rejected("categories.1.templateId"), sent, current)).toStrictEqual({
      kind: "field",
      key: "13:box",
      message: "office.templateDefaults.errors.unfit",
    });
    // An organization default is always on the page.
    expect(defaultsFailure(rejected("defaultBoxTemplateId"), sent, [])).toStrictEqual({
      kind: "field",
      key: "defaultBoxTemplateId",
      message: "office.templateDefaults.errors.unfit",
    });
  });
});

describe("the A4 sheets in the defaults form", () => {
  it("holds the organization's sheet and each category's beside the labels, and sends them as sheets", () => {
    const draft = withSheetCategoryDefault(withOrgSheet(draftOf(DOCUMENT), SHEET), {
      chzProductGroupCode: 8,
      sheetId: SHEET_2,
    });
    expect(defaultsInput(draft)).toMatchObject({
      defaultPalletSheetId: SHEET,
      palletSheetCategories: [{ chzProductGroupCode: 8, sheetId: SHEET_2 }],
      // The label rows stay as they were: a sheet never joins them.
      categories: DOCUMENT.categories,
    });
    // In place for the same category, and gone again.
    const replaced = withSheetCategoryDefault(draft, { chzProductGroupCode: 8, sheetId: SHEET });
    expect(replaced.sheetCategories).toStrictEqual([{ chzProductGroupCode: 8, sheetId: SHEET }]);
    expect(withoutSheetCategoryDefault(replaced, 8).sheetCategories).toStrictEqual([]);
    expect(defaultsInput(withOrgSheet(draft, "")).defaultPalletSheetId).toBeNull();
    expect(sheetSlotKey({ chzProductGroupCode: 8 })).toBe("8:pallet_sheet");
  });

  it("finds a draft changed by a sheet, and unchanged by the sheets' order", () => {
    const draft = draftOf({
      ...DOCUMENT,
      palletSheetCategories: [
        { chzProductGroupCode: 8, sheetId: SHEET },
        { chzProductGroupCode: 13, sheetId: SHEET_2 },
      ],
    });
    const reversed = { ...draft, sheetCategories: [...draft.sheetCategories].reverse() };
    expect(sameDraft(draft, reversed)).toBe(true);
    expect(sameDraft(draft, withOrgSheet(draft, SHEET))).toBe(false);
    expect(
      sameDraft(
        draft,
        withSheetCategoryDefault(draft, { chzProductGroupCode: 8, sheetId: SHEET_2 }),
      ),
    ).toBe(false);
  });

  it("offers a category the A4 sheet right after the pallet label, until it has one", () => {
    expect(freeKinds(DOCUMENT.categories, [], 8)).toStrictEqual([
      "pallet",
      "pallet_sheet",
      "product_duplicate",
    ]);
    expect(
      freeKinds(DOCUMENT.categories, [{ chzProductGroupCode: 8, sheetId: SHEET }], 8),
    ).toStrictEqual(["pallet", "product_duplicate"]);
  });

  it("puts a refused sheet under its control: the organization's, or a category's by its index in the sheets sent", () => {
    const sent = [
      { chzProductGroupCode: 8, sheetId: SHEET },
      { chzProductGroupCode: 13, sheetId: SHEET_2 },
    ];
    expect(defaultsFailure(rejected("defaultPalletSheetId"))).toStrictEqual({
      kind: "field",
      key: "defaultPalletSheetId",
      message: "office.templateDefaults.errors.sheetUnfit",
    });
    expect(
      defaultsFailure(rejected("palletSheetCategories.1.sheetId"), [], [], sent),
    ).toStrictEqual({
      kind: "field",
      key: "13:pallet_sheet",
      message: "office.templateDefaults.errors.sheetUnfit",
    });
    expect(
      defaultsFailure(rejected("palletSheetCategories.0.chzProductGroupCode"), [], [], sent),
    ).toMatchObject({ key: "8:pallet_sheet", message: "office.templateDefaults.errors.category" });
    expect(defaultsFailure(rejected("palletSheetCategories.1"), [], [], sent)).toMatchObject({
      message: "office.templateDefaults.errors.twice",
    });
    // A row the draft no longer holds: the general alert.
    expect(
      defaultsFailure(rejected("palletSheetCategories.0.sheetId"), [], [], sent, sent.slice(1)),
    ).toStrictEqual({ kind: "alert", message: "errors.api.validation_failed" });
  });
});
