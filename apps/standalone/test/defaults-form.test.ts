import { describe, expect, it } from "vitest";

import { HostError } from "../src/host/client.js";
import type { TemplateDefaults } from "../src/host/protocol.js";
import {
  defaultsFailure,
  defaultsInput,
  draftOf,
  sameDraft,
  slotKey,
  withOrgDefault,
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
