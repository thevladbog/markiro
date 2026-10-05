import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { TemplateDefaults } from "../src/host/protocol.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  freePurposes,
  sameDraft,
  slotKey,
  withCategoryDefault,
  withOrgDefault,
  withoutCategoryDefault,
} from "../src/office/templates/defaults-form.js";

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
    });
    expect(defaultsInput(draft)).toStrictEqual({
      defaultBoxTemplateId: BOX,
      defaultPalletTemplateId: null,
      defaultDuplicateTemplateId: null,
      categories: DOCUMENT.categories,
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
});
